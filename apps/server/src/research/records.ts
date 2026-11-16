/**
 * Coordinator-owned research records (spec §5.1 authority note, §6, §9; ADR 0013): hypotheses,
 * approaches, notes, reports, decisions, conversation links and study records.
 *
 *   state/<project>/research/records/<record-id>.json   ResearchRecord, one per file
 *   state/<project>/research/export.json                ResearchExportState
 *   state/<project>/research/drift/<ts>/<path>          hand edits found in the export, kept
 *
 * Canonical records live only here. After every change the coordinator rewrites the main
 * checkout's `.ablationkit/research/` and `.ablationkit/conversations/` (debounced), for the
 * researcher to commit. Those files are read exactly once, when a project is registered (or, for
 * projects registered before this stage, at the first start), and never from an agent worktree:
 * the coordinator only ever touches the registered main checkout path.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { compactTimestamp, readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type ObjectRef,
  ProtocolValidationError,
  RefKind,
  type ResearchActor,
  type ResearchExportState,
  type ResearchKind,
  type ResearchRecord,
  validateResearchExportState,
  validateResearchRecord,
} from "@ablationkit/protocol";
import type { JobService } from "../compute/jobs.ts";
import type { EventHub } from "../events.ts";
import { HttpError } from "../http.ts";
import type { AuditLog } from "../state/audit.ts";
import { compact } from "../state/audit.ts";
import type { ProjectRegistryService } from "../state/registry.ts";
import { isExportPath, parseExport, renderExport } from "./export.ts";
import type { TaskService } from "./tasks.ts";

export const RESEARCH_KINDS: readonly ResearchKind[] = [
  "hypothesis",
  "approach",
  "note",
  "report",
  "decision",
  "conversation",
  "study",
];

type Field =
  | "summary"
  | "body"
  | "attribution"
  | "evidence"
  | "follow_up"
  | "source"
  | "url"
  | "local_ref"
  | "conversation_created_at"
  | "export_notes"
  | "protocol"
  | "baseline_variant"
  | "variants"
  | "metric_goals";

interface KindRule {
  readonly prefix: string;
  readonly statuses?: readonly string[];
  readonly defaultStatus?: string;
  readonly fields: readonly Field[];
}

export const KIND_RULES: Record<ResearchKind, KindRule> = {
  hypothesis: {
    prefix: "hyp",
    statuses: ["proposed", "testing", "supported", "refuted", "inconclusive", "abandoned"],
    defaultStatus: "proposed",
    fields: ["summary", "body"],
  },
  approach: {
    prefix: "apr",
    statuses: ["proposed", "active", "adopted", "rejected", "parked"],
    defaultStatus: "proposed",
    fields: ["summary", "body"],
  },
  note: { prefix: "note", fields: ["summary", "body", "attribution"] },
  report: {
    prefix: "rep",
    statuses: ["draft", "final"],
    defaultStatus: "draft",
    fields: ["summary", "body", "evidence", "follow_up"],
  },
  decision: {
    prefix: "dec",
    statuses: ["proposed", "accepted", "superseded", "reverted"],
    defaultStatus: "proposed",
    fields: ["summary", "body", "evidence"],
  },
  conversation: {
    prefix: "conv",
    fields: ["source", "url", "local_ref", "conversation_created_at", "body", "export_notes"],
  },
  study: {
    prefix: "study",
    statuses: ["planned", "running", "complete", "abandoned"],
    defaultStatus: "planned",
    fields: ["summary", "body", "protocol", "baseline_variant", "variants", "metric_goals"],
  },
};

/** Fields the API may set; everything else is maintained by the coordinator. */
const EDITABLE = new Set<string>([
  "title",
  "status",
  "tags",
  "links",
  ...Object.values(KIND_RULES).flatMap((k) => k.fields),
]);
const RESERVED_IDS = new Set(["export", "reports", "lineage"]);
const REF_RESEARCH = new Set<string>(RESEARCH_KINDS);
const REF_KINDS: readonly string[] = RefKind.anyOf.map((k) => String(k.const));

