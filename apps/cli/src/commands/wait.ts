/**
 * `ablationkit_wait` (ADR 0060): an agent waits for its jobs instead of sleeping or polling in a
 * shell. The MCP server polls the agent API and returns when the jobs reach what was asked: ended
 * with their results in, running, or a metric at a step. It returns early when the researcher
 * writes to the session (directions or an agenda change, which come with the result), and when the
 * cap passes, saying what each job is doing so the agent can wait again.
 */
import { CoordinatorUnavailable } from "../client.ts";
import { UsageError } from "../context.ts";
import type { AgentApi } from "./mcp.ts";

type Json = Record<string, unknown>;

export const WAIT_DEFAULT_SEC = 600;
export const WAIT_MAX_SEC = 3600;
/** How often job state is read (tests set ABLATIONKIT_WAIT_POLL_MS). */
const pollInterval = (): number => Number(process.env["ABLATIONKIT_WAIT_POLL_MS"]) || 5000;
/** A metric condition reads MLflow: less often than job state. */
const METRIC_POLL_MS = 15_000;
/** A coordinator restart takes seconds: a wait rides out this long without an answer. */
const OUTAGE_GRACE_MS = 120_000;
const OUTAGE_POLL_MS = 2_000;
const TERMINAL = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "oom_killed",
  "unknown",
]);

export interface WaitContext {
  /** The harness cancelled the call. */
  readonly signal?: AbortSignal;
  /** Each poll: seconds waited, the cap and what is happening (MCP progress notifications). */
  readonly progress?: (waitedSec: number, totalSec: number, message: string) => void;
  /** Tests: the poll interval. */
  readonly pollMs?: number;
}

interface AttemptView {
  attempt_id: string;
  state: string;
  exit_code?: number;
  error?: string;
  started_at?: string;
  ended_at?: string;
  tracking?: { mlflow_run_id?: string; sync_state?: string };
  remote?: {
    target_id?: string;
    staging?: string;
    staging_error?: string;
    provider_state?: string;
    sync?: string;
    reconcile_required?: string;
  };
}

interface JobView {
  job_id: string;
  run_name?: string;
  state: string;
  target_id?: string;
  submitted_by?: { kind?: string; id?: string };
  latest_attempt?: AttemptView;
}

type For = "end" | "start" | "metric";

const enc = encodeURIComponent;

export const WAIT_DESCRIPTION =
  'Wait for your jobs here instead of sleeping or polling in a shell: it returns when they get where you asked. for: "end" (the default) waits until a job ended and its results are in (its MLflow run synced; a remote job\'s results collected); "start" until it is running (past the queue and a remote target\'s staging); "metric" until its run logged `metric` at `step` or later (e.g. the first loss, or step 1000). It waits on the jobs you name (job IDs, or runs: run names or MLflow run IDs), else on every live job this session submitted; until: "any" (the default: as soon as one is there, so you can read it while the others run) or "all". A job that ends counts for "start" and "metric" too, since it will get no further. timeout_sec caps one call (default 600, at most 3600; keep it under your harness\'s tool-call timeout): a call that hits it says what each job is doing, so call again or do other work and come back. It returns at once when the researcher writes to you (a direction or an agenda change, which come with the result). Read what ended with ablationkit_read run.metrics and job.log.';

export const WAIT_SCHEMA: Json = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: { type: "string" },
      description: "Job IDs to wait on (from ablationkit_job submit).",
    },
    runs: {
      type: "array",
      items: { type: "string" },
      description: "Or runs: run names or MLflow run IDs of this project's jobs.",
    },
    for: {
      type: "string",
      enum: ["end", "start", "metric"],
      description:
        "end (default): ended with results in; start: running; metric: its run logged `metric` (at `step` or later).",
    },
    until: {
      type: "string",
      enum: ["any", "all"],
      description: "any (default): return when one job is there; all: when every job is.",
    },
    metric: { type: "string", description: 'for "metric": the metric key, e.g. "loss".' },
    step: {
      type: "integer",
      minimum: 0,
      description: 'for "metric": the step it must reach (default: any step).',
    },
    timeout_sec: {
      type: "integer",
      minimum: 0,
      maximum: WAIT_MAX_SEC,
      description: `Return after at most this long (default ${WAIT_DEFAULT_SEC}, at most ${WAIT_MAX_SEC}).`,
    },
  },
  additionalProperties: false,
};

function list(a: Json, key: string): string[] {
  const v = a[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x))
    throw new UsageError(`ablationkit_wait: ${key} must be a list of strings`);
  return v as string[];
}

