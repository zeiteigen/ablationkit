import type { TObject } from "@sinclair/typebox";
import { Agenda, AgendaSeen } from "./agenda.ts";
import { TokenStore } from "./auth.ts";
import { ComputeLimitState, ComputeWeights } from "./compute.ts";
import {
  ContainerConfig,
  ContainerEnvironment,
  ContainerSessionRecord,
  EgressRecord,
} from "./containers.ts";
import { AuditRecord, CoordinatorSettings, ProjectRegistry } from "./coordinator.ts";
import { DeploymentRecord } from "./deployments.ts";
import { ResearchDirection } from "./directions.ts";
import { EventEnvelope, JournalEvent } from "./events.ts";
import {
  ExtensionBuildRecord,
  ExtensionExecutionRecord,
  ExtensionManifest,
  ExtensionState,
  SourceBuildRecord,
} from "./extensions.ts";
import { InferenceEvidenceRecord, InferenceSessionRecord } from "./inference.ts";
import { AttemptRecord, CollectorManifest, ConsoleRecord, IngestState, JobRecord } from "./jobs.ts";
import { EvaluationRecord, ModelLink, RegistryVersionLink } from "./lifecycle.ts";
import {
  GoldenExample,
  GoldenSetRecord,
  LlmEvaluationRecord,
  LlmEvidenceRecord,
  LlmSettings,
} from "./llm.ts";
import {
  CoordinatorMovedMarker,
  DesktopConfig,
  PendingRestore,
  RestoreRecord,
} from "./operations.ts";
import { ProjectActionPolicy } from "./policy.ts";
import { ProjectManifest } from "./project.ts";
import {
  ComputeTarget,
  ResumableUpload,
  RunBundleManifest,
  WorkerCredentials,
  WorkerHandshake,
  WorkerHandshakeReply,
} from "./remote.ts";
import { ResearchExportState, ResearchRecord, ReviewState } from "./research.ts";
import { ResearchTask, upgradeTaskV1 } from "./tasks.ts";
import {
  BackupManifest,
  MlflowSidecarState,
  TrackingOutboxRecord,
  TrackingProjectLinks,
  TrackingRunMapping,
} from "./tracking.ts";
import { compileStoredValidator, compileValidator } from "./validate.ts";
import { VaultIndex, VaultNote, VaultReadState, VaultSetAside, VaultWork } from "./vault.ts";

export * from "./agenda.ts";
export * from "./auth.ts";
export * from "./common.ts";
export * from "./compute.ts";
export * from "./containers.ts";
export * from "./coordinator.ts";
export * from "./deployments.ts";
export * from "./directions.ts";
export * from "./events.ts";
export * from "./extensions.ts";
export * from "./inference.ts";
export * from "./jobs.ts";
export * from "./lifecycle.ts";
export * from "./llm.ts";
export * from "./operations.ts";
export * from "./policy.ts";
export * from "./project.ts";
export * from "./remote.ts";
export * from "./research.ts";
export * from "./tasks.ts";
export * from "./tracking.ts";
export * from "./validate.ts";
export * from "./vault.ts";

export interface SchemaEntry {
  /** Name shared by the TypeScript type, the JSON Schema title and the Python model. */
  readonly name: string;
  /** Current `schema_version`. Bump it, and add a core migration, for any incompatible change. */
  readonly version: number;
  /** File stem under packages/protocol/schemas/. */
  readonly file: string;
  readonly schema: TObject;
}

