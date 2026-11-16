/**
 * Local job runner and worker ingest (spec §4.1–4.2, §5.7, §6, §7.11, §10; ADR 0011).
 *
 * A job is a logical submission; each attempt runs one command in the project's own environment
 * under a collector launched as a detached helper (a transient systemd user service, or a
 * detached process in direct mode), so a running attempt survives a coordinator restart. The
 * collector delivers events at least once; this service dedupes them per producer, journals
 * console output per attempt (independent of MLflow), forwards metrics/params/tags to the
 * tracking outbox and turns lifecycle events into compute status.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { TokenStore } from "@ablationkit/auth";
import { COLLECTOR_MAIN, SDK_ENV, type SpoolLayout, spoolLayout } from "@ablationkit/collector";
import { BundleError, pinnedCommit } from "@ablationkit/compute-targets";
import { JsonlLog, readJson, readJsonl, writeJsonAtomic } from "@ablationkit/core";
import {
  detachedAlive,
  killGroup,
  launchDetached,
  probeSupervisor,
  type SupervisorProbe,
  signalDetached,
} from "@ablationkit/process-supervisor";
import {
  type AttemptContainer,
  type AttemptRecord,
  type AttemptState,
  type CollectorManifest,
  type ConsoleRecord,
  ENV_NAME_RE,
  type EventEnvelope,
  type IngestState,
  type JobLimits,
  type JobRecord,
  type MetricsFormat,
  TERMINAL_ATTEMPT_STATES,
  type TokenRecord,
  type UploadedArtifact,
  validateAttemptRecord,
  validateCollectorManifest,
  validateConsoleRecord,
  validateEventEnvelope,
  validateIngestState,
  validateJobRecord,
} from "@ablationkit/protocol";
import {
  type LogModelInput,
  type LogTraceInput,
  type MlflowDatasetInput,
  MlflowError,
  type MlflowMetric,
  type MlflowParam,
  type MlflowTag,
  OutboxFullError,
  TAGS,
  TrackingInputError,
  type TrackingService,
  validateBatch,
  validateDatasets,
} from "@ablationkit/tracking-mlflow";
import type { RuntimePaths } from "../config.ts";
import type { EventHub } from "../events.ts";
import { HttpError } from "../http.ts";
import { safeArtifactPath } from "../listeners/tracking.ts";
import type { AuditLog } from "../state/audit.ts";
import { compact } from "../state/audit.ts";
import type { ProjectRegistryService } from "../state/registry.ts";
import type { RemoteService } from "./remote.ts";

/** The central install's project-facing Python packages, put on PYTHONPATH (criterion 1). */
export const SDK_PYTHONPATH = [
  resolve(import.meta.dir, "../../../../python/ablationkit-sdk/src"),
  resolve(import.meta.dir, "../../../../python/ablationkit-pytorch/src"),
];

export const MAX_EVENTS_PER_BATCH = 1000;
const WATCHDOG_MS = 15_000;
const MAX_DRAINS = 3;
const SECRET_ENV_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)/i;

function isTerminal(s: AttemptState): boolean {
  return TERMINAL_ATTEMPT_STATES.includes(s);
}

export interface SubmitInput {
  readonly project_id: string;
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly environment?: "uv" | "none";
  readonly env?: Readonly<Record<string, string>>;
  readonly limits?: JobLimits;
  readonly artifact_paths?: readonly string[];
  readonly metrics_file?: string;
  readonly metrics_format?: MetricsFormat;
  readonly input_paths?: readonly string[];
  readonly run_name?: string;
  /** What the run tests and why; each attempt's run starts with it as its summary. */
  readonly description?: string;
  readonly study_id?: string;
  readonly variant_id?: string;
  readonly task_id?: string;
  /** The agenda item it serves, canonical (ADR 0058). */
  readonly agenda_item?: string;
  /** Launched from an `MLproject` entrypoint (mlprojects.ts). */
  readonly mlproject?: JobRecord["mlproject"];
  /** Run on this remote compute target (ADR 0023) instead of this machine. */
  readonly target_id?: string;
  /** Paid targets: the submitter accepted the cost. */
  readonly accept_cost?: boolean;
  /** Remote jobs: staged directories carried in the bundle (internal callers only). */
  readonly bundle_inputs?: JobRecord["bundle_inputs"];
  readonly submitted_by: JobRecord["submitted_by"];
  /** Agent jobs: the target's weight when admitted under the compute limit (ADR 0037). */
  readonly compute_weight_hundredths?: number;
  /** Set by the backend broker for `compute.submit` (never by the extension itself). */
  readonly via_extension?: string;
  /** A contained agent session's job (ADR 0061): each local attempt runs in a job container. */
  readonly container?: JobRecord["container"];
}

export interface JobServiceOptions {
  readonly paths: RuntimePaths;
  readonly now: () => Date;
  readonly registry: ProjectRegistryService;
  readonly tokens: TokenStore;
  readonly tracking: TrackingService;
  readonly events: EventHub;
  readonly audit: AuditLog;
  readonly log: (line: string) => void;
  readonly settings: {
    readonly supervisor: "auto" | "systemd" | "direct";
    readonly spoolMaxBytes: number;
    readonly maxArtifactBytes: number;
    readonly deliverDeadlineSec: number;
  };
  /** The worker listener URL, known once it is bound. */
  readonly workerUrl: () => string;
  /** `uv` binary for `environment: "uv"`. */
  readonly uv?: string;
  /** Approved extension SDK source roots appended to the core Python SDKs for this project. */
  readonly sdkPythonPaths?: (projectId: string) => readonly string[];
  readonly watchdogMs?: number;
  /**
   * Turn a `trace.logged` payload into the trace to queue, with the project's capture policy
   * applied (ADR 0021). Returns undefined when capture is off; throws to reject the event.
   */
  readonly prepareTrace?: (
    projectId: string,
    payload: Record<string, unknown>,
    context: { attempt_id: string; job_id: string; remote?: boolean },
  ) => LogTraceInput | undefined | Promise<LogTraceInput | undefined>;
  /** Remote attempts (ADR 0023). */
  readonly remote?: () => RemoteService | undefined;
  /** Job containers for jobs a contained agent session submits (ADR 0061). */
  readonly containers?: () => JobContainers | undefined;
}

/** What the job runner asks of the agent containers service (ADR 0061). */
export interface JobContainers {
  contained(job: JobRecord): boolean;
  checkJob(job: JobRecord): void;
  containerizeJob(
    job: JobRecord,
    a: {
      readonly attemptId: string;
      readonly spool: string;
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    },
  ): { argv: string[]; container: AttemptContainer };
  attemptEnded(attemptId: string, container: string | undefined): void;
  attemptCancelled(container: string | undefined): void;
}

function newJobId(): string {
  return `j-${randomBytes(6).toString("hex")}`;
}

/** Map a collector's exit report to compute status (ADR 0003 for the systemd results). */
function terminalState(
  exit: { exit_code?: number; signal?: string; timed_out?: boolean; oom_killed?: boolean },
  cancelRequested: boolean,
): AttemptState {
  if (exit.oom_killed) return "oom_killed";
  if (exit.timed_out) return "timed_out";
  if (cancelRequested && (exit.signal !== undefined || exit.exit_code !== 0)) return "cancelled";
  if (exit.exit_code === 0) return "succeeded";
  return "failed";
}

/**
 * A worker-reported end time, kept within [started_at, now]: a remote clock can't make a job end
 * before it started (no negative durations) or in the future.
 */
