/**
 * Directions (ADR 0057): the researcher steers through the record.
 *
 *   state/<project>/directions/<direction-id>.json   ResearchDirection, one per file
 *
 * The researcher writes a direction where they read (a note, a run, a study, a task, the bottom
 * line, the project) on the human listener only; agent tokens cannot write one. Agents respond:
 * acknowledge (what they will do), answer (with refs to what they changed, each of which must
 * resolve) or decline (with a reason). The researcher closes the thread, reopens it (it is
 * delivered again) or withdraws it. A `rule` stays in force for every session until withdrawn.
 *
 * Delivery is at breakpoints: every agent-listener response carries `x-ablationkit-directions: N`
 * while N directions in force have not been shown to that agent session in their current round,
 * and `ablationkit mcp` then takes them (`deliver`) and appends them to the tool's result.
 * `deliveries` record which session was shown what; the thread records who answered.
 *
 * Checks (`direction_unanswered`) are advice; completing a task with an unanswered direction on
 * the task, its notes or its runs is refused (409): it forces an answer on the record, not
 * compliance, since declining with a reason is an answer.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type DirectionEntry,
  type DirectionKind,
  type DirectionRef,
  type DirectionTarget,
  type ResearchActor,
  type ResearchDirection,
  validateResearchDirection,
} from "@ablationkit/protocol";
import type { VaultCheck } from "@ablationkit/vault";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";

export const DIRECTION_KINDS: readonly DirectionKind[] = [
  "ask",
  "doubt",
  "do",
  "focus",
  "park",
  "rule",
];
const TARGET_KINDS = ["note", "run", "study", "task", "bottom_line", "project"] as const;
const REF_KINDS = ["note", "run", "job", "study", "task", "work"] as const;
const MAX_TEXT = 8000;

/** Header on agent-listener responses: directions not yet shown to this agent session. */
export const DIRECTIONS_HEADER = "x-ablationkit-directions";

/** What each kind asks of the agent, in the words the MCP server shows it. */
export const KIND_ASKS: Record<DirectionKind, string> = {
  ask: "explain or justify this",
  doubt: "the researcher does not believe this: bring more evidence or lower its standing",
  do: "do this next",
  focus: "prioritise this line of work",
  park: "stop spending on this line for now",
  rule: "a standing rule for every session, in force until the researcher withdraws it",
};

/** A direction with what a reader needs beside it. */
export interface DirectionView extends ResearchDirection {
  /** Who it waits for now: an agent, the researcher (answered or declined), or no one. */
  readonly waiting_on: "agent" | "researcher" | "none";
  /** The target's title, when it resolves. */
  readonly target_title?: string;
  /** False when the target no longer resolves (an archived note, a deleted task). */
  readonly target_found: boolean;
}

/** An agent session as the directions page names it. */
export interface DirectionSession {
  readonly harness?: string;
  readonly label?: string;
  readonly live: boolean;
}

function newId(now: Date): string {
  const d = now.toISOString().slice(0, 10).replaceAll("-", "");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let r = "";
  for (const x of randomBytes(6)) r += alphabet[x % alphabet.length];
  return `dir-${d}-${r}`;
}

const inForce = (d: ResearchDirection) =>
  d.kind === "rule"
    ? d.status !== "withdrawn" && d.status !== "closed"
    : d.status === "open" || d.status === "acknowledged";

const waitingOn = (d: ResearchDirection): DirectionView["waiting_on"] =>
  d.kind === "rule"
    ? d.status === "open"
      ? "agent"
      : d.status === "declined"
        ? "researcher"
        : "none"
    : d.status === "open" || d.status === "acknowledged"
      ? "agent"
      : d.status === "answered" || d.status === "declined"
        ? "researcher"
        : "none";

const targetRef = (t: DirectionTarget) => (t.id ? `${t.kind}:${t.id}` : t.kind);

export class DirectionService {
  private readonly projects = new Map<string, Map<string, ResearchDirection>>();

