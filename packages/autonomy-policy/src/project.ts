/**
 * The authoritative project action policy (spec §7.7; ADR 0037): defaults, migration of version 1
 * revisions, enforceability checks, one decision per agent action, and field-level diffs. Pure
 * functions; the coordinator's `PolicyService` stores revisions.
 *
 * The policy decides what an agent may ask AblationKit itself to do: run jobs here, submit them to
 * remote targets, request deployments, and how many weighted compute hours its jobs may use. There
 * is no `ask`: Git, workspaces and the agent's sandbox belong to the user's harness.
 */
import type { PolicyDecision, ProjectActionPolicy } from "@ablationkit/protocol";

/** Weighted compute hours agents get in a project until the researcher sets another limit. */
export const DEFAULT_COMPUTE_LIMIT_HOURS = 10;

/** Built-in default for a new project (revision 0, never written). */
export function defaultPolicy(projectId: string, createdAt: string): ProjectActionPolicy {
  const deny = { decision: "deny" as const };
  return {
    schema_version: 2,
    project_id: projectId,
    revision: 0,
    created_at: createdAt,
    created_by: "system:default",
    summary:
      "Built-in default: agents may run jobs on this machine and start a loopback preview; remote jobs and other deployments are denied.",
    jobs: {
      run_local: { decision: "allow" },
      submit_remote: { decision: "deny", allowed_targets: [] },
    },
    deployments: {
      preview_local: { decision: "allow" },
      remote_research: deny,
      persistent: deny,
      public: deny,
    },
    compute: { limit_hours: DEFAULT_COMPUTE_LIMIT_HOURS },
  };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};

/** `ask` needed a researcher's approval; approvals are gone, so it becomes `deny` (conservative). */
function decision(v: unknown): PolicyDecision {
  return obj(v)["decision"] === "allow" ? "allow" : "deny";
}

/**
 * A version 1 revision as version 2 (ADR 0037): `experiments.run_local` and `submit_remote` become
 * `jobs.*`, `ask` becomes `deny`, deployment conditions that are still enforced are kept (an idle
 * timeout becomes the runtime cap it acted as), and the compute limit gets its default. Git gates,
 * checks, the network gate, edit and test gates, denied commands, protected evaluation and the
 * defaults block are dropped. Revisions on disk are immutable: this runs on every read.
 */
export function migratePolicyV1(doc: Readonly<Obj>): Obj {
  const ex = obj(doc["experiments"]);
  const remote = obj(ex["submit_remote"]);
  const deployments: Obj = {};
  for (const k of ["preview_local", "remote_research", "persistent", "public"]) {
    const g = obj(obj(doc["deployments"])[k]);
    const cap = g["max_runtime_minutes"] ?? g["idle_timeout_minutes"];
    deployments[k] = {
      decision: k === "public" ? "deny" : decision(g),
      ...(typeof g["exposure"] === "string" ? { exposure: g["exposure"] } : {}),
      ...(Array.isArray(g["allowed_targets"]) ? { allowed_targets: g["allowed_targets"] } : {}),
      ...(typeof cap === "number" ? { max_runtime_minutes: cap } : {}),
    };
  }
  return {
    schema_version: 2,
    project_id: doc["project_id"],
    revision: doc["revision"],
    created_at: doc["created_at"],
    created_by: doc["created_by"],
    ...(typeof doc["summary"] === "string" ? { summary: doc["summary"] } : {}),
    jobs: {
      run_local: { decision: decision(ex["run_local"]) },
      submit_remote: {
        decision: decision(remote),
        allowed_targets: Array.isArray(remote["allowed_targets"]) ? remote["allowed_targets"] : [],
      },
    },
    deployments,
    compute: { limit_hours: DEFAULT_COMPUTE_LIMIT_HOURS },
  };
}

/**
 * Target kinds. A policy's `allowed_targets` names either a kind (`slurm` allows every SLURM
 * target) or one configured target's ID (ADR 0023); `local` is this machine.
 */
