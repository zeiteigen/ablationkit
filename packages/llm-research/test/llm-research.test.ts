import { describe, expect, test } from "bun:test";
import {
  alignExamples,
  applyCapture,
  captureMetadata,
  checkPattern,
  clusterTraceErrors,
  diffPrompts,
  estimateCost,
  latencySummary,
  parsePromptRef,
  parseTemplate,
  providerLocality,
  type RawSpan,
  ragView,
  renderPrompt,
  spanViews,
  sumUsage,
  templateVariables,
  toolCalls,
} from "../src/index.ts";

const J = (v: unknown) => JSON.stringify(v);
const NS = 1_793_800_329_000_000_000;

/** A RAG + tool trace in MLflow's `traces.json` span format. */
function ragTrace(): RawSpan[] {
  return [
    {
      span_id: "root",
      parent_span_id: null,
      name: "answer",
      start_time_unix_nano: NS,
      end_time_unix_nano: NS + 900e6,
      status: { code: "STATUS_CODE_OK" },
      attributes: {
        "mlflow.spanType": J("AGENT"),
        "mlflow.spanInputs": J({ question: "How do refunds work? mail me at a.b@example.com" }),
        "mlflow.spanOutputs": J("Refunds take 5 days [faq.md#2]"),
      },
    },
    {
      span_id: "ret",
      parent_span_id: "root",
      name: "retrieve",
      start_time_unix_nano: NS + 10e6,
      end_time_unix_nano: NS + 60e6,
      status: { code: "STATUS_CODE_OK" },
      attributes: {
        "mlflow.spanType": J("RETRIEVER"),
        "mlflow.spanInputs": J({ query: "refunds" }),
        "mlflow.spanOutputs": J([
          {
            page_content: "Refunds take 5 days.",
            metadata: { doc_uri: "faq.md", chunk_id: "2", score: 0.91 },
          },
          {
            page_content: "Shipping is free.",
            metadata: { doc_uri: "faq.md", chunk_id: "7", score: 0.4 },
          },
        ]),
        "ablationkit.rag.index_revision": J("idx-2026-11-01"),
      },
    },
    {
      span_id: "tool1",
      parent_span_id: "root",
      name: "lookup_order",
      start_time_unix_nano: NS + 70e6,
      end_time_unix_nano: NS + 120e6,
      status: { code: "STATUS_CODE_ERROR", message: "timeout" },
      attributes: { "mlflow.spanType": J("TOOL"), "mlflow.spanInputs": J({ order: 42 }) },
      events: [
        {
          name: "exception",
          attributes: { "exception.type": "TimeoutError", "exception.message": "timeout" },
        },
      ],
    },
    {
      span_id: "tool2",
      parent_span_id: "root",
      name: "lookup_order",
      start_time_unix_nano: NS + 130e6,
      end_time_unix_nano: NS + 150e6,
      status: { code: "STATUS_CODE_OK" },
      attributes: {
        "mlflow.spanType": J("TOOL"),
        "mlflow.spanInputs": J({ order: 42 }),
        "mlflow.spanOutputs": J({ status: "shipped" }),
      },
    },
    {
      span_id: "llm",
      parent_span_id: "root",
      name: "generate",
      start_time_unix_nano: NS + 200e6,
      end_time_unix_nano: NS + 880e6,
      status: { code: "STATUS_CODE_OK" },
      attributes: {
        "mlflow.spanType": J("CHAT_MODEL"),
        "mlflow.spanInputs": J({
          messages: [{ role: "user", content: "key sk-abcdefghijklmnopqrstu" }],
        }),
        "mlflow.spanOutputs": J("Refunds take 5 days [faq.md#2]"),
        "mlflow.chat.tokenUsage": J({ input_tokens: 120, output_tokens: 12, total_tokens: 132 }),
        "ablationkit.llm.model": J("tiny-rag"),
      },
    },
  ];
}

