/**
 * The LLM playground and pinned-variant comparison (spec §5.6.2 items 1–2, §5.6 LLM Research Lab;
 * criteria 10a, 10e; ADR 0021). Each variant is a prompt (a registry version, an alias resolved to
 * one, or an ad-hoc template) sent to one provider model with fixed decoding parameters; all
 * variants run over the same ordered inputs (typed in, or a pinned golden-set version).
 *
 * Results are transient (coordinator memory, one hour). Each call writes an MLflow trace when the
 * project's capture policy allows it. Saving a comparison is explicit and needs every variant
 * pinned to a registry version: an MLflow run with one artifact plus an `LlmEvidenceRecord`.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import { HttpError } from "@ablationkit/core/http";
import type { ExtensionResearchHost } from "@ablationkit/extension-host/backend";
import {
  alignExamples,
  estimateCost,
  isChat,
  latencySummary,
  type RawSpan,
  redactor,
  renderPrompt,
  sumUsage,
  type Template,
  type Usage,
} from "@ablationkit/llm-research";
import {
  type GenerationParams,
  type LlmEvidenceRecord,
  type LlmTarget,
  type ObjectRef,
  type PinnedPrompt,
  validateLlmEvidenceRecord,
} from "@ablationkit/protocol";
import { MlflowError, TAGS } from "@ablationkit/tracking-mlflow";
import type { GoldenSetService } from "./golden-sets.ts";
import { compact, gitHead } from "./helpers.ts";
import { chatCompletion } from "./llm-provider.ts";
import type { EgressData, LlmSettingsStore } from "./llm-settings.ts";
import { type PromptService, templateSha } from "./prompts.ts";
import { TRACE_TAGS, type TraceService } from "./traces.ts";

type Json = Record<string, unknown>;
type Actor = { kind: "human"; id?: string };

export const MAX_PLAYGROUND_CALLS = 300;
const MAX_RESULTS = 100;
const RESULT_TTL_MS = 3_600_000;
const LABEL_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const DECIMAL_RE = /^[0-9]+([.][0-9]+)?$/;
export const EVIDENCE_ARTIFACT = "ablationkit/llm/playground.json";

export interface CallOutput {
  example_id: string;
  trial: number;
  output?: string;
  error?: string;
  latency_ms: number;
  usage?: Usage;
  finish_reason?: string;
  model_reported?: string;
  trace_id?: string;
}

export interface PlaygroundVariant {
  label: string;
  prompt?: PinnedPrompt;
  /** An unsaved template: explorable, not savable as evidence. */
  adhoc?: { template_sha256: string; format: "text" | "chat" };
  template: Template;
  provider_id: string;
  model: string;
  params: GenerationParams;
  locality: "local" | "external";
}

export interface PlaygroundResult {
  result_id: string;
  project_id: string;
  created_at: string;
  created_by: Actor;
  variants: PlaygroundVariant[];
  golden_set?: { golden_set_id: string; name: string; version: number; sha256: string };
  inputs_sha256: string;
  examples: { example_id: string; inputs: Json; expectations?: Json; category?: string }[];
  trials: number;
  outputs: Record<string, CallOutput[]>;
  capture: string;
  traces_written: number;
  trace_errors: number;
  saved_as?: string;
}

