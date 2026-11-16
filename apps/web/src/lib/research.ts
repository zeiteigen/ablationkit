/** Research record shapes and helpers for the Knowledge pages (ADR 0013). Mirrors the server. */

export type ResearchKind =
  | "hypothesis"
  | "approach"
  | "note"
  | "report"
  | "decision"
  | "conversation"
  | "study";

export interface ObjectRef {
  kind: string;
  id: string;
  label?: string;
}

export interface Evidence {
  ref: ObjectRef;
  role?: string;
  mlflow_run_id?: string;
  attempt_id?: string;
  job_id?: string;
  variant_id?: string;
  source_commit?: string;
  source_dirty?: boolean;
  values?: Record<string, string>;
  artifacts?: string[];
  note?: string;
  captured_at: string;
}

export interface ResearchRecord {
  record_id: string;
  project_id: string;
  kind: ResearchKind;
  title: string;
  status?: string;
  summary?: string;
  body?: string;
  tags: string[];
  links: ObjectRef[];
  created_at: string;
  updated_at: string;
  created_by: { kind: string; id?: string };
  updated_by: { kind: string; id?: string };
  revision: number;
  archived_at?: string;
  attribution?: { conversation_id: string; mode: "quote" | "summary" };
  evidence?: Evidence[];
  follow_up?: string;
  generated?: {
    study_id: string;
    baseline_variant?: string;
    metric_keys: string[];
    runs: number;
    generated_at: string;
  };
  source?: string;
  url?: string;
  local_ref?: string;
  conversation_created_at?: string;
  export_notes?: boolean;
  protocol?: string;
  baseline_variant?: string;
  variants?: { variant_id: string; title?: string; description?: string }[];
  metric_goals?: { key: string; goal: "min" | "max" }[];
}

export interface KindInfo {
  kind: ResearchKind;
  /** URL segment and tab id. */
  tab: string;
  label: string;
  singular: string;
  /** What this kind of record is for, in one line (ADR 0048). */
  role: string;
  statuses?: string[];
  summaryLabel?: string;
  bodyLabel?: string;
}

/** Same statuses and fields as `KIND_RULES` in apps/server/src/research/records.ts. */
export const KINDS: readonly KindInfo[] = [
  {
    kind: "hypothesis",
    tab: "hypotheses",
    label: "Hypotheses",
    singular: "Hypothesis",
    role: "A claim that runs can support or refute. It starts proposed and ends supported, refuted or inconclusive.",
    statuses: ["proposed", "testing", "supported", "refuted", "inconclusive", "abandoned"],
    summaryLabel: "Statement",
    bodyLabel: "Details (Markdown)",
  },
  {
    kind: "approach",
    tab: "approaches",
    label: "Approaches",
    singular: "Approach",
    role: "A method or design being tried: how something is built, as opposed to a claim about what is true.",
    statuses: ["proposed", "active", "adopted", "rejected", "parked"],
    summaryLabel: "Summary",
    bodyLabel: "Details (Markdown)",
  },
  {
    kind: "note",
    tab: "notes",
    label: "Notes",
    singular: "Note",
    role: "An observation, audit or log worth keeping that is not a claim, a method, a conclusion or a choice.",
    summaryLabel: "Summary",
    bodyLabel: "Note (Markdown)",
  },
  {
    kind: "report",
    tab: "reports",
    label: "Reports",
    singular: "Report",
    role: "A written conclusion drawn from runs, with the runs it rests on cited as evidence. A study is the experiment; a report is what it showed.",
    statuses: ["draft", "final"],
    summaryLabel: "Summary",
    bodyLabel: "Interpretation (Markdown)",
  },
  {
    kind: "decision",
    tab: "decisions",
    label: "Decisions",
    singular: "Decision",
    role: "A choice that was made, and why. Later work builds on it until it is superseded or reverted.",
    statuses: ["proposed", "accepted", "superseded", "reverted"],
    summaryLabel: "Decision",
    bodyLabel: "Rationale (Markdown)",
  },
  {
    kind: "conversation",
    tab: "conversations",
    label: "Conversations",
    singular: "Conversation link",
    role: "A pointer to a chat where an idea came from. Nothing is fetched or stored.",
    bodyLabel: "Personal notes (kept out of the Git export unless you opt in)",
  },
];

/**
 * How the pieces of a project's research fit together, in the order a question travels through
 * them. Tasks, studies and runs are not Knowledge tabs but belong to the same picture.
 */
