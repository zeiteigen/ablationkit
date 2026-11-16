/**
 * `bun run ci`: the exact checks .github/workflows/ci.yml runs (the workflow only installs the
 * toolchain and then calls this script), so "CI is green" can be verified locally.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The real-MLflow suites record each MLflow endpoint and bridge op they use here, and the last step
 * checks the feature matrix against it (criterion 18). Only those suites: the unit tests talk to a
 * fake MLflow, whose answers must not count.
 */
const MLFLOW_TRACE = join(mkdtempSync(join(tmpdir(), "ak-ci-")), "mlflow-trace.txt");
const traced = (suite: string) => ({
  ABLATIONKIT_MLFLOW_TRACE: MLFLOW_TRACE,
  ABLATIONKIT_MLFLOW_TRACE_SUITE: suite,
});

const STEPS: readonly [string, string[], Record<string, string>?][] = [
  ["install bun deps", ["bun", "install", "--frozen-lockfile"]],
  ["install python deps", ["uv", "sync", "--locked"]],
  ["dev doctor", ["bun", "apps/cli/src/main.ts", "dev", "doctor"]],
  ["format", ["bun", "run", "format:check"]],
  ["lint", ["bun", "run", "lint"]],
  ["typecheck", ["bun", "run", "typecheck"]],
  ["protocol drift", ["bun", "run", "protocol:check"]],
  ["test (bun)", ["bun", "test", "--parallel"]],
  ["test (python)", ["uv", "run", "--frozen", "pytest"]],
  ["web build", ["bun", "run", "web:build"]],
  // Playwright smoke tests: the web shell against a real coordinator and a fake MLflow. Needs a
  // Chromium (ABLATIONKIT_CHROMIUM, Playwright's download, or a system install).
  ["web smoke (playwright)", ["bun", "run", "test:web"]],
  // Starts the pinned MLflow sidecar (uv-synced into a temp dir) and runs the REST contract.
  ["mlflow contract", ["bun", "run", "test:mlflow"], traced("test:mlflow")],
  // Datasets, logged models, registry, classical evaluation and MLflow Projects against the real
  // pinned MLflow and the real Python operations bridge (criteria 5-8).
  ["model lifecycle (real mlflow)", ["bun", "run", "test:lifecycle"], traced("test:lifecycle")],
  ["research inference (real mlflow)", ["bun", "run", "test:inference"], traced("test:inference")],
  ["llm research (real mlflow)", ["bun", "run", "test:llm"], traced("test:llm")],
  // Criterion 17: back up a coordinator with its own managed sidecar, restore on a clean home.
  ["backup and restore (real mlflow)", ["bun", "run", "test:restore"], traced("test:restore")],
  // The Electron shell with Playwright. Skips (and says so) without an Electron or a display.
  ["desktop (electron)", ["bun", "run", "test:desktop"]],
  // Criterion 18: every endpoint and op in the MLflow feature matrix succeeded above.
  [
    "mlflow feature matrix (coverage)",
    ["bun", "scripts/mlflow-matrix.ts", "--coverage", MLFLOW_TRACE],
  ],
];

const root = new URL("..", import.meta.url).pathname;
const summary: string[] = [];
let failed = false;
for (const [name, cmd, env] of STEPS) {
  console.log(`\n::group::${name}: ${cmd.join(" ")}`);
  const start = performance.now();
  const p = Bun.spawnSync(cmd, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...(env ?? {}) },
  });
  const secs = ((performance.now() - start) / 1000).toFixed(1);
  console.log("::endgroup::");
  const ok = p.exitCode === 0;
  summary.push(`${ok ? "pass" : "FAIL"}  ${name} (${secs}s)`);
  if (!ok) {
    failed = true;
    break;
  }
}
console.log(`\nci summary:\n  ${summary.join("\n  ")}`);
process.exit(failed ? 1 : 0);
