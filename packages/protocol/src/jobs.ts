/**
 * Local jobs, execution attempts, ingest and the worker collector (spec §4.1–4.2, §5.7, §6, §10;
 * ADR 0011). A Job is a logical submission; an ExecutionAttempt is one supervised process run of
 * it with exactly one MLflow run. Console output lives in a per-attempt JSONL journal, never in
 * MLflow; metrics, params and tags go to MLflow through the tracking outbox.
 */
import { type Static, Type } from "@sinclair/typebox";
import {
  AttemptId,
  describe,
  EventId,
  JobId,
  ProjectId,
  SequenceNumber,
  StudyId,
  TaskId,
  Timestamp,
  VariantId,
} from "./common.ts";
import { WeightHundredths } from "./compute.ts";
import { AttemptContainer, JobContainer } from "./containers.ts";
import { MlprojectRunInfo } from "./lifecycle.ts";
import { JobLimits, MetricsFormat } from "./limits.ts";
import { RemoteAttemptInfo, TargetId } from "./remote.ts";

/** Environment variable names accepted in `JobRecord.env` (checked in code: record keys are free-form). */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export { JobLimits, MetricsFormat } from "./limits.ts";

export const AttemptState = Type.Union(
  [
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
    Type.Literal("timed_out"),
    Type.Literal("oom_killed"),
    Type.Literal("unknown"),
  ],
  {
    title: "AttemptState",
    description:
      "Compute status of one attempt. `unknown`: the collector vanished without reporting an exit; nothing is rerun automatically.",
  },
);
export type AttemptState = Static<typeof AttemptState>;

export const TERMINAL_ATTEMPT_STATES: readonly AttemptState[] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "oom_killed",
  "unknown",
];

const RelativePath = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: "^[^/].*$",
  description: "Relative path; code rejects `..` segments (no lookaround: Rust regex).",
});

const Actor = Type.Object(
  {
    kind: Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("system")]),
    id: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { title: "JobActor", description: "Who submitted a job.", additionalProperties: false },
);

/** `state/<project-id>/jobs/<job-id>/job.json`. */
export const JobRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    job_id: JobId,
    project_id: ProjectId,
    command: Type.Array(Type.String({ maxLength: 8192 }), {
      minItems: 1,
      maxItems: 1024,
      description: "argv, run from `cwd` inside the project checkout.",
    }),
    cwd: Type.Optional(describe(RelativePath, "Working directory relative to the checkout.")),
    environment: Type.Union([Type.Literal("uv"), Type.Literal("none")], {
      description:
        "`uv`: run through `uv run --frozen --project <checkout>` (the project's own environment). `none`: run argv as given.",
    }),
    env: Type.Record(Type.String(), Type.String({ maxLength: 32_768 }), {
      description: "Extra environment variables. Stored in plain text: never put secrets here.",
    }),
    limits: JobLimits,
    artifact_paths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), {
      maxItems: 64,
      description:
        "Globs relative to the checkout, collected as artifacts after the process exits (for scripts without the SDK).",
    }),
    metrics_file: Type.Optional(
      describe(
        RelativePath,
        "File adapter for scripts without the SDK: a JSON-lines file (relative to the checkout) the collector tails; each object's numeric fields (nested ones flattened with `/`) become metrics at its step.",
      ),
    ),
    metrics_format: Type.Optional(MetricsFormat),
    input_paths: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), {
        maxItems: 16,
        description:
          "Globs relative to the checkout, recorded as `inputs/<path>` artifacts as the job starts (configs the source commit does not hold, e.g. ignored ones). Jobs on this machine only.",
      }),
    ),
    run_name: Type.Optional(Type.String({ minLength: 1, maxLength: 250 })),
    description: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 2000,
        description:
          "What the run tests and why, in a sentence or two. Each attempt's run starts with it as its summary (ADR 0048).",
      }),
    ),
    study_id: Type.Optional(StudyId),
    variant_id: Type.Optional(VariantId),
    task_id: Type.Optional(TaskId),
    agenda_item: Type.Optional(
      Type.String({
        pattern: "^(note:[a-z0-9][a-z0-9-]{0,95}|L[0-9]{1,6})$",
        description:
          "The item of the researcher's agenda this job serves (ADR 0058): `note:<id>` or `L<n>`.",
      }),
    ),
    mlproject: Type.Optional(MlprojectRunInfo),
    target_id: Type.Optional(
      describe(
        TargetId,
        "Remote compute target (ADR 0023). Absent: this machine. Each attempt runs from its own staged bundle.",
      ),
    ),
    bundle_inputs: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" }),
            path: Type.String({
              pattern: "^/.*$",
              maxLength: 4096,
              description: "A directory the coordinator staged.",
            }),
          },
          { title: "BundleInput", additionalProperties: false },
        ),
        {
          maxItems: 8,
          description:
            "Remote jobs: coordinator-staged directories copied into each attempt's bundle at `inputs/<name>` and checksummed with it (a remote evaluation's pinned model). The job finds them under `$ABLATIONKIT_BUNDLE_INPUTS`.",
        },
      ),
    ),
    submitted_by: Actor,
    compute_weight_hundredths: Type.Optional(
      describe(
        WeightHundredths,
        "Agent jobs (ADR 0037): the weight of the job's target when it was submitted, in hundredths. Every attempt's wall time times this weight counts against the project's `compute.limit_hours`; changing the target's weight later does not change it.",
      ),
    ),
    via_extension: Type.Optional(
      Type.String({
        pattern: "^[a-z][a-z0-9-]{1,63}$",
        description:
          "Submitted through this extension backend's broker (`compute.remote`, ADR 0024); only it may read or cancel the job there.",
      }),
    ),
    container: Type.Optional(JobContainer),
    state: describe(AttemptState, "State of the latest attempt."),
    attempts: Type.Array(AttemptId, { description: "Attempt IDs, oldest first." }),
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  {
    title: "JobRecord",
    description: "One logical job submission. Retries add attempts; each attempt has its own run.",
    additionalProperties: false,
  },
);
export type JobRecord = Static<typeof JobRecord>;

