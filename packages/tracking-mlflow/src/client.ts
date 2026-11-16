/**
 * Typed client for the version-pinned MLflow REST API (spec §5.5: "prefer version-pinned official
 * MLflow REST APIs"). Only the coordinator talks to MLflow; nothing here is exposed to browsers,
 * agents or extensions. Contract-tested against the pinned sidecar (test/contract.test.ts).
 */

import { recordMlflowUse } from "./usage-trace.ts";

export type MlflowErrorKind = "unavailable" | "ambiguous" | "rejected";

/**
 * - `unavailable`: the request did not reach MLflow, or MLflow answered 5xx/429. Safe to retry.
 * - `ambiguous`: the request was sent but no answer arrived (timeout, reset). It may have landed.
 * - `rejected`: MLflow answered 4xx. Retrying the same request will not help.
 */
export class MlflowError extends Error {
  constructor(
    readonly kind: MlflowErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "MlflowError";
  }

  get notFound(): boolean {
    return this.status === 404 || this.code === "RESOURCE_DOES_NOT_EXIST";
  }
}

export interface MlflowTag {
  key: string;
  value: string;
}

export interface MlflowMetric {
  key: string;
  value: number;
  timestamp: number;
  step: number;
}

export interface MlflowParam {
  key: string;
  value: string;
}

export type LifecycleStage = "active" | "deleted";
export type ViewType = "ACTIVE_ONLY" | "DELETED_ONLY" | "ALL";
export type RunStatus = "RUNNING" | "SCHEDULED" | "FINISHED" | "FAILED" | "KILLED";

export interface MlflowExperiment {
  experiment_id: string;
  name: string;
  artifact_location?: string;
  lifecycle_stage: LifecycleStage;
  creation_time?: number;
  last_update_time?: number;
  tags?: MlflowTag[];
}

export interface MlflowRunInfo {
  run_id: string;
  experiment_id: string;
  run_name?: string;
  status: RunStatus;
  start_time?: number;
  end_time?: number;
  artifact_uri?: string;
  lifecycle_stage: LifecycleStage;
}

export interface MlflowRun {
  info: MlflowRunInfo;
  data: { metrics?: MlflowMetric[]; params?: MlflowParam[]; tags?: MlflowTag[] };
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

export interface MlflowFileInfo {
  path: string;
  is_dir: boolean;
  file_size?: number;
}

export interface Page<T> {
  items: T[];
  next_page_token?: string;
}

export interface SearchRunsInput {
  experiment_ids: string[];
  filter?: string;
  run_view_type?: ViewType;
  max_results?: number;
  order_by?: string[];
  page_token?: string;
}

/** MLflow's per-request limits for `runs/log-batch`. */
export const LOG_BATCH_LIMITS = { metrics: 1000, params: 100, tags: 100, total: 1000 } as const;

export interface MlflowClientOptions {
  /** Base URL of the tracking server, for example `http://127.0.0.1:7423`. */
  readonly url: string | (() => string | undefined);
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const API = "/api/2.0/mlflow";

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export class MlflowClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MlflowClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  get baseUrl(): string | undefined {
    const u = this.options.url;
    return typeof u === "function" ? u() : u;
  }

