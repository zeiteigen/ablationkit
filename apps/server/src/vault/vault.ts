/**
 * The vault (ADR 0049): a project's knowledge as atomic notes, composed by embedding into
 * notebooks, with a ledger of where the project stands and what the researcher has read.
 *
 *   state/<project>/vault/notes/<note-id>.json   VaultNote, one per file
 *   state/<project>/vault/index.json             VaultIndex: the shelf and the ledger
 *   state/<project>/vault/reads.json             VaultReadState: what the researcher has read
 *   state/<project>/vault/works/<work-id>.json   VaultWork: the library of prior work (ADR 0052)
 *   state/<project>/vault/figures.json           how each figure fared when last drawn (ADR 0053)
 *   state/<project>/vault/set-aside.json         VaultSetAside: runs the agent set aside (ADR 0056)
 *
 * Agents and the researcher write notes, works and the index; only the researcher's reading
 * writes read marks. A write is refused only when the note itself is malformed or would embed itself; how
 * well the vault is written (atomic notes, a fact stated once, everything reachable from the
 * shelf) comes back as `checks`, which advise and gate nothing.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  ProtocolValidationError,
  type ResearchActor,
  type VaultIndex,
  type VaultNote,
  type VaultReadState,
  type VaultSetAside,
  type VaultWork,
  validateVaultIndex,
  validateVaultNote,
  validateVaultReadState,
  validateVaultSetAside,
  validateVaultWork,
} from "@ablationkit/protocol";
import {
  body,
  type CitationFormat,
  checkVault,
  citationEntries,
  embedCycle,
  embedsOf,
  NOTE_ID,
  NOTE_TYPES,
  renderCitations,
  rolesOf,
  type SetAsideMark,
  STANDINGS,
  shortCite,
  usesByWork,
  Vault,
  type VaultCheck,
  WORK_ID,
  type WorkUse,
  workHref,
  workKeys,
  workMatches,
  workStanding,
} from "@ablationkit/vault";
import { HttpError } from "../http.ts";
import { isResearchKind } from "../research/records.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";

export type ReadStatus = "new" | "changed" | "read";

/** The fields of a note someone writes; everything else is the coordinator's bookkeeping. */
const WRITABLE = [
  "type",
  "title",
  "gist",
  "summary",
  "full",
  "standing",
  "key",
  "support",
  "would_change",
  "evidence",
  "figure",
  "study",
  "aliases",
  "bears_on",
  "cites",
  "sources",
  "task_id",
  "edition",
  "created",
  "updated",
] as const;
const REQUIRED = new Set(["type", "title", "gist", "sources", "created", "updated"]);

/** The fields of a work someone writes (ADR 0052). */
const WORK_WRITABLE = [
  "kind",
  "title",
  "authors",
  "year",
  "venue",
  "doi",
  "arxiv",
  "url",
  "version",
  "accessed",
  "reading",
  "summary",
  "takeaway",
  "found_for",
  "found_via",
  "task_id",
] as const;
const WORK_REQUIRED = new Set(["kind", "title", "authors", "reading", "takeaway"]);

/** A work as a line of a list: what it is, where it stands and the roles it plays. */
export interface WorkBrief {
  readonly work_id: string;
  readonly kind: string;
  readonly cite: string;
  readonly title: string;
  readonly year?: number;
  readonly reading: string;
  readonly takeaway: string;
  readonly href?: string;
  readonly standing: "used" | "considered" | "unread";
  readonly roles: string[];
  /** The notes that cite it. */
  readonly cited_by: string[];
  readonly task_id?: string;
  readonly updated_at: string;
}
/** IDs a route path would shadow. */
const RESERVED = new Set(["index", "check", "reads", "notes"]);

export interface NoteBrief {
  readonly note_id: string;
  readonly type: string;
  readonly title: string;
  readonly gist: string;
  readonly standing?: string;
  readonly key?: { text: string; label: string };
  readonly edition?: string;
  readonly task_id?: string;
  readonly updated: string;
  readonly revision: number;
  /** The notes it embeds, in order. */
  readonly embeds: string[];
  /** The notes that embed it. */
  readonly parents: string[];
}

interface ProjectVault {
  notes: Map<string, VaultNote>;
  works: Map<string, VaultWork>;
  index: VaultIndex;
  reads: VaultReadState;
  /** How each figure fared when it was last drawn (ADR 0053), by note ID. */
  figures: Map<string, FigureDrawn>;
  /** The runs the agent set aside, with its reasons (ADR 0056). */
  setAside: VaultSetAside;
  /** Files that did not load (`path: why`). */
  problems: string[];
}

/** One figure's last drawing, as the web UI reported it. */
export interface FigureDrawn {
  readonly revision: number;
  readonly at: string;
  readonly error?: string;
}

/** `figures.json`: a map of note ID to its last drawing; anything else in it is dropped. */
function figuresFile(v: unknown): Map<string, FigureDrawn> {
  const out = new Map<string, FigureDrawn>();
  const all = (v as { figures?: unknown } | null)?.figures;
  if (typeof all !== "object" || all === null) throw new Error("no `figures` map");
  for (const [id, d] of Object.entries(all as Record<string, unknown>)) {
    const x = d as Record<string, unknown>;
    if (!NOTE_ID.test(id) || !Number.isInteger(x?.["revision"]) || typeof x["at"] !== "string")
      continue;
    out.set(id, {
      revision: x["revision"] as number,
      at: x["at"],
      ...(typeof x["error"] === "string" ? { error: x["error"].slice(0, 2000) } : {}),
    });
  }
  return out;
}

/** The syntax error in a figure's script, with its line, or undefined when it parses. */
function figureSyntaxError(script: string): string | undefined {
  try {
    new Bun.Transpiler({ loader: "js" }).transformSync(
      `(async function (el, ak, Plot, d3) {\n${script}\n})`,
    );
  } catch (e) {
    // Bun's BuildMessage: `position` is 1-based and counts the wrapper's first line.
    const pos = (e as { position?: { line?: number; column?: number } }).position;
    const where =
      typeof pos?.line === "number" ? ` at line ${pos.line - 1}, column ${pos.column ?? 0}` : "";
    return `${(e as Error).message ?? String(e)}${where}`;
  }
  try {
    // Parsed as a function body, as the frame runs it: a script that closes the function early
    // parses above but not here. Never called.
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...a: string[]
    ) => unknown;
    new AsyncFunction("el", "ak", "Plot", "d3", script);
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
}

