/**
 * Model lifecycle against the fake MLflow (criteria 5, 6, 7, 8; ADR 0019): real jobs (direct
 * supervisor mode) whose SDK logs dataset inputs and an MLflow model directory, the registry,
 * classical evaluations through the operations bridge (a fake bridge script here; the real Python
 * bridge and real MLflow run in lifecycle-e2e.test.ts), and MLflow Projects launch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { parseMlmodel, trustNote } from "../src/models/models.ts";
import { parseMlproject, renderCommand, shlexQuote } from "../src/tracking/mlprojects.ts";
import { Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
const FAKE_BRIDGE = resolve(import.meta.dir, "fake-bridge.ts");

afterEach(async () => {
  for (const c of h.coordinators)
    for (const j of c.services.jobs.list())
      for (const id of j.attempts) {
        const a = c.services.jobs.attempt(id);
        for (const pid of [a?.collector.pid, a?.pid ? -a.pid : undefined])
          try {
            if (pid) process.kill(pid, "SIGKILL");
          } catch {
            // gone
          }
      }
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

// biome-ignore lint/suspicious/noExplicitAny: loosely typed API JSON in assertions
type Json = any;

const SETTINGS: CoordinatorSettings = {
  schema_version: 1,
  human: { host: "127.0.0.1", port: 0 },
  agent: { host: "127.0.0.1", port: 0 },
  worker: { host: "127.0.0.1", port: 0 },
  mlflow: { enabled: false },
  jobs: { supervisor: "direct", deliver_deadline_sec: 30 },
};

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(50);
  }
}

async function setup(opts: { home?: string; fake?: FakeMlflow; bridgeConfig?: string } = {}) {
  const fake = opts.fake ?? new FakeMlflow().start();
  if (!opts.fake) fakes.push(fake);
  const bridgeConfig = opts.bridgeConfig ?? join(h.tmp("ak-bridge-"), "config.json");
  if (!opts.bridgeConfig) writeFileSync(bridgeConfig, "{}");
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    jobWatchdogMs: 200,
    settings: SETTINGS,
    bridgeCommand: [process.execPath, FAKE_BRIDGE, bridgeConfig],
    ...(opts.home ? { home: opts.home } : {}),
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  return { fake, cl, token, call, bridgeConfig };
}
type Call = Awaited<ReturnType<typeof setup>>["call"];

const MLMODEL = `artifact_path: model
flavors:
  python_function:
    env:
      virtualenv: python_env.yaml
    loader_module: mlflow.sklearn
    model_path: model.skops
    predict_fn: predict
    python_version: 3.12.14
  sklearn:
    pickled_model: model.skops
    serialization_format: skops
    sklearn_version: 1.9.1
mlflow_version: 3.17.2
model_size_bytes: 11410
saved_input_example_info:
  artifact_path: input_example.json
  type: dataframe
signature:
  inputs: '[{"type": "double", "name": "x1", "required": true}, {"type": "double", "name": "x2", "required": true}]'
  outputs: '[{"type": "long", "required": true}]'
  params: null
utc_time_created: '2026-11-04 01:45:56.248654'
`;

/** A project whose training script uses only the SDK; the "model" is an MLflow model directory. */
function trainingRepo(name: string): string {
  const d = h.repo(name);
  mkdirSync(join(d, "data"));
  writeFileSync(join(d, "data", "train.csv"), "x1,x2,y\n0.1,0.2,0\n0.9,0.8,1\n");
  writeFileSync(join(d, "data", "test.csv"), "x1,x2,y\n0.2,0.1,0\n0.8,0.9,1\n");
  writeFileSync(
    join(d, "train.py"),
    `
import os, json, pathlib
import ablationkit_sdk as ak
ak.log_params({"C": 0.5})
ak.log_input("toy", source="data/train.csv", path="data/train.csv", split="train", version="v1",
             schema={"mlflow_colspec": [{"type": "double", "name": "x1"}]}, profile={"num_rows": 2})
ak.log_input("toy", source="data/test.csv", path="data/test.csv", context="validation", split="test")
out = pathlib.Path("out/model"); out.mkdir(parents=True, exist_ok=True)
(out / "MLmodel").write_text(${JSON.stringify(MLMODEL)})
(out / "model.skops").write_bytes(b"skops-bytes")
(out / "requirements.txt").write_text("mlflow==3.17.2\\nscikit-learn==1.9.1\\n")
(out / "python_env.yaml").write_text("python: 3.12.14\\n")
(out / "input_example.json").write_text(json.dumps({"columns": ["x1", "x2"], "data": [[0.1, 0.2]]}))
ak.log_metrics({"val/accuracy": 0.75}, step=1)
ak.log_model(out, "toy-clf", step=1)
print("trained")
`,
  );
  return d;
}

