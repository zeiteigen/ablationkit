/**
 * Deployment gates and the project policy (ADR 0037). Agents may list deployments, *request* one
 * (the project policy decides) and read a summary of the policy. Stopping a deployment, reading
 * revisions and previewing a policy are human-only; saving a revision is in human.ts.
 */
import { HttpError, json, readJsonBody } from "../http.ts";
import type { TaskCall, TaskOp } from "./tasks.ts";

function pid(c: TaskCall): string {
  const id = c.params["id"] as string;
  c.svc.registry.require(id);
  return id;
}

export const DEPLOYMENT_OPS: readonly TaskOp[] = [
  {
    method: "GET",
    path: "/api/v1/projects/:id/deployments",
    action: "deployment.list",
    agent: true,
    run: (c) => {
      const all = c.svc.deployments.list(pid(c));
      return json(200, { deployments: all, total: all.length });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/deployments",
    action: "deployment.request",
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const out = await c.svc.deployments.request(pid(c), body, c.actor);
      const status = out.outcome === "blocked" ? 403 : out.outcome === "started" ? 201 : 503;
      return json(status, out);
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/deployments/:did/stop",
    action: "deployment.stop",
    agent: false,
    run: async (c) =>
      json(200, {
        deployment: await c.svc.deployments.stop(
          c.params["did"] as string,
          pid(c),
          c.actor,
          "stopped by the researcher",
        ),
      }),
  },
];

/** The compute limit with what agents used of it (ADR 0037). */
function computeUsage(c: TaskCall, id: string): Record<string, unknown> {
  const u = c.svc.compute.usage(id);
  return {
    limit_hours: u.limit_hours,
    used_hours: u.used_hours,
    reserved_hours: u.reserved_hours,
    available_hours: u.available_hours,
  };
}

export const POLICY_OPS: readonly TaskOp[] = [
  {
    method: "GET",
    path: "/api/v1/projects/:id/access",
    action: "policy.summary",
    agent: true,
    run: (c) => {
      const id = pid(c);
      return json(200, { ...c.svc.policy.summary(id), compute: computeUsage(c, id) });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/policy",
    action: "policy.read",
    agent: false,
    run: (c) => {
      const id = pid(c);
      return json(200, {
        policy: c.svc.policy.current(id),
        revisions: c.svc.policy.revisions(id),
        compute_usage: computeUsage(c, id),
      });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/policy/revisions/:rev",
    action: "policy.read",
    agent: false,
    run: (c) => {
      const id = pid(c);
      const n = Number(c.params["rev"]);
      const p = Number.isInteger(n) && n >= 0 ? c.svc.policy.revision(id, n) : undefined;
      if (!p)
        throw new HttpError(404, "revision_not_found", `no policy revision ${c.params["rev"]}`);
      return json(200, { policy: p });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/policy/preview",
    action: "policy.preview",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      return json(200, c.svc.policy.preview(pid(c), body["policy"]));
    },
  },
];
