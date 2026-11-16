/**
 * The library (ADR 0052): the prior work consulted for a project, and the part each work plays in
 * the notes that cite it. Who cites what in which role, the works beneath a notebook, and the
 * citations as BibTeX, CSL-JSON or an annotated bibliography in Markdown. Pure: no I/O, runs in
 * the coordinator, the CLI and the browser.
 */
import type {
  VaultCiteRole,
  VaultNote,
  VaultWork,
  VaultWorkKind,
  VaultWorkReading,
} from "@ablationkit/protocol";

export const WORK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const WORK_KINDS: readonly VaultWorkKind[] = [
  "paper",
  "preprint",
  "book",
  "thesis",
  "report",
  "repo",
  "software",
  "dataset",
  "model",
  "docs",
  "article",
  "thread",
  "talk",
  "other",
];

export const READINGS: readonly VaultWorkReading[] = ["unread", "abstract", "skimmed", "read"];

/** In the order a reader asks about them: what was taken, then what it was measured against. */
export const CITE_ROLES: readonly VaultCiteRole[] = [
  "method",
  "solution",
  "baseline",
  "supports",
  "contradicts",
  "inspiration",
  "tool",
  "background",
];

/** What each role means, as a heading over the works that play it. */
export const ROLE_HEADINGS: Readonly<Record<VaultCiteRole, string>> = {
  method: "Methods taken from it",
  solution: "Solutions to problems we hit",
  baseline: "What we compare against",
  supports: "Reports what we found",
  contradicts: "Reports otherwise",
  inspiration: "Suggested what to try",
  tool: "Code, data or models used",
  background: "Background",
};

/** A role as a reader says it of one note: "method of", "solution in", … */
export const ROLE_WORDS: Readonly<Record<VaultCiteRole, string>> = {
  method: "method",
  solution: "solution",
  baseline: "baseline",
  supports: "supports",
  contradicts: "contradicts",
  inspiration: "inspiration",
  tool: "tool",
  background: "background",
};

/** Roles that a note rests on: citing an unread work in one of them is a check. */
const RESTS_ON: ReadonlySet<VaultCiteRole> = new Set([
  "method",
  "solution",
  "baseline",
  "supports",
  "contradicts",
]);

export interface WorkUse {
  readonly note: VaultNote;
  readonly role: VaultCiteRole;
  readonly where?: string;
  readonly note_text?: string;
}

/** Every live note's cites, by work ID, in note order. */
export function usesByWork(notes: readonly VaultNote[]): Map<string, WorkUse[]> {
  const out = new Map<string, WorkUse[]>();
  for (const n of notes) {
    if (n.archived_at) continue;
    for (const c of n.cites ?? []) {
      const list = out.get(c.work) ?? [];
      list.push({
        note: n,
        role: c.role,
        ...(c.where ? { where: c.where } : {}),
        ...(c.note ? { note_text: c.note } : {}),
      });
      out.set(c.work, list);
    }
  }
  return out;
}

/** The roles a work plays, each once, in `CITE_ROLES` order. */
export function rolesOf(uses: readonly WorkUse[] | undefined): VaultCiteRole[] {
  const have = new Set((uses ?? []).map((u) => u.role));
  return CITE_ROLES.filter((r) => have.has(r));
}

export type Standing = "used" | "considered" | "unread";

/** Where a work stands in the library: cited by a note, read and set aside, or not read yet. */
export function workStanding(w: VaultWork, uses: readonly WorkUse[] | undefined): Standing {
  if (uses?.length) return "used";
  return w.reading === "unread" ? "unread" : "considered";
}

/** `Vaswani et al. 2017`: how a reader names a work in a line. */
export function shortCite(w: Pick<VaultWork, "authors" | "year" | "title">): string {
  const fam = (a: string) => (a.includes(",") ? (a.split(",")[0] as string).trim() : a.trim());
  const named = w.authors.filter((a) => a !== "others");
  const etal = w.authors.includes("others") || named.length > 2;
  const who = !named.length
    ? w.title.length > 40
      ? `${w.title.slice(0, 40)}…`
      : w.title
    : etal
      ? `${fam(named[0] as string)} et al.`
      : named.map(fam).join(" and ");
  return w.year ? `${who} ${w.year}` : who;
}

/** The link a reader follows: the DOI, then arXiv, then the URL. */
export function workHref(w: Pick<VaultWork, "doi" | "arxiv" | "url">): string | undefined {
  if (w.doi) return `https://doi.org/${w.doi}`;
  if (w.arxiv) return `https://arxiv.org/abs/${w.arxiv}`;
  return w.url;
}

