/**
 * `ablationkit dev build` (spec §8.5, criterion 15c): make a reviewable build of AblationKit from
 * the current Git checkout (a branch or worktree a coding agent worked in). It runs the documented
 * checks there, then exports the committed tree (`git archive HEAD`) to
 * `<home>/builds/<build-id>/source/`, installs its locked dependencies and builds its web UI.
 * The running coordinator is not touched; the researcher activates the build in the web UI
 * (System → Coordinator and build) and takes effect at the next `ablationkit coordinator start`.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeJsonAtomic } from "@ablationkit/core";
import { type SourceBuildRecord, validateSourceBuildRecord } from "@ablationkit/protocol";
import { type CliContext, flag, parseArgs, printJson, UsageError } from "../context.ts";

const DEV_BUILD_USAGE = `usage: ablationkit dev build [--from DIR] [--base REF] [--check CMD…] [--skip-checks] [--json]
  Runs the checks (default: bun run lint, bun run typecheck, bun run test) in DIR (default: the
  current Git checkout), then writes a reviewable build to ~/.ablationkit/builds/<id>/.
  The running coordinator is unchanged; activate the build in the web UI, then restart.`;

const DEFAULT_CHECKS = ["bun run lint", "bun run typecheck", "bun run test"];

function run(cmd: string[], cwd: string, timeoutMs = 3_600_000) {
  const started = Date.now();
  const p = Bun.spawnSync(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    env: process.env,
  });
  const out = `${p.stdout.toString()}${p.stderr.toString()}`;
  return { code: p.exitCode ?? -1, out, ms: Date.now() - started };
}

function git(cwd: string, ...args: string[]): string | undefined {
  const r = run(["git", ...args], cwd, 60_000);
  return r.code === 0 ? r.out.trim() : undefined;
}

export async function devBuild(argv: readonly string[], ctx: CliContext): Promise<number> {
  const checks: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--check") {
      const v = argv[++i];
      if (!v) throw new UsageError("--check needs a command");
      checks.push(v);
    } else rest.push(a);
  }
  const args = parseArgs(rest, ["json", "skip-checks", "help"]);
  if (args.flags["help"] === true) {
    ctx.out(`${DEV_BUILD_USAGE}\n`);
    return 0;
  }
  const from = resolve(flag(args, "from") ?? process.cwd());
  const top = git(from, "rev-parse", "--show-toplevel");
  if (!top) throw new UsageError(`${from} is not a Git checkout\n\n${DEV_BUILD_USAGE}`);
  if (!existsSync(join(top, "apps/server/src/main.ts")))
    throw new UsageError(`${top} is not an AblationKit checkout`);
  const commit = git(top, "rev-parse", "HEAD") as string;
  const branch = git(top, "rev-parse", "--abbrev-ref", "HEAD");
  const dirty = git(top, "status", "--porcelain") ?? "";
  if (dirty)
    throw new UsageError(
      "the checkout has uncommitted changes; commit them on your branch first (the build is made from the commit, so reviewers see exactly what runs)",
    );
  const baseRef = flag(args, "base") ?? "main";
  const baseCommit =
    git(top, "merge-base", baseRef, "HEAD") ?? git(top, "merge-base", `origin/${baseRef}`, "HEAD");
  const changed = baseCommit
    ? (git(top, "diff", "--name-only", `${baseCommit}..HEAD`) ?? "").split("\n").filter(Boolean)
    : [];
  const diffstat = baseCommit ? git(top, "diff", "--stat", `${baseCommit}..HEAD`) : undefined;

  const dir = join(ctx.home, "builds");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prefix = `b-${commit.slice(0, 12)}-`;
  const n = readdirSync(dir).filter((x) => x.startsWith(prefix)).length + 1;
  const buildId = `${prefix}${n}`;
  const bdir = join(dir, buildId);
  const source = join(bdir, "source");
  const say = (s: string) => {
    if (args.flags["json"] !== true) ctx.out(`${s}\n`);
  };

  const results: SourceBuildRecord["checks"] = [];
  const list = args.flags["skip-checks"] === true ? [] : checks.length ? checks : DEFAULT_CHECKS;
  if (args.flags["skip-checks"] === true)
    results.push({ command: DEFAULT_CHECKS.join(" && "), status: "skipped", duration_ms: 0 });
  for (const c of list) {
    say(`check: ${c}`);
    const r = run(["sh", "-c", c], top);
    results.push({
      command: c,
      status: r.code === 0 ? "passed" : "failed",
      exit_code: r.code,
      duration_ms: r.ms,
      ...(r.code === 0 ? {} : { output_tail: r.out.slice(-8000) }),
    });
    say(`  ${r.code === 0 ? "passed" : `FAILED (exit ${r.code})`} in ${Math.round(r.ms / 1000)} s`);
  }
  const checksOk = results.every((r) => r.status !== "failed");

  let status: SourceBuildRecord["status"] = checksOk ? "ready" : "checks_failed";
  let error: string | undefined;
  mkdirSync(source, { recursive: true });
  const arch = run(
    ["sh", "-c", `git archive --format=tar HEAD | tar -x -C '${source.replaceAll("'", "'\\''")}'`],
    top,
  );
  if (arch.code !== 0) {
    status = "failed";
    error = `git archive failed: ${arch.out.slice(-2000)}`;
  } else {
    say("installing locked dependencies and building the web UI");
    for (const step of [
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "apps/web/build.ts"],
    ]) {
      const r = run(step, source, 900_000);
      if (r.code !== 0) {
        status = "failed";
        error = `${step.join(" ")} failed: ${r.out.slice(-3000)}`;
        break;
      }
    }
  }
  const rec: SourceBuildRecord = {
    schema_version: 1,
    build_id: buildId,
    commit,
    ...(branch ? { branch } : {}),
    base_ref: baseRef,
    ...(baseCommit ? { base_commit: baseCommit } : {}),
    changed_files: changed.slice(0, 5000),
    ...(diffstat ? { diffstat: diffstat.slice(-20_000) } : {}),
    source_dir: source,
    checks: results,
    status,
    ...(error ? { error: error.slice(0, 4000) } : {}),
    created_at: new Date().toISOString(),
  };
  writeJsonAtomic(join(bdir, "build.json"), rec, { validate: validateSourceBuildRecord });
  if (status === "failed") rmSync(source, { recursive: true, force: true });
  if (args.flags["json"] === true) printJson(ctx, { build: rec });
  else
    ctx.out(
      `${[
        `${buildId} ${status} · ${branch ?? "detached"} @ ${commit.slice(0, 12)} · ${changed.length} files changed against ${baseRef}`,
        ...(error ? [`error: ${error}`] : []),
        status === "ready"
          ? "The running coordinator is unchanged. To run this build: System → Coordinator and build → Activate, then `ablationkit coordinator stop && ablationkit coordinator start`."
          : "Not activatable until it builds and every check passes.",
      ].join("\n")}\n`,
    );
  return status === "ready" ? 0 : 1;
}
