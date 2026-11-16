/**
 * Model lifecycle records (spec §5.5, §5.6; ADR 0019). MLflow stays canonical for datasets,
 * logged models, registry versions and evaluation metrics/artifacts. These files hold only
 * AblationKit's side: the execution record of an evaluation it launched, and the provenance joins
 * (model → run → attempt, version → model) the lineage strip walks without calling MLflow.
 */
import { type Static, Type } from "@sinclair/typebox";
import { AttemptId, DecimalString, describe, JobId, ProjectId, Timestamp } from "./common.ts";
import { MlflowExperimentId, MlflowRunId, TrackingRunRef } from "./tracking.ts";

export const LoggedModelId = Type.String({
  title: "LoggedModelId",
  description: "MLflow 3 logged-model ID (`m-…`). Distinct from a run ID and a registry version.",
  pattern: "^m-[A-Za-z0-9]{1,64}$",
});

export const RegisteredModelName = Type.String({
  title: "RegisteredModelName",
  description: "MLflow registered model name.",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$",
});

export const ModelVersionNumber = Type.String({
  title: "ModelVersionNumber",
  description: "MLflow registry version number, as a string.",
  pattern: "^[1-9][0-9]{0,9}$",
});

export const EvaluationId = Type.String({
  title: "EvaluationId",
  description: "AblationKit evaluation ID, `ev-<id>`.",
  pattern: "^ev-[a-z0-9]{6,40}$",
});

/** `state/<project-id>/models/<model-id>.json`. */
export const ModelLink = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    model_id: LoggedModelId,
    name: Type.String({ minLength: 1, maxLength: 250 }),
    experiment_id: MlflowExperimentId,
    source_run_id: Type.Optional(MlflowRunId),
    ref: Type.Optional(describe(TrackingRunRef, "Tracked run (attempt or manual) that logged it.")),
    job_id: Type.Optional(JobId),
    attempt_id: Type.Optional(AttemptId),
    model_key: Type.Optional(
      Type.String({
        pattern: "^[a-f0-9]{8,64}$",
        description: "SDK-side key of a model logged through `log_model` (idempotency).",
      }),
    ),
    origin: Type.Union([Type.Literal("sdk"), Type.Literal("discovered")], {
      description:
        "`sdk`: logged through the AblationKit SDK and collector. `discovered`: seen in MLflow (logged natively or imported).",
    }),
    created_at: Timestamp,
  },
  {
    title: "ModelLink",
    description:
      "Provenance join for one logged model: which run, attempt and job produced it. MLflow holds the model.",
    additionalProperties: false,
  },
);
export type ModelLink = Static<typeof ModelLink>;

/** `state/<project-id>/registry/<link-id>.json`. */
export const RegistryVersionLink = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    name: RegisteredModelName,
    version: ModelVersionNumber,
    model_id: Type.Optional(LoggedModelId),
    run_id: Type.Optional(MlflowRunId),
    source: Type.String({ minLength: 1, maxLength: 1000, description: "MLflow version source." }),
    created_at: Timestamp,
  },
  {
    title: "RegistryVersionLink",
    description:
      "Provenance join for one registry version created through AblationKit. MLflow holds the version, its aliases, tags and description.",
    additionalProperties: false,
  },
);
export type RegistryVersionLink = Static<typeof RegistryVersionLink>;

export const EvaluationModelRef = Type.Object(
  {
    model_id: LoggedModelId,
    registered_name: Type.Optional(RegisteredModelName),
    version: Type.Optional(ModelVersionNumber),
    alias: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9_-]{1,100}$",
        description: "Alias the researcher chose; resolved to `version` at launch and pinned.",
      }),
    ),
  },
  {
    title: "EvaluationModelRef",
    description:
      "A pinned model: always a logged-model ID, plus the registry version it came from.",
    additionalProperties: false,
  },
);
export type EvaluationModelRef = Static<typeof EvaluationModelRef>;

