/**
 * Remote worker mode end to end (spec §2.1, §5.3, §5.7, §10; criterion 12; ADR 0023).
 *
 * coordinator -> bundle (git archive of the pinned commit + worker + SDK) -> "remote" host ->
 * ablationkit-worker -> job -> worker spool -> handshake/events/resumable uploads -> coordinator
 * -> fake MLflow. The remote host is this machine under its own HOME: a fake `ssh` runs the
 * remote command locally, and fake `sbatch`/`sacct`/`squeue`/`scancel` emulate a SLURM cluster
 * (each job is a detached process group). Everything else is real, including the worker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePrintedArchive } from "@ablationkit/compute-targets";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";
import {
  FakeRunpod,
  killTree,
  fakeHost as makeHost,
  remoteDir,
  sbatchCount,
  stopRemotes,
} from "./remote-host.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
const pods: FakeRunpod[] = [];

afterEach(async () => {
  for (const p of pods.splice(0)) await p.stop();
  stopRemotes();
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

const fakeHost = () => makeHost(h.tmp("ak-remote-"));

type Json = Record<string, unknown>;
interface Remote {
  bundle_id: string;
  staging: string;
  provider_job_id?: string;
  provider_state?: string;
  connectivity: string;
  sync: string;
  reconcile_required?: string;
  worker_id?: string;
  source_commit: string;
  spool_acked_seq: number;
  drains?: number;
  imported_at?: string;
}
interface AttemptView {
  attempt_id: string;
  state: string;
  exit_code?: number;
  error?: string;
  started_at?: string;
  ended_at?: string;
  supervisor: { mode: string; enforcement: string; reason?: string };
  snapshot?: { source_commit?: string; hostname?: string; collector_version?: string };
  artifacts: { path: string; size: number; sha256: string }[];
  tracking: { mlflow_run_id?: string; sync_state?: string };
  ingest?: { accepted: number; duplicates: number };
  remote?: Remote;
}
interface JobView {
  job_id: string;
  state: string;
  attempts: string[];
  target_id?: string;
  latest_attempt: AttemptView;
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(100);
  }
}

function settings(workerPort = 0, remote: Json = {}): CoordinatorSettings {
  return {
    schema_version: 1,
    human: { host: "127.0.0.1", port: 0 },
    agent: { host: "127.0.0.1", port: 0 },
    worker: { host: "127.0.0.1", port: workerPort },
    mlflow: { enabled: false },
    jobs: { supervisor: "direct", deliver_deadline_sec: 60 },
    remote: {
      heartbeat_sec: 1,
      disconnected_after_sec: 3,
      provider_poll_sec: 1,
      max_backoff_sec: 1,
      min_free_disk_bytes: 0,
      ...remote,
    },
  };
}

async function setup(
  opts: { home?: string; fake?: FakeMlflow; workerPort?: number; remote?: Json } = {},
) {
  const fake = opts.fake ?? new FakeMlflow().start();
  if (!opts.fake) fakes.push(fake);
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    jobWatchdogMs: 200,
    remoteTickMs: 200,
    settings: settings(opts.workerPort ?? 0, opts.remote ?? {}),
    ...(opts.home ? { home: opts.home } : {}),
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  return { fake, cl, token, call };
}
type Call = Awaited<ReturnType<typeof setup>>["call"];

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    ["git", "-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
}

/** A committed project repo. */
function project(files: Record<string, string>): { dir: string; commit: string } {
  const dir = join(h.tmp(), "proj");
  mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return { dir, commit: git(dir, "rev-parse", "HEAD") };
}

async function addTarget(call: Call, id: string, body: Json): Promise<void> {
  const r = await call(`/api/v1/targets/${id}`, { method: "PUT", body });
  if (r.status !== 201 && r.status !== 200)
    throw new Error(`target: ${r.status} ${JSON.stringify(r.body)}`);
}

async function job(call: Call, id: string): Promise<JobView> {
  return (await call<JobView>(`/api/v1/jobs/${id}`)).body;
}

async function console_(call: Call, j: JobView, stream = "stdout"): Promise<string[]> {
  const r = await call<{ lines: { text: string }[] }>(
    `/api/v1/jobs/${j.job_id}/attempts/${j.latest_attempt.attempt_id}/console?after=-1&limit=10000&stream=${stream}`,
  );
  return r.body.lines.map((l) => l.text);
}

