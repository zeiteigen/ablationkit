/** The agenda's pure logic (ADR 0058): naming items, the diff between revisions, the checks. */
import { describe, expect, test } from "bun:test";
import type { AgendaItem } from "@ablationkit/protocol";
import { agendaChecks, agendaDiff, findItem, itemLine } from "../src/agenda.ts";

const T = "2026-11-13T10:00:00.000Z";
const LATER = "2026-11-13T12:00:00.000Z";
const item = (x: Partial<AgendaItem> & Pick<AgendaItem, "item_id" | "lane">): AgendaItem => ({
  added_at: T,
  moved_at: T,
  ...x,
});
const titles = (id: string) =>
  id === "wd"
    ? { title: "Does weight decay matter?", type: "question", standing: "open" }
    : undefined;

describe("the agenda's logic", () => {
  test("an agent names an item by note:<id>, a bare note ID or L<n> in any case", () => {
    const items = [
      item({ item_id: "note:wd", lane: "now", note_id: "wd" }),
      item({ item_id: "L3", lane: "next", text: "x" }),
    ];
    expect(findItem(items, "note:wd")?.item_id).toBe("note:wd");
    expect(findItem(items, "wd")?.item_id).toBe("note:wd");
    expect(findItem(items, "l3")?.item_id).toBe("L3");
    expect(findItem(items, "L4")).toBeUndefined();
    expect(itemLine(items[0] as AgendaItem, titles)).toBe(
      "note:wd: Does weight decay matter? [question, open]",
    );
  });

  test("the diff says what moved, what was dropped and why, the new order, and the rules", () => {
    const before = {
      items: [
        item({ item_id: "note:wd", lane: "now", note_id: "wd" }),
        item({ item_id: "L1", lane: "next", text: "Three-seed baseline" }),
        item({ item_id: "L2", lane: "now", text: "Tokenizer ablations" }),
      ],
      rules: [{ rule_id: "R1", text: "Keep each job under an hour", added_at: T }],
    };
    const after = {
      items: [
        item({ item_id: "L1", lane: "now", text: "Three-seed baseline" }),
        item({ item_id: "note:wd", lane: "now", note_id: "wd" }),
        item({ item_id: "L2", lane: "dropped", text: "Tokenizer ablations", reason: "off topic" }),
        item({ item_id: "L3", lane: "next", text: "Warmup" }),
      ],
      rules: [{ rule_id: "R2", text: "Three seeds", added_at: T }],
    };
    expect(agendaDiff(before, after, titles)).toEqual([
      'Moved from Next to Now: L1 "Three-seed baseline"',
      'Dropped (was Now): L2 "Tokenizer ablations" (the researcher\'s reason: off topic)',
      'Added to Next: L3 "Warmup"',
      'Now, in order: 1. L1 "Three-seed baseline"; 2. note:wd "Does weight decay matter?"',
      'New rule R2: "Three seeds"',
      'Rule R1 withdrawn: "Keep each job under an hour"',
    ]);
    expect(agendaDiff(after, after, titles)).toEqual([]);
  });

  test("checks: work on a parked item, an item taken off, a live session whose jobs serve nothing in Now", () => {
    const agenda = {
      items: [
        item({ item_id: "note:wd", lane: "now", note_id: "wd" }),
        item({ item_id: "L1", lane: "parked", text: "Warmup", moved_at: LATER }),
      ],
      rules: [],
    };
    const checks = agendaChecks(
      agenda,
      {
        tasks: [
          { task_id: "t1", agenda_item: "L1", status: "open", session: "s1", title: "warmup" },
          { task_id: "t2", agenda_item: "L7", status: "open", session: "s2", title: "gone" },
          { task_id: "t3", agenda_item: "note:wd", status: "open", session: "s2", title: "wd" },
        ],
        jobs: [
          // Before the item was parked: fine.
          { job_id: "j0", task_id: "t1", session: "s1", created_at: T },
          // After: parked work.
          {
            job_id: "j1",
            agenda_item: "L1",
            session: "s1",
            created_at: "2026-11-13T13:00:00.000Z",
          },
          // Serves Now through its task.
          { job_id: "j2", task_id: "t3", session: "s2", created_at: LATER },
        ],
        sessions: [
          { token_id: "s1", label: "claude-code in lab" },
          { token_id: "s2", label: "codex in lab" },
        ],
        since: T,
      },
      titles,
    );
    expect(checks.map((c) => [c.code, c.task ?? c.job ?? c.session])).toEqual([
      ["parked_work", "t1"],
      ["not_on_agenda", "t2"],
      ["parked_work", "j1"],
      ["off_agenda", "s1"],
    ]);
  });
});