describe("spans", () => {
  test("tree, waterfall offsets, kinds, errors and reported usage", () => {
    const v = spanViews(ragTrace());
    expect(v.map((s) => `${s.depth}:${s.name}`)).toEqual([
      "0:answer",
      "1:retrieve",
      "1:lookup_order",
      "1:lookup_order",
      "1:generate",
    ]);
    const llm = v.find((s) => s.span_id === "llm");
    expect(llm?.kind).toBe("llm");
    expect(llm?.offset_ms).toBeCloseTo(200, 0);
    expect(llm?.duration_ms).toBeCloseTo(680, 0);
    expect(llm?.usage).toEqual({ input_tokens: 120, output_tokens: 12, total_tokens: 132 });
    expect(llm?.model).toBe("tiny-rag");
    expect(v.find((s) => s.span_id === "tool1")?.error).toEqual({
      type: "TimeoutError",
      message: "timeout",
    });
    // Usage only where reported: the LLM span reports, nothing else is counted or estimated.
    const u = sumUsage(v.filter((s) => s.kind === "llm").map((s) => s.usage));
    expect(u).toEqual({
      input_tokens: 120,
      output_tokens: 12,
      total_tokens: 132,
      reported: 1,
      missing: 0,
    });
    expect(sumUsage([undefined, undefined])).toEqual({ reported: 0, missing: 2 });
  });

  test("an orphaned span becomes a root rather than disappearing", () => {
    const s = ragTrace();
    (s[1] as RawSpan).parent_span_id = "gone";
    expect(
      spanViews(s)
        .filter((x) => x.depth === 0)
        .map((x) => x.name),
    ).toEqual(["answer", "retrieve"]);
  });

  test("RAG view: query, chunks with ids and scores, generation, index revision recorded or unavailable", () => {
    const v = spanViews(ragTrace());
    const r = ragView(v);
    expect(r.instrumented).toBe(true);
    expect(r.query).toEqual({ query: "refunds" });
    expect(r.retrievals[0]?.documents.map((d) => `${d.doc_uri}#${d.chunk_id}@${d.score}`)).toEqual([
      "faq.md#2@0.91",
      "faq.md#7@0.4",
    ]);
    expect(r.generations[0]?.model).toBe("tiny-rag");
    expect(r.index_revision).toEqual({ available: true, value: "idx-2026-11-01" });
    expect(r.retrieval_config.available).toBe(false);
    const none = ragView(spanViews([ragTrace()[0] as RawSpan]));
    expect(none.instrumented).toBe(false);
    expect(none.index_revision).toEqual({
      available: false,
      reason: "no retrieval span in this trace",
    });
  });

  test("tool calls: retries and failure clusters from observed spans only", () => {
    const { calls, clusters } = toolCalls(spanViews(ragTrace()));
    expect(calls.map((c) => [c.attempt, c.retried, c.error?.type ?? null])).toEqual([
      [1, true, "TimeoutError"],
      [2, false, null],
    ]);
    expect(clusters).toEqual([
      { tool: "lookup_order", error_type: "TimeoutError", count: 1, span_ids: ["tool1"] },
    ]);
    expect(clusterTraceErrors([{ trace_id: "t1", spans: spanViews(ragTrace()) }])).toEqual([
      { span: "lookup_order", error_type: "TimeoutError", count: 1, trace_ids: ["t1"] },
    ]);
  });
});

describe("capture and redaction", () => {
  const base = {
    builtin_redactions: ["email", "secret"] as const,
    patterns: [{ name: "order", regex: "order [0-9]+" }],
  };

  test("redacted: emails, keys and project patterns inside JSON bodies", () => {
    const out = applyCapture(ragTrace(), {
      mode: "redacted",
      ...base,
      builtin_redactions: [...base.builtin_redactions],
    });
    const root = JSON.parse(out.spans[0]?.attributes?.["mlflow.spanInputs"] as string);
    expect(root.question).toBe("How do refunds work? mail me at [REDACTED:email]");
    const llm = out.spans.find((s) => s.span_id === "llm");
    expect(llm?.attributes?.["mlflow.spanInputs"]).toContain("[REDACTED:secret]");
    expect(out.redactions).toEqual({ email: 1, secret: 1 });
    // Token usage and the span type survive redaction.
    expect(llm?.attributes?.["mlflow.chat.tokenUsage"]).toContain("132");
  });

  test("metadata_only keeps structure, timings and usage, drops bodies and exception messages", () => {
    const out = applyCapture(ragTrace(), {
      mode: "metadata_only",
      builtin_redactions: [],
      patterns: [],
    });
    const v = spanViews(out.spans);
    expect(v.every((s) => s.inputs === undefined && s.outputs === undefined)).toBe(true);
    expect(v.find((s) => s.span_id === "ret")?.bodies_omitted).toBe(true);
    expect(v.find((s) => s.span_id === "llm")?.usage?.total_tokens).toBe(132);
    expect(v.find((s) => s.span_id === "tool1")?.error).toEqual({ type: "TimeoutError" });
    expect(out.dropped).toBeGreaterThan(5);
    expect(ragView(v).retrievals[0]?.documents).toEqual([]);
  });

  test("off writes nothing; full is untouched; metadata previews follow the mode", () => {
    expect(
      applyCapture(ragTrace(), { mode: "off", builtin_redactions: [], patterns: [] }).spans,
    ).toEqual([]);
    expect(
      applyCapture(ragTrace(), { mode: "full", builtin_redactions: ["email"], patterns: [] }).spans,
    ).toEqual(ragTrace());
    const md = { "mlflow.traceInputs": "x@y.io", "mlflow.sourceRun": "r1" };
    expect(
      captureMetadata(md, { mode: "redacted", builtin_redactions: ["email"], patterns: [] }),
    ).toEqual({
      "mlflow.traceInputs": "[REDACTED:email]",
      "mlflow.sourceRun": "r1",
    });
    expect(
      captureMetadata(md, { mode: "metadata_only", builtin_redactions: [], patterns: [] }),
    ).toEqual({
      "mlflow.sourceRun": "r1",
    });
  });

  test("bad patterns are reported", () => {
    expect(checkPattern("(")).toContain("not a valid");
    expect(checkPattern("a*")).toBe("matches the empty string");
    expect(checkPattern("TICKET-[0-9]+")).toBeUndefined();
  });
});

