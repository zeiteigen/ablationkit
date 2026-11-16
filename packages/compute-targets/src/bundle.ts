/**
 * Staged run bundles (spec §5.7 "before launch"; ADR 0023).
 *
 *   bundle/bundle.json                      RunBundleManifest (every other file with its SHA-256)
 *   bundle/source/                          `git archive` of the pinned commit (no working tree)
 *   bundle/worker/ablationkit_worker/       the stdlib remote worker
 *   bundle/sdk/ablationkit_sdk/, …          the project-facing SDK packages (on PYTHONPATH)
 *   bundle.tgz                              the archive that is copied to the worker
 *
 * Credentials are never part of the bundle: they travel separately (`credentials.json`, 0600).
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { copyWritable, gitArchive, gitCommit, gitModifiedFiles } from "@ablationkit/core";
import { type RunBundleManifest, validateRunBundleManifest } from "@ablationkit/protocol";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
/** The worker package and the SDK packages that every bundle carries. */
export const WORKER_SRC = join(REPO_ROOT, "python/ablationkit-worker/src/ablationkit_worker");
export const BUNDLE_SDK_SRCS = [
  join(REPO_ROOT, "python/ablationkit-sdk/src/ablationkit_sdk"),
  join(REPO_ROOT, "python/ablationkit-pytorch/src/ablationkit_pytorch"),
  // Remote extension contributions (ADR 0023 decision 26): the runner and `ablationkit_extension.remote`.
  // Bundled backends' job SDKs (`ablationkit_llm`) are added per project by the remote service.
  join(REPO_ROOT, "python/ablationkit-extension/src/ablationkit_extension"),
];

export class BundleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BundleError";
  }
}

/**
 * The checkout's commit to pin, refusing modified tracked files (the bundle must be reproducible).
 * The project's `.ablationkit/` is not source (the coordinator rewrites its research export), so
 * its changes never refuse a job.
 */
export function pinnedCommit(repo: string): string {
  const head = gitCommit(repo);
  if (!head)
    throw new BundleError(
      "no_commit",
      `${repo} has no commit to pin; remote jobs run from a committed revision`,
    );
  const dirty = gitModifiedFiles(repo, [".ablationkit"]);
  if (dirty === undefined) throw new BundleError("git_failed", `git status failed in ${repo}`);
  if (dirty.length > 0)
    throw new BundleError(
      "source_dirty",
      "the checkout has uncommitted changes to tracked files; commit them first (remote jobs run the pinned commit, not the working tree)",
    );
  return head;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile()) out.push(p);
    }
  };
  visit(root);
  return out.sort();
}

function copyPackage(src: string, dest: string): void {
  copyWritable(src, dest, {
    filter: (s) => !s.split(sep).includes("__pycache__") && !s.endsWith(".pyc"),
  });
}

export type BundleSpec = Omit<RunBundleManifest, "files" | "source_commit" | "schema_version">;

export interface BuiltBundle {
  readonly manifest: RunBundleManifest;
  readonly dir: string;
  readonly tgz: string;
  readonly sha256: string;
  readonly size: number;
}

/** Build a bundle for `spec` from `repo` at `commit` into `dir` (replaced if it exists). */
export function buildBundle(input: {
  readonly dir: string;
  readonly repo: string;
  readonly commit: string;
  readonly spec: BundleSpec;
  readonly workerSrc?: string;
  readonly sdkSrcs?: readonly string[];
  /** Staged directories copied to `inputs/<name>` (checksummed like everything else). */
  readonly inputs?: readonly { readonly name: string; readonly path: string }[];
}): BuiltBundle {
  const { dir, repo, commit } = input;
  rmSync(dir, { recursive: true, force: true });
  const b = join(dir, "bundle");
  mkdirSync(join(b, "source"), { recursive: true, mode: 0o700 });
  const tar = join(dir, "source.tar");
  const arch = gitArchive(repo, commit, tar);
  if (arch.code !== 0) throw new BundleError("git_failed", `git archive: ${arch.stderr.trim()}`);
  const x = Bun.spawnSync(["tar", "-xf", tar, "-C", join(b, "source")], { stderr: "pipe" });
  if (x.exitCode !== 0) throw new BundleError("tar_failed", x.stderr.toString().trim());
  rmSync(tar, { force: true });
  copyPackage(input.workerSrc ?? WORKER_SRC, join(b, "worker", "ablationkit_worker"));
  for (const src of input.sdkSrcs ?? BUNDLE_SDK_SRCS)
    copyPackage(src, join(b, "sdk", basename(src)));
  for (const i of input.inputs ?? []) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(i.name))
      throw new BundleError("invalid_request", `bundle input name ${i.name} is not a slug`);
    if (!existsSync(i.path)) throw new BundleError("input_missing", `${i.path} is gone`);
    cpSync(i.path, join(b, "inputs", i.name), { recursive: true, dereference: false });
  }
  const files = walk(b).map((p) => ({
    path: relative(b, p).split(sep).join("/"),
    sha256: sha256(p),
    size: statSync(p).size,
  }));
  const manifest = validateRunBundleManifest({
    schema_version: 1,
    ...input.spec,
    source_commit: commit,
    files,
  });
  if (input.spec.metrics_file?.split("/").includes(".."))
    throw new BundleError("invalid_request", "metrics_file must stay inside the source");
  writeFileSync(join(b, "bundle.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const tgz = join(dir, "bundle.tgz");
  const t = Bun.spawnSync(["tar", "-czf", tgz, "-C", b, "."], { stderr: "pipe" });
  if (t.exitCode !== 0) throw new BundleError("tar_failed", t.stderr.toString().trim());
  return { manifest, dir, tgz, sha256: sha256(tgz), size: lstatSync(tgz).size };
}
