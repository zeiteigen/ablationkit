/**
 * The witness (ADR 0056): the agent's account held against the coordinator's record. Pure: no
 * I/O, runs in the coordinator and the browser.
 *
 * Two things a note's prose can be checked against. Every run a task's jobs produced is either
 * cited by a note (its evidence, a live reference in its text, or a `run:` source) or set aside
 * with a reason the agent recorded; a run that is neither is unaccounted for (the file drawer).
 * And a number a note reports is written as a live reference to the run it came from,
 * `[[run:<run>#<metric>]]` (the run's latest value of the metric, read when the note is shown) or
 * `[[run:<run>#<metric> vs <baseline run>]]` (the difference from the baseline's value), instead
 * of being typed by hand. Evidence by name, never by value (ADR 0049), inside a sentence.
 *
 * Both are advice: they block nothing and no gate reads them.
 */
import type { VaultNote } from "@ablationkit/protocol";
import { withoutEmbeds } from "./text.ts";

/** A live reference to a run's value (or its difference from a baseline run) in a note's prose. */
export interface RunRef {
  readonly run: string;
  readonly metric: string;
  readonly vs?: string;
}

const REF_BODY = /^run:([^\]#|\n]+?)#([^\]|\n]+?)(?:\s+vs\s+(?:run:)?([^\]|\n]+?))?$/;
const REFS = /\[\[(run:[^\]|\n]+)\]\]/g;

/** The reference inside `[[…]]` (`run:a#loss vs b`), or undefined when it is not one. */
export function parseRunRef(inner: string): RunRef | undefined {
  const m = REF_BODY.exec(inner.trim());
  if (!m) return undefined;
  const vs = m[3]?.trim();
  return { run: (m[1] as string).trim(), metric: (m[2] as string).trim(), ...(vs ? { vs } : {}) };
}

/** The live run references a text makes, in order. */
export function runRefsOf(text: string | undefined): RunRef[] {
  const out: RunRef[] = [];
  for (const m of (text ?? "").matchAll(REFS)) {
    const r = parseRunRef(m[1] as string);
    if (r) out.push(r);
  }
  return out;
}

/** The prose of a note, field by field, that a reader takes as its account. */
function proseOf(n: VaultNote): [string, string][] {
  const out: [string, string][] = [["gist", n.gist]];
  if (n.summary) out.push(["summary", n.summary]);
  if (n.full) out.push(["full text", withoutEmbeds(n.full)]);
  if (n.would_change) out.push(["what would change it", n.would_change]);
  return out;
}

/** Every run a note names: its evidence (and baselines), its live references, its `run:` sources. */
export function runsNamedBy(n: VaultNote): string[] {
  const out = new Set<string>();
  for (const e of n.evidence ?? []) {
    out.add(e.run);
    if (e.vs) out.add(e.vs);
  }
  for (const [, t] of proseOf(n))
    for (const r of runRefsOf(t)) {
      out.add(r.run);
      if (r.vs) out.add(r.vs);
    }
  for (const s of n.sources) if (s.startsWith("run:")) out.add(s.slice(4));
  return [...out];
}

/** Which notes name each run (by the name or ID they wrote), archived notes left out. */
export function citations(notes: readonly VaultNote[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of notes) {
    if (n.archived_at) continue;
    for (const r of runsNamedBy(n)) out.set(r, [...(out.get(r) ?? []), n.note_id]);
  }
  return out;
}

// ---------------------------------------------------------------- numbers typed by hand

/**
 * What is not prose for this check: code, mathematics, links and references, URLs, comments,
 * arXiv identifiers and section, table, figure, equation and version numbers.
 */
