/** Public contracts for trusted extension backends. No coordinator service objects cross IPC. */

import type { Termination } from "@ablationkit/process-supervisor";
import type {
  ProjectRegistration,
  ResearchActor,
  ResearchKind,
  ResearchRecord,
} from "@ablationkit/protocol";
import type { MlflowClient } from "@ablationkit/tracking-mlflow";

export interface BackendCaller {
  kind: "human" | "agent";
  id?: string;
}
export interface BackendOperation {
  id: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  agent: boolean;
  /** Human-only: the backend may widen its data controls only while serving this operation. */
  widens_data_controls?: true;
}
export interface BackendManifest {
  id: string;
  version: string;
  host_api: string;
  entry: string;
  capabilities: readonly string[];
  operations: readonly BackendOperation[];
  pages: readonly {
    id: string;
    title: string;
    path: string;
    entry: string;
    profiles?: readonly string[];
    api_path?: string;
  }[];
  services: readonly string[];
  service_agents?: readonly string[];
  uses_services?: readonly string[];
  ingest_services?: Readonly<Record<string, string>>;
  workers?: readonly string[];
  ingest: readonly string[];
  job_sdks: readonly string[];
  agent_skills?: readonly string[];
}
export interface BackendContext {
  project: ProjectRegistration;
  stateDir: string;
  operationDir: string;
  experimentIds: string[];
  links: { experiment_id?: string };
  bridgeAvailable?: string;
  now: string;
  credentialNames: string[];
  retentionSweepMs?: number;
  call<T = unknown>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): void;
  signal: AbortSignal;
}
/** Scoped infrastructure facade. Synchronous fields are request-refreshed snapshots. */
export interface ExtensionResearchHost {
  registry: { list(): readonly ProjectRegistration[]; require(pid: string): ProjectRegistration };
  models: { experimentIds(pid: string): string[] };
  tracking: {
    client: MlflowClient;
    ensureExperimentNow(pid: string): Promise<string>;
    mappings: { getLinks(pid: string): { experiment_id?: string } };
  };
  audit: { record(event: Record<string, unknown>): void };
  events: { publish(pid: string, type: string, payload: Record<string, unknown>): void };
  /**
   * Remote compute through the host (`compute.remote`, ADR 0024): jobs on a compute target that
   * carry staged inputs from the project's state. Submitting, checking and cancelling need a
   * researcher caller; reads and cancels cover only this extension's own jobs.
   */
  compute: {
    target(id: string): Promise<{ target_id: string; kind: string; python?: string } | null>;
    check(targetId: string, opts: { acceptCost: boolean; runtimeSec: number }): Promise<void>;
    submit(input: {
      command: string[];
      environment: "uv" | "none";
      runtime_max_sec: number;
      run_name: string;
      target_id: string;
      accept_cost: boolean;
      inputs: { name: string; path: string }[];
    }): Promise<{ job_id: string; attempt_id: string; source_commit?: string }>;
    job(jobId: string): Promise<ExtensionComputeJob | null>;
    cancel(jobId: string): Promise<void>;
  };
  research: {
    get(pid: string, id: string): Promise<ResearchRecord | undefined>;
    require(pid: string, id: string): Promise<ResearchRecord>;
    list(pid: string, query?: { link?: string }): Promise<ResearchRecord[]>;
    create(
      pid: string,
      kind: ResearchKind,
      input: Record<string, unknown>,
      actor: ResearchActor,
      opts?: { listener?: "human" | "agent" },
    ): Promise<ResearchRecord>;
    update(
      pid: string,
      id: string,
      patch: Record<string, unknown>,
      actor: ResearchActor,
    ): Promise<ResearchRecord>;
  };
}
/** A job submitted through `compute.submit`, as the host shows it to the extension. */
export interface ExtensionComputeJob {
  job_id: string;
  attempt?: {
    attempt_id: string;
    state: string;
    exit_code?: number;
    error?: string;
    sync?: string;
    reconcile_required?: string;
    artifacts: string[];
    mlflow_run_id?: string;
  };
}
export interface ExtensionPythonRun {
  id: string;
  unit: string;
  enforcement: "enforced" | "advisory";
  done: Promise<ExtensionPythonOutcome>;
  stop(): Promise<void>;
}
export interface ExtensionPythonOutcome {
  result?: Record<string, unknown>;
  termination: Termination;
  log_tail: string;
}
export interface ExtensionPythonBridge {
  available(environment: "managed" | "project"): string | undefined;
  reap(id: string): void;
  start(
    id: string,
    request: Record<string, unknown>,
    opts: {
      environment: "managed" | "project";
      projectPath?: string;
      timeoutSec: number;
      memoryMb?: number;
      secretEnv?: Record<string, string>;
    },
  ): Promise<ExtensionPythonRun>;
  logPath(id: string): string;
}

/** Transitional public bridge adapters return generic execution and quota metadata. */
export interface BackendLegacyPlan {
  work: unknown;
  quotas?: { key: string; count: number; limit: number }[];
  cost?: { key: string; max_usd: number };
}