function reportedEnd(reported: string | undefined, started: string | undefined, now: string) {
  const t = reported === undefined ? Number.NaN : Date.parse(reported);
  if (!Number.isFinite(t)) return undefined;
  const lo = Date.parse(started ?? "") || t;
  return new Date(Math.min(Date.parse(now), Math.max(lo, t))).toISOString();
}

function mlflowStatus(s: AttemptState): "FINISHED" | "FAILED" | "KILLED" {
  if (s === "succeeded") return "FINISHED";
  if (s === "cancelled") return "KILLED";
  return "FAILED";
}

interface AttemptPaths {
  readonly dir: string;
  readonly record: string;
  readonly ingest: string;
  readonly console: string;
}

export class JobService {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly ingestStates = new Map<string, IngestState>();
  private readonly ingestQueues = new Map<string, Promise<void>>();
  private readonly consoles = new Map<string, JsonlLog<ConsoleRecord>>();
  private readonly drains = new Map<string, number>();
  private probeResult: SupervisorProbe | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  readonly loadProblems: string[] = [];

  constructor(private readonly o: JobServiceOptions) {}

  // ------------------------------------------------------------------ storage

  private jobDir(projectId: string, jobId: string): string {
    return join(this.o.paths.stateDir, projectId, "jobs", jobId);
  }

  private attemptPaths(a: {
    project_id: string;
    job_id: string;
    attempt_id: string;
  }): AttemptPaths {
    const dir = join(this.jobDir(a.project_id, a.job_id), "attempts", a.attempt_id);
    return {
      dir,
      record: join(dir, "attempt.json"),
      ingest: join(dir, "ingest.json"),
      console: join(dir, "console"),
    };
  }

  spool(attemptId: string): SpoolLayout {
    return spoolLayout(join(this.o.paths.spoolDir, attemptId));
  }

  /** Scan `state/<project>/jobs/` into memory (small canonical JSON files, spec §6). */
  load(): void {
    const state = this.o.paths.stateDir;
    if (!existsSync(state)) return;
    for (const pid of readdirSync(state)) {
      const jobsDir = join(state, pid, "jobs");
      if (!existsSync(jobsDir)) continue;
      for (const jid of readdirSync(jobsDir)) {
        const dir = join(jobsDir, jid);
        try {
          const job = readJson(join(dir, "job.json"), validateJobRecord);
          this.jobs.set(job.job_id, job);
          for (const aid of job.attempts) {
            const p = this.attemptPaths({ project_id: pid, job_id: jid, attempt_id: aid });
            try {
              this.attempts.set(aid, readJson(p.record, validateAttemptRecord));
            } catch (e) {
              this.loadProblems.push(`${p.record}: ${(e as Error).message}`);
            }
          }
        } catch (e) {
          this.loadProblems.push(`${dir}: ${(e as Error).message}`);
        }
      }
    }
  }

