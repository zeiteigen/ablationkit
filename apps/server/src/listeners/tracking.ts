/**
 * Tracking API on the human listener (spec §4.3, §5.5; ADR 0010). React, the CLI and Agent Skills
 * reach MLflow only through these typed routes; MLflow itself stays on loopback and is never
 * proxied wholesale.
 *
 * Reads go to MLflow and are annotated with AblationKit's mapping. Structured writes for runs
 * AblationKit owns go through the durable outbox and answer `202 tracking_pending` until MLflow
 * acknowledges them. Management writes (rename, archive, tags) are synchronous and fail with
 * `503 tracking_unavailable` while MLflow is down. Imported experiments are read-only.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "@ablationkit/core";
import {
  type PendingRestore,
  type TrackingRunMapping,
  validatePendingRestore,
} from "@ablationkit/protocol";
import {
  isReservedTag,
  lttb,
  MAX_RUN_NOTES,
  MAX_RUN_SUMMARY,
  MlflowError,
  type MlflowExperiment,
  type MlflowMetric,
  type MlflowRun,
  NOTES_TAG,
  OutboxFullError,
  RESERVED_EXPERIMENT_PREFIX,
  type RunStatus,
  SYSTEM_METRIC_PREFIX,
  sortHistory,
  TAGS,
  TrackingInputError,
  type ViewType,
} from "@ablationkit/tracking-mlflow";
import { HttpError, intParam, json, readJsonBody, str } from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";
import { exportBackup, verifyBackup } from "../state/backup.ts";
import { pendingRestorePath, readPendingRestore } from "../state/restore.ts";
import { audit, session } from "./common.ts";
import type { HumanCall, HumanHandler } from "./human.ts";
import type { ResearchCall, ResearchOp } from "./research.ts";

/** How long a write waits for MLflow before answering 202 tracking_pending. */
export const WRITE_WAIT_MS = 2000;

/** Translate tracking-layer errors into explicit API errors. */
async function mlflow<T>(svc: Services, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toHttp(svc, e);
  }
}

function toHttp(svc: Services, e: unknown): unknown {
  if (e instanceof MlflowError) {
    if (e.kind !== "rejected")
      return new HttpError(503, "tracking_unavailable", `MLflow is unavailable: ${e.message}`, {
        sidecar: svc.sidecarStatus().state,
      });
    if (e.notFound) return new HttpError(404, "not_found", e.message);
    return new HttpError(400, "mlflow_rejected", e.message, compact({ mlflow_code: e.code }));
  }
  if (e instanceof TrackingInputError) return new HttpError(400, "invalid_request", e.message);
  if (e instanceof OutboxFullError)
    return new HttpError(503, "tracking_outbox_full", e.message, {
      outbox: { ...e.stats, limits: e.limits },
    });
  return e;
}

// ------------------------------------------------------------------ parsing

function listParam(url: URL, key: string): string[] {
  return url.searchParams
    .getAll(key)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function viewParam(url: URL): ViewType {
  const v = url.searchParams.get("view") ?? "active";
  const map: Record<string, ViewType> = {
    active: "ACTIVE_ONLY",
    deleted: "DELETED_ONLY",
    all: "ALL",
  };
  const out = map[v];
  if (!out) throw new HttpError(400, "invalid_request", "view must be active, deleted or all");
  return out;
}

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
function idParam(c: HumanCall, key = "id"): string {
  const v = c.params[key] as string;
  if (!ID_RE.test(v)) throw new HttpError(400, "invalid_request", `bad ${key}`);
  return v;
}

/** Artifact paths are relative, normalized and never escape the run's artifact root. */
export function safeArtifactPath(raw: string | null, required: boolean): string | undefined {
  if (raw === null || raw === "") {
    if (required) throw new HttpError(400, "invalid_request", "path is required");
    return undefined;
  }
  const bad =
    raw.length > 1024 ||
    raw.startsWith("/") ||
    raw.includes("\\") ||
    raw.includes("\0") ||
    raw.includes("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) ||
    raw.split("/").some((s) => s === ".." || s === ".");
  if (bad)
    throw new HttpError(
      400,
      "invalid_artifact_path",
      "artifact path must be relative and stay inside the run",
    );
  return raw.replace(/\/$/, "");
}

function tagsObject(body: Record<string, unknown>, key: string): { key: string; value: string }[] {
  const v = body[key];
  if (v === undefined) return [];
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new HttpError(400, "invalid_request", `\`${key}\` must be an object of strings`);
  return Object.entries(v).map(([k, val]) => {
    if (typeof val !== "string")
      throw new HttpError(400, "invalid_request", `${key}.${k} must be a string`);
    return { key: k, value: val };
  });
}

function arrayField<T>(body: Record<string, unknown>, key: string): T[] | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new HttpError(400, "invalid_request", `\`${key}\` must be an array`);
  return v as T[];
}

// ------------------------------------------------------------- annotation

function expView(svc: Services, e: MlflowExperiment): Record<string, unknown> {
  const owner = svc.tracking.mappings.projectForExperiment(e.experiment_id);
  const importer = svc.tracking.mappings.importOwner(e.experiment_id);
  return {
    ...e,
    ablationkit: compact({
      role: owner ? "project" : importer ? "imported" : "other",
      project_id: owner ?? importer,
      read_only: importer !== undefined,
    }),
  };
}

function mappingView(svc: Services, m: TrackingRunMapping): Record<string, unknown> {
  return { mapping: m, sync: svc.tracking.sync(m.ref) };
}

function runView(svc: Services, r: MlflowRun): Record<string, unknown> {
  const m = svc.tracking.mappings.getByRunId(r.info.run_id);
  return {
    ...r,
    ablationkit: {
      read_only: svc.tracking.mappings.importOwner(r.info.experiment_id) !== undefined,
      ...(m ? mappingView(svc, m) : {}),
    },
  };
}

/** A run named by MLflow run ID or by AblationKit ref (attempt ID / manual ref). */
function resolve(svc: Services, id: string): { mapping?: TrackingRunMapping; runId?: string } {
  const byRef = svc.tracking.mappings.get(id);
  if (byRef) return compact({ mapping: byRef, runId: byRef.mlflow_run_id });
  const byRun = svc.tracking.mappings.getByRunId(id);
  return compact({ mapping: byRun, runId: id });
}

function projectExperimentIds(svc: Services, projectId: string): string[] {
  svc.registry.require(projectId);
  const l = svc.tracking.mappings.getLinks(projectId);
  return [...(l.experiment_id ? [l.experiment_id] : []), ...l.imports.map((i) => i.experiment_id)];
}

function pendingRuns(svc: Services, projectId: string): Record<string, unknown>[] {
  return svc.tracking.mappings
    .forProject(projectId)
    .filter((m) => m.sync_state !== "synced" || !m.mlflow_run_id)
    .map((m) => mappingView(svc, m));
}

async function assertWritableRun(svc: Services, runId: string): Promise<MlflowRun> {
  const run = await mlflow(svc, () => svc.tracking.client.getRun(runId));
  if (svc.tracking.mappings.importOwner(run.info.experiment_id))
    throw new HttpError(409, "read_only_import", "runs in an imported experiment are read-only");
  return run;
}

function splitMetrics(ms: readonly MlflowMetric[]): {
  model: MlflowMetric[];
  system: MlflowMetric[];
} {
  return {
    model: ms.filter((m) => !m.key.startsWith(SYSTEM_METRIC_PREFIX)),
    system: ms.filter((m) => m.key.startsWith(SYSTEM_METRIC_PREFIX)),
  };
}

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? "" : String(v);
  // Quote separators, and text that a spreadsheet would run as a formula.
  const formula = typeof v === "string" && /^[=+\-@]/.test(s);
  return /[",\n\r]/.test(s) || formula ? `"${s.replaceAll('"', '""')}"` : s;
}

function csv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}