  /** Low-level request. `path` starts with `/`. Returns the raw response for streaming callers. */
  async raw(
    method: string,
    path: string,
    init: {
      body?: unknown;
      rawBody?: Uint8Array | string | Blob;
      query?: Record<string, string | undefined>;
    } = {},
  ): Promise<Response> {
    const base = this.baseUrl;
    if (!base) throw new MlflowError("unavailable", "MLflow is not running");
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(init.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        signal: ctrl.signal,
        ...(init.rawBody !== undefined
          ? { body: init.rawBody }
          : init.body === undefined
            ? {}
            : {
                body: JSON.stringify(init.body),
                headers: { "content-type": "application/json" },
              }),
      });
    } catch (e) {
      clearTimeout(timer);
      recordMlflowUse(`rest ${method} ${url.pathname} failed`);
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string }).code ?? "";
      // Refused or unresolvable: nothing was sent. Anything else after send may have landed.
      if (
        /ECONNREFUSED|ConnectionRefused|ENOTFOUND|FailedToOpenSocket|Unable to connect/i.test(
          `${code} ${msg}`,
        )
      )
        throw new MlflowError("unavailable", `MLflow unreachable: ${msg}`);
      if (method === "GET") throw new MlflowError("unavailable", `MLflow request failed: ${msg}`);
      throw new MlflowError("ambiguous", `MLflow request outcome unknown: ${msg}`);
    }
    clearTimeout(timer);
    recordMlflowUse(`rest ${method} ${url.pathname} ${res.status}`);
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    let code: string | undefined;
    let message = text.slice(0, 1000) || res.statusText;
    try {
      const j = JSON.parse(text) as { error_code?: string; message?: string };
      code = j.error_code;
      if (j.message) message = j.message.slice(0, 1000);
    } catch {
      // not JSON
    }
    const kind: MlflowErrorKind =
      res.status >= 500 || res.status === 429 ? "unavailable" : "rejected";
    throw new MlflowError(kind, message, res.status, code);
  }

  private async call<T>(
    method: "GET" | "POST",
    endpoint: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const clean = body ? stripUndefined(body) : undefined;
    const res =
      method === "GET"
        ? await this.raw("GET", `${API}/${endpoint}`, {
            query: Object.fromEntries(
              Object.entries(clean ?? {}).map(([k, v]) => [
                k,
                v === undefined ? undefined : String(v),
              ]),
            ),
          })
        : await this.raw("POST", `${API}/${endpoint}`, { body: clean ?? {} });
    const text = await res.text();
    return (text.length ? JSON.parse(text) : {}) as T;
  }

  // ------------------------------------------------------------------ server

  async health(): Promise<boolean> {
    try {
      const r = await this.raw("GET", "/health");
      return (await r.text()).trim() === "OK";
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    const r = await this.raw("GET", "/version");
    return (await r.text()).trim();
  }

  // ------------------------------------------------------------- experiments

  async createExperiment(name: string, tags: MlflowTag[] = []): Promise<string> {
    const r = await this.call<{ experiment_id: string }>("POST", "experiments/create", {
      name,
      tags: tags.length ? tags : undefined,
    });
    return r.experiment_id;
  }

  async getExperiment(id: string): Promise<MlflowExperiment> {
    const r = await this.call<{ experiment: MlflowExperiment }>("GET", "experiments/get", {
      experiment_id: id,
    });
    return r.experiment;
  }

  /** Undefined if no experiment (active or deleted) has that name. */
  async getExperimentByName(name: string): Promise<MlflowExperiment | undefined> {
    try {
      const r = await this.call<{ experiment: MlflowExperiment }>(
        "GET",
        "experiments/get-by-name",
        {
          experiment_name: name,
        },
      );
      return r.experiment;
    } catch (e) {
      if (e instanceof MlflowError && e.notFound) return undefined;
      throw e;
    }
  }

  async searchExperiments(input: {
    filter?: string;
    view_type?: ViewType;
    max_results?: number;
    order_by?: string[];
    page_token?: string;
  }): Promise<Page<MlflowExperiment>> {
    const r = await this.call<{ experiments?: MlflowExperiment[]; next_page_token?: string }>(
      "POST",
      "experiments/search",
      // MLflow rejects a missing max_results here (it reads the proto default 0).
      { max_results: 1000, ...input },
    );
    return {
      items: r.experiments ?? [],
      ...(r.next_page_token ? { next_page_token: r.next_page_token } : {}),
    };
  }

  async renameExperiment(id: string, name: string): Promise<void> {
    await this.call("POST", "experiments/update", { experiment_id: id, new_name: name });
  }

  async deleteExperiment(id: string): Promise<void> {
    await this.call("POST", "experiments/delete", { experiment_id: id });
  }

  async restoreExperiment(id: string): Promise<void> {
    await this.call("POST", "experiments/restore", { experiment_id: id });
  }

  async setExperimentTag(id: string, key: string, value: string): Promise<void> {
    await this.call("POST", "experiments/set-experiment-tag", { experiment_id: id, key, value });
  }

  // -------------------------------------------------------------------- runs

  async createRun(input: {
    experiment_id: string;
    run_name?: string;
    start_time?: number;
    tags?: MlflowTag[];
  }): Promise<MlflowRun> {
    const r = await this.call<{ run: MlflowRun }>("POST", "runs/create", { ...input });
    return r.run;
  }

  async getRun(id: string): Promise<MlflowRun> {
    const r = await this.call<{ run: MlflowRun }>("GET", "runs/get", { run_id: id });
    return r.run;
  }

  async searchRuns(input: SearchRunsInput): Promise<Page<MlflowRun>> {
    const r = await this.call<{ runs?: MlflowRun[]; next_page_token?: string }>(
      "POST",
      "runs/search",
      {
        ...input,
      },
    );
    return {
      items: r.runs ?? [],
      ...(r.next_page_token ? { next_page_token: r.next_page_token } : {}),
    };
  }

  async updateRun(input: {
    run_id: string;
    status?: RunStatus;
    end_time?: number;
    run_name?: string;
  }): Promise<MlflowRunInfo> {
    const r = await this.call<{ run_info: MlflowRunInfo }>("POST", "runs/update", { ...input });
    return r.run_info;
  }

  async deleteRun(id: string): Promise<void> {
    await this.call("POST", "runs/delete", { run_id: id });
  }

  async restoreRun(id: string): Promise<void> {
    await this.call("POST", "runs/restore", { run_id: id });
  }

  async setTag(runId: string, key: string, value: string): Promise<void> {
    await this.call("POST", "runs/set-tag", { run_id: runId, key, value });
  }

  async deleteTag(runId: string, key: string): Promise<void> {
    await this.call("POST", "runs/delete-tag", { run_id: runId, key });
  }

  /** One request; callers split to {@link LOG_BATCH_LIMITS} (see `chunkBatch`). */
  async logBatch(input: {
    run_id: string;
    metrics?: MlflowMetric[];
    params?: MlflowParam[];
    tags?: MlflowTag[];
  }): Promise<void> {
    await this.call("POST", "runs/log-batch", {
      run_id: input.run_id,
      metrics: input.metrics?.length ? input.metrics : undefined,
      params: input.params?.length ? input.params : undefined,
      tags: input.tags?.length ? input.tags : undefined,
    });
  }

  async getMetricHistory(input: {
    run_id: string;
    metric_key: string;
    max_results?: number;
    page_token?: string;
  }): Promise<Page<MlflowMetric>> {
    const r = await this.call<{ metrics?: MlflowMetric[]; next_page_token?: string }>(
      "GET",
      "metrics/get-history",
      { ...input },
    );
    return {
      items: r.metrics ?? [],
      ...(r.next_page_token ? { next_page_token: r.next_page_token } : {}),
    };
  }

  // --------------------------------------------------------------- artifacts

  async listArtifacts(
    runId: string,
    path?: string,
    pageToken?: string,
  ): Promise<Page<MlflowFileInfo> & { root_uri?: string }> {
    const r = await this.call<{
      files?: MlflowFileInfo[];
      root_uri?: string;
      next_page_token?: string;
    }>("GET", "artifacts/list", { run_id: runId, path, page_token: pageToken });
    return {
      items: r.files ?? [],
      ...(r.root_uri ? { root_uri: r.root_uri } : {}),
      ...(r.next_page_token ? { next_page_token: r.next_page_token } : {}),
    };
  }

  /** Streams one artifact file through the server's artifact proxy. `path` must be validated by the caller. */
  async downloadArtifact(runId: string, path: string): Promise<Response> {
    return this.raw("GET", "/get-artifact", { query: { path, run_uuid: runId } });
  }

  /** Upload through the `mlflow-artifacts` proxy (requires `--serve-artifacts`). */
  async uploadArtifact(
    run: MlflowRunInfo,
    path: string,
    body: Uint8Array | string | Blob,
  ): Promise<void> {
    const uri = run.artifact_uri ?? "";
    const prefix = "mlflow-artifacts:/";
    if (!uri.startsWith(prefix))
      throw new MlflowError("rejected", `run artifact URI ${uri} is not proxied`);
    const rel = `${uri.slice(prefix.length).replace(/^\/+/, "")}/${path}`;
    const base = this.baseUrl;
    if (!base) throw new MlflowError("unavailable", "MLflow is not running");
    const res = await this.fetchImpl(new URL(`/api/2.0/mlflow-artifacts/artifacts/${rel}`, base), {
      method: "PUT",
      body,
    }).catch((e: unknown) => {
      throw new MlflowError("ambiguous", `artifact upload outcome unknown: ${String(e)}`);
    });
    if (!res.ok)
      throw new MlflowError(
        res.status >= 500 ? "unavailable" : "rejected",
        await res.text(),
        res.status,
      );
  }

  // ---------------------------------------------------------------- datasets

  /** `runs/log-inputs`. MLflow reuses a dataset with the same name and digest in an experiment. */
  async logInputs(runId: string, datasets: MlflowDatasetInput[]): Promise<void> {
    await this.call("POST", "runs/log-inputs", { run_id: runId, datasets });
  }

  /** `runs/outputs`: record that a run produced logged models. */
  async logOutputs(runId: string, models: { model_id: string; step: number }[]): Promise<void> {
    await this.call("POST", "runs/outputs", { run_id: runId, models });
  }

  // ------------------------------------------------------------------ models

  async createLoggedModel(input: {
    experiment_id: string;
    name: string;
    source_run_id?: string;
    model_type?: string;
    tags?: MlflowTag[];
    params?: MlflowParam[];
  }): Promise<MlflowLoggedModel> {
    const r = await this.call<{ model: MlflowLoggedModel }>("POST", "logged-models", { ...input });
    return r.model;
  }

  async getLoggedModel(modelId: string): Promise<MlflowLoggedModel> {
    const r = await this.call<{ model: MlflowLoggedModel }>(
      "GET",
      `logged-models/${encodeURIComponent(modelId)}`,
    );
    return r.model;
  }

  async finalizeLoggedModel(
    modelId: string,
    status: "LOGGED_MODEL_READY" | "LOGGED_MODEL_UPLOAD_FAILED",
  ): Promise<MlflowLoggedModel> {
    const res = await this.raw("PATCH", `${API}/logged-models/${encodeURIComponent(modelId)}`, {
      body: { model_id: modelId, status },
    });
    return ((await res.json()) as { model: MlflowLoggedModel }).model;
  }

  async searchLoggedModels(input: {
    experiment_ids: string[];
    filter?: string;
    max_results?: number;
    order_by?: { field_name: string; ascending?: boolean }[];
    page_token?: string;
  }): Promise<Page<MlflowLoggedModel>> {
    const r = await this.call<{ models?: MlflowLoggedModel[]; next_page_token?: string }>(
      "POST",
      "logged-models/search",
      { ...input },
    );
    return {
      items: r.models ?? [],
      ...(r.next_page_token ? { next_page_token: r.next_page_token } : {}),
    };
  }

  /**
   * Proxied artifact path (relative to the `mlflow-artifacts:` root) for a file under a logged
   * model or run artifact URI. Throws for URIs the server does not proxy.
   */
  static proxiedPath(artifactUri: string, path = ""): string {
    const prefix = "mlflow-artifacts:/";
    if (!artifactUri.startsWith(prefix))
      throw new MlflowError("rejected", `artifact URI ${artifactUri} is not proxied`);
    const root = artifactUri.slice(prefix.length).replace(/^\/+/, "").replace(/\/+$/, "");
    return path ? `${root}/${path}` : root;
  }

  /** List one directory under an artifact URI through the `mlflow-artifacts` proxy. */
  async listProxiedArtifacts(artifactUri: string, path = ""): Promise<MlflowFileInfo[]> {
    const res = await this.raw("GET", "/api/2.0/mlflow-artifacts/artifacts", {
      query: { path: MlflowClient.proxiedPath(artifactUri, path) },
    });
    const j = (await res.json()) as { files?: MlflowFileInfo[] };
    return (j.files ?? []).map((f) => ({ ...f, path: path ? `${path}/${f.path}` : f.path }));
  }

  /** Stream one file under an artifact URI through the proxy. */
  async downloadProxiedArtifact(artifactUri: string, path: string): Promise<Response> {
    const rel = MlflowClient.proxiedPath(artifactUri, path)
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    return this.raw("GET", `/api/2.0/mlflow-artifacts/artifacts/${rel}`);
  }

  /** Upload one file under an artifact URI through the proxy. */
  async uploadProxiedArtifact(
    artifactUri: string,
    path: string,
    body: Uint8Array | string | Blob,
  ): Promise<void> {
    const rel = MlflowClient.proxiedPath(artifactUri, path)
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    await this.raw("PUT", `/api/2.0/mlflow-artifacts/artifacts/${rel}`, { rawBody: body });
  }

  // ---------------------------------------------------------------- registry

  async searchRegisteredModels(input: {
    filter?: string;
    max_results?: number;
    order_by?: string[];
    page_token?: string;
  }): Promise<Page<MlflowRegisteredModel>> {
    const r = await this.call<{
      registered_models?: MlflowRegisteredModel[];
      next_page_token?: string;
    }>("GET", "registered-models/search", {
      ...input,
      order_by: input.order_by?.join(","),
    });
    return {
      items: r.registered_models ?? [],
      ...(r.next_page_token ? { next_page_token: r.next_page_token } : {}),
    };
  }

  async createRegisteredModel(input: {
    name: string;
    description?: string;
    tags?: MlflowTag[];
  }): Promise<MlflowRegisteredModel> {
    const r = await this.call<{ registered_model: MlflowRegisteredModel }>(
      "POST",
      "registered-models/create",
      { ...input, tags: input.tags?.length ? input.tags : undefined },
    );
    return r.registered_model;
  }

  async getRegisteredModel(name: string): Promise<MlflowRegisteredModel> {
    const r = await this.call<{ registered_model: MlflowRegisteredModel }>(
      "GET",
      "registered-models/get",
      { name },
    );
    return r.registered_model;
  }

  async updateRegisteredModel(name: string, description: string): Promise<void> {
    await this.raw("PATCH", `${API}/registered-models/update`, { body: { name, description } });
  }

  async setRegisteredModelTag(name: string, key: string, value: string): Promise<void> {
    await this.call("POST", "registered-models/set-tag", { name, key, value });
  }

  async deleteRegisteredModelTag(name: string, key: string): Promise<void> {
    await this.raw("DELETE", `${API}/registered-models/delete-tag`, { body: { name, key } });
  }

  async createModelVersion(input: {
    name: string;
    source: string;
    run_id?: string;
    model_id?: string;
    description?: string;
    tags?: MlflowTag[];
  }): Promise<MlflowModelVersion> {
    const r = await this.call<{ model_version: MlflowModelVersion }>(
      "POST",
      "model-versions/create",
      { ...input, tags: input.tags?.length ? input.tags : undefined },
    );
    return r.model_version;
  }

  async getModelVersion(name: string, version: string): Promise<MlflowModelVersion> {
    const r = await this.call<{ model_version: MlflowModelVersion }>("GET", "model-versions/get", {
      name,
      version,
    });
    return r.model_version;
  }

  async searchModelVersions(input: {
    filter?: string;
    max_results?: number;
    order_by?: string[];
    page_token?: string;
  }): Promise<Page<MlflowModelVersion>> {
    const r = await this.call<{ model_versions?: MlflowModelVersion[]; next_page_token?: string }>(
      "GET",
      "model-versions/search",
      { ...input, order_by: input.order_by?.join(",") },
    );
    return {
      items: r.model_versions ?? [],
      ...(r.next_page_token ? { next_page_token: r.next_page_token } : {}),
    };
  }

  async updateModelVersion(name: string, version: string, description: string): Promise<void> {
    await this.raw("PATCH", `${API}/model-versions/update`, {
      body: { name, version, description },
    });
  }

  async setModelVersionTag(name: string, version: string, key: string, value: string) {
    await this.call("POST", "model-versions/set-tag", { name, version, key, value });
  }

  async deleteModelVersionTag(name: string, version: string, key: string): Promise<void> {
    await this.raw("DELETE", `${API}/model-versions/delete-tag`, { body: { name, version, key } });
  }

  async setAlias(name: string, alias: string, version: string): Promise<void> {
    await this.call("POST", "registered-models/alias", { name, alias, version });
  }

  async deleteAlias(name: string, alias: string): Promise<void> {
    await this.raw("DELETE", `${API}/registered-models/alias`, { body: { name, alias } });
  }

  async getVersionByAlias(name: string, alias: string): Promise<MlflowModelVersion> {
    const r = await this.call<{ model_version: MlflowModelVersion }>(
      "GET",
      "registered-models/alias",
      { name, alias },
    );
    return r.model_version;
  }

  // ------------------------------------------------------------------ traces (MLflow 3, v3 API)

  private async v3<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(
      method,
      `/api/3.0/mlflow/${path}`,
      body === undefined ? {} : { body },
    );
    const text = await res.text();
    return (text.length ? JSON.parse(text) : {}) as T;
  }

  /** Create a finished trace's info (StartTraceV3). Spans are uploaded separately. */
  async startTrace(info: MlflowTraceInfo): Promise<MlflowTraceInfo> {
    const r = await this.v3<{ trace: { trace_info: MlflowTraceInfo } }>("POST", "traces", {
      trace: { trace_info: info },
    });
    return r.trace.trace_info;
  }

  async searchTraces(input: {
    experiment_ids: readonly string[];
    filter?: string;
    max_results?: number;
    order_by?: readonly string[];
    page_token?: string;
  }): Promise<Page<MlflowTraceInfo>> {
    const r = await this.v3<{ traces?: MlflowTraceInfo[]; next_page_token?: string }>(
      "POST",
      "traces/search",
      stripUndefined({
        locations: input.experiment_ids.map((id) => ({
          type: "MLFLOW_EXPERIMENT",
          mlflow_experiment: { experiment_id: id },
        })),
        filter: input.filter,
        max_results: input.max_results,
        order_by: input.order_by?.length ? input.order_by : undefined,
        page_token: input.page_token,
      }),
    );
    return {
      items: r.traces ?? [],
      ...(r.next_page_token ? { next_page_token: r.next_page_token } : {}),
    };
  }

  async getTraceInfo(traceId: string): Promise<MlflowTraceInfo> {
    const r = await this.v3<{ trace: { trace_info: MlflowTraceInfo } }>(
      "GET",
      `traces/${encodeURIComponent(traceId)}`,
    );
    return r.trace.trace_info;
  }

  /** The trace's spans in MLflow's `traces.json` format, wherever MLflow keeps them. */
  async getTraceSpans(traceId: string): Promise<unknown[]> {
    const res = await this.raw("GET", "/ajax-api/3.0/mlflow/get-trace-artifact", {
      query: { request_id: traceId },
    });
    const j = (await res.json()) as { spans?: unknown[] };
    return j.spans ?? [];
  }

  /** Upload spans to the trace's artifact location (what the Python SDK does without OTLP). */
  async uploadTraceSpans(info: MlflowTraceInfo, spans: readonly unknown[]): Promise<void> {
    const loc = info.tags?.["mlflow.artifactLocation"];
    if (!loc) throw new MlflowError("rejected", `trace ${info.trace_id} has no artifact location`);
    await this.uploadProxiedArtifact(loc, "traces.json", JSON.stringify({ spans }));
  }

  async setTraceTag(traceId: string, key: string, value: string): Promise<void> {
    await this.v3("PATCH", `traces/${encodeURIComponent(traceId)}/tags`, { key, value });
  }

  async createAssessment(traceId: string, a: MlflowAssessmentInput): Promise<MlflowAssessment> {
    const r = await this.v3<{ assessment: MlflowAssessment }>(
      "POST",
      `traces/${encodeURIComponent(traceId)}/assessments`,
      { assessment: { ...a, trace_id: traceId } },
    );
    return r.assessment;
  }

  /** Delete by IDs, or everything older than a timestamp (retention). Returns the count. */
  async deleteTraces(input: {
    experiment_id: string;
    trace_ids?: readonly string[];
    max_timestamp_millis?: number;
    max_traces?: number;
  }): Promise<number> {
    const r = await this.v3<{ traces_deleted?: number }>(
      "POST",
      "traces/delete-traces",
      stripUndefined({
        experiment_id: input.experiment_id,
        request_ids: input.trace_ids?.length ? input.trace_ids : undefined,
        max_timestamp_millis: input.max_timestamp_millis,
        max_traces: input.max_traces,
      }),
    );
    return r.traces_deleted ?? 0;
  }

  // ------------------------------------------------------- GenAI evaluation datasets

  async createGenaiDataset(input: {
    name: string;
    experiment_ids: readonly string[];
    tags?: Record<string, string>;
  }): Promise<{ dataset_id: string; digest?: string }> {
    const r = await this.v3<{ dataset: { dataset_id: string; digest?: string } }>(
      "POST",
      "datasets/create",
      stripUndefined({
        name: input.name,
        experiment_ids: input.experiment_ids,
        tags: input.tags ? JSON.stringify(input.tags) : undefined,
      }),
    );
    return r.dataset;
  }

  async upsertGenaiDatasetRecords(datasetId: string, records: readonly unknown[]): Promise<number> {
    const r = await this.v3<{ inserted_count?: number; updated_count?: number }>(
      "POST",
      `datasets/${encodeURIComponent(datasetId)}/records`,
      { records: JSON.stringify(records) },
    );
    return (r.inserted_count ?? 0) + (r.updated_count ?? 0);
  }
}