const NOT_PROSE: readonly RegExp[] = [
  /```[\s\S]*?```/g,
  /`[^`\n]*`/g,
  /\$\$[\s\S]+?\$\$/g,
  /\$(?!\s)(?:\\.|[^\\$\n])+?\$/g,
  /\\\([\s\S]+?\\\)/g,
  /\\\[[\s\S]+?\\\]/g,
  /\[\[[^\]\n]*\]\]/g,
  /\]\([^)\s]*\)/g,
  /https?:\/\/\S+/g,
  /<!--[\s\S]*?-->/g,
  /\b(?:arxiv:?\s*)?\d{4}\.\d{4,5}(?:v\d+)?\b/gi,
  /(?:\b(?:sec(?:tion)?|table|tab|fig(?:ure)?|eq(?:uation)?|appendix|app|chapter|ch|version|ver|v|step|stage|phase|round)\.?|§)\s*\d+(?:\.\d+)+/gi,
];

/**
 * A decimal number standing alone in prose (`0.039`, `1.21`, `12.5%`): not part of an identifier
 * (`sym0.5`, `v1.2`, `run-0.5`), a version (`1.2.3`) or a quantity glued to its unit (`1.5B`).
 */
const DECIMAL = /(?<![\p{L}\p{N}_./:#@\\])(?<![\p{L}\p{N}]-)\d+\.\d+(?![\p{L}\p{N}_]|\.\d)%?/gu;

/**
 * The decimal numbers a text types by hand. Integers are never counted (steps, seeds, sizes,
 * years and counts are written as integers, and are not what a reader checks against a run); a
 * number inside a live reference is the reference's, so it is never counted either.
 */
export function handNumbers(text: string | undefined): string[] {
  let t = text ?? "";
  for (const re of NOT_PROSE) t = t.replace(re, " ");
  return [...t.matchAll(DECIMAL)].map((m) => m[0]);
}

/** The note types whose prose reports results. */
export const REPORTING_TYPES: ReadonlySet<string> = new Set(["claim", "finding", "experiment"]);

/**
 * The decimal numbers in run names (`probe-lr0.5`, `wd0.1-s2`): a setting a run is named after,
 * so prose that names the setting (`at lr 0.5`) is labelling a run, not reporting a result.
 */
export function settingsIn(runNames: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const name of runNames) for (const m of name.matchAll(/\d+\.\d+/g)) out.add(m[0]);
  return out;
}

/**
 * The numbers a note's reporting prose types by hand, with the field each is in. A number that
 * appears in the name of a run (the note's own, or `settings` from the project's) is a setting
 * the run is named after, not a result, and is not counted.
 */
export function unreferencedNumbers(
  n: VaultNote,
  settings: ReadonlySet<string> = new Set(),
): { field: string; numbers: string[] }[] {
  if (!REPORTING_TYPES.has(n.type)) return [];
  const own = settingsIn(runsNamedBy(n));
  const out: { field: string; numbers: string[] }[] = [];
  for (const [field, t] of proseOf(n)) {
    const numbers = handNumbers(t).filter((x) => {
      const v = x.replace(/%$/, "");
      return !own.has(v) && !settings.has(v);
    });
    if (numbers.length) out.push({ field, numbers });
  }
  return out;
}

export const REF_HOWTO =
  "write each as a live reference, `[[run:<run>#<metric>]]` (a difference: `[[run:<run>#<metric> vs <baseline run>]]`), so the reader sees the run's value and where it came from; a number no run of the project recorded (a paper's, a measurement made outside AblationKit) stays as written, and the note says where it is from";

export function listNumbers(numbers: readonly string[]): string {
  const shown = numbers.slice(0, 5).map((x) => `\`${x}\``);
  return `${shown.join(", ")}${numbers.length > 5 ? `, … (${numbers.length} in all)` : ""}`;
}

// ---------------------------------------------------------------- the file drawer

/** Why the agent set a run aside, as it recorded it. */
export interface SetAsideMark {
  readonly reason: string;
  readonly at: string;
}

/** One run a job produced, as the coordinator recorded it. */
export interface RecordedRun {
  /** The run's name and its MLflow run ID, whichever are known. */
  readonly name?: string | undefined;
  readonly id?: string | undefined;
  /** Whether its attempt has ended (a live run owes no account yet). */
  readonly ended: boolean;
}

export type RunStanding = "cited" | "set_aside" | "unaccounted";

export interface RunAccount {
  readonly standing: RunStanding;
  /** The notes that name it. */
  readonly cited_by: string[];
  readonly set_aside?: SetAsideMark;
}

/** How one run is accounted for: cited by a note, set aside with a reason, or neither. */
export function accountFor(
  run: RecordedRun,
  cited: ReadonlyMap<string, readonly string[]>,
  setAside: (id: string) => SetAsideMark | undefined,
): RunAccount {
  const by = [
    ...new Set([
      ...(run.name ? (cited.get(run.name) ?? []) : []),
      ...(run.id ? (cited.get(run.id) ?? []) : []),
    ]),
  ];
  const aside = run.id ? setAside(run.id) : undefined;
  return {
    standing: by.length ? "cited" : aside ? "set_aside" : "unaccounted",
    cited_by: by,
    ...(aside ? { set_aside: aside } : {}),
  };
}
