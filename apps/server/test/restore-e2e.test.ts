/**
 * Criterion 17 end to end (spec §5.8, §13; ADR 0025): a coordinator running its own managed MLflow
 * sidecar accumulates research, job, run, artifact, logged-model, registry, prompt, trace and GenAI
 * evaluation state; it is backed up and stopped; the backup is restored on a "clean machine" (a new
 * runtime directory and a fresh `git clone` of the project at another path); a new coordinator with
 * its own sidecar on another port then serves the same state through the API.
 *
 * Opt-in: `bun run test:restore` (ABLATIONKIT_RESTORE_E2E=1); CI runs it. Needs uv (the pinned
 * MLflow environment, from the uv cache) and python3.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { exportBackup, restoreBackup } from "../src/index.ts";
import { type Client, Harness } from "./helpers.ts";
import { ownedStateAudit } from "./owned-state.ts";

const RUN = process.env["ABLATIONKIT_RESTORE_E2E"] === "1";
const FIXTURES = resolve(import.meta.dir, "../../../fixtures/projects");
const P = "/api/v1/projects/rag";
const REG = "restore-model";

// biome-ignore lint/suspicious/noExplicitAny: loosely typed API JSON in assertions
type Json = any;
type Call = <T = Json>(
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<{ status: number; body: T }>;

const h = new Harness();
let llmServer: ReturnType<typeof Bun.spawn> | undefined;
let llmUrl = "";

/** A model directory as `mlflow.pyfunc.save_model` would leave it, written with the stdlib. */
const MAKE_MODEL = `import sys
from pathlib import Path
import ablationkit_sdk

run = ablationkit_sdk.init()
run.log_params({"kind": "restore-fixture", "lr": 0.1})
for step, loss in enumerate([0.5, 0.25, 0.125]):
    run.log_metrics({"loss": loss}, step=step)
Path("out").mkdir(exist_ok=True)
Path("out/notes.txt").write_text("evidence that must survive a restore\\n")
run.log_artifact("out/notes.txt", "notes")
d = Path("out/model")
d.mkdir(parents=True, exist_ok=True)
(d / "MLmodel").write_text(
    "artifact_path: model\\n"
    "flavors:\\n"
    "  python_function:\\n"
    "    loader_module: restore_fixture\\n"
    "    python_version: 3.12.0\\n"
    "mlflow_version: 3.0.0\\n"
    "model_uuid: 0123456789abcdef0123456789abcdef\\n"
)
(d / "weights.txt").write_text("w = 1\\n")
run.log_model(d, "restore-fixture")
print("made the model")
sys.exit(0)
`;

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

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 600_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(250);
  }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port ?? 0;
  await s.stop(true);
  return port;
}

async function boot(home: string): Promise<{ cl: Client; call: Call; token: string }> {
  const settings: CoordinatorSettings = {
    schema_version: 1,
    human: { host: "127.0.0.1", port: 0 },
    agent: { host: "127.0.0.1", port: 0 },
    worker: { host: "127.0.0.1", port: 0 },
    mlflow: { enabled: true, port: await freePort() },
    jobs: { supervisor: "direct", deliver_deadline_sec: 60 },
  };
  const cl = await h.start({
    home,
    settings,
    trackingIntervalMs: 50,
    researchExportDelayMs: 0,
    llmRetentionSweepMs: 0,
    log: (l) => {
      if (/sidecar|mlflow/i.test(l)) console.error(l);
    },
  });
  const token = await cl.session();
  const call: Call = (path, init = {}) => cl.json(cl.human(path, { token, ...init }));
  await until(async () => {
    const s = (await call("/api/v1/tracking/status")).body.sidecar;
    if (s.state === "failed") throw new Error(`sidecar failed: ${JSON.stringify(s)}`);
    return s.state === "healthy";
  });
  return { cl, call, token };
}

async function job(call: Call, command: string[]): Promise<Json> {
  const r = await call(`${P}/jobs`, {
    body: { command, environment: "none", env: { OPENAI_BASE_URL: llmUrl } },
  });
  if (r.status !== 201) throw new Error(`job: ${r.status} ${JSON.stringify(r.body)}`);
  return until(async () => {
    const j = (await call(`/api/v1/jobs/${r.body.job_id}`)).body;
    const a = j.latest_attempt;
    if (["failed", "timed_out", "oom_killed", "unknown"].includes(a.state))
      throw new Error(`job failed: ${JSON.stringify(a)}`);
    return a.state === "succeeded" && a.tracking.sync_state === "synced" ? j : undefined;
  });
}

