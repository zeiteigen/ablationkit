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
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decide } from "@ablationkit/autonomy-policy";
import type {
  AttemptRecord,
  JobInput,
  JobLimits,
  JobRecord,
  MetricsFormat,
} from "@ablationkit/protocol";
import { parseInputs, stageInputs } from "../compute/job-inputs.ts";
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
  const gpu = body["gpu"];
  if (gpu !== undefined && gpu !== "all" && gpu !== "none")
    throw new HttpError(
      400,
      "invalid_request",
      '`gpu` is "none" (no GPU: tests, checks, CPU work) or "all" (the default)',
    );
  const description = optStr(body, "description")?.trim();
  if (description && description.length > 2000)
    throw new HttpError(400, "invalid_request", "`description` is longer than 2000 characters");
  return {
    project_id: projectId,
    command,
    submitted_by: by,
    ...(optStr(body, "cwd") ? { cwd: optStr(body, "cwd") as string } : {}),
    ...(environment ? { environment: environment as "uv" | "none" } : {}),
    ...(gpu === "none" ? { gpu: "none" as const } : {}),
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
      const id = c.params["id"] as string;
      if (c.svc.jobs.require(id).state === "queued") {
        const done = c.svc.jobs.dequeue(id);
        audit(c, "job.cancel", done.project_id, done.job_id);
        return json(202, c.svc.jobs.jobView(done, false));
      }
      const a = c.svc.jobs.cancel(id);
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

/** At most this many arguments to `uv sync` in an environment build. */
const MAX_BUILD_ARGS = 32;
/** An environment build's time limit when the agent gives none: a first CUDA install takes minutes. */
const BUILD_RUNTIME_SEC = 1_200;

/**
 * An environment build's submission (ADR 0066): `uv sync` with the agent's arguments (`--extra
 * cuda`), no GPU, run as given (the build makes the environment `uv run` would need). The record
 * names the command; the job container runs it from the current environment's copy.
 */
function environmentBuildBody(
  svc: Services,
  pid: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const args = raw["args"] === undefined ? [] : raw["args"];
  if (
    !Array.isArray(args) ||
    args.length > MAX_BUILD_ARGS ||
    !args.every((a) => typeof a === "string" && a.length > 0 && a.length <= 512)
  )
    throw new HttpError(
      400,
      "invalid_request",
      `\`args\`: at most ${MAX_BUILD_ARGS} arguments to uv sync, e.g. ["--extra", "cuda"]`,
    );
  if (raw["command"] !== undefined || raw["target_id"] !== undefined || raw["env"] !== undefined)
    throw new HttpError(
      400,
      "invalid_request",
      "an environment build runs `uv sync` on this machine: give `args`, not `command`, `env` or `target_id`",
    );
  const project = svc.registry.require(pid);
  if (!existsSync(join(project.path, "pyproject.toml")))
    throw new HttpError(
      422,
      "no_project_environment",
      `${project.path} has no pyproject.toml: there is no uv environment to build`,
    );
  const keep = ["run_name", "description", "task_id", "agenda_item"];
  const given = raw["limits"];
  const limits =
    given && typeof given === "object" && !Array.isArray(given)
      ? (given as Record<string, unknown>)
      : {};
  return {
    ...Object.fromEntries(keep.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])),
    limits: { runtime_max_sec: BUILD_RUNTIME_SEC, ...limits },
    command: ["uv", "sync", ...(args as string[])],
    environment: "none",
    gpu: "none",
    run_name: typeof raw["run_name"] === "string" ? raw["run_name"] : "environment build",
    description:
      typeof raw["description"] === "string"
        ? raw["description"]
        : "Build the project's environment from pyproject.toml and uv.lock (uv sync), for the jobs that run in it.",
  };
}

/**
 * Job submission and reading for agents (ADRs 0037, 0068). An agent never picks a target: its job
 * is queued and AblationKit places it on a target of the project's pool (what the policy allows:
 * this machine, then the allowed remote targets) with a free slot. Submitting checks that the pool
 * holds a target (403 `policy_denied` otherwise), then the compute limit at the heaviest weight of
 * the pool (400 `time_limit_required` without a time limit, 403 `compute_limit_reached` when it
 * does not fit). A paid target in the pool counts as the researcher's cost acceptance.
 */
