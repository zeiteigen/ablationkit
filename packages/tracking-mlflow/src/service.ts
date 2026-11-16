/**
 * Tracking service: the coordinator's single path for structured MLflow writes (spec §4.2, §5.5).
 *
 * Every write is journaled in the outbox first and reported as `tracking_pending` until MLflow
 * acknowledges it; nothing is shown as committed before that (criterion 11). A background flusher
 * delivers ops in order per run, retries transient failures with backoff, and parks rejected ones
 * as `sync_failed` (visible, retryable). Run creation is idempotent across ambiguous retries: the
 * flusher first looks for a run tagged with the same `ablationkit.ref` before creating one.
 */
import { randomUUID } from "node:crypto";
import type { TrackingError, TrackingRunMapping, TrackingSyncState } from "@ablationkit/protocol";
import {
  chunkBatch,
  type MlflowClient,
  type MlflowDatasetInput,
  MlflowError,
  type MlflowMetric,
  type MlflowParam,
  type MlflowTag,
  type MlflowTraceInfo,
  type RunStatus,
} from "./client.ts";
import type { MappingStore } from "./mapping.ts";
import type { NewOp, Outbox, OutboxEntry } from "./outbox.ts";
import {
  isReservedTag,
  MAX_RUN_NOTES,
  MAX_RUN_SUMMARY,
  NOTES_TAG,
  projectExperimentName,
  TAGS,
} from "./tags.ts";

export class TrackingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackingInputError";
  }
}