  constructor(private readonly svc: () => Services) {}

  private dir(pid: string): string {
    return join(this.svc().paths.stateDir, pid, "directions");
  }

  forgetProject(pid: string): void {
    this.projects.delete(pid);
  }

  private project(pid: string): Map<string, ResearchDirection> {
    let p = this.projects.get(pid);
    if (p) return p;
    p = new Map();
    const d = this.dir(pid);
    for (const f of existsSync(d) ? readdirSync(d).sort() : []) {
      if (!/^dir-[^.]+\.json$/.test(f)) continue;
      try {
        const x = readJson(join(d, f), validateResearchDirection);
        if (x.project_id === pid && `${x.direction_id}.json` === f) p.set(x.direction_id, x);
      } catch {
        // An unreadable direction is skipped; the rest still reach the agents.
      }
    }
    this.projects.set(pid, p);
    return p;
  }

  private save(d: ResearchDirection): ResearchDirection {
    const f = join(this.dir(d.project_id), `${d.direction_id}.json`);
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    writeJsonAtomic(f, d, { validate: validateResearchDirection });
    this.project(d.project_id).set(d.direction_id, d);
    return d;
  }

  private audit(
    actor: ResearchActor,
    action: string,
    d: { project_id: string; direction_id: string },
    outcome: "allowed" | "denied",
    details?: Record<string, unknown>,
    reason?: string,
  ): void {
    this.svc().audit.record({
      actor: { kind: actor.kind, ...(actor.id ? { id: actor.id } : {}) },
      listener: actor.kind === "agent" ? "agent" : "human",
      action,
      outcome,
      project_id: d.project_id,
      target: d.direction_id,
      ...(reason ? { reason } : {}),
      ...(details ? { details: compact(details) } : {}),
    });
  }

