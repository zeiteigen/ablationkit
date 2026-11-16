/**
 * The vault as a tree: notes embed notes, notebooks embed notebooks, to whatever depth the content
 * calls for. One note can sit in several places; the shelf and the editions are the roots.
 */
import type { VaultNote, VaultNoteType } from "@ablationkit/protocol";
import { body, embedsOf, linksOf, type Part, parts, withoutEmbeds, words } from "./text.ts";

export interface IndexLike {
  readonly shelf: readonly string[];
  readonly ledger: { readonly bottom_line?: string; readonly order: readonly string[] };
}

export type Depth = "gist" | "summary" | "full";

export interface Ledger {
  readonly bottom_line: string | undefined;
  /** Every claim, most important first. */
  readonly claims: readonly VaultNote[];
  readonly groups: Readonly<
    Record<"established" | "leaning" | "open" | "ruled_out", readonly VaultNote[]>
  >;
  readonly decisions: readonly VaultNote[];
  readonly proposed: readonly VaultNote[];
  readonly superseded: readonly VaultNote[];
  readonly questions: readonly VaultNote[];
  readonly answered: readonly VaultNote[];
}

export interface TreeNode {
  readonly note: VaultNote;
  readonly depth: number;
  readonly children: readonly TreeNode[];
}

/** No note needs more places than this listed; a pathological vault stays cheap. */
const MAX_CONTEXTS = 40;

export class Vault {
  readonly notes: readonly VaultNote[];
  readonly shelf: readonly VaultNote[];
  /** Notebooks that report one working session, oldest first. */
  readonly editions: readonly VaultNote[];
  readonly ledger: Ledger;
  private readonly byId = new Map<string, VaultNote>();
  private readonly embedIds = new Map<string, string[]>();
  private readonly linkIds = new Map<string, string[]>();
  private readonly parentIds = new Map<string, string[]>();
  private readonly linkedFrom = new Map<string, string[]>();
  private readonly paths = new Map<string, string[][]>();
  private readonly editionIds: Set<string>;

  constructor(notes: readonly VaultNote[], index: IndexLike) {
    this.notes = notes.filter((n) => !n.archived_at);
    for (const n of this.notes) this.byId.set(n.note_id, n);
    for (const n of this.notes) {
      const text = body(n);
      const embeds = [...new Set(embedsOf(text))].filter(
        (id) => this.byId.has(id) && id !== n.note_id,
      );
      const links = linksOf(text).filter((id) => this.byId.has(id) && id !== n.note_id);
      this.embedIds.set(n.note_id, embeds);
      this.linkIds.set(n.note_id, links);
      for (const id of embeds)
        this.parentIds.set(id, [...(this.parentIds.get(id) ?? []), n.note_id]);
      for (const id of links)
        this.linkedFrom.set(id, [...(this.linkedFrom.get(id) ?? []), n.note_id]);
    }
    this.shelf = index.shelf.flatMap((id) => this.byId.get(id) ?? []);
    this.editions = this.notes
      .filter((n) => n.type === "notebook" && n.edition)
      .sort(
        (a, b) =>
          (a.edition as string).localeCompare(b.edition as string) ||
          a.note_id.localeCompare(b.note_id),
      );
    this.editionIds = new Set(this.editions.map((n) => n.note_id));

    const of = (type: VaultNoteType, standing: string) =>
      this.notes
        .filter((n) => n.type === type && n.standing === standing)
        .sort((a, b) => a.created.localeCompare(b.created) || a.note_id.localeCompare(b.note_id));
    const listed = index.ledger.order.flatMap((id) => {
      const n = this.byId.get(id);
      return n?.type === "claim" ? [n] : [];
    });
    const seen = new Set(listed.map((n) => n.note_id));
    const claims = [
      ...listed,
      ...this.notes
        .filter((n) => n.type === "claim" && !seen.has(n.note_id))
        .sort((a, b) => a.note_id.localeCompare(b.note_id)),
    ];
    const group = (s: string) => claims.filter((n) => n.standing === s);
    this.ledger = {
      bottom_line: index.ledger.bottom_line,
      claims,
      groups: {
        established: group("established"),
        leaning: group("leaning"),
        open: group("open"),
        ruled_out: group("ruled_out"),
      },
      decisions: of("decision", "in_force"),
      proposed: of("decision", "proposed"),
      superseded: of("decision", "superseded"),
      questions: of("question", "open"),
      answered: of("question", "answered"),
    };

    const walk = (id: string, trail: string[]) => {
      if (trail.includes(id)) return;
      const here = [...trail, id];
      const known = this.paths.get(id) ?? [];
      if (known.length >= MAX_CONTEXTS) return;
      this.paths.set(id, [...known, here]);
      for (const child of this.embedIds.get(id) ?? []) walk(child, here);
    };
    for (const n of this.shelf) walk(n.note_id, []);
  }

  get(id: string): VaultNote | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** The notes a note embeds, in order, each once: its children in the tree. */
  children(id: string): VaultNote[] {
    return (this.embedIds.get(id) ?? []).map((x) => this.byId.get(x) as VaultNote);
  }

  /** The notes a note links in its prose. */
  links(id: string): VaultNote[] {
    return (this.linkIds.get(id) ?? []).map((x) => this.byId.get(x) as VaultNote);
  }

  /** The notes and notebooks that embed it: the standing ones first, editions last. */
  parents(id: string, opts: { editions?: boolean } = {}): VaultNote[] {
    const list = [...new Set(this.parentIds.get(id) ?? [])].map(
      (x) => this.byId.get(x) as VaultNote,
    );
    const standing = list.filter((n) => !this.editionIds.has(n.note_id));
    return opts.editions === false
      ? standing
      : [...standing, ...list.filter((n) => this.editionIds.has(n.note_id))];
  }

