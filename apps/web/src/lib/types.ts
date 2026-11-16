/** Shapes of human-API responses the UI reads (see docs/api/coordinator-api.md). */

export interface Tag {
  key: string;
  value: string;
}
export interface Metric {
  key: string;
  value: number;
  timestamp: number;
  step: number;
}

export interface SyncSummary {
  state: string;
  pending_ops: number;
  failed_ops: number;
  last_error?: { message: string };
}

export interface RunMapping {
  ref: string;
  kind: "attempt" | "manual";
  project_id: string;
  mlflow_run_id?: string;
  experiment_id?: string;
  job_id?: string;
  attempt_id?: string;
  study_id?: string;
  variant_id?: string;
  task_id?: string;
  run_name?: string;
  sync_state: string;
  last_error?: string;
  created_at: string;
}

export interface Run {
  info: {
    run_id: string;
    experiment_id: string;
    run_name?: string;
    status: string;
    start_time?: number;
    end_time?: number;
    artifact_uri?: string;
    lifecycle_stage: string;
  };
  data: { metrics?: Metric[]; params?: Tag[]; tags?: Tag[] };
  ablationkit: { read_only: boolean; mapping?: RunMapping; sync?: SyncSummary };
}

export interface PendingRun {
  mapping: RunMapping;
  sync: SyncSummary;
}

export interface RunsPage {
  runs: Run[];
  next_page_token?: string;
  pending_runs: PendingRun[];
  mlflow_available: boolean;
  error?: string;
}

export interface Experiment {
  experiment_id: string;
  name: string;
  lifecycle_stage: string;
  creation_time?: number;
  last_update_time?: number;
  tags?: Tag[];
  ablationkit: { role: "project" | "imported" | "other"; project_id?: string; read_only: boolean };
}

export interface AttemptView {
  attempt_id: string;
  job_id: string;
  project_id: string;
  number: number;
  state: string;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  cancel_requested_at?: string;
  supervisor: {
    mode: string;
    enforcement: string;
    reason?: string;
    unit?: string;
    limits?: Record<string, number>;
  };
  collector: Record<string, unknown>;
  exit_code?: number;
  signal?: string;
  unit_result?: string;
  error?: string;
  snapshot?: Record<string, unknown>;
  artifacts: { path: string; size: number; sha256: string; uploaded_at: string }[];
  tracking: {
    ref: string;
    mlflow_run_id?: string;
    experiment_id?: string;
    sync_state?: string;
    pending_ops?: number;
    failed_ops?: number;
    last_error?: string;
  };
  ingest?: { accepted: number; duplicates: number; rejected: number; last_rejection?: string };
  remote?: RemoteView;
}

/** A remote attempt's compute and sync status (ADR 0023). */
export interface RemoteView {
  target_id: string;
  target_kind: string;
  bundle_id: string;
  source_commit: string;
  staging: string;
  staging_error?: string;
  provider_job_id?: string;
  provider_state?: string;
  provider_checked_at?: string;
  connectivity: string;
  last_contact_at?: string;
  worker_host?: string;
  sync: string;
  sync_error?: string;
  reconcile_required?: string;
  imported_at?: string;
  submitted_at?: string;
  /** Exported attempts: when results should be back (time limit plus slack), set by the coordinator. */
  expected_back_by?: string;
  overdue_at?: string;
  marked_lost_at?: string;
  drains?: number;
  /** A Colab runtime (ADR 0059): its rate, and when it was allocated and released. */
  compute_units?: ColabComputeUnits;
  worker_spool?: {
    pending_events?: number;
    pending_artifacts?: number;
    dropped_events?: number;
    disk_pressure?: boolean;
  };
}

export interface ColabComputeUnits {
  per_hour_hundredths: number;
  balance_at_allocation_hundredths?: number;
  allocated_at: string;
  released_at?: string;
}

/** A Colab account's compute units (`colab usage`: the whole account). */
export interface ColabUsage {
  balance_hundredths: number;
  per_hour_hundredths: number;
  runtimes: number;
  checked_at: string;
}

export interface ComputeTargetView {
  target_id: string;
  kind: string;
  label?: string;
  paid: boolean;
  available: boolean;
  effective_worker_url?: string;
  ssh?: { host: string };
  runpod?: { image: string; gpu_type_ids: string[]; cents_per_hour?: number };
  colab?: {
    mode?: "notebook" | "cli";
    gpu?: string;
    tpu?: string;
    high_mem?: boolean;
    live?: boolean;
  };
  capabilities?: Record<string, boolean>;
}

export interface JobView {
  job_id: string;
  project_id: string;
  command: string[];
  cwd?: string;
  environment: string;
  limits: Record<string, number>;
  artifact_paths: string[];
  metrics_file?: string;
  run_name?: string;
  study_id?: string;
  variant_id?: string;
  task_id?: string;
  target_id?: string;
  submitted_by: { kind: string; id: string };
  state: string;
  attempts: string[];
  created_at: string;
  updated_at: string;
  latest_attempt?: AttemptView;
  attempt_details?: AttemptView[];
}

export interface ConsoleLine {
  seq: number;
  ts: string;
  stream: "stdout" | "stderr" | "log" | "system";
  text: string;
  level?: string;
  logger?: string;
}

export function tagValue(run: Run, key: string): string | undefined {
  return run.data.tags?.find((t) => t.key === key)?.value;
}

export const AK_TAGS = {
  study: "ablationkit.study_id",
  variant: "ablationkit.variant_id",
  job: "ablationkit.job_id",
  attempt: "ablationkit.attempt_id",
  task: "ablationkit.task_id",
  kind: "ablationkit.kind",
  ref: "ablationkit.ref",
  summary: "ablationkit.summary",
  notes: "mlflow.note.content",
  importSource: "ablationkit.import.source",
  importCommit: "ablationkit.import.source_commit",
} as const;

/** A run imported from files written before the project used AblationKit (ADR 0043). */
export function importedFrom(run: Run): string | undefined {
  return tagValue(run, AK_TAGS.kind) === "import"
    ? (tagValue(run, AK_TAGS.importSource) ?? "files")
    : undefined;
}

export function isReservedTag(key: string): boolean {
  return key.startsWith("ablationkit.") || key.startsWith("mlflow.");
}
