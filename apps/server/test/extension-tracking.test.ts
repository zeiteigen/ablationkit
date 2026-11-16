import { describe, expect, test } from "bun:test";
import {
  MlflowClient,
  MlflowError,
  type MlflowRun,
  type MlflowTraceInfo,
} from "@ablationkit/tracking-mlflow";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { callExtensionTracking, type ExtensionTrackingScope } from "../src/extensions/tracking.ts";
import { HttpError } from "../src/http.ts";

type Stub = (...args: unknown[]) => unknown;
function setup(methods: Record<string, Stub> = {}, writable = true) {
  const calls: { method: string; args: unknown[] }[] = [];
  const client = new MlflowClient({
    url: "http://unused.invalid",
    fetch: Object.assign(
      async () => {
        throw new Error("Unexpected network access");
      },
      { preconnect: () => {} },
    ),
  });
  for (const [method, fn] of Object.entries(methods))
    Reflect.set(client, method, async (...args: unknown[]) => {
      calls.push({ method, args });
      return fn(...args);
    });
  const scope: ExtensionTrackingScope = {
    client,
    projectId: "project-a",
    experimentIds: () => ["owned", "linked"],
    ensureExperiment: async () => "owned",
    writable,
  };
  return {
    calls,
    scope,
    call: (method: string, ...args: unknown[]) => callExtensionTracking(scope, method, args),
  };
}
function run(id = "run", experiment = "owned"): MlflowRun {
  return {
    info: {
      run_id: id,
      experiment_id: experiment,
      status: "RUNNING",
      lifecycle_stage: "active",
      artifact_uri: "mlflow-artifacts:/owned/run/artifacts",
    },
    data: {},
  };
}
function trace(id = "trace", experiment = "owned"): MlflowTraceInfo {
  return {
    trace_id: id,
    request_time: "2026-01-01T00:00:00Z",
    state: "OK",
    trace_location: { type: "MLFLOW_EXPERIMENT", mlflow_experiment: { experiment_id: experiment } },
    tags: { "mlflow.artifactLocation": "mlflow-artifacts:/owned/trace/artifacts" },
  };
}
async function denied(promise: Promise<unknown>, code = "extension_tracking_scope") {
  try {
    await promise;
    throw new Error("Expected denial");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(403);
    expect((error as HttpError).code).toBe(code);
  }
}

