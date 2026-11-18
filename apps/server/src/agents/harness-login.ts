/**
 * The researcher's Claude Code login in an agent container (ADR 0063). At start the coordinator
 * copies `<config>/.credentials.json` (by default `~/.claude`) into the container's home and marks
 * Claude Code's onboarding done there, on the same account, with the checkout trusted, so a
 * contained Claude Code starts signed in.
 *
 * While the session runs, a renewal made on this machine (the later `expiresAt`) is carried in
 * within a monitor tick, and Claude Code, which reloads the file when its modification time
 * changes, picks it up. One made in the container stays there: it is never written to this
 * machine. The coordinator cannot tell which account a renewed login belongs to (all it could read
 * is the container's own settings, which the agent writes), so carrying it back would let an agent
 * replace the researcher's login, with another account's among others. It is audited once
 * (`agent.container.login.renewed_inside`): if Claude's refresh tokens rotate, this machine's copy
 * may then need signing in again. When the session ends the container's copy is deleted.
 *
 * The agent can read the copy (it uses it): that is the researcher's choice, stated in ADR 0063.
 * The container's side lives in the agent's home, which the agent writes and keeps between
 * sessions: it is read and written only through `AgentHome`, which never follows a link the agent
 * left there onto this machine's files.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentHome } from "./agent-home.ts";

export interface LoginSource {
  /** The Claude Code configuration directory (`~/.claude`, or a `CLAUDE_CONFIG_DIR`). */
  readonly dir: string;
  readonly credentials: string;
  /** Claude Code's global settings: `~/.claude.json` beside `~/.claude`, else inside the dir. */
  readonly globalConfig: string;
}

/** Where Claude Code keeps a configuration directory's login and its global settings. */
export function claudeLoginSource(dir: string, userHome: string): LoginSource {
  const d = resolve(dir);
  return {
    dir: d,
    credentials: join(d, ".credentials.json"),
    globalConfig:
      d === resolve(userHome, ".claude")
        ? join(resolve(userHome), ".claude.json")
        : join(d, ".claude.json"),
  };
}

interface Oauth {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  subscriptionType?: unknown;
}

interface Read {
  readonly text: string;
  readonly oauth: Oauth;
  readonly expiresAt: number;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJsonFile(path: string): Json | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function parseJson(text: string | undefined): Json | undefined {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text);
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A Claude login file on this machine, or undefined when it is not one. */
function readLogin(path: string): Read | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return parseLogin(text);
}