export function isResearchKind(k: unknown): k is ResearchKind {
  return typeof k === "string" && REF_RESEARCH.has(k);
}

/** `kind:id` → ref (the ID may itself contain colons). */
export function parseRef(s: string): ObjectRef | undefined {
  const i = s.indexOf(":");
  if (i <= 0 || i === s.length - 1) return undefined;
  return { kind: s.slice(0, i) as ObjectRef["kind"], id: s.slice(i + 1) };
}

/** Every ref a record points at: links, evidence and a note's conversation attribution. */
export function outgoingRefs(r: ResearchRecord): ObjectRef[] {
  const refs = [...r.links, ...(r.evidence ?? []).map((e) => e.ref)];
  if (r.attribution) refs.push({ kind: "conversation", id: r.attribution.conversation_id });
  return refs;
}

export interface ListQuery {
  kind?: ResearchKind | undefined;
  tag?: string | undefined;
  status?: string | undefined;
  /** Case-insensitive substring of title, summary and body. */
  q?: string | undefined;
  /** Only records that point at this `kind:id`. */
  link?: string | undefined;
  source?: string | undefined;
  archived?: "exclude" | "include" | "only" | undefined;
  sort?: "updated" | "created" | "title" | undefined;
  order?: "asc" | "desc" | undefined;
}

export interface ExportResult {
  readonly written: string[];
  readonly removed: string[];
  readonly unchanged: number;
  readonly drift: { path: string; saved_to: string }[];
  readonly redactions: number;
  readonly skipped?: string;
}

