/**
 * Executive sessions (ADR 0064). `ablationkit executive`, the MCP server for an agent on the
 * researcher's machine, mints a human-API session through the login socket, marked
 * `executive_session` and labelled with its harness. Such a session oversees the research and
 * runs the agents: it may make every read (GET) of the human API and only the writes an executive
 * makes: start, prompt, pause, resume and stop agent containers, allow an egress host, end agent
 * sessions, and write, close, reopen or withdraw directions (marked as the executive's). Every other
 * write (jobs, notes, research records, tasks, runs, policy, configuration, extensions, backups,
 * projects) is refused with 403 `executive_forbidden` and audited: the executive does not do the
 * research itself.
 *
 * This is a role the coordinator enforces for that token. It is not a boundary against the agent:
 * on the researcher's machine it can still use the CLI as their operator (ADR 0062).
 */
import { TokenScopeError } from "@ablationkit/auth";
import type { TokenRecord } from "@ablationkit/protocol";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";

/** The writes an executive session may make, by route action. */
export const EXECUTIVE_WRITES: ReadonlySet<string> = new Set([
  "agent.container.start",
  "agent.container.input",
  "agent.container.pause",
  "agent.container.resume",
  "agent.container.stop",
  "agent.container.allow",
  "auth.agent_session.end",
  "direction.create",
  "direction.close",
  "direction.reopen",
  "direction.withdraw",
  // Signing itself out.
  "auth.session.revoke",
]);

/** How long an executive session lives at most (it ends when its MCP server closes). */
const EXECUTIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SAFE = new Set(["GET", "HEAD"]);

/** Is this request one an executive session may make? */
export function executiveMay(method: string, action: string): boolean {
  return SAFE.has(method) || EXECUTIVE_WRITES.has(action);
}

export interface ExecutiveSessionView {
  readonly token_id: string;
  readonly harness: string;
  readonly label: string;
  readonly cwd: string;
  readonly started_at: string;
  readonly expires_at?: string;
  readonly live: boolean;
  readonly ended_at?: string;
  readonly end_reason?: string;
}

export function beginExecutive(
  svc: Services,
  input: { harness: string; label: string; cwd: string },
): { token: string; record: TokenRecord } {
  try {
    const minted = svc.tokens.mint("session", {
      label: input.label,
      ttlMs: EXECUTIVE_TTL_MS,
      executiveSession: { harness: input.harness, label: input.label, cwd: input.cwd },
    });
    svc.audit.record({
      actor: { kind: "human", id: minted.record.token_id },
      listener: "login",
      action: "auth.executive_session.start",
      outcome: "allowed",
      target: minted.record.token_id,
      details: { harness: input.harness, label: input.label, cwd: input.cwd },
    });
    return minted;
  } catch (e) {
    if (e instanceof TokenScopeError) throw new HttpError(400, "invalid_scope", e.message);
    throw e;
  }
}

/** End an executive session: by its own token (the MCP server closing) or by the researcher. */
export function endExecutive(svc: Services, tokenId: string, by: string, reason: string): boolean {
  const record = svc.tokens.get(tokenId);
  if (record?.kind !== "session" || !record.executive_session)
    throw new HttpError(404, "executive_session_not_found", "no such executive session");
  const ended = svc.tokens.revoke(tokenId, reason);
  svc.audit.record({
    actor: { kind: "human", id: by },
    listener: by === tokenId ? "login" : "human",
    action: "auth.executive_session.end",
    outcome: "allowed",
    target: tokenId,
    reason,
  });
  return ended;
}

export function listExecutive(svc: Services): ExecutiveSessionView[] {
  return svc.tokens
    .list()
    .filter((t) => t.kind === "session" && t.executive_session)
    .map((t) => {
      const e = t.executive_session as NonNullable<TokenRecord["executive_session"]>;
      const live = svc.tokens.isLive(t);
      return compact({
        token_id: t.token_id,
        harness: e.harness,
        label: e.label,
        cwd: e.cwd,
        started_at: t.created_at,
        expires_at: t.expires_at,
        live,
        ended_at: t.revoked_at ?? (live ? undefined : t.expires_at),
        end_reason: t.revoked_reason ?? (live ? undefined : "expired"),
      }) as ExecutiveSessionView;
    })
    .sort((a, b) => Number(b.live) - Number(a.live) || b.started_at.localeCompare(a.started_at));
}
