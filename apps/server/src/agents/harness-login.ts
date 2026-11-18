/**
 * The researcher's Claude Code login in an agent container (ADR 0063). At start the coordinator
 * copies `<config>/.credentials.json` (by default `~/.claude`) into the container's home and marks
 * Claude Code's onboarding done there, on the same account, with the checkout trusted, so a
 * contained Claude Code starts signed in.
 *
 * Claude Code renews its access token every few hours, and the refresh token most likely rotates:
 * two copies renewing on their own would sign one another out. So while the session runs the two
 * files are kept in step: whichever side renewed (the later `expiresAt`), the fresher login is
 * carried to the other within a monitor tick, and Claude Code, which reloads the file when its
 * modification time changes, picks it up. A login is carried back to this machine only when it
 * parses as a Claude login, renews the same subscription and the container is still signed in to
 * the same account; the file it replaces is backed up first. When the session ends the
 * container's copy is deleted.
 *
 * The agent can read the copy (it uses it): that is the researcher's choice, stated in ADR 0063.
 * The container's side lives in the agent's home, which the agent writes and keeps between
 * sessions: it is read and written only through `AgentHome`, which never follows a link the agent
 * left there onto this machine's files.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/** Write a file the way a reader never sees half of: a temporary file renamed over it. */
function writeAtomic(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.ablationkit-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function accountOf(c: Json | undefined): string | undefined {
  const a = c && isObject(c["oauthAccount"]) ? c["oauthAccount"]["accountUuid"] : undefined;
  return typeof a === "string" ? a : undefined;
}

const fingerprint = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export interface LoginSyncOptions {
  readonly source: LoginSource;
  /** The agent's home on this machine (mounted at /home/agent). */
  readonly home: string;
  /** The checkout, trusted for Claude Code in the container. */
  readonly checkout: string;
  /** Where replaced logins of this machine are backed up (the last five kept). */
  readonly backupDir: string;
  readonly now: () => Date;
  /** Recorded for each renewal carried across. */
  readonly audit: (action: string, details: Record<string, unknown>) => void;
  /** Counts so far (after a coordinator restart). */
  readonly counts?: { readonly synced_back: number; readonly synced_in: number };
}

/** Where the container's copy lives in the agent's home. */
const BOX_CREDENTIALS = ".claude/.credentials.json";
const BOX_CONFIG = ".claude.json";

export class ClaudeLoginSync {
  private readonly box: AgentHome;
  syncedBack: number;
  syncedIn: number;
  stopped: string | undefined;
  private account: string | undefined;
  private subscription: unknown;
  private seen = { host: 0, box: 0 };

  /** The configuration directory the login comes from. */
  get source(): string {
    return this.o.source.dir;
  }

  constructor(private readonly o: LoginSyncOptions) {
    this.box = new AgentHome(o.home);
    this.syncedBack = o.counts?.synced_back ?? 0;
    this.syncedIn = o.counts?.synced_in ?? 0;
    this.account = accountOf(readJsonFile(o.source.globalConfig));
    this.subscription = readLogin(o.source.credentials)?.oauth.subscriptionType;
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
    this.subscription = host.oauth.subscriptionType;
    this.seen = { host: mtime(this.o.source.credentials), box: this.box.mtime(BOX_CREDENTIALS) };
    return true;
  }

  /**
   * Keep the two in step: the fresher login (the later `expiresAt`) is carried to the other side.
   * Returns which way one went, if any.
   */
  sync(): "back" | "in" | undefined {
    if (this.stopped) return undefined;
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
      // Renewed in the container: carried back only on the same subscription and account.
      if (box.oauth.subscriptionType !== this.subscription) {
        this.stop("the container's login is for another subscription");
        return undefined;
      }
      const account = accountOf(parseJson(this.box.read(BOX_CONFIG)));
      if (this.account && account && account !== this.account) {
        this.stop("the container signed in to another account");
        return undefined;
      }
      this.backup(host.text);
      writeAtomic(this.o.source.credentials, box.text, 0o600);
      this.syncedBack++;
      this.seen.host = mtime(this.o.source.credentials);
      this.o.audit("agent.container.login.synced", {
        direction: "back",
        login: fingerprint(box.oauth.refreshToken as string),
      });
      return "back";
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

  /** The session ended: a last renewal is carried back, then the container's copy is deleted. */
  end(): void {
    this.seen = { host: -1, box: -1 };
    this.sync();
    this.box.remove(BOX_CREDENTIALS);
  }

  private stop(reason: string): void {
    this.stopped = reason;
    this.o.audit("agent.container.login.stopped", { reason });
  }

  private backup(text: string): void {
    mkdirSync(this.o.backupDir, { recursive: true, mode: 0o700 });
    const at = this.o.now().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(this.o.backupDir, `credentials-${at}.json`), text, { mode: 0o600 });
    const old = readdirSync(this.o.backupDir)
      .filter((f) => f.startsWith("credentials-"))
      .sort();
    for (const f of old.slice(0, Math.max(0, old.length - 5)))
      rmSync(join(this.o.backupDir, f), { force: true });
  }
}

/** Does a configuration directory hold a Claude login? */
export function hasClaudeLogin(dir: string): boolean {
  return (
    existsSync(join(dir, ".credentials.json")) &&
    readLogin(join(dir, ".credentials.json")) !== undefined
  );
}
