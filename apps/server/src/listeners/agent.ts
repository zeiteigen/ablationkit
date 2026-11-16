/**
 * Agent API (spec §7.11). Bearer tokens bound to one project (ADR 0039).
 *
 * This table is the whole agent surface. It has no policy-edit or extension-activation routes,
 * and must never get any (criterion 56; enforced by test/listeners.test.ts). Research records,
 * report generation and lineage are here, bound to the token's project; deletion is human-only.
 * Agents submit and read jobs and request deployments within the project policy (ADR 0037), read
 * the compute weights and their project's usage against its compute limit, and create, read,
 * complete and abandon research tasks. Jobs and records name their task themselves (`task_id`, a
 * `task:ID` link).
 */
import type { TokenRecord } from "@ablationkit/protocol";
import { HttpError, json, toErrorResponse } from "../http.ts";
import { type Route, Router } from "../router.ts";
import type { Services } from "../services.ts";
import { AGENDA_HEADER } from "../vault/agenda.ts";
import { DIRECTIONS_HEADER } from "../vault/directions.ts";
import { AGENDA_OPS } from "./agenda.ts";
import { BACKEND_MANAGEMENT_OPS, BACKEND_OPS } from "./backends.ts";
import { bearer, checkHost, notFound, requireProject } from "./common.ts";
import { AGENT_COMPUTE_ROUTES, COMPUTE_OPS } from "./compute.ts";
import { DEPLOYMENT_OPS, POLICY_OPS } from "./deployments.ts";
import { DIRECTION_OPS } from "./directions.ts";
import { EXTENSION_OPS } from "./extensions.ts";
import { INFERENCE_OPS } from "./inference.ts";
import { AGENT_JOB_ROUTES } from "./jobs.ts";
import { LIFECYCLE_OPS } from "./lifecycle.ts";
import { RESEARCH_OPS } from "./research.ts";
import { RUN_IMPORT_OPS } from "./run-import.ts";
import { TASK_OPS } from "./tasks.ts";
import { AGENT_TRACKING_OPS, RUN_DESCRIPTION_OPS } from "./tracking.ts";
import { VAULT_OPS } from "./vault.ts";

export interface AgentCall {
  readonly req: Request;
  readonly params: Readonly<Record<string, string>>;
  readonly token: TokenRecord;
  readonly svc: Services;
}

export interface AgentHandler {
  readonly auth: "none" | "agent";
  readonly action: string;
  readonly run: (c: AgentCall) => Response | Promise<Response>;
}

