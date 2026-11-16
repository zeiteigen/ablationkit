import { describe, expect, test } from "bun:test";
import { type CapturePolicyLike, type RawSpan, redactor } from "@ablationkit/data-controls";
import { MlflowClient, type MlflowTraceInfo } from "@ablationkit/tracking-mlflow";
import { projectCapture } from "../src/extensions/capture.ts";
import type { ExtensionCapturePolicy } from "../src/extensions/policy.ts";
import { callExtensionTracking, type ExtensionTrackingScope } from "../src/extensions/tracking.ts";

const EMAIL = "researcher@example.com";
const INFO: MlflowTraceInfo = {
  trace_id: "trace",
  request_time: "2026-11-05T12:00:00.000Z",
  state: "OK",
  trace_location: { type: "MLFLOW_EXPERIMENT", mlflow_experiment: { experiment_id: "owned" } },
  request_preview: `Ask ${EMAIL}`,
  response_preview: `Answer ${EMAIL}`,
  trace_metadata: {
    "mlflow.traceInputs": JSON.stringify({ question: EMAIL }),
    "mlflow.traceOutputs": JSON.stringify({ response: EMAIL }),
    "mlflow.trace.tokenUsage": JSON.stringify({ input_tokens: 3 }),
  },
  tags: {
    "mlflow.artifactLocation": "mlflow-artifacts:/owned/trace",
    "ablationkit.project": "project",
  },
  assessments: [
    {
      assessment_id: "assessment",
      trace_id: "trace",
      assessment_name: "answer",
      source: { source_type: "CODE" },
      rationale: `Expected ${EMAIL}`,
      feedback: { value: EMAIL, error: { error_message: EMAIL } },
      expectation: { value: { answer: EMAIL } },
    },
  ],
};
const SPANS: RawSpan[] = [
  {
    trace_id: "trace",
    span_id: "span",
    name: "chat",
    start_time_unix_nano: "1000",
    end_time_unix_nano: "2000",
    attributes: {
      "mlflow.spanInputs": JSON.stringify({ input: EMAIL }),
      "mlflow.spanOutputs": JSON.stringify(EMAIL),
      "mlflow.spanType": JSON.stringify("CHAT_MODEL"),
      custom: JSON.stringify("sensitive"),
    },
    status: { code: "ERROR", message: EMAIL },
    events: [
      { name: "exception", attributes: { "exception.type": "Error", "exception.message": EMAIL } },
    ],
  },
];

function policy(mode: CapturePolicyLike["mode"]): CapturePolicyLike {
  return { mode, builtin_redactions: ["email"], patterns: [{ name: "test", regex: "sensitive" }] };
}
function fixture(capture?: CapturePolicyLike) {
  const calls: { method: string; args: unknown[] }[] = [];
  const client = new MlflowClient({ url: "http://unused.invalid" });
  const stubs: Record<string, (...args: unknown[]) => unknown> = {
    getTraceInfo: () => INFO,
    getTraceSpans: () => SPANS,
    searchTraces: () => ({
      items: [
        INFO,
        {
          ...INFO,
          trace_location: {
            type: "MLFLOW_EXPERIMENT",
            mlflow_experiment: { experiment_id: "foreign" },
          },
        },
      ],
      next_page_token: "next",
    }),
    startTrace: (info) => info,
    uploadTraceSpans: () => undefined,
  };
  for (const [method, fn] of Object.entries(stubs))
    Reflect.set(client, method, async (...args: unknown[]) => {
      calls.push({ method, args });
      return fn(...args);
    });
  const scope: ExtensionTrackingScope = {
    client,
    projectId: "project",
    experimentIds: () => ["owned"],
    ensureExperiment: async () => "owned",
    writable: true,
    ...(capture ? { capture } : {}),
  };
  return {
    calls,
    scope,
    call: (method: string, ...args: unknown[]) => callExtensionTracking(scope, method, args),
  };
}

describe("project capture constraints", () => {
  test("merges the most restrictive mode and a union of rules regardless of policy order", () => {
    const full: ExtensionCapturePolicy = {
      mode: "full",
      retention_days: 30,
      builtin_redactions: ["secret"],
      patterns: [{ name: "custom", regex: "first" }],
    };
    const redacted: ExtensionCapturePolicy = {
      mode: "redacted",
      retention_days: 7,
      builtin_redactions: ["email", "unknown"],
      patterns: [
        { name: "custom", regex: "second" },
        { name: "duplicate", regex: "first" },
      ],
      redaction_patterns: ["third"],
      remote_capture: true,
    };
    expect(projectCapture([])).toBeUndefined();
    for (const policies of [
      [full, redacted],
      [redacted, full],
    ]) {
      const merged = projectCapture(policies) as CapturePolicyLike;
      expect(merged.mode).toBe("redacted");
      expect(new Set(merged.builtin_redactions)).toEqual(new Set(["email", "secret"]));
      expect(new Set(merged.patterns.map((p) => p.regex))).toEqual(
        new Set(["first", "second", "third"]),
      );
      expect(redactor(merged).text("first second third researcher@example.com")).not.toContain(
        EMAIL,
      );
    }
    expect(projectCapture([full, { ...redacted, mode: "metadata_only" }])?.mode).toBe(
      "metadata_only",
    );
    expect(projectCapture([full, { ...redacted, mode: "off" }])?.mode).toBe("off");
  });

  test("invalid or oversized custom patterns use existing redactor validation", () => {
    const capture = projectCapture([
      {
        mode: "redacted",
        retention_days: 1,
        patterns: [
          { name: "invalid", regex: "[" },
          { name: "large", regex: "x".repeat(501) },
          { name: "valid", regex: "sensitive" },
        ],
      },
    ]) as CapturePolicyLike;
    expect(redactor(capture).text("sensitive")).toBe("[REDACTED:valid]");
  });
});