/** The jobs to wait on: those named, those whose runs are named, else this session's live ones. */
async function resolveJobs(api: AgentApi, a: Json): Promise<{ ids: string[]; implicit: boolean }> {
  const jobs = list(a, "jobs");
  const runs = list(a, "runs");
  if (!jobs.length && !runs.length) {
    const [me, all] = await Promise.all([
      api.request<{ token_id?: string }>("GET", "/api/v1/whoami"),
      api.request<{ jobs: JobView[] }>(
        "GET",
        `/api/v1/projects/${enc(api.project)}/jobs?limit=500`,
      ),
    ]);
    const mine = all.jobs.filter(
      (j) =>
        j.submitted_by?.kind === "agent" &&
        j.submitted_by.id === me.token_id &&
        !TERMINAL.has(j.latest_attempt?.state ?? j.state),
    );
    return { ids: mine.map((j) => j.job_id), implicit: true };
  }
  const ids = [...jobs];
  if (runs.length) {
    const all = await api.request<{ jobs: JobView[] }>(
      "GET",
      `/api/v1/projects/${enc(api.project)}/jobs?limit=500`,
    );
    for (const r of runs) {
      const j = all.jobs.find(
        (x) =>
          x.run_name === r ||
          x.latest_attempt?.tracking?.mlflow_run_id === r ||
          x.latest_attempt?.attempt_id === r,
      );
      if (!j)
        throw new UsageError(
          `ablationkit_wait: no job of this project has the run ${r} (ablationkit_read job.list)`,
        );
      ids.push(j.job_id);
    }
  }
  return { ids: [...new Set(ids)], implicit: false };
}

interface Status {
  readonly view: Json;
  readonly ready: boolean;
  readonly line: string;
}