export interface StartRunInput {
  readonly project_id: string;
  /** Attempt ID for job attempts; omitted for manual runs (a `mr-` ref is minted). */
  readonly ref?: string;
  readonly kind: "attempt" | "manual" | "import";
  readonly job_id?: string;
  readonly attempt_id?: string;
  readonly study_id?: string;
  readonly variant_id?: string;
  readonly task_id?: string;
  readonly run_name?: string;
  /** The run's short description: what it tests and why (the `ablationkit.summary` tag). */
  readonly summary?: string;
  /** In-depth notes, Markdown (the `mlflow.note.content` tag). */
  readonly notes?: string;
  /** Launched from this `MLproject` entrypoint: tags the run like `mlflow run` does. */
  readonly mlproject_entrypoint?: string;
  /** `import` runs: where the run's files were, who imported it, and the commit it says it used. */
  readonly import?: { readonly source: string; readonly by: string; readonly commit?: string };
  /** Epoch ms. Defaults to now. */
  readonly start_time?: number;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface LogBatchInput {
  readonly metrics?: readonly MlflowMetric[];
  readonly params?: readonly MlflowParam[];
  readonly tags?: readonly MlflowTag[];
}

export interface ModelFile {
  readonly path: string;
  readonly size: number;
}

export interface LogModelInput {
  /** SDK-side idempotency key (hex). */
  readonly model_key: string;
  readonly name: string;
  /** Where the SDK staged the model directory inside the run's artifacts. */
  readonly artifact_path: string;
  readonly files: readonly ModelFile[];
  readonly step?: number;
  readonly model_type?: string;
}

export interface LoggedModelResult {
  readonly project_id: string;
  readonly ref: string;
  readonly model_id: string;
  readonly name: string;
  readonly model_key: string;
  readonly experiment_id: string;
  readonly run_id: string;
}

/**
 * A finished trace a job recorded (`trace.logged`), with the project's capture policy already
 * applied by the coordinator: the outbox never holds bodies the policy excludes.
 */
export interface LogTraceInput {
  readonly trace_id: string;
  readonly request_time: string;
  readonly execution_duration_ms: number;
  readonly state: "OK" | "ERROR";
  readonly metadata: Record<string, string>;
  readonly tags: Record<string, string>;
  readonly spans: readonly unknown[];
}

/** Bound on one queued trace (spans and metadata), so the outbox bound stays meaningful. */
export const MAX_TRACE_BYTES = 2 * 1024 * 1024;

export interface WriteReceipt {
  readonly ref: string;
  readonly op_ids: readonly string[];
}

export interface SyncSummary {
  readonly state: TrackingSyncState;
  readonly pending_ops: number;
  readonly failed_ops: number;
  readonly last_error?: TrackingError;
}

export interface TrackingServiceOptions {
  readonly client: MlflowClient;
  readonly outbox: Outbox;
  readonly mappings: MappingStore;
  readonly now?: () => Date;
  /** Called after a mapping changes (sync state, run ID). The coordinator publishes an event. */
  readonly onMappingChange?: (m: TrackingRunMapping) => void;
  readonly onExperimentReady?: (projectId: string, experimentId: string) => void;
  /** Called after a `log_model` op created (or found) and finalized the logged model. */
  readonly onModelLogged?: (info: LoggedModelResult) => void;
  /** How long a `log_model` op waits for its files before it fails (visible, retryable). */
  readonly modelFilesDeadlineMs?: number;
  /** Flush interval while ops are pending. */
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
}

const KEY_RE = /^[A-Za-z0-9_\-. /]{1,250}$/;
const MAX_PARAM_VALUE = 6000;
const MAX_TAG_VALUE = 8000;

function checkKey(kind: string, key: unknown): string {
  if (typeof key !== "string" || !KEY_RE.test(key) || key.includes("..") || key.startsWith("/"))
    throw new TrackingInputError(`invalid ${kind} key ${JSON.stringify(key)}`);
  return key;
}

/** Validate and normalize a batch before it is queued: a bad batch never enters the outbox. */
export function validateBatch(
  b: LogBatchInput,
  opts: { allowReservedTags?: boolean } = {},
): Required<LogBatchInput> {
  const metrics = (b.metrics ?? []).map((m) => {
    checkKey("metric", m.key);
    if (typeof m.value !== "number" || Number.isNaN(m.value))
      throw new TrackingInputError(`metric ${m.key}: value must be a number`);
    if (!Number.isSafeInteger(m.timestamp) || m.timestamp < 0)
      throw new TrackingInputError(`metric ${m.key}: timestamp must be epoch milliseconds`);
    if (!Number.isSafeInteger(m.step))
      throw new TrackingInputError(`metric ${m.key}: step must be an integer`);
    return { key: m.key, value: m.value, timestamp: m.timestamp, step: m.step };
  });
  const params = (b.params ?? []).map((p) => {
    checkKey("param", p.key);
    if (typeof p.value !== "string" || p.value.length > MAX_PARAM_VALUE)
      throw new TrackingInputError(
        `param ${p.key}: value must be a string of at most ${MAX_PARAM_VALUE} chars`,
      );
    return { key: p.key, value: p.value };
  });
  const tags = (b.tags ?? []).map((t) => {
    checkKey("tag", t.key);
    if (!opts.allowReservedTags && isReservedTag(t.key))
      throw new TrackingInputError(`tag ${t.key} is reserved`);
    if (typeof t.value !== "string" || t.value.length > MAX_TAG_VALUE)
      throw new TrackingInputError(
        `tag ${t.key}: value must be a string of at most ${MAX_TAG_VALUE} chars`,
      );
    return { key: t.key, value: t.value };
  });
  if (metrics.length + params.length + tags.length === 0)
    throw new TrackingInputError("empty batch");
  return { metrics, params, tags };
}

function toTrackingError(e: unknown): TrackingError {
  if (e instanceof MlflowError) {
    return {
      kind: e.kind,
      message: e.message.slice(0, 2000),
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.code ? { code: e.code.slice(0, 200) } : {}),
    };
  }
  return { kind: "rejected", message: (e instanceof Error ? e.message : String(e)).slice(0, 2000) };
}

/** An op the flusher must hold back without counting a failure (it is waiting on another op). */
class Blocked extends Error {}

const MAX_DATASET_FIELD = 1_000_000;

/** Validate dataset inputs before they are queued (MLflow's own limits, roughly). */
export function validateDatasets(ds: readonly MlflowDatasetInput[]): MlflowDatasetInput[] {
  if (!Array.isArray(ds) || ds.length === 0 || ds.length > 100)
    throw new TrackingInputError("datasets must be a list of 1 to 100 inputs");
  return ds.map((d) => {
    const x = d?.dataset;
    if (!x || typeof x !== "object") throw new TrackingInputError("dataset is required");
    const s = (k: keyof typeof x, max: number, required = true): string | undefined => {
      const v = x[k];
      if (v === undefined && !required) return undefined;
      if (typeof v !== "string" || (required && !v) || v.length > max)
        throw new TrackingInputError(
          `dataset.${String(k)} must be a string of at most ${max} chars`,
        );
      return v;
    };
    const tags = (d.tags ?? []).map((t: MlflowTag) => {
      checkKey("dataset tag", t?.key);
      if (typeof t.value !== "string" || t.value.length > 5000)
        throw new TrackingInputError(`dataset tag ${t.key}: value too long`);
      return { key: t.key, value: t.value };
    });
    const schema = s("schema", MAX_DATASET_FIELD, false);
    const profile = s("profile", 16_000, false);
    return {
      tags,
      dataset: {
        name: s("name", 500) as string,
        digest: s("digest", 36) as string,
        source_type: s("source_type", 36) as string,
        source: s("source", 65_000) as string,
        ...(schema !== undefined ? { schema } : {}),
        ...(profile !== undefined ? { profile } : {}),
      },
    };
  });
}

