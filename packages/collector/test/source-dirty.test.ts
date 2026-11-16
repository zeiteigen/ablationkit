/** A run's dirty flag: changes its source commit does not hold, never AblationKit's own files. */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceDirty } from "../src/collector.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) =>
  expect(Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" }).exitCode).toBe(0);

test("untracked or modified files make a checkout dirty; .ablationkit/ never does", () => {
  const repo = mkdtempSync(join(tmpdir(), "ak-dirty-"));
  dirs.push(repo);
  expect(sourceDirty(repo)).toBeUndefined();
  sh(repo, "init", "-q");
  sh(repo, "config", "user.email", "t@example.com");
  sh(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "train.py"), "print(1)\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  expect(sourceDirty(repo)).toBe(false);
  // Registration and the research export: untracked, then committed and changed again.
  mkdirSync(join(repo, ".ablationkit/research"), { recursive: true });
  writeFileSync(join(repo, ".ablationkit/project.json"), "{}");
  expect(sourceDirty(repo)).toBe(false);
  sh(repo, "add", ".ablationkit");
  sh(repo, "commit", "-qm", "register");
  writeFileSync(join(repo, ".ablationkit/research/note.md"), "a note");
  writeFileSync(join(repo, ".ablationkit/project.json"), '{"changed": true}');
  expect(sourceDirty(repo)).toBe(false);
  // The source: an untracked script, then an edit to a tracked one.
  writeFileSync(join(repo, "new.py"), "print(2)\n");
  expect(sourceDirty(repo)).toBe(true);
  rmSync(join(repo, "new.py"));
  writeFileSync(join(repo, "train.py"), "print(3)\n");
  expect(sourceDirty(repo)).toBe(true);
});

test("a project in a subdirectory: changes elsewhere in the repository count", () => {
  const repo = mkdtempSync(join(tmpdir(), "ak-dirty-sub-"));
  dirs.push(repo);
  sh(repo, "init", "-q");
  sh(repo, "config", "user.email", "t@example.com");
  sh(repo, "config", "user.name", "t");
  mkdirSync(join(repo, "proj"));
  writeFileSync(join(repo, "proj/train.py"), "1\n");
  writeFileSync(join(repo, "lib.py"), "1\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  mkdirSync(join(repo, "proj/.ablationkit"));
  writeFileSync(join(repo, "proj/.ablationkit/project.json"), "{}");
  expect(sourceDirty(join(repo, "proj"))).toBe(false);
  writeFileSync(join(repo, "lib.py"), "2\n");
  expect(sourceDirty(join(repo, "proj"))).toBe(true);
});
