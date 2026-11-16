import { describe, expect, test } from "bun:test";
import {
  type VaultNote,
  type VaultWork,
  validateVaultNote,
  validateVaultWork,
} from "@ablationkit/protocol";
import {
  annotation,
  checkVault,
  checkWorks,
  citationEntries,
  rolesOf,
  shortCite,
  toBibtex,
  toCslJson,
  toMarkdown,
  usesByWork,
  workHref,
  workKeys,
  workMatches,
  workStanding,
} from "../src/index.ts";
import { parseWorkMarkdown, renderWorkMarkdown } from "../src/markdown.ts";

function note(id: string, fields: Partial<VaultNote> = {}): VaultNote {
  return validateVaultNote({
    schema_version: 1,
    note_id: id,
    project_id: "lab",
    type: "finding",
    title: `The ${id} note`,
    gist: `${id} is a thing.`,
    sources: ["repo:README.md"],
    created: "2026-11-01",
    updated: "2026-11-01",
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    created_by: { kind: "agent" },
    updated_by: { kind: "agent" },
    revision: 1,
    ...fields,
  });
}

function work(
  id: string,
  fields: { [K in keyof VaultWork]?: VaultWork[K] | undefined } = {},
): VaultWork {
  const w: Record<string, unknown> = {
    schema_version: 1,
    work_id: id,
    project_id: "lab",
    kind: "paper",
    title: "On Layer Normalization in the Transformer Architecture",
    authors: ["Xiong, Ruibin", "Yang, Yunchang", "others"],
    year: 2020,
    venue: "ICML 2020",
    arxiv: "2002.04745",
    reading: "read",
    takeaway: "The final LayerNorm is part of the Pre-LN design; we were missing it.",
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    created_by: { kind: "agent" },
    updated_by: { kind: "agent" },
    revision: 1,
    ...fields,
  };
  for (const k of Object.keys(w)) if (w[k] === undefined) delete w[k];
  return validateVaultWork(w);
}

const XIONG = work("xiong-2020-layernorm");
const NANO = work("karpathy-nanogpt", {
  kind: "repo",
  title: "nanoGPT",
  authors: ["Karpathy, Andrej"],
  year: undefined,
  venue: undefined,
  arxiv: undefined,
  url: "https://github.com/karpathy/nanoGPT",
  version: "93a43d9",
  reading: "skimmed",
  takeaway: "Set aside: it ties embeddings & we study that separately.",
});
const TODO = work("someone-2024-later", {
  arxiv: "2401.00001",
  reading: "unread",
  takeaway: "Not read yet; looks related to warm-up.",
});
const FIX = note("fix", {
  title: "Adding the final LayerNorm closes the gap",
  cites: [
    { work: "xiong-2020-layernorm", role: "solution", where: "§3" },
    { work: "xiong-2020-layernorm", role: "background" },
  ],
});
const BASE = note("base", { cites: [{ work: "xiong-2020-layernorm", role: "baseline" }] });