  all(pid: string): ResearchDirection[] {
    return [...this.project(pid).values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  get(pid: string, id: string): ResearchDirection | undefined {
    return this.project(pid).get(id);
  }

  require(pid: string, id: string): ResearchDirection {
    this.svc().registry.require(pid);
    const d = this.get(pid, id);
    if (!d) throw new HttpError(404, "direction_not_found", `no direction ${id} in project ${pid}`);
    return d;
  }

  // ---- what a target is ------------------------------------------------------------------------

  private runExists(pid: string, id: string): boolean {
    return this.svc()
      .tracking.mappings.forProject(pid)
      .some((m) => m.run_name === id || m.mlflow_run_id === id);
  }

  /** The target's title, or undefined when it does not resolve. */
  private targetTitle(pid: string, t: DirectionTarget): string | undefined {
    const svc = this.svc();
    const id = t.id ?? "";
    switch (t.kind) {
      case "note": {
        const n = svc.vault.get(pid, id);
        return n && !n.archived_at ? n.title : undefined;
      }
      case "task":
        return svc.tasks.get(pid, id)?.title;
      case "study": {
        const r = svc.research.get(pid, id);
        return r?.kind === "study" ? r.title : undefined;
      }
      case "run":
        return this.runExists(pid, id) ? id : undefined;
      case "bottom_line":
        return "The bottom line";
      case "project":
        return svc.registry.get(pid)?.name ?? pid;
    }
  }

  private refExists(pid: string, r: DirectionRef): boolean {
    const svc = this.svc();
    switch (r.kind) {
      case "note":
        return Boolean(svc.vault.get(pid, r.id));
      case "run":
        return this.runExists(pid, r.id);
      case "job":
        return svc.jobs.get(r.id)?.project_id === pid;
      case "study":
        return svc.research.get(pid, r.id)?.kind === "study";
      case "task":
        return Boolean(svc.tasks.get(pid, r.id));
      case "work":
        return Boolean(svc.vault.getWork(pid, r.id));
    }
  }

  view(d: ResearchDirection): DirectionView {
    const title = this.targetTitle(d.project_id, d.target);
    return compact({
      ...d,
      waiting_on: waitingOn(d),
      target_title: title,
      target_found: title !== undefined,
    }) as DirectionView;
  }

  /** The agent sessions named in directions, and whether any agent session of the project is live. */
  sessions(pid: string): { sessions: Record<string, DirectionSession>; live: number } {
    const svc = this.svc();
    const sessions: Record<string, DirectionSession> = {};
    let live = 0;
    for (const t of svc.tokens.list()) {
      if (t.kind !== "agent" || t.scope.project_id !== pid) continue;
      const isLive = svc.tokens.isLive(t);
      if (isLive) live++;
      sessions[t.token_id] = compact({
        harness: t.agent_session?.harness,
        label: t.agent_session?.label ?? t.label,
        live: isLive,
      }) as DirectionSession;
    }
    return { sessions, live };
  }

  list(
    pid: string,
    q: { status?: string; target?: string; waiting?: string } = {},
  ): DirectionView[] {
    this.svc().registry.require(pid);
    return this.all(pid)
      .map((d) => this.view(d))
      .filter(
        (d) =>
          (!q.status || d.status === q.status) &&
          (!q.target || targetRef(d.target) === q.target) &&
          (!q.waiting || d.waiting_on === q.waiting),
      )
      .reverse();
  }

  // ---- the researcher's writes (human listener only) -------------------------------------------

  create(
    pid: string,
    input: { target: unknown; kind: unknown; text: unknown },
    actor: ResearchActor,
  ): DirectionView {
    const svc = this.svc();
    svc.registry.require(pid);
    if (actor.kind !== "human")
      throw new HttpError(403, "researcher_only", "directions are the researcher's to write");
    const kind = input.kind as DirectionKind;
    if (!DIRECTION_KINDS.includes(kind))
      throw new HttpError(
        400,
        "invalid_request",
        `\`kind\` must be one of ${DIRECTION_KINDS.join(", ")}`,
      );
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) throw new HttpError(400, "invalid_request", "`text` is required");
    if (text.length > MAX_TEXT)
      throw new HttpError(400, "invalid_request", `\`text\` is longer than ${MAX_TEXT} characters`);
    const t = input.target as { kind?: unknown; id?: unknown } | undefined;
    const tkind = t?.kind as DirectionTarget["kind"];
    if (!t || !TARGET_KINDS.includes(tkind))
      throw new HttpError(
        400,
        "invalid_request",
        `\`target.kind\` must be one of ${TARGET_KINDS.join(", ")}`,
      );
    const needsId = !["bottom_line", "project"].includes(tkind);
    if (needsId && (typeof t.id !== "string" || !t.id))
      throw new HttpError(400, "invalid_request", `a ${tkind} target needs its \`id\``);
    const target: DirectionTarget = needsId ? { kind: tkind, id: t.id as string } : { kind: tkind };
    if (this.targetTitle(pid, target) === undefined)
      throw new HttpError(404, "not_found", `no ${tkind} ${target.id} in this project`);
    const now = svc.now();
    const d = this.save({
      schema_version: 1,
      direction_id: newId(now),
      project_id: pid,
      target,
      kind,
      text,
      status: "open",
      round: 1,
      thread: [],
      deliveries: [],
      created_at: now.toISOString(),
      created_by: actor,
      updated_at: now.toISOString(),
      revision: 1,
    });
    svc.events.publish(pid, "direction.created", {
      direction_id: d.direction_id,
      kind,
      target: targetRef(target),
    });
    this.audit(actor, "direction.create", d, "allowed", { kind, target: targetRef(target) });
    return this.view(d);
  }

  /** close, reopen or withdraw: the researcher's turns. */
  settle(
    pid: string,
    id: string,
    act: "close" | "reopen" | "withdraw",
    text: unknown,
    actor: ResearchActor,
  ): DirectionView {
    const d = this.require(pid, id);
    if (actor.kind !== "human")
      throw new HttpError(
        403,
        "researcher_only",
        "only the researcher closes, reopens or withdraws",
      );
    const note = typeof text === "string" ? text.trim() : "";
    if (note.length > MAX_TEXT)
      throw new HttpError(400, "invalid_request", `\`text\` is longer than ${MAX_TEXT} characters`);
    const refuse = (msg: string): never => {
      throw new HttpError(409, "direction_state", msg);
    };
    let status = d.status;
    let round = d.round;
    if (act === "withdraw") {
      if (d.status === "withdrawn") refuse(`${id} is already withdrawn`);
      status = "withdrawn";
    } else if (act === "close") {
      if (d.kind === "rule") refuse("a rule is ended by withdrawing it");
      if (d.status === "closed" || d.status === "withdrawn") refuse(`${id} is ${d.status}`);
      status = "closed";
    } else {
      if (d.status === "open") refuse(`${id} is open already`);
      status = "open";
      round = d.round + 1;
    }
    const entry: DirectionEntry = compact({
      act,
      at: this.svc().now().toISOString(),
      by: actor,
      text: note || undefined,
    }) as DirectionEntry;
    return this.write(d, { status, round, thread: [...d.thread, entry] }, actor, act);
  }

  private write(
    d: ResearchDirection,
    change: Partial<ResearchDirection>,
    actor: ResearchActor,
    act: string,
  ): DirectionView {
    const svc = this.svc();
    const saved = this.save({
      ...d,
      ...change,
      revision: d.revision + 1,
      updated_at: svc.now().toISOString(),
    });
    svc.events.publish(d.project_id, "direction.updated", {
      direction_id: d.direction_id,
      status: saved.status,
      act,
    });
    this.audit(actor, `direction.${act}`, d, "allowed", { status: saved.status });
    return this.view(saved);
  }

  // ---- the agent's turns -------------------------------------------------------------------------

  respond(
    pid: string,
    id: string,
    input: { kind: unknown; text: unknown; refs: unknown },
    actor: ResearchActor,
  ): DirectionView {
    const d = this.require(pid, id);
    const act = input.kind as "ack" | "answer" | "decline";
    if (!["ack", "answer", "decline"].includes(act))
      throw new HttpError(400, "invalid_request", "`kind` must be one of ack, answer, decline");
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text)
      throw new HttpError(
        400,
        "invalid_request",
        act === "ack"
          ? "`text` is required: say what you will do"
          : act === "answer"
            ? "`text` is required: the answer"
            : "`text` is required: why you decline",
      );
    if (text.length > MAX_TEXT)
      throw new HttpError(400, "invalid_request", `\`text\` is longer than ${MAX_TEXT} characters`);
    const refs: DirectionRef[] = [];
    if (input.refs !== undefined) {
      if (!Array.isArray(input.refs) || input.refs.length > 50)
        throw new HttpError(400, "invalid_request", "`refs` must be an array of at most 50 refs");
      for (const r of input.refs as { kind?: unknown; id?: unknown }[]) {
        const kind = r?.kind as DirectionRef["kind"];
        if (!REF_KINDS.includes(kind) || typeof r.id !== "string" || !r.id)
          throw new HttpError(
            400,
            "invalid_request",
            `each ref is {kind, id} with kind one of ${REF_KINDS.join(", ")}`,
          );
        const ref = { kind, id: r.id };
        // An answer names what it changed; a name that does not resolve is not recorded.
        if (!this.refExists(pid, ref))
          throw new HttpError(
            400,
            "unresolved_ref",
            `${kind}:${r.id} does not exist in this project: an answer can only point at what is recorded`,
          );
        refs.push(ref);
      }
    }
    const refuse = (msg: string): never => {
      this.audit(actor, "direction.respond", d, "denied", { act }, msg);
      throw new HttpError(409, "direction_state", msg);
    };
    if (!inForce(d))
      refuse(
        `${id} is ${d.status}: ${d.status === "answered" || d.status === "declined" ? "the researcher closes it or reopens it" : "nothing to answer"}`,
      );
    if (d.kind === "rule" && act === "answer")
      refuse("a rule is not answered: acknowledge it (ack) and follow it, or decline it with why");
    const status = act === "ack" ? "acknowledged" : act === "answer" ? "answered" : "declined";
    const entry: DirectionEntry = compact({
      act,
      at: this.svc().now().toISOString(),
      by: actor,
      text,
      refs: refs.length ? refs : undefined,
    }) as DirectionEntry;
    return this.write(d, { status, thread: [...d.thread, entry] }, actor, act);
  }

