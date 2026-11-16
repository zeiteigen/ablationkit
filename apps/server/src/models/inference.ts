/**
 * Research inference (spec §5.6.1; criteria 9, 9a, 9b, 9e, 10d; ADR 0020): one-shot prediction,
 * aligned model comparison, interactive sessions (`inference-sessions.ts`) and explicit
 * save-to-evidence.
 *
 * Every model is pinned to an immutable logged-model ID before anything runs (an alias resolves
 * now, and the result records the version it resolved to). The model's `MLmodel` picks a task
 * adapter (`@ablationkit/inference-adapters`); the payload is validated against it here, before a
 * worker starts, and again by MLflow's own schema enforcement in the worker. Model files are
 * untrusted code: they load only in the bridge's isolated, resource-limited Python processes, and
 * a model whose format runs code on load needs an explicit acknowledgement.
 *
 * Exploration is transient. One-shot and comparison results live in this process's memory for an
 * hour and the worker's directory (which held the request) is deleted when it finishes; nothing is
 * written to MLflow. Saving is an explicit action that writes an `inference_evidence` MLflow run
 * with the inputs, outputs and provenance as one artifact, plus a provenance record here; deleting
 * it deletes the MLflow run.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type Adapter,
  canonicalJson,
  exactMcnemar,
  incompatibilities,
  selectAdapter,
  validateParams,
  validatePayload,
} from "@ablationkit/inference-adapters";
import {
  type DeploymentRecord,
  type EvaluationModelRef,
  type InferenceEvidenceRecord,
  type InferenceSessionRecord,
  type ObjectRef,
  validateInferenceEvidenceRecord,
} from "@ablationkit/protocol";
import { MlflowError, TAGS } from "@ablationkit/tracking-mlflow";
import type { DeploymentLauncher } from "../compute/deployments.ts";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";
import { sha256File } from "../state/backup.ts";
import {
  BRIDGE_VERSION,
  BridgeUnavailableError,
  type OperationsBridge,
} from "../tracking/bridge.ts";
import { checkoutDataFile, gitHead } from "./evaluations.ts";
import {
  InferenceSessions,
  type SessionActor,
  type SessionAnswer,
  type SessionStartInput,
} from "./inference-sessions.ts";
import type { ModelInferenceInfo, ModelSelector } from "./models.ts";

const RESULT_TTL_MS = 60 * 60_000;
const MAX_RESULTS = 200;
const MAX_ONE_SHOT_ROWS = 1000;
const MAX_COMPARE_ROWS = 1000;
const MAX_COMPARE_MODELS = 4;
const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_MEMORY_MB = 2048;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
export const EVIDENCE_ARTIFACT = "ablationkit/inference/evidence.json";

type Json = Record<string, unknown>;
type Actor = { kind: "human" | "agent"; id?: string };

/** A pinned model with what inference needs to run it. */
export interface PinnedModel {
  readonly ref: EvaluationModelRef;
  readonly info: ModelInferenceInfo;
  readonly adapter: Adapter;
}

export interface ModelOutcome {
  readonly model: EvaluationModelRef;
  readonly source_run_id?: string;
  readonly status: "ok" | "error";
  readonly error?: { code: string; message: string };
  readonly outputs?: unknown[];
  readonly probabilities?: unknown[];
  readonly probabilities_note?: string;
  readonly rows?: number;
  readonly timings: {
    import_ms?: number;
    load_ms?: number;
    predict_ms?: number;
    postprocess_ms?: number;
    /** Process start to result, measured by the coordinator. */
    worker_ms?: number;
    /** Session only: send to answer, including queueing. */
    round_trip_ms?: number;
  };
  readonly enforcement?: "enforced" | "advisory";
}

