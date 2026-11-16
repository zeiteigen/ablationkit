/**
 * The MLflow feature compatibility matrix (criterion 18). Data: packages/tracking-mlflow/src/
 * feature-matrix.ts. Output: docs/api/mlflow-compatibility.md.
 *
 *   bun scripts/mlflow-matrix.ts --write            regenerate the doc
 *   bun scripts/mlflow-matrix.ts --check            static checks (also run by bun test)
 *   bun scripts/mlflow-matrix.ts --coverage FILE    every listed endpoint and op succeeded in the
 *                                                   trace a real-MLflow run wrote (CI)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  endpointPattern,
  MLFLOW_FEATURES,
  type MlflowFeature,
} from "../packages/tracking-mlflow/src/feature-matrix.ts";

export const ROOT = resolve(import.meta.dir, "..");
export const DOC = "docs/api/mlflow-compatibility.md";

/** Files that call MLflow REST directly (only the coordinator does). */
const REST_CALLERS = [
  "packages/tracking-mlflow/src/client.ts",
  "apps/server/src/extensions/tracking.ts",
];
/** Files that hold bridge ops (`OPS = {...}`) and call Python MLflow APIs. */
const PYTHON_SOURCES = [
  "packages/tracking-mlflow/env/bridge/ablationkit_bridge.py",
  "packages/builtin-llm/src/python/genai.py",
  "packages/builtin-llm/src/python/sdk",
  "fixtures/projects/sklearn-lifecycle",
  "fixtures/projects/llm-rag-agent",
];

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Every `METHOD /path` the REST callers use, with `:x` for interpolated segments. */
export function clientEndpoints(): string[] {
  const out = new Set<string>();
  for (const f of REST_CALLERS) {
    const src = read(f);
    for (const m of src.matchAll(
      /(?:this|client)\.(call|raw|v3)(?:<[^()]*?>)?\(\s*"([A-Z]+)",\s*(?:"([^"]+)"|`([^`]+)`)/gs,
    )) {
      const [, kind, method, plain, tpl] = m as unknown as [
        string,
        string,
        string,
        string?,
        string?,
      ];
      let p = (plain ?? tpl) as string;
      if (/^\$\{API\}\/\$\{[^}]+\}$|^\$\{[^}]+\}$/.test(p)) continue; // the generic call() itself
      p = p.replace(/^\$\{API\}/, "/api/2.0/mlflow").replace(/\$\{[^}]+\}/g, ":x");
      if (kind === "call") p = `/api/2.0/mlflow/${p}`;
      if (kind === "v3") p = `/api/3.0/mlflow/${p}`;
      out.add(`${method} ${p}`);
    }
  }
  return [...out].sort();
}

function pythonText(): string {
  const parts: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    if (rel.endsWith(".py")) {
      parts.push(read(rel));
      return;
    }
    for (const n of new Bun.Glob("**/*.py").scanSync({ cwd: abs })) parts.push(read(join(rel, n)));
  };
  for (const s of PYTHON_SOURCES) walk(s);
  return parts.join("\n");
}

export function bridgeOps(): string[] {
  const ops = new Set<string>();
  for (const f of PYTHON_SOURCES.filter((s) => s.endsWith(".py")))
    for (const m of read(f).matchAll(/^OPS = \{([^}]*)\}/gm))
      for (const k of (m[1] as string).matchAll(/"([a-z_]+)":/g)) ops.add(k[1] as string);
  return [...ops].sort();
}

const covers = (f: MlflowFeature, endpoint: string) =>
  (f.rest ?? []).some(
    (r) => r === endpoint || endpointPattern(r).test(endpoint.replace(/:x/g, "x")),
  );

/** Static problems: undeclared endpoints or ops, stale Python APIs, an outdated doc. */
export function check(): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const f of MLFLOW_FEATURES) {
    if (ids.has(f.id)) problems.push(`duplicate feature id ${f.id}`);
    ids.add(f.id);
    if (f.suites.length === 0) problems.push(`${f.id}: no real-MLflow suite`);
    if (/mlflow ui|stock/i.test(f.surface)) problems.push(`${f.id}: surface names the MLflow UI`);
  }
  for (const e of clientEndpoints())
    if (!MLFLOW_FEATURES.some((f) => covers(f, e)))
      problems.push(`the client calls ${e}, which no matrix row lists`);
  const listedRest = MLFLOW_FEATURES.flatMap((f) => f.rest ?? []);
  const used = clientEndpoints();
  for (const r of listedRest)
    if (!used.some((e) => e === r || endpointPattern(r).test(e.replace(/:x/g, "x"))))
      problems.push(`the matrix lists ${r}, which the client never calls`);
  const ops = bridgeOps();
  for (const op of ops)
    if (!MLFLOW_FEATURES.some((f) => f.bridge?.includes(op)))
      problems.push(`bridge op ${op} is in no matrix row`);
  for (const f of MLFLOW_FEATURES)
    for (const op of f.bridge ?? [])
      if (!ops.includes(op)) problems.push(`${f.id}: bridge op ${op} no longer exists`);
  const py = pythonText();
  for (const f of MLFLOW_FEATURES)
    for (const api of f.python ?? [])
      if (!py.includes(`${api}(`)) problems.push(`${f.id}: ${api} is no longer called`);
  const doc = join(ROOT, DOC);
  if (!existsSync(doc) || readFileSync(doc, "utf8") !== render())
    problems.push(`${DOC} is stale: run bun scripts/mlflow-matrix.ts --write`);
  return problems;
}

