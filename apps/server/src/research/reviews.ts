/**
 * The researcher's review of a project's research (ADR 0048): which records and tasks they have
 * read, and the reading list built from them.
 *
 *   state/<project>/research/reviews.json   ReviewState
 *
 * A mark stores a hash of what was read, so a record whose text, status or evidence changed later
 * shows as changed, while a new link or tag does not. A mark records reading: it approves nothing
 * and no gate reads it. Agents can read the marks and the researcher's notes; only the researcher
 * writes them.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type ResearchActor,
  type ResearchRecord,
  type ResearchTask,
  type ReviewMark,
  type ReviewState,
  validateReviewState,
} from "@ablationkit/protocol";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";

export type ReviewStatus = "new" | "changed" | "reviewed";

export interface ReviewItem {
  readonly kind: string;
  readonly id: string;
  readonly title: string;
  readonly status?: string;
  /** The short description, cut to a few lines. */
  readonly summary?: string;
  readonly updated_at: string;
  readonly by: string;
  readonly review: ReviewStatus;
  readonly reviewed_at?: string;
  readonly note?: string;
  /** Missing descriptions: `summary`, `body`. */
  readonly gaps: string[];
}

export interface ReviewThread {
  /** The task the items were recorded under; absent for records outside any task. */
  readonly task?: ReviewItem & { goal: string; outcome?: string; conclusion?: string };
  readonly items: ReviewItem[];
}

/** Reading order inside a thread: the conclusion first, then what it rests on. */
const ORDER = ["report", "hypothesis", "study", "decision", "approach", "note"];
/** Kinds whose in-depth read is expected, not optional. */
const NEEDS_BODY = new Set(["report", "note", "decision", "approach", "hypothesis"]);