export function params(raw: unknown): GenerationParams {
  const p = (typeof raw === "object" && raw !== null ? raw : {}) as Json;
  const dec = (k: string, max: number): string | undefined => {
    const v = p[k];
    if (v === undefined) return undefined;
    const s = typeof v === "number" ? String(v) : v;
    if (typeof s !== "string" || !DECIMAL_RE.test(s) || Number(s) > max)
      throw new HttpError(400, "invalid_request", `params.${k} must be a decimal 0..${max}`);
    return s;
  };
  const int = (k: string, min: number, max: number): number | undefined => {
    const v = p[k];
    if (v === undefined) return undefined;
    if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max)
      throw new HttpError(400, "invalid_request", `params.${k} must be an integer ${min}..${max}`);
    return v as number;
  };
  const stop = p["stop"];
  if (
    stop !== undefined &&
    (!Array.isArray(stop) ||
      stop.length > 4 ||
      stop.some((x) => typeof x !== "string" || x.length > 100))
  )
    throw new HttpError(400, "invalid_request", "params.stop is at most 4 strings");
  for (const k of Object.keys(p))
    if (!["temperature", "top_p", "max_tokens", "seed", "stop"].includes(k))
      throw new HttpError(400, "invalid_request", `unknown parameter ${k}`);
  return compact({
    temperature: dec("temperature", 2),
    top_p: dec("top_p", 1),
    max_tokens: int("max_tokens", 1, 32768),
    seed: int("seed", 0, 2_147_483_647),
    stop: stop as string[] | undefined,
  }) as GenerationParams;
}

function b64(n: number): string {
  return randomBytes(n).toString("base64");
}

/** The two spans of one playground call, in MLflow's `traces.json` format. */
export function callSpans(
  v: PlaygroundVariant,
  inputs: Json,
  messages: unknown,
  out: CallOutput,
  startMs: number,
): RawSpan[] {
  const tid = b64(16);
  const root = b64(8);
  const ns = (ms: number) => Math.round(ms * 1e6);
  const end = startMs + out.latency_ms;
  const status = out.error
    ? { code: "STATUS_CODE_ERROR", message: out.error }
    : { code: "STATUS_CODE_OK", message: "" };
  const events = out.error
    ? [
        {
          name: "exception",
          time_unix_nano: ns(end),
          attributes: { "exception.type": "ProviderError", "exception.message": out.error },
        },
      ]
    : [];
  return [
    {
      trace_id: tid,
      span_id: root,
      parent_span_id: null,
      name: `playground ${v.label}`,
      start_time_unix_nano: ns(startMs),
      end_time_unix_nano: ns(end),
      status,
      events: [],
      attributes: {
        "mlflow.spanType": JSON.stringify("CHAIN"),
        "mlflow.spanInputs": JSON.stringify(inputs),
        "mlflow.spanOutputs": JSON.stringify(out.output ?? null),
      },
    },
    {
      trace_id: tid,
      span_id: b64(8),
      parent_span_id: root,
      name: "chat_completion",
      start_time_unix_nano: ns(startMs),
      end_time_unix_nano: ns(end),
      status,
      events,
      attributes: compact({
        "mlflow.spanType": JSON.stringify("CHAT_MODEL"),
        "mlflow.spanInputs": JSON.stringify({ messages, model: v.model, params: v.params }),
        "mlflow.spanOutputs": JSON.stringify(out.output ?? null),
        "mlflow.chat.tokenUsage": out.usage ? JSON.stringify(out.usage) : undefined,
        "ablationkit.llm.model": JSON.stringify(out.model_reported ?? v.model),
        "ablationkit.llm.provider": JSON.stringify(v.provider_id),
      }) as Record<string, string>,
    },
  ];
}

export class PlaygroundService {
  private readonly results = new Map<string, PlaygroundResult>();
  private readonly evidence = new Map<string, LlmEvidenceRecord>();
  readonly loadProblems: string[] = [];

  constructor(
    private readonly o: {
      svc: () => ExtensionResearchHost;
      stateDir: string;
      now: () => Date;
      settings: LlmSettingsStore;
      prompts: PromptService;
      golden: GoldenSetService;
      traces: TraceService;
    },
  ) {}

  private get svc(): ExtensionResearchHost {
    return this.o.svc();
  }

  private evDir(pid: string): string {
    return join(this.o.stateDir, pid, "llm", "evidence");
  }

