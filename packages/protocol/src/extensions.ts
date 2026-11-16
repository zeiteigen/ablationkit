/**
 * Level 1 extensions (spec §8, read with the §7.11 trust model; ADR 0022). Extension source lives
 * in the project checkout; the coordinator keeps immutable builds (a source snapshot, the UI
 * bundles and the Python environment), the per-project approvals and the Python executions:
 *
 *   <checkout>/.ablationkit/extensions/<ext>/manifest.json          ExtensionManifest (author-written)
 *   state/<p>/extensions/<ext>/state.json                            ExtensionState: enabled, active build, approvals
 *   state/<p>/extensions/<ext>/builds/<eb>/build.json                ExtensionBuildRecord
 *   state/<p>/extensions/<ext>/builds/<eb>/{src,ui,venv}/            the snapshot, bundles and environment
 *   state/<p>/extensions/executions/<xe>.json                        ExtensionExecutionRecord
 *   state/<p>/extensions/executions/<xe>/{inputs,outputs,log.txt}    staged inputs, output area, log
 *
 * Approval binds the exact source, lockfile and capability hashes (criterion 15f). No floats:
 * metric values are decimal strings.
 */
import { type Static, Type } from "@sinclair/typebox";
import { AttemptId, JobId, ProjectId, Timestamp } from "./common.ts";
import { ObjectRef } from "./research.ts";
import { MlflowRunId } from "./tracking.ts";

const Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Count = Type.Integer({ minimum: 0 });
const Decimal = (description: string) =>
  Type.String({
    pattern: "^-?[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?$",
    maxLength: 40,
    description,
  });

export const ExtensionId = Type.String({
  title: "ExtensionId",
  description: "Extension ID: lowercase letters, digits and dashes, starting with a letter.",
  pattern: "^[a-z][a-z0-9-]{1,62}$",
});

export const ExtensionBuildId = Type.String({
  title: "ExtensionBuildId",
  description:
    "Content-derived build ID, `eb-<16 hex>`: the same source, lockfile and capabilities give the same build.",
  pattern: "^eb-[a-f0-9]{16}$",
});

export const ExtensionExecutionId = Type.String({
  title: "ExtensionExecutionId",
  description: "Python extension execution ID, `xe-<id>`.",
  pattern: "^xe-[a-z0-9]{6,40}$",
});

const Semver = Type.String({
  pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$",
  maxLength: 64,
});

export const ContributionPoint = Type.Union(
  [
    Type.Literal("project.panel"),
    Type.Literal("run.tab"),
    Type.Literal("comparison.view"),
    Type.Literal("report.block"),
    Type.Literal("model.demo"),
    Type.Literal("project.action"),
    Type.Literal("project.analysis"),
    Type.Literal("run.evaluator"),
  ],
  {
    title: "ContributionPoint",
    description:
      "Where a contribution mounts. UI points (`project.panel`, `run.tab`, `comparison.view`, `report.block`, `model.demo`) take a `.tsx`/`.ts` entry rendered in a sandboxed iframe. Python points (`project.analysis`, `run.evaluator`) take `path.py:function`. `project.action` names an allowlisted `operation`.",
  },
);
export type ContributionPoint = Static<typeof ContributionPoint>;

const ParamValue = Type.Union([Type.String({ maxLength: 1000 }), Type.Integer(), Type.Boolean()]);

export const ExtensionContribution = Type.Object(
  {
    id: Type.String({
      pattern: "^[a-z][a-z0-9-]{0,40}$",
      description: "Unique within the extension.",
    }),
    point: ContributionPoint,
    title: Type.String({ minLength: 1, maxLength: 80 }),
    entry: Type.Optional(
      Type.String({
        maxLength: 300,
        description:
          "Relative path inside the extension: `ui/src/View.tsx`, or `python/analysis.py:analyze` for Python points.",
      }),
    ),
    operation: Type.Optional(
      Type.String({
        maxLength: 80,
        description:
          "`project.action` only: the allowlisted coordinator operation (`extension.python.run`, `report.generate`, `research.note.create`).",
      }),
    ),
    target: Type.Optional(
      Type.String({
        pattern: "^[a-z][a-z0-9-]{0,40}$",
        description:
          "`extension.python.run` actions, and UI contributions that run Python: the ID of this extension's own Python contribution.",
      }),
    ),
    params: Type.Optional(
      Type.Record(Type.String(), ParamValue, {
        description: "Fixed parameters for a `project.action` operation.",
      }),
    ),
  },
  { title: "ExtensionContribution", additionalProperties: false },
);
export type ExtensionContribution = Static<typeof ExtensionContribution>;

