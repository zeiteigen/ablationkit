/**
 * Research inference against the fake MLflow and the fake bridge (criteria 9, 9a, 9b, 9e; ADR
 * 0020): one-shot prediction with signature validation and separate load/predict timings, aligned
 * comparisons, sessions (repeat, idle expiry, stop, crash, restart), explicit save-to-evidence with
 * provenance and deletion, privacy of unsaved exploration, and restarts. The real Python bridge,
 * real models and real MLflow run in inference-e2e.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CoordinatorSettings, DeploymentRecord } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { alignComparison } from "../src/models/inference.ts";
import { Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
const FAKE_BRIDGE = resolve(import.meta.dir, "fake-bridge.ts");

afterEach(async () => {
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

const mlmodel = (
  opts: { format?: string; inputs?: string; outputs?: string; noSig?: boolean } = {},
) => `artifact_path: model
flavors:
  python_function:
    loader_module: mlflow.sklearn
    model_path: model.skops
    python_version: 3.12.14
  sklearn:
    pickled_model: model.skops
    serialization_format: ${opts.format ?? "skops"}
    sklearn_version: 1.9.1
mlflow_version: 3.17.2
${
  opts.noSig
    ? ""
    : `signature:
  inputs: '${opts.inputs ?? '[{"type": "double", "name": "x1", "required": true}, {"type": "double", "name": "x2", "required": true}]'}'
  outputs: '${opts.outputs ?? '[{"type": "long", "required": true}]'}'
  params: null
`
}`;

async function setup(opts: { home?: string; fake?: FakeMlflow; bridgeConfig?: string } = {}) {
  const fake = opts.fake ?? new FakeMlflow().start();
  if (!opts.fake) fakes.push(fake);
  const bridgeConfig = opts.bridgeConfig ?? join(h.tmp("ak-bridge-"), "config.json");
  if (!opts.bridgeConfig) writeFileSync(bridgeConfig, "{}");
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    settings: SETTINGS,
    bridgeCommand: [process.execPath, FAKE_BRIDGE, bridgeConfig],
    inferenceSweepMs: 100,
    ...(opts.home ? { home: opts.home } : {}),
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  const svc = () => (h.coordinators.at(-1) as (typeof h.coordinators)[number]).services;
  const config = (c: Json) => writeFileSync(bridgeConfig, JSON.stringify(c));
  return { fake, cl, call, svc, config, bridgeConfig };
}
type World = Awaited<ReturnType<typeof setup>>;

async function project(w: World, id: string): Promise<string> {
  const path = h.repo(id);
  mkdirSync(join(path, "data"));
  writeFileSync(
    join(path, "data", "test.csv"),
    "x1,x2,y\n0.1,0.2,0\n0.9,0.8,1\n0.5,0.5,1\n0.2,0.3,0\n",
  );
  expect((await w.call("/api/v1/projects", { body: { path, project_id: id } })).status).toBe(201);
  return path;
}

/** A ready logged model in the project's experiment, with this MLmodel. */
async function seedModel(w: World, pid: string, name: string, text = mlmodel()): Promise<string> {
  const s = w.svc();
  const exp = await s.tracking.ensureExperimentNow(pid);
  const c = s.tracking.client;
  const run = await c.createRun({ experiment_id: exp, run_name: `train ${name}` });
  const m = await c.createLoggedModel({ experiment_id: exp, name, source_run_id: run.info.run_id });
  await c.uploadProxiedArtifact(m.info.artifact_uri, "MLmodel", text);
  await c.finalizeLoggedModel(m.info.model_id, "LOGGED_MODEL_READY");
  return m.info.model_id;
}

const runCount = (w: World) => w.fake.allRuns().length;
const auditText = (w: World) => {
  const d = w.svc().paths.auditDir;
  return readdirSync(d)
    .map((f) => readFileSync(join(d, f), "utf8"))
    .join("");
};

