/**
 * Every spec §15 acceptance criterion, the stage that owns it and the automated evidence for it
 * (Stage 18 release qualification). `scripts/acceptance.ts` runs the evidence and writes the
 * pass/fail report; `scripts/test/acceptance.test.ts` keeps this registry in step with the spec
 * (the same criterion IDs) and with the tests (each evidence file exists and names the criterion).
 *
 * A suite is a `package.json` script of the form `[ENV=1] bun test PATHS [--timeout N]`, or
 * `unit` (plain `bun test`, what CI's "test (bun)" step runs), or `mlflow-coverage` (the MLflow
 * feature matrix checked against the trace the real-MLflow suites wrote).
 */

export type Status =
  /** Automated evidence covers the whole criterion. */
  | "automated"
  /** Automated evidence covers part of it; `note` says what is missing and why. */
  | "partial"
  /** Not met; a documented exception the researcher accepted (`note` links the decision). */
  | "exception"
  | "not_started";

export interface Evidence {
  file: string;
  suite: string;
}

export interface Criterion {
  id: string;
  stage: number;
  status: Status;
  evidence: readonly Evidence[];
  note?: string;
}

const unit = (...files: string[]): Evidence[] => files.map((file) => ({ file, suite: "unit" }));
const S = "apps/server/test/";
const C = "apps/cli/test/";
const WEB: Evidence = { file: "apps/web/e2e/smoke.test.ts", suite: "test:web" };
const LIFECYCLE: Evidence = { file: `${S}lifecycle-e2e.test.ts`, suite: "test:lifecycle" };
const INFERENCE: Evidence = { file: `${S}inference-e2e.test.ts`, suite: "test:inference" };
const LLM: Evidence = { file: `${S}llm-e2e.test.ts`, suite: "test:llm" };
const RESTORE: Evidence = { file: `${S}restore-e2e.test.ts`, suite: "test:restore" };
const EXT: Evidence = { file: `${S}extensions-e2e.test.ts`, suite: "test:extensions" };
const TORCH: Evidence = { file: `${S}torch-fixture.test.ts`, suite: "test:torch" };

const c = (id: string, stage: number, evidence: Evidence[], note?: string): Criterion => ({
  id,
  stage,
  status: "automated",
  evidence,
  ...(note ? { note } : {}),
});

/** ADR 0037 removed research campaigns; these criteria were about campaigns. */
const noCampaigns = (
  id: string,
  stage: number,
  why: string,
  evidence: Evidence[] = [],
): Criterion => ({
  id,
  stage,
  status: "exception",
  evidence,
  note: `Accepted exception (ADR 0037): research campaigns were removed; agents work in tasks driven from their own harness, and the project policy alone bounds them. ${why}`,
});

/**
 * ADR 0037 removed Git management, candidate workspaces, approvals and AblationKit's own agent
 * sandbox: the user's harness owns the agent's session, its Git and its sandbox.
 */
const harnessOwned = (id: string, stage: number, why: string): Criterion => ({
  id,
  stage,
  status: "exception",
  evidence: [],
  note: `Accepted exception (ADR 0037): Git, candidate workspaces, approvals and the agent's sandbox belong to the user's harness now; AblationKit decides only what an agent asks it to do (jobs, deployments), under the project policy. ${why}`,
});

/**
 * ADR 0039 removed T3 Code integration and agent orchestration: AblationKit no longer starts,
 * drives, streams or converses with agents; the user's harness owns the session.
 */
const noOrchestration = (
  id: string,
  stage: number,
  why: string,
  evidence: Evidence[] = [],
): Criterion => ({
  id,
  stage,
  status: "exception",
  evidence,
  note: `Accepted exception (ADR 0039): AblationKit no longer starts, drives, streams or converses with agents, and has no T3 Code integration; the user's harness (Claude Code, Codex, T3 Code) owns the agent's session, and agents report into AblationKit through \`ablationkit mcp\` (ADR 0040). ${why}`,
});

