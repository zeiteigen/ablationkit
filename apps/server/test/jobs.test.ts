/**
 * Local jobs end to end: coordinator -> collector (a real detached process) -> job -> spool ->
 * worker ingest -> console journal + tracking outbox -> fake MLflow (criteria 1, 11, 13; ADR 0011).
 *
 * These run in direct supervisor mode so they pass without a systemd user manager; the systemd
 * limits are covered by packages/process-supervisor tests and the systemd block at the end.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { probeSupervisor } from "@ablationkit/process-supervisor";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";

const FIXTURES = resolve(import.meta.dir, "../../../fixtures/projects");
const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  // Collectors outlive coordinators by design; don't leave test ones retrying in the background.
  for (const c of h.coordinators) {
    for (const j of c.services.jobs.list()) {
      for (const id of j.attempts) {
        const a = c.services.jobs.attempt(id);
        for (const pid of [a?.collector.pid, a?.pid ? -a.pid : undefined]) {
          try {
            if (pid) process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    }
  }
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

function settings(extra: Partial<CoordinatorSettings["jobs"]> = {}): CoordinatorSettings {
  return {
    schema_version: 1,
    human: { host: "127.0.0.1", port: 0 },
    agent: { host: "127.0.0.1", port: 0 },
    worker: { host: "127.0.0.1", port: 0 },
    mlflow: { enabled: false },
    jobs: { supervisor: "direct", deliver_deadline_sec: 30, ...extra },
  };
}

type Json = Record<string, unknown>;
interface AttemptView {
  attempt_id: string;
  state: string;
  exit_code?: number;
  signal?: string;
  error?: string;
  pid?: number;
  supervisor: { mode: string; enforcement: string; reason?: string };
  collector: { pid?: number; dropped_events?: number };
  snapshot?: { python?: string; sdk_version?: string; source_commit?: string };
  artifacts: { path: string; size: number; sha256: string }[];
  tracking: { mlflow_run_id?: string; sync_state?: string; pending_ops?: number };
  ingest?: { accepted: number; duplicates: number; rejected: number };
}
interface JobView {
  job_id: string;
  state: string;
  attempts: string[];
  latest_attempt: AttemptView;
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(50);
  }
}

async function setup(
  opts: { home?: string; jobs?: Partial<CoordinatorSettings["jobs"]>; fake?: FakeMlflow } = {},
) {
  const fake = opts.fake ?? new FakeMlflow().start();
  if (!opts.fake) fakes.push(fake);
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    jobWatchdogMs: 200,
    settings: settings(opts.jobs),
    ...(opts.home ? { home: opts.home } : {}),
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  return { fake, cl, token, call };
}

type Call = Awaited<ReturnType<typeof setup>>["call"];

async function addProject(call: Call, path: string, id: string): Promise<void> {
  const r = await call("/api/v1/projects", { body: { path, project_id: id } });
  expect(r.status).toBe(201);
}

/** A repo whose script uses the SDK; nothing from AblationKit is copied into it. */
function sdkRepo(script: string): string {
  const d = h.repo("sdk-project");
  writeFileSync(join(d, "train.py"), script);
  return d;
}

function fixtureRepo(name: string): string {
  const d = join(h.tmp("ak-fixture-"), name);
  cpSync(join(FIXTURES, name), d, { recursive: true });
  return d;
}