/** Everything criterion 17 names, as the API shows it. */
async function snapshot(call: Call, ids: Json): Promise<Json> {
  const run = (await call(`/api/v1/tracking/runs/${ids.modelRun}`)).body;
  const series = (await call(`/api/v1/tracking/runs/${ids.modelRun}/metrics?keys=loss`)).body;
  const arts = (await call(`/api/v1/tracking/runs/${ids.modelRun}/artifacts?path=notes`)).body;
  const model = (await call(`${P}/models/${ids.modelId}`)).body;
  const reg = (await call(`${P}/registry/${REG}`)).body.registered_model;
  const resolved = (await call(`${P}/registry/${REG}/resolve?alias=champion`)).body;
  const prompt = (await call(`${P}/llm/prompts/${ids.prompt}`)).body.prompt;
  const ev = (await call(`${P}/llm/evaluations/${ids.evaluation}`)).body.evaluation;
  const examples = (await call(`${P}/llm/evaluations/${ids.evaluation}/examples`)).body;
  const traces = (await call(`${P}/llm/traces?run_id=${ids.ragRun}&max_results=100`)).body.traces;
  const trace = (await call(`${P}/llm/traces/${ids.trace}`)).body;
  const note = (await call(`${P}/research/${ids.note}`)).body.record;
  const jobView = (await call(`/api/v1/jobs/${ids.modelJob}`)).body;
  const console_ = (
    await call(
      `/api/v1/jobs/${ids.modelJob}/attempts/${jobView.latest_attempt.attempt_id}/console?after=-1&limit=1000&stream=stdout`,
    )
  ).body.lines.map((l: Json) => l.text);
  return {
    run: {
      status: run.run?.info?.status ?? run.info?.status,
      params: run.run?.data?.params ?? run.data?.params,
    },
    series,
    artifacts: arts,
    model: { name: model.model.name, flavors: model.mlmodel.flavors.map((f: Json) => f.name) },
    registry: reg.versions.map((v: Json) => [v.version, v.model_id]),
    resolved: { version: resolved.version, model_id: resolved.model_id },
    prompt: prompt.versions.map((v: Json) => [v.version, v.aliases, v.template]),
    evaluation: {
      state: ev.state,
      metrics: ev.results.map((r: Json) => r.metrics),
      runs: ev.results.map((r: Json) => r.run_id),
    },
    examples: examples.rows.map((r: Json) => [
      r.example_id,
      r.cells.only?.output,
      r.cells.only?.scores,
    ]),
    traces: traces.map((t: Json) => t.trace_id).sort(),
    trace: { spans: trace.spans?.length ?? trace.tree?.length, status: trace.trace?.status },
    note: { title: note.title, body: note.body },
    job: { state: jobView.latest_attempt.state, console: console_ },
  };
}

