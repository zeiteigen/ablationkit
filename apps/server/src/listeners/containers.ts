/**
 * Agent containers (ADR 0061): the researcher's routes. Starting a session, pausing, resuming and
 * stopping it, reading its terminal and its egress, and the project's container configuration are
 * all here, on the human listener only: no agent route reads or changes any of it.
 */
import { HttpError, json, readJsonBody, str } from "../http.ts";
import type { Route } from "../router.ts";
import type { HumanCall, HumanHandler } from "./human.ts";

const session = (action: string, run: HumanHandler["run"]): HumanHandler => ({
  auth: "session",
  action,
  run,
});

function by(c: HumanCall): string {
  return c.session.token_id;
}

function strings(v: unknown, what: string, max: number): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string"))
    throw new HttpError(
      400,
      "invalid_request",
      `\`${what}\` must be an array of at most ${max} strings`,
    );
  return v as string[];
}

function view(c: HumanCall, sid: string): Record<string, unknown> {
  const s = c.svc.containers.require(sid);
  return {
    ...s,
    ...(["starting", "running", "paused"].includes(s.state)
      ? { attach: c.svc.containers.attachCommand(sid) }
      : {}),
  };
}

export const CONTAINER_ROUTES: readonly Route<HumanHandler>[] = [
  {
    method: "GET",
    path: "/api/v1/agent-containers",
    handler: session("agent.container.list", (c) => {
      const project = c.url.searchParams.get("project") ?? undefined;
      if (project) c.svc.registry.require(project);
      return json(200, {
        sessions: c.svc.containers.list(project),
        runtime: c.svc.containers.runtime(),
      });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/agent-containers/runtime",
    handler: session("agent.container.runtime", (c) =>
      json(200, { ...c.svc.containers.runtime(true), tree: c.svc.containers.tree }),
    ),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/agent-containers",
    handler: session("agent.container.start", async (c) => {
      const pid = c.params["id"] as string;
      const body = await readJsonBody(c.req);
      const harness = str(body, "harness", { optional: true }) ?? "claude-code";
      if (harness !== "claude-code" && harness !== "codex" && harness !== "shell")
        throw new HttpError(400, "invalid_request", "`harness` is claude-code, codex or shell");
      const binaries = (body["binaries"] ?? {}) as Record<string, unknown>;
      const git = (body["git"] ?? {}) as Record<string, unknown>;
      const opt = (o: Record<string, unknown>, k: string) =>
        typeof o[k] === "string" && (o[k] as string).length > 0 ? (o[k] as string) : undefined;
      const label = str(body, "label", { optional: true });
      const harnessBin = opt(binaries, "harness");
      const name = opt(git, "name");
      const email = opt(git, "email");
      const login = (body["login"] ?? {}) as Record<string, unknown>;
      const loginFrom = opt(login, "from");
      const s = await c.svc.containers.start(
        pid,
        {
          harness,
          args: strings(body["args"], "args", 64),
          ...(label ? { label } : {}),
          binaries: { ...(harnessBin ? { harness: harnessBin } : {}) },
          git: { ...(name ? { name } : {}), ...(email ? { email } : {}) },
          login: { copy: login["copy"] !== false, ...(loginFrom ? { from: loginFrom } : {}) },
          remote_control: body["remote_control"] !== false,
        },
        by(c),
      );
      return json(201, view(c, s.session_id));
    }),
  },
  {
    method: "GET",
    path: "/api/v1/agent-containers/:sid",
    handler: session("agent.container.read", (c) => json(200, view(c, c.params["sid"] as string))),
  },
  {
    method: "POST",
    path: "/api/v1/agent-containers/:sid/pause",
    handler: session("agent.container.pause", async (c) => {
      const body = await readJsonBody(c.req);
      c.svc.containers.pause(
        c.params["sid"] as string,
        by(c),
        str(body, "reason", { optional: true }),
      );
      return json(200, view(c, c.params["sid"] as string));
    }),
  },
  {
    method: "POST",
    path: "/api/v1/agent-containers/:sid/resume",
    handler: session("agent.container.resume", (c) => {
      c.svc.containers.resume(c.params["sid"] as string, by(c));
      return json(200, view(c, c.params["sid"] as string));
    }),
  },
  {
    method: "POST",
    path: "/api/v1/agent-containers/:sid/stop",
    handler: session("agent.container.stop", async (c) => {
      const body = await readJsonBody(c.req);
      c.svc.containers.stop(
        c.params["sid"] as string,
        by(c),
        str(body, "reason", { optional: true }),
      );
      return json(202, view(c, c.params["sid"] as string));
    }),
  },
  {
    method: "POST",
    path: "/api/v1/agent-containers/:sid/input",
    handler: session("agent.container.input", async (c) => {
      const body = await readJsonBody(c.req);
      const text = str(body, "text", { optional: true });
      const keys = strings(body["keys"], "keys", 64);
      // Text is submitted with Enter unless `enter: false`.
      const enter = body["enter"] !== false && text !== undefined && text.length > 0;
      return json(
        200,
        c.svc.containers.input(c.params["sid"] as string, by(c), {
          ...(text ? { text } : {}),
          keys: enter ? [...keys, "Enter"] : keys,
        }),
      );
    }),
  },
  {
    method: "GET",
    path: "/api/v1/agent-containers/:sid/screen",
    handler: session("agent.container.screen", (c) =>
      json(
        200,
        c.svc.containers.screen(c.params["sid"] as string, {
          ansi: c.url.searchParams.get("ansi") === "1",
        }),
      ),
    ),
  },
  {
    method: "GET",
    path: "/api/v1/agent-containers/:sid/egress",
    handler: session("agent.container.egress", (c) => {
      const sid = c.params["sid"] as string;
      c.svc.containers.require(sid);
      const outcome = c.url.searchParams.get("outcome");
      if (outcome !== null && !["allowed", "denied", "error"].includes(outcome))
        throw new HttpError(400, "invalid_request", "`outcome` is allowed, denied or error");
      const limit = Math.min(
        Math.max(Number(c.url.searchParams.get("limit") ?? 200) || 200, 1),
        5000,
      );
      return json(200, {
        records: c.svc.containers.egress(sid, {
          limit,
          ...(outcome ? { outcome: outcome as "allowed" | "denied" | "error" } : {}),
        }),
        summary: c.svc.containers.egressSummary(sid),
      });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/jobs/:id/attempts/:attemptId/egress",
    handler: session("job.egress", (c) => {
      const a = c.svc.jobs.requireAttempt(
        c.params["id"] as string,
        c.params["attemptId"] as string,
      );
      return json(200, {
        records: c.svc.containers.egress(a.attempt_id, { limit: 1000 }),
        summary: c.svc.containers.egressSummary(a.attempt_id),
      });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/agent-containers/config",
    handler: session("agent.container.config.read", (c) => {
      const pid = c.params["id"] as string;
      c.svc.registry.require(pid);
      return json(200, c.svc.containers.config(pid));
    }),
  },
  {
    method: "PUT",
    path: "/api/v1/projects/:id/agent-containers/config",
    handler: session("agent.container.config.set", async (c) => {
      const pid = c.params["id"] as string;
      const body = await readJsonBody(c.req);
      return json(200, c.svc.containers.setConfig(pid, body, by(c)));
    }),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/agent-containers/allow",
    handler: session("agent.container.allow", async (c) => {
      const pid = c.params["id"] as string;
      const body = await readJsonBody(c.req);
      const hosts = strings(body["hosts"], "hosts", 64);
      if (!hosts.length) throw new HttpError(400, "invalid_request", "give `hosts` to allow");
      const list = body["list"] ?? "egress";
      if (list !== "egress" && list !== "environment")
        throw new HttpError(
          400,
          "invalid_request",
          "`list` is egress (the agents' allowlist) or environment (environment builds')",
        );
      return json(200, c.svc.containers.allowHosts(pid, hosts, by(c), list));
    }),
  },
];
