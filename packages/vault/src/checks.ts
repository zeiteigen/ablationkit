/**
 * Where a vault falls short of how it is meant to be written (ADR 0049): notes that are not
 * atomic, a fact stated twice, an embed or a run that does not resolve, a note the shelf does not
 * reach, a ledger that lags its claims. A check is advice for whoever writes the vault: it blocks
 * nothing and no gate reads it.
 */
import type { VaultNote, VaultWork } from "@ablationkit/protocol";
import { type IndexLike, Vault } from "./graph.ts";
import {
  body,
  embedsOf,
  linksOf,
  parts,
  STANDINGS,
  sentences,
  withoutEmbeds,
  words,
} from "./text.ts";
import {
  accountFor,
  citations,
  handNumbers,
  listNumbers,
  REF_HOWTO,
  type RecordedRun,
  runRefsOf,
  type SetAsideMark,
  settingsIn,
  unreferencedNumbers,
} from "./witness.ts";
import { checkWorks } from "./works.ts";

export interface VaultCheck {
  readonly code: string;
  /** The note it is about; absent for a check on the vault as a whole. */
  readonly note?: string;
  /** The work of the library it is about (ADR 0052). */
  readonly work?: string;
  readonly message: string;
}

/** What the vault points at outside itself. Anything left undefined is not checked. */
export interface VaultWorld {
  /** Run names and MLflow run IDs of the project. */
  readonly runs?: ReadonlySet<string>;
  /** Study IDs of the project. */
  readonly studies?: ReadonlySet<string>;
  /** Whether a `kind:id` source exists; undefined when it cannot be told. */
  readonly source?: (kind: string, id: string) => boolean | undefined;
  /** Completed tasks, to find one that left no note. */
  readonly completed_tasks?: readonly { task_id: string; title: string }[];
  /** When the index (the bottom line) was last written. */
  readonly index_updated_at?: string;
  /** The library, archived works included (ADR 0052); undefined leaves citations unchecked. */
  readonly works?: readonly VaultWork[];
  /**
   * How each figure fared the last time it was drawn (ADR 0053), by note ID: the revision drawn
   * and the error it threw, if any. A report on an older revision says nothing about this one.
   */
  readonly figures?: ReadonlyMap<string, { readonly revision: number; readonly error?: string }>;
  /**
   * The runs each task's jobs produced, as the coordinator recorded them (ADR 0056), and the runs
   * the agent set aside, by MLflow run ID. Undefined leaves the file drawer unchecked.
   */
  readonly task_runs?: readonly {
    readonly task_id: string;
    readonly title: string;
    readonly runs: readonly RecordedRun[];
  }[];
  readonly set_aside?: (runId: string) => SetAsideMark | undefined;
}

/** Aims, not limits: the schema's limits are far looser. */
export const AIMS = { summary_words: 110, full_words: 320, repeated_sentence_words: 10 } as const;

