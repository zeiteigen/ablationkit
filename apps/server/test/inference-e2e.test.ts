/**
 * Research inference end to end against the real pinned MLflow and the real Python operations
 * bridge (criteria 9, 9a, 9b, 9c, 9e, 10d). Opt-in: `bun run test:inference`
 * (ABLATIONKIT_INFERENCE_E2E=1); CI runs it. Like lifecycle-e2e.test.ts it starts the managed
 * sidecar in a temporary directory, unless ABLATIONKIT_LIFECYCLE_MLFLOW_URL and
 * ABLATIONKIT_BRIDGE_PYTHON point at a running pinned server and its venv's Python.
 *
 * Two fixture repos, each trained through its MLproject as real jobs:
 *   - sklearn-lifecycle: two iris classifiers (tabular), a ridge regressor, a TF-IDF text model;
 *   - vision-digits: an 8×8 digit classifier with a declared image adapter, predicted from PNGs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { MlflowClient, MlflowSidecar } from "@ablationkit/tracking-mlflow";
import { DEFAULT_BRIDGE_SCRIPT } from "../src/tracking/bridge.ts";
import { type Client, Harness } from "./helpers.ts";

const RUN = process.env["ABLATIONKIT_INFERENCE_E2E"] === "1";
const OPS = resolve(import.meta.dir, "../../../packages/tracking-mlflow/env");
const FIXTURES = resolve(import.meta.dir, "../../../fixtures/projects");

// biome-ignore lint/suspicious/noExplicitAny: loosely typed API JSON in assertions
type Json = any;

const h = new Harness();
const REG = `iris-inf-${Date.now().toString(36)}`;
let sidecar: MlflowSidecar | undefined;
let sidecarDir: string | undefined;
let mlflow: MlflowClient;
let cl: Client;
let call: <T = Json>(
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<{ status: number; body: T }>;
let env: Record<string, string>;
const models: Record<string, string> = {};

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 300_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(250);
  }
}

function git(dir: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

async function addRepo(name: string, id: string): Promise<string> {
  const repo = join(h.tmp(`ak-${id}-`), name);
  cpSync(join(FIXTURES, name), repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture");
  expect((await call("/api/v1/projects", { body: { path: repo, project_id: id } })).status).toBe(
    201,
  );
  return repo;
}

/** Train through the MLproject and return the ready logged model and the job. */
async function train(pid: string, entrypoint: string, parameters: Record<string, string>) {
  const r = await call(`/api/v1/projects/${pid}/mlproject/runs`, {
    body: { entrypoint, parameters, environment: "none", env },
  });
  expect(r.status).toBe(202);
  const job = await until(async () => {
    const j = (await call(`/api/v1/jobs/${r.body.job.job_id}`)).body;
    const a = j.latest_attempt;
    if (["failed", "timed_out", "oom_killed", "unknown"].includes(a.state))
      throw new Error(`job failed: ${JSON.stringify(a)}`);
    return a.state === "succeeded" && a.tracking.sync_state === "synced" ? j : undefined;
  });
  const runId = job.latest_attempt.tracking.mlflow_run_id;
  const model = await until(async () => {
    const ms = (await call(`/api/v1/projects/${pid}/models?run_id=${runId}`)).body.models as Json[];
    return ms.find((m) => m.status === "LOGGED_MODEL_READY");
  });
  return { model_id: model.model_id as string, job, runId: runId as string };
}

const b64 = (p: string) => readFileSync(p).toString("base64");

async function experimentRuns(pid: string): Promise<number> {
  const exp = await mlflow.getExperimentByName(`ak/${pid}`);
  if (!exp) return 0;
  return (await mlflow.searchRuns({ experiment_ids: [exp.experiment_id], max_results: 1000 })).items
    .length;
}

