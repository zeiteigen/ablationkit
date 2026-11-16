/**
 * LLM research records (spec §5.6.2, §5.6 GenAI rows; ADR 0021). MLflow keeps the canonical
 * traces, prompt versions, evaluation runs and assessments; these records keep the data controls,
 * the immutable golden-set versions, the pinned evaluation inputs and the saved playground
 * evidence:
 *
 *   state/<p>/llm/settings.json                     LlmSettings: providers, egress, capture, retention
 *   state/<p>/llm/golden-sets/<gs>.json             GoldenSetRecord
 *   state/<p>/llm/golden-sets/<gs>/v<N>.jsonl       one GoldenExample per line, immutable (SHA-256 pinned)
 *   state/<p>/llm/evaluations/<le>.json             LlmEvaluationRecord
 *   state/<p>/llm/evidence/<lx>.json                LlmEvidenceRecord
 *
 * No floats: decoding parameters, metric values and costs are decimal strings.
 */
import { type Static, Type } from "@sinclair/typebox";
import { AttemptId, JobId, ProjectId, Timestamp } from "./common.ts";
import { ENV_NAME_RE } from "./jobs.ts";
import { MlflowExperimentId, MlflowRunId } from "./tracking.ts";

const Decimal = (description: string) =>
  Type.String({
    pattern: "^-?[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?$",
    maxLength: 40,
    description,
  });
const Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Ms = Type.Integer({ minimum: 0, description: "Whole milliseconds." });
const Count = Type.Integer({ minimum: 0 });

export const LlmActor = Type.Object(
  {
    kind: Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("system")]),
    id: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { title: "LlmActor", additionalProperties: false },
);
export type LlmActor = Static<typeof LlmActor>;

export const LlmProviderId = Type.String({
  title: "LlmProviderId",
  pattern: "^[a-z0-9][a-z0-9-]{0,39}$",
});
export const GoldenSetId = Type.String({
  title: "GoldenSetId",
  description: "Golden set ID, `gs-<id>`.",
  pattern: "^gs-[a-z0-9]{6,40}$",
});
export const LlmEvaluationId = Type.String({
  title: "LlmEvaluationId",
  description: "GenAI evaluation ID, `le-<id>`.",
  pattern: "^le-[a-z0-9]{6,40}$",
});
export const LlmEvidenceId = Type.String({
  title: "LlmEvidenceId",
  description: "Saved LLM evidence ID, `lx-<id>`.",
  pattern: "^lx-[a-z0-9]{6,40}$",
});
export const TraceId = Type.String({
  title: "TraceId",
  description: "MLflow trace ID (`tr-<32 hex>`).",
  pattern: "^tr-[a-f0-9]{32}$",
});
export const VariantLabel = Type.String({ pattern: "^[A-Za-z0-9_.-]{1,40}$" });

export const LlmRate = Type.Object(
  {
    model: Type.String({ minLength: 1, maxLength: 200 }),
    input_usd_per_mtok: Decimal("US dollars per million input tokens."),
    output_usd_per_mtok: Decimal("US dollars per million output tokens."),
    source: Type.String({
      minLength: 1,
      maxLength: 300,
      description: "Where the rate came from (a price page URL, an invoice, 'local: free').",
    }),
    version: Type.String({
      minLength: 1,
      maxLength: 100,
      description: "Rate card date or version.",
    }),
  },
  {
    title: "LlmRate",
    description:
      "A token rate for estimating cost. Estimates are labelled as estimates with this source and version; they are never presented as billed cost.",
    additionalProperties: false,
  },
);

export const LlmProviderConfig = Type.Object(
  {
    provider_id: LlmProviderId,
    label: Type.Optional(Type.String({ maxLength: 200 })),
    kind: Type.Literal("openai_compatible"),
    base_url: Type.String({
      pattern: "^https?://[^ ]+$",
      maxLength: 500,
      description:
        "Base URL of an OpenAI-compatible API (vLLM, llama.cpp server, Ollama), e.g. `http://127.0.0.1:11434/v1`.",
    }),
    api_key_env: Type.Optional(
      Type.String({
        pattern: ENV_NAME_RE.source,
        description:
          "Name of a coordinator environment variable holding the API key. The key itself is never stored or shown.",
      }),
    ),
    models: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      minItems: 1,
      maxItems: 100,
      description: "Model names that may be requested from this provider.",
    }),
    locality: Type.Union([Type.Literal("local"), Type.Literal("external")], {
      description:
        "Derived from the host: loopback addresses are `local`; anything else is `external` and needs an egress approval.",
    }),
    egress: Type.Optional(
      Type.Object(
        {
          approved_at: Timestamp,
          approved_by: Type.String({ maxLength: 200 }),
          allow_datasets: Type.Boolean({
            description:
              "Whether golden-set examples and recorded traces may be sent to this provider (generation or judging). Without it only ad-hoc playground inputs may go.",
          }),
          note: Type.Optional(Type.String({ maxLength: 2000 })),
        },
        {
          title: "LlmEgressApproval",
          description: "A researcher's approval to send data to an external provider.",
          additionalProperties: false,
        },
      ),
    ),
    rates: Type.Optional(Type.Array(LlmRate, { maxItems: 100 })),
    timeout_sec: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
  },
  { title: "LlmProviderConfig", additionalProperties: false },
);
export type LlmProviderConfig = Static<typeof LlmProviderConfig>;