export const ExtensionPythonSettings = Type.Object(
  {
    requires_python: Type.String({ maxLength: 60 }),
    environment: Type.Optional(
      Type.Union([Type.Literal("extension"), Type.Literal("project")], {
        description:
          "`extension` (default): the extension's own `pyproject.toml` and lockfile. `project` (ADR 0046): the project's own environment, built from the checkout's committed `uv.lock` at its current commit with the project's package installed, so the contribution can import the project's code; `project` and `lockfile` are then left out, and it runs on this machine only.",
      }),
    ),
    project: Type.Optional(
      Type.String({
        maxLength: 200,
        description:
          "Directory holding `pyproject.toml` and the lockfile, relative to the extension (environment `extension`).",
      }),
    ),
    lockfile: Type.Optional(
      Type.String({
        maxLength: 200,
        description: "`uv.lock`, relative to the extension (environment `extension`).",
      }),
    ),
    max_runtime_seconds: Type.Integer({ minimum: 1, maximum: 3600 }),
    max_memory_mb: Type.Integer({ minimum: 64, maximum: 65_536 }),
    cpu_percent: Type.Optional(Type.Integer({ minimum: 1, maximum: 6400 })),
    gpu: Type.Boolean(),
    warm: Type.Optional(
      Type.Boolean({
        description:
          "Keep one Python process per build between runs (ADR 0047): imports and module state persist, runs are served one at a time, the time limit applies to each run, and the process exits after 10 idle minutes.",
      }),
    ),
    network: Type.Union([Type.Literal("none"), Type.Literal("egress")], {
      description:
        "`none` (default): the runner starts the process in its own empty network namespace when the host allows it. `egress` needs the `network.egress` capability.",
    }),
  },
  { title: "ExtensionPythonSettings", additionalProperties: false },
);
export type ExtensionPythonSettings = Static<typeof ExtensionPythonSettings>;

export const ModelAllowEntry = Type.String({
  maxLength: 300,
  description:
    "A logged model `m-…`, or a registered model `name@alias` / `name/version`. An alias is pinned to its version at each call.",
});

export const LlmAllowEntry = Type.Object(
  {
    provider_id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,40}$" }),
    model: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { title: "LlmAllowEntry", additionalProperties: false },
);

export const CapabilityConfig = Type.Object(
  {
    inference: Type.Optional(
      Type.Object(
        {
          models: Type.Array(ModelAllowEntry, { minItems: 1, maxItems: 20 }),
          max_requests_per_hour: Type.Integer({ minimum: 1, maximum: 10_000 }),
          max_request_bytes: Type.Integer({ minimum: 64, maximum: 8 * 1024 * 1024 }),
          max_rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        },
        { title: "InferenceCapabilityConfig", additionalProperties: false },
      ),
    ),
    llm: Type.Optional(
      Type.Object(
        {
          targets: Type.Array(LlmAllowEntry, { minItems: 1, maxItems: 10 }),
          max_calls_per_hour: Type.Integer({ minimum: 1, maximum: 10_000 }),
          max_input_chars: Type.Integer({ minimum: 1, maximum: 200_000 }),
          max_cost_usd: Type.Optional(Decimal("Optional ceiling on estimated cost per hour.")),
        },
        { title: "LlmCapabilityConfig", additionalProperties: false },
      ),
    ),
    artifacts: Type.Optional(
      Type.Object(
        {
          max_output_bytes: Type.Integer({ minimum: 1024, maximum: 1024 * 1024 * 1024 }),
        },
        { title: "ArtifactCapabilityConfig", additionalProperties: false },
      ),
    ),
  },
  {
    title: "CapabilityConfig",
    description: "Bounds for capabilities that need them: allowlists, quotas and sizes.",
    additionalProperties: false,
  },
);
export type CapabilityConfig = Static<typeof CapabilityConfig>;

