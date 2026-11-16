/**
 * The vault in the web UI (ADR 0049), its pure parts: term links into the fundamentals, links to
 * notes in Markdown (never HTML), evidence against its baseline, the ledger's sentences, places.
 */
import { describe, expect, test } from "bun:test";
import type { VaultNote } from "@ablationkit/protocol";
import { Vault } from "@ablationkit/vault";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, type NoteLinks } from "../src/components/Markdown.tsx";
import {
  bearsOn,
  evidenceRows,
  fmtDiff,
  fmtValue,
  linkTerms,
  metricName,
  newsSentence,
  nothingEstablished,
  placesOf,
  type ReadState,
  resolveLinks,
  termList,
  termName,
  termPattern,
} from "../src/lib/vault.ts";

function note(id: string, type: VaultNote["type"], extra: Partial<VaultNote> = {}): VaultNote {
  return {
    schema_version: 1,
    note_id: id,
    project_id: "lab",
    type,
    title: id,
    gist: `The gist of ${id}.`,
    sources: [],
    created: "2026-11-10",
    updated: "2026-11-10",
    created_at: "2026-11-10T10:00:00.000Z",
    updated_at: "2026-11-10T10:00:00.000Z",
    created_by: { kind: "agent", id: "a" },
    updated_by: { kind: "agent", id: "a" },
    revision: 1,
    ...extra,
  } as VaultNote;
}

const NOTES = [
  note("bits-per-byte", "concept", { title: "Bits per byte (BPB)" }),
  note("layernorm", "concept", { title: "LayerNorm, and where each model applies it" }),
  note("macro-tokenizer", "concept", {
    title: "The macro tokenizer: BPE over base-token IDs",
  }),
  note("rope", "method", { title: "Rotary positions", aliases: ["RoPE"] }),
  note("adamw", "concept", { title: "Optimizer" }),
];

describe("terms (ADR 0049)", () => {
  const terms = termList(NOTES);
  const re = termPattern(terms);

  test("names come from aliases, else from the title: its abbreviation and a short name", () => {
    const texts = terms.map((t) => t.text);
    expect(texts).toContain("BPB");
    expect(texts).toContain("Bits per byte");
    expect(texts).toContain("LayerNorm");
    expect(texts).toContain("macro tokenizer");
    // Aliases replace the derivation: the title and the aliases, nothing derived.
    expect(texts).toContain("RoPE");
    expect(texts).toContain("Rotary positions");
    // One plain word is not a term (it would link every "optimizer" in prose).
    expect(texts).not.toContain("Optimizer");
    expect(termName(terms, NOTES[0] as VaultNote)).toBe("Bits per byte");
  });

  test("the first mention in a note's own prose links, once across all of it", () => {
    const out = linkTerms(
      ["Scored in BPB, and BPB again.", "The macro tokenizer and the Macro tokenizer; RoPE."],
      terms,
      re,
    );
    expect(out[0]).toBe("Scored in [[bits-per-byte|BPB]], and BPB again.");
    expect(out[1]).toBe(
      "The [[macro-tokenizer|macro tokenizer]] and the Macro tokenizer; [[rope|RoPE]].",
    );
  });

  test("code, mathematics, links, headings and table rows are left alone; so is the note itself", () => {
    const [a, b, c] = linkTerms(
      [
        "`BPB` and $BPB$ and [BPB](https://x.org) and [[layernorm]] then LayerNorm.",
        "## BPB\n\n| BPB | x |\n|---|---|\n\nBut BPB here.",
        "RoPE inside its own note.",
      ],
      terms,
      re,
      ["rope"],
    );
    // LayerNorm is linked explicitly, so its mention is not linked again.
    expect(a).toBe("`BPB` and $BPB$ and [BPB](https://x.org) and [[layernorm]] then LayerNorm.");
    expect(b).toBe("## BPB\n\n| BPB | x |\n|---|---|\n\nBut [[bits-per-byte|BPB]] here.");
    expect(c).toBe("RoPE inside its own note.");
  });

  test("a word inside another is not a term: BPBs, xBPB, pre-LayerNorm stay as written", () => {
    expect(linkTerms(["BPBs and xBPB and pre-LayerNorm."], terms, re)[0]).toBe(
      "BPBs and xBPB and pre-LayerNorm.",
    );
  });

  test("a bare link reads as the note's title, without 'the The'", () => {
    const t = (id: string) => NOTES.find((n) => n.note_id === id)?.title;
    expect(resolveLinks("Built on the [[macro-tokenizer]].", t)).toBe(
      "Built on the [[macro-tokenizer|macro tokenizer: BPE over base-token IDs]].",
    );
    expect(resolveLinks("Reads [[macro-tokenizer]].", t)).toBe(
      "Reads [[macro-tokenizer|the macro tokenizer: BPE over base-token IDs]].",
    );
    expect(resolveLinks("[[layernorm|LN]] and [[gone]] and [[gone|its words]].", t)).toBe(
      "[[layernorm|LN]] and gone and its words.",
    );
  });

  test("metric keys are said as words, an abbreviation the vault defines winning", () => {
    expect(metricName("validation/bits_per_byte", terms)).toBe("BPB");
    expect(metricName("train/loss")).toBe("loss");
    expect(metricName("eval/elbo/pc/ce_levels/01")).toBe("ce levels 01");
  });
});

