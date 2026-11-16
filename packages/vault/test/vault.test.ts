import { describe, expect, test } from "bun:test";
import type { VaultNote } from "@ablationkit/protocol";
import { checkVault, embedCycle, embedsOf, linksOf, parts, Vault } from "../src/index.ts";
import {
  parseIndexYaml,
  parseNoteMarkdown,
  renderIndexYaml,
  renderNoteMarkdown,
} from "../src/markdown.ts";

function note(id: string, fields: Partial<VaultNote> = {}): VaultNote {
  return {
    schema_version: 1,
    note_id: id,
    project_id: "lab",
    type: "concept",
    title: id,
    gist: `${id} is a thing.`,
    summary: `What ${id} is, in a sentence of its own that no other note repeats at all.`,
    sources: ["repo:README.md"],
    created: "2026-11-01",
    updated: "2026-11-01",
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    created_by: { kind: "agent" },
    updated_by: { kind: "agent" },
    revision: 1,
    ...fields,
  };
}

const NOTES: VaultNote[] = [
  note("metric", { aliases: ["BPB"] }),
  note("tokenizer"),
  note("finding", {
    type: "finding",
    summary: "Measured with [[metric]] on the [[tokenizer|8k tokenizer]].",
    evidence: [{ run: "r1", role: "for" }],
  }),
  note("claim-a", {
    type: "claim",
    standing: "leaning",
    support: "1 run",
    full: "It rests on one run.\n\n![[finding]]",
  }),
  note("claim-b", { type: "claim", standing: "open", support: "none yet" }),
  note("decide", { type: "decision", standing: "in_force" }),
  note("ask", { type: "question", standing: "open", bears_on: ["claim-b"], sources: [] }),
  note("basics", {
    type: "notebook",
    full: "First the metric.\n\n![[metric]]\n\nThen the tokenizer.\n\n![[tokenizer]]",
  }),
  note("argument", {
    type: "notebook",
    full: "## What was seen\n\nThe metric again.\n\n![[metric]]\n\n![[claim-a]]\n\nStill open.\n\n![[claim-b]]\n\n![[decide]]\n\nAnd asked.\n\n![[ask]]",
  }),
  note("book", { type: "notebook", full: "![[basics]]\n\nThen the argument.\n\n![[argument]]" }),
  note("session", {
    type: "notebook",
    edition: "2026-11-02",
    full: "What the day found.\n\n![[finding]]",
  }),
  note("gone", { archived_at: "2026-11-03T00:00:00Z" }),
];
const INDEX = {
  shelf: ["book"],
  ledger: { bottom_line: "Leaning.", order: ["claim-b", "claim-a"] },
};

describe("text", () => {
  test("embeds are whole lines; links are inline; parts keep the order a reader meets them in", () => {
    const text = "Before [[a|the a]] and [[b]].\n\n![[c]]\n\nAfter ![[d]] inline.\n![[e]]  ";
    expect(embedsOf(text)).toEqual(["c", "e"]);
    expect(linksOf(text)).toEqual(["a", "b"]);
    expect(parts(text, (id) => id !== "e")).toEqual([
      { type: "prose", md: "Before [[a|the a]] and [[b]]." },
      { type: "embed", id: "c" },
      { type: "prose", md: "After ![[d]] inline." },
    ]);
  });
});

