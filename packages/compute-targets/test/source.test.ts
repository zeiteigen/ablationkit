import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "../src/bundle.ts";
import { ignoredEntries, snapshotSource } from "../src/source.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ak-source-"));
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

/** A checkout with tracked, changed, untracked, ignored and hidden files. */
function checkout(): { repo: string; head: string } {
  const root = tmp();
  const repo = join(root, "repo");
  run(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, ".gitignore"), "data/\nruns/\n__pycache__/\nlocal.yaml\n");
  writeFileSync(join(repo, "train.py"), "lr = 1\n");
  writeFileSync(join(repo, "run.sh"), "#!/bin/sh\n");
  execFileSync("chmod", ["+x", join(repo, "run.sh")]);
  writeFileSync(join(repo, "gone.py"), "x\n");
  mkdirSync(join(repo, "eval"));
  writeFileSync(join(repo, "eval", "labels.csv"), "secret\n");
  mkdirSync(join(repo, ".ablationkit", "research"), { recursive: true });
  writeFileSync(join(repo, ".ablationkit", "research", "a.md"), "a\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "first");
  const head = run(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "train.py"), "lr = 2\n");
  rmSync(join(repo, "gone.py"));
  writeFileSync(join(repo, "new.py"), "y\n");
  symlinkSync("train.py", join(repo, "link.py"));
  for (const d of ["data", "runs/a", "src/__pycache__"])
    mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, "data", "big.bin"), "0123456789");
  writeFileSync(join(repo, "runs", "a", "ckpt.pt"), "w");
  writeFileSync(join(repo, "src", "__pycache__", "m.pyc"), "c");
  writeFileSync(join(repo, "local.yaml"), "seed: 1\n");
  return { repo, head };
}

describe("a job's source as submitted (ADR 0068)", () => {
  test("tracked and untracked files as they are, the ignored ones it names; never hidden paths, .git or .ablationkit", () => {
    const { repo, head } = checkout();
    const dest = join(tmp(), "source");
    const s = snapshotSource({
      repo,
      dest,
      exclude: (rel) => rel === "eval" || rel.startsWith("eval/"),
      include: ["local.yaml"],
    });
    expect(readFileSync(join(dest, "train.py"), "utf8")).toBe("lr = 2\n");
    expect(readFileSync(join(dest, "new.py"), "utf8")).toBe("y\n");
    expect(readFileSync(join(dest, "local.yaml"), "utf8")).toBe("seed: 1\n");
    expect(lstatSync(join(dest, "link.py")).isSymbolicLink()).toBe(true);
    expect(statSync(join(dest, "run.sh")).mode & 0o111).not.toBe(0);
    for (const gone of ["gone.py", "eval", "data", "runs", "src", ".git", ".ablationkit"])
      expect([gone, existsSync(join(dest, gone))]).toEqual([gone, false]);
    expect(s.commit).toBe(head);
    expect([...s.changed].sort()).toEqual(["gone.py", "link.py", "new.py", "train.py"]);
    expect(s.changed_total).toBe(4);
    expect(s.files).toBe(6);
  });

  test("too large a source is refused, naming .gitignore", () => {
    const { repo } = checkout();
    const dest = join(tmp(), "source");
    expect(() => snapshotSource({ repo, dest, maxBytes: 8 })).toThrow(/\.gitignore/);
    expect(existsSync(dest)).toBe(false);
    expect(() => snapshotSource({ repo, dest, maxFiles: 2 })).toThrow(/source.*over 2 files/);
  });

  test("a checkout without Git: its files, without environments and caches", () => {
    const repo = tmp();
    writeFileSync(join(repo, "a.py"), "a\n");
    mkdirSync(join(repo, ".venv", "lib"), { recursive: true });
    writeFileSync(join(repo, ".venv", "lib", "x.py"), "x\n");
    const dest = join(tmp(), "source");
    const s = snapshotSource({ repo, dest });
    expect(existsSync(join(dest, "a.py"))).toBe(true);
    expect(existsSync(join(dest, ".venv"))).toBe(false);
    expect(s.commit).toBeUndefined();
  });

  test("ignored entries a job reads in place: data and outputs, never caches", () => {
    const { repo } = checkout();
    // `src/` holds nothing but a cache, so Git reports it whole: harmless, it is empty of source.
    expect(ignoredEntries(repo)).toEqual(["data", "local.yaml", "runs", "src"]);
  });

  test("a remote bundle carries the snapshot, recorded against its commit", () => {
    const { repo, head } = checkout();
    const source = join(tmp(), "source");
    snapshotSource({ repo, dest: source });
    const out = tmp();
    const b = buildBundle({
      dir: out,
      repo,
      commit: head,
      source,
      spec: {
        bundle_id: "b-0123456789ab",
        project_id: "lab",
        job_id: "j-0123456789ab",
        attempt_id: "j-0123456789ab-a1",
        target_id: "gpu",
        target_kind: "ssh",
        created_at: "2026-11-17T12:00:00.000Z",
        worker_url: "http://127.0.0.1:1",
        argv: ["python", "train.py"],
        environment: "none",
        cwd: ".",
        env: {},
        limits: {},
        artifact_paths: [],
        heartbeat_sec: 30,
        max_backoff_sec: 300,
        spool_max_bytes: 1048576,
        min_free_disk_bytes: 1048576,
        deliver_deadline_sec: 60,
      } as never,
    });
    expect(b.manifest.source_commit).toBe(head);
    expect(readFileSync(join(out, "bundle", "source", "train.py"), "utf8")).toBe("lr = 2\n");
    expect(b.manifest.files.map((f) => f.path)).toContain("source/new.py");
  });
});
