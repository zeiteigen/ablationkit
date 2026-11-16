/**
 * MLflow trace spans as the trace explorer shows them (spec §5.6.2 items 3, 5, 6; criteria 10b, 10c):
 * a tree with a waterfall, span kinds, errors and retries, token usage only where reported, RAG
 * retrieval evidence and tool calls. Everything is derived from MLflow's own span data at read
 * time; nothing here is a second span store.
 */
import type { RawSpan } from "./redact.ts";

export type SpanKind =
  | "llm"
  | "retrieval"
  | "rerank"
  | "tool"
  | "agent"
  | "chain"
  | "embedding"
  | "other";

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface SpanView {
  span_id: string;
  parent_id: string | undefined;
  name: string;
  type: string;
  kind: SpanKind;
  depth: number;
  start_ms: number;
  /** Offset from the trace's first span start. */
  offset_ms: number;
  duration_ms: number | undefined;
  status: "ok" | "error" | "unset";
  error: { type?: string; message?: string } | undefined;
  inputs: unknown;
  outputs: unknown;
  /** `metadata_only` capture left a size instead of the body. */
  bodies_omitted: boolean;
  usage: Usage | undefined;
  model: string | undefined;
  attributes: Record<string, unknown>;
  children: string[];
}

const KIND: Record<string, SpanKind> = {
  LLM: "llm",
  CHAT_MODEL: "llm",
  RETRIEVER: "retrieval",
  RERANKER: "rerank",
  TOOL: "tool",
  AGENT: "agent",
  CHAIN: "chain",
  EMBEDDING: "embedding",
};

function parse(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function nsToMs(v: number | string | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n / 1e6 : undefined;
}

function omitted(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>)["omitted"] === "metadata_only"
  );
}

export function usageOf(v: unknown): Usage | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const n = (k: string) =>
    typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : undefined;
  const u: Usage = {};
  const i = n("input_tokens") ?? n("prompt_tokens");
  const out = n("output_tokens") ?? n("completion_tokens");
  const t = n("total_tokens");
  if (i !== undefined) u.input_tokens = i;
  if (out !== undefined) u.output_tokens = out;
  if (t !== undefined) u.total_tokens = t;
  else if (i !== undefined && out !== undefined) u.total_tokens = i + out;
  return Object.keys(u).length ? u : undefined;
}

/** Normalize MLflow spans into a depth-first ordered list with tree links and waterfall offsets. */
export function spanViews(raw: readonly RawSpan[]): SpanView[] {
  const byId = new Map<string, SpanView>();
  let t0 = Number.POSITIVE_INFINITY;
  for (const s of raw) {
    const start = nsToMs(s.start_time_unix_nano) ?? 0;
    t0 = Math.min(t0, start);
  }
  if (!Number.isFinite(t0)) t0 = 0;
  for (const s of raw) {
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.attributes ?? {})) attrs[k] = parse(v);
    const type =
      typeof attrs["mlflow.spanType"] === "string"
        ? (attrs["mlflow.spanType"] as string)
        : "UNKNOWN";
    const start = nsToMs(s.start_time_unix_nano) ?? 0;
    const end = nsToMs(s.end_time_unix_nano);
    const exc = (s.events ?? []).find((e) => e.name === "exception");
    const code = s.status?.code ?? "";
    const status = code.endsWith("ERROR") ? "error" : code.endsWith("OK") ? "ok" : "unset";
    const err =
      status === "error" || exc
        ? {
            ...(typeof exc?.attributes?.["exception.type"] === "string"
              ? { type: exc.attributes["exception.type"] as string }
              : {}),
            ...((typeof exc?.attributes?.["exception.message"] === "string"
              ? { message: exc.attributes["exception.message"] as string }
              : s.status?.message
                ? { message: s.status.message }
                : {}) as { message?: string }),
          }
        : undefined;
    const inputs = attrs["mlflow.spanInputs"];
    const outputs = attrs["mlflow.spanOutputs"];
    const model =
      typeof attrs["mlflow.llm.model"] === "string"
        ? (attrs["mlflow.llm.model"] as string)
        : typeof attrs["ablationkit.llm.model"] === "string"
          ? (attrs["ablationkit.llm.model"] as string)
          : undefined;
    byId.set(s.span_id, {
      span_id: s.span_id,
      parent_id: s.parent_span_id ?? undefined,
      name: s.name,
      type,
      kind: KIND[type] ?? "other",
      depth: 0,
      start_ms: start,
      offset_ms: start - t0,
      duration_ms: end === undefined ? undefined : Math.max(0, end - start),
      status,
      error: err,
      inputs: omitted(inputs) ? undefined : inputs,
      outputs: omitted(outputs) ? undefined : outputs,
      bodies_omitted: omitted(inputs) || omitted(outputs),
      usage: usageOf(attrs["mlflow.chat.tokenUsage"]),
      model,
      attributes: attrs,
      children: [],
    });
  }
  const roots: SpanView[] = [];
  for (const v of byId.values()) {
    const p = v.parent_id ? byId.get(v.parent_id) : undefined;
    if (p) p.children.push(v.span_id);
    else {
      v.parent_id = undefined;
      roots.push(v);
    }
  }
  const out: SpanView[] = [];
  const visit = (v: SpanView, depth: number, seen: Set<string>) => {
    if (seen.has(v.span_id)) return;
    seen.add(v.span_id);
    v.depth = depth;
    out.push(v);
    const kids = v.children
      .map((id) => byId.get(id) as SpanView)
      .sort((a, b) => a.start_ms - b.start_ms);
    v.children = kids.map((k) => k.span_id);
    for (const k of kids) visit(k, depth + 1, seen);
  };
  const seen = new Set<string>();
  for (const r of roots.sort((a, b) => a.start_ms - b.start_ms)) visit(r, 0, seen);
  return out;
}