describe("the library", () => {
  test("uses, roles and where a work stands", () => {
    const uses = usesByWork([
      FIX,
      BASE,
      note("gone", {
        archived_at: "2026-11-02T00:00:00Z",
        cites: [{ work: "karpathy-nanogpt", role: "tool" }],
      }),
    ]);
    expect(rolesOf(uses.get("xiong-2020-layernorm"))).toEqual([
      "solution",
      "baseline",
      "background",
    ]);
    expect(uses.has("karpathy-nanogpt")).toBe(false);
    expect(workStanding(XIONG, uses.get(XIONG.work_id))).toBe("used");
    expect(workStanding(NANO, undefined)).toBe("considered");
    expect(workStanding(TODO, undefined)).toBe("unread");
  });

  test("names, links and identities", () => {
    expect(shortCite(XIONG)).toBe("Xiong et al. 2020");
    expect(shortCite(NANO)).toBe("Karpathy");
    expect(shortCite({ authors: ["Ba, Jimmy", "Hinton, Geoffrey"], year: 2016, title: "x" })).toBe(
      "Ba and Hinton 2016",
    );
    expect(workHref(XIONG)).toBe("https://arxiv.org/abs/2002.04745");
    expect(workHref({ doi: "10.1000/xyz", url: "https://x.org" })).toBe(
      "https://doi.org/10.1000/xyz",
    );
    // The same paper by arXiv ID, a versioned ID and its abs URL is one work.
    expect(workKeys({ arxiv: "2002.04745v2" })).toEqual(["arxiv:2002.04745"]);
    expect(workKeys({ url: "https://arxiv.org/abs/2002.04745v1" })).toEqual(["arxiv:2002.04745"]);
    expect(workKeys({ url: "https://www.github.com/karpathy/nanoGPT.git/" })).toEqual([
      "url:github.com/karpathy/nanogpt",
    ]);
    expect(workMatches(XIONG, "xiong layernorm")).toBe(true);
    expect(workMatches(XIONG, "xiong attention")).toBe(false);
  });

  test("checks: unknown and unread works, no locator, duplicates, unresearched questions", () => {
    const notes = [
      FIX,
      note("leans", { cites: [{ work: "someone-2024-later", role: "supports" }] }),
      note("idea", { cites: [{ work: "someone-2024-later", role: "inspiration" }] }),
      note("lost", { cites: [{ work: "nobody-1999", role: "method" }] }),
      note("asks", { type: "question", standing: "open", sources: [] }),
      note("asked", {
        type: "question",
        standing: "open",
        sources: [],
        cites: [{ work: "xiong-2020-layernorm", role: "background" }],
      }),
    ];
    const works = [
      XIONG,
      TODO,
      work("no-link", { arxiv: undefined }),
      work("xiong-again", { arxiv: undefined, url: "https://arxiv.org/abs/2002.04745" }),
    ];
    const codes = checkWorks(notes, works).map((c) => `${c.code}:${c.note ?? c.work}`);
    expect(codes.sort()).toEqual(
      [
        "cites_unread:leans",
        "unknown_work:lost",
        "question_without_prior_work:asks",
        "work_without_locator:no-link",
        "duplicate_work:xiong-again",
      ].sort(),
    );
    // The vault's checks include the library's when it is given, and a cite counts as a source.
    const all = checkVault(
      [note("cited", { sources: [], cites: [{ work: "xiong-2020-layernorm", role: "method" }] })],
      { shelf: [], ledger: { order: [] } },
      { works: [XIONG] },
    );
    expect(all.map((c) => c.code)).not.toContain("no_sources");
    expect(
      checkVault(notes, { shelf: [], ledger: { order: [] } }).map((c) => c.code),
    ).not.toContain("unknown_work");
  });
});

