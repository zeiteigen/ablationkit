/**
 * Command palette catalogue (spec §2.2). Each command has a short phrase to type; one the
 * human/operations CLI also has shows its `ablationkit …` line. Research actions are not CLI
 * commands (agents use `ablationkit mcp`, ADR 0040). Commands that need a project use the current
 * one; an `arg` is typed after the phrase in the palette input ("run logs job-…").
 */

export interface PaletteCommand {
  readonly id: string;
  readonly title: string;
  /** What to type: its words before the first upper-case placeholder select the command. */
  readonly phrase: string;
  /** The equivalent `ablationkit …` line, when the CLI has one. */
  readonly cli?: string;
  readonly needsProject?: boolean;
  /** Placeholder for a required argument. */
  readonly arg?: string;
  readonly keywords?: string;
}

export const COMMANDS: readonly PaletteCommand[] = [
  {
    id: "go.docs",
    title: "Open the user guide",
    phrase: "docs",
    keywords: "help documentation getting started tutorial",
  },
  {
    id: "go.home",
    title: "Go to Home",
    phrase: "project list",
    cli: "ablationkit project list",
  },
  {
    id: "go.compute",
    title: "Go to Compute",
    phrase: "target list",
    cli: "ablationkit target list",
    keywords: "cost spend gpu utilization hours targets workers",
  },
  {
    id: "go.system",
    title: "Go to System",
    phrase: "tracking status",
    cli: "ablationkit tracking status",
  },
  { id: "go.settings", title: "Go to Settings", phrase: "login", cli: "ablationkit login" },
  {
    id: "project.add",
    title: "Register a project checkout",
    phrase: "project add PATH",
    cli: "ablationkit project add PATH",
    arg: "absolute path",
  },
  {
    id: "project.show",
    title: "Open project",
    phrase: "project show ID",
    cli: "ablationkit project show ID",
    arg: "project id",
  },
  {
    id: "project.doctor",
    title: "Project doctor",
    phrase: "project doctor --project ID",
    cli: "ablationkit project doctor --project ID",
    needsProject: true,
  },
  {
    id: "run.submit",
    title: "Submit a run (launch dialog)",
    phrase: "run submit",
    needsProject: true,
    keywords: "launch job new",
  },
  { id: "run.status", title: "Job status", phrase: "run status", needsProject: true },
  {
    id: "run.logs",
    title: "Job console logs",
    phrase: "run logs JOB",
    arg: "job id",
  },
  { id: "run.cancel", title: "Cancel a job", phrase: "run cancel JOB", arg: "job id" },
  { id: "run.retry", title: "Retry a job", phrase: "run retry JOB", arg: "job id" },
  {
    id: "runs.search",
    title: "Search runs",
    phrase: "runs search FILTER",
    needsProject: true,
    arg: "MLflow filter (optional)",
  },
  {
    id: "runs.compare",
    title: "Compare runs",
    phrase: "runs compare",
    needsProject: true,
  },
  { id: "studies", title: "Studies and ablations", phrase: "studies", needsProject: true },
  {
    id: "experiments",
    title: "Manage MLflow experiments",
    phrase: "tracking import --project ID --experiment EXP",
    cli: "ablationkit tracking import --project ID --experiment EXP",
    needsProject: true,
  },
  {
    id: "standing",
    title: "Standing: where the project stands",
    phrase: "standing",
    needsProject: true,
    keywords: "ledger claims decisions questions bottom line review new",
  },
  {
    id: "notebooks",
    title: "Notebooks: the fundamentals and the research, as notes",
    phrase: "notebooks",
    needsProject: true,
    keywords: "vault shelf fundamentals tree sessions knowledge",
  },
  {
    id: "vault.find",
    title: "Find a note in the vault",
    phrase: "find note",
    needsProject: true,
    keywords: "vault search concept term",
  },
  {
    id: "vault.library",
    title: "Library: the prior work the vault cites",
    phrase: "library",
    needsProject: true,
    keywords: "works papers citations references bibtex prior work",
  },
  {
    id: "vault.tree",
    title: "The tree: every notebook and note",
    phrase: "tree",
    needsProject: true,
    keywords: "vault outline structure notebooks",
  },
  {
    id: "knowledge",
    title: "Knowledge: hypotheses, notes, reports, decisions",
    phrase: "research list",
    needsProject: true,
    keywords: "research hypothesis approach",
  },
  {
    id: "research.note",
    title: "Add a research note",
    phrase: "research note add",
    needsProject: true,
  },
  {
    id: "research.hypothesis",
    title: "Add a hypothesis",
    phrase: "research hypothesis add",
    needsProject: true,
  },
  {
    id: "research.report",
    title: "Generate a report from a study",
    phrase: "research report generate",
    needsProject: true,
  },
  {
    id: "conversation.link",
    title: "Link an external conversation",
    phrase: "conversation link",
    needsProject: true,
    keywords: "chatgpt claude codex chat",
  },
  {
    id: "research.export",
    title: "Export research to the checkout",
    phrase: "research export",
    needsProject: true,
  },
  {
    id: "lineage",
    title: "Show lineage of an object",
    phrase: "lineage KIND:ID",
    needsProject: true,
    arg: "KIND:ID, e.g. run:abc123",
  },
  {
    id: "dataset.list",
    title: "Datasets and their lineage",
    phrase: "dataset list",
    needsProject: true,
    keywords: "data inputs splits fingerprint",
  },
  {
    id: "model.list",
    title: "Logged models",
    phrase: "model list",
    needsProject: true,
    keywords: "flavor signature",
  },
  {
    id: "model.show",
    title: "Open a logged model",
    phrase: "model show MODEL_ID",
    needsProject: true,
    arg: "logged model ID (m-…)",
  },
  {
    id: "registry.list",
    title: "Model registry",
    phrase: "registry list",
    needsProject: true,
    keywords: "versions aliases champion",
  },
  {
    id: "inference.predict",
    title: "One-shot prediction",
    phrase: "inference predict",
    needsProject: true,
    keywords: "inference lab predict model",
  },
  {
    id: "inference.session",
    title: "Inference sessions",
    phrase: "inference sessions",
    needsProject: true,
    keywords: "warm serving session idle",
  },
  {
    id: "inference.compare",
    title: "Compare models on identical examples",
    phrase: "inference compare",
    needsProject: true,
    keywords: "disagreement paired comparison",
  },
  {
    id: "inference.evidence",
    title: "Saved inference evidence",
    phrase: "inference evidence",
    needsProject: true,
    keywords: "saved predictions comparisons",
  },
  {
    id: "llm.traces",
    title: "LLM traces",
    phrase: "llm traces",
    needsProject: true,
    keywords: "genai trace spans waterfall rag tool agent",
  },
  {
    id: "llm.prompts",
    title: "Prompt registry",
    phrase: "llm prompts",
    needsProject: true,
    keywords: "prompt versions diff alias",
  },
  {
    id: "llm.eval",
    title: "New GenAI evaluation",
    phrase: "llm eval run",
    needsProject: true,
    keywords: "genai evaluation judge scorer golden",
  },
  {
    id: "llm.playground",
    title: "LLM playground",
    phrase: "llm playground",
    needsProject: true,
    keywords: "prompt model compare chat",
  },
  {
    id: "llm.golden",
    title: "Golden sets",
    phrase: "llm golden sets",
    needsProject: true,
    keywords: "evaluation dataset held out",
  },
  {
    id: "llm.controls",
    title: "LLM data controls",
    phrase: "llm data controls",
    needsProject: true,
    keywords: "egress capture redaction retention provider",
  },
  {
    id: "evaluation.run",
    title: "New classical evaluation",
    phrase: "evaluation run",
    needsProject: true,
    keywords: "evaluate thresholds classifier regressor",
  },
  {
    id: "evaluation.list",
    title: "Evaluations",
    phrase: "evaluation list",
    needsProject: true,
  },
  {
    id: "mlproject.show",
    title: "MLproject entrypoints",
    phrase: "mlproject show",
    needsProject: true,
    keywords: "mlflow projects entrypoint run",
  },
  {
    id: "tracking.doctor",
    title: "Tracking doctor",
    phrase: "tracking doctor",
    cli: "ablationkit tracking doctor",
  },
  {
    id: "tracking.outbox",
    title: "Tracking outbox",
    phrase: "tracking outbox",
    cli: "ablationkit tracking outbox",
  },
  {
    id: "backup.create",
    title: "Create a backup",
    phrase: "backup create",
    cli: "ablationkit backup create",
  },
  {
    id: "backup.list",
    title: "List backups",
    phrase: "backup list",
    cli: "ablationkit backup list",
  },
];