export const SupervisorInfo = Type.Object(
  {
    mode: Type.Union([Type.Literal("systemd"), Type.Literal("direct"), Type.Literal("remote")], {
      description:
        "`systemd`: a user scope per attempt. `direct`: a plain process group (no systemd user manager). `remote`: the target's own supervisor (`remote.target_kind`).",
    }),
    enforcement: Type.Union([Type.Literal("enforced"), Type.Literal("advisory")], {
      description:
        "Whether CPU/memory/task limits are enforced by the kernel (spec §7.11). Never claim enforced for direct mode.",
    }),
    reason: Type.Optional(Type.String({ maxLength: 2000 })),
    unit: Type.Optional(Type.String({ maxLength: 256, description: "systemd scope of the job." })),
    collector_unit: Type.Optional(Type.String({ maxLength: 256 })),
    container: Type.Optional(AttemptContainer),
  },
  { title: "SupervisorInfo", additionalProperties: false },
);
export type SupervisorInfo = Static<typeof SupervisorInfo>;

export const CollectorHealth = Type.Object(
  {
    pid: Type.Optional(Type.Integer({ minimum: 1 })),
    last_seen_at: Type.Optional(Timestamp),
    spool_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
    pending_events: Type.Optional(Type.Integer({ minimum: 0 })),
    pending_artifacts: Type.Optional(Type.Integer({ minimum: 0 })),
    dropped_events: Type.Optional(Type.Integer({ minimum: 0 })),
    last_error: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  {
    title: "CollectorHealth",
    description: "Last health report from the attempt's collector.",
    additionalProperties: false,
  },
);
export type CollectorHealth = Static<typeof CollectorHealth>;

export const AttemptSnapshot = Type.Object(
  {
    hostname: Type.String({ maxLength: 253 }),
    command: Type.Array(Type.String({ maxLength: 8192 }), { maxItems: 1100 }),
    cwd: Type.String({ maxLength: 4096 }),
    source_commit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{7,64}$" })),
    source_dirty: Type.Optional(Type.Boolean()),
    python: Type.Optional(Type.String({ maxLength: 200 })),
    sdk_version: Type.Optional(Type.String({ maxLength: 100 })),
    collector_version: Type.String({ maxLength: 100 }),
  },
  {
    title: "AttemptSnapshot",
    description: "Provenance captured when the attempt started (spec §6).",
    additionalProperties: false,
  },
);
export type AttemptSnapshot = Static<typeof AttemptSnapshot>;

export const UploadedArtifact = Type.Object(
  {
    path: describe(RelativePath, "Path inside the run's artifact root."),
    size: Type.Integer({ minimum: 0 }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    uploaded_at: Timestamp,
  },
  { title: "UploadedArtifact", additionalProperties: false },
);
export type UploadedArtifact = Static<typeof UploadedArtifact>;

/** `state/<project-id>/jobs/<job-id>/attempts/<attempt-id>/attempt.json`. */
export const AttemptRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    attempt_id: AttemptId,
    job_id: JobId,
    project_id: ProjectId,
    number: Type.Integer({ minimum: 1 }),
    state: AttemptState,
    created_at: Timestamp,
    started_at: Type.Optional(Timestamp),
    ended_at: Type.Optional(Timestamp),
    cancel_requested_at: Type.Optional(Timestamp),
    supervisor: SupervisorInfo,
    collector: CollectorHealth,
    token_id: describe(
      Type.String({ pattern: "^[a-f0-9]{16}$" }),
      "Worker token for this attempt.",
    ),
    pid: Type.Optional(Type.Integer({ minimum: 1 })),
    exit_code: Type.Optional(Type.Integer()),
    signal: Type.Optional(Type.String({ maxLength: 32 })),
    unit_result: Type.Optional(
      Type.String({ maxLength: 64, description: "systemd `Result` of the scope." }),
    ),
    error: Type.Optional(Type.String({ maxLength: 2000 })),
    snapshot: Type.Optional(AttemptSnapshot),
    artifacts: Type.Array(UploadedArtifact, { maxItems: 10_000 }),
    remote: Type.Optional(RemoteAttemptInfo),
  },
  {
    title: "AttemptRecord",
    description:
      "One execution attempt: compute status, supervision and provenance. Its MLflow run is keyed by attempt_id.",
    additionalProperties: false,
  },
);
export type AttemptRecord = Static<typeof AttemptRecord>;

