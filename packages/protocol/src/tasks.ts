/**
 * Research tasks (spec §2.3, §7.9; ADR 0039).
 *
 * The coordinator owns each task under `~/.ablationkit/state/<project>/tasks/<task>.json`. A task is
 * a record an agent creates to group its work: a goal, optional criteria, the jobs and research
 * records it links, and, when the agent completes it, an outcome with a report. AblationKit does not
 * start, drive or watch the agent; the user's harness owns the session.
 */
import { type Static, Type } from "@sinclair/typebox";
import { ProjectId, TaskId, Timestamp } from "./common.ts";
import { ResearchActor } from "./research.ts";

const Text = (maxLength: number, description?: string) =>
  Type.String({ maxLength, ...(description ? { description } : {}) });

export const TaskStatus = Type.Union(
  [Type.Literal("open"), Type.Literal("completed"), Type.Literal("abandoned")],
  {
    title: "TaskStatus",
    description:
      "`open` while the agent works on it; `completed` with an outcome and a notebook of the vault (or a report record); `abandoned` by the agent or the researcher, with a reason.",
  },
);
export type TaskStatus = Static<typeof TaskStatus>;

export const TaskOutcome = Type.Union(
  [Type.Literal("supported"), Type.Literal("not_supported"), Type.Literal("inconclusive")],
  {
    title: "TaskOutcome",
    description:
      "The research outcome a completed task reports. `supported` and `not_supported` need a notebook with a note that cites runs, or a report that cites evidence.",
  },
);
export type TaskOutcome = Static<typeof TaskOutcome>;

export const ResearchTask = Type.Object(
  {
    schema_version: Type.Literal(2),
    task_id: TaskId,
    project_id: ProjectId,
    revision: Type.Integer({ minimum: 1 }),
    created_by: ResearchActor,
    created_at: Timestamp,
    updated_at: Timestamp,
    title: Text(300),
    goal: Text(20000),
    criteria: Type.Array(Text(2000), {
      maxItems: 50,
      description: "What would settle the goal, as the agent wrote it. Optional.",
    }),
    status: TaskStatus,
    outcome: Type.Optional(TaskOutcome),
    report_id: Type.Optional(Text(128, "The report record a completed task points at.")),
    notebook_id: Type.Optional(
      Text(
        96,
        "The vault notebook a completed task points at (ADR 0049): what the task established, as the notes it wrote, compiled.",
      ),
    ),
    conclusion: Type.Optional(
      Text(
        20000,
        "The answer to the goal in a few sentences, as the agent wrote it when it completed the task: what was found and what it means. Markdown with LaTeX.",
      ),
    ),
    agenda_item: Type.Optional(
      Type.String({
        pattern: "^(note:[a-z0-9][a-z0-9-]{0,95}|L[0-9]{1,6})$",
        description:
          "The item of the researcher's agenda this task serves (ADR 0058): `note:<id>` or `L<n>`.",
      }),
    ),
    closed_at: Type.Optional(Timestamp),
    closed_by: Type.Optional(ResearchActor),
    reason: Type.Optional(Text(2000, "Why the task was abandoned.")),
  },
  {
    title: "ResearchTask",
    description:
      "A research task (ADR 0039): a record an agent creates to group its work. Jobs carry its `task_id` and research records link it (`task:ID`); the coordinator derives both when the task is read.",
    additionalProperties: false,
  },
);
export type ResearchTask = Static<typeof ResearchTask>;

const OLD_CLOSED: Readonly<Record<string, TaskStatus>> = {
  completed: "completed",
  failed: "abandoned",
  canceled: "abandoned",
};

/**
 * A task written before ADR 0039 (schema version 1): a draft, dispatch outbox, T3 bindings, plan,
 * context package, sources and autonomy mode. Completed stays completed with its outcome and
 * report; failed and canceled become abandoned; every other state becomes open. Instructions,
 * constraints, the evaluation plan, sources and the session fields are dropped.
 */
export function upgradeTaskV1(doc: Record<string, unknown>): Record<string, unknown> {
  if (doc["schema_version"] !== 1) return doc;
  const status = OLD_CLOSED[doc["status"] as string] ?? "open";
  const completion = doc["completion"] as Record<string, unknown> | undefined;
  const history = (doc["history"] as { to_status?: string; at?: string; by?: unknown }[]) ?? [];
  const last = [...history].reverse().find((h) => h.to_status === doc["status"]);
  const actor = (a: unknown) => {
    if (!a || typeof a !== "object") return undefined;
    const { task_id: _t, ...rest } = a as Record<string, unknown>;
    return rest;
  };
  const criteria = ((doc["acceptance_criteria"] as { text?: unknown }[] | undefined) ?? [])
    .map((c) => c?.text)
    .filter((t): t is string => typeof t === "string");
  const outcome = completion?.["outcome"] ?? doc["scientific_status"];
  const reportId = completion?.["report_id"] ?? doc["result_report_id"];
  const closedAt = (completion?.["at"] as string | undefined) ?? last?.at;
  const closedBy = actor(completion?.["by"] ?? last?.by);
  return {
    schema_version: 2,
    task_id: doc["task_id"],
    project_id: doc["project_id"],
    revision: doc["revision"],
    created_by: actor(doc["created_by"]),
    created_at: doc["created_at"],
    updated_at: doc["updated_at"],
    title: doc["title"],
    goal: doc["objective"],
    criteria,
    status,
    ...(status === "completed" && typeof outcome === "string" && outcome !== "not_evaluated"
      ? { outcome }
      : {}),
    ...(status === "completed" && typeof reportId === "string" ? { report_id: reportId } : {}),
    ...(status !== "open" && closedAt ? { closed_at: closedAt } : {}),
    ...(status !== "open" && closedBy ? { closed_by: closedBy } : {}),
    ...(status === "abandoned" && typeof doc["status_reason"] === "string"
      ? { reason: doc["status_reason"] }
      : {}),
  };
}