/** An unsaved result. Held in memory only, for an hour. */
export interface InferenceResult {
  readonly result_id: string;
  readonly project_id: string;
  readonly kind: "prediction" | "comparison";
  readonly via: "one_shot" | "session";
  readonly session_id?: string;
  readonly task: Adapter["task"];
  readonly output: Adapter["output"];
  readonly labels?: Readonly<Record<string, string>>;
  readonly models: ModelOutcome[];
  readonly inputs?: unknown;
  /** Rows read from a dataset slice (comparison), for display. */
  readonly input_rows?: unknown[];
  readonly targets?: unknown[];
  readonly dataset?: InferenceEvidenceRecord["dataset"];
  readonly params?: Json;
  readonly rows: number;
  readonly input_sha256: string;
  readonly environment: {
    kind: "managed" | "project";
    mlflow_version?: string;
    python_version?: string;
  };
  readonly comparison?: Json;
  readonly trust: ModelInferenceInfo["trust"][];
  readonly created_at: string;
  readonly expires_at: string;
  readonly saved_as?: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function errorCode(kind: unknown): string {
  switch (kind) {
    case "schema":
      return "schema_mismatch";
    case "input":
      return "invalid_input";
    case "load":
      return "load_failed";
    case "output_too_large":
      return "output_too_large";
    case "session_crashed":
      return "session_crashed";
    default:
      return "predict_failed";
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export class InferenceService {
  readonly sessions: InferenceSessions;
  private readonly results = new Map<string, InferenceResult>();
  private readonly evidence = new Map<string, InferenceEvidenceRecord>();
  readonly loadProblems: string[] = [];

  constructor(
    private readonly o: {
      readonly svc: () => Services;
      readonly stateDir: string;
      readonly bridge: OperationsBridge;
      readonly now: () => Date;
      readonly sweepMs?: number;
    },
  ) {
    this.sessions = new InferenceSessions({
      svc: o.svc,
      stateDir: o.stateDir,
      bridge: o.bridge,
      now: o.now,
      ...(o.sweepMs !== undefined ? { sweepMs: o.sweepMs } : {}),
    });
  }

  private get svc(): Services {
    return this.o.svc();
  }

  private evidenceDir(pid: string): string {
    return join(this.o.stateDir, pid, "inference", "evidence");
  }

  /** Drop a removed project's results, saved evidence and sessions from memory. */
  forgetProject(pid: string): void {
    for (const [id, r] of [...this.results]) if (r.project_id === pid) this.results.delete(id);
    for (const [id, r] of [...this.evidence]) if (r.project_id === pid) this.evidence.delete(id);
    this.sessions.forgetProject(pid);
  }

  load(projects: readonly string[]): void {
    this.sessions.load(projects);
    for (const pid of projects) {
      const d = this.evidenceDir(pid);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
        try {
          const r = readJson(join(d, f), validateInferenceEvidenceRecord);
          this.evidence.set(r.evidence_id, r);
        } catch {
          this.loadProblems.push(join(d, f));
        }
      }
    }
    this.loadProblems.push(...this.sessions.loadProblems);
  }

  start(): void {
    this.sessions.start();
  }

  shutdown(): Promise<void> {
    this.results.clear();
    return this.sessions.shutdown();
  }

  // ------------------------------------------------------------------ pinning

  /** Pin a selector and choose its adapter; refuse unsupported models with the adapter's reason. */
  async pin(
    pid: string,
    sel: ModelSelector,
    what: string,
    acknowledgeTrust: boolean,
  ): Promise<PinnedModel> {
    const ref = await this.svc.models.pin(pid, sel ?? {}, what);
    const info = await this.svc.models.inferenceInfo(pid, ref.model_id);
    if (!info.mlmodel)
      throw new HttpError(
        422,
        "unsupported_model",
        `${what}: model ${ref.model_id} has no MLmodel file`,
      );
    const choice = selectAdapter(info.mlmodel);
    if (!choice.supported)
      throw new HttpError(422, "unsupported_model", `${what}: ${choice.message}`, {
        reason: choice.code,
        model_id: ref.model_id,
      });
    if (info.trust.level !== "restricted" && !acknowledgeTrust)
      throw new HttpError(
        409,
        "trust_acknowledgement_required",
        `${what}: ${info.trust.warning} Send acknowledge_trust: true to load it in an isolated worker.`,
        { model_id: ref.model_id, trust: info.trust },
      );
    return { ref, info, adapter: choice.adapter };
  }

  /** The adapter and trust note for one model, for building an input form. */
  async describe(pid: string, sel: ModelSelector): Promise<Json> {
    const ref = await this.svc.models.pin(pid, sel, "model");
    const info = await this.svc.models.inferenceInfo(pid, ref.model_id);
    const choice = info.mlmodel
      ? selectAdapter(info.mlmodel)
      : ({
          supported: false,
          code: "no_signature",
          message: "the model has no MLmodel file",
        } as const);
    return compact({
      model: ref,
      source_run_id: info.source_run_id,
      trust: info.trust,
      adapter: choice.supported ? choice.adapter : undefined,
      unsupported: choice.supported ? undefined : { code: choice.code, message: choice.message },
      flavors: info.mlmodel?.flavors.map((f) => f.name),
      signature: info.mlmodel?.signature,
    });
  }

  private checkInputs(a: Adapter, inputs: unknown, params: unknown, maxRows: number): number {
    const v = validatePayload(a, inputs, { maxRows });
    const issues = [...v.issues, ...validateParams(a, params)];
    if (issues.length)
      throw new HttpError(422, "invalid_input", "the inputs do not match the model's signature", {
        issues,
      });
    return v.rows;
  }

  private limits(body: Json): {
    timeoutSec: number;
    memoryMb: number;
    environment: "managed" | "project";
  } {
    const t = body["timeout_sec"] ?? DEFAULT_TIMEOUT_SEC;
    if (!Number.isSafeInteger(t) || (t as number) < 10 || (t as number) > 3600)
      throw new HttpError(400, "invalid_request", "timeout_sec must be an integer in [10, 3600]");
    const m = body["memory_mb"] ?? DEFAULT_MEMORY_MB;
    if (!Number.isSafeInteger(m) || (m as number) < 128 || (m as number) > 1_048_576)
      throw new HttpError(400, "invalid_request", "memory_mb must be an integer of at least 128");
    const environment = body["environment"] ?? "managed";
    if (environment !== "managed" && environment !== "project")
      throw new HttpError(400, "invalid_request", "environment must be managed or project");
    const why = this.o.bridge.available(environment);
    if (why) throw new HttpError(503, "bridge_unavailable", `cannot run inference: ${why}`);
    return { timeoutSec: t as number, memoryMb: m as number, environment };
  }

  // ------------------------------------------------------------------ one-shot

  /** Run one pinned model once in a short-lived worker; its directory is deleted afterwards. */
  private async oneShot(
    pid: string,
    p: PinnedModel,
    payload: { inputs?: unknown; data?: Json; params?: unknown; return_inputs?: boolean },
    lim: { timeoutSec: number; memoryMb: number; environment: "managed" | "project" },
    signal?: AbortSignal,
  ): Promise<{ outcome: ModelOutcome; raw?: Json }> {
    const id = `inf-${randomBytes(8).toString("hex")}`;
    const project = this.svc.registry.get(pid);
    const t0 = performance.now();
    const base = compact({ model: p.ref, source_run_id: p.info.source_run_id });
    let run: Awaited<ReturnType<OperationsBridge["start"]>>;
    try {
      run = await this.o.bridge.start(
        id,
        compact({
          op: "predict",
          model_uri: `models:/${p.ref.model_id}`,
          adapter: p.adapter,
          inputs: payload.inputs,
          data: payload.data,
          params: payload.params,
          return_inputs: payload.return_inputs,
          max_output_bytes: MAX_OUTPUT_BYTES,
        }),
        compact({
          environment: lim.environment,
          projectPath: project?.path,
          timeoutSec: lim.timeoutSec,
          memoryMb: lim.memoryMb,
        }),
      );
    } catch (e) {
      this.o.bridge.discard(id);
      if (e instanceof BridgeUnavailableError)
        throw new HttpError(503, "bridge_unavailable", e.message);
      throw e;
    }
    let canceled = false;
    const onAbort = () => {
      canceled = true;
      void run.stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const out = await run.done;
    signal?.removeEventListener("abort", onAbort);
    // The request file held the inputs: exploration leaves nothing on disk.
    this.o.bridge.discard(id);
    const worker_ms = Math.round((performance.now() - t0) * 1000) / 1000;
    const res = out.result;
    const timings = compact({
      import_ms: num(res?.["import_ms"]),
      load_ms: num(res?.["load_ms"]),
      predict_ms: num(res?.["predict_ms"]),
      postprocess_ms: num(res?.["postprocess_ms"]),
      worker_ms,
    });
    if (res?.["ok"] === true)
      return {
        outcome: compact({
          ...base,
          status: "ok" as const,
          outputs: res["outputs"] as unknown[],
          probabilities: res["probabilities"] as unknown[] | undefined,
          probabilities_note: res["probabilities_note"] as string | undefined,
          rows: res["rows"] as number,
          timings,
          enforcement: run.enforcement,
        }),
        raw: res,
      };
    const t = out.termination;
    const error = canceled
      ? { code: "canceled", message: "the request was canceled; the worker was stopped" }
      : res?.["error"]
        ? { code: errorCode(res["kind"]), message: String(res["error"]).slice(0, 4000) }
        : t.timed_out
          ? { code: "timeout", message: `the worker hit its ${lim.timeoutSec}s time limit` }
          : t.oom_killed
            ? {
                code: "out_of_memory",
                message: `the worker hit its ${lim.memoryMb} MB memory limit`,
              }
            : {
                code: "worker_failed",
                message: `the worker exited without a result (exit ${t.exit_code ?? t.signal ?? "?"}): ${out.log_tail.slice(-1500)}`,
              };
    return {
      outcome: compact({
        ...base,
        status: "error" as const,
        error,
        timings,
        enforcement: run.enforcement,
      }),
      ...(res ? { raw: res } : {}),
    };
  }

  private remember(
    r: Omit<InferenceResult, "result_id" | "created_at" | "expires_at">,
  ): InferenceResult {
    const now = this.o.now();
    const t = now.getTime();
    for (const [k, v] of this.results) if (Date.parse(v.expires_at) <= t) this.results.delete(k);
    while (this.results.size >= MAX_RESULTS) {
      const oldest = this.results.keys().next().value as string;
      this.results.delete(oldest);
    }
    const full: InferenceResult = {
      ...r,
      result_id: `ir-${randomBytes(8).toString("hex")}`,
      created_at: now.toISOString(),
      expires_at: new Date(t + RESULT_TTL_MS).toISOString(),
    };
    this.results.set(full.result_id, full);
    return full;
  }

  result(pid: string, id: string): InferenceResult {
    const r = this.results.get(id);
    if (!r || r.project_id !== pid || Date.parse(r.expires_at) <= this.o.now().getTime())
      throw new HttpError(
        404,
        "result_expired",
        `no unsaved result ${id}: unsaved results are kept in memory for an hour and are lost on restart`,
      );
    return r;
  }

  private auditUse(
    pid: string,
    actor: Actor | SessionActor,
    action: string,
    target: string,
    details: Json,
  ) {
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: actor.kind === "system" ? "internal" : actor.kind,
      action,
      outcome: "allowed",
      project_id: pid,
      target,
      details,
    });
  }

  async predict(
    pid: string,
    body: Json,
    actor: Actor,
    signal?: AbortSignal,
  ): Promise<InferenceResult> {
    this.svc.registry.require(pid);
    const lim = this.limits(body);
    const p = await this.pin(
      pid,
      body["model"] as ModelSelector,
      "model",
      body["acknowledge_trust"] === true,
    );
    const rows = this.checkInputs(p.adapter, body["inputs"], body["params"], MAX_ONE_SHOT_ROWS);
    const { outcome, raw } = await this.oneShot(
      pid,
      p,
      compact({ inputs: body["inputs"], params: body["params"] }),
      lim,
      signal,
    );
    // Audit: counts and status only, never the inputs.
    this.auditUse(pid, actor, "inference.predict", p.ref.model_id, {
      rows,
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error.code } : {}),
    });
    return this.remember(
      compact({
        project_id: pid,
        kind: "prediction" as const,
        via: "one_shot" as const,
        task: p.adapter.task,
        output: p.adapter.output,
        labels: p.adapter.labels,
        models: [outcome],
        inputs: body["inputs"],
        params: body["params"] as Json | undefined,
        rows,
        input_sha256: sha256(canonicalJson(body["inputs"])),
        environment: compact({
          kind: lim.environment,
          mlflow_version: raw?.["mlflow_version"] as string | undefined,
          python_version: raw?.["python_version"] as string | undefined,
        }),
        trust: [p.info.trust],
      }),
    );
  }

  // ------------------------------------------------------------------ comparison

  async compare(
    pid: string,
    body: Json,
    actor: Actor,
    signal?: AbortSignal,
  ): Promise<InferenceResult> {
    const project = this.svc.registry.require(pid);
    const lim = this.limits(body);
    const sels = body["models"];
    if (!Array.isArray(sels) || sels.length < 2 || sels.length > MAX_COMPARE_MODELS)
      throw new HttpError(
        400,
        "invalid_request",
        `models must list 2 to ${MAX_COMPARE_MODELS} models`,
      );
    const ack = body["acknowledge_trust"] === true;
    const pinned: PinnedModel[] = [];
    for (const [i, s] of sels.entries())
      pinned.push(await this.pin(pid, s as ModelSelector, `models[${i}]`, ack));
    const ids = pinned.map((p) => p.ref.model_id);
    if (new Set(ids).size !== ids.length)
      throw new HttpError(
        400,
        "invalid_request",
        "the models resolve to the same logged model twice",
      );
    // Compatibility first: never run a comparison whose inputs mean different things.
    const first = pinned[0] as PinnedModel;
    const problems = pinned.slice(1).flatMap((p) => {
      const why = incompatibilities(first.adapter, p.adapter);
      return why.length ? [{ models: [first.ref.model_id, p.ref.model_id], reasons: why }] : [];
    });
    if (problems.length)
      throw new HttpError(
        422,
        "incompatible_schemas",
        "these models do not take the same inputs; a paired comparison would be meaningless",
        { pairs: problems },
      );
    let rows: number;
    let dataset: InferenceEvidenceRecord["dataset"] | undefined;
    let data: Json | undefined;
    let inputSha: string;
    const ds = body["dataset"] as Json | undefined;
    if (ds !== undefined) {
      if (body["inputs"] !== undefined)
        throw new HttpError(400, "invalid_request", "give inputs or dataset, not both");
      if (typeof ds !== "object" || ds === null)
        throw new HttpError(400, "invalid_request", "dataset must be an object");
      const abs = checkoutDataFile(project.path, ds["path"]);
      const offset = ds["offset"] ?? 0;
      const limit = ds["limit"] ?? 100;
      if (!Number.isSafeInteger(offset) || (offset as number) < 0)
        throw new HttpError(
          400,
          "invalid_request",
          "dataset.offset must be a non-negative integer",
        );
      if (
        !Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > MAX_COMPARE_ROWS
      )
        throw new HttpError(400, "invalid_request", `dataset.limit must be 1..${MAX_COMPARE_ROWS}`);
      const targets = ds["targets"];
      if (
        targets !== undefined &&
        (typeof targets !== "string" || !targets || targets.length > 250)
      )
        throw new HttpError(400, "invalid_request", "dataset.targets must name the label column");
      const split = ds["split"];
      const sha = await sha256File(abs);
      dataset = compact({
        path: ds["path"] as string,
        sha256: sha,
        offset: offset as number,
        limit: limit as number,
        targets: targets as string | undefined,
        split: typeof split === "string" ? split.slice(0, 100) : undefined,
        source_commit: gitHead(project.path),
      });
      data = compact({ path: abs, offset, limit, targets });
      inputSha = sha256(`${sha}:${offset}:${limit}`);
      rows = limit as number;
    } else {
      rows = this.checkInputs(first.adapter, body["inputs"], body["params"], MAX_COMPARE_ROWS);
      inputSha = sha256(canonicalJson(body["inputs"]));
    }
    for (const p of pinned.slice(1)) {
      const issues = validateParams(p.adapter, body["params"]);
      if (issues.length)
        throw new HttpError(422, "invalid_input", "params do not match every model", { issues });
    }
    // Each model loads in its own isolated worker; two at a time.
    const outs: { outcome: ModelOutcome; raw?: Json }[] = [];
    for (let i = 0; i < pinned.length; i += 2) {
      const batch = pinned.slice(i, i + 2);
      outs.push(
        ...(await Promise.all(
          batch.map((p, j) =>
            this.oneShot(
              pid,
              p,
              compact({
                inputs: body["inputs"],
                data,
                params: body["params"],
                return_inputs: data !== undefined && i + j === 0 ? true : undefined,
              }),
              lim,
              signal,
            ),
          ),
        )),
      );
    }
    const raw0 = outs[0]?.raw;
    const targets = (raw0?.["targets"] as unknown[] | undefined) ?? undefined;
    const inputRows = raw0?.["inputs"] as unknown[] | undefined;
    const models = outs.map((o) => o.outcome);
    const comparison = alignComparison(models, targets, first.adapter.output, dataset?.offset ?? 0);
    this.auditUse(pid, actor, "inference.compare", ids.join(","), {
      rows: comparison["rows"],
      models: ids,
      dataset: dataset?.path,
    });
    return this.remember(
      compact({
        project_id: pid,
        kind: "comparison" as const,
        via: "one_shot" as const,
        task: first.adapter.task,
        output: first.adapter.output,
        labels: first.adapter.labels,
        models,
        inputs: body["inputs"],
        input_rows: inputRows,
        targets,
        dataset,
        params: body["params"] as Json | undefined,
        rows: typeof comparison["rows"] === "number" ? (comparison["rows"] as number) : rows,
        input_sha256: inputSha,
        environment: compact({
          kind: lim.environment,
          mlflow_version: raw0?.["mlflow_version"] as string | undefined,
          python_version: raw0?.["python_version"] as string | undefined,
        }),
        comparison,
        trust: pinned.map((p) => p.info.trust),
      }),
    );
  }

  // ------------------------------------------------------------------ sessions

  async startSession(
    pid: string,
    body: Json,
    actor: SessionActor,
    extra: { deployment_id?: string; trusted?: boolean } = {},
  ): Promise<InferenceSessionRecord> {
    this.svc.registry.require(pid);
    const p = await this.pin(
      pid,
      body["model"] as ModelSelector,
      "model",
      extra.trusted === true || body["acknowledge_trust"] === true,
    );
    const env = body["environment"];
    if (env !== undefined && env !== "managed" && env !== "project")
      throw new HttpError(400, "invalid_request", "environment must be managed or project");
    const rec = await this.sessions.create(
      pid,
      compact({ model: p.ref, source_run_id: p.info.source_run_id, adapter: p.adapter }),
      {
        ...(body as SessionStartInput),
        ...(env ? { environment: env as "managed" | "project" } : {}),
      },
      actor,
      compact({ deployment_id: extra.deployment_id }),
    );
    if (body["wait"] === true) return this.sessions.waitReady(rec.session_id, 600_000);
    return rec;
  }

  async sessionPredict(
    pid: string,
    sid: string,
    body: Json,
    actor: Actor,
  ): Promise<InferenceResult> {
    const s = this.sessions.get(pid, sid);
    const a: SessionAnswer = await this.sessions.predict(pid, sid, {
      inputs: body["inputs"],
      params: body["params"],
    });
    const adapter = this.sessions.adapterOf(sid) as Adapter;
    const outcome: ModelOutcome = compact({
      model: s.model,
      source_run_id: s.source_run_id,
      status: a.ok ? ("ok" as const) : ("error" as const),
      error: a.ok
        ? undefined
        : { code: errorCode(a.kind), message: String(a.error ?? "").slice(0, 4000) },
      outputs: a.outputs,
      probabilities: a.probabilities,
      probabilities_note: a.probabilities_note,
      rows: a.rows,
      timings: compact({
        predict_ms: a.predict_ms,
        postprocess_ms: a.postprocess_ms,
        round_trip_ms: a.round_trip_ms,
      }),
      enforcement: s.enforcement,
    });
    this.auditUse(pid, actor, "inference.session.predict", sid, {
      rows: a.rows ?? 0,
      status: outcome.status,
    });
    const cur = this.sessions.get(pid, sid);
    return this.remember(
      compact({
        project_id: pid,
        kind: "prediction" as const,
        via: "session" as const,
        session_id: sid,
        task: adapter.task,
        output: adapter.output,
        labels: adapter.labels,
        models: [outcome],
        inputs: body["inputs"],
        params: body["params"] as Json | undefined,
        rows: a.rows ?? 0,
        input_sha256: sha256(canonicalJson(body["inputs"])),
        environment: compact({
          kind: cur.environment,
          mlflow_version: cur.mlflow_version,
          python_version: cur.python_version,
        }),
        trust: [],
      }),
    );
  }

  // ------------------------------------------------------------------ evidence

  private saveEvidence(r: InferenceEvidenceRecord): InferenceEvidenceRecord {
    mkdirSync(this.evidenceDir(r.project_id), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.evidenceDir(r.project_id), `${r.evidence_id}.json`), r, {
      validate: validateInferenceEvidenceRecord,
    });
    this.evidence.set(r.evidence_id, r);
    return r;
  }

  listEvidence(pid: string, includeDeleted = false): InferenceEvidenceRecord[] {
    return [...this.evidence.values()]
      .filter((e) => e.project_id === pid && (includeDeleted || !e.deleted_at))
      .sort((a, b) => b.saved_at.localeCompare(a.saved_at));
  }

  getEvidence(pid: string, id: string): InferenceEvidenceRecord {
    const e = this.evidence.get(id);
    if (!e || e.project_id !== pid)
      throw new HttpError(404, "not_found", `no inference evidence ${id}`);
    return e;
  }

  /** The record and, unless it was deleted, the artifact MLflow holds for it. */
  async evidenceView(pid: string, id: string): Promise<Json> {
    const e = this.getEvidence(pid, id);
    if (e.deleted_at || !e.mlflow_run_id) return { evidence: e };
    try {
      const res = await this.svc.tracking.client.downloadArtifact(e.mlflow_run_id, e.artifact_path);
      const text = await res.text();
      return { evidence: e, document: JSON.parse(text) as Json };
    } catch (err) {
      if (err instanceof MlflowError) return { evidence: e, unavailable: err.message };
      throw err;
    }
  }

  /**
   * Explicitly save an unsaved result as evidence: an MLflow run tagged `inference_evidence` holding
   * one artifact with the inputs, outputs and provenance, a provenance record here, and an optional
   * link from a research record.
   */
  async save(
    pid: string,
    resultId: string,
    body: Json,
    actor: Actor,
  ): Promise<InferenceEvidenceRecord> {
    const project = this.svc.registry.require(pid);
    const r = this.result(pid, resultId);
    if (r.saved_as)
      throw new HttpError(409, "already_saved", `result ${resultId} is saved as ${r.saved_as}`);
    const title =
      body["title"] ??
      `${r.kind === "comparison" ? "Comparison" : "Prediction"} of ${r.models.map((m) => (m.model.registered_name ? `${m.model.registered_name} v${m.model.version}` : m.model.model_id)).join(" vs ")}`;
    if (typeof title !== "string" || !title.trim() || title.length > 200)
      throw new HttpError(400, "invalid_request", "title must be 1..200 characters");
    const note = body["note"];
    if (note !== undefined && (typeof note !== "string" || note.length > 5000))
      throw new HttpError(400, "invalid_request", "note must be at most 5000 characters");
    const link = body["link"] as ObjectRef | undefined;
    if (link !== undefined) {
      const rec = typeof link?.id === "string" ? this.svc.research.get(pid, link.id) : undefined;
      if (!rec || rec.kind !== link.kind)
        throw new HttpError(
          422,
          "unknown_link",
          "link must name a research record of this project",
        );
    }
    const id = `ie-${randomBytes(8).toString("hex")}`;
    const commit = gitHead(project.path);
    const models = r.models.map((m) =>
      compact({
        model_id: m.model.model_id,
        registered_name: m.model.registered_name,
        version: m.model.version,
        alias: m.model.alias,
        source_run_id: m.source_run_id,
        source_commit: this.sourceCommitOf(m.source_run_id),
      }),
    );
    const stored = [
      ...(r.inputs !== undefined ? ["inputs"] : []),
      ...(r.input_rows ? ["input_rows"] : []),
      "outputs",
      ...(r.models.some((m) => m.probabilities) ? ["probabilities"] : []),
      ...(r.targets ? ["targets"] : []),
      ...(r.comparison ? ["comparison"] : []),
      "timings",
      "provenance",
    ];
    const provenance = compact({
      evidence_id: id,
      project_id: pid,
      kind: r.kind,
      via: r.via,
      session_id: r.session_id,
      models,
      task: r.task,
      output: r.output,
      dataset: r.dataset,
      input_sha256: r.input_sha256,
      params: r.params,
      code_revision: commit,
      environment: { ...r.environment, bridge_version: BRIDGE_VERSION },
      predicted_at: r.created_at,
      saved_at: this.o.now().toISOString(),
      saved_by: actor,
    });
    const doc = compact({
      schema: "ablationkit.inference_evidence/v1",
      title,
      note,
      provenance,
      inputs: r.inputs,
      input_rows: r.input_rows,
      targets: r.targets,
      labels: r.labels,
      models: r.models,
      comparison: r.comparison,
    });
    const text = JSON.stringify(doc);
    if (Buffer.byteLength(text) > MAX_EVIDENCE_BYTES)
      throw new HttpError(413, "too_large", `evidence is limited to ${MAX_EVIDENCE_BYTES} bytes`);
    let runId: string;
    let experimentId: string;
    const c = this.svc.tracking.client;
    try {
      experimentId = await this.svc.tracking.ensureExperimentNow(pid);
      const run = await c.createRun({
        experiment_id: experimentId,
        run_name: `inference evidence ${id.slice(3, 11)}`,
        tags: [
          { key: TAGS.project, value: pid },
          { key: TAGS.kind, value: "inference_evidence" },
          { key: "ablationkit.evidence_id", value: id },
          { key: "ablationkit.inference_kind", value: r.kind },
          { key: "ablationkit.evaluated_model_id", value: r.models[0]?.model.model_id ?? "" },
          { key: "ablationkit.model_ids", value: r.models.map((m) => m.model.model_id).join(",") },
          { key: "ablationkit.input_sha256", value: r.input_sha256 },
          ...(r.dataset ? [{ key: "ablationkit.dataset_sha256", value: r.dataset.sha256 }] : []),
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
    const rec: InferenceEvidenceRecord = compact({
      schema_version: 1 as const,
      evidence_id: id,
      project_id: pid,
      kind: r.kind,
      via: r.via,
      session_id: r.session_id,
      title,
      note: note as string | undefined,
      models,
      task: r.task,
      output: r.output,
      rows: r.rows,
      input_sha256: r.input_sha256,
      dataset: r.dataset,
      params: r.params,
      code_revision: commit,
      environment: compact({ ...r.environment, bridge_version: BRIDGE_VERSION }),
      stored,
      mlflow_run_id: runId,
      experiment_id: experimentId,
      artifact_path: EVIDENCE_ARTIFACT,
      artifact_bytes: Buffer.byteLength(text),
      predicted_at: r.created_at,
      saved_by: actor,
      saved_at: provenance.saved_at as string,
    });
    this.saveEvidence(rec);
    this.results.set(r.result_id, { ...r, saved_as: id });
    if (link) {
      const target = this.svc.research.get(pid, link.id);
      if (target)
        this.svc.research.update(
          pid,
          link.id,
          {
            links: [
              ...target.links,
              { kind: "inference_evidence", id, label: title.slice(0, 300) },
            ],
          },
          compact({ kind: actor.kind, id: actor.id }),
        );
    }
    this.auditUse(pid, actor, "inference.evidence.save", id, {
      result: resultId,
      mlflow_run_id: runId,
      models: models.map((m) => m.model_id),
      bytes: rec.artifact_bytes,
    });
    this.svc.events.publish(pid, "inference.evidence.saved", { evidence_id: id, kind: r.kind });
    return rec;
  }

  /** The commit the model's training attempt ran at, when a job produced it. */
  private sourceCommitOf(runId: string | undefined): string | undefined {
    if (!runId) return undefined;
    const a = this.svc.tracking.mappings.getByRunId(runId)?.attempt_id;
    return a ? this.svc.jobs.attempt(a)?.snapshot?.source_commit : undefined;
  }

  /** Delete saved evidence: the MLflow run is deleted; the record keeps a tombstone. */
  async deleteEvidence(pid: string, id: string, actor: Actor): Promise<InferenceEvidenceRecord> {
    const e = this.getEvidence(pid, id);
    if (e.deleted_at) return e;
    if (e.mlflow_run_id)
      try {
        await this.svc.tracking.client.deleteRun(e.mlflow_run_id);
      } catch (err) {
        if (err instanceof MlflowError && !err.notFound)
          throw new HttpError(
            503,
            "tracking_unavailable",
            `MLflow is unavailable; nothing was deleted: ${err.message}`,
          );
      }
    const next = this.saveEvidence({ ...e, deleted_at: this.o.now().toISOString() });
    this.auditUse(pid, actor, "inference.evidence.delete", id, { mlflow_run_id: e.mlflow_run_id });
    this.svc.events.publish(pid, "inference.evidence.deleted", { evidence_id: id });
    return next;
  }

  // ------------------------------------------------------------- deployments

  /**
   * The local preview launcher for deployment gates (ADR 0018 decision on deployments): an
   * approved `preview_local` deployment of `models:/<name>/<version>` starts an inference session
   * with the deployment's TTL. There is no network endpoint; the session is reachable only through
   * the coordinator. Other kinds need remote workers (Stage 16).
   */
  launcher(): DeploymentLauncher {
    return {
      name: "inference-session",
      start: async (d: DeploymentRecord) => {
        if (d.kind !== "preview_local" || d.exposure !== "loopback")
          throw new HttpError(
            422,
            "unsupported_deployment",
            "only local loopback previews start here; remote research endpoints need a remote worker (Stage 16)",
          );
        const m = /^models:\/(.+)\/([1-9][0-9]{0,9})$/.exec(d.model_uri);
        if (!m)
          throw new HttpError(
            422,
            "unsupported_model_uri",
            "a local preview needs a registry version (models:/<name>/<version>)",
          );
        const ttl = Math.min(d.ttl_minutes * 60, 86_400);
        const s = await this.startSession(
          d.project_id,
          {
            model: { name: m[1], version: m[2] },
            idle_timeout_sec: ttl,
            max_lifetime_sec: Math.max(ttl + 60, 10),
            wait: true,
          },
          { kind: "system", id: d.deployment_id },
          { deployment_id: d.deployment_id, trusted: true },
        );
        if (s.state !== "ready")
          throw new HttpError(
            502,
            "session_failed",
            `the session ${s.state}: ${s.end_reason ?? ""}`,
          );
        return { endpoint: `ablationkit:inference-session/${s.session_id}` };
      },
      stop: async (d: DeploymentRecord) => {
        const s = this.sessions.byDeployment(d.deployment_id);
        if (s)
          await this.sessions.stop(
            s.session_id,
            "stopped",
            `deployment ${d.deployment_id} stopped`,
          );
      },
    };
  }
}

/**
 * Align the models' outputs example by example (the same ordered rows), with disagreements,
 * correctness against the targets when present, and an exact McNemar test for two classifiers.
 */
export function alignComparison(
  models: readonly ModelOutcome[],
  targets: readonly unknown[] | undefined,
  output: Adapter["output"],
  offset: number,
): Json {
  const ok = models.filter((m) => m.status === "ok" && Array.isArray(m.outputs));
  if (ok.length !== models.length)
    return {
      paired: false,
      rows: 0,
      note: "at least one model failed; nothing is aligned",
      failed: models.filter((m) => m.status !== "ok").map((m) => m.model.model_id),
    };
  const n = (ok[0]?.outputs ?? []).length;
  if (ok.some((m) => (m.outputs ?? []).length !== n))
    return { paired: false, rows: 0, note: "the models returned different row counts" };
  const regression = output === "regression";
  const same = (a: unknown, b: unknown) => {
    if (regression && typeof a === "number" && typeof b === "number")
      return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    return canonicalJson(a) === canonicalJson(b);
  };
  const hasTargets = Array.isArray(targets) && targets.length === n;
  const correct = (p: unknown, t: unknown) => String(p) === String(t);
  const examples = [];
  let disagreements = 0;
  const perModel = ok.map(() => ({ correct: 0, abs_err: 0 }));
  for (let i = 0; i < n; i++) {
    const preds = ok.map((m) => (m.outputs as unknown[])[i]);
    const agree = preds.every((p) => same(p, preds[0]));
    if (!agree) disagreements++;
    const t = hasTargets ? (targets as unknown[])[i] : undefined;
    const ex: Json = { index: offset + i, predictions: preds, agree };
    if (hasTargets) {
      ex["target"] = t;
      if (regression)
        ex["abs_errors"] = preds.map((p, j) => {
          const e = typeof p === "number" && typeof t === "number" ? Math.abs(p - t) : null;
          if (e !== null) (perModel[j] as { abs_err: number }).abs_err += e;
          return e;
        });
      else
        ex["correct"] = preds.map((p, j) => {
          const c = correct(p, t);
          if (c) (perModel[j] as { correct: number }).correct++;
          return c;
        });
    }
    examples.push(ex);
  }
  const summary = ok.map((m, j) =>
    compact({
      model_id: m.model.model_id,
      rows: n,
      correct: hasTargets && !regression ? perModel[j]?.correct : undefined,
      accuracy: hasTargets && !regression && n ? (perModel[j]?.correct ?? 0) / n : undefined,
      mae: hasTargets && regression && n ? (perModel[j]?.abs_err ?? 0) / n : undefined,
      load_ms: m.timings.load_ms,
      predict_ms: m.timings.predict_ms,
      metric_direction: hasTargets
        ? regression
          ? "lower is better"
          : "higher is better"
        : undefined,
    }),
  );
  const out: Json = {
    paired: true,
    rows: n,
    disagreements,
    has_targets: hasTargets,
    summary,
    examples,
  };
  if (hasTargets && !regression && ok.length === 2) {
    let b = 0;
    let c = 0;
    for (const ex of examples) {
      const [x, y] = ex["correct"] as boolean[];
      if (x && !y) b++;
      if (y && !x) c++;
    }
    const p = exactMcnemar(b, c);
    out["paired_test"] =
      p === undefined
        ? { note: "no discordant pairs: no paired test computed" }
        : {
            method: "exact McNemar (two-sided binomial test on discordant pairs)",
            assumptions: "paired predictions on the same ordered rows; rows independent",
            only_first_correct: b,
            only_second_correct: c,
            p_value: p,
          };
  } else
    out["paired_test"] = {
      note: hasTargets
        ? "a significance test is computed only for two classifiers"
        : "no targets: correctness and significance are not computed",
    };
  return out;
}
