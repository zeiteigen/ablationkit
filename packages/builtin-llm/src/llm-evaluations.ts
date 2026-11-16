/**
 * GenAI evaluation (spec §5.6.1 mode 3 for GenAI, §5.6.2 items 2, 4, 5 and the LLM-first loop;
 * criteria 10, 10a, 10b, 10c, 10e; ADR 0021).
 *
 * One evaluation runs one to six pinned targets over one golden-set version through
 * `mlflow.genai.evaluate` in the operations bridge: a `prompt` target is a prompt version (an
 * alias is resolved and recorded) sent to one provider model with fixed decoding parameters; a
 * `recorded` target is the traces a project job already recorded over the same golden set (a RAG
 * or agent application), which are scored where they are. Each target is its own MLflow run with
 * traces and assessments; the per-example results are its `ablationkit/llm/examples.json`.
 *
 * Before anything runs: prompts resolve, every prompt variable is filled by every example, every
 * provider (generation and judges) passes the egress check for dataset rows, the call budget fits,
 * and project scorers (project code) need an explicit acknowledgement. Researcher-only: running
 * models spends money and can send data out.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import { HttpError } from "@ablationkit/core/http";
import type {
  ExtensionPythonBridge,
  ExtensionPythonRun,
  ExtensionResearchHost,
} from "@ablationkit/extension-host/backend";
import {
  alignExamples,
  BUILTIN_REDACTIONS,
  type ExampleResultLike,
  estimateCost,
  renderPrompt,
  type Template,
} from "@ablationkit/llm-research";
import {
  type GoldenExample,
  type LlmEgressUse,
  type LlmEvaluationRecord,
  type LlmTarget,
  type ScorerRef,
  validateLlmEvaluationRecord,
} from "@ablationkit/protocol";
import { MlflowError, type MlflowTag, TAGS } from "@ablationkit/tracking-mlflow";
import type { GoldenSetService } from "./golden-sets.ts";
import { compact, gitHead } from "./helpers.ts";
import type { LlmSettingsStore } from "./llm-settings.ts";
import { params as parseParams } from "./playground.ts";
import type { PromptService } from "./prompts.ts";
import { TRACE_TAGS, type TraceService } from "./traces.ts";

type Json = Record<string, unknown>;
type Actor = { kind: "human" | "agent"; id?: string };

const TERMINAL = new Set(["succeeded", "failed", "canceled", "interrupted"]);
const BUILTINS = new Set([
  "exact_match",
  "contains_expected",
  "expected_facts",
  "regex",
  "max_length",
  "retrieval_recall",
  "has_citation",
  "tool_called",
]);
const EXAMPLES_ARTIFACT = "ablationkit/llm/examples.json";

export interface ExampleRow extends ExampleResultLike {
  scores?: Record<string, { value?: unknown; rationale?: string; error?: string }>;
  usage?: Record<string, number>;
}

/** Tags of one target's MLflow run (local and remote evaluations alike). */
function runTags(
  pid: string,
  id: string,
  goldenRef: string,
  goldenSha: string,
  t: LlmTarget,
): MlflowTag[] {
  return [
    { key: TAGS.project, value: pid },
    { key: TAGS.kind, value: "llm_evaluation" },
    { key: "ablationkit.llm_evaluation", value: id },
    { key: "ablationkit.variant", value: t.label },
    { key: "ablationkit.golden_set", value: goldenRef },
    { key: "ablationkit.golden_sha256", value: goldenSha },
    ...(t.kind === "prompt"
      ? [
          { key: "ablationkit.prompt", value: `${t.prompt.name}/${t.prompt.version}` },
          { key: "ablationkit.model", value: `${t.provider_id}/${t.model}` },
        ]
      : [{ key: "ablationkit.source_run", value: t.source_run_id }]),
  ];
}

