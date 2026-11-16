import { describe, expect, test } from "bun:test";
import type { VaultNote } from "@ablationkit/protocol";
import {
  accountFor,
  checkVault,
  citations,
  handNumbers,
  linksOf,
  parseRunRef,
  runRefsOf,
  runsNamedBy,
  unreferencedNumbers,
} from "../src/index.ts";

function note(id: string, fields: Partial<VaultNote> = {}): VaultNote {
  return {
    schema_version: 1,
    note_id: id,
    project_id: "lab",
    type: "finding",
    title: id,
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
  };
}

const INDEX = { shelf: [], ledger: { order: [] } };

describe("live run references (ADR 0056)", () => {
  test("a reference names a run and a metric, and optionally a baseline", () => {
    expect(parseRunRef("run:sym64k-base#val/bpb")).toEqual({
      run: "sym64k-base",
      metric: "val/bpb",
    });
    expect(parseRunRef("run:fraise#bpb vs sym64k-base")).toEqual({
      run: "fraise",
      metric: "bpb",
      vs: "sym64k-base",
    });
    expect(parseRunRef("run:fraise#bpb vs run:base")).toMatchObject({ vs: "base" });
    expect(parseRunRef("run:fraise")).toBeUndefined();
    expect(parseRunRef("bits-per-byte")).toBeUndefined();
    expect(
      runRefsOf("Fraise trails by [[run:fraise#bpb vs base]], at [[run:fraise#bpb]] BPB."),
    ).toEqual([
      { run: "fraise", metric: "bpb", vs: "base" },
      { run: "fraise", metric: "bpb" },
    ]);
  });

  test("a reference is not a link to a note, so it never reads as an unresolved link", () => {
    expect(linksOf("See [[metric]] and [[run:a#loss]].")).toEqual(["metric"]);
    const checks = checkVault(
      [note("f", { gist: "It ends at [[run:a#loss]].", evidence: [{ run: "a", role: "for" }] })],
      INDEX,
      { runs: new Set(["a"]) },
    );
    expect(checks.map((c) => c.code)).not.toContain("unresolved_link");
  });

  test("a reference to a run the project does not have is flagged, the baseline too", () => {
    const checks = checkVault(
      [note("f", { gist: "It is [[run:a#loss vs ghost]] lower." })],
      INDEX,
      {
        runs: new Set(["a"]),
      },
    );
    expect(checks.filter((c) => c.code === "unknown_run").map((c) => c.message)).toEqual([
      "the text refers to run `ghost`, which is not a run of this project",
    ]);
  });
});

describe("numbers typed by hand (ADR 0056)", () => {
  test("decimal numbers in prose are found; references, code, maths, IDs and versions are not", () => {
    expect(
      handNumbers("Fraise trails the 64k/64k by 0.039 BPB (−1.21%, 12.5% of the gap)."),
    ).toEqual(["0.039", "1.21%", "12.5%"]);
    expect(
      handNumbers(
        [
          "It ends at [[run:a#loss]] after 2000 steps in 2026, seed 3.",
          "`lr=0.003` and $\\alpha = 0.5$ and arXiv 2610.14162v2 (Section 3.2, Table 4.1).",
          "sym0.5, v1.2, run-0.5, 1.2.3, a 1.5B model, 0.5x, https://x.org/a/0.25.",
        ].join(" "),
      ),
    ).toEqual([]);
  });

  test("only reporting notes are checked, in each field of their prose", () => {
    expect(
      unreferencedNumbers(
        note("f", {
          gist: "It ends 0.04 lower.",
          summary: "See [[run:a#loss vs b]].",
          full: "Peak memory was 16.2 GB.\n\n![[other]]",
        }),
      ),
    ).toEqual([
      { field: "gist", numbers: ["0.04"] },
      { field: "full text", numbers: ["16.2"] },
    ]);
    expect(
      unreferencedNumbers(note("c", { type: "concept", gist: "BPB is 8 / 0.69 bits." })),
    ).toEqual([]);
  });

  test("a number a run is named after is a setting, not a result", () => {
    const n = note("f", {
      gist: "At lr 0.5 the loss ends 0.04 lower than at 0.1.",
      evidence: [{ run: "probe-lr0.5", role: "for" }],
    });
    expect(unreferencedNumbers(n)).toEqual([{ field: "gist", numbers: ["0.04", "0.1"] }]);
    expect(unreferencedNumbers(n, new Set(["0.1"]))).toEqual([
      { field: "gist", numbers: ["0.04"] },
    ]);
    const checks = checkVault([n], INDEX, { runs: new Set(["probe-lr0.5", "probe-lr0.1"]) });
    expect(checks.find((c) => c.code === "unreferenced_number")?.message).toStartWith(
      "its gist types `0.04` by hand",
    );
  });

  test("the vault check names the note and the bottom line", () => {
    const checks = checkVault(
      [note("f", { gist: "It ends 0.04 lower." })],
      { shelf: [], ledger: { order: [], bottom_line: "We stand at 1.21 BPB." } },
      {},
    );
    const typed = checks.filter((c) => c.code === "unreferenced_number");
    expect(typed.map((c) => c.note)).toEqual(["f", undefined]);
    expect(typed[0]?.message).toContain("`0.04`");
    expect(typed[1]?.message).toStartWith("the bottom line types `1.21`");
  });
});

