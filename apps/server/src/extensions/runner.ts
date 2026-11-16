/**
 * The Python extension runner (spec §8.4.1 with §7.11; criteria 15e, 15f; ADR 0022).
 *
 * Each execution runs an approved build's Python contribution as its own process:
 *
 * - from the build's snapshot and the venv made from its lockfile (never the checkout);
 * - under a systemd user scope with the manifest's `MemoryMax`, `CPUQuota`, `RuntimeMaxSec` and
 *   `TasksMax` (enforced when the controllers are delegated, advisory otherwise);
 * - with `network: none`, inside an empty network namespace (`unshare -rn`) when the host
 *   allows unprivileged user namespaces, which also keeps it away from MLflow and the coordinator;
 * - with a scrubbed environment: no tokens, no MLflow URI, `CUDA_VISIBLE_DEVICES` empty without
 *   the `gpu` capability.
 *
 * It talks to the coordinator only over its stdin/stdout (the broker): every call is checked
 * against the approved capabilities. Staged inputs are files under `inputs/`; outputs must be
 * written under `outputs/`, are hashed and size-limited, and are logged to MLflow through the
 * coordinator when `project.results.write` is granted. Approved Python is trusted code: it can
 * read whatever the researcher can (the record says so).
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import { PYTHON_BROKER_METHODS, pointInfo, sha256 } from "@ablationkit/extension-host";
import {
  probeSupervisor,
  type Supervised,
  type SupervisorProbe,
  startSupervised,
  stopUnit,
  type Termination,
} from "@ablationkit/process-supervisor";
import type {
  ExtensionActor,
  ExtensionApproval,
  ExtensionBuildRecord,
  ExtensionExecutionRecord,
  ExtensionResult,
  ObjectRef,
} from "@ablationkit/protocol";
import { ProtocolValidationError, validateExtensionExecutionRecord } from "@ablationkit/protocol";
import { MlflowError, TAGS } from "@ablationkit/tracking-mlflow";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";
import type { ExtensionService } from "./host.ts";

type Json = Record<string, unknown>;

export const PYTHON_SDK_DIR = resolve(
  import.meta.dir,
  "../../../../python/ablationkit-extension/src",
);
const RUNNER = join(PYTHON_SDK_DIR, "ablationkit_extension", "runner.py");
const MAX_PARAMS_BYTES = 64 * 1024;
const MAX_DATA_BYTES = 256 * 1024;
const DEFAULT_OUTPUT_BYTES = 64 * 1024 * 1024;
const LOG_TAIL = 64 * 1024;
const TASKS_MAX = 128;

interface Live {
  sup: Supervised;
  cancelled?: string;
}

/** A warm worker (`python.warm`, ADR 0047): one Python process per build, serving runs in turn. */
interface Warm {
  readonly key: string;
  readonly pid: string;
  readonly ext: string;
  readonly sup: Supervised;
  readonly ready: Promise<boolean>;
  dead: boolean;
  term?: Termination;
  /** Runs queue on this: one at a time. */
  lock: Promise<void>;
  served: number;
  idle?: ReturnType<typeof setTimeout>;
  /** The current run's handlers (protocol messages, stderr bytes). */
  onMessage?: ((m: Json) => Promise<void>) | undefined;
  onStderr?: ((chunk: Uint8Array) => void) | undefined;
}

/** A warm worker exits after this long without a run. */
export const WARM_IDLE_MS = 10 * 60 * 1000;

let unshareOk: boolean | undefined;
/** Can this host start a process in an empty network namespace without privileges? */
export function unshareAvailable(): boolean {
  if (unshareOk === undefined) {
    if (process.env["ABLATIONKIT_NO_NETNS"] === "1") unshareOk = false;
    else
      try {
        unshareOk =
          Bun.spawnSync(["unshare", "-rn", "true"], { stdout: "ignore", stderr: "ignore" })
            .exitCode === 0;
      } catch {
        unshareOk = false;
      }
  }
  return unshareOk;
}

export class ExtensionRunner {
  readonly loadProblems: string[] = [];
  private readonly records = new Map<string, ExtensionExecutionRecord>();
  private readonly live = new Map<string, Live>();
  private readonly warm = new Map<string, Warm>();
  private remoteTimer: ReturnType<typeof setInterval> | undefined;
  private reconciling = false;
  private probeResult: SupervisorProbe | undefined;

  constructor(
    private readonly o: {
      readonly svc: () => Services;
      readonly stateDir: string;
      readonly now: () => Date;
      readonly supervisor: "auto" | "systemd" | "direct";
      readonly maxConcurrent: number;
      readonly host: ExtensionService;
    },
  ) {}

  private get svc(): Services {
    return this.o.svc();
  }

  private probe(): SupervisorProbe {
    if (!this.probeResult) {
      const s = this.o.supervisor;
      this.probeResult =
        s === "direct"
          ? probeSupervisor({ ABLATIONKIT_SUPERVISOR: "direct" })
          : probeSupervisor({ ABLATIONKIT_SUPERVISOR: s === "systemd" ? "systemd" : undefined });
    }
    return this.probeResult;
  }

  private dir(pid: string): string {
    return join(this.o.stateDir, pid, "extensions", "executions");
  }
  execDir(pid: string, xid: string): string {
    return join(this.dir(pid), xid);
  }

  /** Extension executions of a project still running (project removal refuses these). */
  running(pid: string): ExtensionExecutionRecord[] {
    return [...this.records.values()].filter((r) => r.project_id === pid && r.status === "running");
  }

  /** Drop a removed project's executions from memory. */
  forgetProject(pid: string): void {
    for (const [id, r] of [...this.records]) if (r.project_id === pid) this.records.delete(id);
  }