describe("the tree", () => {
  const v = new Vault(NOTES, INDEX);

  test("archived notes are not part of it; the shelf and editions are its roots", () => {
    expect(v.has("gone")).toBe(false);
    expect(v.shelf.map((n) => n.note_id)).toEqual(["book"]);
    expect(v.editions.map((n) => n.note_id)).toEqual(["session"]);
    expect(v.children("book").map((n) => n.note_id)).toEqual(["basics", "argument"]);
  });

  test("a note knows every place it sits, the standing ones before the editions", () => {
    expect(v.contexts("metric").map((c) => c.map((n) => n.note_id))).toEqual([
      ["book", "basics", "metric"],
      ["book", "argument", "metric"],
    ]);
    expect(v.contexts("finding").map((c) => c.map((n) => n.note_id))).toEqual([
      ["book", "argument", "claim-a", "finding"],
    ]);
    expect(v.parents("finding").map((n) => n.note_id)).toEqual(["claim-a", "session"]);
    expect(v.parents("finding", { editions: false }).map((n) => n.note_id)).toEqual(["claim-a"]);
    expect(v.editionsOf("finding").map((n) => n.note_id)).toEqual(["session"]);
    expect(v.onShelf("session")).toBe(false);
    expect(v.mentions("metric").map((m) => m.note.note_id)).toEqual(["finding"]);
  });

  test("reading order follows the embeds; compose keeps prose and embeds apart", () => {
    expect(v.flatten("book").map((x) => `${x.depth}:${x.note.note_id}`)).toEqual([
      "0:book",
      "1:basics",
      "2:metric",
      "2:tokenizer",
      "1:argument",
      "2:metric",
      "2:claim-a",
      "3:finding",
      "2:claim-b",
      "2:decide",
      "2:ask",
    ]);
    expect(v.compose("claim-a").full).toEqual([
      { type: "prose", md: "It rests on one run." },
      { type: "embed", id: "finding" },
    ]);
    expect(v.minutes("book")).toBe(1);
  });

  test("the ledger lists claims in its order, then the rest; decisions and questions by standing", () => {
    expect(v.ledger.claims.map((n) => n.note_id)).toEqual(["claim-b", "claim-a"]);
    expect(v.ledger.groups.leaning.map((n) => n.note_id)).toEqual(["claim-a"]);
    expect(v.ledger.groups.established).toEqual([]);
    expect(v.ledger.decisions.map((n) => n.note_id)).toEqual(["decide"]);
    expect(v.ledger.questions.map((n) => n.note_id)).toEqual(["ask"]);
    const unordered = new Vault(NOTES, { shelf: [], ledger: { order: [] } });
    expect(unordered.ledger.claims.map((n) => n.note_id)).toEqual(["claim-a", "claim-b"]);
  });

  test("search ranks a title or alias above a mention", () => {
    expect(v.search("bpb").map((n) => n.note_id)).toEqual(["metric"]);
    expect(v.search("metric")[0]?.note_id).toBe("metric");
    expect(v.search("metric", { types: ["finding"] }).map((n) => n.note_id)).toEqual(["finding"]);
    expect(v.search("  ")).toEqual([]);
  });

  test("a cycle is named before it is written, and the tree survives one that is already there", () => {
    expect(embedCycle(NOTES, { note_id: "finding", full: "![[book]]" })).toEqual([
      "finding",
      "book",
      "argument",
      "claim-a",
      "finding",
    ]);
    expect(embedCycle(NOTES, { note_id: "finding", full: "![[metric]]" })).toBeUndefined();
    const looped = new Vault(
      [note("a", { type: "notebook", full: "![[b]]" }), note("b", { full: "![[a]]" })],
      { shelf: ["a"], ledger: { order: [] } },
    );
    expect(looped.flatten("a").map((x) => x.note.note_id)).toEqual(["a", "b"]);
    expect(looped.contexts("b")).toHaveLength(1);
  });
});

