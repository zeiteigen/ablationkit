/**
 * Direction routes (ADR 0057). The researcher writes, closes, reopens and withdraws directions on
 * the human listener; agents read them, take the ones not yet shown to their session (`deliver`)
 * and respond. An agent token that tries to write one gets 403 `researcher_only`, audited: what an
 * agent is shown as the researcher's words is never something an agent wrote.
 */
import { HttpError, json, readJsonBody } from "../http.ts";
import type { ResearchCall, ResearchOp } from "./research.ts";

export interface DirectionOp extends ResearchOp {
  /** On the agent listener only. */
  readonly agentOnly?: true;
}

const pid = (c: ResearchCall) => {
  const id = c.params["id"] as string;
  c.svc.registry.require(id);
  return id;
};
const did = (c: ResearchCall) => c.params["did"] as string;

const listBody = (c: ResearchCall) => {
  const p = pid(c);
  const q = c.url.searchParams;
  const directions = c.svc.directions.list(p, {
    ...(q.get("status") ? { status: q.get("status") as string } : {}),
    ...(q.get("target") ? { target: q.get("target") as string } : {}),
    ...(q.get("waiting") ? { waiting: q.get("waiting") as string } : {}),
  });
  const { sessions, live } = c.svc.directions.sessions(p);
  return {
    directions,
    total: directions.length,
    sessions,
    live_sessions: live,
    counts: {
      waiting_on_agent: directions.filter((d) => d.waiting_on === "agent").length,
      waiting_on_researcher: directions.filter((d) => d.waiting_on === "researcher").length,
      rules: directions.filter((d) => d.kind === "rule" && d.status !== "withdrawn").length,
    },
  };
};

const settle =
  (act: "close" | "reopen" | "withdraw") =>
  async (c: ResearchCall): Promise<Response> => {
    const body = await readJsonBody(c.req);
    return json(200, {
      direction: c.svc.directions.settle(pid(c), did(c), act, body["text"], c.actor),
    });
  };

export const DIRECTION_OPS: readonly DirectionOp[] = [
  {
    method: "GET",
    path: "/api/v1/projects/:id/directions",
    action: "direction.list",
    agent: true,
    run: (c) => json(200, listBody(c)),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/directions",
    action: "direction.create",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      return json(201, {
        direction: c.svc.directions.create(
          pid(c),
          { target: body["target"], kind: body["kind"], text: body["text"] },
          c.actor,
        ),
      });
    },
  },
  {
    // The agent listener's answer to an attempt to write one: refused and audited.
    method: "POST",
    path: "/api/v1/projects/:id/directions",
    action: "direction.create",
    agent: true,
    agentOnly: true,
    run: (c) => {
      c.svc.audit.record({
        actor: c.actor,
        listener: "agent",
        action: "direction.create",
        outcome: "denied",
        project_id: pid(c),
        reason: "directions are the researcher's to write",
      });
      throw new HttpError(
        403,
        "researcher_only",
        "directions are the researcher's to write, in the web UI; respond to one with ablationkit_do direction.respond",
      );
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/directions/deliver",
    action: "direction.deliver",
    agent: true,
    agentOnly: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const all = body["all"] === true;
      const directions = c.svc.directions.deliver(pid(c), c.actor.id as string, { all });
      return json(200, { directions, total: directions.length });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/directions/:did/respond",
    action: "direction.respond",
    agent: true,
    agentOnly: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      return json(200, {
        direction: c.svc.directions.respond(
          pid(c),
          did(c),
          { kind: body["kind"], text: body["text"], refs: body["refs"] },
          c.actor,
        ),
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/directions/:did/close",
    action: "direction.close",
    agent: false,
    run: settle("close"),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/directions/:did/reopen",
    action: "direction.reopen",
    agent: false,
    run: settle("reopen"),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/directions/:did/withdraw",
    action: "direction.withdraw",
    agent: false,
    run: settle("withdraw"),
  },
];