describe("host trace capture enforcement", () => {
  test("a tighter policy scrubs historical trace info, search results, assessments and spans", async () => {
    const { call } = fixture(policy("redacted"));
    const info = (await call("getTraceInfo", "trace")) as MlflowTraceInfo;
    expect(info.request_preview).toBe("Ask [REDACTED:email]");
    expect(info.trace_metadata?.["mlflow.trace.tokenUsage"]).toBe(
      INFO.trace_metadata?.["mlflow.trace.tokenUsage"],
    );
    expect(JSON.stringify(info)).not.toContain(EMAIL);
    const page = (await call("searchTraces", { experiment_ids: ["owned"] })) as {
      items: MlflowTraceInfo[];
      next_page_token: string;
    };
    expect(page.items).toHaveLength(1);
    expect(page.next_page_token).toBe("next");
    expect(JSON.stringify(page)).not.toContain(EMAIL);
    const spans = (await call("getTraceSpans", "trace")) as RawSpan[];
    expect(spans).toHaveLength(1);
    expect(JSON.stringify(spans)).not.toContain(EMAIL);
    expect(spans[0]?.attributes?.["custom"]).toContain("[REDACTED:test]");
    // Reapplying a read policy must not rewrite persisted historical content in memory.
    expect(INFO.request_preview).toContain(EMAIL);
    expect(SPANS[0]?.attributes?.["mlflow.spanInputs"]).toContain(EMAIL);
  });

  test.each(["metadata_only", "off"] as const)(
    "%s reads preserve topology and usage while hiding bodies",
    async (mode) => {
      const { call } = fixture(policy(mode));
      const info = (await call("getTraceInfo", "trace")) as MlflowTraceInfo;
      expect(info).not.toHaveProperty("request_preview");
      expect(info).not.toHaveProperty("response_preview");
      expect(info.trace_metadata).toEqual({
        "mlflow.trace.tokenUsage": JSON.stringify({ input_tokens: 3 }),
      });
      expect(JSON.stringify(info)).not.toContain(EMAIL);
      const spans = (await call("getTraceSpans", "trace")) as RawSpan[];
      expect(spans[0]).toMatchObject({
        span_id: "span",
        name: "chat",
        start_time_unix_nano: "1000",
      });
      expect(JSON.parse(spans[0]?.attributes?.["mlflow.spanInputs"] ?? "{}")).toMatchObject({
        omitted: "metadata_only",
      });
      expect(JSON.stringify(spans)).not.toContain(EMAIL);
    },
  );

  test("new info and span writes are scrubbed before MLflow sees them", async () => {
    const { call, calls } = fixture(policy("redacted"));
    const created = (await call("startTrace", INFO)) as MlflowTraceInfo;
    expect(JSON.stringify(created)).not.toContain(EMAIL);
    const start = calls.find((call) => call.method === "startTrace")?.args[0] as MlflowTraceInfo;
    expect(JSON.stringify(start)).not.toContain(EMAIL);
    expect(start.tags?.["ablationkit.project"]).toBe("project");
    expect(start.trace_location?.mlflow_experiment?.experiment_id).toBe("owned");
    await call("uploadTraceSpans", INFO, SPANS);
    const uploaded = calls.at(-1)?.args[1] as RawSpan[];
    expect(JSON.stringify(uploaded)).not.toContain(EMAIL);
    expect(uploaded[0]?.attributes?.["custom"]).toContain("[REDACTED:test]");
    expect(calls.at(-1)?.args[0]).toBe(INFO); // The trusted upload destination remains intact.
  });

  test("off blocks new trace creation and scrubs spans for already-started traces", async () => {
    const { call, calls } = fixture(policy("off"));
    await expect(call("startTrace", INFO)).rejects.toMatchObject({
      status: 403,
      code: "extension_capture_off",
    });
    expect(calls).toEqual([]);
    await call("uploadTraceSpans", INFO, SPANS);
    const uploaded = calls.at(-1)?.args[1] as RawSpan[];
    expect(uploaded).toHaveLength(1);
    expect(JSON.parse(uploaded[0]?.attributes?.["mlflow.spanInputs"] ?? "{}")).toMatchObject({
      omitted: "metadata_only",
    });
    expect(JSON.stringify(uploaded)).not.toContain(EMAIL);
  });

  test("explicit full or absent policy retains the permitted trace content", async () => {
    for (const capture of [undefined, policy("full")]) {
      const { call } = fixture(capture);
      expect(await call("getTraceInfo", "trace")).toBe(INFO);
      expect(await call("getTraceSpans", "trace")).toEqual(SPANS);
    }
  });
});