describe("checks", () => {
  test("a well-written vault has none", () => {
    expect(
      checkVault(NOTES, INDEX, {
        runs: new Set(["r1"]),
        completed_tasks: [],
        index_updated_at: "2026-11-02T00:00:00Z",
      }),
    ).toEqual([]);
  });

  test("each shortfall is named once, on the note it is about", () => {
    const same =
      "The comparison used the same data and the same budget and the same seed for both models.";
    const bad: VaultNote[] = [
      note("first", { summary: same }),
      note("second", {
        type: "finding",
        summary: `${same} See [[nowhere]].`,
        full: `# Heading\n\n${"word ".repeat(330)}\n\n![[missing]]`,
        evidence: [{ run: "never", role: "for", vs: "also-never" }],
        sources: ["task:t-1", "repo:x"],
      }),
      note("bare-claim", { type: "claim", standing: "leaning", sources: [] }),
      note("stack", {
        type: "notebook",
        summary: "",
        full: "![[first]]\n\n![[second]]\n\n![[bare-claim]]",
      }),
      note("loose", { type: "notebook", full: "Prose only." }),
      note("probe", { type: "experiment", study: "no-such-study" }),
      note("q", { type: "question", standing: "open", bears_on: ["first"], sources: [] }),
    ];
    const checks = checkVault(
      bad,
      { shelf: ["stack", "first", "ghost"], ledger: { order: ["first"] } },
      {
        runs: new Set(["r1"]),
        studies: new Set(["s1"]),
        source: (kind) => (kind === "task" ? false : undefined),
        completed_tasks: [{ task_id: "t-9", title: "Nine" }],
      },
    );
    const by = (id: string | undefined) =>
      checks
        .filter((c) => c.note === id)
        .map((c) => c.code)
        .sort();
    expect(by("first")).toEqual(["shelf_not_a_notebook"]);
    expect(by("second")).toEqual([
      "headings",
      "long_note",
      "repeated",
      "unknown_baseline",
      "unknown_run",
      "unknown_source",
      "unresolved_embed",
      "unresolved_link",
    ]);
    expect(by("bare-claim")).toEqual(["claim_without_evidence", "no_sources", "no_support"]);
    expect(by("stack")).toEqual(["embeds_without_prose", "no_summary"]);
    expect(by("loose")).toEqual(["empty_notebook", "off_shelf"]);
    expect(by("probe")).toEqual(["off_shelf", "unknown_study"]);
    expect(by("q")).toEqual(["bears_on_not_a_claim", "off_shelf"]);
    expect(by(undefined)).toEqual([
      "ledger_order",
      "ledger_unknown",
      "no_bottom_line",
      "shelf_unknown",
      "task_without_notes",
    ]);
  });

  test("a figure names its runs, owes no summary, and a failed drawing of this revision is named (ADR 0053)", () => {
    // `undefined` drops a field: a figure with no summary, no runs or no script.
    const fig = (
      id: string,
      fields: { [K in keyof VaultNote]?: VaultNote[K] | undefined } = {},
    ) => {
      const n: Record<string, unknown> = {
        ...note(id, { type: "figure" }),
        figure: { script: "el.append('x')" },
        evidence: [{ run: "r1", role: "for" }],
        ...fields,
      };
      delete n["summary"];
      for (const k of Object.keys(n)) if (n[k] === undefined) delete n[k];
      return n as unknown as VaultNote;
    };
    const book = note("figs", {
      type: "notebook",
      summary: "The figures, with a sentence of connecting prose between each of them here.",
      full: "First.\n\n![[good]]\n\nThen.\n\n![[bare]]\n\nLast.\n\n![[broken]]\n\nAnd.\n\n![[unscripted]]",
    });
    const all = [
      book,
      fig("good"),
      fig("bare", { evidence: undefined }),
      fig("broken", { revision: 3 }),
      fig("unscripted", { figure: undefined }),
      note("concept-x"),
    ];
    const codes = (figures: Map<string, { revision: number; error?: string }>) =>
      checkVault(
        all,
        { shelf: ["figs"], ledger: { order: [] } },
        { runs: new Set(["r1"]), figures },
      )
        .filter((c) => c.note !== "concept-x" && c.code !== "off_shelf")
        .map((c) => `${c.note}:${c.code}`);
    expect(codes(new Map())).toEqual(["bare:figure_without_runs", "unscripted:no_figure"]);
    expect(codes(new Map([["broken", { revision: 3, error: "TypeError: boom" }]]))).toContain(
      "broken:figure_error",
    );
    // A report on an earlier revision says nothing about this one.
    expect(codes(new Map([["broken", { revision: 2, error: "TypeError: boom" }]]))).not.toContain(
      "broken:figure_error",
    );
  });

  test("a bottom line older than a claim is stale", () => {
    const checks = checkVault(NOTES, INDEX, { index_updated_at: "2026-10-01T00:00:00Z" });
    expect(checks.map((c) => c.code)).toEqual(["stale_bottom_line"]);
    expect(checks[0]?.message).toContain("2 claims");
  });
});

