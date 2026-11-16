/**
 * The desktop shell's rules, kept free of Electron so they are unit-tested (spec §2.1, §8.3;
 * ADR 0025): which coordinator to open, where its windows may navigate, which web permissions a
 * page gets, and how the managed coordinator is started.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type DesktopConfig, validateDesktopConfig } from "@ablationkit/protocol";

export type { DesktopConfig };

export const DEFAULT_CONFIG: DesktopConfig = { schema_version: 1, mode: "managed" };

/** `ABLATIONKIT_DESKTOP_CONFIG`, or `$XDG_CONFIG_HOME/ablationkit/desktop.json`. */
export function configPath(env: Record<string, string | undefined> = process.env): string {
  if (env["ABLATIONKIT_DESKTOP_CONFIG"]) return env["ABLATIONKIT_DESKTOP_CONFIG"];
  const xdg = env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(xdg, "ablationkit", "desktop.json");
}

export function loadConfig(path: string): DesktopConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const v = JSON.parse(readFileSync(path, "utf8"));
  validateDesktopConfig(v);
  return v as DesktopConfig;
}

export function saveConfig(path: string, c: DesktopConfig): void {
  validateDesktopConfig(c);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The runtime directory a managed coordinator uses. */
export function managedHome(c: DesktopConfig, env: Record<string, string | undefined>): string {
  return resolve(c.home ?? (env["ABLATIONKIT_HOME"] || join(homedir(), ".ablationkit")));
}

/** The origin of a URL, or undefined when it is not http(s). */
function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** A remote coordinator URL is HTTPS, or plain http on loopback (no session in clear). */
export function checkRemoteUrl(url: string): string {
  const u = new URL(url);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback))
    throw new Error(
      `${u.origin}: a remote coordinator is reached over HTTPS (for example \`ablationkit access tailscale\` on the workstation); plain http only on this machine`,
    );
  if (u.username || u.password) throw new Error("the URL must not carry credentials");
  return u.origin;
}

/**
 * A pasted one-time login link must point at the chosen coordinator's own `/login`; anything else
 * is refused, so the app never opens a page it was not asked to trust.
 */
export function checkLoginLink(link: string, origin: string): string {
  const u = new URL(link.trim());
  if (u.origin !== origin) throw new Error(`the login link is for ${u.origin}, not ${origin}`);
  if (u.pathname !== "/login" || !u.searchParams.get("code"))
    throw new Error("not a login link: run `ablationkit login --origin URL` on the workstation");
  return u.toString();
}

/** Main-window navigation stays on the coordinator's origin. */
export function navigationAllowed(url: string, coordinator: string | undefined): boolean {
  return coordinator !== undefined && originOf(url) === coordinator;
}

/** Links to other sites open in the system browser, and only http(s) ones. */
export function openExternally(url: string, coordinator: string | undefined): boolean {
  const o = originOf(url);
  return o !== undefined && o !== coordinator;
}

/**
 * Web permissions: notifications for the coordinator's own pages, nothing else (no camera,
 * microphone, geolocation, clipboard reads, MIDI, HID, serial or USB). Extension frames have an
 * opaque origin, so they never match.
 */
export function permissionAllowed(
  permission: string,
  requestingUrl: string | undefined,
  coordinator: string | undefined,
): boolean {
  if (!coordinator || !requestingUrl || originOf(requestingUrl) !== coordinator) return false;
  return permission === "notifications" || permission === "clipboard-sanitized-write";
}

/** The `electron` binary: ABLATIONKIT_ELECTRON, or the first of these on PATH. */
const ELECTRON_CANDIDATES = ["electron", "electron43", "electron42", "electron41"];

export function findElectron(
  env: Record<string, string | undefined>,
  which: (cmd: string) => string | null,
): string | undefined {
  if (env["ABLATIONKIT_ELECTRON"]) return env["ABLATIONKIT_ELECTRON"];
  for (const c of ELECTRON_CANDIDATES) {
    const p = which(c);
    if (p) return p;
  }
  return undefined;
}

/** argv that runs the AblationKit CLI from this checkout (Electron's Node does not run Bun code). */
export function cliArgv(env: Record<string, string | undefined>, repoRoot: string): string[] {
  const bun = env["ABLATIONKIT_BUN"] || "bun";
  return [bun, join(repoRoot, "apps", "cli", "src", "main.ts")];
}

/** The hardened web preferences of every window (spec §8.3). */
export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  experimentalFeatures: false,
  spellcheck: false,
  navigateOnDragDrop: false,
} as const;