export class TrackingService {
  readonly client: MlflowClient;
  readonly outbox: Outbox;
  readonly mappings: MappingStore;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private paused = 0;
  private flushing: Promise<void> | undefined;
  private kicked = false;
  private readonly waiters = new Set<() => void>();
  /** Last time a flush reached MLflow, and the last transport error, for status. */
  lastContactAt: string | undefined;
  lastTransportError: TrackingError | undefined;
  /** Circuit breaker: after MLflow is unreachable, no delivery attempt before this (epoch ms). */
  private downUntil = 0;
  private downStreak = 0;

  constructor(private readonly options: TrackingServiceOptions) {
    this.client = options.client;
    this.outbox = options.outbox;
    this.mappings = options.mappings;
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
  }

  // ------------------------------------------------------------------ writes

  /** Queue the project experiment `ak/<project-id>` unless it is known or already queued. */
  ensureProject(projectId: string): string | undefined {
    const links = this.mappings.getLinks(projectId);
    if (links.experiment_id) return undefined;
    if (this.outbox.entries({ projectId }).some((e) => e.op.kind === "ensure_experiment"))
      return undefined;
    const e = this.outbox.enqueue({
      kind: "ensure_experiment",
      project_id: projectId,
      payload: {},
    });
    this.kick();
    return e.op_id;
  }

