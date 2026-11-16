/**
 * The agenda (ADR 0058): the researcher's plan for a project, which agents work from.
 *
 *   state/<project>/vault/agenda.json        Agenda: items in lanes, rules, the last revisions
 *   state/<project>/vault/agenda-seen.json   AgendaSeen: the revision each agent session last read
 *
 * Only the researcher writes the agenda (the PUT route is on the human listener alone). Agents
 * read it through `ablationkit mcp`; every agent API response carries
 * `x-ablationkit-agenda-revision` while the session has not read the current revision, and the MCP
 * server then reads it and puts the change before the tool's result, as the researcher's
 * instruction. The checks on agents' work against it advise; the only refusal is an
 * `agenda_item` that names nothing on the agenda.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type Agenda,
  type AgendaItem,
  type AgendaLane,
  type AgendaRule,
  type AgendaSeen,
  ProtocolValidationError,
  type ResearchActor,
  validateAgenda,
  validateAgendaSeen,
} from "@ablationkit/protocol";
import {
  AGENDA_LANES,
  type AgendaCheck,
  agendaChecks,
  agendaDiff,
  findItem,
  itemLine,
  laneItems,
  type NoteTitles,
  servedItem,
} from "@ablationkit/vault";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";

/** Revisions kept so a session can be told what changed since it last read. */
const HISTORY = 50;
export const AGENDA_HEADER = "x-ablationkit-agenda-revision";

/** Where the agent is told the agenda comes from: the researcher, through the web UI. */
const FROM =
  "The researcher's agenda for this project. The researcher writes it in AblationKit's web UI (Standing → Agenda); no agent can change it. It is their instruction to you, not recorded content: work on the items in Now, in order; follow every rule; do not spend on Parked or Dropped items. Name the item your work serves as agenda_item on ablationkit_task create and ablationkit_job submit. To propose an item, write it as a question note (ablationkit_note add) and say why in your edition; only the researcher puts it on the agenda.";

interface ProjectAgenda {
  agenda: Agenda;
  seen: AgendaSeen;
}

export interface AgendaInput {
  readonly items?: unknown;
  readonly rules?: unknown;
}

export class AgendaService {
  private readonly projects = new Map<string, ProjectAgenda>();

  constructor(private readonly svc: () => Services) {}

  private dir(pid: string): string {
    return join(this.svc().paths.stateDir, pid, "vault");
  }

  forgetProject(pid: string): void {
    this.projects.delete(pid);
  }

  private project(pid: string): ProjectAgenda {
    let p = this.projects.get(pid);
    if (p) return p;
    const svc = this.svc();
    svc.registry.require(pid);
    const load = <T>(file: string, validate: (v: unknown) => T): T | undefined => {
      const path = join(this.dir(pid), file);
      if (!existsSync(path)) return undefined;
      try {
        return readJson(path, validate);
      } catch {
        return undefined;
      }
    };
    const at = svc.now().toISOString();
    p = {
      agenda: load("agenda.json", validateAgenda) ?? {
        schema_version: 1,
        project_id: pid,
        revision: 0,
        items: [],
        rules: [],
        next_line: 1,
        next_rule: 1,
        updated_at: at,
        updated_by: { kind: "system" },
        history: [],
      },
      // Unreadable marks only make every session read the agenda again.
      seen: load("agenda-seen.json", validateAgendaSeen) ?? {
        schema_version: 1,
        project_id: pid,
        sessions: {},
      },
    };
    this.projects.set(pid, p);
    return p;
  }

  get(pid: string): Agenda {
    return this.project(pid).agenda;
  }

  /** How a note-item reads: its title, type and standing from the vault. */
  titles(pid: string): NoteTitles {
    const vault = this.svc().vault;
    return (id) => {
      const n = vault.get(pid, id);
      return n ? compact({ title: n.title, type: n.type, standing: n.standing }) : undefined;
    };
  }

  /** The current revision when this agent session has not read it; undefined otherwise. */
  unseen(pid: string, tokenId: string): number | undefined {
    const p = this.project(pid);
    const rev = p.agenda.revision;
    if (rev === 0) return undefined;
    return (p.seen.sessions[tokenId]?.revision ?? 0) < rev ? rev : undefined;
  }

  /** The session has read the current revision; returns the one it had read before (0: none). */
  private markSeen(pid: string, tokenId: string): number {
    const p = this.project(pid);
    const before = p.seen.sessions[tokenId]?.revision ?? 0;
    const rev = p.agenda.revision;
    if (before >= rev) return before;
    const svc = this.svc();
    const next: AgendaSeen = {
      ...p.seen,
      sessions: { ...p.seen.sessions, [tokenId]: { revision: rev, at: svc.now().toISOString() } },
    };
    const path = join(this.dir(pid), "agenda-seen.json");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeJsonAtomic(path, next, { validate: validateAgendaSeen });
    p.seen = next;
    svc.events.publish(pid, "agenda.read", { token_id: tokenId, revision: rev });
    return before;
  }