export const KNOWN_TARGETS = new Set(["local", "ssh", "runpod", "slurm", "colab"]);
const TARGET_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const DEPLOYMENT_EXPOSURES = new Set(["loopback", "tailnet", "public"]);

/** Whether `allowed` (target IDs or kinds) admits a target with this ID and kind. */
export function targetAllowed(
  allowed: readonly string[],
  target: string,
  kind: string | undefined,
): boolean {
  return allowed.includes(target) || (kind !== undefined && allowed.includes(kind));
}

/**
 * Referential and enforceability checks beyond the schema (§7.7.3). Anything AblationKit cannot
 * enforce is refused, so it can never appear to be in force (criterion 33, "fails closed").
 */
export function validatePolicy(p: ProjectActionPolicy, projectId: string): string[] {
  const errs: string[] = [];
  if (p.project_id !== projectId) errs.push(`project_id is ${p.project_id}, not ${projectId}`);
  const targets = (label: string, list: readonly string[] | undefined) => {
    for (const t of list ?? [])
      if (!KNOWN_TARGETS.has(t) && !TARGET_ID_RE.test(t))
        errs.push(`${label}.allowed_targets: ${t} is neither a target kind nor a target ID`);
  };
  targets("jobs.submit_remote", p.jobs.submit_remote.allowed_targets);
  if (p.jobs.submit_remote.allowed_targets.includes("local"))
    errs.push("jobs.submit_remote.allowed_targets: local is jobs.run_local");
  for (const [k, g] of Object.entries(p.deployments)) {
    targets(`deployments.${k}`, g.allowed_targets);
    if (g.exposure !== undefined && !DEPLOYMENT_EXPOSURES.has(g.exposure))
      errs.push(`deployments.${k}.exposure: ${g.exposure} is not loopback, tailnet or public`);
    if (k === "preview_local" && g.exposure !== undefined && g.exposure !== "loopback")
      errs.push("deployments.preview_local.exposure: a local preview is loopback only");
  }
  if (p.deployments.public.decision === "allow")
    errs.push("deployments.public: a public endpoint is never started for an agent (§7.1)");
  return errs;
}

/** An agent action the policy decides, named by its policy field. */
export type PolicyAction =
  | "jobs.run_local"
  | "jobs.submit_remote"
  | "deployments.preview_local"
  | "deployments.remote_research"
  | "deployments.persistent"
  | "deployments.public";

/** Conditions a request carries; each is checked when present. */
export interface ActionContext {
  /** Compute or deployment target: `local` or a configured target's ID. */
  readonly target?: string;
  /** The target's kind (`ssh`, `slurm`, `runpod`, `colab`), matched by kind entries. */
  readonly targetKind?: string;
  /** Wall-clock minutes a deployment may run (its TTL). */
  readonly minutes?: number;
  /** Deployment exposure. */
  readonly exposure?: string;
}

export interface Evaluation {
  readonly decision: PolicyDecision;
  /** Why it is denied, each naming the policy field (empty when allowed). */
  readonly reasons: readonly string[];
  readonly policy_revision: number;
}

