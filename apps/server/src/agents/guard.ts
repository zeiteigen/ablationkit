/**
 * The agent guard (ADR 0041): project-scoped rules that keep Claude Code and Codex, working in a
 * registered checkout, out of the coordinator home (`~/.ablationkit`: the login socket and the
 * CLI's saved human session, ADR 0040) and the project's own `.ablationkit/`. The coordinator
 * applies it when a project is registered or remapped; `ablationkit project guard` (run by
 * `scripts/setup.sh`) applies it to checkouts registered before.
 *
 * - Claude Code: `<checkout>/.claude/settings.local.json` (per machine, never committed), merged:
 *   `permissions.deny` rules and `sandbox.filesystem.denyRead`/`denyWrite` entries are added,
 *   nothing else is changed. `sandbox.enabled` is the researcher's choice and is only reported.
 * - Codex: `<checkout>/.codex/config.toml` gets a permission profile, `ablationkit-guard`, made the
 *   default, in two marked blocks AblationKit owns. A file that already chose a sandbox
 *   (`sandbox_mode`, `[sandbox_workspace_write]`, another `default_permissions`) is left alone.
 *
 * Levels (docs/security/README.md): Claude Code's permission rules bind its own tools and the Bash
 * file commands it recognizes; the `sandbox.filesystem` entries bind Bash at the OS level only
 * when `sandbox.enabled` is on. Codex enforces its profile with its sandbox (bubblewrap and
 * seccomp on Linux), but loads `.codex/config.toml` only for a project the user trusts. Neither
 * binds an agent run outside these harnesses.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readGit } from "@ablationkit/core";

export type AgentGuardAction = "created" | "updated" | "unchanged" | "skipped";

export interface AgentGuardFile {
  readonly harness: "claude-code" | "codex";
  /** Absolute path of the file. */
  readonly file: string;
  readonly action: AgentGuardAction;
  readonly note?: string;
  /** Claude Code only: whether the checkout's project settings turn its sandbox on. */
  readonly sandbox_enabled?: boolean;
}

export interface AgentGuardOptions {
  /** The user's home directory (default `os.homedir()`), for the `~/.ablationkit` form. */
  readonly userHome?: string;
}

/** The Codex permission profile's name. */
export const AGENT_GUARD_PROFILE = "ablationkit-guard";

const CLAUDE_FILE = join(".claude", "settings.local.json");
const CODEX_FILE = join(".codex", "config.toml");

/**
 * How the harnesses' configs name the coordinator home: `~/.ablationkit` when it is the default
 * home, else the absolute path; plus its resolved path when that differs (a symlinked home).
 */
export function guardHomeRefs(home: string, userHome = homedir()): string[] {
  const abs = resolve(home);
  const refs = [abs === join(resolve(userHome), ".ablationkit") ? "~/.ablationkit" : abs];
  try {
    const real = realpathSync(abs);
    if (real !== abs) refs.push(real);
  } catch {
    // not created yet: the configured path is all there is
  }
  return refs;
}

/** Apply the guard to one checkout. Never throws: a file it cannot write is reported `skipped`. */
export function applyAgentGuard(
  checkout: string,
  home: string,
  opts: AgentGuardOptions = {},
): AgentGuardFile[] {
  const refs = guardHomeRefs(home, opts.userHome);
  return [
    guarded("claude-code", checkout, CLAUDE_FILE, () => claudeGuard(checkout, refs)),
    guarded("codex", checkout, CODEX_FILE, () => codexGuard(checkout, refs)),
  ];
}

class Skip extends Error {}