async function submit(call: Call, projectId: string, body: Json): Promise<JobView> {
  const r = await call<JobView>(`/api/v1/projects/${projectId}/jobs`, { body });
  if (r.status !== 201) throw new Error(`submit: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

const TRAIN = `
import time, ablationkit_sdk as ak
ak.log_params({"lr": 0.1})
for epoch in range(EPOCHS):
    ak.log_metrics({"loss": 1.0 / (epoch + 1)}, step=epoch)
    print(f"epoch {epoch}", flush=True)
    time.sleep(SLEEP)
open("model.bin", "wb").write(b"w" * 4096)
ak.log_artifact("model.bin", artifact_path="ckpt")
`;

function train(epochs: number, sleep: number): string {
  return TRAIN.replace("EPOCHS", String(epochs)).replace("SLEEP", String(sleep));
}

describe("remote worker mode", () => {
  test("an SSH worker runs a staged bundle of the pinned commit and reconciles console, metrics and artifacts", async () => {
    const { fake, call, cl } = await setup();
    const host = fakeHost();
    const repo = project({ "train.py": train(3, 0.05) });
    expect(
      (await call("/api/v1/projects", { body: { path: repo.dir, project_id: "rp" } })).status,
    ).toBe(201);
    await addTarget(call, "box", {
      kind: "ssh",
      ssh: { host: "gpu-box", command: [host.ssh], supervisor: "nohup" },
      worker_url: cl.c.urls.worker,
    });
    const doctor = await call<{
      ok: boolean;
      checks: { name: string; ok: boolean; detail: string }[];
    }>("/api/v1/targets/box/doctor", { body: {} });
    expect(doctor.body.checks.map((c) => [c.name, c.ok])).toEqual([
      ["worker URL", true],
      ["ssh and python", true],
      ["worker listener reachable from the target", true],
      ["work directory", true],
    ]);
    const s = await submit(call, "rp", {
      command: ["python3", "train.py"],
      target_id: "box",
      environment: "none",
    });
    expect(s.target_id).toBe("box");
    expect(s.latest_attempt.supervisor.mode).toBe("remote");
    const j = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.state === "succeeded" &&
        x.latest_attempt.remote?.sync === "synced" &&
        x.latest_attempt.artifacts.length === 1 &&
        x.latest_attempt.tracking.sync_state === "synced"
        ? x
        : undefined;
    });
    const a = j.latest_attempt;
    expect(a.remote).toMatchObject({
      staging: "submitted",
      connectivity: "connected",
      source_commit: repo.commit,
    });
    expect(a.remote?.provider_job_id).toMatch(/^pid:[0-9]+$/);
    expect(a.snapshot?.source_commit).toBe(repo.commit);
    expect(a.snapshot?.collector_version).toContain("ablationkit-worker");
    // The worker reports how limits are applied on its host; nothing is claimed enforced.
    expect(a.supervisor).toMatchObject({ mode: "remote", enforcement: "advisory" });
    expect(await console_(call, j)).toEqual(["epoch 0", "epoch 1", "epoch 2"]);
    const run = fake.run(a.tracking.mlflow_run_id as string);
    expect(run?.info.status).toBe("FINISHED");
    expect(run?.metrics.filter((m) => m.key === "loss").map((m) => m.step)).toEqual([0, 1, 2]);
    expect(run?.params.get("lr")).toBe("0.1");
    expect(run?.artifacts.get("ckpt/model.bin")?.byteLength).toBe(4096);
    // Delivered: the worker removed its spool and credentials on the host.
    const wd = remoteDir(host.home, a.attempt_id);
    expect(existsSync(join(wd, "credentials.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(wd, "state.json"), "utf8")).phase).toBe("synced");
  }, 90_000);

  test("criterion 12: a SLURM job keeps training while the coordinator is down, finishes offline, and reconciles without a second submission", async () => {
    const fakeMl = new FakeMlflow().start();
    fakes.push(fakeMl);
    const home = h.tmp("ak-home-");
    const first = await setup({ home, fake: fakeMl });
    const workerPort = Number(new URL(first.cl.c.urls.worker).port);
    const host = fakeHost();
    const repo = project({ "train.py": train(10, 0.3) });
    await first.call("/api/v1/projects", { body: { path: repo.dir, project_id: "hpc" } });
    await addTarget(first.call, "cluster", {
      kind: "slurm",
      ssh: { host: "login.hpc", command: [host.ssh] },
      slurm: { partition: "gpu", gres: "gpu:1", drain_sec: 1 },
      worker_url: first.cl.c.urls.worker,
    });
    const s = await submit(first.call, "hpc", {
      command: ["python3", "train.py"],
      target_id: "cluster",
      environment: "none",
      limits: { runtime_max_sec: 600, memory_max_bytes: 512 * 1024 * 1024 },
    });
    const attemptId = s.latest_attempt.attempt_id;
    // Mid-epoch: the coordinator (the workstation) shuts down.
    await until(async () =>
      (await console_(first.call, await job(first.call, s.job_id))).includes("epoch 2"),
    );
    const sbatch = readFileSync(join(remoteDir(host.home, attemptId), "job.sbatch"), "utf8");
    expect(sbatch).toContain("#SBATCH --no-requeue");
    expect(sbatch).toContain("#SBATCH --partition=gpu");
    expect(sbatch).toContain("#SBATCH --gres=gpu:1");
    expect(sbatch).toContain("#SBATCH --mem=512M");
    await first.cl.c.stop();
    h.coordinators.splice(h.coordinators.indexOf(first.cl.c), 1);
    // The job finishes while the workstation is off; the worker gives up delivering inside the
    // allocation after drain_sec and leaves its spool on the cluster.
    const slurmId = readdirSync(join(host.home, "slurm")).find((x) => /^[0-9]+$/.test(x)) as string;
    await until(async () => existsSync(join(host.home, "slurm", slurmId, "exit")), 60_000);
    expect(readFileSync(join(host.home, "slurm", slurmId, "exit"), "utf8").trim()).toBe("0");
    expect(existsSync(join(remoteDir(host.home, attemptId), "spool", "exit.json"))).toBe(true);
    // The workstation comes back: provider status says COMPLETED, results are missing, so the
    // coordinator drains the spool from the login node. It never resubmits.
    const second = await setup({ home, fake: fakeMl, workerPort });
    const j = await until(async () => {
      const x = await job(second.call, s.job_id);
      return x.latest_attempt.state === "succeeded" &&
        x.latest_attempt.remote?.sync === "synced" &&
        x.latest_attempt.artifacts.length === 1 &&
        x.latest_attempt.tracking.sync_state === "synced"
        ? x
        : undefined;
    }, 60_000);
    expect(sbatchCount(host.home)).toBe(1);
    expect(j.attempts).toHaveLength(1);
    expect(j.latest_attempt.remote?.provider_state).toBe("COMPLETED");
    expect(j.latest_attempt.remote?.drains).toBeGreaterThanOrEqual(1);
    expect(await console_(second.call, j)).toEqual(
      Array.from({ length: 10 }, (_, i) => `epoch ${i}`),
    );
    const run = fakeMl.run(j.latest_attempt.tracking.mlflow_run_id as string);
    expect(run?.metrics.filter((m) => m.key === "loss").map((m) => m.step)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(run?.artifacts.get("ckpt/model.bin")?.byteLength).toBe(4096);
    expect(run?.info.status).toBe("FINISHED");
  }, 150_000);

  test("a job that finishes while the coordinator is offline delivers on reconnection; a stale upload token is refreshed with the launch token", async () => {
    const fakeMl = new FakeMlflow().start();
    fakes.push(fakeMl);
    const home = h.tmp("ak-home-");
    const first = await setup({ home, fake: fakeMl, remote: { upload_token_ttl_sec: 2 } });
    const workerPort = Number(new URL(first.cl.c.urls.worker).port);
    const host = fakeHost();
    const repo = project({ "train.py": train(4, 0.3) });
    await first.call("/api/v1/projects", { body: { path: repo.dir, project_id: "off" } });
    await addTarget(first.call, "box", {
      kind: "ssh",
      ssh: { host: "box", command: [host.ssh], supervisor: "nohup" },
      worker_url: first.cl.c.urls.worker,
    });
    const s = await submit(first.call, "off", {
      command: ["python3", "train.py"],
      target_id: "box",
      environment: "none",
    });
    await until(async () => (await job(first.call, s.job_id)).latest_attempt.state === "running");
    await first.cl.c.stop();
    h.coordinators.splice(h.coordinators.indexOf(first.cl.c), 1);
    const wd = remoteDir(host.home, s.latest_attempt.attempt_id);
    await until(async () => existsSync(join(wd, "spool", "exit.json")), 30_000);
    await Bun.sleep(2500); // longer than the upload token's lifetime
    const second = await setup({
      home,
      fake: fakeMl,
      workerPort,
      remote: { upload_token_ttl_sec: 2 },
    });
    const j = await until(async () => {
      const x = await job(second.call, s.job_id);
      return x.latest_attempt.state === "succeeded" && x.latest_attempt.remote?.sync === "synced"
        ? x
        : undefined;
    });
    expect(await console_(second.call, j)).toEqual(["epoch 0", "epoch 1", "epoch 2", "epoch 3"]);
    const st = JSON.parse(readFileSync(join(wd, "state.json"), "utf8"));
    expect(st.phase).toBe("synced");
    // The coordinator never resubmitted: one attempt, one worker.
    expect(j.attempts).toHaveLength(1);
  }, 120_000);

  test("worker reboot: the job is reported lost, is not rerun, and waits for a human to resolve it", async () => {
    const { call, cl } = await setup();
    const host = fakeHost();
    const repo = project({
      "train.py":
        "import os, time\nopen(os.environ['MARKER'],'a').write('run\\n')\nprint('up', flush=True)\ntime.sleep(120)\n",
    });
    await call("/api/v1/projects", { body: { path: repo.dir, project_id: "rb" } });
    await addTarget(call, "box", {
      kind: "ssh",
      ssh: { host: "box", command: [host.ssh], supervisor: "nohup" },
      worker_url: cl.c.urls.worker,
    });
    const marker = join(host.home, "runs.txt");
    const s = await submit(call, "rb", {
      command: ["python3", "train.py"],
      target_id: "box",
      environment: "none",
      env: { MARKER: marker },
    });
    const attemptId = s.latest_attempt.attempt_id;
    await until(async () => (await console_(call, await job(call, s.job_id))).includes("up"));
    const wd = remoteDir(host.home, attemptId);
    const st = JSON.parse(readFileSync(join(wd, "state.json"), "utf8"));
    const jobInfo = JSON.parse(readFileSync(join(wd, "spool", "job.json"), "utf8"));
    // A reboot: the worker, its shim and the job die together.
    killTree(st.worker_pid);
    killTree(st.shim_pid);
    killTree(jobInfo.pid, true);
    const j = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.state === "unknown" && x.latest_attempt.remote?.sync === "synced"
        ? x
        : undefined;
    });
    expect(j.latest_attempt.remote?.reconcile_required).toContain("not rerun");
    expect(j.latest_attempt.error).toContain("not rerun");
    expect(j.attempts).toHaveLength(1);
    expect(readFileSync(marker, "utf8")).toBe("run\n");
    // The attention inbox and the status bar say so.
    const inbox = await call<{ items: { id: string; kind: string; ref?: string }[] }>(
      "/api/v1/inbox",
    );
    expect(inbox.body.items).toContainEqual(
      expect.objectContaining({
        id: `reconcile_required:${attemptId}`,
        kind: "reconcile_required",
        ref: `job:${s.job_id}`,
      }),
    );
    const bar = await call<{ offline: Json }>("/api/v1/shell/status");
    expect(bar.body.offline).toMatchObject({ available: true, reconcile_required: 1 });
    // A human looks and accepts the outcome; still no rerun.
    const bad = await call(`/api/v1/jobs/${s.job_id}/attempts/${attemptId}/remote/resolve`, {
      body: {},
    });
    expect(bad.status).toBe(400);
    const ok = await call<{ remote: Remote }>(
      `/api/v1/jobs/${s.job_id}/attempts/${attemptId}/remote/resolve`,
      {
        body: { note: "host rebooted for a kernel update; rerun by hand later" },
      },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.remote.reconcile_required).toBeUndefined();
    expect((await job(call, s.job_id)).attempts).toHaveLength(1);
    const after = await call<{ items: { kind: string }[] }>("/api/v1/inbox");
    expect(after.body.items.filter((i) => i.kind === "reconcile_required")).toEqual([]);
  }, 90_000);

  test("a provider that ends the job outside AblationKit (scancel) leaves it unknown and reconcile_required; never resubmitted", async () => {
    const { call, cl } = await setup();
    const host = fakeHost();
    const repo = project({ "train.py": "import time\nprint('up', flush=True)\ntime.sleep(120)\n" });
    await call("/api/v1/projects", { body: { path: repo.dir, project_id: "pt" } });
    await addTarget(call, "cluster", {
      kind: "slurm",
      ssh: { host: "login", command: [host.ssh] },
      slurm: { drain_sec: 1 },
      worker_url: cl.c.urls.worker,
    });
    const s = await submit(call, "pt", {
      command: ["python3", "train.py"],
      target_id: "cluster",
      environment: "none",
    });
    await until(async () => (await console_(call, await job(call, s.job_id))).includes("up"));
    const id = (await job(call, s.job_id)).latest_attempt.remote?.provider_job_id as string;
    Bun.spawnSync([join(host.bin, "scancel"), id]);
    const j = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.state === "unknown" ? x : undefined;
    });
    expect(j.latest_attempt.remote?.provider_state).toBe("CANCELLED");
    expect(j.latest_attempt.remote?.reconcile_required).toBeDefined();
    expect(sbatchCount(host.home)).toBe(1);
    expect(j.attempts).toHaveLength(1);
  }, 90_000);

  test("cancel reaches a remote job through the heartbeat and the provider", async () => {
    const { call, cl } = await setup();
    const host = fakeHost();
    const repo = project({ "train.py": "import time\nprint('up', flush=True)\ntime.sleep(120)\n" });
    await call("/api/v1/projects", { body: { path: repo.dir, project_id: "cx" } });
    await addTarget(call, "box", {
      kind: "ssh",
      ssh: { host: "box", command: [host.ssh], supervisor: "nohup" },
      worker_url: cl.c.urls.worker,
    });
    const s = await submit(call, "cx", {
      command: ["python3", "train.py"],
      target_id: "box",
      environment: "none",
    });
    await until(async () => (await console_(call, await job(call, s.job_id))).includes("up"));
    expect((await call(`/api/v1/jobs/${s.job_id}/cancel`, { body: {} })).status).toBe(202);
    const j = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.state === "cancelled" && x.latest_attempt.remote?.sync === "synced"
        ? x
        : undefined;
    });
    expect(j.attempts).toHaveLength(1);
  }, 90_000);

  test("a second worker for the same attempt is refused and flagged; a launch token can only hand-shake", async () => {
    const { call, cl } = await setup();
    const host = fakeHost();
    const repo = project({ "train.py": "import time\nprint('up', flush=True)\ntime.sleep(120)\n" });
    await call("/api/v1/projects", { body: { path: repo.dir, project_id: "dup" } });
    await addTarget(call, "box", {
      kind: "ssh",
      ssh: { host: "box", command: [host.ssh], supervisor: "nohup" },
      worker_url: cl.c.urls.worker,
    });
    const s = await submit(call, "dup", {
      command: ["python3", "train.py"],
      target_id: "box",
      environment: "none",
    });
    const a = s.latest_attempt;
    await until(async () => (await job(call, s.job_id)).latest_attempt.state === "running");
    const creds = JSON.parse(
      readFileSync(join(remoteDir(host.home, a.attempt_id), "credentials.json"), "utf8"),
    );
    const base = `/api/v1/jobs/${s.job_id}/attempts/${a.attempt_id}`;
    const events = await cl.worker(`${base}/events:batch`, {
      token: creds.launch_token,
      body: { events: [] },
    });
    expect(events.status).toBe(401);
    const hs = await cl.json<{ error: { code: string } }>(
      cl.worker(`${base}/handshake`, {
        token: creds.launch_token,
        body: {
          schema_version: 1,
          worker_id: "w-00000000deadbeef",
          hostname: "copy-of-the-bundle",
          worker_version: "0.1.0",
          bundle_id: a.remote?.bundle_id,
          phase: "running",
          last_acked_seq: -1,
          spool: {},
          drained: false,
          refresh: false,
        },
      }),
    );
    expect(hs.status).toBe(409);
    expect(hs.body.error.code).toBe("duplicate_execution");
    const j = await job(call, s.job_id);
    expect(j.latest_attempt.remote?.reconcile_required).toContain("second worker");
    expect(j.latest_attempt.state).toBe("running"); // the first worker keeps going
    await call(`/api/v1/jobs/${s.job_id}/cancel`, { body: {} });
  }, 90_000);

  test("an isolated runtime's spool is imported later through the same dedupe (no network to the coordinator)", async () => {
    const { fake, call } = await setup();
    const host = fakeHost();
    const repo = project({ "train.py": train(3, 0) });
    await call("/api/v1/projects", { body: { path: repo.dir, project_id: "iso" } });
    // The worker cannot reach the coordinator at all (a closed port): it runs and spools.
    await addTarget(call, "island", {
      kind: "ssh",
      ssh: { host: "island", command: [host.ssh], supervisor: "nohup" },
      worker_url: "http://127.0.0.1:9",
    });
    const s = await submit(call, "iso", {
      command: ["python3", "train.py"],
      target_id: "island",
      environment: "none",
    });
    const wd = remoteDir(host.home, s.latest_attempt.attempt_id);
    await until(async () => existsSync(join(wd, "spool", "exit.json")), 30_000);
    await Bun.sleep(500);
    const archive = join(h.tmp(), "spool.tgz");
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", wd, "state.json", "spool"]).exitCode).toBe(
      0,
    );
    const imp = await call<{
      accepted: number;
      duplicates: number;
      artifacts: number;
      state: string;
    }>(`/api/v1/jobs/${s.job_id}/attempts/${s.latest_attempt.attempt_id}/remote/import`, {
      body: { archive_path: archive },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.state).toBe("succeeded");
    expect(imp.body.artifacts).toBe(1);
    const again = await call<{ accepted: number; duplicates: number }>(
      `/api/v1/jobs/${s.job_id}/attempts/${s.latest_attempt.attempt_id}/remote/import`,
      { body: { archive_path: archive } },
    );
    expect(again.body.accepted).toBe(0);
    expect(again.body.duplicates).toBeGreaterThan(0);
    const j = await job(call, s.job_id);
    expect(await console_(call, j)).toEqual(["epoch 0", "epoch 1", "epoch 2"]);
    const run = await until(async () => {
      const r = fake.run(j.latest_attempt.tracking.mlflow_run_id as string);
      return r && r.metrics.length === 3 ? r : undefined;
    });
    expect(run.artifacts.get("ckpt/model.bin")?.byteLength).toBe(4096);
  }, 90_000);

  test("submission checks: pinned commits only, a worker URL, valid targets", async () => {
    const { call } = await setup();
    const host = fakeHost();
    const repo = project({ "train.py": "print(1)\n" });
    await call("/api/v1/projects", { body: { path: repo.dir, project_id: "chk" } });
    await addTarget(call, "box", { kind: "ssh", ssh: { host: "box", command: [host.ssh] } });
    const noUrl = await call<{ error: { code: string } }>("/api/v1/projects/chk/jobs", {
      body: { command: ["python3", "train.py"], target_id: "box" },
    });
    expect(noUrl.status).toBe(422);
    expect(noUrl.body.error.code).toBe("no_worker_url");
    await addTarget(call, "box", {
      kind: "ssh",
      ssh: { host: "box", command: [host.ssh] },
      worker_url: "http://ws.tail1234.ts.net:7422",
    });
    writeFileSync(join(repo.dir, "train.py"), "print(2)\n");
    const dirty = await call<{ error: { code: string } }>("/api/v1/projects/chk/jobs", {
      body: { command: ["python3", "train.py"], target_id: "box" },
    });
    expect(dirty.status).toBe(422);
    expect(dirty.body.error.code).toBe("source_dirty");
    const bad = await call<{ error: { code: string } }>("/api/v1/targets/x", {
      method: "PUT",
      body: { kind: "slurm" },
    });
    expect(bad.status).toBe(400);
    const unknown = await call<{ error: { code: string } }>("/api/v1/projects/chk/jobs", {
      body: { command: ["python3", "train.py"], target_id: "nope" },
    });
    expect(unknown.status).toBe(404);
    const list = await call<{ targets: { target_id: string; capabilities: Json }[] }>(
      "/api/v1/targets",
    );
    expect(list.body.targets.map((t) => t.target_id)).toEqual(["box"]);
    expect(list.body.targets[0]?.capabilities).toMatchObject({ independent_supervision: true });
  }, 60_000);
});

describe("Runpod (paid compute, pulled bundles)", () => {
  const KEY_ENV = "AK_TEST_RUNPOD_KEY";

  async function runpodWorld(opts: { home?: string; fake?: FakeMlflow; workerPort?: number } = {}) {
    const env = await setup(opts);
    const podHome = h.tmp("ak-pod-");
    process.env[KEY_ENV] = "rp-test-key";
    const rp = new FakeRunpod(podHome, "rp-test-key").start();
    pods.push(rp);
    return { ...env, rp, podHome };
  }

  async function addPodTarget(
    call: Call,
    rp: FakeRunpod,
    podHome: string,
    workerUrl: string,
    extra: Json = {},
  ): Promise<void> {
    await addTarget(call, "pods", {
      kind: "runpod",
      runpod: {
        api_url: rp.url,
        api_key_env: KEY_ENV,
        image: "python:3.12",
        gpu_type_ids: ["NVIDIA A40"],
        cents_per_hour: 50,
        ...extra,
      },
      work_dir: join(podHome, "workspace", ".ablationkit-worker"),
      worker_url: workerUrl,
    });
  }

  test("a pod pulls and verifies its bundle, runs the job, delivers, and is removed; paid compute needs a time limit and accepted cost", async () => {
    const home = h.tmp("ak-home-");
    const { call, cl, fake, rp, podHome } = await runpodWorld({ home });
    const repo = project({ "train.py": train(3, 0.05) });
    await call("/api/v1/projects", { body: { path: repo.dir, project_id: "rp" } });
    await addPodTarget(call, rp, podHome, cl.c.urls.worker);
    const doctor = await call<{ checks: { name: string; ok: boolean }[] }>(
      "/api/v1/targets/pods/doctor",
      { body: {} },
    );
    expect(doctor.body.checks.find((c) => c.name === "runpod api")?.ok).toBe(true);
    const body = { command: ["python3", "train.py"], target_id: "pods", environment: "none" };
    const noLimit = await call<{ error: { code: string } }>("/api/v1/projects/rp/jobs", { body });
    expect(noLimit.body.error.code).toBe("time_limit_required");
    const limited = { ...body, limits: { runtime_max_sec: 600 } };
    const noCost = await call<{
      error: { code: string; estimate?: { cents: number } };
    }>("/api/v1/projects/rp/jobs", { body: limited });
    expect(noCost.status).toBe(409);
    expect(noCost.body.error.code).toBe("cost_acceptance_required");
    expect(noCost.body.error.estimate?.cents).toBe(9); // 50 cents/hour × 10 minutes
    expect(rp.calls.filter((c) => c === "POST /pods")).toEqual([]);
    const s = await submit(call, "rp", { ...limited, accept_cost: true });
    const j = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.state === "succeeded" &&
        x.latest_attempt.remote?.sync === "synced" &&
        x.latest_attempt.artifacts.length === 1
        ? x
        : undefined;
    });
    expect(j.latest_attempt.remote?.provider_job_id).toBe("pod1");
    expect(await console_(call, j)).toEqual(["epoch 0", "epoch 1", "epoch 2"]);
    expect(fake.run(j.latest_attempt.tracking.mlflow_run_id as string)?.metrics.length).toBe(3);
    // The pod removed itself after delivery; the coordinator's release finds nothing left.
    await until(async () => rp.pods.size === 0 && true);
    await until(async () =>
      (await job(call, s.job_id)).latest_attempt.remote?.provider_state === "released"
        ? true
        : undefined,
    );
    expect(rp.calls.filter((c) => c === "POST /pods")).toHaveLength(1);
    // The staged bundle left the coordinator at first contact; the API key never reached the pod.
    expect(existsSync(join(home, "bundles", j.latest_attempt.attempt_id, "bundle.tgz"))).toBe(
      false,
    );
    const podEnv =
      readFileSync(join(podHome, "pod1.out"), "utf8") +
      readFileSync(join(podHome, "pod1.err"), "utf8");
    expect(podEnv).not.toContain("rp-test-key");
  }, 90_000);

  test("offline: the pod stops itself with results in its spool, and a drain restarts it to deliver without rerunning", async () => {
    const fakeMl = new FakeMlflow().start();
    fakes.push(fakeMl);
    const home = h.tmp("ak-home-");
    const first = await runpodWorld({ home, fake: fakeMl });
    const workerPort = Number(new URL(first.cl.c.urls.worker).port);
    const repo = project({ "train.py": train(6, 0.3) });
    await first.call("/api/v1/projects", { body: { path: repo.dir, project_id: "rpo" } });
    await addPodTarget(first.call, first.rp, first.podHome, first.cl.c.urls.worker, {
      deliver_deadline_sec: 1,
    });
    const s = await submit(first.call, "rpo", {
      command: ["python3", "train.py"],
      target_id: "pods",
      environment: "none",
      limits: { runtime_max_sec: 600 },
      accept_cost: true,
    });
    await until(async () =>
      (await console_(first.call, await job(first.call, s.job_id))).includes("epoch 1"),
    );
    await first.cl.c.stop();
    // Offline: the job finishes, delivery fails past the deadline, and the pod stops itself.
    await until(async () => first.rp.pods.get("pod1")?.desiredStatus === "EXITED" && true, 60_000);
    const second = await setup({ home, fake: fakeMl, workerPort });
    const j = await until(async () => {
      const x = await job(second.call, s.job_id);
      return x.latest_attempt.state === "succeeded" && x.latest_attempt.remote?.sync === "synced"
        ? x
        : undefined;
    }, 60_000);
    expect(await console_(second.call, j)).toEqual([0, 1, 2, 3, 4, 5].map((e) => `epoch ${e}`));
    expect(j.attempts).toHaveLength(1);
    expect(first.rp.calls.filter((c) => c === "POST /pods")).toHaveLength(1);
    expect(first.rp.calls).toContain("POST /pods/pod1/start");
    expect(j.latest_attempt.artifacts.map((a) => a.path)).toEqual(["ckpt/model.bin"]);
  }, 120_000);
});

describe("Colab (exported notebooks, later import)", () => {
  test("a notebook carries the verified bundle and no credentials; running it offline and importing its archive reconciles once", async () => {
    const { call, fake } = await setup();
    const repo = project({ "train.py": train(3, 0) });
    await call("/api/v1/projects", { body: { path: repo.dir, project_id: "cb" } });
    const runtime = h.tmp("ak-colab-");
    await addTarget(call, "colab", { kind: "colab", work_dir: join(runtime, "content") });
    const s = await submit(call, "cb", {
      command: ["python3", "train.py"],
      target_id: "colab",
      environment: "none",
    });
    const exported = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.remote?.staging === "exported" ? x : undefined;
    });
    const a = exported.latest_attempt;
    expect(a.state).toBe("starting");
    const res = await fetchNotebook(call, s.job_id, a.attempt_id);
    const nb = res as { cells: { cell_type: string; source: string[] }[] };
    const code = nb.cells.filter((c) => c.cell_type === "code").map((c) => c.source.join(""));
    const text = JSON.stringify(nb);
    expect(text).not.toMatch(/"launch_token": ?"(?!offline)/);
    expect(text).toContain("bundle checksum mismatch");
    // "Colab": run the cells in order with no route to the coordinator.
    const script = join(runtime, "nb.py");
    writeFileSync(script, code.join("\n\n"));
    const t0 = Date.now();
    const run = Bun.spawnSync(["python3", script], {
      cwd: runtime,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ABLATIONKIT_WORKER_SUPERVISOR: "direct" },
    });
    expect(Date.now() - t0).toBeLessThan(20_000); // never waits on the network
    expect(run.stdout.toString()).toContain("worker exit 75");
    const archive = join(runtime, "content", `ak-${a.attempt_id}-state.tgz`);
    expect(existsSync(archive)).toBe(true);
    // The archive is also printed (a download can silently do nothing): the same bytes.
    const printed = parsePrintedArchive(run.stdout.toString());
    expect(printed.name).toBe(`ak-${a.attempt_id}-state.tgz`);
    expect(Buffer.from(printed.bytes).equals(readFileSync(archive))).toBe(true);
    expect(text).toContain(`remote import ${s.job_id} --base64 FILE`);
    const ranUntil = Date.now();
    // Nothing arrived on its own.
    expect((await job(call, s.job_id)).latest_attempt.state).toBe("starting");
    await Bun.sleep(1500); // the archive comes home later than the job ended
    // Imported into the wrong job: refused, naming whose archive it is, and the other job is untouched.
    const other = await submit(call, "cb", {
      command: ["python3", "train.py"],
      target_id: "colab",
      environment: "none",
    });
    const wrong = await call<{ error: { code: string; message: string } }>(
      `/api/v1/jobs/${other.job_id}/attempts/${other.latest_attempt.attempt_id}/remote/import`,
      { body: { archive_path: archive } },
    );
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("wrong_attempt");
    expect(wrong.body.error.message).toContain(
      `this archive is attempt ${a.attempt_id} (job ${s.job_id}), not ${other.latest_attempt.attempt_id}`,
    );
    const untouched = (await job(call, other.job_id)).latest_attempt;
    expect(untouched.remote?.reconcile_required).toBeUndefined();
    expect(untouched.remote?.imported_at).toBeUndefined();
    await call(`/api/v1/jobs/${other.job_id}/cancel`, { body: {} });
    const imp = await call<{ accepted: number; artifacts: number; state: string }>(
      `/api/v1/jobs/${s.job_id}/attempts/${a.attempt_id}/remote/import`,
      { body: { archive_path: archive } },
    );
    expect(imp.status).toBe(200);
    expect(imp.body.state).toBe("succeeded");
    expect(imp.body.artifacts).toBe(1);
    const again = await call<{ accepted: number; duplicates: number }>(
      `/api/v1/jobs/${s.job_id}/attempts/${a.attempt_id}/remote/import`,
      { body: { archive_path: archive } },
    );
    expect(again.body.accepted).toBe(0);
    const j = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.tracking.sync_state === "synced" ? x : undefined;
    });
    expect(await console_(call, j)).toEqual(["epoch 0", "epoch 1", "epoch 2"]);
    expect(j.latest_attempt.remote?.imported_at).toBeDefined();
    // The attempt ended when the worker's job exited, not when the archive was imported.
    const ended = Date.parse(j.latest_attempt.ended_at as string);
    expect(ended).toBeLessThanOrEqual(ranUntil);
    expect(ended).toBeGreaterThanOrEqual(Date.parse(j.latest_attempt.started_at as string));
    const runRec = fake.run(j.latest_attempt.tracking.mlflow_run_id as string);
    expect(runRec?.info.status).toBe("FINISHED");
    expect(runRec?.info.end_time).toBe(ended);
    expect(runRec?.artifacts.get("ckpt/model.bin")?.byteLength).toBe(4096);
  }, 90_000);

  test("an exported attempt gets an expected-back-by deadline, shows as overdue, and once marked lost ends unknown; a late import still settles it", async () => {
    const { call, cl } = await setup();
    const repo = project({ "train.py": train(2, 0) });
    await call("/api/v1/projects", { body: { path: repo.dir, project_id: "cl" } });
    const runtime = h.tmp("ak-colab-");
    await addTarget(call, "colab", { kind: "colab", work_dir: join(runtime, "content") });
    const s = await submit(call, "cl", {
      command: ["python3", "train.py"],
      target_id: "colab",
      environment: "none",
      limits: { runtime_max_sec: 300 },
    });
    const svc = cl.c.services;
    const attempt = () => {
      const j = svc.jobs.get(s.job_id);
      return j ? svc.jobs.latestAttempt(j) : undefined;
    };
    const exported = await until(async () =>
      attempt()?.remote?.staging === "exported" ? attempt() : undefined,
    );
    const r0 = exported.remote as NonNullable<typeof exported.remote>;
    expect(Date.parse(r0.expected_back_by as string) - Date.parse(r0.submitted_at as string)).toBe(
      35 * 60_000,
    );
    expect(r0.overdue_at).toBeUndefined();
    const waiting = await call<{ items: { kind: string; ref?: string }[] }>("/api/v1/inbox");
    expect(waiting.body.items).toContainEqual(
      expect.objectContaining({ kind: "awaiting_run", ref: `job:${s.job_id}` }),
    );
    svc.jobs.updateAttempt({
      ...exported,
      remote: { ...r0, expected_back_by: new Date(Date.now() - 1000).toISOString() },
    });
    const overdue = await until(async () =>
      attempt()?.remote?.overdue_at ? attempt() : undefined,
    );
    expect(overdue.state).toBe("starting"); // never failed automatically
    const inbox = await call<{ items: { title: string; ref?: string }[] }>("/api/v1/inbox");
    expect(
      inbox.body.items.some((i) => i.ref === `job:${s.job_id}` && i.title.includes("is overdue")),
    ).toBe(true);
    const base = `/api/v1/jobs/${s.job_id}/attempts/${overdue.attempt_id}/remote`;
    expect((await call(`${base}/resolve`, { body: { note: "checked" } })).status).toBe(409);
    const lost = await call<{ remote: { marked_lost_at?: string } }>(`${base}/resolve`, {
      body: { lost: true, note: "runtime deleted" },
    });
    expect(lost.status).toBe(200);
    expect(lost.body.remote.marked_lost_at).toBeDefined();
    expect(attempt()?.state).toBe("unknown");
    // A lost attempt cannot be marked twice.
    expect((await call(`${base}/resolve`, { body: { lost: true } })).status).toBe(409);

    // The notebook did run after all: its archive comes home late and settles the attempt.
    const nb = (await fetchNotebook(call, s.job_id, overdue.attempt_id)) as {
      cells: { cell_type: string; source: string[] }[];
    };
    const script = join(runtime, "nb.py");
    writeFileSync(
      script,
      nb.cells
        .filter((c) => c.cell_type === "code")
        .map((c) => c.source.join(""))
        .join("\n\n"),
    );
    const ran = Bun.spawnSync(["python3", script], {
      cwd: runtime,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ABLATIONKIT_WORKER_SUPERVISOR: "direct" },
    });
    expect(ran.stdout.toString()).toContain("worker exit 75");
    const imp = await call<{ state: string }>(`${base}/import`, {
      body: { archive_path: join(runtime, "content", `ak-${overdue.attempt_id}-state.tgz`) },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.state).toBe("succeeded");
    expect(attempt()?.started_at).toBeDefined();
    expect(attempt()?.error).toBeUndefined();
  }, 90_000);
});

async function fetchNotebook(call: Call, jobId: string, attemptId: string): Promise<unknown> {
  const r = await call(`/api/v1/jobs/${jobId}/attempts/${attemptId}/remote/notebook`);
  if (r.status !== 200) throw new Error(`notebook: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

describe("MLproject entrypoints on remote targets", () => {
  test("an entrypoint runs from the bundle on an SSH worker; path parameters stay relative to the checkout", async () => {
    const { call, cl } = await setup();
    const host = fakeHost();
    const repo = project({
      MLproject: `name: toy
entry_points:
  main:
    parameters:
      data: {type: path, default: in.txt}
      n: {type: float, default: 2}
    command: "python3 train.py --data {data} --n {n}"
`,
      "in.txt": "hello from the bundle\n",
      "train.py":
        "import sys\na = dict(zip(sys.argv[1::2], sys.argv[2::2]))\nprint(a['--data'], open(a['--data']).read().strip(), a['--n'], flush=True)\n",
    });
    await call("/api/v1/projects", { body: { path: repo.dir, project_id: "mlp" } });
    await addTarget(call, "box", {
      kind: "ssh",
      ssh: { host: "box", command: [host.ssh], supervisor: "nohup" },
      worker_url: cl.c.urls.worker,
    });
    const r = await call<{ job: { job_id: string; command: string[] } }>(
      "/api/v1/projects/mlp/mlproject/runs",
      { body: { parameters: { n: "3" }, target_id: "box", environment: "none" } },
    );
    expect(r.status).toBe(202);
    expect(r.body.job.command.at(-1)).toBe("python3 train.py --data in.txt --n 3");
    const j = await until(async () => {
      const x = await job(call, r.body.job.job_id);
      return x.latest_attempt.state === "succeeded" && x.latest_attempt.remote?.sync === "synced"
        ? x
        : undefined;
    });
    expect(j.target_id).toBe("box");
    expect(await console_(call, j)).toEqual(["in.txt hello from the bundle 3"]);
  }, 60_000);
});
