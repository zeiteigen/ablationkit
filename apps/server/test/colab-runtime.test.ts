/**
 * Colab runtimes through Google's Colab CLI, end to end (ADR 0059).
 *
 * coordinator -> `colab new` -> mkdir, upload bundle and credentials, unpack (`colab exec -f`) ->
 * keeper execution (the local client is killed once it reports) -> worker -> job -> spool ->
 * progress snapshots and the final archive, downloaded through the file API and imported ->
 * `colab stop`. The CLI is `fake-colab.py`: a "runtime" is this machine, so the worker, the
 * keeper and the import are real. Nothing here needs a network or a Google account.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";
import { killTree } from "./remote-host.ts";

const FAKE_COLAB = join(import.meta.dir, "fake-colab.py");
const h = new Harness();
const fakes: FakeMlflow[] = [];
const runtimes: string[] = [];

afterEach(async () => {
  // Workers outlive the coordinator by design: kill what the tests started.
  for (const root of runtimes.splice(0))
    if (existsSync(root))
      for (const a of readdirSync(root)) {
        const read = (p: string): Record<string, unknown> => {
          try {
            return JSON.parse(readFileSync(join(root, a, p), "utf8"));
          } catch {
            return {};
          }
        };
        const st = read("state.json");
        killTree(st["worker_pid"]);
        killTree(st["shim_pid"]);
        killTree(read("spool/job.json")["pid"], true);
        killTree(read("ak-keeper.json")["worker_pid"]);
      }
  delete process.env["FAKE_COLAB_SIGNED_OUT"];
  delete process.env["FAKE_COLAB_REFUSE"];
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

type Json = Record<string, unknown>;
interface Remote {
  staging: string;
  staging_error?: string;
  provider_job_id?: string;
  provider_state?: string;
  sync: string;
  sync_error?: string;
  imported_at?: string;
  reconcile_required?: string;
  compute_units?: {
    per_hour_hundredths: number;
    balance_at_allocation_hundredths?: number;
    allocated_at: string;
    released_at?: string;
  };
}
interface AttemptView {
  attempt_id: string;
  state: string;
  error?: string;
  artifacts: { path: string }[];
  tracking: { mlflow_run_id?: string; sync_state?: string };
  remote?: Remote;
}
interface JobView {
  job_id: string;
  latest_attempt: AttemptView;
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(100);
  }
}

function settings(): CoordinatorSettings {
  return {
    schema_version: 1,
    human: { host: "127.0.0.1", port: 0 },
    agent: { host: "127.0.0.1", port: 0 },
    worker: { host: "127.0.0.1", port: 0 },
    mlflow: { enabled: false },
    jobs: { supervisor: "direct", deliver_deadline_sec: 60 },
    remote: {
      heartbeat_sec: 1,
      disconnected_after_sec: 3,
      provider_poll_sec: 1,
      max_backoff_sec: 1,
      min_free_disk_bytes: 0,
    },
  };
}

async function setup() {
  process.env["ABLATIONKIT_COLAB_PROGRESS_SEC"] = "0.5";
  const fake = new FakeMlflow().start();
  fakes.push(fake);
  const home = h.tmp("ak-home-");
  const cl = await h.start({
    home,
    ...(process.env["AK_TEST_LOG"] ? { log: (l: string) => console.log("[coord]", l) } : {}),
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    jobWatchdogMs: 200,
    remoteTickMs: 200,
    settings: settings(),
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  return { fake, cl, call, home };
}
type Call = Awaited<ReturnType<typeof setup>>["call"];

function git(dir: string, ...args: string[]): void {
  const p = Bun.spawnSync(
    ["git", "-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
}

function project(files: Record<string, string>): string {
  const dir = join(h.tmp(), "proj");
  mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
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
const train = (epochs: number, sleep: number): string =>
  TRAIN.replace("EPOCHS", String(epochs)).replace("SLEEP", String(sleep));

/** A Colab CLI target whose runtimes are directories under a fresh temporary root. */
async function colabTarget(
  call: Call,
  home: string,
  colab: Json = {},
): Promise<{ root: string; state: string }> {
  const root = join(h.tmp("ak-colab-rt-"), "content", "ablationkit");
  mkdirSync(root, { recursive: true });
  runtimes.push(root);
  const r = await call("/api/v1/targets/colab", {
    method: "PUT",
    body: {
      kind: "colab",
      work_dir: root,
      colab: { mode: "cli", cli: ["python3", FAKE_COLAB], gpu: "L4", keep_after_sec: 30, ...colab },
    },
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(JSON.stringify(r.body));
  return { root, state: join(home, "colab", "sessions.json") };
}

function sessions(stateFile: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

async function job(call: Call, id: string): Promise<JobView> {
  return (await call<JobView>(`/api/v1/jobs/${id}`)).body;
}

async function submit(call: Call, projectId: string, body: Json): Promise<JobView> {
  const r = await call<JobView>(`/api/v1/projects/${projectId}/jobs`, { body });
  if (r.status !== 201) throw new Error(`submit: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

describe("Colab runtimes through the Colab CLI", () => {
  test("a job runs unattended: the runtime is allocated and staged, progress arrives while it runs, results are collected, and the runtime is stopped", async () => {
    const { call, fake, home } = await setup();
    const repo = project({ "train.py": train(6, 0.6) });
    await call("/api/v1/projects", { body: { path: repo, project_id: "cr" } });
    const { root, state } = await colabTarget(call, home);
    // No worker URL anywhere: the coordinator collects.
    const doctor = await call<{
      ok: boolean;
      checks: { name: string; ok: boolean; detail: string }[];
    }>("/api/v1/targets/colab/doctor", { body: {} });
    expect(doctor.body.ok).toBe(true);
    expect(doctor.body.checks.map((c) => c.name)).toEqual([
      "colab cli",
      "signed in",
      "compute units",
      "runtime",
      "unattended execution",
      "live delivery",
    ]);
    const list = await call<{ targets: { capabilities?: Json }[] }>("/api/v1/targets");
    expect(list.body.targets[0]?.capabilities).toMatchObject({ submit: true, collects: true });

    const s = await submit(call, "cr", {
      command: ["python3", "train.py"],
      target_id: "colab",
      environment: "none",
      limits: { runtime_max_sec: 600 },
    });
    // Progress: the attempt starts running from a snapshot while the job still runs.
    const running = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.state === "running" ? x : undefined;
    });
    const a = running.latest_attempt;
    expect(a.remote?.staging).toBe("submitted");
    expect(a.remote?.provider_job_id).toBe(`ak-${a.attempt_id}`);
    expect(a.remote?.imported_at).toBeDefined();
    expect(a.remote?.compute_units).toMatchObject({
      per_hour_hundredths: 150,
      balance_at_allocation_hundredths: 10000,
    });
    expect(sessions(state)[`ak-${a.attempt_id}`]).toBeDefined();
    // The bundle was verified, unpacked and removed; the worker has offline credentials only.
    const wd = join(root, a.attempt_id);
    expect(existsSync(join(wd, "bundle", "bundle.json"))).toBe(true);
    expect(existsSync(join(wd, "bundle.tgz"))).toBe(false);
    expect(readFileSync(join(wd, "credentials.json"), "utf8")).toContain(
      '"launch_token":"offline"',
    );
    const usage = await call<{ per_hour_hundredths: number; runtimes: number }>(
      "/api/v1/targets/colab/usage",
    );
    expect(usage.body).toMatchObject({ per_hour_hundredths: 150, runtimes: 1 });

    const done = await until(async () => {
      const x = await job(call, s.job_id);
      const r = x.latest_attempt.remote;
      return x.latest_attempt.state === "succeeded" &&
        r?.sync === "synced" &&
        r.provider_state === "released" &&
        x.latest_attempt.tracking.sync_state === "synced"
        ? x
        : undefined;
    });
    const fin = done.latest_attempt;
    expect(fin.artifacts.map((x) => x.path)).toEqual(["ckpt/model.bin"]);
    expect(fin.remote?.compute_units?.released_at).toBeDefined();
    // Released: the runtime is stopped.
    expect(sessions(state)[`ak-${a.attempt_id}`]).toBeUndefined();
    const lines = await call<{ lines: { text: string }[] }>(
      `/api/v1/jobs/${s.job_id}/attempts/${fin.attempt_id}/console?after=-1&limit=100&stream=stdout`,
    );
    expect(lines.body.lines.map((l) => l.text)).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `epoch ${i}`),
    );
    const run = fake.run(fin.tracking.mlflow_run_id as string);
    expect(run?.info.status).toBe("FINISHED");
    expect(run?.metrics.filter((m) => m.key === "loss").map((m) => m.step)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(run?.artifacts.get("ckpt/model.bin")?.byteLength).toBe(4096);
  }, 120_000);

  test("cancel reaches the job through the keeper; the runtime is released", async () => {
    const { call, home } = await setup();
    const repo = project({ "train.py": train(200, 0.2) });
    await call("/api/v1/projects", { body: { path: repo, project_id: "cc" } });
    const { state } = await colabTarget(call, home);
    const s = await submit(call, "cc", {
      command: ["python3", "train.py"],
      target_id: "colab",
      environment: "none",
    });
    const running = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.state === "running" ? x : undefined;
    });
    expect((await call(`/api/v1/jobs/${s.job_id}/cancel`, { body: {} })).status).toBe(202);
    const done = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.state === "cancelled" &&
        x.latest_attempt.remote?.provider_state === "released"
        ? x
        : undefined;
    });
    expect(done.latest_attempt.remote?.sync).toBe("synced");
    expect(sessions(state)[`ak-${running.latest_attempt.attempt_id}`]).toBeUndefined();
  }, 120_000);

  test("a CLI that is not signed in, or an accelerator the account cannot have, fails the attempt before anything runs, with no token in the error", async () => {
    const { call, home } = await setup();
    const repo = project({ "train.py": train(1, 0) });
    await call("/api/v1/projects", { body: { path: repo, project_id: "cs" } });
    const { state } = await colabTarget(call, home);
    process.env["FAKE_COLAB_SIGNED_OUT"] = "1";
    const doctor = await call<{
      ok: boolean;
      checks: { name: string; ok: boolean; detail: string }[];
    }>("/api/v1/targets/colab/doctor", { body: {} });
    expect(doctor.body.ok).toBe(false);
    const signin = doctor.body.checks.find((c) => c.name === "signed in");
    expect(signin?.ok).toBe(false);
    expect(signin?.detail).toContain("colab sessions");
    expect(signin?.detail).not.toContain("accounts.google.com");
    const usage = await call<{ error: { code: string } }>("/api/v1/targets/colab/usage");
    expect(usage.status).toBe(502);
    expect(usage.body.error.code).toBe("colab_signin_required");
    const s1 = await submit(call, "cs", {
      command: ["python3", "train.py"],
      target_id: "colab",
      environment: "none",
    });
    const failed = await until(async () => {
      const x = await job(call, s1.job_id);
      return x.latest_attempt.state === "failed" ? x : undefined;
    });
    expect(failed.latest_attempt.remote?.staging).toBe("failed");
    expect(failed.latest_attempt.remote?.staging_error).toContain("not signed in");
    expect(failed.latest_attempt.remote?.staging_error).toContain("colab sessions");
    delete process.env["FAKE_COLAB_SIGNED_OUT"];

    process.env["FAKE_COLAB_REFUSE"] = "L4";
    const s2 = await submit(call, "cs", {
      command: ["python3", "train.py"],
      target_id: "colab",
      environment: "none",
    });
    const refused = await until(async () => {
      const x = await job(call, s2.job_id);
      return x.latest_attempt.state === "failed" ? x : undefined;
    });
    expect(refused.latest_attempt.remote?.staging_error).toContain("Backend rejected accelerator");
    expect(Object.keys(sessions(state))).toEqual([]);
  }, 120_000);

  test("a failure after the runtime was allocated releases it, and the CLI's tokens never reach the record", async () => {
    const { call, home } = await setup();
    const repo = project({ "train.py": train(1, 0) });
    await call("/api/v1/projects", { body: { path: repo, project_id: "cu" } });
    // The uploads go beside the worker directory, into a directory that does not exist on this
    // "runtime": the upload fails with the CLI's HTTP error, which prints the runtime's token.
    const root = join(h.tmp("ak-colab-rt-"), "missing", "ablationkit");
    const r = await call("/api/v1/targets/colab", {
      method: "PUT",
      body: {
        kind: "colab",
        work_dir: root,
        colab: { mode: "cli", cli: ["python3", FAKE_COLAB], gpu: "L4" },
      },
    });
    expect(r.status).toBe(201);
    const state = join(home, "colab", "sessions.json");
    const s = await submit(call, "cu", {
      command: ["python3", "train.py"],
      target_id: "colab",
      environment: "none",
    });
    const failed = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.state === "failed" ? x : undefined;
    });
    const err = failed.latest_attempt.remote?.staging_error ?? "";
    expect(err).toContain("Upload failed");
    expect(err).not.toMatch(/eyJ|proxy-token=(?!REDACTED)/);
    expect(Object.keys(sessions(state))).toEqual([]);
  }, 60_000);

  test("targets: mode cli options are validated; a notebook target keeps exporting", async () => {
    const { call } = await setup();
    const bad = async (colab: Json, extra: Json = {}) =>
      (
        await call<{ error: { message: string } }>("/api/v1/targets/c2", {
          method: "PUT",
          body: { kind: "colab", colab, ...extra },
        })
      ).body.error?.message ?? "";
    expect(await bad({ mode: "cli", gpu: "L4", tpu: "v5e1" })).toContain("not both");
    expect(await bad({ gpu: "L4" })).toContain("`mode: cli` only");
    expect(await bad({ mode: "cli" }, { work_dir: "~/x" })).toContain("absolute");
    const ok = await call<{ capabilities: Json }>("/api/v1/targets/c3", {
      method: "PUT",
      body: { kind: "colab" },
    });
    expect(ok.body.capabilities).toMatchObject({ exports: true, submit: false });
  }, 30_000);
});
