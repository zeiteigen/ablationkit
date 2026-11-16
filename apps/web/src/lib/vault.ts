/**
 * The vault in the web UI (ADR 0049), pure parts: what the coordinator's vault view looks like,
 * read state, the words the ledger is written in, term links into the fundamentals, a note's
 * places, and evidence rows against their baseline. No React, no fetching: `vault-store.ts` loads,
 * the components in `components/Note.tsx` and `pages/standing.tsx`, `pages/notebooks.tsx` render.
 */
import type { VaultEvidence, VaultNote, VaultWork } from "@ablationkit/protocol";
import { linksOf, type Vault } from "@ablationkit/vault";

/** `GET /api/v1/projects/:id/vault`. A note absent from `reads` has not been read. */
export interface VaultView {
  project_id: string;
  notes: VaultNote[];
  shelf: string[];
  editions: string[];
  ledger: { bottom_line?: string; order: string[] };
  index?: { revision?: number; updated_at?: string };
  reads: Record<string, { state: "read" | "changed"; read_at?: string }>;
  counts: {
    notes: number;
    new: number;
    changed: number;
    ledger_unread: number;
    checks: number;
    works?: number;
  };
  /** The library of prior work (ADR 0052): every live work. */
  works?: VaultWork[];
}

export type ReadState = "new" | "changed" | "read";

export function readState(reads: VaultView["reads"], id: string): ReadState {
  return reads[id]?.state ?? "new";
}

/** The ledger's lines: every claim, decisions in force and open questions. */
export function ledgerLines(v: Vault): VaultNote[] {
  return [...v.ledger.claims, ...v.ledger.decisions, ...v.ledger.questions];
}

export function onLedger(n: VaultNote): boolean {
  if (n.type === "claim") return true;
  if (n.type === "decision") return n.standing === "in_force";
  if (n.type === "question") return n.standing === "open";
  return false;
}

// ---------------------------------------------------------------- depths

export const DEPTHS = ["title", "gist", "summary", "full"] as const;
export type Depth = (typeof DEPTHS)[number];
export const DEPTH_WORD: Record<Depth, string> = {
  title: "Title",
  gist: "Gist",
  summary: "Summary",
  full: "Full text",
};
/** -1 title · 0 gist · 1 summary · 2 full. */
export const depthIndex = (d: Depth): number => DEPTHS.indexOf(d) - 1;

/** Whether a note has anything below its summary: its full text, its runs or its sources. */
export function hasFull(n: VaultNote): boolean {
  return (
    Boolean(n.full?.trim()) ||
    Boolean(n.evidence?.length) ||
    Boolean(n.cites?.length) ||
    n.sources.length > 0
  );
}

/** The library page, or one work on it (ADR 0052). */
export function libraryHref(base: string, work?: string, notebook?: string): string {
  const q = new URLSearchParams();
  if (work) q.set("work", work);
  if (notebook) q.set("notebook", notebook);
  const s = q.toString();
  return `${base}/notebooks/library${s ? `?${s}` : ""}`;
}

/** Where a format of the library's citations downloads from (the human API, same origin). */
export function citationsHref(
  pid: string,
  format: "bibtex" | "csl-json" | "markdown",
  notebook?: string,
): string {
  const q = new URLSearchParams({ format });
  if (notebook) q.set("notebook", notebook);
  return `/api/v1/projects/${encodeURIComponent(pid)}/vault/citations?${q}`;
}

// ---------------------------------------------------------------- words

export const STANDING: Record<string, { label: string; tone: string; says: string }> = {
  established: { label: "established", tone: "ok", says: "We act on it." },
  leaning: { label: "leaning", tone: "warn", says: "Probably true; the support is thin." },
  open: { label: "open", tone: "info", says: "Not known yet." },
  ruled_out: { label: "ruled out", tone: "err", says: "Tested and not so." },
  in_force: { label: "in force", tone: "ok", says: "What we are doing." },
  proposed: { label: "proposed", tone: "info", says: "Not yet adopted." },
  superseded: { label: "superseded", tone: "warn", says: "Replaced by a later choice." },
  answered: { label: "answered", tone: "ok", says: "Asked and answered." },
};

const NUM_WORDS =
  "no one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(
    " ",
  );
export const numWord = (n: number): string => NUM_WORDS[n] ?? String(n);
export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
export const plural = (n: number, one: string, many: string): string =>
  `${numWord(n)} ${n === 1 ? one : many}`;