/** Backend declarations are data: the host validates and authorizes every invocation. */
export const ExtensionBackend = Type.Object(
  {
    entry: Type.String({ maxLength: 300 }),
    workers: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 16 })),
    service_agents: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 64 })),
    uses_services: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 64 })),
    ingest_services: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 100 }))),
    services: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_.-]{1,100}$" }), { maxItems: 64 }),
    operations: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: "^[a-z][a-z0-9_.-]{1,100}$" }),
          input_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          output_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          method: Type.Union([
            Type.Literal("GET"),
            Type.Literal("POST"),
            Type.Literal("PUT"),
            Type.Literal("PATCH"),
            Type.Literal("DELETE"),
          ]),
          path: Type.String({ maxLength: 300 }),
          agent: Type.Boolean(),
          widens_data_controls: Type.Optional(
            Type.Literal(true, {
              description:
                "Human-only: the backend may widen its data controls only while serving this operation.",
            }),
          ),
        },
        { title: "ExtensionBackendOperation", additionalProperties: false },
      ),
      { maxItems: 128 },
    ),
    pages: Type.Array(
      Type.Object(
        {
          api_path: Type.Optional(Type.String({ maxLength: 200 })),
          profiles: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 16 })),
          id: Type.String({ maxLength: 60 }),
          title: Type.String({ maxLength: 80 }),
          path: Type.String({ maxLength: 200 }),
          entry: Type.String({ maxLength: 300 }),
        },
        { title: "ExtensionBackendPage", additionalProperties: false },
      ),
      { maxItems: 16 },
    ),
    ingest: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 32 }),
    job_sdks: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 16 }),
    agent_skills: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 32 })),
  },
  { title: "ExtensionBackend", additionalProperties: false },
);
export type ExtensionBackend = Static<typeof ExtensionBackend>;

/** `<checkout>/.ablationkit/extensions/<id>/manifest.json`. */
export const ExtensionManifest = Type.Object(
  {
    schema_version: Type.Literal(1),
    id: ExtensionId,
    version: Semver,
    name: Type.Optional(Type.String({ maxLength: 120 })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    host_api: Type.String({
      maxLength: 100,
      description:
        "Supported host API range: `^2.0.0` for backends; non-backend extensions may also target API 1.",
    }),
    contributes: Type.Array(ExtensionContribution, { minItems: 0, maxItems: 32 }),
    backend: Type.Optional(ExtensionBackend),
    python: Type.Optional(ExtensionPythonSettings),
    capabilities: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_.]{1,80}$" }), {
      maxItems: 32,
    }),
    capability_config: Type.Optional(CapabilityConfig),
  },
  {
    title: "ExtensionManifest",
    description:
      "A Level 1 extension: contributions, host API range, Python limits and requested capabilities (spec §8.2).",
    additionalProperties: false,
  },
);
export type ExtensionManifest = Static<typeof ExtensionManifest>;

export const ExtensionActor = Type.Object(
  {
    kind: Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("system")]),
    id: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { title: "ExtensionActor", additionalProperties: false },
);
export type ExtensionActor = Static<typeof ExtensionActor>;

export const ExtensionApproval = Type.Object(
  {
    build_id: ExtensionBuildId,
    version: Semver,
    source_sha256: Sha256,
    lockfile_sha256: Type.Optional(Sha256),
    capability_sha256: Sha256,
    bundle_sha256: Type.Optional(Sha256),
    environment_sha256: Type.Optional(Sha256),
    capabilities: Type.Array(Type.String({ maxLength: 81 }), { maxItems: 32 }),
    trusted_code: Type.Literal(true, {
      description:
        "Approved Python runs as trusted code under the researcher's user (§7.11): acknowledged by the researcher, or, for an automatic approval, the coordinator's setting.",
    }),
    automatic: Type.Optional(
      Type.Boolean({
        description:
          "Enabled as it was built, without a separate approval (ADR 0045); `approved_by` is who built it.",
      }),
    ),
    approved_by: ExtensionActor,
    approved_at: Timestamp,
    note: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { title: "ExtensionApproval", additionalProperties: false },
);
export type ExtensionApproval = Static<typeof ExtensionApproval>;

/** `state/<p>/extensions/<ext>/state.json`. */
export const ExtensionState = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    extension_id: ExtensionId,
    enabled: Type.Boolean({
      description: "Mounted and runnable in this project. Only the researcher enables it.",
    }),
    active_build: Type.Optional(ExtensionBuildId),
    approvals: Type.Array(ExtensionApproval, {
      maxItems: 200,
      description: "Every approval for this project, oldest first. Rollback re-activates one.",
    }),
    disabled_at: Type.Optional(Timestamp),
    disabled_by: Type.Optional(ExtensionActor),
    disabled_reason: Type.Optional(Type.String({ maxLength: 500 })),
    updated_at: Timestamp,
  },
  {
    title: "ExtensionState",
    description:
      "One extension in one project: whether it is enabled, its active build and approvals.",
    additionalProperties: false,
  },
);
export type ExtensionState = Static<typeof ExtensionState>;