const RUN_ID_TAGS = [TAGS.job, TAGS.attempt, TAGS.study, TAGS.variant, TAGS.task] as const;

function runsTable(runs: readonly MlflowRun[]): { header: string[]; rows: unknown[][] } {
  const params = new Set<string>();
  const metrics = new Set<string>();
  for (const r of runs) {
    for (const p of r.data.params ?? []) params.add(p.key);
    for (const m of r.data.metrics ?? []) metrics.add(m.key);
  }
  const pk = [...params].sort();
  const mk = [...metrics].sort();
  const header = [
    "run_id",
    "run_name",
    "experiment_id",
    "status",
    "start_time",
    "end_time",
    ...RUN_ID_TAGS.map((t) => t.replace("ablationkit.", "")),
    ...pk.map((k) => `params.${k}`),
    ...mk.map((k) => `metrics.${k}`),
  ];
  const rows = runs.map((r) => {
    const tags = new Map((r.data.tags ?? []).map((t) => [t.key, t.value]));
    const ps = new Map((r.data.params ?? []).map((p) => [p.key, p.value]));
    const ms = new Map((r.data.metrics ?? []).map((m) => [m.key, m.value]));
    return [
      r.info.run_id,
      r.info.run_name,
      r.info.experiment_id,
      r.info.status,
      r.info.start_time ? new Date(r.info.start_time).toISOString() : "",
      r.info.end_time ? new Date(r.info.end_time).toISOString() : "",
      ...RUN_ID_TAGS.map((t) => tags.get(t)),
      ...pk.map((k) => ps.get(k)),
      ...mk.map((k) => ms.get(k)),
    ];
  });
  return { header, rows };
}

const SAFE_INLINE_TYPES = new Set([
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/gif",
  "application/json",
]);

/** What the shared read helpers use of a human or agent call. */
interface ReadCall {
  readonly svc: Services;
  readonly url: URL;
}

/** Metrics projection for a run named by run ID or ref; pending runs never invent metrics. */
async function metricsFor(c: ReadCall, id: string): Promise<Response> {
  const { mapping, runId } = resolve(c.svc, id);
  const sync = mapping ? c.svc.tracking.sync(mapping.ref) : undefined;
  if (!runId) {
    if (!mapping) throw new HttpError(404, "not_found", `no tracked run ${id}`);
    return json(200, {
      ref: mapping.ref,
      sync,
      state: "tracking_pending",
      metrics: [],
      system_metrics: [],
    });
  }
  const key = c.url.searchParams.get("key");
  if (key) {
    const max = intParam(c.url, "max_results", 25_000, 1, 25_000);
    const page = await mlflow(c.svc, () =>
      c.svc.tracking.client.getMetricHistory(
        compact({
          run_id: runId,
          metric_key: key,
          max_results: max,
          page_token: c.url.searchParams.get("page_token") ?? undefined,
        }),
      ),
    );
    if (c.url.searchParams.get("format") === "csv")
      return new Response(
        csv(
          ["step", "timestamp", "value"],
          page.items.map((m) => [m.step, m.timestamp, m.value]),
        ),
        {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${runId}-${key.replaceAll(/[^A-Za-z0-9._-]/g, "_")}.csv"`,
          },
        },
      );
    return json(
      200,
      compact({
        run_id: runId,
        key,
        history: page.items,
        next_page_token: page.next_page_token,
        sync,
      }),
    );
  }
  const run = await mlflow(c.svc, () => c.svc.tracking.client.getRun(runId));
  const { model, system } = splitMetrics(run.data.metrics ?? []);
  return json(200, compact({ run_id: runId, metrics: model, system_metrics: system, sync }));
}

/** Points fetched per metric before downsampling; beyond this the series is marked truncated. */
export const SERIES_FETCH_MAX = 250_000;

/**
 * Downsampled metric series for charts (spec §5.6). Reads the full history from MLflow (bounded),
 * then applies LTTB; canonical data stays in MLflow and is exported unmodified through `?key=`.
 */
async function seriesFor(c: ReadCall, id: string): Promise<Response> {
  const { mapping, runId } = resolve(c.svc, id);
  if (!runId) {
    if (!mapping) throw new HttpError(404, "not_found", `no tracked run ${id}`);
    return json(200, { ref: mapping.ref, state: "tracking_pending", series: [] });
  }
  const keys = listParam(c.url, "keys");
  if (keys.length === 0 || keys.length > 20)
    throw new HttpError(400, "invalid_request", "keys must list 1 to 20 metric keys");
  const points = intParam(c.url, "points", 500, 10, 5000);
  const x = c.url.searchParams.get("x") ?? "step";
  if (x !== "step" && x !== "time")
    throw new HttpError(400, "invalid_request", "x must be step or time");
  const series = await mlflow(c.svc, () =>
    Promise.all(
      keys.map(async (key) => {
        const all: MlflowMetric[] = [];
        let token: string | undefined;
        do {
          const page = await c.svc.tracking.client.getMetricHistory(
            compact({ run_id: runId, metric_key: key, max_results: 25_000, page_token: token }),
          );
          all.push(...page.items);
          token = page.next_page_token;
        } while (token && all.length < SERIES_FETCH_MAX);
        const sorted = sortHistory(all);
        const out = lttb(sorted, points, x === "time" ? (p) => p.timestamp : (p) => p.step);
        const row = (m: { step: number; timestamp: number; value: number }) => [
          m.step,
          m.timestamp,
          Number.isFinite(m.value) ? m.value : String(m.value),
        ];
        return compact({
          key,
          total: all.length,
          downsampled: out.points.length < sorted.length - out.nonFinite.length,
          truncated: token ? true : undefined,
          points: out.points.map(row),
          non_finite: out.nonFinite.length ? out.nonFinite.map(row) : undefined,
        });
      }),
    ),
  );
  return json(200, { run_id: runId, x, series });
}

// ----------------------------------------------------------------- routes