describe("one-shot prediction (criterion 9)", () => {
  test("a pinned model predicts once in a worker that exits; inputs are validated; load and predict times are separate; nothing is persisted", async () => {
    const w = await setup();
    await project(w, "p");
    const m1 = await seedModel(w, "p", "clf");
    w.config({ predictions: { [m1]: [1, 0] } });
    // Registry pin: an alias resolves to the version and model ID now.
    expect(
      (await w.call("/api/v1/projects/p/registry", { body: { name: "clf-reg" } })).status,
    ).toBe(201);
    expect(
      (await w.call("/api/v1/projects/p/registry/clf-reg/versions", { body: { model_id: m1 } }))
        .status,
    ).toBe(201);
    await w.call("/api/v1/projects/p/registry/clf-reg/aliases/champion", {
      method: "PUT",
      body: { version: "1" },
    });

    const d = (await w.call("/api/v1/projects/p/inference/describe?name=clf-reg&alias=champion"))
      .body;
    expect(d.model).toEqual({
      model_id: m1,
      registered_name: "clf-reg",
      version: "1",
      alias: "champion",
    });
    expect(d.adapter).toMatchObject({ task: "tabular", output: "classification" });
    expect(d.adapter.columns.map((c: Json) => c.name)).toEqual(["x1", "x2"]);
    expect(d.trust.level).toBe("restricted");

    const runsBefore = runCount(w);
    const inputs = {
      records: [
        { x1: 0.1, x2: 0.2 },
        { x1: 0.9, x2: 0.8 },
      ],
    };
    const r = await w.call("/api/v1/projects/p/inference/predict", {
      body: { model: { name: "clf-reg", alias: "champion" }, inputs },
    });
    expect(r.status).toBe(200);
    const res = r.body.result;
    expect(res).toMatchObject({ kind: "prediction", via: "one_shot", task: "tabular", rows: 2 });
    expect(res.models[0]).toMatchObject({
      status: "ok",
      outputs: [1, 0],
      model: { model_id: m1, registered_name: "clf-reg", version: "1", alias: "champion" },
    });
    expect(res.models[0].probabilities[0]).toEqual([{ label: 1, p: 0.9 }]);
    const t = res.models[0].timings;
    expect(t.load_ms).toBe(20);
    expect(t.predict_ms).toBe(1.5);
    expect(t.worker_ms).toBeGreaterThan(0);
    expect(res.input_sha256).toHaveLength(64);
    expect(res.expires_at > res.created_at).toBe(true);

    // Privacy (9e): no MLflow run, no worker directory left, nothing in the audit but counts.
    expect(runCount(w)).toBe(runsBefore);
    const ops = w.svc().paths.operationsDir;
    expect(existsSync(ops) ? readdirSync(ops).filter((x) => x.startsWith("inf-")) : []).toEqual([]);
    const audit = auditText(w);
    expect(audit).toContain('"inference.predict"');
    expect(audit).not.toContain("0.9,");
    expect(audit).not.toContain('"x1"');

    // The result is readable for an hour, from memory.
    expect(
      (await w.call(`/api/v1/projects/p/inference/results/${res.result_id}`)).body.result.result_id,
    ).toBe(res.result_id);

    // Validation happens before any worker starts: unknown, missing and mistyped fields.
    const bad = await w.call("/api/v1/projects/p/inference/predict", {
      body: { model: { model_id: m1 }, inputs: { records: [{ x1: "a", x3: 1 }] } },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("invalid_input");
    expect(bad.body.error.issues).toEqual([
      { row: 0, field: "x3", message: "is not an input of this model" },
      { row: 0, field: "x1", message: "must be a finite number (double)" },
      { row: 0, field: "x2", message: "is required (double)" },
    ]);

    // A worker-side schema error is a structured result, not a crash.
    w.config({ predict_fail: true });
    const se = (
      await w.call("/api/v1/projects/p/inference/predict", {
        body: { model: { model_id: m1 }, inputs },
      })
    ).body.result;
    expect(se.models[0]).toMatchObject({ status: "error", error: { code: "schema_mismatch" } });
    expect(se.models[0].timings.load_ms).toBe(20);
  });

  test("unsupported models and models that run code on load are refused with the reason", async () => {
    const w = await setup();
    await project(w, "u");
    const noSig = await seedModel(w, "u", "nosig", mlmodel({ noSig: true }));
    const pickled = await seedModel(w, "u", "pickled", mlmodel({ format: "cloudpickle" }));
    const inputs = { records: [{ x1: 1, x2: 2 }] };
    const a = await w.call("/api/v1/projects/u/inference/predict", {
      body: { model: { model_id: noSig }, inputs },
    });
    expect(a.status).toBe(422);
    expect(a.body.error).toMatchObject({ code: "unsupported_model", reason: "no_signature" });
    expect(a.body.error.message).toContain("infer_signature");
    const b = await w.call("/api/v1/projects/u/inference/predict", {
      body: { model: { model_id: pickled }, inputs },
    });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("trust_acknowledgement_required");
    expect(b.body.error.trust.level).toBe("code");
    const c = await w.call("/api/v1/projects/u/inference/predict", {
      body: { model: { model_id: pickled }, inputs, acknowledge_trust: true },
    });
    expect(c.status).toBe(200);
    // Another project's model is not reachable.
    await project(w, "other");
    expect(
      (
        await w.call("/api/v1/projects/other/inference/predict", {
          body: { model: { model_id: pickled }, inputs, acknowledge_trust: true },
        })
      ).status,
    ).toBe(404);
  });
});

describe("model comparison and evidence (criteria 9b, 9e)", () => {
  test("two pinned models on identical examples: aligned, disagreements, correctness, paired test; saved with provenance in MLflow; deletable", async () => {
    const w = await setup();
    await project(w, "c");
    const a = await seedModel(w, "c", "a");
    const b = await seedModel(w, "c", "b");
    w.config({ predictions: { [a]: [0, 1, 1, 0], [b]: [0, 0, 1, 1] } });

    // Incompatible schemas are refused before anything runs.
    const other = await seedModel(
      w,
      "c",
      "wide",
      mlmodel({ inputs: '[{"type": "double", "name": "x1"}, {"type": "string", "name": "x2"}]' }),
    );
    const inc = await w.call("/api/v1/projects/c/inference/compare", {
      body: {
        models: [{ model_id: a }, { model_id: other }],
        inputs: { records: [{ x1: 1, x2: 2 }] },
      },
    });
    expect(inc.status).toBe(422);
    expect(inc.body.error.code).toBe("incompatible_schemas");
    expect(inc.body.error.pairs[0].reasons).toEqual(["column x2 is double vs string"]);

    // A dataset slice from the checkout, with its target column.
    const r = await w.call("/api/v1/projects/c/inference/compare", {
      body: {
        models: [{ model_id: a }, { model_id: b }],
        dataset: { path: "data/test.csv", targets: "y", offset: 0, limit: 4, split: "test" },
      },
    });
    expect(r.status).toBe(200);
    const res = r.body.result;
    expect(res.kind).toBe("comparison");
    expect(res.dataset).toMatchObject({
      path: "data/test.csv",
      offset: 0,
      limit: 4,
      targets: "y",
      split: "test",
    });
    expect(res.dataset.sha256).toHaveLength(64);
    expect(res.input_rows[0]).toEqual({ x1: 0.1, x2: 0.2 });
    const cmp = res.comparison;
    expect(cmp).toMatchObject({ paired: true, rows: 4, disagreements: 2, has_targets: true });
    expect(cmp.examples[1]).toEqual({
      index: 1,
      predictions: [1, 0],
      agree: false,
      target: 1,
      correct: [true, false],
    });
    expect(cmp.summary.map((s: Json) => s.correct)).toEqual([4, 2]);
    expect(cmp.summary[0].metric_direction).toBe("higher is better");
    expect(cmp.paired_test).toMatchObject({ only_first_correct: 2, only_second_correct: 0 });
    expect(cmp.paired_test.method).toContain("McNemar");
    expect(cmp.paired_test.p_value).toBeCloseTo(0.5, 9);

    // Explicit save: an inference_evidence MLflow run with one artifact, a record, a research link.
    const note = (
      await w.call("/api/v1/projects/c/research", {
        body: { kind: "note", title: "A beats B on the test slice", body: "see comparison" },
      })
    ).body.record;
    const runsBefore = runCount(w);
    const sv = await w.call(`/api/v1/projects/c/inference/results/${res.result_id}/save`, {
      body: { note: "A vs B", link: { kind: "note", id: note.record_id } },
    });
    expect(sv.status).toBe(201);
    const ev = sv.body.evidence;
    expect(runCount(w)).toBe(runsBefore + 1);
    expect(ev).toMatchObject({
      kind: "comparison",
      rows: 4,
      task: "tabular",
      dataset: { path: "data/test.csv", targets: "y" },
      artifact_path: "ablationkit/inference/evidence.json",
      environment: { kind: "managed", bridge_version: 1 },
    });
    expect(ev.models.map((m: Json) => m.model_id)).toEqual([a, b]);
    expect(ev.models[0].source_run_id).toBeDefined();
    expect(ev.stored).toEqual([
      "input_rows",
      "outputs",
      "probabilities",
      "targets",
      "comparison",
      "timings",
      "provenance",
    ]);
    const run = w.fake.run(ev.mlflow_run_id);
    const tags = Object.fromEntries(run?.tags ?? []);
    expect(tags).toMatchObject({
      "ablationkit.kind": "inference_evidence",
      "ablationkit.evidence_id": ev.evidence_id,
      "ablationkit.model_ids": `${a},${b}`,
      "ablationkit.dataset_sha256": res.dataset.sha256,
    });
    expect(run?.info.status).toBe("FINISHED");
    const view = (await w.call(`/api/v1/projects/c/inference/evidence/${ev.evidence_id}`)).body;
    expect(view.document.provenance).toMatchObject({
      evidence_id: ev.evidence_id,
      input_sha256: res.input_sha256,
    });
    expect(view.document.comparison.examples).toHaveLength(4);
    expect(view.document.targets).toEqual([0, 1, 1, 0]);
    // Saving twice is refused; the research note links the evidence; lineage shows it.
    expect(
      (await w.call(`/api/v1/projects/c/inference/results/${res.result_id}/save`, { body: {} }))
        .status,
    ).toBe(409);
    const linked = (await w.call(`/api/v1/projects/c/research/${note.record_id}`)).body.record;
    expect(linked.links).toContainEqual(
      expect.objectContaining({ kind: "inference_evidence", id: ev.evidence_id }),
    );
    const lin = (await w.call(`/api/v1/projects/c/lineage?kind=logged_model&id=${a}`)).body;
    const inf = lin.steps.find((s: Json) => s.step === "inference");
    expect(inf.status).toBe("linked");
    expect(inf.items[0]).toMatchObject({
      ref: { kind: "inference_evidence", id: ev.evidence_id },
      status: "saved comparison",
    });
    const fromEv = (
      await w.call(`/api/v1/projects/c/lineage?kind=inference_evidence&id=${ev.evidence_id}`)
    ).body;
    expect(
      fromEv.steps
        .find((s: Json) => s.step === "logged_model")
        .items.map((i: Json) => i.ref.id)
        .sort(),
    ).toEqual([a, b].sort());

    // Deletion removes the MLflow run and keeps a tombstone.
    const del = await w.call(`/api/v1/projects/c/inference/evidence/${ev.evidence_id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(del.body.evidence.deleted_at).toBeDefined();
    expect(w.fake.run(ev.mlflow_run_id)?.info.lifecycle_stage).toBe("deleted");
    expect((await w.call("/api/v1/projects/c/inference/evidence")).body.evidence).toEqual([]);
    expect(
      (await w.call("/api/v1/projects/c/inference/evidence?deleted=1")).body.evidence,
    ).toHaveLength(1);
  });

  test("alignment math: regression has no significance test, failures align nothing", () => {
    const m = (outputs: unknown[]) => ({
      model: { model_id: "m-a" },
      status: "ok" as const,
      outputs,
      timings: {},
    });
    const reg = alignComparison([m([1.0, 2.0]), m([1.0, 2.5])], [1.0, 2.0], "regression", 10);
    expect(reg).toMatchObject({ paired: true, rows: 2, disagreements: 1 });
    expect((reg["examples"] as Json[])[1]).toMatchObject({ index: 11, abs_errors: [0, 0.5] });
    expect((reg["paired_test"] as Json).note).toContain("only for two classifiers");
    const failed = alignComparison(
      [m([1]), { model: { model_id: "m-b" }, status: "error" as const, timings: {} }],
      undefined,
      "classification",
      0,
    );
    expect(failed).toMatchObject({ paired: false, rows: 0, failed: ["m-b"] });
  });
});

describe("interactive sessions (criterion 9a)", () => {
  test("a warm session answers repeated predictions from one process, reports readiness, memory and logs, and stops on request", async () => {
    const w = await setup();
    await project(w, "s");
    const m = await seedModel(w, "s", "warm");
    w.config({ predictions: { [m]: [7] } });
    const st = await w.call("/api/v1/projects/s/inference/sessions", {
      body: { model: { model_id: m }, wait: true, idle_timeout_sec: 600, memory_mb: 512 },
    });
    expect(st.status).toBe(201);
    const s = st.body.session;
    expect(s).toMatchObject({ state: "ready", task: "tabular", restarts: 0 });
    expect(s.timings.load_ms).toBe(13);
    expect(s.pid).toBeGreaterThan(0);
    expect(s.limits).toMatchObject({ idle_timeout_sec: 600, memory_mb: 512, max_queue: 4 });
    expect(s.transitions.map((t: Json) => t.state)).toEqual(["starting", "ready"]);
    const sid = s.session_id;
    for (let i = 0; i < 3; i++) {
      const p = await w.call(`/api/v1/projects/s/inference/sessions/${sid}/predict`, {
        body: { inputs: { records: [{ x1: i, x2: 1 }] } },
      });
      expect(p.status).toBe(200);
      expect(p.body.result).toMatchObject({ via: "session", session_id: sid });
      expect(p.body.result.models[0]).toMatchObject({ status: "ok", outputs: [7] });
      expect(p.body.result.models[0].timings.round_trip_ms).toBeGreaterThan(0);
    }
    const bad = await w.call(`/api/v1/projects/s/inference/sessions/${sid}/predict`, {
      body: { inputs: { records: [{ nope: 1 }] } },
    });
    expect(bad.status).toBe(422);
    await Bun.sleep(3100);
    const v = (await w.call(`/api/v1/projects/s/inference/sessions/${sid}`)).body;
    expect(v.session.pid).toBe(s.pid); // no reload: the same process
    expect(v.session.counters).toMatchObject({ requests: 3, errors: 0, rejected: 1 });
    expect(v.session.memory.rss_bytes).toBe(2_000_000);
    expect(v.adapter.task).toBe("tabular");
    expect(
      await (
        await w.cl.human(`/api/v1/projects/s/inference/sessions/${sid}/log`, {
          token: await w.cl.session(),
        })
      ).text(),
    ).toContain("fake session ready");
    // The agent listener reads sessions but cannot start or drive them.
    const stop = await w.call(`/api/v1/projects/s/inference/sessions/${sid}/stop`, { body: {} });
    expect(stop.body.session).toMatchObject({
      state: "stopped",
      end_reason: "stopped by the researcher",
    });
    expect(stop.body.session.transitions.map((t: Json) => t.state)).toEqual([
      "starting",
      "ready",
      "stopping",
      "stopped",
    ]);
    const after = await w.call(`/api/v1/projects/s/inference/sessions/${sid}/predict`, {
      body: { inputs: { records: [{ x1: 1, x2: 1 }] } },
    });
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe("session_not_ready");
  }, 30_000);

  test("idle expiry, crash cleanup, failed loads and restart", async () => {
    const w = await setup();
    await project(w, "e");
    const textModel = await seedModel(
      w,
      "e",
      "txt",
      mlmodel({
        inputs: '[{"type": "string", "name": "text", "required": true}]',
        outputs: '[{"type": "string"}]',
      }),
    );
    w.config({ predictions: { [textModel]: ["pos"] } });
    const start = async (body: Json = {}) =>
      (
        await w.call("/api/v1/projects/e/inference/sessions", {
          body: { model: { model_id: textModel }, wait: true, ...body },
        })
      ).body.session;

    // Idle expiry.
    const idle = await start({ idle_timeout_sec: 2 });
    expect(idle.state).toBe("ready");
    const expired = await until(async () => {
      const s = (await w.call(`/api/v1/projects/e/inference/sessions/${idle.session_id}`)).body
        .session;
      return s.state === "expired" ? s : undefined;
    }, 10_000);
    expect(expired.end_reason).toContain("idle timeout");

    // Crash: the worker dies mid-request; the request gets a structured error, the state is honest.
    const s = await start();
    const crash = await w.call(`/api/v1/projects/e/inference/sessions/${s.session_id}/predict`, {
      body: { inputs: { records: [{ text: "crash" }] } },
    });
    expect(crash.status).toBe(200);
    expect(crash.body.result.models[0].error.code).toBe("session_crashed");
    const crashed = await until(async () => {
      const r = (await w.call(`/api/v1/projects/e/inference/sessions/${s.session_id}`)).body
        .session;
      return r.state === "crashed" ? r : undefined;
    });
    expect(crashed.end_reason).toContain("SIGKILL");
    expect(() => process.kill(s.pid, 0)).toThrow();
    const audit = auditText(w);
    expect(audit).toContain('"inference.session.crashed"');

    // Restart: a fresh worker for the same pinned model.
    const re = await w.call(`/api/v1/projects/e/inference/sessions/${s.session_id}/restart`, {
      body: {},
    });
    expect(re.status).toBe(202);
    const back = await until(async () => {
      const r = (await w.call(`/api/v1/projects/e/inference/sessions/${s.session_id}`)).body
        .session;
      return r.state === "ready" ? r : undefined;
    });
    expect(back.restarts).toBe(1);
    expect(back.pid).not.toBe(s.pid);
    const ok = await w.call(`/api/v1/projects/e/inference/sessions/${s.session_id}/predict`, {
      body: { inputs: { records: [{ text: "fine" }] } },
    });
    expect(ok.body.result.models[0].outputs).toEqual(["pos"]);

    // A model that never loads ends failed, with the reason.
    w.config({ load_fail: true });
    const failed = await start();
    expect(failed).toMatchObject({ state: "failed" });
    expect(failed.end_reason).toContain("cannot load model");
  }, 40_000);

  test("a local preview deployment starts a session through the launcher; other kinds are refused", async () => {
    const w = await setup();
    await project(w, "d");
    const m = await seedModel(w, "d", "dep");
    await w.call("/api/v1/projects/d/registry", { body: { name: "dep-reg" } });
    await w.call("/api/v1/projects/d/registry/dep-reg/versions", { body: { model_id: m } });
    const launcher = w.svc().inference.launcher();
    const d = {
      deployment_id: "dep-20261103-abcd1234",
      project_id: "d",
      kind: "preview_local",
      exposure: "loopback",
      model_uri: "models:/dep-reg/1",
      ttl_minutes: 5,
    } as DeploymentRecord;
    const out = await launcher.start(d);
    expect(out.endpoint).toMatch(/^ablationkit:inference-session\/is-/);
    const s = w.svc().inference.sessions.byDeployment(d.deployment_id);
    expect(s).toMatchObject({
      state: "ready",
      deployment_id: d.deployment_id,
      requested_by: { kind: "system" },
    });
    expect(s?.limits.idle_timeout_sec).toBe(300);
    await launcher.stop(d);
    expect(w.svc().inference.sessions.byDeployment(d.deployment_id)?.state).toBe("stopped");
    await expect(launcher.start({ ...d, kind: "persistent", exposure: "public" })).rejects.toThrow(
      "Stage 16",
    );
  }, 30_000);
});

describe("restart and shutdown (criterion 9e)", () => {
  test("shutdown stops local sessions; a restart finds nothing alive and forgets unsaved results; saved evidence stays", async () => {
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const home = h.tmp("ak-inf-home-");
    const cfg = join(h.tmp("ak-bridge-"), "config.json");
    writeFileSync(cfg, "{}");
    const w = await setup({ home, fake, bridgeConfig: cfg });
    await project(w, "r");
    const m = await seedModel(w, "r", "r");
    const s = (
      await w.call("/api/v1/projects/r/inference/sessions", {
        body: { model: { model_id: m }, wait: true },
      })
    ).body.session;
    const inputs = { records: [{ x1: 1, x2: 2 }] };
    const one = (
      await w.call("/api/v1/projects/r/inference/predict", {
        body: { model: { model_id: m }, inputs },
      })
    ).body.result;
    const two = (
      await w.call("/api/v1/projects/r/inference/predict", {
        body: { model: { model_id: m }, inputs },
      })
    ).body.result;
    const ev = (
      await w.call(`/api/v1/projects/r/inference/results/${one.result_id}/save`, {
        body: { title: "kept" },
      })
    ).body.evidence;

    // A hard stop: simulate a crash by leaving a "ready" record behind for the next start.
    const c = h.coordinators.at(-1) as (typeof h.coordinators)[number];
    await c.stop();
    expect(() => process.kill(s.pid, 0)).toThrow();
    const file = join(
      c.services.paths.stateDir,
      "r",
      "inference",
      "sessions",
      `${s.session_id}.json`,
    );
    const rec = JSON.parse(readFileSync(file, "utf8"));
    expect(rec).toMatchObject({ state: "stopped", end_reason: "the coordinator shut down" });
    writeFileSync(
      file,
      JSON.stringify({ ...rec, state: "ready", end_reason: undefined, ended_at: undefined }),
    );

    const w2 = await setup({ home, fake, bridgeConfig: cfg });
    const after = (await w2.call(`/api/v1/projects/r/inference/sessions/${s.session_id}`)).body
      .session;
    expect(after.state).toBe("stopped");
    expect(after.end_reason).toContain("do not survive a restart");
    const gone = await w2.call(`/api/v1/projects/r/inference/results/${two.result_id}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe("result_expired");
    expect(
      (await w2.call(`/api/v1/projects/r/inference/evidence/${ev.evidence_id}`)).body.evidence
        .title,
    ).toBe("kept");
  }, 30_000);
});

describe("tracked batch evaluation (criterion 9c)", () => {
  test("a fixed-dataset evaluation of a candidate against a baseline records paired example-level results in MLflow", async () => {
    const w = await setup();
    await project(w, "b");
    const cand = await seedModel(w, "b", "cand");
    const base = await seedModel(w, "b", "base");
    const r = await w.call("/api/v1/projects/b/evaluations", {
      body: {
        model_type: "classifier",
        model: { model_id: cand },
        baseline: { model_id: base },
        dataset: { path: "data/test.csv", targets: "y", split: "test" },
      },
    });
    expect(r.status).toBe(202);
    expect(r.body.evaluation.examples_requested).toBe(true);
    const id = r.body.evaluation.evaluation_id;
    const done = await until(async () => {
      const v = (await w.call(`/api/v1/projects/b/evaluations/${id}`)).body;
      return v.evaluation.state === "succeeded" ? v : undefined;
    });
    expect(done.evaluation.examples).toMatchObject({ paired: true, rows: 2, disagreements: 2 });
    expect(done.evaluation.examples.paired_test.method).toContain("McNemar");
    expect(done.evaluation.dataset.sha256).toHaveLength(64);
    // Canonical copy in MLflow: the candidate run's ablationkit/examples.json.
    const ex = (await w.call(`/api/v1/projects/b/evaluations/${id}/examples`)).body;
    expect(ex.summary.rows).toBe(2);
    expect(ex.rows[0]).toEqual({ row: 1, target: 1, candidate: 0, baseline: 1 });
    // Opting out records no examples.
    const plain = await w.call("/api/v1/projects/b/evaluations", {
      body: {
        model_type: "classifier",
        model: { model_id: cand },
        dataset: { path: "data/test.csv", targets: "y" },
        examples: false,
      },
    });
    const pid2 = plain.body.evaluation.evaluation_id;
    await until(
      async () =>
        (await w.call(`/api/v1/projects/b/evaluations/${pid2}`)).body.evaluation.state ===
        "succeeded",
    );
    expect((await w.call(`/api/v1/projects/b/evaluations/${pid2}/examples`)).status).toBe(404);
  });
});
