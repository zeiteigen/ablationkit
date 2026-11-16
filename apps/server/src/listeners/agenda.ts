/**
 * Agenda routes (ADR 0058). The researcher reads and writes the agenda on the human
 * listener; agents only read it, on the agent listener, where reading marks the session as having
 * read the current revision. There is no route by which an agent token changes it.
 */
import { HttpError, json, readJsonBody } from "../http.ts";
import type { ResearchOp } from "./research.ts";

const pid = (c: { params: Readonly<Record<string, string>> }) => c.params["id"] as string;

export const AGENDA_OPS: readonly ResearchOp[] = [
  {
    method: "GET",
    path: "/api/v1/projects/:id/agenda",
    action: "agenda.read",
    agent: true,
    run: (c) => {
      if (c.listener === "agent") {
        const raw = c.url.searchParams.get("since");
        const since = raw === null || raw === "" ? undefined : Number(raw);
        if (since !== undefined && !(Number.isSafeInteger(since) && since >= 0))
          throw new HttpError(400, "invalid_request", "`since` is a revision number");
        return json(
          200,
          c.svc.agenda.forAgent(pid(c), c.actor.id as string, {
            ...(since !== undefined ? { since } : {}),
          }),
        );
      }
      return json(200, c.svc.agenda.view(pid(c)));
    },
  },
  {
    method: "PUT",
    path: "/api/v1/projects/:id/agenda",
    action: "agenda.update",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      for (const k of Object.keys(body))
        if (!["items", "rules", "if_revision"].includes(k))
          throw new HttpError(400, "invalid_request", `\`${k}\` is not part of the agenda`);
      const ifRevision = body["if_revision"];
      if (ifRevision !== undefined && !Number.isSafeInteger(ifRevision))
        throw new HttpError(400, "invalid_request", "`if_revision` must be an integer");
      const r = c.svc.agenda.put(
        pid(c),
        { items: body["items"], rules: body["rules"] },
        c.actor,
        ifRevision !== undefined ? { ifRevision: ifRevision as number } : {},
      );
      return json(200, {
        ...c.svc.agenda.view(pid(c)),
        changes: r.changes,
        ...(r.unchanged ? { unchanged: true } : {}),
      });
    },
  },
];
