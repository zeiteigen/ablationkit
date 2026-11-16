/**
 * Remote attempts (spec §2.1 remote worker mode, §5.3, §5.7, §10; ADR 0023).
 *
 * Submission pins the checkout's commit, builds a self-sufficient bundle, mints a launch token
 * (handshake only, for the job's horizon) and a short-lived upload token, stages the bundle and
 * the credentials on the target, and submits. Once the provider confirms, the provider's own
 * supervisor owns the job; this service only watches:
 *
 * - the worker's handshake (heartbeat): connectivity, the spool cursor (so a reconnecting worker
 *   replays only what was not applied), cancel requests, token refresh, duplicate-execution guard;
 * - provider status, polled; a provider that ended the job while results are missing gets a drain
 *   (deliver the leftover spool), never a resubmission;
 * - compute status and sync status separately (`awaiting_sync`, `syncing`, `synced`, `sync_failed`).
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { TokenStore } from "@ablationkit/auth";
import {
  BUNDLE_SDK_SRCS,
  BundleError,
  buildBundle,
  pinnedCommit,
  type TargetAdapter,
  TargetError,
} from "@ablationkit/compute-targets";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type AttemptRecord,
  type EventEnvelope,
  type JobRecord,
  type RemoteAttemptInfo,
  type ResumableUpload,
  type TokenRecord,
  validateResumableUpload,
  validateWorkerHandshake,
  type WorkerCredentials,
  type WorkerHandshake,
  type WorkerHandshakeReply,
} from "@ablationkit/protocol";
import { isLoopbackHost, type ResolvedSettings, type RuntimePaths } from "../config.ts";
import type { EventHub } from "../events.ts";
import { HttpError } from "../http.ts";
import { safeArtifactPath } from "../listeners/tracking.ts";
import type { AuditLog } from "../state/audit.ts";
import { compact } from "../state/audit.ts";
import { sha256File } from "../state/backup.ts";
import type { JobService } from "./jobs.ts";
import type { TargetService } from "./targets.ts";

const DAY_MS = 86_400_000;
const MAX_DRAINS = 3;
const MAX_CHUNK = 16 * 1024 * 1024;

export interface RemoteServiceOptions {
  readonly paths: RuntimePaths;
  readonly now: () => Date;
  readonly jobs: JobService;
  readonly targets: TargetService;
  readonly tokens: TokenStore;
  readonly events: EventHub;
  readonly audit: AuditLog;
  readonly log: (line: string) => void;
  readonly settings: ResolvedSettings["remote"];
  readonly spoolMaxBytes: number;
  readonly deliverDeadlineSec: number;
  readonly maxArtifactBytes: number;
  /** Approved extension Python packages to stage alongside the core SDK packages. */
  readonly sdkSources?: (projectId: string) => readonly string[];
  /** The bound worker listener, used when it binds a non-loopback address and nothing is set. */
  readonly boundWorkerUrl: () => string;
  /** Watchdog interval (tests). Default 5 s. */
  readonly tickMs?: number;
}

/** What JobService needs to create a remote attempt record. */
export interface PreparedRemote {
  readonly remote: RemoteAttemptInfo;
  readonly tokenId: string;
  readonly enforcement: "enforced" | "advisory";
  readonly reason: string;
}

/** A provider failure in a human action: a clear HTTP error instead of a 500. */
function asHttp(e: unknown): never {
  if (e instanceof TargetError) {
    const status =
      e.code === "not_supported" || e.code === "cannot_drain"
        ? 409
        : e.code === "credentials_missing"
          ? 422
          : 502;
    throw new HttpError(status, e.code, e.message);
  }
  throw e;
}

/** Paths under `root` that are not plain files or directories (symlinks, devices, FIFOs). */
function specialEntries(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.isFile()) found.push(relative(root, p));
    }
  };
  walk(root);
  return found;
}

interface StagedUpload {
  readonly file: string;
  readonly dest: string;
  readonly sha256: string;
  readonly size: number;
  readonly store_slot?: number;
}

/** A staged upload record from an imported spool, or undefined if it is malformed or unsafe. */
function stagedUpload(path: string): StagedUpload | undefined {
  let u: Partial<StagedUpload>;
  try {
    u = JSON.parse(readFileSync(path, "utf8")) as Partial<StagedUpload>;
    safeArtifactPath(typeof u.dest === "string" ? u.dest : "..", true);
  } catch {
    return undefined;
  }
  if (
    typeof u.file !== "string" ||
    typeof u.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(u.sha256) ||
    !Number.isSafeInteger(u.size) ||
    (u.size as number) < 0
  )
    return undefined;
  return u as StagedUpload;
}