export interface ResearchServiceOptions {
  readonly stateDir: string;
  readonly registry: ProjectRegistryService;
  readonly jobs: JobService;
  /** Task links must name a task of the project (ADR 0039). */
  readonly tasks: TaskService;
  readonly events: EventHub;
  readonly audit: AuditLog;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  /** Debounce before an export after a change. 0 exports synchronously. */
  readonly exportDelayMs?: number;
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Write a checkout file atomically (temp + rename), world-readable like any source file. */
function writeTextAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(4).toString("hex")}.ak-tmp`);
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** A Git linked worktree (or submodule) has a `.git` file rather than a directory. */
export function isLinkedWorktree(dir: string): boolean {
  try {
    const st = statSync(join(dir, ".git"));
    if (st.isDirectory()) return false;
    return /gitdir:.*\/worktrees\//.test(readFileSync(join(dir, ".git"), "utf8"));
  } catch {
    return false;
  }
}

export class ResearchService {
  private readonly records = new Map<string, Map<string, ResearchRecord>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly loadProblems: string[] = [];

  constructor(private readonly o: ResearchServiceOptions) {}

  private dir(pid: string): string {
    return join(this.o.stateDir, pid, "research");
  }

  private recordPath(pid: string, id: string): string {
    return join(this.dir(pid), "records", `${id}.json`);
  }

  /**
   * Drop a removed project's records and cancel its pending checkout export, which would
   * otherwise write `.ablationkit/research/` back into the checkout after removal.
   */
  forgetProject(pid: string): void {
    const t = this.timers.get(pid);
    if (t) clearTimeout(t);
    this.timers.delete(pid);
    this.records.delete(pid);
  }

  private project(pid: string): Map<string, ResearchRecord> {
    let m = this.records.get(pid);
    if (!m) {
      m = new Map();
      this.records.set(pid, m);
    }
    return m;
  }

  /** Scan every project's record files (spec §6: rebuild lookups from small canonical files). */
  load(): void {
    this.records.clear();
    if (!existsSync(this.o.stateDir)) return;
    for (const pid of readdirSync(this.o.stateDir)) {
      const dir = join(this.dir(pid), "records");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json") || f.startsWith(".")) continue;
        try {
          const r = readJson(join(dir, f), validateResearchRecord);
          if (r.project_id !== pid || `${r.record_id}.json` !== f)
            throw new Error("project or record ID does not match its path");
          this.project(pid).set(r.record_id, r);
        } catch (e) {
          this.loadProblems.push(`${join(dir, f)}: ${(e as Error).message}`);
        }
      }
    }
  }

  private save(r: ResearchRecord): void {
    const p = this.recordPath(r.project_id, r.record_id);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeJsonAtomic(p, r, { validate: validateResearchRecord });
    this.project(r.project_id).set(r.record_id, r);
  }

  all(pid: string): ResearchRecord[] {
    return [...(this.records.get(pid)?.values() ?? [])];
  }

  get(pid: string, id: string): ResearchRecord | undefined {
    return this.records.get(pid)?.get(id);
  }

  require(pid: string, id: string): ResearchRecord {
    this.o.registry.require(pid);
    const r = this.get(pid, id);
    if (!r) throw new HttpError(404, "not_found", `no research record ${id} in ${pid}`);
    return r;
  }

  list(pid: string, q: ListQuery = {}): ResearchRecord[] {
    this.o.registry.require(pid);
    const needle = q.q?.toLowerCase();
    const archived = q.archived ?? "exclude";
    const link = q.link ? parseRef(q.link) : undefined;
    const out = this.all(pid).filter((r) => {
      if (q.kind && r.kind !== q.kind) return false;
      if (q.tag && !r.tags.includes(q.tag)) return false;
      if (q.status && r.status !== q.status) return false;
      if (q.source && r.source !== q.source) return false;
      if (archived === "exclude" && r.archived_at) return false;
      if (archived === "only" && !r.archived_at) return false;
      if (link && !outgoingRefs(r).some((x) => x.kind === link.kind && x.id === link.id))
        return false;
      if (needle) {
        const hay = `${r.title}\n${r.summary ?? ""}\n${r.body ?? ""}\n${r.url ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    const sort = q.sort ?? "updated";
    const dir = (q.order ?? (sort === "title" ? "asc" : "desc")) === "asc" ? 1 : -1;
    const key = (r: ResearchRecord) =>
      sort === "title" ? r.title.toLowerCase() : sort === "created" ? r.created_at : r.updated_at;
    // Ties (same millisecond, same title) break on the ID, so order survives a reload from disk.
    return out.sort((a, b) =>
      key(a) < key(b)
        ? -dir
        : key(a) > key(b)
          ? dir
          : a.record_id < b.record_id
            ? -dir
            : a.record_id > b.record_id
              ? dir
              : 0,
    );
  }

  /** Records that point at `ref` (links, evidence, attribution). */
  backlinks(pid: string, ref: { kind: string; id: string }): ResearchRecord[] {
    return this.all(pid).filter((r) =>
      outgoingRefs(r).some((x) => x.kind === ref.kind && x.id === ref.id),
    );
  }

  private newId(pid: string, kind: ResearchKind): string {
    const date = this.o.now().toISOString().slice(0, 10).replace(/-/g, "");
    for (;;) {
      const id = `${KIND_RULES[kind].prefix}-${date}-${randomBytes(3).toString("hex")}`;
      if (!this.get(pid, id)) return id;
    }
  }

  /** Check an API payload against the kind's field set and cross-record rules. */
  private checkInput(pid: string, kind: ResearchKind, input: Record<string, unknown>): void {
    const rule = KIND_RULES[kind];
    for (const k of Object.keys(input)) {
      if (!EDITABLE.has(k))
        throw new HttpError(400, "invalid_request", `\`${k}\` cannot be set through the API`);
      if (!["title", "status", "tags", "links"].includes(k) && !rule.fields.includes(k as Field))
        throw new HttpError(400, "invalid_request", `a ${kind} has no \`${k}\` field`);
      if (input[k] === null)
        throw new HttpError(400, "invalid_request", `omit \`${k}\` instead of sending null`);
    }
    if (input["status"] !== undefined) {
      if (!rule.statuses) throw new HttpError(400, "invalid_request", `a ${kind} has no status`);
      if (!rule.statuses.includes(String(input["status"])))
        throw new HttpError(
          400,
          "invalid_request",
          `status must be one of ${rule.statuses.join(", ")}`,
        );
    }
    const links = input["links"];
    if (links !== undefined) {
      if (!Array.isArray(links))
        throw new HttpError(400, "invalid_request", "`links` must be an array");
      for (const l of links as ObjectRef[]) this.checkRef(pid, l);
    }
    const ev = input["evidence"];
    if (Array.isArray(ev))
      for (const e of ev as { ref?: ObjectRef }[]) if (e?.ref) this.checkRef(pid, e.ref);
    const att = input["attribution"] as { conversation_id?: string } | undefined;
    if (att?.conversation_id !== undefined) {
      const c = this.get(pid, att.conversation_id);
      if (c?.kind !== "conversation")
        throw new HttpError(
          422,
          "unknown_link",
          `attribution names ${att.conversation_id}, which is not a conversation link in ${pid}`,
        );
    }
  }

  /**
   * Links to research records, jobs, attempts and tasks must resolve: lineage is
   * never fabricated. Runs, artifacts and other objects are not checked here (MLflow may be
   * offline).
   */
  private checkRef(pid: string, ref: ObjectRef): void {
    if (!ref || typeof ref !== "object" || typeof ref.id !== "string")
      throw new HttpError(400, "invalid_request", "each link needs `kind` and `id`");
    if (!REF_KINDS.includes(ref.kind))
      throw new HttpError(
        400,
        "invalid_request",
        `unknown link kind ${String(ref.kind).slice(0, 64)}; a link is KIND:ID with KIND one of ${REF_KINDS.join(", ")}`,
      );
    if (REF_RESEARCH.has(ref.kind)) {
      const r = this.get(pid, ref.id);
      if (!r || r.kind !== ref.kind)
        throw new HttpError(422, "unknown_link", `no ${ref.kind} ${ref.id} in ${pid}`);
    } else if (ref.kind === "job") {
      const j = this.o.jobs.get(ref.id);
      if (!j || j.project_id !== pid)
        throw new HttpError(422, "unknown_link", `no job ${ref.id} in ${pid}`);
    } else if (ref.kind === "attempt") {
      const a = this.o.jobs.attempt(ref.id);
      if (!a || a.project_id !== pid)
        throw new HttpError(422, "unknown_link", `no attempt ${ref.id} in ${pid}`);
    } else if (ref.kind === "task") {
      if (!this.o.tasks.get(pid, ref.id))
        throw new HttpError(422, "unknown_link", `no task ${ref.id} in ${pid}`);
    }
  }

  private checkStudy(r: ResearchRecord): void {
    if (r.kind !== "study") return;
    const ids = (r.variants ?? []).map((v) => v.variant_id);
    if (new Set(ids).size !== ids.length)
      throw new HttpError(400, "invalid_request", "variant IDs must be unique");
    if (r.baseline_variant && ids.length && !ids.includes(r.baseline_variant))
      throw new HttpError(
        400,
        "invalid_request",
        `baseline ${r.baseline_variant} is not one of the variants`,
      );
  }

  private checkConversation(r: ResearchRecord): void {
    if (r.kind !== "conversation") return;
    if (!r.source)
      throw new HttpError(400, "invalid_request", "a conversation link needs `source`");
    if (!r.url && !r.local_ref)
      throw new HttpError(400, "invalid_request", "a conversation link needs `url` or `local_ref`");
  }

  private validated(r: ResearchRecord): ResearchRecord {
    try {
      validateResearchRecord(r);
    } catch (e) {
      if (e instanceof ProtocolValidationError)
        throw new HttpError(400, "invalid_request", e.message, { issues: e.issues.slice(0, 20) });
      throw e;
    }
    this.checkStudy(r);
    this.checkConversation(r);
    return r;
  }

  create(
    pid: string,
    kind: ResearchKind,
    input: Record<string, unknown>,
    actor: ResearchActor,
    opts: {
      id?: string;
      generated?: ResearchRecord["generated"];
      listener?: "human" | "agent";
    } = {},
  ): ResearchRecord {
    this.o.registry.require(pid);
    if (!isResearchKind(kind)) throw new HttpError(400, "invalid_request", "unknown `kind`");
    this.checkInput(pid, kind, input);
    let id = opts.id;
    if (id !== undefined) {
      if (kind !== "study")
        throw new HttpError(
          400,
          "invalid_request",
          "only a study takes a chosen `id` (its study_id tag)",
        );
      if (RESERVED_IDS.has(id)) throw new HttpError(400, "invalid_request", `${id} is reserved`);
      if (this.get(pid, id)) throw new HttpError(409, "record_exists", `${id} already exists`);
    } else id = this.newId(pid, kind);
    const ts = this.o.now().toISOString();
    const rule = KIND_RULES[kind];
    const r = this.validated(
      compact({
        schema_version: 1 as const,
        record_id: id,
        project_id: pid,
        kind,
        tags: [],
        links: [],
        ...(rule.defaultStatus ? { status: rule.defaultStatus } : {}),
        ...(input as Partial<ResearchRecord>),
        generated: opts.generated,
        created_at: ts,
        updated_at: ts,
        created_by: actor,
        updated_by: actor,
        revision: 1,
      }) as ResearchRecord,
    );
    this.save(r);
    this.changed(r, "research.created", actor, opts.listener);
    return r;
  }

  update(
    pid: string,
    id: string,
    patch: Record<string, unknown>,
    actor: ResearchActor,
    opts: {
      ifRevision?: number;
      generated?: ResearchRecord["generated"];
      unset?: readonly string[];
      listener?: "human" | "agent";
    } = {},
  ): ResearchRecord {
    const cur = this.require(pid, id);
    if (opts.ifRevision !== undefined && opts.ifRevision !== cur.revision)
      throw new HttpError(
        409,
        "revision_conflict",
        `${id} is at revision ${cur.revision}, not ${opts.ifRevision}`,
        {
          revision: cur.revision,
        },
      );
    this.checkInput(pid, cur.kind, patch);
    const next: Record<string, unknown> = { ...cur, ...patch };
    for (const k of opts.unset ?? []) {
      if (!EDITABLE.has(k) || ["title", "tags", "links"].includes(k))
        throw new HttpError(400, "invalid_request", `\`${k}\` cannot be cleared`);
      delete next[k];
    }
    if (opts.generated) next["generated"] = opts.generated;
    const r = this.validated({
      ...(next as ResearchRecord),
      updated_at: this.o.now().toISOString(),
      updated_by: actor,
      revision: cur.revision + 1,
    });
    this.save(r);
    this.changed(r, "research.updated", actor, opts.listener, Object.keys(patch));
    return r;
  }

  setArchived(
    pid: string,
    id: string,
    archived: boolean,
    actor: ResearchActor,
    listener?: "human" | "agent",
  ): ResearchRecord {
    const cur = this.require(pid, id);
    if (Boolean(cur.archived_at) === archived) return cur;
    const ts = this.o.now().toISOString();
    const { archived_at: _, ...rest } = cur;
    const r = this.validated({
      ...rest,
      ...(archived ? { archived_at: ts } : {}),
      updated_at: ts,
      updated_by: actor,
      revision: cur.revision + 1,
    });
    this.save(r);
    this.changed(r, archived ? "research.archived" : "research.restored", actor, listener);
    return r;
  }

  /** Human-only: remove a record. Records that point at it keep a dangling link, shown as missing. */
  remove(pid: string, id: string, actor: ResearchActor): ResearchRecord {
    const cur = this.require(pid, id);
    rmSync(this.recordPath(pid, id), { force: true });
    rmSync(`${this.recordPath(pid, id)}.bak`, { force: true });
    this.records.get(pid)?.delete(id);
    this.changed(cur, "research.deleted", actor, "human");
    return cur;
  }

  private changed(
    r: ResearchRecord,
    type: string,
    actor: ResearchActor,
    listener: "human" | "agent" | undefined,
    fields?: string[],
  ): void {
    this.o.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: listener ?? "internal",
      action: type,
      outcome: "allowed",
      project_id: r.project_id,
      target: r.record_id,
      details: compact({ kind: r.kind, revision: r.revision, fields }),
    });
    this.o.events.publish(r.project_id, type, {
      record_id: r.record_id,
      kind: r.kind,
      revision: r.revision,
      actor: actor.kind,
    });
    this.scheduleExport(r.project_id);
  }

  // ---- export / import ---------------------------------------------------------------------

  private statePath(pid: string): string {
    return join(this.dir(pid), "export.json");
  }

  exportState(pid: string): ResearchExportState {
    try {
      return readJson(this.statePath(pid), validateResearchExportState);
    } catch {
      return { schema_version: 1, project_id: pid, drift: [], files: {} };
    }
  }

  private saveState(s: ResearchExportState): void {
    mkdirSync(this.dir(s.project_id), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.statePath(s.project_id), s, { validate: validateResearchExportState });
  }

  scheduleExport(pid: string): void {
    const delay = this.o.exportDelayMs ?? 250;
    if (delay <= 0) {
      this.exportSafely(pid);
      return;
    }
    if (this.timers.has(pid)) return;
    this.timers.set(
      pid,
      setTimeout(() => {
        this.timers.delete(pid);
        this.exportSafely(pid);
      }, delay),
    );
  }

  /** Run pending exports now (shutdown, tests). */
  flush(): void {
    for (const [pid, t] of [...this.timers]) {
      clearTimeout(t);
      this.timers.delete(pid);
      this.exportSafely(pid);
    }
  }

  private exportSafely(pid: string): void {
    try {
      this.exportNow(pid);
    } catch (e) {
      this.o.log(`research export for ${pid} failed: ${(e as Error).message}`);
    }
  }

  /**
   * Rewrite the export in the registered main checkout. A file whose content differs from what
   * the last export wrote was edited by hand: it is copied into the state directory (and listed
   * in the inbox) before being replaced. Only files AblationKit wrote are ever removed.
   */
  exportNow(pid: string): ExportResult {
    const p = this.o.registry.get(pid);
    if (!p)
      return {
        written: [],
        removed: [],
        unchanged: 0,
        drift: [],
        redactions: 0,
        skipped: "project is not registered",
      };
    const state = this.exportState(pid);
    const root = join(p.path, ".ablationkit");
    const ts = this.o.now();
    if (!existsSync(p.path)) {
      const msg = `checkout ${p.path} is missing`;
      this.saveState({ ...state, last_export_error: msg });
      return { written: [], removed: [], unchanged: 0, drift: [], redactions: 0, skipped: msg };
    }
    const { files, redactions } = renderExport(this.all(pid));
    const written: string[] = [];
    const removed: string[] = [];
    const drift: { path: string; saved_to: string }[] = [];
    let unchanged = 0;
    const keep = (rel: string, current: string) => {
      const dest = join(this.dir(pid), "drift", compactTimestamp(ts), rel);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writeTextAtomic(dest, current);
      drift.push({ path: rel, saved_to: dest });
    };
    const nextFiles: Record<string, string> = {};
    for (const [rel, text] of files) {
      const abs = join(root, rel);
      const current = readText(abs);
      const hash = sha256(text);
      nextFiles[rel] = hash;
      if (current === text) {
        unchanged++;
        continue;
      }
      if (current !== undefined && sha256(current) !== state.files[rel]) keep(rel, current);
      writeTextAtomic(abs, text);
      written.push(rel);
    }
    for (const rel of Object.keys(state.files)) {
      if (files.has(rel) || !isExportPath(rel)) continue;
      const abs = join(root, rel);
      const current = readText(abs);
      if (current === undefined) continue;
      if (sha256(current) !== state.files[rel]) keep(rel, current);
      rmSync(abs, { force: true });
      removed.push(rel);
    }
    const allDrift = [
      ...drift.map((d) => ({ ...d, detected_at: ts.toISOString() })),
      ...state.drift,
    ].slice(0, 200);
    const { last_export_error: _e, ...rest } = state;
    this.saveState({
      ...rest,
      last_export_at: ts.toISOString(),
      last_export_redactions: redactions,
      drift: allDrift,
      files: nextFiles,
    });
    if (written.length || removed.length) {
      this.o.events.publish(pid, "research.exported", {
        written: written.length,
        removed: removed.length,
        drift: drift.length,
        redactions,
      });
    }
    for (const d of drift)
      this.o.audit.record({
        actor: { kind: "system" },
        listener: "internal",
        action: "research.export.drift",
        outcome: "allowed",
        project_id: pid,
        target: d.path,
        reason:
          "export file was edited outside AblationKit; the edit was saved and the file rewritten",
        details: { saved_to: d.saved_to },
      });
    return { written, removed, unchanged, drift, redactions };
  }

  /** Forget listed drift (the researcher has looked at it). */
  clearDrift(pid: string): void {
    this.o.registry.require(pid);
    this.saveState({ ...this.exportState(pid), drift: [] });
  }

  /**
   * Import an existing export once. Runs on registration, and at startup for projects that were
   * registered before research records existed. Never reads a linked worktree.
   */
  importOnce(pid: string): { imported: number; problems: string[]; note: string } {
    const p = this.o.registry.require(pid);
    const state = this.exportState(pid);
    if (state.imported_at) return { imported: 0, problems: [], note: "already imported" };
    const finish = (imported: number, note: string, problems: string[] = []) => {
      this.saveState({
        ...this.exportState(pid),
        imported_at: this.o.now().toISOString(),
        imported_records: imported,
        import_note: note.slice(0, 2000),
      });
      return { imported, problems, note };
    };
    if (this.all(pid).length > 0)
      return finish(0, "skipped: the coordinator already holds research records for this project");
    if (isLinkedWorktree(p.path))
      return finish(0, `skipped: ${p.path} is a linked Git worktree, not the main checkout`);
    const root = join(p.path, ".ablationkit");
    const parsed = parseExport(
      pid,
      (rel) => readText(join(root, rel)),
      (dir) => {
        try {
          return readdirSync(join(root, dir));
        } catch {
          return [];
        }
      },
    );
    for (const r of parsed.records) this.save(r);
    for (const msg of parsed.problems) this.o.log(`research import ${pid}: ${msg}`);
    const result = finish(
      parsed.records.length,
      parsed.records.length || parsed.problems.length
        ? `imported ${parsed.records.length} record(s) from ${root}${parsed.problems.length ? `; ${parsed.problems.length} problem(s)` : ""}`
        : "no existing export",
      parsed.problems,
    );
    this.o.audit.record({
      actor: { kind: "system" },
      listener: "internal",
      action: "research.import",
      outcome: "allowed",
      project_id: pid,
      target: root,
      details: { imported: parsed.records.length, problems: parsed.problems.slice(0, 20) },
    });
    if (parsed.records.length) {
      this.o.events.publish(pid, "research.imported", { records: parsed.records.length });
    }
    // Problem files are kept: the next export treats them as hand edits and saves them first.
    if (parsed.records.length || parsed.problems.length) this.scheduleExport(pid);
    return result;
  }

  stop(): void {
    this.flush();
  }
}