export interface MlflowTraceInfo {
  trace_id: string;
  trace_location?: {
    type: string;
    mlflow_experiment?: { experiment_id: string };
  };
  request_time: string;
  execution_duration?: string;
  state: "OK" | "ERROR" | "IN_PROGRESS" | "STATE_UNSPECIFIED";
  request_preview?: string;
  response_preview?: string;
  client_request_id?: string;
  trace_metadata?: Record<string, string>;
  tags?: Record<string, string>;
  assessments?: MlflowAssessment[];
}

export interface MlflowAssessmentInput {
  assessment_name: string;
  source: { source_type: "HUMAN" | "LLM_JUDGE" | "CODE"; source_id?: string };
  feedback?: { value: unknown; error?: { error_code?: string; error_message?: string } };
  expectation?: { value: unknown };
  rationale?: string;
  metadata?: Record<string, string>;
  span_id?: string;
}

export interface MlflowAssessment extends MlflowAssessmentInput {
  assessment_id: string;
  trace_id: string;
  create_time?: string;
  last_update_time?: string;
  valid?: boolean;
}

export interface MlflowDataset {
  name: string;
  digest: string;
  source_type: string;
  source: string;
  schema?: string;
  profile?: string;
}

export interface MlflowDatasetInput {
  tags?: MlflowTag[];
  dataset: MlflowDataset;
}

