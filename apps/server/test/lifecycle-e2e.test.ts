/**
 * Model lifecycle end to end against the real pinned MLflow and the real Python operations bridge
 * (criteria 5, 6, 7, 8). Opt-in: `bun run test:lifecycle` (ABLATIONKIT_LIFECYCLE_E2E=1); CI runs
 * it. It starts the managed sidecar in a temporary directory (uv-synced from packages/tracking-mlflow/env), unless
 * ABLATIONKIT_LIFECYCLE_MLFLOW_URL and ABLATIONKIT_BRIDGE_PYTHON point at a running pinned server
 * and its venv's Python (for iterating locally).
 *
 * The fixture (fixtures/projects/sklearn-lifecycle) trains scikit-learn models through its
 * `MLproject`, saves them with `mlflow.sklearn.save_model` and reports them with the SDK. Its
 * environment is the sidecar's (mlflow, scikit-learn, pandas) on PATH.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { MlflowClient, MlflowSidecar } from "@ablationkit/tracking-mlflow";
import { DEFAULT_BRIDGE_SCRIPT } from "../src/tracking/bridge.ts";
import { type Client, Harness } from "./helpers.ts";
import { fakeHost, stopRemotes } from "./remote-host.ts";

const RUN = process.env["ABLATIONKIT_LIFECYCLE_E2E"] === "1";
const OPS = resolve(import.meta.dir, "../../../packages/tracking-mlflow/env");
const FIXTURES = resolve(import.meta.dir, "../../../fixtures/projects");

// biome-ignore lint/suspicious/noExplicitAny: loosely typed API JSON in assertions
type Json = any;

const h = new Harness();
/** Registered model names are global in MLflow: unique per run, so a reused server is fine. */
const REG = `iris-clf-${Date.now().toString(36)}`;
let mlflowUrl: string;
let python: string;
let sidecar: MlflowSidecar | undefined;
let sidecarDir: string | undefined;
let cl: Client;
let call: <T = Json>(
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<{ status: number; body: T }>;
let repo: string;
let env: Record<string, string>;

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

async function mlproject(entrypoint: string, parameters: Record<string, string>): Promise<Json> {
  const r = await call("/api/v1/projects/skl/mlproject/runs", {
    body: { entrypoint, parameters, environment: "none", env },
  });
  expect(r.status).toBe(202);
  return until(async () => {
    const j = (await call(`/api/v1/jobs/${r.body.job.job_id}`)).body;
    const a = j.latest_attempt;
    if (["failed", "timed_out", "oom_killed", "unknown"].includes(a.state))
      throw new Error(`job failed: ${JSON.stringify(a)}`);
    return a.state === "succeeded" && a.tracking.sync_state === "synced" ? j : undefined;
  });
}

async function modelOf(job: Json): Promise<Json> {
  const runId = job.latest_attempt.tracking.mlflow_run_id;
  return until(async () => {
    const ms = (await call(`/api/v1/projects/skl/models?run_id=${runId}`)).body.models as Json[];
    return ms.find((m) => m.status === "LOGGED_MODEL_READY");
  });
}

async function evaluation(body: Json): Promise<Json> {
  const r = await call("/api/v1/projects/skl/evaluations", { body });
  if (r.status !== 202) throw new Error(`evaluation: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.evaluation.evaluation_id;
  return until(async () => {
    const v = (await call(`/api/v1/projects/skl/evaluations/${id}`)).body;
    if (v.evaluation.state === "failed")
      throw new Error(`evaluation failed: ${v.evaluation.error}`);
    return v.evaluation.state === "succeeded" ? v : undefined;
  });
}

describe.skipIf(!RUN)("model lifecycle on real MLflow (criteria 5-8)", () => {
  beforeAll(async () => {
    if (process.env["ABLATIONKIT_LIFECYCLE_MLFLOW_URL"]) {
      mlflowUrl = process.env["ABLATIONKIT_LIFECYCLE_MLFLOW_URL"];
      python = process.env["ABLATIONKIT_BRIDGE_PYTHON"] as string;
      if (!python)
        throw new Error("set ABLATIONKIT_BRIDGE_PYTHON with ABLATIONKIT_LIFECYCLE_MLFLOW_URL");
    } else {
      sidecarDir = mkdtempSync(join(tmpdir(), "ak-lifecycle-mlflow-"));
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
      mlflowUrl = sidecar.url;
      python = join(sidecar.status().paths.venv, "bin", "python");
    }
    const settings: CoordinatorSettings = {
      schema_version: 1,
      human: { host: "127.0.0.1", port: 0 },
      agent: { host: "127.0.0.1", port: 0 },
      worker: { host: "127.0.0.1", port: 0 },
      mlflow: { enabled: false },
      jobs: { supervisor: "direct", deliver_deadline_sec: 60 },
      remote: {
        heartbeat_sec: 1,
        provider_poll_sec: 1,
        max_backoff_sec: 1,
        min_free_disk_bytes: 0,
      },
    };
    cl = await h.start({
      trackingUrl: mlflowUrl,
      trackingIntervalMs: 50,
      jobWatchdogMs: 200,
      remoteTickMs: 200,
      settings,
      bridgeCommand: [python, "-I", DEFAULT_BRIDGE_SCRIPT],
    });
    const token = await cl.session();
    call = (path, init = {}) => cl.json(cl.human(path, { token, ...init }));
    repo = join(h.tmp("ak-skl-"), "sklearn-lifecycle");
    cpSync(join(FIXTURES, "sklearn-lifecycle"), repo, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "fixture");
    env = { PATH: `${dirname(python)}:${process.env["PATH"]}`, MLFLOW_DISABLE_AGENT_HINT: "1" };
    expect(
      (await call("/api/v1/projects", { body: { path: repo, project_id: "skl" } })).status,
    ).toBe(201);
  }, 900_000);

  afterAll(async () => {
    stopRemotes();
    await h.cleanup();
    await sidecar?.stop();
    if (sidecarDir) rmSync(sidecarDir, { recursive: true, force: true });
  });

  let clf1: Json;
  let clf2: Json;
  let reg: Json;
  let job1: Json;

  test("criterion 8: the MLproject is detected and its entrypoints launch as tracked jobs", async () => {
    const info = (await call("/api/v1/projects/skl/mlproject")).body;
    expect(info.found).toBe(true);
    expect(info.entry_points.map((e: Json) => e.name)).toEqual(["main", "regress", "text"]);
    expect(info.entry_points[0].parameters).toEqual([
      { name: "C", type: "float", default: "1.0" },
      { name: "data", type: "path", default: "data/iris.csv" },
    ]);
    job1 = await mlproject("main", { C: "0.5" });
    expect(job1.mlproject).toMatchObject({ entrypoint: "main", parameters: { C: "0.5" } });
    const c = new MlflowClient({ url: mlflowUrl });
    const run = await c.getRun(job1.latest_attempt.tracking.mlflow_run_id);
    const tags = new Map((run.data.tags ?? []).map((t) => [t.key, t.value]));
    expect(tags.get("mlflow.project.entryPoint")).toBe("main");
    expect(tags.get("mlflow.source.type")).toBe("PROJECT");
    expect(run.data.params).toContainEqual({ key: "C", value: "0.5" });
    expect(run.data.metrics?.find((m) => m.key === "val/accuracy")?.value).toBeGreaterThan(0.8);
    const runs = (await call("/api/v1/tracking/runs?project=skl")).body.runs as Json[];
    expect(runs.map((r) => r.info.run_id)).toContain(run.info.run_id);

    // Another project, without an MLproject, runs a plain command.
    const plain = join(h.tmp("ak-plain-"), "uninstrumented-script");
    cpSync(join(FIXTURES, "uninstrumented-script"), plain, { recursive: true });
    await call("/api/v1/projects", { body: { path: plain, project_id: "plain" } });
    expect((await call("/api/v1/projects/plain/mlproject")).body.found).toBe(false);
    const j = await call("/api/v1/projects/plain/jobs", {
      body: { command: ["python3", "-c", "print('no MLproject needed')"], environment: "none" },
    });
    expect(j.status).toBe(201);
    await until(
      async () =>
        (await call(`/api/v1/jobs/${j.body.job_id}`)).body.latest_attempt.state === "succeeded",
    );
  }, 600_000);

  test("criterion 6: the logged sklearn model is inspectable and downloadable, with flavors, signature and dependencies", async () => {
    clf1 = await modelOf(job1);
    const d = (await call(`/api/v1/projects/skl/models/${clf1.model_id}`)).body;
    expect(d.model.name).toBe("iris-logreg");
    expect(d.mlmodel.flavors.map((f: Json) => f.name).sort()).toEqual([
      "python_function",
      "sklearn",
    ]);
    expect(d.mlmodel.signature.inputs.map((c: Json) => c.name)).toEqual([
      "sepal_length",
      "sepal_width",
      "petal_length",
      "petal_width",
    ]);
    expect(d.trust.level).toBe("restricted"); // MLflow 3.17 saves sklearn models as skops
    expect(d.dependencies.requirements).toContain("scikit-learn");
    expect(d.source_run.attempt_id).toBe(job1.latest_attempt.attempt_id);
    const dl = await cl.human(
      `/api/v1/projects/skl/models/${clf1.model_id}/artifacts/download?path=MLmodel`,
      {
        token: await cl.session(),
      },
    );
    expect(dl.status).toBe(200);
    expect(await dl.text()).toContain("sklearn");
  }, 300_000);

  test("criterion 5: datasets show versions, roles, splits, fingerprints, source commit and linked runs/models", async () => {
    const ds = (await call("/api/v1/projects/skl/datasets")).body.datasets as Json[];
    const iris = ds.filter((d) => d.name === "iris");
    expect(iris.length).toBeGreaterThanOrEqual(1);
    const use = iris.flatMap((d) => d.uses).find((u: Json) => u.split === "train");
    expect(use).toMatchObject({ context: "training", version: "v1", job_id: job1.job_id });
    expect(use.fingerprint).toHaveLength(64);
    expect(use.source_commit).toMatch(/^[a-f0-9]{40}$/);
    expect(iris.flatMap((d) => d.models)).toContainEqual({
      model_id: clf1.model_id,
      relation: "trained",
    });
  }, 120_000);

  test("criterion 6: register, version, alias and choose a version; lineage reaches the job", async () => {
    clf2 = await modelOf(await mlproject("main", { C: "5" }));
    reg = await modelOf(await mlproject("regress", { alpha: "0.5" }));
    expect(
      (await call("/api/v1/projects/skl/registry", { body: { name: REG, description: "iris" } }))
        .status,
    ).toBe(201);
    for (const m of [clf1, clf2])
      expect(
        (
          await call(`/api/v1/projects/skl/registry/${REG}/versions`, {
            body: { model_id: m.model_id },
          })
        ).status,
      ).toBe(201);
    await call(`/api/v1/projects/skl/registry/${REG}/aliases/champion`, {
      method: "PUT",
      body: { version: "2" },
    });
    const r = (await call(`/api/v1/projects/skl/registry/${REG}/resolve?alias=champion`)).body;
    expect(r).toMatchObject({ version: "2", model_id: clf2.model_id });
    const detail = (await call(`/api/v1/projects/skl/registry/${REG}`)).body.registered_model;
    expect(detail.versions.map((v: Json) => [v.version, v.model_id])).toEqual([
      ["2", clf2.model_id],
      ["1", clf1.model_id],
    ]);
    const lin = (await call(`/api/v1/projects/skl/lineage?kind=model_version&id=${REG}/1`)).body;
    expect(lin.steps.find((s: Json) => s.step === "job").items[0].ref.id).toBe(job1.job_id);
  }, 600_000);

  test("criterion 7: classification and regression evaluations with plots and threshold results", async () => {
    const clf = await evaluation({
      model_type: "classifier",
      model: { name: REG, alias: "champion" },
      baseline: { name: REG, version: "1" },
      dataset: { path: "data/iris.csv", targets: "target", split: "all" },
      thresholds: [
        { metric: "accuracy_score", threshold: "0.8", greater_is_better: true },
        { metric: "log_loss", threshold: "2.0", greater_is_better: false },
      ],
    });
    expect(clf.evaluation.model).toMatchObject({
      model_id: clf2.model_id,
      version: "2",
      alias: "champion",
    });
    expect(clf.evaluation.validation).toMatchObject({ passed: true, mlflow_verdict: "passed" });
    expect(clf.candidate.metrics.accuracy_score).toBeGreaterThan(0.8);
    expect(clf.baseline.metrics.accuracy_score).toBeGreaterThan(0.5);
    const plots = (clf.candidate.artifacts as Json[]).map((a) => a.path);
    expect(plots.some((p: string) => p.startsWith("confusion_matrix") && p.endsWith(".png"))).toBe(
      true,
    );
    expect(plots).toContain("ablationkit/validation.json");

    const rgr = await evaluation({
      model_type: "regressor",
      model: { model_id: reg.model_id },
      dataset: { path: "data/regression.csv", targets: "y" },
      thresholds: [
        { metric: "r2_score", threshold: "0.5", greater_is_better: true },
        { metric: "mean_absolute_error", threshold: "0.0001", greater_is_better: false },
      ],
    });
    expect(rgr.candidate.metrics.r2_score).toBeGreaterThan(0.5);
    expect(rgr.evaluation.validation.passed).toBe(false);
    expect(rgr.evaluation.validation.mlflow_verdict).toBe("failed");
    const [r2, mae] = rgr.evaluation.validation.outcomes;
    expect(r2).toMatchObject({ metric: "r2_score", passed: true });
    expect(mae.passed).toBe(false);
    expect(mae.failures[0]).toContain("mean_absolute_error");

    // Linked from the model and the registry version.
    const md = (await call(`/api/v1/projects/skl/models/${clf2.model_id}`)).body;
    expect(md.evaluations.map((e: Json) => e.evaluation_id)).toContain(
      clf.evaluation.evaluation_id,
    );
    const ds = (await call("/api/v1/projects/skl/datasets")).body.datasets as Json[];
    const evalUse = ds
      .flatMap((d) => d.uses)
      .find((u: Json) => u.evaluation_id === clf.evaluation.evaluation_id);
    expect(evalUse).toBeDefined();
  }, 600_000);

  test("criterion 9e, remote half: a remote evaluation loads the registered sklearn model with the real mlflow.pyfunc on the worker and checks thresholds after sync", async () => {
    // The "remote" host is this machine over a fake ssh; its Python is the pinned MLflow venv
    // (mlflow, scikit-learn), so the worker loads the exported model files as a real target would.
    const host = fakeHost(h.tmp("ak-remote-"));
    const t = await call("/api/v1/targets/box", {
      method: "PUT",
      body: {
        kind: "ssh",
        ssh: { host: "box", command: [host.ssh], supervisor: "nohup" },
        worker_url: cl.c.urls.worker,
        python,
      },
    });
    expect([200, 201]).toContain(t.status);
    const r = await call("/api/v1/projects/skl/evaluations", {
      body: {
        model_type: "classifier",
        model: { name: REG, alias: "champion" },
        dataset: { path: "data/iris.csv", targets: "target" },
        thresholds: [
          { metric: "accuracy_score", threshold: "0.8", greater_is_better: true },
          { metric: "f1_score", threshold: "0.999", greater_is_better: true },
        ],
        target_id: "box",
        timeout_sec: 600,
      },
    });
    if (r.status !== 202) throw new Error(`evaluation: ${r.status} ${JSON.stringify(r.body)}`);
    expect(r.body.evaluation.remote).toMatchObject({ target_id: "box" });
    const id = r.body.evaluation.evaluation_id;
    const done = await until(async () => {
      const v = (await call(`/api/v1/projects/skl/evaluations/${id}`)).body;
      if (v.evaluation.state === "failed") throw new Error(`failed: ${v.evaluation.error}`);
      return v.evaluation.state === "succeeded" ? v : undefined;
    });
    const ev = done.evaluation;
    expect(ev.model).toMatchObject({ model_id: clf2.model_id });
    expect(ev.validation.mlflow_verdict).toBeUndefined();
    const [acc, f1] = ev.validation.outcomes;
    expect(acc).toMatchObject({ metric: "accuracy_score", passed: true });
    expect(f1).toMatchObject({ metric: "f1_score", passed: false });
    // The job's run is the evaluation's run, with the metrics the worker computed.
    const run = await new MlflowClient({ url: mlflowUrl }).getRun(ev.mlflow_run_id);
    const m = new Map((run.data.metrics ?? []).map((x) => [x.key, x.value]));
    expect(m.get("example_count")).toBe(150);
    expect(m.get("accuracy_score")).toBeGreaterThan(0.8);
    const tags = new Map((run.data.tags ?? []).map((x) => [x.key, x.value]));
    expect(tags.get("ablationkit.evaluation_id")).toBe(id);
    const job = (await call(`/api/v1/jobs/${ev.remote.job_id}`)).body;
    expect(job.attempts).toHaveLength(1);
    expect(job.latest_attempt.artifacts.map((a: Json) => a.path)).toContain("eval/predictions.csv");
  }, 600_000);
});
