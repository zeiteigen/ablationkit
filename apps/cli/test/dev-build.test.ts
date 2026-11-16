/**
 * Criterion 15c (spec §8.5): a coding agent changes a core service in a Git branch, runs the
 * checks with `ablationkit dev build` and gets a reviewable build; the running coordinator stays
 * unchanged until the researcher activates it and the next `coordinator start`.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNING_ROOT } from "@ablationkit/server";
import { renderUnit, serverRoot } from "../src/commands/coordinator.ts";
import { Harness, ROOT, cli as run } from "./helpers.ts";

const h = new Harness();
afterEach(h.cleanup);
const tmp = () => h.tmp("ak-devbuild-");
const sh = (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};

test("a branch change to a core service becomes a reviewed build without touching the running coordinator", async () => {
  const home = tmp();
  const clone = join(tmp(), "ablationkit");
  sh(ROOT, "git", "clone", "--quiet", "--no-hardlinks", ROOT, clone);
  sh(clone, "git", "checkout", "-q", "-b", "agent/status-build-field");
  // The change a coding agent makes: a new field on a core service's response.
  const f = join(clone, "apps/server/src/listeners/shell.ts");
  const src = readFileSync(f, "utf8");
  const marker = "          // One coordinator (spec §5.3): the active one is the one answering.";
  expect(src).toContain(marker);
  writeFileSync(f, src.replace(marker, `          variant: "agent-branch",\n${marker}`));
  sh(
    clone,
    "git",
    "-c",
    "user.email=a@b",
    "-c",
    "user.name=agent",
    "commit",
    "-qam",
    "status: report the build variant",
  );
  // Uncommitted changes are refused: the build is made from the commit.
  writeFileSync(join(clone, "scratch.txt"), "x");
  const dirty = await run(home, ["dev", "build", "--from", clone, "--skip-checks"]);
  expect(dirty.code).toBe(2);
  expect(dirty.err).toContain("uncommitted changes");
  rmSync(join(clone, "scratch.txt"));

  const failing = await run(home, ["dev", "build", "--from", clone, "--check", "exit 3", "--json"]);
  expect(failing.code).toBe(1);
  expect(JSON.parse(failing.out).build.status).toBe("checks_failed");

  const b = await run(home, [
    "dev",
    "build",
    "--from",
    clone,
    "--base",
    "main",
    "--check",
    "git diff --check HEAD~1",
    "--json",
  ]);
  expect(b.err).toBe("");
  expect(b.code).toBe(0);
  const rec = JSON.parse(b.out).build;
  expect(rec).toMatchObject({ status: "ready", branch: "agent/status-build-field" });
  expect(rec.changed_files).toContain("apps/server/src/listeners/shell.ts");
  expect(rec.checks[0]).toMatchObject({ command: "git diff --check HEAD~1", status: "passed" });
  expect(
    readFileSync(join(rec.source_dir, "apps/server/src/listeners/shell.ts"), "utf8"),
  ).toContain('variant: "agent-branch"');
  expect(existsSync(join(rec.source_dir, "apps/web/dist/index.html"))).toBe(true);

  // The coordinator that is running is this install, before and after the build exists.
  const c = await h.start(home);
  const s = c.services.builds.status() as {
    modified: boolean;
    running: { root: string };
    restart_required: boolean;
  };
  expect(s.modified).toBe(false);
  expect(s.running.root).toBe(RUNNING_ROOT);
  expect(c.services.builds.list().map((x) => x.build_id)).toContain(rec.build_id);
  // Before activation, `coordinator start` runs this install; after it, the build (next start only).
  expect(serverRoot(home, ROOT)).toEqual({ root: ROOT });
  expect(() => c.services.builds.activate(JSON.parse(failing.out).build.build_id, {})).toThrow(
    /checks_failed/,
  );
  c.services.builds.activate(rec.build_id, { id: "test" });
  expect(serverRoot(home, ROOT)).toEqual({ root: rec.source_dir, build_id: rec.build_id });
  const unit = renderUnit({
    bun: "/usr/bin/bun",
    serverMain: join(rec.source_dir, "apps/server/src/main.ts"),
    home,
    workingDirectory: rec.source_dir,
  });
  expect(unit).toContain(rec.source_dir);
  const after = c.services.builds.status() as {
    modified: boolean;
    restart_required: boolean;
    running: { root: string };
  };
  expect(after.running.root).toBe(RUNNING_ROOT);
  expect(after.restart_required).toBe(true);
  c.services.builds.deactivate({});
  expect(serverRoot(home, ROOT)).toEqual({ root: ROOT });
}, 300_000);