/** The later of two `YYYY-MM-DD` days: a note is never updated before it was created. */
const laterDay = (a: string, b: string): string => (a.localeCompare(b) >= 0 ? a : b);

/** What a reader reads of a note. Sources, aliases and bookkeeping are left out on purpose. */
function noteDigest(n: VaultNote): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        n.type,
        n.title,
        n.gist,
        n.summary,
        n.full,
        n.standing,
        n.key,
        n.support,
        n.would_change,
        (n.evidence ?? []).map((e) => [e.run, e.role, e.metric, e.vs, e.note]),
        n.study,
        // Appended only when present, so the marks of notes that cite nothing stay as they were.
        ...(n.cites?.length ? [n.cites.map((c) => [c.work, c.role, c.where, c.note])] : []),
        ...(n.figure ? [n.figure.script] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

export class VaultService {
  private readonly projects = new Map<string, ProjectVault>();

  constructor(private readonly svc: () => Services) {}

  private dir(pid: string): string {
    return join(this.svc().paths.stateDir, pid, "vault");
  }

  private notePath(pid: string, id: string): string {
    return join(this.dir(pid), "notes", `${id}.json`);
  }

  forgetProject(pid: string): void {
    this.projects.delete(pid);
  }

  private today(): string {
    return this.svc().now().toISOString().slice(0, 10);
  }

  private project(pid: string): ProjectVault {
    let p = this.projects.get(pid);
    if (p) return p;
    const svc = this.svc();
    svc.registry.require(pid);
    const problems: string[] = [];
    const notes = new Map<string, VaultNote>();
    const dir = join(this.dir(pid), "notes");
    for (const f of existsSync(dir) ? readdirSync(dir).sort() : []) {
      if (!f.endsWith(".json") || f.startsWith(".")) continue;
      try {
        const n = readJson(join(dir, f), validateVaultNote);
        if (n.project_id !== pid || `${n.note_id}.json` !== f)
          throw new Error("project or note ID does not match its path");
        notes.set(n.note_id, n);
      } catch (e) {
        // One unreadable note must not hide the rest of the vault.
        problems.push(`${join(dir, f)}: ${(e as Error).message}`);
      }
    }
    const works = new Map<string, VaultWork>();
    const wdir = join(this.dir(pid), "works");
    for (const f of existsSync(wdir) ? readdirSync(wdir).sort() : []) {
      if (!f.endsWith(".json") || f.startsWith(".")) continue;
      try {
        const w = readJson(join(wdir, f), validateVaultWork);
        if (w.project_id !== pid || `${w.work_id}.json` !== f)
          throw new Error("project or work ID does not match its path");
        works.set(w.work_id, w);
      } catch (e) {
        problems.push(`${join(wdir, f)}: ${(e as Error).message}`);
      }
    }
    const load = <T>(file: string, validate: (v: unknown) => T): T | undefined => {
      const path = join(this.dir(pid), file);
      if (!existsSync(path)) return undefined;
      try {
        return readJson(path, validate);
      } catch (e) {
        problems.push(`${path}: ${(e as Error).message}`);
        return undefined;
      }
    };
    p = {
      notes,
      works,
      index: load("index.json", validateVaultIndex) ?? {
        schema_version: 1,
        project_id: pid,
        shelf: [],
        ledger: { order: [] },
        updated_at: svc.now().toISOString(),
        updated_by: { kind: "system" },
        revision: 1,
      },
      figures: load("figures.json", figuresFile) ?? new Map(),
      setAside: load("set-aside.json", validateVaultSetAside) ?? {
        schema_version: 1,
        project_id: pid,
        runs: {},
      },
      // Unreadable marks lose what was read, never a note: start over rather than fail every read.
      reads: load("reads.json", validateVaultReadState) ?? {
        schema_version: 1,
        project_id: pid,
        notes: {},
      },
      problems,
    };
    this.projects.set(pid, p);
    return p;
  }

  // ---- reads ---------------------------------------------------------------------------------

  /** Every note, archived ones included. */
  all(pid: string): VaultNote[] {
    return [...this.project(pid).notes.values()];
  }

  get(pid: string, id: string): VaultNote | undefined {
    return this.project(pid).notes.get(id);
  }

  require(pid: string, id: string): VaultNote {
    const n = this.get(pid, id);
    if (!n) throw new HttpError(404, "not_found", `no note ${id} in this project's vault`);
    return n;
  }

  index(pid: string): VaultIndex {
    return this.project(pid).index;
  }

  graph(pid: string): Vault {
    const p = this.project(pid);
    return new Vault([...p.notes.values()], p.index);
  }

  readStatus(n: VaultNote): { state: ReadStatus; read_at?: string } {
    const mark = this.project(n.project_id).reads.notes[n.note_id];
    if (!mark) return { state: "new" };
    return { state: mark.digest === noteDigest(n) ? "read" : "changed", read_at: mark.read_at };
  }

  /** What the vault points at outside itself, from the coordinator's own files. */
  private world(pid: string) {
    const svc = this.svc();
    const runs = new Set<string>();
    const studies = new Set<string>();
    for (const m of svc.tracking.mappings.forProject(pid)) {
      if (m.run_name) runs.add(m.run_name);
      if (m.mlflow_run_id) runs.add(m.mlflow_run_id);
      if (m.study_id) studies.add(m.study_id);
    }
    for (const r of svc.research.all(pid)) if (r.kind === "study") studies.add(r.record_id);
    return {
      runs,
      studies,
      source: (kind: string, id: string): boolean | undefined => {
        if (kind === "task") return Boolean(svc.tasks.get(pid, id));
        if (isResearchKind(kind)) return svc.research.get(pid, id)?.kind === kind;
        if (kind === "run") return runs.has(id);
        return undefined;
      },
      completed_tasks: svc.tasks
        .list(pid)
        .filter((t) => t.status === "completed")
        .map((t) => ({ task_id: t.task_id, title: t.title })),
      index_updated_at: this.project(pid).index.updated_at,
      works: [...this.project(pid).works.values()],
      figures: this.project(pid).figures,
      // The file drawer (ADR 0056): the runs each task's jobs produced, and those set aside.
      task_runs: svc.witness.taskRuns(pid),
      set_aside: (id: string) => this.setAsideMark(pid, id),
    };
  }

  checks(pid: string): VaultCheck[] {
    const p = this.project(pid);
    return [
      ...p.problems.map((message) => ({ code: "unreadable", message })),
      ...checkVault([...p.notes.values()], p.index, this.world(pid)),
      // The researcher's directions no agent has answered yet (ADR 0057).
      ...this.svc().directions.checks(pid),
    ];
  }

  private brief(n: VaultNote, vault: Vault): NoteBrief {
    return compact({
      note_id: n.note_id,
      type: n.type,
      title: n.title,
      gist: n.gist,
      standing: n.standing,
      key: n.key,
      edition: n.edition,
      task_id: n.task_id,
      updated: n.updated,
      revision: n.revision,
      embeds: vault.children(n.note_id).map((c) => c.note_id),
      parents: vault.parents(n.note_id).map((c) => c.note_id),
    }) as NoteBrief;
  }

  /** Notes without their text, for a list: the newest change first. */
  list(
    pid: string,
    q: { type?: string; standing?: string; q?: string; task?: string; archived?: boolean } = {},
  ): NoteBrief[] {
    const p = this.project(pid);
    const vault = this.graph(pid);
    if (q.archived)
      return [...p.notes.values()].filter((n) => n.archived_at).map((n) => this.brief(n, vault));
    const found = q.q?.trim() ? vault.search(q.q) : [...vault.notes];
    const out = found.filter(
      (n) =>
        (!q.type || n.type === q.type) &&
        (!q.standing || n.standing === q.standing) &&
        (!q.task || n.task_id === q.task || n.sources.includes(`task:${q.task}`)),
    );
    if (!q.q?.trim())
      out.sort(
        (a, b) => b.updated_at.localeCompare(a.updated_at) || a.note_id.localeCompare(b.note_id),
      );
    return out.map((n) => this.brief(n, vault));
  }

  /**
   * The whole vault for a reader: every live note with its text, the shelf, the editions, the
   * ledger, and what has been read. `brief` leaves the text out (an agent's outline).
   */
  view(pid: string, opts: { brief?: boolean } = {}) {
    const p = this.project(pid);
    const vault = this.graph(pid);
    const reads: Record<string, { state: ReadStatus; read_at?: string }> = {};
    let unread = 0;
    let changed = 0;
    for (const n of vault.notes) {
      const st = this.readStatus(n);
      if (st.state === "new") unread++;
      else {
        reads[n.note_id] = st;
        if (st.state === "changed") changed++;
      }
    }
    const checks = this.checks(pid);
    const works = [...p.works.values()].filter((w) => !w.archived_at);
    const uses = usesByWork(vault.notes);
    return {
      project_id: pid,
      notes: opts.brief ? vault.notes.map((n) => this.brief(n, vault)) : [...vault.notes],
      // The library (ADR 0052): every live work; brief leaves them to ablationkit_read work.list.
      ...(opts.brief ? {} : { works }),
      shelf: vault.shelf.map((n) => n.note_id),
      editions: vault.editions.map((n) => n.note_id),
      ledger: compact({
        bottom_line: p.index.ledger.bottom_line,
        order: vault.ledger.claims.map((n) => n.note_id),
      }),
      index: { revision: p.index.revision, updated_at: p.index.updated_at },
      // A note absent from `reads` has not been read.
      reads,
      counts: {
        notes: vault.notes.length,
        new: unread,
        changed,
        // What the navigation shows: lines of the ledger not read as they now stand.
        ledger_unread: [
          ...vault.ledger.claims,
          ...vault.ledger.decisions,
          ...vault.ledger.questions,
        ].filter((n) => this.readStatus(n).state !== "read").length,
        checks: checks.length,
        works: works.length,
        works_cited: works.filter((w) => uses.has(w.work_id)).length,
        works_unread: works.filter((w) => w.reading === "unread").length,
      },
      ...(opts.brief ? { checks } : {}),
    };
  }

  /** One note with where it sits, what mentions it and what is wrong with it. */
  noteView(pid: string, id: string) {
    const note = this.require(pid, id);
    const vault = this.graph(pid);
    const name = (n: VaultNote) => ({ note_id: n.note_id, type: n.type, title: n.title });
    return {
      note,
      embeds: vault.children(id).map((n) => ({
        ...name(n),
        gist: n.gist,
        ...(n.standing ? { standing: n.standing } : {}),
      })),
      // Every chain of notes from a shelf notebook down to this one.
      places: vault.contexts(id).map((chain) => chain.map(name)),
      editions: vault.editionsOf(id).map(name),
      mentioned_by: [...new Set(vault.mentions(id).map((m) => m.note))].map(name),
      // The works it cites, named as a reader names them (ADR 0052).
      cites: (note.cites ?? []).map((c) => {
        const w = this.project(pid).works.get(c.work);
        return compact({
          ...c,
          cite: w ? shortCite(w) : undefined,
          title: w?.title,
          reading: w?.reading,
          href: w ? workHref(w) : undefined,
          missing: w && !w.archived_at ? undefined : true,
        });
      }),
      in_ledger: ["claim", "decision", "question"].includes(note.type) && !note.archived_at,
      read: this.readStatus(note),
      checks: this.checks(pid).filter((c) => c.note === id),
    };
  }

  // ---- writes --------------------------------------------------------------------------------

  private checked(
    pid: string,
    raw: Record<string, unknown>,
    known: readonly VaultNote[],
  ): VaultNote {
    const id = raw["note_id"] as string;
    const fail = (message: string, code = "invalid_request"): never => {
      throw new HttpError(400, code, `${id}: ${message}`);
    };
    const type = raw["type"];
    if (typeof type !== "string" || !(NOTE_TYPES as readonly string[]).includes(type))
      fail(`\`type\` is one of ${NOTE_TYPES.join(", ")}`);
    const title = raw["title"];
    if (typeof title === "string" && title.length > 80)
      fail(
        `the title is ${title.length} characters; at most 80. A claim, finding or decision is titled with a short sentence that states it; the rest goes in the gist`,
      );
    const gist = raw["gist"];
    if (typeof gist === "string" && gist.length > 180)
      fail(
        `the gist is ${gist.length} characters; at most 180. Say the thing in one sentence and continue in the summary`,
      );
    const allowed = STANDINGS[type as VaultNote["type"]];
    const standing = raw["standing"];
    if (allowed && !(allowed as readonly unknown[]).includes(standing))
      fail(`a ${type} carries \`standing\`: ${allowed.join(", ")}`);
    if (!allowed && standing !== undefined)
      fail(`a ${type} carries no \`standing\` (claims, decisions and questions do)`);
    if (raw["edition"] !== undefined && type !== "notebook")
      fail("only a notebook carries `edition` (it reports one working session)");
    if (type === "figure" && raw["figure"] === undefined)
      fail(
        "a figure carries the code that draws it: `figure: {script}` (see the field's description)",
      );
    if (type !== "figure" && raw["figure"] !== undefined)
      fail("only a figure carries `figure`; give the note `type: figure`, or embed a figure note");
    let n: VaultNote;
    try {
      n = validateVaultNote(raw);
    } catch (e) {
      if (e instanceof ProtocolValidationError)
        throw new HttpError(400, "invalid_request", `${id}: ${e.message}`, {
          issues: e.issues.slice(0, 20),
        });
      throw e;
    }
    if (n.figure) {
      const err = figureSyntaxError(n.figure.script);
      if (err) fail(`the figure's script does not parse: ${err}`, "figure_syntax");
    }
    if (n.task_id && !this.svc().tasks.get(pid, n.task_id))
      fail(`task ${n.task_id} is not a task of this project`);
    if (embedsOf(body(n)).includes(n.note_id)) fail("the note embeds itself", "embed_cycle");
    const cycle = embedCycle(known, n);
    if (cycle)
      fail(
        `embedding makes a note contain itself: ${cycle.join(" → ")}. A note embeds smaller notes; link the larger one instead`,
        "embed_cycle",
      );
    return n;
  }

  private input(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (!(WRITABLE as readonly string[]).includes(k))
        throw new HttpError(400, "invalid_request", `\`${k}\` is not a field of a note`);
      // An empty string or list clears an optional field, so a writer need not know `unset`.
      if (v === undefined || v === null) continue;
      if (!REQUIRED.has(k) && (v === "" || (Array.isArray(v) && v.length === 0))) continue;
      out[k] = typeof v === "string" && k !== "type" ? v.trim() : v;
    }
    return out;
  }

  private save(n: VaultNote): void {
    const path = this.notePath(n.project_id, n.note_id);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeJsonAtomic(path, n, { validate: validateVaultNote });
    this.project(n.project_id).notes.set(n.note_id, n);
  }

  private changed(
    n: VaultNote,
    type: string,
    actor: ResearchActor,
    listener: "human" | "agent" | undefined,
    fields?: string[],
    was?: VaultNote,
  ): void {
    // A change of standing is kept in the journal, so a session's account can say from what to what.
    const standing =
      was && was.standing !== n.standing
        ? { standing_from: was.standing ?? "", standing_to: n.standing ?? "" }
        : {};
    const svc = this.svc();
    svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: listener ?? "internal",
      action: type,
      outcome: "allowed",
      project_id: n.project_id,
      target: n.note_id,
      details: compact({ type: n.type, revision: n.revision, fields, ...standing }),
    });
    svc.events.publish(n.project_id, type, {
      note_id: n.note_id,
      type: n.type,
      revision: n.revision,
      actor: actor.kind,
    });
  }

  private result(n: VaultNote) {
    return { note: n, checks: this.checks(n.project_id).filter((c) => c.note === n.note_id) };
  }

  private checkId(pid: string, id: unknown): string {
    if (typeof id !== "string" || !NOTE_ID.test(id))
      throw new HttpError(
        400,
        "invalid_request",
        "`id` is kebab-case words that say what the note is, e.g. `macro-tokenizer` (lower-case letters, digits and hyphens; at most 96 characters)",
      );
    if (RESERVED.has(id)) throw new HttpError(400, "invalid_request", `${id} is reserved`);
    this.svc().registry.require(pid);
    return id;
  }

  create(
    pid: string,
    idIn: unknown,
    input: Record<string, unknown>,
    actor: ResearchActor,
    listener?: "human" | "agent",
  ) {
    const id = this.checkId(pid, idIn);
    const p = this.project(pid);
    if (p.notes.has(id))
      throw new HttpError(
        409,
        "note_exists",
        `${id} already exists${p.notes.get(id)?.archived_at ? " (archived)" : ""}: update it, or choose an id for what is different about the new note`,
      );
    const ts = this.svc().now().toISOString();
    const n = this.checked(
      pid,
      {
        sources: [],
        created: this.today(),
        ...this.input(input),
        updated:
          (input["updated"] as string | undefined) ??
          (input["created"] as string | undefined) ??
          this.today(),
        schema_version: 1,
        note_id: id,
        project_id: pid,
        created_at: ts,
        updated_at: ts,
        created_by: actor,
        updated_by: actor,
        revision: 1,
      },
      [...p.notes.values()],
    );
    this.save(n);
    this.changed(n, "vault.note.created", actor, listener);
    return this.result(n);
  }

  update(
    pid: string,
    id: string,
    patch: Record<string, unknown>,
    actor: ResearchActor,
    opts: { ifRevision?: number; unset?: readonly string[]; listener?: "human" | "agent" } = {},
  ) {
    const cur = this.require(pid, id);
    if (opts.ifRevision !== undefined && opts.ifRevision !== cur.revision)
      throw new HttpError(
        409,
        "revision_conflict",
        `${id} is at revision ${cur.revision}, not ${opts.ifRevision}`,
        { revision: cur.revision },
      );
    const next: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (!(WRITABLE as readonly string[]).includes(k))
        throw new HttpError(400, "invalid_request", `\`${k}\` is not a field of a note`);
      if (v === undefined || v === null) continue;
      const empty = v === "" || (Array.isArray(v) && v.length === 0);
      if (empty && !REQUIRED.has(k)) delete next[k];
      else next[k] = typeof v === "string" && k !== "type" ? v.trim() : v;
    }
    for (const k of opts.unset ?? []) {
      if (!(WRITABLE as readonly string[]).includes(k) || REQUIRED.has(k))
        throw new HttpError(400, "invalid_request", `\`${k}\` cannot be cleared`);
      delete next[k];
    }
    // A type that carries no standing drops the old one rather than refusing the change.
    if (
      patch["type"] !== undefined &&
      !STANDINGS[next["type"] as VaultNote["type"]] &&
      patch["standing"] === undefined
    )
      delete next["standing"];
    const draft = this.checked(
      pid,
      {
        ...next,
        updated_at: this.svc().now().toISOString(),
        updated_by: actor,
        revision: cur.revision + 1,
      },
      this.all(pid),
    );
    // `updated` is when what the note says last changed: a new source or alias does not move it.
    const n: VaultNote =
      patch["updated"] === undefined && noteDigest(draft) !== noteDigest(cur)
        ? { ...draft, updated: laterDay(this.today(), draft.created) }
        : draft;
    this.save(n);
    this.changed(n, "vault.note.updated", actor, opts.listener, Object.keys(patch), cur);
    return this.result(n);
  }

  /** Create or replace a note whole (an import): fields left out are cleared. */
  put(
    pid: string,
    idIn: unknown,
    input: Record<string, unknown>,
    actor: ResearchActor,
    listener?: "human" | "agent",
  ) {
    const id = this.checkId(pid, idIn);
    const cur = this.project(pid).notes.get(id);
    if (!cur) return { ...this.create(pid, id, input, actor, listener), created: true };
    const ts = this.svc().now().toISOString();
    const fields = this.input(input);
    const draft = this.checked(
      pid,
      {
        sources: [],
        created: cur.created,
        updated: cur.updated,
        ...fields,
        schema_version: 1,
        note_id: id,
        project_id: pid,
        created_at: cur.created_at,
        created_by: cur.created_by,
        updated_at: ts,
        updated_by: actor,
        revision: cur.revision + 1,
      },
      this.all(pid),
    );
    // The same note again (a second import) changes nothing, not even the revision.
    const same = (a: VaultNote, b: VaultNote) =>
      WRITABLE.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k])) &&
      Boolean(a.archived_at) === Boolean(b.archived_at);
    if (same(draft, cur)) return { ...this.result(cur), created: false, unchanged: true };
    const n: VaultNote =
      fields["updated"] === undefined && noteDigest(draft) !== noteDigest(cur)
        ? { ...draft, updated: laterDay(this.today(), draft.created) }
        : draft;
    this.save(n);
    this.changed(n, "vault.note.updated", actor, listener, Object.keys(fields), cur);
    return { ...this.result(n), created: false };
  }

  setArchived(
    pid: string,
    id: string,
    archived: boolean,
    actor: ResearchActor,
    listener?: "human" | "agent",
  ) {
    const cur = this.require(pid, id);
    if (Boolean(cur.archived_at) === archived) return { note: cur, embedded_in: [] as string[] };
    const embedded = archived
      ? this.graph(pid)
          .parents(id)
          .map((n) => n.note_id)
      : [];
    const ts = this.svc().now().toISOString();
    const { archived_at: _, ...rest } = cur;
    const n = this.checked(
      pid,
      {
        ...rest,
        ...(archived ? { archived_at: ts } : {}),
        updated_at: ts,
        updated_by: actor,
        revision: cur.revision + 1,
      },
      archived ? [] : this.all(pid),
    );
    this.save(n);
    this.changed(n, archived ? "vault.note.archived" : "vault.note.restored", actor, listener);
    // Notes that embedded it now have an embed that resolves to nothing: say so, so they get fixed.
    return { note: n, embedded_in: embedded };
  }

  /** Human only. Notes that embed or link it keep the reference, which the checks then name. */
  remove(pid: string, id: string, actor: ResearchActor): VaultNote {
    const cur = this.require(pid, id);
    const path = this.notePath(pid, id);
    rmSync(path, { force: true });
    rmSync(`${path}.bak`, { force: true });
    const p = this.project(pid);
    p.notes.delete(id);
    if (p.reads.notes[id]) {
      const { [id]: _, ...rest } = p.reads.notes;
      this.saveReads({ ...p.reads, notes: rest });
    }
    this.changed(cur, "vault.note.deleted", actor, "human");
    return cur;
  }

  setIndex(
    pid: string,
    patch: { shelf?: unknown; bottom_line?: unknown; order?: unknown },
    actor: ResearchActor,
    opts: { ifRevision?: number; listener?: "human" | "agent" } = {},
  ) {
    const p = this.project(pid);
    const cur = p.index;
    if (opts.ifRevision !== undefined && opts.ifRevision !== cur.revision)
      throw new HttpError(
        409,
        "revision_conflict",
        `the vault index is at revision ${cur.revision}, not ${opts.ifRevision}`,
        { revision: cur.revision },
      );
    const ids = (v: unknown, name: string): string[] => {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
        throw new HttpError(400, "invalid_request", `\`${name}\` is a list of note IDs`);
      return [...new Set(v as string[])];
    };
    const want = (list: string[], name: string, type: string) => {
      for (const id of list) {
        const n = p.notes.get(id);
        if (!n || n.archived_at)
          throw new HttpError(
            400,
            "invalid_request",
            `\`${name}\`: ${id} is not a note of this vault`,
          );
        if (n.type !== type)
          throw new HttpError(
            400,
            "invalid_request",
            `\`${name}\`: ${id} is a ${n.type}, not a ${type}`,
          );
      }
      return list;
    };
    const shelf =
      patch.shelf === undefined ? cur.shelf : want(ids(patch.shelf, "shelf"), "shelf", "notebook");
    const order =
      patch.order === undefined
        ? cur.ledger.order
        : want(ids(patch.order, "order"), "order", "claim");
    if (patch.bottom_line !== undefined && typeof patch.bottom_line !== "string")
      throw new HttpError(400, "invalid_request", "`bottom_line` is text");
    const bottom =
      patch.bottom_line === undefined ? cur.ledger.bottom_line : patch.bottom_line.trim();
    let next: VaultIndex;
    try {
      next = validateVaultIndex({
        schema_version: 1,
        project_id: pid,
        shelf,
        ledger: compact({ bottom_line: bottom || undefined, order }),
        updated_at: this.svc().now().toISOString(),
        updated_by: actor,
        revision: cur.revision + 1,
      });
    } catch (e) {
      if (e instanceof ProtocolValidationError)
        throw new HttpError(400, "invalid_request", e.message, { issues: e.issues.slice(0, 20) });
      throw e;
    }
    const path = join(this.dir(pid), "index.json");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeJsonAtomic(path, next, { validate: validateVaultIndex });
    p.index = next;
    const svc = this.svc();
    svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: opts.listener ?? "internal",
      action: "vault.index.updated",
      outcome: "allowed",
      project_id: pid,
      details: { revision: next.revision, fields: Object.keys(patch) },
    });
    svc.events.publish(pid, "vault.index.updated", { revision: next.revision, actor: actor.kind });
    return {
      index: next,
      checks: this.checks(pid).filter((c) => c.note === undefined),
    };
  }

  private saveReads(s: VaultReadState): void {
    const path = join(this.dir(s.project_id), "reads.json");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeJsonAtomic(path, s, { validate: validateVaultReadState });
    this.project(s.project_id).reads = s;
  }

  /**
   * The researcher read these notes (as they now stand), or wants them unread again; `forget`
   * clears every mark. Returns the status of each note named.
   */
  markRead(
    pid: string,
    input: { read?: readonly string[]; unread?: readonly string[]; forget?: boolean },
    actor: ResearchActor,
  ): Record<string, { state: ReadStatus; read_at?: string }> {
    const p = this.project(pid);
    const svc = this.svc();
    const notes = input.forget ? {} : { ...p.reads.notes };
    const at = svc.now().toISOString();
    const named = [...new Set([...(input.read ?? []), ...(input.unread ?? [])])];
    for (const id of input.read ?? []) {
      const n = p.notes.get(id);
      // A note deleted since the page loaded is not an error worth failing the batch for.
      if (!n || n.archived_at) continue;
      const digest = noteDigest(n);
      if (notes[id]?.digest !== digest) notes[id] = { digest, read_at: at };
    }
    for (const id of input.unread ?? []) delete notes[id];
    this.saveReads({ ...p.reads, notes });
    svc.events.publish(pid, "vault.reads.updated", {
      notes: named.length,
      forget: Boolean(input.forget),
    });
    svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: "human",
      action: "vault.reads.mark",
      outcome: "allowed",
      project_id: pid,
      details: {
        read: input.read?.length ?? 0,
        unread: input.unread?.length ?? 0,
        forget: Boolean(input.forget),
      },
    });
    const out: Record<string, { state: ReadStatus; read_at?: string }> = {};
    for (const id of named) {
      const n = p.notes.get(id);
      if (n) out[id] = this.readStatus(n);
    }
    return out;
  }

  // ---- figures (ADR 0053) ----------------------------------------------------------------------

  /**
   * The web UI reports how a figure fared when it drew it: an error comes back to the writer as
   * the `figure_error` check. Written only when it changes, so reading a vault does not write.
   */
  figureDrawn(
    pid: string,
    id: string,
    input: { revision?: unknown; error?: unknown },
  ): FigureDrawn {
    const n = this.require(pid, id);
    if (n.type !== "figure") throw new HttpError(400, "invalid_request", `${id} is not a figure`);
    if (input.revision !== n.revision)
      throw new HttpError(409, "revision_conflict", `${id} is at revision ${n.revision}`);
    const error =
      typeof input.error === "string" && input.error.trim()
        ? input.error.trim().slice(0, 2000)
        : undefined;
    const p = this.project(pid);
    const was = p.figures.get(id);
    if (was && was.revision === n.revision && was.error === error) return was;
    const now: FigureDrawn = {
      revision: n.revision,
      at: this.svc().now().toISOString(),
      ...(error ? { error } : {}),
    };
    p.figures.set(id, now);
    const path = join(this.dir(pid), "figures.json");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeJsonAtomic(path, {
      schema_version: 1,
      project_id: pid,
      figures: Object.fromEntries([...p.figures].sort(([a], [b]) => a.localeCompare(b))),
    });
    this.svc().events.publish(pid, "vault.figure.drawn", {
      note_id: id,
      revision: n.revision,
      ok: !error,
    });
    return now;
  }

  // ---- the library (ADR 0052) ----------------------------------------------------------------

  /** Every work, archived ones included. */
  allWorks(pid: string): VaultWork[] {
    return [...this.project(pid).works.values()];
  }

  getWork(pid: string, id: string): VaultWork | undefined {
    return this.project(pid).works.get(id);
  }

  requireWork(pid: string, id: string): VaultWork {
    const w = this.getWork(pid, id);
    if (!w) throw new HttpError(404, "not_found", `no work ${id} in this project's library`);
    return w;
  }

  private workBrief(w: VaultWork, uses: readonly WorkUse[] | undefined): WorkBrief {
    return compact({
      work_id: w.work_id,
      kind: w.kind,
      cite: shortCite(w),
      title: w.title,
      year: w.year,
      reading: w.reading,
      takeaway: w.takeaway,
      href: workHref(w),
      standing: workStanding(w, uses),
      roles: rolesOf(uses),
      cited_by: [...new Set((uses ?? []).map((u) => u.note.note_id))],
      task_id: w.task_id,
      updated_at: w.updated_at,
    }) as WorkBrief;
  }

  /**
   * The library as a list, newest change first. `q` matches title, authors, venue, what it says
   * and what was taken from it; `role` keeps the works cited in that role; `standing` the works
   * used, considered (read and set aside) or not read yet.
   */
  listWorks(
    pid: string,
    q: {
      q?: string;
      kind?: string;
      reading?: string;
      role?: string;
      standing?: string;
      task?: string;
      note?: string;
      archived?: boolean;
    } = {},
  ): WorkBrief[] {
    const uses = usesByWork(this.graph(pid).notes);
    return this.allWorks(pid)
      .filter((w) => (q.archived ? Boolean(w.archived_at) : !w.archived_at))
      .filter(
        (w) =>
          (!q.q?.trim() || workMatches(w, q.q)) &&
          (!q.kind || w.kind === q.kind) &&
          (!q.reading || w.reading === q.reading) &&
          (!q.task || w.task_id === q.task) &&
          (!q.role || (uses.get(w.work_id) ?? []).some((u) => u.role === q.role)) &&
          (!q.note || (uses.get(w.work_id) ?? []).some((u) => u.note.note_id === q.note)) &&
          (!q.standing || workStanding(w, uses.get(w.work_id)) === q.standing),
      )
      .sort(
        (a, b) => b.updated_at.localeCompare(a.updated_at) || a.work_id.localeCompare(b.work_id),
      )
      .map((w) => this.workBrief(w, uses.get(w.work_id)));
  }

  /** One work with every note that cites it and the role it plays there. */
  workView(pid: string, id: string) {
    const work = this.requireWork(pid, id);
    const uses = usesByWork(this.graph(pid).notes).get(id) ?? [];
    return {
      work,
      cite: shortCite(work),
      href: workHref(work),
      standing: workStanding(work, uses),
      roles: rolesOf(uses),
      cited_by: uses.map((u) =>
        compact({
          note_id: u.note.note_id,
          type: u.note.type,
          title: u.note.title,
          role: u.role,
          where: u.where,
          note: u.note_text,
        }),
      ),
      checks: this.checks(pid).filter((c) => c.work === id),
    };
  }

  private workInput(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (!(WORK_WRITABLE as readonly string[]).includes(k))
        throw new HttpError(400, "invalid_request", `\`${k}\` is not a field of a work`);
      if (v === undefined || v === null) continue;
      if (!WORK_REQUIRED.has(k) && (v === "" || (Array.isArray(v) && v.length === 0))) continue;
      out[k] = typeof v === "string" ? v.trim() : v;
    }
    return normaliseWork(out);
  }

  private checkedWork(pid: string, raw: Record<string, unknown>): VaultWork {
    const id = raw["work_id"] as string;
    let w: VaultWork;
    try {
      w = validateVaultWork(raw);
    } catch (e) {
      if (e instanceof ProtocolValidationError)
        throw new HttpError(400, "invalid_request", `${id}: ${e.message}`, {
          issues: e.issues.slice(0, 20),
        });
      throw e;
    }
    if (w.task_id && !this.svc().tasks.get(pid, w.task_id))
      throw new HttpError(
        400,
        "invalid_request",
        `${id}: task ${w.task_id} is not a task of this project`,
      );
    // The same work twice splits what is known about it: say which one exists.
    const keys = new Set(workKeys(w));
    for (const other of this.project(pid).works.values()) {
      if (other.work_id === id) continue;
      const same = workKeys(other).find((k) => keys.has(k));
      if (same)
        throw new HttpError(
          409,
          "work_exists",
          `${id}: the library has this work as \`${other.work_id}\` (${same})${other.archived_at ? ", archived: restore it" : ""}. Update that one and cite it`,
          { work_id: other.work_id },
        );
    }
    return w;
  }

  private saveWork(w: VaultWork): void {
    const path = join(this.dir(w.project_id), "works", `${w.work_id}.json`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeJsonAtomic(path, w, { validate: validateVaultWork });
    this.project(w.project_id).works.set(w.work_id, w);
  }

  private workChanged(
    w: VaultWork,
    type: string,
    actor: ResearchActor,
    listener: "human" | "agent" | undefined,
    fields?: string[],
  ): void {
    const svc = this.svc();
    svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: listener ?? "internal",
      action: type,
      outcome: "allowed",
      project_id: w.project_id,
      target: w.work_id,
      details: compact({ kind: w.kind, revision: w.revision, fields }),
    });
    svc.events.publish(w.project_id, type, {
      work_id: w.work_id,
      kind: w.kind,
      revision: w.revision,
      actor: actor.kind,
    });
  }

  private workResult(w: VaultWork) {
    return { work: w, checks: this.checks(w.project_id).filter((c) => c.work === w.work_id) };
  }

  private checkWorkId(pid: string, id: unknown): string {
    if (typeof id !== "string" || !WORK_ID.test(id))
      throw new HttpError(
        400,
        "invalid_request",
        "`id` is the work's citation key in kebab-case: the first author's family name, the year and a word of the title (`vaswani-2017-attention`), or owner and name for code (`karpathy-nanogpt`); at most 64 characters",
      );
    this.svc().registry.require(pid);
    return id;
  }

  addWork(
    pid: string,
    idIn: unknown,
    input: Record<string, unknown>,
    actor: ResearchActor,
    listener?: "human" | "agent",
  ) {
    const id = this.checkWorkId(pid, idIn);
    const p = this.project(pid);
    const cur = p.works.get(id);
    if (cur)
      throw new HttpError(
        409,
        "work_exists",
        `${id} is already in the library${cur.archived_at ? " (archived)" : ""}: update it, or choose another key for a different work`,
        { work_id: id },
      );
    const ts = this.svc().now().toISOString();
    const w = this.checkedWork(pid, {
      authors: [],
      ...this.workInput(input),
      schema_version: 1,
      work_id: id,
      project_id: pid,
      created_at: ts,
      updated_at: ts,
      created_by: actor,
      updated_by: actor,
      revision: 1,
    });
    this.saveWork(w);
    this.workChanged(w, "vault.work.created", actor, listener);
    return this.workResult(w);
  }

  updateWork(
    pid: string,
    id: string,
    patch: Record<string, unknown>,
    actor: ResearchActor,
    opts: { ifRevision?: number; listener?: "human" | "agent" } = {},
  ) {
    const cur = this.requireWork(pid, id);
    if (opts.ifRevision !== undefined && opts.ifRevision !== cur.revision)
      throw new HttpError(
        409,
        "revision_conflict",
        `${id} is at revision ${cur.revision}, not ${opts.ifRevision}`,
        { revision: cur.revision },
      );
    const next: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (!(WORK_WRITABLE as readonly string[]).includes(k))
        throw new HttpError(400, "invalid_request", `\`${k}\` is not a field of a work`);
      if (v === undefined || v === null) continue;
      const empty = v === "" || (Array.isArray(v) && v.length === 0);
      if (empty && !WORK_REQUIRED.has(k)) delete next[k];
      else next[k] = typeof v === "string" ? v.trim() : v;
    }
    const w = this.checkedWork(pid, {
      ...normaliseWork(next),
      updated_at: this.svc().now().toISOString(),
      updated_by: actor,
      revision: cur.revision + 1,
    });
    this.saveWork(w);
    this.workChanged(w, "vault.work.updated", actor, opts.listener, Object.keys(patch));
    return this.workResult(w);
  }

  /** Create or replace a work whole (an import): fields left out are cleared. */
  putWork(
    pid: string,
    idIn: unknown,
    input: Record<string, unknown>,
    actor: ResearchActor,
    listener?: "human" | "agent",
  ) {
    const id = this.checkWorkId(pid, idIn);
    const cur = this.project(pid).works.get(id);
    if (!cur) return { ...this.addWork(pid, id, input, actor, listener), created: true };
    const draft = this.checkedWork(pid, {
      authors: [],
      ...this.workInput(input),
      schema_version: 1,
      work_id: id,
      project_id: pid,
      created_at: cur.created_at,
      created_by: cur.created_by,
      updated_at: this.svc().now().toISOString(),
      updated_by: actor,
      revision: cur.revision + 1,
      ...(cur.archived_at ? { archived_at: cur.archived_at } : {}),
    });
    if (WORK_WRITABLE.every((k) => JSON.stringify(draft[k]) === JSON.stringify(cur[k])))
      return { ...this.workResult(cur), created: false, unchanged: true };
    this.saveWork(draft);
    this.workChanged(draft, "vault.work.updated", actor, listener, Object.keys(input));
    return { ...this.workResult(draft), created: false };
  }

  setWorkArchived(
    pid: string,
    id: string,
    archived: boolean,
    actor: ResearchActor,
    listener?: "human" | "agent",
  ) {
    const cur = this.requireWork(pid, id);
    const cited_by = [
      ...new Set((usesByWork(this.graph(pid).notes).get(id) ?? []).map((u) => u.note.note_id)),
    ];
    if (Boolean(cur.archived_at) === archived) return { work: cur, cited_by };
    const ts = this.svc().now().toISOString();
    const { archived_at: _, ...rest } = cur;
    const w = validateVaultWork({
      ...rest,
      ...(archived ? { archived_at: ts } : {}),
      updated_at: ts,
      updated_by: actor,
      revision: cur.revision + 1,
    });
    this.saveWork(w);
    this.workChanged(w, archived ? "vault.work.archived" : "vault.work.restored", actor, listener);
    // Notes that cite it now cite nothing the library holds: say so, so they get fixed.
    return { work: w, cited_by };
  }

  /** Human only. Notes that cite it keep the citation, which the checks then name. */
  removeWork(pid: string, id: string, actor: ResearchActor): VaultWork {
    const cur = this.requireWork(pid, id);
    const path = join(this.dir(pid), "works", `${id}.json`);
    rmSync(path, { force: true });
    rmSync(`${path}.bak`, { force: true });
    this.project(pid).works.delete(id);
    this.workChanged(cur, "vault.work.deleted", actor, "human");
    return cur;
  }

  /**
   * The library's citations: every live work (used or set aside), only the cited ones, or the
   * ones a notebook and the notes beneath it cite, with the role each played as the annotation.
   */
  citations(
    pid: string,
    opts: { format: CitationFormat; notebook?: string; cited?: boolean },
  ): { text: string; filename: string; content_type: string; count: number } {
    const vault = this.graph(pid);
    let only: Set<string> | undefined;
    let title = `${this.svc().registry.require(pid).name}: prior work`;
    if (opts.notebook) {
      const nb = vault.get(opts.notebook);
      if (!nb)
        throw new HttpError(404, "not_found", `no note ${opts.notebook} in this project's vault`);
      only = vault.under(nb.note_id);
      title = `${nb.title}: works cited`;
    }
    const entries = citationEntries(this.allWorks(pid), vault.notes, {
      ...(only ? { only } : {}),
      ...(opts.cited ? { cited: true } : {}),
    });
    const stem = `${pid}${opts.notebook ? `-${opts.notebook}` : ""}`;
    const [ext, type] =
      opts.format === "bibtex"
        ? ["bib", "application/x-bibtex; charset=utf-8"]
        : opts.format === "csl-json"
          ? ["json", "application/vnd.citationstyles.csl+json; charset=utf-8"]
          : ["md", "text/markdown; charset=utf-8"];
    return {
      text: renderCitations(opts.format, entries, title),
      filename: `${stem}.${ext}`,
      content_type: type,
      count: entries.length,
    };
  }

  // ---- tasks ---------------------------------------------------------------------------------

  /** Notes written under a task, or distilled from it. */
  ofTask(pid: string, taskId: string): VaultNote[] {
    return this.all(pid).filter(
      (n) => !n.archived_at && (n.task_id === taskId || n.sources.includes(`task:${taskId}`)),
    );
  }

  /**
   * Whether a notebook, anywhere beneath it, holds a note that cites runs as `evidence`. A live
   * reference in prose (ADR 0056) does not count: the completion gate is unchanged.
   */
  citesRuns(pid: string, notebookId: string): boolean {
    const vault = this.graph(pid);
    return [...vault.under(notebookId)].some((id) => (vault.get(id)?.evidence ?? []).length > 0);
  }

  // ---- runs set aside (ADR 0056) -------------------------------------------------------------

  setAsideMark(pid: string, runId: string): SetAsideMark | undefined {
    const m = this.project(pid).setAside.runs[runId];
    return m ? { reason: m.reason, at: m.at } : undefined;
  }

  /**
   * The agent sets a run aside with the reason it is not reported, or (an empty reason) takes the
   * mark back. The reason is the agent's account; the coordinator records who wrote it and when.
   */
  setAside(
    pid: string,
    run: { id: string; name?: string | undefined },
    reason: string,
    actor: ResearchActor,
    listener: "human" | "agent" | undefined,
  ): SetAsideMark | undefined {
    const svc = this.svc();
    const p = this.project(pid);
    const runs = { ...p.setAside.runs };
    const text = reason.trim();
    if (text.length > 1000)
      throw new HttpError(400, "invalid_request", "`set_aside` is at most 1000 characters");
    if (text)
      runs[run.id] = compact({
        reason: text,
        run_name: run.name,
        at: svc.now().toISOString(),
        by: compact({ kind: actor.kind, id: actor.id }),
      }) as VaultSetAside["runs"][string];
    else delete runs[run.id];
    const next: VaultSetAside = { ...p.setAside, runs };
    const path = join(this.dir(pid), "set-aside.json");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeJsonAtomic(path, next, { validate: validateVaultSetAside });
    p.setAside = next;
    svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: listener ?? "internal",
      action: text ? "vault.run.set_aside" : "vault.run.set_aside.clear",
      outcome: "allowed",
      project_id: pid,
      target: run.id,
      details: compact({ run_name: run.name }),
    });
    svc.events.publish(pid, "vault.run.set_aside", { mlflow_run_id: run.id, set: Boolean(text) });
    return this.setAsideMark(pid, run.id);
  }
}

/**
 * What a writer pastes for a locator, as the library stores it: a DOI without its resolver, an
 * arXiv ID without its prefix or URL, a year given as text.
 */
function normaliseWork(w: Record<string, unknown>): Record<string, unknown> {
  const out = { ...w };
  if (typeof out["doi"] === "string")
    out["doi"] = out["doi"].replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "");
  if (typeof out["arxiv"] === "string")
    out["arxiv"] = out["arxiv"]
      .replace(/^(https?:\/\/arxiv\.org\/(abs|pdf)\/|arxiv:\s*)/i, "")
      .replace(/\.pdf$/, "");
  if (typeof out["year"] === "string" && /^[0-9]{4}$/.test(out["year"]))
    out["year"] = Number(out["year"]);
  return out;
}
