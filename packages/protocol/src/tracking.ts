/**
 * MLflow tracking integration state (spec §4.2, §5.5, §5.8, §6.1; ADR 0010). These files hold
 * AblationKit's side of the integration only: run mappings, project-to-experiment links, the
 * temporary durable outbox and backup manifests. MLflow stays the canonical store of tracking data.
 */
import { type Static, Type } from "@sinclair/typebox";
import {
  AttemptId,
  describe,
  JobId,
  ProjectId,
  SequenceNumber,
  StudyId,
  TaskId,
  Timestamp,
  VariantId,
} from "./common.ts";

export const MlflowExperimentId = Type.String({
  title: "MlflowExperimentId",
  description: "MLflow experiment ID, as MLflow returns it.",
  pattern: "^[A-Za-z0-9_-]{1,64}$",
});

export const MlflowRunId = Type.String({
  title: "MlflowRunId",
  description: "MLflow run ID, as MLflow returns it.",
  pattern: "^[A-Za-z0-9_-]{1,64}$",
});

export const TrackingRunRef = Type.String({
  title: "TrackingRunRef",
  description:
    "AblationKit's key for one tracked run: the attempt ID for job attempts, `mr-<id>` for runs created by hand.",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});

export const TrackingSyncState = Type.Union(
  [Type.Literal("tracking_pending"), Type.Literal("synced"), Type.Literal("sync_failed")],
  {
    title: "TrackingSyncState",
    description:
      "Whether MLflow has acknowledged every queued write: `tracking_pending` (queued or retrying), `synced`, or `sync_failed` (a write was rejected; retryable).",
  },
);
export type TrackingSyncState = Static<typeof TrackingSyncState>;

const MlflowExperimentName = Type.String({
  title: "MlflowExperimentName",
  description: "MLflow experiment name.",
  minLength: 1,
  maxLength: 500,
});

const ShortText = Type.String({ minLength: 1, maxLength: 2000 });

/** `state/<project-id>/tracking/runs/<ref>.json`. */
export const TrackingRunMapping = Type.Object(
  {
    schema_version: Type.Literal(1),
    ref: TrackingRunRef,
    kind: Type.Union([Type.Literal("attempt"), Type.Literal("manual"), Type.Literal("import")], {
      description:
        "`attempt`: one execution attempt of a job. `manual`: created from the UI/CLI. `import`: a run that happened outside AblationKit, imported from its files (ADR 0043).",
    }),
    project_id: ProjectId,
    experiment_name: describe(MlflowExperimentName, "Target experiment, `ak/<project-id>`."),
    experiment_id: Type.Optional(
      describe(MlflowExperimentId, "Set once MLflow acknowledges the experiment."),
    ),
    mlflow_run_id: Type.Optional(
      describe(MlflowRunId, "Set once MLflow acknowledges the run. Never invented."),
    ),
    job_id: Type.Optional(JobId),
    attempt_id: Type.Optional(AttemptId),
    study_id: Type.Optional(StudyId),
    variant_id: Type.Optional(VariantId),
    task_id: Type.Optional(TaskId),
    run_name: Type.Optional(Type.String({ minLength: 1, maxLength: 250 })),
    sync_state: TrackingSyncState,
    last_error: Type.Optional(describe(ShortText, "Last rejected or failed write, for display.")),
    created_at: Timestamp,
    updated_at: Timestamp,
    synced_at: Type.Optional(describe(Timestamp, "When the last queued write was acknowledged.")),
    logged_model_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    registered_model_name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    registered_model_version: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
    evaluation_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    trace_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    deployment_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    mlproject_entrypoint: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    import_source: Type.Optional(
      describe(
        Type.String({ minLength: 1, maxLength: 500 }),
        "`import` runs: where the run's files were (a path in the checkout); one import per source.",
      ),
    ),
  },
  {
    title: "TrackingRunMapping",
    description:
      "Persisted mapping of one AblationKit attempt (or manual run) to its MLflow run, with sync state. Execution status lives with the job, not here.",
    additionalProperties: false,
  },
);
export type TrackingRunMapping = Static<typeof TrackingRunMapping>;