export interface UsageTotals {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** LLM spans with reported usage. */
  reported: number;
  /** LLM spans without it: shown as unavailable, never estimated. */
  missing: number;
}

export function sumUsage(list: readonly (Usage | undefined)[]): UsageTotals {
  const t: UsageTotals = { reported: 0, missing: 0 };
  for (const u of list) {
    if (!u) {
      t.missing++;
      continue;
    }
    t.reported++;
    for (const k of ["input_tokens", "output_tokens", "total_tokens"] as const) {
      const v = u[k];
      if (v !== undefined) t[k] = (t[k] ?? 0) + v;
    }
  }
  return t;
}

export interface RetrievedDoc {
  id: string | undefined;
  doc_uri: string | undefined;
  chunk_id: string | undefined;
  score: number | undefined;
  content: string | undefined;
}

export interface Retrieval {
  span_id: string;
  name: string;
  kind: "retrieval" | "rerank";
  query: unknown;
  documents: RetrievedDoc[];
  duration_ms: number | undefined;
  error: SpanView["error"];
  bodies_omitted: boolean;
}

export type Availability<T> = { available: true; value: T } | { available: false; reason: string };

export interface RagView {
  /** False when the trace has no retriever span: nothing below is inferred. */
  instrumented: boolean;
  query: unknown;
  retrievals: Retrieval[];
  generations: {
    span_id: string;
    name: string;
    model: string | undefined;
    usage: Usage | undefined;
    outputs: unknown;
  }[];
  index_revision: Availability<string>;
  retrieval_config: Availability<Record<string, unknown>>;
}

function docsOf(outputs: unknown): RetrievedDoc[] {
  const list = Array.isArray(outputs)
    ? outputs
    : typeof outputs === "object" &&
        outputs !== null &&
        Array.isArray((outputs as Record<string, unknown>)["documents"])
      ? ((outputs as Record<string, unknown>)["documents"] as unknown[])
      : [];
  return list.slice(0, 200).map((d) => {
    const o = (typeof d === "object" && d !== null ? d : { page_content: String(d) }) as Record<
      string,
      unknown
    >;
    const md = (
      typeof o["metadata"] === "object" && o["metadata"] !== null ? o["metadata"] : {}
    ) as Record<string, unknown>;
    const s = (v: unknown) =>
      typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
    const score =
      typeof md["score"] === "number"
        ? md["score"]
        : typeof o["score"] === "number"
          ? o["score"]
          : undefined;
    return {
      id: s(o["id"]),
      doc_uri: s(md["doc_uri"]) ?? s(md["source"]),
      chunk_id: s(md["chunk_id"]),
      score: score as number | undefined,
      content: s(o["page_content"]) ?? s(o["content"]),
    };
  });
}

/**
 * The RAG path of one trace: query → retrieved chunks → reranking → generation. Index revision and
 * retrieval configuration come only from what the application recorded (`ablationkit.rag.*` span
 * attributes or trace tags); otherwise they are reported unavailable.
 */
