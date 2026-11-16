/**
 * The agenda's pure logic (ADR 0058): how an agent names an item, how an item reads in
 * one line, what changed between two revisions, and the checks on the work agents record against
 * it. Shared by the coordinator and the web UI.
 *
 * Everything here advises. Which item a job or task serves is the agent's own declaration, so no
 * check below is a control: an agent that names no item is reported as off the agenda, nothing
 * more.
 */
import type { AgendaItem, AgendaLane, AgendaRule } from "@ablationkit/protocol";

export const AGENDA_LANES: readonly AgendaLane[] = ["now", "next", "parked", "dropped"];

export const LANE_LABEL: Readonly<Record<AgendaLane, string>> = {
  now: "Now",
  next: "Next",
  parked: "Parked",
  dropped: "Dropped",
};

/** What an agenda item is named by in `agenda_item`: `note:<id>` or `L<n>`. */
export const AGENDA_ITEM_ID = /^(note:[a-z0-9][a-z0-9-]{0,95}|L[0-9]{1,6})$/;

/** The parts of an agenda that a revision changes. */
export interface AgendaBody {
  readonly items: readonly AgendaItem[];
  readonly rules: readonly AgendaRule[];
}

/** What a note-item reads as: its title, type and standing, when the vault has it. */
export type NoteTitles = (
  noteId: string,
) => { title: string; type?: string; standing?: string } | undefined;

/** The items of one lane, in priority order. */
export function laneItems(items: readonly AgendaItem[], lane: AgendaLane): AgendaItem[] {
  return items.filter((i) => i.lane === lane);
}

/**
 * The item an agent names: `note:<id>`, a bare note ID, or `L3` (any case). Undefined when the
 * agenda has no such item.
 */
export function findItem(items: readonly AgendaItem[], ref: string): AgendaItem | undefined {
  const r = ref.trim();
  const id = /^l[0-9]+$/i.test(r) ? r.toUpperCase() : r.startsWith("note:") ? r : `note:${r}`;
  return items.find((i) => i.item_id === id);
}

/** An item in one line: `note:wd-sweep: Does weight decay matter? [question, open]`, `L2: text`. */
export function itemLine(item: AgendaItem, titles: NoteTitles): string {
  if (item.note_id) {
    const n = titles(item.note_id);
    const kind = n?.type ? ` [${n.type}${n.standing ? `, ${n.standing}` : ""}]` : "";
    return `${item.item_id}: ${n?.title ?? "(a note no longer in the vault)"}${kind}`;
  }
  return `${item.item_id}: ${item.text ?? ""}`;
}

/** What an item says, without its ID: the note's title or the line's text. */
export function itemTitle(item: AgendaItem, titles: NoteTitles): string {
  return item.note_id ? (titles(item.note_id)?.title ?? item.note_id) : (item.text ?? item.item_id);
}

const quoted = (item: AgendaItem, titles: NoteTitles) =>
  `${item.item_id} "${itemTitle(item, titles)}"`;
const because = (item: AgendaItem) =>
  item.reason ? ` (the researcher's reason: ${item.reason})` : "";

/**
 * What changed from one revision to the next, as sentences an agent reads: items added, moved
 * between lanes, reworded or removed, the new order of Now and Next, and rules added, withdrawn
 * or reworded. `before` undefined: everything is new.
 */
export function agendaDiff(
  before: AgendaBody | undefined,
  after: AgendaBody,
  titles: NoteTitles,
): string[] {
  const out: string[] = [];
  const was = new Map((before?.items ?? []).map((i) => [i.item_id, i]));
  const now = new Map(after.items.map((i) => [i.item_id, i]));
  for (const i of after.items) {
    const b = was.get(i.item_id);
    const label = LANE_LABEL[i.lane];
    if (!b) {
      out.push(
        i.lane === "dropped" || i.lane === "parked"
          ? `${label}: ${quoted(i, titles)}${because(i)}`
          : `Added to ${label}: ${quoted(i, titles)}`,
      );
      continue;
    }
    if (b.lane !== i.lane)
      out.push(
        i.lane === "dropped" || i.lane === "parked"
          ? `${label} (was ${LANE_LABEL[b.lane]}): ${quoted(i, titles)}${because(i)}`
          : `Moved from ${LANE_LABEL[b.lane]} to ${label}: ${quoted(i, titles)}`,
      );
    else if ((b.reason ?? "") !== (i.reason ?? "") && i.reason)
      out.push(`${label}, with a reason now: ${quoted(i, titles)}${because(i)}`);
    if (!i.note_id && b.text !== i.text)
      out.push(`Reworded: ${i.item_id} "${b.text}" → "${i.text}"`);
  }
  for (const b of before?.items ?? [])
    if (!now.has(b.item_id))
      out.push(`Removed from the agenda (was ${LANE_LABEL[b.lane]}): ${quoted(b, titles)}`);
  // Now's order is what agents work through: say it whenever it changed. Next only when items
  // already there changed places.
  const ids = (list: readonly AgendaItem[], lane: AgendaLane) =>
    laneItems(list, lane).map((i) => i.item_id);
  const nowAfter = laneItems(after.items, "now");
  if (
    nowAfter.length > 1 &&
    ids(before?.items ?? [], "now").join() !== ids(after.items, "now").join()
  )
    out.push(
      `Now, in order: ${nowAfter.map((i, n) => `${n + 1}. ${quoted(i, titles)}`).join("; ")}`,
    );
  const keptNext = (list: readonly AgendaItem[], other: Map<string, AgendaItem>) =>
    laneItems(list, "next")
      .filter((i) => other.get(i.item_id)?.lane === "next")
      .map((i) => i.item_id);
  if (keptNext(before?.items ?? [], now).join() !== keptNext(after.items, was).join())
    out.push(
      `Next is in a new order: ${laneItems(after.items, "next")
        .map((i, n) => `${n + 1}. ${quoted(i, titles)}`)
        .join("; ")}`,
    );
  const rulesWas = new Map((before?.rules ?? []).map((r) => [r.rule_id, r]));
  const rulesNow = new Set(after.rules.map((r) => r.rule_id));
  for (const r of after.rules) {
    const b = rulesWas.get(r.rule_id);
    if (!b) out.push(`New rule ${r.rule_id}: "${r.text}"`);
    else if (b.text !== r.text)
      out.push(`Rule ${r.rule_id} reworded: "${r.text}" (was "${b.text}")`);
  }
  for (const b of before?.rules ?? [])
    if (!rulesNow.has(b.rule_id)) out.push(`Rule ${b.rule_id} withdrawn: "${b.text}"`);
  return out;
}