export const ImportedExperiment = Type.Object(
  {
    experiment_id: MlflowExperimentId,
    name: MlflowExperimentName,
    linked_at: Timestamp,
  },
  {
    title: "ImportedExperiment",
    description: "A historical MLflow experiment linked to a project read-only. Never rewritten.",
    additionalProperties: false,
  },
);
export type ImportedExperiment = Static<typeof ImportedExperiment>;

/** `state/<project-id>/tracking/experiments.json`. */
export const TrackingProjectLinks = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    experiment_name: describe(MlflowExperimentName, "Always `ak/<project-id>`."),
    experiment_id: Type.Optional(
      describe(MlflowExperimentId, "Set once MLflow acknowledges the project experiment."),
    ),
    imports: Type.Array(ImportedExperiment, { description: "Read-only linked experiments." }),
  },
  {
    title: "TrackingProjectLinks",
    description: "A project's MLflow experiment and its read-only imported experiments.",
    additionalProperties: false,
  },
);
export type TrackingProjectLinks = Static<typeof TrackingProjectLinks>;

export const TrackingOpKind = Type.Union(
  [
    Type.Literal("ensure_experiment"),
    Type.Literal("create_run"),
    Type.Literal("log_batch"),
    Type.Literal("update_run"),
    Type.Literal("log_inputs"),
    Type.Literal("log_model"),
    Type.Literal("log_trace"),
  ],
  { title: "TrackingOpKind", description: "Kind of queued MLflow write." },
);
export type TrackingOpKind = Static<typeof TrackingOpKind>;

export const TrackingOp = Type.Object(
  {
    kind: TrackingOpKind,
    project_id: ProjectId,
    ref: Type.Optional(
      describe(TrackingRunRef, "Run the write belongs to; absent for experiment writes."),
    ),
    payload: Type.Record(Type.String(), Type.Unknown(), {
      description: "Kind-specific body, validated by the tracking package before it is queued.",
    }),
    enqueued_at: Timestamp,
    bytes: Type.Integer({ minimum: 0, description: "Serialized payload size, for the bound." }),
  },
  {
    title: "TrackingOp",
    description: "One queued MLflow write.",
    additionalProperties: false,
  },
);
export type TrackingOp = Static<typeof TrackingOp>;

export const TrackingError = Type.Object(
  {
    kind: Type.Union(
      [Type.Literal("unavailable"), Type.Literal("ambiguous"), Type.Literal("rejected")],
      {
        description:
          "`unavailable`: MLflow unreachable or 5xx (retried). `ambiguous`: the request may have landed (retried idempotently). `rejected`: MLflow refused it (failed until retried by hand).",
      },
    ),
    message: Type.String({ maxLength: 2000 }),
    status: Type.Optional(Type.Integer({ minimum: 0, maximum: 999 })),
    code: Type.Optional(Type.String({ maxLength: 200 })),
  },
  {
    title: "TrackingError",
    description: "Why an MLflow write did not succeed.",
    additionalProperties: false,
  },
);
export type TrackingError = Static<typeof TrackingError>;

/** `tracking/outbox/outbox-NNNN.jsonl`. */
export const TrackingOutboxRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    seq: SequenceNumber,
    ts: Timestamp,
    type: Type.Union(
      [Type.Literal("enqueue"), Type.Literal("ack"), Type.Literal("fail"), Type.Literal("requeue")],
      {
        description:
          "`enqueue` adds `op`; `ack` resolves it (with `result`); `fail` parks it after a rejection; `requeue` puts a failed op back.",
      },
    ),
    op_id: Type.String({ pattern: "^op-[A-Za-z0-9_-]{1,64}$" }),
    op: Type.Optional(TrackingOp),
    result: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    error: Type.Optional(TrackingError),
  },
  {
    title: "TrackingOutboxRecord",
    description:
      "One entry of the temporary durable tracking outbox. Replaying the journal gives the pending and failed writes; fully resolved segments are deleted.",
    additionalProperties: false,
  },
);
export type TrackingOutboxRecord = Static<typeof TrackingOutboxRecord>;