async function submit(call: Call, project: string, body: Json): Promise<JobView> {
  const r = await call<JobView & { error?: Json }>(`/api/v1/projects/${project}/jobs`, { body });
  if (r.status !== 201) throw new Error(`submit: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function job(call: Call, id: string): Promise<JobView> {
  return (await call<JobView>(`/api/v1/jobs/${id}`)).body;
}

const TERMINAL = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "oom_killed",
  "unknown",
]);

/** Every console line of the latest attempt, paging through the API; `done` from the last page. */
async function readAll(
  call: Call,
  j: { job_id: string; latest_attempt: { attempt_id: string } },
  stream?: string,
): Promise<{ lines: { stream: string; text: string }[]; done: boolean }> {
  const lines: { stream: string; text: string }[] = [];
  let after = -1;
  for (;;) {
    const q = `after=${after}&limit=10000${stream ? `&stream=${stream}` : ""}`;
    const r = await call<{
      lines: { stream: string; text: string }[];
      next_after: number;
      done: boolean;
    }>(`/api/v1/jobs/${j.job_id}/attempts/${j.latest_attempt.attempt_id}/console?${q}`);
    lines.push(...r.body.lines);
    if (r.body.next_after === after || r.body.done) return { lines, done: r.body.done };
    after = r.body.next_after;
  }
}

/** Wait until the attempt is terminal and its console is fully delivered. */
async function finished(call: Call, id: string, ms = 30_000): Promise<JobView> {
  return until(async () => {
    const j = await job(call, id);
    if (!TERMINAL.has(j.latest_attempt.state)) return undefined;
    return (await readAll(call, j)).done ? j : undefined;
  }, ms);
}

async function consoleLines(
  call: Call,
  j: JobView,
  stream?: string,
): Promise<{ stream: string; text: string }[]> {
  return (await readAll(call, j, stream)).lines;
}

const SDK_SCRIPT = `
import logging, sys
import ablationkit_sdk as ak
logging.basicConfig(level=logging.INFO)
logging.getLogger().addHandler(ak.LoggingHandler())
ak.log_params({"lr": 0.01, "layers": 2})
ak.set_tags({"variant": "baseline"})
for step in range(5):
    ak.log_metrics({"train/loss": 1.0 / (step + 1)}, step=step)
    print(f"step {step}", flush=True)
logging.getLogger("train").info("finished training")
open("model.bin", "wb").write(b"weights")
ak.log_artifact("model.bin", artifact_path="checkpoints")
ak.log_dict({"ok": True}, "summary.json")
print("oops", file=sys.stderr, flush=True)
`;

describe("local jobs", () => {
  test("an SDK-instrumented script logs console, metrics, params, tags and artifacts to MLflow through the collector (criterion 13)", async () => {
    const { fake, call } = await setup();
    await addProject(call, sdkRepo(SDK_SCRIPT), "sdk-demo");
    const submitted = await submit(call, "sdk-demo", {
      command: ["python3", "train.py"],
      run_name: "baseline",
      study_id: "study-1",
      variant_id: "baseline",
    });
    expect(submitted.attempts).toHaveLength(1);
    const j = await finished(call, submitted.job_id);
    const a = j.latest_attempt;
    expect(a.state).toBe("succeeded");
    expect(a.exit_code).toBe(0);
    expect(a.supervisor).toMatchObject({ mode: "direct", enforcement: "advisory" });
    expect(a.snapshot?.sdk_version).toBe("0.1.0");
    expect(a.snapshot?.python).toMatch(/^3\./);

    const lines = await consoleLines(call, j);
    expect(lines.filter((l) => l.stream === "stdout").map((l) => l.text)).toEqual([
      "step 0",
      "step 1",
      "step 2",
      "step 3",
      "step 4",
    ]);
    expect(lines.some((l) => l.stream === "stderr" && l.text === "oops")).toBe(true);
    expect(lines.some((l) => l.stream === "log" && l.text === "finished training")).toBe(true);
    expect((await consoleLines(call, j, "stderr")).every((l) => l.stream === "stderr")).toBe(true);

    // MLflow: one run for the attempt, with metrics, params, tags, artifacts and FINISHED status.
    const synced = await until(async () => {
      const x = await job(call, j.job_id);
      return x.latest_attempt.tracking.sync_state === "synced" &&
        x.latest_attempt.artifacts.length === 2
        ? x
        : undefined;
    });
    const run = fake.run(synced.latest_attempt.tracking.mlflow_run_id as string);
    expect(run).toBeDefined();
    expect(run?.info.status).toBe("FINISHED");
    expect(run?.metrics.filter((m) => m.key === "train/loss").map((m) => m.step)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(run?.params.get("lr")).toBe("0.01");
    expect(run?.tags.get("variant")).toBe("baseline");
    expect(run?.tags.get("ablationkit.study_id")).toBe("study-1");
    expect(new TextDecoder().decode(run?.artifacts.get("checkpoints/model.bin"))).toBe("weights");
    expect(JSON.parse(new TextDecoder().decode(run?.artifacts.get("summary.json")))).toEqual({
      ok: true,
    });
    expect(synced.latest_attempt.artifacts.map((x) => x.path).sort()).toEqual([
      "checkpoints/model.bin",
      "summary.json",
    ]);
  }, 60_000);

  test("two unrelated repos share one central install: an uninstrumented script in its own uv environment and an SDK project (criterion 1)", async () => {
    const { fake, call } = await setup();
    const plain = fixtureRepo("uninstrumented-script");
    const sdk = sdkRepo(SDK_SCRIPT);
    await addProject(call, plain, "plain");
    await addProject(call, sdk, "instrumented");

    const p = await submit(call, "plain", {
      command: ["python", "train.py", "--epochs", "4", "--fail"],
      metrics_file: "outputs/metrics.jsonl",
      artifact_paths: ["outputs/*.json"],
    });
    const s = await submit(call, "instrumented", { command: ["python3", "train.py"] });
    const pj = await finished(call, p.job_id, 120_000);
    const sj = await finished(call, s.job_id);

    // The uninstrumented script failed on purpose: compute status says so, the run is FAILED.
    expect(pj.latest_attempt.state).toBe("failed");
    expect(pj.latest_attempt.exit_code).toBe(3);
    expect(sj.latest_attempt.state).toBe("succeeded");
    const out = await consoleLines(call, pj, "stdout");
    expect(out.map((l) => l.text.replace(/ loss=.*$/, ""))).toEqual([
      "epoch 1/4",
      "epoch 2/4",
      "epoch 3/4",
      "epoch 4/4",
      "done",
    ]);
    // stderr also carries uv's own messages (creating the project environment).
    const debug = (await consoleLines(call, pj, "stderr")).filter((l) =>
      l.text.startsWith("debug:"),
    );
    expect(debug).toHaveLength(4);

    const pdone = await until(async () => {
      const x = await job(call, p.job_id);
      return x.latest_attempt.tracking.sync_state === "synced" &&
        x.latest_attempt.artifacts.length > 0
        ? x
        : undefined;
    });
    const prun = fake.run(pdone.latest_attempt.tracking.mlflow_run_id as string);
    expect(prun?.info.status).toBe("FAILED");
    expect(prun?.metrics.filter((m) => m.key === "loss").map((m) => m.step)).toEqual([1, 2, 3, 4]);
    expect(prun?.artifacts.has("outputs/model.json")).toBe(true);

    // Each project has its own experiment; neither checkout contains AblationKit code.
    const srun = fake.run(
      (await job(call, s.job_id)).latest_attempt.tracking.mlflow_run_id as string,
    );
    expect(prun?.info.experiment_id).not.toBe(srun?.info.experiment_id);
    for (const repo of [plain, sdk]) {
      expect(existsSync(join(repo, "ablationkit_sdk"))).toBe(false);
      expect(readFileSync(join(repo, "train.py"), "utf8")).not.toContain("sys.path");
    }
    expect(readFileSync(join(plain, "pyproject.toml"), "utf8")).not.toContain("ablationkit");
  }, 180_000);

  test("training logs stay viewable while MLflow is down; tracking shows pending, then syncs (criterion 11)", async () => {
    const { fake, call } = await setup();
    await addProject(call, sdkRepo(SDK_SCRIPT), "offline");
    fake.down = true;
    const s = await submit(call, "offline", { command: ["python3", "train.py"] });
    const j = await finished(call, s.job_id);
    expect(j.latest_attempt.state).toBe("succeeded");
    expect((await consoleLines(call, j, "stdout")).length).toBe(5);
    expect(j.latest_attempt.tracking.sync_state).toBe("tracking_pending");
    expect(j.latest_attempt.tracking.mlflow_run_id).toBeUndefined();
    fake.down = false;
    const synced = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.tracking.sync_state === "synced" &&
        x.latest_attempt.artifacts.length === 2
        ? x
        : undefined;
    }, 60_000);
    const run = fake.run(synced.latest_attempt.tracking.mlflow_run_id as string);
    expect(run?.metrics.filter((m) => m.key === "train/loss")).toHaveLength(5);
  }, 90_000);

  test("cancel stops the job and its process group; the run is KILLED", async () => {
    const { fake, call } = await setup();
    const repo = h.repo("sleepy");
    writeFileSync(join(repo, "run.sh"), "echo started\nsleep 60 &\nsleep 60\n");
    await addProject(call, repo, "sleepy");
    const s = await submit(call, "sleepy", { command: ["sh", "run.sh"] });
    await until(async () => (await job(call, s.job_id)).latest_attempt.state === "running");
    const c = await call(`/api/v1/jobs/${s.job_id}/cancel`, { body: {} });
    expect(c.status).toBe(202);
    const j = await finished(call, s.job_id);
    expect(j.latest_attempt.state).toBe("cancelled");
    expect(j.latest_attempt.signal).toBe("SIGTERM");
    const run = await until(async () => {
      const id = (await job(call, s.job_id)).latest_attempt.tracking.mlflow_run_id;
      const r = id ? fake.run(id) : undefined;
      return r?.info.status === "KILLED" ? r : undefined;
    });
    expect(run.info.status).toBe("KILLED");
    // Cancelling a finished job is a conflict; retry starts attempt 2 with a fresh run.
    expect((await call(`/api/v1/jobs/${s.job_id}/cancel`, { body: {} })).status).toBe(409);
  }, 60_000);

  test("the time limit ends a job as timed_out; retry creates a new attempt and a new MLflow run", async () => {
    const { call } = await setup();
    const repo = h.repo("slow");
    await addProject(call, repo, "slow");
    const s = await submit(call, "slow", {
      command: ["sleep", "30"],
      limits: { runtime_max_sec: 1 },
    });
    const j = await finished(call, s.job_id);
    expect(j.latest_attempt.state).toBe("timed_out");
    const r = await call<AttemptView>(`/api/v1/jobs/${s.job_id}/retry`, { body: {} });
    expect(r.status).toBe(201);
    expect(r.body.attempt_id).toBe(`${s.job_id}-a2`);
    const j2 = await finished(call, s.job_id);
    expect(j2.attempts).toEqual([`${s.job_id}-a1`, `${s.job_id}-a2`]);
    expect(j2.latest_attempt.state).toBe("timed_out");
    const runs = await until(async () => {
      const x = await call<{ attempt_details: AttemptView[] }>(`/api/v1/jobs/${s.job_id}`);
      const ids = x.body.attempt_details.map((a) => a.tracking.mlflow_run_id);
      return ids.every(Boolean) ? ids : undefined;
    });
    expect(new Set(runs).size).toBe(2);
  }, 60_000);

  test("a running attempt survives a coordinator restart and delivers to the new one", async () => {
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const home = h.tmp("ak-home-");
    const first = await setup({ home, fake });
    const repo = h.repo("survivor");
    writeFileSync(
      join(repo, "run.py"),
      "import time\nfor i in range(6):\n    print(f'tick {i}', flush=True)\n    time.sleep(0.5)\n",
    );
    await addProject(first.call, repo, "survivor");
    const s = await submit(first.call, "survivor", { command: ["python3", "run.py"] });
    await until(async () => (await job(first.call, s.job_id)).latest_attempt.state === "running");
    await first.cl.c.stop();
    h.coordinators.splice(h.coordinators.indexOf(first.cl.c), 1);
    await Bun.sleep(1500); // the job keeps running and the collector keeps spooling
    const second = await setup({ home, fake });
    const j = await finished(second.call, s.job_id);
    expect(j.latest_attempt.state).toBe("succeeded");
    const ticks = (await consoleLines(second.call, j, "stdout")).map((l) => l.text);
    expect(ticks).toEqual(["tick 0", "tick 1", "tick 2", "tick 3", "tick 4", "tick 5"]);
  }, 60_000);

  test("a vanished collector is reconciled to unknown and the job is not rerun (spec §5.7)", async () => {
    const { call } = await setup();
    const repo = h.repo("orphan");
    writeFileSync(join(repo, "run.sh"), "echo hello\nsleep 2\necho bye\n");
    await addProject(call, repo, "orphan");
    const s = await submit(call, "orphan", { command: ["sh", "run.sh"] });
    const running = await until(async () => {
      const x = await job(call, s.job_id);
      if (x.latest_attempt.state !== "running" || !x.latest_attempt.collector.pid) return undefined;
      return (await consoleLines(call, x, "stdout")).length > 0 ? x : undefined;
    });
    process.kill(running.latest_attempt.collector.pid as number, "SIGKILL");
    const j = await finished(call, s.job_id);
    expect(j.latest_attempt.state).toBe("unknown");
    expect(j.latest_attempt.error).toContain("nothing was rerun");
    expect(j.attempts).toHaveLength(1);
    expect((await consoleLines(call, j, "stdout")).map((l) => l.text)).toEqual(["hello"]);
  }, 60_000);
});

describe("a metrics file reused across runs (stress F43)", () => {
  test("a run that rewrites the file (same or larger size, same inode) is read from the start; appends are never counted twice", async () => {
    const { call, fake } = await setup();
    await addProject(call, h.repo("rewrite"), "rewrite");
    /** One job running `code` in the checkout; the `acc` values its MLflow run got, in order. */
    const accOf = async (code: string): Promise<number[]> => {
      const s = await submit(call, "rewrite", {
        command: ["python3", "-c", code],
        metrics_file: "m.jsonl",
      });
      const j = await finished(call, s.job_id);
      expect(j.latest_attempt.state).toBe("succeeded");
      const done = await until(async () => {
        const x = await job(call, s.job_id);
        return x.latest_attempt.tracking.sync_state === "synced" ? x : undefined;
      });
      const run = fake.run(done.latest_attempt.tracking.mlflow_run_id as string);
      return (run?.metrics ?? [])
        .filter((m) => m.key === "acc")
        .sort((a, b) => a.step - b.step)
        .map((m) => m.value);
    };
    // Truncate and write in place (`open(..., "w")`: the same inode), as most scripts do.
    const write = (...vals: number[]) =>
      `import time\nf = open("m.jsonl", "w")\n${vals
        .map((v) => `f.write('{"acc": ${v}}\\n'); f.flush(); time.sleep(0.3)`)
        .join("\n")}\nf.close()`;
    expect(await accOf(write(0.1))).toEqual([0.1]);
    // Same size, other content: it used to be invisible (the size equalled the offset).
    expect(await accOf(write(0.2))).toEqual([0.2]);
    // Byte-identical content: still this run's metric (the file was rewritten after the start).
    expect(await accOf(write(0.2))).toEqual([0.2]);
    // Larger: it used to be read from the old offset, losing its first line.
    expect(await accOf(write(0.3, 0.4))).toEqual([0.3, 0.4]);
    // Appending to an earlier run's file: only the new lines, each once, across several polls.
    const append = `import time\nf = open("m.jsonl", "a")\nfor v in (0.5, 0.6, 0.7):\n    f.write('{"acc": %s}\\n' % v); f.flush(); time.sleep(0.5)\nf.close()`;
    expect(await accOf(append)).toEqual([0.5, 0.6, 0.7]);
    // Replaced by a new file (another inode): read from the start.
    const replace = `import os\nopen("m.tmp", "w").write('{"acc": 0.8}\\n{"acc": 0.9}\\n')\nos.replace("m.tmp", "m.jsonl")`;
    expect(await accOf(replace)).toEqual([0.8, 0.9]);
  }, 120_000);
});

describe("metrics_format (ADR 0042)", () => {
  test("an events file with its own step and time keys and nested values is read as is; steps count across polls", async () => {
    const { call, fake } = await setup();
    await addProject(call, h.repo("events"), "events");
    const runOf = async (body: Record<string, unknown>) => {
      const s = await submit(call, "events", body);
      expect((await finished(call, s.job_id)).latest_attempt.state).toBe("succeeded");
      const done = await until(async () => {
        const x = await job(call, s.job_id);
        return x.latest_attempt.tracking.sync_state === "synced" ? x : undefined;
      });
      return (fake.run(done.latest_attempt.tracking.mlflow_run_id as string)?.metrics ?? [])
        .map((m) => `${m.key}@${m.step}=${m.value}`)
        .sort();
    };
    // A training script's own events file: global_step, float seconds, a nested validation.
    const events = [
      `{"time": 1731000000.5, "type": "progress", "global_step": 10, "loss": 3.5}`,
      `{"time": 1731000001.0, "type": "checkpoint", "global_step": 10, "path": "c.pt"}`,
      `{"time": 1731000002.0, "type": "validation", "validation": {"global_step": 10, "bpb": 1.25}}`,
      `{"time": 1731000003.0, "type": "progress", "global_step": 20, "loss": 3.25}`,
    ];
    const code = `import time\nf = open("ev.jsonl", "w")\nfor l in ${JSON.stringify(events)}:\n    f.write(l + "\\n"); f.flush(); time.sleep(0.4)\nf.close()`;
    expect(
      await runOf({
        command: ["python3", "-c", code],
        metrics_file: "ev.jsonl",
        metrics_format: {
          step_keys: ["global_step", "validation/global_step"],
          timestamp_key: "time",
        },
      }),
    ).toEqual(["loss@10=3.5", "loss@20=3.25", "validation/bpb@10=1.25"]);
    // Without step keys, the line number, counted across polls (it used to restart at each read).
    const plain = `import time\nf = open("m.jsonl", "w")\nfor v in (0.5, 0.6, 0.7):\n    f.write('{"acc": %s}\\n' % v); f.flush(); time.sleep(0.5)\nf.close()`;
    expect(await runOf({ command: ["python3", "-c", plain], metrics_file: "m.jsonl" })).toEqual([
      "acc@1=0.5",
      "acc@2=0.6",
      "acc@3=0.7",
    ]);
  }, 120_000);

  test("input_paths: files recorded as inputs/ artifacts as they were when the job started; local only", async () => {
    const { call, fake } = await setup();
    const repo = h.repo("inputs");
    mkdirSync(join(repo, "configs"), { recursive: true });
    writeFileSync(join(repo, "configs/smoke.json"), '{"lr": 0.1}');
    await addProject(call, repo, "inputs");
    // The job rewrites its config: the recorded input is the one it started with.
    const code = `open("configs/smoke.json", "w").write('{"lr": 9}')`;
    const s = await submit(call, "inputs", {
      command: ["python3", "-c", code],
      input_paths: ["configs/*.json", "missing/*.yaml"],
    });
    const j = await finished(call, s.job_id);
    expect(j.latest_attempt.state).toBe("succeeded");
    const done = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.artifacts.some((a) => a.path === "inputs/configs/smoke.json")
        ? x
        : undefined;
    });
    const run = fake.run(done.latest_attempt.tracking.mlflow_run_id as string);
    const bytes = run?.artifacts.get("inputs/configs/smoke.json");
    expect(bytes ? new TextDecoder().decode(bytes) : undefined).toBe('{"lr": 0.1}');
    expect((await consoleLines(call, done, "system")).map((l) => l.text)).toContain(
      "input missing/*.yaml: no files match",
    );
    const remote = await call<{ error: { code: string; message: string } }>(
      "/api/v1/projects/inputs/jobs",
      { body: { command: ["true"], input_paths: ["configs/*.json"], target_id: "gpu" } },
    );
    expect(remote.status).toBe(400);
    expect(remote.body.error.message).toContain("jobs on this machine");
    const outside = await call("/api/v1/projects/inputs/jobs", {
      body: { command: ["true"], input_paths: ["../x"] },
    });
    expect(outside.status).toBe(400);
  }, 60_000);

  test("a malformed metrics_format is refused", async () => {
    const { call } = await setup();
    await addProject(call, h.repo("bad-format"), "bad-format");
    for (const metrics_format of [
      "global_step",
      { step_keys: [] },
      { step_keys: ["a", ""] },
      { timestamp_key: 3 },
      { step: "a" },
    ]) {
      const r = await call("/api/v1/projects/bad-format/jobs", {
        body: { command: ["true"], metrics_file: "m.jsonl", metrics_format },
      });
      expect([r.status, (r.body as { error?: { code?: string } }).error?.code]).toEqual([
        400,
        "invalid_request",
      ]);
    }
  });
});

describe("spool bounds (spec §5.7: spool full)", () => {
  test("a full spool drops and counts console events but keeps lifecycle events; the job is not blocked", async () => {
    const { call } = await setup({ jobs: { spool_max_bytes: 1024 * 1024 } });
    const repo = h.repo("noisy");
    // ~4 MB of output against a 1 MiB spool, while the coordinator is reachable.
    writeFileSync(join(repo, "noisy.py"), "for i in range(40000):\n    print('x' * 100, i)\n");
    await addProject(call, repo, "noisy");
    const s = await submit(call, "noisy", { command: ["python3", "noisy.py"] });
    const j = await finished(call, s.job_id, 60_000);
    expect(j.latest_attempt.state).toBe("succeeded");
    const lines = await consoleLines(call, j, "stdout");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(40_000);
    const health = await until(async () => {
      const x = await job(call, s.job_id);
      return x.latest_attempt.collector.dropped_events !== undefined
        ? x.latest_attempt.collector
        : undefined;
    });
    // Output outruns delivery, so the bound is hit: the overflow is counted, never silent, and
    // the lifecycle events (start, exit, health) still arrive.
    expect(health.dropped_events).toBeGreaterThan(0);
    expect(lines.length + (health.dropped_events ?? 0)).toBeGreaterThanOrEqual(40_000);
  }, 90_000);
});

describe("worker ingest", () => {
  async function liveAttempt() {
    const env = await setup();
    const repo = h.repo("ingest");
    await addProject(env.call, repo, "ingest");
    const s = await submit(env.call, "ingest", { command: ["sleep", "30"] });
    const attemptId = s.attempts[0] as string;
    const svc = env.cl.c.services;
    const token = readFileSync(svc.jobs.spool(attemptId).token, "utf8").trim();
    await until(async () => (await job(env.call, s.job_id)).latest_attempt.state === "running");
    const base = `/api/v1/jobs/${s.job_id}/attempts/${attemptId}`;
    return { ...env, s, attemptId, token, base };
  }

  function ev(attempt: { s: JobView; attemptId: string }, seq: number, extra: Json = {}): Json {
    return {
      schema_version: 1,
      event_id: `e-${seq}-${Math.random().toString(16).slice(2)}`,
      project_id: "ingest",
      ablationkit_job_id: attempt.s.job_id,
      attempt_id: attempt.attemptId,
      producer_id: "sdk-test",
      producer_seq: seq,
      ts: "2026-11-02T18:00:00.000Z",
      type: "metric.batch",
      payload: { metrics: [{ key: "loss", value: seq, step: seq }] },
      ...extra,
    };
  }

  test("duplicate delivery after a lost acknowledgment is deduplicated at ingress", async () => {
    const a = await liveAttempt();
    const batch = { events: [ev(a, 0), ev(a, 1)] };
    const post = () =>
      a.cl.json<Json>(a.cl.worker(`${a.base}/events:batch`, { token: a.token, body: batch }));
    expect((await post()).body).toEqual({ accepted: 2, duplicates: 0, rejected: 0 });
    expect((await post()).body).toEqual({ accepted: 0, duplicates: 2, rejected: 0 });
    // A bad event is counted and skipped; it never blocks the rest of the batch.
    const mixed = await a.cl.json<Json>(
      a.cl.worker(`${a.base}/events:batch`, {
        token: a.token,
        body: {
          events: [
            ev(a, 2, { payload: { metrics: [{ key: "bad key!", value: 1 }] } }),
            ev(a, 3, { type: "console.line", payload: { stream: "stdout", text: "hi" } }),
          ],
        },
      }),
    );
    expect(mixed.body).toEqual({ accepted: 1, duplicates: 0, rejected: 1 });
    const run = await until(async () => {
      const id = (await job(a.call, a.s.job_id)).latest_attempt.tracking.mlflow_run_id;
      const r = id ? a.fake.run(id) : undefined;
      return r && r.metrics.length >= 2 ? r : undefined;
    });
    await Bun.sleep(200);
    expect(run.metrics.map((m) => [m.key, m.step])).toEqual([
      ["loss", 0],
      ["loss", 1],
    ]);
    await a.call(`/api/v1/jobs/${a.s.job_id}/cancel`, { body: {} });
  }, 60_000);

  test("events and artifacts are bound to the token's attempt; uploads are checked", async () => {
    const a = await liveAttempt();
    const forged = await a.cl.worker(`${a.base}/events:batch`, {
      token: a.token,
      body: { events: [ev(a, 0, { attempt_id: "someone-else" })] },
    });
    expect(forged.status).toBe(403);
    const put = (path: string, body: string, sha: string) =>
      fetch(`${a.cl.c.urls.worker}${a.base}/artifacts?path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${a.token}`, "x-ablationkit-sha256": sha },
        body,
      });
    const sha = new Bun.CryptoHasher("sha256").update("data").digest("hex");
    expect((await put("../escape", "data", sha)).status).toBe(400);
    await until(async () => (await job(a.call, a.s.job_id)).latest_attempt.tracking.mlflow_run_id);
    expect((await put("x.txt", "data", "0".repeat(64))).status).toBe(422);
    const ok = await put("dir/x.txt", "data", sha);
    expect(ok.status).toBe(201);
    const j = await job(a.call, a.s.job_id);
    expect(j.latest_attempt.artifacts).toEqual([
      expect.objectContaining({ path: "dir/x.txt", size: 4, sha256: sha }),
    ]);
    await a.call(`/api/v1/jobs/${a.s.job_id}/cancel`, { body: {} });
  }, 60_000);

  test("submission validation: secrets in env, escaping paths, uv without a project environment", async () => {
    const { call } = await setup();
    await addProject(call, h.repo("val"), "val");
    const bad = async (body: Json) =>
      (await call<{ error: { code: string } }>("/api/v1/projects/val/jobs", { body })).body.error
        .code;
    expect(await bad({ command: ["true"], env: { WANDB_API_KEY: "x" } })).toBe("secret_in_job_env");
    expect(await bad({ command: ["true"], env: { ABLATIONKIT_HOME: "x" } })).toBe(
      "invalid_request",
    );
    expect(await bad({ command: ["true"], cwd: "../.." })).toBe("invalid_request");
    expect(await bad({ command: ["true"], metrics_file: "/etc/passwd" })).toBe("invalid_request");
    expect(await bad({ command: ["true"], artifact_paths: ["../*"] })).toBe("invalid_request");
    expect(await bad({ command: ["true"], environment: "uv" })).toBe("no_project_environment");
    expect(await bad({ command: [] })).toBe("invalid_request");
  });
});

const probe = probeSupervisor({});
describe.skipIf(!(probe.mode === "systemd" && probe.enforcement === "enforced"))(
  "systemd supervisor (enforced limits)",
  () => {
    test("an attempt over its memory limit is oom_killed and labelled enforced", async () => {
      const { call } = await setup({ jobs: { supervisor: "systemd" } });
      await addProject(call, h.repo("hungry"), "hungry");
      const s = await submit(call, "hungry", {
        command: ["python3", "-c", "b = bytearray(1024 * 1024 * 1024); print(len(b))"],
        limits: { memory_max_bytes: 64 * 1024 * 1024 },
      });
      const j = await finished(call, s.job_id);
      expect(j.latest_attempt.supervisor).toMatchObject({
        mode: "systemd",
        enforcement: "enforced",
      });
      expect(j.latest_attempt.state).toBe("oom_killed");
    }, 60_000);
  },
);
