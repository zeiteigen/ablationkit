/**
 * The project action policy in plain language for Project settings → Agent permissions (ADR 0037):
 * what each field means to a researcher, and a policy diff as before → after sentences. The
 * coordinator computes the diff (`POST …/policy/preview`); this only words it.
 */

export type Decision = "allow" | "deny";

export interface DeploymentGate {
  decision: Decision;
  exposure?: string;
  allowed_targets?: string[];
  max_runtime_minutes?: number;
}

export interface ProjectPolicy {
  schema_version: number;
  project_id: string;
  revision: number;
  created_at: string;
  created_by: string;
  summary?: string;
  jobs: {
    run_local: { decision: Decision };
    submit_remote: { decision: Decision; allowed_targets: string[] };
  };
  deployments: {
    preview_local: DeploymentGate;
    remote_research: DeploymentGate;
    persistent: DeploymentGate;
    public: DeploymentGate;
  };
  compute: { limit_hours: number };
}

export interface PolicyChange {
  path: string;
  from: unknown;
  to: unknown;
  effect: "widened" | "reduced" | "changed";
}

/** The editable body of a revision: the coordinator fills in the metadata. */
export function revisionBody(
  p: ProjectPolicy,
): Omit<ProjectPolicy, "schema_version" | "project_id" | "revision" | "created_at" | "created_by"> {
  const {
    schema_version: _s,
    project_id: _p,
    revision: _r,
    created_at: _c,
    created_by: _b,
    ...rest
  } = p;
  return rest;
}

const LABELS: Record<string, string> = {
  "jobs.run_local.decision": "Run jobs on this workstation",
  "jobs.submit_remote.decision": "Submit jobs to remote targets",
  "jobs.submit_remote.allowed_targets": "Remote targets agents may use",
  "deployments.preview_local.decision": "Start local previews",
  "deployments.remote_research.decision": "Start remote research endpoints",
  "deployments.persistent.decision": "Persistent deployments",
  "deployments.public.decision": "Public endpoints",
  "compute.limit_hours": "Compute limit",
};

function gateLabel(path: string): string {
  const m = /^deployments\.([a-z_]+)\.([a-z_]+)$/.exec(path);
  if (!m) return path;
  const base = LABELS[`deployments.${m[1]}.decision`] ?? `deployments.${m[1]}`;
  const field = (m[2] as string).replaceAll("_", " ");
  return `${base}: ${field}`;
}

function value(path: string, v: unknown): string {
  if (v === undefined) return path.endsWith("allowed_targets") ? "any" : "not set";
  if (v === "allow") return "allowed";
  if (v === "deny") return "denied";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  if (path === "compute.limit_hours") return `${v} weighted hours`;
  return String(v);
}

export interface ChangeText {
  label: string;
  from: string;
  to: string;
  /** What it means for agents. */
  effect: string;
}

/** One change of a policy diff as a sentence a researcher can check before saving. */
export function describeChange(c: PolicyChange): ChangeText {
  return {
    label: LABELS[c.path] ?? gateLabel(c.path),
    from: value(c.path, c.from),
    to: value(c.path, c.to),
    effect:
      c.effect === "widened"
        ? "agents may do more"
        : c.effect === "reduced"
          ? "agents may do less"
          : "changed",
  };
}

/** Who wrote a revision, for the card's header. */
export function revisionAuthor(createdBy: string): string {
  if (createdBy === "system:default") return "the built-in default";
  if (createdBy.startsWith("human:")) return `the researcher (session ${createdBy.slice(6, 14)})`;
  return createdBy;
}

/**
 * The bar of a usage meter: used and reserved as percentages of the limit (clamped so the bar
 * never overflows), and whether usage has reached the limit.
 */
export function meterParts(
  used: number,
  reserved: number,
  limit: number,
): { used: number; reserved: number; full: boolean } {
  if (limit <= 0) return { used: used > 0 ? 100 : 0, reserved: 0, full: true };
  const u = Math.min(100, (used / limit) * 100);
  const r = Math.min(100 - u, (reserved / limit) * 100);
  return { used: u, reserved: r, full: used + reserved >= limit - 1e-9 };
}

/**
 * A weight typed into the Compute page (`1`, `0.5`, `3`): a positive number with at most two
 * decimals, up to 1000. Returns the number or an error message.
 */
export function parseWeightInput(s: string): number | { error: string } {
  const t = s.trim();
  if (!/^[0-9]+(\.[0-9]{1,2})?$|^\.[0-9]{1,2}$/.test(t))
    return { error: "a positive number with at most two decimals" };
  const n = Number(t);
  if (n <= 0 || n > 1000) return { error: "between 0.01 and 1000" };
  return n;
}

/** Hours for the meter's caption: one decimal under 10, whole hours above. */
export function fmtWeightedHours(h: number): string {
  if (h === 0) return "0";
  if (h < 10) return String(Math.round(h * 10) / 10 || Math.round(h * 100) / 100);
  return String(Math.round(h));
}