export const CRITERIA: readonly Criterion[] = [
  c("1", 5, [...unit(`${S}jobs.test.ts`), TORCH]),
  c("1a", 7, unit(`${S}research.test.ts`)),
  c("1b", 15, unit(`${S}extensions.test.ts`)),
  c("2", 3, unit(`${S}coordinator.test.ts`)),
  c("3", 2, [...unit(`${S}file-based.test.ts`), RESTORE]),
  c("4", 6, [...unit(`${S}tracking.test.ts`), WEB]),
  c("5", 12, [...unit(`${S}lifecycle.test.ts`), LIFECYCLE, WEB]),
  c("6", 12, [...unit(`${S}lifecycle.test.ts`), LIFECYCLE, WEB]),
  c("7", 12, [...unit(`${S}lifecycle.test.ts`), LIFECYCLE, WEB]),
  c("8", 12, [...unit(`${S}lifecycle.test.ts`), LIFECYCLE, WEB]),
  c("9", 13, [...unit(`${S}inference.test.ts`), INFERENCE, WEB]),
  c("9a", 13, [...unit(`${S}inference.test.ts`), INFERENCE, WEB]),
  c("9b", 13, [...unit(`${S}inference.test.ts`), INFERENCE, WEB]),
  c("9c", 13, [...unit(`${S}inference.test.ts`), INFERENCE]),
  c("9d", 15, [...unit(`${S}extensions.test.ts`), WEB]),
  c("9e", 13, [...unit(`${S}inference.test.ts`, `${S}remote-evaluations.test.ts`), INFERENCE]),
  c("10", 14, [...unit(`${S}llm.test.ts`), LLM, WEB]),
  c("10a", 14, [...unit(`${S}llm.test.ts`), LLM, WEB]),
  c("10b", 14, [...unit(`${S}llm.test.ts`), LLM, WEB]),
  c("10c", 14, [...unit(`${S}llm.test.ts`), LLM, WEB]),
  c("10d", 13, [INFERENCE]),
  c("10e", 14, [...unit(`${S}llm.test.ts`), LLM, WEB]),
  c(
    "11",
    4,
    unit(
      `${S}tracking.test.ts`,
      `${S}jobs.test.ts`,
      "packages/tracking-mlflow/test/service.test.ts",
    ),
  ),
  c(
    "12",
    16,
    unit(`${S}remote.test.ts`, `${S}remote-endpoints.test.ts`, `${S}security-remote.test.ts`),
  ),
  c("13", 5, unit(`${S}jobs.test.ts`)),
  c("14", 7, unit(`${S}research.test.ts`, `${S}lifecycle.test.ts`)),
  c("15", 15, [...unit(`${S}extensions.test.ts`), WEB]),
  c("15a", 15, [...unit(`${S}extensions.test.ts`, `${C}extension.test.ts`), WEB]),
  c("15b", 15, unit(`${S}extensions.test.ts`, "packages/extension-host/test/host.test.ts")),
  c("15c", 15, unit(`${S}extensions.test.ts`, `${C}dev-build.test.ts`)),
  c("15d", 18, unit(`${C}docs.test.ts`, `${C}docs-drift.test.ts`, `${S}api-docs.test.ts`)),
  c("15e", 15, [...unit(`${S}extensions.test.ts`, `${C}extension.test.ts`), EXT]),
  c("15f", 15, [...unit(`${S}extensions.test.ts`), WEB]),
  c("16", 7, unit(`${S}research.test.ts`, `${C}mcp.test.ts`)),
  c("17", 17, [...unit(`${S}restore.test.ts`), RESTORE, WEB]),
  c("18", 18, [
    ...unit("packages/tracking-mlflow/test/feature-matrix.test.ts"),
    { file: "scripts/mlflow-matrix.ts", suite: "mlflow-coverage" },
  ]),
  harnessOwned(
    "19",
    11,
    "A Review task is guidance in its context package with no plan turn and a read-only runtime mode; denying edits and shell actions at the tool boundary is the harness's.",
  ),
  noCampaigns(
    "20",
    11,
    "Implement remains a task mode; its isolated-candidate run, diff and envelope were proved through an Implement campaign.",
  ),
  noCampaigns("21", 11, "Explore was the campaign loop over hypotheses and variants."),
  noCampaigns("22", 11, "The autonomous-research loop was a campaign."),
  noCampaigns(
    "23",
    11,
    "The subject is a campaign's requests; guarded actions and the agent API's missing privileged routes keep their own evidence (criterion 56).",
  ),
  noCampaigns("24", 11, "Budgets were campaign budgets."),
  noCampaigns("25", 11, "Pause, stop and steer were campaign controls."),
  noCampaigns(
    "26",
    11,
    "There is no coordinator-bound decision loop; remote jobs finishing offline and reconciling later is criterion 12's evidence.",
  ),
  noCampaigns(
    "27",
    18,
    "The harness baseline compared a plain task with a campaign (ADR 0029: no measurable difference), and that orchestration is what was removed.",
  ),
  noCampaigns("28", 11, "Evidence assessments were a campaign's."),
  noCampaigns("29", 11, "The subject is one autonomous campaign under two project policies."),
  harnessOwned("30", 8, "AblationKit brokers no commits, pushes or merges."),
  harnessOwned("31", 8, "AblationKit performs no merges."),
  {
    id: "32",
    stage: 11,
    status: "partial",
    evidence: unit(`${S}deployments.test.ts`),
    note: "Project A's agent opens a loopback preview within its cap and never a persistent or public endpoint; project B allows a scoped remote research session on one target. There is no approval step (ADR 0037): B's scoped session is an explicit `allow` with its target and runtime cap.",
  },
  {
    id: "33",
    stage: 8,
    status: "automated",
    evidence: unit(`${S}agent-policy.test.ts`, "packages/autonomy-policy/test/policy.test.ts"),
    note: "Since ADR 0037 there are no pending grants to invalidate: a reduction takes effect at the next request.",
  },
  {
    id: "34",
    stage: 11,
    status: "partial",
    evidence: unit(`${S}deployments.test.ts`),
    note: "Nothing is queued to execute on reconnection: a local preview does not survive a restart and a deployment that waited for an approval loads closed. The pre-issued bounded authorizations were campaign authorizations, and pushes and merges are the harness's (ADR 0037); remote jobs completing offline is criterion 12's evidence.",
  },
  harnessOwned(
    "35",
    11,
    "Shell attempts, path escapes, pushes and network operations are the harness's to refuse, and its runtime requests are answered there (ADR 0039). What an agent asks AblationKit to do is decided by the project policy, for any provider.",
  ),
  noOrchestration("36", 9, "Tasks are created by agents, not launched from the UI."),
  noOrchestration(
    "37",
    9,
    "There is no launch to attach a conversation link or an excerpt to; conversation links stay research records (criterion 16).",
  ),
  c("38", 9, unit(`${S}tasks.test.ts`, `${C}mcp.test.ts`)),
  noOrchestration("39", 8, "There is no dispatch for a preflight to gate."),
  noOrchestration("40", 8, "There is no agent session for AblationKit to set up or refresh."),
  noOrchestration(
    "41",
    9,
    "There is no T3 adapter; agents use AblationKit only through `ablationkit mcp` (ADR 0040).",
  ),
  noOrchestration(
    "42",
    9,
    "AblationKit submits no agent turns, so there are none to duplicate; jobs are never resubmitted on restart (criterion 13).",
  ),
  noOrchestration(
    "43",
    8,
    "AblationKit sets no runtime mode; what an agent asks AblationKit to do is bounded by the project policy and the compute limit whatever its harness allows.",
  ),
  c("44", 9, unit(`${S}tasks.test.ts`)),
  noOrchestration("45", 10, "There is no conversation view."),
  noOrchestration("46", 10, "There is no conversation view."),
  noOrchestration("47", 10, "There is no Research Activity projection of a conversation."),
  noOrchestration("48", 10, "There is no conversation view."),
  noOrchestration("49", 10, "Approvals are the harness's; AblationKit holds none."),
  noOrchestration("50", 10, "There is no T3 connection to drop."),
  noOrchestration("51", 10, "A task links no threads."),
  {
    id: "52",
    stage: 10,
    status: "partial",
    evidence: unit(`${S}tasks.test.ts`),
    note: "A task an agent creates through `ablationkit mcp` shows what was recorded under it (jobs, runs, records) through `ablationkit_read task.show` and on the web UI's Tasks page; there is no conversation view to report external history in (ADR 0039, 0040).",
  },
  noOrchestration(
    "53",
    10,
    "AblationKit holds no conversation content; agent tokens reach only their project (threat POL-5).",
  ),
  noOrchestration("54", 10, "There is no event normalizer or T3 contract to test."),
  harnessOwned("55", 8, "AblationKit launches no sandbox of its own."),
  c(
    "56",
    3,
    unit(`${S}listeners.test.ts`, `${S}security-routes.test.ts`, `${S}security-agent.test.ts`),
  ),
  {
    id: "57",
    stage: 3,
    status: "exception",
    evidence: unit(`${S}listeners.test.ts`),
    note: "Accepted exception (ADR 0037): passkeys and step-up were removed; privileged writes (policy revisions, extension activation, build activation, backup restore, project removal, widening LLM data controls) need the researcher's session on the human API, locally or over Tailscale. The listed test proves they exist only there: an agent token never reaches them, but a stolen human session can make them.",
  },
  harnessOwned("58", 8, "There is no AblationKit sandbox whose controls could be labelled."),
  c("59", 7, unit(`${S}research.test.ts`, `${C}mcp.test.ts`)),
  c("60", 4, unit(`${S}tracking.test.ts`, "packages/tracking-mlflow/test/service.test.ts")),
];

