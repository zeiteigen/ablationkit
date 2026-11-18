/**
 * Read-only Git for the coordinator: the commit a run pins, whether tracked files changed, a
 * file's status, and `git archive` of a pinned commit for a remote run bundle. AblationKit never
 * commits, pushes or merges; the user's harness owns Git (ADR 0037).
 *
 * Every call disables hooks, fsmonitor, pagers, external diff and credential prompts and ignores
 * the inherited `GIT_*` environment: these run in checkouts an agent may have written, and that
 * must never make the coordinator execute anything. A repository's own configuration can also
 * name commands Git runs on its files (filter drivers, textconv, fsmonitor in `config.worktree`)
 * under names no `-c` override can anticipate, so commands that read the working tree or blobs
 * run against a shadow common directory: the repository's objects, refs and `info/` linked in,
 * and a `config` written from its harmless keys only (`core.*` less the command-naming ones,
 * `extensions.*`, `index.*`). Git never reads the checkout's own config for them, and an agent
 * rewriting it between our read and Git's changes nothing. Submodules are left out
 * (`--ignore-submodules=all`): Git would run in them with their own config.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const SAFE_CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.pager=cat",
  "core.askPass=",
  "credential.interactive=false",
  "diff.external=",
  "gc.auto=0",
  "maintenance.auto=false",
];

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("GIT_")) continue;
    env[k] = v;
  }
  // No optional locks: `git status` must not refresh the checkout's index (read-only Git).
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
}

function spawnGit(
  cwd: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): GitResult {
  const p = Bun.spawnSync(["git", ...SAFE_CONFIG.flatMap((c) => ["-c", c]), ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** Commands that never read the working tree or convert blobs: they run in place. */
const CONFIG_ONLY = new Set(["rev-parse"]);
/** Commands that would recurse into submodules (each with its own, unshadowed config). */
const SUBMODULE_AWARE = new Set(["status", "diff"]);

/** `core.*` keys that name a command, a pager or the work tree: never copied into the shadow. */
const CORE_DENY = new Set([
  "alternaterefscommand",
  "askpass",
  "bare",
  "editor",
  "fsmonitor",
  "gitproxy",
  "hookspath",
  "pager",
  "sshcommand",
  "worktree",
]);

/** The repository's config keys a read may keep: what changes how files are read, nothing run. */
function keptKey(key: string): boolean {
  const [section, name, ...rest] = key.split(".");
  if (!section || !name || rest.length || !/^[a-z0-9-]+$/.test(name)) return false;
  if (section === "core") return !CORE_DENY.has(name);
  if (section === "extensions") return name !== "worktreeconfig";
  return section === "index";
}

function quoteValue(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

/** The kept keys of `file` (with its includes), in order, as `[section, name, value]`. */
function keptConfig(file: string, env: Record<string, string>): [string, string, string][] {
  if (!existsSync(file)) return [];
  const r = spawnGit(
    tmpdir(),
    ["config", "--file", file, "--includes", "--list", "-z"],
    env,
    10_000,
  );
  if (r.code !== 0) return [];
  const out: [string, string, string][] = [];
  for (const entry of r.stdout.split("\0")) {
    const nl = entry.indexOf("\n");
    const key = (nl < 0 ? entry : entry.slice(0, nl)).toLowerCase();
    if (!entry || !keptKey(key)) continue;
    const dot = key.indexOf(".");
    out.push([key.slice(0, dot), key.slice(dot + 1), nl < 0 ? "true" : entry.slice(nl + 1)]);
  }
  return out;
}

/**
 * A shadow common directory for the repository at `common` (worktree `gitDir`): every entry but
 * `config`, `config.worktree` and `hooks` linked in, and a `config` of the kept keys.
 */
function shadowCommonDir(common: string, gitDir: string, env: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ablationkit-git-"));
  for (const name of readdirSync(common)) {
    if (name === "config" || name === "config.worktree" || name === "hooks") continue;
    symlinkSync(join(common, name), join(dir, name));
  }
  const sections = new Map<string, string[]>();
  const entries = [
    ...keptConfig(join(common, "config"), env),
    ...keptConfig(join(gitDir, "config.worktree"), env),
  ];
  for (const [section, name, value] of entries) {
    const lines = sections.get(section) ?? [];
    lines.push(`\t${name} = ${quoteValue(value)}`);
    sections.set(section, lines);
  }
  const core = sections.get("core") ?? [];
  core.push("\tbare = false");
  sections.set("core", core);
  const text = [...sections].map(([s, lines]) => `[${s}]\n${lines.join("\n")}\n`).join("");
  writeFileSync(join(dir, "config"), text, { mode: 0o600 });
  return dir;
}

/** Run one read-only Git command in `cwd`; never throws on a non-zero exit. */
export function readGit(
  cwd: string,
  args: readonly string[],
  opts: { readonly timeoutMs?: number } = {},
): GitResult {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const env = gitEnv();
  if (CONFIG_ONLY.has(args[0] ?? "")) return spawnGit(cwd, args, env, timeoutMs);
  const where = spawnGit(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"],
    env,
    10_000,
  );
  if (where.code !== 0) return where;
  const [gitDir, common, top] = where.stdout.split("\n");
  if (!gitDir || !common || !top) return { code: 128, stdout: "", stderr: "git: no work tree\n" };
  // A `core.worktree` pointing outside the checkout is the config's, not the checkout's.
  const here = realpathSync(cwd);
  if (here !== top && !here.startsWith(`${top}/`))
    return { code: 128, stdout: "", stderr: "git: the work tree does not contain the checkout\n" };
  const shadow = shadowCommonDir(common, gitDir, env);
  try {
    const extra = SUBMODULE_AWARE.has(args[0] ?? "") ? ["--ignore-submodules=all"] : [];
    const [cmd, ...rest] = args;
    return spawnGit(
      cwd,
      [cmd ?? "", ...extra, ...rest],
      { ...env, GIT_DIR: gitDir, GIT_COMMON_DIR: shadow, GIT_WORK_TREE: top },
      timeoutMs,
    );
  } finally {
    rmSync(shadow, { recursive: true, force: true });
  }
}

/** The full SHA of `rev` (default HEAD), or undefined when it does not resolve to a commit. */
export function gitCommit(cwd: string, rev = "HEAD"): string | undefined {
  const r = readGit(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
    timeoutMs: 10_000,
  });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/**
 * Tracked files with uncommitted changes (`git status`, untracked files excluded), anywhere in the
 * repository; `exclude` names paths relative to `cwd` to leave out (e.g. `.ablationkit`).
 */
export function gitModifiedFiles(
  cwd: string,
  exclude: readonly string[] = [],
): string[] | undefined {
  const spec = exclude.length ? ["--", ":/", ...exclude.map((p) => `:(exclude)${p}`)] : [];
  const r = readGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=no", ...spec]);
  if (r.code !== 0) return undefined;
  return r.stdout
    .split("\0")
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3));
}

/** Write `git archive --format=tar` of `commit` to `out`. */
export function gitArchive(cwd: string, commit: string, out: string): GitResult {
  return readGit(cwd, ["archive", "--format=tar", "-o", out, commit]);
}