export const MlflowUpgradeRecord = Type.Object(
  {
    from_version: Type.String({ minLength: 1, maxLength: 50 }),
    to_version: Type.String({ minLength: 1, maxLength: 50 }),
    at: Timestamp,
    backup_id: Type.String({ minLength: 1, maxLength: 100 }),
  },
  {
    title: "MlflowUpgradeRecord",
    description: "An MLflow version change, and the backup taken before it.",
    additionalProperties: false,
  },
);

/** `mlflow/sidecar.json`. */
export const MlflowSidecarState = Type.Object(
  {
    schema_version: Type.Literal(1),
    data_mlflow_version: Type.String({
      minLength: 1,
      maxLength: 50,
      description: "MLflow version that last opened (and migrated) the data in `mlflow/`.",
    }),
    initialized_at: Timestamp,
    updated_at: Timestamp,
    upgrades: Type.Array(MlflowUpgradeRecord),
  },
  {
    title: "MlflowSidecarState",
    description: "Managed MLflow sidecar bookkeeping, used by the upgrade guard.",
    additionalProperties: false,
  },
);
export type MlflowSidecarState = Static<typeof MlflowSidecarState>;

export const BackupFile = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096, description: "Relative to the backup." }),
    bytes: Type.Integer({ minimum: 0 }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { title: "BackupFile", additionalProperties: false },
);
export type BackupFile = Static<typeof BackupFile>;

/** `backups/<backup-id>/manifest.json`. */
export const BackupManifest = Type.Object(
  {
    schema_version: Type.Literal(1),
    backup_id: Type.String({ pattern: "^[0-9]{8}T[0-9]{6}Z(-[a-z0-9-]{1,40})?$" }),
    created_at: Timestamp,
    reason: Type.Union(
      [Type.Literal("manual"), Type.Literal("pre_upgrade"), Type.Literal("move")],
      {
        description:
          "`move`: taken by `coordinator move` with the coordinator stopped, before this home was retired.",
      },
    ),
    quiesce: Type.Optional(
      Type.Union([Type.Literal("tracking_paused"), Type.Literal("coordinator_stopped")], {
        description:
          "How writes were held still: tracking delivery paused in a running coordinator, or the coordinator stopped (the runtime lock held by the backup). Absent in backups made before Stage 17 (tracking_paused).",
      }),
    ),
    source: Type.Optional(
      Type.Object(
        {
          hostname: Type.String({ minLength: 1, maxLength: 255 }),
          home: Type.String({ minLength: 1, maxLength: 4096 }),
        },
        {
          title: "BackupSource",
          additionalProperties: false,
          description: "The machine and runtime directory the backup was taken from.",
        },
      ),
    ),
    projects: Type.Optional(
      Type.Array(
        Type.Object(
          {
            project_id: Type.String({ minLength: 1, maxLength: 100 }),
            path: Type.String({ minLength: 1, maxLength: 4096 }),
          },
          { title: "BackupProject", additionalProperties: false },
        ),
        {
          description:
            "Registered projects and their checkout paths at backup time; restore remaps them (`--project ID=PATH`).",
        },
      ),
    ),
    mlflow_version: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
    mlflow_database: Type.Union([Type.Literal("vacuum_into"), Type.Literal("absent")], {
      description:
        "`vacuum_into`: SQLite-safe snapshot taken with `VACUUM INTO` (never a raw copy of the live file). `absent`: no MLflow database yet.",
    }),
    outbox: Type.Object(
      { pending: Type.Integer({ minimum: 0 }), failed: Type.Integer({ minimum: 0 }) },
      {
        title: "BackupOutboxCounts",
        additionalProperties: false,
        description: "Outbox state when the snapshot was taken.",
      },
    ),
    files: Type.Array(BackupFile),
    excluded: Type.Array(Type.String({ maxLength: 500 }), {
      description: "What was deliberately left out, and why.",
    }),
  },
  {
    title: "BackupManifest",
    description:
      "A coordinated snapshot of MLflow data (database and artifacts) and coordinator state.",
    additionalProperties: false,
  },
);
export type BackupManifest = Static<typeof BackupManifest>;
