/**
 * Research inference records (spec §5.6.1; ADR 0020). Exploration is transient: one-shot results
 * and comparisons live in coordinator memory only. Two things are persisted, neither holding raw
 * inputs or outputs:
 *
 *   state/<p>/inference/sessions/<id>.json   InferenceSessionRecord: lifecycle of a warm model process
 *   state/<p>/inference/evidence/<id>.json   InferenceEvidenceRecord: provenance of an explicitly saved
 *                                            result; the inputs/outputs are an MLflow artifact
 */
import { type Static, Type } from "@sinclair/typebox";
import { ProjectId, Timestamp } from "./common.ts";
import { EvaluationModelRef } from "./lifecycle.ts";
import { MlflowExperimentId, MlflowRunId } from "./tracking.ts";

export const InferenceSessionId = Type.String({
  title: "InferenceSessionId",
  description: "AblationKit inference session ID, `is-<id>`.",
  pattern: "^is-[a-z0-9]{6,40}$",
});

export const InferenceEvidenceId = Type.String({
  title: "InferenceEvidenceId",
  description: "Saved inference evidence ID, `ie-<id>`.",
  pattern: "^ie-[a-z0-9]{6,40}$",
});

export const InferenceTask = Type.Union(
  [Type.Literal("tabular"), Type.Literal("text"), Type.Literal("image")],
  {
    title: "InferenceTask",
    description: "Task adapter chosen from the model's signature and metadata.",
  },
);

export const InferenceOutputKind = Type.Union(
  [Type.Literal("classification"), Type.Literal("regression"), Type.Literal("unknown")],
  { title: "InferenceOutputKind" },
);

const Ms = Type.Integer({ minimum: 0, description: "Whole milliseconds." });

export const InferenceSessionState = Type.Union(
  [
    Type.Literal("starting"),
    Type.Literal("ready"),
    Type.Literal("stopping"),
    Type.Literal("stopped"),
    Type.Literal("expired"),
    Type.Literal("crashed"),
    Type.Literal("failed"),
  ],
  {
    title: "InferenceSessionState",
    description:
      "`starting`: the worker is loading the model. `ready`: it answers predictions. `expired`: stopped after its idle timeout. `crashed`: the process died while serving. `failed`: the model never loaded. A coordinator restart stops every session (`stopped`).",
  },
);
export type InferenceSessionState = Static<typeof InferenceSessionState>;

/** `state/<project-id>/inference/sessions/<session-id>.json`. */
export const InferenceSessionRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    session_id: InferenceSessionId,
    project_id: ProjectId,
    model: EvaluationModelRef,
    source_run_id: Type.Optional(MlflowRunId),
    task: InferenceTask,
    output: InferenceOutputKind,
    environment: Type.Union([Type.Literal("managed"), Type.Literal("project")]),
    state: InferenceSessionState,
    limits: Type.Object(
      {
        idle_timeout_sec: Type.Integer({ minimum: 2, maximum: 86_400 }),
        max_lifetime_sec: Type.Integer({ minimum: 10, maximum: 7 * 86_400 }),
        memory_mb: Type.Integer({ minimum: 128, maximum: 1_048_576 }),
        max_request_bytes: Type.Integer({ minimum: 1024, maximum: 64 * 1024 * 1024 }),
        max_queue: Type.Integer({
          minimum: 1,
          maximum: 64,
          description: "Requests waiting or running at once; the worker answers one at a time.",
        }),
        request_timeout_sec: Type.Integer({ minimum: 1, maximum: 3600 }),
      },
      { title: "InferenceSessionLimits", additionalProperties: false },
    ),
    enforcement: Type.Optional(
      Type.Union([Type.Literal("enforced"), Type.Literal("advisory")], {
        description: "Whether memory and lifetime limits are enforced by a systemd scope.",
      }),
    ),
    pid: Type.Optional(Type.Integer({ minimum: 1 })),
    unit: Type.Optional(Type.String({ maxLength: 200 })),
    timings: Type.Object(
      { import_ms: Type.Optional(Ms), load_ms: Type.Optional(Ms), start_ms: Type.Optional(Ms) },
      {
        title: "InferenceSessionTimings",
        description:
          "`start_ms`: process start to ready. `load_ms`: model download and load alone.",
        additionalProperties: false,
      },
    ),
    counters: Type.Object(
      {
        requests: Type.Integer({ minimum: 0 }),
        errors: Type.Integer({ minimum: 0 }),
        rejected: Type.Integer({ minimum: 0, description: "Refused before reaching the worker." }),
        last_predict_ms: Type.Optional(Ms),
      },
      { title: "InferenceSessionCounters", additionalProperties: false },
    ),
    memory: Type.Optional(
      Type.Object(
        {
          rss_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
          peak_rss_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
          gpu_allocated_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
          at: Timestamp,
        },
        { title: "InferenceSessionMemory", additionalProperties: false },
      ),
    ),
    mlflow_version: Type.Optional(Type.String({ maxLength: 50 })),
    python_version: Type.Optional(Type.String({ maxLength: 50 })),
    deployment_id: Type.Optional(
      Type.String({
        pattern: "^dep-[a-z0-9-]{1,60}$",
        description: "Started by this local preview deployment.",
      }),
    ),
    restarts: Type.Integer({ minimum: 0 }),
    end_reason: Type.Optional(Type.String({ maxLength: 4000 })),
    transitions: Type.Array(
      Type.Object(
        {
          state: InferenceSessionState,
          at: Timestamp,
          reason: Type.Optional(Type.String({ maxLength: 1000 })),
        },
        { title: "InferenceSessionTransition", additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
    requested_by: Type.Object(
      {
        kind: Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("system")]),
        id: Type.Optional(Type.String({ maxLength: 200 })),
      },
      { title: "InferenceSessionActor", additionalProperties: false },
    ),
    created_at: Timestamp,
    ready_at: Type.Optional(Timestamp),
    last_activity_at: Type.Optional(Timestamp),
    ended_at: Type.Optional(Timestamp),
    updated_at: Timestamp,
  },
  {
    title: "InferenceSessionRecord",
    description:
      "A supervised, resource-capped, idle-expiring model process (spec §5.6.1 mode 2). No inputs or outputs are stored here.",
    additionalProperties: false,
  },
);
export type InferenceSessionRecord = Static<typeof InferenceSessionRecord>;