  load(pids: readonly string[]): void {
    for (const pid of pids) {
      const d = this.dir(pid);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
        try {
          const r = readJson(join(d, f), validateExtensionExecutionRecord);
          this.records.set(r.execution_id, r);
        } catch {
          this.loadProblems.push(join(d, f));
        }
      }
    }
  }

  /** Executions a previous coordinator left running are interrupted, never rerun (§8.4.1). */
  start(): void {
    for (const r of this.records.values()) {
      if (r.status !== "running") continue;
      // A remote execution is supervised by its job: it reconciles, it is never interrupted.
      if (r.remote) {
        this.ensureRemoteTimer();
        continue;
      }
      stopUnit(`${this.unit(r.execution_id)}.scope`);
      this.save({
        ...r,
        status: "interrupted",
        finished_at: this.o.now().toISOString(),
        error:
          "the coordinator stopped while this execution ran; it was not rerun and its outputs were not recorded",
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.remoteTimer) clearInterval(this.remoteTimer);
    this.remoteTimer = undefined;
    await this.stopWarm();
    await Promise.all(
      [...this.live.entries()].map(async ([, l]) => {
        l.cancelled = "the coordinator stopped";
        await l.sup?.stop().catch(() => undefined);
      }),
    );
  }

  private unit(xid: string): string {
    return `ak-ext-${xid}`;
  }

  private save(r: ExtensionExecutionRecord): void {
    mkdirSync(this.dir(r.project_id), { recursive: true });
    writeJsonAtomic(join(this.dir(r.project_id), `${r.execution_id}.json`), r, {
      validate: validateExtensionExecutionRecord,
    });
    this.records.set(r.execution_id, r);
  }

  get(pid: string, xid: string): ExtensionExecutionRecord {
    const r = this.records.get(xid);
    if (!r || r.project_id !== pid) throw new HttpError(404, "not_found", `no execution ${xid}`);
    return r;
  }

  list(pid: string, ext?: string): ExtensionExecutionRecord[] {
    return [...this.records.values()]
      .filter((r) => r.project_id === pid && (!ext || r.extension_id === ext))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 200);
  }

  view(r: ExtensionExecutionRecord): Json {
    return compact({
      execution_id: r.execution_id,
      extension_id: r.extension_id,
      build_id: r.build_id,
      contribution: r.contribution,
      status: r.status,
      progress: r.progress,
      result: r.result,
      error: r.error,
      created_at: r.created_at,
      finished_at: r.finished_at,
      mlflow_run_id: r.mlflow_run_id,
      enforcement: r.enforcement,
      limits: r.limits,
      remote: r.remote,
      warm: r.warm,
    });
  }

  logTail(pid: string, xid: string): string {
    this.get(pid, xid);
    const f = join(this.execDir(pid, xid), "log.txt");
    if (!existsSync(f)) return "";
    const b = readFileSync(f);
    return b.subarray(Math.max(0, b.length - LOG_TAIL)).toString("utf8");
  }

  async cancel(pid: string, xid: string, actor: ExtensionActor): Promise<ExtensionExecutionRecord> {
    const r = this.get(pid, xid);
    if (r.status === "running" && r.remote) {
      // The job's cancellation reaches the worker; the record follows the attempt.
      try {
        this.svc.jobs.cancel(r.remote.job_id);
      } catch {
        // already ended
      }
      return r;
    }
    const l = this.live.get(xid);
    if (r.status !== "running" || !l) return r;
    l.cancelled = `cancelled by ${actor.kind}`;
    // A warm run still queued has no process yet: it ends as cancelled when its turn comes.
    // A running warm run stops its worker; the next run starts a new one.
    await l.sup?.stop();
    return this.get(pid, xid);
  }

  async cancelAll(pid: string, ext: string, why: string): Promise<number> {
    void this.stopWarm(pid, ext);
    const ids = [...this.records.values()]
      .filter((r) => r.project_id === pid && r.extension_id === ext && r.status === "running")
      .map((r) => r.execution_id);
    await Promise.all(
      ids.map(async (id) => {
        const l = this.live.get(id);
        if (!l) return;
        l.cancelled = why;
        await l.sup?.stop().catch(() => undefined);
      }),
    );
    return ids.length;
  }

  /** Start one execution. Returns once the process is running; it finishes in the background. */
  async run(
    pid: string,
    ext: string,
    contribution: string,
    input: { params: unknown; refs: unknown },
    actor: ExtensionActor,
    opts: { targetId?: string; acceptCost?: boolean } = {},
  ): Promise<ExtensionExecutionRecord> {
    const host = this.o.host;
    if (opts.targetId !== undefined && actor.kind !== "human")
      throw new HttpError(
        403,
        "remote_humans_only",
        "only a researcher runs an extension contribution on a remote target",
      );
    if (host.safeMode)
      throw new HttpError(503, "safe_mode", "extensions are inactive in safe mode");
    // An agent's run is decided by the project policy, like its jobs (ADR 0045): approval no
    // longer gates it, since a build is enabled as it is built.
    if (actor.kind === "agent") this.o.svc().policy.requireAgent(pid, "jobs.run_local");
    const b = host.activeBuild(pid, ext);
    if (!b)
      throw new HttpError(
        403,
        "extension_inactive",
        `${ext} is not enabled and approved in this project`,
      );
    const approval = host.approval(pid, ext, b.build_id) as ExtensionApproval;
    if (!approval.capabilities.includes("project.analysis.execute"))
      throw new HttpError(
        403,
        "capability_denied",
        `${ext} was not granted project.analysis.execute`,
      );
    host.assertApprovedSource(pid, ext, b);
    const c = b.manifest.contributes.find((x) => x.id === contribution);
    if (!c || pointInfo(c.point)?.kind !== "python" || !c.entry)
      throw new HttpError(
        404,
        "not_found",
        `${contribution} is not one of ${ext}'s Python contributions`,
      );
    const py = b.manifest.python;
    if (!py || b.python?.status !== "ready")
      throw new HttpError(
        409,
        "python_env_missing",
        "this build has no Python environment; build again",
      );
    const params = input.params ?? {};
    if (typeof params !== "object" || Array.isArray(params) || params === null)
      throw new HttpError(400, "invalid_request", "params must be an object");
    const paramsText = JSON.stringify(params);
    if (Buffer.byteLength(paramsText) > MAX_PARAMS_BYTES)
      throw new HttpError(
        413,
        "request_too_large",
        `params are limited to ${MAX_PARAMS_BYTES} bytes`,
      );
    const refs = this.checkRefs(input.refs);
    if (opts.targetId !== undefined && py.environment === "project")
      throw new HttpError(
        400,
        "invalid_request",
        `${ext} runs in the project's own environment, which exists on this machine only; run it here`,
      );
    if (opts.targetId !== undefined) this.checkRemote(b, py, opts.targetId, opts.acceptCost);
    const running = [...this.records.values()].filter((r) => r.status === "running" && !r.remote);
    if (opts.targetId === undefined && running.length >= this.o.maxConcurrent)
      throw new HttpError(
        429,
        "too_many_executions",
        `at most ${this.o.maxConcurrent} extension executions run at once`,
      );
    if (
      opts.targetId === undefined &&
      running.filter((r) => r.project_id === pid).length >=
        Math.max(1, Math.floor(this.o.maxConcurrent / 2))
    )
      throw new HttpError(
        429,
        "too_many_executions",
        "this project already has its share of running extension executions",
      );

    const xid = `xe-${randomBytes(8).toString("hex")}`;
    const dir = this.execDir(pid, xid);
    const inputs = join(dir, "inputs");
    const outputs = join(dir, "outputs");
    mkdirSync(join(inputs, "runs"), { recursive: true, mode: 0o700 });
    mkdirSync(outputs, { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "tmp"), { recursive: true, mode: 0o700 });
    // Stage inputs: only what was referenced, and only with the capability to read it.
    if (approval.capabilities.includes("project.runs.read"))
      for (const r of refs.filter((x) => x.kind === "run")) {
        const run = await host.projectRun(pid, r.id);
        writeFileSync(
          join(inputs, "runs", `${r.id}.json`),
          JSON.stringify(host.runSummary(run), null, 2),
        );
      }
    else if (refs.some((x) => x.kind === "run"))
      throw new HttpError(
        403,
        "capability_denied",
        `${ext} was not granted project.runs.read, so runs cannot be staged`,
      );
    // Read-only staged files (advisory: approved Python runs as the researcher).
    for (const f of readdirSync(join(inputs, "runs"))) chmodSync(join(inputs, "runs", f), 0o444);
    if (opts.targetId !== undefined)
      return this.runRemote(
        { pid, ext, contribution, xid, dir, params, paramsText, refs, actor },
        b,
        approval,
        opts.targetId,
        opts.acceptCost === true,
      );

    const probe = this.probe();
    const netns = py.network === "none" && unshareAvailable();
    const limitsEnforced = probe.mode === "systemd" && probe.enforcement === "enforced";
    const reasons: string[] = [];
    if (!limitsEnforced)
      reasons.push(`limits advisory: ${probe.reason ?? "systemd user scopes unavailable"}`);
    if (py.network === "none" && !netns)
      reasons.push(
        "network advisory: unprivileged network namespaces (unshare -rn) are unavailable",
      );
    if (py.network === "egress")
      reasons.push("network allowed: the network.egress capability was approved");
    reasons.push(
      "filesystem reads advisory: approved Python runs as trusted code under your user (§7.11)",
    );
    if (py.warm === true)
      reasons.push(
        "warm worker: memory, CPU and task limits hold for the whole worker process; the time limit is applied to each run by the coordinator, which stops the worker when a run overruns",
      );
    const outMax =
      b.manifest.capability_config?.artifacts?.max_output_bytes ?? DEFAULT_OUTPUT_BYTES;
    const limits = {
      runtime_max_sec: py.max_runtime_seconds,
      memory_max_bytes: py.max_memory_mb * 1024 * 1024,
      cpu_quota_percent: py.cpu_percent ?? 100,
      tasks_max: TASKS_MAX,
      output_max_bytes: outMax,
    };
    // After a restore the build has no venv yet: rebuild it from the lockfile (must match).
    await host.ensurePythonEnv(pid, ext, b.build_id);
    const now = this.o.now().toISOString();
    const rec: ExtensionExecutionRecord = compact({
      schema_version: 1 as const,
      execution_id: xid,
      project_id: pid,
      extension_id: ext,
      build_id: b.build_id,
      contribution,
      entry: c.entry,
      source_sha256: b.source_sha256,
      lockfile_sha256: b.lockfile_sha256,
      capability_sha256: b.capability_sha256,
      environment: compact({
        python_version: b.python.python_version,
        environment_sha256: b.python.environment_sha256,
      }),
      params_sha256: sha256(paramsText),
      refs,
      status: "running" as const,
      created_by: actor,
      created_at: now,
      limits,
      enforcement: {
        limits: limitsEnforced ? ("enforced" as const) : ("advisory" as const),
        network: netns ? ("enforced" as const) : ("advisory" as const),
        reasons,
      },
    }) as ExtensionExecutionRecord;
    this.save(rec);

    const buildDir = host.buildDir(pid, ext, b.build_id);
    const request = {
      project_id: pid,
      extension_id: ext,
      execution_id: xid,
      contribution,
      capabilities: approval.capabilities,
      refs,
      inputs_dir: inputs,
      outputs_dir: outputs,
      output_max_bytes: outMax,
      source_dir: join(buildDir, "src"),
      entry: c.entry,
      params,
    };
    writeFileSync(join(dir, "request.json"), JSON.stringify(request), { mode: 0o600 });
    const python = join(buildDir, "venv", "bin", "python");
    const argv = [
      ...(netns ? ["unshare", "-rn", "--"] : []),
      python,
      "-I",
      "-B",
      RUNNER,
      join(dir, "request.json"),
    ];
    const env: Record<string, string> = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: join(dir, "tmp"),
      TMPDIR: join(dir, "tmp"),
      LANG: "C.UTF-8",
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
      MPLBACKEND: "Agg",
    };
    if (!b.manifest.python?.gpu || !approval.capabilities.includes("gpu"))
      env["CUDA_VISIBLE_DEVICES"] = "";
    // Environment `project` (ADR 0046): where the checkout is, for the project's own data files.
    // Reading it is what trusted code may do anyway; the variable only makes it explicit.
    if (b.manifest.python?.environment === "project")
      env["ABLATIONKIT_CHECKOUT"] = this.o.svc().registry.require(pid).path;
    if (py.warm === true) {
      const wl: Live = { sup: undefined as unknown as Supervised };
      this.live.set(xid, wl);
      this.svc.audit.record({
        actor: compact({ kind: actor.kind, id: actor.id }),
        listener: actor.kind === "agent" ? "agent" : actor.kind === "human" ? "human" : "internal",
        action: "extension.execute",
        outcome: "allowed",
        project_id: pid,
        target: xid,
        details: { extension_id: ext, build_id: b.build_id, contribution, warm: true },
      });
      this.svc.events.publish(pid, "extension.execution.started", {
        execution_id: xid,
        extension_id: ext,
      });
      void this.runWarm(rec, request, approval, wl, {
        argv: [...(netns ? ["unshare", "-rn", "--"] : []), python, "-I", "-B", RUNNER, "--serve"],
        env,
        mode: probe.mode,
        limits,
      }).catch((e) => {
        this.live.delete(xid);
        const cur = this.records.get(xid) as ExtensionExecutionRecord;
        if (cur.status === "running")
          this.save({
            ...cur,
            status: "failed",
            finished_at: this.o.now().toISOString(),
            error: `runner error: ${String(e)}`.slice(0, 4000),
          });
      });
      return rec;
    }
    let sup: Supervised;
    try {
      sup = await startSupervised({
        unit: this.unit(xid),
        argv,
        cwd: dir,
        env,
        mode: probe.mode,
        stdin: "pipe",
        limits: {
          runtime_max_sec: limits.runtime_max_sec,
          memory_max_bytes: limits.memory_max_bytes,
          cpu_quota_percent: limits.cpu_quota_percent,
          tasks_max: limits.tasks_max,
        },
      });
    } catch (e) {
      const failed = {
        ...rec,
        status: "failed" as const,
        finished_at: this.o.now().toISOString(),
        error: `could not start: ${(e as Error).message}`,
      };
      this.save(failed);
      return failed;
    }
    const l: Live = { sup };
    this.live.set(xid, l);
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: actor.kind === "agent" ? "agent" : actor.kind === "human" ? "human" : "internal",
      action: "extension.execute",
      outcome: "allowed",
      project_id: pid,
      target: xid,
      details: {
        extension_id: ext,
        build_id: b.build_id,
        contribution,
        limits: rec.enforcement.limits,
        network: rec.enforcement.network,
      },
    });
    this.svc.events.publish(pid, "extension.execution.started", {
      execution_id: xid,
      extension_id: ext,
    });
    void this.supervise(rec, l, approval).catch((e) => {
      const cur = this.records.get(xid) as ExtensionExecutionRecord;
      if (cur.status === "running")
        this.save({
          ...cur,
          status: "failed",
          finished_at: this.o.now().toISOString(),
          error: `runner error: ${String(e)}`.slice(0, 4000),
        });
    });
    return rec;
  }

  // ------------------------------------------------------------------ remote (ADR 0023 decision 26)

  /** Refuse a remote run that cannot work before anything is staged. */
  private checkRemote(
    b: ExtensionBuildRecord,
    py: NonNullable<ExtensionBuildRecord["manifest"]["python"]>,
    targetId: string,
    acceptCost?: boolean,
  ): void {
    if (!this.svc.targets.get(targetId))
      throw new HttpError(404, "target_not_found", `no compute target ${targetId}`);
    const deps = b.python?.packages ?? [];
    if (deps.length)
      throw new HttpError(
        422,
        "dependencies_not_remote",
        `${b.manifest.id} pins ${deps.length} package(s) (${deps.slice(0, 5).join(", ")}); its environment is built on the workstation, so it runs locally. Remote targets run contributions that need only the standard library and the extension SDK.`,
      );
    this.svc.remote.check(targetId, {
      acceptCost: acceptCost === true,
      runtimeSec: py.max_runtime_seconds,
    });
  }

  /**
   * Submit the contribution as a job on `targetId`. The bundle carries the build's source snapshot,
   * the request and the staged inputs; nothing else of the coordinator is reachable from there.
   */
  private runRemote(
    x: {
      pid: string;
      ext: string;
      contribution: string;
      xid: string;
      dir: string;
      params: unknown;
      paramsText: string;
      refs: ObjectRef[];
      actor: ExtensionActor;
    },
    b: ExtensionBuildRecord,
    approval: ExtensionApproval,
    targetId: string,
    acceptCost: boolean,
  ): ExtensionExecutionRecord {
    const host = this.o.host;
    const py = b.manifest.python as NonNullable<ExtensionBuildRecord["manifest"]["python"]>;
    const c = b.manifest.contributes.find((y) => y.id === x.contribution) as {
      entry: string;
    };
    const stage = join(x.dir, "remote", "extension");
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    cpSync(join(host.buildDir(x.pid, x.ext, b.build_id), "src"), join(stage, "src"), {
      recursive: true,
    });
    cpSync(join(x.dir, "inputs"), join(stage, "inputs"), { recursive: true });
    const outMax =
      b.manifest.capability_config?.artifacts?.max_output_bytes ?? DEFAULT_OUTPUT_BYTES;
    const text = JSON.stringify({
      project_id: x.pid,
      extension_id: x.ext,
      execution_id: x.xid,
      contribution: x.contribution,
      capabilities: approval.capabilities,
      refs: x.refs,
      output_max_bytes: outMax,
      entry: c.entry,
      params: x.params,
      gpu: py.gpu === true && approval.capabilities.includes("gpu"),
    });
    writeFileSync(join(stage, "request.json"), text, { mode: 0o600 });
    const requestSha = sha256(text);
    const target = this.svc.targets.require(targetId);
    const limits = {
      runtime_max_sec: py.max_runtime_seconds,
      memory_max_bytes: py.max_memory_mb * 1024 * 1024,
      cpu_quota_percent: py.cpu_percent ?? 100,
      tasks_max: TASKS_MAX,
      output_max_bytes: outMax,
    };
    let submitted: ReturnType<Services["jobs"]["submit"]>;
    try {
      submitted = this.svc.jobs.submit({
        project_id: x.pid,
        command: [
          target.python ?? "python3",
          "-m",
          "ablationkit_extension.remote",
          "--request-sha256",
          requestSha,
        ],
        environment: "none",
        limits: {
          runtime_max_sec: limits.runtime_max_sec,
          memory_max_bytes: limits.memory_max_bytes,
        },
        run_name: `${x.ext}/${x.contribution} ${x.xid.slice(3, 11)}`,
        target_id: targetId,
        accept_cost: acceptCost,
        bundle_inputs: [{ name: "extension", path: stage }],
        submitted_by: compact({ kind: "human" as const, id: x.actor.id }),
      });
    } catch (e) {
      rmSync(x.dir, { recursive: true, force: true });
      throw e;
    }
    const now = this.o.now().toISOString();
    const rec: ExtensionExecutionRecord = compact({
      schema_version: 1 as const,
      execution_id: x.xid,
      project_id: x.pid,
      extension_id: x.ext,
      build_id: b.build_id,
      contribution: x.contribution,
      entry: c.entry,
      source_sha256: b.source_sha256,
      lockfile_sha256: b.lockfile_sha256,
      capability_sha256: b.capability_sha256,
      environment: compact({
        python_version: b.python?.python_version,
        environment_sha256: b.python?.environment_sha256,
      }),
      params_sha256: sha256(x.paramsText),
      refs: x.refs,
      status: "running" as const,
      created_by: x.actor,
      created_at: now,
      limits,
      enforcement: {
        limits: "advisory" as const,
        network: "advisory" as const,
        reasons: [
          `remote target ${targetId}: limits are applied by the target (reported on the job)`,
          "network advisory: no network namespace on a remote target; broker calls are answered from the staged inputs only",
          "filesystem reads advisory: approved Python runs as trusted code under the target's user (§7.11)",
        ],
      },
      remote: {
        target_id: targetId,
        job_id: submitted.job.job_id,
        attempt_id: submitted.attempt.attempt_id,
        request_sha256: requestSha,
      },
    }) as ExtensionExecutionRecord;
    this.save(rec);
    this.svc.audit.record({
      actor: compact({ kind: x.actor.kind, id: x.actor.id }),
      listener: "human",
      action: "extension.execute",
      outcome: "allowed",
      project_id: x.pid,
      target: x.xid,
      details: {
        extension_id: x.ext,
        build_id: b.build_id,
        contribution: x.contribution,
        target_id: targetId,
        job_id: submitted.job.job_id,
        request_sha256: requestSha,
      },
    });
    this.svc.events.publish(x.pid, "extension.execution.started", {
      execution_id: x.xid,
      extension_id: x.ext,
    });
    this.ensureRemoteTimer();
    return rec;
  }

  private ensureRemoteTimer(): void {
    if (this.remoteTimer) return;
    this.remoteTimer = setInterval(() => {
      void this.reconcileRemote().catch(() => {});
    }, 2000);
    (this.remoteTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Follow each running remote execution's job; nothing here starts anything. Once the attempt
   * has succeeded and synced, the result and outputs are fetched from the job's run, validated as
   * a local result would be, and recorded once.
   */
  async reconcileRemote(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const r of [...this.records.values()]) {
        if (!r.remote || r.status !== "running") continue;
        try {
          await this.reconcileOne(r);
        } catch (e) {
          if (!(e instanceof MlflowError)) throw e;
          // MLflow is down: the next tick tries again.
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOne(r: ExtensionExecutionRecord): Promise<void> {
    const remote = r.remote as NonNullable<ExtensionExecutionRecord["remote"]>;
    const job = this.svc.jobs.get(remote.job_id);
    const a = job ? this.svc.jobs.latestAttempt(job) : undefined;
    if (!job || !a) return;
    const host = this.o.host;
    const note = (text: string) => {
      if (remote.note !== text || remote.attempt_id !== a.attempt_id)
        this.save({ ...r, remote: { ...remote, attempt_id: a.attempt_id, note: text } });
    };
    const finish = (
      status: ExtensionExecutionRecord["status"],
      patch: { error?: string; result?: ExtensionResult; mlflow_run_id?: string | undefined },
    ) => {
      const { note: _n, ...settled } = remote;
      const started = a.started_at ? Date.parse(a.started_at) : NaN;
      const ended = a.ended_at ? Date.parse(a.ended_at) : NaN;
      const done = compact({
        ...r,
        ...patch,
        status,
        remote: { ...settled, attempt_id: a.attempt_id },
        finished_at: this.o.now().toISOString(),
        termination: compact({
          exit_code: a.exit_code,
          duration_ms: Number.isFinite(ended - started) ? Math.max(0, ended - started) : 0,
        }),
      }) as ExtensionExecutionRecord;
      this.save(done);
      host.log(
        r.project_id,
        r.extension_id,
        status === "succeeded" ? "info" : "error",
        `python:${r.contribution}`,
        `${r.execution_id} ${status} on ${remote.target_id}${patch.error ? `: ${patch.error}` : ""}`,
      );
      this.svc.events.publish(r.project_id, "extension.execution.finished", {
        execution_id: r.execution_id,
        extension_id: r.extension_id,
        status,
      });
    };
    const why = `${a.exit_code !== undefined ? ` (exit ${a.exit_code})` : ""}${a.error ? `: ${a.error}` : ""}`;
    if (a.state === "cancelled") return finish("cancelled", { error: "cancelled" });
    if (a.state === "timed_out")
      return finish("timed_out", {
        error: `stopped at its time limit of ${r.limits.runtime_max_sec} s on ${remote.target_id}`,
      });
    if (a.state === "oom_killed")
      return finish("oom_killed", { error: `killed at its memory limit on ${remote.target_id}` });
    if (a.state === "failed")
      return finish("failed", { error: `the job failed${why}; see its log`.slice(0, 4000) });
    if (a.state === "unknown" || a.remote?.reconcile_required)
      return note(
        `the attempt is ${a.state}${a.remote?.reconcile_required ? ` (${a.remote.reconcile_required})` : ""}: resolve it on the job; the execution is not rerun`,
      );
    if (a.state !== "succeeded") return;
    const jobRun = this.svc.tracking.mappings.get(a.attempt_id)?.mlflow_run_id;
    if (
      a.remote?.sync !== "synced" ||
      !jobRun ||
      !a.artifacts.some((x) => x.path === "extension/result.json")
    )
      return note("the job finished; waiting for the worker to deliver its result");
    const c = this.svc.tracking.client;
    const res = await c.downloadArtifact(jobRun, "extension/result.json");
    if (!res.ok) return note("the job finished; waiting for its result to reach MLflow");
    const raw = (await res.json()) as Json;
    // Fetch the declared outputs into the execution's output area, then check them as locally.
    const dir = this.execDir(r.project_id, r.execution_id);
    const outputs = join(dir, "outputs");
    rmSync(outputs, { recursive: true, force: true });
    mkdirSync(outputs, { recursive: true, mode: 0o700 });
    const names = Array.isArray(raw["artifacts"])
      ? (raw["artifacts"] as unknown[]).slice(0, 100)
      : [];
    for (const n of names) {
      if (typeof n !== "string") continue;
      const p = resolve(outputs, n);
      if (!p.startsWith(`${outputs}/`)) continue; // checkResult refuses it below
      const f = await c.downloadArtifact(jobRun, `extension/outputs/${n}`);
      if (!f.ok) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, new Uint8Array(await f.arrayBuffer()));
    }
    let typed: ExtensionResult;
    try {
      typed = this.checkResult(dir, raw, r.limits.output_max_bytes);
    } catch (e) {
      return finish("failed", { error: `invalid result: ${(e as Error).message}`.slice(0, 4000) });
    }
    if (typed.status !== "ok") return finish("failed", { result: typed, error: typed.summary });
    let mlflowRunId: string | undefined;
    const approval = host.approval(r.project_id, r.extension_id, r.build_id);
    if (approval?.capabilities.includes("project.results.write"))
      try {
        mlflowRunId = await this.logToMlflow(r, typed, dir);
      } catch (e) {
        typed = {
          ...typed,
          warnings: [
            ...typed.warnings,
            `not logged to MLflow (${(e as Error).message}); the result is kept in AblationKit only`.slice(
              0,
              1000,
            ),
          ].slice(0, 50),
        };
      }
    return finish("succeeded", { result: typed, mlflow_run_id: mlflowRunId });
  }

  private checkRefs(raw: unknown): ObjectRef[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > 50)
      throw new HttpError(400, "invalid_request", "refs must be a list of at most 50");
    return raw.map((r) => {
      const x = r as Json;
      if (
        typeof x?.["kind"] !== "string" ||
        typeof x["id"] !== "string" ||
        !/^[A-Za-z0-9_./:@-]{1,300}$/.test(x["id"])
      )
        throw new HttpError(400, "invalid_request", "each ref needs kind and id");
      if (
        !["run", "logged_model", "model_version", "dataset", "evaluation", "trace"].includes(
          x["kind"],
        )
      )
        throw new HttpError(
          400,
          "invalid_request",
          `refs of kind ${x["kind"]} cannot be passed to extensions`,
        );
      return { kind: x["kind"] as ObjectRef["kind"], id: x["id"] };
    });
  }

  private async supervise(
    rec: ExtensionExecutionRecord,
    l: Live,
    approval: ExtensionApproval,
  ): Promise<void> {
    const pid = rec.project_id;
    const xid = rec.execution_id;
    const ext = rec.extension_id;
    const dir = this.execDir(pid, xid);
    const started = Date.now();
    const log = Bun.file(join(dir, "log.txt")).writer();
    const host = this.o.host;
    const stdin = l.sup.stdin;
    stdin?.on("error", () => undefined);
    const errPump = (async () => {
      let buf = "";
      for await (const chunk of l.sup.stderr) {
        log.write(chunk as Uint8Array);
        buf += Buffer.from(chunk as Uint8Array).toString("utf8");
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const line = buf.slice(0, i);
          if (line.trim()) host.log(pid, ext, "info", `python:${rec.contribution}`, line);
          buf = buf.slice(i + 1);
          i = buf.indexOf("\n");
        }
        if (buf.length > 8192) buf = buf.slice(-8192);
      }
    })().catch(() => undefined);
    let result: Json | undefined;
    let protoError: string | undefined;
    let lastProgress = 0;
    let buf = "";
    try {
      for await (const chunk of l.sup.stdout) {
        buf += Buffer.from(chunk as Uint8Array).toString("utf8");
        if (buf.length > 16 * 1024 * 1024) {
          protoError = "the extension sent a protocol message over 16 MiB";
          await l.sup.stop();
          break;
        }
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          i = buf.indexOf("\n");
          let m: Json;
          try {
            m = JSON.parse(line) as Json;
          } catch {
            continue;
          }
          if (m["t"] === "call") {
            const reply = await this.broker(pid, ext, approval, m);
            stdin?.write(`${JSON.stringify(reply)}\n`);
          } else if (m["t"] === "progress") {
            const pct = Math.max(0, Math.min(100, Number(m["percent"]) | 0));
            const cur = this.records.get(xid) as ExtensionExecutionRecord;
            const progress = compact({
              percent: pct,
              message:
                typeof m["message"] === "string"
                  ? (m["message"] as string).slice(0, 500)
                  : undefined,
            });
            this.records.set(xid, { ...cur, progress });
            if (Date.now() - lastProgress > 500) {
              lastProgress = Date.now();
              this.save({ ...cur, progress });
              this.svc.events.publish(pid, "extension.execution.progress", {
                execution_id: xid,
                ...progress,
              });
            }
          } else if (m["t"] === "result" && result === undefined) {
            result = (m["result"] ?? {}) as Json;
          }
        }
      }
    } finally {
      stdin?.end();
    }
    const term = await l.sup.exited;
    await errPump;
    await log.end();
    this.live.delete(xid);
    await this.complete(rec, approval, {
      result,
      protoError,
      cancelled: l.cancelled,
      timedOut: term.timed_out === true,
      oom: term.oom_killed === true,
      noResult: `exited (${term.exit_code ?? term.signal}) without a result; see the log`,
      termination: compact({
        exit_code: term.exit_code,
        signal: term.signal,
        unit_result: term.unit_result,
        duration_ms: Date.now() - started,
      }),
    });
  }

  /** The build's warm worker, started (and awaited ready) when there is none alive. */
  private warmWorker(
    rec: ExtensionExecutionRecord,
    spawn: {
      argv: string[];
      env: Record<string, string>;
      mode: SupervisorProbe["mode"];
      limits: ExtensionExecutionRecord["limits"];
    },
  ): Warm {
    const key = `${rec.project_id}/${rec.extension_id}/${rec.build_id}`;
    const have = this.warm.get(key);
    if (have && !have.dead) return have;
    const dir = join(
      this.o.stateDir,
      rec.project_id,
      "extension-workers",
      `w-${randomBytes(6).toString("hex")}`,
    );
    mkdirSync(join(dir, "tmp"), { recursive: true, mode: 0o700 });
    const env = { ...spawn.env, HOME: join(dir, "tmp"), TMPDIR: join(dir, "tmp") };
    const unit = `ak-extw-${randomBytes(6).toString("hex")}`;
    let resolveReady: (ok: boolean) => void = () => undefined;
    const ready = new Promise<boolean>((r) => {
      resolveReady = r;
    });
    const started = startSupervised({
      unit,
      argv: spawn.argv,
      cwd: dir,
      env,
      mode: spawn.mode,
      stdin: "pipe",
      // Memory, CPU and tasks hold for the whole process; the time limit is applied to each run.
      limits: {
        memory_max_bytes: spawn.limits.memory_max_bytes,
        cpu_quota_percent: spawn.limits.cpu_quota_percent,
        tasks_max: spawn.limits.tasks_max,
      },
    });
    const w: Warm = {
      key,
      pid: rec.project_id,
      ext: rec.extension_id,
      sup: undefined as unknown as Supervised,
      ready,
      dead: false,
      lock: Promise.resolve(),
      served: 0,
    };
    this.warm.set(key, w);
    void started.then(
      (sup) => {
        (w as { sup: Supervised }).sup = sup;
        sup.stdin?.on("error", () => undefined);
        void (async () => {
          let buf = "";
          for await (const chunk of sup.stdout) {
            buf += Buffer.from(chunk as Uint8Array).toString("utf8");
            if (buf.length > 16 * 1024 * 1024) {
              await sup.stop();
              break;
            }
            let i = buf.indexOf("\n");
            while (i >= 0) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 1);
              i = buf.indexOf("\n");
              let m: Json;
              try {
                m = JSON.parse(line) as Json;
              } catch {
                continue;
              }
              if (m["t"] === "ready") resolveReady(true);
              else await w.onMessage?.(m);
            }
          }
        })().catch(() => undefined);
        void (async () => {
          for await (const chunk of sup.stderr) {
            if (w.onStderr) w.onStderr(chunk as Uint8Array);
            else
              for (const line of Buffer.from(chunk as Uint8Array)
                .toString("utf8")
                .split("\n"))
                if (line.trim()) this.o.host.log(w.pid, w.ext, "info", "python:warm", line);
          }
        })().catch(() => undefined);
        void sup.exited.then((term) => {
          w.dead = true;
          w.term = term;
          if (w.idle) clearTimeout(w.idle);
          if (this.warm.get(key) === w) this.warm.delete(key);
          resolveReady(false);
          rmSync(dir, { recursive: true, force: true });
        });
      },
      () => {
        w.dead = true;
        if (this.warm.get(key) === w) this.warm.delete(key);
        resolveReady(false);
      },
    );
    return w;
  }

  /** One run on the build's warm worker: queued, then sent; its own record, log and outputs. */
  private async runWarm(
    rec: ExtensionExecutionRecord,
    request: Json,
    approval: ExtensionApproval,
    l: Live,
    spawn: {
      argv: string[];
      env: Record<string, string>;
      mode: SupervisorProbe["mode"];
      limits: ExtensionExecutionRecord["limits"];
    },
  ): Promise<void> {
    const pid = rec.project_id;
    const xid = rec.execution_id;
    const ext = rec.extension_id;
    const dir = this.execDir(pid, xid);
    let w = this.warmWorker(rec, spawn);
    let release: () => void = () => undefined;
    const prev = w.lock;
    w.lock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    if (w.dead) {
      release();
      w = this.warmWorker(rec, spawn);
      const p2 = w.lock;
      w.lock = new Promise<void>((r) => {
        release = r;
      });
      await p2;
    }
    if (w.idle) clearTimeout(w.idle);
    const reused = w.served > 0;
    const started = Date.now();
    const log = Bun.file(join(dir, "log.txt")).writer();
    let result: Json | undefined;
    let timedOut = false;
    let lastProgress = 0;
    try {
      if (l.cancelled) throw new Error("cancelled before it started");
      const ok = await w.ready;
      if (!ok || w.dead) throw new Error("the warm worker did not start");
      l.sup = w.sup;
      this.save({
        ...(this.records.get(xid) as ExtensionExecutionRecord),
        warm: { worker: w.sup.unit, reused },
      });
      let done: () => void = () => undefined;
      const finished = new Promise<void>((r) => {
        done = r;
      });
      // The run's stderr ends at the runner's marker line (it is written before the result).
      let stderrDone: () => void = () => undefined;
      const stderrEnded = new Promise<void>((r) => {
        stderrDone = r;
      });
      const marker = `\0ak-run-end ${xid}`;
      let errBuf = "";
      w.onStderr = (chunk) => {
        errBuf += Buffer.from(chunk).toString("utf8");
        let i = errBuf.indexOf("\n");
        while (i >= 0) {
          const line = errBuf.slice(0, i);
          errBuf = errBuf.slice(i + 1);
          i = errBuf.indexOf("\n");
          if (line === marker) {
            stderrDone();
            continue;
          }
          log.write(new TextEncoder().encode(`${line}\n`));
          if (line.trim()) this.o.host.log(pid, ext, "info", `python:${rec.contribution}`, line);
        }
        if (errBuf.length > 65536) {
          log.write(new TextEncoder().encode(errBuf));
          errBuf = "";
        }
      };
      w.onMessage = async (m) => {
        if (m["t"] === "call") {
          const reply = await this.broker(pid, ext, approval, m);
          w.sup.stdin?.write(`${JSON.stringify(reply)}\n`);
        } else if (m["t"] === "progress") {
          const pct = Math.max(0, Math.min(100, Number(m["percent"]) | 0));
          const cur = this.records.get(xid) as ExtensionExecutionRecord;
          const progress = compact({
            percent: pct,
            message:
              typeof m["message"] === "string" ? (m["message"] as string).slice(0, 500) : undefined,
          });
          this.records.set(xid, { ...cur, progress });
          if (Date.now() - lastProgress > 500) {
            lastProgress = Date.now();
            this.save({ ...cur, progress });
            this.svc.events.publish(pid, "extension.execution.progress", {
              execution_id: xid,
              ...progress,
            });
          }
        } else if (m["t"] === "result" && m["execution_id"] === xid && result === undefined) {
          result = (m["result"] ?? {}) as Json;
          done();
        }
      };
      w.sup.stdin?.write(`${JSON.stringify({ t: "request", request })}\n`);
      const timer = setTimeout(() => {
        timedOut = true;
        void w.sup.stop();
      }, spawn.limits.runtime_max_sec * 1000);
      await Promise.race([finished, w.sup.exited]);
      clearTimeout(timer);
      if (result !== undefined) await Promise.race([stderrEnded, Bun.sleep(2000)]);
    } catch (e) {
      if (!l.cancelled) log.write(new TextEncoder().encode(`${(e as Error).message}\n`));
    } finally {
      w.onMessage = undefined;
      w.onStderr = undefined;
      this.live.delete(xid);
      await log.end();
      if (!w.dead) {
        w.served++;
        w.idle = setTimeout(() => void w.sup.stop(), WARM_IDLE_MS);
      }
      release();
    }
    const term = w.dead ? w.term : undefined;
    await this.complete(rec, approval, {
      result,
      protoError: undefined,
      cancelled: l.cancelled,
      timedOut,
      oom: term?.oom_killed === true && !timedOut,
      noResult: w.dead
        ? `the warm worker exited (${term?.exit_code ?? term?.signal ?? "?"}) during the run; see the log`
        : "the warm worker did not start; see the log",
      termination: compact({
        exit_code: result === undefined ? term?.exit_code : undefined,
        signal: result === undefined ? term?.signal : undefined,
        unit_result: result === undefined ? term?.unit_result : undefined,
        duration_ms: Date.now() - started,
      }),
    });
  }

  /** Stop warm workers: one extension's in a project, or all (shutdown). */
  async stopWarm(pid?: string, ext?: string): Promise<void> {
    await Promise.all(
      [...this.warm.values()]
        .filter((w) => (!pid || w.pid === pid) && (!ext || w.ext === ext))
        .map(async (w) => {
          if (w.idle) clearTimeout(w.idle);
          await w.sup?.stop?.().catch(() => undefined);
        }),
    );
  }

  /** Record how a run ended (one process per run, or a warm worker's run) and log its result. */
  private async complete(
    rec: ExtensionExecutionRecord,
    approval: ExtensionApproval,
    o: {
      result: Json | undefined;
      protoError: string | undefined;
      cancelled: string | undefined;
      timedOut: boolean;
      oom: boolean;
      noResult: string;
      termination: NonNullable<ExtensionExecutionRecord["termination"]>;
    },
  ): Promise<void> {
    const pid = rec.project_id;
    const xid = rec.execution_id;
    const ext = rec.extension_id;
    const dir = this.execDir(pid, xid);
    const host = this.o.host;
    const { result, protoError, termination } = o;
    const cur = this.records.get(xid) as ExtensionExecutionRecord;
    let status: ExtensionExecutionRecord["status"];
    let error: string | undefined;
    let typed: ExtensionResult | undefined;
    if (o.cancelled) {
      status = "cancelled";
      error = o.cancelled;
    } else if (o.timedOut) {
      status = "timed_out";
      error = `stopped at its time limit of ${cur.limits.runtime_max_sec} s`;
    } else if (o.oom) {
      status = "oom_killed";
      error = `killed at its memory limit of ${Math.round(cur.limits.memory_max_bytes / 1048576)} MiB`;
    } else if (protoError) {
      status = "failed";
      error = protoError;
    } else if (!result) {
      status = "failed";
      error = o.noResult;
    } else {
      try {
        typed = this.checkResult(dir, result, cur.limits.output_max_bytes);
        status = typed.status === "ok" ? "succeeded" : "failed";
        if (status === "failed") error = typed.summary;
      } catch (e) {
        status = "failed";
        error = `invalid result: ${(e as Error).message}`.slice(0, 4000);
      }
    }
    let mlflowRunId: string | undefined;
    if (
      status === "succeeded" &&
      typed &&
      approval.capabilities.includes("project.results.write")
    ) {
      try {
        mlflowRunId = await this.logToMlflow(cur, typed, dir);
      } catch (e) {
        typed = {
          ...typed,
          warnings: [
            ...typed.warnings,
            `not logged to MLflow (${e instanceof MlflowError ? "MLflow unavailable" : "error"}: ${(e as Error).message}); the result is kept in AblationKit only`.slice(
              0,
              1000,
            ),
          ].slice(0, 50),
        };
      }
    }
    const done: ExtensionExecutionRecord = compact({
      ...cur,
      status,
      finished_at: this.o.now().toISOString(),
      termination,
      result: typed,
      error,
      mlflow_run_id: mlflowRunId,
    }) as ExtensionExecutionRecord;
    this.save(done);
    host.log(
      pid,
      ext,
      status === "succeeded" ? "info" : "error",
      `python:${rec.contribution}`,
      `${xid} ${status}${error ? `: ${error}` : ""}`,
    );
    this.svc.events.publish(pid, "extension.execution.finished", {
      execution_id: xid,
      extension_id: ext,
      status,
    });
  }

  /** One broker call from Python, checked against the approved capabilities. */
  private async broker(
    pid: string,
    ext: string,
    approval: ExtensionApproval,
    m: Json,
  ): Promise<Json> {
    const id = m["id"];
    const method = m["method"];
    const params = (m["params"] ?? {}) as Json;
    const fail = (code: string, message: string) => ({ t: "reply", id, error: { code, message } });
    if (typeof method !== "string" || !Object.hasOwn(PYTHON_BROKER_METHODS, method))
      return fail("method_not_allowed", `${String(method)} is not a broker method`);
    const need = PYTHON_BROKER_METHODS[method];
    if (need && !approval.capabilities.includes(need)) {
      this.svc.audit.record({
        actor: { kind: "system" },
        listener: "internal",
        action: "extension.broker",
        outcome: "denied",
        project_id: pid,
        target: ext,
        details: { method, capability: need },
      });
      return fail("capability_denied", `${method} needs ${need}, which ${ext} was not granted`);
    }
    const host = this.o.host;
    try {
      switch (method) {
        case "context.get":
          return {
            t: "reply",
            id,
            result: { project_id: pid, extension_id: ext, capabilities: approval.capabilities },
          };
        case "runs.list":
          return { t: "reply", id, result: await host.listRuns(pid, params) };
        case "runs.get":
          return {
            t: "reply",
            id,
            result: host.runSummary(await host.projectRun(pid, params["run_id"])),
          };
        case "runs.metric_history": {
          const run = await host.projectRun(pid, params["run_id"]);
          const h = await this.svc.tracking.client.getMetricHistory({
            run_id: run.info.run_id,
            metric_key: String(params["key"] ?? ""),
            max_results: 25_000,
          });
          return {
            t: "reply",
            id,
            result: {
              history: h.items.map((x) => ({
                step: x.step,
                value: x.value,
                timestamp: x.timestamp,
              })),
            },
          };
        }
        case "research.list": {
          const kind = typeof params["kind"] === "string" ? params["kind"] : undefined;
          const recs = this.svc.research.list(pid, kind ? { kind: kind as never } : {});
          return {
            t: "reply",
            id,
            result: {
              records: recs.slice(0, 500).map((r) =>
                compact({
                  record_id: r.record_id,
                  kind: r.kind,
                  title: r.title,
                  status: r.status,
                  tags: r.tags,
                }),
              ),
            },
          };
        }
        case "models.list":
          return {
            t: "reply",
            id,
            result: await this.svc.models.listModels(pid, { max_results: 100 }),
          };
        default:
          return fail("method_not_allowed", method);
      }
    } catch (e) {
      if (e instanceof HttpError) return fail(e.code, e.message);
      if (e instanceof MlflowError) return fail("tracking_unavailable", e.message);
      return fail("broker_error", String(e).slice(0, 500));
    }
  }

  /** Validate the wire result: artifacts inside the output area, sizes, types and bounds. */
  private checkResult(dir: string, raw: Json, maxBytes: number): ExtensionResult {
    const outputs = realpathSync(join(dir, "outputs"));
    const names = raw["artifacts"];
    if (!Array.isArray(names) || names.length > 100)
      throw new Error("artifacts must be a list of at most 100");
    let total = 0;
    const artifacts = names.map((n) => {
      if (typeof n !== "string") throw new Error("artifact names must be strings");
      const p = resolve(outputs, n);
      if (!p.startsWith(`${outputs}/`) || !existsSync(p))
        throw new Error(`artifact ${n} is not in the output area`);
      const st = lstatSync(p);
      if (!st.isFile()) throw new Error(`artifact ${n} is not a regular file`);
      if (realpathSync(p) !== p) throw new Error(`artifact ${n} is a link`);
      total += st.size;
      const data = readFileSync(p);
      return {
        path: relative(outputs, p),
        bytes: st.size,
        sha256: sha256(data),
        content_type: contentType(n),
      };
    });
    if (total > maxBytes)
      throw new Error(`artifacts total ${total} bytes, over the ${maxBytes} byte limit`);
    const metrics = (raw["metrics"] ?? {}) as Json;
    if (Object.keys(metrics).length > 100) throw new Error("at most 100 metrics");
    const data = raw["data"];
    if (data !== undefined && Buffer.byteLength(JSON.stringify(data)) > MAX_DATA_BYTES)
      throw new Error(`data is limited to ${MAX_DATA_BYTES} bytes; write an artifact instead`);
    const r = compact({
      status: raw["status"] === "ok" ? ("ok" as const) : ("error" as const),
      summary: String(raw["summary"] ?? "").slice(0, 2000),
      metrics,
      tables: raw["tables"] ?? [],
      warnings: raw["warnings"] ?? [],
      errors: raw["errors"] ?? [],
      artifacts,
      data,
    }) as ExtensionResult;
    // The record validator checks the remaining shapes (decimal metrics, table bounds).
    try {
      validateExtensionExecutionRecord({
        schema_version: 1,
        execution_id: "xe-validate",
        project_id: "p-validate",
        extension_id: "validate",
        build_id: "eb-0000000000000000",
        contribution: "x",
        entry: "x",
        source_sha256: "0".repeat(64),
        capability_sha256: "0".repeat(64),
        environment: {},
        params_sha256: "0".repeat(64),
        refs: [],
        status: "succeeded",
        created_by: { kind: "system" },
        created_at: new Date(0).toISOString(),
        limits: {
          runtime_max_sec: 1,
          memory_max_bytes: 1,
          cpu_quota_percent: 1,
          tasks_max: 1,
          output_max_bytes: 1,
        },
        enforcement: { limits: "advisory", network: "advisory", reasons: [] },
        result: r,
      });
    } catch (e) {
      if (e instanceof ProtocolValidationError) throw new Error(e.issues.slice(0, 3).join("; "));
      throw e;
    }
    return r;
  }

  private async logToMlflow(
    r: ExtensionExecutionRecord,
    result: ExtensionResult,
    dir: string,
  ): Promise<string> {
    const c = this.svc.tracking.client;
    const experimentId = await this.svc.tracking.ensureExperimentNow(r.project_id);
    const run = await c.createRun({
      experiment_id: experimentId,
      run_name: `${r.extension_id}/${r.contribution} ${r.execution_id.slice(3, 11)}`,
      tags: [
        { key: TAGS.project, value: r.project_id },
        { key: TAGS.kind, value: "extension_execution" },
        { key: "ablationkit.extension", value: r.extension_id },
        { key: "ablationkit.extension.build", value: r.build_id },
        { key: "ablationkit.extension.contribution", value: r.contribution },
        { key: "ablationkit.extension.source_sha256", value: r.source_sha256 },
        { key: "ablationkit.extension.execution", value: r.execution_id },
        ...(r.refs.length
          ? [
              {
                key: "ablationkit.extension.refs",
                value: r.refs
                  .map((x) => `${x.kind}:${x.id}`)
                  .join(",")
                  .slice(0, 5000),
              },
            ]
          : []),
        { key: "mlflow.note.content", value: result.summary.slice(0, 5000) || r.contribution },
      ],
    });
    const runId = run.info.run_id;
    try {
      const t = Date.now();
      const metrics = Object.entries(result.metrics)
        .map(([key, v]) => ({ key, value: Number(v), timestamp: t, step: 0 }))
        .filter((m) => Number.isFinite(m.value));
      if (metrics.length) await c.logBatch({ run_id: runId, metrics });
      for (const a of result.artifacts)
        await c.uploadArtifact(
          run.info,
          `extension/${a.path}`,
          readFileSync(join(dir, "outputs", a.path)),
        );
      await c.uploadArtifact(
        run.info,
        "extension/result.json",
        JSON.stringify(
          {
            execution_id: r.execution_id,
            extension_id: r.extension_id,
            build_id: r.build_id,
            source_sha256: r.source_sha256,
            lockfile_sha256: r.lockfile_sha256,
            environment: r.environment,
            result,
          },
          null,
          2,
        ),
      );
      await c.updateRun({ run_id: runId, status: "FINISHED", end_time: Date.now() });
    } catch (e) {
      await c.updateRun({ run_id: runId, status: "FAILED", end_time: Date.now() }).catch(() => {});
      throw e;
    }
    return runId;
  }
}

function contentType(name: string): string {
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
  return (
    {
      json: "application/json",
      csv: "text/csv",
      txt: "text/plain",
      md: "text/markdown",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      svg: "image/svg+xml",
      html: "text/plain",
    }[ext] ?? "application/octet-stream"
  );
}