function guarded(
  harness: AgentGuardFile["harness"],
  checkout: string,
  rel: string,
  run: () => Omit<AgentGuardFile, "harness" | "file">,
): AgentGuardFile {
  const file = join(checkout, rel);
  try {
    const link = symlinkOnPath(checkout, rel);
    if (link) throw new Skip(`${link} is a symbolic link; AblationKit does not write through it`);
    const r = run();
    let tracked: string | undefined;
    if (r.action === "created" || r.action === "updated") {
      try {
        tracked = gitHygiene(checkout, rel, r.action);
      } catch (e) {
        tracked = `could not add it to .git/info/exclude: ${(e as Error).message}`;
      }
    }
    const note = [r.note, tracked].filter(Boolean).join("; ");
    return { harness, file, ...r, ...(note ? { note } : {}) };
  } catch (e) {
    const note = e instanceof Skip ? e.message : `cannot write it: ${(e as Error).message}`;
    return { harness, file, action: "skipped", note };
  }
}

function symlinkOnPath(checkout: string, rel: string): string | undefined {
  let p = checkout;
  for (const part of rel.split("/")) {
    p = join(p, part);
    try {
      if (lstatSync(p).isSymbolicLink()) return relative(checkout, p);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.ablationkit-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// --- Claude Code ------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function claudeRule(ref: string): string {
  return ref.startsWith("~/") ? `${ref}/**` : `/${ref}/**`;
}

/**
 * The parts of a checkout's `.ablationkit/` the coordinator owns (ADR 0044): the manifest and the
 * exports it rewrites. `extensions/` is not among them: it is extension source agents write
 * (every change is a new build that waits for the researcher's approval).
 */
export const GUARDED_PROJECT_PATHS = [
  ".ablationkit/project.json",
  ".ablationkit/research",
  ".ablationkit/conversations",
  ".ablationkit/llm",
] as const;

/** Entries the guard wrote before ADR 0044 (all of `.ablationkit/`); applying it removes them. */
export const SUPERSEDED_CLAUDE = {
  deny: ["Read(/.ablationkit/**)", "Edit(/.ablationkit/**)"],
  sandbox: ["./.ablationkit"],
} as const;

const claudeProjectRule = (p: string) => (p.endsWith(".json") ? `/${p}` : `/${p}/**`);

/** What the guard adds to `.claude/settings.local.json` (rule paths per Claude Code's syntax). */
export function claudeGuardEntries(refs: readonly string[]): {
  deny: string[];
  denyRead: string[];
  denyWrite: string[];
} {
  const deny = [
    ...refs.flatMap((r) => [`Read(${claudeRule(r)})`, `Edit(${claudeRule(r)})`]),
    ...GUARDED_PROJECT_PATHS.flatMap((p) => [
      `Read(${claudeProjectRule(p)})`,
      `Edit(${claudeProjectRule(p)})`,
    ]),
    "Edit(/.claude/settings.local.json)",
    "Edit(/.claude/settings.json)",
    "Edit(/.codex/config.toml)",
  ];
  const project = GUARDED_PROJECT_PATHS.map((p) => `./${p}`);
  const denyRead = [...refs, ...project];
  const denyWrite = [
    ...refs,
    ...project,
    "./.claude/settings.local.json",
    "./.claude/settings.json",
    "./.codex/config.toml",
  ];
  return { deny, denyRead, denyWrite };
}

function objectAt(parent: Json, key: string, where: string): Json {
  const v = parent[key];
  if (v === undefined) {
    const o: Json = {};
    parent[key] = o;
    return o;
  }
  if (!isObject(v)) throw new Skip(`${where} is not an object; fix it by hand`);
  return v;
}

/** Drop entries the guard itself wrote before ADR 0044 (never anything else). */
function drop(parent: Json, key: string, values: readonly string[]): void {
  const v = parent[key];
  if (Array.isArray(v)) parent[key] = v.filter((x) => !values.includes(x as string));
}

function union(parent: Json, key: string, values: readonly string[], where: string): void {
  const v = parent[key] ?? [];
  if (!Array.isArray(v)) throw new Skip(`${where} is not a list; fix it by hand`);
  const next = [...v];
  for (const x of values) if (!next.includes(x)) next.push(x);
  parent[key] = next;
}

function claudeGuard(
  checkout: string,
  refs: readonly string[],
): Omit<AgentGuardFile, "harness" | "file"> {
  const file = join(checkout, CLAUDE_FILE);
  const existed = existsSync(file);
  let doc: Json = {};
  if (existed) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Skip("not valid JSON; fix it and run `ablationkit project guard` again");
    }
    if (!isObject(parsed)) throw new Skip("not a JSON object; fix it by hand");
    doc = parsed;
  }
  const want = claudeGuardEntries(refs);
  const before = JSON.stringify(doc);
  const perms = objectAt(doc, "permissions", "permissions");
  union(perms, "deny", want.deny, "permissions.deny");
  drop(perms, "deny", SUPERSEDED_CLAUDE.deny);
  const sandbox = objectAt(doc, "sandbox", "sandbox");
  const fs = objectAt(sandbox, "filesystem", "sandbox.filesystem");
  union(fs, "denyRead", want.denyRead, "sandbox.filesystem.denyRead");
  union(fs, "denyWrite", want.denyWrite, "sandbox.filesystem.denyWrite");
  drop(fs, "denyRead", SUPERSEDED_CLAUDE.sandbox);
  drop(fs, "denyWrite", SUPERSEDED_CLAUDE.sandbox);
  const enabled = claudeSandboxEnabled(checkout, doc);
  const note = enabled
    ? undefined
    : "Claude Code's sandbox is off: the deny rules bind Claude's own file tools and the Bash file commands it recognizes, not other programs; turn on sandbox.enabled to have Bash held to them by the OS";
  const base = { sandbox_enabled: enabled, ...(note ? { note } : {}) };
  if (existed && JSON.stringify(doc) === before) return { action: "unchanged", ...base };
  writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { action: existed ? "updated" : "created", ...base };
}

