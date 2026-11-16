/**
 * The Bun coordinator (spec §3.3): owns the runtime directory, runs startup recovery, and serves
 * the human, agent and worker listeners plus the local login socket. ADR 0009.
 */

import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LOGIN_CODE_TTL_MS, OneTimeStore, TokenStore } from "@ablationkit/auth";
import type { Shell } from "@ablationkit/compute-targets";
import { diagnoseStorage, recoverJsonFile } from "@ablationkit/core";
import {
  type ComputeTarget,
  validateCoordinatorSettings,
  validateTokenStore,
} from "@ablationkit/protocol";
import {
  MappingStore,
  MlflowClient,
  MlflowSidecar,
  Outbox,
  OutboxFullError,
  pinnedMlflowVersion,
  type SidecarHooks,
  type SidecarStatus,
  TrackingService,
} from "@ablationkit/tracking-mlflow";
import { ComputeLimitService } from "./agents/compute-limit.ts";
import { PolicyService } from "./agents/policy.ts";
import { AgentSessionService } from "./agents/sessions.ts";
import { BuildService } from "./builds.ts";
import { type DeploymentLauncher, DeploymentService } from "./compute/deployments.ts";
import { JobService } from "./compute/jobs.ts";
import { RemoteService } from "./compute/remote.ts";
import { RemoteEndpoints } from "./compute/remote-endpoints.ts";
import { TargetService } from "./compute/targets.ts";
import {
  loadSettings,
  type ResolvedSettings,
  resolveSettings,
  resolveWorkerHost,
  runtimePaths,
} from "./config.ts";
import { EventHub } from "./events.ts";
import { ExtensionBackends } from "./extensions/backends.ts";
import { BUNDLED_EXTENSIONS } from "./extensions/bundled.ts";
import { ExtensionService } from "./extensions/host.ts";
import { HttpError } from "./http.ts";
import { agentFetch } from "./listeners/agent.ts";
import { humanFetch } from "./listeners/human.ts";
import { loginSocketFetch } from "./listeners/login-socket.ts";
import { MAX_WORKER_BODY_BYTES, workerFetch } from "./listeners/worker.ts";
import { EvaluationService } from "./models/evaluations.ts";
import { InferenceService } from "./models/inference.ts";
import { ModelService } from "./models/models.ts";
import { LibnotifyNotifier, type Notifier, publishingNotifier } from "./notifications.ts";
import { ResearchService } from "./research/records.ts";
import { ReviewService } from "./research/reviews.ts";
import { TaskService } from "./research/tasks.ts";
import type { Services, StartupReport } from "./services.ts";
import { AuditLog, compact } from "./state/audit.ts";
import { BackupService } from "./state/backup.ts";
import { systemDiagnostics } from "./state/diagnostics.ts";
import { RuntimeLock } from "./state/lock.ts";
import { ProjectRegistryService } from "./state/registry.ts";
import {
  applyPendingRestore,
  CoordinatorMovedError,
  movedMarkerPath,
  readMovedMarker,
} from "./state/restore.ts";
import { DEFAULT_BRIDGE_SCRIPT, OperationsBridge } from "./tracking/bridge.ts";
import { trackingDoctor } from "./tracking/doctor.ts";
import { AgendaService } from "./vault/agenda.ts";
import { DirectionService } from "./vault/directions.ts";
import { VaultService } from "./vault/vault.ts";
import { WitnessService } from "./vault/witness.ts";

/** `packages/tracking-mlflow/env` in the checkout (Stage 18 packages it with the install). */
export const DEFAULT_MLFLOW_OPS_DIR = resolve(
  import.meta.dir,
  "../../../packages/tracking-mlflow/env",
);