export function checkVault(
  all: readonly VaultNote[],
  index: IndexLike,
  world: VaultWorld = {},
): VaultCheck[] {
  const out: VaultCheck[] = [];
  const vault = new Vault(all, index);
  const notes = vault.notes;
  const add = (code: string, note: string | undefined, message: string) =>
    out.push(note === undefined ? { code, message } : { code, note, message });
  // Settings runs are named after (`lr0.5`): prose naming one labels a run, not a result.
  const settings = settingsIn(world.runs ?? []);

  for (const n of notes) {
    const id = n.note_id;
    const text = body(n);
    for (const e of new Set(embedsOf(text)))
      if (e === id) add("embeds_itself", id, "the note embeds itself");
      else if (!vault.has(e))
        add("unresolved_embed", id, `embeds \`${e}\`, which is not a note of this vault`);
    for (const l of linksOf(text))
      if (!vault.has(l))
        add("unresolved_link", id, `links \`${l}\`, which is not a note of this vault`);

    const atomic = n.type !== "notebook";
    // A figure is read as the figure and its gist; a summary (how to read it) is welcome, not owed.
    if (!n.summary?.trim() && n.type !== "figure")
      add(
        "no_summary",
        id,
        atomic
          ? "no summary: two to four sentences that continue from the gist"
          : "a notebook opens with a paragraph that says what it establishes and how it proceeds (its summary)",
      );
    if (atomic) {
      const sw = words(withoutEmbeds(n.summary));
      if (sw > AIMS.summary_words)
        add("long_summary", id, `the summary is ${sw} words; 30 to 80 is the aim`);
      const fw = words(withoutEmbeds(n.full));
      if (fw > AIMS.full_words)
        add(
          "long_note",
          id,
          `the full text is ${fw} words: an atomic note holds one idea. Split it, or embed the notes it compiles`,
        );
      if (/^#{1,6}\s/m.test(text))
        add("headings", id, "headings inside an atomic note: a note with parts embeds them");
      if (!n.sources.length && !(n.cites ?? []).length && n.type !== "question")
        add("no_sources", id, "no sources: say what the note was distilled from");
    } else {
      let run = 0;
      for (const p of parts(n.full)) {
        run = p.type === "embed" ? run + 1 : 0;
        if (run === 3)
          add(
            "embeds_without_prose",
            id,
            "more than two embeds in a row: a notebook carries the argument from one note to the next in its own sentences",
          );
      }
      if (!embedsOf(n.full).length) add("empty_notebook", id, "a notebook that embeds no note");
    }

    const allowed = STANDINGS[n.type];
    if (allowed && !n.standing)
      add("no_standing", id, `a ${n.type} carries a standing: ${allowed.join(", ")}`);
    if (n.type === "claim" && !n.support?.trim())
      add("no_support", id, "a claim says how much evidence it rests on (`support`)");
    if (n.type === "claim" && n.standing !== "open" && !(n.evidence ?? []).length) {
      const rests = [...vault.under(id)].some(
        (x) => x !== id && (vault.get(x)?.evidence ?? []).length > 0,
      );
      if (!rests)
        add(
          "claim_without_evidence",
          id,
          `a claim that is ${n.standing?.replace("_", " ")} cites runs, or embeds the findings that do`,
        );
    }
    if (n.type === "experiment") {
      if (!n.study) add("no_study", id, "an experiment names its study (`study`)");
      else if (world.studies && !world.studies.has(n.study))
        add("unknown_study", id, `study \`${n.study}\` is not a study of this project`);
    }
    if (n.type === "figure") {
      if (!n.figure)
        add("no_figure", id, "a figure carries the code that draws it (`figure.script`)");
      if (!(n.evidence ?? []).length)
        add(
          "figure_without_runs",
          id,
          "a figure names the runs it draws as `evidence`, so the reader sees what it rests on",
        );
      const drawn = world.figures?.get(id);
      if (drawn?.error && drawn.revision === n.revision)
        add("figure_error", id, `the figure failed when it was last drawn: ${drawn.error}`);
    }
    for (const e of n.evidence ?? []) {
      if (world.runs && !world.runs.has(e.run))
        add("unknown_run", id, `evidence run \`${e.run}\` is not a run of this project`);
      if (e.vs && !(n.evidence ?? []).some((b) => b.run === e.vs))
        add(
          "unknown_baseline",
          id,
          `evidence row \`${e.run}\` compares with \`${e.vs}\`, which the note does not list`,
        );
    }
    for (const r of runRefsOf([n.gist, text, n.would_change ?? ""].join("\n")))
      for (const run of r.vs ? [r.run, r.vs] : [r.run])
        if (world.runs && !world.runs.has(run))
          add(
            "unknown_run",
            id,
            `the text refers to run \`${run}\`, which is not a run of this project`,
          );
    for (const u of unreferencedNumbers(n, settings))
      add(
        "unreferenced_number",
        id,
        `its ${u.field} types ${listNumbers(u.numbers)} by hand: ${REF_HOWTO}`,
      );
    for (const b of n.bears_on ?? [])
      if (vault.get(b)?.type !== "claim")
        add("bears_on_not_a_claim", id, `\`bears_on\` names \`${b}\`, which is not a claim`);
    for (const s of n.sources) {
      const at = s.indexOf(":");
      const kind = s.slice(0, at);
      if (kind === "repo") continue;
      if (world.source?.(kind, s.slice(at + 1)) === false)
        add("unknown_source", id, `source \`${s}\` does not exist in this project`);
    }

    if (!vault.onShelf(id) && !vault.isEdition(id)) {
      const where = vault.parents(id).length
        ? "only inside editions or notes the shelf does not reach"
        : "embedded nowhere";
      add(
        "off_shelf",
        id,
        n.type === "notebook" && !vault.parents(id).length
          ? "a notebook that is neither on the shelf nor a chapter of another notebook"
          : `not reachable from the shelf (${where}): embed it where it belongs`,
      );
    }
  }

  for (const id of index.shelf) {
    const n = vault.get(id);
    if (!n) add("shelf_unknown", undefined, `the shelf lists \`${id}\`, which is not a note`);
    else if (n.type !== "notebook")
      add("shelf_not_a_notebook", id, `the shelf lists a ${n.type}; it holds notebooks`);
  }
  for (const id of index.ledger.order)
    if (vault.get(id)?.type !== "claim")
      add("ledger_unknown", undefined, `the ledger's order lists \`${id}\`, which is not a claim`);
  if (notes.length) {
    if (!vault.shelf.length)
      add("empty_shelf", undefined, "the shelf is empty: nothing can be read in order");
    else if (!notes.some((n) => n.type === "concept"))
      add(
        "no_fundamentals",
        undefined,
        "no concept notes: the vault explains the research but not what the project is or how it works",
      );
    if (vault.ledger.claims.length && !index.ledger.bottom_line?.trim())
      add("no_bottom_line", undefined, "the ledger has claims and no bottom line");
    const ordered = new Set(index.ledger.order);
    const unordered = vault.ledger.claims.filter((n) => !ordered.has(n.note_id));
    if (unordered.length)
      add(
        "ledger_order",
        undefined,
        `${unordered.length === 1 ? "a claim is" : `${unordered.length} claims are`} not in the ledger's order of importance: ${unordered.map((n) => n.note_id).join(", ")}`,
      );
    const typed = handNumbers(index.ledger.bottom_line).filter(
      (x) => !settings.has(x.replace(/%$/, "")),
    );
    if (typed.length)
      add(
        "unreferenced_number",
        undefined,
        `the bottom line types ${listNumbers(typed)} by hand: ${REF_HOWTO}`,
      );
    if (world.index_updated_at && index.ledger.bottom_line?.trim()) {
      const later = vault.ledger.claims.filter(
        (n) => n.updated_at > (world.index_updated_at as string),
      );
      if (later.length)
        add(
          "stale_bottom_line",
          undefined,
          `the bottom line was written before ${later.length === 1 ? "a claim" : `${later.length} claims`} changed (${later.map((n) => n.note_id).join(", ")}): read it again and rewrite it if it no longer holds`,
        );
    }
  }

  // A fact lives in one note: the same sentence in two notes is the sign that it does not.
  const first = new Map<string, string>();
  const repeated = new Map<string, string>();
  for (const n of notes)
    for (const s of sentences(n)) {
      if (words(s.key) < AIMS.repeated_sentence_words) continue;
      const seen = first.get(s.key);
      if (seen === undefined) first.set(s.key, n.note_id);
      else if (seen !== n.note_id) repeated.set(`${seen}\n${n.note_id}`, s.raw);
    }
  for (const [pair, raw] of repeated) {
    const [a, b] = pair.split("\n") as [string, string];
    add(
      "repeated",
      b,
      `says what \`${a}\` already says ("${raw.length > 90 ? `${raw.slice(0, 90)}…` : raw}"): state it once and link or embed it`,
    );
  }

  if (world.completed_tasks) {
    const cited = new Set<string>();
    for (const n of notes) {
      if (n.task_id) cited.add(n.task_id);
      for (const s of n.sources) if (s.startsWith("task:")) cited.add(s.slice(5));
    }
    for (const t of world.completed_tasks)
      if (!cited.has(t.task_id))
        add(
          "task_without_notes",
          undefined,
          `task ${t.task_id} (${t.title}) was completed and no note cites it: what it found is not in the vault`,
        );
  }
  if (world.task_runs) {
    // The file drawer (ADR 0056): every run a task's jobs produced is cited or set aside.
    const cited = citations(notes);
    const aside = world.set_aside ?? (() => undefined);
    for (const t of world.task_runs) {
      // A run MLflow has not acknowledged holds no result yet, and cannot be set aside.
      const ended = t.runs.filter((r) => r.ended && r.id);
      const loose = ended.filter((r) => accountFor(r, cited, aside).standing === "unaccounted");
      if (loose.length)
        add(
          "unaccounted_runs",
          undefined,
          `task ${t.task_id} (${t.title}): ${loose.length} of its ${ended.length} ended runs ${loose.length === 1 ? "is" : "are"} neither cited by a note nor set aside (${loose
            .slice(0, 6)
            .map((r) => r.name ?? r.id)
            .join(
              ", ",
            )}${loose.length > 6 ? ", …" : ""}): cite each in the note it bears on, or set it aside with the reason (ablationkit_run describe {run, set_aside})`,
        );
    }
  }
  if (world.works) out.push(...checkWorks(notes, world.works));
  return out;
}