  load(projects: readonly string[]): void {
    for (const pid of projects) {
      const d = this.evDir(pid);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith(".json")))
        try {
          const r = readJson(join(d, f), validateLlmEvidenceRecord);
          this.evidence.set(r.evidence_id, r);
        } catch {
          this.loadProblems.push(join(d, f));
        }
    }
  }

  private sweep(): void {
    const cut = this.o.now().getTime() - RESULT_TTL_MS;
    for (const [k, r] of this.results) if (Date.parse(r.created_at) < cut) this.results.delete(k);
    while (this.results.size > MAX_RESULTS)
      this.results.delete(this.results.keys().next().value as string);
  }

  /** Resolve one requested variant (prompt pinned now) and check the provider's egress for `data`. */
  async variant(pid: string, raw: Json, data: EgressData): Promise<PlaygroundVariant> {
    const label = raw["label"];
    if (typeof label !== "string" || !LABEL_RE.test(label))
      throw new HttpError(
        400,
        "invalid_request",
        "each variant needs a label ([A-Za-z0-9_.-]{1,40})",
      );
    const providerId = String(raw["provider_id"] ?? "");
    const model = String(raw["model"] ?? "");
    const use = this.o.settings.provider(pid, providerId, model, data);
    let template: Template;
    let prompt: PinnedPrompt | undefined;
    let adhoc: PlaygroundVariant["adhoc"];
    if (raw["prompt"] !== undefined) {
      const r = await this.o.prompts.resolve(pid, raw["prompt"]);
      template = r.template;
      prompt = r.pinned;
    } else if (typeof raw["template"] === "string" || Array.isArray(raw["template"])) {
      template = raw["template"] as Template;
      if (
        Array.isArray(template) &&
        !template.every((m) => typeof m?.role === "string" && typeof m?.content === "string")
      )
        throw new HttpError(
          400,
          "invalid_request",
          `${label}: chat templates are lists of {role, content}`,
        );
      adhoc = {
        template_sha256: templateSha(template),
        format: isChat(template) ? "chat" : "text",
      };
    } else
      throw new HttpError(
        400,
        "invalid_request",
        `${label}: give a prompt (name@alias, name/version) or a template`,
      );
    return compact({
      label,
      prompt,
      adhoc,
      template,
      provider_id: providerId,
      model,
      params: params(raw["params"]),
      locality: use.provider.locality,
    }) as PlaygroundVariant;
  }

  async run(
    pid: string,
    body: Json,
    actor: Actor,
    signal?: AbortSignal,
  ): Promise<PlaygroundResult> {
    this.svc.registry.require(pid);
    const rawVariants = body["variants"];
    if (!Array.isArray(rawVariants) || rawVariants.length < 1 || rawVariants.length > 6)
      throw new HttpError(400, "invalid_request", "variants must be a list of 1..6");
    const trials = (body["trials"] ?? 1) as number;
    if (!Number.isSafeInteger(trials) || trials < 1 || trials > 5)
      throw new HttpError(400, "invalid_request", "trials must be 1..5");
    // Inputs: a pinned golden-set version (dataset egress) or ad-hoc rows.
    let examples: PlaygroundResult["examples"];
    let golden: PlaygroundResult["golden_set"];
    let data: EgressData = "adhoc";
    const gs = body["golden_set"] as Json | undefined;
    if (gs !== undefined) {
      const pinned = this.o.golden.examples(
        pid,
        String(gs["id"] ?? gs["name"] ?? ""),
        gs["version"] as number | undefined,
      );
      const limit = (gs["limit"] ?? pinned.examples.length) as number;
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new HttpError(400, "invalid_request", "golden_set.limit must be positive");
      examples = pinned.examples.slice(0, limit).map((e) =>
        compact({
          example_id: e.example_id,
          inputs: e.inputs,
          expectations: e.expectations,
          category: e.category,
        }),
      );
      golden = {
        golden_set_id: pinned.set.golden_set_id,
        name: pinned.set.name,
        version: pinned.version.version,
        sha256: pinned.version.sha256,
      };
      data = "dataset";
    } else {
      const rows = body["inputs"];
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100)
        throw new HttpError(
          400,
          "invalid_request",
          "inputs must be a list of 1..100 objects (prompt variables), or give golden_set",
        );
      examples = rows.map((r, i) => {
        if (typeof r !== "object" || r === null || Array.isArray(r))
          throw new HttpError(
            400,
            "invalid_request",
            `inputs[${i}] must be an object of prompt variables`,
          );
        return { example_id: `in-${i + 1}`, inputs: r as Json };
      });
    }
    const variants: PlaygroundVariant[] = [];
    for (const v of rawVariants as Json[]) variants.push(await this.variant(pid, v, data));
    if (new Set(variants.map((v) => v.label)).size !== variants.length)
      throw new HttpError(400, "invalid_request", "variant labels must be unique");
    const calls = examples.length * trials * variants.length;
    if (calls > MAX_PLAYGROUND_CALLS)
      throw new HttpError(
        422,
        "too_many_calls",
        `${calls} calls; the playground runs at most ${MAX_PLAYGROUND_CALLS} (use a GenAI evaluation)`,
      );
    // Every variant's prompt variables must be filled by every input before anything is sent.
    const missing: string[] = [];
    for (const v of variants)
      for (const e of examples) {
        const m = renderPrompt(v.template, e.inputs).missing;
        if (m.length) missing.push(`${v.label}/${e.example_id}: ${m.join(", ")}`);
      }
    if (missing.length)
      throw new HttpError(422, "missing_variables", "inputs do not fill every prompt variable", {
        missing: missing.slice(0, 50),
      });
    const capture = this.o.settings.capture(pid).mode;
    const writeTraces = body["trace"] !== false && capture !== "off";
    const result: PlaygroundResult = compact({
      result_id: `pr-${randomBytes(8).toString("hex")}`,
      project_id: pid,
      created_at: this.o.now().toISOString(),
      created_by: actor,
      variants,
      golden_set: golden,
      inputs_sha256: createHash("sha256")
        .update(JSON.stringify(examples.map((e) => [e.example_id, e.inputs])))
        .digest("hex"),
      examples,
      trials,
      outputs: Object.fromEntries(variants.map((v) => [v.label, [] as CallOutput[]])),
      capture: writeTraces ? capture : "off",
      traces_written: 0,
      trace_errors: 0,
    }) as PlaygroundResult;
    this.svc.audit.record({
      actor: compact({ kind: "human" as const, id: actor.id }),
      listener: "human",
      action: "llm.playground.run",
      outcome: "allowed",
      project_id: pid,
      target: result.result_id,
      details: compact({
        calls,
        variants: variants.map((v) => `${v.label}:${v.provider_id}/${v.model}:${v.locality}`),
        golden_set: golden ? `${golden.golden_set_id}/${golden.version}` : undefined,
      }),
    });
    const jobs: { v: PlaygroundVariant; e: PlaygroundResult["examples"][number]; trial: number }[] =
      [];
    for (const e of examples)
      for (let t = 1; t <= trials; t++) for (const v of variants) jobs.push({ v, e, trial: t });
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (signal?.aborted) return;
        const j = jobs[next++];
        if (!j) return;
        const out = await this.call(pid, j.v, j.e.inputs, j.e.example_id, j.trial, signal, data);
        if (writeTraces) {
          try {
            const startMs = Date.now() - out.latency_ms;
            const rendered = renderPrompt(j.v.template, j.e.inputs).messages;
            const id = await this.o.traces.write(pid, {
              name: `playground ${j.v.label}`,
              spans: callSpans(j.v, j.e.inputs, rendered, out, startMs),
              state: out.error ? "ERROR" : "OK",
              request_time: new Date(startMs).toISOString(),
              duration_ms: out.latency_ms,
              request_preview: JSON.stringify(j.e.inputs),
              response_preview: out.output ?? "",
              tags: compact({
                [TRACE_TAGS.source]: "playground",
                [TRACE_TAGS.variant]: j.v.label,
                [TRACE_TAGS.example]: j.e.example_id,
                [TRACE_TAGS.model]: j.v.model,
                [TRACE_TAGS.prompt]: j.v.prompt
                  ? `${j.v.prompt.name}/${j.v.prompt.version}`
                  : undefined,
                [TRACE_TAGS.golden]: golden
                  ? `${golden.golden_set_id}/${golden.version}`
                  : undefined,
                "ablationkit.playground": result.result_id,
              }) as Record<string, string>,
              metadata: out.usage ? { "mlflow.trace.tokenUsage": JSON.stringify(out.usage) } : {},
            });
            if (id) {
              out.trace_id = id;
              result.traces_written++;
            }
          } catch {
            result.trace_errors++;
          }
        }
        (result.outputs[j.v.label] as CallOutput[]).push(out);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
    if (signal?.aborted) throw new HttpError(499, "canceled", "the request was canceled");
    this.sweep();
    this.results.set(result.result_id, result);
    return result;
  }

  private async call(
    pid: string,
    v: PlaygroundVariant,
    inputs: Json,
    exampleId: string,
    trial: number,
    signal?: AbortSignal,
    data: EgressData = "adhoc",
  ): Promise<CallOutput> {
    const use = this.o.settings.provider(pid, v.provider_id, v.model, data);
    const r = await chatCompletion({
      baseUrl: use.provider.base_url,
      apiKey: use.apiKey,
      data: data,
      model: v.model,
      messages: renderPrompt(v.template, inputs).messages,
      params: v.params,
      timeoutMs: (use.provider.timeout_sec ?? 60) * 1000,
      signal,
    });
    return compact({
      example_id: exampleId,
      trial,
      output: r.text,
      error: r.error
        ? `${r.error.code}${r.error.status ? ` ${r.error.status}` : ""}: ${r.error.message}`
        : undefined,
      latency_ms: r.latency_ms,
      usage: r.usage,
      finish_reason: r.finish_reason,
      model_reported: r.model,
    }) as CallOutput;
  }

  result(pid: string, id: string): PlaygroundResult {
    this.sweep();
    const r = this.results.get(id);
    if (!r || r.project_id !== pid)
      throw new HttpError(
        404,
        "not_found",
        `no playground result ${id} (results are kept for one hour)`,
      );
    return r;
  }

  /** The result with the aligned per-example view and per-variant summaries. */
  view(r: PlaygroundResult): Json {
    const order = r.examples.map((e) => e.example_id);
    return {
      ...r,
      variants: r.variants.map(({ template, ...v }) => ({ ...v, template })),
      rows: alignExamples(
        order,
        r.variants.map((v) => ({ label: v.label, examples: r.outputs[v.label] ?? [] })),
      ).map((row) => ({
        ...row,
        expectations: r.examples.find((e) => e.example_id === row.example_id)?.expectations,
        inputs: r.examples.find((e) => e.example_id === row.example_id)?.inputs,
        trials: Object.fromEntries(
          r.variants.map((v) => [
            v.label,
            (r.outputs[v.label] ?? []).filter((o) => o.example_id === row.example_id),
          ]),
        ),
      })),
      summary: Object.fromEntries(
        r.variants.map((v) => {
          const outs = r.outputs[v.label] ?? [];
          const usage = sumUsage(outs.filter((o) => !o.error).map((o) => o.usage));
          const cost = estimateCost(
            usage,
            this.o.settings.rate(r.project_id, v.provider_id, v.model),
          );
          return [
            v.label,
            compact({
              calls: outs.length,
              errors: outs.filter((o) => o.error).length,
              usage,
              latency_ms: latencySummary(outs.map((o) => o.latency_ms)),
              cost,
              cost_unavailable: cost
                ? undefined
                : usage.reported === 0
                  ? "the provider reported no token usage"
                  : "no rate configured for this model",
              distinct_outputs: new Set(outs.map((o) => o.output)).size,
            }),
          ];
        }),
      ),
    };
  }

  // ------------------------------------------------------------------ evidence

  private saveEvidence(r: LlmEvidenceRecord): void {
    mkdirSync(this.evDir(r.project_id), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.evDir(r.project_id), `${r.evidence_id}.json`), r, {
      validate: validateLlmEvidenceRecord,
    });
    this.evidence.set(r.evidence_id, r);
  }

  listEvidence(pid: string): LlmEvidenceRecord[] {
    this.svc.registry.require(pid);
    return [...this.evidence.values()]
      .filter((r) => r.project_id === pid)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  getEvidence(pid: string, id: string): LlmEvidenceRecord {
    const r = this.evidence.get(id);
    if (!r || r.project_id !== pid) throw new HttpError(404, "not_found", `no LLM evidence ${id}`);
    return r;
  }

  async save(pid: string, resultId: string, body: Json, actor: Actor): Promise<LlmEvidenceRecord> {
    const project = this.svc.registry.require(pid);
    const r = this.result(pid, resultId);
    if (r.saved_as)
      throw new HttpError(409, "already_saved", `result ${resultId} is saved as ${r.saved_as}`);
    const unpinned = r.variants.filter((v) => !v.prompt).map((v) => v.label);
    if (unpinned.length)
      throw new HttpError(
        409,
        "unpinned_prompt",
        `register the prompt of ${unpinned.join(", ")} as a version first; evidence needs pinned prompts`,
      );
    const title = body["title"] ?? `Playground: ${r.variants.map((v) => v.label).join(" vs ")}`;
    if (typeof title !== "string" || !title.trim() || title.length > 300)
      throw new HttpError(400, "invalid_request", "title must be 1..300 characters");
    const note = body["note"];
    if (note !== undefined && (typeof note !== "string" || note.length > 4000))
      throw new HttpError(400, "invalid_request", "note is at most 4000 characters");
    const link = body["link"] as ObjectRef | undefined;
    if (link !== undefined) {
      const rec =
        typeof link?.id === "string" ? await this.svc.research.get(pid, link.id) : undefined;
      if (!rec || rec.kind !== link.kind)
        throw new HttpError(
          422,
          "unknown_link",
          "link must name a research record of this project",
        );
    }
    const policy = this.o.settings.capture(pid);
    // Saved evidence keeps bodies (that is the point of saving) but still honours redaction.
    const red = redactor(policy);
    const scrub = <T>(v: T): T => (policy.mode === "full" ? v : (red.value(v) as T));
    const id = `lx-${randomBytes(8).toString("hex")}`;
    const targets: LlmTarget[] = r.variants.map((v) => ({
      kind: "prompt" as const,
      label: v.label,
      prompt: v.prompt as PinnedPrompt,
      provider_id: v.provider_id,
      model: v.model,
      params: v.params,
    }));
    const view = this.view(r);
    const doc = {
      schema: "ablationkit.llm_evidence/v1",
      evidence_id: id,
      title,
      note,
      targets,
      golden_set: r.golden_set,
      inputs_sha256: r.inputs_sha256,
      trials: r.trials,
      examples: scrub(r.examples),
      outputs: scrub(r.outputs),
      summary: view["summary"],
      capture: policy.mode,
      code_revision: gitHead(project.path),
      ran_at: r.created_at,
      saved_at: this.o.now().toISOString(),
      saved_by: actor,
    };
    const text = JSON.stringify(doc);
    if (Buffer.byteLength(text) > 16 * 1024 * 1024)
      throw new HttpError(413, "too_large", "evidence is limited to 16 MiB");
    const trace_ids = Object.values(r.outputs).flatMap((o) =>
      o.map((x) => x.trace_id).filter((x): x is string => !!x),
    );
    let runId: string;
    let experimentId: string;
    const c = this.svc.tracking.client;
    try {
      experimentId = await this.svc.tracking.ensureExperimentNow(pid);
      const run = await c.createRun({
        experiment_id: experimentId,
        run_name: `llm evidence ${id.slice(3, 11)}`,
        tags: [
          { key: TAGS.project, value: pid },
          { key: TAGS.kind, value: "llm_evidence" },
          { key: "ablationkit.evidence_id", value: id },
          {
            key: "ablationkit.prompts",
            value: targets
              .map((t) => (t.kind === "prompt" ? `${t.prompt.name}/${t.prompt.version}` : ""))
              .join(",")
              .slice(0, 5000),
          },
          {
            key: "ablationkit.models",
            value: targets
              .map((t) => (t.kind === "prompt" ? `${t.provider_id}/${t.model}` : ""))
              .join(",")
              .slice(0, 5000),
          },
          { key: "ablationkit.input_sha256", value: r.inputs_sha256 },
          ...(r.golden_set
            ? [
                {
                  key: "ablationkit.golden_set",
                  value: `${r.golden_set.golden_set_id}/${r.golden_set.version}`,
                },
              ]
            : []),
          { key: "mlflow.note.content", value: (note as string | undefined) ?? title },
        ],
      });
      runId = run.info.run_id;
      try {
        await c.uploadArtifact(run.info, EVIDENCE_ARTIFACT, text);
        await c.updateRun({ run_id: runId, status: "FINISHED", end_time: Date.now() });
      } catch (e) {
        await c
          .updateRun({ run_id: runId, status: "FAILED", end_time: Date.now() })
          .catch(() => {});
        throw e;
      }
    } catch (e) {
      if (e instanceof MlflowError)
        throw new HttpError(
          503,
          "tracking_unavailable",
          `MLflow is unavailable; nothing was saved: ${e.message}`,
        );
      throw e;
    }
    const rec: LlmEvidenceRecord = compact({
      schema_version: 1 as const,
      evidence_id: id,
      project_id: pid,
      kind: "playground" as const,
      title,
      note: note as string | undefined,
      targets,
      golden_set: r.golden_set
        ? {
            golden_set_id: r.golden_set.golden_set_id,
            version: r.golden_set.version,
            sha256: r.golden_set.sha256,
          }
        : undefined,
      inputs_sha256: r.inputs_sha256,
      examples: r.examples.length,
      trace_ids: trace_ids.slice(0, 10_000),
      mlflow_run_id: runId,
      experiment_id: experimentId,
      artifact_path: EVIDENCE_ARTIFACT,
      artifact_bytes: Buffer.byteLength(text),
      stored: ["inputs", "outputs", "expectations", "usage", "timings", "variants", "provenance"],
      source_commit: doc.code_revision,
      created_by: compact({ kind: "human" as const, id: actor.id }),
      created_at: doc.saved_at,
    }) as LlmEvidenceRecord;
    this.saveEvidence(rec);
    this.results.set(r.result_id, { ...r, saved_as: id });
    if (link) {
      const target = await this.svc.research.get(pid, link.id);
      if (target)
        await this.svc.research.update(
          pid,
          link.id,
          { links: [...target.links, { kind: "llm_evidence", id, label: title.slice(0, 300) }] },
          compact({ kind: "human" as const, id: actor.id }),
        );
    }
    this.svc.audit.record({
      actor: compact({ kind: "human" as const, id: actor.id }),
      listener: "human",
      action: "llm.evidence.save",
      outcome: "allowed",
      project_id: pid,
      target: id,
      details: { result: resultId, mlflow_run_id: runId, bytes: rec.artifact_bytes },
    });
    this.svc.events.publish(pid, "llm.evidence.saved", { evidence_id: id });
    return rec;
  }

  async deleteEvidence(pid: string, id: string, actor: Actor): Promise<LlmEvidenceRecord> {
    const r = this.getEvidence(pid, id);
    if (r.deleted_at) return r;
    try {
      await this.svc.tracking.client.deleteRun(r.mlflow_run_id);
    } catch (e) {
      if (!(e instanceof MlflowError && e.notFound)) {
        if (e instanceof MlflowError)
          throw new HttpError(
            503,
            "tracking_unavailable",
            `MLflow is unavailable; nothing was deleted: ${e.message}`,
          );
        throw e;
      }
    }
    const next = { ...r, deleted_at: this.o.now().toISOString() };
    this.saveEvidence(next);
    this.svc.audit.record({
      actor: compact({ kind: "human" as const, id: actor.id }),
      listener: "human",
      action: "llm.evidence.delete",
      outcome: "allowed",
      project_id: pid,
      target: id,
    });
    this.svc.events.publish(pid, "llm.evidence.deleted", { evidence_id: id });
    return next;
  }
}
