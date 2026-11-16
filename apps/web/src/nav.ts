/**
 * Information architecture (spec §2.2, v0.15 normative; ADR 0036, ADR 0055). Navigation is
 * organized by research activity, not by MLflow object type. What a project does not use yet and
 * what task profiles hide is under "More", never removed: every item here stays routable.
 */

export const TASK_PROFILES = [
  "llm",
  "rag",
  "agent",
  "computer_vision",
  "tabular",
  "other",
] as const;
export type TaskProfile = (typeof TASK_PROFILES)[number];

export interface NavItem {
  readonly id: string;
  readonly label: string;
  /** Path relative to the layer root ("" for global, "/p/<id>" for project). */
  readonly path: string;
  readonly contains: string;
}

export interface BackendPageDeclaration {
  id: string;
  title: string;
  path: string;
  entry: string;
  profiles?: string[];
  /** Project-relative API prefix served as an operation alias, for example `/llm`. */
  api_path?: string;
}

export interface RegisteredBackend {
  id: string;
  bundled?: boolean;
  capabilities?: string[];
  enabled: boolean;
  pages: BackendPageDeclaration[];
}

/** The global layer (ADR 0055): Home, Agents (ADR 0065) and Compute, then the projects. */
export const GLOBAL_NAV: readonly NavItem[] = [
  {
    id: "home",
    label: "Home",
    path: "/",
    contains: "Where each project stands, running jobs, compute this week, the attention inbox",
  },
  {
    id: "agents",
    label: "Agents",
    path: "/agents",
    contains:
      "The agents in agent containers: live terminals, controls, egress, what each changed and its account",
  },
  {
    id: "compute",
    label: "Compute",
    path: "/compute",
    contains: "Compute hours, estimated spend, utilization, agent compute, targets and weights",
  },
];

/** At the bottom of the sidebar, quietly: Settings (with System as a tab) and the guide. */
export const GLOBAL_FOOT: readonly NavItem[] = [
  {
    id: "settings",
    label: "Settings",
    path: "/settings",
    contains:
      "Preferences, every project's agent sessions, and System: MLflow sidecar health, delivery backlog, backups, build info",
  },
  {
    id: "docs",
    label: "Docs",
    path: "/docs",
    contains: "User guide: setup, research, experiments, LLM evaluation and workspace operations",
  },
];

export const PROJECT_NAV: readonly NavItem[] = [
  {
    id: "overview",
    label: "Overview",
    path: "",
    contains: "Where the project stands, in brief, and what the agents did (ADR 0055)",
  },
  {
    id: "standing",
    label: "Standing",
    path: "/standing",
    contains:
      "Where the project stands: the bottom line, claims by standing, decisions in force, open questions, and what is new since you last read (ADR 0049)",
  },
  {
    id: "notebooks",
    label: "Notebooks",
    path: "/notebooks",
    contains:
      "The vault's notebooks: the fundamentals, one notebook per question, the sessions; the tree and the library",
  },
  {
    id: "runs",
    label: "Runs",
    path: "/runs",
    contains: "Studies and MLflow runs, comparison and ablations, jobs and console logs",
  },
  {
    id: "data",
    label: "Data & Evals",
    path: "/data",
    contains: "Datasets and lineage, classical and GenAI evaluations, golden sets",
  },
  {
    id: "models",
    label: "Models",
    path: "/models",
    contains: "Logged models, registry, Inference, demos",
  },
  {
    id: "settings",
    label: "Project settings",
    path: "/settings",
    contains:
      "Agents (permissions, compute limit, sessions), task profiles, extensions, health, removal",
  },
];

/**
 * The original records (ADR 0049): tasks and research records as they were written, the vault's
 * provenance. They are under "More" in the project navigation (ADR 0055).
 */
export const ORIGINAL_RECORDS: readonly NavItem[] = [
  {
    id: "knowledge",
    label: "Knowledge",
    path: "/knowledge",
    contains: "Hypotheses, approaches, notes, reports, decisions and conversations as written",
  },
  {
    id: "tasks",
    label: "Tasks",
    path: "/tasks",
    contains: "The tasks agents recorded their work under",
  },
  {
    id: "review",
    label: "Review",
    path: "/review",
    contains: "The reading list of the original records (ADR 0048)",
  },
];