  /** Directions in force not yet shown to this session in their current round. */
  pending(pid: string, session: string): ResearchDirection[] {
    if (!this.svc().registry.get(pid)) return [];
    return this.all(pid).filter(
      (d) => inForce(d) && !d.deliveries.some((x) => x.session === session && x.round === d.round),
    );
  }

  /**
   * Show directions to an agent session and record it: the ones not yet shown, or (`all`, at the
   * start of a session) every one in force. Rules come first.
   */
  deliver(pid: string, session: string, opts: { all?: boolean } = {}): DirectionView[] {
    this.svc().registry.require(pid);
    const now = this.svc().now().toISOString();
    const out = opts.all ? this.all(pid).filter(inForce) : this.pending(pid, session);
    for (const d of out) {
      if (d.deliveries.some((x) => x.session === session && x.round === d.round)) continue;
      this.save({
        ...d,
        deliveries: [...d.deliveries, { session, at: now, round: d.round }].slice(-2000),
      });
    }
    return out
      .map((d) => this.view(this.get(pid, d.direction_id) ?? d))
      .sort((a, b) => Number(b.kind === "rule") - Number(a.kind === "rule"));
  }

  // ---- accountability ----------------------------------------------------------------------------

  /** Directions an agent still owes an answer: open or acknowledged (a rule: not acknowledged). */
  private owed(pid: string): ResearchDirection[] {
    return this.all(pid).filter((d) =>
      d.kind === "rule" ? d.status === "open" : d.status === "open" || d.status === "acknowledged",
    );
  }