export const ExtensionDiagnostic = Type.Object(
  {
    level: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
    code: Type.String({ pattern: "^[a-z][a-z0-9_]{1,60}$" }),
    message: Type.String({ maxLength: 2000 }),
    path: Type.Optional(Type.String({ maxLength: 300 })),
    fix: Type.Optional(Type.String({ maxLength: 1000, description: "What to change." })),
  },
  { title: "ExtensionDiagnostic", additionalProperties: false },
);
export type ExtensionDiagnostic = Static<typeof ExtensionDiagnostic>;

export const ExtensionFile = Type.Object(
  {
    path: Type.String({ maxLength: 500 }),
    sha256: Sha256,
    bytes: Count,
  },
  { title: "ExtensionFile", additionalProperties: false },
);

/** `state/<p>/extensions/<ext>/builds/<eb>/build.json`. */
export const ExtensionBuildRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    build_id: ExtensionBuildId,
    project_id: ProjectId,
    extension_id: ExtensionId,
    version: Semver,
    manifest: ExtensionManifest,
    origin: Type.Union([Type.Literal("checkout"), Type.Literal("registry")]),
    files: Type.Array(ExtensionFile, { maxItems: 2000 }),
    source_sha256: Sha256,
    lockfile_sha256: Type.Optional(Sha256),
    capability_sha256: Sha256,
    bundle_sha256: Type.Optional(Sha256),
    backend: Type.Optional(
      Type.Object(
        { file: Type.String({ maxLength: 100 }), sha256: Sha256 },
        { title: "ExtensionBackendBundle", additionalProperties: false },
      ),
    ),
    ui: Type.Array(
      Type.Object(
        {
          contribution: Type.String({ maxLength: 41 }),
          file: Type.String({ maxLength: 100 }),
          sha256: Sha256,
          bytes: Count,
        },
        { title: "ExtensionUiBundle", additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
    python: Type.Optional(
      Type.Object(
        {
          status: Type.Union([Type.Literal("ready"), Type.Literal("failed")]),
          python_version: Type.Optional(Type.String({ maxLength: 40 })),
          environment_sha256: Type.Optional(Sha256),
          project_commit: Type.Optional(
            Type.String({
              pattern: "^[a-f0-9]{40,64}$",
              description:
                "Environment `project`: the checkout commit the environment was built from.",
            }),
          ),
          project_lockfile_sha256: Type.Optional(Sha256),
          packages: Type.Optional(
            Type.Array(Type.String({ maxLength: 200 }), {
              maxItems: 500,
              description: "`name==version` installed from the lockfile.",
            }),
          ),
          error: Type.Optional(Type.String({ maxLength: 4000 })),
        },
        { title: "ExtensionPythonEnvironment", additionalProperties: false },
      ),
    ),
    host_api_version: Semver,
    status: Type.Union([Type.Literal("ready"), Type.Literal("failed")]),
    diagnostics: Type.Array(ExtensionDiagnostic, { maxItems: 200 }),
    built_by: ExtensionActor,
    built_at: Timestamp,
  },
  {
    title: "ExtensionBuildRecord",
    description:
      "An immutable build: the source snapshot's file hashes, the UI bundles and the Python environment made from the lockfile.",
    additionalProperties: false,
  },
);
export type ExtensionBuildRecord = Static<typeof ExtensionBuildRecord>;

export const ExtensionExecutionStatus = Type.Union(
  [
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("timed_out"),
    Type.Literal("oom_killed"),
    Type.Literal("cancelled"),
    Type.Literal("interrupted"),
  ],
  {
    title: "ExtensionExecutionStatus",
    description:
      "`interrupted`: the coordinator stopped while it ran; it is never rerun and its outputs were not recorded.",
  },
);
export type ExtensionExecutionStatus = Static<typeof ExtensionExecutionStatus>;

export const ExtensionTable = Type.Object(
  {
    title: Type.String({ maxLength: 200 }),
    columns: Type.Array(Type.String({ maxLength: 100 }), { minItems: 1, maxItems: 50 }),
    rows: Type.Array(
      Type.Array(Type.Union([Type.String({ maxLength: 1000 }), Type.Integer(), Type.Boolean()]), {
        maxItems: 50,
      }),
      { maxItems: 500 },
    ),
  },
  { title: "ExtensionTable", additionalProperties: false },
);
export type ExtensionTable = Static<typeof ExtensionTable>;

export const ExtensionArtifact = Type.Object(
  {
    path: Type.String({ maxLength: 300, description: "Relative to the execution's output area." }),
    bytes: Count,
    sha256: Sha256,
    content_type: Type.String({ maxLength: 100 }),
  },
  { title: "ExtensionArtifact", additionalProperties: false },
);
export type ExtensionArtifact = Static<typeof ExtensionArtifact>;

export const ExtensionResult = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
    summary: Type.String({ maxLength: 2000 }),
    metrics: Type.Record(Type.String(), Decimal("A metric value."), {
      description: "At most 100 metrics.",
    }),
    tables: Type.Array(ExtensionTable, { maxItems: 10 }),
    warnings: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 50 }),
    errors: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 50 }),
    artifacts: Type.Array(ExtensionArtifact, { maxItems: 100 }),
    data: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Bounded JSON for a paired React view (at most 256 KiB serialized).",
      }),
    ),
  },
  { title: "ExtensionResult", additionalProperties: false },
);
export type ExtensionResult = Static<typeof ExtensionResult>;