export const RESEARCH_MAP: readonly { id: string; label: string; role: string; path: string }[] = [
  {
    id: "task",
    label: "Task",
    role: "A question put to an agent, and its answer: the goal, the outcome and everything recorded on the way.",
    path: "/tasks",
  },
  {
    id: "hypothesis",
    label: "Hypothesis",
    role: "A claim that runs can support or refute.",
    path: "/knowledge/hypotheses",
  },
  {
    id: "study",
    label: "Study",
    role: "One experiment: runs of several variants compared against a baseline under one protocol. Its table is live.",
    path: "/runs/studies",
  },
  {
    id: "run",
    label: "Run",
    role: "One execution of the code: its parameters, metrics, artifacts and console.",
    path: "/runs",
  },
  {
    id: "report",
    label: "Report",
    role: "A written conclusion drawn from runs, with frozen evidence. What a study, or several, showed.",
    path: "/knowledge/reports",
  },
  {
    id: "decision",
    label: "Decision",
    role: "A choice made because of what was found, and why.",
    path: "/knowledge/decisions",
  },
];

export const STUDY_ROLE =
  "One experiment: runs of several variants compared against a baseline under one protocol. The table is live and changes as runs land; a report is the written conclusion drawn from it.";

export type ReviewStatus = "new" | "changed" | "reviewed";

export interface ReviewInfo {
  state: ReviewStatus;
  reviewed_at?: string;
  note?: string;
}

export interface ReviewItem {
  kind: string;
  id: string;
  title: string;
  status?: string;
  summary?: string;
  updated_at: string;
  by: string;
  review: ReviewStatus;
  reviewed_at?: string;
  note?: string;
  gaps: string[];
}

export interface ReviewThread {
  task?: ReviewItem & { goal: string; outcome?: string; conclusion?: string };
  items: ReviewItem[];
}

export interface ReviewList {
  threads: ReviewThread[];
  counts: { total: number; reviewed: number; new: number; changed: number; gaps: number };
  queue: { kind: string; id: string }[];
}

/** A linked object's name, as the record route resolves it. */
export interface RefName {
  title: string;
  status?: string;
  summary?: string;
}

export function statusTone(s: string | undefined): "ok" | "err" | "info" | "warn" | "neutral" {
  if (!s) return "neutral";
  if (["supported", "adopted", "accepted", "final", "complete", "completed"].includes(s))
    return "ok";
  if (["refuted", "rejected", "reverted", "not_supported"].includes(s)) return "err";
  if (["testing", "active", "running", "open"].includes(s)) return "info";
  if (["inconclusive"].includes(s)) return "warn";
  return "neutral";
}

export const STUDY_STATUSES = ["planned", "running", "complete", "abandoned"];

export const CONVERSATION_SOURCES = [
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude", label: "Claude" },
  { id: "claude_code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "other", label: "Other" },
];

export function kindInfo(kind: string): KindInfo | undefined {
  return KINDS.find((k) => k.kind === kind);
}

export function sourceLabel(id: string | undefined): string {
  return CONVERSATION_SOURCES.find((s) => s.id === id)?.label ?? id ?? "";
}

/** Where a reference opens in the UI, or undefined when it has no page (yet). */
export function refHref(base: string, r: { kind: string; id: string }): string | undefined {
  const e = encodeURIComponent;
  switch (r.kind) {
    case "hypothesis":
    case "approach":
    case "note":
    case "report":
    case "decision":
    case "conversation":
      return `${base}/knowledge/r/${e(r.id)}`;
    case "study":
      return `${base}/runs/studies/${e(r.id)}`;
    case "variant": {
      const [s, v] = r.id.split("/");
      return `${base}/runs?study=${e(s ?? "")}&variant=${e(v ?? "")}`;
    }
    case "job":
      return `${base}/runs/jobs/${e(r.id)}`;
    case "run":
      return `${base}/runs/r/${e(r.id)}`;
    case "metric":
    case "artifact":
      return `${base}/runs/r/${e(r.id.split("/")[0] ?? "")}`;
    case "logged_model":
      return `${base}/models/m/${e(r.id)}`;
    case "model_version": {
      const i = r.id.lastIndexOf("/");
      return `${base}/models/registry/${e(r.id.slice(0, i))}?v=${e(r.id.slice(i + 1))}`;
    }
    case "evaluation":
      return `${base}/data/evaluations/${e(r.id)}`;
    case "dataset":
      return `${base}/data`;
    case "task":
      return `${base}/tasks/${e(r.id)}`;
    default:
      return undefined;
  }
}

/** `kind:id` text ↔ refs, for the link editor. */
export function parseLinks(text: string): ObjectRef[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(":");
      if (i <= 0) throw new Error(`a link is KIND:ID, got “${s}”`);
      return { kind: s.slice(0, i), id: s.slice(i + 1) };
    });
}

export function formatLinks(links: readonly ObjectRef[]): string {
  return links.map((l) => `${l.kind}:${l.id}`).join("\n");
}

export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((t) => t.replace(/^#/, ""))
        .filter(Boolean),
    ),
  ];
}