  /** `direction_unanswered`, for the vault's checks: on a note, or on the vault as a whole. */
  checks(pid: string): VaultCheck[] {
    const out: VaultCheck[] = [];
    for (const d of this.owed(pid)) {
      const what =
        d.kind === "rule"
          ? `the researcher's rule ${d.direction_id} has not been acknowledged by any session`
          : `the researcher's direction ${d.direction_id} (${d.kind}) on ${targetRef(d.target)} is ${d.status === "acknowledged" ? "acknowledged but not answered" : "not answered"}`;
      out.push(
        compact({
          code: "direction_unanswered",
          note: d.target.kind === "note" ? d.target.id : undefined,
          message: `${what}: answer it on the record (ablationkit_do direction.respond with kind answer and the refs of what you changed, or decline with why)`,
        }) as VaultCheck,
      );
    }
    return out;
  }

  /**
   * What a task owes before it completes: unanswered directions (not rules) on the task itself,
   * on the notes written under it, and on the runs of its jobs.
   */
  owedByTask(pid: string, tid: string): ResearchDirection[] {
    const svc = this.svc();
    const notes = new Set(svc.vault.ofTask(pid, tid).map((n) => n.note_id));
    const runs = new Set<string>();
    for (const j of svc.jobs.list(pid)) if (j.task_id === tid && j.run_name) runs.add(j.run_name);
    for (const m of svc.tracking.mappings.forProject(pid))
      if (m.task_id === tid) {
        if (m.run_name) runs.add(m.run_name);
        if (m.mlflow_run_id) runs.add(m.mlflow_run_id);
      }
    return this.owed(pid).filter((d) => {
      if (d.kind === "rule") return false;
      const id = d.target.id ?? "";
      return (
        (d.target.kind === "task" && id === tid) ||
        (d.target.kind === "note" && notes.has(id)) ||
        (d.target.kind === "run" && runs.has(id))
      );
    });
  }
}
