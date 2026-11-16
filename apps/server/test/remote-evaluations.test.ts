/**
 * Remote evaluations (criterion 9e, remote half; ADR 0023 decision 21). A classical evaluation on a
 * compute target is a job whose bundle carries the pinned model (`inputs/model`); the committed
 * dataset is in its source; `ablationkit_sdk.evaluate` computes the metrics on the worker and logs
 * them through the spool. A coordinator shutdown does not interrupt it: it finishes on the cluster
 * and reconciles after the restart, with one submission and one attempt.
 *
 * The cluster is the fake SLURM host from `remote-host.ts`. Its Python has a stub `mlflow.pyfunc`
 * (the real loader needs MLflow; `test:lifecycle` covers MLflow models) whose model is a rule in
 * `model.json`, and which records each load so a second execution would show.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorSettings, EvaluationRecord } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";
import { fakeHost, sbatchCount, stopRemotes } from "./remote-host.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];

afterEach(async () => {
  stopRemotes();
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

type Json = Record<string, unknown>;

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(100);
  }
}

function settings(workerPort = 0): CoordinatorSettings {
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
    },
  };
}

async function coordinator(home: string, fake: FakeMlflow, workerPort = 0) {
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    jobWatchdogMs: 200,
    remoteTickMs: 200,
    settings: settings(workerPort),
    home,
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  return { cl, call };
}

const MLMODEL = "flavors:\n  python_function:\n    loader_module: rule_model\n";

/** Train locally: the "model" predicts 1 when x > 0.5 (an MLflow-shaped directory). */
const TRAIN = `
import json, pathlib
import ablationkit_sdk as ak
out = pathlib.Path("out/model"); out.mkdir(parents=True, exist_ok=True)
(out / "MLmodel").write_text(${JSON.stringify(MLMODEL)})
(out / "model.json").write_text(json.dumps({"feature": "x", "cut": 0.5}))
ak.log_model(out, "rule", step=1)
`;

// Ten rows: the rule gets nine right (row x=0.45 is labelled 1).
const DATA = `x,label\n${[
  [0.1, 0],
  [0.2, 0],
  [0.3, 0],
  [0.45, 1],
  [0.4, 0],
  [0.6, 1],
  [0.7, 1],
  [0.8, 1],
  [0.9, 1],
  [0.05, 0],
]
  .map(([x, y]) => `${x},${y}`)
  .join("\n")}\n`;

/** A stub `mlflow.pyfunc` on the cluster's Python: loads `model.json`, logs each load, is slow. */
function stubPython(home: string): string {
  const lib = join(home, "pylib", "mlflow");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "__init__.py"), "");
  writeFileSync(
    join(lib, "pyfunc.py"),
    `import json, os, time
class _M:
    def __init__(self, d):
        self.m = json.load(open(os.path.join(d, "model.json")))
    def predict(self, rows):
        return [1 if float(r[self.m["feature"]]) > self.m["cut"] else 0 for r in rows]
def load_model(d):
    with open(os.path.join(os.environ["HOME"], "loads.log"), "a") as f:
        f.write(d + "\\n")
    time.sleep(3)
    return _M(d)
`,
  );
  const py = join(home, "bin", "py");
  writeFileSync(
    py,
    `#!/bin/bash\nexport PYTHONPATH="\${PYTHONPATH:+$PYTHONPATH:}${join(home, "pylib")}"\nexec python3 "$@"\n`,
  );
  chmodSync(py, 0o755);
  return py;
}

