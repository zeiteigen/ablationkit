/**
 * The threat map stays true: every named test exists, the doc is generated, IDs are unique, and
 * nothing in the docs or UI promises more than the controls do (spec §7.11).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DOC, missingProofs, ROOT, render } from "../security-map.ts";
import { AREAS } from "../security-threats.ts";

const SWEEP = [
  "README.md",
  "docs/autonomy",
  "docs/security",
  "docs/extensions",
  "docs/contributing",
  "docs/release",
  "skills",
  "packages/extension-host/templates",
  "apps/web/src",
  "packages/builtin-llm/src/ui",
];

function files(rel: string): string[] {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [rel];
  return readdirSync(abs).flatMap((n) =>
    n === "node_modules" || n === "dist" ? [] : files(join(rel, n)),
  );
}

/** Wording that promises what §7.11 does not. A line that negates it is allowed. */
const CLAIM =
  /\b(guarantee[sd]?|cannot be bypassed|can(?:no|')t bypass|impossible to|fully (?:sandboxed|isolated|secure)|completely (?:isolated|secure)|tamper-?proof|unbreakable|100% secure)\b/i;
const NEGATED = /\b(never|not|no|without|nothing)\b/i;

describe("security threat map", () => {
  test("every named test exists", () => {
    expect(missingProofs()).toEqual([]);
  });

  test("the doc is generated from the registry", () => {
    expect(readFileSync(join(ROOT, DOC), "utf8")).toBe(render());
  });

  test("IDs are unique and every threat has a proof", () => {
    const ids = AREAS.flatMap((a) => a.threats.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of AREAS) for (const t of a.threats) expect(t.proofs.length).toBeGreaterThan(0);
  });

  test("an advisory or pattern-based control says where it stops", () => {
    for (const a of AREAS)
      for (const t of a.threats)
        if (/pattern-based|secret scan/i.test(`${t.control} ${t.limit ?? ""}`))
          expect([t.id, Boolean(t.limit)]).toEqual([t.id, true]);
  });

  test("docs and the UI do not overclaim", () => {
    const found: string[] = [];
    for (const f of SWEEP.flatMap(files)) {
      if (!/\.(md|tsx?|css)$/.test(f)) continue;
      const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (CLAIM.test(line) && !NEGATED.test(line)) found.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
