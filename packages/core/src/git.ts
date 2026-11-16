/**
 * Read-only Git for the coordinator: the commit a run pins, whether tracked files changed, a
 * file's status, and `git archive` of a pinned commit for a remote run bundle. AblationKit never
 * commits, pushes or merges; the user's harness owns Git (ADR 0037).
 *
 * Every call disables hooks, fsmonitor, pagers, external diff and credential prompts and ignores
 * the inherited `GIT_*` environment: these run in checkouts an agent may have written, and that
 * must never make the coordinator execute anything.
 */

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
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };
}

/** Run one read-only Git command in `cwd`; never throws on a non-zero exit. */
export function readGit(
  cwd: string,
  args: readonly string[],
  opts: { readonly timeoutMs?: number } = {},
): GitResult {
  const p = Bun.spawnSync(["git", ...SAFE_CONFIG.flatMap((c) => ["-c", c]), ...args], {
    cwd,
    env: gitEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? 120_000,
  });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
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