describe("Markdown: links to notes are elements, never HTML (ADR 0048, 0049)", () => {
  const links: NoteLinks = {
    typeOf: (id) => (id === "layernorm" ? "concept" : undefined),
    href: (id) => `/p/lab/notebooks/n/${id}`,
    open: () => {},
  };
  const html = (text: string, notes?: NoteLinks, inline = false) =>
    renderToStaticMarkup(<Markdown text={text} notes={notes} inline={inline} />);

  test("with the vault, a link to a note it has becomes an in-app link", () => {
    const out = html("Pre-[[layernorm|LN]] blocks.", links);
    expect(out).toContain(
      '<a class="v-wl v-wl-concept" href="/p/lab/notebooks/n/layernorm" data-note="layernorm">LN</a>',
    );
  });

  test("an unknown note keeps its words; without the vault the text is as written", () => {
    expect(html("See [[nope|this]].", links)).toContain("See this.");
    expect(html("See [[layernorm]].")).toContain("See [[layernorm]].");
  });

  test("the strict policy holds inside vault prose: HTML is text, unsafe links are not links", () => {
    const out = html(
      "<img src=x onerror=alert(1)> [[layernorm|<b>x</b>]] [y](javascript:alert(1))",
      links,
    );
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(out).not.toContain('href="javascript:');
  });

  test("a gist renders inline, without a paragraph around it", () => {
    expect(html("A *short* line with $x$.", links, true)).toMatch(
      /^<span class="md-inline">A <em>short<\/em> line with <span class="tex"/,
    );
  });
});

describe("evidence (ADR 0049): values read from runs, compared with the baseline", () => {
  const values: Record<string, number> = { a: 1.5, b: 1.4, c: 2.0, d: 1.9, e: 1.45 };
  const lookup = (run: string) =>
    run in values ? { runId: `id-${run}`, value: values[run] } : undefined;

  test("each row against the nearest baseline above it with the same metric", () => {
    const rows = evidenceRows(
      [
        { run: "a", role: "baseline", metric: "m" },
        { run: "b", role: "for", metric: "m" },
        { run: "c", role: "baseline", metric: "m" },
        { run: "d", role: "against", metric: "m" },
      ],
      lookup,
    );
    expect(rows.map((r) => r.base?.run)).toEqual([undefined, "a", undefined, "c"]);
    expect(rows[1]?.delta).toBeCloseTo(-0.1);
    expect(rows[3]?.delta).toBeCloseTo(-0.1);
  });

  test("`vs` names the baseline when there are two; a row before any baseline uses the first", () => {
    const rows = evidenceRows(
      [
        { run: "e", role: "for", metric: "m", vs: "c" },
        { run: "b", role: "context", metric: "m" },
        { run: "a", role: "baseline", metric: "m" },
        { run: "c", role: "baseline", metric: "m" },
        { run: "d", role: "for", metric: "m", vs: "a" },
      ],
      lookup,
    );
    expect(rows[0]?.base?.run).toBe("c");
    expect(rows[1]?.base?.run).toBe("a");
    expect(rows[4]?.base?.run).toBe("a");
    expect(rows[4]?.delta).toBeCloseTo(0.4);
  });

  test("a run that is not found, or a metric not logged, has no value and no difference", () => {
    const rows = evidenceRows(
      [
        { run: "a", role: "baseline", metric: "m" },
        { run: "zzz", role: "for", metric: "m" },
      ],
      lookup,
    );
    expect(rows[1]?.found).toBe(false);
    expect(rows[1]?.delta).toBeUndefined();
  });

  test("values to the precision their size calls for; signed differences", () => {
    expect(fmtValue(1.40871)).toBe("1.4087");
    expect(fmtValue(64.123)).toBe("64.12");
    expect(fmtValue(812.25)).toBe("812.3");
    expect(fmtValue(undefined)).toBe("—");
    expect(fmtDiff(-0.0429, 1.5)).toBe("−0.0429");
    expect(fmtDiff(0.1, 1)).toBe("+0.1000");
    expect(fmtDiff(0, 1)).toBe("±0.0000");
    expect(fmtDiff(undefined)).toBe("");
  });
});