/** Inside a project the palette leads with reading: the vault, then studies and runs (ADR 0055). */
const PROJECT_FIRST = [
  "standing",
  "notebooks",
  "vault.find",
  "vault.library",
  "vault.tree",
  "studies",
  "runs.search",
];

/** Split "run logs job-123" into the best command prefix and its argument. */
export function parseInput(input: string): { query: string; arg: string } {
  const q = input.trim();
  for (const c of COMMANDS) {
    if (!c.arg) continue;
    const short = c.phrase.split(/ [A-Z]/)[0] as string;
    if (q.toLowerCase().startsWith(`${short} `)) {
      return { query: short, arg: q.slice(short.length + 1).trim() };
    }
  }
  return { query: q, arg: "" };
}

/** Rank commands by a simple subsequence match over title, phrase, CLI line and keywords. */
export function matchCommands(
  input: string,
  opts: { hasProject: boolean },
  commands: readonly PaletteCommand[] = COMMANDS,
): PaletteCommand[] {
  const { query } = parseInput(input);
  const q = query.toLowerCase();
  const avail = commands.filter((c) => opts.hasProject || !c.needsProject);
  if (!q) {
    if (!opts.hasProject) return [...avail];
    const rank = (c: PaletteCommand) => {
      const i = PROJECT_FIRST.indexOf(c.id);
      return i < 0 ? PROJECT_FIRST.length : i;
    };
    return [...avail].sort((a, b) => rank(a) - rank(b));
  }
  const scored: [number, PaletteCommand][] = [];
  for (const c of avail) {
    const hay = `${c.title} ${c.phrase} ${c.cli ?? ""} ${c.keywords ?? ""}`.toLowerCase();
    const s = score(q, hay);
    if (s > 0) scored.push([s, c]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map(([, c]) => c);
}

function score(q: string, hay: string): number {
  if (hay.includes(q)) return 100 - hay.indexOf(q) / 10;
  let i = 0;
  let gaps = 0;
  for (const ch of hay) {
    if (ch === q[i]) i++;
    else if (i > 0) gaps++;
    if (i === q.length) return Math.max(1, 50 - gaps / 5);
  }
  return 0;
}