/** Normalised identities of a work, to find the same work added twice. */
export function workKeys(w: Pick<VaultWork, "doi" | "arxiv" | "url">): string[] {
  const out: string[] = [];
  if (w.doi) out.push(`doi:${w.doi.toLowerCase()}`);
  if (w.arxiv) out.push(`arxiv:${w.arxiv.replace(/v[0-9]+$/, "").toLowerCase()}`);
  if (w.url) {
    const u = w.url
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, "")
      .replace(/[#?].*$/, "")
      .replace(/(\.git)?\/*$/, "");
    const arx = /^arxiv\.org\/(?:abs|pdf)\/([^/]+?)(?:v[0-9]+)?(?:\.pdf)?$/.exec(u);
    out.push(arx ? `arxiv:${arx[1]}` : `url:${u}`);
  }
  return [...new Set(out)];
}

/** Whether a library work matches words (title, authors, venue, what it says and what it gave). */
export function workMatches(w: VaultWork, q: string): boolean {
  const hay = [
    w.work_id,
    w.title,
    w.authors.join(" "),
    w.venue,
    w.year?.toString(),
    w.summary,
    w.takeaway,
    w.found_for,
    w.doi,
    w.arxiv,
    w.url,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

// ---------------------------------------------------------------- checks

export interface WorkCheck {
  readonly code: string;
  readonly note?: string;
  readonly work?: string;
  readonly message: string;
}

/**
 * Where the library and the notes' citations fall short: a cite that names no work, a note that
 * rests on a work nobody read, a work that cannot be found again, the same work twice, an open
 * question that cites no prior work. Advice, like every check of the vault.
 */
export function checkWorks(notes: readonly VaultNote[], works: readonly VaultWork[]): WorkCheck[] {
  const out: WorkCheck[] = [];
  const live = works.filter((w) => !w.archived_at);
  const byId = new Map(live.map((w) => [w.work_id, w]));
  const archived = new Set(works.filter((w) => w.archived_at).map((w) => w.work_id));
  for (const n of notes) {
    if (n.archived_at) continue;
    for (const c of n.cites ?? []) {
      const w = byId.get(c.work);
      if (!w)
        out.push({
          code: "unknown_work",
          note: n.note_id,
          message: archived.has(c.work)
            ? `cites \`${c.work}\`, which is archived in the library: cite another work or restore it`
            : `cites \`${c.work}\`, which is not in the library: add it (ablationkit_work add)`,
        });
      else if (w.reading === "unread" && RESTS_ON.has(c.role))
        out.push({
          code: "cites_unread",
          note: n.note_id,
          message: `rests on \`${c.work}\` (${c.role}), which is marked unread: read it and say how closely (\`reading\`), or cite it as inspiration`,
        });
    }
    if (n.type === "question" && n.standing === "open" && !(n.cites ?? []).length)
      out.push({
        code: "question_without_prior_work",
        note: n.note_id,
        message:
          "an open question that cites no prior work: if others have met it, look for what they found (papers, code, issues) and cite it; works read and set aside go in the library too",
      });
  }
  const seen = new Map<string, string>();
  for (const w of live) {
    if (!w.doi && !w.arxiv && !w.url)
      out.push({
        code: "work_without_locator",
        work: w.work_id,
        message: "no DOI, arXiv ID or URL: a reader cannot find it again",
      });
    for (const k of workKeys(w)) {
      const first = seen.get(k);
      if (first && first !== w.work_id)
        out.push({
          code: "duplicate_work",
          work: w.work_id,
          message: `the same work as \`${first}\` (${k}): keep one and cite it`,
        });
      else seen.set(k, w.work_id);
    }
  }
  return out;
}

// ---------------------------------------------------------------- citations

export type CitationFormat = "bibtex" | "csl-json" | "markdown";
export const CITATION_FORMATS: readonly CitationFormat[] = ["bibtex", "csl-json", "markdown"];

export interface CitationEntry {
  readonly work: VaultWork;
  readonly uses: readonly WorkUse[];
}

/** One line per role: "method in “Title” (§3); solution in …". */
export function roleSummary(uses: readonly WorkUse[]): string {
  const by = new Map<VaultCiteRole, string[]>();
  for (const u of uses) {
    const at = `“${u.note.title}”${u.where ? ` (${u.where})` : ""}`;
    by.set(u.role, [...(by.get(u.role) ?? []), at]);
  }
  return CITE_ROLES.filter((r) => by.has(r))
    .map((r) => `${ROLE_WORDS[r]} in ${(by.get(r) as string[]).join(", ")}`)
    .join("; ");
}

/** What a citation's annotation says: the role it played and what was taken from it. */
export function annotation(e: CitationEntry): string {
  const role = e.uses.length
    ? `Role: ${roleSummary(e.uses)}.`
    : `Role: consulted, not cited (${e.work.reading}).`;
  return `${role} Takeaway: ${e.work.takeaway}`;
}

const TEX_SPECIAL: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "%": "\\%",
  "&": "\\&",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};
const tex = (s: string) => s.replace(/[\\{}%&$#_~^]/g, (c) => TEX_SPECIAL[c] as string);
/** Plain Markdown and wiki links to words a bibliography can hold. */
const plain = (s: string) =>
  s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

const PROCEEDINGS =
  /proceedings|conference|workshop|symposium|\b(neurips|nips|icml|iclr|cvpr|iccv|eccv|acl|emnlp|naacl|coling|aaai|ijcai|kdd|sigir|www|interspeech|icassp|uai|aistats|colt|corl|rss|icra|iros|bmvc|wacv|accv|miccai|siggraph|wsdm|cikm|recsys|colm|ecml|eacl|conll|icdm|sdm)\b/i;

function bibType(w: VaultWork): string {
  switch (w.kind) {
    case "paper":
      return w.venue && PROCEEDINGS.test(w.venue) ? "inproceedings" : "article";
    case "book":
      return "book";
    case "thesis":
      return "phdthesis";
    case "report":
      return "techreport";
    default:
      return "misc";
  }
}

function bibAuthors(authors: readonly string[]): string {
  // An organisation is braced so BibTeX does not split it into a given and a family name.
  return authors
    .map((a) => (a === "others" ? "others" : a.includes(",") ? tex(a) : `{${tex(a)}}`))
    .join(" and ");
}

/** The library as BibTeX: one entry per work, its role and takeaway in `annote`. */
export function toBibtex(entries: readonly CitationEntry[]): string {
  return entries
    .map((e) => {
      const w = e.work;
      const type = bibType(w);
      const f: [string, string][] = [];
      if (w.authors.length) f.push(["author", `{${bibAuthors(w.authors)}}`]);
      f.push(["title", `{{${tex(w.title)}}}`]);
      if (w.year) f.push(["year", String(w.year)]);
      if (w.venue) {
        const field =
          type === "article"
            ? "journal"
            : type === "inproceedings"
              ? "booktitle"
              : type === "phdthesis"
                ? "school"
                : type === "techreport"
                  ? "institution"
                  : type === "book"
                    ? "publisher"
                    : "howpublished";
        f.push([field, `{${tex(w.venue)}}`]);
      }
      if (w.doi) f.push(["doi", `{${w.doi}}`]);
      if (w.arxiv) {
        f.push(["eprint", `{${w.arxiv}}`]);
        f.push(["archiveprefix", "{arXiv}"]);
      }
      if (w.url) f.push(["url", `{${w.url}}`]);
      const notes = [
        w.version ? `Version ${w.version}` : undefined,
        w.accessed ? `Accessed ${w.accessed}` : undefined,
      ].filter(Boolean);
      if (notes.length) f.push(["note", `{${tex(notes.join(". "))}}`]);
      if (w.accessed) f.push(["urldate", `{${w.accessed}}`]);
      f.push(["annote", `{${tex(plain(annotation(e)))}}`]);
      const width = Math.max(...f.map(([k]) => k.length));
      return `@${type}{${w.work_id},\n${f.map(([k, v]) => `  ${k.padEnd(width)} = ${v}`).join(",\n")}\n}\n`;
    })
    .join("\n");
}

const CSL_TYPE: Readonly<Record<VaultWorkKind, string>> = {
  paper: "article-journal",
  preprint: "article",
  book: "book",
  thesis: "thesis",
  report: "report",
  repo: "software",
  software: "software",
  dataset: "dataset",
  model: "software",
  docs: "webpage",
  article: "post-weblog",
  thread: "post",
  talk: "speech",
  other: "document",
};

/** The library as CSL-JSON (Zotero, Pandoc, citeproc): its role and takeaway in `note`. */
export function toCslJson(entries: readonly CitationEntry[]): string {
  const items = entries.map((e) => {
    const w = e.work;
    const type =
      w.kind === "paper" && w.venue && PROCEEDINGS.test(w.venue)
        ? "paper-conference"
        : CSL_TYPE[w.kind];
    const author = w.authors
      .filter((a) => a !== "others")
      .map((a) => {
        if (!a.includes(",")) return { literal: a };
        const [family, ...given] = a.split(",");
        return { family: (family as string).trim(), given: given.join(",").trim() };
      });
    const day = (d: string) => ({ "date-parts": [d.split("-").map(Number)] });
    return Object.fromEntries(
      Object.entries({
        id: w.work_id,
        type,
        title: w.title,
        author: author.length ? author : undefined,
        issued: w.year ? { "date-parts": [[w.year]] } : undefined,
        "container-title": w.venue,
        DOI: w.doi,
        URL: w.url ?? (w.arxiv ? `https://arxiv.org/abs/${w.arxiv}` : undefined),
        number: w.arxiv && w.kind === "preprint" ? `arXiv:${w.arxiv}` : undefined,
        version: w.version,
        accessed: w.accessed ? day(w.accessed) : undefined,
        abstract: w.summary ? plain(w.summary) : undefined,
        note: plain(annotation(e)),
      }).filter(([, v]) => v !== undefined),
    );
  });
  return `${JSON.stringify(items, null, 2)}\n`;
}

/** The library as an annotated bibliography a person reads: by the role each work played. */
export function toMarkdown(entries: readonly CitationEntry[], title: string): string {
  const line = (e: CitationEntry) => {
    const w = e.work;
    const href = workHref(w);
    const who = w.authors.filter((a) => a !== "others");
    const authors = who.length
      ? `${who.join("; ")}${w.authors.includes("others") ? "; et al." : ""}`
      : "";
    const head = [
      authors,
      w.year ? `(${w.year})` : "",
      href ? `[${w.title}](${href})` : `*${w.title}*`,
      w.venue ? `${w.venue}.` : "",
      w.version ? `Version ${w.version}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const out = [`- **${w.work_id}**: ${head}`];
    out.push(`  - *Read:* ${w.reading}. *Took from it:* ${plain(w.takeaway)}`);
    if (e.uses.length) out.push(`  - *Role:* ${roleSummary(e.uses)}.`);
    if (w.found_for) out.push(`  - *Looked up for:* ${plain(w.found_for)}`);
    return out.join("\n");
  };
  const used = entries.filter((e) => e.uses.length);
  const rest = entries.filter((e) => !e.uses.length);
  const parts = [`# ${title}\n`];
  for (const r of CITE_ROLES) {
    // A work sits under the first role it plays; its line names every role.
    const group = used.filter((e) => rolesOf(e.uses)[0] === r);
    if (group.length) parts.push(`## ${ROLE_HEADINGS[r]}\n\n${group.map(line).join("\n")}\n`);
  }
  const considered = rest.filter((e) => e.work.reading !== "unread");
  const unread = rest.filter((e) => e.work.reading === "unread");
  if (considered.length)
    parts.push(`## Considered and set aside\n\n${considered.map(line).join("\n")}\n`);
  if (unread.length) parts.push(`## Found, not read yet\n\n${unread.map(line).join("\n")}\n`);
  if (!entries.length) parts.push("No works.\n");
  return parts.join("\n");
}

export function renderCitations(
  format: CitationFormat,
  entries: readonly CitationEntry[],
  title: string,
): string {
  if (format === "bibtex") return toBibtex(entries);
  if (format === "csl-json") return toCslJson(entries);
  return toMarkdown(entries, title);
}

/**
 * The entries to export, in citation-key order: every live work of the library, used or set
 * aside; with `cited`, only the works a note cites; with `only` (a notebook and the notes beneath
 * it), only the works those notes cite, with their roles there.
 */
export function citationEntries(
  works: readonly VaultWork[],
  notes: readonly VaultNote[],
  opts: { only?: ReadonlySet<string>; cited?: boolean } = {},
): CitationEntry[] {
  const scoped = opts.only ? notes.filter((n) => opts.only?.has(n.note_id)) : notes;
  const uses = usesByWork(scoped);
  const citedOnly = opts.cited || opts.only !== undefined;
  return works
    .filter((w) => !w.archived_at && (!citedOnly || uses.has(w.work_id)))
    .sort((a, b) => a.work_id.localeCompare(b.work_id))
    .map((w) => ({ work: w, uses: uses.get(w.work_id) ?? [] }));
}