export interface Visibility<T> {
  readonly primary: readonly T[];
  readonly more: readonly T[];
}

/** Tabs inside Runs: Runs, Studies and Jobs; the operator's tabs sit under "More" (ADR 0055). */
export const RUNS_TABS: readonly NavItem[] = [
  { id: "runs", label: "Runs", path: "/runs", contains: "Run search, filter and pagination" },
  { id: "studies", label: "Studies", path: "/runs/studies", contains: "Studies and variants" },
  { id: "jobs", label: "Jobs", path: "/runs/jobs", contains: "Jobs, attempts, console logs" },
  { id: "compare", label: "Compare", path: "/runs/compare", contains: "Multi-run comparison" },
  {
    id: "entrypoints",
    label: "Entrypoints",
    path: "/runs/entrypoints",
    contains: "MLproject entrypoints and parameters, launched as jobs",
  },
  {
    id: "experiments",
    label: "Experiments",
    path: "/runs/experiments",
    contains: "MLflow experiments: create, rename, archive, link",
  },
];

/** Runs, Studies and Jobs are the Runs tabs; Compare, Entrypoints and Experiments are under "More". */
export function runsTabs(): Visibility<NavItem> {
  const primary = new Set(["runs", "studies", "jobs"]);
  return {
    primary: RUNS_TABS.filter((t) => primary.has(t.id)),
    more: RUNS_TABS.filter((t) => !primary.has(t.id)),
  };
}

/** Tabs inside Models. Registry, Inference and Demos collapse under "More" until a logged model. */
export const MODELS_TABS: readonly NavItem[] = [
  { id: "logged", label: "Logged models", path: "/models", contains: "Logged models" },
  { id: "registry", label: "Registry", path: "/models/registry", contains: "Registered models" },
  { id: "inference", label: "Inference", path: "/models/inference", contains: "Inference" },
  { id: "demos", label: "Demos", path: "/models/demos", contains: "Demos" },
];

/**
 * The project navigation (ADR 0055): Data & Evals and Models are in the list once the project uses
 * the model lifecycle (a logged model or an evaluation), and under "More" until then. Task
 * profiles never remove a section; every item stays routable.
 */
export function projectNav(lifecycle: boolean): Visibility<NavItem> {
  const lifecycleIds = new Set(["data", "models"]);
  return {
    primary: PROJECT_NAV.filter((i) => lifecycle || !lifecycleIds.has(i.id)),
    more: lifecycle ? [] : PROJECT_NAV.filter((i) => lifecycleIds.has(i.id)),
  };
}

/** Enabled backend pages join project navigation; optional profile metadata only changes visibility. */
export function backendProjectNav(
  backends: readonly RegisteredBackend[],
  profiles: readonly string[],
): Visibility<NavItem> {
  const primary: NavItem[] = [];
  const more: NavItem[] = [];
  for (const backend of backends) {
    if (!backend.enabled) continue;
    for (const page of backend.pages) {
      const item: NavItem = {
        id: `backend:${backend.id}:${page.id}`,
        label: page.title,
        path: page.path,
        contains: page.title,
      };
      if (page.profiles?.length && !page.profiles.some((profile) => profiles.includes(profile))) {
        more.push(item);
      } else primary.push(item);
    }
  }
  return { primary, more };
}

/** Models tabs: Registry, Demos and Inference sit under "More" until the project has a logged model. */
export function modelsTabs(hasLoggedModel: boolean): Visibility<NavItem> {
  if (hasLoggedModel) return { primary: MODELS_TABS, more: [] };
  return {
    primary: MODELS_TABS.filter((t) => t.id === "logged"),
    more: MODELS_TABS.filter((t) => t.id !== "logged"),
  };
}

/** The active project nav item for a path below `/p/<id>`. */
export function activeProjectItem(
  rest: string,
  items: readonly NavItem[] = [...PROJECT_NAV, ...ORIGINAL_RECORDS],
): string {
  const hit = [...items]
    .filter((item) => item.path && (rest === item.path || rest.startsWith(`${item.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return hit ? hit.id : "overview";
}