export function ragView(
  spans: readonly SpanView[],
  tags: Readonly<Record<string, string>> = {},
): RagView {
  const retrievals: Retrieval[] = spans
    .filter((s) => s.kind === "retrieval" || s.kind === "rerank")
    .map((s) => ({
      span_id: s.span_id,
      name: s.name,
      kind: s.kind as "retrieval" | "rerank",
      query: s.inputs,
      documents: docsOf(s.outputs),
      duration_ms: s.duration_ms,
      error: s.error,
      bodies_omitted: s.bodies_omitted,
    }));
  const attr = (k: string): unknown => {
    for (const s of spans) if (s.attributes[k] !== undefined) return s.attributes[k];
    const t = tags[k];
    return t === undefined ? undefined : parseLoose(t);
  };
  const rev = attr("ablationkit.rag.index_revision");
  const cfg = attr("ablationkit.rag.config");
  const instrumented = retrievals.some((r) => r.kind === "retrieval");
  return {
    instrumented,
    query: retrievals[0]?.query,
    retrievals,
    generations: spans
      .filter((s) => s.kind === "llm")
      .map((s) => ({
        span_id: s.span_id,
        name: s.name,
        model: s.model,
        usage: s.usage,
        outputs: s.outputs,
      })),
    index_revision:
      typeof rev === "string" && rev
        ? { available: true, value: rev }
        : {
            available: false,
            reason: instrumented
              ? "the application did not record `ablationkit.rag.index_revision`"
              : "no retrieval span in this trace",
          },
    retrieval_config:
      typeof cfg === "object" && cfg !== null && !Array.isArray(cfg)
        ? { available: true, value: cfg as Record<string, unknown> }
        : {
            available: false,
            reason: instrumented
              ? "the application did not record `ablationkit.rag.config`"
              : "no retrieval span in this trace",
          },
  };
}

function parseLoose(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export interface ToolCall {
  span_id: string;
  parent_id: string | undefined;
  name: string;
  arguments: unknown;
  result: unknown;
  error: SpanView["error"];
  duration_ms: number | undefined;
  /** 1 for the first call of this tool under the same parent, 2 for its first retry, … */
  attempt: number;
  /** A later call of the same tool under the same parent followed this failed one. */
  retried: boolean;
}

export interface FailureCluster {
  tool: string;
  error_type: string;
  count: number;
  span_ids: string[];
}

/** Observed tool calls (TOOL spans) with retries and failure clusters. No hidden reasoning is shown or inferred. */
export function toolCalls(spans: readonly SpanView[]): {
  calls: ToolCall[];
  clusters: FailureCluster[];
} {
  const tools = spans.filter((s) => s.kind === "tool");
  const seen = new Map<string, ToolCall[]>();
  const calls: ToolCall[] = [];
  for (const s of [...tools].sort((a, b) => a.start_ms - b.start_ms)) {
    const key = `${s.parent_id ?? ""}\u0000${s.name}`;
    const prev = seen.get(key) ?? [];
    const c: ToolCall = {
      span_id: s.span_id,
      parent_id: s.parent_id,
      name: s.name,
      arguments: s.inputs,
      result: s.outputs,
      error: s.error,
      duration_ms: s.duration_ms,
      attempt: prev.length + 1,
      retried: false,
    };
    const last = prev.at(-1);
    if (last?.error) last.retried = true;
    prev.push(c);
    seen.set(key, prev);
    calls.push(c);
  }
  const clusters = new Map<string, FailureCluster>();
  for (const c of calls) {
    if (!c.error) continue;
    const et = c.error.type ?? "error";
    const k = `${c.name}\u0000${et}`;
    const cl = clusters.get(k) ?? { tool: c.name, error_type: et, count: 0, span_ids: [] };
    cl.count++;
    cl.span_ids.push(c.span_id);
    clusters.set(k, cl);
  }
  return { calls, clusters: [...clusters.values()].sort((a, b) => b.count - a.count) };
}

/** Group error traces across a search page: same root error type and failing span name. */
export function clusterTraceErrors(
  traces: readonly { trace_id: string; spans: readonly SpanView[] }[],
): { span: string; error_type: string; count: number; trace_ids: string[] }[] {
  const m = new Map<
    string,
    { span: string; error_type: string; count: number; trace_ids: string[] }
  >();
  for (const t of traces) {
    const failing = t.spans.filter((s) => s.error);
    const deepest = failing.sort((a, b) => b.depth - a.depth)[0];
    if (!deepest) continue;
    const et = deepest.error?.type ?? "error";
    const k = `${deepest.name}\u0000${et}`;
    const c = m.get(k) ?? { span: deepest.name, error_type: et, count: 0, trace_ids: [] };
    c.count++;
    c.trace_ids.push(t.trace_id);
    m.set(k, c);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}