/** A job or task as the checks see it. */
export interface AgendaJob {
  readonly job_id: string;
  readonly agenda_item?: string | undefined;
  readonly task_id?: string | undefined;
  /** The agent session (token ID) that submitted it; undefined for the researcher's jobs. */
  readonly session?: string | undefined;
  readonly created_at: string;
  readonly run_name?: string | undefined;
}

export interface AgendaTask {
  readonly task_id: string;
  readonly agenda_item?: string | undefined;
  readonly status: string;
  readonly session?: string | undefined;
  readonly title: string;
}

export interface AgendaCheck {
  readonly code: "parked_work" | "off_agenda" | "not_on_agenda";
  readonly message: string;
  readonly item?: string;
  readonly job?: string;
  readonly task?: string;
  readonly session?: string;
}

/** The item a job serves: its own `agenda_item`, else its task's. */
export function servedItem(
  job: AgendaJob,
  tasks: ReadonlyMap<string, AgendaTask>,
): string | undefined {
  return job.agenda_item ?? (job.task_id ? tasks.get(job.task_id)?.agenda_item : undefined);
}

/**
 * The checks on agents' work against the agenda (advice; nothing is refused for them):
 *
 * - `parked_work`: an open task, or a job submitted after the item was parked or dropped, names a
 *   Parked or Dropped item.
 * - `not_on_agenda`: an open task names an item the researcher has since removed.
 * - `off_agenda`: an agent session (one of `sessions`, the live ones) has jobs since the agenda
 *   had a Now item and none of them serves a Now item.
 */
export function agendaChecks(
  agenda: AgendaBody,
  work: {
    readonly jobs: readonly AgendaJob[];
    readonly tasks: readonly AgendaTask[];
    readonly sessions: readonly { token_id: string; label?: string | undefined }[];
    /** When the agenda first had a Now item, if it has one now. */
    readonly since?: string | undefined;
  },
  titles: NoteTitles,
): AgendaCheck[] {
  const out: AgendaCheck[] = [];
  const items = new Map(agenda.items.map((i) => [i.item_id, i]));
  const tasks = new Map(work.tasks.map((t) => [t.task_id, t]));
  const off = (i: AgendaItem) => i.lane === "parked" || i.lane === "dropped";
  for (const t of work.tasks) {
    if (t.status !== "open" || !t.agenda_item) continue;
    const i = items.get(t.agenda_item);
    if (!i)
      out.push({
        code: "not_on_agenda",
        item: t.agenda_item,
        task: t.task_id,
        ...(t.session ? { session: t.session } : {}),
        message: `task ${t.task_id} serves ${t.agenda_item}, which the researcher has taken off the agenda: finish what is under way, then complete or abandon the task`,
      });
    else if (off(i))
      out.push({
        code: "parked_work",
        item: i.item_id,
        task: t.task_id,
        ...(t.session ? { session: t.session } : {}),
        message: `task ${t.task_id} serves ${quoted(i, titles)}, which the researcher has ${i.lane}${because(i)}: stop spending on it; complete or abandon the task with what it has`,
      });
  }
  for (const j of work.jobs) {
    const id = servedItem(j, tasks);
    const i = id ? items.get(id) : undefined;
    if (i && off(i) && j.created_at >= i.moved_at)
      out.push({
        code: "parked_work",
        item: i.item_id,
        job: j.job_id,
        ...(j.session ? { session: j.session } : {}),
        message: `job ${j.run_name ?? j.job_id} was submitted for ${quoted(i, titles)} after the researcher ${i.lane === "parked" ? "parked" : "dropped"} it${because(i)}`,
      });
  }
  const nowIds = new Set(laneItems(agenda.items, "now").map((i) => i.item_id));
  if (nowIds.size && work.since) {
    const since = work.since;
    for (const s of work.sessions) {
      const mine = work.jobs.filter((j) => j.session === s.token_id && j.created_at >= since);
      if (!mine.length) continue;
      const served = mine.filter((j) => {
        const id = servedItem(j, tasks);
        return id !== undefined && nowIds.has(id);
      });
      if (!served.length)
        out.push({
          code: "off_agenda",
          session: s.token_id,
          message: `${s.label ?? s.token_id} has run ${mine.length} ${mine.length === 1 ? "job" : "jobs"} and none serves an item in Now: name the Now item each job serves (agenda_item), or say in your edition why this work comes first`,
        });
    }
  }
  return out;
}
