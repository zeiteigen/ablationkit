/**
 * The release acceptance sweep (Stage 18): run the evidence for every spec §15 criterion and write
 * a pass/fail report.
 *
 *   bun scripts/acceptance.ts                     the suites CI runs (unit, web, real MLflow)
 *   bun scripts/acceptance.ts --real              also the opt-in suites that fetch wheels or
 *                                                 download torch
 *   bun scripts/acceptance.ts --suites unit,test:llm
 *   bun scripts/acceptance.ts --out FILE          default docs/release/acceptance-report.md
 *
 * Each suite runs once (`bun test FILES --reporter=junit`, with the suite's env from package.json).
 * A file passes when it ran at least one test, none failed and not all were skipped. A criterion
 * passes when every evidence file that ran passed; evidence in suites that were not selected is
 * listed as not run, never as passing. Registry: scripts/acceptance-criteria.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CI_SUITES,
  CRITERIA,
  type Criterion,
  REAL_SUITES,
  specCriterionIds,
} from "./acceptance-criteria.ts";
import { coverage } from "./mlflow-matrix.ts";

const ROOT = resolve(import.meta.dir, "..");

export interface SuiteCommand {
  env: Record<string, string>;
  files: string[];
  timeout?: number;
}

/** `ABLATIONKIT_X_E2E=1 bun test PATHS --timeout N` from package.json, as data. */
export function suiteCommand(name: string): SuiteCommand {
  const scripts = (
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const script = scripts[name];
  if (!script) throw new Error(`no package.json script ${name}`);
  const words = script.split(/\s+/);
  const env: Record<string, string> = {};
  let i = 0;
  while (words[i]?.includes("=")) {
    const [k, v] = (words[i] as string).split("=") as [string, string];
    env[k] = v;
    i++;
  }
  if (words[i] !== "bun" || words[i + 1] !== "test")
    throw new Error(`${name} is not a bun test script: ${script}`);
  const files: string[] = [];
  let timeout: number | undefined;
  for (let j = i + 2; j < words.length; j++) {
    if (words[j] === "--timeout") timeout = Number(words[++j]);
    else if (!(words[j] as string).startsWith("-")) files.push(words[j] as string);
  }
  return { env, files, ...(timeout ? { timeout } : {}) };
}

export interface FileResult {
  tests: number;
  failures: number;
  skipped: number;
}
export type Outcome = "pass" | "fail" | "skipped" | "not_run" | "error";

export function parseJunit(xml: string): Map<string, FileResult> {
  const out = new Map<string, FileResult>();
  for (const m of xml.matchAll(
    /^ {2}<testsuite name="([^"]+)"[^>]*?\btests="(\d+)"[^>]*?\bfailures="(\d+)"[^>]*?\bskipped="(\d+)"/gm,
  ))
    out.set(m[1] as string, { tests: Number(m[2]), failures: Number(m[3]), skipped: Number(m[4]) });
  return out;
}

export function fileOutcome(r: FileResult | undefined): Outcome {
  if (!r) return "error";
  if (r.failures > 0) return "fail";
  if (r.tests === 0 || r.skipped >= r.tests) return "skipped";
  return "pass";
}

interface SuiteRun {
  suite: string;
  exitCode: number;
  seconds: number;
  files: Map<string, FileResult>;
  problems?: string[];
}

function runSuite(suite: string, files: string[], trace: string, scratch: string): SuiteRun {
  const start = performance.now();
  const junit = join(scratch, `${suite.replace(/[^a-z0-9]/gi, "_")}.xml`);
  const cmd = suite === "unit" ? { env: {}, files, timeout: 60_000 } : suiteCommand(suite);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...cmd.env };
  if (
    ["test:mlflow", "test:lifecycle", "test:inference", "test:llm", "test:restore"].includes(suite)
  ) {
    env["ABLATIONKIT_MLFLOW_TRACE"] = trace;
    env["ABLATIONKIT_MLFLOW_TRACE_SUITE"] = suite;
  }
  const argv = [
    "bun",
    "test",
    ...cmd.files,
    ...(cmd.timeout ? ["--timeout", String(cmd.timeout)] : []),
    "--reporter=junit",
    `--reporter-outfile=${junit}`,
  ];
  console.log(`\n== ${suite}: ${argv.slice(0, 2 + cmd.files.length).join(" ")}`);
  const p = Bun.spawnSync(argv, { cwd: ROOT, env, stdout: "inherit", stderr: "inherit" });
  return {
    suite,
    exitCode: p.exitCode ?? 1,
    seconds: (performance.now() - start) / 1000,
    files: existsSync(junit) ? parseJunit(readFileSync(junit, "utf8")) : new Map(),
  };
}

export interface CriterionResult {
  criterion: Criterion;
  title: string;
  result: "pass" | "fail" | "partial" | "not_run" | "not_started" | "exception";
  evidence: { file: string; suite: string; outcome: Outcome }[];
}

export function judge(
  criterion: Criterion,
  title: string,
  outcomes: (suite: string, file: string) => Outcome,
): CriterionResult {
  const evidence = criterion.evidence.map((e) => ({ ...e, outcome: outcomes(e.suite, e.file) }));
  let result: CriterionResult["result"];
  if (criterion.status === "not_started" || criterion.status === "exception")
    result = criterion.status;
  else if (evidence.some((e) => ["fail", "error", "skipped"].includes(e.outcome))) result = "fail";
  else if (!evidence.some((e) => e.outcome === "pass")) result = "not_run";
  else result = criterion.status === "partial" ? "partial" : "pass";
  return { criterion, title, result, evidence };
}