async function addProject(call: Call, path: string, id: string): Promise<void> {
  const r = await call("/api/v1/projects", { body: { path, project_id: id } });
  expect(r.status).toBe(201);
}

async function runJob(call: Call, project: string, body: Json): Promise<Json> {
  const r = await call(`/api/v1/projects/${project}/jobs`, { body });
  expect(r.status).toBe(201);
  return until(async () => {
    const j = (await call(`/api/v1/jobs/${r.body.job_id}`)).body;
    return j.latest_attempt.state === "succeeded"
      ? j
      : j.latest_attempt.state === "failed"
        ? Promise.reject(new Error(JSON.stringify(j)))
        : undefined;
  }, 30_000);
}

/** Train once and wait until the logged model is ready in MLflow. */
async function trainedModel(call: Call, project: string): Promise<{ model_id: string; job: Json }> {
  const job = await runJob(call, project, { command: ["python3", "train.py"], run_name: "train" });
  const model = await until(async () => {
    const r = await call(`/api/v1/projects/${project}/models`);
    const m = r.body.models?.[0];
    return m?.status === "LOGGED_MODEL_READY" ? m : undefined;
  });
  return { model_id: model.model_id, job };
}

describe("datasets and logged models (criteria 5, 6)", () => {
  test("the SDK's dataset inputs and model directory reach MLflow with roles, splits, fingerprints, flavors, signature and lineage", async () => {
    const { fake, call, cl } = await setup();
    await addProject(call, trainingRepo("dl"), "dl");
    const { model_id, job } = await trainedModel(call, "dl");
    const attemptId = job.latest_attempt.attempt_id as string;
    const runId = job.latest_attempt.tracking.mlflow_run_id as string;

    // MLflow holds the logged model with its own artifacts, linked to the attempt's run.
    const lm = fake.loggedModel(model_id);
    expect(lm?.info.source_run_id).toBe(runId);
    expect(lm?.info.tags).toContainEqual({ key: "ablationkit.attempt_id", value: attemptId });
    expect(new TextDecoder().decode(fake.modelArtifact(model_id, "MLmodel"))).toBe(MLMODEL);
    expect(fake.run(runId)?.outputs).toEqual([{ model_id, step: 1 }]);

    // Model page data: flavors, signature, dependencies, trust, files, source run, datasets.
    const d = (await call(`/api/v1/projects/dl/models/${model_id}`)).body;
    expect(d.model).toMatchObject({
      model_id,
      name: "toy-clf",
      status: "LOGGED_MODEL_READY",
      attempt_id: attemptId,
    });
    expect(d.mlmodel.flavors.map((f: Json) => f.name).sort()).toEqual([
      "python_function",
      "sklearn",
    ]);
    expect(d.mlmodel.flavors.find((f: Json) => f.name === "sklearn")).toMatchObject({
      serialization_format: "skops",
      framework_version: "1.9.1",
    });
    expect(d.mlmodel.signature.inputs).toEqual([
      { type: "double", name: "x1", required: true },
      { type: "double", name: "x2", required: true },
    ]);
    expect(d.trust.level).toBe("restricted");
    expect(d.dependencies.requirements).toContain("scikit-learn==1.9.1");
    expect(d.input_example).toContain("x1");
    expect(d.files.map((f: Json) => f.path).sort()).toEqual([
      "MLmodel",
      "input_example.json",
      "model.skops",
      "python_env.yaml",
      "requirements.txt",
    ]);
    expect(d.source_run).toMatchObject({ run_id: runId, attempt_id: attemptId });
    expect(d.source_run.datasets.map((x: Json) => x.split).sort()).toEqual(["test", "train"]);

    // Download: bytes as an attachment, never active content.
    const dl = await cl.human(
      `/api/v1/projects/dl/models/${model_id}/artifacts/download?path=model.skops`,
      {
        token: (await cl.session()) as string,
      },
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(await dl.text()).toBe("skops-bytes");
    const outside = await call(
      `/api/v1/projects/dl/models/${model_id}/artifacts/download?path=../x`,
    );
    expect(outside.status).toBe(400);

    // Datasets (criterion 5): versions by digest, roles, splits, fingerprints, runs and models.
    const ds = (await call("/api/v1/projects/dl/datasets")).body.datasets as Json[];
    expect(ds).toHaveLength(2);
    const train = ds.find((x) => x.uses[0].split === "train") as Json;
    expect(train).toMatchObject({ name: "toy", source_type: "local", source: "data/train.csv" });
    expect(train.digest).toHaveLength(16);
    expect(train.schema).toEqual({ mlflow_colspec: [{ type: "double", name: "x1" }] });
    expect(train.profile).toEqual({ num_rows: 2 });
    expect(train.uses[0]).toMatchObject({
      run_id: runId,
      context: "training",
      version: "v1",
      job_id: job.job_id,
      attempt_id: attemptId,
    });
    expect(train.uses[0].fingerprint).toHaveLength(64);
    expect(train.uses[0].fingerprint.startsWith(train.digest)).toBe(true);
    expect(train.models).toEqual([{ model_id, relation: "trained" }]);
    const test2 = ds.find((x) => x.uses[0].split === "test") as Json;
    expect(test2.uses[0].context).toBe("validation");

    // Lineage from the model reaches the run, attempt and job.
    const lin = (await call(`/api/v1/projects/dl/lineage?kind=logged_model&id=${model_id}`)).body;
    const step = (s: string) => lin.steps.find((x: Json) => x.step === s);
    expect(step("logged_model").status).toBe("subject");
    expect(step("run").items.map((i: Json) => i.ref.id)).toEqual([runId]);
    expect(step("attempt").items.map((i: Json) => i.ref.id)).toEqual([attemptId]);
    expect(step("job").items.map((i: Json) => i.ref.id)).toEqual([job.job_id]);
    expect(step("model_version")).toMatchObject({ status: "missing", reason: "not registered" });

    // Another project cannot read it.
    await addProject(call, h.repo("other"), "other");
    expect((await call(`/api/v1/projects/other/models/${model_id}`)).status).toBe(404);
  }, 60_000);

  test("registry: register, version, alias, describe, tag, resolve, lineage, project scoping and agent read-only access", async () => {
    const { call, cl } = await setup();
    await addProject(call, trainingRepo("reg"), "reg");
    await addProject(call, h.repo("other"), "other");
    const first = await trainedModel(call, "reg");
    // A second training run: a second logged model.
    await runJob(call, "reg", { command: ["python3", "train.py"] });
    const second = await until(async () => {
      const ms = (await call("/api/v1/projects/reg/models")).body.models as Json[];
      return ms.find((m) => m.model_id !== first.model_id && m.status === "LOGGED_MODEL_READY");
    });

    const created = await call("/api/v1/projects/reg/registry", {
      body: { name: "toy classifier", description: "first draft", tags: { team: "a" } },
    });
    expect(created.status).toBe(201);
    expect(
      (await call("/api/v1/projects/reg/registry", { body: { name: "toy classifier" } })).status,
    ).toBe(409);
    const v1 = await call("/api/v1/projects/reg/registry/toy classifier/versions", {
      body: { model_id: first.model_id, description: "baseline" },
    });
    expect(v1.status).toBe(201);
    expect(v1.body.model_version.version).toBe("1");
    const v2 = await call("/api/v1/projects/reg/registry/toy classifier/versions", {
      body: { model_id: second.model_id, tags: { stage: "candidate" } },
    });
    expect(v2.body.model_version.version).toBe("2");

    // Choose a version: an alias, resolved to a pinned version and logged-model ID.
    expect(
      (
        await call("/api/v1/projects/reg/registry/toy classifier/aliases/champion", {
          method: "PUT",
          body: { version: "2" },
        })
      ).status,
    ).toBe(200);
    const res = await call("/api/v1/projects/reg/registry/toy classifier/resolve?alias=champion");
    expect(res.body).toMatchObject({ version: "2", model_id: second.model_id, alias: "champion" });
    expect(
      (
        await call("/api/v1/projects/reg/registry/toy classifier/aliases/latest", {
          method: "PUT",
          body: { version: "1" },
        })
      ).status,
    ).toBe(400);

    await call("/api/v1/projects/reg/registry/toy classifier/versions/1", {
      method: "PATCH",
      body: { description: "the baseline", tags: { reviewed: "yes" } },
    });
    const upd = await call("/api/v1/projects/reg/registry/toy classifier", {
      method: "PATCH",
      body: { description: "", delete_tags: ["team"] },
    });
    expect(upd.status).toBe(200);
    const rm = upd.body.registered_model;
    expect(rm.description).toBe("");
    expect(rm.tags).toEqual([]);
    expect(rm.aliases).toEqual([{ alias: "champion", version: "2" }]);
    expect(rm.versions.map((v: Json) => v.version)).toEqual(["2", "1"]);
    const ver1 = rm.versions.find((v: Json) => v.version === "1");
    expect(ver1).toMatchObject({
      description: "the baseline",
      model_id: first.model_id,
      run_id: first.job.latest_attempt.tracking.mlflow_run_id,
      attempt_id: first.job.latest_attempt.attempt_id,
      job_id: first.job.job_id,
    });
    expect(ver1.tags).toContainEqual({ key: "reviewed", value: "yes" });
    expect(rm.versions[0].aliases).toEqual(["champion"]);

    // Reserved tags are refused; the model page lists the versions it backs.
    expect(
      (
        await call("/api/v1/projects/reg/registry/toy classifier", {
          method: "PATCH",
          body: { tags: { "ablationkit.project_id": "other" } },
        })
      ).status,
    ).toBe(400);
    const md = (await call(`/api/v1/projects/reg/models/${second.model_id}`)).body;
    expect(md.registry_versions).toEqual([
      { name: "toy classifier", version: "2", aliases: ["champion"] },
    ]);

    // Lineage: registry version → logged model → run → attempt → job.
    const lin = (await call("/api/v1/projects/reg/lineage?kind=model_version&id=toy classifier/1"))
      .body;
    const step = (s: string) => lin.steps.find((x: Json) => x.step === s);
    expect(step("model_version").status).toBe("subject");
    expect(step("logged_model").items.map((i: Json) => i.ref.id)).toEqual([first.model_id]);
    expect(step("job").items.map((i: Json) => i.ref.id)).toEqual([first.job.job_id]);

    // Project scoping: another project cannot see, mutate or register into it.
    expect((await call("/api/v1/projects/other/registry/toy classifier")).status).toBe(409);
    expect(
      (
        await call("/api/v1/projects/other/registry/toy classifier/versions", {
          body: { model_id: first.model_id },
        })
      ).status,
    ).toBe(409);
    expect((await call("/api/v1/projects/other/registry")).body.registered_models).toEqual([]);
    await call("/api/v1/projects/other/registry", { body: { name: "other-model" } });
    expect(
      (
        await call("/api/v1/projects/other/registry/other-model/versions", {
          body: { model_id: first.model_id },
        })
      ).status,
    ).toBe(404);

    // An agent bound to the project reads; registry writes are not on the agent listener.
    const minted = { body: await cl.agentSession("reg") };
    const agent = (path: string, init: { method?: string; body?: unknown } = {}) =>
      cl.json(cl.agent(path, { token: minted.body.token, ...init }));
    expect((await agent("/api/v1/projects/reg/registry/toy classifier")).status).toBe(200);
    expect((await agent("/api/v1/projects/reg/datasets")).status).toBe(200);
    expect(
      (
        await agent("/api/v1/projects/reg/registry/toy classifier/aliases/champion", {
          method: "PUT",
          body: { version: "1" },
        })
      ).status,
    ).toBe(404);
    expect((await agent("/api/v1/projects/reg/registry", { body: { name: "x" } })).status).toBe(
      404,
    );
    expect((await agent("/api/v1/projects/other/registry")).status).toBe(403);
  }, 90_000);
});

describe("classical evaluation (criterion 7)", () => {
  test("launch by registry alias pins the version; metrics, plots and threshold outcomes are recorded and linked", async () => {
    const { call, bridgeConfig, fake } = await setup();
    const repo = trainingRepo("ev");
    await addProject(call, repo, "ev");
    const first = await trainedModel(call, "ev");
    await runJob(call, "ev", { command: ["python3", "train.py"] });
    const second = await until(async () => {
      const ms = (await call("/api/v1/projects/ev/models")).body.models as Json[];
      return ms.find((m) => m.model_id !== first.model_id && m.status === "LOGGED_MODEL_READY");
    });
    writeFileSync(
      bridgeConfig,
      JSON.stringify({ metrics: { [first.model_id]: 0.8, [second.model_id]: 0.9 } }),
    );
    await call("/api/v1/projects/ev/registry", { body: { name: "toy" } });
    for (const m of [first.model_id, second.model_id])
      await call("/api/v1/projects/ev/registry/toy/versions", { body: { model_id: m } });
    await call("/api/v1/projects/ev/registry/toy/aliases/champion", {
      method: "PUT",
      body: { version: "2" },
    });

    // Input validation happens before anything runs.
    const bad = async (body: Json) =>
      (await call("/api/v1/projects/ev/evaluations", { body })).status;
    const base = {
      model_type: "classifier",
      model: { name: "toy", alias: "champion" },
      dataset: { path: "data/test.csv", targets: "y" },
    };
    expect(await bad({ ...base, dataset: { path: "../x.csv", targets: "y" } })).toBe(400);
    expect(await bad({ ...base, dataset: { path: "data/nope.csv", targets: "y" } })).toBe(404);
    expect(await bad({ ...base, model_type: "ranker" })).toBe(400);
    expect(
      await bad({
        ...base,
        thresholds: [
          { metric: "accuracy_score", min_absolute_change: "0.01", greater_is_better: true },
        ],
      }),
    ).toBe(422);
    expect(
      await bad({
        ...base,
        thresholds: [{ metric: "accuracy_score", threshold: 0.5, greater_is_better: true }],
      }),
    ).toBe(400);

    const launched = await call("/api/v1/projects/ev/evaluations", {
      body: {
        ...base,
        dataset: { path: "data/test.csv", targets: "y", split: "test" },
        baseline: { name: "toy", version: "1" },
        thresholds: [
          { metric: "accuracy_score", threshold: "0.85", greater_is_better: true },
          { metric: "example_count", min_absolute_change: "1", greater_is_better: true },
        ],
      },
    });
    expect(launched.status).toBe(202);
    const ev = launched.body.evaluation;
    // The alias was resolved and pinned at launch.
    expect(ev.model).toEqual({
      model_id: second.model_id,
      registered_name: "toy",
      version: "2",
      alias: "champion",
    });
    expect(ev.baseline).toEqual({ model_id: first.model_id, registered_name: "toy", version: "1" });
    expect(ev.dataset.sha256).toHaveLength(64);
    // Moving the alias afterwards changes nothing about this evaluation.
    await call("/api/v1/projects/ev/registry/toy/aliases/champion", {
      method: "PUT",
      body: { version: "1" },
    });

    const done = await until(async () => {
      const r = (await call(`/api/v1/projects/ev/evaluations/${ev.evaluation_id}`)).body;
      return r.evaluation.state === "succeeded"
        ? r
        : r.evaluation.state === "failed"
          ? Promise.reject(new Error(r.evaluation.error))
          : undefined;
    });
    expect(done.evaluation.validation).toMatchObject({
      passed: false,
      mlflow_verdict: "failed",
      outcomes: [
        { metric: "accuracy_score", passed: true, candidate: "0.9", baseline: "0.8" },
        { metric: "example_count", passed: false },
      ],
    });
    expect(done.candidate.metrics.accuracy_score).toBe(0.9);
    expect(done.baseline.metrics.accuracy_score).toBe(0.8);
    expect(done.candidate.artifacts.map((a: Json) => a.path)).toContain("confusion_matrix.png");
    // MLflow runs are tagged with the evaluation and the evaluated model.
    const run = fake.run(ev.mlflow_run_id);
    expect(run?.tags.get("ablationkit.evaluation_id")).toBe(ev.evaluation_id);
    expect(run?.tags.get("ablationkit.evaluated_model_id")).toBe(second.model_id);
    expect(run?.info.status).toBe("FINISHED");

    // Linked in the UI's data: the model page, the registry version, the dataset and lineage.
    const md = (await call(`/api/v1/projects/ev/models/${second.model_id}`)).body;
    expect(md.evaluations).toEqual([
      {
        evaluation_id: ev.evaluation_id,
        state: "succeeded",
        role: "candidate",
        passed: false,
        mlflow_run_id: ev.mlflow_run_id,
      },
    ]);
    const reg = (await call("/api/v1/projects/ev/registry/toy")).body.registered_model;
    expect(reg.versions.find((v: Json) => v.version === "2").evaluations).toEqual([
      { evaluation_id: ev.evaluation_id, state: "succeeded", passed: false },
    ]);
    const ds = (await call("/api/v1/projects/ev/datasets")).body.datasets as Json[];
    const evalDs = ds.find((d) => d.digest === "evaldigest") as Json;
    expect(evalDs.uses[0]).toMatchObject({
      context: "evaluation",
      evaluation_id: ev.evaluation_id,
    });
    expect(evalDs.models).toContainEqual({
      model_id: second.model_id,
      relation: "evaluated",
      registered: "toy@2",
    });
    const lin = (await call(`/api/v1/projects/ev/lineage?kind=evaluation&id=${ev.evaluation_id}`))
      .body;
    const step = (s: string) => lin.steps.find((x: Json) => x.step === s);
    expect(step("evaluation").items[0]).toMatchObject({ status: "thresholds failed" });
    expect(step("logged_model").items.map((i: Json) => i.ref.id)).toEqual([second.model_id]);
    expect(step("model_version").items.map((i: Json) => i.ref.id)).toEqual(["toy/2"]);

    // A failing operation is a failed evaluation with MLflow's error, and its run is FAILED.
    writeFileSync(bridgeConfig, JSON.stringify({ fail: true }));
    const f = (await call("/api/v1/projects/ev/evaluations", { body: base })).body.evaluation;
    const failed = await until(async () => {
      const r = (await call(`/api/v1/projects/ev/evaluations/${f.evaluation_id}`)).body.evaluation;
      return r.state === "failed" ? r : undefined;
    });
    expect(failed.error).toContain("target column");
    expect(fake.run(f.mlflow_run_id)?.info.status).toBe("FAILED");
  }, 120_000);

  test("an evaluation running when the coordinator stops is interrupted on restart, never rerun; cancel works", async () => {
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const home = h.tmp("ak-home-");
    const cfg = join(h.tmp("ak-bridge-"), "config.json");
    writeFileSync(cfg, JSON.stringify({ sleep_ms: 30_000 }));
    const first = await setup({ fake, home, bridgeConfig: cfg });
    await addProject(first.call, trainingRepo("rs"), "rs");
    const { model_id } = await trainedModel(first.call, "rs");
    const body = {
      model_type: "classifier",
      model: { model_id },
      dataset: { path: "data/test.csv", targets: "y" },
    };
    const a = (await first.call("/api/v1/projects/rs/evaluations", { body })).body.evaluation;
    await until(
      async () =>
        (await first.call(`/api/v1/projects/rs/evaluations/${a.evaluation_id}`)).body.evaluation
          .state === "running",
    );
    const b = (await first.call("/api/v1/projects/rs/evaluations", { body })).body.evaluation;
    await until(
      async () =>
        (await first.call(`/api/v1/projects/rs/evaluations/${b.evaluation_id}`)).body.evaluation
          .state === "running",
    );
    const canceled = await first.call(`/api/v1/projects/rs/evaluations/${b.evaluation_id}/cancel`, {
      body: {},
    });
    expect(canceled.body.evaluation.state).toBe("canceled");
    await until(async () => fake.run(b.mlflow_run_id)?.info.status === "KILLED");
    await first.cl.c.stop();

    const second = await setup({ fake, home, bridgeConfig: cfg });
    const r = (await second.call(`/api/v1/projects/rs/evaluations/${a.evaluation_id}`)).body
      .evaluation;
    expect(r.state).toBe("interrupted");
    expect(r.error).toContain("not rerun");
    await until(async () => fake.run(a.mlflow_run_id)?.info.status === "KILLED");
    // Criterion 14: datasets and model provenance survive the restart.
    const ds = (await second.call("/api/v1/projects/rs/datasets")).body.datasets as Json[];
    expect(ds.map((d) => d.name)).toEqual(["toy", "toy"]);
    expect(ds.flatMap((d) => d.models)).toContainEqual({ model_id, relation: "trained" });
    const lin = (await second.call(`/api/v1/projects/rs/lineage?kind=logged_model&id=${model_id}`))
      .body;
    expect(lin.steps.find((s: Json) => s.step === "job").status).toBe("linked");
    expect(lin.steps.find((s: Json) => s.step === "evaluation").items.length).toBe(2);
  }, 90_000);
});

describe("MLflow Projects (criterion 8)", () => {
  function mlprojectRepo(name: string, mlproject: string): string {
    const d = h.repo(name);
    writeFileSync(join(d, "MLproject"), mlproject);
    mkdirSync(join(d, "data"));
    writeFileSync(join(d, "data", "x.csv"), "a\n1\n");
    writeFileSync(
      join(d, "train.py"),
      `
import sys, argparse
import ablationkit_sdk as ak
p = argparse.ArgumentParser(); p.add_argument("--alpha", type=float); p.add_argument("--data"); p.add_argument("--note", default="")
a = p.parse_args()
ak.log_metrics({"loss": 1 - a.alpha}, step=0)
print("alpha", a.alpha, "data", a.data, "note", a.note)
`,
    );
    return d;
  }

  const MLPROJECT = `name: toy-project
python_env: python_env.yaml
entry_points:
  main:
    parameters:
      alpha: {type: float, default: 0.5}
      data: path
    command: "python3 train.py --alpha {alpha} --data {data}"
  validate:
    parameters:
      data: {type: path, default: data/x.csv}
    command: "python3 train.py --alpha 0 --data {data}"
`;

  test("detect entrypoints, launch one as a job tagged like mlflow run, observe it; a project without MLproject still runs", async () => {
    const { call, fake } = await setup();
    const repo = mlprojectRepo("mp", MLPROJECT);
    await addProject(call, repo, "mp");
    const info = (await call("/api/v1/projects/mp/mlproject")).body;
    expect(info).toMatchObject({ found: true, name: "toy-project", problems: [] });
    expect(info.environment).toMatchObject({
      kind: "python_env",
      file: "python_env.yaml",
      supported: true,
    });
    expect(info.entry_points).toEqual([
      {
        name: "main",
        command: "python3 train.py --alpha {alpha} --data {data}",
        parameters: [
          { name: "alpha", type: "float", default: "0.5" },
          { name: "data", type: "path" },
        ],
      },
      {
        name: "validate",
        command: "python3 train.py --alpha 0 --data {data}",
        parameters: [{ name: "data", type: "path", default: "data/x.csv" }],
      },
    ]);

    // Bad parameters are refused before anything runs.
    const launch = (body: Json) => call("/api/v1/projects/mp/mlproject/runs", { body });
    expect(
      (await launch({ entrypoint: "main", parameters: { data: "data/x.csv", alpha: "lots" } }))
        .status,
    ).toBe(422);
    expect((await launch({ entrypoint: "main", parameters: {} })).status).toBe(422);
    expect(
      (await launch({ entrypoint: "main", parameters: { data: "../../etc/passwd" } })).status,
    ).toBe(422);
    expect((await launch({ entrypoint: "nope" })).status).toBe(404);

    const r = await launch({
      entrypoint: "main",
      parameters: { alpha: "0.7", data: "data/x.csv", note: "it's quoted" },
      environment: "none",
    });
    expect(r.status).toBe(202);
    expect(r.body.mlproject).toEqual({
      entrypoint: "main",
      parameters: { alpha: "0.7", data: join(repo, "data/x.csv"), note: "it's quoted" },
      declared_environment: "python_env",
      project_name: "toy-project",
    });
    expect(r.body.job.command).toEqual([
      "/bin/sh",
      "-c",
      `python3 train.py --alpha 0.7 --data ${join(repo, "data/x.csv")} --note 'it'"'"'s quoted'`,
    ]);
    const jobId = r.body.job.job_id as string;
    const job = await until(async () => {
      const j = (await call(`/api/v1/jobs/${jobId}`)).body;
      return j.latest_attempt.state === "succeeded" &&
        j.latest_attempt.tracking.sync_state === "synced"
        ? j
        : undefined;
    }, 30_000);
    expect(job.mlproject.entrypoint).toBe("main");
    const run = fake.run(job.latest_attempt.tracking.mlflow_run_id);
    expect(run?.tags.get("mlflow.project.entryPoint")).toBe("main");
    expect(run?.tags.get("mlflow.source.type")).toBe("PROJECT");
    expect(run?.tags.get("ablationkit.mlproject_entrypoint")).toBe("main");
    expect(run?.metrics.find((m) => m.key === "loss")?.value).toBeCloseTo(0.3);
    const con = (
      await call(
        `/api/v1/jobs/${jobId}/attempts/${job.latest_attempt.attempt_id}/console?after=-1&limit=1000`,
      )
    ).body;
    expect(con.lines.map((l: Json) => l.text).join("\n")).toContain("note it's quoted");
    const mapping = h.coordinators[0]?.services.tracking.mappings.get(
      job.latest_attempt.attempt_id,
    );
    expect(mapping?.mlproject_entrypoint).toBe("main");

    // A project without an MLproject: nothing to detect, and plain commands still run.
    const plain = h.repo("plain");
    writeFileSync(join(plain, "run.py"), "print('plain')\n");
    await addProject(call, plain, "plain");
    expect((await call("/api/v1/projects/plain/mlproject")).body).toMatchObject({
      found: false,
      entry_points: [],
    });
    expect(
      (await call("/api/v1/projects/plain/mlproject/runs", { body: { entrypoint: "main" } }))
        .status,
    ).toBe(404);
    const pj = await runJob(call, "plain", { command: ["python3", "run.py"] });
    expect(pj.mlproject).toBeUndefined();

    // docker_env is refused (no containers), and is reported as such.
    const docker = mlprojectRepo(
      "dk",
      "name: d\ndocker_env:\n  image: x\nentry_points:\n  main:\n    command: echo hi\n",
    );
    await addProject(call, docker, "dk");
    expect((await call("/api/v1/projects/dk/mlproject")).body.environment).toMatchObject({
      kind: "docker_env",
      supported: false,
    });
    const refused = await call("/api/v1/projects/dk/mlproject/runs", {
      body: { entrypoint: "main" },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("unsupported_environment");
  }, 60_000);

  test("command rendering follows mlflow run: typed parameters, shlex quoting, braces, extras", () => {
    expect(shlexQuote("")).toBe("''");
    expect(shlexQuote("a-b_c.d/e:1")).toBe("a-b_c.d/e:1");
    expect(shlexQuote("a b")).toBe("'a b'");
    expect(shlexQuote("it's")).toBe(`'it'"'"'s'`);
    const ep = parseMlproject(
      "entry_points:\n  main:\n    parameters:\n      n: float\n      u: uri\n      s: string\n    command: 'run {{literal}} {n} {u} {s}'\n",
    ).entry_points[0];
    if (!ep) throw new Error("no entrypoint");
    const r = renderCommand(
      ep,
      { n: "1e-3", u: "s3://bucket/x", s: "$(rm -rf /)", extra: "v" },
      "/repo",
    );
    expect(r.command).toBe("run {literal} 1e-3 s3://bucket/x '$(rm -rf /)' --extra v");
    expect(renderCommand(ep, { n: "2", u: "rel/p", s: "" }, "/repo").command).toBe(
      "run {literal} 2 /repo/rel/p ''",
    );
    const broken = parseMlproject("entry_points:\n  main:\n    command: 'x {undeclared}'\n")
      .entry_points[0];
    if (!broken) throw new Error("no entrypoint");
    expect(() => renderCommand(broken, {}, "/repo")).toThrow(/not a declared parameter/);
    expect(parseMlproject("a: [1, 2\n").problems[0]).toContain("YAML");
    expect(parseMlproject("name: x\n").problems).toEqual(["MLproject has no entry_points"]);
  });
});

describe("model metadata parsing", () => {
  test("MLmodel flavors, signature and trust notes", () => {
    const m = parseMlmodel(MLMODEL);
    expect(m.python_version).toBe("3.12.14");
    expect(m.mlflow_version).toBe("3.17.2");
    expect(trustNote(m.flavors).level).toBe("restricted");
    const pickled = parseMlmodel(
      "flavors:\n  sklearn:\n    serialization_format: cloudpickle\n  python_function: {}\n",
    );
    expect(trustNote(pickled.flavors)).toMatchObject({ level: "code" });
    expect(trustNote(parseMlmodel("flavors:\n  pytorch: {}\n").flavors).level).toBe("code");
    expect(parseMlmodel("[").problems[0]).toContain("YAML");
  });
});