describe("the ledger's sentences (ADR 0049)", () => {
  const notes = [
    note("nb", "notebook", { full: "![[c1]]\n\n![[c2]]\n\n![[q1]]" }),
    note("c1", "claim", { standing: "leaning", support: "4 runs · one seed", full: "![[f1]]" }),
    note("c2", "claim", { standing: "open", support: "no runs yet", full: "![[f2]]" }),
    note("f1", "finding"),
    note("f2", "finding"),
    note("d1", "decision", { standing: "in_force" }),
    note("q1", "question", { standing: "open", summary: "Would move [[c2]]." }),
  ];
  const v = new Vault(notes, { shelf: ["nb"], ledger: { order: ["c1", "c2"] } });
  const of =
    (m: Record<string, ReadState>) =>
    (id: string): ReadState =>
      m[id] ?? "new";

  test("a first visit says what there is to read", () => {
    expect(newsSentence(v, of({}))).toBe(
      "You have not read anything here yet: two claims, one decision and one open question, with two findings beneath the claims.",
    );
  });

  test("afterwards, what is new and what was revised, counted from the read state", () => {
    expect(newsSentence(v, of({ c1: "changed", f1: "read", nb: "read" }))).toBe(
      "One claim is new and one revised, with one new finding beneath them. One decision and one question are new or revised.",
    );
    expect(newsSentence(v, of({ c1: "read", c2: "read", d1: "read", q1: "read" }))).toBe(
      "Under claims you have read, two findings are new.",
    );
    const all = Object.fromEntries(notes.map((n) => [n.note_id, "read" as ReadState]));
    expect(newsSentence(v, of(all))).toBe(
      "You have read everything on this page as it now stands.",
    );
  });

  test("nothing established is said, counted from each claim's support", () => {
    expect(nothingEstablished(v.ledger.claims)).toBe(
      "Nothing is established yet. Of the two claims, one rests on a single training seed and one on no runs at all, so the strongest of them is leaning.",
    );
    expect(nothingEstablished([])).toBe("Nothing is established yet; no claim is recorded.");
    expect(nothingEstablished([note("x", "claim", { support: "eight seeds" })])).toBe(
      "Nothing is established yet. No claim has the support to act on.",
    );
  });

  test("a note's places: the notebook page that holds it, and the ledger", () => {
    const p = placesOf(v, "c1");
    expect(p.map((x) => [x.kind, x.root])).toEqual([
      ["notebook", "nb"],
      ["ledger", "ledger"],
    ]);
    expect(placesOf(v, "f1").map((x) => [x.kind, x.root, x.chain.join(" › ")])).toEqual([
      ["notebook", "nb", "nb › c1"],
    ]);
  });

  test("a question bears on the claims that link or embed it, or that it names", () => {
    expect(bearsOn(v, "q1")).toEqual(["c2"]);
    const w = new Vault(
      [
        ...notes.filter((n) => n.note_id !== "q1"),
        note("q1", "question", { standing: "open", bears_on: ["c1"] }),
      ],
      { shelf: ["nb"], ledger: { order: [] } },
    );
    expect(bearsOn(w, "q1")).toEqual(["c1"]);
  });
});