/** `state/<p>/extensions/executions/<xe>.json`. */
export const ExtensionExecutionRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    execution_id: ExtensionExecutionId,
    project_id: ProjectId,
    extension_id: ExtensionId,
    build_id: ExtensionBuildId,
    contribution: Type.String({ maxLength: 41 }),
    entry: Type.String({ maxLength: 300 }),
    source_sha256: Sha256,
    lockfile_sha256: Type.Optional(Sha256),
    capability_sha256: Sha256,
    environment: Type.Object(
      {
        python_version: Type.Optional(Type.String({ maxLength: 40 })),
        environment_sha256: Type.Optional(Sha256),
      },
      { title: "ExecutionEnvironment", additionalProperties: false },
    ),
    params_sha256: Sha256,
    refs: Type.Array(ObjectRef, { maxItems: 50 }),
    status: ExtensionExecutionStatus,
    created_by: ExtensionActor,
    created_at: Timestamp,
    finished_at: Type.Optional(Timestamp),
    limits: Type.Object(
      {
        runtime_max_sec: Type.Integer({ minimum: 1 }),
        memory_max_bytes: Type.Integer({ minimum: 1 }),
        cpu_quota_percent: Type.Integer({ minimum: 1 }),
        tasks_max: Type.Integer({ minimum: 1 }),
        output_max_bytes: Type.Integer({ minimum: 1 }),
      },
      { title: "ExecutionLimits", additionalProperties: false },
    ),
    enforcement: Type.Object(
      {
        limits: Type.Union([Type.Literal("enforced"), Type.Literal("advisory")]),
        network: Type.Union([Type.Literal("enforced"), Type.Literal("advisory")]),
        reasons: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 10 }),
      },
      {
        title: "ExecutionEnforcement",
        additionalProperties: false,
        description:
          "Limits: systemd scope with delegated controllers. Network: an empty network namespace (`unshare -rn`). Filesystem reads are never enforced in v1.0 (§7.11).",
      },
    ),
    termination: Type.Optional(
      Type.Object(
        {
          exit_code: Type.Optional(Type.Integer()),
          signal: Type.Optional(Type.String({ maxLength: 20 })),
          unit_result: Type.Optional(Type.String({ maxLength: 40 })),
          duration_ms: Count,
        },
        { title: "ExecutionTermination", additionalProperties: false },
      ),
    ),
    progress: Type.Optional(
      Type.Object(
        {
          percent: Type.Integer({ minimum: 0, maximum: 100 }),
          message: Type.Optional(Type.String({ maxLength: 500 })),
        },
        { title: "ExecutionProgress", additionalProperties: false },
      ),
    ),
    result: Type.Optional(ExtensionResult),
    mlflow_run_id: Type.Optional(MlflowRunId),
    error: Type.Optional(Type.String({ maxLength: 4000 })),
    warm: Type.Optional(
      Type.Object(
        {
          worker: Type.String({ maxLength: 200, description: "The warm worker's unit." }),
          reused: Type.Boolean({
            description: "The worker had served an earlier run (its imports were warm).",
          }),
        },
        {
          title: "ExecutionWarmWorker",
          description: "Run by a warm worker (`python.warm`, ADR 0047).",
          additionalProperties: false,
        },
      ),
    ),
    remote: Type.Optional(
      Type.Object(
        {
          target_id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" }),
          job_id: JobId,
          attempt_id: Type.Optional(AttemptId),
          request_sha256: Sha256,
          note: Type.Optional(Type.String({ maxLength: 1000 })),
        },
        {
          title: "ExtensionExecutionRemote",
          description:
            "A contribution run as a job on a compute target (ADR 0023 decision 26): the bundle carries the build's source, the request and the staged inputs; broker calls are answered from those inputs only. It survives a coordinator restart and is recorded once, when the attempt has synced.",
          additionalProperties: false,
        },
      ),
    ),
  },
  {
    title: "ExtensionExecutionRecord",
    description:
      "One run of an approved Python contribution: exact code, lockfile and environment hashes, inputs, limits, enforcement, termination and the typed result.",
    additionalProperties: false,
  },
);
export type ExtensionExecutionRecord = Static<typeof ExtensionExecutionRecord>;