/** Suites CI runs (`scripts/ci.ts`). The others spend model turns or download large wheels. */
export const CI_SUITES = [
  "unit",
  "test:web",
  "test:mlflow",
  "test:lifecycle",
  "test:inference",
  "test:llm",
  "test:restore",
  "mlflow-coverage",
] as const;
/** Opt-in suites: real wheels and torch. */
export const REAL_SUITES = ["test:extensions", "test:torch"] as const;

/** Criterion IDs as numbered in spec §15 (`1.`, `1a.`, … `60.`). */
export function specCriterionIds(spec: string): string[] {
  const start = spec.indexOf("## 15. Acceptance criteria");
  const end = spec.indexOf("## 16.", start);
  const body = spec.slice(start, end);
  return [...body.matchAll(/^([0-9]+[a-z]?)\. \*\*/gm)].map((m) => m[1] as string);
}

/**
 * Criterion IDs a source file names: "criterion 9c", "criteria 5-8", "Criteria 20–26, 28, 29",
 * "criteria 45–54". Ranges are numeric.
 */
export function mentionedCriteria(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(
    /\b[Cc]riteri(?:on|a)\s+((?:[0-9]+[a-f]?(?:\s*[–-]\s*[0-9]+)?(?:\s*(?:,|and|&)\s*)?)+)/g,
  ))
    for (const part of (m[1] as string).split(/\s*(?:,|and|&)\s*/)) {
      const r = /^([0-9]+)\s*[–-]\s*([0-9]+)$/.exec(part.trim());
      if (r) for (let i = Number(r[1]); i <= Number(r[2]); i++) out.add(String(i));
      else if (part.trim()) out.add(part.trim());
    }
  return out;
}