describe("managed extension MLflow scope", () => {
  test("fake dataset GET retains ownership metadata for scoped record upserts", async () => {
    const fake = new FakeMlflow().start();
    try {
      const client = new MlflowClient({ url: fake.url });
      const owned = await client.createExperiment("owned");
      const foreign = await client.createExperiment("foreign");
      const scope: ExtensionTrackingScope = {
        client,
        projectId: "project-a",
        experimentIds: () => [owned],
        ensureExperiment: async () => owned,
        writable: true,
      };
      const created = (await callExtensionTracking(scope, "createGenaiDataset", [
        { name: "golden", experiment_ids: [owned], tags: { custom: "retained" } },
      ])) as { dataset_id: string };
      const fetched = (await callExtensionTracking(scope, "getGenaiDataset", [
        created.dataset_id,
      ])) as { experiment_ids: string[]; tags: string };
      expect(fetched.experiment_ids).toEqual([owned]);
      expect(JSON.parse(fetched.tags)).toEqual({
        custom: "retained",
        "ablationkit.project": "project-a",
      });
      const records = [{ inputs: { question: "hello" } }];
      expect(
        await callExtensionTracking(scope, "upsertGenaiDatasetRecords", [
          created.dataset_id,
          records,
        ]),
      ).toBe(1);
      expect(fake.datasetRecords(created.dataset_id)).toEqual(records);
      const other = await client.createGenaiDataset({
        name: "foreign",
        experiment_ids: [foreign],
      });
      await denied(callExtensionTracking(scope, "getGenaiDataset", [other.dataset_id]));
      await denied(
        callExtensionTracking(scope, "upsertGenaiDatasetRecords", [other.dataset_id, records]),
      );
      expect(fake.datasetRecords(other.dataset_id)).toEqual([]);
      await expect(
        callExtensionTracking(scope, "getGenaiDataset", ["d-0000"]),
      ).rejects.toBeInstanceOf(MlflowError);
    } finally {
      await fake.stop();
    }
  });

  test("unknown and raw methods are denied; read-only writes stop before client calls", async () => {
    const { call, calls } = setup({}, false);
    for (const method of [
      "raw",
      "constructor",
      "createExperiment",
      "downloadProxiedArtifact",
      "notAMethod",
    ])
      await denied(call(method), "extension_tracking_method");
    for (const method of [
      "createRun",
      "updateRun",
      "deleteRun",
      "uploadArtifact",
      "createRegisteredModel",
      "createModelVersion",
      "setAlias",
      "deleteAlias",
      "startTrace",
      "uploadTraceSpans",
      "setTraceTag",
      "createAssessment",
      "deleteTraces",
      "createGenaiDataset",
      "upsertGenaiDatasetRecords",
    ])
      await denied(call(method), "extension_tracking_read_only");
    expect(calls).toEqual([]);
  });

  test("run reads, changes and artifacts recheck authoritative experiment ownership", async () => {
    const { call, calls } = setup({
      getRun: () => run("foreign", "other"),
      updateRun: () => {},
      deleteRun: () => {},
      listArtifacts: () => ({}),
      downloadArtifact: () => new Response("secret"),
      uploadArtifact: () => {},
    });
    await denied(call("getRun", "foreign"));
    await denied(call("updateRun", { run_id: "foreign" }));
    await denied(call("deleteRun", "foreign"));
    await denied(call("listArtifacts", "foreign"));
    await denied(call("downloadArtifact", "foreign", "data.json"));
    await denied(
      call(
        "uploadArtifact",
        { ...run().info, run_id: "foreign", experiment_id: "owned" },
        "data.json",
        "bad",
      ),
    );
    expect(calls.every((c) => c.method === "getRun")).toBe(true);
  });

  test("owned artifact uploads use server run info and preserve binary and streaming responses", async () => {
    const canonical = run();
    const response = new Response(new Uint8Array([4, 5]));
    const bytes = new Uint8Array([1, 2, 3]);
    const { call, calls } = setup({
      getRun: () => canonical,
      uploadArtifact: () => {},
      downloadArtifact: () => response,
    });
    await call(
      "uploadArtifact",
      { ...canonical.info, artifact_uri: "mlflow-artifacts:/foreign/artifacts" },
      "folder/data.bin",
      bytes,
    );
    expect(calls[1]?.args[0]).toBe(canonical.info);
    expect(calls[1]?.args[2]).toBe(bytes);
    expect(await call("downloadArtifact", "run", "folder/data.bin")).toBe(response);
    for (const path of [
      "../secret",
      "/secret",
      "folder/%2e%2e/secret",
      "file?bad",
      "folder\\secret",
    ]) {
      await expect(call("downloadArtifact", "run", path)).rejects.toMatchObject({ status: 400 });
    }
  });

  test("queries reject foreign or empty experiment scope and filter unexpected foreign results", async () => {
    const { call, calls } = setup({
      searchRuns: () => ({ items: [run(), run("foreign", "other")] }),
      searchTraces: () => ({ items: [trace(), trace("foreign", "other")] }),
    });
    for (const method of ["searchRuns", "searchTraces"]) {
      await denied(call(method, { experiment_ids: ["owned", "other"] }));
      await denied(call(method, { experiment_ids: [] }));
      expect(calls).toEqual([]);
    }
    expect(await call("searchRuns", {})).toEqual({ items: [run()] });
    expect(calls[0]?.args[0]).toMatchObject({ experiment_ids: ["owned", "linked"] });
    expect(await call("searchTraces", { experiment_ids: ["linked"] })).toEqual({
      items: [trace()],
    });
  });

  test("new runs and traces force project experiment and sanitize project tags", async () => {
    const { call, calls } = setup({ createRun: (input) => input, startTrace: (input) => input });
    const created = await call("createRun", {
      experiment_id: "other",
      tags: [
        { key: "ablationkit.project", value: "other" },
        { key: "kept", value: "yes" },
      ],
    });
    expect(created).toEqual({
      experiment_id: "owned",
      tags: [
        { key: "kept", value: "yes" },
        { key: "ablationkit.project", value: "project-a" },
      ],
    });
    const started = await call("startTrace", {
      ...trace(),
      trace_location: { type: "MLFLOW_EXPERIMENT", mlflow_experiment: { experiment_id: "other" } },
      tags: {
        "ablationkit.project": "other",
        "mlflow.artifactLocation": "mlflow-artifacts:/other",
        name: "keep",
      },
    });
    expect(started).toMatchObject({
      trace_location: { mlflow_experiment: { experiment_id: "owned" } },
      tags: { "ablationkit.project": "project-a", name: "keep" },
    });
    expect((started as MlflowTraceInfo).tags?.["mlflow.artifactLocation"]).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  test("every trace access checks location and uploads ignore supplied artifact locations", async () => {
    const actual = trace();
    const { call, calls } = setup({
      getTraceInfo: (id) => (id === "foreign" ? trace("foreign", "other") : actual),
      getTraceSpans: () => [],
      uploadTraceSpans: () => {},
      setTraceTag: () => {},
      createAssessment: () => ({}),
      deleteTraces: () => 1,
    });
    for (const method of ["getTraceInfo", "getTraceSpans", "setTraceTag", "createAssessment"])
      await denied(call(method, "foreign", "key", "value"));
    await denied(call("uploadTraceSpans", { ...trace("foreign"), tags: actual.tags }, []));
    await denied(call("deleteTraces", { experiment_id: "owned", trace_ids: ["foreign"] }));
    await denied(call("deleteTraces", { experiment_id: "other" }));
    expect(calls.every((c) => c.method === "getTraceInfo")).toBe(true);
    const spans = [{ span_id: "span" }];
    await call(
      "uploadTraceSpans",
      { ...actual, tags: { "mlflow.artifactLocation": "mlflow-artifacts:/other" } },
      spans,
    );
    expect(calls.at(-1)?.args).toEqual([actual, spans]);
    expect(calls.at(-1)?.args[0]).toBe(actual);
    expect(calls.at(-1)?.args[1]).toBe(spans);
    await denied(call("setTraceTag", "trace", "mlflow.artifactLocation", "other"));
    await call("setTraceTag", "trace", "ablationkit.project", "other");
    expect(calls.at(-1)?.args).toEqual(["trace", "ablationkit.project", "project-a"]);
    expect(await call("getTraceSpans", "trace")).toEqual([]);
    expect(await call("deleteTraces", { experiment_id: "owned", trace_ids: ["trace"] })).toBe(1);
  });

  test("registry methods validate parent model; searches filter project tags or linked experiments", async () => {
    const models = [
      { name: "owned-model", tags: [{ key: "ablationkit.project", value: "project-a" }] },
      { name: "linked-model", tags: [{ key: "_mlflow_experiment_ids", value: ",linked," }] },
      { name: "foreign-model", tags: [{ key: "ablationkit.project", value: "project-b" }] },
    ];
    const { call, calls } = setup({
      getRegisteredModel: (name) => models.find((m) => m.name === name),
      searchRegisteredModels: () => ({ items: models, next_page_token: "next" }),
      searchModelVersions: () => ({ items: models.map((m) => ({ name: m.name, version: "1" })) }),
      getModelVersion: () => "version",
      getVersionByAlias: () => "alias",
      createModelVersion: () => "created",
      setAlias: () => {},
      deleteAlias: () => {},
    });
    for (const method of [
      "getRegisteredModel",
      "getModelVersion",
      "getVersionByAlias",
      "setAlias",
      "deleteAlias",
    ])
      await denied(call(method, "foreign-model", "1", "2"));
    await denied(call("createModelVersion", { name: "foreign-model", source: "dummy-source" }));
    expect(calls.every((c) => c.method === "getRegisteredModel")).toBe(true);
    expect(await call("searchRegisteredModels", {})).toEqual({
      items: models.slice(0, 2),
      next_page_token: "next",
    });
    expect(await call("searchModelVersions", {})).toEqual({
      items: [
        { name: "owned-model", version: "1" },
        { name: "linked-model", version: "1" },
      ],
    });
    expect(await call("getModelVersion", "linked-model", "1")).toBe("version");
    await call("setAlias", "owned-model", "production", "1");
  });

  test("registry creation forces project tag and rejects foreign experiment associations", async () => {
    const { call } = setup({ createRegisteredModel: (input) => input });
    expect(
      await call("createRegisteredModel", {
        name: "model",
        tags: [{ key: "ablationkit.project", value: "other" }],
      }),
    ).toEqual({ name: "model", tags: [{ key: "ablationkit.project", value: "project-a" }] });
    await denied(
      call("createRegisteredModel", {
        name: "model",
        tags: [{ key: "_mlflow_experiment_ids", value: ",other," }],
      }),
    );
  });

  test("GenAI datasets are scoped by persisted experiment associations before gets and upserts", async () => {
    const { call, calls } = setup({
      raw: (_method, path) =>
        new Response(
          JSON.stringify({
            dataset: {
              dataset_id: String(path).split("/").at(-1),
              experiment_ids: String(path).endsWith("foreign") ? ["other"] : ["owned"],
            },
          }),
        ),
      createGenaiDataset: (input) => input,
      upsertGenaiDatasetRecords: () => 2,
    });
    await denied(call("getGenaiDataset", "foreign"));
    await denied(call("upsertGenaiDatasetRecords", "foreign", []));
    expect(calls.every((c) => c.method === "raw")).toBe(true);
    expect(await call("getGenaiDataset", "dataset")).toEqual({
      dataset_id: "dataset",
      experiment_ids: ["owned"],
    });
    expect(calls.at(-1)?.args).toEqual(["GET", "/api/3.0/mlflow/datasets/dataset"]);
    expect(await call("upsertGenaiDatasetRecords", "dataset", [])).toBe(2);
    await denied(call("createGenaiDataset", { name: "golden", experiment_ids: ["other"] }));
    expect(
      await call("createGenaiDataset", {
        name: "golden",
        experiment_ids: ["owned"],
        tags: { "ablationkit.project": "other" },
      }),
    ).toMatchObject({ experiment_ids: ["owned"], tags: { "ablationkit.project": "project-a" } });
  });

  test("MLflow errors preserve identity for existing recovery paths", async () => {
    const error = new MlflowError("unavailable", "tracking offline", 503);
    const { call } = setup({
      getRun: () => {
        throw error;
      },
    });
    await expect(call("getRun", "run")).rejects.toBe(error);
  });
});