/** Where a job is, and whether it is where the call waits for. */
async function status(
  api: AgentApi,
  j: JobView,
  forWhat: For,
  metric: string | undefined,
  step: number | undefined,
  readMetric: boolean,
  lastMetric: Map<string, Json>,
): Promise<Status> {
  const a = j.latest_attempt;
  const state = a?.state ?? j.state;
  const ended = TERMINAL.has(state);
  const r = a?.remote;
  // Results are in once MLflow has every write and a remote attempt's spool is home.
  const collecting =
    ended &&
    r !== undefined &&
    !["synced", "sync_failed"].includes(r.sync ?? "") &&
    !r.reconcile_required;
  const syncing = ended && a?.tracking?.sync_state === "tracking_pending";
  const results = !ended
    ? undefined
    : collecting
      ? "being collected from the target"
      : syncing
        ? "reaching MLflow"
        : a?.tracking?.sync_state === "sync_failed"
          ? "MLflow rejected a write (retrying)"
          : "in";
  let reached: Json | undefined = lastMetric.get(j.job_id);
  if (forWhat === "metric" && metric && a && state === "running" && readMetric) {
    try {
      const m = await api.request<{ metrics?: { key: string; value: number; step?: number }[] }>(
        "GET",
        `/api/v1/projects/${enc(api.project)}/runs/${enc(a.tracking?.mlflow_run_id ?? a.attempt_id)}/metrics`,
      );
      const hit = m.metrics?.find((x) => x.key === metric);
      if (hit) {
        reached = { key: hit.key, value: hit.value, step: hit.step ?? 0 };
        lastMetric.set(j.job_id, reached);
      }
    } catch {
      // The run is not in MLflow yet: wait.
    }
  }
  const ready =
    forWhat === "end"
      ? ended && !collecting && !syncing
      : forWhat === "start"
        ? state === "running" || ended
        : ended || (reached !== undefined && Number(reached["step"] ?? 0) >= (step ?? 0));
  // "running", "starting, staging", "running (job ended (worker exit 75))": the provider's word
  // only when it adds something.
  const provider = r?.provider_state;
  const placement = (j as { placement?: { target?: string; waiting?: string; error?: string } })
    .placement;
  const where = r
    ? `${state}${r.staging && r.staging !== "submitted" ? `, ${r.staging}` : ""}${provider && !provider.startsWith(state) ? ` (${provider})` : ""}`
    : state === "queued" && placement?.waiting
      ? `queued (${placement.waiting})`
      : placement?.error && !a
        ? `${state} (${placement.error})`
        : state;
  const view: Json = {
    job_id: j.job_id,
    ...(j.run_name ? { run_name: j.run_name } : {}),
    state,
    ready,
    ...(placement ? { placement } : {}),
    ...(results ? { results } : {}),
    ...(a
      ? {
          attempt_id: a.attempt_id,
          run: a.tracking?.mlflow_run_id ?? a.attempt_id,
          ...(a.exit_code !== undefined ? { exit_code: a.exit_code } : {}),
          ...(a.error ? { error: a.error } : {}),
          ...(a.started_at ? { started_at: a.started_at } : {}),
          ...(a.ended_at ? { ended_at: a.ended_at } : {}),
        }
      : {}),
    ...(reached ? { metric: reached } : {}),
    ...(r
      ? {
          remote: {
            target_id: r.target_id,
            staging: r.staging,
            ...(r.provider_state ? { provider_state: r.provider_state } : {}),
            sync: r.sync,
            ...(r.staging_error ? { staging_error: r.staging_error } : {}),
            ...(r.reconcile_required ? { reconcile_required: r.reconcile_required } : {}),
          },
        }
      : {}),
  };
  return { view, ready, line: `${j.run_name ?? j.job_id}: ${where}` };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(t);
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** Wait (see the module comment). */
export async function waitForJobs(api: AgentApi, a: Json, ctx: WaitContext = {}): Promise<Json> {
  for (const k of Object.keys(a))
    if (!(k in (WAIT_SCHEMA["properties"] as Json)))
      throw new UsageError(`ablationkit_wait: unknown argument ${k}`);
  const forWhat = (a["for"] ?? "end") as For;
  if (!["end", "start", "metric"].includes(forWhat))
    throw new UsageError('ablationkit_wait: for is "end", "start" or "metric"');
  const until = a["until"] ?? "any";
  if (until !== "any" && until !== "all")
    throw new UsageError('ablationkit_wait: until is "any" or "all"');
  const metric = typeof a["metric"] === "string" && a["metric"] ? a["metric"] : undefined;
  if (forWhat === "metric" && !metric)
    throw new UsageError('ablationkit_wait: for "metric" needs metric (a metric key)');
  const step = a["step"] === undefined ? undefined : Number(a["step"]);
  if (step !== undefined && !(Number.isInteger(step) && step >= 0))
    throw new UsageError("ablationkit_wait: step is a whole number");
  const t = a["timeout_sec"] === undefined ? WAIT_DEFAULT_SEC : Number(a["timeout_sec"]);
  if (!Number.isFinite(t) || t < 0)
    throw new UsageError("ablationkit_wait: timeout_sec is a number of seconds");
  const timeoutSec = Math.min(WAIT_MAX_SEC, t);
  const { ids, implicit } = await resolveJobs(api, a);
  if (!ids.length)
    return {
      done: true,
      reason: "nothing_to_wait_for",
      jobs: [],
      next: implicit
        ? "This session has no live jobs. Name jobs or runs to wait on ones that ended or that another session submitted."
        : "No jobs named.",
    };
  const started = Date.now();
  const pollMs = ctx.pollMs ?? pollInterval();
  const lastMetric = new Map<string, Json>();
  let lastMetricRead = 0;
  // When the coordinator went away (restarting), since when: the wait rides it out for a while.
  let outage: number | undefined;
  for (;;) {
    let views: JobView[];
    try {
      views = await Promise.all(
        ids.map((id) => api.request<JobView>("GET", `/api/v1/jobs/${enc(id)}`)),
      );
      outage = undefined;
    } catch (e) {
      if (!(e instanceof CoordinatorUnavailable)) throw e;
      outage ??= Date.now();
      if (Date.now() - outage > OUTAGE_GRACE_MS || Date.now() - started >= timeoutSec * 1000)
        throw e;
      ctx.progress?.(
        Math.round((Date.now() - started) / 1000),
        timeoutSec,
        "the coordinator is not answering (restarting?): still waiting",
      );
      await sleep(Math.min(OUTAGE_POLL_MS, timeoutSec * 1000 - (Date.now() - started)), ctx.signal);
      continue;
    }
    // The researcher wrote while we waited: hand the turn back now (it comes with the result).
    const researcher = (api.pending?.() ?? 0) > 0 || api.agendaWaiting?.() !== undefined;
    const readMetric =
      forWhat === "metric" && Date.now() - lastMetricRead >= Math.min(METRIC_POLL_MS, pollMs * 3);
    if (readMetric) lastMetricRead = Date.now();
    const st = await Promise.all(
      views.map((v) => status(api, v, forWhat, metric, step, readMetric, lastMetric)),
    );
    const ready = st.filter((s) => s.ready);
    const done = until === "all" ? ready.length === st.length : ready.length > 0;
    const waited = Math.round((Date.now() - started) / 1000);
    const timedOut = Date.now() - started >= timeoutSec * 1000;
    if (done || researcher || timedOut) {
      const reason = done ? "condition" : researcher ? "researcher" : "timeout";
      const left = st.length - ready.length;
      return {
        done,
        reason,
        for: forWhat,
        until,
        ...(metric ? { metric, ...(step !== undefined ? { step } : {}) } : {}),
        waited_sec: waited,
        ready: ready.map((s) => s.view["job_id"]),
        jobs: st.map((s) => s.view),
        next:
          reason === "researcher"
            ? "The researcher wrote to you (with this result): finish the step you are on, act on it, then wait again."
            : reason === "timeout"
              ? `Nothing got there in ${timeoutSec} s. Call ablationkit_wait again, or do other work and come back.`
              : forWhat === "end"
                ? `Read what ended (ablationkit_read run.metrics, job.log) and describe it (ablationkit_run describe)${left ? `; ${left} still going: wait again for ${left === 1 ? "it" : "them"}` : ""}.`
                : `There${left ? `; ${left} not yet: wait again for ${left === 1 ? "it" : "them"}` : ""}.`,
      };
    }
    const target =
      forWhat === "end"
        ? "to end"
        : forWhat === "start"
          ? "to start"
          : `to log ${metric}${step !== undefined ? ` at step ${step}` : ""}`;
    ctx.progress?.(
      waited,
      timeoutSec,
      `waiting for ${until === "all" ? "all" : "any"} of ${st.length} ${target}: ${st.map((s) => s.line).join("; ")}`.slice(
        0,
        500,
      ),
    );
    await sleep(Math.min(pollMs, timeoutSec * 1000 - (Date.now() - started)), ctx.signal);
  }
}
