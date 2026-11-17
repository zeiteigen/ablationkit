/**
 * A job's source as it was when it was submitted (ADR 0068): the checkout's files that Git tracks
 * or would track (untracked files that are not ignored), with the ignored files the job's
 * `input_paths` name, copied into a directory of the coordinator's. Wherever an agent's job is
 * placed, it runs this copy, so a queued job runs what was submitted, and the same job runs on any
 * target of its pool. Only read-only Git is used (ADR 0037).
 */
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gitCommit, readGit } from "@ablationkit/core";
import { BundleError } from "./bundle.ts";

/** What a snapshot holds, recorded on the job. */
export interface SourceSnapshot {
  /** The commit the checkout was at, when it had one. */
  readonly commit?: string;
  /** Files that differ from the commit (modified, added, deleted, untracked), at most 200. */
  readonly changed: readonly string[];
  readonly changed_total: number;
  readonly files: number;
  readonly bytes: number;
}

export const SOURCE_MAX_BYTES = 256 * 1024 * 1024;
export const SOURCE_MAX_FILES = 50_000;
const CHANGED_MAX = 200;

/** Never part of a job's source: the repository itself and the coordinator's own records. */
const ALWAYS_LEFT_OUT = [".git", ".ablationkit"];

/** Directories that are never source when there is no Git to say so. */
const NOT_SOURCE = new Set([
  ".git",
  ".ablationkit",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);

function leftOut(rel: string, exclude?: (rel: string) => boolean): boolean {
  const first = rel.split("/")[0] ?? "";
  return ALWAYS_LEFT_OUT.includes(first) || exclude?.(rel) === true;
}

function nul(text: string): string[] {
  return text.split("\0").filter((e) => e.length > 0);
}

/** Every file below `root` (no Git): what is not obviously an environment or a cache. */
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!NOT_SOURCE.has(e.name)) visit(join(d, e.name));
      } else if (e.isFile() || e.isSymbolicLink())
        out.push(relative(root, join(d, e.name)).split(sep).join("/"));
    }
  };
  visit(root);
  return out;
}

/** `git status` entries relative to the repository: what differs from HEAD. */
function changedFiles(repo: string, exclude?: (rel: string) => boolean): string[] {
  const r = readGit(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (r.code !== 0) return [];
  const out: string[] = [];
  const entries = nul(r.stdout);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as string;
    const path = e.slice(3);
    // A rename or copy is followed by its source path.
    if (e[0] === "R" || e[0] === "C") i++;
    if (!leftOut(path, exclude)) out.push(path);
  }
  return out;
}

/**
 * Copy the checkout's source into `dest` (replaced if it exists). `exclude` leaves paths out
 * (hidden paths); `include` adds ignored files by glob (a job's `input_paths`). Throws
 * `source_too_large` past `maxBytes` or `maxFiles`.
 */
export function snapshotSource(input: {
  readonly repo: string;
  readonly dest: string;
  readonly exclude?: (rel: string) => boolean;
  readonly include?: readonly string[];
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}): SourceSnapshot {
  const { repo, dest } = input;
  const maxBytes = input.maxBytes ?? SOURCE_MAX_BYTES;
  const maxFiles = input.maxFiles ?? SOURCE_MAX_FILES;
  const listed = readGit(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const git = listed.code === 0;
  const names = new Set(git ? nul(listed.stdout) : walk(repo));
  for (const pattern of input.include ?? [])
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: repo, dot: true, onlyFiles: true }))
      names.add(rel.split(sep).join("/"));
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  let files = 0;
  let bytes = 0;
  const tooLarge = (what: string) =>
    new BundleError(
      "source_too_large",
      `the job's source (the checkout's files Git tracks or would track) is over ${what}: add data, outputs and other large files to .gitignore. A job reads ignored files on this machine in place, and takes them elsewhere through artifacts`,
    );
  for (const rel of [...names].sort()) {
    if (leftOut(rel, input.exclude) || rel.split("/").includes("..")) continue;
    const src = join(repo, rel);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(src);
    } catch {
      continue; // deleted in the working tree
    }
    if (!st.isFile() && !st.isSymbolicLink()) continue; // a submodule's directory
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), to);
    else {
      bytes += st.size;
      if (bytes > maxBytes) {
        rmSync(dest, { recursive: true, force: true });
        throw tooLarge(`${Math.round(maxBytes / 1024 / 1024)} MiB`);
      }
      copyFileSync(src, to);
      chmodSync(to, st.mode & 0o755);
    }
    files++;
    if (files > maxFiles) {
      rmSync(dest, { recursive: true, force: true });
      throw tooLarge(`${maxFiles} files`);
    }
  }
  const commit = git ? gitCommit(repo) : undefined;
  const changed = git ? changedFiles(repo, input.exclude) : [];
  return {
    ...(commit ? { commit } : {}),
    changed: changed.slice(0, CHANGED_MAX),
    changed_total: changed.length,
    files,
    bytes,
  };
}

/** Cache directories a job never needs from the checkout. */
const CACHES = new Set([
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".venv",
  "venv",
  "node_modules",
  ".ipynb_checkpoints",
]);

/**
 * The checkout's ignored files and directories a job on this machine may read in place (data,
 * earlier outputs), as paths relative to it, shallowest first: never caches, environments, the
 * repository or the coordinator's records. At most `max`.
 */
export function ignoredEntries(repo: string, max = 128): string[] {
  const r = readGit(repo, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (r.code !== 0) return [];
  return nul(r.stdout)
    .map((p) => p.replace(/\/$/, ""))
    .filter((p) => {
      const parts = p.split("/");
      return (
        !ALWAYS_LEFT_OUT.includes(parts[0] ?? "") &&
        !parts.some((x) => CACHES.has(x) || x.endsWith(".egg-info"))
      );
    })
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, max);
}