/** `.../attempts/<attempt-id>/ingest.json`: at-least-once dedupe state at the coordinator. */
export const IngestState = Type.Object(
  {
    schema_version: Type.Literal(1),
    attempt_id: AttemptId,
    producers: Type.Record(Type.String(), SequenceNumber, {
      description: "Highest producer_seq accepted per producer; anything at or below is a replay.",
    }),
    accepted: Type.Integer({ minimum: 0 }),
    duplicates: Type.Integer({ minimum: 0 }),
    rejected: Type.Integer({ minimum: 0 }),
    last_rejection: Type.Optional(Type.String({ maxLength: 2000 })),
    spool_acked_seq: Type.Optional(
      describe(
        Type.Integer({ minimum: -1 }),
        "Highest worker spool seq applied (remote workers send it with each batch).",
      ),
    ),
  },
  {
    title: "IngestState",
    description: "Per-attempt ingest high-water marks and counters.",
    additionalProperties: false,
  },
);
export type IngestState = Static<typeof IngestState>;

export const ConsoleStream = Type.Union(
  [Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("log"), Type.Literal("system")],
  {
    title: "ConsoleStream",
    description:
      "`log`: a Python logging record from the SDK handler. `system`: a note from AblationKit itself.",
  },
);
export type ConsoleStream = Static<typeof ConsoleStream>;

/** `.../attempts/<attempt-id>/console/console-NNNN.jsonl`. */
export const ConsoleRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    seq: SequenceNumber,
    ts: Timestamp,
    stream: ConsoleStream,
    text: Type.String({ maxLength: 65_536 }),
    level: Type.Optional(Type.String({ maxLength: 32 })),
    logger: Type.Optional(Type.String({ maxLength: 256 })),
    event_id: Type.Optional(EventId),
  },
  {
    title: "ConsoleRecord",
    description: "One console line of an attempt. Independent of MLflow (criterion 11).",
    additionalProperties: false,
  },
);
export type ConsoleRecord = Static<typeof ConsoleRecord>;

/** `spool/<attempt-id>/manifest.json`, written by the coordinator for the collector. */
export const CollectorManifest = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    job_id: JobId,
    attempt_id: AttemptId,
    worker_url: Type.String({ pattern: "^https?://.*$", maxLength: 2048 }),
    token_file: Type.String({ pattern: "^/.*$", maxLength: 4096 }),
    project_path: Type.String({ pattern: "^/.*$", maxLength: 4096 }),
    argv: Type.Array(Type.String({ maxLength: 8192 }), { minItems: 1, maxItems: 1100 }),
    cwd: Type.String({ pattern: "^/.*$", maxLength: 4096 }),
    env: Type.Record(Type.String(), Type.String()),
    limits: JobLimits,
    mode: Type.Union([Type.Literal("systemd"), Type.Literal("direct")]),
    unit: Type.String({ pattern: "^[A-Za-z0-9:_.-]{1,200}$" }),
    artifact_paths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 })),
    metrics_file: Type.Optional(Type.String({ pattern: "^/.*$", maxLength: 4096 })),
    metrics_format: Type.Optional(MetricsFormat),
    input_paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }))),
    spool_max_bytes: Type.Integer({ minimum: 1024 * 1024 }),
    deliver_deadline_sec: describe(
      Type.Integer({ minimum: 1 }),
      "How long after exit the collector keeps retrying delivery before leaving the spool for reconciliation.",
    ),
    drain_only: Type.Optional(
      describe(Type.Boolean(), "Deliver an existing spool without starting the command."),
    ),
  },
  {
    title: "CollectorManifest",
    description: "Everything the collector needs to run and report one attempt.",
    additionalProperties: false,
  },
);
export type CollectorManifest = Static<typeof CollectorManifest>;
