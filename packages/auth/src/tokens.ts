/**
 * Bearer tokens for the three listeners (spec §7.11, ADR 0008).
 *
 * A token string is `<prefix><token_id>.<secret>`: `aks_` human session, `aka_` agent,
 * `akw_` worker. Only SHA-256(secret) is stored. The token_id is public and is what audit
 * records name. Verification checks kind, hash, revocation and expiry; the caller checks scope.
 */
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type AgentSessionInfo,
  type TokenKind,
  type TokenRecord,
  type TokenScope,
  type TokenStore as TokenStoreFile,
  validateTokenStore,
} from "@ablationkit/protocol";
import { hexEqual, randomHexId, randomToken, sha256Hex } from "./crypto.ts";

export const TOKEN_PREFIX: Readonly<Record<TokenKind, string>> = {
  session: "aks_",
  agent: "aka_",
  worker: "akw_",
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 7 * DAY_MS;
/** Agent tokens end at most this long after they were minted. */
export const AGENT_TTL_MS = 7 * DAY_MS;
/** An agent session token also ends after this long without a request (ADR 0040). */
export const AGENT_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** `last_used_at` is written at most this often. */
const TOUCH_EVERY_MS = 60 * 1000;
/** Worker tokens stay valid this long after their job reaches a terminal state. */
export const WORKER_GRACE_MS = 7 * DAY_MS;

const TOKEN_RE = /^(aks_|aka_|akw_)([a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/;

export interface MintOptions {
  scope?: TokenScope;
  label?: string;
  /**
   * Override the default lifetime. Local worker tokens have none until the job is terminal;
   * remote worker tokens (ADR 0023) pass one: short for upload tokens, the job's horizon for launch.
   */
  ttlMs?: number;
  /** Worker tokens: `launch` may only perform the remote handshake. */
  purpose?: "upload" | "launch";
  /** Agent tokens minted for one agent session (ADR 0040). */
  agentSession?: Pick<AgentSessionInfo, "harness" | "label" | "cwd">;
}

export interface MintedToken {
  /** The secret token string. Shown once; never stored. */
  readonly token: string;
  readonly record: TokenRecord;
}

export class TokenScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenScopeError";
  }
}

/** Parse a token string without checking it; undefined if malformed. */
export function parseToken(
  token: string,
): { kind: TokenKind; tokenId: string; secret: string } | undefined {
  const m = TOKEN_RE.exec(token);
  if (!m) return undefined;
  const kind = (Object.keys(TOKEN_PREFIX) as TokenKind[]).find((k) => TOKEN_PREFIX[k] === m[1]);
  if (!kind) return undefined;
  return { kind, tokenId: m[2] as string, secret: m[3] as string };
}

function requireScope(kind: TokenKind, scope: TokenScope): void {
  if (kind === "agent" && !scope.project_id) {
    throw new TokenScopeError("agent tokens must be bound to a project_id");
  }
  if (kind === "agent" && Object.keys(scope).some((k) => k !== "project_id")) {
    throw new TokenScopeError("agent tokens are bound to a project only (ADR 0039)");
  }
  if (kind === "worker" && (!scope.project_id || !scope.job_id || !scope.attempt_id)) {
    throw new TokenScopeError("worker tokens must be bound to project_id, job_id and attempt_id");
  }
  if (kind === "session" && Object.keys(scope).length > 0) {
    throw new TokenScopeError("session tokens carry no scope");
  }
}

/** File-backed token store. Single writer: only the coordinator process uses it. */
export class TokenStore {
  private data: TokenStoreFile;

  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    try {
      this.data = readJson(path, validateTokenStore);
    } catch (e) {
      if ((e as { kind?: string }).kind !== "missing") throw e;
      this.data = { schema_version: 1, tokens: [] };
    }
  }

  private save(): void {
    writeJsonAtomic(this.path, this.data, { validate: validateTokenStore });
  }

  mint(kind: TokenKind, options: MintOptions = {}): MintedToken {
    const scope = options.scope ?? {};
    requireScope(kind, scope);
    const tokenId = randomHexId(8);
    const secret = randomToken(32);
    const now = this.now();
    const defaultTtl =
      kind === "session" ? SESSION_TTL_MS : kind === "agent" ? AGENT_TTL_MS : undefined;
    const ttl = kind === "worker" ? options.ttlMs : (options.ttlMs ?? defaultTtl);
    if (options.purpose !== undefined && kind !== "worker")
      throw new TokenScopeError("only worker tokens have a purpose");
    if (options.agentSession !== undefined && kind !== "agent")
      throw new TokenScopeError("only agent tokens belong to an agent session");
    const record: TokenRecord = {
      token_id: tokenId,
      kind,
      token_hash: sha256Hex(secret),
      created_at: now.toISOString(),
      ...(ttl === undefined ? {} : { expires_at: new Date(now.getTime() + ttl).toISOString() }),
      ...(options.label === undefined ? {} : { label: options.label }),
      scope: { ...scope },
      ...(options.purpose === "launch" ? { purpose: "launch" as const } : {}),
      ...(options.agentSession === undefined
        ? {}
        : {
            agent_session: {
              ...options.agentSession,
              last_used_at: now.toISOString(),
              idle_timeout_sec: AGENT_SESSION_IDLE_MS / 1000,
            },
          }),
    };
    this.data.tokens.push(record);
    this.save();
    return { token: `${TOKEN_PREFIX[kind]}${tokenId}.${secret}`, record };
  }

  /** The live record for `token` if it is of `kind`, unrevoked and unexpired. */
  verify(token: string, kind: TokenKind): TokenRecord | undefined {
    const parsed = parseToken(token);
    if (!parsed || parsed.kind !== kind) return undefined;
    const record = this.get(parsed.tokenId);
    if (!record || record.kind !== kind) return undefined;
    if (!hexEqual(record.token_hash, sha256Hex(parsed.secret))) return undefined;
    return this.isLive(record) ? record : undefined;
  }

  isLive(record: TokenRecord): boolean {
    if (record.revoked_at !== undefined) return false;
    if (record.expires_at !== undefined && Date.parse(record.expires_at) <= this.now().getTime())
      return false;
    return this.idleSince(record) === undefined;
  }

  /** When an agent session token went idle (its idle timeout passed), or undefined. */
  idleSince(record: TokenRecord): Date | undefined {
    const s = record.agent_session;
    if (!s) return undefined;
    const at = Date.parse(s.last_used_at) + s.idle_timeout_sec * 1000;
    return at <= this.now().getTime() ? new Date(at) : undefined;
  }

  /** An agent session token was used: move `last_used_at`, writing at most once a minute. */
  touch(record: TokenRecord): void {
    const s = record.agent_session;
    if (!s) return;
    const now = this.now();
    if (now.getTime() - Date.parse(s.last_used_at) < TOUCH_EVERY_MS) return;
    s.last_used_at = now.toISOString();
    this.save();
  }

  /**
   * End agent session tokens that went idle or reached their maximum age: they are revoked with
   * the reason (`idle` or `expired`), once. Returns the ones ended now, for the audit log.
   */
  endExpiredAgentSessions(): { record: TokenRecord; reason: "idle" | "expired" }[] {
    const now = this.now();
    const ended: { record: TokenRecord; reason: "idle" | "expired" }[] = [];
    for (const t of this.data.tokens) {
      if (t.kind !== "agent" || !t.agent_session || t.revoked_at !== undefined) continue;
      const reason =
        t.expires_at !== undefined && Date.parse(t.expires_at) <= now.getTime()
          ? "expired"
          : this.idleSince(t)
            ? "idle"
            : undefined;
      if (!reason) continue;
      t.revoked_at = now.toISOString();
      t.revoked_reason = reason;
      ended.push({ record: t, reason });
    }
    if (ended.length > 0) this.save();
    return ended;
  }

  get(tokenId: string): TokenRecord | undefined {
    return this.data.tokens.find((t) => t.token_id === tokenId);
  }

  list(): readonly TokenRecord[] {
    return this.data.tokens;
  }

  /** Revoke one token. Returns false if unknown or already revoked. */
  revoke(tokenId: string, reason: string): boolean {
    return this.revokeWhere((t) => t.token_id === tokenId, reason) > 0;
  }

  /** Revoke every live token matching `pred`; returns how many. */
  revokeWhere(pred: (t: TokenRecord) => boolean, reason: string): number {
    const at = this.now().toISOString();
    let n = 0;
    for (const t of this.data.tokens) {
      if (t.revoked_at === undefined && pred(t)) {
        t.revoked_at = at;
        t.revoked_reason = reason;
        n += 1;
      }
    }
    if (n > 0) this.save();
    return n;
  }

  /**
   * A job reached a terminal state at `terminalAt`: its worker tokens now expire after the
   * 7-day grace period (spec §7.11). Returns how many tokens were updated.
   */
  markJobTerminal(jobId: string, terminalAt: Date): number {
    const expires = new Date(terminalAt.getTime() + WORKER_GRACE_MS).toISOString();
    let n = 0;
    for (const t of this.data.tokens) {
      if (
        t.kind === "worker" &&
        t.scope.job_id === jobId &&
        t.revoked_at === undefined &&
        (t.expires_at === undefined || Date.parse(t.expires_at) > Date.parse(expires))
      ) {
        t.expires_at = expires;
        n += 1;
      }
    }
    if (n > 0) this.save();
    return n;
  }

  /** A remote worker refreshed: revoke the attempt's other upload tokens (one live at a time). */
  revokeUploadTokens(attemptId: string, keepTokenId: string): number {
    return this.revokeWhere(
      (t) =>
        t.kind === "worker" &&
        t.scope.attempt_id === attemptId &&
        t.purpose !== "launch" &&
        t.token_id !== keepTokenId,
      "refreshed",
    );
  }
}
