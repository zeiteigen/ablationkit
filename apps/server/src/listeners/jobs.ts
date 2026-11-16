/**
 * Jobs (spec §4.3, §10; ADR 0011): submit, list, inspect, cancel, retry and read console output.
 * Compute status (the attempt) and sync status (its MLflow run) are shown separately; console
 * output comes from the attempt's own journal, never from MLflow.
 *
 * Agents (ADR 0037) submit, list and read jobs of their token's project, and cancel the jobs they
 * submitted. The project policy decides each submission: `jobs.run_local` on this machine,
 * `jobs.submit_remote` and its allowed targets elsewhere, and `compute.limit_hours` (the job needs
 * a time limit, and its time limit × its target's weight must fit). A refusal names the policy
 * field or the limit.
 */
import type { AttemptRecord, JobLimits, JobRecord, MetricsFormat } from "@ablationkit/protocol";
import { HttpError, intParam, json, readJsonBody } from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";
import type { AgentCall, AgentHandler } from "./agent.ts";
import { requireProject, session } from "./common.ts";
import type { HumanCall, HumanHandler } from "./human.ts";

function strings(body: Record<string, unknown>, key: string, max: number): string[] | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || x.length === 0))
    throw new HttpError(400, "invalid_request", `\`${key}\` must be an array of non-empty strings`);
  return v as string[];
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0)
    throw new HttpError(400, "invalid_request", `\`${key}\` must be a non-empty string`);
  return v;
}

const LIMIT_KEYS = [
  "memory_max_bytes",
  "cpu_quota_percent",
  "runtime_max_sec",
  "tasks_max",
] as const;

export function limits(body: Record<string, unknown>): JobLimits | undefined {
  const v = body["limits"];
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new HttpError(400, "invalid_request", "`limits` must be an object");
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(k))
      throw new HttpError(400, "invalid_request", `unknown limit ${k}`);
    if (!Number.isSafeInteger(n) || (n as number) < 1)
      throw new HttpError(400, "invalid_request", `limit ${k} must be a positive integer`);
    out[k] = n as number;
  }
  return out as JobLimits;
}

export function envObject(body: Record<string, unknown>): Record<string, string> | undefined {
  const v = body["env"];
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new HttpError(400, "invalid_request", "`env` must be an object of strings");
  for (const x of Object.values(v))
    if (typeof x !== "string")
      throw new HttpError(400, "invalid_request", "`env` values must be strings");
  return v as Record<string, string>;
}

/** An attempt's console after `after`, optionally only some streams (human and agent routes). */
async function consoleResponse(svc: Services, a: AttemptRecord, url: URL): Promise<Response> {
  const after = intParam(url, "after", -1, -1, Number.MAX_SAFE_INTEGER);
  const limit = intParam(url, "limit", 1000, 1, 10_000);
  const streams = url.searchParams.get("stream");
  const set = streams ? new Set(streams.split(",").map((s) => s.trim())) : undefined;
  const out = await svc.jobs.readConsole(a, { after, limit, ...(set ? { streams: set } : {}) });
  return json(200, { attempt_id: a.attempt_id, state: a.state, ...out });
}

function audit(c: HumanCall, action: string, projectId: string, target: string): void {
  c.svc.audit.record({
    actor: { kind: "human", id: c.session.token_id },
    listener: "human",
    action,
    outcome: "allowed",
    project_id: projectId,
    target,
  });
}

type SubmitInput = Parameters<Services["jobs"]["submit"]>[0];

/** A submission body, as the human and agent routes take it. */
function submitInput(
  body: Record<string, unknown>,
  projectId: string,
  by: JobRecord["submitted_by"],
): SubmitInput {
  const command = strings(body, "command", 1024);
  if (!command || command.length === 0)
    throw new HttpError(400, "invalid_request", "`command` is required");
  const environment = body["environment"];
  if (environment !== undefined && environment !== "uv" && environment !== "none")
    throw new HttpError(400, "invalid_request", "`environment` must be uv or none");
  const env = envObject(body);
  const lim = limits(body);
  const artifactPaths = strings(body, "artifact_paths", 64);
  const inputPaths = strings(body, "input_paths", 16);
  const description = optStr(body, "description")?.trim();
  if (description && description.length > 2000)
    throw new HttpError(400, "invalid_request", "`description` is longer than 2000 characters");
  return {
    project_id: projectId,
    command,
    submitted_by: by,
    ...(optStr(body, "cwd") ? { cwd: optStr(body, "cwd") as string } : {}),
    ...(environment ? { environment: environment as "uv" | "none" } : {}),
    ...(env ? { env } : {}),
    ...(lim ? { limits: lim } : {}),
    ...(artifactPaths ? { artifact_paths: artifactPaths } : {}),
    ...(inputPaths ? { input_paths: inputPaths } : {}),
    ...(optStr(body, "metrics_file")
      ? { metrics_file: optStr(body, "metrics_file") as string }
      : {}),
    ...(body["metrics_format"] !== undefined
      ? { metrics_format: metricsFormat(body["metrics_format"]) }
      : {}),
    ...(optStr(body, "target_id") ? { target_id: optStr(body, "target_id") as string } : {}),
    ...(body["accept_cost"] === true ? { accept_cost: true } : {}),
    ...(description ? { description } : {}),
    ...Object.fromEntries(
      (["run_name", "study_id", "variant_id", "task_id", "agenda_item"] as const).flatMap((k) => {
        const v = optStr(body, k);
        return v ? [[k, v]] : [];
      }),
    ),
  };
}