export const CaptureMode = Type.Union(
  [
    Type.Literal("full"),
    Type.Literal("redacted"),
    Type.Literal("metadata_only"),
    Type.Literal("off"),
  ],
  {
    title: "CaptureMode",
    description:
      "What trace bodies (prompts, outputs, retrieved passages, tool arguments) are kept. `full`: as recorded. `redacted`: with the redaction rules applied. `metadata_only`: span names, types, timings, status and token counts, no bodies. `off`: playground and job traces are not written at all (evaluations still record metadata-only traces, which MLflow needs).",
  },
);
export type CaptureMode = Static<typeof CaptureMode>;

export const RedactionPattern = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z0-9_-]{1,40}$" }),
    regex: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { title: "RedactionPattern", additionalProperties: false },
);

export const LlmCapturePolicy = Type.Object(
  {
    mode: CaptureMode,
    builtin_redactions: Type.Array(
      Type.Union([
        Type.Literal("email"),
        Type.Literal("secret"),
        Type.Literal("phone"),
        Type.Literal("card"),
        Type.Literal("ipv4"),
      ]),
      { maxItems: 10 },
    ),
    patterns: Type.Array(RedactionPattern, { maxItems: 50 }),
    retention_days: Type.Integer({
      minimum: 1,
      maximum: 3650,
      description:
        "Traces older than this are deleted from MLflow by the retention sweeper. Saved evidence is kept until deleted.",
    }),
    remote_capture: Type.Boolean({
      description: "Whether remote workers may capture trace bodies. Off by default (spec §16).",
    }),
  },
  { title: "LlmCapturePolicy", additionalProperties: false },
);
export type LlmCapturePolicy = Static<typeof LlmCapturePolicy>;

/** `state/<project-id>/llm/settings.json`. */
export const LlmSettings = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    revision: Type.Integer({ minimum: 0, description: "0 is the built-in default." }),
    updated_at: Timestamp,
    updated_by: Type.String({ maxLength: 200 }),
    providers: Type.Array(LlmProviderConfig, { maxItems: 20 }),
    capture: LlmCapturePolicy,
  },
  {
    title: "LlmSettings",
    description:
      "A project's LLM data controls: OpenAI-compatible providers with their egress approvals and rates, and the trace capture, redaction and retention policy.",
    additionalProperties: false,
  },
);
export type LlmSettings = Static<typeof LlmSettings>;

export const GoldenExample = Type.Object(
  {
    example_id: Type.String({ pattern: "^[A-Za-z0-9_.-]{1,64}$" }),
    inputs: Type.Record(Type.String(), Type.Unknown(), {
      description: "Named inputs, e.g. `{question: …}`; prompt variables are filled from these.",
    }),
    expectations: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Ground truth, e.g. `expected_response`, `expected_facts`, `expected_retrieved_context`. Missing ground truth is reported, not guessed.",
      }),
    ),
    category: Type.Optional(Type.String({ maxLength: 100 })),
    edge_case: Type.Optional(Type.Boolean()),
    tags: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 })),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  {
    title: "GoldenExample",
    description: "One line of a golden-set version file.",
    additionalProperties: false,
  },
);
export type GoldenExample = Static<typeof GoldenExample>;