describe("citations", () => {
  const entries = citationEntries([XIONG, NANO, TODO], [FIX, BASE]);

  test("which works: all, cited, or beneath a notebook", () => {
    expect(entries.map((e) => e.work.work_id)).toEqual([
      "karpathy-nanogpt",
      "someone-2024-later",
      "xiong-2020-layernorm",
    ]);
    expect(
      citationEntries([XIONG, NANO], [FIX], { cited: true }).map((e) => e.work.work_id),
    ).toEqual(["xiong-2020-layernorm"]);
    const scoped = citationEntries([XIONG, NANO], [FIX, BASE], { only: new Set(["base"]) });
    expect(scoped.map((e) => e.uses.map((u) => u.role))).toEqual([["baseline"]]);
    expect(citationEntries([{ ...XIONG, archived_at: "2026-11-02T00:00:00Z" }], [FIX])).toEqual([]);
  });

  test("the annotation says the role each work played and what was taken from it", () => {
    const x = entries.find((e) => e.work.work_id === "xiong-2020-layernorm");
    expect(annotation(x as never)).toBe(
      "Role: solution in “Adding the final LayerNorm closes the gap” (§3); baseline in “The base note”; background in “Adding the final LayerNorm closes the gap”. Takeaway: The final LayerNorm is part of the Pre-LN design; we were missing it.",
    );
    const n = entries.find((e) => e.work.work_id === "karpathy-nanogpt");
    expect(annotation(n as never)).toStartWith("Role: consulted, not cited (skimmed).");
  });

  test("BibTeX", () => {
    const bib = toBibtex(entries);
    expect(bib).toContain("@inproceedings{xiong-2020-layernorm,");
    expect(bib).toContain("author        = {Xiong, Ruibin and Yang, Yunchang and others}");
    expect(bib).toContain(
      "title         = {{On Layer Normalization in the Transformer Architecture}}",
    );
    expect(bib).toContain("booktitle     = {ICML 2020}");
    expect(bib).toContain("eprint        = {2002.04745}");
    expect(bib).toContain("archiveprefix = {arXiv}");
    expect(bib).toContain("annote        = {Role: solution in");
    expect(bib).toContain("@misc{karpathy-nanogpt,");
    expect(bib).toContain("note   = {Version 93a43d9}");
    // TeX's special characters are escaped.
    expect(bib).toContain("embeddings \\& we study");
    // Balanced braces in every entry.
    for (const entry of bib.split("\n@")) {
      const open = (entry.match(/(?<!\\)\{/g) ?? []).length;
      const close = (entry.match(/(?<!\\)\}/g) ?? []).length;
      expect(open).toBe(close);
    }
  });

  test("CSL-JSON", () => {
    const items = JSON.parse(toCslJson(entries)) as Record<string, unknown>[];
    const x = items.find((i) => i["id"] === "xiong-2020-layernorm") as Record<string, unknown>;
    expect(x["type"]).toBe("paper-conference");
    expect(x["author"]).toEqual([
      { family: "Xiong", given: "Ruibin" },
      { family: "Yang", given: "Yunchang" },
    ]);
    expect(x["issued"]).toEqual({ "date-parts": [[2020]] });
    expect(x["URL"]).toBe("https://arxiv.org/abs/2002.04745");
    expect(String(x["note"])).toStartWith("Role: solution in");
    const n = items.find((i) => i["id"] === "karpathy-nanogpt") as Record<string, unknown>;
    expect([n["type"], n["version"]]).toEqual(["software", "93a43d9"]);
  });

  test("an annotated bibliography by role", () => {
    const md = toMarkdown(entries, "Prior work");
    expect(md).toStartWith("# Prior work\n");
    expect(md.indexOf("## Solutions to problems we hit")).toBeLessThan(
      md.indexOf("## Considered and set aside"),
    );
    expect(md.indexOf("## Considered and set aside")).toBeLessThan(
      md.indexOf("## Found, not read yet"),
    );
    expect(md).toContain(
      "[On Layer Normalization in the Transformer Architecture](https://arxiv.org/abs/2002.04745)",
    );
    expect(md).toContain("*Role:* solution in");
    expect(md).not.toContain("## Background");
  });
});

test("a work as Markdown and back", () => {
  const w = {
    ...NANO,
    summary: "A minimal GPT training loop.\n\nIt fits in one file.",
    found_for: "a reference loop",
  };
  const { id, work: back } = parseWorkMarkdown(renderWorkMarkdown(w), "karpathy-nanogpt");
  expect(id).toBe("karpathy-nanogpt");
  expect(back).toEqual({
    kind: "repo",
    title: "nanoGPT",
    authors: ["Karpathy, Andrej"],
    url: "https://github.com/karpathy/nanoGPT",
    version: "93a43d9",
    reading: "skimmed",
    summary: "A minimal GPT training loop.\n\nIt fits in one file.",
    takeaway: "Set aside: it ties embeddings & we study that separately.",
    found_for: "a reference loop",
  });
  // A year stays a number; an arXiv ID that YAML would read as a number stays text.
  const x = parseWorkMarkdown(renderWorkMarkdown(XIONG)).work;
  expect([x.year, x.arxiv]).toEqual([2020, "2002.04745"]);
  const bare = parseWorkMarkdown(
    "---\nid: w\nkind: paper\ntitle: T\narxiv: 2002.04740\nversion: 1.10\nreading: read\ntakeaway: t\n---\n",
  ).work;
  expect([bare.arxiv, bare.version, bare.authors]).toEqual(["2002.04740", "1.10", []]);
});
