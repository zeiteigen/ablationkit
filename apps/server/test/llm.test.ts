/**
 * LLM research against the fake MLflow, the fake bridge and an in-test OpenAI-compatible server
 * (criteria 10, 10a, 10b, 10c, 10e; ADR 0021): prompt registry browsing, diffs and alias pinning;
 * immutable golden sets with held-out guards; trace capture, redaction, search, span trees, RAG and
 * tool views, feedback and retention; data controls and egress; the playground with saved
 * evidence; GenAI evaluations with aligned per-example results, comparison, flags and reports.
 * The real bridge, real MLflow and the RAG fixture job run in llm-e2e.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BackendCaller } from "@ablationkit/extension-host/backend";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import type { Services } from "../src/services.ts";
import { Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const FAKE_BRIDGE = resolve(import.meta.dir, "fake-bridge.ts");

afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
  for (const s of servers.splice(0)) await s.stop(true);
});

// biome-ignore lint/suspicious/noExplicitAny: loosely typed API JSON in assertions
type Json = any;

/** Exercise exported extension services rather than coordinator-owned LLM internals. */
function extensionLlm(services: Services) {
  const actor: BackendCaller = { kind: "human", id: "test" };
  const service = <T = unknown>(pid: string, name: string, args: unknown[]) =>
    services.backends.service<T>(pid, "llm-research", name, args, actor);
  const sweep = async (pids: string[]) =>
    Object.assign(
      {},
      ...(await Promise.all(pids.map((pid) => service<Record<string, number>>(pid, "sweep", [])))),
    ) as Record<string, number>;
  return {
    traces: {
      prepareJobTrace: (
        pid: string,
        payload: Record<string, unknown>,
        context: { attempt_id: string; job_id: string; remote?: boolean },
      ) => service(pid, "trace.prepare", [pid, payload, context]),
      write: (pid: string, trace: Record<string, unknown>) =>
        service<string>(pid, "traces.write", [pid, trace]),
      sweep,
    },
    settings: {
      update: (pid: string, body: Record<string, unknown>) =>
        service(pid, "settings.update", [pid, body]),
    },
    sweep,
  };
}

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

/** An OpenAI-compatible endpoint: echoes the last user message; usage unless `-nousage`. */
function fakeLlm() {
  const seen: Json[] = [];
  const srv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (r) => {
      const url = new URL(r.url);
      if (url.pathname.endsWith("/models"))
        return Response.json({ data: [{ id: "echo" }, { id: "echo-nousage" }] });
      const body = (await r.json()) as Json;
      seen.push({ ...body, authorization: r.headers.get("authorization") });
      const user = body.messages.filter((m: Json) => m.role === "user").at(-1)?.content ?? "";
      if (user.includes("flaky"))
        return Response.json({ error: { message: "overloaded" } }, { status: 500 });
      const system = body.messages.find((m: Json) => m.role === "system")?.content ?? "";
      const text = `${system.includes("terse") ? "" : "Sure! "}${user}`;
      return Response.json({
        model: body.model,
        choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
        ...(String(body.model).endsWith("-nousage")
          ? {}
          : { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
      });
    },
  });
  servers.push(srv);
  return { url: `http://127.0.0.1:${srv.port}/v1`, seen };
}

async function setup(
  opts: {
    home?: string;
    fake?: FakeMlflow;
    bridgeConfig?: string;
    env?: Record<string, string>;
  } = {},
) {
  const fake = opts.fake ?? new FakeMlflow().start();
  if (!opts.fake) fakes.push(fake);
  const bridgeConfig = opts.bridgeConfig ?? join(h.tmp("ak-bridge-"), "config.json");
  if (!opts.bridgeConfig) writeFileSync(bridgeConfig, "{}");
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    settings: SETTINGS,
    bridgeCommand: ["bun", FAKE_BRIDGE, bridgeConfig],
    llmRetentionSweepMs: 0,
    ...(opts.home ? { home: opts.home } : {}),
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  const svc = () => (h.coordinators.at(-1) as (typeof h.coordinators)[number]).services;
  const config = (c: Json) => writeFileSync(bridgeConfig, JSON.stringify(c));
  let agentToken: string | undefined;
  const agent = async <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) => {
    if (!agentToken) {
      agentToken = (await cl.agentSession("rag")).token;
    }
    return cl.json<T>(cl.agent(path, { token: agentToken, ...init }));
  };
  return { fake, cl, call, agent, svc, config, bridgeConfig, token };
}
type World = Awaited<ReturnType<typeof setup>>;

const P = "/api/v1/projects/rag/llm";