export const GoldenSetVersion = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    sha256: describeSha("SHA-256 of the version's JSONL file; checked on every read."),
    examples: Count,
    categories: Type.Record(Type.String(), Count),
    edge_cases: Count,
    missing_expectations: Count,
    parent_version: Type.Optional(Type.Integer({ minimum: 1 })),
    note: Type.Optional(Type.String({ maxLength: 2000 })),
    created_at: Timestamp,
    created_by: LlmActor,
    mlflow_dataset_id: Type.Optional(
      Type.String({
        maxLength: 100,
        description: "The MLflow GenAI evaluation dataset mirroring this version.",
      }),
    ),
  },
  { title: "GoldenSetVersion", additionalProperties: false },
);
export type GoldenSetVersion = Static<typeof GoldenSetVersion>;

function describeSha(description: string) {
  return Type.String({ pattern: "^[a-f0-9]{64}$", description });
}

/** `state/<project-id>/llm/golden-sets/<golden-set-id>.json`. */
export const GoldenSetRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    golden_set_id: GoldenSetId,
    project_id: ProjectId,
    name: Type.String({ pattern: "^[a-z0-9][a-z0-9_.-]{0,79}$" }),
    description: Type.Optional(Type.String({ maxLength: 4000 })),
    held_out: Type.Boolean({
      description:
        "A held-out set: only a researcher may add versions, and its expectations are never exported to the checkout.",
    }),
    versions: Type.Array(GoldenSetVersion, { minItems: 1, maxItems: 1000 }),
    created_at: Timestamp,
    updated_at: Timestamp,
    created_by: LlmActor,
  },
  {
    title: "GoldenSetRecord",
    description:
      "A fixed, versioned evaluation set. Versions are immutable files pinned by SHA-256; changing a set means adding a version.",
    additionalProperties: false,
  },
);
export type GoldenSetRecord = Static<typeof GoldenSetRecord>;

export const PinnedPrompt = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    version: Type.Integer({ minimum: 1 }),
    alias: Type.Optional(
      Type.String({
        maxLength: 256,
        description: "The alias the request named; `version` is what it resolved to.",
      }),
    ),
    template_sha256: Sha256,
    format: Type.Union([Type.Literal("text"), Type.Literal("chat")]),
  },
  { title: "PinnedPrompt", additionalProperties: false },
);
export type PinnedPrompt = Static<typeof PinnedPrompt>;

export const GenerationParams = Type.Object(
  {
    temperature: Type.Optional(Decimal("0..2")),
    top_p: Type.Optional(Decimal("0..1")),
    max_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 32768 })),
    seed: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 2_147_483_647,
        description:
          "Sent to the provider; honoured only if the provider supports it, so repeated trials are not exact reproductions.",
      }),
    ),
    stop: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 4 })),
  },
  { title: "GenerationParams", additionalProperties: false },
);
export type GenerationParams = Static<typeof GenerationParams>;

export const LlmTarget = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("prompt"),
      label: VariantLabel,
      prompt: PinnedPrompt,
      provider_id: LlmProviderId,
      model: Type.String({ minLength: 1, maxLength: 200 }),
      params: GenerationParams,
    },
    {
      title: "PromptTarget",
      description:
        "A pinned prompt version rendered with each example's inputs and sent to one provider model.",
      additionalProperties: false,
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("recorded"),
      label: VariantLabel,
      source_run_id: MlflowRunId,
      traces: Count,
      matched: Type.Integer({
        minimum: 0,
        description: "Traces tagged with an example ID of the golden-set version.",
      }),
    },
    {
      title: "RecordedTarget",
      description:
        "Traces a project's own application recorded (for example a RAG job over the golden set); they are scored, not regenerated.",
      additionalProperties: false,
    },
  ),
]);
export type LlmTarget = Static<typeof LlmTarget>;

export const ScorerRef = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z0-9_]{1,64}$" }),
    kind: Type.Union([Type.Literal("builtin"), Type.Literal("judge"), Type.Literal("project")]),
    builtin: Type.Optional(
      Type.Union([
        Type.Literal("exact_match"),
        Type.Literal("contains_expected"),
        Type.Literal("expected_facts"),
        Type.Literal("regex"),
        Type.Literal("max_length"),
        Type.Literal("retrieval_recall"),
        Type.Literal("has_citation"),
        Type.Literal("tool_called"),
      ]),
    ),
    params: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 500 }))),
    judge: Type.Optional(
      Type.Object(
        {
          provider_id: LlmProviderId,
          model: Type.String({ minLength: 1, maxLength: 200 }),
          locality: Type.Union([Type.Literal("local"), Type.Literal("external")]),
          rubric: Type.String({ minLength: 1, maxLength: 8000 }),
          rubric_sha256: Sha256,
          uses: Type.Union([Type.Literal("answer"), Type.Literal("grounding")], {
            description: "`grounding` judges the answer against the trace's retrieved passages.",
          }),
          params: GenerationParams,
        },
        {
          title: "JudgeProvenance",
          description:
            "The judge model, rubric and settings, kept with every judged result. Judge output is an opinion, not ground truth.",
          additionalProperties: false,
        },
      ),
    ),
    project: Type.Optional(
      Type.Object(
        {
          path: Type.String({ maxLength: 500 }),
          function: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,99}$" }),
          sha256: Sha256,
          commit: Type.Optional(Type.String({ maxLength: 64 })),
        },
        { title: "ProjectScorer", additionalProperties: false },
      ),
    ),
  },
  { title: "ScorerRef", additionalProperties: false },
);
export type ScorerRef = Static<typeof ScorerRef>;