export const ExtensionSettings = Type.Object(
  {
    safe_mode: Type.Optional(
      Type.Boolean({
        description:
          "Start with every extension inactive: nothing mounts or runs; the Extensions page stays usable for disable and rollback.",
      }),
    ),
    max_concurrent_executions: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    require_approval: Type.Optional(
      Type.Boolean({
        description:
          "Require the researcher's approval before a build is enabled (ADR 0045). Default false: a successful build in a project is enabled as it is built.",
      }),
    ),
  },
  {
    title: "ExtensionSettings",
    description: "Extension host settings.",
    additionalProperties: false,
  },
);
export type ExtensionSettings = Static<typeof ExtensionSettings>;

// ---------------------------------------------------------------------------- Level 2 builds

export const SourceBuildId = Type.String({
  title: "SourceBuildId",
  description: "A modified AblationKit build, `b-<commit12>-<n>`.",
  pattern: "^b-[a-f0-9]{12}-[0-9]{1,4}$",
});

/** `<home>/builds/<build-id>/build.json`: a Level 2 (source) build made by `ablationkit dev build`. */
export const SourceBuildRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    build_id: SourceBuildId,
    commit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
    branch: Type.Optional(Type.String({ maxLength: 200 })),
    base_ref: Type.Optional(Type.String({ maxLength: 200 })),
    base_commit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40}$" })),
    changed_files: Type.Array(Type.String({ maxLength: 500 }), {
      maxItems: 5000,
      description: "Files changed against the base, for review.",
    }),
    diffstat: Type.Optional(Type.String({ maxLength: 20_000 })),
    source_dir: Type.String({ maxLength: 1000 }),
    checks: Type.Array(
      Type.Object(
        {
          command: Type.String({ maxLength: 500 }),
          status: Type.Union([
            Type.Literal("passed"),
            Type.Literal("failed"),
            Type.Literal("skipped"),
          ]),
          exit_code: Type.Optional(Type.Integer()),
          duration_ms: Type.Integer({ minimum: 0 }),
          output_tail: Type.Optional(Type.String({ maxLength: 8000 })),
        },
        { title: "SourceBuildCheck", additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    status: Type.Union(
      [Type.Literal("ready"), Type.Literal("checks_failed"), Type.Literal("failed")],
      {
        description: "`ready`: built and every check passed (or was explicitly skipped).",
      },
    ),
    error: Type.Optional(Type.String({ maxLength: 4000 })),
    created_at: Timestamp,
  },
  {
    title: "SourceBuildRecord",
    description:
      "A reviewable modified build of AblationKit itself (Level 2, spec §8.5): commit, branch, changes against the base, the checks run and their results. Activation is separate and only changes the next start.",
    additionalProperties: false,
  },
);
export type SourceBuildRecord = Static<typeof SourceBuildRecord>;