describe.skipIf(!RUN)("backup and restore on real MLflow (criterion 17)", () => {
  let before: Json;
  const ids: Json = {};
  let backupId = "";
  let backupPath = "";
  let repo = "";

  beforeAll(async () => {
    llmServer = Bun.spawn(["python3", join(FIXTURES, "llm-rag-agent", "serve_llm.py"), "0"], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = (llmServer.stdout as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    llmUrl = `http://127.0.0.1:${/READY (\d+)/.exec(first)?.[1]}/v1`;
  });

  afterAll(async () => {
    llmServer?.kill();
    await h.cleanup();
  });

  test("a coordinator accumulates research, runs, models, registry, prompts, traces and evaluations, and is backed up", async () => {
    const home = h.tmp("ak-restore-a-");
    const { call } = await boot(home);
    repo = join(h.tmp("ak-restore-src-"), "rag");
    cpSync(join(FIXTURES, "llm-rag-agent"), repo, { recursive: true });
    writeFileSync(join(repo, "make_model.py"), MAKE_MODEL);
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "fixture");
    expect(
      (await call("/api/v1/projects", { body: { path: repo, project_id: "rag" } })).status,
    ).toBe(201);

    // LLM research: provider, golden set, a pinned prompt.
    expect(
      (
        await call(`${P}/llm/settings`, {
          method: "PUT",
          body: { providers: [{ provider_id: "fixture", base_url: llmUrl, models: ["tiny-rag"] }] },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`${P}/llm/golden-sets`, {
          body: { name: "faq-golden", from_file: "golden.jsonl" },
        })
      ).status,
    ).toBe(201);
    ids.prompt = `faq-${Date.now().toString(36)}`;
    expect(
      (
        await call(`${P}/llm/prompts`, {
          body: {
            name: ids.prompt,
            template: [
              { role: "system", content: "Be terse." },
              { role: "user", content: "Question: {{question}}" },
            ],
            commit_message: "answer prompt",
          },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(`${P}/llm/prompts/${ids.prompt}/alias`, {
          body: { alias: "champion", version: 1 },
        })
      ).status,
    ).toBe(200);

    // A traced RAG job and a job that logs metrics, an artifact and a model.
    const rag = await job(call, ["python3", "rag_app.py", "faq-golden"]);
    ids.ragRun = rag.latest_attempt.tracking.mlflow_run_id;
    const traces = await until(async () => {
      const t = (await call(`${P}/llm/traces?run_id=${ids.ragRun}`)).body.traces;
      return t.length >= 7 ? t : undefined;
    });
    ids.trace = traces[0].trace_id;
    const made = await job(call, ["python3", "make_model.py"]);
    ids.modelJob = made.job_id;
    ids.modelRun = made.latest_attempt.tracking.mlflow_run_id;
    const model = await until(async () => {
      const ms = (await call(`${P}/models?run_id=${ids.modelRun}`)).body.models as Json[];
      return ms.find((m) => m.status === "LOGGED_MODEL_READY");
    });
    ids.modelId = model.model_id;

    // Registry: a version with an alias.
    expect(
      (await call(`${P}/registry`, { body: { name: REG, description: "restore" } })).status,
    ).toBe(201);
    expect(
      (await call(`${P}/registry/${REG}/versions`, { body: { model_id: ids.modelId } })).status,
    ).toBe(201);
    expect(
      (
        await call(`${P}/registry/${REG}/aliases/champion`, {
          method: "PUT",
          body: { version: "1" },
        })
      ).status,
    ).toBe(200);

    // A GenAI evaluation (mlflow.genai.evaluate in the bridge).
    const c = await call(`${P}/llm/evaluations`, {
      body: {
        golden_set: { name: "faq-golden" },
        targets: [
          {
            label: "only",
            prompt: `${ids.prompt}@champion`,
            provider_id: "fixture",
            model: "tiny-rag",
            params: { temperature: "0" },
          },
        ],
        scorers: [{ name: "exact", builtin: "exact_match" }],
      },
    });
    expect(c.status).toBe(201);
    const ev = await until(async () => {
      const r = (await call(`${P}/llm/evaluations/${c.body.evaluation.evaluation_id}`)).body
        .evaluation;
      if (r.state === "failed") throw new Error(`evaluation failed: ${r.error}`);
      return r.state === "succeeded" ? r : undefined;
    });
    ids.evaluation = ev.evaluation_id;

    // A research note.
    const note = await call(`${P}/research`, {
      body: { kind: "note", title: "Restore drill", body: "every link survives" },
    });
    ids.note = note.body.record.record_id;

    before = await snapshot(call, ids);
    expect(before.registry).toEqual([["1", ids.modelId]]);
    expect(before.resolved).toEqual({ version: "1", model_id: ids.modelId });
    expect(before.traces.length).toBeGreaterThanOrEqual(7);
    expect(before.job.console).toContain("made the model");

    const b = await call("/api/v1/backups", { body: {} });
    expect(b.status).toBe(201);
    expect(b.body.mlflow_database).toBe("vacuum_into");
    backupId = b.body.backup_id;
    backupPath = b.body.path;
    const v = await call(`/api/v1/backups/${backupId}/verify`, { body: {} });
    expect(v.body.ok).toBe(true);
    for (const c of h.coordinators.splice(0)) await c.stop();

    // Criterion 3 on a real home: MLflow's SQLite is the only database, and it is under mlflow/.
    // A backup holds a snapshot of the same MLflow database.
    const audit = ownedStateAudit(home, /^(backups\/[^/]+\/)?mlflow\//);
    expect(audit.databases).toEqual([]);
    expect(audit.mlflowDatabases).toContain("mlflow/mlflow.db");
  }, 1_800_000);

  test("restored on a clean machine, a new coordinator serves the same research, MLflow and registry state", async () => {
    // The clean machine: a fresh clone at another path (the registration manifest was never
    // committed, so the restore writes it) and an empty runtime directory.
    const clone = join(h.tmp("ak-restore-clone-"), "rag");
    git(repo, "clone", "-q", repo, clone);
    expect(existsSync(join(clone, ".ablationkit", "project.json"))).toBe(false);
    const homeB = h.tmp("ak-restore-b-");
    const archive = join(h.tmp("ak-restore-arch-"), "b.tar.gz");
    await exportBackup(backupPath, archive);
    const r = await restoreBackup({ source: archive, home: homeB, projectPaths: { rag: clone } });
    expect(r.record.projects[0]).toMatchObject({ checkout: "present", to_path: clone });
    expect(existsSync(join(clone, ".ablationkit", "project.json"))).toBe(true);

    const { cl, call, token } = await boot(homeB);
    const after = await snapshot(call, ids);
    expect(after).toEqual(before);
    // Artifact bytes, not only listings.
    const dl = await cl.human(
      `/api/v1/tracking/runs/${ids.modelRun}/artifacts/download?path=notes/notes.txt`,
      { token },
    );
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("evidence that must survive a restore\n");
    // The restored artifact store matches the runs that reference it (spec §13 diagnostics).
    const ops = (await call("/api/v1/system/operations")).body;
    const missing = ops.diagnostics.checks.find((c: Json) => c.name === "missing artifacts");
    expect(missing.status).toBe("ok");
    expect(missing.detail).not.toContain("(0 checked)");
    expect(ops.restored.backup_id).toBe(backupId);
    // MLflow writes still work on the restored data: a new run lands in the same experiment.
    const again = await job(call, ["python3", "make_model.py"]);
    expect(again.latest_attempt.tracking.sync_state).toBe("synced");
  }, 1_800_000);
});
