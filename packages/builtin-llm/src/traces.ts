/**
 * The trace explorer over MLflow traces (spec §5.6 GenAI Traces, §5.6.2 items 3, 5, 6; criteria 10,
 * 10b, 10c, 10e; ADR 0021). MLflow is the only span store: search and detail read it, and every
 * read applies the project's current capture policy again, so tightening redaction also hides
 * bodies captured under an older policy.
 *
 * Writes come from three places, all with the capture policy applied before anything is stored:
 * jobs (`trace.logged` through the tracking outbox), the playground (directly), and GenAI
 * evaluations (the bridge's span processor).
 */

import { HttpError } from "@ablationkit/core/http";
import type { ExtensionResearchHost } from "@ablationkit/extension-host/backend";
import {
  applyCapture,
  captureMetadata,
  capturePreview,
  clusterTraceErrors,
  type RawSpan,
  ragView,
  redactor,
  spanViews,
  sumUsage,
  toolCalls,
  usageOf,
} from "@ablationkit/llm-research";
import type { LlmCapturePolicy, ObjectRef } from "@ablationkit/protocol";
import {
  type LogTraceInput,
  MlflowError,
  type MlflowTraceInfo,
} from "@ablationkit/tracking-mlflow";
import { compact } from "./helpers.ts";
import type { LlmSettingsStore } from "./llm-settings.ts";

type Json = Record<string, unknown>;

export const TRACE_ID_RE = /^tr-[a-f0-9]{32}$/;
const TAG_VALUE_RE = /^[A-Za-z0-9_.:@/ -]{1,250}$/;

/** Tags AblationKit sets on traces it writes or asks the bridge to write. */
export const TRACE_TAGS = {
  project: "ablationkit.project",
  source: "ablationkit.source",
  job: "ablationkit.job",
  attempt: "ablationkit.attempt",
  evaluation: "ablationkit.evaluation",
  example: "ablationkit.example_id",
  variant: "ablationkit.variant",
  prompt: "ablationkit.prompt",
  model: "ablationkit.model",
  golden: "ablationkit.golden_set",
  capture: "ablationkit.capture",
} as const;

export interface TraceQuery {
  status?: string | undefined;
  run_id?: string | undefined;
  name?: string | undefined;
  source?: string | undefined;
  evaluation?: string | undefined;
  example_id?: string | undefined;
  variant?: string | undefined;
  prompt?: string | undefined;
  model?: string | undefined;
  page_token?: string | undefined;
  max_results?: number | undefined;
  /** Fetch spans of the page to cluster failures (bounded to 50 traces). */
  clusters?: boolean | undefined;
}

export interface TraceWrite {
  readonly name: string;
  readonly spans: readonly RawSpan[];
  readonly state: "OK" | "ERROR";
  readonly request_time: string;
  readonly duration_ms: number;
  readonly tags: Record<string, string>;
  readonly metadata?: Record<string, string>;
  readonly run_id?: string;
  readonly request_preview?: string;
  readonly response_preview?: string;
}

function q(v: string): string {
  if (!TAG_VALUE_RE.test(v))
    throw new HttpError(400, "invalid_request", `bad filter value ${JSON.stringify(v)}`);
  return `'${v}'`;
}

export function newTraceId(): string {
  return `tr-${crypto.randomUUID().replaceAll("-", "")}`;
}

