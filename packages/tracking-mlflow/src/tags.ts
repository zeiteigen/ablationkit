/** MLflow naming and reverse tags (spec §5.5 run mapping, §6.1). */

/** The one MLflow experiment of a project. */
export function projectExperimentName(projectId: string): string {
  return `ak/${projectId}`;
}

/** Experiment names under `ak/` are reserved for project experiments the coordinator creates. */
export const RESERVED_EXPERIMENT_PREFIX = "ak/";

/** Reverse tags on every run AblationKit creates, so a run can be traced back without our files. */
export const TAGS = {
  project: "ablationkit.project_id",
  ref: "ablationkit.ref",
  kind: "ablationkit.kind",
  job: "ablationkit.job_id",
  attempt: "ablationkit.attempt_id",
  study: "ablationkit.study_id",
  variant: "ablationkit.variant_id",
  task: "ablationkit.task_id",
  /** The run's short description (ADR 0048): what it tests and why, then what came out. */
  summary: "ablationkit.summary",
  modelKey: "ablationkit.model_key",
  evaluation: "ablationkit.evaluation_id",
  mlproject: "ablationkit.mlproject_entrypoint",
  datasetSplit: "ablationkit.split",
  datasetVersion: "ablationkit.version",
  datasetFingerprint: "ablationkit.fingerprint",
  sourceCommit: "ablationkit.source_commit",
  /** Imported runs (ADR 0043): where their files were, who imported them, and when. */
  importSource: "ablationkit.import.source",
  importedBy: "ablationkit.import.by",
  importedAt: "ablationkit.import.at",
  /** The commit the importer says the run used; reported, not checked. */
  importCommit: "ablationkit.import.source_commit",
} as const;

/** MLflow's own description tag: the run's in-depth notes (Markdown), also shown by stock MLflow. */
export const NOTES_TAG = "mlflow.note.content";

/** MLflow truncates tag values beyond this. */
export const MAX_RUN_NOTES = 8000;
export const MAX_RUN_SUMMARY = 2000;

/** Tags users may not set or delete through the API: they are the mapping. */
export function isReservedTag(key: string): boolean {
  return key.startsWith("ablationkit.") || key.startsWith("mlflow.");
}

/** MLflow logs system metrics (CPU, GPU, memory) under this prefix. */
export const SYSTEM_METRIC_PREFIX = "system/";