/** `sandbox.enabled` as the checkout's project settings resolve it (local over shared). */
function claudeSandboxEnabled(checkout: string, local: Json): boolean {
  const from = (d: unknown): boolean | undefined =>
    isObject(d) && isObject(d["sandbox"]) && typeof d["sandbox"]["enabled"] === "boolean"
      ? d["sandbox"]["enabled"]
      : undefined;
  const own = from(local);
  if (own !== undefined) return own;
  try {
    return (
      from(JSON.parse(readFileSync(join(checkout, ".claude", "settings.json"), "utf8"))) ?? false
    );
  } catch {
    return false;
  }
}

// --- Codex ------------------------------------------------------------------------------------

const DEFAULT_BEGIN = `# >>> ${AGENT_GUARD_PROFILE}:default`;
const DEFAULT_END = `# <<< ${AGENT_GUARD_PROFILE}:default`;
const PROFILE_BEGIN = `# >>> ${AGENT_GUARD_PROFILE}:profile`;
const PROFILE_END = `# <<< ${AGENT_GUARD_PROFILE}:profile`;

function tomlString(s: string): string {
  return JSON.stringify(s);
}

/** The two blocks AblationKit owns in `.codex/config.toml`. */
export function codexGuardBlocks(refs: readonly string[]): { head: string; profile: string } {
  const head = [
    DEFAULT_BEGIN,
    "# Written by AblationKit (ADRs 0041, 0044): keeps agents out of the coordinator home and the parts of .ablationkit/ it owns.",
    "# `ablationkit project guard` rewrites both marked blocks; edit outside them.",
    `default_permissions = ${tomlString(AGENT_GUARD_PROFILE)}`,
    DEFAULT_END,
    "",
  ].join("\n");
  const profile = [
    PROFILE_BEGIN,
    `[permissions.${AGENT_GUARD_PROFILE}]`,
    'description = "AblationKit: no access to the coordinator home or the coordinator-owned parts of .ablationkit/ (extensions/ stays open)"',
    'extends = ":workspace"',
    "",
    `[permissions.${AGENT_GUARD_PROFILE}.filesystem]`,
    '":root" = "read"',
    ...refs.map((r) => `${tomlString(r)} = "deny"`),
    "",
    `[permissions.${AGENT_GUARD_PROFILE}.filesystem.":workspace_roots"]`,
    ...GUARDED_PROJECT_PATHS.map((p) => `${tomlString(p)} = "deny"`),
    PROFILE_END,
    "",
  ].join("\n");
  return { head, profile };
}