export const UsageSummary = Type.Object(
  {
    input_tokens: Type.Optional(Count),
    output_tokens: Type.Optional(Count),
    total_tokens: Type.Optional(Count),
    reported: Type.Integer({ minimum: 0, description: "Calls whose provider reported usage." }),
    missing: Type.Integer({
      minimum: 0,
      description: "Calls with no reported usage (never estimated).",
    }),
  },
  { title: "UsageSummary", additionalProperties: false },
);
export type UsageSummary = Static<typeof UsageSummary>;

export const CostEstimate = Type.Object(
  {
    estimated_usd: Decimal("An estimate from reported tokens times the rate; not a billed amount."),
    basis: Type.String({ maxLength: 500 }),
    rate_source: Type.String({ maxLength: 300 }),
    rate_version: Type.String({ maxLength: 100 }),
    partial: Type.Boolean({
      description: "Some calls had no reported usage, so the estimate leaves them out.",
    }),
  },
  { title: "CostEstimate", additionalProperties: false },
);
export type CostEstimate = Static<typeof CostEstimate>;

export const LlmVariantResult = Type.Object(
  {
    label: VariantLabel,
    run_id: Type.Optional(MlflowRunId),
    metrics: Type.Optional(Type.Record(Type.String(), Decimal("A scorer aggregate."))),
    examples: Type.Optional(Count),
    errors: Type.Optional(
      Type.Integer({ minimum: 0, description: "Examples whose generation failed." }),
    ),
    scorer_errors: Type.Optional(Count),
    usage: Type.Optional(UsageSummary),
    judge_usage: Type.Optional(UsageSummary),
    latency_ms: Type.Optional(
      Type.Object(
        { mean: Ms, p50: Ms, max: Ms },
        { title: "LatencySummary", additionalProperties: false },
      ),
    ),
    cost: Type.Optional(CostEstimate),
  },
  { title: "LlmVariantResult", additionalProperties: false },
);
export type LlmVariantResult = Static<typeof LlmVariantResult>;

export const LlmEgressUse = Type.Object(
  {
    provider_id: LlmProviderId,
    locality: Type.Union([Type.Literal("local"), Type.Literal("external")]),
    purpose: Type.Union([Type.Literal("generation"), Type.Literal("judge")]),
    approved_at: Type.Optional(Timestamp),
  },
  { title: "LlmEgressUse", additionalProperties: false },
);
export type LlmEgressUse = Static<typeof LlmEgressUse>;

export const LlmEvaluationState = Type.Union(
  [
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("canceled"),
    Type.Literal("interrupted"),
  ],
  { title: "LlmEvaluationState" },
);

