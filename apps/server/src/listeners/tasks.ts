/**
 * Research task routes (ADR 0039).
 *
 * Agents create tasks for their token's project, read them, and complete or abandon them. The
 * researcher reads them and may abandon one. Nothing here starts, drives or watches an agent.
 */
import type { ResearchActor, TaskOutcome } from "@ablationkit/protocol";
import { HttpError, json, readJsonBody } from "../http.ts";
import type { Method } from "../router.ts";
import type { Services } from "../services.ts";

export interface TaskCall {
  readonly req: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly svc: Services;
  readonly actor: ResearchActor;
  readonly listener: "human" | "agent";
}

export interface TaskOp {
  readonly method: Method;
  readonly path: string;
  readonly action: string;
  /** On the agent listener too. */
  readonly agent: boolean;
  /** On the agent listener only: an agent's own operation, not the researcher's. */
  readonly agentOnly?: true;
  readonly run: (c: TaskCall) => Response | Promise<Response>;
}

type Body = Record<string, unknown>;

function str(b: Body, k: string, required = false): string | undefined {
  const v = b[k];
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, "invalid_request", `\`${k}\` is required`);
    return undefined;
  }
  if (typeof v !== "string")
    throw new HttpError(400, "invalid_request", `\`${k}\` must be a string`);
  return v;
}

function strs(b: Body, k: string): string[] | undefined {
  const v = b[k];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw new HttpError(400, "invalid_request", `\`${k}\` must be an array of strings`);
  return v as string[];
}

const OUTCOMES: readonly TaskOutcome[] = ["supported", "not_supported", "inconclusive"];

const pid = (c: TaskCall) => {
  const id = c.params["id"] as string;
  c.svc.registry.require(id);
  return id;
};
const tid = (c: TaskCall) => c.params["tid"] as string;

export const TASK_OPS: readonly TaskOp[] = [
  {
    method: "GET",
    path: "/api/v1/projects/:id/tasks",
    action: "task.list",
    agent: true,
    run: (c) => {
      const status = c.url.searchParams.get("status") ?? undefined;
      const tasks = c.svc.tasks.list(pid(c), status ? { status } : {});
      return json(200, { tasks, total: tasks.length });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/tasks",
    action: "task.create",
    agent: true,
    agentOnly: true,
    run: async (c) => {
      const b = await readJsonBody(c.req);
      const title = str(b, "title");
      const criteria = strs(b, "criteria");
      const agendaItem = str(b, "agenda_item");
      const task = c.svc.tasks.create(
        pid(c),
        {
          goal: str(b, "goal", true) as string,
          ...(title !== undefined ? { title } : {}),
          ...(criteria ? { criteria } : {}),
          ...(agendaItem ? { agenda_item: agendaItem } : {}),
        },
        c.actor,
      );
      return json(201, { task });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/tasks/:tid",
    action: "task.read",
    agent: true,
    run: (c) => {
      const p = pid(c);
      const task = c.svc.tasks.require(p, tid(c));
      const st = c.svc.reviews.ofTask(task);
      return json(200, {
        task,
        ...c.svc.tasks.work(p, tid(c)),
        review: {
          state: st.review,
          ...(st.mark ? { reviewed_at: st.mark.reviewed_at } : {}),
          ...(st.mark?.note ? { note: st.mark.note } : {}),
        },
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/tasks/:tid/complete",
    action: "task.complete",
    agent: true,
    agentOnly: true,
    run: async (c) => {
      const b = await readJsonBody(c.req);
      const outcome = str(b, "outcome", true) as TaskOutcome;
      if (!OUTCOMES.includes(outcome))
        throw new HttpError(
          400,
          "invalid_request",
          `\`outcome\` must be one of ${OUTCOMES.join(", ")}`,
        );
      const task = c.svc.tasks.complete(
        pid(c),
        tid(c),
        {
          outcome,
          ...(str(b, "report_id") ? { report_id: str(b, "report_id") as string } : {}),
          ...(str(b, "notebook_id") ? { notebook_id: str(b, "notebook_id") as string } : {}),
          ...(str(b, "conclusion") ? { conclusion: str(b, "conclusion") as string } : {}),
        },
        c.actor,
      );
      return json(200, { task, checks: c.svc.tasks.work(pid(c), tid(c)).checks });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/tasks/:tid/abandon",
    action: "task.abandon",
    agent: true,
    run: async (c) => {
      const b = await readJsonBody(c.req);
      return json(200, { task: c.svc.tasks.abandon(pid(c), tid(c), c.actor, str(b, "reason")) });
    },
  },
];