export class RemoteService {
  private readonly pending = new Map<
    string,
    { tgz: string; credentials: string; workerUrl: string; sha256: string }
  >();
  private readonly released = new Set<string>();
  private readonly polledAt = new Map<string, number>();
  private readonly drainedAt = new Map<string, number>();
  private readonly busy = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly o: RemoteServiceOptions) {}

  private iso(): string {
    return this.o.now().toISOString();
  }

  workerUrlFor(targetId: string): string | undefined {
    const t = this.o.targets.get(targetId);
    if (t?.worker_url) return t.worker_url;
    if (this.o.settings.workerUrl) return this.o.settings.workerUrl;
    const bound = this.o.boundWorkerUrl();
    return bound && !isLoopbackHost(new URL(bound).hostname) ? bound : undefined;
  }

  /**
   * Cost estimate for `minutes` of wall time on a target, from its rate card (spec §10: estimate
   * before submit). Provider billing lags and can differ; this is always labelled an estimate.
   */
  estimate(targetId: string, minutes: number): { cents?: number; basis: string } {
    const t = this.o.targets.require(targetId);
    if (!t.paid) return { cents: 0, basis: `${t.kind} target: no dollar rate` };
    const rate = t.runpod?.cents_per_hour;
    if (rate === undefined)
      return { basis: `${targetId} has no rate card (runpod.cents_per_hour); the cost is unknown` };
    const m = Math.max(0, minutes);
    return {
      cents: Math.ceil((rate * m) / 60),
      basis: `${rate} cents/hour × ${m} minutes from the target's rate card (an estimate, not a bill)`,
    };
  }

  /** Validate a submission to `targetId` before anything is recorded. */
  check(targetId: string, opts: { acceptCost?: boolean; runtimeSec?: number }): void {
    const t = this.o.targets.require(targetId);
    const adapter = this.o.targets.adapter(t);
    if (!adapter.capabilities.submit && !adapter.capabilities.exports)
      throw new HttpError(
        422,
        "target_cannot_submit",
        `${t.kind} targets do not run jobs unattended`,
      );
    if (t.paid && !opts.runtimeSec)
      throw new HttpError(
        422,
        "time_limit_required",
        `${targetId} is paid compute: set a time limit (\`limits.runtime_max_sec\`) so the cost is bounded`,
      );
    if (t.paid && !opts.acceptCost) {
      const est = this.estimate(targetId, Math.ceil((opts.runtimeSec ?? 0) / 60));
      throw new HttpError(
        409,
        "cost_acceptance_required",
        `${targetId} is paid compute (${est.cents !== undefined ? `up to about ${est.cents} cents: ` : ""}${est.basis}); submit again with \`accept_cost: true\` (cloud cost is approval-required, spec §10)`,
        { estimate: est },
      );
    }
    // An offline export (a Colab notebook without credentials) never calls back.
    const offlineExport = adapter.capabilities.exports && t.colab?.live !== true;
    if (!offlineExport && !this.workerUrlFor(targetId))
      throw new HttpError(
        422,
        "no_worker_url",
        "remote workers need a URL to reach this coordinator: set `remote.worker_url` in settings.json (for example http://<tailnet-name>:7422) or the target's `worker_url`",
      );
  }

  /**
   * Pin, bundle and mint credentials for one attempt (synchronous: nothing has left this machine
   * yet). Staging and submission happen in `start`.
   */
  prepare(job: JobRecord, attemptId: string, checkout: string): PreparedRemote {
    const target = this.o.targets.require(job.target_id as string);
    const workerUrl = this.workerUrlFor(target.target_id) ?? this.o.boundWorkerUrl();
    let commit: string;
    try {
      commit = pinnedCommit(checkout);
    } catch (e) {
      if (e instanceof BundleError) throw new HttpError(422, e.code, e.message);
      throw e;
    }
    const bundleId = `b-${randomBytes(6).toString("hex")}`;
    const dir = join(this.o.paths.bundlesDir, attemptId);
    let built: ReturnType<typeof buildBundle>;
    try {
      built = buildBundle({
        dir,
        repo: checkout,
        commit,
        sdkSrcs: [...BUNDLE_SDK_SRCS, ...(this.o.sdkSources?.(job.project_id) ?? [])],
        spec: compact({
          bundle_id: bundleId,
          project_id: job.project_id,
          job_id: job.job_id,
          attempt_id: attemptId,
          target_id: target.target_id,
          target_kind: target.kind,
          created_at: this.iso(),
          worker_url: workerUrl,
          argv: job.command,
          environment: job.environment,
          cwd: job.cwd ?? ".",
          env: job.env,
          limits: job.limits,
          artifact_paths: job.artifact_paths,
          metrics_file: job.metrics_file,
          metrics_format: job.metrics_format,
          heartbeat_sec: this.o.settings.heartbeatSec,
          max_backoff_sec: this.o.settings.maxBackoffSec,
          spool_max_bytes: this.o.spoolMaxBytes,
          min_free_disk_bytes: this.o.settings.minFreeDiskBytes,
          deliver_deadline_sec: this.o.deliverDeadlineSec,
        }) as never,
        ...(job.bundle_inputs ? { inputs: job.bundle_inputs } : {}),
      });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      if (e instanceof BundleError) throw new HttpError(422, e.code, e.message);
      throw e;
    }
    const scope = { project_id: job.project_id, job_id: job.job_id, attempt_id: attemptId };
    const launch = this.o.tokens.mint("worker", {
      scope,
      purpose: "launch",
      ttlMs: this.o.settings.launchTokenDays * DAY_MS,
      label: `launch ${attemptId}`,
    });
    const upload = this.o.tokens.mint("worker", {
      scope,
      ttlMs: this.o.settings.uploadTokenTtlSec * 1000,
      label: `upload ${attemptId}`,
    });
    const ntfy = target.ntfy;
    const ntfyToken = ntfy?.token_env ? process.env[ntfy.token_env] : undefined;
    const store = this.storeSlots(
      { project_id: job.project_id, attempt_id: attemptId },
      this.o.settings.artifactStore?.slots ?? 0,
      launch.record.expires_at as string,
    );
    const creds: WorkerCredentials = {
      schema_version: 1,
      launch_token: launch.token,
      launch_expires_at: launch.record.expires_at as string,
      upload_token: upload.token,
      upload_expires_at: upload.record.expires_at as string,
      ...(ntfy ? { ntfy: compact({ url: ntfy.url, token: ntfyToken }) } : {}),
      ...(store ? { artifact_store: store } : {}),
    };
    this.pending.set(attemptId, {
      tgz: built.tgz,
      credentials: `${JSON.stringify(creds)}\n`,
      workerUrl,
      sha256: built.sha256,
    });
    const label =
      target.kind === "slurm"
        ? "SLURM enforces --time; memory and CPU depend on the cluster's cgroup configuration (reported by the worker when the job starts)"
        : "the worker reports the enforcement on its host when the job starts";
    return {
      tokenId: upload.record.token_id,
      enforcement: "advisory",
      reason: label,
      remote: {
        target_id: target.target_id,
        target_kind: target.kind,
        bundle_id: bundleId,
        bundle_sha256: built.sha256,
        source_commit: commit,
        staging: "bundling",
        connectivity: "pending",
        sync: "awaiting_sync",
        spool_acked_seq: -1,
        launch_token_id: launch.record.token_id,
        launch_expires_at: launch.record.expires_at as string,
        ...(store ? { store_slots: store.slots.length } : {}),
      },
    };
  }

  // ------------------------------------------------------------------ artifact store (decision 24)

  private storeWarned = false;

  /** The S3 client for `remote.artifact_store`, or undefined (not configured, keys unset). */
  private storeClient(): Bun.S3Client | undefined {
    const s = this.o.settings.artifactStore;
    if (!s) return undefined;
    const accessKeyId = process.env[s.accessKeyIdEnv];
    const secretAccessKey = process.env[s.secretAccessKeyEnv];
    if (!accessKeyId || !secretAccessKey) {
      if (!this.storeWarned)
        this.o.log(
          `remote.artifact_store is configured but ${s.accessKeyIdEnv}/${s.secretAccessKeyEnv} are not set; workers upload through the coordinator`,
        );
      this.storeWarned = true;
      return undefined;
    }
    return new Bun.S3Client({
      accessKeyId,
      secretAccessKey,
      endpoint: s.endpoint,
      bucket: s.bucket,
      region: s.region,
      virtualHostedStyle: s.virtualHostedStyle,
    });
  }

  /**
   * The store's configuration and a reachability probe for the System page: a HEAD of a key that
   * never exists (a 404 answer proves the endpoint, bucket and signing work). No secrets returned.
   */
  async storeHealth(): Promise<Record<string, unknown>> {
    const s = this.o.settings.artifactStore;
    if (!s) return { configured: false };
    const base = {
      configured: true,
      endpoint: s.endpoint,
      bucket: s.bucket,
      region: s.region,
      prefix: s.prefix,
      min_bytes: s.minBytes,
      slots: s.slots,
      key_env: [s.accessKeyIdEnv, s.secretAccessKeyEnv],
      keys_set: Boolean(process.env[s.accessKeyIdEnv] && process.env[s.secretAccessKeyEnv]),
    };
    const client = this.storeClient();
    if (!client) return { ...base, reachable: false, error: "access keys are not set" };
    try {
      await client.exists(`${s.prefix}.health-probe`);
      return { ...base, reachable: true };
    } catch (e) {
      return { ...base, reachable: false, error: String((e as Error).message).slice(0, 500) };
    }
  }

  /** Slot `n` of an attempt: the worker cannot name any other key. */
  storeKey(a: { project_id: string; attempt_id: string }, slot: number): string {
    const prefix = this.o.settings.artifactStore?.prefix ?? "ablationkit/";
    return `${prefix}${a.project_id}/${a.attempt_id}/s${String(slot).padStart(2, "0")}`;
  }

  /**
   * Presigned PUT URLs for a worker's credentials. SigV4 caps them at 7 days: past that, the
   * worker falls back to the coordinator's resumable uploads.
   */
  private storeSlots(
    a: { project_id: string; attempt_id: string },
    count: number,
    launchExpiresAt: string,
  ): WorkerCredentials["artifact_store"] {
    const s = this.o.settings.artifactStore;
    const client = count > 0 ? this.storeClient() : undefined;
    if (!s || !client) return undefined;
    const now = this.o.now().getTime();
    const expiresIn = Math.max(
      60,
      Math.min(7 * 86_400, Math.floor((Date.parse(launchExpiresAt) - now) / 1000)),
    );
    const expires_at = new Date(now + expiresIn * 1000).toISOString();
    return {
      min_bytes: s.minBytes,
      slots: Array.from({ length: count }, (_, slot) => ({
        slot,
        url: client.presign(this.storeKey(a, slot), { method: "PUT", expiresIn }),
        expires_at,
      })),
    };
  }

  /**
   * A worker's receipt for an artifact it put in the store: pull, verify, store through MLflow,
   * delete the object. Retryable failures are 503 (the object is kept); a wrong object is deleted.
   */
  private async storeReceipt(
    a: AttemptRecord,
    path: string,
    size: number,
    sha: string,
    rawSlot: unknown,
  ): Promise<Record<string, unknown>> {
    const slot = rawSlot as number;
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= (a.remote?.store_slots ?? 0))
      throw new HttpError(
        400,
        "invalid_request",
        "`store_slot` is not a slot issued to this attempt",
      );
    const client = this.storeClient();
    if (!client)
      throw new HttpError(
        503,
        "artifact_store_unavailable",
        "the artifact store is not configured on the coordinator, or its key variables are unset; the object stays in the store",
      );
    const obj = client.file(this.storeKey(a, slot));
    const drop = () => obj.delete().catch(() => undefined);
    if (a.artifacts.some((x) => x.path === path && x.sha256 === sha)) {
      await drop();
      return { done: true };
    }
    let found: number | undefined;
    try {
      found = (await obj.exists()) ? (await obj.stat()).size : undefined;
    } catch (e) {
      throw new HttpError(
        503,
        "artifact_store_unavailable",
        `artifact store: ${(e as Error).message}`,
      );
    }
    if (found === undefined)
      throw new HttpError(404, "store_object_missing", `slot ${slot} holds no object`);
    if (found !== size || found > this.o.maxArtifactBytes) {
      await drop();
      throw found > this.o.maxArtifactBytes
        ? new HttpError(
            413,
            "artifact_too_large",
            `artifacts are limited to ${this.o.maxArtifactBytes} bytes`,
          )
        : new HttpError(
            422,
            "checksum_mismatch",
            `the stored object has ${found} bytes, not ${size}`,
          );
    }
    const dir = this.uploadsDir(a);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const part = join(dir, `store-s${slot}.part`);
    try {
      try {
        await Bun.write(part, obj);
      } catch (e) {
        throw new HttpError(
          503,
          "artifact_store_unavailable",
          `artifact store: ${(e as Error).message}`,
        );
      }
      const got = await sha256File(part);
      if (got !== sha) {
        await drop();
        throw new HttpError(422, "checksum_mismatch", `received ${got}, expected ${sha}`);
      }
      let entry: Record<string, unknown>;
      try {
        entry = await this.o.jobs.storeArtifact(a, path, part, size, sha);
      } catch (e) {
        if (e instanceof HttpError && e.code === "tracking_pending")
          throw new HttpError(503, "tracking_pending", e.message);
        throw e;
      }
      await drop();
      this.o.audit.record({
        actor: { kind: "system" },
        listener: "internal",
        action: "job.artifacts.store_receipt",
        outcome: "allowed",
        project_id: a.project_id,
        target: a.attempt_id,
        details: { path, size, slot },
      });
      return entry;
    } finally {
      rmSync(part, { force: true });
    }
  }

  /** Delete what is left of a synced attempt's slots (objects of refused or abandoned uploads). */
  private async cleanStore(a: AttemptRecord): Promise<void> {
    const client = this.storeClient();
    const n = a.remote?.store_slots ?? 0;
    if (!client || !n) return;
    try {
      for (let slot = 0; slot < n; slot++) await client.delete(this.storeKey(a, slot));
      this.patch(a.attempt_id, { store_cleaned_at: this.iso() });
    } catch (e) {
      this.o.log(`artifact store cleanup for ${a.attempt_id} failed: ${(e as Error).message}`);
    }
  }

  private adapterOf(a: AttemptRecord): TargetAdapter {
    const r = a.remote as RemoteAttemptInfo;
    return this.o.targets.adapter(this.o.targets.require(r.target_id));
  }

  private patch(
    attemptId: string,
    p: { [K in keyof RemoteAttemptInfo]?: RemoteAttemptInfo[K] | undefined },
  ): AttemptRecord | undefined {
    const a = this.o.jobs.attempt(attemptId);
    if (!a?.remote) return undefined;
    const next: AttemptRecord = {
      ...a,
      remote: compact({ ...a.remote, ...p }) as RemoteAttemptInfo,
    };
    this.o.jobs.updateAttempt(next);
    const before = a.remote;
    const r = next.remote as RemoteAttemptInfo;
    if (
      before.connectivity !== r.connectivity ||
      before.sync !== r.sync ||
      before.staging !== r.staging ||
      before.provider_state !== r.provider_state ||
      before.reconcile_required !== r.reconcile_required ||
      before.overdue_at !== r.overdue_at ||
      before.marked_lost_at !== r.marked_lost_at
    )
      this.o.events.publish(
        a.project_id,
        "job.attempt.remote",
        compact({
          job_id: a.job_id,
          attempt_id: a.attempt_id,
          target_id: r.target_id,
          staging: r.staging,
          connectivity: r.connectivity,
          sync: r.sync,
          provider_state: r.provider_state,
          reconcile_required: r.reconcile_required,
        }),
      );
    return next;
  }

  /** Stage and submit in the background. */
  start(attemptId: string): void {
    void this.stageAndSubmit(attemptId).catch((e) =>
      this.o.log(`remote submission of ${attemptId} failed: ${(e as Error).message}`),
    );
  }

  private async stageAndSubmit(attemptId: string): Promise<void> {
    const staged = this.pending.get(attemptId);
    let a = this.o.jobs.attempt(attemptId);
    if (!staged || !a?.remote) return;
    this.pending.delete(attemptId);
    const adapter = this.adapterOf(a);
    const input = {
      attemptId,
      jobId: a.job_id,
      workerUrl: staged.workerUrl,
      bundleSha256: staged.sha256,
      tgz: staged.tgz,
      credentials: staged.credentials,
      limits: this.o.jobs.require(a.job_id).limits,
    };
    this.patch(attemptId, { staging: "staging" });
    try {
      await adapter.stage(input);
    } catch (e) {
      // Nothing ran: the attempt failed before it started.
      const msg = `staging on ${a.remote.target_id} failed: ${(e as Error).message}`.slice(0, 2000);
      this.patch(attemptId, { staging: "failed", staging_error: msg, sync: "synced" });
      this.o.jobs.finishAttempt(attemptId, "failed", { error: msg });
      return;
    }
    a = this.o.jobs.attempt(attemptId) as AttemptRecord;
    const targetId = (a.remote as RemoteAttemptInfo).target_id;
    if (a.cancel_requested_at) {
      this.patch(attemptId, {
        staging: "failed",
        staging_error: "cancelled before submission",
        sync: "synced",
      });
      this.o.jobs.finishAttempt(attemptId, "cancelled", { error: "cancelled before submission" });
      return;
    }
    try {
      const { provider_job_id } = await adapter.submit(input);
      const submittedAt = this.iso();
      const back = adapter.capabilities.exports
        ? this.expectedBackBy(submittedAt, input.limits.runtime_max_sec)
        : undefined;
      this.patch(attemptId, {
        staging: adapter.capabilities.exports ? "exported" : "submitted",
        submitted_at: submittedAt,
        provider_job_id,
        ...(back ? { expected_back_by: back } : {}),
      });
      this.o.audit.record({
        actor: { kind: "system" },
        listener: "internal",
        action: "job.remote.submit",
        outcome: "allowed",
        project_id: a.project_id,
        target: attemptId,
        details: { target_id: targetId, provider_job_id },
      });
    } catch (e) {
      // The provider may have started it anyway (a timeout after the fact): never assume either way.
      const msg = `submission to ${targetId} did not confirm: ${(e as Error).message}`.slice(
        0,
        1500,
      );
      this.patch(attemptId, {
        staging: "failed",
        staging_error: msg,
        reconcile_required: `${msg}. The job may or may not be running on the target; check it there before retrying.`,
      });
      this.o.jobs.finishAttempt(attemptId, "unknown", { error: msg });
    } finally {
      // A pulling worker (a Runpod pod) downloads the bundle after submission; it is removed at
      // first contact or once the attempt is terminal.
      if (!adapter.capabilities.pulls_bundle) rmSync(staged.tgz, { force: true });
    }
  }

  /**
   * When an exported attempt should be back (F29): the export time plus the job's time limit
   * plus `remote.export_slack_min`. Nothing hears from an offline notebook, so this is the only
   * signal that one was lost; without a time limit there is none.
   */
  private expectedBackBy(
    exportedAt: string,
    runtimeMaxSec: number | undefined,
  ): string | undefined {
    if (!runtimeMaxSec) return undefined;
    const ms =
      Date.parse(exportedAt) + runtimeMaxSec * 1000 + this.o.settings.exportSlackMin * 60_000;
    return new Date(ms).toISOString();
  }

  /** The exported notebook of a Colab attempt. */
  notebookFile(a: AttemptRecord): string {
    const p = join(this.o.paths.bundlesDir, a.attempt_id, "notebook.ipynb");
    if (a.remote?.staging !== "exported" || !existsSync(p))
      throw new HttpError(404, "notebook_not_found", "this attempt has no exported notebook");
    return p;
  }

  /** The staged bundle a pulling worker downloads with its launch token (ADR 0023). */
  bundleFile(token: TokenRecord): string {
    const a = this.requireRemote(token);
    const tgz = join(this.o.paths.bundlesDir, a.attempt_id, "bundle.tgz");
    if (!this.adapterOf(a).capabilities.pulls_bundle || !existsSync(tgz))
      throw new HttpError(404, "bundle_not_found", "no staged bundle for this attempt");
    this.o.audit.record({
      actor: { kind: "worker", id: token.token_id },
      listener: "worker",
      action: "job.remote.bundle",
      outcome: "allowed",
      project_id: a.project_id,
      target: a.attempt_id,
    });
    return tgz;
  }

  // ------------------------------------------------------------------ worker API

  private requireRemote(token: TokenRecord): AttemptRecord {
    const a = token.scope.attempt_id ? this.o.jobs.attempt(token.scope.attempt_id) : undefined;
    if (!a || a.job_id !== token.scope.job_id)
      throw new HttpError(404, "attempt_not_found", "unknown attempt");
    if (!a.remote) throw new HttpError(409, "not_remote", "this attempt is not a remote attempt");
    return a;
  }

  /** Refuse a second worker for the same attempt (ambiguous or duplicated execution). */
  guardWorker(a: AttemptRecord, workerId: string | null | undefined, host?: string): void {
    const r = a.remote;
    if (!r?.worker_id || !workerId || workerId === r.worker_id) return;
    const why = `a second worker (${workerId}${host ? ` on ${host}` : ""}) reported attempt ${a.attempt_id}, which ${r.worker_id}${r.worker_host ? ` on ${r.worker_host}` : ""} already runs; it was refused and nothing was rerun`;
    if (r.reconcile_required !== why) {
      this.patch(a.attempt_id, { reconcile_required: why });
      this.o.audit.record({
        actor: { kind: "worker" },
        listener: "worker",
        action: "job.remote.duplicate",
        outcome: "denied",
        project_id: a.project_id,
        target: a.attempt_id,
        reason: why,
      });
    }
    throw new HttpError(409, "duplicate_execution", why);
  }

  handshake(token: TokenRecord, raw: unknown): WorkerHandshakeReply {
    let hs: WorkerHandshake;
    try {
      hs = validateWorkerHandshake(raw);
    } catch (e) {
      throw new HttpError(400, "invalid_request", (e as Error).message);
    }
    const a = this.requireRemote(token);
    const r = a.remote as RemoteAttemptInfo;
    if (hs.bundle_id !== r.bundle_id)
      throw new HttpError(
        409,
        "duplicate_execution",
        `bundle ${hs.bundle_id} is not this attempt's bundle ${r.bundle_id}`,
      );
    this.guardWorker(a, hs.worker_id, hs.hostname);
    const ts = this.iso();
    const wasDisconnected = r.connectivity === "disconnected";
    if (!r.first_contact_at)
      rmSync(join(this.o.paths.bundlesDir, a.attempt_id, "bundle.tgz"), { force: true });
    const pending = (hs.spool.pending_events ?? 0) + (hs.spool.pending_artifacts ?? 0);
    const done = hs.phase === "exited" || hs.phase === "lost";
    this.patch(
      a.attempt_id,
      compact({
        worker_id: hs.worker_id,
        worker_host: hs.hostname,
        provider_job_id: r.provider_job_id ?? hs.provider_job_id,
        first_contact_at: r.first_contact_at ?? ts,
        last_contact_at: ts,
        connectivity: "connected" as const,
        sync:
          hs.drained && done
            ? ("synced" as const)
            : pending > 0
              ? ("syncing" as const)
              : ("synced" as const),
        sync_error: undefined,
        worker_spool: hs.spool,
      }),
    );
    if (wasDisconnected)
      this.o.events.publish(a.project_id, "job.worker.reconnected", {
        job_id: a.job_id,
        attempt_id: a.attempt_id,
        target_id: r.target_id,
      });
    let upload: { token: string; expires_at: string } | undefined;
    if (hs.refresh || token.purpose === "launch") {
      const minted = this.o.tokens.mint("worker", {
        scope: { project_id: a.project_id, job_id: a.job_id, attempt_id: a.attempt_id },
        ttlMs: this.o.settings.uploadTokenTtlSec * 1000,
        label: `upload ${a.attempt_id} (refreshed)`,
      });
      this.o.tokens.revokeUploadTokens(a.attempt_id, minted.record.token_id);
      upload = { token: minted.token, expires_at: minted.record.expires_at as string };
      this.o.audit.record({
        actor: { kind: "worker", id: token.token_id },
        listener: "worker",
        action: "job.remote.refresh",
        outcome: "allowed",
        project_id: a.project_id,
        target: a.attempt_id,
      });
    }
    const cur = this.o.jobs.attempt(a.attempt_id) as AttemptRecord;
    return {
      schema_version: 1,
      spool_acked_seq: this.o.jobs.spoolAcked(cur),
      cancel_requested: cur.cancel_requested_at !== undefined,
      heartbeat_sec: this.o.settings.heartbeatSec,
      ...(upload ? { upload_token: upload.token, upload_expires_at: upload.expires_at } : {}),
      artifacts: cur.artifacts.map((x) => ({ path: x.path, sha256: x.sha256 })),
    };
  }

  private uploadsDir(a: AttemptRecord): string {
    return join(this.o.jobs.attemptDir(a), "uploads");
  }

  private loadUpload(a: AttemptRecord, uploadId: string): ResumableUpload {
    if (!/^u-[a-f0-9]{16}$/.test(uploadId))
      throw new HttpError(404, "upload_not_found", "unknown upload");
    const p = join(this.uploadsDir(a), `${uploadId}.json`);
    if (!existsSync(p)) throw new HttpError(404, "upload_not_found", "unknown upload");
    return readJson(p, validateResumableUpload);
  }

  async uploadStart(
    token: TokenRecord,
    path: string,
    raw: Record<string, unknown>,
    workerId?: string | null,
  ): Promise<Record<string, unknown>> {
    const a = this.requireRemote(token);
    this.guardWorker(a, workerId);
    const size = raw["size"];
    const sha = raw["sha256"];
    if (
      !Number.isSafeInteger(size) ||
      (size as number) < 0 ||
      typeof sha !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha)
    )
      throw new HttpError(400, "invalid_request", "`size` and a hex `sha256` are required");
    if ((size as number) > this.o.maxArtifactBytes)
      throw new HttpError(
        413,
        "artifact_too_large",
        `artifacts are limited to ${this.o.maxArtifactBytes} bytes`,
      );
    if (raw["store_slot"] !== undefined)
      return this.storeReceipt(a, path, size as number, sha, raw["store_slot"]);
    if (a.artifacts.some((x) => x.path === path && x.sha256 === sha)) return { done: true };
    const dir = this.uploadsDir(a);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The same file again (a retried start after a lost response) resumes the same upload.
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const u = readJson(join(dir, f), validateResumableUpload);
      if (u.path === path && u.sha256 === sha && u.size === size)
        return { upload_id: u.upload_id, received: u.received };
    }
    const ts = this.iso();
    const u: ResumableUpload = {
      schema_version: 1,
      upload_id: `u-${randomBytes(8).toString("hex")}`,
      attempt_id: a.attempt_id,
      path,
      size: size as number,
      sha256: sha,
      received: 0,
      created_at: ts,
      updated_at: ts,
    };
    writeJsonAtomic(join(dir, `${u.upload_id}.json`), u, {
      validate: validateResumableUpload,
      backup: false,
    });
    rmSync(join(dir, `${u.upload_id}.part`), { force: true });
    return { upload_id: u.upload_id, received: 0 };
  }

  async uploadChunk(
    token: TokenRecord,
    uploadId: string,
    req: Request,
  ): Promise<Record<string, unknown>> {
    const a = this.requireRemote(token);
    this.guardWorker(a, req.headers.get("x-ablationkit-worker-id"));
    const u = this.loadUpload(a, uploadId);
    const offset = Number(req.headers.get("x-ablationkit-offset") ?? "NaN");
    if (offset !== u.received) {
      await req.body?.cancel().catch(() => undefined);
      throw new HttpError(409, "offset_mismatch", `expected offset ${u.received}`, {
        received: u.received,
      });
    }
    const part = join(this.uploadsDir(a), `${uploadId}.part`);
    // Bytes past `received` belong to an interrupted chunk that was never acknowledged.
    const fd = openSync(part, existsSync(part) ? "r+" : "w", 0o600);
    let received = u.received;
    try {
      ftruncateSync(fd, received);
      let wrote = 0;
      if (req.body)
        for await (const chunk of req.body) {
          wrote += chunk.byteLength;
          if (wrote > MAX_CHUNK || received + chunk.byteLength > u.size)
            throw new HttpError(
              413,
              "chunk_too_large",
              "the chunk exceeds the declared size or 16 MiB",
            );
          writeSync(fd, chunk, 0, chunk.byteLength, received);
          received += chunk.byteLength;
        }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    writeJsonAtomic(
      join(this.uploadsDir(a), `${uploadId}.json`),
      { ...u, received, updated_at: this.iso() },
      { validate: validateResumableUpload, backup: false },
    );
    return { upload_id: uploadId, received };
  }

  async uploadComplete(
    token: TokenRecord,
    uploadId: string,
    workerId?: string | null,
  ): Promise<Record<string, unknown>> {
    const a = this.requireRemote(token);
    this.guardWorker(a, workerId);
    const u = this.loadUpload(a, uploadId);
    if (u.received !== u.size)
      throw new HttpError(409, "upload_incomplete", `received ${u.received} of ${u.size} bytes`, {
        received: u.received,
      });
    const part = join(this.uploadsDir(a), `${uploadId}.part`);
    // Streamed: an upload may be as large as the artifact limit (GBs).
    const sha = await sha256File(part);
    if (sha !== u.sha256) {
      rmSync(part, { force: true });
      rmSync(join(this.uploadsDir(a), `${uploadId}.json`), { force: true });
      throw new HttpError(422, "checksum_mismatch", `received ${sha}, expected ${u.sha256}`);
    }
    const entry = await this.o.jobs.storeArtifact(a, u.path, part, u.size, u.sha256);
    rmSync(part, { force: true });
    rmSync(join(this.uploadsDir(a), `${uploadId}.json`), { force: true });
    return entry;
  }

  // ------------------------------------------------------------------ human actions

  async cancel(a: AttemptRecord): Promise<void> {
    const r = a.remote;
    if (r?.staging === "exported") {
      // Nothing runs that AblationKit controls; a later import still lands (and is deduplicated).
      this.patch(a.attempt_id, { sync: "synced" });
      this.o.jobs.finishAttempt(a.attempt_id, "cancelled", {
        error: "cancelled before the exported notebook reported back",
      });
      return;
    }
    if (r?.staging !== "submitted" || !r.provider_job_id) return;
    try {
      await this.adapterOf(a).cancel(a.attempt_id, r.provider_job_id);
    } catch (e) {
      // The heartbeat still carries the request; say that provider-native cancel did not work.
      this.o.log(`provider cancel of ${a.attempt_id} failed: ${(e as Error).message}`);
      this.patch(a.attempt_id, {
        sync_error: `provider cancel failed: ${(e as Error).message}`.slice(0, 2000),
      });
    }
  }

  async drain(a: AttemptRecord, by: string): Promise<void> {
    if (!a.remote) throw new HttpError(409, "not_remote", "this attempt is not a remote attempt");
    await this.adapterOf(a).drain(a.attempt_id, a.remote.provider_job_id).catch(asHttp);
    this.drainedAt.set(a.attempt_id, Date.now());
    this.patch(a.attempt_id, { drains: (a.remote.drains ?? 0) + 1 });
    this.o.audit.record({
      actor: compact({
        kind: by === "system" ? ("system" as const) : ("human" as const),
        id: by === "system" ? undefined : by,
      }),
      listener: by === "system" ? "internal" : "human",
      action: "job.remote.drain",
      outcome: "allowed",
      project_id: a.project_id,
      target: a.attempt_id,
    });
  }

  /** New credentials for a worker whose launch token expired (a disconnection beyond its horizon). */
  async reauthorize(a: AttemptRecord, by: string): Promise<RemoteAttemptInfo> {
    const r = a.remote;
    if (!r) throw new HttpError(409, "not_remote", "this attempt is not a remote attempt");
    const target = this.o.targets.require(r.target_id);
    const scope = { project_id: a.project_id, job_id: a.job_id, attempt_id: a.attempt_id };
    this.o.tokens.revokeWhere(
      (t) => t.kind === "worker" && t.scope.attempt_id === a.attempt_id,
      "reauthorized",
    );
    const launch = this.o.tokens.mint("worker", {
      scope,
      purpose: "launch",
      ttlMs: this.o.settings.launchTokenDays * DAY_MS,
      label: `launch ${a.attempt_id} (reauthorized)`,
    });
    const upload = this.o.tokens.mint("worker", {
      scope,
      ttlMs: this.o.settings.uploadTokenTtlSec * 1000,
    });
    const ntfyToken = target.ntfy?.token_env ? process.env[target.ntfy.token_env] : undefined;
    // Fresh presigned URLs for the same slots: the worker remembers which ones it used.
    const store = this.storeSlots(a, r.store_slots ?? 0, launch.record.expires_at as string);
    const reauth: WorkerCredentials = {
      schema_version: 1,
      launch_token: launch.token,
      launch_expires_at: launch.record.expires_at as string,
      upload_token: upload.token,
      upload_expires_at: upload.record.expires_at as string,
      ...(target.ntfy ? { ntfy: compact({ url: target.ntfy.url, token: ntfyToken }) } : {}),
      ...(store ? { artifact_store: store } : {}),
    };
    await this.adapterOf(a)
      .reauthorize(a.attempt_id, `${JSON.stringify(reauth)}\n`)
      .catch(asHttp);
    this.o.audit.record({
      actor: { kind: "human", id: by },
      listener: "human",
      action: "job.remote.reauthorize",
      outcome: "allowed",
      project_id: a.project_id,
      target: a.attempt_id,
    });
    return this.patch(a.attempt_id, {
      launch_token_id: launch.record.token_id,
      launch_expires_at: launch.record.expires_at as string,
      sync_error: undefined,
    })?.remote as RemoteAttemptInfo;
  }

  /**
   * A human looked at an ambiguous attempt and accepts its recorded outcome. Never reruns it.
   * `lost`: an exported attempt that will not report back (its runtime is gone, F29) ends
   * `unknown`, which releases its parallel slot. A late import of its
   * archive still lands and settles it.
   */
  resolve(
    a: AttemptRecord,
    by: string,
    note: string,
    opts: { lost?: boolean } = {},
  ): RemoteAttemptInfo {
    if (opts.lost) return this.markLost(a, by, note);
    if (!a.remote?.reconcile_required)
      throw new HttpError(409, "nothing_to_resolve", "this attempt does not need reconciliation");
    this.o.audit.record({
      actor: { kind: "human", id: by },
      listener: "human",
      action: "job.remote.resolve",
      outcome: "allowed",
      project_id: a.project_id,
      target: a.attempt_id,
      reason: note.slice(0, 500),
      details: { was: a.remote.reconcile_required },
    });
    return this.patch(a.attempt_id, { reconcile_required: undefined })?.remote as RemoteAttemptInfo;
  }

  private markLost(a: AttemptRecord, by: string, note: string): RemoteAttemptInfo {
    if (a.remote?.staging !== "exported")
      throw new HttpError(
        409,
        "not_exported",
        "only an exported (notebook) attempt can be marked lost; a submitted one is watched through its provider (drain, resolve)",
      );
    if (!["starting", "running"].includes(a.state))
      throw new HttpError(409, "invalid_transition", `the attempt already ended (${a.state})`);
    const at = this.iso();
    this.o.audit.record({
      actor: { kind: "human", id: by },
      listener: "human",
      action: "job.remote.mark_lost",
      outcome: "allowed",
      project_id: a.project_id,
      target: a.attempt_id,
      reason: note.slice(0, 500),
      details: compact({
        expected_back_by: a.remote.expected_back_by,
        overdue_at: a.remote.overdue_at,
      }),
    });
    this.patch(a.attempt_id, { marked_lost_at: at, reconcile_required: undefined });
    this.o.jobs.finishAttempt(a.attempt_id, "unknown", {
      error: `marked lost by a researcher: ${note}`.slice(0, 2000),
    });
    return this.o.jobs.attempt(a.attempt_id)?.remote as RemoteAttemptInfo;
  }

  /**
   * Import a worker directory archived on an isolated runtime (Colab, an air-gapped node, or a
   * worker whose credentials expired): its spool is ingested through the same dedupe as live
   * delivery, and staged artifacts are verified and stored. Idempotent.
   */
  async importSpool(
    a: AttemptRecord,
    archive: string,
    by: string,
  ): Promise<Record<string, unknown>> {
    if (!a.remote) throw new HttpError(409, "not_remote", "this attempt is not a remote attempt");
    const listing = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
    if (listing.exitCode !== 0)
      throw new HttpError(400, "invalid_archive", "not a gzip tar archive");
    for (const name of listing.stdout.toString().split("\n").filter(Boolean))
      if (name.startsWith("/") || name.split("/").includes(".."))
        throw new HttpError(400, "invalid_archive", `unsafe path in archive: ${name}`);
    const tmp = mkdtempSync(join(this.o.paths.bundlesDir, ".import-"));
    try {
      const x = Bun.spawnSync(
        ["tar", "-xzf", archive, "-C", tmp, "--no-same-owner", "--no-same-permissions"],
        {
          stderr: "pipe",
        },
      );
      if (x.exitCode !== 0) throw new HttpError(400, "invalid_archive", x.stderr.toString().trim());
      // The archive comes from a machine AblationKit does not control: a link would make the
      // reads below (journal, staged artifacts) read the coordinator's own files.
      const special = specialEntries(tmp);
      if (special.length)
        throw new HttpError(
          400,
          "invalid_archive",
          `links and special files are refused in an import: ${special.slice(0, 5).join(", ")}`,
        );
      const spool = this.findSpool(tmp);
      if (!spool) throw new HttpError(400, "invalid_archive", "no spool/journal in the archive");
      let state: { worker_id?: unknown } = {};
      if (existsSync(join(spool, "..", "state.json")))
        try {
          state = JSON.parse(readFileSync(join(spool, "..", "state.json"), "utf8"));
        } catch {
          throw new HttpError(400, "invalid_archive", "state.json is not valid JSON");
        }
      const segs = readdirSync(join(spool, "journal"))
        .filter((f) => /^spool-[0-9]{4,}\.jsonl$/.test(f))
        .sort();
      // Another attempt's archive: say whose it is (before the worker check, which would flag
      // this attempt as run twice).
      const owner = archiveOwner(spool, segs);
      if (owner && (owner.attempt_id !== a.attempt_id || owner.job_id !== a.job_id))
        throw new HttpError(
          409,
          "wrong_attempt",
          `this archive is attempt ${owner.attempt_id} (job ${owner.job_id}), not ${a.attempt_id} (job ${a.job_id}); import it with \`ablationkit remote import ${owner.job_id} ARCHIVE\``,
        );
      this.guardWorker(a, typeof state.worker_id === "string" ? state.worker_id : undefined);
      let accepted = 0;
      let duplicates = 0;
      let rejected = 0;
      let batch: { seq: number; ev: EventEnvelope }[] = [];
      const flush = async (): Promise<void> => {
        if (!batch.length) return;
        const res = await this.o.jobs.ingestAttempt(
          a.attempt_id,
          { events: batch.map((b) => b.ev) },
          {
            spoolThrough: (batch.at(-1) as { seq: number }).seq,
          },
        );
        accepted += res.accepted;
        duplicates += res.duplicates;
        rejected += res.rejected;
        batch = [];
      };
      for (const f of segs) {
        for (const line of readFileSync(join(spool, "journal", f), "utf8").split("\n")) {
          if (!line.trim()) continue;
          let rec: { seq: number } & EventEnvelope;
          try {
            rec = JSON.parse(line);
          } catch {
            rejected++;
            continue;
          }
          const { seq, ...ev } = rec;
          batch.push({ seq, ev: ev as EventEnvelope });
          if (batch.length >= 1000) await flush();
        }
      }
      await flush();
      let artifacts = 0;
      let pendingArtifacts = 0;
      const uploads = join(spool, "uploads");
      if (existsSync(uploads))
        for (const f of readdirSync(uploads).filter((x) => x.endsWith(".json"))) {
          const u = stagedUpload(join(uploads, f));
          if (!u) {
            rejected++;
            continue;
          }
          if (u.store_slot !== undefined) {
            // Already in the artifact store: the spool only holds the receipt.
            let stored = false;
            for (let i = 0; i < 40 && !stored; i++) {
              try {
                await this.storeReceipt(
                  this.o.jobs.attempt(a.attempt_id) as AttemptRecord,
                  u.dest,
                  u.size,
                  u.sha256,
                  u.store_slot,
                );
                stored = true;
              } catch (e) {
                if (!(e instanceof HttpError)) throw e;
                if (e.code !== "tracking_pending") break;
                await Bun.sleep(250);
              }
            }
            if (stored) artifacts++;
            else pendingArtifacts++;
            continue;
          }
          const file = resolve(spool, u.file);
          if (!file.startsWith(spool + sep) || !existsSync(file)) continue;
          const cur = this.o.jobs.attempt(a.attempt_id) as AttemptRecord;
          if (cur.artifacts.some((x) => x.path === u.dest && x.sha256 === u.sha256)) continue;
          const bytes = statSync(file).size;
          if (bytes > this.o.maxArtifactBytes || (await sha256File(file)) !== u.sha256) {
            rejected++;
            continue;
          }
          const sha = u.sha256;
          // The run is created from the events just imported: give the outbox a moment.
          let stored = false;
          for (let i = 0; i < 40 && !stored; i++) {
            try {
              await this.o.jobs.storeArtifact(
                this.o.jobs.attempt(a.attempt_id) as AttemptRecord,
                u.dest,
                file,
                bytes,
                sha,
              );
              stored = true;
            } catch (e) {
              if (!(e instanceof HttpError) || e.code !== "tracking_pending") throw e;
              await Bun.sleep(250);
            }
          }
          if (stored) artifacts++;
          else pendingArtifacts++;
        }
      const after = this.o.jobs.attempt(a.attempt_id) as AttemptRecord;
      this.patch(a.attempt_id, {
        sync: after.state === "starting" || after.state === "running" ? "awaiting_sync" : "synced",
        sync_error: undefined,
        imported_at: this.o.now().toISOString(),
      });
      this.o.audit.record({
        actor: { kind: "human", id: by },
        listener: "human",
        action: "job.remote.import",
        outcome: "allowed",
        project_id: a.project_id,
        target: a.attempt_id,
        details: { accepted, duplicates, rejected, artifacts, pending_artifacts: pendingArtifacts },
      });
      return {
        accepted,
        duplicates,
        rejected,
        artifacts,
        ...(pendingArtifacts
          ? {
              pending_artifacts: pendingArtifacts,
              note: "the MLflow run is not ready (tracking pending); import the same archive again to store the remaining artifacts",
            }
          : {}),
        state: after.state,
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private findSpool(root: string): string | undefined {
    const stack = [root];
    for (let depth = 0; stack.length && depth < 2000; depth++) {
      const d = stack.shift() as string;
      if (existsSync(join(d, "journal")) && existsSync(join(d, "..", "bundle"))) return d;
      if (d.endsWith(`${sep}spool`) && existsSync(join(d, "journal"))) return d;
      for (const e of readdirSync(d, { withFileTypes: true }))
        if (e.isDirectory() && !e.isSymbolicLink()) stack.push(join(d, e.name));
    }
    return undefined;
  }

  // ------------------------------------------------------------------ watchdog

  /** Connectivity, provider status and drains. Never resubmits (spec §5.3). */
  async tick(): Promise<void> {
    const now = Date.now();
    for (const a of this.o.jobs.remoteAttempts()) {
      const r = a.remote as RemoteAttemptInfo;
      if (this.busy.has(a.attempt_id)) continue;
      const terminal = !["starting", "running"].includes(a.state);
      if (terminal && r.sync === "synced" && r.provider_job_id) await this.release(a);
      if (terminal && r.sync === "synced" && r.store_slots && !r.store_cleaned_at)
        await this.cleanStore(a);
      if (terminal && (r.sync === "synced" || r.staging === "failed")) continue;
      // An exported notebook past its expected return: say so once; never fail it (F29).
      if (
        !terminal &&
        r.staging === "exported" &&
        r.expected_back_by &&
        !r.overdue_at &&
        this.o.now().getTime() > Date.parse(r.expected_back_by)
      ) {
        this.patch(a.attempt_id, { overdue_at: this.iso() });
        this.o.events.publish(a.project_id, "job.worker.overdue", {
          job_id: a.job_id,
          attempt_id: a.attempt_id,
          target_id: r.target_id,
          expected_back_by: r.expected_back_by,
        });
      }
      // Connectivity.
      if (r.connectivity === "connected" && r.last_contact_at) {
        const age = this.o.now().getTime() - Date.parse(r.last_contact_at);
        if (age > this.o.settings.disconnectedAfterSec * 1000) {
          this.patch(a.attempt_id, { connectivity: "disconnected", sync: "awaiting_sync" });
          this.o.events.publish(a.project_id, "job.worker.disconnected", {
            job_id: a.job_id,
            attempt_id: a.attempt_id,
            target_id: r.target_id,
            last_contact_at: r.last_contact_at,
          });
        }
      }
      // Provider status.
      if (r.staging !== "submitted" || !r.provider_job_id) continue;
      const last = this.polledAt.get(a.attempt_id) ?? 0;
      if (now - last < this.o.settings.providerPollSec * 1000) continue;
      this.polledAt.set(a.attempt_id, now);
      this.busy.add(a.attempt_id);
      try {
        await this.poll(a);
      } catch (e) {
        this.patch(a.attempt_id, {
          provider_state: `unreachable: ${(e as Error).message}`.slice(0, 100),
          provider_checked_at: this.iso(),
        });
      } finally {
        this.busy.delete(a.attempt_id);
      }
    }
  }

  /** Release provider resources (a pod) once an attempt is terminal and delivered. */
  private async release(a: AttemptRecord): Promise<void> {
    const r = a.remote as RemoteAttemptInfo;
    if (this.released.has(a.attempt_id) || r.provider_state === "released") return;
    let adapter: TargetAdapter;
    try {
      adapter = this.adapterOf(a);
    } catch {
      return;
    }
    if (!adapter.capabilities.release || !adapter.release) return;
    this.released.add(a.attempt_id);
    rmSync(join(this.o.paths.bundlesDir, a.attempt_id, "bundle.tgz"), { force: true });
    try {
      await adapter.release(a.attempt_id, r.provider_job_id as string);
      this.patch(a.attempt_id, { provider_state: "released", provider_checked_at: this.iso() });
      this.o.audit.record({
        actor: { kind: "system" },
        listener: "internal",
        action: "job.remote.release",
        outcome: "allowed",
        project_id: a.project_id,
        target: a.attempt_id,
        details: { provider_job_id: r.provider_job_id },
      });
    } catch (e) {
      this.released.delete(a.attempt_id);
      this.o.log(
        `releasing ${r.provider_job_id} for ${a.attempt_id} failed: ${(e as Error).message}`,
      );
    }
  }

  private async poll(a: AttemptRecord): Promise<void> {
    const r = a.remote as RemoteAttemptInfo;
    const adapter = this.adapterOf(a);
    const st = await adapter.status(a.attempt_id, r.provider_job_id as string);
    const cur = this.patch(a.attempt_id, {
      provider_state: st.state.slice(0, 100),
      provider_checked_at: this.iso(),
    });
    if (!st.terminal || !cur?.remote) return;
    const c = cur.remote;
    const phase = st.worker?.["phase"];
    if (phase === "synced" || c.sync === "synced") return;
    const connectedRecently =
      c.connectivity === "connected" &&
      c.last_contact_at !== undefined &&
      this.o.now().getTime() - Date.parse(c.last_contact_at) <
        2 * this.o.settings.heartbeatSec * 1000;
    if (connectedRecently) return; // the worker is delivering on its own
    // The provider ended the job but results are missing: deliver the leftover spool. Never rerun.
    const drains = c.drains ?? 0;
    if (drains >= MAX_DRAINS || !adapter.capabilities.drain) {
      if (!c.reconcile_required) {
        const why = adapter.capabilities.drain
          ? `the provider reports ${st.state}, and ${MAX_DRAINS} drains did not deliver the worker's results; the outcome stays as last reported and nothing was rerun`
          : `the provider reports ${st.state} and the worker's results did not arrive; this target cannot drain, so \`remote import\` its worker directory if you can retrieve it; nothing was rerun`;
        this.patch(a.attempt_id, { reconcile_required: why, sync: "sync_failed", sync_error: why });
        if (cur.state === "starting" || cur.state === "running")
          this.o.jobs.finishAttempt(a.attempt_id, "unknown", { error: why });
      }
      return;
    }
    const lastDrain = this.drainedAt.get(a.attempt_id) ?? 0;
    if (Date.now() - lastDrain < this.o.settings.providerPollSec * 1000) return;
    this.o.log(`provider reports ${st.state} for ${a.attempt_id}; draining the worker's spool`);
    try {
      await this.drain(cur, "system");
    } catch (e) {
      // A failed drain still counts: after MAX_DRAINS the attempt waits for a human.
      this.drainedAt.set(a.attempt_id, Date.now());
      this.patch(a.attempt_id, {
        drains: drains + 1,
        sync_error: `drain failed: ${(e as Error).message}`.slice(0, 2000),
      });
    }
  }

  startWatchdog(): void {
    const ms = this.o.tickMs ?? 5000;
    this.timer = setInterval(() => {
      void this.tick().catch((e) => this.o.log(`remote watchdog: ${(e as Error).message}`));
    }, ms);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Bundles whose staging never finished (a coordinator crash mid-submission) are not retried. */
  recover(): void {
    for (const a of this.o.jobs.remoteAttempts()) {
      const r = a.remote as RemoteAttemptInfo;
      if (r.staging === "bundling" || r.staging === "staging") {
        const msg =
          "the coordinator stopped while staging this attempt; it may or may not have reached the target, so it was not resubmitted";
        this.patch(a.attempt_id, {
          staging: "failed",
          staging_error: msg,
          reconcile_required: msg,
        });
        this.o.jobs.finishAttempt(a.attempt_id, "unknown", { error: msg });
      }
    }
    // Old bundle directories of finished attempts are not needed.
    if (!existsSync(this.o.paths.bundlesDir)) return;
    for (const d of readdirSync(this.o.paths.bundlesDir)) {
      if (d.startsWith(".import-"))
        rmSync(join(this.o.paths.bundlesDir, d), { recursive: true, force: true });
    }
  }
}

const ID_LIKE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The attempt an imported spool's first event names (untrusted: IDs only when ID-shaped). */
function archiveOwner(
  spool: string,
  segs: readonly string[],
): { attempt_id: string; job_id: string } | undefined {
  const first = segs[0];
  if (!first) return undefined;
  for (const line of readFileSync(join(spool, "journal", first), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as { attempt_id?: unknown; ablationkit_job_id?: unknown };
      const attempt = ev.attempt_id;
      const job = ev.ablationkit_job_id;
      return typeof attempt === "string" &&
        typeof job === "string" &&
        ID_LIKE.test(attempt) &&
        ID_LIKE.test(job)
        ? { attempt_id: attempt, job_id: job }
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