export interface CoordinatorOptions {
  readonly home: string;
  /** Override `settings.json` (tests). */
  readonly settings?: Parameters<typeof resolveSettings>[0];
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
  /** SSE heartbeat interval (tests). */
  readonly heartbeatMs?: number;
  /** Use an MLflow server already running at this URL instead of the managed sidecar (tests). */
  readonly trackingUrl?: string;
  /** `packages/tracking-mlflow/env` directory with the pinned MLflow environment. */
  readonly mlflowOpsDir?: string;
  /** Sidecar test hooks (fake server, no uv). */
  readonly sidecarHooks?: SidecarHooks;
  /** Tracking flush interval (tests). */
  readonly trackingIntervalMs?: number;
  /** Job reconcile interval (tests). */
  readonly jobWatchdogMs?: number;
  /** Debounce before a research export (tests use 0: export synchronously). */
  readonly researchExportDelayMs?: number;
  /** Desktop notifications; default: libnotify when a display is available, off under tests. */
  readonly notifier?: Notifier;
  /** Starts deployments; default: local previews as inference sessions (Stage 13). */
  readonly deploymentLauncher?: DeploymentLauncher;
  /**
   * argv that runs the operations bridge in the managed environment (tests, or an MLflow started
   * elsewhere). Default: the sidecar's venv Python with packages/tracking-mlflow/env/bridge/ablationkit_bridge.py.
   */
  readonly bridgeCommand?: readonly string[];
  /** How often idle inference sessions are checked for expiry (tests). Default 5 s. */
  readonly inferenceSweepMs?: number;
  /** Trace retention sweep interval (tests set 0 to disable). Default one hour. */
  readonly llmRetentionSweepMs?: number;
  /** Start with every extension inactive (`coordinator start --safe-mode`, ADR 0022). */
  readonly safeMode?: boolean;
  /** Remote watchdog interval, ms (tests). */
  readonly remoteTickMs?: number;
  /** Replace SSH for a target (tests run "remote" commands locally). */
  readonly targetShell?: (t: ComputeTarget) => Shell | undefined;
}

type Server = ReturnType<typeof Bun.serve>;

class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

function recoverAll(paths: ReturnType<typeof runtimePaths>): StartupReport {
  // MLflow's own tree (venv, artifacts) and backups hold no coordinator journals, and grow large.
  // Collector spools are written by collectors, not the coordinator (single-writer rule).
  const findings = diagnoseStorage(paths.home, {
    exclude: [
      paths.mlflowDir,
      paths.backupsDir,
      paths.spoolDir,
      // Candidate clones a home kept from before ADR 0037 are agent-written Git trees: never touched.
      join(paths.home, "workspaces"),
      paths.operationsDir,
    ],
  });
  const repairs: string[] = [];
  const reports = [
    recoverJsonFile(paths.settings, { validate: validateCoordinatorSettings }),
    ProjectRegistryService.recover(paths.registry),
    recoverJsonFile(paths.tokens, { validate: validateTokenStore }),
  ];
  for (const r of reports) {
    const file = r.path;
    for (const a of r.actions) repairs.push(`${a.kind}: ${a.path} (${a.detail})`);
    if (r.status === "unrecoverable") {
      throw new StartupError(
        `cannot start: ${file} is unreadable and has no valid backup (${r.error}). Fix or move it aside.`,
      );
    }
  }
  return { findings, repairs, unreadable: [] };
}

export class Coordinator {
  private stopped = false;

  private constructor(
    readonly services: Services,
    private readonly lock: RuntimeLock,
    private readonly servers: { human: Server; agent: Server; worker: Server; login: Server },
    private readonly log: (line: string) => void,
  ) {}

  get urls(): Services["urls"] {
    return this.services.urls;
  }

  get loginSocket(): string {
    return this.services.paths.loginSocket;
  }