  startRun(input: StartRunInput): WriteReceipt & { mapping: TrackingRunMapping } {
    const ref = input.ref ?? `mr-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    if (this.mappings.get(ref)) throw new TrackingInputError(`run ${ref} already exists`);
    if (
      input.kind === "attempt" &&
      (!input.job_id || !input.attempt_id || input.attempt_id !== ref)
    )
      throw new TrackingInputError(
        "attempt runs need job_id and attempt_id, and ref must equal attempt_id",
      );
    if ((input.kind === "import") !== (input.import !== undefined))
      throw new TrackingInputError("import runs, and only they, carry their import source");
    const extraTags = Object.entries(input.tags ?? {}).map(([key, value]) => ({ key, value }));
    if (extraTags.length) validateBatch({ tags: extraTags });
    const ts = this.now().toISOString();
    const mapping: TrackingRunMapping = {
      schema_version: 1,
      ref,
      kind: input.kind,
      project_id: input.project_id,
      experiment_name: projectExperimentName(input.project_id),
      ...(input.job_id ? { job_id: input.job_id } : {}),
      ...(input.attempt_id ? { attempt_id: input.attempt_id } : {}),
      ...(input.study_id ? { study_id: input.study_id } : {}),
      ...(input.variant_id ? { variant_id: input.variant_id } : {}),
      ...(input.task_id ? { task_id: input.task_id } : {}),
      ...(input.run_name ? { run_name: input.run_name } : {}),
      ...(input.mlproject_entrypoint ? { mlproject_entrypoint: input.mlproject_entrypoint } : {}),
      ...(input.import ? { import_source: input.import.source } : {}),
      sync_state: "tracking_pending",
      created_at: ts,
      updated_at: ts,
    };
    const tags: MlflowTag[] = [
      { key: TAGS.project, value: input.project_id },
      { key: TAGS.ref, value: ref },
      { key: TAGS.kind, value: input.kind },
    ];
    const opt: [string, string | undefined][] = [
      [TAGS.job, input.job_id],
      [TAGS.attempt, input.attempt_id],
      [TAGS.study, input.study_id],
      [TAGS.variant, input.variant_id],
      [TAGS.task, input.task_id],
      [TAGS.summary, input.summary?.slice(0, MAX_RUN_SUMMARY)],
      [NOTES_TAG, input.notes?.slice(0, MAX_RUN_NOTES)],
    ];
    for (const [key, value] of opt) if (value) tags.push({ key, value });
    if (input.mlproject_entrypoint) {
      if (!/^[A-Za-z0-9_.-]{1,200}$/.test(input.mlproject_entrypoint))
        throw new TrackingInputError("bad MLproject entrypoint name");
      tags.push(
        { key: TAGS.mlproject, value: input.mlproject_entrypoint },
        { key: "mlflow.project.entryPoint", value: input.mlproject_entrypoint },
        { key: "mlflow.source.type", value: "PROJECT" },
        { key: "mlflow.project.backend", value: "local" },
      );
    }
    if (input.import)
      tags.push(
        { key: TAGS.importSource, value: input.import.source },
        { key: TAGS.importedBy, value: input.import.by },
        { key: TAGS.importedAt, value: ts },
        ...(input.import.commit ? [{ key: TAGS.importCommit, value: input.import.commit }] : []),
      );
    tags.push(...extraTags);
    const op = this.enqueue({
      kind: "create_run",
      project_id: input.project_id,
      ref,
      payload: {
        ...(input.run_name ? { run_name: input.run_name } : {}),
        start_time: input.start_time ?? this.now().getTime(),
        tags,
      },
    });
    this.mappings.put(mapping);
    this.kick();
    return { ref, op_ids: [op.op_id], mapping };
  }

  logBatch(ref: string, batch: LogBatchInput): WriteReceipt {
    const m = this.requireMapping(ref);
    const clean = validateBatch(batch);
    const op = this.enqueue({
      kind: "log_batch",
      project_id: m.project_id,
      ref,
      payload: { ...clean },
    });
    this.markPending(m);
    this.kick();
    return { ref, op_ids: [op.op_id] };
  }

  endRun(
    ref: string,
    input: { status: Exclude<RunStatus, "RUNNING" | "SCHEDULED">; end_time?: number },
  ): WriteReceipt {
    const m = this.requireMapping(ref);
    const op = this.enqueue({
      kind: "update_run",
      project_id: m.project_id,
      ref,
      payload: { status: input.status, end_time: input.end_time ?? this.now().getTime() },
    });
    this.markPending(m);
    this.kick();
    return { ref, op_ids: [op.op_id] };
  }

  /** Queue dataset inputs for a run (`runs/log-inputs`). */
  logInputs(ref: string, datasets: readonly MlflowDatasetInput[]): WriteReceipt {
    const m = this.requireMapping(ref);
    const clean = validateDatasets(datasets);
    const op = this.enqueue({
      kind: "log_inputs",
      project_id: m.project_id,
      ref,
      payload: { datasets: clean },
    });
    this.markPending(m);
    this.kick();
    return { ref, op_ids: [op.op_id] };
  }

  /** Queue a trace for a run: StartTraceV3, then its spans to the trace's artifact location. */
  logTrace(ref: string, input: LogTraceInput): WriteReceipt {
    const m = this.requireMapping(ref);
    if (!/^tr-[a-f0-9]{32}$/.test(input.trace_id))
      throw new TrackingInputError("trace_id must be tr- and 32 hex characters");
    if (Number.isNaN(Date.parse(input.request_time)))
      throw new TrackingInputError("request_time must be an ISO timestamp");
    if (!Number.isSafeInteger(input.execution_duration_ms) || input.execution_duration_ms < 0)
      throw new TrackingInputError("execution_duration_ms must be a non-negative integer");
    if (input.state !== "OK" && input.state !== "ERROR")
      throw new TrackingInputError("state must be OK or ERROR");
    if (!Array.isArray(input.spans) || input.spans.length > 5000)
      throw new TrackingInputError("a trace has at most 5000 spans");
    for (const o of [input.metadata, input.tags])
      for (const [k, v] of Object.entries(o))
        if (typeof v !== "string" || k.length > 250 || v.length > 8000)
          throw new TrackingInputError(
            "trace metadata and tags are strings (keys ≤ 250, values ≤ 8000)",
          );
    const payload = { ...input };
    if (JSON.stringify(payload).length > MAX_TRACE_BYTES)
      throw new TrackingInputError(`a trace is limited to ${MAX_TRACE_BYTES} bytes`);
    const op = this.enqueue({ kind: "log_trace", project_id: m.project_id, ref, payload });
    this.markPending(m);
    this.kick();
    return { ref, op_ids: [op.op_id] };
  }

  /**
   * Queue a logged model whose files the worker stages into the run's artifacts. The op waits
   * (without failing) until every declared file is in MLflow, then creates the logged model,
   * copies the files to its own artifact location, finalizes it and records the run output.
   */
  logModel(ref: string, input: LogModelInput): WriteReceipt {
    const m = this.requireMapping(ref);
    if (!/^[a-f0-9]{8,64}$/.test(input.model_key))
      throw new TrackingInputError("model_key must be 8-64 hex characters");
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(input.name))
      throw new TrackingInputError("model name: letters, digits, '_', '-', '.' (1-200)");
    const ap = input.artifact_path;
    if (!ap || ap.startsWith("/") || ap.split("/").some((s) => s === ".." || s === "." || !s))
      throw new TrackingInputError("artifact_path must be a relative path inside the run");
    if (input.files.length === 0 || input.files.length > 10_000)
      throw new TrackingInputError("a model needs 1 to 10000 files");
    for (const f of input.files)
      if (
        typeof f.path !== "string" ||
        !f.path ||
        f.path.startsWith("/") ||
        f.path.split("/").some((s) => s === ".." || s === "." || !s) ||
        !Number.isSafeInteger(f.size) ||
        f.size < 0
      )
        throw new TrackingInputError(`bad model file entry ${JSON.stringify(f).slice(0, 200)}`);
    if (!input.files.some((f) => f.path === "MLmodel"))
      throw new TrackingInputError("a logged model directory must contain an MLmodel file");
    if (
      this.outbox
        .entries({ ref })
        .some((e) => e.op.kind === "log_model" && e.op.payload["model_key"] === input.model_key)
    )
      return { ref, op_ids: [] };
    const op = this.enqueue({
      kind: "log_model",
      project_id: m.project_id,
      ref,
      payload: {
        model_key: input.model_key,
        name: input.name,
        artifact_path: ap,
        files: input.files.map((f) => ({ path: f.path, size: f.size })),
        step: input.step ?? 0,
        ...(input.model_type ? { model_type: input.model_type.slice(0, 100) } : {}),
      },
    });
    this.markPending(m);
    this.kick();
    return { ref, op_ids: [op.op_id] };
  }

  /** Put a failed op back in the queue. */
  retry(opId: string): OutboxEntry | undefined {
    const e = this.outbox.requeue(opId);
    if (e?.op.ref) {
      const m = this.mappings.get(e.op.ref);
      if (m) this.refreshMapping(m.ref);
    }
    this.kick();
    return e;
  }

  private enqueue(op: NewOp): OutboxEntry {
    return this.outbox.enqueue(op);
  }

  private requireMapping(ref: string): TrackingRunMapping {
    const m = this.mappings.get(ref);
    if (!m) throw new TrackingInputError(`unknown tracked run ${ref}`);
    return m;
  }

  private markPending(m: TrackingRunMapping): void {
    if (m.sync_state === "tracking_pending") return;
    this.saveMapping({
      ...m,
      sync_state: "tracking_pending",
      updated_at: this.now().toISOString(),
    });
  }

  private saveMapping(m: TrackingRunMapping): void {
    this.mappings.put(m);
    this.options.onMappingChange?.(m);
  }

  // ------------------------------------------------------------- read helpers

  sync(ref: string): SyncSummary {
    const live = this.outbox.entries({ ref });
    const failed = live.filter((e) => e.state === "failed");
    const last = [...live].reverse().find((e) => e.last_error)?.last_error;
    const state: TrackingSyncState = failed.length
      ? "sync_failed"
      : live.length
        ? "tracking_pending"
        : "synced";
    return {
      state,
      pending_ops: live.length - failed.length,
      failed_ops: failed.length,
      ...(last ? { last_error: last } : {}),
    };
  }

  // ----------------------------------------------------------------- flusher

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flushing;
  }

  /** Stop delivering (for a consistent backup) until `resume`. Waits for an in-flight pass. */
  async pause(): Promise<void> {
    this.paused++;
    await this.flushing;
  }

  resume(): void {
    this.paused = Math.max(0, this.paused - 1);
    if (this.paused === 0) this.kick();
  }

  /** The sidecar became healthy: retry now instead of waiting out the backoff. */
  mlflowAvailable(): void {
    this.downUntil = 0;
    this.downStreak = 0;
    for (const e of this.outbox.entries({ state: "pending" })) e.next_attempt_at = 0;
    this.kick();
  }

  kick(): void {
    this.kicked = true;
    if (this.running && !this.flushing) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().finally(() => {
        const busy = this.outbox.entries({ state: "pending" }).length > 0;
        if (this.kicked) this.schedule(0);
        else if (busy) this.schedule(this.intervalMs);
      });
    }, ms);
  }

  /** Resolve true once none of `opIds` is pending any more (acked or failed), false on timeout. */
  async waitFor(opIds: readonly string[], timeoutMs: number): Promise<boolean> {
    const done = () => opIds.every((id) => this.outbox.get(id)?.state !== "pending");
    if (done()) return true;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(check);
        resolve(done());
      }, timeoutMs);
      const check = () => {
        if (!done()) return;
        clearTimeout(t);
        this.waiters.delete(check);
        resolve(true);
      };
      this.waiters.add(check);
    });
  }

  /** One delivery pass. Concurrent calls share the pass in flight. */
  flush(): Promise<void> {
    if (this.paused > 0) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.kicked = false;
    this.flushing = this.pass().finally(() => {
      this.flushing = undefined;
      for (const w of [...this.waiters]) w();
    });
    return this.flushing;
  }

  private backoff(attempts: number): number {
    const base = Math.min(this.maxBackoffMs, 500 * 2 ** Math.min(attempts, 16));
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  private async pass(): Promise<void> {
    const blocked = new Set<string>();
    const touched = new Set<string>();
    const now = this.now().getTime();
    if (now < this.downUntil) return;
    let acked = 0;
    for (const e of this.outbox.entries()) {
      // A model waits for its files on its own key, so it never holds the run's metrics back.
      const key =
        e.op.kind === "log_model"
          ? `${e.op.ref}#model:${String(e.op.payload["model_key"])}`
          : (e.op.ref ?? `project:${e.op.project_id}`);
      if (e.state === "failed") {
        // A failed create/ensure leaves nothing to log to: hold later ops for the same target.
        if (e.op.kind === "create_run" || e.op.kind === "ensure_experiment") blocked.add(key);
        continue;
      }
      if (blocked.has(key)) continue;
      if (e.next_attempt_at > now) {
        blocked.add(key);
        continue;
      }
      try {
        const result = await this.execute(e);
        this.outbox.ack(e.op_id, result);
        this.lastContactAt = this.now().toISOString();
        this.lastTransportError = undefined;
        this.downStreak = 0;
        acked++;
        if (e.op.ref) touched.add(e.op.ref);
      } catch (err) {
        if (err instanceof Blocked) {
          blocked.add(key);
          continue;
        }
        const te = toTrackingError(err);
        if (te.kind === "rejected") {
          this.lastContactAt = this.now().toISOString();
          this.outbox.fail(e.op_id, te);
          if (e.op.ref) touched.add(e.op.ref);
          if (e.op.kind === "create_run" || e.op.kind === "ensure_experiment") blocked.add(key);
          continue;
        }
        this.lastTransportError = te;
        this.outbox.deferred(e.op_id, te, this.now().getTime() + this.backoff(e.attempts));
        if (e.op.ref) touched.add(e.op.ref);
        // MLflow is unreachable: stop this pass rather than fail every op the same way.
        if (te.kind === "unavailable") {
          this.downUntil = this.now().getTime() + this.backoff(this.downStreak++);
          break;
        }
        blocked.add(key);
      }
    }
    for (const ref of touched) this.refreshMapping(ref);
    if (acked > 0) this.outbox.gc();
  }

  private refreshMapping(ref: string): void {
    const m = this.mappings.get(ref);
    if (!m) return;
    const s = this.sync(ref);
    const lastError = s.last_error && s.state !== "synced" ? s.last_error.message : undefined;
    if (m.sync_state === s.state && m.last_error === lastError) return;
    const ts = this.now().toISOString();
    const { last_error: _drop, ...rest } = m;
    this.saveMapping({
      ...rest,
      sync_state: s.state,
      updated_at: ts,
      ...(s.state === "synced" ? { synced_at: ts } : {}),
      ...(lastError && s.state === "sync_failed" ? { last_error: lastError } : {}),
    });
  }

  private async execute(e: OutboxEntry): Promise<Record<string, unknown>> {
    switch (e.op.kind) {
      case "ensure_experiment":
        return { experiment_id: await this.ensureExperimentNow(e.op.project_id) };
      case "create_run":
        return this.createRunNow(e);
      case "log_batch": {
        const runId = this.runIdFor(e);
        const p = e.op.payload as {
          metrics?: MlflowMetric[];
          params?: MlflowParam[];
          tags?: MlflowTag[];
        };
        // Chunks are idempotent to replay: MLflow skips identical metrics, re-setting a tag or an
        // unchanged param is a no-op.
        for (const chunk of chunkBatch(p)) await this.client.logBatch({ run_id: runId, ...chunk });
        return { run_id: runId };
      }
      case "update_run": {
        const runId = this.runIdFor(e);
        const p = e.op.payload as { status?: RunStatus; end_time?: number; run_name?: string };
        await this.client.updateRun({ run_id: runId, ...p });
        return { run_id: runId };
      }
      case "log_inputs": {
        const runId = this.runIdFor(e);
        const p = e.op.payload as { datasets: MlflowDatasetInput[] };
        await this.client.logInputs(runId, p.datasets);
        return { run_id: runId };
      }
      case "log_model":
        return this.logModelNow(e);
      case "log_trace":
        return this.logTraceNow(e);
    }
  }

  private async logTraceNow(e: OutboxEntry): Promise<Record<string, unknown>> {
    const runId = this.runIdFor(e);
    const m = this.mappings.get(e.op.ref as string) as TrackingRunMapping;
    const experimentId = m.experiment_id ?? (await this.ensureExperimentNow(m.project_id));
    const p = e.op.payload as unknown as LogTraceInput;
    let info: MlflowTraceInfo;
    try {
      info = await this.client.startTrace({
        trace_id: p.trace_id,
        trace_location: {
          type: "MLFLOW_EXPERIMENT",
          mlflow_experiment: { experiment_id: experimentId },
        },
        request_time: p.request_time,
        execution_duration: `${(p.execution_duration_ms / 1000).toFixed(3)}s`,
        state: p.state,
        trace_metadata: {
          "mlflow.trace_schema.version": "3",
          ...p.metadata,
          "mlflow.sourceRun": runId,
        },
        tags: p.tags,
      });
    } catch (err) {
      // A replay after an ambiguous delivery: the info landed, the spans may not have.
      if (!(err instanceof MlflowError) || err.kind !== "rejected" || !/exist/i.test(err.message))
        throw err;
      info = await this.client.getTraceInfo(p.trace_id);
    }
    await this.client.uploadTraceSpans(info, p.spans);
    return { run_id: runId, trace_id: p.trace_id };
  }

  private async listTree(runId: string, path: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const walk = async (p: string, depth: number) => {
      if (depth > 32) return;
      let token: string | undefined;
      do {
        const page = await this.client.listArtifacts(runId, p, token);
        for (const f of page.items) {
          if (f.is_dir) await walk(f.path, depth + 1);
          else out.set(f.path, f.file_size ?? -1);
        }
        token = page.next_page_token;
      } while (token);
    };
    await walk(path, 0);
    return out;
  }

  private async logModelNow(e: OutboxEntry): Promise<Record<string, unknown>> {
    const runId = this.runIdFor(e);
    const m = this.mappings.get(e.op.ref as string) as TrackingRunMapping;
    const experimentId = m.experiment_id ?? (await this.ensureExperimentNow(m.project_id));
    const p = e.op.payload as {
      model_key: string;
      name: string;
      artifact_path: string;
      files: ModelFile[];
      step: number;
      model_type?: string;
    };
    // 1. Every declared file must be in the run's artifacts (the collector uploads them).
    const have = await this.listTree(runId, p.artifact_path);
    const missing = p.files.filter((f) => {
      const size = have.get(`${p.artifact_path}/${f.path}`);
      return size === undefined || (size >= 0 && size !== f.size);
    });
    if (missing.length) {
      const age = this.now().getTime() - Date.parse(e.op.enqueued_at);
      if (age > (this.options.modelFilesDeadlineMs ?? 6 * 3600_000))
        throw new MlflowError(
          "rejected",
          `model ${p.name}: ${missing.length} file(s) never reached MLflow (first: ${missing[0]?.path}); retry after the upload completes`,
        );
      throw new Blocked();
    }
    // 2. Find or create the logged model (idempotent on the SDK's key).
    const found = await this.client.searchLoggedModels({
      experiment_ids: [experimentId],
      filter: `tags.\`${TAGS.modelKey}\` = '${p.model_key}'`,
      max_results: 2,
    });
    let model = found.items[0];
    if (!model) {
      const tags: MlflowTag[] = [
        { key: TAGS.project, value: m.project_id },
        { key: TAGS.ref, value: m.ref },
        { key: TAGS.modelKey, value: p.model_key },
      ];
      if (m.job_id) tags.push({ key: TAGS.job, value: m.job_id });
      if (m.attempt_id) tags.push({ key: TAGS.attempt, value: m.attempt_id });
      model = await this.client.createLoggedModel({
        experiment_id: experimentId,
        name: p.name,
        source_run_id: runId,
        ...(p.model_type ? { model_type: p.model_type } : {}),
        tags,
      });
    }
    const modelId = model.info.model_id;
    // 3. Copy the files to the model's own location, then mark it ready.
    if (model.info.status !== "LOGGED_MODEL_READY") {
      for (const f of p.files) {
        const res = await this.client.downloadArtifact(runId, `${p.artifact_path}/${f.path}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        await this.client.uploadProxiedArtifact(model.info.artifact_uri, f.path, bytes);
      }
      await this.client.finalizeLoggedModel(modelId, "LOGGED_MODEL_READY");
    }
    // 4. The run produced it.
    await this.client.logOutputs(runId, [{ model_id: modelId, step: p.step }]);
    this.options.onModelLogged?.({
      project_id: m.project_id,
      ref: m.ref,
      model_id: modelId,
      name: p.name,
      model_key: p.model_key,
      experiment_id: experimentId,
      run_id: runId,
    });
    return { run_id: runId, model_id: modelId };
  }

  private runIdFor(e: OutboxEntry): string {
    const m = e.op.ref ? this.mappings.get(e.op.ref) : undefined;
    if (!m) throw new MlflowError("rejected", `no mapping for ${e.op.ref ?? "?"}`);
    if (!m.mlflow_run_id) throw new Blocked();
    return m.mlflow_run_id;
  }

  /** Find or create `ak/<project-id>`; restores it if it was deleted. */
  async ensureExperimentNow(projectId: string): Promise<string> {
    const links = this.mappings.getLinks(projectId);
    if (links.experiment_id) return links.experiment_id;
    const name = projectExperimentName(projectId);
    let exp = await this.client.getExperimentByName(name);
    let id: string;
    if (!exp) {
      try {
        id = await this.client.createExperiment(name, [{ key: TAGS.project, value: projectId }]);
      } catch (err) {
        // An ambiguous create may have landed: look again before failing.
        exp = await this.client.getExperimentByName(name);
        if (!exp) throw err;
        id = exp.experiment_id;
      }
    } else {
      id = exp.experiment_id;
      if (exp.lifecycle_stage === "deleted") await this.client.restoreExperiment(id);
      const tag = exp.tags?.find((t) => t.key === TAGS.project)?.value;
      if (tag !== undefined && tag !== projectId)
        throw new MlflowError("rejected", `experiment ${name} is tagged for project ${tag}`);
      if (tag === undefined) await this.client.setExperimentTag(id, TAGS.project, projectId);
    }
    this.mappings.putLinks({ ...this.mappings.getLinks(projectId), experiment_id: id });
    this.options.onExperimentReady?.(projectId, id);
    return id;
  }

  private async createRunNow(e: OutboxEntry): Promise<Record<string, unknown>> {
    const ref = e.op.ref as string;
    const m = this.mappings.get(ref);
    if (!m) throw new MlflowError("rejected", `no mapping for ${ref}`);
    if (m.mlflow_run_id) return { run_id: m.mlflow_run_id };
    const experimentId = await this.ensureExperimentNow(m.project_id);
    // Idempotency: a previous ambiguous attempt may already have created the run.
    const found = await this.client.searchRuns({
      experiment_ids: [experimentId],
      filter: `tags.\`${TAGS.ref}\` = '${ref}'`,
      run_view_type: "ALL",
      max_results: 2,
    });
    let runId = found.items[0]?.info.run_id;
    if (!runId) {
      const p = e.op.payload as { run_name?: string; start_time?: number; tags?: MlflowTag[] };
      const run = await this.client.createRun({
        experiment_id: experimentId,
        ...(p.run_name ? { run_name: p.run_name } : {}),
        ...(p.start_time !== undefined ? { start_time: p.start_time } : {}),
        tags: p.tags ?? [],
      });
      runId = run.info.run_id;
    }
    const current = this.mappings.get(ref) ?? m;
    this.saveMapping({
      ...current,
      experiment_id: experimentId,
      mlflow_run_id: runId,
      updated_at: this.now().toISOString(),
    });
    return { run_id: runId, experiment_id: experimentId };
  }
}