describe("the Markdown form", () => {
  test("a note file reads to its fields; summary and full split at the marker", () => {
    const { id, note: n } = parseNoteMarkdown(
      [
        "---",
        "id: width-helps",
        "type: claim",
        "title: Width helps",
        'gist: "Wider is better: by 0.04."',
        "standing: leaning",
        'key: { text: "0.41 → 0.37", label: "validation loss" }',
        "evidence:",
        "  - { run: base, role: baseline, metric: val_loss }",
        'sources: [task-1, "repo:train.py"]',
        "created: 2026-11-03",
        "---",
        "",
        "The summary.",
        "",
        "<!-- full -->",
        "",
        "The full text.",
        "",
        "![[finding]]",
        "",
      ].join("\n"),
      "width-helps",
    );
    expect(id).toBe("width-helps");
    expect(n).toEqual({
      type: "claim",
      title: "Width helps",
      gist: "Wider is better: by 0.04.",
      standing: "leaning",
      key: { text: "0.41 → 0.37", label: "validation loss" },
      evidence: [{ run: "base", role: "baseline", metric: "val_loss" }],
      sources: ["task-1", "repo:train.py"],
      created: "2026-11-03",
      summary: "The summary.",
      full: "The full text.\n\n![[finding]]",
    });
  });

  test("a notebook's opening paragraph is its summary; the composition is the rest", () => {
    const text =
      "---\nid: nb\ntype: notebook\ntitle: N\ngist: G.\n---\n\nIt opens.\n\nThen leads in.\n\n![[a]]\n";
    expect(parseNoteMarkdown(text).note).toMatchObject({
      summary: "It opens.",
      full: "Then leads in.\n\n![[a]]",
    });
    const straight = "---\nid: nb\ntype: notebook\ntitle: N\ngist: G.\n---\n\n## Part\n\n![[a]]\n";
    const parsed = parseNoteMarkdown(straight).note;
    expect(parsed.summary).toBeUndefined();
    expect(parsed.full).toBe("## Part\n\n![[a]]");
  });

  test("problems say what to fix", () => {
    expect(() => parseNoteMarkdown("just text")).toThrow("no frontmatter");
    expect(() => parseNoteMarkdown("---\nid: a\ntitle: x: y: [\n---\n")).toThrow("not valid YAML");
    expect(() => parseNoteMarkdown("---\nid: a\n---\n", "b")).toThrow("is not the file name");
  });

  test("a note and the index go out and come back the same", () => {
    const n = NOTES.find((x) => x.note_id === "claim-a") as VaultNote;
    const back = parseNoteMarkdown(renderNoteMarkdown(n), "claim-a").note;
    for (const k of [
      "type",
      "title",
      "gist",
      "summary",
      "full",
      "standing",
      "support",
      "sources",
    ] as const)
      expect(back[k]).toEqual(n[k]);
    expect(back.created).toBe("2026-11-01");
    expect(parseIndexYaml(renderIndexYaml(INDEX))).toEqual({
      shelf: ["book"],
      bottom_line: "Leaning.",
      order: ["claim-b", "claim-a"],
    });
    expect(parseIndexYaml("shelf: [a]\neditions: [e]\n")).toEqual({ shelf: ["a"], order: [] });
  });

  test("a figure's script goes out after its marker and comes back whole, backticks and all", () => {
    const script = "// a ``` fence inside\nconst t = `a`;\nel.append(Plot.plot({}));";
    const n = note("fig", {
      type: "figure",
      full: "How to read it.",
      figure: { script },
      evidence: [{ run: "r1", role: "for" }],
    });
    const md = renderNoteMarkdown(n);
    expect(md).toContain("<!-- figure -->\n\n````js\n");
    const back = parseNoteMarkdown(md, "fig").note;
    expect(back.figure).toEqual({ script });
    expect(back.full).toBe("How to read it.");
    expect(back.summary).toBe(n.summary);
    expect(() =>
      parseNoteMarkdown("---\nid: f\ntype: figure\n---\n\n<!-- figure -->\n\nno fence", "f"),
    ).toThrow("one fenced code block");
  });
});
