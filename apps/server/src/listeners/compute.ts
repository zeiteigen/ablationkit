/**
 * Compute weights and the agent compute limit (ADR 0037). The researcher sets each target's
 * machine-wide weight and reads every project's agent usage; an agent reads the weights and its own
 * project's usage and limit, so it can plan. Raising a limit is a policy revision (human.ts).
 */

import { ENFORCEMENT_NOTE } from "../agents/compute-limit.ts";
import { json, readJsonBody } from "../http.ts";
import type { Route } from "../router.ts";
import { compact } from "../state/audit.ts";
import type { AgentHandler } from "./agent.ts";
import type { HumanHandler } from "./human.ts";
import type { TaskOp } from "./tasks.ts";

/** A project's agent usage against its limit: both listeners (the agent's own project only). */
export const COMPUTE_OPS: readonly TaskOp[] = [
  {
    method: "GET",
    path: "/api/v1/projects/:id/compute",
    action: "compute.usage",
    agent: true,
    run: (c) =>
      json(200, { ...c.svc.compute.usage(c.params["id"] as string), note: ENFORCEMENT_NOTE }),
  },
];

export const COMPUTE_ROUTES: readonly Route<HumanHandler>[] = [
  {
    method: "GET",
    path: "/api/v1/compute",
    handler: {
      auth: "session",
      action: "compute.usage",
      run: (c) =>
        json(200, {
          ...c.svc.compute.weights(),
          projects: c.svc.compute.allUsage(),
          note: ENFORCEMENT_NOTE,
        }),
    },
  },
  {
    method: "GET",
    path: "/api/v1/compute/weights",
    handler: {
      auth: "session",
      action: "compute.weights.read",
      run: (c) => json(200, c.svc.compute.weights()),
    },
  },
  {
    method: "PUT",
    path: "/api/v1/compute/weights",
    handler: {
      auth: "session",
      action: "compute.weights.set",
      run: async (c) => {
        const body = await readJsonBody(c.req);
        const out = c.svc.compute.setWeights(body["weights"], `human:${c.session.token_id}`);
        c.svc.audit.record(
          compact({
            actor: { kind: "human" as const, id: c.session.token_id },
            listener: "human" as const,
            action: "compute.weights.set",
            outcome: "allowed" as const,
            details: out.changes.length ? { changes: out.changes } : undefined,
          }),
        );
        return json(200, { ...c.svc.compute.weights(), changes: out.changes });
      },
    },
  },
];

export const AGENT_COMPUTE_ROUTES: readonly Route<AgentHandler>[] = [
  {
    method: "GET",
    path: "/api/v1/compute/weights",
    handler: {
      auth: "agent",
      action: "compute.weights.read",
      run: (c) => json(200, c.svc.compute.weights()),
    },
  },
];