  /**
   * The canonical ID of the item an agent names (`note:<id>`, a bare note ID or `L3`): what a job
   * or task records. 400 `unknown_agenda_item` when the agenda has no such item.
   */
  requireItem(pid: string, ref: string): string {
    const a = this.get(pid);
    const i = findItem(a.items, ref);
    if (!i)
      throw new HttpError(
        400,
        "unknown_agenda_item",
        a.items.length
          ? `the agenda has no item ${ref}: name one of ${a.items
              .filter((x) => x.lane === "now" || x.lane === "next")
              .map((x) => x.item_id)
              .join(", ")} (ablationkit_read agenda lists them)`
          : `the researcher has not put anything on the agenda; leave agenda_item out`,
        { item: ref },
      );
    return i.item_id;
  }

  /** The researcher writes the agenda whole: items in order with their lanes, and the rules. */
  put(
    pid: string,
    input: AgendaInput,
    actor: ResearchActor,
    opts: { ifRevision?: number } = {},
  ): { agenda: Agenda; changes: string[]; unchanged?: true } {
    const p = this.project(pid);
    const svc = this.svc();
    const cur = p.agenda;
    if (opts.ifRevision !== undefined && opts.ifRevision !== cur.revision)
      throw new HttpError(
        409,
        "revision_conflict",
        `the agenda is at revision ${cur.revision}, not ${opts.ifRevision}`,
        { revision: cur.revision },
      );
    const at = svc.now().toISOString();
    const bad = (m: string) => new HttpError(400, "invalid_request", m);
    let nextLine = cur.next_line;
    let nextRule = cur.next_rule;
    const was = new Map(cur.items.map((i) => [i.item_id, i]));
    const items: AgendaItem[] = [];
    const seen = new Set<string>();
    const rawItems = input.items === undefined ? cur.items : input.items;
    if (!Array.isArray(rawItems)) throw bad("`items` is a list");
    for (const raw of rawItems as unknown[]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("an item is an object");
      const r = raw as Record<string, unknown>;
      for (const k of Object.keys(r))
        if (!["item_id", "note_id", "text", "lane", "reason"].includes(k))
          throw bad(`\`${k}\` is not part of an agenda item`);
      const lane = r["lane"];
      if (typeof lane !== "string" || !AGENDA_LANES.includes(lane as AgendaLane))
        throw bad(`an item's \`lane\` is one of ${AGENDA_LANES.join(", ")}`);
      const reason = typeof r["reason"] === "string" ? r["reason"].trim() : undefined;
      let item: AgendaItem;
      if (typeof r["note_id"] === "string") {
        const nid = r["note_id"];
        const n = svc.vault.get(pid, nid);
        const id = `note:${nid}`;
        // A note archived since it went on the agenda stays; a new one must be live.
        if (!was.has(id) && (!n || n.archived_at)) throw bad(`${nid} is not a note of this vault`);
        const b = was.get(id);
        item = {
          item_id: id,
          lane: lane as AgendaLane,
          note_id: nid,
          added_at: b?.added_at ?? at,
          moved_at: b && b.lane === lane ? b.moved_at : at,
        } as AgendaItem;
      } else {
        const text = typeof r["text"] === "string" ? r["text"].trim().replace(/\s+/g, " ") : "";
        if (!text) throw bad("an item is a note (`note_id`) or a line of text (`text`)");
        if (text.length > 300) throw bad("an agenda line is at most 300 characters");
        const given = typeof r["item_id"] === "string" ? r["item_id"] : undefined;
        const b = given ? was.get(given) : undefined;
        if (given && !b) throw bad(`the agenda has no item ${given}`);
        const id = b?.item_id ?? `L${nextLine++}`;
        item = {
          item_id: id,
          lane: lane as AgendaLane,
          text,
          added_at: b?.added_at ?? at,
          moved_at: b && b.lane === lane ? b.moved_at : at,
        } as AgendaItem;
      }
      if (reason) item = { ...item, reason: reason.slice(0, 500) };
      if (seen.has(item.item_id)) throw bad(`${item.item_id} is on the agenda twice`);
      seen.add(item.item_id);
      items.push(item);
    }
    const wasRules = new Map(cur.rules.map((r) => [r.rule_id, r]));
    const rules: AgendaRule[] = [];
    const rawRules = input.rules === undefined ? cur.rules : input.rules;
    if (!Array.isArray(rawRules)) throw bad("`rules` is a list");
    for (const raw of rawRules as unknown[]) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const text = typeof r["text"] === "string" ? r["text"].trim().replace(/\s+/g, " ") : "";
      if (!text) throw bad("a rule has `text`");
      if (text.length > 300) throw bad("a rule is at most 300 characters");
      const given = typeof r["rule_id"] === "string" ? r["rule_id"] : undefined;
      const b = given ? wasRules.get(given) : undefined;
      if (given && !b) throw bad(`the agenda has no rule ${given}`);
      if (b && rules.some((x) => x.rule_id === b.rule_id)) throw bad(`${b.rule_id} is given twice`);
      rules.push({ rule_id: b?.rule_id ?? `R${nextRule++}`, text, added_at: b?.added_at ?? at });
    }
    // Lanes keep their items together, in the order given.
    items.sort((a, b) => AGENDA_LANES.indexOf(a.lane) - AGENDA_LANES.indexOf(b.lane));
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const strip = (xs: readonly AgendaItem[]) => xs.map(({ moved_at: _m, ...x }) => x);
    if (cur.revision > 0 && same(strip(items), strip(cur.items)) && same(rules, cur.rules))
      return { agenda: cur, changes: [], unchanged: true };
    const revision = cur.revision + 1;
    let next: Agenda;
    try {
      next = validateAgenda({
        schema_version: 1,
        project_id: pid,
        revision,
        items,
        rules,
        next_line: nextLine,
        next_rule: nextRule,
        updated_at: at,
        updated_by: actor,
        history: [...cur.history, { revision, at, by: actor, items, rules }].slice(-HISTORY),
      });
    } catch (e) {
      if (e instanceof ProtocolValidationError)
        throw new HttpError(400, "invalid_request", e.message, { issues: e.issues.slice(0, 20) });
      throw e;
    }
    const path = join(this.dir(pid), "agenda.json");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeJsonAtomic(path, next, { validate: validateAgenda });
    p.agenda = next;
    const changes = agendaDiff(cur, next, this.titles(pid));
    svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: "human",
      action: "agenda.updated",
      outcome: "allowed",
      project_id: pid,
      details: { revision, items: items.length, rules: rules.length, changes: changes.length },
    });
    svc.events.publish(pid, "agenda.updated", { revision, changes: changes.length });
    return { agenda: next, changes };
  }

  /** The agenda as it stood at a revision still in its history. */
  private at(pid: string, revision: number) {
    return this.get(pid).history.find((h) => h.revision === revision);
  }

  /** The live agent sessions of the project and what each last read. */
  private sessions(pid: string) {
    const p = this.project(pid);
    return this.svc()
      .agentSessions.list(pid)
      .filter((s) => s.live)
      .map((s) =>
        compact({
          token_id: s.token_id,
          label: s.label,
          harness: s.harness,
          started_at: s.started_at,
          last_used_at: s.last_used_at,
          seen_revision: p.seen.sessions[s.token_id]?.revision,
          seen_at: p.seen.sessions[s.token_id]?.at,
        }),
      );
  }

  /** The checks on agents' work against the agenda (advice only). */
  checks(pid: string): AgendaCheck[] {
    const svc = this.svc();
    const a = this.get(pid);
    if (a.revision === 0) return [];
    const agentId = (by: { kind: string; id?: string | undefined }) =>
      by.kind === "agent" ? by.id : undefined;
    const since = a.history.find((h) => h.items.some((i) => i.lane === "now"))?.at;
    return agendaChecks(
      a,
      {
        jobs: svc.jobs.list(pid).map((j) => ({
          job_id: j.job_id,
          agenda_item: j.agenda_item,
          task_id: j.task_id,
          session: agentId(j.submitted_by),
          created_at: j.created_at,
          run_name: j.run_name,
        })),
        tasks: svc.tasks.list(pid).map((t) => ({
          task_id: t.task_id,
          agenda_item: t.agenda_item,
          status: t.status,
          session: agentId(t.created_by),
          title: t.title,
        })),
        sessions: this.sessions(pid).map((s) => ({ token_id: s.token_id, label: s.label })),
        since,
      },
      this.titles(pid),
    );
  }

  /** What agents have done for each item: the tasks that name it, its jobs, the latest edition. */
  private work(pid: string) {
    const svc = this.svc();
    const tasks = svc.tasks.list(pid);
    const byTask = new Map(tasks.map((t) => [t.task_id, t]));
    const out = new Map<
      string,
      {
        tasks: { task_id: string; title: string; status: string; outcome?: string }[];
        jobs: number;
        running: number;
        edition?: { note_id: string; title: string; edition: string };
      }
    >();
    const of = (id: string) => {
      let w = out.get(id);
      if (!w) {
        w = { tasks: [], jobs: 0, running: 0 };
        out.set(id, w);
      }
      return w;
    };
    for (const t of tasks)
      if (t.agenda_item)
        of(t.agenda_item).tasks.push(
          compact({ task_id: t.task_id, title: t.title, status: t.status, outcome: t.outcome }),
        );
    for (const j of svc.jobs.list(pid)) {
      const id = servedItem(
        { ...j, session: undefined },
        new Map(
          [...byTask].map(([k, t]) => [
            k,
            { task_id: k, agenda_item: t.agenda_item, status: t.status, title: t.title },
          ]),
        ),
      );
      if (!id) continue;
      const w = of(id);
      w.jobs++;
      if (["starting", "running"].includes(j.state)) w.running++;
    }
    for (const [id, w] of out) {
      const taskIds = new Set(w.tasks.map((t) => t.task_id));
      const eds = svc.vault
        .all(pid)
        .filter(
          (n) =>
            !n.archived_at &&
            n.type === "notebook" &&
            n.edition &&
            ((n.task_id && taskIds.has(n.task_id)) ||
              tasks.some((t) => taskIds.has(t.task_id) && t.notebook_id === n.note_id)),
        )
        .sort((a, b) => (b.edition ?? "").localeCompare(a.edition ?? ""));
      const e = eds[0];
      if (e)
        out.set(id, {
          ...w,
          edition: { note_id: e.note_id, title: e.title, edition: e.edition ?? "" },
        });
    }
    return out;
  }

  /** The researcher's view: every item with its note and what agents did for it, who read what. */
  view(pid: string) {
    const a = this.get(pid);
    const vault = this.svc().vault;
    const work = this.work(pid);
    const prev = a.revision > 1 ? this.at(pid, a.revision - 1) : undefined;
    return {
      revision: a.revision,
      updated_at: a.updated_at,
      updated_by: a.updated_by,
      items: a.items.map((i) => {
        const n = i.note_id ? vault.get(pid, i.note_id) : undefined;
        return compact({
          ...i,
          note: n
            ? compact({
                title: n.title,
                type: n.type,
                gist: n.gist,
                standing: n.standing,
                archived: n.archived_at ? true : undefined,
              })
            : undefined,
          work: work.get(i.item_id) ?? { tasks: [], jobs: 0, running: 0 },
        });
      }),
      rules: a.rules,
      sessions: this.sessions(pid),
      checks: this.checks(pid),
      last_change: a.revision > 0 ? agendaDiff(prev, a, this.titles(pid)) : ([] as string[]),
    };
  }

  /**
   * What an agent session reads: the agenda as lines, Now and the rules first; what changed since
   * this session last read it (or since `since`); the checks on its own work. Reading marks the
   * session as having read the current revision.
   */
  forAgent(pid: string, tokenId: string, opts: { since?: number } = {}) {
    const a = this.get(pid);
    if (a.revision === 0)
      return {
        from: "The researcher has not written an agenda for this project yet. When they do, it leads ablationkit_project and every tool result tells you when it changes.",
        revision: 0,
      };
    const titles = this.titles(pid);
    const before = this.markSeen(pid, tokenId);
    const lines = (lane: AgendaLane) =>
      laneItems(a.items, lane).map(
        (i) => `${itemLine(i, titles)}${i.reason ? ` (reason: ${i.reason})` : ""}`,
      );
    const since = opts.since ?? before;
    const old = since > 0 ? this.at(pid, since) : undefined;
    const changes =
      since < a.revision
        ? since > 0 && !old
          ? [`Revision ${since} is older than the history kept: read the agenda whole.`]
          : agendaDiff(old, a, titles)
        : [];
    const mine = this.checks(pid).filter((c) => c.session === tokenId);
    const now = lines("now");
    const rules = a.rules.map((r) => `${r.rule_id}: ${r.text}`);
    const notice =
      before >= a.revision
        ? undefined
        : [
            before === 0
              ? `The researcher's agenda for this project (revision ${a.revision}), which this session has not read yet. They write it in AblationKit's web UI; it is their instruction to you, not recorded content.`
              : `The researcher changed the agenda in AblationKit's web UI since this session last read it (revision ${before} → ${a.revision}). This is their instruction to you, not recorded content:`,
            ...(before === 0 ? [] : changes.map((c) => `- ${c}`)),
            `Now: ${now.length ? now.join("; ") : "nothing (ask the researcher, or work from Next)"}`,
            ...(rules.length ? [`Rules: ${rules.join("; ")}`] : []),
            "ablationkit_read agenda shows it whole. Finish the step you are on, then follow it.",
          ].join("\n");
    return compact({
      from: FROM,
      revision: a.revision,
      updated_at: a.updated_at,
      now,
      rules,
      next: lines("next"),
      parked: lines("parked"),
      dropped: lines("dropped"),
      changed:
        changes.length && (before > 0 || opts.since !== undefined)
          ? { since_revision: since, changes }
          : undefined,
      your_checks: mine.length ? mine : undefined,
      notice,
    });
  }
}