describe("prompts", () => {
  test("variables, rendering, missing variables and chat parsing", () => {
    const chat = parseTemplate(
      J([
        { role: "system", content: "Be {{tone}}" },
        { role: "user", content: "{{ question }}" },
      ]),
      "chat",
    );
    expect(templateVariables(chat)).toEqual(["question", "tone"]);
    expect(renderPrompt(chat, { question: "hi" })).toEqual({
      messages: [
        { role: "system", content: "Be " },
        { role: "user", content: "hi" },
      ],
      missing: ["tone"],
    });
    expect(renderPrompt("Q: {{q}}", { q: 3 }).messages).toEqual([
      { role: "user", content: "Q: 3" },
    ]);
    expect(parseTemplate("not json", "chat")).toBe("not json");
  });

  test("diffs: lines, roles, variables", () => {
    const d = diffPrompts(
      [
        { role: "system", content: "Be terse.\nCite sources." },
        { role: "user", content: "{{question}}" },
      ],
      [
        { role: "system", content: "Be friendly.\nCite sources." },
        { role: "user", content: "{{question}} ({{lang}})" },
      ],
    );
    expect(d.identical).toBe(false);
    expect(d.variables).toEqual({ added: ["lang"], removed: [], kept: ["question"] });
    expect(d.blocks[0]?.lines).toEqual([
      { op: "del", text: "Be terse." },
      { op: "add", text: "Be friendly." },
      { op: "same", text: "Cite sources." },
    ]);
    expect(diffPrompts("a\nb", "a\nb").identical).toBe(true);
  });

  test("references", () => {
    expect(parsePromptRef("qa@champion")).toEqual({ name: "qa", alias: "champion" });
    expect(parsePromptRef("prompts:/qa/3")).toEqual({ name: "qa", version: 3 });
    expect(parsePromptRef("qa@3")).toEqual({ name: "qa", version: 3 });
    expect(parsePromptRef("qa")).toEqual({ name: "qa" });
    expect(parsePromptRef("qa/latest")).toBeUndefined();
  });
});

describe("measurement", () => {
  test("cost: only with a rate and reported usage, labelled as an estimate", () => {
    const rate = {
      model: "m",
      input_usd_per_mtok: "0.5",
      output_usd_per_mtok: "1.5",
      source: "https://example.com/pricing",
      version: "2026-10",
    };
    expect(
      estimateCost({ input_tokens: 2000, output_tokens: 1000, reported: 3, missing: 1 }, rate),
    ).toEqual({
      estimated_usd: "0.0025",
      basis: "2000 input + 1000 output tokens at m rates (0.5 / 1.5 USD per million)",
      rate_source: "https://example.com/pricing",
      rate_version: "2026-10",
      partial: true,
    });
    expect(estimateCost({ reported: 0, missing: 4 }, rate)).toBeUndefined();
    expect(estimateCost({ input_tokens: 10, reported: 1, missing: 0 }, undefined)).toBeUndefined();
  });

  test("locality", () => {
    expect(providerLocality("http://127.0.0.1:11434/v1")).toBe("local");
    expect(providerLocality("http://localhost:8000/v1")).toBe("local");
    expect(providerLocality("http://[::1]:8000/v1")).toBe("local");
    expect(providerLocality("http://192.168.1.4:8000/v1")).toBe("external");
    expect(providerLocality("https://api.example.com/v1")).toBe("external");
  });

  test("alignment: same ordered examples, differences, regressions against the first label", () => {
    const a = [
      { example_id: "e1", output: "paris", scores: { exact: { value: true } } },
      { example_id: "e2", output: "lima", scores: { exact: { value: true } } },
    ];
    const b = [
      { example_id: "e2", output: "quito", scores: { exact: { value: false } } },
      { example_id: "e1", output: "paris", scores: { exact: { value: true } } },
    ];
    const rows = alignExamples(
      ["e1", "e2"],
      [
        { label: "A", examples: a },
        { label: "B", examples: b },
      ],
    );
    expect(rows.map((r) => [r.example_id, r.differs, r.regressions, r.failed])).toEqual([
      ["e1", false, {}, false],
      ["e2", true, { B: ["exact"] }, true],
    ]);
    expect(latencySummary([300, 100, 200])).toEqual({ mean: 200, p50: 200, max: 300 });
    expect(latencySummary([])).toBeUndefined();
  });
});
