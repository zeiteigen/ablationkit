/**
 * The MLflow feature compatibility matrix (criterion 18, spec §5.5): every MLflow capability
 * AblationKit depends on, the REST endpoints or Python APIs that provide it on the pinned MLflow,
 * where a researcher uses it in AblationKit (never the stock MLflow UI), and the real-MLflow suites
 * that exercise it.
 *
 * Kept honest by `scripts/mlflow-matrix.ts`:
 * - `--check` (CI, via `test/feature-matrix.test.ts`): every endpoint the client calls and every
 *   bridge op is listed here, every Python API listed is still called, and
 *   `docs/api/mlflow-compatibility.md` is generated from this file;
 * - `--coverage FILE` (CI, after the real-MLflow suites ran with `ABLATIONKIT_MLFLOW_TRACE=FILE`):
 *   every endpoint and op listed here succeeded against the pinned MLflow in this run.
 *
 * `rest` entries are `METHOD /path`, with `:x` for one path segment.
 */

export type MlflowArea =
  | "Server"
  | "Experiments and runs"
  | "Artifacts"
  | "Datasets"
  | "Logged models"
  | "Model registry"
  | "Classical evaluation"
  | "MLflow Projects"
  | "Inference"
  | "Tracing"
  | "Prompt registry"
  | "GenAI evaluation"
  | "Operations";

export type MlflowSuite =
  | "test:mlflow"
  | "test:lifecycle"
  | "test:inference"
  | "test:llm"
  | "test:restore";

export interface MlflowFeature {
  id: string;
  area: MlflowArea;
  feature: string;
  rest?: readonly string[];
  /** Operations-bridge ops (`packages/tracking-mlflow/env/bridge`, the LLM backend's worker). */
  bridge?: readonly string[];
  /** Python MLflow APIs those ops or the job SDKs call. */
  python?: readonly string[];
  /** Where it is used in AblationKit. */
  surface: string;
  suites: readonly MlflowSuite[];
  note?: string;
}

const V2 = "/api/2.0/mlflow";
const V3 = "/api/3.0/mlflow";
const ART = "/api/2.0/mlflow-artifacts/artifacts";