function titles(): Map<string, string> {
  const spec = readFileSync(join(ROOT, "docs/spec/AblationKit_SPEC.md"), "utf8");
  const out = new Map<string, string>();
  const start = spec.indexOf("## 15. Acceptance criteria");
  const section = spec.slice(start, spec.indexOf("## 16.", start));
  for (const m of section.matchAll(/^([0-9]+[a-z]?)\. \*\*([^*]+?):?\*\*/gm))
    if (!out.has(m[1] as string)) out.set(m[1] as string, (m[2] as string).replace(/:$/, ""));
  return out;
}

function git(...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return p.stdout.toString().trim();
}

export function renderReport(
  results: CriterionResult[],
  runs: SuiteRun[],
  meta: { date: string; commit: string; dirty: boolean; suites: string[] },
): string {
  const count = (r: CriterionResult["result"]) => results.filter((x) => x.result === r).length;
  const mark: Record<CriterionResult["result"], string> = {
    pass: "pass",
    fail: "**FAIL**",
    partial: "partial",
    not_run: "not run",
    not_started: "not started",
    exception: "exception",
  };
  const ev: Record<Outcome, string> = {
    pass: "✓",
    fail: "✗",
    skipped: "skipped",
    not_run: "not run",
    error: "no result",
  };
  const lines = [
    "# v1.0 acceptance report",
    "",
    "<!-- Generated by `bun scripts/acceptance.ts`. Registry: scripts/acceptance-criteria.ts. -->",
    "",
    `Run ${meta.date} on \`${meta.commit}\`${meta.dirty ? " (with uncommitted changes)" : ""}. Suites: ${meta.suites.map((s) => `\`${s}\``).join(", ")}.`,
    "",
    `**${count("pass")} pass, ${count("fail")} fail, ${count("partial")} partial, ${count("not_run")} not run, ${count("not_started")} not started, ${count("exception")} accepted exceptions** (of ${results.length}).`,
    "",
    "A criterion passes when every evidence file that ran passed (at least one test, none failed, not all skipped). Evidence in a suite that was not run is shown as not run, never as passing.",
    "",
    "## Suites",
    "",
    "| Suite | Exit | Time | Files |",
    "| --- | --- | --- | --- |",
    ...runs.map(
      (r) =>
        `| \`${r.suite}\` | ${r.exitCode} | ${r.seconds.toFixed(0)} s | ${r.problems ? (r.problems.length ? `${r.problems.length} problem(s)` : "ok") : r.files.size} |`,
    ),
    "",
    "## Criteria",
    "",
    "| # | Criterion | Stage | Result | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...results.map((r) => {
      const evidence = r.evidence
        .map((e) => `\`${e.file}\` (${e.suite}) ${ev[e.outcome]}`)
        .join("<br>");
      const note = r.criterion.note ? `${evidence ? "<br>" : ""}${r.criterion.note}` : "";
      return `| ${r.criterion.id} | ${r.title} | ${r.criterion.stage} | ${mark[r.result]} | ${evidence}${note} |`;
    }),
    "",
  ];
  const problems = runs.flatMap((r) => (r.problems ?? []).map((p) => `- \`${r.suite}\`: ${p}`));
  if (problems.length) lines.push("## Problems", "", ...problems, "");
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const selected: string[] = opt("--suites")?.split(",") ?? [
    ...CI_SUITES,
    ...(args.includes("--real") ? REAL_SUITES : []),
  ];
  const out = resolve(opt("--out") ?? join(ROOT, "docs/release/acceptance-report.md"));
  const scratch = mkdtempSync(join(tmpdir(), "ak-acceptance-"));
  const trace = join(scratch, "mlflow-trace.txt");

  const spec = readFileSync(join(ROOT, "docs/spec/AblationKit_SPEC.md"), "utf8");
  if (specCriterionIds(spec).join() !== CRITERIA.map((c) => c.id).join())
    throw new Error("scripts/acceptance-criteria.ts is out of step with spec §15");

  const runs: SuiteRun[] = [];
  for (const suite of selected.filter((s) => s !== "mlflow-coverage")) {
    const files = [
      ...new Set(
        CRITERIA.flatMap((c) => c.evidence.filter((e) => e.suite === suite).map((e) => e.file)),
      ),
    ];
    if (suite === "unit" && files.length === 0) continue;
    runs.push(runSuite(suite, files, trace, scratch));
  }
  if (selected.includes("mlflow-coverage")) {
    const problems = existsSync(trace)
      ? coverage(readFileSync(trace, "utf8"))
      : ["no MLflow trace"];
    runs.push({
      suite: "mlflow-coverage",
      exitCode: problems.length ? 1 : 0,
      seconds: 0,
      files: new Map(),
      problems,
    });
  }

  const bySuite = new Map(runs.map((r) => [r.suite, r]));
  const outcomes = (suite: string, file: string): Outcome => {
    const run = bySuite.get(suite);
    if (!run) return "not_run";
    if (suite === "mlflow-coverage") return run.problems?.length ? "fail" : "pass";
    return fileOutcome(run.files.get(file));
  };
  const t = titles();
  const results = CRITERIA.map((c) => judge(c, t.get(c.id) ?? "", outcomes));
  const report = renderReport(results, runs, {
    date: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    commit: git("rev-parse", "--short", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
    suites: selected,
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report);
  const failed = results.filter((r) => r.result === "fail");
  console.log(`\nacceptance: wrote ${out}`);
  for (const r of results.filter((x) => x.result !== "pass"))
    console.log(`  ${r.criterion.id}: ${r.result}`);
  process.exit(failed.length ? 1 : 0);
}
