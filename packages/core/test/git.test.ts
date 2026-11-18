import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitArchive, gitCommit, gitModifiedFiles, readGit } from "../src/index.ts";
import { tempDir } from "./helpers.ts";

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString();
}

/** A repository with one committed file, `f`, changed since (with a later mtime). */
function repo(): { dir: string; marker: string } {
  const root = tempDir();
  const dir = join(root, "r");
  mkdirSync(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "f"), "a\n");
  git(dir, "add", "f");
  git(dir, "commit", "-qm", "init");
  writeFileSync(join(dir, "f"), "b\n");
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(dir, "f"), later, later);
  return { dir, marker: join(root, "ran") };
}

describe("readGit and the repository's own config", () => {
  test("a filter driver the repository defines never runs, and status still reads", () => {
    const { dir, marker } = repo();
    writeFileSync(join(dir, ".gitattributes"), "* filter=evil diff=evil\n");
    git(dir, "config", "filter.evil.clean", `touch ${marker}; cat`);
    git(dir, "config", "filter.evil.smudge", `touch ${marker}; cat`);
    git(dir, "config", "filter.evil.process", `touch ${marker}`);
    git(dir, "config", "diff.evil.textconv", `touch ${marker}; cat`);
    expect(gitModifiedFiles(dir)).toEqual(["f"]);
    const status = readGit(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    expect(status.code).toBe(0);
    expect(status.stdout.split("\0")).toContain("?? .gitattributes");
    const head = gitCommit(dir);
    expect(head).toBeDefined();
    expect(readGit(dir, ["diff", "--name-status", "-z", head ?? "HEAD"]).code).toBe(0);
    expect(gitArchive(dir, head ?? "HEAD", join(dir, "..", "out.tar")).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("an fsmonitor in config.worktree never runs", () => {
    const { dir, marker } = repo();
    git(dir, "config", "extensions.worktreeConfig", "true");
    git(dir, "config", "--worktree", "core.fsmonitor", `touch ${marker}; false`);
    expect(gitModifiedFiles(dir)).toEqual(["f"]);
    expect(existsSync(marker)).toBe(false);
  });

  test("a linked worktree reads through the shadow too", () => {
    const { dir, marker } = repo();
    git(dir, "worktree", "add", "-q", join(dir, "..", "wt"));
    const wt = join(dir, "..", "wt");
    writeFileSync(join(wt, ".gitattributes"), "* filter=evil\n");
    git(dir, "config", "filter.evil.clean", `touch ${marker}; cat`);
    writeFileSync(join(wt, "f"), "c\n");
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(wt, "f"), later, later);
    expect(gitModifiedFiles(wt)).toEqual(["f"]);
    expect(existsSync(marker)).toBe(false);
  });

  test("a core.worktree outside the checkout is refused", () => {
    const { dir } = repo();
    git(dir, "config", "core.worktree", "/");
    expect(readGit(dir, ["status", "--porcelain"]).code).not.toBe(0);
  });

  test("the shadow directory is removed after each call", () => {
    const { dir } = repo();
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("ablationkit-git-")).length;
    gitModifiedFiles(dir);
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("ablationkit-git-")).length;
    expect(after).toBe(before);
  });
});