describe("Remote evaluations (criterion 9e, remote half)", () => {
  test("an evaluation on a SLURM target carries the pinned model, runs while the coordinator is off, and reconciles once with its thresholds checked", async () => {
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const home = h.tmp("ak-home-");
    const first = await coordinator(home, fake);
    const workerPort = Number(new URL(first.cl.c.urls.worker).port);
    const host = fakeHost(h.tmp("ak-remote-"));
    const py = stubPython(host.home);

    const repo = join(h.tmp(), "ev");
    mkdirSync(join(repo, "data"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q", repo]);
    writeFileSync(join(repo, "data", "test.csv"), DATA);
    writeFileSync(join(repo, "train.py"), TRAIN);
    Bun.spawnSync(["git", "-C", repo, "add", "-A"]);
    Bun.spawnSync([
      "git",
      "-C",
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "data",
    ]);
    expect(
      (await first.call("/api/v1/projects", { body: { path: repo, project_id: "ev" } })).status,
    ).toBe(201);
    const train = await first.call<{ job_id: string }>("/api/v1/projects/ev/jobs", {
      body: { command: ["python3", "train.py"], environment: "none" },
    });
    expect(train.status).toBe(201);
    const model = await until(async () => {
      const m = (await first.call<{ models: Json[] }>("/api/v1/projects/ev/models")).body
        .models?.[0];
      return m?.["status"] === "LOGGED_MODEL_READY" ? (m["model_id"] as string) : undefined;
    });
    const put = await first.call("/api/v1/targets/cluster", {
      method: "PUT",
      body: {
        kind: "slurm",
        ssh: { host: "login.hpc", command: [host.ssh] },
        slurm: { drain_sec: 1 },
        python: py,
        worker_url: first.cl.c.urls.worker,
      },
    });
    expect([200, 201]).toContain(put.status);

    const evaluate = (body: Json) =>
      first.call<{ evaluation: EvaluationRecord; error?: { code: string } }>(
        "/api/v1/projects/ev/evaluations",
        {
          body: {
            model_type: "classifier",
            model: { model_id: model },
            dataset: { path: "data/test.csv", targets: "label" },
            target_id: "cluster",
            environment: "managed",
            timeout_sec: 600,
            thresholds: [
              { metric: "accuracy_score", threshold: "0.8", greater_is_better: true },
              { metric: "f1_score", threshold: "0.99", greater_is_better: true },
            ],
            ...body,
          },
        },
      );
    // The worker evaluates the committed file of the pinned commit, so an uncommitted one is refused.
    writeFileSync(join(repo, "data", "extra.csv"), DATA);
    expect(
      (await evaluate({ dataset: { path: "data/extra.csv", targets: "label" } })).body.error?.code,
    ).toBe("dataset_not_committed");
    expect((await evaluate({ baseline: { model_id: model } })).body.error?.code).toBe(
      "baseline_not_remote",
    );

    rmSync(join(repo, "data", "extra.csv"));
    const created = await evaluate({});
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const ev = created.body.evaluation;
    expect(ev).toMatchObject({ state: "running", remote: { target_id: "cluster" } });
    const jobId = ev.remote?.job_id as string;
    // The model files rode in the bundle, checksummed with it.
    const bundle = JSON.parse(
      readFileSync(
        join(home, "bundles", ev.remote?.attempt_id as string, "bundle", "bundle.json"),
        "utf8",
      ),
    ) as { files: { path: string }[] };
    expect(bundle.files.map((f) => f.path)).toContain("inputs/model/model.json");

    // The workstation shuts down while the cluster loads the model.
    await until(async () => {
      try {
        return readFileSync(join(host.home, "loads.log"), "utf8").length > 0;
      } catch {
        return false;
      }
    });
    await first.cl.c.stop();
    h.coordinators.splice(h.coordinators.indexOf(first.cl.c), 1);
    await Bun.sleep(5000);

    // Back: the evaluation was not interrupted; it reconciles from the job, never reruns.
    const second = await coordinator(home, fake, workerPort);
    const done = await until(async () => {
      const v = (
        await second.call<{ evaluation: EvaluationRecord }>(
          `/api/v1/projects/ev/evaluations/${ev.evaluation_id}`,
        )
      ).body.evaluation;
      return v.state !== "running" ? v : undefined;
    }, 60_000);
    expect(done.state).toBe("succeeded");
    expect(done.validation?.passed).toBe(false);
    expect(done.validation?.outcomes).toEqual([
      { metric: "accuracy_score", passed: true, candidate: "0.9", failures: [] },
      expect.objectContaining({ metric: "f1_score", passed: false }),
    ]);
    expect(done.mlflow_run_id).toBeDefined();
    const run = fake.run(done.mlflow_run_id as string);
    expect(run?.metrics.find((m) => m.key === "accuracy_score")?.value).toBe(0.9);
    expect(run?.artifacts.has("eval/predictions.csv")).toBe(true);
    // Exactly one execution: one sbatch, one attempt, one model load.
    expect(sbatchCount(host.home)).toBe(1);
    const job = (await second.call<{ attempts: string[] }>(`/api/v1/jobs/${jobId}`)).body;
    expect(job.attempts).toHaveLength(1);
    expect(readFileSync(join(host.home, "loads.log"), "utf8").trim().split("\n")).toHaveLength(1);
  }, 150_000);
});
