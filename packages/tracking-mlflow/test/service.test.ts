import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MlflowError } from "../src/client.ts";
import { MappingStore } from "../src/mapping.ts";
import { TrackingInputError } from "../src/service.ts";
import { Env, until } from "./helpers.ts";

const env = new Env();
afterEach(() => env.cleanup());

const attempt = (n: number) => ({
  project_id: "demo",
  kind: "attempt" as const,
  ref: `att-${n}`,
  job_id: "job-1",
  attempt_id: `att-${n}`,
  study_id: "study-a",
  variant_id: "baseline",
  task_id: "task-1",
});

describe("TrackingService", () => {
  test("lands runs in ak/<project-id> with study, variant and task tags (criterion 60)", async () => {
    const fake = env.fake();
    const { svc, mappings } = await env.service(() => fake.url);
    svc.start();
    const r = svc.startRun(attempt(1));
    svc.logBatch("att-1", {
      metrics: [{ key: "loss", value: 0.5, timestamp: 1, step: 0 }],
      params: [{ key: "lr", value: "0.1" }],
    });
    await until(() => mappings.get("att-1")?.sync_state === "synced");
    const m = mappings.get(r.ref);
    expect(m?.mlflow_run_id).toBeDefined();
    const run = fake.run(m?.mlflow_run_id as string);
    expect(run?.info.experiment_id).toBe(mappings.getLinks("demo").experiment_id as string);
    const exp = await svc.client.getExperiment(run?.info.experiment_id as string);
    expect(exp.name).toBe("ak/demo");
    for (const [k, v] of [
      ["ablationkit.project_id", "demo"],
      ["ablationkit.job_id", "job-1"],
      ["ablationkit.attempt_id", "att-1"],
      ["ablationkit.study_id", "study-a"],
      ["ablationkit.variant_id", "baseline"],
      ["ablationkit.task_id", "task-1"],
    ])
      expect(run?.tags.get(k as string)).toBe(v as string);
    expect(run?.params.get("lr")).toBe("0.1");
    // Retries create new attempts and new runs; the experiment is shared.
    svc.startRun(attempt(2));
    await until(() => mappings.get("att-2")?.sync_state === "synced");
    expect(mappings.get("att-2")?.mlflow_run_id).not.toBe(m?.mlflow_run_id);
    expect(fake.allRuns().every((x) => x.info.experiment_id === run?.info.experiment_id)).toBe(
      true,
    );
  });

  test("queues while MLflow is down and reports tracking_pending, never committed (criterion 11)", async () => {
    const fake = env.fake();
    await fake.stop();
    const { svc, mappings, outbox, home } = await env.service(() => fake.url);
    svc.start();
    svc.startRun(attempt(1));
    svc.logBatch("att-1", { metrics: [{ key: "loss", value: 1, timestamp: 1, step: 0 }] });
    await Bun.sleep(150);
    expect(mappings.get("att-1")?.sync_state).toBe("tracking_pending");
    expect(mappings.get("att-1")?.mlflow_run_id).toBeUndefined();
    expect(svc.sync("att-1")).toMatchObject({
      state: "tracking_pending",
      pending_ops: 2,
      failed_ops: 0,
    });
    expect(svc.lastTransportError?.kind).toBe("unavailable");
    // A coordinator restart in the middle loses nothing.
    await svc.stop();
    outbox.close();
    const again = await env.service(() => fake.url, { home });
    expect(again.outbox.stats().pending).toBe(2);
    fake.start();
    again.svc.start();
    again.svc.mlflowAvailable();
    await until(() => again.mappings.get("att-1")?.sync_state === "synced");
    const run = fake.run(again.mappings.get("att-1")?.mlflow_run_id as string);
    expect(run?.metrics).toHaveLength(1);
    expect(again.outbox.stats().pending).toBe(0);
  });

  test("a 503 from MLflow is retried, not failed", async () => {
    const fake = env.fake();
    fake.down = true;
    const { svc, mappings } = await env.service(() => fake.url);
    svc.start();
    svc.startRun(attempt(1));
    await Bun.sleep(100);
    expect(mappings.get("att-1")?.sync_state).toBe("tracking_pending");
    fake.down = false;
    await until(() => mappings.get("att-1")?.sync_state === "synced");
  });

  test("an ambiguous run create is not duplicated on retry", async () => {
    const fake = env.fake();
    // The first runs/create lands in MLflow but the caller sees a reset.
    const { svc, mappings } = await env.service(() => fake.url, { timeoutMs: 300 });
    const realCreate = svc.client.createRun.bind(svc.client);
    let calls = 0;
    svc.client.createRun = async (input) => {
      calls++;
      const run = await realCreate(input);
      if (calls === 1) throw new MlflowError("ambiguous", "reset after send");
      return run;
    };
    svc.start();
    svc.startRun(attempt(1));
    await until(() => mappings.get("att-1")?.sync_state === "synced");
    expect(calls).toBe(1);
    expect(fake.allRuns()).toHaveLength(1);
    expect(mappings.get("att-1")?.mlflow_run_id).toBe(fake.allRuns()[0]?.info.run_id as string);
  });

  test("replayed metric batches do not duplicate points", async () => {
    const fake = env.fake();
    const { svc, mappings } = await env.service(() => fake.url);
    svc.start();
    svc.startRun(attempt(1));
    const batch = { metrics: [{ key: "loss", value: 0.3, timestamp: 5, step: 1 }] };
    svc.logBatch("att-1", batch);
    svc.logBatch("att-1", batch);
    await until(() => mappings.get("att-1")?.sync_state === "synced");
    expect(fake.run(mappings.get("att-1")?.mlflow_run_id as string)?.metrics).toHaveLength(1);
  });

  test("a rejected write shows sync_failed with the reason and can be retried", async () => {
    const fake = env.fake();
    const { svc, mappings, outbox } = await env.service(() => fake.url);
    svc.start();
    svc.startRun(attempt(1));
    svc.logBatch("att-1", { params: [{ key: "lr", value: "0.1" }] });
    svc.logBatch("att-1", { params: [{ key: "lr", value: "0.2" }] });
    svc.logBatch("att-1", { metrics: [{ key: "loss", value: 1, timestamp: 1, step: 0 }] });
    await until(() => mappings.get("att-1")?.sync_state === "sync_failed");
    const m = mappings.get("att-1");
    expect(m?.last_error).toContain("Changing param values");
    // Later writes for the run still land.
    await until(() => (fake.run(m?.mlflow_run_id as string)?.metrics.length ?? 0) === 1);
    const failed = outbox.entries({ state: "failed" });
    expect(failed).toHaveLength(1);
    // Retrying the same rejected write fails again, visibly.
    svc.retry(failed[0]?.op_id as string);
    await until(() => outbox.get(failed[0]?.op_id as string)?.state === "failed");
    expect(mappings.get("att-1")?.sync_state).toBe("sync_failed");
  });

  test("ends runs, rejects bad input and reserved tags before queueing", async () => {
    const fake = env.fake();
    const { svc, mappings, outbox } = await env.service(() => fake.url);
    svc.start();
    svc.startRun(attempt(1));
    expect(() => svc.startRun(attempt(1))).toThrow(TrackingInputError);
    expect(() => svc.logBatch("att-1", { tags: [{ key: "ablationkit.ref", value: "x" }] })).toThrow(
      TrackingInputError,
    );
    expect(() =>
      svc.logBatch("att-1", { metrics: [{ key: "../x", value: 1, timestamp: 1, step: 0 }] }),
    ).toThrow(TrackingInputError);
    expect(() =>
      svc.logBatch("att-1", { metrics: [{ key: "x", value: Number.NaN, timestamp: 1, step: 0 }] }),
    ).toThrow(TrackingInputError);
    expect(() => svc.logBatch("nope", { params: [{ key: "a", value: "b" }] })).toThrow(
      TrackingInputError,
    );
    expect(outbox.stats().pending + outbox.stats().failed).toBeLessThanOrEqual(1);
    svc.endRun("att-1", { status: "FINISHED", end_time: 99 });
    await until(
      () => mappings.get("att-1")?.sync_state === "synced" && outbox.stats().pending === 0,
    );
    expect(fake.run(mappings.get("att-1")?.mlflow_run_id as string)?.info.status).toBe("FINISHED");
  });

  test("mappings survive a reload from disk", async () => {
    const fake = env.fake();
    const { svc, mappings, home } = await env.service(() => fake.url);
    svc.start();
    svc.startRun(attempt(1));
    await until(() => mappings.get("att-1")?.sync_state === "synced");
    const fresh = new MappingStore(join(home, "state"));
    expect(fresh.load()).toEqual([]);
    expect(fresh.getByRunId(mappings.get("att-1")?.mlflow_run_id as string)?.ref).toBe("att-1");
    expect(fresh.getLinks("demo").experiment_id).toBe(
      mappings.getLinks("demo").experiment_id as string,
    );
  });
});