function digest(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** What a reader reads of a record. Links, tags and bookkeeping are left out on purpose. */
function recordDigest(r: ResearchRecord): string {
  return digest([
    r.title,
    r.status,
    r.summary,
    r.body,
    r.follow_up,
    r.protocol,
    r.baseline_variant,
    r.variants,
    r.metric_goals,
    (r.evidence ?? []).map((e) => [e.ref.kind, e.ref.id, e.role, e.values, e.note]),
  ]);
}

function taskDigest(t: ResearchTask): string {
  return digest([
    t.title,
    t.goal,
    t.criteria,
    t.status,
    t.outcome,
    t.report_id,
    t.conclusion,
    // Appended only when set, so tasks completed with a report keep the digest they were read at.
    ...(t.notebook_id ? [t.notebook_id] : []),
  ]);
}

const clip = (s: string | undefined, n = 600) =>
  s && s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;

export class ReviewService {
  private readonly states = new Map<string, ReviewState>();

  constructor(private readonly svc: () => Services) {}

  private path(pid: string): string {
    return join(this.svc().paths.stateDir, pid, "research", "reviews.json");
  }

  forgetProject(pid: string): void {
    this.states.delete(pid);
  }

  private state(pid: string): ReviewState {
    let s = this.states.get(pid);
    if (!s) {
      const p = this.path(pid);
      try {
        s = existsSync(p) ? readJson(p, validateReviewState) : undefined;
      } catch {
        // An unreadable file loses marks, never research: start over rather than fail every read.
        s = undefined;
      }
      s ??= { schema_version: 1, project_id: pid, items: {} };
      this.states.set(pid, s);
    }
    return s;
  }

  private save(s: ReviewState): void {
    const p = this.path(s.project_id);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeJsonAtomic(p, s, { validate: validateReviewState });
    this.states.set(s.project_id, s);
  }

  private target(pid: string, kind: string, id: string): { digest: string } {
    const svc = this.svc();
    if (kind === "task") return { digest: taskDigest(svc.tasks.require(pid, id)) };
    const r = svc.research.require(pid, id);
    if (r.kind !== kind)
      throw new HttpError(404, "not_found", `${id} is a ${r.kind}, not a ${kind}`);
    return { digest: recordDigest(r) };
  }

  /** The mark on one item and whether it still matches what the item says now. */
  status(
    pid: string,
    kind: string,
    id: string,
    now: string,
  ): { review: ReviewStatus; mark?: ReviewMark } {
    const mark = this.state(pid).items[`${kind}:${id}`];
    if (!mark) return { review: "new" };
    return { review: mark.digest === now ? "reviewed" : "changed", mark };
  }

  ofRecord(r: ResearchRecord) {
    return this.status(r.project_id, r.kind, r.record_id, recordDigest(r));
  }

  ofTask(t: ResearchTask) {
    return this.status(t.project_id, "task", t.task_id, taskDigest(t));
  }

  mark(
    pid: string,
    kind: string,
    id: string,
    input: { reviewed: boolean; note?: string },
    actor: ResearchActor,
  ): { review: ReviewStatus; mark?: ReviewMark } {
    const svc = this.svc();
    svc.registry.require(pid);
    const t = this.target(pid, kind, id);
    const s = this.state(pid);
    const key = `${kind}:${id}`;
    const items = { ...s.items };
    if (input.reviewed) {
      const note = input.note?.trim();
      if (note && note.length > 4000)
        throw new HttpError(400, "invalid_request", "`note` is longer than 4000 characters");
      items[key] = compact({
        digest: t.digest,
        reviewed_at: svc.now().toISOString(),
        by: actor,
        note: note || undefined,
      }) as ReviewMark;
    } else delete items[key];
    this.save({ ...s, items });
    svc.events.publish(pid, "review.updated", { kind, id, reviewed: input.reviewed });
    svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: "human",
      action: "review.mark",
      outcome: "allowed",
      project_id: pid,
      target: key,
      details: { reviewed: input.reviewed, note: Boolean(input.note?.trim()) },
    });
    return this.status(pid, kind, id, t.digest);
  }

  private recordItem(r: ResearchRecord): ReviewItem {
    const st = this.ofRecord(r);
    const gaps: string[] = [];
    if (!r.summary?.trim()) gaps.push("summary");
    if (NEEDS_BODY.has(r.kind) && !r.body?.trim() && !r.generated) gaps.push("body");
    return compact({
      kind: r.kind,
      id: r.record_id,
      title: r.title,
      status: r.status,
      summary: clip(r.summary ?? (r.kind === "note" ? r.body : undefined)),
      updated_at: r.updated_at,
      by: r.updated_by.kind,
      review: st.review,
      reviewed_at: st.mark?.reviewed_at,
      note: st.mark?.note,
      gaps,
    }) as ReviewItem;
  }

  private taskItem(t: ResearchTask): NonNullable<ReviewThread["task"]> {
    const st = this.ofTask(t);
    return compact({
      kind: "task",
      id: t.task_id,
      title: t.title,
      status: t.status,
      outcome: t.outcome,
      goal: t.goal,
      conclusion: t.conclusion,
      summary: clip(t.conclusion ?? t.goal),
      updated_at: t.updated_at,
      by: t.created_by.kind,
      review: st.review,
      reviewed_at: st.mark?.reviewed_at,
      note: st.mark?.note,
      gaps: t.status === "completed" && !t.conclusion?.trim() ? ["summary"] : [],
    }) as NonNullable<ReviewThread["task"]>;
  }

  /**
   * The reading list: one thread per task, newest first, then the records outside any task. In a
   * thread the task comes first (the question and its answer), then reports, hypotheses, studies,
   * decisions, approaches and notes. `queue` is the same order with only what is left to read.
   */
  list(pid: string): {
    threads: ReviewThread[];
    counts: { total: number; reviewed: number; new: number; changed: number; gaps: number };
    queue: { kind: string; id: string }[];
  } {
    const svc = this.svc();
    svc.registry.require(pid);
    const tasks = svc.tasks.list(pid);
    const taskIds = new Set(tasks.map((t) => t.task_id));
    const byTask = new Map<string, ResearchRecord[]>();
    const loose: ResearchRecord[] = [];
    for (const r of svc.research.all(pid)) {
      if (r.archived_at || r.kind === "conversation") continue;
      const tid = r.links.find((l) => l.kind === "task" && taskIds.has(l.id))?.id;
      if (tid) byTask.set(tid, [...(byTask.get(tid) ?? []), r]);
      else loose.push(r);
    }
    // Among reports: the task's own report, then other written ones, then generated tables.
    const rank = (r: ResearchRecord, reportId?: string) =>
      r.kind !== "report" ? 0 : r.record_id === reportId ? 0 : r.generated ? 2 : 1;
    const ordered = (rs: ResearchRecord[], reportId?: string) =>
      [...rs]
        .sort(
          (a, b) =>
            ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) ||
            rank(a, reportId) - rank(b, reportId) ||
            a.created_at.localeCompare(b.created_at) ||
            a.record_id.localeCompare(b.record_id),
        )
        .map((r) => this.recordItem(r));
    const threads: ReviewThread[] = tasks.map((t) => ({
      task: this.taskItem(t),
      items: ordered(byTask.get(t.task_id) ?? [], t.report_id),
    }));
    if (loose.length) threads.push({ items: ordered(loose) });
    const all = threads.flatMap((t) => [...(t.task ? [t.task] : []), ...t.items]);
    const count = (s: ReviewStatus) => all.filter((i) => i.review === s).length;
    return {
      threads,
      counts: {
        total: all.length,
        reviewed: count("reviewed"),
        new: count("new"),
        changed: count("changed"),
        gaps: all.filter((i) => i.gaps.length).length,
      },
      queue: all.filter((i) => i.review !== "reviewed").map((i) => ({ kind: i.kind, id: i.id })),
    };
  }
}