  isEdition(id: string): boolean {
    return this.editionIds.has(id);
  }

  /** Every place a note sits: chains of notes from a shelf notebook down to the note itself. */
  contexts(id: string): VaultNote[][] {
    return (this.paths.get(id) ?? []).map((p) => p.map((x) => this.byId.get(x) as VaultNote));
  }

  /** Whether a note is reachable from the shelf through embeds. */
  onShelf(id: string): boolean {
    return this.paths.has(id);
  }

  /** The editions that carried a note (anywhere beneath them), oldest first. */
  editionsOf(id: string): VaultNote[] {
    return this.editions.filter((e) => e.note_id !== id && this.under(e.note_id).has(id));
  }

  /** Every note beneath a note through embeds, the note itself included. */
  under(id: string): Set<string> {
    const seen = new Set<string>();
    const go = (x: string) => {
      if (seen.has(x)) return;
      seen.add(x);
      for (const c of this.embedIds.get(x) ?? []) go(c);
    };
    if (this.byId.has(id)) go(id);
    return seen;
  }

  /** Notes that link a note in their prose, with the paragraph that does. */
  mentions(id: string): { note: VaultNote; text: string }[] {
    const out: { note: VaultNote; text: string }[] = [];
    const re = new RegExp(`(?<!!)\\[\\[${id}(\\|[^\\]]*)?\\]\\]`);
    for (const from of new Set(this.linkedFrom.get(id) ?? [])) {
      const n = this.byId.get(from) as VaultNote;
      for (const para of body(n).split(/\n{2,}/))
        if (re.test(para)) out.push({ note: n, text: para.trim() });
    }
    return out;
  }

  /**
   * A note's text as parts, so an embed can be shown however the reader wants. Depths are
   * cumulative: the full text continues from the summary.
   */
  compose(id: string): { summary: Part[]; full: Part[] } {
    const n = this.byId.get(id);
    const has = (x: string) => this.byId.has(x) && x !== id;
    return { summary: parts(n?.summary, has), full: parts(n?.full, has) };
  }

  /** The tree under a note, following embeds; a note already on the path is not entered again. */
  tree(id: string, depth = 0, trail: readonly string[] = []): TreeNode {
    const note = this.byId.get(id) as VaultNote;
    const next = [...trail, id];
    return {
      note,
      depth,
      children: this.children(id)
        .filter((c) => !next.includes(c.note_id))
        .map((c) => this.tree(c.note_id, depth + 1, next)),
    };
  }

  /** Reading order under a note, depth-first, the note itself first. */
  flatten(id: string): { note: VaultNote; depth: number; path: string[] }[] {
    const out: { note: VaultNote; depth: number; path: string[] }[] = [];
    const go = (t: TreeNode, path: string[]) => {
      const here = [...path, t.note.note_id];
      out.push({ note: t.note, depth: t.depth, path: here });
      for (const ch of t.children) go(ch, here);
    };
    if (this.byId.has(id)) go(this.tree(id), []);
    return out;
  }

  /** Words in a note at a depth, not counting what it embeds. */
  words(id: string, depth: Depth = "full"): number {
    const n = this.byId.get(id);
    if (!n) return 0;
    return (
      words(n.gist) +
      (depth === "gist" ? 0 : words(withoutEmbeds(n.summary))) +
      (depth === "full" ? words(withoutEmbeds(n.full)) : 0)
    );
  }

  /** Minutes to read everything under a note at a depth, at 230 words a minute. */
  minutes(id: string, depth: Depth = "full"): number {
    const total = [...this.under(id)].reduce((a, x) => a + this.words(x, depth), 0);
    return Math.max(1, Math.round(total / 230));
  }

  /** Notes matching every word of a query, best first (title over gist over text). */
  search(q: string, opts: { types?: readonly VaultNoteType[] } = {}): VaultNote[] {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const scored: { note: VaultNote; score: number }[] = [];
    for (const n of this.notes) {
      if (opts.types && !opts.types.includes(n.type)) continue;
      const title = n.title.toLowerCase();
      const gist = n.gist.toLowerCase();
      const names = (n.aliases ?? []).join(" ").toLowerCase();
      const text = `${body(n)} ${n.note_id}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (title.includes(t) || names.includes(t)) score += 6;
        else if (gist.includes(t)) score += 3;
        else if (text.includes(t)) score += 1;
        else {
          score = -1;
          break;
        }
      }
      if (score > 0) scored.push({ note: n, score });
    }
    return scored.sort((a, b) => b.score - a.score).map((x) => x.note);
  }
}

/**
 * The chain of embeds that would make a note contain itself, if writing `candidate` (its text as
 * it would be stored) creates one; undefined otherwise.
 */
export function embedCycle(
  notes: readonly VaultNote[],
  candidate: Pick<VaultNote, "note_id" | "summary" | "full">,
): string[] | undefined {
  const embeds = new Map<string, string[]>();
  for (const n of notes) if (!n.archived_at) embeds.set(n.note_id, embedsOf(body(n)));
  embeds.set(candidate.note_id, embedsOf(body(candidate)));
  const seen = new Set<string>();
  const go = (id: string, path: string[]): string[] | undefined => {
    for (const c of embeds.get(id) ?? []) {
      if (c === candidate.note_id) return [...path, id, c];
      if (seen.has(c)) continue;
      seen.add(c);
      const hit = go(c, [...path, id]);
      if (hit) return hit;
    }
    return undefined;
  };
  return go(candidate.note_id, []);
}