/**
 * A job's `agenda_item` by its canonical ID (`note:<id>` or `L<n>`, ADR 0058): 400
 * `unknown_agenda_item` when the agenda has no such item. Which item a job serves is the
 * submitter's declaration; the agenda's checks read it, nothing refuses on its lane.
 */
function withAgendaItem<T extends { project_id: string; agenda_item?: string }>(
  svc: Services,
  input: T,
): T {
  return input.agenda_item
    ? { ...input, agenda_item: svc.agenda.requireItem(input.project_id, input.agenda_item) }
    : input;
}

/** `metrics_format` (ADR 0042): `{step_keys?: string[] (1–8), timestamp_key?: string}`. */
function metricsFormat(v: unknown): MetricsFormat {
  const bad = (why: string) => new HttpError(400, "invalid_request", `\`metrics_format\` ${why}`);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad("must be an object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (k !== "step_keys" && k !== "timestamp_key") throw bad(`has an unknown key ${k}`);
  const key = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 250;
  const steps = o["step_keys"];
  if (
    steps !== undefined &&
    (!Array.isArray(steps) || steps.length < 1 || steps.length > 8 || !steps.every(key))
  )
    throw bad("step_keys must be 1 to 8 non-empty keys");
  if (o["timestamp_key"] !== undefined && !key(o["timestamp_key"]))
    throw bad("timestamp_key must be a non-empty key");
  return {
    ...(steps ? { step_keys: steps as string[] } : {}),
    ...(o["timestamp_key"] ? { timestamp_key: o["timestamp_key"] as string } : {}),
  };
}

export const JOB_ROUTES: readonly Route<HumanHandler>[] = [
  {
    method: "GET",
    path: "/api/v1/jobs/supervisor",
    handler: session("jobs.supervisor", (c) => json(200, c.svc.jobs.probe())),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/jobs",
    handler: session("job.submit", async (c) => {
      const input = submitInput(await readJsonBody(c.req), c.params["id"] as string, {
        kind: "human",
        id: c.session.token_id,
      });
      if (input.task_id) c.svc.tasks.requireOpen(input.project_id, input.task_id);
      const { job } = c.svc.jobs.submit(withAgendaItem(c.svc, input));
      return json(201, c.svc.jobs.jobView(job));
    }),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/jobs",
    handler: session("job.list", (c) => {
      const pid = c.params["id"] as string;
      c.svc.registry.require(pid);
      const limit = intParam(c.url, "limit", 50, 1, 500);
      const jobs = c.svc.jobs.list(pid).slice(0, limit);
      return json(200, { jobs: jobs.map((j) => c.svc.jobs.jobView(j, false)) });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/jobs",
    handler: session("job.list", (c) => {
      const limit = intParam(c.url, "limit", 50, 1, 500);
      const jobs = c.svc.jobs.list().slice(0, limit);
      return json(200, { jobs: jobs.map((j) => c.svc.jobs.jobView(j, false)) });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/jobs/:id",
    handler: session("job.read", (c) =>
      json(200, c.svc.jobs.jobView(c.svc.jobs.require(c.params["id"] as string))),
    ),
  },
  {
    method: "POST",
    path: "/api/v1/jobs/:id/cancel",
    handler: session("job.cancel", (c) => {
      const a = c.svc.jobs.cancel(c.params["id"] as string);
      audit(c, "job.cancel", a.project_id, a.attempt_id);
      return json(202, c.svc.jobs.attemptView(a));
    }),
  },
  {
    method: "POST",
    path: "/api/v1/jobs/:id/retry",
    handler: session("job.retry", async (c) => {
      const body = c.req.headers.get("content-type")?.startsWith("application/json")
        ? await readJsonBody(c.req)
        : {};
      const a = c.svc.jobs.retry(c.params["id"] as string, {
        acceptCost: body["accept_cost"] === true,
      });
      return json(201, c.svc.jobs.attemptView(a));
    }),
  },
  {
    method: "GET",
    path: "/api/v1/jobs/:id/attempts/:attemptId/console",
    handler: session("job.console", async (c) => {
      const a = c.svc.jobs.requireAttempt(
        c.params["id"] as string,
        c.params["attemptId"] as string,
      );
      return consoleResponse(c.svc, a, c.url);
    }),
  },
];

/** A job of the token's project, or 404 (another project's jobs do not exist for this agent). */
function ownJob(c: AgentCall): JobRecord {
  const j = c.svc.jobs.get(c.params["id"] as string);
  if (!j || j.project_id !== c.token.scope.project_id)
    throw new HttpError(404, "job_not_found", `no job ${c.params["id"]}`);
  return j;
}

function agentAudit(
  c: AgentCall,
  action: string,
  outcome: "allowed" | "denied",
  target: string,
  details?: Record<string, unknown>,
  reason?: string,
): void {
  c.svc.audit.record({
    actor: { kind: "agent", id: c.token.token_id },
    listener: "agent",
    action,
    outcome,
    project_id: c.token.scope.project_id,
    target,
    ...(details ? { details } : {}),
    ...(reason ? { reason: reason.slice(0, 1024) } : {}),
  });
}

const agentOp = (action: string, run: AgentHandler["run"]): AgentHandler => ({
  auth: "agent",
  action,
  run,
});

/**
 * Job submission and reading for agents (ADR 0037). Submitting checks the project policy: allowed
 * proceeds, denied is refused (403 `policy_denied`) with the field that denies it; then the compute
 * limit (400 `time_limit_required` without a time limit, 403 `compute_limit_reached` when it does
 * not fit). A paid target the policy allows counts as the researcher's cost acceptance; the agent
 * cannot accept cost itself.
 */
export const AGENT_JOB_ROUTES: readonly Route<AgentHandler>[] = [
  {
    method: "POST",
    path: "/api/v1/projects/:id/jobs",
    handler: agentOp("job.submit", async (c) => {
      const pid = c.params["id"] as string;
      requireProject(c.svc, c.token, pid);
      const body = await readJsonBody(c.req);
      const { accept_cost: _a, ...given } = submitInput(body, pid, {
        kind: "agent",
        id: c.token.token_id,
      });
      // A task the job is recorded under: one of this project's, still open (ADR 0039).
      if (given.task_id) c.svc.tasks.requireOpen(pid, given.task_id);
      // The agenda item it serves, by its canonical ID (ADR 0058); an unknown one is refused.
      const input = withAgendaItem(c.svc, given);
      const targetId = input.target_id;
      const target = targetId ? c.svc.targets.get(targetId) : undefined;
      let weight: number;
      try {
        c.svc.policy.requireAgent(
          pid,
          targetId ? "jobs.submit_remote" : "jobs.run_local",
          targetId ? { target: targetId, ...(target ? { targetKind: target.kind } : {}) } : {},
        );
        // The compute limit (ADR 0037) is held through each attempt's time limit.
        const runtime = input.limits?.runtime_max_sec;
        if (runtime === undefined)
          throw new HttpError(
            400,
            "time_limit_required",
            "an agent's job needs a time limit (`limits.runtime_max_sec`; `runtime_max_sec` on the `ablationkit_job submit` tool): it is how the project's compute limit is held",
          );
        weight = c.svc.compute.admit(pid, targetId ?? "local", runtime);
      } catch (e) {
        if (e instanceof HttpError)
          agentAudit(
            c,
            "job.submit",
            "denied",
            targetId ?? "local",
            { command: input.command[0], code: e.code, ...e.extra },
            e.message,
          );
        throw e;
      }
      const { job } = c.svc.jobs.submit({
        ...input,
        ...(targetId && target?.paid ? { accept_cost: true } : {}),
        compute_weight_hundredths: weight,
      });
      agentAudit(c, "job.submit", "allowed", job.job_id, {
        target: targetId ?? "local",
        policy: targetId ? "jobs.submit_remote" : "jobs.run_local",
        compute_weight: weight / 100,
      });
      return json(201, c.svc.jobs.jobView(job));
    }),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/jobs",
    handler: agentOp("job.list", (c) => {
      const pid = c.params["id"] as string;
      requireProject(c.svc, c.token, pid);
      const limit = intParam(new URL(c.req.url), "limit", 50, 1, 500);
      const jobs = c.svc.jobs.list(pid).slice(0, limit);
      return json(200, { jobs: jobs.map((j) => c.svc.jobs.jobView(j, false)) });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/jobs",
    handler: agentOp("job.list", (c) => {
      const limit = intParam(new URL(c.req.url), "limit", 50, 1, 500);
      const jobs = c.svc.jobs.list(c.token.scope.project_id).slice(0, limit);
      return json(200, { jobs: jobs.map((j) => c.svc.jobs.jobView(j, false)) });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/jobs/:id",
    handler: agentOp("job.read", (c) => json(200, c.svc.jobs.jobView(ownJob(c)))),
  },
  {
    method: "POST",
    path: "/api/v1/jobs/:id/cancel",
    handler: agentOp("job.cancel", (c) => {
      const j = ownJob(c);
      if (j.submitted_by.kind !== "agent" || j.submitted_by.id !== c.token.token_id)
        throw new HttpError(403, "forbidden_scope", "an agent cancels only the jobs it submitted");
      const a = c.svc.jobs.cancel(j.job_id);
      agentAudit(c, "job.cancel", "allowed", a.attempt_id);
      return json(202, c.svc.jobs.attemptView(a));
    }),
  },
  {
    method: "GET",
    path: "/api/v1/jobs/:id/attempts/:attemptId/console",
    handler: agentOp("job.console", async (c) => {
      const j = ownJob(c);
      const a = c.svc.jobs.requireAttempt(j.job_id, c.params["attemptId"] as string);
      return consoleResponse(c.svc, a, new URL(c.req.url));
    }),
  },
];