export const TRACKING_ROUTES: readonly Route<HumanHandler>[] = [
  {
    method: "GET",
    path: "/api/v1/tracking/status",
    handler: session("tracking.status", (c) =>
      json(200, {
        sidecar: c.svc.sidecarStatus(),
        outbox: c.svc.tracking.outbox.stats(),
        ...compact({
          last_contact_at: c.svc.tracking.lastContactAt,
          last_transport_error: c.svc.tracking.lastTransportError,
        }),
      }),
    ),
  },
  {
    method: "GET",
    path: "/api/v1/tracking/doctor",
    handler: session("tracking.doctor", async (c) => json(200, await c.svc.trackingDoctor())),
  },
  {
    method: "GET",
    path: "/api/v1/tracking/outbox",
    handler: session("tracking.outbox.read", (c) => {
      const state = (c.url.searchParams.get("state") ?? undefined) as
        | "pending"
        | "failed"
        | undefined;
      if (state !== undefined && !["pending", "failed"].includes(state))
        throw new HttpError(400, "invalid_request", "state must be pending or failed");
      const projectId = c.url.searchParams.get("project") ?? undefined;
      const entries = c.svc.tracking.outbox.entries(compact({ state, projectId }));
      const limit = intParam(c.url, "limit", 200, 1, 5000);
      return json(200, {
        stats: c.svc.tracking.outbox.stats(),
        entries: entries.slice(0, limit).map((e) =>
          compact({
            op_id: e.op_id,
            kind: e.op.kind,
            project_id: e.op.project_id,
            ref: e.op.ref,
            state: e.state,
            attempts: e.attempts,
            last_error: e.last_error,
            enqueued_at: e.op.enqueued_at,
            bytes: e.op.bytes,
            next_attempt_at: e.next_attempt_at
              ? new Date(e.next_attempt_at).toISOString()
              : undefined,
          }),
        ),
      });
    }),
  },
  {
    method: "POST",
    path: "/api/v1/tracking/outbox/:id/retry",
    handler: session("tracking.outbox.retry", (c) => {
      const id = c.params["id"] as string;
      const e = c.svc.tracking.retry(id);
      if (!e) throw new HttpError(404, "not_found", `no failed op ${id}`);
      audit(c, "tracking.outbox.retry", compact({ project_id: e.op.project_id, target: id }));
      return json(200, { op_id: id, state: e.state });
    }),
  },
  // ------------------------------------------------------------ experiments
  {
    method: "GET",
    path: "/api/v1/tracking/experiments",
    handler: session("tracking.experiments.list", async (c) => {
      const project = c.url.searchParams.get("project");
      if (project) {
        const ids = projectExperimentIds(c.svc, project);
        const exps = await mlflow(c.svc, () =>
          Promise.all(ids.map((id) => c.svc.tracking.client.getExperiment(id))),
        );
        return json(200, {
          experiments: exps.map((e) => expView(c.svc, e)),
          links: c.svc.tracking.mappings.getLinks(project),
        });
      }
      const page = await mlflow(c.svc, () =>
        c.svc.tracking.client.searchExperiments(
          compact({
            view_type: viewParam(c.url),
            max_results: intParam(c.url, "max_results", 100, 1, 1000),
            filter: c.url.searchParams.get("filter") ?? undefined,
            order_by: listParam(c.url, "order_by").length
              ? listParam(c.url, "order_by")
              : undefined,
            page_token: c.url.searchParams.get("page_token") ?? undefined,
          }),
        ),
      );
      return json(
        200,
        compact({
          experiments: page.items.map((e) => expView(c.svc, e)),
          next_page_token: page.next_page_token,
        }),
      );
    }),
  },
  {
    method: "POST",
    path: "/api/v1/tracking/experiments",
    handler: session("tracking.experiments.create", async (c) => {
      const body = await readJsonBody(c.req);
      const name = str(body, "name");
      if (body["confirm"] !== true)
        throw new HttpError(
          400,
          "confirmation_required",
          "creating an MLflow experiment needs `confirm: true`",
        );
      if (name.startsWith(RESERVED_EXPERIMENT_PREFIX))
        throw new HttpError(
          409,
          "reserved_name",
          `experiment names under ${RESERVED_EXPERIMENT_PREFIX} are reserved for project experiments`,
        );
      const tags = tagsObject(body, "tags");
      for (const t of tags)
        if (isReservedTag(t.key))
          throw new HttpError(400, "invalid_request", `tag ${t.key} is reserved`);
      const id = await mlflow(c.svc, () => c.svc.tracking.client.createExperiment(name, tags));
      audit(c, "tracking.experiments.create", { target: id, details: { name } });
      const e = await mlflow(c.svc, () => c.svc.tracking.client.getExperiment(id));
      return json(201, { experiment: expView(c.svc, e) });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/tracking/experiments/:id",
    handler: session("tracking.experiments.read", async (c) => {
      const e = await mlflow(c.svc, () => c.svc.tracking.client.getExperiment(idParam(c)));
      return json(200, { experiment: expView(c.svc, e) });
    }),
  },
  {
    method: "PATCH",
    path: "/api/v1/tracking/experiments/:id",
    handler: session("tracking.experiments.update", async (c) => {
      const id = idParam(c);
      const body = await readJsonBody(c.req);
      const svc = c.svc;
      if (svc.tracking.mappings.importOwner(id))
        throw new HttpError(409, "read_only_import", "imported experiments are read-only");
      const owner = svc.tracking.mappings.projectForExperiment(id);
      const name = str(body, "name", { optional: true });
      const lifecycle = str(body, "lifecycle", { optional: true });
      if (lifecycle !== undefined && lifecycle !== "active" && lifecycle !== "deleted")
        throw new HttpError(400, "invalid_request", "lifecycle must be active or deleted");
      if (owner && (name !== undefined || lifecycle === "deleted"))
        throw new HttpError(
          409,
          "project_experiment",
          `experiment ${id} is project ${owner}'s ak/ experiment; it cannot be renamed or archived`,
        );
      if (name?.startsWith(RESERVED_EXPERIMENT_PREFIX))
        throw new HttpError(
          409,
          "reserved_name",
          `experiment names under ${RESERVED_EXPERIMENT_PREFIX} are reserved`,
        );
      const tags = tagsObject(body, "tags");
      for (const t of tags)
        if (isReservedTag(t.key))
          throw new HttpError(400, "invalid_request", `tag ${t.key} is reserved`);
      await mlflow(svc, async () => {
        if (name !== undefined) await svc.tracking.client.renameExperiment(id, name);
        for (const t of tags) await svc.tracking.client.setExperimentTag(id, t.key, t.value);
        if (lifecycle === "deleted") await svc.tracking.client.deleteExperiment(id);
        if (lifecycle === "active") await svc.tracking.client.restoreExperiment(id);
      });
      audit(c, "tracking.experiments.update", {
        target: id,
        details: compact({
          name,
          lifecycle,
          tags: tags.length ? tags.map((t) => t.key) : undefined,
        }),
      });
      const e = await mlflow(svc, () => svc.tracking.client.getExperiment(id));
      return json(200, { experiment: expView(svc, e) });
    }),
  },
  // ------------------------------------------------------------------- runs
  {
    method: "GET",
    path: "/api/v1/tracking/runs",
    handler: session("tracking.runs.list", async (c) => {
      const project = c.url.searchParams.get("project") ?? undefined;
      let ids = listParam(c.url, "experiment_ids");
      if (project && ids.length === 0) ids = projectExperimentIds(c.svc, project);
      if (!project && ids.length === 0)
        throw new HttpError(400, "invalid_request", "give project or experiment_ids");
      const pending = project ? pendingRuns(c.svc, project) : [];
      // The project experiment itself is still queued: nothing to search yet.
      if (ids.length === 0)
        return json(200, {
          runs: [],
          pending_runs: pending,
          mlflow_available: await c.svc.tracking.client.health(),
        });
      try {
        const page = await c.svc.tracking.client.searchRuns(
          compact({
            experiment_ids: ids,
            filter: c.url.searchParams.get("filter") ?? undefined,
            run_view_type: viewParam(c.url),
            max_results: intParam(c.url, "max_results", 100, 1, 1000),
            order_by: listParam(c.url, "order_by").length
              ? listParam(c.url, "order_by")
              : undefined,
            page_token: c.url.searchParams.get("page_token") ?? undefined,
          }),
        );
        return json(
          200,
          compact({
            runs: page.items.map((r) => runView(c.svc, r)),
            next_page_token: page.next_page_token,
            pending_runs: pending,
            mlflow_available: true,
          }),
        );
      } catch (e) {
        // MLflow down: a project view still shows what is queued, labelled as pending.
        if (project && e instanceof MlflowError && e.kind !== "rejected")
          return json(200, {
            runs: [],
            pending_runs: pending,
            mlflow_available: false,
            error: e.message,
          });
        throw toHttp(c.svc, e);
      }
    }),
  },
  {
    method: "POST",
    path: "/api/v1/tracking/runs",
    handler: session("tracking.runs.create", async (c) => {
      const body = await readJsonBody(c.req);
      const projectId = str(body, "project_id");
      c.svc.registry.require(projectId);
      const tags = tagsObject(body, "tags");
      const params = tagsObject(body, "params");
      const metrics = arrayField<MlflowMetric>(body, "metrics");
      try {
        const started = c.svc.tracking.startRun(
          compact({
            project_id: projectId,
            kind: "manual" as const,
            run_name: str(body, "run_name", { optional: true }),
            study_id: str(body, "study_id", { optional: true }),
            variant_id: str(body, "variant_id", { optional: true }),
            task_id: str(body, "task_id", { optional: true }),
            tags: Object.fromEntries(tags.map((t) => [t.key, t.value])),
          }),
        );
        const opIds = [...started.op_ids];
        if (params.length || metrics?.length)
          opIds.push(...c.svc.tracking.logBatch(started.ref, compact({ params, metrics })).op_ids);
        audit(c, "tracking.runs.create", { project_id: projectId, target: started.ref });
        const done = await c.svc.tracking.waitFor(opIds, WRITE_WAIT_MS);
        const m = c.svc.tracking.mappings.get(started.ref) as TrackingRunMapping;
        const sync = c.svc.tracking.sync(started.ref);
        if (done && sync.state === "synced")
          return json(201, { ref: started.ref, mlflow_run_id: m.mlflow_run_id, mapping: m, sync });
        return json(202, { ref: started.ref, state: sync.state, op_ids: opIds, mapping: m, sync });
      } catch (e) {
        throw toHttp(c.svc, e);
      }
    }),
  },
  {
    method: "GET",
    path: "/api/v1/tracking/runs/:id",
    handler: session("tracking.runs.read", async (c) => {
      const id = idParam(c);
      const { mapping, runId } = resolve(c.svc, id);
      if (!runId) {
        if (!mapping) throw new HttpError(404, "not_found", `no tracked run ${id}`);
        return json(200, {
          ref: mapping.ref,
          state: "tracking_pending",
          ...mappingView(c.svc, mapping),
        });
      }
      try {
        const run = await c.svc.tracking.client.getRun(runId);
        return json(200, { run: runView(c.svc, run) });
      } catch (e) {
        if (mapping && e instanceof MlflowError && e.kind !== "rejected")
          return json(200, {
            ref: mapping.ref,
            mlflow_available: false,
            error: e.message,
            ...mappingView(c.svc, mapping),
          });
        throw toHttp(c.svc, e);
      }
    }),
  },
  {
    method: "PATCH",
    path: "/api/v1/tracking/runs/:id",
    handler: session("tracking.runs.update", async (c) => {
      const id = idParam(c);
      const { mapping, runId } = resolve(c.svc, id);
      if (!runId)
        throw new HttpError(409, "tracking_pending", "MLflow has not acknowledged this run yet");
      const body = await readJsonBody(c.req);
      const name = str(body, "name", { optional: true });
      const status = str(body, "status", { optional: true }) as RunStatus | undefined;
      const lifecycle = str(body, "lifecycle", { optional: true });
      const setTags = tagsObject(body, "tags");
      const deleteTags = arrayField<string>(body, "delete_tags") ?? [];
      if (status && !["FINISHED", "FAILED", "KILLED"].includes(status))
        throw new HttpError(400, "invalid_request", "status must be FINISHED, FAILED or KILLED");
      if (status && mapping?.kind === "attempt")
        throw new HttpError(
          409,
          "attempt_run_status",
          "an attempt's run status follows its job; cancel the job instead",
        );
      if (lifecycle !== undefined && lifecycle !== "active" && lifecycle !== "deleted")
        throw new HttpError(400, "invalid_request", "lifecycle must be active or deleted");
      for (const k of [...setTags.map((t) => t.key), ...deleteTags])
        if (typeof k !== "string" || isReservedTag(k))
          throw new HttpError(400, "invalid_request", `tag ${String(k)} is reserved`);
      const svc = c.svc;
      await assertWritableRun(svc, runId);
      await mlflow(svc, async () => {
        if (name !== undefined || status !== undefined)
          await svc.tracking.client.updateRun(
            compact({
              run_id: runId,
              run_name: name,
              status,
              end_time: status ? svc.now().getTime() : undefined,
            }),
          );
        for (const t of setTags) await svc.tracking.client.setTag(runId, t.key, t.value);
        for (const k of deleteTags) await svc.tracking.client.deleteTag(runId, k);
        if (lifecycle === "deleted") await svc.tracking.client.deleteRun(runId);
        if (lifecycle === "active") await svc.tracking.client.restoreRun(runId);
      });
      audit(c, "tracking.runs.update", {
        ...(mapping ? { project_id: mapping.project_id } : {}),
        target: runId,
        details: compact({
          name,
          status,
          lifecycle,
          tags: setTags.map((t) => t.key),
          delete_tags: deleteTags,
        }),
      });
      const run = await mlflow(svc, () => svc.tracking.client.getRun(runId));
      return json(200, { run: runView(svc, run) });
    }),
  },
  {
    method: "POST",
    path: "/api/v1/tracking/runs/:id/log",
    handler: session("tracking.runs.log", async (c) => {
      const id = idParam(c);
      const { mapping } = resolve(c.svc, id);
      if (!mapping || mapping.kind !== "manual")
        throw new HttpError(
          409,
          "not_writable",
          "only runs created through AblationKit's tracking API accept logged data here; job attempts log through the worker API",
        );
      const body = await readJsonBody(c.req);
      try {
        const r = c.svc.tracking.logBatch(
          mapping.ref,
          compact({
            metrics: arrayField<MlflowMetric>(body, "metrics"),
            params: tagsObject(body, "params"),
            tags: tagsObject(body, "tags"),
          }),
        );
        audit(c, "tracking.runs.log", { project_id: mapping.project_id, target: mapping.ref });
        const done = await c.svc.tracking.waitFor(r.op_ids, WRITE_WAIT_MS);
        const sync = c.svc.tracking.sync(mapping.ref);
        return json(done && sync.state === "synced" ? 200 : 202, {
          ref: mapping.ref,
          op_ids: r.op_ids,
          state: sync.state,
          sync,
        });
      } catch (e) {
        throw toHttp(c.svc, e);
      }
    }),
  },
  {
    method: "POST",
    path: "/api/v1/tracking/runs/:id/end",
    handler: session("tracking.runs.end", async (c) => {
      const id = idParam(c);
      const { mapping } = resolve(c.svc, id);
      if (!mapping || mapping.kind !== "manual")
        throw new HttpError(
          409,
          "not_writable",
          "only manual runs can be ended here; an attempt's run ends with its job",
        );
      const body = await readJsonBody(c.req);
      const status = (str(body, "status", { optional: true }) ?? "FINISHED") as
        | "FINISHED"
        | "FAILED"
        | "KILLED";
      if (!["FINISHED", "FAILED", "KILLED"].includes(status))
        throw new HttpError(400, "invalid_request", "status must be FINISHED, FAILED or KILLED");
      const r = c.svc.tracking.endRun(mapping.ref, { status });
      audit(c, "tracking.runs.end", {
        project_id: mapping.project_id,
        target: mapping.ref,
        details: { status },
      });
      const done = await c.svc.tracking.waitFor(r.op_ids, WRITE_WAIT_MS);
      const sync = c.svc.tracking.sync(mapping.ref);
      return json(done && sync.state === "synced" ? 200 : 202, {
        ref: mapping.ref,
        state: sync.state,
        sync,
      });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/tracking/runs/:id/metrics",
    handler: session("tracking.runs.metrics", (c) => metricsFor(c, idParam(c))),
  },
  {
    method: "GET",
    path: "/api/v1/tracking/runs/:id/metrics/series",
    handler: session("tracking.runs.series", (c) => seriesFor(c, idParam(c))),
  },
  {
    method: "GET",
    path: "/api/v1/attempts/:id/metrics",
    handler: session("tracking.attempts.metrics", (c) => metricsFor(c, idParam(c))),
  },
  {
    method: "GET",
    path: "/api/v1/tracking/runs/:id/artifacts",
    handler: session("tracking.runs.artifacts", async (c) => {
      const { runId, mapping } = resolve(c.svc, idParam(c));
      if (!runId) {
        if (!mapping) throw new HttpError(404, "not_found", "no such run");
        return json(200, { ref: mapping.ref, state: "tracking_pending", files: [] });
      }
      const path = safeArtifactPath(c.url.searchParams.get("path"), false);
      const page = await mlflow(c.svc, () =>
        c.svc.tracking.client.listArtifacts(
          runId,
          path,
          c.url.searchParams.get("page_token") ?? undefined,
        ),
      );
      return json(
        200,
        compact({
          run_id: runId,
          path: path ?? "",
          files: page.items,
          next_page_token: page.next_page_token,
        }),
      );
    }),
  },
  {
    method: "GET",
    path: "/api/v1/tracking/runs/:id/artifacts/download",
    handler: session("tracking.runs.artifacts.download", async (c) => {
      const { runId } = resolve(c.svc, idParam(c));
      if (!runId)
        throw new HttpError(409, "tracking_pending", "MLflow has not acknowledged this run yet");
      const path = safeArtifactPath(c.url.searchParams.get("path"), true) as string;
      const upstream = await mlflow(c.svc, () =>
        c.svc.tracking.client.downloadArtifact(runId, path),
      );
      const type =
        (upstream.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const filename = (path.split("/").at(-1) ?? "artifact").replaceAll(/[^A-Za-z0-9._-]/g, "_");
      // Artifacts are untrusted: never render them as active content on the coordinator origin.
      return new Response(upstream.body, {
        headers: compact({
          "content-type": SAFE_INLINE_TYPES.has(type) ? type : "application/octet-stream",
          "content-length": upstream.headers.get("content-length") ?? undefined,
          "content-disposition": `attachment; filename="${filename}"`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
          "cache-control": "no-store",
        }),
      });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/tracking/compare",
    handler: session("tracking.compare", async (c) => {
      const ids = listParam(c.url, "runs");
      if (ids.length < 2 || ids.length > 20)
        throw new HttpError(400, "invalid_request", "runs must list 2 to 20 run IDs or refs");
      const resolved = ids.map((id) => ({ id, ...resolve(c.svc, id) }));
      const pending = resolved.filter((r) => !r.runId);
      if (pending.length)
        throw new HttpError(
          409,
          "tracking_pending",
          "some runs are not acknowledged by MLflow yet",
          {
            pending: pending.map((p) => p.id),
          },
        );
      const runs = await mlflow(c.svc, () =>
        Promise.all(resolved.map((r) => c.svc.tracking.client.getRun(r.runId as string))),
      );
      const keys = (pick: (r: MlflowRun) => { key: string; value: unknown }[]) =>
        [...new Set(runs.flatMap((r) => pick(r).map((x) => x.key)))].sort().map((key) => {
          const values = runs.map((r) => pick(r).find((x) => x.key === key)?.value);
          return {
            key,
            values,
            differs: new Set(values.map((v) => JSON.stringify(v ?? null))).size > 1,
          };
        });
      return json(200, {
        runs: runs.map((r) => ({
          run_id: r.info.run_id,
          run_name: r.info.run_name,
          experiment_id: r.info.experiment_id,
          status: r.info.status,
          ablationkit: Object.fromEntries(
            RUN_ID_TAGS.map((t) => [
              t.replace("ablationkit.", ""),
              r.data.tags?.find((x) => x.key === t)?.value,
            ]).filter(([, v]) => v !== undefined),
          ),
        })),
        params: keys((r) => r.data.params ?? []),
        metrics: keys((r) => r.data.metrics ?? []),
      });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/tracking/export",
    handler: session("tracking.export", async (c) => {
      const format = c.url.searchParams.get("format") ?? "csv";
      if (format !== "csv" && format !== "json")
        throw new HttpError(400, "invalid_request", "format must be csv or json");
      const project = c.url.searchParams.get("project");
      const runIds = listParam(c.url, "runs");
      let runs: MlflowRun[];
      if (runIds.length) {
        if (runIds.length > 1000) throw new HttpError(400, "invalid_request", "at most 1000 runs");
        runs = await mlflow(c.svc, () =>
          Promise.all(
            runIds.map((id) => c.svc.tracking.client.getRun(resolve(c.svc, id).runId ?? id)),
          ),
        );
      } else {
        let ids = listParam(c.url, "experiment_ids");
        if (project && ids.length === 0) ids = projectExperimentIds(c.svc, project);
        if (ids.length === 0)
          throw new HttpError(400, "invalid_request", "give runs, project or experiment_ids");
        runs = [];
        let token: string | undefined;
        do {
          const page = await mlflow(c.svc, () =>
            c.svc.tracking.client.searchRuns(
              compact({
                experiment_ids: ids,
                filter: c.url.searchParams.get("filter") ?? undefined,
                run_view_type: viewParam(c.url),
                max_results: 1000,
                page_token: token,
              }),
            ),
          );
          runs.push(...page.items);
          token = page.next_page_token;
        } while (token && runs.length < 10_000);
      }
      audit(
        c,
        "tracking.export",
        compact({ project_id: project ?? undefined, details: { runs: runs.length, format } }),
      );
      if (format === "json") return json(200, { runs: runs.map((r) => runView(c.svc, r)) });
      const t = runsTable(runs);
      return new Response(csv(t.header, t.rows), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${project ?? "runs"}-export.csv"`,
          "cache-control": "no-store",
        },
      });
    }),
  },
  // ----------------------------------------------------------------- models
  {
    method: "GET",
    path: "/api/v1/tracking/models",
    handler: session("tracking.models.list", async (c) => {
      const project = c.url.searchParams.get("project");
      let ids = listParam(c.url, "experiment_ids");
      if (project && ids.length === 0) ids = projectExperimentIds(c.svc, project);
      if (ids.length === 0)
        throw new HttpError(400, "invalid_request", "give project or experiment_ids");
      const page = await mlflow(c.svc, () =>
        c.svc.tracking.client.searchLoggedModels(
          compact({
            experiment_ids: ids,
            max_results: intParam(c.url, "max_results", 100, 1, 1000),
            page_token: c.url.searchParams.get("page_token") ?? undefined,
          }),
        ),
      );
      return json(200, compact({ models: page.items, next_page_token: page.next_page_token }));
    }),
  },
  {
    method: "GET",
    path: "/api/v1/tracking/registered-models",
    handler: session("tracking.registered_models.list", async (c) => {
      const page = await mlflow(c.svc, () =>
        c.svc.tracking.client.searchRegisteredModels(
          compact({
            filter: c.url.searchParams.get("filter") ?? undefined,
            max_results: intParam(c.url, "max_results", 100, 1, 1000),
            page_token: c.url.searchParams.get("page_token") ?? undefined,
          }),
        ),
      );
      return json(
        200,
        compact({ registered_models: page.items, next_page_token: page.next_page_token }),
      );
    }),
  },
  // -------------------------------------------------------- project links
  {
    method: "GET",
    path: "/api/v1/projects/:id/tracking",
    handler: session("tracking.project.read", (c) => {
      const id = c.params["id"] as string;
      c.svc.registry.require(id);
      const live = c.svc.tracking.outbox.entries({ projectId: id });
      return json(200, {
        links: c.svc.tracking.mappings.getLinks(id),
        runs: c.svc.tracking.mappings.forProject(id).length,
        pending_ops: live.filter((e) => e.state === "pending").length,
        failed_ops: live.filter((e) => e.state === "failed").length,
        sidecar: c.svc.sidecarStatus().state,
      });
    }),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/tracking/imports",
    handler: session("tracking.project.import", async (c) => {
      const projectId = c.params["id"] as string;
      c.svc.registry.require(projectId);
      const body = await readJsonBody(c.req);
      const expId = str(body, "experiment_id");
      const m = c.svc.tracking.mappings;
      const e = await mlflow(c.svc, () => c.svc.tracking.client.getExperiment(expId));
      const owner = m.projectForExperiment(expId);
      if (owner || e.name.startsWith(RESERVED_EXPERIMENT_PREFIX))
        throw new HttpError(
          409,
          "project_experiment",
          `${e.name} is a project experiment, not a historical one`,
        );
      const importer = m.importOwner(expId);
      if (importer && importer !== projectId)
        throw new HttpError(
          409,
          "already_imported",
          `experiment ${expId} is already linked to project ${importer}`,
        );
      const links = m.getLinks(projectId);
      if (!importer) {
        m.putLinks({
          ...links,
          imports: [
            ...links.imports,
            { experiment_id: expId, name: e.name, linked_at: c.svc.now().toISOString() },
          ],
        });
        audit(c, "tracking.project.import", {
          project_id: projectId,
          target: expId,
          details: { name: e.name },
        });
        c.svc.events.publish(projectId, "tracking.experiment.imported", {
          experiment_id: expId,
          name: e.name,
        });
      }
      return json(importer ? 200 : 201, {
        links: m.getLinks(projectId),
        experiment: expView(c.svc, e),
      });
    }),
  },
  // ---------------------------------------------------------------- backups
  {
    method: "POST",
    path: "/api/v1/backups",
    handler: session("backup.create", async (c) => {
      const r = await c.svc.backups.create("manual");
      audit(c, "backup.create", {
        target: r.manifest.backup_id,
        details: { files: r.manifest.files.length, mlflow_database: r.manifest.mlflow_database },
      });
      const bytes = r.manifest.files.reduce((n, f) => n + f.bytes, 0);
      return json(201, {
        backup_id: r.manifest.backup_id,
        path: r.path,
        created_at: r.manifest.created_at,
        mlflow_database: r.manifest.mlflow_database,
        mlflow_version: r.manifest.mlflow_version,
        files: r.manifest.files.length,
        bytes,
        outbox: r.manifest.outbox,
        excluded: r.manifest.excluded,
      });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/backups",
    handler: session("backup.list", (c) =>
      json(200, {
        backups: c.svc.backups.list().map((b) => ({
          backup_id: b.manifest.backup_id,
          path: b.path,
          created_at: b.manifest.created_at,
          reason: b.manifest.reason,
          mlflow_version: b.manifest.mlflow_version,
          mlflow_database: b.manifest.mlflow_database,
          files: b.manifest.files.length,
          bytes: b.manifest.files.reduce((n, f) => n + f.bytes, 0),
          ...(b.manifest.quiesce ? { quiesce: b.manifest.quiesce } : {}),
          ...(b.manifest.source ? { source: b.manifest.source } : {}),
        })),
        pending_restore: readPendingRestore(c.svc.paths.home) ?? null,
      }),
    ),
  },
  {
    method: "POST",
    path: "/api/v1/backups/:id/verify",
    handler: session("backup.verify", async (c) => {
      const id = c.params["id"] as string;
      const dir = backupDir(c.svc, id);
      const v = await verifyBackup(dir);
      audit(c, "backup.verify", {
        target: id,
        outcome: v.ok ? "allowed" : "error",
        details: { problems: v.problems.length },
      });
      return json(200, { backup_id: id, ok: v.ok, problems: v.problems.slice(0, 100) });
    }),
  },
  {
    // Restore replaces every byte of coordinator state, so it waits for the next start (like a
    // Level 2 build): this request only schedules it, after checking the backup (ADR 0025).
    method: "POST",
    path: "/api/v1/backups/:id/restore",
    handler: {
      auth: "session",
      action: "backup.restore",
      run: async (c) => {
        const id = c.params["id"] as string;
        const v = await verifyBackup(backupDir(c.svc, id));
        if (!v.ok)
          throw new HttpError(
            409,
            "backup_damaged",
            `backup ${id} does not match its manifest: ${v.problems.slice(0, 5).join("; ")}`,
          );
        const pending: PendingRestore = {
          schema_version: 1,
          backup_id: id,
          requested_at: c.svc.now().toISOString(),
          requested_by: c.session.token_id,
        };
        writeJsonAtomic(pendingRestorePath(c.svc.paths.home), pending, {
          validate: validatePendingRestore,
          backup: false,
        });
        audit(c, "backup.restore.schedule", { target: id });
        return json(200, {
          pending_restore: pending,
          restart_required: true,
          note: "applied at the next coordinator start (ablationkit coordinator stop && ablationkit coordinator start); the current state is moved aside, not deleted",
        });
      },
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/backups/restore",
    handler: session("backup.restore.cancel", (c) => {
      const p = readPendingRestore(c.svc.paths.home);
      rmSync(pendingRestorePath(c.svc.paths.home), { force: true });
      if (p) audit(c, "backup.restore.cancel", { target: p.backup_id });
      return json(200, { cancelled: p?.backup_id ?? null });
    }),
  },
  {
    // The archive `backup restore` reads on another machine (`coordinator move` is the safe way to
    // hand over a live home; this is a copy of a backup, and the home stays writable here).
    method: "GET",
    path: "/api/v1/backups/:id/archive",
    handler: session("backup.export", async (c) => {
      const id = c.params["id"] as string;
      const dir = backupDir(c.svc, id);
      const exports = join(c.svc.paths.backupsDir, ".exports");
      const out = join(exports, `${id}.tar.gz`);
      if (!existsSync(out)) {
        // One cached archive at a time: each is as large as the backup.
        if (existsSync(exports))
          for (const f of readdirSync(exports)) rmSync(join(exports, f), { force: true });
        await exportBackup(dir, out);
      }
      audit(c, "backup.export", { target: id });
      return new Response(Bun.file(out), {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="ablationkit-backup-${id}.tar.gz"`,
          "cache-control": "no-store",
        },
      });
    }),
  },
];

function backupDir(svc: Services, id: string): string {
  let dir: string;
  try {
    dir = svc.backups.path(id);
  } catch {
    throw new HttpError(400, "invalid_request", `not a backup ID: ${id}`);
  }
  if (!existsSync(join(dir, "manifest.json")))
    throw new HttpError(404, "backup_not_found", `no backup ${id}`);
  return dir;
}

// ------------------------------------------------------------ agent reads

/** The most a text artifact read returns at once (ADR 0040). */
export const AGENT_TEXT_ARTIFACT_MAX_BYTES = 256 * 1024;

/**
 * A run of the project, named by MLflow run ID or AblationKit ref. A run outside the project's
 * experiments (its own and its imports) is not found, so an agent token reads only its project.
 */
async function projectRun(
  c: ResearchCall,
): Promise<{ mapping?: TrackingRunMapping; runId?: string; run?: MlflowRun }> {
  const pid = c.params["id"] as string;
  const id = c.params["run"] as string;
  if (!ID_RE.test(id)) throw new HttpError(400, "invalid_request", "bad run");
  const { mapping, runId } = resolve(c.svc, id);
  const notFound = new HttpError(404, "not_found", `no run ${id} in project ${pid}`);
  if (mapping) {
    if (mapping.project_id !== pid) throw notFound;
    return compact({ mapping, runId });
  }
  if (!runId) throw notFound;
  const run = await mlflow(c.svc, () => c.svc.tracking.client.getRun(runId));
  if (!projectExperimentIds(c.svc, pid).includes(run.info.experiment_id)) throw notFound;
  return { runId, run };
}

/**
 * The MLflow run ID of one of a project's runs, named by a job (its latest attempt), an attempt,
 * a run name (the newest job with it) or an MLflow run ID: a job's `inputs` (ADR 0068).
 */
export async function projectRunId(svc: Services, pid: string, id: string): Promise<string> {
  if (!ID_RE.test(id) && id.length > 250)
    throw new HttpError(
      400,
      "invalid_request",
      "a run is named by a job, an attempt, a run name or an MLflow run ID",
    );
  const notFound = new HttpError(404, "run_not_found", `no run ${id} in project ${pid}`);
  const jobs = svc.jobs.list(pid);
  const job =
    jobs.find((j) => j.job_id === id) ??
    jobs.find((j) => j.run_name === id && j.attempts.length > 0);
  const ref = job ? job.attempts[job.attempts.length - 1] : id;
  if (!ref || !ID_RE.test(ref)) throw notFound;
  const { mapping, runId } = resolve(svc, ref);
  if (mapping) {
    if (mapping.project_id !== pid) throw notFound;
    if (!runId)
      throw new HttpError(409, "tracking_pending", `MLflow has not acknowledged run ${id} yet`);
    return runId;
  }
  if (!runId) throw notFound;
  const run = await mlflow(svc, () => svc.tracking.client.getRun(runId)).catch(() => {
    throw notFound;
  });
  if (!projectExperimentIds(svc, pid).includes(run.info.experiment_id)) throw notFound;
  return runId;
}

const agentRead = (
  path: string,
  action: string,
  run: (c: ResearchCall) => Promise<Response>,
): ResearchOp => ({ method: "GET", path, action, agent: true, run });

/**
 * A run's description (ADR 0048), on both listeners: `summary` (what the run tests and why, then
 * what came out) and `notes` (the in-depth read, Markdown). They are the run's
 * `ablationkit.summary` and `mlflow.note.content` tags; an empty string clears one. `set_aside`
 * (ADR 0056) is why the run is not reported, kept by the coordinator in the vault's
 * `set-aside.json` (not in MLflow, so the file drawer is checked without it); an empty string
 * takes the mark back.
 */
export const RUN_DESCRIPTION_OPS: readonly ResearchOp[] = [
  {
    method: "PUT",
    path: "/api/v1/projects/:id/runs/:run/description",
    action: "tracking.runs.describe",
    agent: true,
    run: async (c) => {
      const { runId } = await projectRun(c);
      if (!runId)
        throw new HttpError(409, "tracking_pending", "MLflow has not acknowledged this run yet");
      const body = await readJsonBody(c.req);
      const field = (k: string, max: number) => {
        const v = body[k];
        if (v === undefined) return undefined;
        if (typeof v !== "string" || v.length > max)
          throw new HttpError(
            400,
            "invalid_request",
            `\`${k}\` must be a string of at most ${max} characters`,
          );
        return v.trim();
      };
      const summary = field("summary", MAX_RUN_SUMMARY);
      const notes = field("notes", MAX_RUN_NOTES);
      const setAside = field("set_aside", 1000);
      if (summary === undefined && notes === undefined && setAside === undefined)
        throw new HttpError(
          400,
          "invalid_request",
          "give `summary`, `notes`, `set_aside` or some of them",
        );
      const svc = c.svc;
      const pid = c.params["id"] as string;
      let mark: unknown;
      if (setAside !== undefined) {
        const { mapping } = await projectRun(c);
        mark =
          svc.vault.setAside(
            pid,
            { id: runId, name: mapping?.run_name },
            setAside,
            c.actor,
            c.listener,
          ) ?? null;
        if (summary === undefined && notes === undefined)
          return json(200, { mlflow_run_id: runId, set_aside: mark });
      }
      await assertWritableRun(svc, runId);
      await mlflow(svc, async () => {
        for (const [key, value] of [
          [TAGS.summary, summary],
          [NOTES_TAG, notes],
        ] as const) {
          if (value === undefined) continue;
          if (value) await svc.tracking.client.setTag(runId, key, value);
          else await svc.tracking.client.deleteTag(runId, key).catch(() => {});
        }
      });
      svc.audit.record({
        actor: compact({ kind: c.actor.kind, id: c.actor.id }),
        listener: c.listener,
        action: "tracking.runs.describe",
        outcome: "allowed",
        project_id: c.params["id"] as string,
        target: runId,
        details: compact({ summary: summary !== undefined, notes: notes !== undefined }),
      });
      svc.events.publish(c.params["id"] as string, "tracking.run.described", {
        mlflow_run_id: runId,
      });
      const run = await mlflow(svc, () => svc.tracking.client.getRun(runId));
      return json(200, {
        run: runView(svc, run),
        ...(setAside !== undefined ? { set_aside: mark } : {}),
      });
    },
  },
];

/**
 * Run reads for agents, bound to the token's project (ADR 0040): search, one run, metrics (latest
 * values, or one metric's history paged), artifact listings and bounded text artifact reads. The
 * agent never writes runs here; its jobs' runs are written by their collectors.
 */
export const AGENT_TRACKING_OPS: readonly ResearchOp[] = [
  agentRead("/api/v1/projects/:id/runs", "tracking.runs.list", async (c) => {
    const pid = c.params["id"] as string;
    const ids = projectExperimentIds(c.svc, pid);
    const pending = pendingRuns(c.svc, pid);
    if (ids.length === 0) return json(200, { runs: [], pending_runs: pending });
    const page = await mlflow(c.svc, () =>
      c.svc.tracking.client.searchRuns(
        compact({
          experiment_ids: ids,
          filter: c.url.searchParams.get("filter") ?? undefined,
          run_view_type: viewParam(c.url),
          max_results: intParam(c.url, "max_results", 50, 1, 200),
          order_by: listParam(c.url, "order_by").length ? listParam(c.url, "order_by") : undefined,
          page_token: c.url.searchParams.get("page_token") ?? undefined,
        }),
      ),
    );
    return json(
      200,
      compact({
        runs: page.items.map((r) => runView(c.svc, r)),
        next_page_token: page.next_page_token,
        pending_runs: pending,
      }),
    );
  }),
  agentRead("/api/v1/projects/:id/runs/:run", "tracking.runs.read", async (c) => {
    const { mapping, runId, run } = await projectRun(c);
    if (!runId)
      return json(200, {
        ref: mapping?.ref,
        state: "tracking_pending",
        ...(mapping ? mappingView(c.svc, mapping) : {}),
      });
    const r = run ?? (await mlflow(c.svc, () => c.svc.tracking.client.getRun(runId)));
    return json(200, { run: runView(c.svc, r) });
  }),
  agentRead("/api/v1/projects/:id/runs/:run/metrics", "tracking.runs.metrics", async (c) => {
    const { mapping, runId } = await projectRun(c);
    if (c.url.searchParams.get("format") === "csv")
      throw new HttpError(400, "invalid_request", "agents read metric history as JSON");
    return metricsFor(c, runId ?? (mapping as TrackingRunMapping).ref);
  }),
  agentRead("/api/v1/projects/:id/runs/:run/artifacts", "tracking.runs.artifacts", async (c) => {
    const { mapping, runId } = await projectRun(c);
    if (!runId) return json(200, { ref: mapping?.ref, state: "tracking_pending", files: [] });
    const path = safeArtifactPath(c.url.searchParams.get("path"), false);
    const page = await mlflow(c.svc, () =>
      c.svc.tracking.client.listArtifacts(
        runId,
        path,
        c.url.searchParams.get("page_token") ?? undefined,
      ),
    );
    return json(
      200,
      compact({
        run_id: runId,
        path: path ?? "",
        files: page.items,
        next_page_token: page.next_page_token,
      }),
    );
  }),
  agentRead(
    "/api/v1/projects/:id/runs/:run/artifacts/text",
    "tracking.runs.artifacts.text",
    async (c) => {
      const { runId } = await projectRun(c);
      if (!runId)
        throw new HttpError(409, "tracking_pending", "MLflow has not acknowledged this run yet");
      const path = safeArtifactPath(c.url.searchParams.get("path"), true) as string;
      const offset = intParam(c.url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = intParam(c.url, "limit", 64 * 1024, 1, AGENT_TEXT_ARTIFACT_MAX_BYTES);
      const upstream = await mlflow(c.svc, () =>
        c.svc.tracking.client.downloadArtifact(runId, path),
      );
      const bytes = new Uint8Array(await upstream.arrayBuffer());
      const slice = bytes.subarray(offset, offset + limit);
      if (slice.includes(0))
        throw new HttpError(415, "not_text", `${path} is not a text file; list it instead`);
      // End a page on a UTF-8 character boundary.
      let end = slice.length;
      if (offset + end < bytes.length)
        while (end > 0 && ((bytes[offset + end] ?? 0) & 0xc0) === 0x80) end--;
      return json(
        200,
        compact({
          run_id: runId,
          path,
          size: bytes.length,
          offset,
          text: new TextDecoder().decode(slice.subarray(0, end)),
          next_offset: offset + end < bytes.length ? offset + end : undefined,
        }),
      );
    },
  ),
];