/** Every top-level protocol schema. The generator emits JSON Schema, Python models and docs from this list. */
export const SCHEMAS: readonly SchemaEntry[] = [
  { name: "EventEnvelope", version: 1, file: "event-envelope.v1", schema: EventEnvelope },
  { name: "JournalEvent", version: 1, file: "journal-event.v1", schema: JournalEvent },
  { name: "ProjectManifest", version: 1, file: "project-manifest.v1", schema: ProjectManifest },
  { name: "ProjectRegistry", version: 1, file: "project-registry.v1", schema: ProjectRegistry },
  {
    name: "CoordinatorSettings",
    version: 1,
    file: "coordinator-settings.v1",
    schema: CoordinatorSettings,
  },
  { name: "AuditRecord", version: 1, file: "audit-record.v1", schema: AuditRecord },
  { name: "TokenStore", version: 1, file: "token-store.v1", schema: TokenStore },
  {
    name: "TrackingRunMapping",
    version: 1,
    file: "tracking-run-mapping.v1",
    schema: TrackingRunMapping,
  },
  {
    name: "TrackingProjectLinks",
    version: 1,
    file: "tracking-project-links.v1",
    schema: TrackingProjectLinks,
  },
  {
    name: "TrackingOutboxRecord",
    version: 1,
    file: "tracking-outbox-record.v1",
    schema: TrackingOutboxRecord,
  },
  {
    name: "MlflowSidecarState",
    version: 1,
    file: "mlflow-sidecar-state.v1",
    schema: MlflowSidecarState,
  },
  { name: "BackupManifest", version: 1, file: "backup-manifest.v1", schema: BackupManifest },
  { name: "RestoreRecord", version: 1, file: "restore-record.v1", schema: RestoreRecord },
  { name: "PendingRestore", version: 1, file: "pending-restore.v1", schema: PendingRestore },
  { name: "DesktopConfig", version: 1, file: "desktop-config.v1", schema: DesktopConfig },
  {
    name: "CoordinatorMovedMarker",
    version: 1,
    file: "coordinator-moved-marker.v1",
    schema: CoordinatorMovedMarker,
  },
  { name: "JobRecord", version: 1, file: "job-record.v1", schema: JobRecord },
  { name: "AttemptRecord", version: 1, file: "attempt-record.v1", schema: AttemptRecord },
  { name: "IngestState", version: 1, file: "ingest-state.v1", schema: IngestState },
  { name: "ConsoleRecord", version: 1, file: "console-record.v1", schema: ConsoleRecord },
  {
    name: "CollectorManifest",
    version: 1,
    file: "collector-manifest.v1",
    schema: CollectorManifest,
  },
  { name: "ComputeTarget", version: 1, file: "compute-target.v1", schema: ComputeTarget },
  { name: "ComputeWeights", version: 1, file: "compute-weights.v1", schema: ComputeWeights },
  {
    name: "ComputeLimitState",
    version: 1,
    file: "compute-limit-state.v1",
    schema: ComputeLimitState,
  },
  {
    name: "RunBundleManifest",
    version: 1,
    file: "run-bundle-manifest.v1",
    schema: RunBundleManifest,
  },
  { name: "WorkerHandshake", version: 1, file: "worker-handshake.v1", schema: WorkerHandshake },
  {
    name: "WorkerHandshakeReply",
    version: 1,
    file: "worker-handshake-reply.v1",
    schema: WorkerHandshakeReply,
  },
  { name: "ResumableUpload", version: 1, file: "resumable-upload.v1", schema: ResumableUpload },
  {
    name: "WorkerCredentials",
    version: 1,
    file: "worker-credentials.v1",
    schema: WorkerCredentials,
  },
  { name: "ResearchRecord", version: 1, file: "research-record.v1", schema: ResearchRecord },
  {
    name: "ResearchExportState",
    version: 1,
    file: "research-export-state.v1",
    schema: ResearchExportState,
  },
  { name: "ReviewState", version: 1, file: "review-state.v1", schema: ReviewState },
  { name: "VaultNote", version: 1, file: "vault-note.v1", schema: VaultNote },
  { name: "VaultIndex", version: 1, file: "vault-index.v1", schema: VaultIndex },
  { name: "VaultReadState", version: 1, file: "vault-read-state.v1", schema: VaultReadState },
  { name: "VaultWork", version: 1, file: "vault-work.v1", schema: VaultWork },
  { name: "VaultSetAside", version: 1, file: "vault-set-aside.v1", schema: VaultSetAside },
  { name: "Agenda", version: 1, file: "agenda.v1", schema: Agenda },
  { name: "AgendaSeen", version: 1, file: "agenda-seen.v1", schema: AgendaSeen },
  {
    name: "ProjectActionPolicy",
    version: 2,
    file: "project-action-policy.v2",
    schema: ProjectActionPolicy,
  },
  { name: "ResearchTask", version: 2, file: "research-task.v2", schema: ResearchTask },
  {
    name: "ResearchDirection",
    version: 1,
    file: "research-direction.v1",
    schema: ResearchDirection,
  },
  { name: "ContainerConfig", version: 1, file: "container-config.v1", schema: ContainerConfig },
  {
    name: "ContainerSessionRecord",
    version: 1,
    file: "container-session-record.v1",
    schema: ContainerSessionRecord,
  },
  { name: "EgressRecord", version: 1, file: "egress-record.v1", schema: EgressRecord },
  {
    name: "ContainerEnvironment",
    version: 1,
    file: "container-environment.v1",
    schema: ContainerEnvironment,
  },
  {
    name: "DeploymentRecord",
    version: 1,
    file: "deployment-record.v1",
    schema: DeploymentRecord,
  },
  { name: "ModelLink", version: 1, file: "model-link.v1", schema: ModelLink },
  {
    name: "RegistryVersionLink",
    version: 1,
    file: "registry-version-link.v1",
    schema: RegistryVersionLink,
  },
  {
    name: "EvaluationRecord",
    version: 1,
    file: "evaluation-record.v1",
    schema: EvaluationRecord,
  },
  {
    name: "InferenceSessionRecord",
    version: 1,
    file: "inference-session-record.v1",
    schema: InferenceSessionRecord,
  },
  {
    name: "InferenceEvidenceRecord",
    version: 1,
    file: "inference-evidence-record.v1",
    schema: InferenceEvidenceRecord,
  },
  { name: "LlmSettings", version: 1, file: "llm-settings.v1", schema: LlmSettings },
  { name: "GoldenSetRecord", version: 1, file: "golden-set-record.v1", schema: GoldenSetRecord },
  {
    name: "LlmEvaluationRecord",
    version: 1,
    file: "llm-evaluation-record.v1",
    schema: LlmEvaluationRecord,
  },
  {
    name: "LlmEvidenceRecord",
    version: 1,
    file: "llm-evidence-record.v1",
    schema: LlmEvidenceRecord,
  },
  {
    name: "ExtensionManifest",
    version: 1,
    file: "extension-manifest.v1",
    schema: ExtensionManifest,
  },
  { name: "ExtensionState", version: 1, file: "extension-state.v1", schema: ExtensionState },
  {
    name: "ExtensionBuildRecord",
    version: 1,
    file: "extension-build-record.v1",
    schema: ExtensionBuildRecord,
  },
  {
    name: "ExtensionExecutionRecord",
    version: 1,
    file: "extension-execution-record.v1",
    schema: ExtensionExecutionRecord,
  },
  {
    name: "SourceBuildRecord",
    version: 1,
    file: "source-build-record.v1",
    schema: SourceBuildRecord,
  },
];