describe("the file drawer (ADR 0056)", () => {
  const notes = [
    note("f", {
      gist: "Wide wins by [[run:wide#loss vs base]].",
      evidence: [{ run: "wide", role: "for" }],
    }),
    note("g", { sources: ["run:probe-id"] }),
    note("old", {
      evidence: [{ run: "diverged", role: "for" }],
      archived_at: "2026-11-02T00:00:00Z",
    }),
  ];

  test("a note names its evidence, its baselines, its references and its run sources", () => {
    expect(runsNamedBy(notes[0] as VaultNote).sort()).toEqual(["base", "wide"]);
    expect(runsNamedBy(notes[1] as VaultNote)).toEqual(["probe-id"]);
    const cited = citations(notes);
    expect(cited.get("wide")).toEqual(["f"]);
    expect(cited.has("diverged")).toBe(false);
  });

  test("each run is cited, set aside or unaccounted for, by name or by ID", () => {
    const cited = citations(notes);
    const aside = (id: string) =>
      id === "id-3" ? { reason: "diverged at step 900", at: "2026-11-02T00:00:00Z" } : undefined;
    expect(accountFor({ name: "base", id: "id-1", ended: true }, cited, aside)).toEqual({
      standing: "cited",
      cited_by: ["f"],
    });
    expect(accountFor({ name: "x", id: "probe-id", ended: true }, cited, aside).standing).toBe(
      "cited",
    );
    expect(accountFor({ name: "diverged", id: "id-3", ended: true }, cited, aside)).toEqual({
      standing: "set_aside",
      cited_by: [],
      set_aside: { reason: "diverged at step 900", at: "2026-11-02T00:00:00Z" },
    });
    expect(accountFor({ name: "lucky", id: "id-4", ended: true }, cited, aside).standing).toBe(
      "unaccounted",
    );
  });

  test("the check lists a task's ended, acknowledged runs that are neither", () => {
    const checks = checkVault(notes, INDEX, {
      task_runs: [
        {
          task_id: "task-1",
          title: "Width",
          runs: [
            { name: "base", id: "id-1", ended: true },
            { name: "wide", id: "id-2", ended: true },
            { name: "diverged", id: "id-3", ended: true },
            { name: "lucky", id: "id-4", ended: true },
            { name: "live", id: "id-5", ended: false },
            { name: "pending", ended: true },
          ],
        },
      ],
      set_aside: (id) => (id === "id-3" ? { reason: "diverged", at: "t" } : undefined),
    });
    const loose = checks.filter((c) => c.code === "unaccounted_runs");
    expect(loose).toHaveLength(1);
    expect(loose[0]?.message).toStartWith(
      "task task-1 (Width): 1 of its 4 ended runs is neither cited by a note nor set aside (lucky)",
    );
  });
});
