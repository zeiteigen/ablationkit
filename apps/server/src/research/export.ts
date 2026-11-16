/**
 * The main-checkout export of coordinator-owned research records (spec §5.1 authority note,
 * ADR 0013). Pure rendering and parsing; `ResearchService` decides when to write and read.
 *
 *   .ablationkit/research/hypotheses.json   approaches.json   decisions.json   studies.json
 *   .ablationkit/research/notes/<date>-<slug>.md
 *   .ablationkit/research/reports/<date>-<slug>.md
 *   .ablationkit/conversations/references.json
 *
 * Every file carries the full record, so the one-time import on registration is lossless, except
 * a conversation's personal notes, which are exported only when `export_notes` is set (spec §9).
 * Fields that look like secrets are replaced in the export (never in the canonical record).
 */
import {
  type ResearchKind,
  type ResearchRecord,
  validateResearchRecord,
} from "@ablationkit/protocol";
import { slugify } from "../state/registry.ts";

export const EXPORT_NOTICE =
  "Exported by AblationKit from the coordinator's research records. Edits here are not read back: use the UI or `ablationkit research`.";

const JSON_FILES: Partial<Record<ResearchKind, string>> = {
  hypothesis: "research/hypotheses.json",
  approach: "research/approaches.json",
  decision: "research/decisions.json",
  study: "research/studies.json",
  conversation: "conversations/references.json",
};
const MD_DIRS: Partial<Record<ResearchKind, string>> = {
  note: "research/notes",
  report: "research/reports",
};

/** Every path the export may own, relative to `.ablationkit/`. */
export function isExportPath(rel: string): boolean {
  return (
    Object.values(JSON_FILES).includes(rel) || /^research\/(notes|reports)\/[^/]+\.md$/.test(rel)
  );
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|rk)-(proj-|ant-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export const REDACTED =
  "[withheld from the Git export: this field looks like it contains a secret]";

/** Replace secret-looking strings anywhere in `value`. Returns the copy and how many it replaced. */
function redact<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (looksSecret(v)) {
        count++;
        return REDACTED;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value) as T, count };
}

function exportable(r: ResearchRecord): ResearchRecord {
  if (r.kind === "conversation" && !r.export_notes) {
    const { body: _private, ...rest } = r;
    return rest;
  }
  return r;
}

function byCreated(a: ResearchRecord, b: ResearchRecord): number {
  return a.created_at < b.created_at
    ? -1
    : a.created_at > b.created_at
      ? 1
      : a.record_id.localeCompare(b.record_id);
}

/** JSON inside an HTML comment must not close it. */
function commentJson(v: unknown): string {
  return JSON.stringify(v).replace(/-->/g, "--\\u003e");
}

const BODY_MARKER = "<!-- ablationkit:body -->";
const META_RE = /^<!-- ablationkit:record (.*) -->$/;

function fmtEvidenceRow(e: NonNullable<ResearchRecord["evidence"]>[number]): string {
  const vals = Object.entries(e.values ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const cell = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return `| ${cell(e.role)} | ${cell(e.variant_id)} | ${e.ref.kind} \`${cell(e.ref.id)}\` | ${cell(e.attempt_id)} | ${e.source_commit ? `\`${e.source_commit.slice(0, 12)}\`${e.source_dirty ? " (dirty)" : ""}` : ""} | ${cell(vals)} |`;
}

function renderMarkdown(r: ResearchRecord): string {
  const { body, ...meta } = r;
  const out: string[] = [
    `<!-- ablationkit:record ${commentJson(meta)} -->`,
    `<!-- ${EXPORT_NOTICE} -->`,
    "",
    `# ${r.title.replace(/\n/g, " ")}`,
    "",
  ];
  const facts = [
    `ID \`${r.record_id}\``,
    r.status ? `status ${r.status}` : undefined,
    r.tags.length ? `tags ${r.tags.join(", ")}` : undefined,
    `${r.created_by.kind}, ${r.created_at}`,
    r.archived_at ? `archived ${r.archived_at}` : undefined,
  ].filter(Boolean);
  out.push(`_${facts.join(" · ")}_`, "");
  if (r.attribution)
    out.push(
      `> ${r.attribution.mode === "quote" ? "Quoted from" : "Summarized from"} conversation \`${r.attribution.conversation_id}\`.`,
      "",
    );
  if (r.links.length) {
    out.push("Links:", "");
    for (const l of r.links) out.push(`- ${l.kind} \`${l.id}\`${l.label ? ` (${l.label})` : ""}`);
    out.push("");
  }
  if (r.kind === "report") {
    if (r.summary) out.push("## Evidence summary", "", r.summary, "");
    if (r.evidence?.length) {
      out.push(
        "## Evidence",
        "",
        "| Role | Variant | Object | Attempt | Source | Values |",
        "| --- | --- | --- | --- | --- | --- |",
        ...r.evidence.map(fmtEvidenceRow),
        "",
      );
    }
    if (r.follow_up) out.push("## Follow-up", "", r.follow_up, "");
    out.push("## Interpretation", "");
  } else if (r.summary) out.push(r.summary, "");
  // The body follows the marker verbatim, plus one newline the parser removes: lossless.
  // Display text above the marker is never parsed (the header JSON is), so neutralize any copy
  // of the marker there; the header JSON cannot contain it because `-->` is escaped.
  const head = out.join("\n").split(BODY_MARKER).join("<!-- ablationkit body -->");
  return `${head}\n${BODY_MARKER}\n${body ?? ""}\n`;
}