  static async start(options: CoordinatorOptions): Promise<Coordinator> {
    const log = options.log ?? ((l: string) => console.error(`coordinator: ${l}`));
    const now = options.now ?? (() => new Date());
    const paths = runtimePaths(options.home);
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    chmodSync(paths.home, 0o700);
    const { lock, staleReplaced } = RuntimeLock.acquire(paths.lock);
    try {
      if (staleReplaced) log(`replaced a stale lock at ${paths.lock}`);
      // A home handed to another machine never starts again (spec §5.3: no dual masters).
      const moved = readMovedMarker(paths.home);
      if (moved) throw new CoordinatorMovedError(moved, movedMarkerPath(paths.home));
      // A restore requested from the System page replaces this home before anything loads.
      await applyPendingRestore(paths.home, now, log);
      const startup = recoverAll(paths);
      for (const d of [dirname(paths.tokens), paths.stateDir])
        mkdirSync(d, { recursive: true, mode: 0o700 });
      const settings: ResolvedSettings = options.settings
        ? resolveSettings(options.settings)
        : loadSettings(paths.settings);
      const audit = new AuditLog(paths.auditDir, now);
      const events = new EventHub(paths.eventsDir, now, options.heartbeatMs);
      const journalRepairs = [...audit.recovery.actions, ...events.recovery.actions].map(
        (a) => `${a.kind}: ${a.path} (${a.detail})`,
      );
      const report: StartupReport = {
        findings: startup.findings,
        repairs: [...startup.repairs, ...journalRepairs],
        unreadable: [],
      };
      const unreadable = (what: string, path: string): void => {
        report.unreadable.push(`${what}: ${path}`);
        log(`startup finding: unreadable ${what} ${path}`);
      };
      for (const f of report.findings) log(`startup finding: ${f.kind} ${f.path}`);
      for (const r of report.repairs) log(`startup repair: ${r}`);

      const startedAt = now();
      const outbox = await Outbox.open(paths.outboxDir, {
        limits: { maxOps: settings.mlflow.outboxMaxOps, maxBytes: settings.mlflow.outboxMaxBytes },
        now,
      });
      const mappings = new MappingStore(paths.stateDir);
      const mappingProblems = mappings.load();
      for (const p of mappingProblems) unreadable("tracking mapping", p);
      const registry = new ProjectRegistryService(paths.registry, paths.stateDir, now);
      const opsDir = options.mlflowOpsDir ?? DEFAULT_MLFLOW_OPS_DIR;
      let sidecar: MlflowSidecar | undefined;
      const client = new MlflowClient({ url: options.trackingUrl ?? (() => sidecar?.activeUrl) });
      const tracking = new TrackingService({
        client,
        outbox,
        mappings,
        now,
        ...(options.trackingIntervalMs ? { intervalMs: options.trackingIntervalMs } : {}),
        onMappingChange: (m) =>
          events.publish(
            m.project_id,
            "tracking.run.sync",
            compact({
              ref: m.ref,
              sync_state: m.sync_state,
              mlflow_run_id: m.mlflow_run_id,
              job_id: m.job_id,
              attempt_id: m.attempt_id,
              last_error: m.last_error,
            }),
          ),
        onExperimentReady: (projectId, experimentId) =>
          events.publish(projectId, "tracking.experiment.ready", { experiment_id: experimentId }),
        onModelLogged: (info) => svcRef?.models.onModelLogged(info),
      });
      const backups = new BackupService({
        paths,
        now,
        quiesce: {
          mode: "tracking_paused",
          pause: () => tracking.pause(),
          resume: () => tracking.resume(),
          outboxStats: () => tracking.outbox.stats(),
        },
        projects: () => registry.list(),
        mlflowVersion: () => sidecar?.status().installed_version ?? sidecar?.pinnedVersion,
      });
      if (!options.trackingUrl) {
        sidecar = new MlflowSidecar({
          opsDir,
          dataDir: paths.mlflowDir,
          port: settings.mlflow.port,
          // The systemd unit sets ABLATIONKIT_UV: a user service has no login PATH.
          uv: process.env["ABLATIONKIT_UV"] ?? "uv",
          now,
          log,
          preUpgradeBackup: async (from, to) => {
            const b = await backups.create("pre_upgrade");
            audit.record({
              actor: { kind: "system" },
              listener: "internal",
              action: "mlflow.upgrade",
              outcome: "allowed",
              target: b.manifest.backup_id,
              details: { from, to },
            });
            return b.manifest.backup_id;
          },
          onState: (st) => {
            if (st.state === "healthy") tracking.mlflowAvailable();
          },
          ...(options.sidecarHooks ? { hooks: options.sidecarHooks } : {}),
        });
        if (!settings.mlflow.enabled) sidecar.disable();
      }
      const external = options.trackingUrl;
      const sidecarStatus = (): SidecarStatus =>
        sidecar
          ? sidecar.status()
          : {
              state: "external",
              since: startedAt.toISOString(),
              ...(external ? { url: external } : {}),
              pinned_version: pinnedMlflowVersion(opsDir),
              restarts: 0,
              paths: { data: "", database: "", artifacts: "", log: "", venv: "" },
            };
      const tokens = new TokenStore(paths.tokens, now);
      let workerUrl = "";
      let boundWorkerUrl = "";
      let svcRef: Services | undefined;
      let remoteRef: RemoteService | undefined;
      const jobs = new JobService({
        paths,
        now,
        registry,
        tokens,
        tracking,
        events,
        audit,
        log,
        settings: settings.jobs,
        workerUrl: () => workerUrl,
        ...(options.jobWatchdogMs ? { watchdogMs: options.jobWatchdogMs } : {}),
        prepareTrace: (pid, payload, ctx) =>
          (svcRef as Services).backends.ingest(pid, "trace.logged", payload, ctx),
        remote: () => remoteRef,
        sdkPythonPaths: (pid) => (svcRef as Services).backends.sdkPythonPaths(pid),
      });
      jobs.load();
      for (const p of jobs.loadProblems) unreadable("job record", p);
      const targets = new TargetService({
        dir: paths.targetsDir,
        now,
        ...(options.targetShell ? { shellFor: options.targetShell } : {}),
      });
      targets.load();
      for (const p of targets.loadProblems) unreadable("compute target", p);
      const remote = new RemoteService({
        sdkSources: (pid) => (svcRef as Services).backends.jobSdks(pid),
        paths,
        now,
        jobs,
        targets,
        tokens,
        events,
        audit,
        log,
        settings: settings.remote,
        spoolMaxBytes: settings.jobs.spoolMaxBytes,
        deliverDeadlineSec: settings.jobs.deliverDeadlineSec,
        maxArtifactBytes: settings.jobs.maxArtifactBytes,
        boundWorkerUrl: () => boundWorkerUrl,
        ...(options.remoteTickMs ? { tickMs: options.remoteTickMs } : {}),
      });
      remoteRef = remote;
      const tasks = new TaskService(() => svcRef as Services);
      const research = new ResearchService({
        stateDir: paths.stateDir,
        registry,
        jobs,
        tasks,
        events,
        audit,
        now,
        log,
        ...(options.researchExportDelayMs !== undefined
          ? { exportDelayMs: options.researchExportDelayMs }
          : {}),
      });
      research.load();
      for (const p of research.loadProblems) unreadable("research record", p);
      const policy = new PolicyService(paths.stateDir, now);
      const compute = new ComputeLimitService({
        svc: () => svcRef as Services,
        weightsPath: paths.computeWeights,
        stateDir: paths.stateDir,
        now,
      });
      compute.load();
      for (const p of compute.loadProblems) unreadable("compute weights", p);
      const baseNotifier =
        options.notifier ??
        new LibnotifyNotifier({
          now,
          enabled:
            process.env["NODE_ENV"] !== "test" &&
            process.env["ABLATIONKIT_NOTIFY"] !== "0" &&
            Boolean(process.env["DISPLAY"] || process.env["WAYLAND_DISPLAY"]),
        });
      // Browsers and the desktop app (local or remote) raise it with the Notification API.
      const notifier = publishingNotifier(baseNotifier, (n) => {
        if (n.project_id)
          events.publish(
            n.project_id,
            "notification.raised",
            compact({ key: n.key, title: n.title, body: n.body, urgency: n.urgency, link: n.link }),
          );
      });
      const endpoints = new RemoteEndpoints({
        svc: () => svcRef as Services,
        stateDir: paths.stateDir,
        now,
      });
      const deployments = new DeploymentService({
        svc: () => svcRef as Services,
        stateDir: paths.stateDir,
        now,
        notifier,
        launcher: options.deploymentLauncher ?? {
          // Local previews are inference sessions; research endpoints are Runpod pods.
          name: "inference-session+remote-endpoint",
          start: (d) =>
            d.kind === "preview_local"
              ? (svcRef as Services).inference.launcher().start(d)
              : d.kind === "remote_research"
                ? endpoints.start(d)
                : Promise.reject(
                    new HttpError(
                      422,
                      "unsupported_deployment",
                      `AblationKit does not launch ${d.kind} endpoints; the request is recorded and gated only`,
                    ),
                  ),
          stop: (d) =>
            d.kind === "remote_research"
              ? endpoints.stop(d)
              : (svcRef as Services).inference.launcher().stop(d),
          check: (d) => endpoints.check(d),
        },
      });
      for (const p of deployments.load(registry.list().map((x) => x.project_id)))
        unreadable("deployment", p);
      const bridgeEnv = process.env["ABLATIONKIT_BRIDGE_PYTHON"];
      const bridge = new OperationsBridge({
        dir: paths.operationsDir,
        uv: process.env["ABLATIONKIT_UV"] ?? "uv",
        trackingUrl: () => client.baseUrl,
        supervisor: settings.jobs.supervisor,
        managedCommand: () => {
          if (options.bridgeCommand) return [...options.bridgeCommand];
          const py = sidecar ? join(sidecar.status().paths.venv, "bin", "python") : bridgeEnv;
          return py && existsSync(py) ? [py, "-I", DEFAULT_BRIDGE_SCRIPT] : undefined;
        },
      });
      const models = new ModelService({
        svc: () => svcRef as Services,
        stateDir: paths.stateDir,
        now,
      });
      const evaluations = new EvaluationService({
        svc: () => svcRef as Services,
        stateDir: paths.stateDir,
        bridge,
        now,
      });
      evaluations.load(registry.list().map((x) => x.project_id));
      for (const p of evaluations.loadProblems) unreadable("evaluation", p);
      const inference = new InferenceService({
        svc: () => svcRef as Services,
        stateDir: paths.stateDir,
        bridge,
        now,
        ...(options.inferenceSweepMs !== undefined ? { sweepMs: options.inferenceSweepMs } : {}),
      });
      inference.load(registry.list().map((x) => x.project_id));
      for (const p of inference.loadProblems) unreadable("inference record", p);
      const safeMode =
        options.safeMode === true ||
        settings.extensions.safeMode ||
        process.env["ABLATIONKIT_SAFE_MODE"] === "1";
      const backends = new ExtensionBackends({
        svc: () => svcRef as Services,
        bundles: BUNDLED_EXTENSIONS,
        safeMode,
        ...(options.llmRetentionSweepMs !== undefined
          ? { retentionSweepMs: options.llmRetentionSweepMs }
          : {}),
      });
      const extensions = new ExtensionService({
        svc: () => svcRef as Services,
        stateDir: paths.stateDir,
        homeDir: paths.home,
        now,
        safeMode,
        uv: process.env["ABLATIONKIT_UV"] ?? "uv",
        supervisor: settings.jobs.supervisor,
        maxConcurrent: settings.extensions.maxConcurrent,
        requireApproval: settings.extensions.requireApproval,
      });
      extensions.load(registry.list().map((x) => x.project_id));
      for (const p of extensions.loadProblems) unreadable("extension record", p);
      if (safeMode) log("safe mode: every extension is inactive");
      const svc: Services = {
        paths,
        now,
        startedAt,
        tokens,
        agentSessions: new AgentSessionService(() => svcRef as Services),
        loginCodes: new OneTimeStore<{ origin: string }>(LOGIN_CODE_TTL_MS, now),
        audit,
        events,
        registry,
        startup: report,
        tracking,
        sidecar,
        sidecarStatus,
        backups,
        trackingDoctor: () =>
          trackingDoctor({
            paths,
            now,
            tracking,
            sidecar,
            sidecarStatus,
            registry,
            mappingProblems,
          }),
        jobs,
        research,
        reviews: new ReviewService(() => svcRef as Services),
        vault: new VaultService(() => svcRef as Services),
        witness: new WitnessService(() => svcRef as Services),
        directions: new DirectionService(() => svcRef as Services),
        agenda: new AgendaService(() => svcRef as Services),
        policy,
        compute,
        tasks,
        deployments,
        endpoints,
        models,
        evaluations,
        inference,
        backends,
        extensions,
        builds: new BuildService({
          home: paths.home,
          now,
          audit: (action, actor, details) =>
            audit.record({
              actor: compact({ kind: "human" as const, id: actor.id }),
              listener: "human",
              action,
              outcome: "allowed",
              details,
            }),
        }),
        targets,
        remote,
        bridge,
        notifier,
        urls: { human: "", agent: "", worker: "" },
        trustedOrigins: settings.trustedOrigins ?? [],
      };
      svcRef = svc;

      let humanPort = 0;
      let agentPort = 0;
      const human = Bun.serve({
        hostname: settings.human.host,
        port: settings.human.port,
        idleTimeout: 60,
        maxRequestBodySize: 2 * 1024 * 1024,
        fetch: humanFetch(svc, () => humanPort),
      });
      const agent = Bun.serve({
        hostname: settings.agent.host,
        port: settings.agent.port,
        idleTimeout: 60,
        maxRequestBodySize: 2 * 1024 * 1024,
        fetch: agentFetch(svc, () => agentPort),
      });
      const workerHost = resolveWorkerHost(settings.worker.host);
      const worker = Bun.serve({
        hostname: workerHost,
        port: settings.worker.port,
        idleTimeout: 60,
        // Artifact uploads stream through this listener; JSON routes enforce their own limit.
        maxRequestBodySize: Math.max(
          MAX_WORKER_BODY_BYTES,
          settings.jobs.maxArtifactBytes + 65_536,
        ),
        fetch: workerFetch(svc),
      });
      humanPort = human.port ?? 0;
      agentPort = agent.port ?? 0;
      const hostFor = (h: string): string => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);
      svc.urls.human = `http://${hostFor(settings.human.host)}:${humanPort}`;
      svc.urls.agent = `http://${hostFor(settings.agent.host)}:${agentPort}`;
      svc.urls.worker = `http://${hostFor(workerHost)}:${worker.port}`;
      boundWorkerUrl = svc.urls.worker;
      // Collectors run on this machine: reach the worker listener over loopback when it binds wide.
      const wh = workerHost;
      workerUrl = `http://${wh === "0.0.0.0" || wh === "::" ? "127.0.0.1" : hostFor(wh)}:${worker.port}`;
      if (!settings.trustedOrigins)
        svc.trustedOrigins = [{ origin: `http://localhost:${humanPort}` }];

      mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
      chmodSync(paths.runDir, 0o700);
      rmSync(paths.loginSocket, { force: true });
      const login = Bun.serve({ unix: paths.loginSocket, fetch: loginSocketFetch(svc) });
      chmodSync(paths.loginSocket, 0o600);

      // Tracking: deliver queued writes, make sure every project has its experiment, start MLflow.
      tracking.start();
      for (const p of registry.list()) {
        try {
          tracking.ensureProject(p.project_id);
        } catch (e) {
          if (!(e instanceof OutboxFullError)) throw e;
          log(`tracking outbox full; ${p.project_id}'s experiment will be created later`);
        }
      }
      if (sidecar && settings.mlflow.enabled) void sidecar.start();
      // Jobs: re-point live collectors at this listener, reconcile vanished ones.
      jobs.start();
      compute.start();
      svc.agentSessions.start();
      // Remote attempts: staging a crash interrupted is not retried; watch workers and providers.
      remote.recover();
      remote.startWatchdog();
      for (const p of tasks.load()) unreadable("task record", p);
      // Deployments: nothing is assumed to survive a restart (criterion 34).
      deployments.start();
      // Evaluations: one a previous coordinator left running is interrupted, never rerun.
      evaluations.start();
      // Inference sessions are local processes: none survives a restart (criterion 9e).
      inference.start();
      // Backends recover interrupted operations; host-owned retention continues while disabled.
      await backends.startAll();
      // Extension executions a previous coordinator left running are interrupted, never rerun.
      extensions.start();
      // Research: projects registered before research records existed import their export once.
      for (const p of registry.list()) {
        try {
          research.importOnce(p.project_id);
          // Re-export: an export lost to a crash inside the debounce window is rewritten, and
          // hand edits made while the coordinator was down are detected.
          research.scheduleExport(p.project_id);
        } catch (e) {
          log(`research import for ${p.project_id} failed: ${(e as Error).message}`);
        }
      }

      // Startup diagnostics (spec §13): the System page re-runs them on demand.
      const diagnosis = systemDiagnostics(svc);
      for (const c of diagnosis.checks)
        if (c.status !== "ok" && c.name !== "mlflow sidecar")
          log(`startup diagnostic: ${c.status} ${c.name}: ${c.detail}`);

      audit.record({
        actor: { kind: "system" },
        listener: "internal",
        action: "coordinator.start",
        outcome: "allowed",
        details: {
          pid: process.pid,
          urls: { ...svc.urls },
          findings: report.findings.length,
          repairs: report.repairs.length,
          diagnosis: diagnosis.status,
          ...(svc.extensions.safeMode ? { safe_mode: true } : {}),
        },
      });
      log(
        `human ${svc.urls.human} · agent ${svc.urls.agent} · worker ${svc.urls.worker} · login ${paths.loginSocket}`,
      );
      return new Coordinator(svc, lock, { human, agent, worker, login }, log);
    } catch (e) {
      lock.release();
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Stop everything that can still publish events before closing the event journal.
    this.services.jobs.stop();
    this.services.compute.stop();
    this.services.agentSessions.stop();
    this.services.remote.stop();
    this.services.research.stop();
    this.services.deployments.stopAll();
    await this.services.evaluations.shutdown();
    await this.services.inference.shutdown();
    await this.services.backends.shutdown();
    await this.services.extensions.shutdown();
    await Promise.all(Object.values(this.servers).map((s) => s.stop(true)));
    await this.services.tracking.stop();
    await this.services.sidecar?.stop();
    this.services.events.close();
    this.services.tracking.outbox.close();
    rmSync(this.services.paths.loginSocket, { force: true });
    this.services.audit.record({
      actor: { kind: "system" },
      listener: "internal",
      action: "coordinator.stop",
      outcome: "allowed",
    });
    this.services.audit.close();
    this.lock.release();
    this.log("stopped");
  }
}