  private saveJob(job: JobRecord): void {
    mkdirSync(this.jobDir(job.project_id, job.job_id), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.jobDir(job.project_id, job.job_id), "job.json"), job, {
      validate: validateJobRecord,
    });
    this.jobs.set(job.job_id, job);
  }

  private saveAttempt(a: AttemptRecord): void {
    const p = this.attemptPaths(a);
    mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(p.record, a, { validate: validateAttemptRecord });
    this.attempts.set(a.attempt_id, a);
  }

  private ingestState(a: AttemptRecord): IngestState {
    const cached = this.ingestStates.get(a.attempt_id);
    if (cached) return cached;
    let s: IngestState;
    try {
      s = readJson(this.attemptPaths(a).ingest, validateIngestState);
    } catch {
      s = {
        schema_version: 1,
        attempt_id: a.attempt_id,
        producers: {},
        accepted: 0,
        duplicates: 0,
        rejected: 0,
      };
    }
    this.ingestStates.set(a.attempt_id, s);
    return s;
  }

  private consoleLog(a: AttemptRecord): JsonlLog<ConsoleRecord> {
    let log = this.consoles.get(a.attempt_id);
    if (!log) {
      log = JsonlLog.open<ConsoleRecord>(this.attemptPaths(a).console, {
        name: "console",
        validate: validateConsoleRecord,
      });
      this.consoles.set(a.attempt_id, log);
    }
    return log;
  }

  private closeConsole(attemptId: string): void {
    this.consoles.get(attemptId)?.close();
    this.consoles.delete(attemptId);
  }

  // ------------------------------------------------------------------ reads

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  require(jobId: string): JobRecord {
    const j = this.jobs.get(jobId);
    if (!j) throw new HttpError(404, "job_not_found", `no job ${jobId}`);
    return j;
  }

  attempt(attemptId: string): AttemptRecord | undefined {
    return this.attempts.get(attemptId);
  }

  requireAttempt(jobId: string, attemptId: string): AttemptRecord {
    const a = this.attempts.get(attemptId);
    if (!a || a.job_id !== jobId)
      throw new HttpError(404, "attempt_not_found", `no attempt ${attemptId} of job ${jobId}`);
    return a;
  }

  list(projectId?: string): JobRecord[] {
    return [...this.jobs.values()]
      .filter((j) => projectId === undefined || j.project_id === projectId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  latestAttempt(job: JobRecord): AttemptRecord | undefined {
    const id = job.attempts.at(-1);
    return id ? this.attempts.get(id) : undefined;
  }

  /** Jobs of a project whose latest attempt has not finished (project removal refuses these). */
  unfinished(projectId: string): JobRecord[] {
    return this.list(projectId).filter((j) => {
      const a = this.latestAttempt(j);
      return a !== undefined && !isTerminal(a.state);
    });
  }

  /** Drop a removed project's jobs from memory; its files were moved aside (`project-removal.ts`). */
  forgetProject(projectId: string): void {
    for (const j of this.list(projectId)) {
      for (const aid of j.attempts) {
        this.closeConsole(aid);
        this.attempts.delete(aid);
        this.ingestStates.delete(aid);
        this.drains.delete(aid);
      }
      this.jobs.delete(j.job_id);
    }
  }

  /** Attempt with its tracking link: compute status and sync status are shown separately. */
  attemptView(a: AttemptRecord): Record<string, unknown> {
    const m = this.o.tracking.mappings.get(a.attempt_id);
    const sync = m ? this.o.tracking.sync(a.attempt_id) : undefined;
    const ingest = this.ingestStates.get(a.attempt_id);
    return {
      ...a,
      tracking: compact({
        ref: a.attempt_id,
        mlflow_run_id: m?.mlflow_run_id,
        experiment_id: m?.experiment_id,
        sync_state: sync?.state ?? m?.sync_state,
        pending_ops: sync?.pending_ops,
        failed_ops: sync?.failed_ops,
        last_error: sync?.last_error?.message ?? m?.last_error,
      }),
      ...(ingest
        ? {
            ingest: compact({
              accepted: ingest.accepted,
              duplicates: ingest.duplicates,
              rejected: ingest.rejected,
              last_rejection: ingest.last_rejection,
            }),
          }
        : {}),
    };
  }

  jobView(job: JobRecord, withAttempts = true): Record<string, unknown> {
    const latest = this.latestAttempt(job);
    return {
      ...job,
      latest_attempt: latest ? this.attemptView(latest) : undefined,
      ...(withAttempts
        ? {
            attempt_details: job.attempts.flatMap((id) => {
              const a = this.attempts.get(id);
              return a ? [this.attemptView(a)] : [];
            }),
          }
        : {}),
    };
  }

  async readConsole(
    a: AttemptRecord,
    opts: { after: number; limit: number; streams?: ReadonlySet<string> },
  ): Promise<{ lines: ConsoleRecord[]; next_after: number; done: boolean }> {
    const lines: ConsoleRecord[] = [];
    let last = opts.after;
    const dir = this.attemptPaths(a).console;
    if (existsSync(dir)) {
      for await (const r of readJsonl<ConsoleRecord>(dir, {
        name: "console",
        fromSeq: opts.after + 1,
      })) {
        if (r.seq <= opts.after) continue;
        last = r.seq;
        if (!opts.streams || opts.streams.has(r.stream)) lines.push(r);
        if (lines.length >= opts.limit) break;
      }
    }
    // Done: the exit was ingested, and the spool is ordered, so every earlier line is here.
    // (Artifact uploads may still be pending; they never block console output.)
    const done = isTerminal(a.state) && lines.length < opts.limit;
    return { lines, next_after: last, done };
  }

  // ------------------------------------------------------------------ submit

  /** The largest artifact a job (or an import) may upload. */
  get maxArtifactBytes(): number {
    return this.o.settings.maxArtifactBytes;
  }

  probe(): SupervisorProbe {
    if (!this.probeResult) {
      const s = this.o.settings.supervisor;
      this.probeResult =
        s === "direct"
          ? probeSupervisor({ ABLATIONKIT_SUPERVISOR: "direct" })
          : probeSupervisor({
              ...process.env,
              ABLATIONKIT_SUPERVISOR: s === "systemd" ? "systemd" : undefined,
            });
    }
    return this.probeResult;
  }

  submit(input: SubmitInput): { job: JobRecord; attempt: AttemptRecord } {
    const project = this.o.registry.require(input.project_id);
    if (input.command.length === 0 || input.command.some((c) => typeof c !== "string"))
      throw new HttpError(400, "invalid_request", "`command` must be a non-empty array of strings");
    const env = input.env ?? {};
    for (const [k, v] of Object.entries(env)) {
      if (!ENV_NAME_RE.test(k) || typeof v !== "string")
        throw new HttpError(400, "invalid_request", `invalid environment variable ${k}`);
      if (k.startsWith("ABLATIONKIT_"))
        throw new HttpError(400, "invalid_request", `${k}: ABLATIONKIT_* variables are reserved`);
      if (SECRET_ENV_RE.test(k))
        throw new HttpError(
          400,
          "secret_in_job_env",
          `${k} looks like a secret; job records are plain text (spec §10). Set it in the coordinator's environment instead`,
        );
    }
    if (input.cwd !== undefined) this.checkCwd(project.path, input.cwd);
    if (input.metrics_file !== undefined)
      this.checkInside(project.path, input.metrics_file, "metrics_file");
    for (const g of input.artifact_paths ?? [])
      if (g.startsWith("/") || g.split("/").includes(".."))
        throw new HttpError(
          400,
          "invalid_request",
          `artifact path ${g} must stay inside the checkout`,
        );
    for (const g of input.input_paths ?? [])
      if (g.startsWith("/") || g.split("/").includes(".."))
        throw new HttpError(
          400,
          "invalid_request",
          `input path ${g} must stay inside the checkout`,
        );
    if (input.input_paths?.length && input.target_id !== undefined)
      throw new HttpError(
        400,
        "invalid_request",
        "`input_paths` applies to jobs on this machine: a remote job runs only the committed source, so commit the files it needs",
      );
    if (input.target_id !== undefined) {
      if (input.target_id === "local")
        throw new HttpError(400, "invalid_request", "omit `target_id` to run on this machine");
      const remote = this.requireRemote();
      remote.check(input.target_id, {
        acceptCost: input.accept_cost === true,
        ...(input.limits?.runtime_max_sec ? { runtimeSec: input.limits.runtime_max_sec } : {}),
      });
      try {
        pinnedCommit(project.path);
      } catch (e) {
        if (e instanceof BundleError) throw new HttpError(422, e.code, e.message);
        throw e;
      }
    }
    const hasPyproject = existsSync(join(project.path, "pyproject.toml"));
    const environment = input.environment ?? (hasPyproject ? "uv" : "none");
    if (environment === "uv" && !hasPyproject)
      throw new HttpError(
        422,
        "no_project_environment",
        `${project.path} has no pyproject.toml; use environment "none" to run the command as given`,
      );
    const ts = this.o.now().toISOString();
    const job: JobRecord = {
      schema_version: 1,
      job_id: newJobId(),
      project_id: project.project_id,
      command: [...input.command],
      ...(input.cwd ? { cwd: input.cwd } : {}),
      environment,
      env: { ...env },
      limits: { ...(input.limits ?? {}) },
      artifact_paths: [...(input.artifact_paths ?? [])],
      ...(input.metrics_file ? { metrics_file: input.metrics_file } : {}),
      ...(input.metrics_format ? { metrics_format: input.metrics_format } : {}),
      ...(input.input_paths?.length ? { input_paths: [...input.input_paths] } : {}),
      ...(input.run_name ? { run_name: input.run_name } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.study_id ? { study_id: input.study_id } : {}),
      ...(input.variant_id ? { variant_id: input.variant_id } : {}),
      ...(input.task_id ? { task_id: input.task_id } : {}),
      ...(input.agenda_item ? { agenda_item: input.agenda_item } : {}),
      ...(input.mlproject ? { mlproject: input.mlproject } : {}),
      ...(input.target_id ? { target_id: input.target_id } : {}),
      ...(input.target_id && input.bundle_inputs?.length
        ? { bundle_inputs: [...input.bundle_inputs] }
        : {}),
      submitted_by: input.submitted_by,
      ...(input.compute_weight_hundredths !== undefined
        ? { compute_weight_hundredths: input.compute_weight_hundredths }
        : {}),
      ...(input.via_extension ? { via_extension: input.via_extension } : {}),
      ...(input.container ? { container: { ...input.container } } : {}),
      state: "starting",
      attempts: [],
      created_at: ts,
      updated_at: ts,
    };
    validateJobRecord(job);
    const attempt = this.launchAttempt(job);
    return { job: this.require(job.job_id), attempt };
  }

  retry(jobId: string, opts: { acceptCost?: boolean } = {}): AttemptRecord {
    const job = this.require(jobId);
    if (job.target_id)
      this.requireRemote().check(job.target_id, {
        acceptCost: opts.acceptCost === true,
        ...(job.limits.runtime_max_sec ? { runtimeSec: job.limits.runtime_max_sec } : {}),
      });
    const latest = this.latestAttempt(job);
    if (latest && !isTerminal(latest.state))
      throw new HttpError(
        409,
        "attempt_active",
        `attempt ${latest.attempt_id} is still ${latest.state}`,
      );
    this.o.registry.require(job.project_id);
    return this.launchAttempt(job);
  }

  cancel(jobId: string): AttemptRecord {
    const job = this.require(jobId);
    const a = this.latestAttempt(job);
    if (!a || isTerminal(a.state))
      throw new HttpError(409, "not_running", `job ${jobId} has no running attempt`);
    const updated: AttemptRecord = { ...a, cancel_requested_at: this.o.now().toISOString() };
    this.saveAttempt(updated);
    if (a.remote) {
      // The worker sees the request in its next heartbeat; provider-native cancel is best effort.
      void this.o.remote?.()?.cancel(updated);
      this.publishAttempt(updated);
      return updated;
    }
    // Ask the collector to stop the job; it records the exit and delivers it.
    const sent = signalDetached(this.collectorInfo(a), "SIGTERM");
    if (a.supervisor.container)
      this.o.containers?.()?.attemptCancelled(a.supervisor.container.name);
    if (!sent && a.pid) {
      // The collector is gone: stop the job's own unit or group directly.
      if (a.supervisor.unit && a.supervisor.mode === "systemd")
        signalDetached({ unit: a.supervisor.unit }, "SIGTERM");
      else killGroup(a.pid, "SIGTERM");
    }
    this.publishAttempt(updated);
    return updated;
  }

  private checkInside(root: string, rel: string, what: string): void {
    const abs = resolve(root, rel);
    if (rel.startsWith("/") || !abs.startsWith(root + sep))
      throw new HttpError(
        400,
        "invalid_request",
        `\`${what}\` must stay inside the project checkout`,
      );
  }

  private checkCwd(root: string, cwd: string): void {
    const abs = resolve(root, cwd);
    if (cwd.startsWith("/") || !(abs === root || abs.startsWith(root + sep)))
      throw new HttpError(400, "invalid_request", "`cwd` must stay inside the project checkout");
    if (!existsSync(abs) || !statSync(abs).isDirectory())
      throw new HttpError(400, "invalid_request", `no directory ${cwd} in the project checkout`);
  }

  /**
   * The job's environment. `host`: on top of the coordinator's own (minus `ABLATIONKIT_*`); a job
   * container (ADR 0061) gets only the job's variables and the SDK's.
   */
  private buildEnv(
    job: JobRecord,
    attemptId: string,
    spool: SpoolLayout,
    host = true,
  ): Record<string, string> {
    const env: Record<string, string> = {};
    if (host)
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("ABLATIONKIT_")) env[k] = v;
      }
    Object.assign(env, job.env);
    const py = [
      ...SDK_PYTHONPATH,
      ...(this.o.sdkPythonPaths?.(job.project_id) ?? []),
      ...(env["PYTHONPATH"] ? [env["PYTHONPATH"]] : []),
    ];
    env["PYTHONPATH"] = py.join(":");
    env["PYTHONUNBUFFERED"] = "1";
    env[SDK_ENV.eventsFile] = spool.sdkEvents;
    env[SDK_ENV.artifactDir] = spool.artifacts;
    env[SDK_ENV.projectId] = job.project_id;
    env[SDK_ENV.jobId] = job.job_id;
    env[SDK_ENV.attemptId] = attemptId;
    return env;
  }

  private launchAttempt(job: JobRecord): AttemptRecord {
    const project = this.o.registry.require(job.project_id);
    const number = job.attempts.length + 1;
    const attemptId = `${job.job_id}-a${number}`;
    const probe = this.probe();
    const ts = this.o.now().toISOString();
    // A contained session's job (ADR 0061): its job container is planned before anything starts,
    // so a missing runtime, image or GPU is a refusal, not a failed attempt.
    const containers = job.target_id ? undefined : this.o.containers?.();
    const inContainer = containers?.contained(job) === true;
    if (job.container && !job.target_id && !inContainer)
      throw new HttpError(
        503,
        "container_runtime_unavailable",
        "this job came from an agent container session and runs only in a job container, which this coordinator cannot start",
      );
    if (inContainer) containers?.checkJob(job);
    // Tracking first: a full outbox is backpressure, and nothing has started yet.
    try {
      this.o.tracking.startRun(
        compact({
          kind: "attempt" as const,
          project_id: job.project_id,
          ref: attemptId,
          job_id: job.job_id,
          attempt_id: attemptId,
          study_id: job.study_id,
          variant_id: job.variant_id,
          task_id: job.task_id,
          mlproject_entrypoint: job.mlproject?.entrypoint,
          run_name: job.run_name ?? `${job.job_id} #${number}`,
          summary: job.description,
        }),
      );
    } catch (e) {
      if (e instanceof OutboxFullError)
        throw new HttpError(
          503,
          "tracking_backpressure",
          "the tracking outbox is full; try again later",
        );
      throw e;
    }
    if (job.target_id) return this.launchRemote(job, attemptId, number, project.path, ts);
    const minted = this.o.tokens.mint("worker", {
      scope: { project_id: job.project_id, job_id: job.job_id, attempt_id: attemptId },
      label: `attempt ${attemptId}`,
    });
    const spool = this.spool(attemptId);
    mkdirSync(spool.root, { recursive: true, mode: 0o700 });
    writeFileSync(spool.token, `${minted.token}\n`, { mode: 0o600 });
    const uv = this.o.uv ?? process.env["ABLATIONKIT_UV"] ?? "uv";
    let argv =
      job.environment === "uv"
        ? [uv, "run", "--frozen", "--project", project.path, "--", ...job.command]
        : [...job.command];
    const cwd = job.cwd ? resolve(project.path, job.cwd) : project.path;
    let container: AttemptContainer | undefined;
    let containerError: string | undefined;
    if (inContainer && containers) {
      try {
        const planned = containers.containerizeJob(job, {
          attemptId,
          spool: spool.root,
          argv,
          cwd,
          env: this.buildEnv(job, attemptId, spool, false),
        });
        argv = planned.argv;
        container = planned.container;
      } catch (e) {
        containerError = `could not plan the job container: ${(e as Error).message}`.slice(0, 2000);
      }
    }
    const unit = `ak-job-${attemptId}`;
    const manifest: CollectorManifest = {
      schema_version: 1,
      project_id: job.project_id,
      job_id: job.job_id,
      attempt_id: attemptId,
      worker_url: this.o.workerUrl(),
      token_file: spool.token,
      project_path: project.path,
      argv,
      cwd,
      env: this.buildEnv(job, attemptId, spool),
      limits: job.limits,
      mode: probe.mode,
      unit,
      artifact_paths: job.artifact_paths,
      ...(job.metrics_file ? { metrics_file: resolve(project.path, job.metrics_file) } : {}),
      ...(job.metrics_format ? { metrics_format: job.metrics_format } : {}),
      ...(job.input_paths ? { input_paths: job.input_paths } : {}),
      spool_max_bytes: this.o.settings.spoolMaxBytes,
      deliver_deadline_sec: this.o.settings.deliverDeadlineSec,
    };
    writeJsonAtomic(spool.manifest, manifest, {
      validate: validateCollectorManifest,
      backup: false,
    });
    let attempt: AttemptRecord = {
      schema_version: 1,
      attempt_id: attemptId,
      job_id: job.job_id,
      project_id: job.project_id,
      number,
      state: "starting",
      created_at: ts,
      supervisor: compact({
        mode: probe.mode,
        enforcement: probe.enforcement,
        reason: probe.reason,
        unit: probe.mode === "systemd" ? `${unit}.scope` : undefined,
        container,
      }),
      collector: {},
      token_id: minted.record.token_id,
      artifacts: [],
    };
    this.saveJob({
      ...job,
      attempts: [...job.attempts, attemptId],
      state: "starting",
      updated_at: ts,
    });
    try {
      if (containerError) throw new Error(containerError);
      const info = this.launchCollector(attemptId, probe.mode);
      attempt = {
        ...attempt,
        supervisor: compact({ ...attempt.supervisor, collector_unit: info.unit }),
        collector: compact({ pid: info.pid }),
      };
      this.saveAttempt(attempt);
    } catch (e) {
      this.saveAttempt(attempt);
      attempt = this.finish(attempt, "failed", {
        error: `could not launch the collector: ${(e as Error).message}`.slice(0, 2000),
      });
    }
    this.o.audit.record({
      actor: compact({ kind: job.submitted_by.kind, id: job.submitted_by.id }),
      listener:
        job.submitted_by.kind === "agent"
          ? "agent"
          : job.submitted_by.kind === "human"
            ? "human"
            : "internal",
      action: number === 1 ? "job.submit" : "job.retry",
      outcome: attempt.state === "failed" ? "error" : "allowed",
      project_id: job.project_id,
      target: attemptId,
      details: { mode: probe.mode, enforcement: probe.enforcement },
    });
    this.publishAttempt(attempt);
    return attempt;
  }

  private requireRemote(): RemoteService {
    const r = this.o.remote?.();
    if (!r) throw new HttpError(501, "remote_unavailable", "remote compute is not configured");
    return r;
  }

  /** A remote attempt: bundle, credentials, then staging and submission in the background. */
  private launchRemote(
    job: JobRecord,
    attemptId: string,
    number: number,
    checkout: string,
    ts: string,
  ): AttemptRecord {
    const remote = this.requireRemote();
    this.saveJob({
      ...job,
      attempts: [...job.attempts, attemptId],
      state: "starting",
      updated_at: ts,
    });
    let attempt: AttemptRecord;
    try {
      const prep = remote.prepare(job, attemptId, checkout);
      attempt = {
        schema_version: 1,
        attempt_id: attemptId,
        job_id: job.job_id,
        project_id: job.project_id,
        number,
        state: "starting",
        created_at: ts,
        supervisor: { mode: "remote", enforcement: prep.enforcement, reason: prep.reason },
        collector: {},
        token_id: prep.tokenId,
        artifacts: [],
        remote: prep.remote,
      };
      this.saveAttempt(attempt);
    } catch (e) {
      attempt = {
        schema_version: 1,
        attempt_id: attemptId,
        job_id: job.job_id,
        project_id: job.project_id,
        number,
        state: "starting",
        created_at: ts,
        supervisor: { mode: "remote", enforcement: "advisory" },
        collector: {},
        token_id: "0000000000000000",
        artifacts: [],
      };
      this.saveAttempt(attempt);
      attempt = this.finish(attempt, "failed", {
        error: `could not prepare the remote attempt: ${(e as Error).message}`.slice(0, 2000),
      });
    }
    this.o.audit.record({
      actor: compact({ kind: job.submitted_by.kind, id: job.submitted_by.id }),
      listener:
        job.submitted_by.kind === "agent"
          ? "agent"
          : job.submitted_by.kind === "human"
            ? "human"
            : "internal",
      action: number === 1 ? "job.submit" : "job.retry",
      outcome: attempt.state === "failed" ? "error" : "allowed",
      project_id: job.project_id,
      target: attemptId,
      details: compact({ target_id: job.target_id, bundle_id: attempt.remote?.bundle_id }),
    });
    this.publishAttempt(attempt);
    if (attempt.state === "starting") remote.start(attemptId);
    return attempt;
  }

  private launchCollector(
    attemptId: string,
    mode: "systemd" | "direct",
  ): { pid?: number; unit?: string } {
    const spool = this.spool(attemptId);
    const env: Record<string, string> = {};
    for (const k of [
      "PATH",
      "HOME",
      "USER",
      "LANG",
      "TMPDIR",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
    ]) {
      const v = process.env[k];
      if (v) env[k] = v;
    }
    return launchDetached({
      unit: `ak-col-${attemptId}`,
      argv: [process.execPath, COLLECTOR_MAIN, "--spool", spool.root],
      cwd: spool.root,
      env,
      mode,
      logFile: spool.log,
    });
  }

  private collectorInfo(a: AttemptRecord): { pid?: number; unit?: string } {
    if (a.supervisor.collector_unit) return { unit: a.supervisor.collector_unit };
    return a.collector.pid ? { pid: a.collector.pid } : {};
  }

  private collectorAlive(a: AttemptRecord): boolean {
    const info = this.collectorInfo(a);
    return (info.pid !== undefined || info.unit !== undefined) && detachedAlive(info);
  }

  // ------------------------------------------------------------------ lifecycle

  private finish(
    a: AttemptRecord,
    state: AttemptState,
    extra: Partial<AttemptRecord> = {},
  ): AttemptRecord {
    const ts = this.o.now().toISOString();
    // The worker's exit time wins over "now": an offline archive is imported long after the job
    // ended.
    const ended = reportedEnd(extra.ended_at, a.started_at, ts) ?? a.ended_at ?? ts;
    const done: AttemptRecord = { ...a, ...extra, state, ended_at: ended };
    this.saveAttempt(done);
    const job = this.jobs.get(a.job_id);
    if (job) this.saveJob({ ...job, state, updated_at: ts });
    try {
      if (this.o.tracking.mappings.get(a.attempt_id))
        this.o.tracking.endRun(a.attempt_id, {
          status: mlflowStatus(state),
          end_time: Date.parse(ended),
        });
    } catch (e) {
      this.o.log(`could not queue the end of run ${a.attempt_id}: ${(e as Error).message}`);
    }
    // Worker tokens stay valid for the grace period so late uploads still land (spec §7.11).
    this.o.tokens.markJobTerminal(a.job_id, this.o.now());
    this.closeConsole(a.attempt_id);
    if (a.supervisor.container)
      this.o.containers?.()?.attemptEnded(a.attempt_id, a.supervisor.container.name);
    return done;
  }

  // ------------------------------------------------------------------ remote helpers

  attemptDir(a: { project_id: string; job_id: string; attempt_id: string }): string {
    return this.attemptPaths(a).dir;
  }

  /** Save a changed attempt record (remote status updates). */
  updateAttempt(a: AttemptRecord): void {
    this.saveAttempt(a);
  }

  /** End an attempt with `state` and publish it. */
  finishAttempt(attemptId: string, state: AttemptState, extra: Partial<AttemptRecord> = {}): void {
    const a = this.attempts.get(attemptId);
    if (!a) return;
    this.publishAttempt(this.finish(a, state, extra));
  }

  /** Highest worker spool seq applied for a remote attempt (-1: none). */
  spoolAcked(a: AttemptRecord): number {
    return this.ingestState(a).spool_acked_seq ?? -1;
  }

  remoteAttempts(): AttemptRecord[] {
    return [...this.attempts.values()].filter((a) => a.remote !== undefined);
  }

  private publishAttempt(a: AttemptRecord): void {
    this.o.events.publish(
      a.project_id,
      "job.attempt.state",
      compact({
        job_id: a.job_id,
        attempt_id: a.attempt_id,
        state: a.state,
        exit_code: a.exit_code,
        signal: a.signal,
        unit_result: a.unit_result,
        cancel_requested: a.cancel_requested_at ? true : undefined,
      }),
    );
  }

  // ------------------------------------------------------------------ ingest

  /**
   * Ingest one batch from a collector (at least once). Events at or below a producer's
   * high-water mark are duplicates. Invalid events are counted and skipped so one bad event
   * never blocks the spool. Throws 503 on tracking backpressure (nothing is applied then).
   */
  async ingest(
    token: TokenRecord,
    raw: unknown,
    opts: { spoolThrough?: number; workerId?: string | null } = {},
  ): Promise<{ accepted: number; duplicates: number; rejected: number }> {
    const { job_id: jobId, attempt_id: attemptId } = token.scope;
    const a = attemptId ? this.attempts.get(attemptId) : undefined;
    if (!a || a.job_id !== jobId) throw new HttpError(404, "attempt_not_found", "unknown attempt");
    if (a.remote) this.o.remote?.()?.guardWorker(a, opts.workerId);
    return this.ingestAttempt(a.attempt_id, raw, opts);
  }

  /** Ingest a batch for an attempt (live delivery or an imported spool). */
  async ingestAttempt(
    attemptId: string,
    raw: unknown,
    opts: { spoolThrough?: number } = {},
  ): Promise<{ accepted: number; duplicates: number; rejected: number }> {
    const previous = this.ingestQueues.get(attemptId) ?? Promise.resolve();
    const result = previous.then(() => this.ingestAttemptSerial(attemptId, raw, opts));
    // Store a fulfilled tail even when this request fails, so retries can proceed.
    const tail = result.then(
      () => {},
      () => {},
    );
    this.ingestQueues.set(attemptId, tail);
    try {
      return await result;
    } finally {
      if (this.ingestQueues.get(attemptId) === tail) this.ingestQueues.delete(attemptId);
    }
  }

  private async ingestAttemptSerial(
    attemptId: string,
    raw: unknown,
    opts: { spoolThrough?: number },
  ): Promise<{ accepted: number; duplicates: number; rejected: number }> {
    const a = this.attempts.get(attemptId);
    if (!a) throw new HttpError(404, "attempt_not_found", "unknown attempt");
    const list = (raw as { events?: unknown })?.events;
    if (!Array.isArray(list))
      throw new HttpError(400, "invalid_request", "`events` must be an array");
    if (list.length > MAX_EVENTS_PER_BATCH)
      throw new HttpError(
        413,
        "batch_too_large",
        `at most ${MAX_EVENTS_PER_BATCH} events per batch`,
      );

    const st = this.ingestState(a);
    const hwm = { ...st.producers };
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    let lastRejection: string | undefined;
    const reject = (why: string): void => {
      rejected++;
      lastRejection = why.slice(0, 2000);
    };
    const consoleLines: Omit<ConsoleRecord, "seq">[] = [];
    const metrics: MlflowMetric[] = [];
    const params: MlflowParam[] = [];
    const tags: MlflowTag[] = [];
    const paramValues = new Map<string, string>();
    const lifecycle: EventEnvelope[] = [];
    const datasets: MlflowDatasetInput[] = [];
    const models: LogModelInput[] = [];
    const traces: LogTraceInput[] = [];

    for (const item of list) {
      let ev: EventEnvelope;
      try {
        ev = validateEventEnvelope(item);
      } catch (e) {
        reject(`invalid envelope: ${(e as Error).message}`);
        continue;
      }
      if (
        ev.project_id !== a.project_id ||
        ev.ablationkit_job_id !== a.job_id ||
        ev.attempt_id !== a.attempt_id
      )
        throw new HttpError(403, "forbidden_scope", "events must belong to this token's attempt");
      const seen = hwm[ev.producer_id];
      if (seen !== undefined && ev.producer_seq <= seen) {
        duplicates++;
        continue;
      }
      hwm[ev.producer_id] = ev.producer_seq;
      try {
        await this.collect(ev, {
          consoleLines,
          metrics,
          params,
          tags,
          paramValues,
          lifecycle,
          datasets,
          models,
          traces,
          sourceCommit: a.snapshot?.source_commit,
          projectId: a.project_id,
          context: {
            attempt_id: a.attempt_id,
            job_id: a.job_id,
            ...(a.remote ? { remote: true } : {}),
          },
        });
        accepted++;
      } catch (e) {
        reject(`${ev.type}: ${(e as Error).message}`);
      }
    }

    // Effects: tracking (may refuse with backpressure before anything is written), console, lifecycle.
    if (metrics.length + params.length + tags.length > 0) {
      try {
        this.o.tracking.logBatch(a.attempt_id, { metrics, params, tags });
      } catch (e) {
        if (e instanceof OutboxFullError)
          throw new HttpError(503, "tracking_backpressure", "tracking outbox is full; retry later");
        if (e instanceof TrackingInputError) reject(`tracking: ${e.message}`);
        else throw e;
      }
    }
    // Dataset inputs and logged models follow the run's other writes through the outbox.
    try {
      if (datasets.length) this.o.tracking.logInputs(a.attempt_id, datasets);
      for (const m of models) this.o.tracking.logModel(a.attempt_id, m);
      for (const t of traces) this.o.tracking.logTrace(a.attempt_id, t);
    } catch (e) {
      if (e instanceof OutboxFullError)
        throw new HttpError(503, "tracking_backpressure", "tracking outbox is full; retry later");
      if (e instanceof TrackingInputError) reject(`tracking: ${e.message}`);
      else throw e;
    }
    if (consoleLines.length > 0) this.consoleLog(a).appendBatch(consoleLines);
    for (const ev of lifecycle) this.applyLifecycle(a.attempt_id, ev);
    // Late lines for a finished attempt reopen its journal; don't keep the handle.
    if (isTerminal((this.attempts.get(a.attempt_id) ?? a).state)) this.closeConsole(a.attempt_id);

    const next: IngestState = compact({
      schema_version: 1 as const,
      attempt_id: a.attempt_id,
      producers: hwm,
      accepted: st.accepted + accepted,
      duplicates: st.duplicates + duplicates,
      rejected: st.rejected + rejected,
      last_rejection: lastRejection ?? st.last_rejection,
      spool_acked_seq:
        opts.spoolThrough !== undefined && Number.isSafeInteger(opts.spoolThrough)
          ? Math.max(st.spool_acked_seq ?? -1, opts.spoolThrough)
          : st.spool_acked_seq,
    });
    writeJsonAtomic(this.attemptPaths(a).ingest, next, {
      validate: validateIngestState,
      backup: false,
    });
    this.ingestStates.set(a.attempt_id, next);
    return { accepted, duplicates, rejected };
  }

  private async collect(
    ev: EventEnvelope,
    acc: {
      consoleLines: Omit<ConsoleRecord, "seq">[];
      metrics: MlflowMetric[];
      params: MlflowParam[];
      tags: MlflowTag[];
      paramValues: Map<string, string>;
      lifecycle: EventEnvelope[];
      datasets: MlflowDatasetInput[];
      models: LogModelInput[];
      traces: LogTraceInput[];
      sourceCommit: string | undefined;
      projectId: string;
      context: { attempt_id: string; job_id: string; remote?: boolean };
    },
  ): Promise<void> {
    const p = ev.payload;
    const tsMs = Date.parse(ev.ts);
    switch (ev.type) {
      case "console.line": {
        const stream = p["stream"];
        if (stream !== "stdout" && stream !== "stderr" && stream !== "system")
          throw new Error("stream must be stdout, stderr or system");
        acc.consoleLines.push({
          schema_version: 1,
          ts: ev.ts,
          stream,
          text: String(p["text"] ?? "").slice(0, 65_536),
          event_id: ev.event_id,
        });
        return;
      }
      case "log.record": {
        acc.consoleLines.push(
          compact({
            schema_version: 1 as const,
            ts: ev.ts,
            stream: "log" as const,
            text: String(p["message"] ?? "").slice(0, 65_536),
            level: typeof p["level"] === "string" ? p["level"].slice(0, 32) : undefined,
            logger: typeof p["logger"] === "string" ? p["logger"].slice(0, 256) : undefined,
            event_id: ev.event_id,
          }),
        );
        return;
      }
      case "metric.batch": {
        const items = p["metrics"];
        if (!Array.isArray(items) || items.length === 0)
          throw new Error("metrics must be a non-empty array");
        // Fixed timestamps from the event keep replays idempotent in MLflow.
        const ms = items.map((m: Record<string, unknown>) => ({
          key: m["key"] as string,
          value: m["value"] as number,
          step: m["step"] === undefined ? 0 : (m["step"] as number),
          timestamp: m["timestamp"] === undefined ? tsMs : (m["timestamp"] as number),
        }));
        validateBatch({ metrics: ms });
        acc.metrics.push(...ms);
        return;
      }
      case "param.batch": {
        const obj = p["params"];
        if (typeof obj !== "object" || obj === null || Array.isArray(obj))
          throw new Error("params must be an object");
        const ps = Object.entries(obj).map(([key, value]) => ({
          key,
          value: typeof value === "string" ? value : JSON.stringify(value),
        }));
        validateBatch({ params: ps });
        for (const x of ps) {
          const prev = acc.paramValues.get(x.key);
          if (prev !== undefined && prev !== x.value)
            throw new Error(
              `param ${x.key} logged twice with different values (MLflow params are immutable)`,
            );
        }
        for (const x of ps) {
          if (!acc.paramValues.has(x.key)) {
            acc.paramValues.set(x.key, x.value);
            acc.params.push(x);
          }
        }
        return;
      }
      case "tag.batch": {
        const obj = p["tags"];
        if (typeof obj !== "object" || obj === null || Array.isArray(obj))
          throw new Error("tags must be an object");
        const ts = Object.entries(obj).map(([key, value]) => ({ key, value: String(value) }));
        validateBatch({ tags: ts });
        acc.tags.push(...ts);
        return;
      }
      case "artifact.logged":
        return; // bytes arrive through the artifact upload route
      case "dataset.input": {
        acc.datasets.push(datasetInputFromEvent(p, acc.sourceCommit));
        return;
      }
      case "model.logged": {
        const files = p["files"];
        if (!Array.isArray(files)) throw new Error("files must be an array");
        acc.models.push(
          compact({
            model_key: String(p["model_key"] ?? ""),
            name: String(p["name"] ?? ""),
            artifact_path: String(p["artifact_path"] ?? ""),
            files: files.map((f: Record<string, unknown>) => ({
              path: String(f?.["path"] ?? ""),
              size: Number(f?.["size"]),
            })),
            step: typeof p["step"] === "number" ? p["step"] : 0,
            model_type: typeof p["model_type"] === "string" ? p["model_type"] : undefined,
          }),
        );
        return;
      }
      case "trace.logged": {
        if (!this.o.prepareTrace) throw new Error("traces are not accepted by this coordinator");
        const t = await this.o.prepareTrace(acc.projectId, p, acc.context);
        if (t) acc.traces.push(t);
        return;
      }
      case "attempt.started":
      case "attempt.exited":
      case "collector.health":
      case "collector.drained":
      case "sdk.started":
      case "worker.status":
        acc.lifecycle.push(ev);
        return;
      default:
        throw new Error("unknown event type");
    }
  }

  private applyLifecycle(attemptId: string, ev: EventEnvelope): void {
    const a = this.attempts.get(attemptId);
    if (!a) return;
    const p = ev.payload;
    const num = (k: string): number | undefined =>
      typeof p[k] === "number" && Number.isSafeInteger(p[k]) ? (p[k] as number) : undefined;
    const str = (k: string, max = 2000): string | undefined =>
      typeof p[k] === "string" ? (p[k] as string).slice(0, max) : undefined;
    switch (ev.type) {
      case "attempt.started": {
        // A late import of an attempt marked lost (F29) records when it really started but stays
        // `unknown` until its exit arrives: a partial archive must not revive it as running.
        const late =
          a.state === "unknown" && a.remote?.marked_lost_at !== undefined && !a.started_at;
        if (a.state !== "starting" && !late) return;
        const pid = num("pid");
        const enforcement = p["enforcement"];
        const next: AttemptRecord = compact({
          ...a,
          state: late ? a.state : ("running" as const),
          started_at: ev.ts,
          pid: pid && pid > 0 ? pid : undefined,
          // A remote worker reports how limits are applied on its host (never claimed enforced here).
          supervisor:
            a.remote && (enforcement === "enforced" || enforcement === "advisory")
              ? (compact({
                  ...a.supervisor,
                  enforcement,
                  reason: str("reason") ?? a.supervisor.reason,
                  unit: str("unit", 256),
                }) as AttemptRecord["supervisor"])
              : a.supervisor,
          collector: compact({
            ...a.collector,
            pid: num("collector_pid") ?? a.collector.pid,
            last_seen_at: ev.ts,
          }),
          snapshot: compact({
            ...(a.snapshot ?? {}),
            hostname: str("hostname", 253) ?? "unknown",
            command: Array.isArray(p["command"])
              ? (p["command"] as unknown[]).map(String).slice(0, 1100)
              : [],
            cwd: str("cwd", 4096) ?? "",
            source_commit:
              typeof p["source_commit"] === "string" && /^[a-f0-9]{7,64}$/.test(p["source_commit"])
                ? p["source_commit"]
                : undefined,
            source_dirty: typeof p["source_dirty"] === "boolean" ? p["source_dirty"] : undefined,
            collector_version: str("collector_version", 100) ?? "unknown",
          }),
        });
        this.saveAttempt(next);
        if (late) return;
        const job = this.jobs.get(a.job_id);
        if (job) this.saveJob({ ...job, state: "running", updated_at: this.o.now().toISOString() });
        this.publishAttempt(next);
        return;
      }
      case "sdk.started": {
        const snap = a.snapshot ?? {
          hostname: "unknown",
          command: [],
          cwd: "",
          collector_version: "unknown",
        };
        this.saveAttempt({
          ...a,
          snapshot: compact({
            ...snap,
            python: str("python", 200),
            sdk_version: str("sdk_version", 100),
          }),
        });
        return;
      }
      case "collector.health": {
        this.saveAttempt({
          ...a,
          collector: compact({
            pid: num("pid") ?? a.collector.pid,
            last_seen_at: ev.ts,
            spool_bytes: num("spool_bytes"),
            pending_events: num("pending_events"),
            pending_artifacts: num("pending_artifacts"),
            dropped_events: num("dropped_events"),
            last_error: str("last_error"),
          }),
        });
        return;
      }
      case "attempt.exited": {
        if (isTerminal(a.state) && a.state !== "unknown") return;
        if (p["lost"] === true) {
          // A remote worker restarted and the job's process was gone: never rerun (spec §5.3).
          const why = str("error") ?? "the job's process was lost without an exit record";
          if (a.remote) {
            this.saveAttempt({ ...a, remote: { ...a.remote, reconcile_required: why } });
          }
          const lost = this.finish(this.attempts.get(a.attempt_id) as AttemptRecord, "unknown", {
            error: why,
            ended_at: ev.ts,
          });
          this.publishAttempt(lost);
          return;
        }
        const exit = {
          ...(num("exit_code") === undefined ? {} : { exit_code: num("exit_code") as number }),
          ...(str("signal", 32) ? { signal: str("signal", 32) as string } : {}),
          timed_out: p["timed_out"] === true,
          oom_killed: p["oom_killed"] === true,
        };
        const state = terminalState(
          exit,
          a.cancel_requested_at !== undefined || p["cancelled"] === true,
        );
        // A late import of an attempt marked lost: its real outcome replaces the "marked lost" note.
        const { error: _lostNote, ...unlost } = a;
        const done = this.finish(
          a.state === "unknown" && a.remote?.marked_lost_at ? unlost : a,
          state,
          compact({
            exit_code: exit.exit_code,
            signal: exit.signal,
            unit_result: str("unit_result", 64),
            error: str("error"),
            ended_at: ev.ts,
          }),
        );
        this.publishAttempt(done);
        return;
      }
      case "collector.drained": {
        if (isTerminal(a.state)) return;
        const done = this.finish(a, "unknown", {
          error: "the collector stopped without reporting how the job ended; nothing was rerun",
        });
        this.publishAttempt(done);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ artifacts

  /** Stream one artifact upload to a staging file, verify it, and hand it to MLflow. */
  async uploadArtifact(
    token: TokenRecord,
    req: Request,
    path: string,
  ): Promise<Record<string, unknown>> {
    const a = token.scope.attempt_id ? this.attempts.get(token.scope.attempt_id) : undefined;
    if (!a || a.job_id !== token.scope.job_id)
      throw new HttpError(404, "attempt_not_found", "unknown attempt");
    const expected = req.headers.get("x-ablationkit-sha256") ?? "";
    if (!/^[a-f0-9]{64}$/.test(expected))
      throw new HttpError(400, "invalid_request", "x-ablationkit-sha256 must be a hex SHA-256");
    const declared = Number(req.headers.get("content-length") ?? "NaN");
    const max = this.o.settings.maxArtifactBytes;
    if (Number.isFinite(declared) && declared > max)
      throw new HttpError(413, "artifact_too_large", `artifacts are limited to ${max} bytes`);
    const m = this.o.tracking.mappings.get(a.attempt_id);
    if (!m?.mlflow_run_id)
      throw new HttpError(503, "tracking_pending", "the attempt's MLflow run is not created yet", {
        retry: true,
      });
    const dir = this.attemptPaths(a).dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `upload-${randomBytes(6).toString("hex")}.part`);
    try {
      const hash = createHash("sha256");
      const sink = Bun.file(tmp).writer();
      let size = 0;
      if (req.body) {
        for await (const chunk of req.body) {
          size += chunk.byteLength;
          if (size > max) {
            await sink.end();
            throw new HttpError(413, "artifact_too_large", `artifacts are limited to ${max} bytes`);
          }
          hash.update(chunk);
          sink.write(chunk);
        }
      }
      await sink.end();
      const sha256 = hash.digest("hex");
      if (sha256 !== expected)
        throw new HttpError(422, "checksum_mismatch", `received ${sha256}, expected ${expected}`);
      return await this.storeArtifact(a, path, tmp, size, sha256);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** Hand a verified file to MLflow as one of the attempt's artifacts and record it. */
  async storeArtifact(
    a: AttemptRecord,
    path: string,
    file: string,
    size: number,
    sha256: string,
  ): Promise<UploadedArtifact> {
    // Every caller (local upload, remote upload, store receipt, spool import) checks these; the
    // sink checks them again so a new caller cannot skip them.
    safeArtifactPath(path, true);
    const max = this.o.settings.maxArtifactBytes;
    if (size > max)
      throw new HttpError(413, "artifact_too_large", `artifacts are limited to ${max} bytes`);
    const m = this.o.tracking.mappings.get(a.attempt_id);
    if (!m?.mlflow_run_id)
      throw new HttpError(503, "tracking_pending", "the attempt's MLflow run is not created yet", {
        retry: true,
      });
    try {
      const run = await this.o.tracking.client.getRun(m.mlflow_run_id);
      await this.o.tracking.client.uploadArtifact(run.info, path, Bun.file(file));
    } catch (e) {
      if (e instanceof MlflowError && e.kind !== "rejected")
        throw new HttpError(503, "tracking_unavailable", e.message, { retry: true });
      if (e instanceof MlflowError) throw new HttpError(422, "artifact_rejected", e.message);
      throw e;
    }
    const cur = this.attempts.get(a.attempt_id) as AttemptRecord;
    const entry = { path, size, sha256, uploaded_at: this.o.now().toISOString() };
    this.saveAttempt({
      ...cur,
      artifacts: [...cur.artifacts.filter((x) => x.path !== path), entry].slice(-10_000),
    });
    this.o.events.publish(a.project_id, "job.artifact.uploaded", {
      job_id: a.job_id,
      attempt_id: a.attempt_id,
      path,
      size,
    });
    return entry;
  }

  // ------------------------------------------------------------------ reconciliation

  /**
   * Find attempts whose collector is gone without a reported exit. With a spool, relaunch a
   * drain-only collector to deliver what is left; without one, the status is `unknown`. Never
   * reruns the job (spec §5.7).
   */
  reconcile(): void {
    for (const a of this.attempts.values()) {
      if (isTerminal(a.state) || a.remote) continue; // remote attempts: RemoteService
      if (this.collectorAlive(a)) continue;
      const spool = this.spool(a.attempt_id);
      const tries = this.drains.get(a.attempt_id) ?? 0;
      if (!existsSync(spool.manifest) || tries >= MAX_DRAINS) {
        const done = this.finish(a, "unknown", {
          error: existsSync(spool.manifest)
            ? "the collector kept stopping before it delivered the spool; see the spool on disk"
            : "the collector and its spool are gone; the job's outcome is unknown",
        });
        this.publishAttempt(done);
        continue;
      }
      this.drains.set(a.attempt_id, tries + 1);
      try {
        const manifest = readJson(spool.manifest, validateCollectorManifest);
        writeJsonAtomic(
          spool.manifest,
          { ...manifest, worker_url: this.o.workerUrl(), drain_only: true },
          { validate: validateCollectorManifest, backup: false },
        );
        const info = this.launchCollector(a.attempt_id, a.supervisor.mode as "systemd" | "direct");
        this.saveAttempt({
          ...a,
          supervisor: compact({ ...a.supervisor, collector_unit: info.unit }),
          collector: compact({ ...a.collector, pid: info.pid }),
        });
        this.o.log(`relaunched a drain collector for ${a.attempt_id}`);
      } catch (e) {
        this.o.log(`could not relaunch the collector for ${a.attempt_id}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Coordinator (re)start: point live collectors' manifests at the current worker URL (ports can
   * change), then reconcile, and keep checking periodically.
   */
  start(): void {
    for (const a of this.attempts.values()) {
      if (isTerminal(a.state) || a.remote) continue;
      const spool = this.spool(a.attempt_id);
      try {
        const manifest = readJson(spool.manifest, validateCollectorManifest);
        if (manifest.worker_url !== this.o.workerUrl())
          writeJsonAtomic(
            spool.manifest,
            { ...manifest, worker_url: this.o.workerUrl() },
            {
              validate: validateCollectorManifest,
              backup: false,
            },
          );
      } catch {
        // reconcile() handles a missing spool
      }
    }
    this.reconcile();
    this.watchdog = setInterval(() => {
      try {
        this.reconcile();
      } catch (e) {
        this.o.log(`job reconcile failed: ${(e as Error).message}`);
      }
    }, this.o.watchdogMs ?? WATCHDOG_MS);
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    for (const id of [...this.consoles.keys()]) this.closeConsole(id);
  }
}

/**
 * One SDK `dataset.input` event as an MLflow dataset input. The role goes in
 * `mlflow.data.context` (MLflow's own convention); split, version, the full fingerprint and the
 * attempt's source commit are AblationKit tags on the input.
 */
function datasetInputFromEvent(
  p: Record<string, unknown>,
  sourceCommit: string | undefined,
): MlflowDatasetInput {
  const str = (k: string): string | undefined =>
    typeof p[k] === "string" ? (p[k] as string) : undefined;
  const name = str("name");
  const digest = str("digest");
  const source = str("source");
  if (!name || !digest || !source) throw new Error("dataset.input needs name, digest and source");
  const sourceType = str("source_type") ?? "local";
  const tags: MlflowTag[] = [{ key: "mlflow.data.context", value: str("context") ?? "training" }];
  for (const [k, tag] of [
    ["split", TAGS.datasetSplit],
    ["version", TAGS.datasetVersion],
    ["fingerprint", TAGS.datasetFingerprint],
  ] as const) {
    const v = str(k);
    if (v) tags.push({ key: tag, value: v.slice(0, 500) });
  }
  if (sourceCommit) tags.push({ key: TAGS.sourceCommit, value: sourceCommit });
  return validateDatasets([
    {
      tags,
      dataset: compact({
        name,
        digest,
        source_type: sourceType,
        // MLflow's local and http sources are JSON objects with a `uri`.
        source: source.startsWith("{") ? source : JSON.stringify({ uri: source }),
        schema: str("schema"),
        profile: str("profile"),
      }),
    },
  ])[0] as MlflowDatasetInput;
}