function stripBlocks(text: string): { rest: string; found: boolean } {
  let found = false;
  let rest = text;
  for (const [b, e] of [
    [DEFAULT_BEGIN, DEFAULT_END],
    [PROFILE_BEGIN, PROFILE_END],
  ] as const) {
    const i = rest.indexOf(`${b}\n`);
    const j = i < 0 ? -1 : rest.indexOf(e, i);
    if (i >= 0 && j >= 0) {
      found = true;
      const end = rest.indexOf("\n", j);
      rest = rest.slice(0, i) + (end < 0 ? "" : rest.slice(end + 1));
    }
  }
  return { rest: rest.trim(), found };
}

function compose(rest: string, blocks: { head: string; profile: string }): string {
  return [blocks.head, rest ? `${rest}\n` : "", blocks.profile].filter(Boolean).join("\n");
}

function parseToml(text: string, what: string): Json {
  try {
    const v = Bun.TOML.parse(text);
    return isObject(v) ? v : {};
  } catch (e) {
    throw new Skip(
      `${what} is not valid TOML (${(e as Error).message}); fix it and run \`ablationkit project guard\` again`,
    );
  }
}

/** Whether a parsed config selects a profile that denies every home ref and the owned paths. */
function profileGuards(cfg: Json, refs: readonly string[]): boolean {
  if (cfg["default_permissions"] !== AGENT_GUARD_PROFILE) return false;
  const perms = cfg["permissions"];
  const prof = isObject(perms) ? perms[AGENT_GUARD_PROFILE] : undefined;
  const fs = isObject(prof) ? prof["filesystem"] : undefined;
  if (!isObject(fs)) return false;
  const roots = fs[":workspace_roots"];
  return (
    refs.every((r) => fs[r] === "deny") &&
    isObject(roots) &&
    GUARDED_PROJECT_PATHS.every((p) => roots[p] === "deny")
  );
}

function codexGuard(
  checkout: string,
  refs: readonly string[],
): Omit<AgentGuardFile, "harness" | "file"> {
  const file = join(checkout, CODEX_FILE);
  const blocks = codexGuardBlocks(refs);
  if (!existsSync(file)) {
    writeAtomic(file, compose("", blocks));
    return { action: "created" };
  }
  const text = readFileSync(file, "utf8");
  const { rest, found } = stripBlocks(text);
  const own = parseToml(rest, "the file");
  const conflict =
    own["sandbox_mode"] !== undefined
      ? `it sets sandbox_mode = ${tomlString(String(own["sandbox_mode"]))}`
      : own["sandbox_workspace_write"] !== undefined
        ? "it has a [sandbox_workspace_write] table"
        : own["default_permissions"] !== undefined
          ? `it sets default_permissions = ${tomlString(String(own["default_permissions"]))}`
          : undefined;
  if (conflict) {
    if (!found && profileGuards(own, refs)) return { action: "unchanged" };
    return {
      action: "skipped",
      note: `${conflict}, so Codex would not use the ${AGENT_GUARD_PROFILE} profile there; AblationKit leaves your choice alone. To use the guard, remove it, or add "~/.ablationkit" = "deny", and under ":workspace_roots" ${GUARDED_PROJECT_PATHS.map((p) => `"${p}" = "deny"`).join(", ")}, to the profile you use`,
    };
  }
  const perms = own["permissions"];
  if (isObject(perms) && perms[AGENT_GUARD_PROFILE] !== undefined)
    return {
      action: "skipped",
      note: `it already defines a [permissions.${AGENT_GUARD_PROFILE}] profile that AblationKit did not write; rename or remove it`,
    };
  const next = compose(rest, blocks);
  if (next === text) return { action: "unchanged" };
  // The merged file must still parse and must select the guard as written.
  const merged = parseToml(next, "the merged file");
  if (!profileGuards(merged, refs))
    throw new Skip(
      "the profile could not be added without changing the file's meaning; add it by hand",
    );
  writeAtomic(file, next);
  return { action: "updated" };
}

