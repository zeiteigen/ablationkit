/**
 * Classical model evaluation (spec §5.5 "Classical model evaluation", §5.6 Evaluations; criterion 7;
 * ADR 0019).
 *
 * The researcher picks a pinned model (a logged-model ID, or a registry version/alias resolved and
 * pinned at launch), an optional baseline, a dataset file in the checkout with its target column,
 * and validation thresholds. The coordinator creates the MLflow run(s), then the operations bridge
 * runs `mlflow.models.evaluate` and `mlflow.validate_evaluation_results` in an isolated worker.
 * MLflow keeps the metrics, plots and tables; this record keeps the execution state, the pinned
 * inputs (with the dataset's SHA-256) and the threshold outcomes.
 *
 * A coordinator restart never resumes or reruns an evaluation: one that was running is marked
 * `interrupted`, its worker is stopped, and its MLflow runs are ended `KILLED`.
 *
 * Remote evaluations (`target_id`; criterion 9e, ADR 0023 decision 21) run as a job on a compute
 * target: the pinned model's files ride in the attempt's bundle (`inputs/model`), the committed
 * dataset is in its source, and `ablationkit_sdk.evaluate` computes the classical metrics there and
 * logs them through the worker's spool. The job's MLflow run is the evaluation's run. The
 * coordinator checks the thresholds once the attempt is synced. Being independently supervised, a
 * remote evaluation is not interrupted by a restart; it reconciles like its job, never twice.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type EvaluationModelRef,
  type EvaluationRecord,
  type ThresholdOutcome,
  type ThresholdSpec,
  validateEvaluationRecord,
} from "@ablationkit/protocol";
import { MlflowError, type MlflowTag, TAGS } from "@ablationkit/tracking-mlflow";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";
import { sha256File } from "../state/backup.ts";
import {
  type BridgeRun,
  BridgeUnavailableError,
  type OperationsBridge,
} from "../tracking/bridge.ts";
import { exportModelFiles, treeSha256 } from "./export.ts";
import type { ModelSelector } from "./models.ts";

const DECIMAL_RE = /^-?[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?$/;
const METRIC_RE = /^[A-Za-z0-9_./ -]{1,250}$/;
export const MAX_DATASET_BYTES = 2 * 1024 * 1024 * 1024;
const TERMINAL = new Set(["succeeded", "failed", "canceled", "interrupted"]);

export interface EvaluationInput {
  readonly model_type: "classifier" | "regressor";
  readonly model: ModelSelector;
  readonly baseline?: ModelSelector;
  readonly dataset: { path: string; targets: string; name?: string; split?: string };
  readonly thresholds?: readonly ThresholdSpec[];
  readonly environment?: "managed" | "project";
  /** Batch evaluation: per-example predictions and paired outcomes too (default true). */
  readonly examples?: boolean;
  readonly timeout_sec?: number;
  readonly memory_mb?: number;
  /** Run on this compute target (a remote evaluation). */
  readonly target_id?: string;
  /** Paid targets: the requester accepted the estimate. */
  readonly accept_cost?: boolean;
}

export interface EvaluationServiceOptions {
  readonly svc: () => Services;
  readonly stateDir: string;
  readonly bridge: OperationsBridge;
  readonly now: () => Date;
  readonly maxConcurrent?: number;
  /** How often open remote evaluations follow their jobs (default 2 s). */
  readonly remotePollMs?: number;
}

/** `uv` when asked for the project's environment, or by default when the project has one. */
function environmentIsUv(root: string, env: EvaluationInput["environment"]): boolean {
  return env === "project" || (env === undefined && existsSync(join(root, "pyproject.toml")));
}

const DEC = (n: number) => (Number.isFinite(n) ? String(n) : "0");

/** An absolute threshold against a synced metric (change thresholds need a baseline: local only). */
function checkThreshold(t: ThresholdSpec, value: number | undefined): ThresholdOutcome {
  if (value === undefined || !Number.isFinite(value))
    return { metric: t.metric, passed: false, failures: [`${t.metric} was not logged`] };
  const failures: string[] = [];
  if (t.threshold !== undefined) {
    const th = Number(t.threshold);
    const ok = t.greater_is_better ? value >= th : value <= th;
    if (!ok)
      failures.push(
        `${t.metric} = ${DEC(value)} is ${t.greater_is_better ? "below" : "above"} the threshold ${t.threshold}`,
      );
  }
  return { metric: t.metric, passed: failures.length === 0, candidate: DEC(value), failures };
}

