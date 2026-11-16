/**
 * The acceptance registry (`scripts/acceptance-criteria.ts`) stays in step with spec §15 and with
 * the tests: the same criterion IDs in the same order, every evidence file exists and names the
 * criterion it is evidence for, every suite is runnable, and only accepted states are used.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { suiteCommand } from "../acceptance.ts";
import {
  CI_SUITES,
  CRITERIA,
  mentionedCriteria,
  REAL_SUITES,
  specCriterionIds,
} from "../acceptance-criteria.ts";

const ROOT = resolve(import.meta.dir, "../..");

describe("acceptance registry", () => {
  test("lists exactly the spec §15 criteria, in order", () => {
    const spec = readFileSync(join(ROOT, "docs/spec/AblationKit_SPEC.md"), "utf8");
    const ids = specCriterionIds(spec);
    expect(ids.length).toBeGreaterThanOrEqual(60);
    expect(CRITERIA.map((c) => c.id)).toEqual(ids);
  });

  test("the mention parser reads ranges and lists", () => {
    expect([...mentionedCriteria("Criteria 20–26, 28, 29")]).toEqual([
      "20",
      "21",
      "22",
      "23",
      "24",
      "25",
      "26",
      "28",
      "29",
    ]);
    expect([...mentionedCriteria("criteria 5-8 and criterion 9c")]).toEqual([
      "5",
      "6",
      "7",
      "8",
      "9c",
    ]);
    expect([...mentionedCriteria("criteria 15, 15a, 9d")]).toEqual(["15", "15a", "9d"]);
  });

  test("every evidence file exists and names its criterion", () => {
    const problems: string[] = [];
    for (const c of CRITERIA)
      for (const e of c.evidence) {
        const p = join(ROOT, e.file);
        if (!existsSync(p)) {
          problems.push(`${c.id}: ${e.file} does not exist`);
          continue;
        }
        if (!mentionedCriteria(readFileSync(p, "utf8")).has(c.id))
          problems.push(`${c.id}: ${e.file} never names criterion ${c.id}`);
      }
    expect(problems).toEqual([]);
  });

  test("states are honest: automated has evidence, anything else says why", () => {
    for (const c of CRITERIA) {
      if (c.status === "automated") expect(c.evidence.length, c.id).toBeGreaterThan(0);
      else expect((c.note ?? "").length, c.id).toBeGreaterThan(10);
    }
  });

  test("every suite resolves to a command", () => {
    const suites = new Set(CRITERIA.flatMap((c) => c.evidence.map((e) => e.suite)));
    for (const s of suites) {
      expect([...CI_SUITES, ...REAL_SUITES] as string[], s).toContain(s);
      if (s !== "unit" && s !== "mlflow-coverage")
        expect(suiteCommand(s).files.length, s).toBeGreaterThan(0);
    }
  });
});