export const AGENT_ROUTES: readonly Route<AgentHandler>[] = [
  {
    method: "GET",
    path: "/api/v1/health",
    handler: {
      auth: "none",
      action: "health.read",
      run: () => json(200, { status: "ok", api: "agent" }),
    },
  },
  {
    method: "GET",
    path: "/api/v1/whoami",
    handler: {
      auth: "agent",
      action: "auth.whoami",
      run: (c) =>
        json(200, {
          kind: "agent",
          token_id: c.token.token_id,
          scope: c.token.scope,
          expires_at: c.token.expires_at,
          ...(c.token.agent_session
            ? {
                session: {
                  harness: c.token.agent_session.harness,
                  label: c.token.agent_session.label,
                  idle_timeout_sec: c.token.agent_session.idle_timeout_sec,
                },
              }
            : {}),
        }),
    },
  },
  {
    // The session's own account (ADR 0056): what the coordinator recorded of it, and what it wrote.
    method: "GET",
    path: "/api/v1/projects/:id/session/account",
    handler: {
      auth: "agent",
      action: "auth.agent_session.account",
      run: async (c) => {
        requireProject(c.svc, c.token, c.params["id"] as string);
        return json(200, await c.svc.witness.account(c.token.token_id));
      },
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id",
    handler: {
      auth: "agent",
      action: "project.read",
      run: (c) => {
        const id = c.params["id"] as string;
        requireProject(c.svc, c.token, id);
        const p = c.svc.registry.require(id);
        // Agents get the ID and name, not the coordinator's local path layout.
        return json(200, { project_id: p.project_id, name: p.name });
      },
    },
  },
  ...[
    ...RESEARCH_OPS,
    ...VAULT_OPS,
    ...AGENDA_OPS,
    ...LIFECYCLE_OPS,
    ...INFERENCE_OPS,
    ...BACKEND_OPS,
    ...BACKEND_MANAGEMENT_OPS,
    ...EXTENSION_OPS,
    ...AGENT_TRACKING_OPS,
    ...RUN_DESCRIPTION_OPS,
    // Research tasks: create, read, complete, abandon. Deployments: list and request (the policy
    // decides); the policy itself: a read-only summary; the project's compute usage against its limit.
    ...TASK_OPS,
    // The researcher's directions (ADR 0057): read them, take the undelivered ones, respond.
    ...DIRECTION_OPS,
    ...DEPLOYMENT_OPS,
    ...POLICY_OPS,
    ...COMPUTE_OPS,
    ...RUN_IMPORT_OPS,
  ]
    .filter((op) => op.agent)
    .map(
      (op): Route<AgentHandler> => ({
        method: op.method,
        path: op.path,
        handler: {
          auth: "agent",
          action: op.action,
          run: (c) => {
            const id = c.params["id"] as string;
            requireProject(c.svc, c.token, id);
            return op.run({
              req: c.req,
              url: new URL(c.req.url),
              params: c.params,
              svc: c.svc,
              actor: { kind: "agent", id: c.token.token_id },
              listener: "agent",
            });
          },
        },
      }),
    ),
  ...AGENT_JOB_ROUTES,
  ...AGENT_COMPUTE_ROUTES,
];

/**
 * While the session has not read the researcher's current agenda (ADR 0058), every response says
 * which revision is waiting; `ablationkit mcp` then reads it and puts the change before the tool's
 * result. Reading the agenda (GET /agenda) marks it read, so the header stops.
 */
function withAgenda(svc: Services, token: TokenRecord, res: Response): Response {
  const pid = token.scope.project_id;
  if (!pid) return res;
  try {
    const rev = svc.agenda.unseen(pid, token.token_id);
    if (rev === undefined) return res;
    try {
      res.headers.set(AGENDA_HEADER, String(rev));
      return res;
    } catch {
      const headers = new Headers(res.headers);
      headers.set(AGENDA_HEADER, String(rev));
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
  } catch {
    // A removed project: the agenda waits for the next response.
    return res;
  }
}

/**
 * The agent API's request handler. On the TCP listener the Host header is checked (port); on an
 * agent container's own socket (ADR 0061) there is no Host to check and only that session's token
 * (`onlyToken`) is accepted.
 */
export function agentFetch(
  svc: Services,
  port: () => number,
  opts: { readonly onlyToken?: string } = {},
): (req: Request) => Promise<Response> {
  const router = new Router(AGENT_ROUTES);
  return async (req) => {
    try {
      if (opts.onlyToken === undefined) checkHost(req, port());
      const url = new URL(req.url);
      const m = router.match(req.method, url.pathname);
      if (m.kind !== "found") throw notFound();
      const h = m.route.handler;
      if (h.auth === "none")
        return await h.run({ req, params: m.params, svc, token: undefined as never });
      const t = bearer(req);
      const verified = t ? svc.tokens.verify(t, "agent") : undefined;
      const token =
        opts.onlyToken === undefined || verified?.token_id === opts.onlyToken
          ? verified
          : undefined;
      if (!token) {
        svc.audit.record({
          actor: { kind: "agent" },
          listener: "agent",
          action: "auth.token_check",
          outcome: "denied",
          target: `${req.method} ${m.route.path}`,
          reason: t ? "invalid, expired or revoked agent token" : "missing agent token",
        });
        throw new HttpError(401, "unauthenticated", "a valid agent token is required");
      }
      svc.tokens.touch(token);
      // A contained session (ADR 0061) does not run project code on this machine outside a
      // container unless the researcher allowed it.
      if (svc.containers.hostCodeRefused(token, h.action)) {
        svc.audit.record({
          actor: { kind: "agent", id: token.token_id },
          listener: "agent",
          action: h.action,
          outcome: "denied",
          project_id: token.scope.project_id,
          target: `${req.method} ${m.route.path}`,
          reason: "contained session: host code refused",
        });
        return withAgenda(
          svc,
          token,
          withDirections(
            svc,
            token,
            toErrorResponse(
              new HttpError(
                403,
                "contained_host_code",
                `${h.action} runs project code on this machine outside the agent container; the project's container settings refuse it for contained sessions (host_code). The researcher can run it from the web UI.`,
              ),
            ),
          ),
        );
      }
      let res: Response;
      try {
        res = await h.run({ req, params: m.params, svc, token });
      } catch (e) {
        res = toErrorResponse(e);
      }
      // Both notices ride on every response, refusals included: the agenda's revision when this
      // session has not read it (ADR 0058) and the directions not yet shown to it (ADR 0057).
      return withAgenda(svc, token, withDirections(svc, token, res));
    } catch (e) {
      return toErrorResponse(e);
    }
  };
}

/**
 * Every response to an agent session says how many of the researcher's directions in force it
 * has not been shown yet (ADR 0057), refusals included: `ablationkit mcp` takes them at this
 * breakpoint and appends them to the tool's result.
 */
function withDirections(svc: Services, token: TokenRecord, res: Response): Response {
  let n = 0;
  try {
    n = svc.directions.pending(token.scope.project_id as string, token.token_id).length;
  } catch {
    return res;
  }
  if (!n) return res;
  try {
    res.headers.set(DIRECTIONS_HEADER, String(n));
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set(DIRECTIONS_HEADER, String(n));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}