export const MLFLOW_FEATURES: readonly MlflowFeature[] = [
  {
    id: "server.health",
    area: "Server",
    feature: "Health and version of the managed sidecar (upgrade guard)",
    rest: ["GET /health", "GET /version"],
    surface: "Status bar, System page, `tracking doctor`",
    suites: ["test:mlflow", "test:lifecycle", "test:restore"],
  },
  {
    id: "experiments.manage",
    area: "Experiments and runs",
    feature:
      "Create, read, search, rename, delete, restore and tag experiments (`ak/<project-id>`)",
    rest: [
      `POST ${V2}/experiments/create`,
      `GET ${V2}/experiments/get`,
      `GET ${V2}/experiments/get-by-name`,
      `POST ${V2}/experiments/search`,
      `POST ${V2}/experiments/update`,
      `POST ${V2}/experiments/delete`,
      `POST ${V2}/experiments/restore`,
      `POST ${V2}/experiments/set-experiment-tag`,
    ],
    surface: "Experiments page, `tracking import`",
    suites: ["test:mlflow"],
  },
  {
    id: "runs.lifecycle",
    area: "Experiments and runs",
    feature: "Create, read, update, search, delete and restore runs",
    rest: [
      `POST ${V2}/runs/create`,
      `GET ${V2}/runs/get`,
      `POST ${V2}/runs/update`,
      `POST ${V2}/runs/search`,
      `POST ${V2}/runs/delete`,
      `POST ${V2}/runs/restore`,
    ],
    surface: "Runs, Studies and Compare pages; jobs",
    suites: ["test:mlflow", "test:lifecycle"],
  },
  {
    id: "runs.logging",
    area: "Experiments and runs",
    feature: "Params, metrics, tags and system metrics in batches; tag edits",
    rest: [`POST ${V2}/runs/log-batch`, `POST ${V2}/runs/set-tag`, `POST ${V2}/runs/delete-tag`],
    surface: "Run detail (parameters, tags, system metrics); the job collector",
    suites: ["test:mlflow", "test:lifecycle"],
  },
  {
    id: "runs.metric-history",
    area: "Experiments and runs",
    feature: "Full metric history for charts (downsampled in AblationKit)",
    rest: [`GET ${V2}/metrics/get-history`],
    surface: "Metric charts, comparisons and ablation tables",
    suites: ["test:mlflow", "test:restore"],
  },
  {
    id: "artifacts.proxied",
    area: "Artifacts",
    feature: "List, download and upload run artifacts through the artifact proxy",
    rest: [
      `GET ${V2}/artifacts/list`,
      "GET /get-artifact",
      `GET ${ART}`,
      `GET ${ART}/:x`,
      `PUT ${ART}/:x`,
    ],
    surface: "Artifact browser (content-type checked); collector uploads",
    suites: ["test:mlflow", "test:restore"],
    note: "`:x` is the artifact path; nested paths are matched segment by segment.",
  },
  {
    id: "datasets.inputs",
    area: "Datasets",
    feature: "Dataset inputs with digests, sources, roles and splits",
    rest: [`POST ${V2}/runs/log-inputs`],
    python: ["mlflow.data.from_pandas"],
    surface: "Data & Evals → Datasets, lineage strip",
    suites: ["test:lifecycle"],
  },
  {
    id: "models.logged",
    area: "Logged models",
    feature: "Logged models (MLflow 3): create, search, read, finalize, link to run outputs",
    rest: [
      `POST ${V2}/logged-models`,
      `POST ${V2}/logged-models/search`,
      `GET ${V2}/logged-models/:x`,
      `PATCH ${V2}/logged-models/:x`,
      `POST ${V2}/runs/outputs`,
    ],
    python: ["mlflow.sklearn.save_model"],
    surface: "Models page (flavors, signature, files, download)",
    suites: ["test:lifecycle"],
  },
  {
    id: "registry.models",
    area: "Model registry",
    feature: "Registered models: create, read, search, describe, tag",
    rest: [
      `POST ${V2}/registered-models/create`,
      `GET ${V2}/registered-models/get`,
      `GET ${V2}/registered-models/search`,
      `PATCH ${V2}/registered-models/update`,
      `POST ${V2}/registered-models/set-tag`,
      `DELETE ${V2}/registered-models/delete-tag`,
    ],
    surface: "Registry page, `registry` CLI",
    suites: ["test:mlflow", "test:lifecycle", "test:restore"],
  },
  {
    id: "registry.versions",
    area: "Model registry",
    feature: "Model versions: register, read, search, describe, tag",
    rest: [
      `POST ${V2}/model-versions/create`,
      `GET ${V2}/model-versions/get`,
      `GET ${V2}/model-versions/search`,
      `PATCH ${V2}/model-versions/update`,
      `POST ${V2}/model-versions/set-tag`,
      `DELETE ${V2}/model-versions/delete-tag`,
    ],
    surface: "Registry page (versions, lineage)",
    suites: ["test:mlflow", "test:lifecycle", "test:restore"],
  },
  {
    id: "registry.aliases",
    area: "Model registry",
    feature: "Aliases: set, resolve to an exact version, remove",
    rest: [
      `POST ${V2}/registered-models/alias`,
      `GET ${V2}/registered-models/alias`,
      `DELETE ${V2}/registered-models/alias`,
    ],
    surface: "Registry page, version pickers in Inference and evaluation",
    suites: ["test:mlflow", "test:lifecycle", "test:restore"],
  },
  {
    id: "evaluation.classical",
    area: "Classical evaluation",
    feature: "Classifier and regressor evaluation with plots and threshold validation",
    bridge: ["evaluate"],
    python: ["mlflow.models.evaluate", "mlflow.validate_evaluation_results"],
    surface: "Data & Evals → Evaluations, `evaluation run`",
    suites: ["test:lifecycle", "test:inference"],
    note: "Also the tracked batch comparison of criterion 9c.",
  },
  {
    id: "projects.mlproject",
    area: "MLflow Projects",
    feature: "`MLproject` entrypoints and parameters, run as supervised jobs",
    rest: [`POST ${V2}/runs/create`],
    surface: "Runs → Entrypoints, `mlproject show|run`",
    suites: ["test:lifecycle"],
    note: "AblationKit parses `MLproject` itself and runs the entrypoint as a job (no `mlflow run`); `docker_env` is refused.",
  },
  {
    id: "inference.one-shot",
    area: "Inference",
    feature: "Load a pinned model and predict once in an isolated worker",
    bridge: ["predict"],
    python: ["mlflow.pyfunc.load_model"],
    surface: "Inference page (Predict, Compare), `inference predict|compare`",
    suites: ["test:inference"],
  },
  {
    id: "inference.sessions",
    area: "Inference",
    feature: "Warm model sessions (supervised, idle TTL)",
    bridge: ["serve"],
    python: ["mlflow.pyfunc.load_model"],
    surface: "Inference page (Sessions), `inference session`",
    suites: ["test:inference"],
  },
  {
    id: "tracing.traces",
    area: "Tracing",
    feature: "Trace ingest (v3), search, read, span data, tags, delete",
    rest: [
      `POST ${V3}/traces`,
      `POST ${V3}/traces/search`,
      `GET ${V3}/traces/:x`,
      "GET /ajax-api/3.0/mlflow/get-trace-artifact",
      `PATCH ${V3}/traces/:x/tags`,
      `POST ${V3}/traces/delete-traces`,
    ],
    python: [
      "mlflow.tracing.configure",
      "mlflow.start_span",
      "mlflow.set_trace_tag",
      "mlflow.get_current_active_span",
    ],
    surface: "LLM Lab → Traces (span tree, waterfall, RAG and tool views)",
    suites: ["test:mlflow", "test:llm", "test:restore"],
    note: "Span payloads pass the project's capture policy before display (criterion 10e).",
  },
  {
    id: "tracing.assessments",
    area: "Tracing",
    feature: "Human feedback and scorer assessments on traces",
    rest: [`POST ${V3}/traces/:x/assessments`],
    surface: "Trace detail feedback, GenAI evaluation results",
    suites: ["test:mlflow", "test:llm"],
  },
  {
    id: "prompts.registry",
    area: "Prompt registry",
    feature: "Prompt versions, aliases and diffs (registered models tagged as prompts)",
    rest: [
      `POST ${V2}/registered-models/create`,
      `GET ${V2}/registered-models/search`,
      `POST ${V2}/model-versions/create`,
      `GET ${V2}/model-versions/search`,
      `POST ${V2}/registered-models/alias`,
      `GET ${V2}/registered-models/alias`,
    ],
    surface: "LLM Lab → Prompts, `llm prompts`",
    suites: ["test:mlflow", "test:llm", "test:restore"],
    note: "Uses `mlflow.prompt.is_prompt` and `mlflow.prompt.text` tags, as MLflow's own client does.",
  },
  {
    id: "genai.datasets",
    area: "GenAI evaluation",
    feature: "GenAI evaluation datasets (golden-set versions mirrored as records)",
    rest: [`POST ${V3}/datasets/create`, `POST ${V3}/datasets/:x/records`, `GET ${V3}/datasets/:x`],
    surface: "LLM Lab → Golden sets",
    suites: ["test:mlflow", "test:llm"],
  },
  {
    id: "genai.evaluate",
    area: "GenAI evaluation",
    feature: "`mlflow.genai.evaluate` over pinned variants with custom scorers and recorded traces",
    bridge: ["genai_evaluate"],
    python: ["mlflow.genai.evaluate", "mlflow.get_trace"],
    surface: "LLM Lab → Evaluations, `llm eval run`",
    suites: ["test:llm", "test:restore"],
  },
  {
    id: "ops.backup",
    area: "Operations",
    feature:
      "Consistent backup of MLflow's SQLite database and artifacts; restore on a clean machine",
    surface: "System page → Backups, `backup create|restore`",
    suites: ["test:restore"],
    note: "`VACUUM INTO` snapshot of `mlflow.db` (no REST); restore is checked through the REST API.",
  },
];

/** `GET /api/3.0/mlflow/traces/:x` → a matcher for a recorded `url.pathname`. */
export function endpointPattern(rest: string): RegExp {
  const [method, path] = rest.split(" ") as [string, string];
  const re = path
    .split("/")
    .map((seg) => (seg === ":x" ? ".+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${method} ${re}$`);
}