function durationMs(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const m = /^([0-9.]+)s$/.exec(d);
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

export class TraceService {
  constructor(
    private readonly o: {
      svc: () => ExtensionResearchHost;
      settings: LlmSettingsStore;
      now: () => Date;
    },
  ) {}

  private get svc(): ExtensionResearchHost {
    return this.o.svc();
  }

  private policy(pid: string): LlmCapturePolicy {
    return this.o.settings.capture(pid);
  }

  private unavailable(e: unknown): never {
    if (e instanceof MlflowError)
      throw new HttpError(503, "tracking_unavailable", `MLflow is unavailable: ${e.message}`);
    throw e;
  }

  // ------------------------------------------------------------------ writes

  /**
   * Shape and capture-filter a job's `trace.logged` payload for the outbox. Undefined when capture
   * is off. Throws (rejecting the event) on a malformed trace.
   */
  prepareJobTrace(
    pid: string,
    payload: Json,
    ctx: { attempt_id: string; job_id: string; remote?: boolean },
  ): LogTraceInput | undefined {
    const t = payload["trace"] as Json | undefined;
    if (!t || typeof t !== "object") throw new Error("payload.trace must be an object");
    const id = String(t["trace_id"] ?? "");
    if (!TRACE_ID_RE.test(id)) throw new Error("trace_id must be tr- and 32 hex characters");
    const spans = t["spans"];
    if (!Array.isArray(spans) || spans.length === 0 || spans.length > 5000)
      throw new Error("spans must be a list of 1..5000 MLflow spans");
    for (const s of spans as Json[])
      if (typeof s?.["span_id"] !== "string" || typeof s?.["name"] !== "string")
        throw new Error("each span needs span_id and name");
    const projectPolicy = this.policy(pid);
    if (projectPolicy.mode === "off") return undefined;
    // Remote workers may not capture bodies unless the project allows it (spec §16, ADR 0023).
    const policy =
      ctx.remote && !projectPolicy.remote_capture && projectPolicy.mode !== "metadata_only"
        ? { ...projectPolicy, mode: "metadata_only" as const }
        : projectPolicy;
    const strMap = (v: unknown, prefix?: string): Record<string, string> => {
      const out: Record<string, string> = {};
      if (typeof v !== "object" || v === null) return out;
      for (const [k, x] of Object.entries(v).slice(0, 100)) {
        if (prefix && !k.startsWith(prefix)) continue;
        if (typeof x === "string") out[k.slice(0, 250)] = x.slice(0, 8000);
      }
      return out;
    };
    const captured = applyCapture(spans as RawSpan[], policy);
    const r = redactor(policy);
    // Project tags may say anything; only `ablationkit.*` and `mlflow.traceName` pass, redacted.
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(strMap(t["tags"])))
      if (k.startsWith("ablationkit.") || k === "mlflow.traceName")
        tags[k] = policy.mode === "full" ? v : r.text(v);
    Object.assign(tags, {
      [TRACE_TAGS.project]: pid,
      [TRACE_TAGS.source]: "job",
      [TRACE_TAGS.job]: ctx.job_id,
      [TRACE_TAGS.attempt]: ctx.attempt_id,
      [TRACE_TAGS.capture]: policy.mode,
      "mlflow.traceName": String(t["name"] ?? (spans[0] as Json)["name"]).slice(0, 250),
    });
    const metadata = captureMetadata(strMap(t["metadata"]), policy);
    const state = t["state"] === "ERROR" ? "ERROR" : "OK";
    const dur = Number(t["duration_ms"] ?? 0);
    const reqTime = String(t["request_time"] ?? "");
    return {
      trace_id: id,
      request_time: Number.isNaN(Date.parse(reqTime)) ? this.o.now().toISOString() : reqTime,
      execution_duration_ms: Number.isFinite(dur) && dur >= 0 ? Math.round(dur) : 0,
      state,
      metadata,
      tags,
      spans: captured.spans,
    };
  }

  /** Write a coordinator-made trace (the playground). Undefined when capture is off. */
  async write(pid: string, t: TraceWrite): Promise<string | undefined> {
    const policy = this.policy(pid);
    if (policy.mode === "off") return undefined;
    const id = newTraceId();
    const spans = applyCapture(
      t.spans.map((s) => ({
        ...s,
        attributes: { ...(s.attributes ?? {}), "mlflow.traceRequestId": JSON.stringify(id) },
      })),
      policy,
    ).spans;
    const c = this.svc.tracking.client;
    const experimentId = await this.svc.tracking.ensureExperimentNow(pid);
    const info = await c.startTrace(
      compact({
        trace_id: id,
        trace_location: {
          type: "MLFLOW_EXPERIMENT",
          mlflow_experiment: { experiment_id: experimentId },
        },
        request_time: t.request_time,
        execution_duration: `${(t.duration_ms / 1000).toFixed(3)}s`,
        state: t.state,
        request_preview: capturePreview(t.request_preview?.slice(0, 1000), policy),
        response_preview: capturePreview(t.response_preview?.slice(0, 1000), policy),
        trace_metadata: {
          "mlflow.trace_schema.version": "3",
          ...captureMetadata(t.metadata ?? {}, policy),
          ...(t.run_id ? { "mlflow.sourceRun": t.run_id } : {}),
        },
        tags: {
          ...t.tags,
          [TRACE_TAGS.project]: pid,
          [TRACE_TAGS.capture]: policy.mode,
          "mlflow.traceName": t.name,
        },
      }) as MlflowTraceInfo,
    );
    await c.uploadTraceSpans(info, spans);
    return id;
  }

  // ------------------------------------------------------------------ reads

  private filter(qy: TraceQuery): string | undefined {
    const parts: string[] = [];
    if (qy.status) {
      if (qy.status !== "OK" && qy.status !== "ERROR")
        throw new HttpError(400, "invalid_request", "status must be OK or ERROR");
      parts.push(`trace.status = '${qy.status}'`);
    }
    if (qy.run_id) {
      if (!/^[a-f0-9]{32}$/.test(qy.run_id))
        throw new HttpError(400, "invalid_request", "bad run_id");
      parts.push(`run_id = '${qy.run_id}'`);
    }
    if (qy.name) parts.push(`trace.name = ${q(qy.name)}`);
    const tags: [keyof TraceQuery, string][] = [
      ["source", TRACE_TAGS.source],
      ["evaluation", TRACE_TAGS.evaluation],
      ["example_id", TRACE_TAGS.example],
      ["variant", TRACE_TAGS.variant],
      ["prompt", TRACE_TAGS.prompt],
      ["model", TRACE_TAGS.model],
    ];
    for (const [k, tag] of tags) {
      const v = qy[k];
      if (typeof v === "string" && v) parts.push(`tag.\`${tag}\` = ${q(v)}`);
    }
    return parts.length ? parts.join(" AND ") : undefined;
  }

  private summary(pid: string, t: MlflowTraceInfo): Json {
    const policy = this.policy(pid);
    const md = t.trace_metadata ?? {};
    const tags = t.tags ?? {};
    let usage: unknown;
    try {
      usage = md["mlflow.trace.tokenUsage"]
        ? usageOf(JSON.parse(md["mlflow.trace.tokenUsage"]))
        : undefined;
    } catch {
      usage = undefined;
    }
    return compact({
      trace_id: t.trace_id,
      name: tags["mlflow.traceName"],
      state: t.state,
      request_time: t.request_time,
      duration_ms: durationMs(t.execution_duration),
      run_id: md["mlflow.sourceRun"],
      request_preview: capturePreview(t.request_preview ?? md["mlflow.traceInputs"], policy),
      response_preview: capturePreview(t.response_preview ?? md["mlflow.traceOutputs"], policy),
      usage,
      tags: Object.fromEntries(Object.entries(tags).filter(([k]) => k.startsWith("ablationkit."))),
      assessments: (t.assessments ?? []).map((a) =>
        compact({
          name: a.assessment_name,
          value: a.feedback?.value ?? a.expectation?.value,
          source: a.source.source_type,
          error: a.feedback?.error?.error_message,
        }),
      ),
    });
  }

  async search(pid: string, qy: TraceQuery): Promise<Json> {
    const ids = this.svc.models.experimentIds(pid);
    if (!ids.length) return { traces: [], unavailable: "the project has no MLflow experiment yet" };
    const max = Math.min(Math.max(qy.max_results ?? 50, 1), 200);
    try {
      const page = await this.svc.tracking.client.searchTraces(
        compact({
          experiment_ids: ids,
          filter: this.filter(qy),
          max_results: max,
          order_by: ["timestamp_ms DESC"],
          page_token: qy.page_token,
        }),
      );
      const out: Json = {
        traces: page.items.map((t) => this.summary(pid, t)),
        ...(page.next_page_token ? { next_page_token: page.next_page_token } : {}),
      };
      if (qy.clusters) {
        const errs = page.items.filter((t) => t.state === "ERROR").slice(0, 50);
        const withSpans = await Promise.all(
          errs.map(async (t) => ({
            trace_id: t.trace_id,
            spans: spanViews(
              applyCapture(
                (await this.svc.tracking.client
                  .getTraceSpans(t.trace_id)
                  .catch(() => [])) as RawSpan[],
                this.policy(pid),
              ).spans,
            ),
          })),
        );
        out["clusters"] = clusterTraceErrors(withSpans);
      }
      return out;
    } catch (e) {
      return this.unavailable(e);
    }
  }

  /** The trace info, checked to belong to one of the project's experiments. */
  async info(pid: string, id: string): Promise<MlflowTraceInfo> {
    if (!TRACE_ID_RE.test(id)) throw new HttpError(400, "invalid_request", "bad trace ID");
    let info: MlflowTraceInfo;
    try {
      info = await this.svc.tracking.client.getTraceInfo(id);
    } catch (e) {
      if (e instanceof MlflowError && e.notFound)
        throw new HttpError(404, "not_found", `no trace ${id}`);
      return this.unavailable(e);
    }
    const exp = info.trace_location?.mlflow_experiment?.experiment_id;
    if (!exp || !this.svc.models.experimentIds(pid).includes(exp))
      throw new HttpError(404, "not_found", `no trace ${id} in this project`);
    return info;
  }

  /** Spans of a project trace with the current policy applied (shared with evaluations). */
  async spans(pid: string, id: string): Promise<{ spans: RawSpan[]; available: boolean }> {
    try {
      const raw = (await this.svc.tracking.client.getTraceSpans(id)) as RawSpan[];
      return { spans: applyCapture(raw, this.policy(pid)).spans, available: true };
    } catch (e) {
      if (e instanceof MlflowError && e.notFound) return { spans: [], available: false };
      return this.unavailable(e);
    }
  }

  async get(pid: string, id: string): Promise<Json> {
    const info = await this.info(pid, id);
    const research = await this.svc.research.list(pid, { link: `trace:${id}` });
    const policy = this.policy(pid);
    const { spans: raw, available } = await this.spans(pid, id);
    const views = spanViews(raw);
    const tags = info.tags ?? {};
    const r = redactor(policy);
    const text = (s: string | undefined) =>
      s === undefined || policy.mode === "full"
        ? s
        : policy.mode === "redacted"
          ? r.text(s)
          : undefined;
    const tools = toolCalls(views);
    return compact({
      trace: this.summary(pid, info),
      capture: compact({ now: policy.mode, recorded_under: tags[TRACE_TAGS.capture] }),
      spans_available: available,
      spans: views,
      usage: sumUsage(views.filter((s) => s.kind === "llm").map((s) => s.usage)),
      rag: ragView(views, tags),
      tools: tools.calls,
      tool_failures: tools.clusters,
      errors: views
        .filter((s) => s.error)
        .map((s) => ({ span_id: s.span_id, name: s.name, ...s.error })),
      assessments: (info.assessments ?? []).map((a) =>
        compact({
          assessment_id: a.assessment_id,
          name: a.assessment_name,
          value: a.feedback?.value ?? a.expectation?.value,
          kind: a.expectation ? "expectation" : "feedback",
          source: a.source,
          rationale: text(a.rationale),
          error: a.feedback?.error?.error_message,
          metadata: a.metadata,
          span_id: a.span_id,
          created_at: a.create_time,
        }),
      ),
      links: compact({
        run_id: info.trace_metadata?.["mlflow.sourceRun"],
        evaluation_id: tags[TRACE_TAGS.evaluation],
        example_id: tags[TRACE_TAGS.example],
        variant: tags[TRACE_TAGS.variant],
        prompt: tags[TRACE_TAGS.prompt],
        golden_set: tags[TRACE_TAGS.golden],
        job_id: tags[TRACE_TAGS.job],
        attempt_id: tags[TRACE_TAGS.attempt],
        research: research.map((x) => ({ kind: x.kind, id: x.record_id, title: x.title })),
      }),
    });
  }

  /** A researcher's feedback or annotation on a trace (or one span), as an MLflow assessment. */
  async feedback(
    pid: string,
    id: string,
    body: Json,
    actor: { kind: "human"; id?: string },
  ): Promise<Json> {
    await this.info(pid, id);
    const name = body["name"];
    if (typeof name !== "string" || !/^[a-z0-9_.-]{1,64}$/.test(name))
      throw new HttpError(400, "invalid_request", "name must match [a-z0-9_.-]{1,64}");
    const v = body["value"];
    if (
      !(
        typeof v === "boolean" ||
        typeof v === "string" ||
        (typeof v === "number" && Number.isFinite(v))
      )
    )
      throw new HttpError(400, "invalid_request", "value must be a boolean, string or number");
    if (typeof v === "string" && v.length > 500)
      throw new HttpError(400, "invalid_request", "value is at most 500 characters");
    const rationale = body["rationale"];
    if (rationale !== undefined && (typeof rationale !== "string" || rationale.length > 4000))
      throw new HttpError(400, "invalid_request", "rationale is at most 4000 characters");
    const span = body["span_id"];
    if (span !== undefined && (typeof span !== "string" || span.length > 100))
      throw new HttpError(400, "invalid_request", "bad span_id");
    try {
      const a = await this.svc.tracking.client.createAssessment(
        id,
        compact({
          assessment_name: name,
          source: { source_type: "HUMAN" as const, source_id: actor.id ?? "human" },
          feedback: { value: v },
          rationale: rationale as string | undefined,
          span_id: span as string | undefined,
          metadata: { "ablationkit.project": pid },
        }),
      );
      this.svc.audit.record({
        actor: compact({ kind: "human" as const, id: actor.id }),
        listener: "human",
        action: "llm.trace.feedback",
        outcome: "allowed",
        project_id: pid,
        target: id,
        details: { name },
      });
      return { assessment_id: a.assessment_id, name, value: v };
    } catch (e) {
      return this.unavailable(e);
    }
  }

  /** Link a trace to a research record (a note or report) without copying any span data. */
  async link(
    pid: string,
    id: string,
    target: ObjectRef,
    actor: { kind: "human" | "agent"; id?: string },
  ): Promise<void> {
    const rec = await this.svc.research.require(pid, target.id);
    if (rec.links.some((l) => l.kind === "trace" && l.id === id)) return;
    await this.svc.research.update(
      pid,
      rec.record_id,
      { links: [...rec.links, { kind: "trace", id }] },
      compact({ kind: actor.kind, id: actor.id }),
    );
  }

  /**
   * Retention: delete traces older than the project's `retention_days` from its own experiment.
   * Linked (imported) experiments are read-only and never touched.
   */
  async sweep(pids: readonly string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const pid of pids) {
      const exp = this.svc.tracking.mappings.getLinks(pid).experiment_id;
      if (!exp) continue;
      const days = this.policy(pid).retention_days;
      const cutoff = this.o.now().getTime() - days * 86_400_000;
      try {
        let n = 0;
        for (let i = 0; i < 20; i++) {
          const d = await this.svc.tracking.client.deleteTraces({
            experiment_id: exp,
            max_timestamp_millis: cutoff,
            max_traces: 1000,
          });
          n += d;
          if (d < 1000) break;
        }
        out[pid] = n;
        if (n)
          this.svc.audit.record({
            actor: { kind: "system" },
            listener: "internal",
            action: "llm.trace.retention",
            outcome: "allowed",
            project_id: pid,
            target: exp,
            details: { deleted: n, retention_days: days },
          });
      } catch {
        // MLflow down: the next sweep tries again
      }
    }
    return out;
  }
}
