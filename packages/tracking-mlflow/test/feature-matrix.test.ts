/**
 * Criterion 18: the MLflow feature compatibility matrix stays consistent with the code, and no
 * required feature needs the stock MLflow UI. The other half (every listed feature succeeded
 * against the pinned MLflow) is `bun scripts/mlflow-matrix.ts --coverage`, run by `bun run ci`
 * after the real-MLflow suites.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, coverage, ROOT } from "../../../scripts/mlflow-matrix.ts";
import { endpointPattern, MLFLOW_FEATURES } from "../src/feature-matrix.ts";

describe("MLflow feature matrix (criterion 18)", () => {
  test("lists every endpoint and bridge op the code uses, and nothing it does not", () => {
    expect(check()).toEqual([]);
  });

  test("covers the required MLflow areas of spec §5.5", () => {
    const areas = new Set(MLFLOW_FEATURES.map((f) => f.area));
    for (const a of [
      "Experiments and runs",
      "Artifacts",
      "Datasets",
      "Logged models",
      "Model registry",
      "Classical evaluation",
      "MLflow Projects",
      "Inference",
      "Tracing",
      "Prompt registry",
      "GenAI evaluation",
    ])
      expect(areas.has(a as never)).toBe(true);
  });

  test("coverage reads a trace: only successes count, and a missing feature is reported", () => {
    const all = MLFLOW_FEATURES.flatMap((f) => [
      ...(f.rest ?? []).map((r) => `${f.suites[0]} rest ${r.replace(/:x/g, "abc")} 200`),
      ...(f.bridge ?? []).map((b) => `${f.suites[0]} bridge ${b} ok`),
    ]).join("\n");
    expect(coverage(all)).toEqual([]);
    const failing = all.replace("rest GET /health 200", "rest GET /health 503");
    expect(coverage(failing)).toEqual([
      "server.health: GET /health never succeeded in test:mlflow or test:lifecycle or test:restore",
    ]);
    expect(coverage(all.replace("bridge serve ok", "bridge serve error"))).toEqual([
      "inference.sessions: bridge serve never succeeded in test:inference",
    ]);
    // A success in a suite the row does not list does not count.
    const elsewhere = all.replace("test:inference bridge serve ok", "test:mlflow bridge serve ok");
    expect(coverage(elsewhere)).toEqual([
      "inference.sessions: bridge serve never succeeded in test:inference",
    ]);
    expect(
      endpointPattern("GET /api/3.0/mlflow/traces/:x").test("GET /api/3.0/mlflow/traces/tr-1"),
    ).toBe(true);
  });

  test("the web app never links to, frames or proxies the stock MLflow UI", () => {
    const glob = new Bun.Glob("**/*.{ts,tsx,html}");
    const offenders: string[] = [];
    for (const rel of glob.scanSync({ cwd: join(ROOT, "apps/web/src") })) {
      const src = readFileSync(join(ROOT, "apps/web/src", rel), "utf8");
      if (/#\/experiments|\/static-files\/|ajax-api|mlflow_ui|:5000\b|MLflow UI/i.test(src))
        offenders.push(rel);
      // Frames are only the sandboxed extension and backend views and vault figures (ADR 0053).
      if (/<iframe/.test(src) && !/ExtensionFrame|BackendPage|Figure\.tsx$/.test(rel))
        offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
