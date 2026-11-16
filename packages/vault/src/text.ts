/**
 * What a note's text says about the tree: `![[id]]` alone on a line embeds another note at that
 * point, `[[id]]` or `[[id|words]]` links one. Pure: no I/O, runs in the coordinator, the CLI and
 * the browser.
 */
import type { VaultNote, VaultNoteType, VaultStanding } from "@ablationkit/protocol";

export const NOTE_TYPES: readonly VaultNoteType[] = [
  "concept",
  "method",
  "experiment",
  "finding",
  "claim",
  "decision",
  "question",
  "log",
  "figure",
  "notebook",
];

/** The standings a type may carry; a type not listed carries none. */
export const STANDINGS: Readonly<Partial<Record<VaultNoteType, readonly VaultStanding[]>>> = {
  claim: ["established", "leaning", "open", "ruled_out"],
  decision: ["in_force", "proposed", "superseded"],
  question: ["open", "answered"],
};

export const NOTE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;

const EMBED_LINE = /^!\[\[([^\]|]+)\]\]\s*$/;
const EMBEDS = /^!\[\[([^\]|]+)\]\]\s*$/gm;
/** `[[run:…]]` is a live run reference (ADR 0056), not a link to a note. */
const LINKS = /(?<!!)\[\[(?!run:)([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/** The text of a note below its gist: the summary, then the full text. */
export function body(n: Pick<VaultNote, "summary" | "full">): string {
  return [n.summary, n.full].filter(Boolean).join("\n\n");
}

/** IDs a text embeds, in order, as written (they may not exist). */
export function embedsOf(text: string | undefined): string[] {
  return [...(text ?? "").matchAll(EMBEDS)].map((m) => (m[1] ?? "").trim());
}

/** IDs a text links, in order, each once, as written (they may not exist). */
export function linksOf(text: string | undefined): string[] {
  return [...new Set([...(text ?? "").matchAll(LINKS)].map((m) => (m[1] ?? "").trim()))];
}

/** A text without its embed lines. */
export function withoutEmbeds(text: string | undefined): string {
  return (text ?? "").replace(EMBEDS, "");
}

export function words(text: string | undefined): number {
  return ((text ?? "").match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? []).length;
}

export type Part = { type: "prose"; md: string } | { type: "embed"; id: string };

/**
 * A text as the parts a reader meets in order: prose (Markdown) and embeds. An embed whose note
 * `has` does not know is dropped; without `has`, every embed line is kept.
 */
export function parts(text: string | undefined, has?: (id: string) => boolean): Part[] {
  const out: Part[] = [];
  let buf: string[] = [];
  const flush = () => {
    const md = buf.join("\n").trim();
    if (md) out.push({ type: "prose", md });
    buf = [];
  };
  for (const line of (text ?? "").split("\n")) {
    const m = EMBED_LINE.exec(line.trim());
    if (!m) buf.push(line);
    else {
      const id = (m[1] ?? "").trim();
      if (has && !has(id)) continue;
      flush();
      out.push({ type: "embed", id });
    }
  }
  flush();
  return out;
}

/**
 * Sentences of a note's own prose, normalised for comparison (lower case, no punctuation), with
 * the text as written. Used to find a fact stated in two notes.
 */
export function sentences(n: Pick<VaultNote, "summary" | "full">): { key: string; raw: string }[] {
  const text = withoutEmbeds(body(n)).replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2");
  const out: { key: string; raw: string }[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const key = raw
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (key) out.push({ key, raw: raw.trim() });
  }
  return out;
}