export const InferenceEvidenceModel = Type.Object(
  {
    model_id: EvaluationModelRef.properties.model_id,
    registered_name: EvaluationModelRef.properties.registered_name,
    version: EvaluationModelRef.properties.version,
    alias: EvaluationModelRef.properties.alias,
    source_run_id: Type.Optional(MlflowRunId),
    source_commit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{7,64}$" })),
  },
  { title: "InferenceEvidenceModel", additionalProperties: false },
);

/** `state/<project-id>/inference/evidence/<evidence-id>.json`. */
export const InferenceEvidenceRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    evidence_id: InferenceEvidenceId,
    project_id: ProjectId,
    kind: Type.Union([Type.Literal("prediction"), Type.Literal("comparison")]),
    via: Type.Union([Type.Literal("one_shot"), Type.Literal("session")]),
    session_id: Type.Optional(InferenceSessionId),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    note: Type.Optional(Type.String({ maxLength: 5000 })),
    models: Type.Array(InferenceEvidenceModel, { minItems: 1, maxItems: 8 }),
    task: InferenceTask,
    output: InferenceOutputKind,
    rows: Type.Integer({ minimum: 0 }),
    input_sha256: Type.String({
      pattern: "^[a-f0-9]{64}$",
      description: "SHA-256 of the canonical JSON inputs (or of the dataset file for a slice).",
    }),
    dataset: Type.Optional(
      Type.Object(
        {
          path: Type.String({ minLength: 1, maxLength: 1024 }),
          sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          offset: Type.Integer({ minimum: 0 }),
          limit: Type.Integer({ minimum: 1 }),
          targets: Type.Optional(Type.String({ maxLength: 250 })),
          split: Type.Optional(Type.String({ maxLength: 100 })),
          source_commit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{7,64}$" })),
        },
        { title: "InferenceEvidenceDataset", additionalProperties: false },
      ),
    ),
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    code_revision: Type.Optional(
      Type.String({
        pattern: "^[a-f0-9]{7,64}$",
        description: "The project checkout's HEAD when the evidence was saved.",
      }),
    ),
    environment: Type.Object(
      {
        kind: Type.Union([Type.Literal("managed"), Type.Literal("project")]),
        mlflow_version: Type.Optional(Type.String({ maxLength: 50 })),
        python_version: Type.Optional(Type.String({ maxLength: 50 })),
        bridge_version: Type.Integer({ minimum: 1 }),
      },
      { title: "InferenceEvidenceEnvironment", additionalProperties: false },
    ),
    stored: Type.Array(Type.String({ maxLength: 50 }), {
      maxItems: 20,
      description: "What the MLflow artifact contains (inputs, outputs, probabilities, targets…).",
    }),
    mlflow_run_id: Type.Optional(MlflowRunId),
    experiment_id: Type.Optional(MlflowExperimentId),
    artifact_path: Type.String({ maxLength: 500 }),
    artifact_bytes: Type.Integer({ minimum: 0 }),
    predicted_at: Timestamp,
    saved_by: Type.Object(
      {
        kind: Type.Union([Type.Literal("human"), Type.Literal("agent")]),
        id: Type.Optional(Type.String({ maxLength: 200 })),
      },
      { title: "InferenceEvidenceActor", additionalProperties: false },
    ),
    saved_at: Timestamp,
    deleted_at: Type.Optional(Timestamp),
  },
  {
    title: "InferenceEvidenceRecord",
    description:
      "An inference result or model comparison the researcher saved explicitly. MLflow holds the artifact (an `inference_evidence` run); this record holds the provenance.",
    additionalProperties: false,
  },
);
export type InferenceEvidenceRecord = Static<typeof InferenceEvidenceRecord>;