function sha(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

export class LlmEvaluationService {
  private readonly records = new Map<string, LlmEvaluationRecord>();
  private readonly running = new Map<string, ExtensionPythonRun>();
  private readonly queue: string[] = [];
  /** Prompt templates and provider endpoints per queued evaluation (not persisted: rebuilt never). */
  private readonly pending = new Map<
    string,
    { request: Json; secretEnv: Record<string, string> }
  >();
  private stopped = false;
  private remoteTimer: ReturnType<typeof setInterval> | undefined;
  private reconciling = false;
  readonly loadProblems: string[] = [];

  constructor(
    private readonly o: {
      svc: () => ExtensionResearchHost;
      stateDir: string;
      now: () => Date;
      bridge: ExtensionPythonBridge;
      settings: LlmSettingsStore;
      prompts: PromptService;
      golden: GoldenSetService;
      traces: TraceService;
      maxConcurrent?: number;
      /** How often open remote evaluations follow their jobs (default 2 s). */
      remotePollMs?: number;
      /** Runs `fn` outside the current request's caller context (for timers). */
      detach?: <T>(fn: () => T) => T;
    },
  ) {}

  private get svc(): ExtensionResearchHost {
    return this.o.svc();
  }

  private dir(pid: string): string {
    return join(this.o.stateDir, pid, "llm", "evaluations");
  }

  private save(r: LlmEvaluationRecord): LlmEvaluationRecord {
    mkdirSync(this.dir(r.project_id), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.dir(r.project_id), `${r.evaluation_id}.json`), r, {
      validate: validateLlmEvaluationRecord,
    });
    this.records.set(r.evaluation_id, r);
    this.svc.events.publish(r.project_id, "llm.evaluation.updated", {
      evaluation_id: r.evaluation_id,
      state: r.state,
    });
    return r;
  }

  private update(id: string, patch: Partial<LlmEvaluationRecord>): LlmEvaluationRecord {
    const cur = this.records.get(id) as LlmEvaluationRecord;
    return this.save({ ...cur, ...patch, updated_at: this.o.now().toISOString() });
  }

  load(projects: readonly string[]): void {
    for (const pid of projects) {
      const d = this.dir(pid);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith(".json")))
        try {
          const r = readJson(join(d, f), validateLlmEvaluationRecord);
          this.records.set(r.evaluation_id, r);
        } catch {
          this.loadProblems.push(join(d, f));
        }
    }
  }

  /** A restart never resumes or reruns: anything unfinished is interrupted. */
  start(): void {
    for (const r of this.records.values()) {
      if (TERMINAL.has(r.state)) continue;
      // A remote evaluation is supervised by its job: it reconciles, it is never interrupted.
      if (r.remote) {
        this.ensureRemoteTimer();
        continue;
      }
      if (r.state === "running") this.o.bridge.reap(r.evaluation_id);
      this.update(r.evaluation_id, {
        state: "interrupted",
        ended_at: this.o.now().toISOString(),
        error:
          "the coordinator stopped before this evaluation finished; it was not rerun (that would spend model calls again).",
      });
      void this.endRuns(r, "KILLED");
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    if (this.remoteTimer) clearInterval(this.remoteTimer);
    this.remoteTimer = undefined;
  }

  list(pid: string): LlmEvaluationRecord[] {
    this.svc.registry.require(pid);
    return [...this.records.values()]
      .filter((r) => r.project_id === pid)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(pid: string, id: string): LlmEvaluationRecord {
    const r = this.records.get(id);
    if (!r || r.project_id !== pid)
      throw new HttpError(404, "not_found", `no GenAI evaluation ${id}`);
    return r;
  }

  // ------------------------------------------------------------------ create

  private scorer(
    pid: string,
    raw: Json,
    ack: boolean,
    egress: LlmEgressUse[],
    secretEnv: Record<string, string>,
  ): { ref: ScorerRef; bridge: Json } {
    const name = raw["name"];
    if (typeof name !== "string" || !/^[a-z0-9_]{1,64}$/.test(name))
      throw new HttpError(400, "invalid_request", "scorer names match [a-z0-9_]{1,64}");
    const kind =
      raw["kind"] ??
      (raw["builtin"]
        ? "builtin"
        : raw["judge"]
          ? "judge"
          : raw["project"]
            ? "project"
            : undefined);
    const p = raw["params"] as Record<string, unknown> | undefined;
    const paramsOut =
      p === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(p).map(([k, v]) => {
              if (typeof v !== "string" && typeof v !== "number")
                throw new HttpError(400, "invalid_request", `${name}.params.${k} must be a string`);
              return [k, String(v).slice(0, 500)];
            }),
          );
    if (kind === "builtin") {
      const b = String(raw["builtin"] ?? name);
      if (!BUILTINS.has(b))
        throw new HttpError(
          400,
          "invalid_request",
          `unknown builtin scorer ${b}; one of ${[...BUILTINS].join(", ")}`,
        );
      if (b === "regex") {
        try {
          new RegExp(String(paramsOut?.["pattern"] ?? ""));
        } catch {
          throw new HttpError(
            400,
            "invalid_request",
            `${name}: params.pattern must be a regular expression`,
          );
        }
        if (!paramsOut?.["pattern"])
          throw new HttpError(400, "invalid_request", `${name}: params.pattern is required`);
      }
      if (b === "tool_called" && !paramsOut?.["tool"])
        throw new HttpError(400, "invalid_request", `${name}: params.tool is required`);
      const ref = compact({
        name,
        kind: "builtin" as const,
        builtin: b as ScorerRef["builtin"],
        params: paramsOut,
      }) as ScorerRef;
      return { ref, bridge: { ...ref } };
    }
    if (kind === "judge") {
      const j = (raw["judge"] ?? {}) as Json;
      const providerId = String(j["provider_id"] ?? "");
      const model = String(j["model"] ?? "");
      const use = this.o.settings.provider(pid, providerId, model, "dataset");
      const rubric = j["rubric"];
      if (typeof rubric !== "string" || !rubric.trim() || rubric.length > 8000)
        throw new HttpError(400, "invalid_request", `${name}: judge.rubric is 1..8000 characters`);
      const uses = j["uses"] ?? "answer";
      if (uses !== "answer" && uses !== "grounding")
        throw new HttpError(400, "invalid_request", `${name}: judge.uses is answer or grounding`);
      const judge = compact({
        provider_id: providerId,
        model,
        locality: use.provider.locality,
        rubric,
        rubric_sha256: sha(rubric),
        uses: uses as "answer" | "grounding",
        params: parseParams(j["params"] ?? { temperature: "0" }),
      });
      if (!egress.some((e) => e.provider_id === providerId && e.purpose === "judge"))
        egress.push(
          compact({
            provider_id: providerId,
            locality: use.provider.locality,
            purpose: "judge" as const,
            approved_at: use.provider.egress?.approved_at,
          }) as LlmEgressUse,
        );
      const keyEnv = this.keyEnv(providerId, use.apiKey, secretEnv);
      const ref = compact({ name, kind: "judge" as const, judge }) as ScorerRef;
      return {
        ref,
        bridge: {
          ...ref,
          judge_provider: compact({
            provider_id: providerId,
            base_url: use.provider.base_url,
            timeout_sec: use.provider.timeout_sec,
            api_key_env: keyEnv,
          }),
        },
      };
    }
    if (kind === "project") {
      const pr = (raw["project"] ?? {}) as Json;
      const root = this.svc.registry.require(pid).path;
      const rel = pr["path"];
      if (
        typeof rel !== "string" ||
        !rel.endsWith(".py") ||
        rel.startsWith("/") ||
        rel.split("/").includes("..")
      )
        throw new HttpError(
          400,
          "invalid_request",
          `${name}: project.path is a .py file inside the checkout`,
        );
      const abs = resolve(root, rel);
      if (!abs.startsWith(root + sep) || !existsSync(abs) || !statSync(abs).isFile())
        throw new HttpError(404, "file_not_found", `${name}: no file ${rel} in the checkout`);
      const fn = pr["function"];
      if (typeof fn !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(fn))
        throw new HttpError(
          400,
          "invalid_request",
          `${name}: project.function must be a Python name`,
        );
      if (!ack)
        throw new HttpError(
          409,
          "project_code_acknowledgement_required",
          `${name} runs project code (${rel}) in the evaluation worker; set acknowledge_project_code`,
        );
      const ref = compact({
        name,
        kind: "project" as const,
        project: compact({
          path: rel,
          function: fn,
          sha256: sha(readFileSync(abs)),
          commit: gitHead(root),
        }),
      }) as ScorerRef;
      return { ref, bridge: { ...ref } };
    }
    throw new HttpError(400, "invalid_request", `${name}: kind is builtin, judge or project`);
  }

  private keyEnv(
    providerId: string,
    key: string | undefined,
    secretEnv: Record<string, string>,
  ): string | undefined {
    if (!key) return undefined;
    const name = `AK_LLM_KEY_${providerId.replaceAll("-", "_").toUpperCase()}`;
    secretEnv[name] = key;
    return name;
  }

  private async recordedTraces(
    pid: string,
    runId: string,
    ids: Set<string>,
  ): Promise<{ trace_id: string; example_id: string }[]> {
    const c = this.svc.tracking.client;
    const run = await c.getRun(runId).catch((e: unknown) => {
      if (e instanceof MlflowError && e.notFound)
        throw new HttpError(404, "not_found", `no MLflow run ${runId}`);
      throw e;
    });
    if (!this.svc.models.experimentIds(pid).includes(run.info.experiment_id))
      throw new HttpError(404, "not_found", `run ${runId} is not in this project`);
    const out: { trace_id: string; example_id: string }[] = [];
    let token: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await c.searchTraces(
        compact({
          experiment_ids: [run.info.experiment_id],
          filter: `run_id = '${runId}'`,
          max_results: 100,
          page_token: token,
        }),
      );
      for (const t of page.items) {
        const ex = t.tags?.[TRACE_TAGS.example];
        if (ex && ids.has(ex) && !out.some((o) => o.example_id === ex))
          out.push({ trace_id: t.trace_id, example_id: ex });
      }
      token = page.next_page_token;
      if (!token) break;
    }
    return out;
  }

  async create(pid: string, body: Json, actor: Actor): Promise<LlmEvaluationRecord> {
    const project = this.svc.registry.require(pid);
    const targetId = body["target_id"];
    if (targetId !== undefined) {
      if (actor.kind !== "human")
        throw new HttpError(
          403,
          "remote_humans_only",
          "only a researcher runs an evaluation on a remote target",
        );
      if (typeof targetId !== "string" || !(await this.svc.compute.target(targetId)))
        throw new HttpError(404, "target_not_found", `no compute target ${String(targetId)}`);
    } else {
      const unavailable = this.o.bridge.available("managed");
      if (unavailable)
        throw new HttpError(503, "bridge_unavailable", `cannot evaluate: ${unavailable}`);
    }
    const gs = (body["golden_set"] ?? {}) as Json;
    const pinned = this.o.golden.examples(
      pid,
      String(gs["id"] ?? gs["name"] ?? ""),
      gs["version"] as number | undefined,
    );
    const examples: GoldenExample[] = pinned.examples;
    const ids = new Set(examples.map((e) => e.example_id));
    const trials = (body["trials"] ?? 1) as number;
    if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10)
      throw new HttpError(400, "invalid_request", "trials must be 1..10");
    const timeout = (body["timeout_sec"] ?? 1800) as number;
    if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 86_400)
      throw new HttpError(400, "invalid_request", "timeout_sec must be 10..86400");
    const maxCalls = (body["max_calls"] ?? 1000) as number;
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100_000)
      throw new HttpError(400, "invalid_request", "max_calls must be 1..100000");
    const rawTargets = body["targets"];
    if (!Array.isArray(rawTargets) || rawTargets.length < 1 || rawTargets.length > 6)
      throw new HttpError(400, "invalid_request", "targets must be a list of 1..6");
    const egress: LlmEgressUse[] = [];
    const secretEnv: Record<string, string> = {};
    const targets: LlmTarget[] = [];
    const bridgeTargets: Json[] = [];
    let generationCalls = 0;
    let judgedItems = 0;
    try {
      for (const raw of rawTargets as Json[]) {
        const label = raw["label"];
        if (typeof label !== "string" || !/^[A-Za-z0-9_.-]{1,40}$/.test(label))
          throw new HttpError(
            400,
            "invalid_request",
            "each target needs a label ([A-Za-z0-9_.-]{1,40})",
          );
        if (targets.some((t) => t.label === label))
          throw new HttpError(400, "invalid_request", `target label ${label} is used twice`);
        if (raw["recorded"] !== undefined) {
          if (targetId !== undefined)
            throw new HttpError(
              422,
              "recorded_not_remote",
              `${label}: recorded traces live in MLflow on the workstation; score them locally`,
            );
          const runId = String((raw["recorded"] as Json)["run_id"] ?? "");
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId))
            throw new HttpError(
              400,
              "invalid_request",
              `${label}: recorded.run_id must be an MLflow run ID`,
            );
          const traces = await this.recordedTraces(pid, runId, ids);
          if (!traces.length)
            throw new HttpError(
              422,
              "no_matching_traces",
              `run ${runId} has no traces tagged with an example of ${pinned.set.name} v${pinned.version.version} (ablationkit.example_id)`,
            );
          targets.push({
            kind: "recorded",
            label,
            source_run_id: runId,
            traces: traces.length,
            matched: traces.length,
          });
          bridgeTargets.push({ kind: "recorded", label, source_run_id: runId, traces });
          judgedItems += traces.length;
          continue;
        }
        const providerId = String(raw["provider_id"] ?? "");
        const model = String(raw["model"] ?? "");
        const use = this.o.settings.provider(pid, providerId, model, "dataset");
        const resolved = await this.o.prompts.resolve(pid, raw["prompt"]);
        const missing = new Set<string>();
        for (const e of examples)
          for (const m of renderPrompt(resolved.template, e.inputs).missing) missing.add(m);
        if (missing.size)
          throw new HttpError(
            422,
            "missing_variables",
            `${label}: prompt variables ${[...missing].join(", ")} are not inputs of every example`,
          );
        const params = parseParams(raw["params"]);
        targets.push({
          kind: "prompt",
          label,
          prompt: resolved.pinned,
          provider_id: providerId,
          model,
          params,
        });
        if (!egress.some((e) => e.provider_id === providerId && e.purpose === "generation"))
          egress.push(
            compact({
              provider_id: providerId,
              locality: use.provider.locality,
              purpose: "generation" as const,
              approved_at: use.provider.egress?.approved_at,
            }) as LlmEgressUse,
          );
        bridgeTargets.push({
          kind: "prompt",
          label,
          template: resolved.template as Template,
          prompt: resolved.pinned,
          provider: compact({
            provider_id: providerId,
            base_url: use.provider.base_url,
            timeout_sec: use.provider.timeout_sec,
            api_key_env: this.keyEnv(providerId, use.apiKey, secretEnv),
          }),
          model,
          params,
        });
        generationCalls += examples.length * trials;
        judgedItems += examples.length * trials;
      }
    } catch (e) {
      if (e instanceof MlflowError)
        throw new HttpError(503, "tracking_unavailable", `MLflow is unavailable: ${e.message}`);
      throw e;
    }
    const rawScorers = body["scorers"];
    if (!Array.isArray(rawScorers) || rawScorers.length < 1 || rawScorers.length > 20)
      throw new HttpError(400, "invalid_request", "scorers must be a list of 1..20");
    const ack = body["acknowledge_project_code"] === true;
    const scorers = (rawScorers as Json[]).map((s) => this.scorer(pid, s, ack, egress, secretEnv));
    if (new Set(scorers.map((s) => s.ref.name)).size !== scorers.length)
      throw new HttpError(400, "invalid_request", "scorer names must be unique");
    const judges = scorers.filter((s) => s.ref.kind === "judge").length;
    const calls = generationCalls + judgedItems * judges;
    if (calls > maxCalls)
      throw new HttpError(
        422,
        "call_budget_exceeded",
        `this evaluation needs up to ${calls} model calls; max_calls is ${maxCalls}`,
        { calls, max_calls: maxCalls },
      );
    const settings = this.o.settings.get(pid);
    const id = `le-${randomBytes(8).toString("hex")}`;
    const now = this.o.now().toISOString();
    if (typeof targetId === "string")
      return this.createRemote(pid, project.path, targetId, body, actor, {
        id,
        now,
        pinned,
        examples,
        targets,
        bridgeTargets,
        scorers,
        trials,
        timeout,
        maxCalls,
        egress,
        secretEnv,
      });
    let experimentId: string;
    const runIds: string[] = [];
    try {
      experimentId = await this.svc.tracking.ensureExperimentNow(pid);
      for (const t of targets) {
        const tags = runTags(
          pid,
          id,
          `${pinned.set.golden_set_id}/${pinned.version.version}`,
          pinned.version.sha256,
          t,
        );
        const run = await this.svc.tracking.client.createRun({
          experiment_id: experimentId,
          run_name: `genai ${id.slice(3, 11)} ${t.label}`,
          tags,
        });
        runIds.push(run.info.run_id);
      }
    } catch (e) {
      if (e instanceof MlflowError)
        throw new HttpError(503, "tracking_unavailable", `MLflow is unavailable: ${e.message}`);
      throw e;
    }
    const rec: LlmEvaluationRecord = compact({
      schema_version: 1 as const,
      evaluation_id: id,
      project_id: pid,
      kind: "genai" as const,
      golden_set: {
        golden_set_id: pinned.set.golden_set_id,
        name: pinned.set.name,
        version: pinned.version.version,
        sha256: pinned.version.sha256,
        held_out: pinned.set.held_out,
        examples: examples.length,
      },
      targets,
      scorers: scorers.map((s) => s.ref),
      trials,
      retention: {
        capture: settings.capture.mode,
        retention_days: settings.capture.retention_days,
        settings_revision: settings.revision,
      },
      egress,
      environment: "managed" as const,
      state: "queued" as const,
      experiment_id: experimentId,
      results: targets.map((t, i) => ({ label: t.label, run_id: runIds[i] as string })),
      source_commit: gitHead(project.path),
      limits: { timeout_sec: timeout, max_calls: maxCalls },
      requested_by: compact({ kind: actor.kind, id: actor.id }),
      created_at: now,
      updated_at: now,
    }) as LlmEvaluationRecord;
    const capture = settings.capture;
    const request: Json = compact({
      op: "genai_evaluate",
      experiment_id: experimentId,
      golden_set: {
        golden_set_id: pinned.set.golden_set_id,
        name: pinned.set.name,
        version: pinned.version.version,
        sha256: pinned.version.sha256,
      },
      examples,
      trials,
      max_calls: maxCalls,
      targets: bridgeTargets.map((t, i) => ({ ...t, run_id: runIds[i] })),
      scorers: scorers.map((s) => s.bridge),
      capture: {
        mode: capture.mode,
        rules: [
          ...capture.builtin_redactions.map((b) => [b, BUILTIN_REDACTIONS[b]]),
          ...capture.patterns.map((p) => [p.name, p.regex]),
        ],
      },
      tags: {
        [TRACE_TAGS.project]: pid,
        [TRACE_TAGS.evaluation]: id,
        [TRACE_TAGS.golden]: `${pinned.set.golden_set_id}/${pinned.version.version}`,
        [TRACE_TAGS.capture]: capture.mode,
      },
      project_path: scorers.some((s) => s.ref.kind === "project") ? project.path : undefined,
    });
    this.save(rec);
    this.pending.set(id, { request, secretEnv });
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: actor.kind,
      action: "llm.evaluation.create",
      outcome: "allowed",
      project_id: pid,
      target: id,
      details: {
        golden_set: `${pinned.set.golden_set_id}/${pinned.version.version}`,
        targets: targets.map((t) =>
          t.kind === "prompt"
            ? `${t.label}:${t.prompt.name}/${t.prompt.version}@${t.provider_id}/${t.model}`
            : `${t.label}:recorded ${t.source_run_id}`,
        ),
        scorers: rec.scorers.map((s) => s.name),
        egress: egress.map((e) => `${e.provider_id}:${e.locality}:${e.purpose}`),
        max_calls: maxCalls,
      },
    });
    this.queue.push(id);
    this.pump();
    return rec;
  }

  // ------------------------------------------------------------------ remote (ADR 0023 decision 25)

  /**
   * A GenAI evaluation as a job on a compute target. The request (examples, prompts, keyless
   * provider endpoints, scorers) rides in the bundle; the targets' MLflow runs are created and
   * filled when the job's results have synced, so creating one needs neither MLflow nor the bridge.
   */
  private async createRemote(
    pid: string,
    root: string,
    targetId: string,
    body: Json,
    actor: Actor,
    p: {
      id: string;
      now: string;
      pinned: ReturnType<GoldenSetService["examples"]>;
      examples: GoldenExample[];
      targets: LlmTarget[];
      bridgeTargets: Json[];
      scorers: { ref: ScorerRef; bridge: Json }[];
      trials: number;
      timeout: number;
      maxCalls: number;
      egress: LlmEgressUse[];
      secretEnv: Record<string, string>;
    },
  ): Promise<LlmEvaluationRecord> {
    // A bundle is a file on someone else's machine: it never carries a provider key.
    const keyed = Object.keys(p.secretEnv);
    if (keyed.length)
      throw new HttpError(
        422,
        "provider_key_not_remote",
        "a remote evaluation calls providers from the compute target and its bundle carries no secrets: use a provider without an API key that the target can reach (a model served on the cluster or the tailnet), or run the evaluation locally",
      );
    for (const s of p.scorers) {
      const path = s.ref.project?.path;
      if (!path) continue;
      const dirty = Bun.spawnSync(["git", "-C", root, "status", "--porcelain", "--", path], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const tracked = Bun.spawnSync(
        ["git", "-C", root, "ls-files", "--error-unmatch", "--", path],
        { stdout: "ignore", stderr: "ignore" },
      );
      if (tracked.exitCode !== 0 || dirty.stdout.toString().trim())
        throw new HttpError(
          422,
          "scorer_not_committed",
          `${s.ref.name}: ${path} must be committed and unchanged: the worker runs the bundle's copy of the pinned commit`,
        );
    }
    const env = body["environment"];
    if (env !== undefined && env !== "none" && env !== "project")
      throw new HttpError(400, "invalid_request", "environment is none or project");
    const acceptCost = body["accept_cost"] === true;
    await this.svc.compute.check(targetId, { acceptCost, runtimeSec: p.timeout });
    const settings = this.o.settings.get(pid);
    const capture = settings.capture;
    // Trace bodies leave the workstation only if the project allows remote capture (decision 12).
    const mode =
      capture.remote_capture || capture.mode === "metadata_only" ? capture.mode : "metadata_only";
    const goldenRef = `${p.pinned.set.golden_set_id}/${p.pinned.version.version}`;
    const request = {
      schema: "ablationkit.remote_genai_request/v1",
      golden_set: {
        golden_set_id: p.pinned.set.golden_set_id,
        name: p.pinned.set.name,
        version: p.pinned.version.version,
        sha256: p.pinned.version.sha256,
      },
      examples: p.examples,
      trials: p.trials,
      max_calls: p.maxCalls,
      targets: p.bridgeTargets,
      scorers: p.scorers.map((s) => s.bridge),
      capture: {
        mode,
        rules: [
          ...capture.builtin_redactions.map((b) => [b, BUILTIN_REDACTIONS[b]]),
          ...capture.patterns.map((x) => [x.name, x.regex]),
        ],
      },
      tags: {
        [TRACE_TAGS.project]: pid,
        [TRACE_TAGS.evaluation]: p.id,
        [TRACE_TAGS.golden]: goldenRef,
        [TRACE_TAGS.capture]: mode,
      },
    };
    const inputs = join(this.dir(pid), `${p.id}.inputs`);
    const stage = join(inputs, "genai");
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    const text = `${JSON.stringify(request)}\n`;
    writeFileSync(join(stage, "request.json"), text, { mode: 0o600 });
    const requestSha = sha(text);
    const target = await this.svc.compute.target(targetId);
    if (!target) throw new HttpError(404, "target_not_found", `no compute target ${targetId}`);
    const uv = env === "project";
    let submitted: Awaited<ReturnType<ExtensionResearchHost["compute"]["submit"]>>;
    try {
      submitted = await this.svc.compute.submit({
        command: [
          uv ? "python" : (target.python ?? "python3"),
          "-m",
          "ablationkit_llm.evaluate",
          "--request-sha256",
          requestSha,
        ],
        environment: uv ? "uv" : "none",
        runtime_max_sec: p.timeout,
        run_name: `genai ${p.id.slice(3, 11)}`,
        target_id: targetId,
        accept_cost: acceptCost,
        inputs: [{ name: "genai", path: stage }],
      });
    } catch (e) {
      rmSync(inputs, { recursive: true, force: true });
      throw e;
    }
    const rec: LlmEvaluationRecord = compact({
      schema_version: 1 as const,
      evaluation_id: p.id,
      project_id: pid,
      kind: "genai" as const,
      golden_set: {
        golden_set_id: p.pinned.set.golden_set_id,
        name: p.pinned.set.name,
        version: p.pinned.version.version,
        sha256: p.pinned.version.sha256,
        held_out: p.pinned.set.held_out,
        examples: p.examples.length,
      },
      targets: p.targets,
      scorers: p.scorers.map((s) => s.ref),
      trials: p.trials,
      retention: {
        capture: mode,
        retention_days: capture.retention_days,
        settings_revision: settings.revision,
      },
      egress: p.egress,
      environment: "remote" as const,
      remote: {
        target_id: targetId,
        job_id: submitted.job_id,
        attempt_id: submitted.attempt_id,
        request_sha256: requestSha,
      },
      state: "running" as const,
      results: p.targets.map((t) => ({ label: t.label })),
      source_commit: submitted.source_commit ?? gitHead(root),
      limits: { timeout_sec: p.timeout, max_calls: p.maxCalls },
      enforcement: "advisory" as const,
      requested_by: compact({ kind: actor.kind, id: actor.id }),
      created_at: p.now,
      started_at: p.now,
      updated_at: p.now,
    }) as LlmEvaluationRecord;
    this.save(rec);
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: actor.kind,
      action: "llm.evaluation.create",
      outcome: "allowed",
      project_id: pid,
      target: p.id,
      details: {
        golden_set: goldenRef,
        targets: p.targets.map((t) =>
          t.kind === "prompt"
            ? `${t.label}:${t.prompt.name}/${t.prompt.version}@${t.provider_id}/${t.model}`
            : t.label,
        ),
        scorers: rec.scorers.map((s) => s.name),
        egress: p.egress.map((e) => `${e.provider_id}:${e.locality}:${e.purpose}`),
        max_calls: p.maxCalls,
        target_id: targetId,
        job_id: submitted.job_id,
        request_sha256: requestSha,
      },
    });
    this.ensureRemoteTimer();
    return rec;
  }

  private ensureRemoteTimer(): void {
    if (this.remoteTimer || this.stopped) return;
    // Detached from the creating request: the timer must not carry its (expiring) caller context.
    const detach = this.o.detach ?? ((fn) => fn());
    this.remoteTimer = detach(() =>
      setInterval(() => {
        void this.reconcileRemote().catch(() => {});
      }, this.o.remotePollMs ?? 2000),
    );
    (this.remoteTimer as { unref?: () => void }).unref?.();
  }

  private remoteNote(r: LlmEvaluationRecord, note: string, attemptId: string): void {
    const remote = r.remote as NonNullable<LlmEvaluationRecord["remote"]>;
    if (remote.note !== note || remote.attempt_id !== attemptId)
      this.update(r.evaluation_id, { remote: { ...remote, attempt_id: attemptId, note } });
  }

  /**
   * Follow each open remote evaluation's job; nothing here starts anything. Once the attempt has
   * succeeded and synced, create (or reuse) each target's run and fill it from the job's
   * `eval/genai-results.json`. A failed or `unknown` attempt is reported, never retried.
   */
  async reconcileRemote(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const r of [...this.records.values()]) {
        if (!r.remote || TERMINAL.has(r.state)) continue;
        try {
          await this.reconcileOne(r);
        } catch (e) {
          if (!(e instanceof MlflowError)) throw e;
          // MLflow is down: try again on the next tick.
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOne(r: LlmEvaluationRecord): Promise<void> {
    const remote = r.remote as NonNullable<LlmEvaluationRecord["remote"]>;
    const job = await this.svc.compute.job(remote.job_id);
    const a = job?.attempt;
    if (!job || !a) return;
    const ended = this.o.now().toISOString();
    const settled = { ...remote, attempt_id: a.attempt_id };
    delete (settled as { note?: string }).note;
    if (a.state === "cancelled") {
      this.update(r.evaluation_id, { remote: settled, state: "canceled", ended_at: ended });
      return;
    }
    if (a.state === "failed" || a.state === "timed_out" || a.state === "oom_killed") {
      this.update(r.evaluation_id, {
        remote: settled,
        state: "failed",
        ended_at: ended,
        error:
          `the evaluation job ${a.state.replace("_", " ")}${a.exit_code !== undefined ? ` (exit ${a.exit_code})` : ""}${a.error ? `: ${a.error}` : ""}`.slice(
            0,
            4000,
          ),
      });
      return;
    }
    if (a.state === "unknown" || a.reconcile_required) {
      this.remoteNote(
        r,
        `the attempt is ${a.state}${a.reconcile_required ? ` (${a.reconcile_required})` : ""}: resolve it on the job; the evaluation is not rerun`,
        a.attempt_id,
      );
      return;
    }
    if (a.state !== "succeeded") {
      if (remote.attempt_id !== a.attempt_id)
        this.update(r.evaluation_id, { remote: { ...remote, attempt_id: a.attempt_id } });
      return;
    }
    const jobRun = a.mlflow_run_id;
    const delivered =
      a.sync === "synced" &&
      jobRun !== undefined &&
      a.artifacts.includes("eval/genai-results.json");
    if (!delivered) {
      this.remoteNote(
        r,
        "the job finished; waiting for the worker to deliver its results",
        a.attempt_id,
      );
      return;
    }
    const res = await this.svc.tracking.client.downloadArtifact(jobRun, "eval/genai-results.json");
    if (!res.ok) {
      this.remoteNote(r, "the job finished; waiting for its results to reach MLflow", a.attempt_id);
      return;
    }
    const out = (await res.json()) as Json;
    const got = (out["results"] as Json[] | undefined) ?? [];
    if (out["evaluation_id"] !== r.evaluation_id) {
      this.update(r.evaluation_id, {
        remote: settled,
        state: "failed",
        ended_at: ended,
        error: "the job's results name a different evaluation",
      });
      return;
    }
    const c = this.svc.tracking.client;
    await c.setTag(jobRun, "ablationkit.llm_evaluation", r.evaluation_id);
    const experimentId =
      r.experiment_id ?? (await this.svc.tracking.ensureExperimentNow(r.project_id));
    const goldenRef = `${r.golden_set.golden_set_id}/${r.golden_set.version}`;
    let cur = r;
    // One run per target, created once (its ID is saved before anything is logged to it).
    for (const t of r.targets) {
      const i = cur.results.findIndex((x) => x.label === t.label);
      let runId = cur.results[i]?.run_id;
      if (!runId) {
        const run = await c.createRun({
          experiment_id: experimentId,
          run_name: `genai ${r.evaluation_id.slice(3, 11)} ${t.label}`,
          tags: [
            ...runTags(r.project_id, r.evaluation_id, goldenRef, r.golden_set.sha256, t),
            { key: "ablationkit.source_job_run", value: jobRun },
          ],
        });
        runId = run.info.run_id;
        cur = this.update(r.evaluation_id, {
          experiment_id: experimentId,
          results: cur.results.map((x, j) => (j === i ? { ...x, run_id: runId as string } : x)),
        });
      }
      const g = got.find((x) => x["label"] === t.label);
      const run = await c.getRun(runId);
      if (run.info.status !== "RUNNING") continue; // filled on an earlier tick
      if (g) {
        const now = Date.now();
        const metrics = Object.entries((g["metrics"] as Record<string, string>) ?? {})
          .map(([key, v]) => ({ key, value: Number(v), timestamp: now, step: 0 }))
          .filter((m) => Number.isFinite(m.value));
        await c.logBatch({
          run_id: runId,
          metrics,
          params:
            t.kind === "prompt"
              ? [
                  { key: "ablationkit.golden_set", value: goldenRef },
                  { key: "ablationkit.prompt", value: `${t.prompt.name}/${t.prompt.version}` },
                  { key: "ablationkit.model", value: t.model },
                  ...Object.entries(t.params ?? {}).map(([k, v]) => ({
                    key: `gen.${k}`,
                    value: String(v),
                  })),
                ]
              : [],
        });
        await c.uploadArtifact(run.info, EXAMPLES_ARTIFACT, JSON.stringify(g["doc"] ?? {}));
      }
      await c.updateRun({ run_id: runId, status: g ? "FINISHED" : "FAILED", end_time: Date.now() });
    }
    this.update(r.evaluation_id, {
      remote: settled,
      state: "succeeded",
      ended_at: ended,
      results: this.variantResults(cur, got),
    });
  }

  private pump(): void {
    if (this.stopped) return;
    const max = this.o.maxConcurrent ?? 1;
    while (this.running.size < max && this.queue.length) {
      const id = this.queue.shift() as string;
      const r = this.records.get(id);
      if (r?.state !== "queued") continue;
      void this.execute(r);
    }
  }

  private async execute(r: LlmEvaluationRecord): Promise<void> {
    const id = r.evaluation_id;
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (!p) return;
    let run: ExtensionPythonRun;
    try {
      run = await this.o.bridge.start(id, p.request, {
        environment: "managed",
        timeoutSec: r.limits.timeout_sec,
        memoryMb: 4096,
        secretEnv: p.secretEnv,
      });
    } catch (e) {
      if (this.stopped) return;
      this.update(id, {
        state: "failed",
        ended_at: this.o.now().toISOString(),
        error: String(e).slice(0, 4000),
      });
      await this.endRuns(r, "FAILED");
      this.pump();
      return;
    }
    if (this.stopped) return;
    this.running.set(id, run);
    this.update(id, {
      state: "running",
      started_at: this.o.now().toISOString(),
      enforcement: run.enforcement,
    });
    const out = await run.done;
    this.running.delete(id);
    if (this.stopped) return;
    const cur = this.records.get(id) as LlmEvaluationRecord;
    const ended = this.o.now().toISOString();
    const res = out.result;
    if (cur.state === "canceled") {
      await this.endRuns(cur, "KILLED");
    } else if (res?.["ok"] === true) {
      const results = this.variantResults(cur, (res["results"] as Json[] | undefined) ?? []);
      this.update(id, {
        state: "succeeded",
        ended_at: ended,
        results,
      } as Partial<LlmEvaluationRecord>);
      await this.endRuns(cur, "FINISHED");
    } else {
      const t = out.termination;
      const why = res?.["error"]
        ? String(res["error"])
        : t.timed_out
          ? `the evaluation worker hit its ${cur.limits.timeout_sec}s time limit`
          : t.oom_killed
            ? "the evaluation worker ran out of memory"
            : `the evaluation worker exited without a result (exit ${t.exit_code ?? t.signal ?? "?"}): ${out.log_tail.slice(-1500)}`;
      this.update(id, { state: "failed", ended_at: ended, error: why.slice(0, 4000) });
      await this.endRuns(cur, "FAILED");
    }
    this.pump();
  }

  /** The record's per-target results from the evaluator's output (local or remote). */
  private variantResults(cur: LlmEvaluationRecord, got: Json[]): LlmEvaluationRecord["results"] {
    return cur.results.map((base) => {
      const g = got.find((x) => x["label"] === base.label) ?? {};
      const t = cur.targets.find((x) => x.label === base.label);
      const usage = g["usage"] as LlmEvaluationRecord["results"][number]["usage"];
      const cost =
        usage && t?.kind === "prompt"
          ? estimateCost(usage, this.o.settings.rate(cur.project_id, t.provider_id, t.model))
          : undefined;
      const ju = Object.values((g["judge_usage"] as Record<string, Json> | undefined) ?? {});
      const judge_usage = ju.length
        ? compact({
            reported: ju.reduce((s, x) => s + Number(x["reported"] ?? 0), 0),
            missing: ju.reduce((s, x) => s + Number(x["missing"] ?? 0), 0),
            input_tokens: ju.some((x) => x["input_tokens"] !== undefined)
              ? ju.reduce((s, x) => s + Number(x["input_tokens"] ?? 0), 0)
              : undefined,
            output_tokens: ju.some((x) => x["output_tokens"] !== undefined)
              ? ju.reduce((s, x) => s + Number(x["output_tokens"] ?? 0), 0)
              : undefined,
            total_tokens: ju.some((x) => x["total_tokens"] !== undefined)
              ? ju.reduce((s, x) => s + Number(x["total_tokens"] ?? 0), 0)
              : undefined,
          })
        : undefined;
      return compact({
        ...base,
        metrics: g["metrics"] as Record<string, string> | undefined,
        examples: g["examples"] as number | undefined,
        errors: g["errors"] as number | undefined,
        scorer_errors: g["scorer_errors"] as number | undefined,
        usage,
        judge_usage,
        latency_ms: g["latency_ms"] as LlmEvaluationRecord["results"][number]["latency_ms"],
        cost,
      });
    });
  }

  private async endRuns(
    r: LlmEvaluationRecord,
    status: "FAILED" | "KILLED" | "FINISHED",
  ): Promise<void> {
    for (const x of r.results) {
      if (!x.run_id) continue;
      try {
        const run = await this.svc.tracking.client.getRun(x.run_id);
        if (run.info.status === "RUNNING" || run.info.status === "SCHEDULED")
          await this.svc.tracking.client.updateRun({
            run_id: x.run_id,
            status,
            end_time: Date.now(),
          });
      } catch {
        // MLflow down: the record says what happened
      }
    }
  }

  async cancel(pid: string, id: string, actor: Actor): Promise<LlmEvaluationRecord> {
    const r = this.get(pid, id);
    if (TERMINAL.has(r.state))
      throw new HttpError(409, "not_running", `evaluation ${id} is ${r.state}`);
    this.pending.delete(id);
    if (r.remote)
      try {
        await this.svc.compute.cancel(r.remote.job_id);
      } catch {
        // already ended: reconciliation is skipped for a canceled record either way
      }
    const next = this.update(id, { state: "canceled", ended_at: this.o.now().toISOString() });
    const run = this.running.get(id);
    if (run) await run.stop();
    else await this.endRuns(next, "KILLED");
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: actor.kind,
      action: "llm.evaluation.cancel",
      outcome: "allowed",
      project_id: pid,
      target: id,
    });
    return this.records.get(id) as LlmEvaluationRecord;
  }

  // ------------------------------------------------------------------ results

  private async rowsOf(runId: string): Promise<ExampleRow[]> {
    const res = await this.svc.tracking.client.downloadArtifact(runId, EXAMPLES_ARTIFACT);
    const text = await res.text();
    if (text.length > 32 * 1024 * 1024)
      throw new HttpError(413, "too_large", "the examples artifact is larger than 32 MiB");
    return ((JSON.parse(text) as Json)["rows"] as ExampleRow[] | undefined) ?? [];
  }

  /**
   * Per-example results of every target, aligned on the golden set's order (the first target is
   * the baseline for regressions). Expectations of a held-out set are not shown to agents.
   */
  async examples(pid: string, id: string, viewer: "human" | "agent"): Promise<Json> {
    const r = this.get(pid, id);
    if (r.state !== "succeeded")
      throw new HttpError(409, "not_finished", `evaluation ${id} is ${r.state}`);
    const per: { label: string; examples: ExampleRow[]; error?: string }[] = [];
    for (const x of r.results) {
      try {
        per.push({ label: x.label, examples: x.run_id ? await this.rowsOf(x.run_id) : [] });
      } catch (e) {
        if (e instanceof MlflowError)
          per.push({ label: x.label, examples: [], error: `unavailable: ${e.message}` });
        else throw e;
      }
    }
    let golden: GoldenExample[] = [];
    try {
      golden = this.o.golden.examples(
        pid,
        r.golden_set.golden_set_id,
        r.golden_set.version,
      ).examples;
    } catch {
      golden = [];
    }
    const hideExpectations = viewer === "agent" && r.golden_set.held_out;
    const rows = alignExamples(
      golden.map((g) => g.example_id),
      per,
    ).map((row) => {
      const g = golden.find((x) => x.example_id === row.example_id);
      return compact({
        ...row,
        category: row.category ?? g?.category,
        edge_case: g?.edge_case,
        inputs: g?.inputs,
        expectations: hideExpectations ? undefined : g?.expectations,
        missing_expectations:
          !g?.expectations || !Object.keys(g.expectations).length ? true : undefined,
      });
    });
    const slices: Record<string, Record<string, { n: number; failed: number }>> = {};
    for (const row of rows) {
      const cat = (row["category"] as string | undefined) ?? "(none)";
      for (const [label, cell] of Object.entries(row.cells)) {
        const byCat = slices[label] ?? {};
        slices[label] = byCat;
        const s = byCat[cat] ?? { n: 0, failed: 0 };
        byCat[cat] = s;
        s.n++;
        if (
          cell?.error ||
          Object.values(cell?.scores ?? {}).some((v) => v.value === false || v.value === "no")
        )
          s.failed++;
      }
    }
    return compact({
      evaluation: r,
      targets: per.map((p) => compact({ label: p.label, unavailable: p.error })),
      rows,
      slices,
      expectations_hidden: hideExpectations || undefined,
      nondeterminism:
        r.trials > 1
          ? Object.fromEntries(
              per.map((p) => {
                const byEx = new Map<string, Set<string>>();
                for (const e of p.examples)
                  byEx.set(
                    e.example_id,
                    (byEx.get(e.example_id) ?? new Set()).add(JSON.stringify(e.output ?? null)),
                  );
                return [p.label, [...byEx.values()].filter((s) => s.size > 1).length];
              }),
            )
          : undefined,
    });
  }

  /** Compare one target of each of two evaluations example by example (paired only on the same golden-set version). */
  async compare(
    pid: string,
    a: string,
    b: string,
    labels: { a?: string; b?: string },
    viewer: "human" | "agent",
  ): Promise<Json> {
    const ra = this.get(pid, a);
    const rb = this.get(pid, b);
    const la = labels.a ?? ra.results[0]?.label;
    const lb = labels.b ?? rb.results[0]?.label;
    const xa = ra.results.find((x) => x.label === la);
    const xb = rb.results.find((x) => x.label === lb);
    if (!xa?.run_id || !xb?.run_id) throw new HttpError(404, "not_found", "no such target");
    if (ra.state !== "succeeded" || rb.state !== "succeeded")
      throw new HttpError(409, "not_finished", "both evaluations must have succeeded");
    const paired = ra.golden_set.sha256 === rb.golden_set.sha256;
    const ea = await this.rowsOf(xa.run_id).catch((e: unknown) => this.unavailable(e));
    const eb = await this.rowsOf(xb.run_id).catch((e: unknown) => this.unavailable(e));
    const A = `${a}:${la}`;
    const B = `${b}:${lb}`;
    const order = this.o.golden
      .examples(pid, ra.golden_set.golden_set_id, ra.golden_set.version)
      .examples.map((e) => e.example_id);
    const rows = alignExamples(order, [
      { label: A, examples: ea },
      { label: B, examples: eb },
    ]);
    const metrics = new Set([...Object.keys(xa.metrics ?? {}), ...Object.keys(xb.metrics ?? {})]);
    return {
      paired,
      pairing: paired
        ? `same golden set version (${ra.golden_set.name} v${ra.golden_set.version}, ${ra.golden_set.sha256.slice(0, 12)}): example-level comparison is paired`
        : "different golden-set versions: aggregates only; per-example rows are matched by example_id where both have it and are not a paired comparison",
      a: {
        evaluation_id: a,
        label: la,
        metrics: xa.metrics,
        usage: xa.usage,
        latency_ms: xa.latency_ms,
        cost: xa.cost,
        golden_set: ra.golden_set,
      },
      b: {
        evaluation_id: b,
        label: lb,
        metrics: xb.metrics,
        usage: xb.usage,
        latency_ms: xb.latency_ms,
        cost: xb.cost,
        golden_set: rb.golden_set,
      },
      metric_deltas: Object.fromEntries(
        [...metrics].map((m) => {
          const va = xa.metrics?.[m];
          const vb = xb.metrics?.[m];
          return [
            m,
            compact({
              a: va,
              b: vb,
              delta:
                va !== undefined && vb !== undefined ? String(Number(vb) - Number(va)) : undefined,
            }),
          ];
        }),
      ),
      significance:
        "not computed: no supported paired test for scorer feedback is configured; compare example rows",
      rows:
        viewer === "agent" && (ra.golden_set.held_out || rb.golden_set.held_out)
          ? rows.map((r) => ({ ...r }))
          : rows,
      regressions: rows
        .filter((r) => (r.regressions[B] ?? []).length)
        .map((r) => ({
          example_id: r.example_id,
          scorers: r.regressions[B],
          trace_a: r.cells[A]?.trace_id,
          trace_b: r.cells[B]?.trace_id,
        })),
      improvements: rows
        .filter((r) => (r.improvements[B] ?? []).length)
        .map((r) => ({ example_id: r.example_id, scorers: r.improvements[B] })),
    };
  }

  private unavailable(e: unknown): never {
    if (e instanceof MlflowError)
      throw new HttpError(503, "tracking_unavailable", `MLflow is unavailable: ${e.message}`);
    throw e;
  }

  /** Mark an example's trace as an important failure (a human assessment on the MLflow trace). */
  async flag(
    pid: string,
    id: string,
    body: Json,
    actor: { kind: "human"; id?: string },
  ): Promise<Json> {
    const r = this.get(pid, id);
    const label = (body["label"] as string | undefined) ?? r.results[0]?.label;
    const x = r.results.find((y) => y.label === label);
    if (!x?.run_id) throw new HttpError(404, "not_found", `no target ${label}`);
    const rows = await this.rowsOf(x.run_id).catch((e: unknown) => this.unavailable(e));
    const row = rows.find(
      (y) =>
        y.example_id === body["example_id"] &&
        (y.trial ?? 1) === ((body["trial"] as number | undefined) ?? 1),
    );
    if (!row?.trace_id)
      throw new HttpError(
        404,
        "not_found",
        `no traced example ${String(body["example_id"])} in ${label}`,
      );
    const note = body["note"];
    if (note !== undefined && (typeof note !== "string" || note.length > 4000))
      throw new HttpError(400, "invalid_request", "note is at most 4000 characters");
    const a = await this.o.traces.feedback(
      pid,
      row.trace_id,
      compact({
        name: "ablationkit.flag",
        value: "important_failure",
        rationale: (note as string | undefined) ?? `flagged in ${id}/${label}`,
      }),
      actor,
    );
    this.svc.events.publish(pid, "llm.evaluation.flagged", {
      evaluation_id: id,
      example_id: row.example_id,
      trace_id: row.trace_id,
    });
    return { ...a, trace_id: row.trace_id, example_id: row.example_id, label };
  }

  /**
   * A report linking prompt versions, trace IDs, evaluator definitions, the data revision and the
   * MLflow runs (the LLM-first loop's report step). Evidence only; interpretation is the reader's.
   */
  async report(pid: string, id: string, actor: Actor): Promise<Json> {
    const r = this.get(pid, id);
    if (r.state !== "succeeded")
      throw new HttpError(409, "not_finished", `evaluation ${id} is ${r.state}`);
    const ex = await this.examples(pid, id, actor.kind);
    const rows =
      (ex["rows"] as (Json & {
        cells: Record<string, ExampleRow | undefined>;
        regressions: Record<string, string[]>;
        failed: boolean;
      })[]) ?? [];
    const flagged: { example_id: string; label: string; trace_id: string }[] = [];
    for (const row of rows)
      for (const [label, c] of Object.entries(row.cells))
        if (
          c?.trace_id &&
          (c.error ||
            Object.values(c.scores ?? {}).some((s) => s.value === false || s.value === "no"))
        )
          flagged.push({ example_id: String(row["example_id"]), label, trace_id: c.trace_id });
    const lines: string[] = [];
    lines.push(
      `GenAI evaluation \`${id}\` over golden set **${r.golden_set.name} v${r.golden_set.version}** (SHA-256 \`${r.golden_set.sha256.slice(0, 16)}…\`, ${r.golden_set.examples} examples${r.golden_set.held_out ? ", held out" : ""}), ${r.trials} trial(s).`,
    );
    lines.push(
      "",
      "## Targets",
      "",
      "| Target | What ran | MLflow run | Metrics | Tokens (reported) | Latency p50 | Estimated cost |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const t of r.targets) {
      const x = r.results.find((y) => y.label === t.label);
      const what =
        t.kind === "prompt"
          ? `prompt \`${t.prompt.name}\` v${t.prompt.version}${t.prompt.alias ? ` (from @${t.prompt.alias})` : ""} → \`${t.provider_id}/${t.model}\` ${JSON.stringify(t.params)}`
          : `recorded traces of run \`${t.source_run_id}\` (${t.matched} matched)`;
      const m =
        Object.entries(x?.metrics ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join(", ") || "—";
      const u = x?.usage
        ? x.usage.reported
          ? `${x.usage.total_tokens ?? "?"} (${x.usage.missing} calls unreported)`
          : "unavailable"
        : "—";
      const c = x?.cost
        ? `~$${x.cost.estimated_usd} (estimate; ${x.cost.rate_source}, ${x.cost.rate_version})`
        : "unavailable";
      lines.push(
        `| ${t.label} | ${what} | \`${x?.run_id ?? "—"}\` | ${m} | ${u} | ${x?.latency_ms ? `${x.latency_ms.p50} ms` : "—"} | ${c} |`,
      );
    }
    lines.push("", "## Evaluators", "");
    for (const s of r.scorers) {
      if (s.kind === "judge" && s.judge)
        lines.push(
          `- \`${s.name}\`: LLM judge \`${s.judge.provider_id}/${s.judge.model}\` (${s.judge.locality}), uses ${s.judge.uses}, rubric SHA-256 \`${s.judge.rubric_sha256.slice(0, 16)}…\`: "${s.judge.rubric.slice(0, 300)}". A judge's verdict is an opinion, not ground truth.`,
        );
      else if (s.kind === "project" && s.project)
        lines.push(
          `- \`${s.name}\`: project scorer \`${s.project.path}:${s.project.function}\` (SHA-256 \`${s.project.sha256.slice(0, 16)}…\`${s.project.commit ? `, commit ${s.project.commit.slice(0, 12)}` : ""})`,
        );
      else
        lines.push(
          `- \`${s.name}\`: built-in \`${s.builtin}\`${s.params ? ` ${JSON.stringify(s.params)}` : ""}`,
        );
    }
    lines.push("", "## Failures and regressions", "");
    if (!flagged.length) lines.push("No failed examples.");
    for (const f of flagged.slice(0, 50))
      lines.push(`- \`${f.example_id}\` (${f.label}): trace \`${f.trace_id}\``);
    const regress = rows.filter((row) => Object.values(row.regressions).some((v) => v.length));
    if (regress.length) {
      lines.push("", `Regressions against the first target (${r.targets[0]?.label}):`);
      for (const row of regress.slice(0, 50))
        lines.push(
          `- \`${String(row["example_id"])}\`: ${Object.entries(row.regressions)
            .map(([l, s]) => `${l} fails ${s.join(", ")}`)
            .join("; ")}`,
        );
    }
    lines.push("", "## Data and limits", "");
    lines.push(
      `- Traces recorded under capture \`${r.retention.capture}\`, kept ${r.retention.retention_days} days (data controls revision ${r.retention.settings_revision}).`,
    );
    lines.push(
      `- Data sent to: ${r.egress.map((e) => `${e.provider_id} (${e.locality}, ${e.purpose})`).join(", ") || "nothing external"}.`,
    );
    if (r.source_commit) lines.push(`- Code revision: \`${r.source_commit}\`.`);
    if (ex["nondeterminism"])
      lines.push(
        `- Examples whose outputs differed across trials: ${JSON.stringify(ex["nondeterminism"])}. Repeated samples are distributions, not reproductions.`,
      );
    const missing = rows.filter((row) => row["missing_expectations"]).length;
    if (missing)
      lines.push(
        `- ${missing} example(s) have no ground truth; scorers that need it report an error rather than a value.`,
      );
    const links = [
      { kind: "llm_evaluation" as const, id },
      {
        kind: "golden_set" as const,
        id: `${r.golden_set.golden_set_id}/${r.golden_set.version}`,
        label: `${r.golden_set.name} v${r.golden_set.version}`,
      },
      ...r.targets.flatMap((t) =>
        t.kind === "prompt"
          ? [{ kind: "prompt_version" as const, id: `${t.prompt.name}/${t.prompt.version}` }]
          : [],
      ),
      ...r.results.flatMap((x) =>
        x.run_id ? [{ kind: "run" as const, id: x.run_id, label: x.label }] : [],
      ),
      ...flagged.slice(0, 50).map((f) => ({
        kind: "trace" as const,
        id: f.trace_id,
        label: `${f.example_id} (${f.label})`,
      })),
    ];
    const seen = new Set<string>();
    const rec = await this.svc.research.create(
      pid,
      "report",
      {
        title:
          `GenAI evaluation ${r.golden_set.name} v${r.golden_set.version}: ${r.targets.map((t) => t.label).join(" vs ")}`.slice(
            0,
            300,
          ),
        body: lines.join("\n"),
        links: links.filter((l) => !seen.has(`${l.kind}:${l.id}`) && seen.add(`${l.kind}:${l.id}`)),
        tags: ["llm-evaluation"],
      },
      compact({ kind: actor.kind, id: actor.id }),
      { listener: actor.kind },
    );
    return { report: rec };
  }

  logTail(pid: string, id: string): string {
    this.get(pid, id);
    const f = this.o.bridge.logPath(id);
    if (!existsSync(f)) return "";
    const text = readFileSync(f);
    return text.subarray(Math.max(0, text.length - 65_536)).toString("utf8");
  }
}