export type LoggedModelStatus =
  | "LOGGED_MODEL_PENDING"
  | "LOGGED_MODEL_READY"
  | "LOGGED_MODEL_UPLOAD_FAILED"
  | "LOGGED_MODEL_STATUS_UNSPECIFIED";

export interface MlflowLoggedModel {
  info: {
    model_id: string;
    experiment_id: string;
    name: string;
    creation_timestamp_ms?: number;
    last_updated_timestamp_ms?: number;
    artifact_uri: string;
    status: LoggedModelStatus;
    model_type?: string;
    source_run_id?: string;
    tags?: MlflowTag[];
  };
  data: {
    params?: MlflowParam[];
    metrics?: (MlflowMetric & {
      dataset_name?: string;
      dataset_digest?: string;
      run_id?: string;
    })[];
  };
}

export interface MlflowModelVersion {
  name: string;
  version: string;
  creation_timestamp?: number;
  last_updated_timestamp?: number;
  description?: string;
  source: string;
  run_id?: string;
  status?: string;
  tags?: MlflowTag[];
  aliases?: string[];
  model_id?: string;
}

export interface MlflowRegisteredModel {
  name: string;
  creation_timestamp?: number;
  last_updated_timestamp?: number;
  description?: string;
  latest_versions?: MlflowModelVersion[];
  tags?: MlflowTag[];
  aliases?: { alias: string; version: string }[];
}