/**
 * Notes about the user-level Codex config (`$CODEX_HOME/config.toml`): whether Codex will load
 * this checkout's `.codex/config.toml` at all (trusted projects only) and whether a legacy sandbox
 * setting may override it. For the CLI and `scripts/setup.sh`, which run in the user's
 * environment; the coordinator may run with another one.
 */
export function codexUserNotes(
  checkout: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const codexHome = env["CODEX_HOME"] || join(env["HOME"] || homedir(), ".codex");
  if (!existsSync(codexHome)) return [];
  const file = join(codexHome, "config.toml");
  let cfg: Json = {};
  try {
    if (existsSync(file)) {
      const v = Bun.TOML.parse(readFileSync(file, "utf8"));
      if (isObject(v)) cfg = v;
    }
  } catch {
    return [`${file} is not valid TOML; cannot tell whether Codex trusts ${checkout}`];
  }
  const notes: string[] = [];
  const projects = isObject(cfg["projects"]) ? cfg["projects"] : {};
  const paths = new Set([checkout]);
  try {
    paths.add(realpathSync(checkout));
  } catch {
    // a missing checkout keeps its registered path
  }
  const trusted = [...paths].some((p) => {
    const e = projects[p];
    return isObject(e) && e["trust_level"] === "trusted";
  });
  if (!trusted)
    notes.push(
      `Codex loads ${CODEX_FILE} only for trusted projects, and ${checkout} is not trusted in ${file}: trust it when Codex asks, or add [projects.${tomlString(checkout)}] trust_level = "trusted"`,
    );
  if (cfg["sandbox_mode"] !== undefined || cfg["sandbox_workspace_write"] !== undefined)
    notes.push(
      `${file} sets ${cfg["sandbox_mode"] !== undefined ? "sandbox_mode" : "[sandbox_workspace_write]"}; Codex's docs say legacy sandbox settings make it ignore default_permissions (codex-cli 0.167.0 still applied the project's profile over a user-level setting, but --sandbox or -c sandbox_mode does override it)`,
    );
  return notes;
}

// --- Git hygiene ------------------------------------------------------------------------------

/**
 * A file the guard created goes in `.git/info/exclude` (never `.gitignore`) unless Git already
 * ignores or tracks it; a tracked file is left to the researcher. Returns a note, if any.
 */
function gitHygiene(checkout: string, rel: string, action: AgentGuardAction): string | undefined {
  const top = readGit(checkout, ["rev-parse", "--show-toplevel"], { timeoutMs: 10_000 });
  if (top.code !== 0) return undefined;
  let root = top.stdout.trim();
  try {
    root = realpathSync(root);
  } catch {
    return undefined;
  }
  let real = checkout;
  try {
    real = realpathSync(checkout);
  } catch {
    return undefined;
  }
  const path = relative(root, join(real, rel));
  if (path.startsWith("..") || isAbsolute(path)) return undefined;
  const tracked = readGit(root, ["ls-files", "--error-unmatch", "--", path], { timeoutMs: 10_000 });
  if (tracked.code === 0)
    return `${rel} is tracked by Git: it now holds machine-specific paths, so review it before committing`;
  if (action !== "created") return undefined;
  const ignored = readGit(root, ["check-ignore", "-q", "--", path], { timeoutMs: 10_000 });
  if (ignored.code === 0) return undefined;
  const ex = readGit(root, ["rev-parse", "--git-path", "info/exclude"], { timeoutMs: 10_000 });
  if (ex.code !== 0) return undefined;
  const exclude = resolve(root, ex.stdout.trim());
  const line = `/${path}`;
  const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (cur.split("\n").includes(line)) return undefined;
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${line}\n`);
  return undefined;
}