export const ThresholdSpec = Type.Object(
  {
    metric: Type.String({ pattern: "^[A-Za-z0-9_./ -]{1,250}$" }),
    greater_is_better: Type.Boolean(),
    threshold: Type.Optional(DecimalString),
    min_absolute_change: Type.Optional(DecimalString),
    min_relative_change: Type.Optional(DecimalString),
  },
  {
    title: "ThresholdSpec",
    description:
      "One validation threshold, with MLflow `MetricThreshold` semantics. The change checks need a baseline.",
    additionalProperties: false,
  },
);
export type ThresholdSpec = Static<typeof ThresholdSpec>;

export const ThresholdOutcome = Type.Object(
  {
    metric: Type.String({ minLength: 1, maxLength: 250 }),
    passed: Type.Boolean(),
    candidate: Type.Optional(DecimalString),
    baseline: Type.Optional(DecimalString),
    failures: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 8 }),
  },
  { title: "ThresholdOutcome", additionalProperties: false },
);
export type ThresholdOutcome = Static<typeof ThresholdOutcome>;

export const EvaluationState = Type.Union(
  [
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("canceled"),
    Type.Literal("interrupted"),
  ],
  {
    title: "EvaluationState",
    description:
      "Execution state of the evaluation worker. `succeeded` means it ran; whether the thresholds passed is `validation.passed`. `interrupted`: the coordinator stopped while it ran; it is never rerun on its own.",
  },
);
export type EvaluationState = Static<typeof EvaluationState>;