describe.skipIf(!RUN)("research inference on real MLflow (criteria 9, 9a, 9b, 9c, 9e, 10d)", () => {
  let vis: string;

  beforeAll(async () => {
    let url: string;
    let python: string;
    if (process.env["ABLATIONKIT_LIFECYCLE_MLFLOW_URL"]) {
      url = process.env["ABLATIONKIT_LIFECYCLE_MLFLOW_URL"];
      python = process.env["ABLATIONKIT_BRIDGE_PYTHON"] as string;
      if (!python)
        throw new Error("set ABLATIONKIT_BRIDGE_PYTHON with ABLATIONKIT_LIFECYCLE_MLFLOW_URL");
    } else {
      sidecarDir = mkdtempSync(join(tmpdir(), "ak-inference-mlflow-"));
      const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = s.port ?? 0;
      await s.stop(true);
      sidecar = new MlflowSidecar({
        opsDir: OPS,
        dataDir: join(sidecarDir, "mlflow"),
        port,
        preUpgradeBackup: async () => "none",
        log: (l) => console.error(l),
      });
      await sidecar.start();
      if (sidecar.status().state !== "healthy") throw new Error(JSON.stringify(sidecar.status()));
      url = sidecar.url;
      python = join(sidecar.status().paths.venv, "bin", "python");
    }
    mlflow = new MlflowClient({ url });
    const settings: CoordinatorSettings = {
      schema_version: 1,
      human: { host: "127.0.0.1", port: 0 },
      agent: { host: "127.0.0.1", port: 0 },
      worker: { host: "127.0.0.1", port: 0 },
      mlflow: { enabled: false },
      jobs: { supervisor: "direct", deliver_deadline_sec: 60 },
    };
    cl = await h.start({
      trackingUrl: url,
      trackingIntervalMs: 50,
      settings,
      bridgeCommand: [python, "-I", DEFAULT_BRIDGE_SCRIPT],
      inferenceSweepMs: 200,
    });
    const token = await cl.session();
    call = (path, init = {}) => cl.json(cl.human(path, { token, ...init }));
    env = { PATH: `${dirname(python)}:${process.env["PATH"]}`, MLFLOW_DISABLE_AGENT_HINT: "1" };
    await addRepo("sklearn-lifecycle", "skl");
    vis = await addRepo("vision-digits", "vis");
    const [a, b, t, r, d] = await Promise.all([
      train("skl", "main", { C: "1.0" }),
      train("skl", "main", { C: "0.01" }),
      train("skl", "text", {}),
      train("skl", "regress", {}),
      train("vis", "main", {}),
    ]);
    models["iris_a"] = a.model_id;
    models["iris_b"] = b.model_id;
    models["text"] = t.model_id;
    models["ridge"] = r.model_id;
    models["digits"] = d.model_id;
    models["digits_run"] = d.runId;
    expect((await call("/api/v1/projects/skl/registry", { body: { name: REG } })).status).toBe(201);
    for (const id of [a.model_id, b.model_id])
      expect(
        (await call(`/api/v1/projects/skl/registry/${REG}/versions`, { body: { model_id: id } }))
          .status,
      ).toBe(201);
    await call(`/api/v1/projects/skl/registry/${REG}/aliases/champion`, {
      method: "PUT",
      body: { version: "1" },
    });
  }, 900_000);

  afterAll(async () => {
    await h.cleanup();
    await sidecar?.stop();
    if (sidecarDir) rmSync(sidecarDir, { recursive: true, force: true });
  });

  test("criterion 9: one-shot prediction of a pinned registry alias, validated, with load and predict times; nothing kept running or persisted", async () => {
    const runsBefore = await experimentRuns("skl");
    const inputs = {
      records: [
        { sepal_length: 5.1, sepal_width: 3.5, petal_length: 1.4, petal_width: 0.2 },
        { sepal_length: 6.7, sepal_width: 3.0, petal_length: 5.2, petal_width: 2.3 },
      ],
    };
    const r = await call("/api/v1/projects/skl/inference/predict", {
      body: { model: { name: REG, alias: "champion" }, inputs },
    });
    expect(r.status).toBe(200);
    const m = r.body.result.models[0];
    expect(m.status).toBe("ok");
    expect(m.model).toEqual({
      model_id: models["iris_a"],
      registered_name: REG,
      version: "1",
      alias: "champion",
    });
    expect(m.outputs).toEqual([0, 2]);
    expect(m.probabilities[0][0].label).toBe(0);
    expect(m.probabilities[0][0].p).toBeGreaterThan(0.5);
    expect(m.timings.load_ms).toBeGreaterThan(0);
    expect(m.timings.predict_ms).toBeGreaterThan(0);
    expect(m.timings.worker_ms).toBeGreaterThan(m.timings.load_ms);
    expect(r.body.result.environment).toMatchObject({ kind: "managed", mlflow_version: "3.17.2" });
    // No permanent endpoint, no leftover worker, no MLflow write (criterion 9e).
    const ops = h.coordinators[0]?.services.paths.operationsDir as string;
    expect(existsSync(ops) ? readdirSync(ops).filter((x) => x.startsWith("inf-")) : []).toEqual([]);
    expect(await experimentRuns("skl")).toBe(runsBefore);
    // Validation errors come back before any worker starts.
    const bad = await call("/api/v1/projects/skl/inference/predict", {
      body: {
        model: { name: REG, alias: "champion" },
        inputs: { records: [{ sepal_length: "x" }] },
      },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.issues.map((i: Json) => i.field)).toContain("petal_width");
    // A regression model through the same tabular adapter, its form built from the signature.
    const d = (await call(`/api/v1/projects/skl/inference/describe?model_id=${models["ridge"]}`))
      .body;
    expect(d.adapter.columns.map((c: Json) => c.name)).toEqual(["a", "b", "c"]);
    const reg = await call("/api/v1/projects/skl/inference/predict", {
      body: {
        model: { model_id: models["ridge"] },
        inputs: { records: [{ a: 0.5, b: 0.5, c: 0.5 }] },
      },
    });
    expect(reg.body.result.output).toBe("regression");
    expect(typeof reg.body.result.models[0].outputs[0]).toBe("number");
  }, 120_000);

  test("criterion 9a: a warm text session predicts repeatedly without reloading, reports readiness, memory and logs, expires when idle, and is cleaned up after a crash", async () => {
    const st = await call("/api/v1/projects/skl/inference/sessions", {
      body: {
        model: { model_id: models["text"] },
        wait: true,
        idle_timeout_sec: 600,
        memory_mb: 1024,
      },
    });
    expect(st.status).toBe(201);
    const s = st.body.session;
    expect(s).toMatchObject({ state: "ready", task: "text", output: "classification" });
    expect(s.timings.load_ms).toBeGreaterThan(0);
    expect(s.memory.rss_bytes).toBeGreaterThan(10_000_000);
    const sid = s.session_id;
    const outs: string[] = [];
    for (const text of [
      "the plot was wonderful",
      "the acting was dreadful",
      "the ending was superb",
    ]) {
      const p = await call(`/api/v1/projects/skl/inference/sessions/${sid}/predict`, {
        body: { inputs: { records: [{ text }] } },
      });
      expect(p.status).toBe(200);
      const m = p.body.result.models[0];
      expect(m.status).toBe("ok");
      expect(m.timings.predict_ms).toBeLessThan(s.timings.load_ms * 10);
      outs.push(m.outputs[0]);
    }
    expect(outs).toEqual(["pos", "neg", "pos"]);
    await Bun.sleep(3200);
    const v = (await call(`/api/v1/projects/skl/inference/sessions/${sid}`)).body.session;
    expect(v.pid).toBe(s.pid);
    expect(v.counters.requests).toBe(3);
    expect(v.memory.peak_rss_bytes).toBeGreaterThan(0);
    const log = await (
      await cl.human(`/api/v1/projects/skl/inference/sessions/${sid}/log`, {
        token: await cl.session(),
      })
    ).text();
    expect(typeof log).toBe("string");
    // Crash cleanup: the worker is killed from outside.
    process.kill(s.pid, "SIGKILL");
    const crashed = await until(async () => {
      const r = (await call(`/api/v1/projects/skl/inference/sessions/${sid}`)).body.session;
      return r.state === "crashed" ? r : undefined;
    }, 30_000);
    expect(crashed.end_reason).toContain("SIGKILL");
    const dead = await call(`/api/v1/projects/skl/inference/sessions/${sid}/predict`, {
      body: { inputs: { records: [{ text: "x" }] } },
    });
    expect(dead.body.error.code).toBe("session_not_ready");
    // Idle expiry and explicit stop.
    const idle = (
      await call("/api/v1/projects/skl/inference/sessions", {
        body: { model: { model_id: models["text"] }, wait: true, idle_timeout_sec: 3 },
      })
    ).body.session;
    expect(idle.state).toBe("ready");
    const expired = await until(async () => {
      const r = (await call(`/api/v1/projects/skl/inference/sessions/${idle.session_id}`)).body
        .session;
      return r.state === "expired" ? r : undefined;
    }, 30_000);
    expect(expired.end_reason).toContain("idle");
    expect(() => process.kill(idle.pid, 0)).toThrow();
    const live = (
      await call("/api/v1/projects/skl/inference/sessions", {
        body: { model: { model_id: models["text"] }, wait: true },
      })
    ).body.session;
    const stopped = (
      await call(`/api/v1/projects/skl/inference/sessions/${live.session_id}/stop`, { body: {} })
    ).body.session;
    expect(stopped.state).toBe("stopped");
    expect(() => process.kill(live.pid, 0)).toThrow();
  }, 240_000);

  test("criterion 9b: two pinned registry versions on identical dataset rows: aligned predictions, disagreements, correctness; the saved comparison is in MLflow with provenance and can be deleted", async () => {
    const r = await call("/api/v1/projects/skl/inference/compare", {
      body: {
        models: [
          { name: REG, version: "1" },
          { name: REG, version: "2" },
        ],
        dataset: { path: "data/iris.csv", targets: "target", offset: 0, limit: 150 },
      },
    });
    expect(r.status).toBe(200);
    const res = r.body.result;
    const c = res.comparison;
    expect(c).toMatchObject({ paired: true, rows: 150, has_targets: true });
    expect(c.examples).toHaveLength(150);
    expect(c.examples[0].predictions).toHaveLength(2);
    expect(c.disagreements).toBeGreaterThan(0);
    expect(c.disagreements).toBe(c.examples.filter((e: Json) => !e.agree).length);
    expect(c.summary[0].accuracy).toBeGreaterThan(c.summary[1].accuracy);
    expect(c.paired_test.method).toContain("McNemar");
    expect(res.input_rows[0]).toEqual({
      sepal_length: 5.1,
      sepal_width: 3.5,
      petal_length: 1.4,
      petal_width: 0.2,
    });
    // Incompatible models are refused before running.
    const inc = await call("/api/v1/projects/skl/inference/compare", {
      body: {
        models: [{ model_id: models["iris_a"] }, { model_id: models["text"] }],
        inputs: { records: [{ text: "x" }] },
      },
    });
    expect(inc.status).toBe(422);
    expect(inc.body.error.code).toBe("incompatible_schemas");
    // Save: MLflow holds it, with exact versions, dataset fingerprint and source runs.
    const ev = (
      await call(`/api/v1/projects/skl/inference/results/${res.result_id}/save`, {
        body: { title: "C=1 vs C=0.01" },
      })
    ).body.evidence;
    expect(ev.models.map((m: Json) => [m.registered_name, m.version, m.model_id])).toEqual([
      [REG, "1", models["iris_a"]],
      [REG, "2", models["iris_b"]],
    ]);
    expect(ev.models[0].source_commit).toMatch(/^[a-f0-9]{40}$/);
    expect(ev.dataset.sha256).toHaveLength(64);
    expect(ev.code_revision).toMatch(/^[a-f0-9]{40}$/);
    const run = await mlflow.getRun(ev.mlflow_run_id);
    const tags = Object.fromEntries((run.data.tags ?? []).map((t) => [t.key, t.value]));
    expect(tags["ablationkit.kind"]).toBe("inference_evidence");
    expect(tags["ablationkit.model_ids"]).toBe(`${models["iris_a"]},${models["iris_b"]}`);
    const doc = JSON.parse(
      await (await mlflow.downloadArtifact(ev.mlflow_run_id, ev.artifact_path)).text(),
    );
    expect(doc.provenance.dataset.sha256).toBe(ev.dataset.sha256);
    expect(doc.comparison.examples).toHaveLength(150);
    await call(`/api/v1/projects/skl/inference/evidence/${ev.evidence_id}`, { method: "DELETE" });
    expect((await mlflow.getRun(ev.mlflow_run_id)).info.lifecycle_stage).toBe("deleted");
  }, 240_000);

  test("criterion 9c: a tracked batch evaluation compares candidate and baseline on a fixed dataset with example-level failures; MLflow holds the artifacts", async () => {
    const r = await call("/api/v1/projects/skl/evaluations", {
      body: {
        model_type: "classifier",
        model: { name: REG, version: "1" },
        baseline: { name: REG, version: "2" },
        dataset: { path: "data/iris.csv", targets: "target", split: "all" },
      },
    });
    expect(r.status).toBe(202);
    const id = r.body.evaluation.evaluation_id;
    const v = await until(async () => {
      const x = (await call(`/api/v1/projects/skl/evaluations/${id}`)).body;
      if (x.evaluation.state === "failed") throw new Error(x.evaluation.error);
      return x.evaluation.state === "succeeded" ? x : undefined;
    });
    const ex = v.evaluation.examples;
    expect(ex).toMatchObject({ rows: 150, paired: true, model_type: "classifier" });
    expect(ex.candidate_correct).toBeGreaterThan(ex.baseline_correct);
    expect(ex.only_candidate_correct + ex.both_correct).toBe(ex.candidate_correct);
    expect(ex.paired_test.p_value).toMatch(/^[0-9.e-]+$/);
    const doc = (await call(`/api/v1/projects/skl/evaluations/${id}/examples`)).body;
    expect(doc.rows.length).toBe(ex.listed);
    expect(doc.rows[0]).toHaveProperty("candidate");
    const files = (await mlflow.listArtifacts(v.evaluation.mlflow_run_id, "ablationkit")).items.map(
      (f) => f.path,
    );
    expect(files).toContain("ablationkit/examples.json");
    expect(v.candidate.metrics.accuracy_score).toBeGreaterThan(v.baseline.metrics.accuracy_score);
  }, 300_000);

  test("criterion 10d: a vision project trains, logs metrics, artifacts and lineage, and predicts digits from uploaded images through its image adapter", async () => {
    const d = (await call(`/api/v1/projects/vis/inference/describe?model_id=${models["digits"]}`))
      .body;
    expect(d.adapter).toMatchObject({
      task: "image",
      output: "classification",
      source: "metadata",
    });
    expect(d.adapter.image).toMatchObject({ height: 8, width: 8, invert: true, layout: "columns" });
    expect(d.adapter.labels["3"]).toBe("digit 3");
    const run = await mlflow.getRun(models["digits_run"] as string);
    expect((run.data.metrics ?? []).find((m) => m.key === "val/accuracy")?.value).toBeGreaterThan(
      0.9,
    );
    const plots = (await mlflow.listArtifacts(models["digits_run"] as string, "plots")).items.map(
      (f) => f.path,
    );
    expect(plots).toContain("plots/confusion_matrix.png");
    const lin = (
      await call(`/api/v1/projects/vis/lineage?kind=logged_model&id=${models["digits"]}`)
    ).body;
    expect(lin.steps.find((s: Json) => s.step === "job").status).toBe("linked");
    const images = Array.from({ length: 10 }, (_, i) => ({
      data_base64: b64(join(vis, "samples", `digit_${i}.png`)),
      media_type: "image/png",
      name: `digit_${i}.png`,
    }));
    const p = await call("/api/v1/projects/vis/inference/predict", {
      body: { model: { model_id: models["digits"] }, inputs: { images } },
    });
    expect(p.status).toBe(200);
    const m = p.body.result.models[0];
    expect(m.status).toBe("ok");
    const right = (m.outputs as number[]).filter((o, i) => o === i).length;
    expect(right).toBeGreaterThanOrEqual(8);
    expect(m.probabilities[0]).toHaveLength(5);
    // A classical evaluation of the vision model on its held-out split.
    const e = await call("/api/v1/projects/vis/evaluations", {
      body: {
        model_type: "classifier",
        model: { model_id: models["digits"] },
        dataset: { path: "data/digits_test.csv", targets: "label", split: "test" },
        thresholds: [{ metric: "accuracy_score", threshold: "0.9", greater_is_better: true }],
      },
    });
    const id = e.body.evaluation.evaluation_id;
    const v = await until(async () => {
      const x = (await call(`/api/v1/projects/vis/evaluations/${id}`)).body;
      if (x.evaluation.state === "failed") throw new Error(x.evaluation.error);
      return x.evaluation.state === "succeeded" ? x : undefined;
    });
    expect(v.evaluation.validation.passed).toBe(true);
    expect(v.evaluation.examples.rows).toBe(360);
  }, 300_000);

  test("criterion 9e: stopping the coordinator stops local sessions", async () => {
    const s = (
      await call("/api/v1/projects/skl/inference/sessions", {
        body: { model: { model_id: models["text"] }, wait: true },
      })
    ).body.session;
    expect(s.state).toBe("ready");
    const c = h.coordinators[0];
    await c?.stop();
    expect(() => process.kill(s.pid, 0)).toThrow();
    const rec = JSON.parse(
      readFileSync(
        join(
          c?.services.paths.stateDir as string,
          "skl",
          "inference",
          "sessions",
          `${s.session_id}.json`,
        ),
        "utf8",
      ),
    );
    expect(rec.state).toBe("stopped");
  }, 120_000);
});
