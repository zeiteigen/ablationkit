/** Everything a listener needs, built once by the coordinator. */
import type { OneTimeStore, TokenStore } from "@ablationkit/auth";
import type { StorageFinding } from "@ablationkit/core";
import type { TrustedOrigin } from "@ablationkit/protocol";
import type { MlflowSidecar, SidecarStatus, TrackingService } from "@ablationkit/tracking-mlflow";
import type { ComputeLimitService } from "./agents/compute-limit.ts";
import type { PolicyService } from "./agents/policy.ts";
import type { AgentSessionService } from "./agents/sessions.ts";
import type { BuildService } from "./builds.ts";
import type { DeploymentService } from "./compute/deployments.ts";
import type { JobService } from "./compute/jobs.ts";
import type { RemoteService } from "./compute/remote.ts";
import type { RemoteEndpoints } from "./compute/remote-endpoints.ts";
import type { TargetService } from "./compute/targets.ts";
import type { RuntimePaths } from "./config.ts";
import type { EventHub } from "./events.ts";
import type { ExtensionBackends } from "./extensions/backends.ts";
import type { ExtensionService } from "./extensions/host.ts";
import type { EvaluationService } from "./models/evaluations.ts";
import type { InferenceService } from "./models/inference.ts";
import type { ModelService } from "./models/models.ts";
import type { Notifier } from "./notifications.ts";
import type { ResearchService } from "./research/records.ts";
import type { ReviewService } from "./research/reviews.ts";
import type { TaskService } from "./research/tasks.ts";
import type { AuditLog } from "./state/audit.ts";
import type { BackupService } from "./state/backup.ts";
import type { ProjectRegistryService } from "./state/registry.ts";
import type { OperationsBridge } from "./tracking/bridge.ts";
import type { TrackingDoctorReport } from "./tracking/doctor.ts";
import type { AgendaService } from "./vault/agenda.ts";
import type { DirectionService } from "./vault/directions.ts";
import type { VaultService } from "./vault/vault.ts";
import type { WitnessService } from "./vault/witness.ts";

export interface StartupReport {
  /** What diagnosis found before any repair. */
  readonly findings: readonly StorageFinding[];
  /** What recovery did, as human-readable lines. */
  readonly repairs: readonly string[];
  /** Records that failed to load (`<kind>: <path>`); the coordinator started without them. */
  readonly unreadable: string[];
}

export interface ListenerUrls {
  human: string;
  agent: string;
  worker: string;
}

export interface Services {
  readonly paths: RuntimePaths;
  readonly now: () => Date;
  readonly startedAt: Date;
  readonly tokens: TokenStore;
  /** Agent session tokens `ablationkit mcp` mints through the login socket (ADR 0040). */
  readonly agentSessions: AgentSessionService;
  readonly loginCodes: OneTimeStore<{ origin: string }>;
  readonly audit: AuditLog;
  readonly events: EventHub;
  readonly registry: ProjectRegistryService;
  readonly startup: StartupReport;
  /** MLflow writes (outbox), mapping and the REST client (ADR 0010). */
  readonly tracking: TrackingService;
  /** The managed sidecar; undefined when tracking points at an MLflow started elsewhere (tests). */
  readonly sidecar: MlflowSidecar | undefined;
  readonly sidecarStatus: () => SidecarStatus;
  readonly backups: BackupService;
  readonly trackingDoctor: () => Promise<TrackingDoctorReport>;
  /** Local jobs, attempts, console journals and worker ingest (ADR 0011). */
  readonly jobs: JobService;
  /** Research records, the checkout export and the one-time import (ADR 0013). */
  readonly research: ResearchService;
  /** What the researcher has read, and the reading list (ADR 0048). */
  readonly reviews: ReviewService;
  /** Atomic notes, notebooks, the ledger and what the researcher has read of them (ADR 0049). */
  readonly vault: VaultService;
  /** The agent's account held against the coordinator's record (ADR 0056). */
  readonly witness: WitnessService;
  /** The researcher's directions to the agents, their threads and deliveries (ADR 0057). */
  readonly directions: DirectionService;
  /** The researcher's agenda, which agents work from, and what each session last read (ADR 0058). */
  readonly agenda: AgendaService;
  /** Authoritative project action policies, immutable revisions (§7.7.2, ADR 0037). */
  readonly policy: PolicyService;
  /** Compute weights and the agent compute limit: usage, admission, notices (ADR 0037). */
  readonly compute: ComputeLimitService;
  /** Research tasks agents create to group their work (ADR 0039). */
  readonly tasks: TaskService;
  /** Deployment gates: pinned models, TTLs and the project policy (§7.7.4 item 5). */
  readonly deployments: DeploymentService;
  /** Datasets, logged models and the registry over MLflow, plus provenance links (ADR 0019). */
  readonly models: ModelService;
  /** Classical evaluations run through the operations bridge (ADR 0019). */
  readonly evaluations: EvaluationService;
  /** One-shot prediction, sessions, comparisons and saved inference evidence (ADR 0020). */
  readonly inference: InferenceService;
  /** Project-scoped trusted extension backends and their public host brokers (ADR 0024). */
  readonly backends: ExtensionBackends;
  /** Level 1 extensions: builds, per-project approvals, mounts, the bridge and Python runs (ADR 0022). */
  readonly extensions: ExtensionService;
  /** Level 2 source builds: what runs now, reviewable builds, activation for the next start. */
  readonly builds: BuildService;
  /** Remote compute targets (ADR 0023). */
  readonly targets: TargetService;
  /** Remote attempts: bundles, the worker handshake, uploads, provider status (ADR 0023). */
  readonly remote: RemoteService;
  /** Remote research endpoints on Runpod (deployment launcher; ADR 0023 decision 20). */
  readonly endpoints: RemoteEndpoints;
  /** Supervised Python subprocesses for MLflow operations with no REST API (ADR 0019). */
  readonly bridge: OperationsBridge;
  /** Desktop notifications through libnotify (§7.6). */
  readonly notifier: Notifier;
  /** Filled in once the listeners are bound. */
  readonly urls: ListenerUrls;
  trustedOrigins: readonly TrustedOrigin[];
}