function renderJson(kind: ResearchKind, records: readonly ResearchRecord[]): string {
  return `${JSON.stringify(
    { schema_version: 1, kind, exported_by: "ablationkit", notice: EXPORT_NOTICE, records },
    null,
    2,
  )}\n`;
}

/** `<date>-<slug>.md`, made unique in creation order. */
function mdNames(records: readonly ResearchRecord[]): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const r of [...records].sort(byCreated)) {
    const base = `${r.created_at.slice(0, 10)}-${slugify(r.title)}`;
    let name = `${base}.md`;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}.md`;
    used.add(name);
    names.set(r.record_id, name);
  }
  return names;
}

export interface RenderedExport {
  /** Path relative to `.ablationkit/` → file content. */
  readonly files: Map<string, string>;
  readonly redactions: number;
}

export function renderExport(all: readonly ResearchRecord[]): RenderedExport {
  const files = new Map<string, string>();
  let redactions = 0;
  const safe = all
    .map(exportable)
    .map((r) => {
      const x = redact(r);
      redactions += x.count;
      return x.value;
    })
    .sort(byCreated);
  for (const [kind, path] of Object.entries(JSON_FILES) as [ResearchKind, string][]) {
    const mine = safe.filter((r) => r.kind === kind);
    if (mine.length) files.set(path, renderJson(kind, mine));
  }
  for (const [kind, dir] of Object.entries(MD_DIRS) as [ResearchKind, string][]) {
    const mine = safe.filter((r) => r.kind === kind);
    const names = mdNames(mine);
    for (const r of mine) files.set(`${dir}/${names.get(r.record_id)}`, renderMarkdown(r));
  }
  return { files, redactions };
}

export interface ParsedExport {
  readonly records: ResearchRecord[];
  readonly problems: string[];
}

/**
 * Read an export back (one-time import). `read(rel)` returns a file's text or undefined;
 * `list(dir)` returns file names in a directory. Records are re-bound to `projectId`.
 */
export function parseExport(
  projectId: string,
  read: (rel: string) => string | undefined,
  list: (dir: string) => string[],
): ParsedExport {
  const records: ResearchRecord[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const accept = (raw: unknown, where: string) => {
    try {
      const r = validateResearchRecord({ ...(raw as object), project_id: projectId });
      if (seen.has(r.record_id)) {
        problems.push(`${where}: duplicate record ${r.record_id} skipped`);
        return;
      }
      seen.add(r.record_id);
      records.push(r);
    } catch (e) {
      problems.push(`${where}: ${(e as Error).message}`);
    }
  };
  for (const [kind, path] of Object.entries(JSON_FILES) as [ResearchKind, string][]) {
    const text = read(path);
    if (text === undefined) continue;
    try {
      const doc = JSON.parse(text) as { records?: unknown[] };
      if (!Array.isArray(doc.records)) throw new Error("no `records` array");
      for (const [i, raw] of doc.records.entries()) {
        if ((raw as { kind?: string })?.kind !== kind) {
          problems.push(`${path}[${i}]: kind is not ${kind}`);
          continue;
        }
        accept(raw, `${path}[${i}]`);
      }
    } catch (e) {
      problems.push(`${path}: ${(e as Error).message}`);
    }
  }
  for (const [kind, dir] of Object.entries(MD_DIRS) as [ResearchKind, string][]) {
    for (const name of list(dir)
      .filter((n) => n.endsWith(".md"))
      .sort()) {
      const path = `${dir}/${name}`;
      const text = read(path) ?? "";
      const first = text.split("\n", 1)[0] ?? "";
      const m = META_RE.exec(first);
      if (!m) {
        problems.push(`${path}: no AblationKit record header; not imported`);
        continue;
      }
      try {
        const meta = JSON.parse(m[1] as string) as Record<string, unknown>;
        if (meta["kind"] !== kind) throw new Error(`kind is not ${kind}`);
        // The first marker is ours; a body may itself contain the marker text.
        const i = text.indexOf(`\n${BODY_MARKER}\n`);
        const body = i < 0 ? "" : text.slice(i + BODY_MARKER.length + 2).replace(/\n$/, "");
        accept(body ? { ...meta, body } : meta, path);
      } catch (e) {
        problems.push(`${path}: ${(e as Error).message}`);
      }
    }
  }
  return { records, problems };
}