/** `state/<project-id>/evaluations/<evaluation-id>.json`. */
export const EvaluationRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    evaluation_id: EvaluationId,
    project_id: ProjectId,
    kind: Type.Literal("classical", {
      description: "`mlflow.models.evaluate` (GenAI evaluation is a separate kind, Stage 14).",
    }),
    model_type: Type.Union([Type.Literal("classifier"), Type.Literal("regressor")]),
    model: EvaluationModelRef,
    baseline: Type.Optional(EvaluationModelRef),
    dataset: Type.Object(
      {
        path: Type.String({
          minLength: 1,
          maxLength: 1024,
          description: "Relative to the checkout.",
        }),
        sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        name: Type.String({ minLength: 1, maxLength: 250 }),
        targets: Type.String({ minLength: 1, maxLength: 250 }),
        split: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        source_commit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{7,64}$" })),
      },
      { title: "EvaluationDataset", additionalProperties: false },
    ),
    thresholds: Type.Array(ThresholdSpec, { maxItems: 50 }),
    environment: Type.Union([Type.Literal("managed"), Type.Literal("project")], {
      description:
        "`managed`: the coordinator's pinned MLflow environment. `project`: the project's own uv environment (it must provide mlflow).",
    }),
    state: EvaluationState,
    mlflow_run_id: Type.Optional(MlflowRunId),
    baseline_run_id: Type.Optional(MlflowRunId),
    experiment_id: Type.Optional(MlflowExperimentId),
    validation: Type.Optional(
      Type.Object(
        {
          passed: Type.Boolean(),
          outcomes: Type.Array(ThresholdOutcome, { maxItems: 50 }),
          mlflow_verdict: Type.Optional(
            Type.Union([Type.Literal("passed"), Type.Literal("failed")], {
              description:
                "What `mlflow.validate_evaluation_results` decided; must agree. Absent for a remote evaluation, whose thresholds the coordinator checks against the synced metrics.",
            }),
          ),
        },
        { title: "EvaluationValidation", additionalProperties: false },
      ),
    ),
    examples_requested: Type.Optional(
      Type.Boolean({
        description:
          "Batch evaluation: also record per-example predictions and paired outcomes (`ablationkit/examples.json` in the candidate run).",
      }),
    ),
    examples: Type.Optional(
      Type.Object(
        {
          rows: Type.Integer({ minimum: 0 }),
          listed: Type.Integer({ minimum: 0 }),
          paired: Type.Boolean(),
          model_type: Type.Union([Type.Literal("classifier"), Type.Literal("regressor")]),
          candidate_correct: Type.Optional(Type.Integer({ minimum: 0 })),
          baseline_correct: Type.Optional(Type.Integer({ minimum: 0 })),
          both_correct: Type.Optional(Type.Integer({ minimum: 0 })),
          only_candidate_correct: Type.Optional(Type.Integer({ minimum: 0 })),
          only_baseline_correct: Type.Optional(Type.Integer({ minimum: 0 })),
          both_wrong: Type.Optional(Type.Integer({ minimum: 0 })),
          disagreements: Type.Optional(Type.Integer({ minimum: 0 })),
          candidate_mae: Type.Optional(DecimalString),
          baseline_mae: Type.Optional(DecimalString),
          candidate_better_rows: Type.Optional(Type.Integer({ minimum: 0 })),
          paired_test: Type.Optional(
            Type.Object(
              {
                method: Type.String({ maxLength: 200 }),
                assumptions: Type.String({ maxLength: 500 }),
                discordant: Type.Integer({ minimum: 0 }),
                p_value: DecimalString,
              },
              { title: "EvaluationPairedTest", additionalProperties: false },
            ),
          ),
          paired_test_note: Type.Optional(Type.String({ maxLength: 500 })),
        },
        {
          title: "EvaluationExamples",
          description:
            "Summary of the per-example artifact. A paired test appears only where its method is standard, with the method and assumptions.",
          additionalProperties: false,
        },
      ),
    ),
    error: Type.Optional(Type.String({ maxLength: 4000 })),
    remote: Type.Optional(
      Type.Object(
        {
          target_id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" }),
          job_id: JobId,
          attempt_id: Type.Optional(AttemptId),
          model_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          note: Type.Optional(
            Type.String({
              maxLength: 1000,
              description:
                "Why the evaluation is still open (for example the attempt is `unknown` and waits for a human to resolve it; it is never rerun).",
            }),
          ),
        },
        {
          title: "EvaluationRemote",
          description:
            "A remote evaluation (criterion 9e): a job on a compute target whose bundle carries the pinned model. It is independently supervised, survives a coordinator restart and reconciles without running twice.",
          additionalProperties: false,
        },
      ),
    ),
    limits: Type.Object(
      {
        timeout_sec: Type.Integer({ minimum: 10, maximum: 86_400 }),
        memory_mb: Type.Optional(Type.Integer({ minimum: 64, maximum: 1_048_576 })),
      },
      { title: "EvaluationLimits", additionalProperties: false },
    ),
    enforcement: Type.Optional(
      Type.Union([Type.Literal("enforced"), Type.Literal("advisory")], {
        description: "Whether the worker's resource limits were enforced (systemd scope).",
      }),
    ),
    requested_by: Type.Object(
      {
        kind: Type.Union([Type.Literal("human"), Type.Literal("agent")]),
        id: Type.Optional(Type.String({ maxLength: 200 })),
      },
      { title: "EvaluationActor", additionalProperties: false },
    ),
    created_at: Timestamp,
    started_at: Type.Optional(Timestamp),
    ended_at: Type.Optional(Timestamp),
    updated_at: Timestamp,
  },
  {
    title: "EvaluationRecord",
    description:
      "A classical evaluation AblationKit launched in an isolated Python worker. Metrics, plots and tables live in its MLflow run.",
    additionalProperties: false,
  },
);
export type EvaluationRecord = Static<typeof EvaluationRecord>;

export const MlprojectRunInfo = Type.Object(
  {
    entrypoint: Type.String({ pattern: "^[A-Za-z0-9_.-]{1,200}$" }),
    parameters: Type.Record(Type.String(), Type.String({ maxLength: 4096 })),
    declared_environment: Type.Union(
      [
        Type.Literal("python_env"),
        Type.Literal("conda_env"),
        Type.Literal("docker_env"),
        Type.Literal("none"),
      ],
      { description: "What the MLproject file declares." },
    ),
    project_name: Type.Optional(Type.String({ maxLength: 250 })),
  },
  {
    title: "MlprojectRunInfo",
    description:
      "The `MLproject` entrypoint a job was launched from (spec §5.5 MLflow Projects). It runs with local environment semantics in the job runner.",
    additionalProperties: false,
  },
);
export type MlprojectRunInfo = Static<typeof MlprojectRunInfo>;