function pinnedMlflow(): string {
  const lock = read("packages/tracking-mlflow/env/uv.lock");
  const m = /\[\[package\]\]\nname = "mlflow"\nversion = "([^"]+)"/.exec(lock);
  return m ? (m[1] as string) : "unknown";
}

export function render(): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  const lines = [
    "# MLflow feature compatibility matrix",
    "",
    "<!-- Generated by `bun scripts/mlflow-matrix.ts --write` from",
    "packages/tracking-mlflow/src/feature-matrix.ts. Do not edit by hand. -->",
    "",
    `Pinned MLflow: **${pinnedMlflow()}** (\`packages/tracking-mlflow/env/uv.lock\`). Criterion 18 (spec §15): every MLflow capability AblationKit relies on, the REST endpoints or Python APIs that provide it, where it is used in AblationKit, and the suites that run it against the pinned server. No row needs the stock MLflow UI, which AblationKit never links to, frames or proxies.`,
    "",
    "How it stays true:",
    "",
    "- `bun test` (`packages/tracking-mlflow/test/feature-matrix.test.ts`) fails if the client calls an endpoint, or the bridge has an op, that no row lists; if a row lists an endpoint, op or Python API the code no longer uses; or if this page is stale.",
    "- `bun run ci` runs the real-MLflow suites with `ABLATIONKIT_MLFLOW_TRACE` set, then `bun scripts/mlflow-matrix.ts --coverage` fails unless every endpoint and op below succeeded against the pinned server in that run.",
    "- Bump the pin only with those suites passing (`AGENTS.md`).",
    "",
  ];
  let area = "";
  for (const f of MLFLOW_FEATURES) {
    if (f.area !== area) {
      area = f.area;
      lines.push(
        `## ${area}`,
        "",
        "| Feature | MLflow | AblationKit | Suites |",
        "| --- | --- | --- | --- |",
      );
    }
    const mlflow = [
      ...(f.rest ?? []).map((r) => `\`${r}\``),
      ...(f.bridge ?? []).map((b) => `bridge \`${b}\``),
      ...(f.python ?? []).map((p) => `\`${p}\``),
    ];
    lines.push(
      `| ${cell(f.feature)}${f.note ? `. ${cell(f.note)}` : ""} | ${mlflow.join("<br>") || "—"} | ${cell(f.surface)} | ${f.suites.map((s) => `\`${s}\``).join(", ")} |`,
    );
    const next = MLFLOW_FEATURES[MLFLOW_FEATURES.indexOf(f) + 1];
    if (!next || next.area !== area) lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Problems with a trace written by real-MLflow runs: listed features that never succeeded. */
export function coverage(trace: string): string[] {
  // suite → successful `METHOD path` calls and ops
  const ok = new Map<string, Set<string>>();
  const add = (suite: string, v: string) => {
    const set = ok.get(suite) ?? new Set<string>();
    ok.set(suite, set);
    set.add(v);
  };
  for (const line of trace.split("\n")) {
    const [suite, kind, a, b, c] = line.split(" ");
    if (!suite) continue;
    if (kind === "rest" && /^[23][0-9][0-9]$/.test(c ?? "")) add(suite, `${a} ${b}`);
    if (kind === "bridge" && b === "ok") add(suite, `bridge ${a}`);
  }
  const labelled = [...ok.keys()].some((s) => s !== "-");
  const seen = (f: MlflowFeature, test: (v: string) => boolean) =>
    // With suite labels, it must have run in one of the row's suites; without, anywhere.
    [...ok.entries()].some(
      ([suite, set]) =>
        (!labelled || (f.suites as readonly string[]).includes(suite)) && [...set].some(test),
    );
  const problems: string[] = [];
  for (const f of MLFLOW_FEATURES) {
    const where = labelled ? ` in ${f.suites.join(" or ")}` : "";
    for (const r of f.rest ?? []) {
      const re = endpointPattern(r);
      if (!seen(f, (v) => re.test(v))) problems.push(`${f.id}: ${r} never succeeded${where}`);
    }
    for (const op of f.bridge ?? [])
      if (!seen(f, (v) => v === `bridge ${op}`))
        problems.push(`${f.id}: bridge ${op} never succeeded${where}`);
  }
  return problems;
}

if (import.meta.main) {
  const [mode, file] = process.argv.slice(2);
  if (mode === "--write") {
    writeFileSync(join(ROOT, DOC), render());
    console.log(`wrote ${DOC}`);
  } else if (mode === "--check" || mode === "--coverage") {
    const problems =
      mode === "--check"
        ? check()
        : file && existsSync(file)
          ? coverage(readFileSync(file, "utf8"))
          : [`no trace file ${file ?? "(none given)"}`];
    for (const p of problems) console.error(`  ${p}`);
    if (problems.length) {
      console.error(`mlflow feature matrix: ${problems.length} problem(s)`);
      process.exit(1);
    }
    console.log(
      mode === "--check"
        ? `mlflow feature matrix: ${MLFLOW_FEATURES.length} features, consistent with the code`
        : `mlflow feature matrix: every listed endpoint and op succeeded against the pinned MLflow`,
    );
  } else {
    console.error("usage: bun scripts/mlflow-matrix.ts --write | --check | --coverage FILE");
    process.exit(2);
  }
}
