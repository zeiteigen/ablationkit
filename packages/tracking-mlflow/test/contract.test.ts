/**
 * MLflow REST contract (spec §5.5 "Compatibility contract"). The same suite runs against the
 * in-memory fake (always) and against the real pinned sidecar when
 * ABLATIONKIT_MLFLOW_CONTRACT=1 (`bun run test:mlflow`, a CI step). A failure on the real server
 * after bumping the pin in packages/tracking-mlflow/env means the integration needs work before the upgrade.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MlflowClient, MlflowError } from "../src/client.ts";
import { MlflowSidecar, pinnedMlflowVersion } from "../src/sidecar.ts";
import { FakeMlflow } from "../src/testing.ts";

const OPS = resolve(import.meta.dir, "../env");
const REAL = process.env["ABLATIONKIT_MLFLOW_CONTRACT"] === "1";

interface Target {
  url: string;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port ?? 0;
  await s.stop(true);
  return p;
}

function contract(name: string, make: () => Promise<Target>, timeout = 5000): void {
  describe(`MLflow REST contract: ${name}`, () => {
    let t: Target;
    let c: MlflowClient;
    beforeAll(async () => {
      t = await make();
      c = new MlflowClient({ url: t.url, timeoutMs: 15_000 });
    }, 600_000);
    afterAll(() => t?.stop());
    const name = `ak/contract-${Date.now()}`;

    test("health and pinned version", async () => {
      expect(await c.health()).toBe(true);
      expect(await c.version()).toBe(pinnedMlflowVersion(OPS));
    });

    test(
      "experiments: create, get by name, search, rename, tag, delete and restore",
      async () => {
        expect(await c.getExperimentByName(name)).toBeUndefined();
        const id = await c.createExperiment(name, [
          { key: "ablationkit.project_id", value: "contract" },
        ]);
        const e = await c.getExperimentByName(name);
        expect(e?.experiment_id).toBe(id);
        expect(e?.tags).toContainEqual({ key: "ablationkit.project_id", value: "contract" });
        const dup = await c.createExperiment(name).catch((x: unknown) => x);
        expect(dup).toBeInstanceOf(MlflowError);
        expect((dup as MlflowError).kind).toBe("rejected");
        const page = await c.searchExperiments({ max_results: 1 });
        expect(page.items).toHaveLength(1);
        expect(page.next_page_token).toBeDefined();
        await c.renameExperiment(id, `${name}-x`);
        expect((await c.getExperiment(id)).name).toBe(`${name}-x`);
        await c.renameExperiment(id, name);
        await c.setExperimentTag(id, "note", "hi");
        expect((await c.getExperiment(id)).tags).toContainEqual({ key: "note", value: "hi" });
        await c.deleteExperiment(id);
        expect((await c.getExperimentByName(name))?.lifecycle_stage).toBe("deleted");
        const deleted = await c.searchExperiments({ view_type: "DELETED_ONLY" });
        expect(deleted.items.map((x) => x.experiment_id)).toContain(id);
        await c.restoreExperiment(id);
        expect((await c.getExperiment(id)).lifecycle_stage).toBe("active");
        const missing = await c.getExperiment("987654321").catch((x: unknown) => x);
        expect((missing as MlflowError).notFound).toBe(true);
      },
      timeout,
    );

    test(
      "runs: create, search by tag, log-batch idempotency, history, update, tags, delete",
      async () => {
        const exp = (await c.getExperimentByName(name))?.experiment_id as string;
        const run = await c.createRun({
          experiment_id: exp,
          run_name: "att-1",
          start_time: 1_793_660_517_000,
          tags: [{ key: "ablationkit.ref", value: "att-1" }],
        });
        const id = run.info.run_id;
        expect(run.info.status).toBe("RUNNING");
        expect(run.info.artifact_uri).toStartWith("mlflow-artifacts:/");
        const found = await c.searchRuns({
          experiment_ids: [exp],
          filter: "tags.`ablationkit.ref` = 'att-1'",
          run_view_type: "ALL",
        });
        expect(found.items.map((r) => r.info.run_id)).toEqual([id]);
        const none = await c.searchRuns({
          experiment_ids: [exp],
          filter: "tags.`ablationkit.ref` = 'att-2'",
        });
        expect(none.items).toEqual([]);
        const batch = {
          run_id: id,
          metrics: [
            { key: "loss", value: 1.5, timestamp: 1_793_660_517_000, step: 0 },
            { key: "loss", value: 1.2, timestamp: 1_793_660_518_000, step: 1 },
            {
              key: "system/cpu_utilization_percentage",
              value: 40,
              timestamp: 1_793_660_518_000,
              step: 0,
            },
          ],
          params: [{ key: "lr", value: "0.01" }],
          tags: [{ key: "ablationkit.study_id", value: "s1" }],
        };
        await c.logBatch(batch);
        await c.logBatch(batch);
        const hist = await c.getMetricHistory({ run_id: id, metric_key: "loss" });
        expect(hist.items.map((m) => [m.step, m.value])).toEqual([
          [0, 1.5],
          [1, 1.2],
        ]);
        const changed = await c
          .logBatch({ run_id: id, params: [{ key: "lr", value: "0.02" }] })
          .catch((x: unknown) => x);
        expect((changed as MlflowError).kind).toBe("rejected");
        expect((changed as MlflowError).code).toBe("INVALID_PARAMETER_VALUE");
        const got = await c.getRun(id);
        expect(got.data.params).toContainEqual({ key: "lr", value: "0.01" });
        expect(got.data.metrics?.find((m) => m.key === "loss")?.value).toBe(1.2);
        expect(got.data.tags).toContainEqual({ key: "ablationkit.study_id", value: "s1" });
        await c.updateRun({
          run_id: id,
          status: "FINISHED",
          end_time: 1_793_660_600_000,
          run_name: "renamed",
        });
        expect((await c.getRun(id)).info).toMatchObject({
          status: "FINISHED",
          run_name: "renamed",
        });
        await c.setTag(id, "note", "x");
        await c.deleteTag(id, "note");
        expect((await c.getRun(id)).data.tags?.some((t) => t.key === "note")).toBe(false);
        await c.deleteRun(id);
        expect((await c.getRun(id)).info.lifecycle_stage).toBe("deleted");
        expect((await c.searchRuns({ experiment_ids: [exp] })).items).toEqual([]);
        await c.restoreRun(id);
        expect((await c.searchRuns({ experiment_ids: [exp] })).items).toHaveLength(1);
      },
      timeout,
    );

    test(
      "artifacts: upload through the proxy, list, download",
      async () => {
        const exp = (await c.getExperimentByName(name))?.experiment_id as string;
        const run = (await c.createRun({ experiment_id: exp })).info;
        await c.uploadArtifact(run, "sub/notes.txt", "hello");
        const top = await c.listArtifacts(run.run_id);
        expect(top.items).toEqual([{ path: "sub", is_dir: true }]);
        const sub = await c.listArtifacts(run.run_id, "sub");
        expect(sub.items).toEqual([{ path: "sub/notes.txt", is_dir: false, file_size: 5 }]);
        const dl = await c.downloadArtifact(run.run_id, "sub/notes.txt");
        // The UI's previews rely on MLflow's file-name-based content type (the fake mirrors it).
        expect(dl.headers.get("content-type")).toStartWith("text/plain");
        expect(await dl.text()).toBe("hello");
        const missing = await c.downloadArtifact(run.run_id, "nope.txt").catch((x: unknown) => x);
        expect(missing).toBeInstanceOf(MlflowError);
      },
      timeout,
    );

    test(
      "models: logged-model and registry search answer (empty)",
      async () => {
        const exp = (await c.getExperimentByName(name))?.experiment_id as string;
        expect((await c.searchLoggedModels({ experiment_ids: [exp] })).items).toEqual([]);
        expect(Array.isArray((await c.searchRegisteredModels({ max_results: 5 })).items)).toBe(
          true,
        );
      },
      timeout,
    );

    test(
      "datasets: log-inputs shows on the run, and re-logging the same input is a no-op",
      async () => {
        const exp = (await c.getExperimentByName(name))?.experiment_id as string;
        const run = (await c.createRun({ experiment_id: exp })).info;
        const input = {
          tags: [
            { key: "mlflow.data.context", value: "training" },
            { key: "ablationkit.split", value: "train" },
          ],
          dataset: {
            name: "iris",
            digest: "0123abcd",
            source_type: "local",
            source: JSON.stringify({ uri: "data/iris.csv" }),
            schema: JSON.stringify({ mlflow_colspec: [{ type: "double", name: "x" }] }),
            profile: JSON.stringify({ num_rows: 150 }),
          },
        };
        await c.logInputs(run.run_id, [input]);
        await c.logInputs(run.run_id, [input]);
        const got = await c.getRun(run.run_id);
        const inputs = (got.inputs?.["dataset_inputs"] ?? []) as {
          tags: unknown[];
          dataset: Record<string, unknown>;
        }[];
        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.dataset).toMatchObject({ name: "iris", digest: "0123abcd" });
        expect(inputs[0]?.tags).toContainEqual({ key: "ablationkit.split", value: "train" });
        const found = await c.searchRuns({ experiment_ids: [exp], max_results: 50 });
        const same = found.items.find((r) => r.info.run_id === run.run_id);
        expect(same?.inputs?.["dataset_inputs"]).toBeDefined();
      },
      timeout,
    );

    test(
      "logged models: create, upload, list, download, finalize, search by tag and run, outputs",
      async () => {
        const exp = (await c.getExperimentByName(name))?.experiment_id as string;
        const run = (await c.createRun({ experiment_id: exp })).info;
        const m = await c.createLoggedModel({
          experiment_id: exp,
          name: "clf",
          source_run_id: run.run_id,
          tags: [{ key: "ablationkit.model_key", value: "abcdef0123" }],
        });
        expect(m.info.model_id).toStartWith("m-");
        expect(m.info.status).toBe("LOGGED_MODEL_PENDING");
        expect(m.info.artifact_uri).toStartWith("mlflow-artifacts:/");
        await c.uploadProxiedArtifact(m.info.artifact_uri, "MLmodel", "flavors: {}\n");
        await c.uploadProxiedArtifact(m.info.artifact_uri, "sub/w.bin", new Uint8Array([1, 2, 3]));
        const top = await c.listProxiedArtifacts(m.info.artifact_uri);
        expect(top.map((f) => f.path).sort()).toEqual(["MLmodel", "sub"]);
        const sub = await c.listProxiedArtifacts(m.info.artifact_uri, "sub");
        expect(sub).toEqual([{ path: "sub/w.bin", is_dir: false, file_size: 3 }]);
        const dl = await c.downloadProxiedArtifact(m.info.artifact_uri, "MLmodel");
        expect(await dl.text()).toBe("flavors: {}\n");
        const ready = await c.finalizeLoggedModel(m.info.model_id, "LOGGED_MODEL_READY");
        expect(ready.info.status).toBe("LOGGED_MODEL_READY");
        expect((await c.getLoggedModel(m.info.model_id)).info.source_run_id).toBe(run.run_id);
        const byTag = await c.searchLoggedModels({
          experiment_ids: [exp],
          filter: "tags.`ablationkit.model_key` = 'abcdef0123'",
        });
        expect(byTag.items.map((x) => x.info.model_id)).toEqual([m.info.model_id]);
        const byRun = await c.searchLoggedModels({
          experiment_ids: [exp],
          filter: `source_run_id = '${run.run_id}'`,
        });
        expect(byRun.items.map((x) => x.info.model_id)).toEqual([m.info.model_id]);
        await c.logOutputs(run.run_id, [{ model_id: m.info.model_id, step: 0 }]);
        const got = await c.getRun(run.run_id);
        expect(got.outputs?.["model_outputs"]).toEqual([{ model_id: m.info.model_id, step: 0 }]);
        const missing = await c.getLoggedModel("m-0000doesnotexist").catch((x: unknown) => x);
        expect((missing as MlflowError).notFound).toBe(true);
      },
      timeout,
    );

    test(
      "registry: create, version, alias, tags, descriptions, search",
      async () => {
        const exp = (await c.getExperimentByName(name))?.experiment_id as string;
        const run = (await c.createRun({ experiment_id: exp })).info;
        const m = await c.createLoggedModel({
          experiment_id: exp,
          name: "reg",
          source_run_id: run.run_id,
        });
        const reg = `contract-${Date.now()}`;
        await c.createRegisteredModel({
          name: reg,
          description: "first",
          tags: [{ key: "ablationkit.project_id", value: "contract" }],
        });
        const dup = await c.createRegisteredModel({ name: reg }).catch((x: unknown) => x);
        expect((dup as MlflowError).code).toBe("RESOURCE_ALREADY_EXISTS");
        const v1 = await c.createModelVersion({
          name: reg,
          source: `models:/${m.info.model_id}`,
          run_id: run.run_id,
          model_id: m.info.model_id,
          description: "v1",
        });
        expect(v1.version).toBe("1");
        expect(v1.source).toBe(`models:/${m.info.model_id}`);
        const bad = await c
          .createModelVersion({ name: reg, source: `models:/${m.info.model_id}` })
          .catch((x: unknown) => x);
        expect((bad as MlflowError).code).toBe("INVALID_PARAMETER_VALUE");
        const v2 = await c.createModelVersion({
          name: reg,
          source: `models:/${m.info.model_id}`,
          run_id: run.run_id,
          model_id: m.info.model_id,
        });
        expect(v2.version).toBe("2");
        await c.setAlias(reg, "champion", "1");
        expect((await c.getVersionByAlias(reg, "champion")).version).toBe("1");
        await c.setAlias(reg, "champion", "2");
        expect((await c.getVersionByAlias(reg, "champion")).version).toBe("2");
        expect((await c.getModelVersion(reg, "2")).aliases).toEqual(["champion"]);
        await c.setModelVersionTag(reg, "1", "k", "v");
        expect((await c.getModelVersion(reg, "1")).tags).toContainEqual({ key: "k", value: "v" });
        await c.deleteModelVersionTag(reg, "1", "k");
        expect((await c.getModelVersion(reg, "1")).tags ?? []).toEqual([]);
        await c.updateModelVersion(reg, "1", "described");
        expect((await c.getModelVersion(reg, "1")).description).toBe("described");
        await c.updateRegisteredModel(reg, "second");
        await c.setRegisteredModelTag(reg, "a", "b");
        let rm = await c.getRegisteredModel(reg);
        expect(rm.description).toBe("second");
        expect(rm.tags).toContainEqual({ key: "a", value: "b" });
        expect(rm.aliases).toEqual([{ alias: "champion", version: "2" }]);
        await c.deleteRegisteredModelTag(reg, "a");
        await c.deleteAlias(reg, "champion");
        rm = await c.getRegisteredModel(reg);
        expect(rm.aliases ?? []).toEqual([]);
        expect((rm.tags ?? []).map((t) => t.key)).toEqual(["ablationkit.project_id"]);
        const search = await c.searchRegisteredModels({
          filter: "tags.`ablationkit.project_id` = 'contract'",
        });
        expect(search.items.map((x) => x.name)).toContain(reg);
        const versions = await c.searchModelVersions({ filter: `name = '${reg}'` });
        expect(versions.items.map((x) => x.version).sort()).toEqual(["1", "2"]);
        const byRun = await c.searchModelVersions({ filter: `run_id = '${run.run_id}'` });
        expect(byRun.items).toHaveLength(2);
        const noAlias = await c.getVersionByAlias(reg, "champion").catch((x: unknown) => x);
        expect(noAlias).toBeInstanceOf(MlflowError);
      },
      timeout,
    );

    test(
      "traces (v3): start, upload spans, search by tag and status, tag, assess, delete",
      async () => {
        const exp = await c.createExperiment(`${name}-traces`);
        const run = (await c.createRun({ experiment_id: exp })).info;
        const hex = () => crypto.randomUUID().replaceAll("-", "");
        const id = `tr-${hex()}`;
        const info = await c.startTrace({
          trace_id: id,
          trace_location: { type: "MLFLOW_EXPERIMENT", mlflow_experiment: { experiment_id: exp } },
          request_time: new Date().toISOString(),
          execution_duration: "1.250s",
          state: "ERROR",
          trace_metadata: { "mlflow.trace_schema.version": "3", "mlflow.sourceRun": run.run_id },
          tags: { "mlflow.traceName": "answer", "ablationkit.project": "contract" },
        });
        expect(info.tags?.["mlflow.artifactLocation"]).toContain(`/traces/${id}/artifacts`);
        const spans = [
          {
            trace_id: "AAAAAAAAAAAAAAAAAAAAAA==",
            span_id: "AAAAAAAAAAE=",
            parent_span_id: null,
            name: "answer",
            start_time_unix_nano: 1,
            end_time_unix_nano: 1_250_000_001,
            events: [],
            status: { code: "STATUS_CODE_ERROR", message: "boom" },
            attributes: {
              "mlflow.traceRequestId": JSON.stringify(id),
              "mlflow.spanType": '"AGENT"',
            },
          },
        ];
        await c.uploadTraceSpans(info, spans);
        expect(await c.getTraceSpans(id)).toEqual(spans);
        const other = `tr-${hex()}`;
        await c.startTrace({
          trace_id: other,
          trace_location: { type: "MLFLOW_EXPERIMENT", mlflow_experiment: { experiment_id: exp } },
          request_time: new Date(Date.now() - 60_000).toISOString(),
          execution_duration: "0.010s",
          state: "OK",
          tags: { "ablationkit.project": "other" },
        });
        const byTag = await c.searchTraces({
          experiment_ids: [exp],
          filter: "tag.`ablationkit.project` = 'contract'",
        });
        expect(byTag.items.map((t) => t.trace_id)).toEqual([id]);
        const errors = await c.searchTraces({
          experiment_ids: [exp],
          filter: "trace.status = 'ERROR'",
        });
        expect(errors.items.map((t) => t.trace_id)).toEqual([id]);
        const page = await c.searchTraces({ experiment_ids: [exp], max_results: 1 });
        expect(page.items).toHaveLength(1);
        expect(page.next_page_token).toBeDefined();
        await c.setTraceTag(id, "ablationkit.example_id", "e1");
        const a = await c.createAssessment(id, {
          assessment_name: "grounded",
          source: { source_type: "HUMAN", source_id: "tok-1" },
          feedback: { value: false },
          rationale: "no citation",
          metadata: { note: "n" },
        });
        expect(a.assessment_id).toMatch(/^a-/);
        const got = await c.getTraceInfo(id);
        expect(got.tags?.["ablationkit.example_id"]).toBe("e1");
        expect(got.trace_metadata?.["mlflow.sourceRun"]).toBe(run.run_id);
        expect(got.assessments?.map((x) => [x.assessment_name, x.feedback?.value])).toEqual([
          ["grounded", false],
        ]);
        expect(await c.deleteTraces({ experiment_id: exp, trace_ids: [id] })).toBe(1);
        const gone = await c.getTraceInfo(id).catch((x: unknown) => x);
        expect((gone as MlflowError).notFound).toBe(true);
        // Retention: everything older than a cut-off.
        expect(
          await c.deleteTraces({
            experiment_id: exp,
            max_timestamp_millis: Date.now() - 30_000,
            max_traces: 100,
          }),
        ).toBe(1);
      },
      timeout,
    );

    test(
      "prompt registry over the model-registry REST API; GenAI datasets",
      async () => {
        const exp = await c.createExperiment(`${name}-prompts`);
        const prompt = `ak-prompt-${Date.now()}`;
        await c.createRegisteredModel({
          name: prompt,
          tags: [
            { key: "mlflow.prompt.is_prompt", value: "true" },
            { key: "_mlflow_experiment_ids", value: `,${exp},` },
          ],
          description: "v1",
        });
        for (const text of ["Answer: {{question}}", "Answer briefly: {{question}}"])
          await c.createModelVersion({
            name: prompt,
            source: "dummy-source",
            tags: [
              { key: "mlflow.prompt.is_prompt", value: "true" },
              { key: "_mlflow_prompt_type", value: "text" },
              { key: "mlflow.prompt.text", value: text },
            ],
          });
        await c.setAlias(prompt, "champion", "1");
        // Plain registry searches exclude prompts; a prompt-tag filter finds them.
        const plain = await c.searchRegisteredModels({ filter: `name = '${prompt}'` });
        expect(plain.items).toEqual([]);
        const prompts = await c.searchRegisteredModels({
          filter: `tags.\`mlflow.prompt.is_prompt\` = 'true' AND name = '${prompt}'`,
        });
        expect(prompts.items.map((x) => x.name)).toEqual([prompt]);
        const versions = await c.searchModelVersions({
          filter: `name = '${prompt}' AND tags.\`mlflow.prompt.is_prompt\` = 'true'`,
        });
        expect(versions.items.map((v) => v.version).sort()).toEqual(["1", "2"]);
        expect((await c.getVersionByAlias(prompt, "champion")).version).toBe("1");
        const ds = await c.createGenaiDataset({ name: `${prompt}-golden`, experiment_ids: [exp] });
        expect(ds.dataset_id).toMatch(/^d-/);
        expect(
          await c.upsertGenaiDatasetRecords(ds.dataset_id, [
            { inputs: { question: "a" }, expectations: { expected_response: "b" } },
          ]),
        ).toBe(1);
      },
      timeout,
    );
  });
}

contract("fake", async () => {
  const f = new FakeMlflow().start();
  return { url: f.url, stop: () => f.stop() };
});

// A running pinned server (for iterating locally); CI always starts its own sidecar.
const URL_OVERRIDE = process.env["ABLATIONKIT_MLFLOW_CONTRACT_URL"];
if (URL_OVERRIDE)
  contract(
    `real MLflow at ${URL_OVERRIDE}`,
    async () => ({ url: URL_OVERRIDE, stop: async () => {} }),
    30_000,
  );

if (REAL) {
  contract(
    `real MLflow ${pinnedMlflowVersion(OPS)}`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "ak-mlflow-contract-"));
      const sc = new MlflowSidecar({
        opsDir: OPS,
        dataDir: join(dir, "mlflow"),
        port: await freePort(),
        preUpgradeBackup: async () => "none",
        log: (l) => console.error(l),
      });
      await sc.start();
      if (sc.status().state !== "healthy")
        throw new Error(`sidecar: ${JSON.stringify(sc.status())}`);
      return {
        url: sc.url,
        stop: async () => {
          await sc.stop();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
    30_000,
  );
}
