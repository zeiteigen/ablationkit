/**
 * LLM research end to end (criteria 10, 10a, 10b, 10c, 10e; ADR 0021) against the real pinned MLflow,
 * the real Python operations bridge (`mlflow.genai.evaluate`) and the fixture's deterministic
 * OpenAI-compatible server. The RAG/tool fixture app runs as a real job: its traces go
 * SDK → collector → coordinator (capture policy) → outbox → MLflow. Opt-in: `bun run test:llm`
 * (ABLATIONKIT_LLM_E2E=1); CI runs it. ABLATIONKIT_LIFECYCLE_MLFLOW_URL and
 * ABLATIONKIT_BRIDGE_PYTHON reuse a running pinned server, as in the lifecycle tests.
 *
 * ABLATIONKIT_LLM_REAL_URL and ABLATIONKIT_LLM_REAL_MODEL (for example an Ollama at
 * http://127.0.0.1:11434/v1 and llama3.2:3b) additionally run one playground call and one
 * evaluation against a real local model server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { MlflowClient, MlflowSidecar } from "@ablationkit/tracking-mlflow";
import type { Services } from "../src/services.ts";
import { DEFAULT_BRIDGE_SCRIPT } from "../src/tracking/bridge.ts";
import { type Client, Harness } from "./helpers.ts";

const RUN = process.env["ABLATIONKIT_LLM_E2E"] === "1";
const OPS = resolve(import.meta.dir, "../../../packages/tracking-mlflow/env");
const FIXTURES = resolve(import.meta.dir, "../../../fixtures/projects");
const REAL_URL = process.env["ABLATIONKIT_LLM_REAL_URL"];
const REAL_MODEL = process.env["ABLATIONKIT_LLM_REAL_MODEL"];

// biome-ignore lint/suspicious/noExplicitAny: loosely typed API JSON in assertions
type Json = any;

function extensionLlm(services: Services) {
  return {
    sweep: (pid: string) =>
      services.backends.service<Record<string, number>>(pid, "llm-research", "sweep", [], {
        kind: "human",
        id: "test",
      }),
  };
}

const h = new Harness();
let sidecar: MlflowSidecar | undefined;
let sidecarDir: string | undefined;
let llmServer: ReturnType<typeof Bun.spawn> | undefined;
let llmUrl = "";
let mlflow: MlflowClient;
let cl: Client;
let repo = "";
let call: <T = Json>(
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<{ status: number; body: T }>;
const P = "/api/v1/projects/rag/llm";
const PROMPT = `faq-${Date.now().toString(36)}`;
let jobRunId = "";

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

async function evaluate(body: Json): Promise<Json> {
  const c = await call(`${P}/evaluations`, { body });
  if (c.status !== 201) throw new Error(`evaluation: ${c.status} ${JSON.stringify(c.body)}`);
  return until(async () => {
    const r = (await call(`${P}/evaluations/${c.body.evaluation.evaluation_id}`)).body.evaluation;
    if (r.state === "failed") {
      const log = await cl.human(`${P}/evaluations/${r.evaluation_id}/log`, {
        token: await cl.session(),
      });
      throw new Error(`evaluation failed: ${r.error}\n${(await log.text()).slice(-3000)}`);
    }
    return r.state === "succeeded" ? r : undefined;
  });
}

async function runJob(env: Record<string, string>): Promise<Json> {
  const r = await call("/api/v1/projects/rag/jobs", {
    body: { command: ["python3", "rag_app.py", "faq-golden"], environment: "none", env },
  });
  expect(r.status).toBe(201);
  return until(async () => {
    const j = (await call(`/api/v1/jobs/${r.body.job_id}`)).body;
    const a = j.latest_attempt;
    if (["failed", "timed_out", "oom_killed", "unknown"].includes(a.state))
      throw new Error(`job failed: ${JSON.stringify(a)}`);
    return a.state === "succeeded" && a.tracking.sync_state === "synced" ? j : undefined;
  });
}

describe.skipIf(!RUN)("LLM research on real MLflow (criteria 10, 10a, 10b, 10c, 10e)", () => {
  beforeAll(async () => {
    let url: string;
    let python: string;
    if (process.env["ABLATIONKIT_LIFECYCLE_MLFLOW_URL"]) {
      url = process.env["ABLATIONKIT_LIFECYCLE_MLFLOW_URL"];
      python = process.env["ABLATIONKIT_BRIDGE_PYTHON"] as string;
      if (!python)
        throw new Error("set ABLATIONKIT_BRIDGE_PYTHON with ABLATIONKIT_LIFECYCLE_MLFLOW_URL");
    } else {
      sidecarDir = mkdtempSync(join(tmpdir(), "ak-llm-mlflow-"));
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
    // The fixture's OpenAI-compatible server.
    llmServer = Bun.spawn(["python3", join(FIXTURES, "llm-rag-agent", "serve_llm.py"), "0"], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = (llmServer.stdout as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    llmUrl = `http://127.0.0.1:${/READY (\d+)/.exec(first)?.[1]}/v1`;
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
      llmRetentionSweepMs: 0,
    });
    const token = await cl.session();
    call = (path, init = {}) => cl.json(cl.human(path, { token, ...init }));
    repo = join(h.tmp("ak-rag-"), "llm-rag-agent");
    cpSync(join(FIXTURES, "llm-rag-agent"), repo, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "fixture");
    expect(
      (await call("/api/v1/projects", { body: { path: repo, project_id: "rag" } })).status,
    ).toBe(201);
    const providers = [
      {
        provider_id: "fixture",
        base_url: llmUrl,
        models: ["tiny-rag", "tiny-rag-nousage", "tiny-flaky"],
        rates: [
          {
            model: "tiny-rag",
            input_usd_per_mtok: "0.2",
            output_usd_per_mtok: "0.6",
            source: "fixture rate card (not a real price)",
            version: "2026-11",
          },
        ],
      },
      ...(REAL_URL && REAL_MODEL
        ? [{ provider_id: "real", base_url: REAL_URL, models: [REAL_MODEL] }]
        : []),
    ];
    expect((await call(`${P}/settings`, { method: "PUT", body: { providers } })).status).toBe(200);
    expect(
      (
        await call(`${P}/golden-sets`, {
          body: { name: "faq-golden", from_file: "golden.jsonl", description: "support FAQ" },
        })
      ).status,
    ).toBe(201);
    for (const template of [
      [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Question: {{question}}" },
      ],
      [
        { role: "system", content: "Be warm and helpful." },
        { role: "user", content: "Question: {{question}}" },
      ],
    ])
      expect(
        (
          await call(`${P}/prompts`, {
            body: { name: PROMPT, template, commit_message: "answer prompt" },
          })
        ).status,
      ).toBe(201);
    expect(
      (await call(`${P}/prompts/${PROMPT}/alias`, { body: { alias: "champion", version: 1 } }))
        .status,
    ).toBe(200);
  }, 900_000);

  afterAll(async () => {
    llmServer?.kill();
    await h.cleanup();
    await sidecar?.stop();
    if (sidecarDir) rmSync(sidecarDir, { recursive: true, force: true });
  });

  test("criteria 10 and 10a: prompt versions browsed and pinned; two variants over the same golden-set version with per-example outputs, scorer and judge feedback, latency and token usage only where reported", async () => {
    const p = (await call(`${P}/prompts/${PROMPT}`)).body.prompt;
    expect(p.versions.map((v: Json) => [v.version, v.aliases])).toEqual([
      [2, []],
      [1, ["champion"]],
    ]);
    expect(
      (await call(`${P}/prompts/${PROMPT}/diff?from=1&to=2`)).body.diff.blocks[0].lines,
    ).toEqual([
      { op: "del", text: "Be terse." },
      { op: "add", text: "Be warm and helpful." },
    ]);
    const ev = await evaluate({
      golden_set: { name: "faq-golden" },
      targets: [
        {
          label: "terse",
          prompt: `${PROMPT}@champion`,
          provider_id: "fixture",
          model: "tiny-rag",
          params: { temperature: "0" },
        },
        {
          label: "warm",
          prompt: `${PROMPT}/2`,
          provider_id: "fixture",
          model: "tiny-rag-nousage",
          params: { temperature: "0" },
        },
      ],
      scorers: [
        { name: "exact", builtin: "exact_match" },
        { name: "facts", builtin: "expected_facts" },
        {
          name: "correct",
          judge: {
            provider_id: "fixture",
            model: "tiny-rag",
            rubric: "Does the answer state the same fact as the reference answer?",
          },
        },
      ],
    });
    expect(ev.targets[0].prompt).toMatchObject({ name: PROMPT, version: 1, alias: "champion" });
    const [terse, warm] = ev.results;
    // 4 of 6 with ground truth: the warranty answer states the wrong fact, and "money back" shares
    // no word with the FAQ, so nothing is retrieved ("hours" has no ground truth at all).
    expect(Number(terse.metrics["exact/mean"])).toBeCloseTo(4 / 6, 5);
    expect(Number(warm.metrics["exact/mean"])).toBe(0);
    expect(terse.usage.reported).toBe(7);
    expect(terse.usage.missing).toBe(0);
    expect(terse.cost).toMatchObject({
      rate_source: "fixture rate card (not a real price)",
      partial: false,
    });
    expect(warm.usage).toEqual({ reported: 0, missing: 7 });
    expect(warm.cost).toBeUndefined();
    expect(terse.judge_usage.reported).toBe(7);
    const ex = (await call(`${P}/evaluations/${ev.evaluation_id}/examples`)).body;
    expect(ex.rows.map((r: Json) => r.example_id)).toEqual([
      "refund",
      "shipping",
      "password",
      "warranty",
      "order-7",
      "money-back",
      "hours",
    ]);
    const refund = ex.rows[0];
    expect(refund.cells.terse.output).toBe(
      "Refunds are issued within 5 business days after the returned item arrives.",
    );
    expect(refund.cells.warm.output).toStartWith("Happy to help!");
    expect(refund.cells.terse.scores.exact.value).toBe(true);
    expect(refund.regressions.warm).toContain("exact");
    expect(refund.cells.terse.usage.total_tokens).toBeGreaterThan(0);
    expect(refund.cells.warm.usage).toBeUndefined();
    expect(refund.cells.terse.latency_ms).toBeGreaterThanOrEqual(0);
    // Missing ground truth is an error, not a guess.
    expect(ex.rows[6].missing_expectations).toBe(true);
    expect(ex.rows[6].cells.terse.scores.exact.error).toContain("missing ground truth");
    // The judge's verdict lives on the MLflow trace as an LLM_JUDGE assessment with its provenance.
    const tr = (await call(`${P}/traces/${refund.cells.terse.trace_id}`)).body;
    expect(tr.links).toMatchObject({
      evaluation_id: ev.evaluation_id,
      example_id: "refund",
      variant: "terse",
      prompt: `${PROMPT}/1`,
    });
    const judge = tr.assessments.find((a: Json) => a.name === "correct");
    expect(judge.source).toEqual({ source_type: "LLM_JUDGE", source_id: "fixture/tiny-rag" });
    expect(judge.metadata).toMatchObject({
      judge_model: "tiny-rag",
      judge_provider: "fixture",
      judge_locality: "local",
      rubric_sha256: ev.scorers[2].judge.rubric_sha256,
    });
    expect(tr.spans.find((s: Json) => s.kind === "llm").usage.total_tokens).toBeGreaterThan(0);
    // Each target is a finished MLflow run with the per-example artifact.
    const run = await mlflow.getRun(terse.run_id);
    expect(run.info.status).toBe("FINISHED");
    expect(run.data.tags?.find((t) => t.key === "ablationkit.prompt")?.value).toBe(`${PROMPT}/1`);
    const listed = await mlflow.listArtifacts(terse.run_id, "ablationkit/llm");
    expect(listed.items.map((f) => f.path)).toContain("ablationkit/llm/examples.json");
  });

  test("criteria 10b and 10c: a RAG/tool job's traces (LLM, retrieval, tool spans) with timings, errors, retries, retrieval references and index revision; recorded traces scored for grounding with judge provenance; a failed example links to its trace and the report", async () => {
    const job = await runJob({ OPENAI_BASE_URL: llmUrl });
    jobRunId = job.latest_attempt.tracking.mlflow_run_id;
    const traces = await until(async () => {
      const t = (await call(`${P}/traces?run_id=${jobRunId}`)).body.traces;
      return t.length === 7 ? t : undefined;
    }, 120_000);
    const order = traces.find((t: Json) => t.tags["ablationkit.example_id"] === "order-7");
    const d = (await call(`${P}/traces/${order.trace_id}`)).body;
    expect(d.trace.tags).toMatchObject({
      "ablationkit.source": "job",
      "ablationkit.capture": "redacted",
    });
    expect(d.spans.map((s: Json) => `${s.depth}:${s.kind}:${s.name}`)).toEqual([
      "0:agent:support_agent",
      "1:retrieval:retrieve",
      "1:tool:lookup_order",
      "1:tool:lookup_order",
      "1:llm:chat_completion",
    ]);
    expect(d.spans.every((s: Json) => typeof s.duration_ms === "number" && s.offset_ms >= 0)).toBe(
      true,
    );
    expect(d.tools.map((t: Json) => [t.attempt, t.retried, t.error?.type ?? null])).toEqual([
      [1, true, "TimeoutError"],
      [2, false, null],
    ]);
    expect(d.tool_failures).toEqual([
      {
        tool: "lookup_order",
        error_type: "TimeoutError",
        count: 1,
        span_ids: [d.tools[0].span_id],
      },
    ]);
    expect(d.rag.instrumented).toBe(true);
    expect(d.rag.retrievals[0].documents[0]).toMatchObject({ doc_uri: "faq.md", chunk_id: "4" });
    expect(d.rag.index_revision.value).toStartWith("faq-");
    expect(d.rag.retrieval_config).toEqual({
      available: true,
      value: { retriever: "keyword-overlap", top_k: 2, chunking: "paragraph" },
    });
    expect(d.usage.reported).toBe(1);
    const ev = await evaluate({
      golden_set: { name: "faq-golden" },
      targets: [{ label: "rag-v1", recorded: { run_id: jobRunId } }],
      scorers: [
        { name: "recall", builtin: "retrieval_recall" },
        { name: "cited", builtin: "has_citation" },
        {
          name: "grounded",
          judge: {
            provider_id: "fixture",
            model: "tiny-rag",
            rubric: "Is every claim in the answer supported by the retrieved passages?",
            uses: "grounding",
          },
        },
        { name: "cites_source", project: { path: "evals/scorers.py", function: "cites_source" } },
      ],
      acknowledge_project_code: true,
    });
    expect(ev.targets[0]).toMatchObject({ kind: "recorded", source_run_id: jobRunId, matched: 7 });
    expect(ev.scorers[3].project.commit).toMatch(/^[a-f0-9]{40}$/);
    const ex = (await call(`${P}/evaluations/${ev.evaluation_id}/examples`)).body;
    const byId = Object.fromEntries(ex.rows.map((r: Json) => [r.example_id, r.cells["rag-v1"]]));
    expect(byId["refund"].scores.recall.value).toBe(1);
    expect(byId["refund"].scores.cited.value).toBe(true);
    expect(byId["refund"].scores.grounded.value).toBe("yes");
    expect(byId["refund"].scores.cites_source.value).toBe(true);
    expect(byId["hours"].scores.recall.error).toContain("missing ground truth");
    // Scored where they are: the assessments are on the job's own traces, with the judge's provenance.
    expect(byId["refund"].trace_id).toBe(
      traces.find((t: Json) => t.tags["ablationkit.example_id"] === "refund").trace_id,
    );
    const t = (await call(`${P}/traces/${byId["refund"].trace_id}`)).body;
    const g = t.assessments.find((a: Json) => a.name === "grounded");
    expect(g.source.source_type).toBe("LLM_JUDGE");
    expect(g.metadata.rubric_sha256).toBe(ev.scorers[2].judge.rubric_sha256);
    expect(t.links.evaluation_id).toBe(ev.evaluation_id);
    // A failed example (nothing retrieved for "money back") links to its trace and the report.
    expect(byId["money-back"].scores.recall.value).toBe(0);
    expect(byId["money-back"].scores.cited.value).toBe(false);
    const failed = ex.rows.filter((r: Json) => r.failed).map((r: Json) => r.example_id);
    expect(failed).toEqual(["money-back"]);
    const rep = (await call(`${P}/evaluations/${ev.evaluation_id}/report`, { body: {} })).body
      .report;
    const links = rep.links.map((l: Json) => `${l.kind}:${l.id}`);
    expect(links).toContain(`trace:${byId[failed[0]].trace_id}`);
    expect(links).toContain(`run:${ev.results[0].run_id}`);
    expect(rep.body).toContain("rubric SHA-256");
    // Linking references the trace ID only; MLflow keeps the one copy of the spans.
    expect(rep.body).not.toContain("Refunds are issued");
  });

  test("criterion 10e: capture and redaction reach MLflow, external egress is refused, retention deletes, estimates are labelled", async () => {
    // Redacted capture (the default): an email in a playground input never reaches MLflow.
    const r = await call(`${P}/playground`, {
      body: {
        variants: [
          { label: "a", prompt: `${PROMPT}/1`, provider_id: "fixture", model: "tiny-rag" },
        ],
        inputs: [{ question: "Refund for jane.doe@example.com?" }],
      },
    });
    expect(r.status).toBe(200);
    const tid = r.body.result.rows[0].cells.a.trace_id;
    const raw = JSON.stringify(await mlflow.getTraceSpans(tid));
    expect(raw).not.toContain("jane.doe@example.com");
    expect(raw).toContain("[REDACTED:email]");
    // metadata_only: a job's bodies are dropped before the outbox; the grounding judge says it cannot judge.
    expect(
      (await call(`${P}/settings`, { method: "PUT", body: { capture: { mode: "metadata_only" } } }))
        .status,
    ).toBe(200);
    const job = await runJob({ OPENAI_BASE_URL: llmUrl });
    const run2 = job.latest_attempt.tracking.mlflow_run_id;
    const traces = await until(async () => {
      const t = (await call(`${P}/traces?run_id=${run2}`)).body.traces;
      return t.length === 7 ? t : undefined;
    }, 120_000);
    const spans = JSON.stringify(await mlflow.getTraceSpans(traces[0].trace_id));
    expect(spans).not.toContain("Refunds are issued");
    expect(spans).toContain("metadata_only");
    expect(spans).toContain("mlflow.chat.tokenUsage");
    const ev = await evaluate({
      golden_set: { name: "faq-golden" },
      targets: [{ label: "rag-meta", recorded: { run_id: run2 } }],
      scorers: [
        {
          name: "grounded",
          judge: {
            provider_id: "fixture",
            model: "tiny-rag",
            rubric: "Grounded?",
            uses: "grounding",
          },
        },
      ],
    });
    expect(ev.retention.capture).toBe("metadata_only");
    const ex = (await call(`${P}/evaluations/${ev.evaluation_id}/examples`)).body;
    expect(ex.rows[0].cells["rag-meta"].scores.grounded.error).toContain("not captured");
    // External egress is refused until the researcher approves it; nothing is sent.
    const cur = (await call(`${P}/settings`)).body.settings;
    await call(`${P}/settings`, {
      method: "PUT",
      body: {
        providers: [
          ...cur.providers,
          { provider_id: "hosted", base_url: "https://llm.invalid/v1", models: ["x"] },
        ],
      },
    });
    const refused = await call(`${P}/evaluations`, {
      body: {
        golden_set: { name: "faq-golden" },
        targets: [{ label: "x", prompt: `${PROMPT}/1`, provider_id: "hosted", model: "x" }],
        scorers: [{ name: "exact", builtin: "exact_match" }],
      },
    });
    expect(refused.body.error.code).toBe("egress_not_approved");
    // Retention: a sweep with a 1-day window keeps today's traces.
    await call(`${P}/settings`, { method: "PUT", body: { capture: { retention_days: 1 } } });
    const before = (await call(`${P}/traces?max_results=200`)).body.traces.length;
    const svc = (h.coordinators.at(-1) as (typeof h.coordinators)[number]).services;
    expect((await extensionLlm(svc).sweep("rag"))["rag"]).toBe(0);
    expect((await call(`${P}/traces?max_results=200`)).body.traces.length).toBe(before);
  });

  test.skipIf(!REAL_URL || !REAL_MODEL)(
    "a real local OpenAI-compatible server (Ollama, vLLM, llama.cpp)",
    async () => {
      const r = await call(`${P}/playground`, {
        body: {
          variants: [
            {
              label: "real",
              prompt: `${PROMPT}/1`,
              provider_id: "real",
              model: REAL_MODEL,
              params: { temperature: "0", max_tokens: 64 },
            },
          ],
          inputs: [{ question: "How long do refunds take?" }],
        },
      });
      expect(r.status).toBe(200);
      expect(r.body.result.rows[0].cells.real.output.length).toBeGreaterThan(0);
      const ev = await evaluate({
        golden_set: { name: "faq-golden" },
        targets: [
          {
            label: "real",
            prompt: `${PROMPT}/1`,
            provider_id: "real",
            model: REAL_MODEL,
            params: { temperature: "0", max_tokens: 64 },
          },
        ],
        scorers: [{ name: "facts", builtin: "expected_facts" }],
      });
      expect(ev.results[0].examples).toBe(7);
    },
  );
});