/** An actor written before ADR 0039 named the task its agent token was bound to. */
function withoutTask(actor: unknown): unknown {
  if (!actor || typeof actor !== "object") return actor;
  const { task_id: _t, ...rest } = actor as Record<string, unknown>;
  return rest;
}

export const validateEventEnvelope = compileValidator(EventEnvelope);
export const validateJournalEvent = compileValidator(JournalEvent);
export const validateProjectManifest = compileValidator(ProjectManifest);
export const validateProjectRegistry = compileValidator(ProjectRegistry);
/** The Git broker's settings and the trusted origins' passkey RP IDs are gone (ADR 0037). */
export const validateCoordinatorSettings = compileStoredValidator(
  CoordinatorSettings,
  ({ git: _g, ...rest }) => rest,
);
/** Entries written before passkeys were removed (ADR 0037) load without `step_up`. */
export const validateAuditRecord = compileStoredValidator(AuditRecord);
/** Agent tokens bound to a task before ADR 0039 load bound to its project. */
export const validateTokenStore = compileStoredValidator(TokenStore, (doc) => ({
  ...doc,
  tokens: ((doc["tokens"] as Record<string, unknown>[] | undefined) ?? []).map((t) => {
    const { task_id: _t, ...scope } = (t["scope"] ?? {}) as Record<string, unknown>;
    return { ...t, scope };
  }),
}));
export const validateTrackingRunMapping = compileStoredValidator(TrackingRunMapping);
export const validateTrackingProjectLinks = compileValidator(TrackingProjectLinks);
export const validateTrackingOutboxRecord = compileValidator(TrackingOutboxRecord);
export const validateMlflowSidecarState = compileValidator(MlflowSidecarState);
export const validateBackupManifest = compileValidator(BackupManifest);
export const validateRestoreRecord = compileValidator(RestoreRecord);
export const validatePendingRestore = compileValidator(PendingRestore);
export const validateDesktopConfig = compileValidator(DesktopConfig);
export const validateCoordinatorMovedMarker = compileValidator(CoordinatorMovedMarker);
/** Protected evaluation protocols are gone (ADR 0037). */
export const validateJobRecord = compileStoredValidator(
  JobRecord,
  ({ protocol: _p, ...rest }) => rest,
);
export const validateAttemptRecord = compileValidator(AttemptRecord);
export const validateIngestState = compileValidator(IngestState);
export const validateConsoleRecord = compileValidator(ConsoleRecord);
export const validateCollectorManifest = compileValidator(CollectorManifest);
export const validateComputeTarget = compileValidator(ComputeTarget);
export const validateComputeWeights = compileValidator(ComputeWeights);
export const validateComputeLimitState = compileValidator(ComputeLimitState);
export const validateRunBundleManifest = compileValidator(RunBundleManifest);
export const validateWorkerHandshake = compileValidator(WorkerHandshake);
export const validateResumableUpload = compileValidator(ResumableUpload);
/**
 * Before ADR 0039 an agent's task came from its token, as `created_by.task_id`: it becomes a
 * `task:ID` link, which is how a record names its task now.
 */
