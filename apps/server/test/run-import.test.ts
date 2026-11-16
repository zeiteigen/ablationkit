/**
 * Historical-run import (ADR 0043): an agent turns a run's files into a labelled MLflow run of the
 * project (params from JSON files, metric history from a JSON-lines file, artifacts), once per
 * source, inside the checkout only; reports and tasks say which runs were imported.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

type Json = Record<string, unknown>;
const SETTINGS: CoordinatorSettings = {
  schema_version: 1,
  human: { host: "127.0.0.1", port: 0 },
  agent: { host: "127.0.0.1", port: 0 },
  worker: { host: "127.0.0.1", port: 0 },
  mlflow: { enabled: false },
  jobs: { supervisor: "direct", deliver_deadline_sec: 30 },
};

async function setup() {
  const fake = new FakeMlflow().start();
  fakes.push(fake);
  const cl = await h.start({ trackingUrl: fake.url, trackingIntervalMs: 20, settings: SETTINGS });
  const session = await cl.session();
  const human = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token: session, ...init }));
  const repo = h.repo("hist");
  // A run directory as a trainer left it, before the project used AblationKit.
  const run = join(repo, "data/models/pilot-base");
  mkdirSync(run, { recursive: true });
  writeFileSync(
    join(run, "training_hyperparameters.json"),
    JSON.stringify({ lr: 0.001, batch: 64, optimizer: { name: "muon", betas: [0.9, 0.95] } }),
  );
  writeFileSync(join(run, "training.log"), "Step 10: loss 3.5\n");
  writeFileSync(join(run, "checkpoint.pt"), "x".repeat(1000));
  writeFileSync(
    join(run, "events.jsonl"),
    [
      `{"time": 1731000000.5, "type": "progress", "global_step": 10, "loss": 3.5}`,
      `{"time": 1731000002, "type": "validation", "validation": {"global_step": 10, "bpb": 1.25}}`,
      `not json`,
      `{"time": 1731000003, "type": "progress", "global_step": 20, "loss": 3.25}`,
    ].join("\n"),
  );
  mkdirSync(join(repo, ".ablationkit"), { recursive: true });
  expect(
    (await human("/api/v1/projects", { body: { path: repo, project_id: "hist" } })).status,
  ).toBe(201);
  const { token } = await cl.agentSession("hist");
  const agent = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.agent(path, { token, ...init }));
  return { fake, cl, human, agent, repo };
}

interface Imported {
  ref: string;
  mlflow_run_id?: string;
  params: number;
  metrics: number;
  metric_keys: string[];
  artifacts: { path: string }[];
  warnings: string[];
}

describe("historical-run import", () => {
  test("params from JSON files, history from an events file, artifacts; labelled and once per source", async () => {
    const { fake, agent, human } = await setup();
    const task = await agent<{ task: { task_id: string } }>("/api/v1/projects/hist/tasks", {
      body: { goal: "onboard hist" },
    });
    const taskId = task.body.task.task_id;
    const body = {
      run_name: "pilot-base",
      source: "data/models/pilot-base",
      started_at: "2026-10-01T10:00:00Z",
      ended_at: "2026-10-01T12:00:00Z",
      source_commit: "d0fc54e",
      params_files: ["data/models/pilot-base/training_hyperparameters.json"],
      params: { tokenizer: "base-8192" },
      metrics_file: "data/models/pilot-base/events.jsonl",
      metrics_format: {
        step_keys: ["global_step", "validation/global_step"],
        timestamp_key: "time",
      },
      artifact_paths: ["data/models/pilot-base/*.json", "data/models/pilot-base/*.log"],
      study_id: "poc",
      variant_id: "base",
      task_id: taskId,
      tags: { origin: "pilot" },
    };
    const r = await agent<Imported>("/api/v1/projects/hist/run-imports", { body });
    expect(r.status).toBe(201);
    expect(r.body.params).toBe(5);
    expect(r.body.metrics).toBe(3);
    expect(r.body.metric_keys).toEqual(["loss", "validation/bpb"]);
    expect(r.body.artifacts.map((a) => a.path).sort()).toEqual([
      "data/models/pilot-base/training.log",
      "data/models/pilot-base/training_hyperparameters.json",
    ]);
    expect(r.body.warnings).toEqual(["metrics file: 1 line(s) were not JSON objects"]);

    const run = fake.run(r.body.mlflow_run_id as string);
    expect(run?.info.status).toBe("FINISHED");
    expect(run?.info.start_time).toBe(Date.parse("2026-10-01T10:00:00Z"));
    expect(run?.info.end_time).toBe(Date.parse("2026-10-01T12:00:00Z"));
    expect(Object.fromEntries(run?.params ?? [])).toEqual({
      lr: "0.001",
      batch: "64",
      "optimizer/name": "muon",
      "optimizer/betas": "[0.9,0.95]",
      tokenizer: "base-8192",
    });
    expect(run?.metrics.map((m) => `${m.key}@${m.step}=${m.value}`).sort()).toEqual([
      "loss@10=3.5",
      "loss@20=3.25",
      "validation/bpb@10=1.25",
    ]);
    const tags = run?.tags ?? new Map();
    expect(tags.get("ablationkit.kind")).toBe("import");
    expect(tags.get("ablationkit.import.source")).toBe("data/models/pilot-base");
    expect(tags.get("ablationkit.import.source_commit")).toBe("d0fc54e");
    expect(tags.get("ablationkit.import.by")).toMatch(/^agent:/);
    expect(tags.get("ablationkit.study_id")).toBe("poc");
    expect(tags.get("origin")).toBe("pilot");
    expect(tags.has("ablationkit.job_id")).toBe(false);

    // Once per source.
    const again = await agent<{ error: { code: string; ref: string } }>(
      "/api/v1/projects/hist/run-imports",
      { body },
    );
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: "already_imported", ref: r.body.ref });

    // Listed, on its task, and labelled in a generated report.
    const list = await agent<{ imports: { source: string }[] }>(
      "/api/v1/projects/hist/run-imports",
    );
    expect(list.body.imports.map((i) => i.source)).toEqual(["data/models/pilot-base"]);
    const work = await agent<{ imported_runs: { source: string }[] }>(
      `/api/v1/projects/hist/tasks/${taskId}`,
    );
    expect(work.body.imported_runs).toEqual([
      expect.objectContaining({ source: "data/models/pilot-base" }),
    ]);
    const rep = await agent<{ record: { body?: string; evidence: { note?: string }[] } }>(
      "/api/v1/projects/hist/research/reports/generate",
      { body: { study_id: "poc", metric_keys: ["validation/bpb"] } },
    );
    expect(rep.status).toBe(201);
    expect(rep.body.record.evidence[0]?.note).toContain(
      "imported from data/models/pilot-base, not run under AblationKit (reported commit d0fc54e)",
    );
    // The researcher can import too.
    const mine = await human<Imported>("/api/v1/projects/hist/run-imports", {
      body: { run_name: "by-hand", source: "notes/by-hand", metrics: [{ key: "acc", value: 0.5 }] },
    });
    expect(mine.status).toBe(201);
  });

  test("only files inside the checkout, never .ablationkit/; bad input is refused before anything is written", async () => {
    const { agent, repo } = await setup();
    symlinkSync("/etc", join(repo, "etc-link"));
    writeFileSync(join(repo, ".ablationkit/secret.json"), "{}");
    const cases: [Json, number][] = [
      [{ run_name: "x", source: "s", params_files: ["../outside.json"] }, 400],
      [{ run_name: "x", source: "s", params_files: ["etc-link/hostname"] }, 400],
      [{ run_name: "x", source: "s", params_files: [".ablationkit/secret.json"] }, 400],
      [{ run_name: "x", source: "s", metrics_file: "missing.jsonl" }, 404],
      [{ run_name: "x", source: "s", metrics_format: { step_keys: ["s"] } }, 400],
      [{ run_name: "x", source: "s", tags: { "ablationkit.kind": "attempt" } }, 400],
      [{ run_name: "x", source: "s", status: "RUNNING" }, 400],
      [{ run_name: "x", source: "s", source_commit: "not-a-sha" }, 400],
      [{ run_name: "x", source: "s", started_at: "yesterday" }, 400],
      [{ run_name: "x", source: "s", metrics: [{ key: "a", value: "high" }] }, 400],
      [{ run_name: "x", source: "s", surprise: 1 }, 400],
      [{ source: "s" }, 400],
    ];
    for (const [body, status] of cases)
      expect([
        JSON.stringify(body),
        (await agent("/api/v1/projects/hist/run-imports", { body })).status,
      ]).toEqual([JSON.stringify(body), status]);
    const list = await agent<{ imports: unknown[] }>("/api/v1/projects/hist/run-imports");
    expect(list.body.imports).toEqual([]);
    // An artifact glob never reaches .ablationkit/, and a file over the cap is skipped with a warning.
    const r = await agent<Imported>("/api/v1/projects/hist/run-imports", {
      body: { run_name: "g", source: "glob-test", artifact_paths: ["**/*.json", "nothing/*"] },
    });
    expect(r.status).toBe(201);
    expect(r.body.artifacts.map((a) => a.path)).toEqual([
      "data/models/pilot-base/training_hyperparameters.json",
    ]);
    expect(r.body.warnings).toContain("artifact glob nothing/*: no files match");
  });
});