/** Decide one agent action under one policy revision. */
export function decide(
  p: ProjectActionPolicy,
  action: PolicyAction,
  ctx: ActionContext = {},
): Evaluation {
  const reasons: string[] = [];
  const done = (d: PolicyDecision): Evaluation => {
    if (d === "deny")
      reasons.unshift(`policy revision ${p.revision} sets ${action}.decision to deny`);
    return { decision: reasons.length ? "deny" : "allow", reasons, policy_revision: p.revision };
  };
  if (action === "jobs.run_local") {
    if (ctx.target && ctx.target !== "local")
      reasons.push(`jobs.run_local runs on this machine, not ${ctx.target}`);
    return done(p.jobs.run_local.decision);
  }
  if (action === "jobs.submit_remote") {
    const g = p.jobs.submit_remote;
    if (ctx.target === "local") reasons.push("jobs.submit_remote names a remote target");
    else if (
      g.decision === "allow" &&
      ctx.target &&
      !targetAllowed(g.allowed_targets, ctx.target, ctx.targetKind)
    )
      reasons.push(`target ${ctx.target} is not in jobs.submit_remote.allowed_targets`);
    return done(g.decision);
  }
  const key = action.slice("deployments.".length) as keyof ProjectActionPolicy["deployments"];
  const g = p.deployments[key];
  if (g.decision === "allow") {
    if (key === "preview_local" && ctx.exposure && ctx.exposure !== "loopback")
      reasons.push("deployments.preview_local is loopback only");
    if (g.exposure && ctx.exposure && ctx.exposure !== g.exposure)
      reasons.push(`exposure ${ctx.exposure} is not ${action}.exposure (${g.exposure})`);
    if (
      g.allowed_targets &&
      ctx.target &&
      !targetAllowed(g.allowed_targets, ctx.target, ctx.targetKind)
    )
      reasons.push(`target ${ctx.target} is not in ${action}.allowed_targets`);
    if (g.max_runtime_minutes !== undefined && (ctx.minutes ?? 0) > g.max_runtime_minutes)
      reasons.push(
        `a TTL of ${ctx.minutes} minutes exceeds ${action}.max_runtime_minutes (${g.max_runtime_minutes})`,
      );
    if (key === "public") reasons.push("a public endpoint is never started for an agent");
  }
  return done(g.decision);
}

export interface PolicyChange {
  readonly path: string;
  readonly from: unknown;
  readonly to: unknown;
  /** `widened` lets agents do more, `reduced` less. */
  readonly effect: "widened" | "reduced" | "changed";
}

function flatten(v: unknown, prefix: string, out: Map<string, unknown>): void {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else out.set(prefix, v);
}

const META = new Set([
  "schema_version",
  "project_id",
  "revision",
  "created_at",
  "created_by",
  "summary",
]);

function effectOf(path: string, x: unknown, y: unknown): PolicyChange["effect"] {
  const leaf = path.split(".").at(-1) as string;
  if (leaf === "decision") {
    if (x === undefined || y === undefined) return "changed";
    return y === "allow" ? "widened" : "reduced";
  }
  if (leaf === "allowed_targets") {
    // Absent means unrestricted on a deployment gate (on jobs.submit_remote it is required).
    const a = (x as string[] | undefined) ?? undefined;
    const b = (y as string[] | undefined) ?? undefined;
    if (a === undefined) return "reduced";
    if (b === undefined) return "widened";
    const grew = a.every((t) => b.includes(t));
    const shrank = b.every((t) => a.includes(t));
    return grew && !shrank ? "widened" : shrank && !grew ? "reduced" : "changed";
  }
  if (leaf === "limit_hours" || leaf === "max_runtime_minutes") {
    if (x === undefined) return "reduced";
    if (y === undefined) return "widened";
    return (y as number) > (x as number) ? "widened" : "reduced";
  }
  return "changed";
}

/** A field-level diff of two revisions (§7.7.6: shown before a revision is saved). */
export function diffPolicies(prev: ProjectActionPolicy, next: ProjectActionPolicy): PolicyChange[] {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  flatten(prev, "", a);
  flatten(next, "", b);
  const out: PolicyChange[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (META.has(path.split(".")[0] as string)) continue;
    const x = a.get(path);
    const y = b.get(path);
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    out.push({ path, from: x, to: y, effect: effectOf(path, x, y) });
  }
  return out;
}

/** `models:/<name>/<version>` or `runs:/<run>/<path>`: aliases, stages and `latest` are refused. */
export function isPinnedModelUri(uri: string): boolean {
  if (/^models:\/[A-Za-z0-9._-]{1,200}\/[0-9]{1,9}$/.test(uri)) return true;
  if (/^runs:\/[a-f0-9]{8,64}\/[A-Za-z0-9._/-]{1,500}$/.test(uri) && !uri.includes(".."))
    return true;
  return false;
}