export const validateResearchRecord = compileStoredValidator(ResearchRecord, (doc) => {
  const taskId = (doc["created_by"] as Record<string, unknown> | undefined)?.["task_id"];
  const links = (doc["links"] as { kind?: string; id?: string }[] | undefined) ?? [];
  return {
    ...doc,
    created_by: withoutTask(doc["created_by"]),
    updated_by: withoutTask(doc["updated_by"]),
    links:
      typeof taskId === "string" && !links.some((l) => l.kind === "task" && l.id === taskId)
        ? [...links, { kind: "task", id: taskId }]
        : links,
  };
});
export const validateResearchExportState = compileValidator(ResearchExportState);
export const validateReviewState = compileValidator(ReviewState);
export const validateVaultNote = compileValidator(VaultNote);
export const validateVaultIndex = compileValidator(VaultIndex);
export const validateVaultReadState = compileValidator(VaultReadState);
export const validateVaultWork = compileValidator(VaultWork);
export const validateVaultSetAside = compileValidator(VaultSetAside);
export const validateAgenda = compileValidator(Agenda);
export const validateAgendaSeen = compileValidator(AgendaSeen);
export const validateProjectActionPolicy = compileValidator(ProjectActionPolicy);
/** Tasks written before ADR 0039 (dispatch, T3 bindings, plans, modes) load as lean tasks. */
export const validateResearchTask = compileStoredValidator(ResearchTask, upgradeTaskV1);
export const validateResearchDirection = compileValidator(ResearchDirection);
export const validateContainerConfig = compileValidator(ContainerConfig);
export const validateContainerSessionRecord = compileValidator(ContainerSessionRecord);
export const validateEgressRecord = compileValidator(EgressRecord);
export const validateContainerEnvironment = compileValidator(ContainerEnvironment);
/**
 * Approvals are gone (ADR 0037): a request that was waiting for one, or was rejected, is closed.
 * A requester's task from its token is gone too (ADR 0039).
 */
export const validateDeploymentRecord = compileStoredValidator(
  DeploymentRecord,
  ({ approval_id: _a, requested_by, ...doc }) => {
    const rest: Record<string, unknown> = { ...doc, requested_by: withoutTask(requested_by) };
    return rest["status"] === "pending_approval" || rest["status"] === "rejected"
      ? {
          ...rest,
          status: "invalidated",
          status_reason:
            rest["status"] === "rejected"
              ? (rest["status_reason"] ?? "rejected by the researcher")
              : "waited for an approval; approvals were removed (ADR 0037), request it again",
        }
      : rest;
  },
);
export const validateModelLink = compileValidator(ModelLink);
export const validateRegistryVersionLink = compileValidator(RegistryVersionLink);
export const validateEvaluationRecord = compileValidator(EvaluationRecord);
export const validateInferenceSessionRecord = compileValidator(InferenceSessionRecord);
export const validateInferenceEvidenceRecord = compileValidator(InferenceEvidenceRecord);
export const validateLlmSettings = compileValidator(LlmSettings);
export const validateGoldenSetRecord = compileValidator(GoldenSetRecord);
export const validateGoldenExample = compileValidator(GoldenExample);
export const validateLlmEvaluationRecord = compileValidator(LlmEvaluationRecord);
export const validateLlmEvidenceRecord = compileValidator(LlmEvidenceRecord);
export const validateExtensionManifest = compileValidator(ExtensionManifest);
/** Approvals and manifests written before passkeys were removed (ADR 0037) load without `step_up`. */
export const validateExtensionState = compileStoredValidator(ExtensionState);
export const validateExtensionBuildRecord = compileStoredValidator(ExtensionBuildRecord);
export const validateExtensionExecutionRecord = compileStoredValidator(ExtensionExecutionRecord);
export const validateSourceBuildRecord = compileValidator(SourceBuildRecord);