/** Split one logical batch into requests within MLflow's log-batch limits. Order is preserved. */
export function chunkBatch(b: {
  metrics?: readonly MlflowMetric[];
  params?: readonly MlflowParam[];
  tags?: readonly MlflowTag[];
}): { metrics: MlflowMetric[]; params: MlflowParam[]; tags: MlflowTag[] }[] {
  const out: { metrics: MlflowMetric[]; params: MlflowParam[]; tags: MlflowTag[] }[] = [];
  let cur = { metrics: [] as MlflowMetric[], params: [] as MlflowParam[], tags: [] as MlflowTag[] };
  const total = () => cur.metrics.length + cur.params.length + cur.tags.length;
  const push = <K extends "metrics" | "params" | "tags">(k: K, item: (typeof cur)[K][number]) => {
    if (total() >= LOG_BATCH_LIMITS.total || cur[k].length >= LOG_BATCH_LIMITS[k]) {
      out.push(cur);
      cur = { metrics: [], params: [], tags: [] };
    }
    (cur[k] as (typeof item)[]).push(item);
  };
  // Params and tags first: a run's params should exist before its metrics land.
  for (const p of b.params ?? []) push("params", p);
  for (const t of b.tags ?? []) push("tags", t);
  for (const m of b.metrics ?? []) push("metrics", m);
  if (total() > 0 || out.length === 0) out.push(cur);
  return out;
}