/** A Claude login as Claude Code writes it, or undefined when it is not one. */
function parseLogin(text: string | undefined): Read | undefined {
  if (text === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  const oauth = isObject(v) ? v["claudeAiOauth"] : undefined;
  if (!isObject(oauth)) return undefined;
  const o = oauth as Oauth;
  if (
    typeof o.accessToken !== "string" ||
    !o.accessToken.startsWith("sk-ant-oat") ||
    typeof o.refreshToken !== "string" ||
    !o.refreshToken.startsWith("sk-ant-ort") ||
    typeof o.expiresAt !== "number"
  )
    return undefined;
  return { text, oauth: o, expiresAt: o.expiresAt };
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

const fingerprint = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export interface LoginSyncOptions {
  readonly source: LoginSource;
  /** The agent's home on this machine (mounted at /home/agent). */
  readonly home: string;
  /** The checkout, trusted for Claude Code in the container. */
  readonly checkout: string;
  /** Recorded for each renewal carried in, and once for each one made in the container. */
  readonly audit: (action: string, details: Record<string, unknown>) => void;
  /** Counts so far (after a coordinator restart). */
  readonly counts?: { readonly synced_back: number; readonly synced_in: number };
}

/** Where the container's copy lives in the agent's home. */
const BOX_CREDENTIALS = ".claude/.credentials.json";
const BOX_CONFIG = ".claude.json";

export class ClaudeLoginSync {
  private readonly box: AgentHome;
  /** Logins carried back to this machine: none since ADR 0063 was amended; kept on the record. */
  readonly syncedBack: number;
  syncedIn: number;
  private seen = { host: 0, box: 0 };
  /** The fingerprint of the last renewal made in the container, audited once. */
  private renewedInside: string | undefined;

  /** The configuration directory the login comes from. */
  get source(): string {
    return this.o.source.dir;
  }

  constructor(private readonly o: LoginSyncOptions) {
    this.box = new AgentHome(o.home);
    this.syncedBack = o.counts?.synced_back ?? 0;
    this.syncedIn = o.counts?.synced_in ?? 0;
  }

  /** Is there a login to copy? */
  available(): boolean {
    return readLogin(this.o.source.credentials) !== undefined;
  }

  /**
   * Copy the login in, with Claude Code's onboarding done on the same account and the checkout
   * trusted. False when the source holds no Claude login (the agent signs in itself).
   */
  copyIn(): boolean {
    const host = readLogin(this.o.source.credentials);
    if (!host) return false;
    this.box.write(BOX_CREDENTIALS, host.text, 0o600);
    const box = parseJson(this.box.read(BOX_CONFIG)) ?? {};
    const src = readJsonFile(this.o.source.globalConfig) ?? {};
    const projects = isObject(box["projects"]) ? box["projects"] : {};
    const project = isObject(projects[this.o.checkout]) ? projects[this.o.checkout] : {};
    const next: Json = {
      ...box,
      hasCompletedOnboarding: true,
      ...(typeof src["lastOnboardingVersion"] === "string"
        ? { lastOnboardingVersion: src["lastOnboardingVersion"] }
        : {}),
      ...(isObject(src["oauthAccount"]) ? { oauthAccount: src["oauthAccount"] } : {}),
      projects: {
        ...projects,
        [this.o.checkout]: { ...(project as Json), hasTrustDialogAccepted: true },
      },
    };
    this.box.write(BOX_CONFIG, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    this.seen = { host: mtime(this.o.source.credentials), box: this.box.mtime(BOX_CREDENTIALS) };
    return true;
  }

  /**
   * A renewal on this machine (the later `expiresAt`) is carried into the container; one made in
   * the container stays there and is audited once. Returns "in" when one was carried.
   */
  sync(): "in" | undefined {
    const hm = mtime(this.o.source.credentials);
    const bm = this.box.mtime(BOX_CREDENTIALS);
    if (hm === this.seen.host && bm === this.seen.box) return undefined;
    this.seen = { host: hm, box: bm };
    const host = readLogin(this.o.source.credentials);
    const box = parseLogin(this.box.read(BOX_CREDENTIALS));
    if (
      box &&
      host &&
      box.expiresAt > host.expiresAt &&
      box.oauth.refreshToken !== host.oauth.refreshToken
    ) {
      const login = fingerprint(box.oauth.refreshToken as string);
      if (login !== this.renewedInside) {
        this.renewedInside = login;
        this.o.audit("agent.container.login.renewed_inside", { login });
      }
      return undefined;
    }
    if (host && (!box || host.expiresAt > box.expiresAt)) {
      this.box.write(BOX_CREDENTIALS, host.text, 0o600);
      this.syncedIn++;
      this.seen.box = this.box.mtime(BOX_CREDENTIALS);
      this.o.audit("agent.container.login.synced", {
        direction: "in",
        login: fingerprint(host.oauth.refreshToken as string),
      });
      return "in";
    }
    return undefined;
  }

  /**
   * The session ended: the container's copy is deleted, unless `keep` (another live session runs
   * in the same home and signs in with it).
   */
  end(keep = false): void {
    if (!keep) this.box.remove(BOX_CREDENTIALS);
  }
}

/** Does a configuration directory hold a Claude login? */
export function hasClaudeLogin(dir: string): boolean {
  return (
    existsSync(join(dir, ".credentials.json")) &&
    readLogin(join(dir, ".credentials.json")) !== undefined
  );
}