/** A title cut at a word boundary. */
export function short(t: string, n = 46): string {
  if (t.length <= n) return t;
  const at = t.lastIndexOf(" ", n - 1);
  return `${t.slice(0, at > 20 ? at : n - 1)}…`;
}
export function fmtDay(day: string | undefined): string {
  if (!day) return "";
  const d = new Date(`${day.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "session" for an edition, "notebook" for others, the type otherwise. */
export function typeWord(v: Vault, n: VaultNote): string {
  if (n.type === "notebook") return v.isEdition(n.note_id) ? "session" : "notebook";
  return n.type;
}
const isTerm = (n: VaultNote | undefined): boolean => n?.type === "concept" || n?.type === "method";
/** An edition's day, and its name without the date. */
export const edDay = (ed: VaultNote): string => ed.edition ?? ed.note_id.replace(/^edition-/, "");
export const edName = (ed: VaultNote): string => ed.title.replace(/^\d{4}-\d{2}-\d{2}:\s*/, "");

// ---------------------------------------------------------------- terms

export interface Term {
  readonly text: string;
  readonly id: string;
}

/**
 * The words that name each concept and method: its title and its `aliases`; without aliases, the
 * name derived from the title (its abbreviation in brackets, and a short name of two or three
 * words, or one with capitals or punctuation in it). Longest first, each text once.
 */
export function termList(notes: readonly VaultNote[]): Term[] {
  const out: Term[] = [];
  const add = (text: string, id: string) => {
    const t = text.trim();
    if (t.length < 2 || /[[\]|\n]/.test(t)) return;
    if (!out.some((a) => a.text.toLowerCase() === t.toLowerCase())) out.push({ text: t, id });
  };
  for (const n of notes) {
    if (!isTerm(n)) continue;
    if (n.aliases?.length) {
      add(n.title, n.note_id);
      for (const a of n.aliases) add(a, n.note_id);
      continue;
    }
    const ab = /\(([A-Z][A-Za-z.]*(?: [A-Z]+)?)\)/.exec(n.title);
    if (ab?.[1] && ab[1].length >= 2) add(ab[1], n.note_id);
    const name = (n.title.split(/:|,| \(/)[0] ?? "").trim().replace(/^The /, "");
    const words = name.split(/\s+/).length;
    if (words <= 3 && name.length >= 5 && (words > 1 || /[A-Z].*[A-Z]|[._-]/.test(name)))
      add(name, n.note_id);
  }
  return out.sort((a, b) => b.text.length - a.text.length);
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One pattern for every term; a several-word term matches with its first letter in either case. */
export function termPattern(terms: readonly Term[]): RegExp | undefined {
  if (!terms.length) return undefined;
  const alt = terms.map((a) => {
    const e = escRe(a.text);
    return /^[a-z]/i.test(a.text) && a.text.includes(" ")
      ? `[${(a.text[0] as string).toUpperCase()}${(a.text[0] as string).toLowerCase()}]${e.slice(1)}`
      : e;
  });
  return new RegExp(`(?<![\\w/.-])(${alt.join("|")})(?![\\w-])`, "g");
}

function termTarget(terms: readonly Term[], text: string): string | undefined {
  return terms.find((a) => a.text.toLowerCase() === text.toLowerCase())?.id;
}

/**
 * What prose must not be touched: code, mathematics, links (wiki and Markdown), headings, table
 * rows, HTML and bare URLs.
 */
const PROTECTED =
  /```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]+?\$\$|\$(?!\s)[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)|^ {0,3}#{1,6} .*$|^\s*\|.*$|<[^>\n]+>|https?:\/\/\S+/gm;

/**
 * Link the first mention of each term in a note's own prose (its texts in reading order) to the
 * term's note, as `[[id|words]]`. A term the note links itself, and the note itself, are skipped.
 */
export function linkTerms(
  texts: readonly string[],
  terms: readonly Term[],
  pattern: RegExp | undefined,
  skip: Iterable<string> = [],
): string[] {
  if (!pattern) return [...texts];
  const done = new Set<string>(skip);
  for (const t of texts) for (const id of linksOf(t)) done.add(id);
  return texts.map((text) => {
    let out = "";
    let last = 0;
    const gap = (s: string) =>
      s.replace(new RegExp(pattern.source, "g"), (m) => {
        const id = termTarget(terms, m);
        if (!id || done.has(id)) return m;
        done.add(id);
        return `[[${id}|${m}]]`;
      });
    for (const m of text.matchAll(PROTECTED)) {
      out += gap(text.slice(last, m.index)) + m[0];
      last = (m.index ?? 0) + m[0].length;
    }
    return out + gap(text.slice(last));
  });
}

/**
 * A bare `[[id]]` is shown as the note's title; in running text a title that begins with "The"
 * must not read "the The 8k base tokenizer". Unknown notes keep their words, unlinked.
 */
export function resolveLinks(text: string, titleOf: (id: string) => string | undefined): string {
  return text.replace(
    // A live run reference (`[[run:…]]`, ADR 0056) is left as written: it is drawn as a value.
    /(?<!!)\[\[(?!run:)([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g,
    (m, rawId: string, label: string | undefined, at: number, whole: string) => {
      const id = rawId.trim();
      const title = titleOf(id);
      if (title === undefined) return label ?? id;
      if (label !== undefined) return m;
      let shown = title;
      if (/^The\s/.test(shown)) {
        const before = whole.slice(Math.max(0, at - 12), at);
        if (/\b(the|a|an)\s$/i.test(before)) shown = shown.slice(4);
        else if (/[\p{L}\p{N},;)]\s$/u.test(before)) shown = `the ${shown.slice(4)}`;
      }
      return `[[${id}|${shown.replace(/[[\]|]/g, " ")}]]`;
    },
  );
}

/** Text with its `[[id]]` links as plain words: for a gist or the bottom line outside the vault. */
export function plainLinks(text: string, titleOf: (id: string) => string | undefined): string {
  return resolveLinks(text, titleOf).replace(/\[\[[^\]|]+\|([^\]]*)\]\]/g, "$1");
}

/** The short name a term goes by: a several-word alias, else any alias, else its title. */
export function termName(terms: readonly Term[], n: VaultNote): string {
  const mine = terms.filter((x) => x.id === n.note_id && x.text !== n.title);
  const a = mine.find((x) => x.text.includes(" ")) ?? mine[0];
  return a?.text ?? short((n.title.split(/:|,/)[0] ?? n.title).trim(), 34);
}

/** The fundamentals a note and what it embeds use: linked concepts and methods, and named terms. */
export function termsOf(
  v: Vault,
  id: string,
  terms: readonly Term[],
  pattern: RegExp | undefined,
): VaultNote[] {
  const flat = v.flatten(id);
  const inside = new Set(flat.map((x) => x.note.note_id));
  const out: string[] = [];
  const push = (x: string | undefined) => {
    if (x && !inside.has(x) && !out.includes(x) && isTerm(v.get(x))) out.push(x);
  };
  for (const { note } of flat) {
    for (const l of v.links(note.note_id)) push(l.note_id);
    if (pattern)
      for (const m of `${note.gist}\n${note.summary ?? ""}\n${note.full ?? ""}`.matchAll(
        new RegExp(pattern.source, "g"),
      ))
        push(termTarget(terms, m[1] ?? m[0]));
  }
  return out.flatMap((x) => v.get(x) ?? []);
}

/** A metric key as a reader says it; an abbreviation the vault's terms give wins. */
export function metricName(key: string | undefined, terms: readonly Term[] = []): string {
  const segs = String(key ?? "value").split("/");
  // "eval/elbo/pc/ce_levels/01" says "ce levels 01", not "01".
  const last = segs.at(-1) ?? "value";
  const tail = segs.length > 1 && /^\d+$|^.{1,2}$/.test(last) ? segs.slice(-2) : [last];
  const name = tail.join(" ").replace(/_/g, " ");
  const t = termTarget(terms, name);
  if (t) {
    const ab = terms.find((x) => x.id === t && /^[A-Z][A-Za-z.]*[A-Z]$/.test(x.text));
    if (ab && ab.text.length <= 6) return ab.text;
  }
  return name;
}

// ---------------------------------------------------------------- places

export interface Place {
  kind: "notebook" | "session" | "ledger";
  /** The notebook page (or "ledger"). */
  root: string;
  /** The note's ID, to scroll to on that page. */
  at: string;
  label: string;
  /** Titles from the shelf down to where it sits. */
  chain: string[];
}

/** For a chain [shelf notebook … note]: the deepest notebook that holds it is the page. */
export function placeOf(v: Vault, ids: readonly string[]): { root: string; path: string[] } {
  for (let k = ids.length - 2; k >= 0; k--)
    if (v.get(ids[k] as string)?.type === "notebook")
      return { root: ids[k] as string, path: ids.slice(k + 1) };
  return { root: ids[ids.length - 1] as string, path: [] };
}

/** The embeds from a note down to a target, first found. */
export function pathTo(v: Vault, root: string, target: string): string[] {
  const seen = new Set<string>();
  const go = (id: string, trail: string[]): string[] | undefined => {
    if (id === target) return trail;
    if (seen.has(id)) return undefined;
    seen.add(id);
    for (const c of v.children(id)) {
      const r = go(c.note_id, [...trail, c.note_id]);
      if (r) return r;
    }
    return undefined;
  };
  return go(root, []) ?? [];
}

/** Every place a note sits: notebook pages first (one per page and path), sessions, the ledger. */
export function placesOf(v: Vault, id: string): Place[] {
  const n = v.get(id);
  if (!n) return [];
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const chain of v.contexts(id)) {
    if (chain.length === 1) continue;
    const pl = placeOf(
      v,
      chain.map((x) => x.note_id),
    );
    const k = `${pl.root}/${pl.path.join("/")}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      kind: "notebook",
      root: pl.root,
      at: id,
      label: v.get(pl.root)?.title ?? pl.root,
      chain: chain.slice(0, -1).map((x) => x.title),
    });
  }
  for (const ed of v.editionsOf(id))
    out.push({
      kind: "session",
      root: ed.note_id,
      at: id,
      label: `the ${fmtDay(edDay(ed))} session`,
      chain: ["Sessions", edName(ed)],
    });
  if (onLedger(n))
    out.push({
      kind: "ledger",
      root: "ledger",
      at: id,
      label: "where it stands",
      chain: [
        "Where it stands",
        n.type === "claim"
          ? cap(STANDING[n.standing ?? ""]?.label ?? "claims")
          : n.type === "decision"
            ? "Decisions in force"
            : "Open questions",
      ],
    });
  return out;
}

/** The claims a question bears on: as written (`bears_on`), else from embeds and links. */
export function bearsOn(v: Vault, qid: string): string[] {
  const q = v.get(qid);
  if (!q) return [];
  const claims = v.ledger.claims;
  if (q.bears_on?.length)
    return claims.filter((c) => q.bears_on?.includes(c.note_id)).map((c) => c.note_id);
  const qLinks = new Set(v.links(qid).map((x) => x.note_id));
  return claims
    .filter(
      (c) =>
        qLinks.has(c.note_id) ||
        v
          .flatten(c.note_id)
          .some(
            (x) => x.note.note_id === qid || v.links(x.note.note_id).some((l) => l.note_id === qid),
          ),
    )
    .map((c) => c.note_id);
}

// ---------------------------------------------------------------- evidence

export interface RunValue {
  value?: number | undefined;
  runId?: string | undefined;
}

export interface EvidenceRow extends VaultEvidence {
  value?: number | undefined;
  runId?: string | undefined;
  /** Whether the run was found in the project. */
  found: boolean;
  base?: EvidenceRow | undefined;
  delta?: number | undefined;
}

/**
 * A note's runs with their values read now, each compared with its baseline: the row named by
 * `vs`, else the nearest baseline above it with the same metric, else the first such baseline.
 */
export function evidenceRows(
  ev: readonly VaultEvidence[],
  lookup: (run: string, metric: string | undefined) => RunValue | undefined,
): EvidenceRow[] {
  const rows: EvidenceRow[] = ev.map((e) => {
    const hit = lookup(e.run, e.metric);
    return { ...e, value: hit?.value, runId: hit?.runId, found: Boolean(hit?.runId) };
  });
  const lastBase = new Map<string | undefined, EvidenceRow>();
  for (const r of rows) {
    if (r.role === "baseline") {
      lastBase.set(r.metric, r);
      continue;
    }
    const b =
      (r.vs
        ? (rows.find((x) => x.run === r.vs && x.role === "baseline" && x.metric === r.metric) ??
          rows.find((x) => x.run === r.vs && x !== r))
        : undefined) ??
      lastBase.get(r.metric) ??
      rows.find((x) => x.role === "baseline" && x.metric === r.metric);
    r.base = b;
    r.delta =
      b && typeof r.value === "number" && typeof b.value === "number"
        ? r.value - b.value
        : undefined;
  }
  return rows;
}

/** A value to the precision its size calls for. */
export function fmtValue(v: number | undefined, ref = v): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const a = Math.abs(ref ?? v);
  return v.toFixed(a >= 100 ? 1 : a >= 10 ? 2 : 4);
}
export function fmtDiff(d: number | undefined, ref?: number): string {
  if (d === undefined || !Number.isFinite(d)) return "";
  return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${fmtValue(Math.abs(d), ref ?? d)}`;
}

// ---------------------------------------------------------------- what is new

/** The ledger's "new and revised" paragraph, from the read state. */
export function newsSentence(v: Vault, state: (id: string) => ReadState): string {
  const L = v.ledger;
  const unread = (n: VaultNote) => state(n.note_id) !== "read";
  const lines = ledgerLines(v);
  const everRead = v.notes.some((n) => state(n.note_id) !== "new");
  const findingsUnder = (claims: readonly VaultNote[]) => {
    const s = new Set<string>();
    for (const c of claims)
      for (const x of v.flatten(c.note_id).slice(1))
        if (x.note.type === "finding" && unread(x.note)) s.add(x.note.note_id);
    return s;
  };
  if (!everRead) {
    if (!lines.length) return "";
    const parts = [
      L.claims.length ? plural(L.claims.length, "claim", "claims") : "",
      L.decisions.length ? plural(L.decisions.length, "decision", "decisions") : "",
      L.questions.length ? plural(L.questions.length, "open question", "open questions") : "",
    ].filter(Boolean);
    const list =
      parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
    const f = findingsUnder(L.claims).size;
    return `You have not read anything here yet: ${list}${f ? `, with ${plural(f, "finding", "findings")} beneath the claims` : ""}.`;
  }
  const newClaims = L.claims.filter((c) => state(c.note_id) === "new");
  const revClaims = L.claims.filter((c) => state(c.note_id) === "changed");
  const beneath = findingsUnder(L.claims);
  const beneathRead = findingsUnder(L.claims.filter((c) => state(c.note_id) === "read"));
  const nc = newClaims.length;
  const rc = revClaims.length;
  let s = "";
  if (nc || rc) {
    s += nc
      ? `${cap(plural(nc, "claim is", "claims are"))} new${rc ? ` and ${numWord(rc)} revised` : ""}`
      : `${cap(plural(rc, "claim was", "claims were"))} revised`;
    const b = beneathRead.size || beneath.size;
    s += b
      ? `, with ${plural(b, "new finding", "new findings")} beneath ${beneathRead.size ? "the ones you have read" : "them"}.`
      : ".";
  } else if (beneathRead.size)
    s += `Under claims you have read, ${plural(beneathRead.size, "finding is", "findings are")} new.`;
  const nd = L.decisions.filter(unread).length;
  const nq = L.questions.filter(unread).length;
  const others = [
    nd ? plural(nd, "decision", "decisions") : "",
    nq ? plural(nq, "question", "questions") : "",
  ].filter(Boolean);
  if (others.length)
    s += ` ${cap(others.join(" and "))} ${nd + nq === 1 ? "is" : "are"} new or revised.`;
  s = s.trim();
  return s || "You have read everything on this page as it now stands.";
}

/** What "Established" says when it is empty, counted from each claim's support. */
export function nothingEstablished(claims: readonly VaultNote[]): string {
  const total = claims.length;
  if (!total) return "Nothing is established yet; no claim is recorded.";
  const oneSeed = claims.filter((c) => /one (training )?seed/i.test(c.support ?? "")).length;
  const noRuns = claims.filter(
    (c) =>
      !/one (training )?seed/i.test(c.support ?? "") &&
      /no runs|not run|no test run/i.test(c.support ?? ""),
  ).length;
  if (oneSeed + noRuns !== total)
    return "Nothing is established yet. No claim has the support to act on.";
  const parts = [
    oneSeed
      ? `${numWord(oneSeed)} ${oneSeed === 1 ? "rests" : "rest"} on a single training seed`
      : "",
    noRuns ? `${numWord(noRuns)} on no runs at all` : "",
  ].filter(Boolean);
  const leaning = claims.some((c) => c.standing === "leaning");
  return `Nothing is established yet. Of the ${plural(total, "claim", "claims")}, ${parts.join(" and ")}${leaning ? ", so the strongest of them is leaning" : ""}.`;
}
