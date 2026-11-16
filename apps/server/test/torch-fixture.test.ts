/**
 * The custom PyTorch loop fixture end to end, in its own uv environment with CPU torch
 * (criteria 1 and 13). Opt-in: the first run downloads torch (~200 MB). `bun run test:torch`.
 */
import { afterEach, expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";

const ENABLED = process.env["ABLATIONKIT_TORCH_E2E"] === "1";
const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

async function until<T>(fn: () => Promise<T | undefined>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(200);
  }
}

test.skipIf(!ENABLED)(
  "custom PyTorch loop: metrics, params, logs and a checkpoint reach MLflow through the collector",
  async () => {
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const cl = await h.start({
      trackingUrl: fake.url,
      trackingIntervalMs: 20,
      settings: {
        schema_version: 1,
        human: { host: "127.0.0.1", port: 0 },
        agent: { host: "127.0.0.1", port: 0 },
        worker: { host: "127.0.0.1", port: 0 },
        mlflow: { enabled: false },
        jobs: { deliver_deadline_sec: 60 },
      },
    });
    const token = await cl.session();
    const call = <T>(path: string, body?: unknown) =>
      cl.json<T>(cl.human(path, { token, ...(body === undefined ? {} : { body }) }));
    const repo = join(h.tmp("ak-torch-"), "torch-custom-loop");
    cpSync(resolve(import.meta.dir, "../../../fixtures/projects/torch-custom-loop"), repo, {
      recursive: true,
    });
    expect((await call("/api/v1/projects", { path: repo, project_id: "torch-loop" })).status).toBe(
      201,
    );
    const sub = await call<{ job_id: string }>("/api/v1/projects/torch-loop/jobs", {
      command: ["python", "train.py", "--steps", "30"],
      variant_id: "gated",
      limits: { memory_max_bytes: 4 * 1024 ** 3, runtime_max_sec: 900 },
    });
    expect(sub.status).toBe(201);
    type A = {
      state: string;
      exit_code?: number;
      artifacts: { path: string }[];
      tracking: { mlflow_run_id?: string; sync_state?: string };
    };
    const done = await until(async () => {
      const j = (await call<{ latest_attempt: A }>(`/api/v1/jobs/${sub.body.job_id}`)).body;
      const a = j.latest_attempt;
      return a.state !== "starting" &&
        a.state !== "running" &&
        a.tracking.sync_state === "synced" &&
        a.artifacts.length >= 2
        ? a
        : undefined;
    }, 900_000);
    expect(done.state).toBe("succeeded");
    const run = fake.run(done.tracking.mlflow_run_id as string);
    expect(run?.info.status).toBe("FINISHED");
    expect(run?.params.get("model/class")).toBe("GatedMixer");
    expect(run?.params.get("optim/class")).toBe("Adam");
    expect(run?.metrics.filter((m) => m.key === "train/loss").length).toBe(6);
    expect(run?.metrics.some((m) => m.key === "val/loss")).toBe(true);
    expect(run?.artifacts.has("checkpoints/model.pt")).toBe(true);
    expect(run?.artifacts.has("summary.json")).toBe(true);
  },
  900_000,
);