/** `state/<project-id>/llm/evaluations/<evaluation-id>.json`. */
export const LlmEvaluationRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    evaluation_id: LlmEvaluationId,
    project_id: ProjectId,
    kind: Type.Literal("genai"),
    golden_set: Type.Object(
      {
        golden_set_id: GoldenSetId,
        name: Type.String({ maxLength: 80 }),
        version: Type.Integer({ minimum: 1 }),
        sha256: Sha256,
        held_out: Type.Boolean(),
        examples: Count,
      },
      { title: "PinnedGoldenSet", additionalProperties: false },
    ),
    targets: Type.Array(LlmTarget, { minItems: 1, maxItems: 6 }),
    scorers: Type.Array(ScorerRef, { minItems: 1, maxItems: 20 }),
    trials: Type.Integer({
      minimum: 1,
      maximum: 10,
      description:
        "Repeated generations per example; outputs are distributions, not exact reproductions.",
    }),
    retention: Type.Object(
      {
        capture: CaptureMode,
        retention_days: Type.Integer({ minimum: 1 }),
        settings_revision: Type.Integer({ minimum: 0 }),
      },
      {
        title: "DeclaredRetention",
        description: "The data-retention policy this evaluation's traces were recorded under.",
        additionalProperties: false,
      },
    ),
    egress: Type.Array(LlmEgressUse, { maxItems: 20 }),
    environment: Type.Union([Type.Literal("managed"), Type.Literal("remote")], {
      description:
        "`managed`: the operations bridge on the workstation (`mlflow.genai.evaluate`). `remote`: a job on a compute target (`remote`).",
    }),
    remote: Type.Optional(
      Type.Object(
        {
          target_id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" }),
          job_id: JobId,
          attempt_id: Type.Optional(AttemptId),
          request_sha256: Sha256,
          note: Type.Optional(
            Type.String({
              maxLength: 1000,
              description:
                "Why the evaluation is still open (waiting for the worker's results, or an `unknown` attempt a human must resolve; it is never rerun).",
            }),
          ),
        },
        {
          title: "LlmEvaluationRemote",
          description:
            "A remote GenAI evaluation (ADR 0023 decision 25): a job whose bundle carries the request (examples, prompts, keyless provider endpoints, scorers). It survives a coordinator restart and reconciles once; the targets' runs are filled from its `eval/genai-results.json`.",
          additionalProperties: false,
        },
      ),
    ),
    state: LlmEvaluationState,
    experiment_id: Type.Optional(MlflowExperimentId),
    results: Type.Array(LlmVariantResult, { maxItems: 6 }),
    source_commit: Type.Optional(Type.String({ maxLength: 64 })),
    limits: Type.Object(
      {
        timeout_sec: Type.Integer({ minimum: 10, maximum: 86_400 }),
        max_calls: Type.Integer({ minimum: 1, maximum: 100_000 }),
      },
      { title: "LlmEvaluationLimits", additionalProperties: false },
    ),
    enforcement: Type.Optional(Type.Union([Type.Literal("enforced"), Type.Literal("advisory")])),
    error: Type.Optional(Type.String({ maxLength: 4000 })),
    requested_by: LlmActor,
    created_at: Timestamp,
    updated_at: Timestamp,
    started_at: Type.Optional(Timestamp),
    ended_at: Type.Optional(Timestamp),
  },
  {
    title: "LlmEvaluationRecord",
    description:
      "A GenAI evaluation (`mlflow.genai.evaluate`) of one to six pinned targets over one golden-set version. Each target is its own MLflow run with traces and assessments; per-example results are the run's `ablationkit/llm/examples.json` artifact.",
    additionalProperties: false,
  },
);
export type LlmEvaluationRecord = Static<typeof LlmEvaluationRecord>;

/** `state/<project-id>/llm/evidence/<evidence-id>.json`. */
export const LlmEvidenceRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    evidence_id: LlmEvidenceId,
    project_id: ProjectId,
    kind: Type.Literal("playground"),
    title: Type.String({ minLength: 1, maxLength: 300 }),
    note: Type.Optional(Type.String({ maxLength: 4000 })),
    targets: Type.Array(LlmTarget, { minItems: 1, maxItems: 6 }),
    golden_set: Type.Optional(
      Type.Object(
        {
          golden_set_id: GoldenSetId,
          version: Type.Integer({ minimum: 1 }),
          sha256: Sha256,
        },
        { title: "EvidenceGoldenSet", additionalProperties: false },
      ),
    ),
    inputs_sha256: Sha256,
    examples: Count,
    trace_ids: Type.Array(TraceId, { maxItems: 10_000 }),
    mlflow_run_id: MlflowRunId,
    experiment_id: MlflowExperimentId,
    artifact_path: Type.String({ maxLength: 500 }),
    artifact_bytes: Count,
    stored: Type.Array(Type.String({ maxLength: 200 }), {
      maxItems: 20,
      description: "What the artifact holds, in words shown to the researcher.",
    }),
    source_commit: Type.Optional(Type.String({ maxLength: 64 })),
    created_by: LlmActor,
    created_at: Timestamp,
    deleted_at: Type.Optional(Timestamp),
  },
  {
    title: "LlmEvidenceRecord",
    description:
      "An explicitly saved playground comparison: the pinned variants, inputs hash and trace IDs here; the inputs, outputs, usage and timings are one MLflow artifact.",
    additionalProperties: false,
  },
);
export type LlmEvidenceRecord = Static<typeof LlmEvidenceRecord>;
