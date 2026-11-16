import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle, pinnedCommit } from "../src/bundle.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ak-bundle-"));
  dirs.push(d);
  return d;
};
const run = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "r",
      GIT_AUTHOR_EMAIL: "r@r",
      GIT_COMMITTER_NAME: "r",
      GIT_COMMITTER_EMAIL: "r@r",
    },
  }).trim();

describe("remote run bundles from a pinned commit", () => {
  test("the project's own .ablationkit/ never makes the checkout dirty", () => {
    const root = tmp();
    const repo = join(root, "repo");
    run(root, "init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "model.py"), "w = 1\n");
    mkdirSync(join(repo, ".ablationkit/research"), { recursive: true });
    writeFileSync(join(repo, ".ablationkit/research/a.md"), "a\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-qm", "first");
    const head = run(repo, "rev-parse", "HEAD");
    // The coordinator rewrites its research export after the commit.
    writeFileSync(join(repo, ".ablationkit/research/a.md"), "b\n");
    expect(pinnedCommit(repo)).toBe(head);
    writeFileSync(join(repo, "model.py"), "w = 2\n");
    expect(() => pinnedCommit(repo)).toThrow("uncommitted changes");
  });

  test("pins HEAD, refuses modified tracked files, and archives the commit, not the tree", () => {
    const root = tmp();
    const repo = join(root, "repo");
    run(root, "init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "model.py"), "w = 1\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-qm", "first");
    const head = run(repo, "rev-parse", "HEAD");
    // A hook in the checkout never runs: the coordinator's Git is read-only and hook-free.
    const marker = join(root, "hook-ran");
    writeFileSync(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(repo, ".git", "hooks", "post-checkout"), 0o755);

    writeFileSync(join(repo, "untracked.txt"), "scratch\n");
    expect(pinnedCommit(repo)).toBe(head);
    writeFileSync(join(repo, "model.py"), "w = 2\n");
    expect(() => pinnedCommit(repo)).toThrow("uncommitted changes");

    const b = buildBundle({
      dir: join(root, "b"),
      repo,
      commit: head,
      spec: {
        bundle_id: "b-0123456789ab",
        project_id: "lab",
        job_id: "job-20261109-0123abcd",
        attempt_id: "job-20261109-0123abcd-a1",
        target_id: "gpu1",
        target_kind: "ssh",
        created_at: "2026-11-09T00:00:00Z",
        worker_url: "http://127.0.0.1:7003",
        argv: ["python", "model.py"],
        environment: "none",
        cwd: ".",
        env: {},
        limits: {},
        artifact_paths: [],
        heartbeat_sec: 5,
        max_backoff_sec: 5,
        spool_max_bytes: 1048576,
        min_free_disk_bytes: 0,
        deliver_deadline_sec: 0,
      } as never,
      sdkSrcs: [],
    });
    const src = join(b.dir, "bundle", "source");
    expect(readFileSync(join(src, "model.py"), "utf8")).toBe("w = 1\n");
    expect(existsSync(join(src, "untracked.txt"))).toBe(false);
    expect(b.manifest.source_commit).toBe(head);
    expect(b.manifest.files.map((f) => f.path)).toContain("source/model.py");
    expect(existsSync(marker)).toBe(false);
  });
});