/** The checkout's HEAD commit, if it is a Git repository. */
export function gitHead(path: string): string | undefined {
  try {
    const p = Bun.spawnSync(["git", "-C", path, "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = p.stdout.toString().trim();
    return p.exitCode === 0 && /^[a-f0-9]{7,64}$/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A data file inside a checkout: a relative path, no `..`, a regular file within the size limit
 * and a supported table format. Returns the absolute path.
 */
export function checkoutDataFile(root: string, rel: unknown, what = "dataset.path"): string {
  if (typeof rel !== "string" || !rel || rel.startsWith("/") || rel.split("/").includes(".."))
    throw new HttpError(
      400,
      "invalid_request",
      `${what} must be a relative path inside the checkout`,
    );
  const abs = resolve(root, rel);
  if (!abs.startsWith(root + sep) || !existsSync(abs) || !statSync(abs).isFile())
    throw new HttpError(404, "dataset_not_found", `no file ${rel} in the project checkout`);
  if (statSync(abs).size > MAX_DATASET_BYTES)
    throw new HttpError(
      413,
      "dataset_too_large",
      `datasets are limited to ${MAX_DATASET_BYTES} bytes`,
    );
  if (!/\.(csv|parquet|pq|jsonl|ndjson)$/i.test(abs))
    throw new HttpError(422, "unsupported_dataset", "dataset must be .csv, .parquet or .jsonl");
  return abs;
}

export class EvaluationService {
  private readonly records = new Map<string, EvaluationRecord>();
  private readonly running = new Map<string, BridgeRun>();
  private readonly queue: string[] = [];
  private remoteTimer: ReturnType<typeof setInterval> | undefined;
  /** Set by shutdown: late completions are left for the next start to mark interrupted. */
  private stopped = false;
  readonly loadProblems: string[] = [];

  constructor(private readonly o: EvaluationServiceOptions) {}

  private get svc(): Services {
    return this.o.svc();
  }

  private dir(pid: string): string {
    return join(this.o.stateDir, pid, "evaluations");
  }

  private save(r: EvaluationRecord): EvaluationRecord {
    mkdirSync(this.dir(r.project_id), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.dir(r.project_id), `${r.evaluation_id}.json`), r, {
      validate: validateEvaluationRecord,
    });
    this.records.set(r.evaluation_id, r);
    this.svc.events.publish(r.project_id, "evaluation.updated", {
      evaluation_id: r.evaluation_id,
      state: r.state,
      ...(r.validation ? { passed: r.validation.passed } : {}),
    });
    return r;
  }

  private update(id: string, patch: Partial<EvaluationRecord>): EvaluationRecord {
    const cur = this.records.get(id) as EvaluationRecord;
    return this.save({ ...cur, ...patch, updated_at: this.o.now().toISOString() });
  }

  /** Load records; anything a previous coordinator left running is interrupted (never rerun). */
  /** Evaluations of a project that have not finished (project removal refuses these). */
  unfinished(pid: string): EvaluationRecord[] {
    return [...this.records.values()].filter((r) => r.project_id === pid && !TERMINAL.has(r.state));
  }

  /** Drop a removed project's evaluations from memory. */
  forgetProject(pid: string): void {
    for (const [id, r] of [...this.records]) if (r.project_id === pid) this.records.delete(id);
  }

  load(projects: readonly string[]): void {
    for (const pid of projects) {
      const d = this.dir(pid);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
        try {
          const r = readJson(join(d, f), validateEvaluationRecord);
          this.records.set(r.evaluation_id, r);
        } catch {
          this.loadProblems.push(join(d, f));
        }
      }
    }
  }

  start(): void {
    for (const r of this.records.values()) {
      if (TERMINAL.has(r.state)) continue;
      // Independently supervised: it reconciles with its job (`reconcileRemote`), never reruns.
      if (r.remote) continue;
      if (r.state === "running") this.o.bridge.reap(r.evaluation_id);
      this.update(r.evaluation_id, {
        state: "interrupted",
        ended_at: this.o.now().toISOString(),
        error:
          r.state === "running"
            ? "the coordinator stopped while this evaluation ran; it was not rerun. Launch it again."
            : "the coordinator stopped before this evaluation started; it was not run.",
      });
      void this.endRuns(r, "KILLED");
    }
    if ([...this.records.values()].some((r) => r.remote && !TERMINAL.has(r.state)))
      this.ensureRemoteTimer();
  }

  async shutdown(): Promise<void> {
    // Leave running workers to be reaped (and marked interrupted) by the next start.
    this.stopped = true;
    this.queue.length = 0;
    if (this.remoteTimer) clearInterval(this.remoteTimer);
  }

  list(pid: string): EvaluationRecord[] {
    return [...this.records.values()]
      .filter((r) => r.project_id === pid)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(pid: string, id: string): EvaluationRecord {
    const r = this.records.get(id);
    if (!r || r.project_id !== pid) throw new HttpError(404, "not_found", `no evaluation ${id}`);
    return r;
  }

  private pin(pid: string, sel: ModelSelector, what: string): Promise<EvaluationModelRef> {
    return this.svc.models.pin(pid, sel, what);
  }

  private thresholds(list: readonly ThresholdSpec[], baseline: boolean): ThresholdSpec[] {
    if (!Array.isArray(list) || list.length > 50)
      throw new HttpError(400, "invalid_request", "thresholds must be a list of at most 50");
    const seen = new Set<string>();
    return list.map((t) => {
      if (!t || typeof t.metric !== "string" || !METRIC_RE.test(t.metric))
        throw new HttpError(400, "invalid_request", "each threshold needs a metric name");
      if (seen.has(t.metric))
        throw new HttpError(400, "invalid_request", `metric ${t.metric} has two thresholds`);
      seen.add(t.metric);
      if (typeof t.greater_is_better !== "boolean")
        throw new HttpError(
          400,
          "invalid_request",
          `${t.metric}: greater_is_better must be a boolean`,
        );
      for (const k of ["threshold", "min_absolute_change", "min_relative_change"] as const) {
        const v = t[k];
        if (v !== undefined && (typeof v !== "string" || !DECIMAL_RE.test(v)))
          throw new HttpError(400, "invalid_request", `${t.metric}.${k} must be a decimal string`);
      }
      if (
        t.threshold === undefined &&
        t.min_absolute_change === undefined &&
        t.min_relative_change === undefined
      )
        throw new HttpError(
          400,
          "invalid_request",
          `${t.metric}: give threshold, min_absolute_change or min_relative_change`,
        );
      if (t.min_absolute_change !== undefined && !(Number(t.min_absolute_change) > 0))
        throw new HttpError(
          400,
          "invalid_request",
          `${t.metric}.min_absolute_change must be positive`,
        );
      if (t.min_relative_change !== undefined) {
        const r = Number(t.min_relative_change);
        if (!(r >= 0 && r <= 1) || !t.min_relative_change.includes("."))
          throw new HttpError(
            400,
            "invalid_request",
            `${t.metric}.min_relative_change must be a decimal between 0 and 1 (e.g. 0.05)`,
          );
      }
      if ((t.min_absolute_change !== undefined || t.min_relative_change !== undefined) && !baseline)
        throw new HttpError(
          422,
          "baseline_required",
          `${t.metric}: change thresholds compare against a baseline model`,
        );
      return compact<ThresholdSpec>({
        metric: t.metric,
        greater_is_better: t.greater_is_better,
        threshold: t.threshold,
        min_absolute_change: t.min_absolute_change,
        min_relative_change: t.min_relative_change,
      });
    });
  }

  async create(
    pid: string,
    input: EvaluationInput,
    actor: EvaluationRecord["requested_by"],
  ): Promise<EvaluationRecord> {
    const project = this.svc.registry.require(pid);
    if (input.model_type !== "classifier" && input.model_type !== "regressor")
      throw new HttpError(400, "invalid_request", "model_type must be classifier or regressor");
    const environment = input.environment ?? "managed";
    if (environment !== "managed" && environment !== "project")
      throw new HttpError(400, "invalid_request", "environment must be managed or project");
    if (input.target_id !== undefined && input.target_id !== "local")
      return this.createRemote(pid, project.path, input, actor);
    const unavailable = this.o.bridge.available(environment);
    if (unavailable)
      throw new HttpError(503, "bridge_unavailable", `cannot evaluate: ${unavailable}`);
    if (input.examples !== undefined && typeof input.examples !== "boolean")
      throw new HttpError(400, "invalid_request", "examples must be a boolean");
    const timeout = input.timeout_sec ?? 1800;
    if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 86_400)
      throw new HttpError(400, "invalid_request", "timeout_sec must be 10..86400");
    if (
      input.memory_mb !== undefined &&
      (!Number.isSafeInteger(input.memory_mb) || input.memory_mb < 64)
    )
      throw new HttpError(400, "invalid_request", "memory_mb must be an integer of at least 64");
    // Dataset: a file inside the checkout, fingerprinted now so the record pins what was evaluated.
    const ds = input.dataset ?? ({} as EvaluationInput["dataset"]);
    const abs = checkoutDataFile(project.path, ds.path);
    if (typeof ds.targets !== "string" || !METRIC_RE.test(ds.targets))
      throw new HttpError(400, "invalid_request", "dataset.targets must name the label column");
    const model = await this.pin(pid, input.model ?? {}, "model");
    const baseline = input.baseline ? await this.pin(pid, input.baseline, "baseline") : undefined;
    const thresholds = this.thresholds(input.thresholds ?? [], baseline !== undefined);
    const sha = await sha256File(abs);
    const commit = await this.sourceCommit(project.path);
    const now = this.o.now().toISOString();
    const id = `ev-${randomBytes(8).toString("hex")}`;
    // MLflow first: an evaluation needs MLflow, so there is nothing to queue while it is down.
    let experimentId: string;
    let runId: string;
    let baselineRunId: string | undefined;
    try {
      experimentId = await this.svc.tracking.ensureExperimentNow(pid);
      const tags = (role: string, m: EvaluationModelRef): MlflowTag[] => [
        { key: TAGS.project, value: pid },
        { key: TAGS.kind, value: "evaluation" },
        { key: TAGS.evaluation, value: id },
        { key: "ablationkit.evaluation_role", value: role },
        { key: "ablationkit.evaluated_model_id", value: m.model_id },
        { key: "ablationkit.dataset_sha256", value: sha },
        ...(m.registered_name
          ? [{ key: "ablationkit.registered_model", value: `${m.registered_name}/${m.version}` }]
          : []),
      ];
      runId = (
        await this.svc.tracking.client.createRun({
          experiment_id: experimentId,
          run_name: `eval ${id.slice(3, 11)}`,
          tags: tags("candidate", model),
        })
      ).info.run_id;
      if (baseline)
        baselineRunId = (
          await this.svc.tracking.client.createRun({
            experiment_id: experimentId,
            run_name: `eval ${id.slice(3, 11)} baseline`,
            tags: tags("baseline", baseline),
          })
        ).info.run_id;
    } catch (e) {
      if (e instanceof MlflowError)
        throw new HttpError(503, "tracking_unavailable", `MLflow is unavailable: ${e.message}`);
      throw e;
    }
    const rec: EvaluationRecord = compact({
      schema_version: 1 as const,
      evaluation_id: id,
      project_id: pid,
      kind: "classical" as const,
      model_type: input.model_type,
      model,
      baseline,
      dataset: compact({
        path: ds.path,
        sha256: sha,
        name: (ds.name ?? ds.path.split("/").at(-1) ?? "dataset").slice(0, 250),
        targets: ds.targets,
        split: ds.split,
        source_commit: commit,
      }),
      thresholds,
      environment,
      examples_requested: input.examples ?? true,
      state: "queued" as const,
      mlflow_run_id: runId,
      baseline_run_id: baselineRunId,
      experiment_id: experimentId,
      limits: compact({ timeout_sec: timeout, memory_mb: input.memory_mb }),
      requested_by: actor,
      created_at: now,
      updated_at: now,
    });
    this.save(rec);
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: actor.kind,
      action: "evaluation.create",
      outcome: "allowed",
      project_id: pid,
      target: id,
      details: compact({
        model: model.model_id,
        baseline: baseline?.model_id,
        dataset: ds.path,
        sha256: sha,
      }),
    });
    this.queue.push(id);
    this.pump();
    return rec;
  }

  /** Validation shared by local and remote evaluations. */
  private limits(input: EvaluationInput): number {
    const timeout = input.timeout_sec ?? 1800;
    if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 86_400)
      throw new HttpError(400, "invalid_request", "timeout_sec must be 10..86400");
    if (
      input.memory_mb !== undefined &&
      (!Number.isSafeInteger(input.memory_mb) || input.memory_mb < 64)
    )
      throw new HttpError(400, "invalid_request", "memory_mb must be an integer of at least 64");
    return timeout;
  }

  private async createRemote(
    pid: string,
    root: string,
    input: EvaluationInput,
    actor: EvaluationRecord["requested_by"],
  ): Promise<EvaluationRecord> {
    const targetId = input.target_id as string;
    const target = this.svc.targets.get(targetId);
    if (!target) throw new HttpError(404, "target_not_found", `no compute target ${targetId}`);
    if (input.baseline)
      throw new HttpError(
        422,
        "baseline_not_remote",
        "a remote evaluation checks thresholds on one model; evaluate the baseline as its own remote evaluation, or run the comparison locally",
      );
    const timeout = this.limits(input);
    const ds = input.dataset ?? ({} as EvaluationInput["dataset"]);
    const abs = checkoutDataFile(root, ds.path);
    if (!/\.(csv|jsonl|ndjson)$/i.test(abs))
      throw new HttpError(422, "unsupported_dataset", "remote evaluation reads .csv or .jsonl");
    if (typeof ds.targets !== "string" || !METRIC_RE.test(ds.targets))
      throw new HttpError(400, "invalid_request", "dataset.targets must name the label column");
    // The worker evaluates the file in the bundle (the pinned commit), so it must be that file.
    const tracked = Bun.spawnSync(
      ["git", "-C", root, "ls-files", "--error-unmatch", "--", ds.path],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const dirty = Bun.spawnSync(["git", "-C", root, "status", "--porcelain", "--", ds.path], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (tracked.exitCode !== 0 || dirty.stdout.toString().trim())
      throw new HttpError(
        422,
        "dataset_not_committed",
        `${ds.path} must be committed and unchanged: a remote evaluation reads it from the bundle of the pinned commit`,
      );
    const model = await this.pin(pid, input.model ?? {}, "model");
    const thresholds = this.thresholds(input.thresholds ?? [], false);
    // Fail on the target before anything is staged (cost acceptance, time limit, worker URL).
    this.svc.remote.check(targetId, {
      acceptCost: input.accept_cost === true,
      runtimeSec: timeout,
    });
    const sha = await sha256File(abs);
    const id = `ev-${randomBytes(8).toString("hex")}`;
    const stage = join(this.dir(pid), `${id}.inputs`, "model");
    let artifactUri: string;
    try {
      artifactUri = (await this.svc.tracking.client.getLoggedModel(model.model_id)).info
        .artifact_uri;
    } catch (e) {
      if (e instanceof MlflowError)
        throw new HttpError(503, "tracking_unavailable", `MLflow is unavailable: ${e.message}`);
      throw e;
    }
    await exportModelFiles(this.svc.tracking.client, artifactUri, stage, model.model_id);
    const modelSha = treeSha256(stage);
    const uv = environmentIsUv(root, input.environment);
    const python = uv ? "python" : (target.python ?? "python3");
    let submitted: ReturnType<Services["jobs"]["submit"]>;
    try {
      submitted = this.svc.jobs.submit({
        project_id: pid,
        command: [
          python,
          "-m",
          "ablationkit_sdk.evaluate",
          "--type",
          input.model_type,
          "--data",
          ds.path,
          "--targets",
          ds.targets,
          "--dataset-sha256",
          sha,
          "--model-sha256",
          modelSha,
        ],
        environment: uv ? "uv" : "none",
        limits: compact({
          runtime_max_sec: timeout,
          memory_max_bytes: input.memory_mb ? input.memory_mb * 1024 * 1024 : undefined,
        }),
        run_name: `eval ${id.slice(3, 11)}`,
        target_id: targetId,
        accept_cost: input.accept_cost === true,
        bundle_inputs: [{ name: "model", path: stage }],
        submitted_by: compact({ kind: actor.kind, id: actor.id }),
      });
    } catch (e) {
      rmSync(join(this.dir(pid), `${id}.inputs`), { recursive: true, force: true });
      throw e;
    }
    const now = this.o.now().toISOString();
    const rec: EvaluationRecord = compact({
      schema_version: 1 as const,
      evaluation_id: id,
      project_id: pid,
      kind: "classical" as const,
      model_type: input.model_type,
      model,
      dataset: compact({
        path: ds.path,
        sha256: sha,
        name: (ds.name ?? ds.path.split("/").at(-1) ?? "dataset").slice(0, 250),
        targets: ds.targets,
        split: ds.split,
        source_commit: submitted.attempt.remote?.source_commit ?? gitHead(root),
      }),
      thresholds,
      environment: uv ? ("project" as const) : ("managed" as const),
      examples_requested: false,
      state: "running" as const,
      remote: {
        target_id: targetId,
        job_id: submitted.job.job_id,
        attempt_id: submitted.attempt.attempt_id,
        model_sha256: modelSha,
      },
      limits: compact({ timeout_sec: timeout, memory_mb: input.memory_mb }),
      enforcement: "advisory" as const,
      requested_by: actor,
      created_at: now,
      started_at: now,
      updated_at: now,
    });
    this.save(rec);
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: actor.kind,
      action: "evaluation.create",
      outcome: "allowed",
      project_id: pid,
      target: id,
      details: compact({
        model: model.model_id,
        dataset: ds.path,
        sha256: sha,
        target_id: targetId,
        job_id: submitted.job.job_id,
        model_sha256: modelSha,
      }),
    });
    this.ensureRemoteTimer();
    return rec;
  }

  private ensureRemoteTimer(): void {
    if (this.remoteTimer || this.stopped) return;
    this.remoteTimer = setInterval(() => {
      void this.reconcileRemote().catch(() => {});
    }, this.o.remotePollMs ?? 2000);
    (this.remoteTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Follow each open remote evaluation's job. Nothing here starts anything: a failed or `unknown`
   * attempt is reported, never retried (criterion 9e).
   */
  async reconcileRemote(): Promise<void> {
    for (const r of [...this.records.values()]) {
      if (!r.remote || TERMINAL.has(r.state)) continue;
      const job = this.svc.jobs.get(r.remote.job_id);
      const a = job ? this.svc.jobs.latestAttempt(job) : undefined;
      if (!job || !a) continue;
      const m = this.svc.tracking.mappings.get(a.attempt_id);
      const patch: Partial<EvaluationRecord> = {};
      if (m?.mlflow_run_id && r.mlflow_run_id !== m.mlflow_run_id) {
        // Link the job's run to the evaluation (best effort; the record holds the link anyway).
        try {
          const c = this.svc.tracking.client;
          await c.setTag(m.mlflow_run_id, TAGS.evaluation, r.evaluation_id);
          await c.setTag(m.mlflow_run_id, "ablationkit.evaluated_model_id", r.model.model_id);
          await c.setTag(m.mlflow_run_id, "ablationkit.dataset_sha256", r.dataset.sha256);
        } catch {
          continue;
        }
        patch.mlflow_run_id = m.mlflow_run_id;
        if (m.experiment_id) patch.experiment_id = m.experiment_id;
      }
      const ended = this.o.now().toISOString();
      const remote = { ...r.remote, attempt_id: a.attempt_id };
      if (a.state === "succeeded") {
        const runId = patch.mlflow_run_id ?? r.mlflow_run_id;
        const synced = a.remote?.sync === "synced";
        let metrics: Map<string, number> | undefined;
        if (synced && runId)
          try {
            const run = await this.svc.tracking.client.getRun(runId);
            metrics = new Map((run.data?.metrics ?? []).map((x) => [x.key, Number(x.value)]));
          } catch {
            metrics = undefined;
          }
        if (!metrics?.has("example_count")) {
          const note = synced
            ? "the job finished; waiting for its metrics to reach MLflow"
            : "the job finished; waiting for the worker to deliver its results";
          if (r.remote.note !== note || Object.keys(patch).length)
            this.update(r.evaluation_id, { ...patch, remote: { ...remote, note } });
          continue;
        }
        const outcomes = r.thresholds.map((t) => checkThreshold(t, metrics.get(t.metric)));
        const { note: _n, ...done } = remote;
        this.update(r.evaluation_id, {
          ...patch,
          remote: done,
          state: "succeeded",
          ended_at: ended,
          validation: { passed: outcomes.every((o) => o.passed), outcomes },
        });
      } else if (a.state === "cancelled") {
        this.update(r.evaluation_id, { ...patch, remote, state: "canceled", ended_at: ended });
      } else if (a.state === "failed" || a.state === "timed_out" || a.state === "oom_killed") {
        this.update(r.evaluation_id, {
          ...patch,
          remote,
          state: "failed",
          ended_at: ended,
          error:
            `the evaluation job ${a.state.replace("_", " ")}${a.exit_code !== undefined ? ` (exit ${a.exit_code})` : ""}${a.error ? `: ${a.error}` : ""}`.slice(
              0,
              4000,
            ),
        });
      } else if (a.state === "unknown" || a.remote?.reconcile_required) {
        const note = `the attempt is ${a.state}${a.remote?.reconcile_required ? ` (${a.remote.reconcile_required})` : ""}: resolve it on the job; the evaluation is not rerun`;
        if (r.remote.note !== note)
          this.update(r.evaluation_id, { ...patch, remote: { ...remote, note } });
      } else if (Object.keys(patch).length || r.remote.attempt_id !== a.attempt_id) {
        this.update(r.evaluation_id, { ...patch, remote });
      }
    }
  }

  private async sourceCommit(path: string): Promise<string | undefined> {
    return gitHead(path);
  }

  private pump(): void {
    if (this.stopped) return;
    const max = this.o.maxConcurrent ?? 2;
    while (this.running.size < max && this.queue.length) {
      const id = this.queue.shift() as string;
      const r = this.records.get(id);
      if (r?.state !== "queued") continue;
      void this.execute(r);
    }
  }

  private async execute(r: EvaluationRecord): Promise<void> {
    const project = this.svc.registry.get(r.project_id);
    const id = r.evaluation_id;
    let run: BridgeRun;
    try {
      run = await this.o.bridge.start(
        id,
        compact({
          op: "evaluate",
          run_id: r.mlflow_run_id,
          baseline_run_id: r.baseline_run_id,
          model_uri: `models:/${r.model.model_id}`,
          baseline_model_uri: r.baseline ? `models:/${r.baseline.model_id}` : undefined,
          model_type: r.model_type,
          data: compact({
            path: resolve(project?.path ?? "/", r.dataset.path),
            source: r.dataset.path,
            name: r.dataset.name,
            targets: r.dataset.targets,
          }),
          thresholds: r.thresholds,
          examples: r.examples_requested === true ? true : undefined,
        }),
        compact({
          environment: r.environment,
          projectPath: project?.path,
          timeoutSec: r.limits.timeout_sec,
          memoryMb: r.limits.memory_mb,
        }),
      );
    } catch (e) {
      if (this.stopped) return;
      this.update(id, {
        state: "failed",
        ended_at: this.o.now().toISOString(),
        error: (e instanceof BridgeUnavailableError
          ? `bridge unavailable: ${e.message}`
          : String(e)
        ).slice(0, 4000),
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
    const cur = this.records.get(id) as EvaluationRecord;
    const ended = this.o.now().toISOString();
    const res = out.result;
    if (cur.state === "canceled") {
      await this.endRuns(cur, "KILLED");
    } else if (res?.["ok"] === true) {
      const v = res["validation"] as EvaluationRecord["validation"] | null | undefined;
      const ex = res["examples"] as EvaluationRecord["examples"] | null | undefined;
      this.update(
        id,
        compact({
          state: "succeeded" as const,
          ended_at: ended,
          validation: v ?? undefined,
          examples: ex ?? undefined,
        }),
      );
    } else {
      const t = out.termination;
      const why = res?.["error"]
        ? String(res["error"])
        : t.timed_out
          ? `the evaluation worker hit its ${cur.limits.timeout_sec}s time limit`
          : t.oom_killed
            ? "the evaluation worker ran out of memory (limit reached)"
            : `the evaluation worker exited without a result (exit ${t.exit_code ?? t.signal ?? "?"}): ${out.log_tail.slice(-1500)}`;
      this.update(id, { state: "failed", ended_at: ended, error: why.slice(0, 4000) });
      await this.endRuns(cur, "FAILED");
    }
    this.pump();
  }

  /** Best effort: a run the worker never closed is ended with this status. */
  private async endRuns(r: EvaluationRecord, status: "FAILED" | "KILLED"): Promise<void> {
    for (const runId of [r.mlflow_run_id, r.baseline_run_id]) {
      if (!runId) continue;
      try {
        const run = await this.svc.tracking.client.getRun(runId);
        if (run.info.status === "RUNNING" || run.info.status === "SCHEDULED")
          await this.svc.tracking.client.updateRun({ run_id: runId, status, end_time: Date.now() });
      } catch {
        // MLflow down: the run stays RUNNING in MLflow; the record says what happened
      }
    }
  }

  async cancel(
    pid: string,
    id: string,
    actor: EvaluationRecord["requested_by"],
  ): Promise<EvaluationRecord> {
    const r = this.get(pid, id);
    if (TERMINAL.has(r.state))
      throw new HttpError(409, "not_running", `evaluation ${id} is ${r.state}`);
    if (r.remote) {
      // The job owns the run: cancel it there (heartbeat and provider), then record it here.
      try {
        this.svc.jobs.cancel(r.remote.job_id);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 409)) throw e;
      }
      this.update(id, { state: "canceled", ended_at: this.o.now().toISOString() });
    } else {
      const next = this.update(id, { state: "canceled", ended_at: this.o.now().toISOString() });
      const run = this.running.get(id);
      if (run) await run.stop();
      else await this.endRuns(next, "KILLED");
    }
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: actor.kind,
      action: "evaluation.cancel",
      outcome: "allowed",
      project_id: pid,
      target: id,
    });
    return this.records.get(id) as EvaluationRecord;
  }

  /** The record plus what MLflow holds for it: metrics and the diagnostic artifacts. */
  async view(pid: string, id: string): Promise<Record<string, unknown>> {
    const r = this.get(pid, id);
    const c = this.svc.tracking.client;
    const runOf = async (runId: string | undefined) => {
      if (!runId) return undefined;
      try {
        const run = await c.getRun(runId);
        const files: { path: string; is_dir: boolean; file_size?: number }[] = [];
        const walk = async (p: string | undefined, depth: number) => {
          const page = await c.listArtifacts(runId, p);
          for (const f of page.items) {
            if (f.is_dir && depth < 3) await walk(f.path, depth + 1);
            else files.push(f);
          }
        };
        await walk(undefined, 0);
        return {
          run_id: runId,
          status: run.info.status,
          metrics: Object.fromEntries((run.data.metrics ?? []).map((m) => [m.key, m.value])),
          artifacts: files,
        };
      } catch (e) {
        if (e instanceof MlflowError) return { run_id: runId, unavailable: e.message };
        throw e;
      }
    };
    return compact({
      evaluation: r,
      candidate: await runOf(r.mlflow_run_id),
      baseline: await runOf(r.baseline_run_id),
    });
  }

  /** The per-example artifact (`ablationkit/examples.json`) MLflow holds for a batch evaluation. */
  async examples(pid: string, id: string): Promise<Record<string, unknown>> {
    const r = this.get(pid, id);
    if (!r.examples || !r.mlflow_run_id)
      throw new HttpError(404, "not_found", `evaluation ${id} has no example-level results`);
    try {
      const res = await this.svc.tracking.client.downloadArtifact(
        r.mlflow_run_id,
        "ablationkit/examples.json",
      );
      const text = await res.text();
      if (text.length > 8 * 1024 * 1024)
        throw new HttpError(413, "too_large", "the examples artifact is larger than 8 MiB");
      return JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof MlflowError)
        throw new HttpError(503, "tracking_unavailable", `MLflow is unavailable: ${e.message}`);
      throw e;
    }
  }

  logTail(pid: string, id: string): string {
    this.get(pid, id);
    const f = this.o.bridge.logPath(id);
    if (!existsSync(f)) return "";
    const text = readFileSync(f);
    return text.subarray(Math.max(0, text.length - 65_536)).toString("utf8");
  }
}
