/**
 * Backup, restore and `coordinator move` (spec §5.3, §5.8, §13; criterion 17; ADR 0025), against a
 * fake MLflow with a real SQLite file standing in for MLflow's database. The real-MLflow restore
 * (runs, registry, prompts, traces, evaluations) is `restore-e2e.test.ts` (`bun run test:restore`).
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import {
  Coordinator,
  CoordinatorMovedError,
  exportBackup,
  moveCoordinator,
  RestoreError,
  restoreBackup,
  runtimePaths,
} from "../src/index.ts";
import { type Client, Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

type Call = <T = Record<string, unknown>>(
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<{ status: number; body: T }>;

/** Stop every coordinator, keeping their directories (the backups live there). */
async function stopAll(): Promise<void> {
  for (const c of h.coordinators.splice(0)) await c.stop();
}

async function until(cond: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

async function boot(
  home: string,
  fake: FakeMlflow,
): Promise<{ cl: Client; call: Call; token: string }> {
  const cl = await h.start({
    home,
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    researchExportDelayMs: 0,
  });
  const token = await cl.session();
  const call: Call = (path, init = {}) => cl.json(cl.human(path, { token, ...init }));
  return { cl, call, token };
}

/** A coordinator with one project, a note, a target and stand-ins for MLflow's files; backed up. */
async function populated() {
  const fake = new FakeMlflow().start();
  fakes.push(fake);
  const home = h.tmp("ak-home-a-");
  const repo = h.repo("lab");
  const { cl, call, token } = await boot(home, fake);
  expect((await call("/api/v1/projects", { body: { path: repo, project_id: "lab" } })).status).toBe(
    201,
  );
  await until(async () => {
    const t = await call<{ links: { experiment_id?: string } }>("/api/v1/projects/lab/tracking");
    return t.body.links.experiment_id !== undefined;
  });
  const note = await call<{ record: { record_id: string } }>("/api/v1/projects/lab/research", {
    body: { kind: "note", title: "Before the move", body: "evidence survives" },
  });
  expect(note.status).toBe(201);
  const t = await call("/api/v1/targets/box", {
    method: "PUT",
    body: { kind: "ssh", ssh: { host: "gpu-box", supervisor: "nohup" } },
  });
  expect([200, 201]).toContain(t.status);
  const paths = cl.c.services.paths;
  mkdirSync(join(paths.mlflowDir, "artifacts", "1", "r1", "artifacts"), { recursive: true });
  writeFileSync(join(paths.mlflowDir, "artifacts", "1", "r1", "artifacts", "model.pkl"), "weights");
  const db = new Database(join(paths.mlflowDir, "mlflow.db"));
  db.run("CREATE TABLE registered_models (name TEXT)");
  db.run("INSERT INTO registered_models VALUES ('digits')");
  db.close();
  // An extension venv is left out of every backup (it holds absolute paths).
  const venv = join(
    paths.stateDir,
    "lab",
    "extensions",
    "x",
    "builds",
    "eb-0123456789abcdef",
    "venv",
  );
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeFileSync(join(venv, "bin", "python"), "#!/bin/sh\n");
  // An ended job's source snapshot is left out; a queued one's is kept (it still runs it).
  for (const [id, state] of [
    ["j-ended", "succeeded"],
    ["j-waits", "queued"],
  ] as const) {
    const jd = join(paths.stateDir, "lab", "jobs", id);
    mkdirSync(join(jd, "source"), { recursive: true });
    writeFileSync(join(jd, "source", "train.py"), "print('x')\n");
    writeFileSync(join(jd, "job.json"), JSON.stringify({ state }));
  }
  const b = await call<{ backup_id: string; path: string }>("/api/v1/backups", { body: {} });
  expect(b.status).toBe(201);
  return { fake, home, repo, cl, call, token, note: note.body.record.record_id, backup: b.body };
}

/** A fresh clone of the project: Git metadata and its committed manifest only. */
function freshClone(repo: string): string {
  const clone = h.repo("lab-clone");
  mkdirSync(join(clone, ".ablationkit"), { recursive: true });
  cpSync(join(repo, ".ablationkit", "project.json"), join(clone, ".ablationkit", "project.json"));
  return clone;
}

describe("backup and restore", () => {
  test("a restore on a clean home reproduces research, tracking and target state; the project is remapped (criterion 17)", async () => {
    const a = await populated();
    const manifest = JSON.parse(readFileSync(join(a.backup.path, "manifest.json"), "utf8"));
    const listed = manifest.files.map((f: { path: string }) => f.path);
    expect(listed).toContain("coordinator/targets/box.json");
    expect(listed.some((p: string) => p.includes("/venv/"))).toBe(false);
    expect(listed.some((p: string) => p.includes("/j-ended/source/"))).toBe(false);
    expect(listed).toContain("coordinator/state/lab/jobs/j-ended/job.json");
    expect(listed).toContain("coordinator/state/lab/jobs/j-waits/source/train.py");
    expect(manifest.projects).toEqual([{ project_id: "lab", path: a.repo }]);
    await stopAll(); // the workstation is gone; only the backup and a fresh clone remain
    const fake = new FakeMlflow().start();
    fakes.push(fake);

    // The backup travels to another machine and is restored there.
    const carried = join(h.tmp("ak-carry-"), "b");
    cpSync(a.backup.path, carried, { recursive: true });
    const clone = freshClone(a.repo);
    const homeB = h.tmp("ak-home-b-");
    const r = await restoreBackup({
      source: carried,
      home: homeB,
      projectPaths: { lab: clone },
      workerUrl: "http://100.64.0.9:7422",
    });
    expect(r.record.projects).toEqual([
      expect.objectContaining({
        project_id: "lab",
        from_path: a.repo,
        to_path: clone,
        checkout: "present",
      }),
    ]);
    expect(r.record.projects[0]?.files_written).toBeGreaterThan(0);
    expect(r.record.sessions_revoked).toBeGreaterThanOrEqual(1);
    expect(r.record.settings_changes).toEqual([
      "remote.worker_url: (unset) -> http://100.64.0.9:7422",
    ]);
    expect(r.record.warnings.join("\n")).toContain("remote workers report to the worker URL");
    // MLflow's database and artifacts are in place for the sidecar.
    const pb = runtimePaths(homeB);
    const db = new Database(join(pb.mlflowDir, "mlflow.db"), { readonly: true });
    expect(db.query("SELECT name FROM registered_models").all()).toEqual([{ name: "digits" }]);
    db.close();
    expect(
      readFileSync(join(pb.mlflowDir, "artifacts", "1", "r1", "artifacts", "model.pkl"), "utf8"),
    ).toBe("weights");
    expect(existsSync(join(clone, ".ablationkit", "research"))).toBe(true);

    const b = await boot(homeB, fake);
    // The old session is gone; research, registry and targets are back.
    expect((await b.cl.human("/api/v1/projects", { token: a.token })).status).toBe(401);
    const note = await b.call<{ record: { title: string } }>(
      `/api/v1/projects/lab/research/${a.note}`,
    );
    expect(note.body.record.title).toBe("Before the move");
    const projects = await b.call<{ projects: { project_id: string; path: string }[] }>(
      "/api/v1/projects",
    );
    expect(projects.body.projects.map((p) => [p.project_id, p.path])).toEqual([["lab", clone]]);
    const targets = await b.call<{ targets: { target_id: string }[] }>("/api/v1/targets");
    expect(targets.body.targets.map((t) => t.target_id)).toEqual(["box"]);
    const ops = await b.call<{
      restored: { backup_id: string };
      diagnostics: { checks: { name: string; status: string }[] };
    }>("/api/v1/system/operations");
    expect(ops.body.restored.backup_id).toBe(a.backup.backup_id);
    expect(ops.body.diagnostics.checks.map((c) => c.name)).toContain("restored from backup");
    // The restore is in the restored audit journal.
    const audit = readdirSync(pb.auditDir)
      .map((f) => readFileSync(join(pb.auditDir, f), "utf8"))
      .join("");
    expect(audit).toContain('"coordinator.restore"');
  });

  test("restore refuses an occupied home, a damaged backup and paths outside the backup; --force moves the old home aside", async () => {
    const a = await populated();
    await stopAll();
    // An occupied home.
    const homeB = h.tmp("ak-home-b-");
    writeFileSync(join(homeB, "registry.json"), '{"schema_version":1,"projects":[]}');
    await expect(restoreBackup({ source: a.backup.path, home: homeB })).rejects.toThrow(
      /already holds coordinator data/,
    );
    const forced = await restoreBackup({ source: a.backup.path, home: homeB, force: true });
    expect(forced.movedAside && existsSync(join(forced.movedAside, "registry.json"))).toBe(true);
    rmSync(forced.movedAside as string, { recursive: true, force: true });

    // A tampered file: nothing is written.
    const damaged = join(h.tmp("ak-carry-"), "b");
    cpSync(a.backup.path, damaged, { recursive: true });
    writeFileSync(join(damaged, "mlflow", "artifacts", "1", "r1", "artifacts", "model.pkl"), "x");
    const homeC = h.tmp("ak-home-c-");
    await expect(restoreBackup({ source: damaged, home: homeC })).rejects.toThrow(
      /checksum mismatch mlflow\/artifacts/,
    );
    expect(existsSync(join(homeC, "registry.json"))).toBe(false);

    // A directory replaced by a symlink to elsewhere, with matching contents: refused.
    const linked = join(h.tmp("ak-carry-"), "b");
    cpSync(a.backup.path, linked, { recursive: true });
    const outside = join(h.tmp("ak-outside-"), "targets");
    cpSync(join(linked, "coordinator", "targets"), outside, { recursive: true });
    rmSync(join(linked, "coordinator", "targets"), { recursive: true });
    symlinkSync(outside, join(linked, "coordinator", "targets"));
    await expect(restoreBackup({ source: linked, home: h.tmp("ak-home-d-") })).rejects.toThrow(
      /outside the backup coordinator\/targets/,
    );

    // A manifest naming a path outside the backup: refused.
    const crafted = join(h.tmp("ak-carry-"), "b");
    cpSync(a.backup.path, crafted, { recursive: true });
    const m = JSON.parse(readFileSync(join(crafted, "manifest.json"), "utf8"));
    m.files.push({ path: "coordinator/state/../../../evil", bytes: 0, sha256: "0".repeat(64) });
    writeFileSync(join(crafted, "manifest.json"), JSON.stringify(m));
    await expect(restoreBackup({ source: crafted, home: h.tmp("ak-home-e-") })).rejects.toThrow(
      RestoreError,
    );
  });

  test("crafted backups: extra files, foreign checkout paths, symlinked checkouts and hostile archives stay out", async () => {
    const a = await populated();
    await stopAll();
    const sha = (b: string) => createHash("sha256").update(b).digest("hex");
    /** A copy of the backup with extra files, listed in its manifest with correct checksums. */
    const crafted = (files: Record<string, string>, unlisted: Record<string, string> = {}) => {
      const dir = join(h.tmp("ak-carry-"), "b");
      cpSync(a.backup.path, dir, { recursive: true });
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      for (const [rel, body] of Object.entries({ ...files, ...unlisted })) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), body);
      }
      for (const [rel, body] of Object.entries(files))
        m.files.push({ path: rel, bytes: body.length, sha256: sha(body) });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
      return dir;
    };

    // A manifest reaching for hooks and dotfiles of the checkout: refused, with a warning.
    const clone = freshClone(a.repo);
    const hook = "projects/lab/.git/hooks/pre-commit";
    const homeA = h.tmp("ak-home-");
    const r = await restoreBackup({
      source: crafted({ [hook]: "#!/bin/sh\nevil\n", "projects/lab/.bashrc": "evil\n" }),
      home: homeA,
      projectPaths: { lab: clone },
    });
    expect(existsSync(join(clone, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(clone, ".bashrc"))).toBe(false);
    expect(r.record.warnings.join("\n")).toContain("were not restored into the checkout");

    // A checkout whose research/ is a symlink elsewhere: the write does not follow it.
    const linkClone = freshClone(a.repo);
    const outside = h.tmp("ak-outside-");
    symlinkSync(outside, join(linkClone, "research"));
    const homeL = h.tmp("ak-home-");
    const rl = await restoreBackup({
      source: crafted({ "projects/lab/research/planted.md": "x" }),
      home: homeL,
      projectPaths: { lab: linkClone },
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(rl.record.warnings.join("\n")).toContain("behind a symlink");

    // Files the manifest does not list are never placed.
    const homeX = h.tmp("ak-home-");
    await restoreBackup({
      source: crafted({}, { "coordinator/state/planted.json": "{}", "coordinator/evil.sh": "x" }),
      home: homeX,
    });
    expect(existsSync(join(homeX, "state", "planted.json"))).toBe(false);
    expect(existsSync(join(homeX, "evil.sh"))).toBe(false);

    // Archives: `..` members, a top-level symlink to a directory that holds a manifest.
    const tgz = (args: string[]) => {
      const out = join(h.tmp(), "a.tgz");
      expect(Bun.spawnSync(["tar", "-czPf", out, ...args]).exitCode).toBe(0);
      return out;
    };
    const f = join(h.tmp(), "f");
    writeFileSync(f, "x");
    const homeT = h.tmp("ak-home-");
    await expect(
      restoreBackup({ source: tgz([`--transform=s|^${f}$|../../evil|`, f]), home: homeT }),
    ).rejects.toThrow(RestoreError);
    expect(existsSync(join(dirname(dirname(join(homeT, "backups"))), "evil"))).toBe(false);
    const linkDir = h.tmp("ak-link-");
    symlinkSync(a.backup.path, join(linkDir, "b"));
    await expect(
      restoreBackup({
        source: tgz(["-C", linkDir, "b"]),
        home: h.tmp("ak-home-"),
      }),
    ).rejects.toThrow(/not a backup archive/);
  });

  test("a retired home stays retired: start and restore refuse it, and a damaged marker fails closed", async () => {
    const a = await populated();
    await stopAll();
    writeFileSync(
      join(a.home, "moved.json"),
      JSON.stringify({
        schema_version: 1,
        moved_at: "2026-11-01T00:00:00.000Z",
        backup_id: a.backup.backup_id,
        archive: "/somewhere/else.tar.gz",
        archive_sha256: "0".repeat(64),
        hostname: "elsewhere",
      }),
    );
    await expect(boot(a.home, a.fake)).rejects.toThrow(/moved to another machine/);
    await expect(
      restoreBackup({ source: a.backup.path, home: a.home, force: true }),
    ).rejects.toThrow(/retired by `coordinator move`/);
    writeFileSync(join(a.home, "moved.json"), "{not json");
    await expect(boot(a.home, a.fake)).rejects.toThrow();
  });

  test("an exported archive restores; a running coordinator blocks an offline restore", async () => {
    const a = await populated();
    const archive = join(h.tmp("ak-arch-"), "lab.tar.gz");
    await exportBackup(a.backup.path, archive);
    // The coordinator is still running on its own home: an offline restore there is refused.
    await expect(restoreBackup({ source: archive, home: a.home, force: true })).rejects.toThrow(
      /another coordinator/,
    );
    const homeB = h.tmp("ak-home-b-");
    const r = await restoreBackup({ source: archive, home: homeB });
    expect(r.backupDir).toBe(join(homeB, "backups", a.backup.backup_id));
    expect(r.record.backup_id).toBe(a.backup.backup_id);
    expect(existsSync(join(homeB, "state", "lab"))).toBe(true);
  });

  test("coordinator move: backs up a stopped coordinator, packs it and retires the home", async () => {
    const b = await populated();
    const homeA = b.home;
    await stopAll();
    const out = join(h.tmp("ak-move-"), "lab-move.tar.gz");
    const mv = await moveCoordinator({ home: homeA, out });
    expect(mv.marker.backup_id).toMatch(/-move$/);
    expect(existsSync(out)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(mv.backupDir, "manifest.json"), "utf8"));
    expect(manifest.quiesce).toBe("coordinator_stopped");
    expect(manifest.reason).toBe("move");
    // The retired home never starts again.
    await expect(
      Coordinator.start({
        home: homeA,
        log: () => {},
        settings: { schema_version: 1, mlflow: { enabled: false } },
      }),
    ).rejects.toBeInstanceOf(CoordinatorMovedError);
    await expect(moveCoordinator({ home: homeA, out: `${out}.2` })).rejects.toThrow(
      /moved to another machine/,
    );
    // The archive restores on the new machine.
    const homeB = h.tmp("ak-home-b-");
    const r = await restoreBackup({ source: out, home: homeB, projectPaths: { lab: b.repo } });
    expect(r.record.backup_reason).toBe("move");
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const nb = await boot(homeB, fake);
    const note = await nb.call<{ record: { title: string } }>(
      `/api/v1/projects/lab/research/${b.note}`,
    );
    expect(note.body.record.title).toBe("Before the move");
  });

  test("a restore scheduled from the System page replaces the home at the next start", async () => {
    const a = await populated();
    const cookie = await a.cl.browserSession();
    const auth = { cookie, origin: a.cl.localOrigin };
    const path = `/api/v1/backups/${a.backup.backup_id}/restore`;
    // A note written after the backup: gone after the restore, kept in the moved-aside home.
    const later = await a.call<{ record: { record_id: string } }>("/api/v1/projects/lab/research", {
      body: { kind: "note", title: "After the backup" },
    });
    const ok = await a.cl.json<{ restart_required: boolean }>(
      a.cl.human(path, { ...auth, body: {} }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.restart_required).toBe(true);
    const listed = await a.call<{ pending_restore: { backup_id: string } }>("/api/v1/backups");
    expect(listed.body.pending_restore.backup_id).toBe(a.backup.backup_id);
    await stopAll();

    const b = await boot(a.home, a.fake);
    expect((await b.call(`/api/v1/projects/lab/research/${a.note}`)).status).toBe(200);
    expect(
      (await b.call(`/api/v1/projects/lab/research/${later.body.record.record_id}`)).status,
    ).toBe(404);
    expect(existsSync(join(a.home, "restore-pending.json"))).toBe(false);
    const aside = readdirSync(dirname(a.home)).filter((n) =>
      n.startsWith(`${a.home.split("/").at(-1)}.pre-restore-`),
    );
    expect(aside.length).toBe(1);
    h.dirs.push(join(dirname(a.home), aside[0] as string));
    const ops = await b.call<{ restored: { backup_id: string }; pending_restore: null }>(
      "/api/v1/system/operations",
    );
    expect(ops.body.restored.backup_id).toBe(a.backup.backup_id);
    expect(ops.body.pending_restore).toBeNull();
  });

  test("startup diagnostics report unreadable records, safe mode and the store (spec §13)", async () => {
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const home = h.tmp("ak-home-");
    const { cl, call } = await boot(home, fake);
    expect(
      (await call("/api/v1/projects", { body: { path: h.repo("lab"), project_id: "lab" } })).status,
    ).toBe(201);
    void cl;
    await stopAll();
    // A job record that no longer parses.
    const jobs = join(home, "state", "lab", "jobs", "j-broken");
    mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, "job.json"), "{ not json");
    const cl2 = await h.start({ home, trackingUrl: fake.url, safeMode: true });
    const token = await cl2.session();
    const ops = await cl2.json<{
      safe_mode: boolean;
      artifact_store: { configured: boolean };
      diagnostics: { status: string; checks: { name: string; status: string; items?: string[] }[] };
    }>(cl2.human("/api/v1/system/operations", { token }));
    expect(ops.status).toBe(200);
    expect(ops.body.safe_mode).toBe(true);
    expect(ops.body.artifact_store).toEqual({ configured: false });
    const by = Object.fromEntries(ops.body.diagnostics.checks.map((c) => [c.name, c]));
    expect(by["safe mode"]?.status).toBe("warn");
    expect(by["unreadable records"]?.status).toBe("fail");
    expect(by["unreadable records"]?.items?.join("")).toContain("j-broken");
    expect(ops.body.diagnostics.status).toBe("fail");
    for (const name of [
      "storage recovery",
      "pending MLflow writes",
      "stalled MLflow updates",
      "orphaned tracking runs",
      "remote workers",
      "missing artifacts",
    ])
      expect(by[name]?.status).toBe("ok");
    void tmpdir;
  });
});
