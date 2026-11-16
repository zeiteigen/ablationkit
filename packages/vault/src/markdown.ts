/**
 * The vault as Markdown files an Obsidian user would recognise: one note per file, YAML
 * frontmatter, the summary, then `<!-- full -->` and the full text, and for a figure (ADR 0053)
 * `<!-- figure -->` and its script in a fenced block; an `index.yaml` for the
 * shelf and the ledger; and one file per work of the library (`works/<id>.md`: frontmatter, then
 * what the work says). Used by `ablationkit vault import` and `export`. Bun only (`Bun.YAML`):
 * the browser does not import this module.
 */
import type { VaultNote, VaultWork } from "@ablationkit/protocol";

/** The fields of a note someone writes; the rest is the coordinator's bookkeeping. */
export const NOTE_FIELDS = [
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
export type NoteField = (typeof NOTE_FIELDS)[number];
export type NoteInput = Partial<Pick<VaultNote, NoteField>>;

const FRONT = [
  "type",
  "title",
  "gist",
  "standing",
  "key",
  "support",
  "would_change",
  "evidence",
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
const MARKER = /^<!--\s*full\s*-->\s*$/m;
const FIGURE_MARKER = /^<!--\s*figure\s*-->\s*$/m;
/** The fenced block after the figure marker: its fence, its info string and the script. */
const FIGURE_BLOCK = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/;

const day = (v: unknown): unknown => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

/** A file's YAML frontmatter, its ID and the text after it. */
function frontmatter(
  text: string,
  fileId: string | undefined,
): { fm: Record<string, unknown>; id: string; rest: string; raw: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("no frontmatter (the file starts with `---`)");
  let fm: Record<string, unknown>;
  try {
    fm = (Bun.YAML.parse(m[1] ?? "") ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `the frontmatter is not valid YAML (${(e as Error).message}); quote strings that contain ": "`,
    );
  }
  if (typeof fm !== "object" || Array.isArray(fm)) throw new Error("the frontmatter is not a map");
  const id = typeof fm["id"] === "string" ? fm["id"] : fileId;
  if (!id) throw new Error("no `id`");
  if (fileId && id !== fileId) throw new Error(`frontmatter id "${id}" is not the file name`);
  return { fm, id, rest: (m[2] ?? "").replace(/\r\n/g, "\n").trim(), raw: m[1] ?? "" };
}

/** A note file's frontmatter and text. Throws with a message a writer can act on. */
export function parseNoteMarkdown(text: string, fileId?: string): { id: string; note: NoteInput } {
  const { fm, id, rest: all } = frontmatter(text, fileId);
  let text2 = all;
  let script: string | undefined;
  const at = all.search(FIGURE_MARKER);
  if (at >= 0) {
    const block = FIGURE_BLOCK.exec(all.slice(at).replace(FIGURE_MARKER, ""));
    if (!block)
      throw new Error(
        "`<!-- figure -->` is followed by one fenced code block: the figure's script",
      );
    script = block[2];
    text2 = all.slice(0, at).trim();
  }
  const cut = text2.search(MARKER);
  let summary = (cut < 0 ? text2 : text2.slice(0, cut)).trim();
  let full = cut < 0 ? "" : text2.slice(cut).replace(MARKER, "").trim();
  // A notebook without the marker: its opening paragraph is the summary and everything after it
  // (connecting prose, embeds, headings) is the composition, the full text.
  if (cut < 0 && fm["type"] === "notebook") {
    const [first = "", ...rest] = text2.split(/\n{2,}/);
    const opens = !/^(?:!\[\[[^\]]+\]\]\s*|#{1,6}\s.*)$/m.test(first);
    summary = opens ? first.trim() : "";
    full = (opens ? rest : [first, ...rest]).join("\n\n").trim();
  }
  const note: Record<string, unknown> = {};
  for (const k of FRONT) if (fm[k] !== undefined && fm[k] !== null) note[k] = day(fm[k]);
  if (summary) note["summary"] = summary;
  if (full) note["full"] = full;
  if (script?.trim()) note["figure"] = { script };
  note["sources"] = ((fm["sources"] as unknown[] | undefined) ?? []).map(String);
  return { id, note: note as NoteInput };
}

/** A note as a Markdown file. `parseNoteMarkdown` reads it back to the same fields. */
export function renderNoteMarkdown(n: VaultNote): string {
  const fm: Record<string, unknown> = { id: n.note_id };
  for (const k of FRONT) {
    const v = n[k];
    if (v === undefined || (Array.isArray(v) && v.length === 0 && k !== "sources")) continue;
    fm[k] = v;
  }
  const yaml = Bun.YAML.stringify(fm, null, 2).trimEnd();
  // The fence is longer than any run of backticks in the script, so the script reads back whole.
  const fence = "`".repeat(
    Math.max(3, ...[...(n.figure?.script.matchAll(/`+/g) ?? [])].map((m) => m[0].length + 1)),
  );
  const text = [
    n.summary?.trim(),
    n.full?.trim() ? `<!-- full -->\n\n${n.full.trim()}` : undefined,
    n.figure ? `<!-- figure -->\n\n${fence}js\n${n.figure.script}\n${fence}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  return `---\n${yaml}\n---\n\n${text}\n`;
}

export interface IndexInput {
  shelf: string[];
  bottom_line?: string;
  order: string[];
}

export function parseIndexYaml(text: string): IndexInput {
  let doc: Record<string, unknown>;
  try {
    doc = (Bun.YAML.parse(text) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`index.yaml is not valid YAML (${(e as Error).message})`);
  }
  const list = (v: unknown, name: string): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`index.yaml: \`${name}\` is not a list`);
    return v.map(String);
  };
  const ledger = (doc["ledger"] ?? {}) as Record<string, unknown>;
  const bottom = ledger["bottom_line"];
  return {
    shelf: list(doc["shelf"], "shelf"),
    order: list(ledger["order"], "ledger.order"),
    ...(typeof bottom === "string" && bottom.trim() ? { bottom_line: bottom.trim() } : {}),
  };
}

export function renderIndexYaml(index: {
  shelf: readonly string[];
  ledger: { bottom_line?: string; order: readonly string[] };
}): string {
  return `${Bun.YAML.stringify(
    {
      shelf: index.shelf,
      ledger: {
        ...(index.ledger.bottom_line ? { bottom_line: index.ledger.bottom_line } : {}),
        order: index.ledger.order,
      },
    },
    null,
    2,
  ).trimEnd()}\n`;
}

/** The fields of a work someone writes (ADR 0052); the rest is the coordinator's bookkeeping. */
export const WORK_FIELDS = [
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
export type WorkField = (typeof WORK_FIELDS)[number];
export type WorkInput = Partial<Pick<VaultWork, WorkField>>;

/** A work file: its fields as frontmatter and what the work says as the text. */
export function parseWorkMarkdown(text: string, fileId?: string): { id: string; work: WorkInput } {
  const { fm, id, rest, raw } = frontmatter(text, fileId);
  const work: Record<string, unknown> = {};
  for (const k of WORK_FIELDS)
    if (k !== "summary" && fm[k] !== undefined && fm[k] !== null) work[k] = day(fm[k]);
  if (work["authors"] !== undefined) work["authors"] = (work["authors"] as unknown[]).map(String);
  else work["authors"] = [];
  // YAML reads `arxiv: 2002.04740` or `version: 1.10` as a number and drops the zero: such a
  // value is taken as written.
  for (const k of ["doi", "arxiv", "version", "venue"] as const) {
    if (typeof work[k] === "number") {
      const m = new RegExp(`^${k}:[ \\t]*([^\\s#]+)[ \\t]*(?:#.*)?$`, "m").exec(raw);
      work[k] = m?.[1] ?? String(work[k]);
    } else if (work[k] !== undefined) work[k] = String(work[k]);
  }
  if (rest) work["summary"] = rest;
  return { id, work: work as WorkInput };
}

export function renderWorkMarkdown(w: VaultWork): string {
  const fm: Record<string, unknown> = { id: w.work_id };
  for (const k of WORK_FIELDS) {
    if (k === "summary") continue;
    const v = w[k];
    if (v === undefined) continue;
    fm[k] = v;
  }
  const yaml = Bun.YAML.stringify(fm, null, 2).trimEnd();
  return `---\n${yaml}\n---\n${w.summary?.trim() ? `\n${w.summary.trim()}\n` : ""}`;
}