export const AGENT_JOB_ROUTES: readonly Route<AgentHandler>[] = [
  {
    method: "POST",
    path: "/api/v1/projects/:id/jobs",
    handler: agentOp("job.submit", async (c) => {
      const pid = c.params["id"] as string;
      requireProject(c.svc, c.token, pid);
      const raw = await readJsonBody(c.req);
      // A contained session's jobs run in job containers (ADR 0061); a protected evaluation runs
      // the researcher's pinned command, never the agent's.
      const sessionId = c.token.agent_session?.container_session;
      const evaluation = typeof raw["evaluation"] === "string" ? raw["evaluation"] : undefined;
      if (raw["evaluation"] !== undefined && evaluation === undefined)
        throw new HttpError(
          400,
          "invalid_request",
          "`evaluation` is a protected evaluation's name",
        );
      if (evaluation && !sessionId)
        throw new HttpError(
          400,
          "evaluation_needs_container",
          "protected evaluations run only for agents in an agent container (ADR 0061): outside one, the data they protect is not hidden from you",
        );
      const inputs = parseInputs(raw["inputs"]);
      if (raw["target_id"] !== undefined)
        throw new HttpError(
          400,
          "target_not_agents",
          "where an agent's job runs is the researcher's (ADR 0068): give no `target_id`. AblationKit queues the job and starts it on a target of the project's pool (ablationkit_project lists it) as soon as one has a free slot",
        );
      const build = raw["build_environment"] === true;
      if (raw["build_environment"] !== undefined && raw["build_environment"] !== true)
        throw new HttpError(400, "invalid_request", "`build_environment` is true or absent");
      if (build && !sessionId)
        throw new HttpError(
          400,
          "environment_build_needs_container",
          "environment builds are for agents in an agent container (ADR 0066); on this machine outside one, the project's own environment is yours to sync",
        );
      if (build && evaluation)
        throw new HttpError(
          400,
          "invalid_request",
          "give `build_environment` or `evaluation`, not both",
        );
      let body = raw;
      if (build) body = environmentBuildBody(c.svc, pid, raw);
      if (evaluation) {
        const e = c.svc.containers.config(pid).evaluations.find((x) => x.name === evaluation);
        if (!e)
          throw new HttpError(
            404,
            "evaluation_not_found",
            `the project has no protected evaluation ${evaluation}`,
          );
        const keep = [
          "run_name",
          "description",
          "study_id",
          "variant_id",
          "task_id",
          "agenda_item",
        ];
        body = {
          ...Object.fromEntries(keep.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])),
          command: e.command,
          environment: e.environment,
          ...(e.cwd ? { cwd: e.cwd } : {}),
          limits: { runtime_max_sec: e.runtime_max_sec },
          run_name: typeof raw["run_name"] === "string" ? raw["run_name"] : `evaluation ${e.name}`,
        };
      }
      const { accept_cost: _a, ...parsed } = submitInput(body, pid, {
        kind: "agent",
        id: c.token.token_id,
      });
      const given = sessionId
        ? {
            ...parsed,
            container: {
              session_id: sessionId,
              ...(evaluation ? { evaluation } : {}),
              ...(build ? { build_environment: true as const } : {}),
            },
          }
        : parsed;
      // A task the job is recorded under: one of this project's, still open (ADR 0039).
      if (given.task_id) c.svc.tasks.requireOpen(pid, given.task_id);
      // The agenda item it serves, by its canonical ID (ADR 0058); an unknown one is refused.
      const input = withAgendaItem(c.svc, given);
      // Protected evaluations and environment builds run only on this machine (ADRs 0061, 0066).
      const localOnly = build || evaluation !== undefined;
      const pool = c.svc.compute
        .pool(pid)
        .filter((t) => !localOnly || t.target_id === "local")
        .map((t) => t.target_id);
      // Admission checks the compute limit against what is used and reserved; the job reserves
      // its share only when enqueued, so it is admitted again after any await before that.
      const admitJob = (): number => {
        try {
          // The pool is what the policy allows: an empty one is the policy's refusal.
          if (!pool.length) {
            const policy = c.svc.policy.current(pid);
            const reasons = [
              ...decide(policy, "jobs.run_local").reasons,
              ...(localOnly
                ? []
                : policy.jobs.submit_remote.decision === "allow"
                  ? ["jobs.submit_remote.allowed_targets matches no configured compute target"]
                  : decide(policy, "jobs.submit_remote").reasons),
            ];
            throw new HttpError(
              403,
              "policy_denied",
              `${localOnly ? "this runs only on this machine" : "the project's pool is empty"}: ${reasons.join("; ")}. The researcher changes it in Project settings → Agent permissions`,
              {
                action: localOnly ? "jobs.run_local" : "jobs.submit_remote",
                policy_revision: policy.revision,
                reasons,
              },
            );
          }
          // The compute limit (ADR 0037) is held through each attempt's time limit.
          const runtime = input.limits?.runtime_max_sec;
          if (runtime === undefined)
            throw new HttpError(
              400,
              "time_limit_required",
              "an agent's job needs a time limit (`limits.runtime_max_sec`; `runtime_max_sec` on the `ablationkit_job submit` tool): it is how the project's compute limit is held",
            );
          return c.svc.compute.admit(pid, pool, runtime);
        } catch (e) {
          if (e instanceof HttpError) {
            agentAudit(
              c,
              "job.submit",
              "denied",
              pool.join(",") || "none",
              { command: input.command[0], code: e.code, ...e.extra },
              e.message,
            );
            if (e.code === "compute_limit_reached") c.svc.containers.computeLimitRefused(c.token);
          }
          throw e;
        }
      };
      let weight = admitJob();
      // What earlier runs produced, downloaded now (ADR 0068). A job that would run in the checkout
      // itself (outside an agent container, on this machine) has nowhere to put them.
      let staged: { dir: string; inputs: JobInput[] } | undefined;
      if (inputs.length) {
        if (localOnly)
          throw new HttpError(
            400,
            "invalid_request",
            "an environment build or a protected evaluation takes no `inputs`",
          );
        if (!sessionId && pool.includes("local"))
          throw new HttpError(
            400,
            "inputs_need_a_copy",
            "`inputs` go into the copy of its source a job runs in an agent container or on a remote target; outside a container this machine runs your jobs in the checkout itself, where earlier outputs already are",
          );
        const dir = join(c.svc.paths.workDir, "staging", randomBytes(6).toString("hex"));
        staged = { dir, inputs: await stageInputs(c.svc, pid, inputs, dir) };
      }
      let job: JobRecord;
      try {
        // Other jobs may have been admitted and enqueued while the inputs downloaded: admit again,
        // with nothing awaited between this and the reservation the job makes.
        if (staged) weight = admitJob();
        job = c.svc.jobs.enqueue({
          ...input,
          compute_weight_hundredths: weight,
          queue: localOnly ? { local_only: true } : {},
          ...(staged ? { staged_inputs: staged } : {}),
        });
      } finally {
        if (staged) rmSync(staged.dir, { recursive: true, force: true });
      }
      agentAudit(c, "job.submit", "allowed", job.job_id, {
        pool,
        state: job.state,
        ...(staged ? { inputs: staged.inputs.map((x) => `${x.run}:${x.path || "*"}`) } : {}),
        ...(job.placement?.target ? { placed: job.placement.target } : {}),
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
      if (j.state === "queued") {
        const done = c.svc.jobs.dequeue(j.job_id);
        agentAudit(c, "job.cancel", "allowed", j.job_id, { queued: true });
        return json(202, c.svc.jobs.jobView(done, false));
      }
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
      if (j.container?.evaluation)
        throw new HttpError(
          403,
          "protected_evaluation",
          `job ${j.job_id} is the protected evaluation ${j.container.evaluation}: its console may show the data it protects, so only the researcher reads it; its metrics are in its run`,
        );
      const a = c.svc.jobs.requireAttempt(j.job_id, c.params["attemptId"] as string);
      return consoleResponse(c.svc, a, new URL(c.req.url));
    }),
  },
];