async function project(w: World, llmUrl?: string): Promise<string> {
  const path = h.repo("rag");
  writeFileSync(
    join(path, "golden.jsonl"),
    [
      {
        example_id: "e1",
        inputs: { question: "refunds?" },
        expectations: { expected_response: "5 days" },
        category: "billing",
      },
      {
        example_id: "e2",
        inputs: { question: "shipping?" },
        expectations: { expected_response: "free" },
        category: "shipping",
      },
      { example_id: "e3", inputs: { question: "hours?" }, category: "account", edge_case: true },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n"),
  );
  mkdirSync(join(path, "evals"));
  writeFileSync(
    join(path, "evals", "scorers.py"),
    "def polite(inputs, outputs, expectations, trace):\n    return 'Sure' in str(outputs)\n",
  );
  const r = await w.call("/api/v1/projects", { body: { path, project_id: "rag" } });
  expect(r.status).toBe(201);
  if (llmUrl) {
    const s = await w.call(`${P}/settings`, {
      method: "PUT",
      body: {
        providers: [
          {
            provider_id: "local",
            base_url: llmUrl,
            models: ["echo", "echo-nousage"],
            rates: [
              {
                model: "echo",
                input_usd_per_mtok: "0.5",
                output_usd_per_mtok: "1.5",
                source: "test rate card",
                version: "2026-11",
              },
            ],
          },
        ],
      },
    });
    expect(s.status).toBe(200);
  }
  return path;
}

async function prompts(w: World): Promise<void> {
  for (const template of [
    [
      { role: "system", content: "Be terse." },
      { role: "user", content: "{{question}}" },
    ],
    [
      { role: "system", content: "Be friendly." },
      { role: "user", content: "{{question}}" },
    ],
  ])
    expect(
      (await w.call(`${P}/prompts`, { body: { name: "faq", template, commit_message: "v" } }))
        .status,
    ).toBe(201);
  expect(
    (await w.call(`${P}/prompts/faq/alias`, { body: { alias: "champion", version: 1 } })).status,
  ).toBe(200);
}

/** The extension backend records audit entries as notifications: wait for them to land. */
const auditHas = (w: World, action: string) => until(async () => auditText(w).includes(action));

const auditText = (w: World) => {
  const d = w.svc().paths.auditDir;
  return readdirSync(d)
    .map((f) => readFileSync(join(d, f), "utf8"))
    .join("");
};

const NS = 1_793_800_329_000_000_000;
const J = (v: unknown) => JSON.stringify(v);
function ragSpans(): Json[] {
  return [
    {
      span_id: "r",
      parent_span_id: null,
      name: "answer",
      start_time_unix_nano: NS,
      end_time_unix_nano: NS + 9e8,
      status: { code: "STATUS_CODE_OK" },
      attributes: {
        "mlflow.spanType": J("AGENT"),
        "mlflow.spanInputs": J({ question: "refund for bob@example.com?" }),
        "mlflow.spanOutputs": J("5 days [faq.md#1]"),
      },
    },
    {
      span_id: "q",
      parent_span_id: "r",
      name: "retrieve",
      start_time_unix_nano: NS + 1e7,
      end_time_unix_nano: NS + 5e7,
      status: { code: "STATUS_CODE_OK" },
      attributes: {
        "mlflow.spanType": J("RETRIEVER"),
        "mlflow.spanInputs": J({ query: "refund" }),
        "mlflow.spanOutputs": J([
          { page_content: "Refunds take 5 days.", metadata: { doc_uri: "faq.md", chunk_id: "1" } },
        ]),
        "ablationkit.rag.index_revision": J("idx-1"),
      },
    },
    {
      span_id: "t",
      parent_span_id: "r",
      name: "lookup_order",
      start_time_unix_nano: NS + 6e7,
      end_time_unix_nano: NS + 8e7,
      status: { code: "STATUS_CODE_ERROR", message: "timeout" },
      attributes: { "mlflow.spanType": J("TOOL"), "mlflow.spanInputs": J({ order: 7 }) },
      events: [
        {
          name: "exception",
          attributes: { "exception.type": "TimeoutError", "exception.message": "timeout" },
        },
      ],
    },
    {
      span_id: "g",
      parent_span_id: "r",
      name: "generate",
      start_time_unix_nano: NS + 1e8,
      end_time_unix_nano: NS + 8.9e8,
      status: { code: "STATUS_CODE_OK" },
      attributes: {
        "mlflow.spanType": J("CHAT_MODEL"),
        "mlflow.spanInputs": J({
          messages: [{ role: "user", content: "key sk-abcdefghijklmnopqrstuv" }],
        }),
        "mlflow.spanOutputs": J("5 days [faq.md#1]"),
        "mlflow.chat.tokenUsage": J({ input_tokens: 40, output_tokens: 5, total_tokens: 45 }),
      },
    },
  ];
}

describe("prompt registry (criteria 10, 10a)", () => {
  test("versions, chat templates, variables, diffs, aliases pinned to exact versions, project scoping, agent proposals but no aliases", async () => {
    const w = await setup();
    await project(w);
    await prompts(w);
    const list = (await w.call(`${P}/prompts`)).body.prompts;
    expect(list.map((p: Json) => [p.name, p.latest_version])).toEqual([["faq", 2]]);
    const p = (await w.call(`${P}/prompts/faq`)).body.prompt;
    expect(p.versions.map((v: Json) => [v.version, v.format, v.variables, v.aliases])).toEqual([
      [2, "chat", ["question"], []],
      [1, "chat", ["question"], ["champion"]],
    ]);
    const d = (await w.call(`${P}/prompts/faq/diff?from=1&to=2`)).body;
    expect(d.diff.blocks[0].lines).toEqual([
      { op: "del", text: "Be terse." },
      { op: "add", text: "Be friendly." },
    ]);
    // An alias resolves to the exact version now, and both are recorded.
    const r = (await w.call(`${P}/prompts/resolve?ref=faq@champion`)).body;
    expect(r.pinned).toMatchObject({ name: "faq", version: 1, alias: "champion", format: "chat" });
    expect(r.pinned.template_sha256).toMatch(/^[a-f0-9]{64}$/);
    // MLflow keeps prompts out of the model registry listing.
    expect((await w.call("/api/v1/projects/rag/registry")).body.models ?? []).toEqual([]);
    // Agents read and propose versions; moving an alias is a researcher's call.
    expect((await w.agent(`${P}/prompts/faq`)).status).toBe(200);
    const proposed = await w.agent(`${P}/prompts`, {
      body: { name: "faq", template: "Q: {{question}}" },
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body.version.tags["ablationkit.created_by"]).toBe("agent");
    expect(
      (await w.agent(`${P}/prompts/faq/alias`, { body: { alias: "champion", version: 3 } })).status,
    ).toBe(404);
    // The checkout export lets project jobs resolve prompts without MLflow access.
    const exported = JSON.parse(
      readFileSync(
        join(w.svc().registry.require("rag").path, ".ablationkit/llm/prompts/faq.json"),
        "utf8",
      ),
    );
    expect(exported.aliases).toEqual({ champion: 1 });
    expect(Object.keys(exported.versions)).toEqual(["1", "2", "3"]);
    // Another project does not see it, and cannot take the name.
    expect(
      (await w.call("/api/v1/projects", { body: { path: h.repo("other"), project_id: "other" } }))
        .status,
    ).toBe(201);
    expect((await w.call("/api/v1/projects/other/llm/prompts")).body.prompts).toEqual([]);
    expect((await w.call("/api/v1/projects/other/llm/prompts/faq")).status).toBe(404);
    expect(
      (await w.call("/api/v1/projects/other/llm/prompts", { body: { name: "faq", template: "x" } }))
        .status,
    ).toBe(409);
  });
});

describe("golden sets (criteria 10, 10a)", () => {
  test("immutable hashed versions, categories and edge cases, held-out guard, export without held-out expectations, MLflow mirror, tamper detection", async () => {
    const w = await setup();
    const path = await project(w);
    const c = await w.call(`${P}/golden-sets`, {
      body: { name: "faq-golden", held_out: true, from_file: "golden.jsonl" },
    });
    expect(c.status).toBe(201);
    const gs = c.body.golden_set;
    expect(gs.versions[0]).toMatchObject({
      version: 1,
      examples: 3,
      categories: { billing: 1, shipping: 1, account: 1 },
      edge_cases: 1,
      missing_expectations: 1,
    });
    // Mirrored into an MLflow GenAI dataset (best effort, asynchronous).
    const mirrored = await until(
      async () =>
        (await w.call(`${P}/golden-sets/${gs.golden_set_id}`)).body.golden_set.versions[0]
          .mlflow_dataset_id,
    );
    expect(w.fake.datasetRecords(mirrored)).toHaveLength(3);
    // A new version is a new file; identical content is refused.
    expect(
      (
        await w.call(`${P}/golden-sets/faq-golden/versions`, {
          body: { from_file: "golden.jsonl" },
        })
      ).status,
    ).toBe(409);
    const v2 = await w.call(`${P}/golden-sets/faq-golden/versions`, {
      body: { examples: [{ example_id: "e1", inputs: { question: "refunds?" } }], note: "smaller" },
    });
    expect(v2.body.golden_set.versions.map((v: Json) => [v.version, v.parent_version])).toEqual([
      [1, undefined],
      [2, 1],
    ]);
    // Agents cannot create held-out sets or change them, and do not see their expectations.
    expect(
      (
        await w.agent(`${P}/golden-sets`, {
          body: { name: "x", held_out: true, examples: [{ inputs: { q: 1 } }] },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await w.agent(`${P}/golden-sets/faq-golden/versions`, {
          body: { examples: [{ inputs: { q: 1 } }] },
        })
      ).body.error.code,
    ).toBe("held_out_guarded");
    const seen = (await w.agent(`${P}/golden-sets/faq-golden/examples?version=1`)).body;
    expect(seen.expectations_hidden).toBe(true);
    expect(seen.examples.every((e: Json) => e.expectations === undefined)).toBe(true);
    expect(
      (await w.call(`${P}/golden-sets/faq-golden/examples?version=1`)).body.examples[0]
        .expectations,
    ).toEqual({ expected_response: "5 days" });
    // An agent may build a non-held-out set.
    expect(
      (
        await w.agent(`${P}/golden-sets`, {
          body: { name: "scratch", examples: [{ inputs: { question: "a" } }] },
        })
      ).status,
    ).toBe(201);
    // Export: held-out sets carry inputs only.
    const idx = JSON.parse(
      readFileSync(join(path, ".ablationkit/llm/golden-sets/index.json"), "utf8"),
    );
    expect(idx.sets.find((s: Json) => s.name === "faq-golden" && s.version === 1)).toMatchObject({
      inputs_only: true,
      examples: 3,
    });
    expect(
      readFileSync(join(path, ".ablationkit/llm/golden-sets/faq-golden/v1.jsonl"), "utf8"),
    ).not.toContain("expected_response");
    expect(
      readFileSync(join(path, ".ablationkit/llm/golden-sets/scratch/v1.jsonl"), "utf8"),
    ).toContain("ex-0001");
    // Invalid rows are reported per index.
    const bad = await w.call(`${P}/golden-sets`, {
      body: { name: "bad", examples: [{ inputs: {} }, { example_id: "a b", inputs: { q: 1 } }] },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.issues.map((i: Json) => i.index)).toEqual([0, 1]);
    // Tampering with a pinned version is detected on read.
    const f = join(
      w.svc().paths.stateDir,
      "rag",
      "llm",
      "golden-sets",
      gs.golden_set_id,
      "v2.jsonl",
    );
    const { chmodSync } = await import("node:fs");
    chmodSync(f, 0o600);
    writeFileSync(f, '{"example_id":"e1","inputs":{"question":"changed"}}\n');
    expect((await w.call(`${P}/golden-sets/faq-golden/examples?version=2`)).body.error.code).toBe(
      "golden_set_corrupt",
    );
  });
});

describe("traces (criteria 10, 10b, 10c, 10e)", () => {
  test("job traces get the capture policy before the outbox; search, span tree, RAG and tool views, read-time redaction, feedback, links, retention", async () => {
    const w = await setup();
    await project(w);
    const s = w.svc();
    // A job's trace.logged payload: redacted under the default policy, tagged, ready for the outbox.
    const prepared = (await extensionLlm(s).traces.prepareJobTrace(
      "rag",
      {
        trace: {
          trace_id: `tr-${"a".repeat(32)}`,
          name: "answer",
          request_time: new Date().toISOString(),
          duration_ms: 900,
          state: "OK",
          spans: ragSpans(),
          tags: { "ablationkit.example_id": "e1", "other.tag": "x" },
          metadata: { "mlflow.traceInputs": "bob@example.com" },
        },
      },
      { attempt_id: "a-1", job_id: "j-1" },
    )) as Json;
    expect(prepared.tags).toMatchObject({
      "ablationkit.project": "rag",
      "ablationkit.source": "job",
      "ablationkit.job": "j-1",
      "ablationkit.capture": "redacted",
      "ablationkit.example_id": "e1",
    });
    expect(prepared.tags["other.tag"]).toBeUndefined();
    expect(JSON.stringify(prepared.spans)).not.toContain("bob@example.com");
    expect(JSON.stringify(prepared.spans)).toContain("[REDACTED:secret]");
    expect(prepared.metadata["mlflow.traceInputs"]).toBe("[REDACTED:email]");
    await expect(
      extensionLlm(s).traces.prepareJobTrace(
        "rag",
        { trace: { trace_id: "bad", spans: [] } },
        { attempt_id: "a", job_id: "j" },
      ),
    ).rejects.toThrow();
    // A remote attempt's trace: bodies are dropped unless capture.remote_capture is on (ADR 0023).
    const remote = (await extensionLlm(s).traces.prepareJobTrace(
      "rag",
      {
        trace: {
          trace_id: `tr-${"b".repeat(32)}`,
          name: "answer",
          request_time: new Date().toISOString(),
          duration_ms: 900,
          state: "OK",
          spans: ragSpans(),
        },
      },
      { attempt_id: "a-2", job_id: "j-2", remote: true },
    )) as Json;
    expect(remote.tags["ablationkit.capture"]).toBe("metadata_only");
    expect(JSON.stringify(remote.spans)).not.toContain("refund for");

    // Written traces (as the outbox would) are searchable and inspectable.
    const id = (await extensionLlm(s).traces.write("rag", {
      name: "answer",
      spans: ragSpans(),
      state: "ERROR",
      request_time: new Date().toISOString(),
      duration_ms: 900,
      tags: { "ablationkit.example_id": "e1", "ablationkit.source": "job" },
    })) as string;
    await extensionLlm(s).traces.write("rag", {
      name: "other",
      spans: ragSpans().slice(0, 1),
      state: "OK",
      request_time: new Date(Date.now() - 5000).toISOString(),
      duration_ms: 10,
      tags: {},
    });
    const errs = (await w.call(`${P}/traces?status=ERROR&clusters=1`)).body;
    expect(errs.traces.map((t: Json) => t.trace_id)).toEqual([id]);
    expect(errs.clusters).toEqual([
      { span: "lookup_order", error_type: "TimeoutError", count: 1, trace_ids: [id] },
    ]);
    expect((await w.call(`${P}/traces?example_id=e1`)).body.traces).toHaveLength(1);
    expect((await w.call(`${P}/traces?name=a'b`)).status).toBe(400);
    const d = (await w.call(`${P}/traces/${id}`)).body;
    expect(d.spans.map((x: Json) => `${x.depth}:${x.kind}:${x.name}`)).toEqual([
      "0:agent:answer",
      "1:retrieval:retrieve",
      "1:tool:lookup_order",
      "1:llm:generate",
    ]);
    expect(d.usage).toEqual({
      input_tokens: 40,
      output_tokens: 5,
      total_tokens: 45,
      reported: 1,
      missing: 0,
    });
    expect(d.rag.retrievals[0].documents[0]).toMatchObject({ doc_uri: "faq.md", chunk_id: "1" });
    expect(d.rag.index_revision).toEqual({ available: true, value: "idx-1" });
    expect(d.rag.retrieval_config.available).toBe(false);
    expect(d.tools[0]).toMatchObject({ name: "lookup_order", error: { type: "TimeoutError" } });
    expect(d.errors[0]).toMatchObject({ name: "lookup_order", type: "TimeoutError" });
    // Stored redacted (bodies with an email or key never reached MLflow in clear text).
    const stored = JSON.stringify(w.fake.allTraces().find((t) => t.info["trace_id"] === id)?.spans);
    expect(stored).not.toContain("bob@example.com");
    expect(stored).not.toContain("sk-abcdefghijklmnopqrstuv");
    // Tightening the policy hides bodies captured under the old one on every read.
    expect(
      (
        await w.call(`${P}/settings`, {
          method: "PUT",
          body: { capture: { mode: "metadata_only" } },
        })
      ).status,
    ).toBe(200);
    const d2 = (await w.call(`${P}/traces/${id}`)).body;
    expect(d2.capture).toEqual({ now: "metadata_only", recorded_under: "redacted" });
    expect(d2.spans.every((x: Json) => x.inputs === undefined && x.outputs === undefined)).toBe(
      true,
    );
    expect(d2.rag.retrievals[0].bodies_omitted).toBe(true);
    expect(d2.usage.total_tokens).toBe(45);
    // Researcher feedback is an MLflow assessment; agents cannot add it.
    const fb = await w.call(`${P}/traces/${id}/feedback`, {
      body: { name: "grounded", value: false, rationale: "cites the wrong chunk", span_id: "q" },
    });
    expect(fb.status).toBe(200);
    expect((await w.call(`${P}/traces/${id}`)).body.assessments[0]).toMatchObject({
      name: "grounded",
      value: false,
      source: { source_type: "HUMAN" },
    });
    expect(
      (await w.agent(`${P}/traces/${id}/feedback`, { body: { name: "x", value: true } })).status,
    ).toBe(404);
    // Linking to a note references the trace ID; no span data is copied.
    const note = (
      await w.call("/api/v1/projects/rag/research", {
        body: { kind: "note", title: "RAG failure" },
      })
    ).body.record;
    expect(
      (
        await w.agent(`${P}/traces/${id}/link`, {
          body: { to: { kind: "note", id: note.record_id } },
        })
      ).status,
    ).toBe(200);
    const linked = (await w.call(`/api/v1/projects/rag/research/${note.record_id}`)).body.record;
    expect(linked.links).toEqual([{ kind: "trace", id }]);
    expect((await w.call(`${P}/traces/${id}`)).body.links.research).toEqual([
      { kind: "note", id: note.record_id, title: "RAG failure" },
    ]);
    // Another project's trace is not reachable.
    expect(
      (await w.call("/api/v1/projects", { body: { path: h.repo("o2"), project_id: "o2" } })).status,
    ).toBe(201);
    expect((await w.call(`/api/v1/projects/o2/llm/traces/${id}`)).status).toBe(404);
    // Retention deletes old traces from the project's own experiment.
    await w.call(`${P}/settings`, { method: "PUT", body: { capture: { retention_days: 1 } } });
    const old = extensionLlm(s).traces;
    await extensionLlm(s).traces.write("rag", {
      name: "ancient",
      spans: ragSpans().slice(0, 1),
      state: "OK",
      request_time: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      duration_ms: 1,
      tags: {},
    });
    expect(await old.sweep(["rag"])).toEqual({ rag: 1 });
    expect(
      w.fake
        .allTraces()
        .map((t) => t.tags["mlflow.traceName"])
        .sort(),
    ).toEqual(["answer", "other"]);
    await auditHas(w, "llm.trace.retention");
  });
});

describe("data controls (criterion 10e)", () => {
  test("external egress needs the researcher's explicit approval, datasets need dataset egress, capture off writes nothing, keys stay in the environment", async () => {
    const llm = fakeLlm();
    const w = await setup();
    await project(w, llm.url);
    await prompts(w);
    const external = {
      provider_id: "hosted",
      base_url: "https://llm.example.com/v1",
      api_key_env: "AK_TEST_HOSTED_KEY",
      models: ["big"],
    };
    // Adding an external provider is fine; using it is refused until egress is approved.
    const cur = (await w.call(`${P}/settings`)).body.settings;
    const add = await w.call(`${P}/settings`, {
      method: "PUT",
      body: { providers: [...cur.providers, external] },
    });
    expect(add.status).toBe(200);
    expect(add.body.settings.providers[1]).toMatchObject({
      locality: "external",
      api_key_present: false,
    });
    const run = (provider_id: string, model: string, extra: Json = {}) =>
      w.call(`${P}/playground`, {
        body: {
          variants: [{ label: "a", prompt: "faq@champion", provider_id, model }],
          inputs: [{ question: "hi" }],
          ...extra,
        },
      });
    expect((await run("hosted", "big")).body.error.code).toBe("egress_not_approved");
    // Approving egress widens the controls: refused on the ordinary route, with the reason listed.
    const approve = {
      providers: [
        cur.providers[0],
        { ...external, egress: { allow_datasets: false, note: "public prompts only" } },
      ],
    };
    const refused = await w.call(`${P}/settings`, { method: "PUT", body: approve });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("widening_requires_confirmation");
    expect(refused.body.error.widening).toEqual([
      "egress to hosted (https://llm.example.com/v1) approved",
    ]);
    // The widening route is the researcher's explicit request (session only, ADR 0037); an agent
    // cannot send it.
    expect([403, 404]).toContain((await w.agent(`${P}/settings/widen`, { body: approve })).status);
    // Capturing more is also a widening.
    expect(
      (await w.call(`${P}/settings`, { method: "PUT", body: { capture: { mode: "full" } } })).body
        .error.widening,
    ).toEqual(["capture redacted → full"]);
    expect(
      (
        await w.call(`${P}/settings`, {
          method: "PUT",
          body: { capture: { builtin_redactions: [] } },
        })
      ).body.error.widening,
    ).toEqual(["redaction email removed", "redaction secret removed"]);
    // With the approval in place, datasets still need dataset egress.
    expect((await w.call(`${P}/settings/widen`, { body: approve })).status).toBe(200);
    expect((await run("hosted", "big")).body.error.code).toBe("api_key_missing");
    const gs = await w.call(`${P}/golden-sets`, { body: { name: "g", from_file: "golden.jsonl" } });
    expect(gs.status).toBe(201);
    const withSet = await w.call(`${P}/playground`, {
      body: {
        variants: [{ label: "a", prompt: "faq/1", provider_id: "hosted", model: "big" }],
        golden_set: { id: "g" },
      },
    });
    expect(withSet.body.error.code).toBe("dataset_egress_not_approved");
    expect(llm.seen).toHaveLength(0);
    // Unlisted models and providers are refused; nothing was sent anywhere.
    expect((await run("local", "gpt-9")).body.error.code).toBe("model_not_allowed");
    expect((await run("nope", "echo")).body.error.code).toBe("unknown_provider");
    // Capture off: the playground runs but writes no trace.
    await w.call(`${P}/settings`, { method: "PUT", body: { capture: { mode: "off" } } });
    const before = w.fake.allTraces().length;
    const r = await run("local", "echo");
    expect(r.status).toBe(200);
    expect(r.body.result.capture).toBe("off");
    expect(w.fake.allTraces().length).toBe(before);
    // Settings never store a key, only the variable name.
    const raw = readFileSync(join(w.svc().paths.stateDir, "rag", "llm", "settings.json"), "utf8");
    expect(raw).toContain("AK_TEST_HOSTED_KEY");
    await auditHas(w, "llm.settings.widen");
  });
});

describe("playground (criteria 10a, 10e)", () => {
  test("two pinned variants on the same ordered inputs: aligned outputs, traces, usage only where reported, labelled cost estimates, saved evidence with provenance", async () => {
    const llm = fakeLlm();
    const w = await setup();
    await project(w, llm.url);
    await prompts(w);
    expect(
      (await w.call(`${P}/golden-sets`, { body: { name: "g", from_file: "golden.jsonl" } })).status,
    ).toBe(201);
    // A prompt variable the inputs do not fill is refused before any call.
    const missing = await w.call(`${P}/playground`, {
      body: {
        variants: [{ label: "x", template: "{{nope}}", provider_id: "local", model: "echo" }],
        inputs: [{ question: "a" }],
      },
    });
    expect(missing.body.error.code).toBe("missing_variables");
    expect(llm.seen).toHaveLength(0);
    const r = await w.call(`${P}/playground`, {
      body: {
        golden_set: { id: "g", version: 1 },
        variants: [
          {
            label: "terse",
            prompt: "faq@champion",
            provider_id: "local",
            model: "echo",
            params: { temperature: "0.2", seed: 7, max_tokens: 64 },
          },
          {
            label: "friendly",
            prompt: { name: "faq", version: 2 },
            provider_id: "local",
            model: "echo-nousage",
          },
        ],
      },
    });
    expect(r.status).toBe(200);
    const res = r.body.result;
    expect(
      res.variants.map((v: Json) => [v.label, v.prompt.version, v.prompt.alias ?? null]),
    ).toEqual([
      ["terse", 1, "champion"],
      ["friendly", 2, null],
    ]);
    expect(res.rows.map((x: Json) => x.example_id)).toEqual(["e1", "e2", "e3"]);
    expect(res.rows[0].cells.terse.output).toBe("refunds?");
    expect(res.rows[0].cells.friendly.output).toBe("Sure! refunds?");
    expect(res.rows[0].differs).toBe(true);
    expect(res.rows[0].expectations).toEqual({ expected_response: "5 days" });
    // Decoding parameters went to the provider as numbers.
    expect(llm.seen[0]).toMatchObject({ temperature: 0.2, seed: 7, max_tokens: 64 });
    // Usage only where reported; cost only with a rate, and labelled as an estimate.
    expect(res.summary.terse.usage).toEqual({
      input_tokens: 36,
      output_tokens: 9,
      total_tokens: 45,
      reported: 3,
      missing: 0,
    });
    expect(res.summary.terse.cost).toMatchObject({
      estimated_usd: "0.0000315",
      rate_source: "test rate card",
      rate_version: "2026-11",
      partial: false,
    });
    expect(res.summary.friendly.usage).toEqual({ reported: 0, missing: 3 });
    expect(res.summary.friendly.cost).toBeUndefined();
    expect(res.summary.friendly.cost_unavailable).toBe("the provider reported no token usage");
    // Every call is a trace with the variant, example, prompt and golden-set tags.
    expect(res.traces_written).toBe(6);
    const traces = (await w.call(`${P}/traces?variant=terse`)).body.traces;
    expect(traces).toHaveLength(3);
    expect(traces[0].tags).toMatchObject({
      "ablationkit.source": "playground",
      "ablationkit.prompt": "faq/1",
      "ablationkit.model": "echo",
    });
    // Exploration is transient: nothing in MLflow runs until saved.
    expect(w.fake.allRuns()).toHaveLength(0);
    // Ad-hoc templates can be explored but not saved as evidence.
    const adhoc = (
      await w.call(`${P}/playground`, {
        body: {
          variants: [
            { label: "x", template: "Q {{question}}", provider_id: "local", model: "echo" },
          ],
          inputs: [{ question: "a" }],
        },
      })
    ).body.result;
    expect(
      (await w.call(`${P}/playground/${adhoc.result_id}/save`, { body: {} })).body.error.code,
    ).toBe("unpinned_prompt");
    const note = (
      await w.call("/api/v1/projects/rag/research", {
        body: { kind: "note", title: "prompt study" },
      })
    ).body.record;
    const saved = await w.call(`${P}/playground/${res.result_id}/save`, {
      body: { title: "terse vs friendly", link: { kind: "note", id: note.record_id } },
    });
    expect(saved.status).toBe(201);
    const ev = saved.body.evidence;
    expect(ev).toMatchObject({
      kind: "playground",
      examples: 3,
      golden_set: { version: 1 },
      stored: ["inputs", "outputs", "expectations", "usage", "timings", "variants", "provenance"],
    });
    expect(ev.trace_ids).toHaveLength(6);
    const run = w.fake.run(ev.mlflow_run_id);
    expect(run?.tags.get("ablationkit.prompts")).toBe("faq/1,faq/2");
    expect(
      JSON.parse(new TextDecoder().decode(run?.artifacts.get("ablationkit/llm/playground.json")))
        .targets[0].prompt,
    ).toMatchObject({ name: "faq", version: 1, alias: "champion" });
    expect(
      (await w.call(`/api/v1/projects/rag/research/${note.record_id}`)).body.record.links,
    ).toContainEqual({ kind: "llm_evidence", id: ev.evidence_id, label: "terse vs friendly" });
    expect(
      (await w.call(`${P}/playground/${res.result_id}/save`, { body: {} })).body.error.code,
    ).toBe("already_saved");
    expect((await w.agent(`${P}/evidence/${ev.evidence_id}`)).status).toBe(200);
    expect((await w.agent(`${P}/playground`, { body: {} })).status).toBe(404);
    const del = await w.call(`${P}/evidence/${ev.evidence_id}`, { method: "DELETE" });
    expect(del.body.evidence.deleted_at).toBeDefined();
    expect(w.fake.run(ev.mlflow_run_id)?.info.lifecycle_stage).toBe("deleted");
  });
});

describe("GenAI evaluation (criteria 10, 10a, 10b, 10c)", () => {
  test("pinned targets over a golden-set version: runs, traces, aligned examples, regressions, comparison, held-out expectations hidden from agents, flags and a linked report", async () => {
    const llm = fakeLlm();
    const w = await setup();
    await project(w, llm.url);
    await prompts(w);
    const gs = (
      await w.call(`${P}/golden-sets`, {
        body: { name: "g", held_out: true, from_file: "golden.jsonl" },
      })
    ).body.golden_set;
    const body = {
      golden_set: { id: "g" },
      targets: [
        {
          label: "terse",
          prompt: "faq@champion",
          provider_id: "local",
          model: "echo",
          params: { temperature: "0" },
        },
        { label: "friendly", prompt: "faq/2", provider_id: "local", model: "echo-nousage" },
      ],
      scorers: [
        { name: "exact", builtin: "exact_match" },
        {
          name: "grounded",
          judge: {
            provider_id: "local",
            model: "echo",
            rubric: "Is every claim supported by the retrieved passages?",
            uses: "grounding",
          },
        },
      ],
    };
    // Validation before anything runs: budget, scorer kinds, project code acknowledgement.
    expect(
      (await w.call(`${P}/evaluations`, { body: { ...body, max_calls: 5 } })).body.error,
    ).toMatchObject({ code: "call_budget_exceeded", calls: 12 });
    expect(
      (
        await w.call(`${P}/evaluations`, {
          body: {
            ...body,
            scorers: [{ name: "p", project: { path: "evals/scorers.py", function: "polite" } }],
          },
        })
      ).body.error.code,
    ).toBe("project_code_acknowledgement_required");
    expect(
      (
        await w.call(`${P}/evaluations`, {
          body: { ...body, scorers: [{ name: "x", builtin: "vibes" }] },
        })
      ).status,
    ).toBe(400);
    expect((await w.agent(`${P}/evaluations`, { body })).status).toBe(404);
    const c = await w.call(`${P}/evaluations`, {
      body: {
        ...body,
        scorers: [
          ...body.scorers,
          { name: "polite", project: { path: "evals/scorers.py", function: "polite" } },
        ],
        acknowledge_project_code: true,
      },
    });
    expect(c.status).toBe(201);
    const ev = c.body.evaluation;
    expect(ev.targets[0].prompt).toMatchObject({ name: "faq", version: 1, alias: "champion" });
    expect(ev.golden_set).toMatchObject({
      golden_set_id: gs.golden_set_id,
      version: 1,
      sha256: gs.versions[0].sha256,
      held_out: true,
      examples: 3,
    });
    expect(ev.scorers[1].judge).toMatchObject({
      provider_id: "local",
      model: "echo",
      locality: "local",
      uses: "grounding",
    });
    expect(ev.scorers[1].judge.rubric_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ev.scorers[2].project.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ev.retention).toMatchObject({ capture: "redacted", retention_days: 30 });
    expect(ev.egress).toEqual([
      { provider_id: "local", locality: "local", purpose: "generation" },
      { provider_id: "local", locality: "local", purpose: "judge" },
    ]);
    const done = await until(async () => {
      const r = (await w.call(`${P}/evaluations/${ev.evaluation_id}`)).body.evaluation;
      return r.state === "succeeded" || r.state === "failed" ? r : undefined;
    });
    expect(done.state).toBe("succeeded");
    expect(done.results[0]).toMatchObject({
      label: "terse",
      metrics: { "exact/mean": "0.5" },
      usage: { reported: 3, missing: 0, total_tokens: 42 },
    });
    expect(done.results[0].cost.estimated_usd).toBe("0.000033");
    expect(done.results[1].usage).toEqual({ reported: 0, missing: 3 });
    expect(done.results[1].cost).toBeUndefined();
    // MLflow: one run per target, with the pinned prompt and golden set; traces carry the evaluation.
    const run = w.fake.run(done.results[0].run_id);
    expect(run?.tags.get("ablationkit.prompt")).toBe("faq/1");
    expect(run?.tags.get("ablationkit.golden_sha256")).toBe(gs.versions[0].sha256);
    expect(run?.info.status).toBe("FINISHED");
    const traces = (await w.call(`${P}/traces?evaluation=${ev.evaluation_id}`)).body.traces;
    expect(traces).toHaveLength(6);
    // Per-example: aligned rows, regressions against the first target, missing ground truth surfaced.
    const ex = (await w.call(`${P}/evaluations/${ev.evaluation_id}/examples`)).body;
    expect(ex.rows.map((r: Json) => r.example_id)).toEqual(["e1", "e2", "e3"]);
    expect(ex.rows[0].cells.terse.trace_id).toMatch(/^tr-/);
    expect(ex.rows[2].missing_expectations).toBe(true);
    expect(ex.rows[2].cells.terse.scores.exact.error).toContain("missing ground truth");
    expect(ex.rows[0].expectations).toEqual({ expected_response: "5 days" });
    expect(ex.slices.terse).toMatchObject({ billing: { n: 1 }, shipping: { n: 1 } });
    // A failed example links to its trace (and the trace back to the evaluation and example).
    const failing = ex.rows[1].cells.terse;
    const tr = (await w.call(`${P}/traces/${failing.trace_id}`)).body;
    expect(tr.links).toMatchObject({
      evaluation_id: ev.evaluation_id,
      example_id: "e2",
      variant: "terse",
    });
    // Agents read results, but held-out expectations stay hidden.
    const agentView = (await w.agent(`${P}/evaluations/${ev.evaluation_id}/examples`)).body;
    expect(agentView.expectations_hidden).toBe(true);
    expect(agentView.rows.every((r: Json) => r.expectations === undefined)).toBe(true);
    // A second evaluation on the same version compares example by example (paired), no invented significance.
    const c2 = await w.call(`${P}/evaluations`, {
      body: { ...body, targets: [body.targets[1]], scorers: [body.scorers[0]] },
    });
    await until(
      async () =>
        (await w.call(`${P}/evaluations/${c2.body.evaluation.evaluation_id}`)).body.evaluation
          .state === "succeeded",
    );
    const cmp = (
      await w.call(
        `${P}/evaluations/compare?a=${ev.evaluation_id}&b=${c2.body.evaluation.evaluation_id}`,
      )
    ).body;
    expect(cmp.paired).toBe(true);
    expect(cmp.significance).toContain("not computed");
    expect(cmp.rows).toHaveLength(3);
    // Flag an important failure: a human assessment on its MLflow trace.
    const flag = await w.call(`${P}/evaluations/${ev.evaluation_id}/flag`, {
      body: { example_id: "e2", label: "terse", note: "wrong policy" },
    });
    expect(flag.status).toBe(200);
    expect((await w.call(`${P}/traces/${failing.trace_id}`)).body.assessments.at(-1)).toMatchObject(
      { name: "ablationkit.flag", value: "important_failure", rationale: "wrong policy" },
    );
    // The report links prompt versions, the golden set, runs and failing traces; no spans are copied.
    const rep = await w.agent(`${P}/evaluations/${ev.evaluation_id}/report`, { body: {} });
    expect(rep.status).toBe(201);
    const links = rep.body.report.links.map((l: Json) => `${l.kind}:${l.id}`);
    expect(links).toContain(`llm_evaluation:${ev.evaluation_id}`);
    expect(links).toContain(`golden_set:${gs.golden_set_id}/1`);
    expect(links).toContain("prompt_version:faq/1");
    expect(links).toContain(`run:${done.results[0].run_id}`);
    expect(links).toContain(`trace:${failing.trace_id}`);
    expect(rep.body.report.body).toContain("A judge's verdict is an opinion, not ground truth.");
    expect(rep.body.report.body).not.toContain("refunds?");
    await auditHas(w, "llm.evaluation.create");
  });

  test("recorded RAG traces are scored where they are; unmatched runs are refused; a failed or interrupted evaluation is never rerun", async () => {
    const llm = fakeLlm();
    const w = await setup();
    await project(w, llm.url);
    await w.call(`${P}/golden-sets`, { body: { name: "g", from_file: "golden.jsonl" } });
    const s = w.svc();
    const exp = await s.tracking.ensureExperimentNow("rag");
    const job = (await s.tracking.client.createRun({ experiment_id: exp, run_name: "rag job" }))
      .info.run_id;
    const empty = (await s.tracking.client.createRun({ experiment_id: exp, run_name: "nothing" }))
      .info.run_id;
    for (const e of ["e1", "e2"])
      await extensionLlm(s).traces.write("rag", {
        name: "answer",
        spans: ragSpans(),
        state: "OK",
        request_time: new Date().toISOString(),
        duration_ms: 900,
        run_id: job,
        tags: { "ablationkit.example_id": e },
      });
    const scorers = [{ name: "recall", builtin: "retrieval_recall" }];
    expect(
      (
        await w.call(`${P}/evaluations`, {
          body: {
            golden_set: { id: "g" },
            targets: [{ label: "rag", recorded: { run_id: empty } }],
            scorers,
          },
        })
      ).body.error.code,
    ).toBe("no_matching_traces");
    const c = await w.call(`${P}/evaluations`, {
      body: {
        golden_set: { id: "g" },
        targets: [{ label: "rag", recorded: { run_id: job } }],
        scorers,
      },
    });
    expect(c.status).toBe(201);
    expect(c.body.evaluation.targets[0]).toMatchObject({
      kind: "recorded",
      source_run_id: job,
      matched: 2,
    });
    const done = await until(async () => {
      const r = (await w.call(`${P}/evaluations/${c.body.evaluation.evaluation_id}`)).body
        .evaluation;
      return r.state === "succeeded" ? r : undefined;
    });
    expect(done.results[0].examples).toBe(2);
    expect(w.fake.allTraces()).toHaveLength(2);
    // Failure is recorded, runs are closed.
    w.config({ genai_fail: true });
    const f = (
      await w.call(`${P}/evaluations`, {
        body: {
          golden_set: { id: "g" },
          targets: [{ label: "rag", recorded: { run_id: job } }],
          scorers,
        },
      })
    ).body.evaluation;
    const failed = await until(async () => {
      const r = (await w.call(`${P}/evaluations/${f.evaluation_id}`)).body.evaluation;
      return r.state === "failed" ? r : undefined;
    });
    expect(failed.error).toContain("call budget");
    expect(w.fake.run(failed.results[0].run_id)?.info.status).toBe("FAILED");
    // A restart while one runs: interrupted, its run killed, nothing rerun.
    w.config({ sleep_ms: 60_000 });
    const home = w.svc().paths.home;
    const slow = (
      await w.call(`${P}/evaluations`, {
        body: {
          golden_set: { id: "g" },
          targets: [{ label: "rag", recorded: { run_id: job } }],
          scorers,
        },
      })
    ).body.evaluation;
    await until(
      async () =>
        (await w.call(`${P}/evaluations/${slow.evaluation_id}`)).body.evaluation.state ===
        "running",
    );
    await (h.coordinators.pop() as (typeof h.coordinators)[number]).stop();
    const w2 = await setup({ home, fake: w.fake, bridgeConfig: w.bridgeConfig });
    const after = (await w2.call(`${P}/evaluations/${slow.evaluation_id}`)).body.evaluation;
    expect(after.state).toBe("interrupted");
    expect(after.error).toContain("not rerun");
    await until(async () => w.fake.run(after.results[0].run_id)?.info.status === "KILLED");
    expect(existsSync(join(home, "state"))).toBe(true);
  });
});
