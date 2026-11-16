/**
 * The authoritative project action policy (spec §7.7.2; ADR 0037). Revisions are immutable files
 * under `state/<project>/policy/rev-NNNNNN.json`, outside every agent-editable checkout, and each
 * revision is audited. Revision 0 is the built-in default and is never written. Version 1
 * revisions are migrated on every read; the files stay as they were written. A repository file
 * (`AGENTS.md`, skills, prompts) never changes the policy.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  type ActionContext,
  decide,
  defaultPolicy,
  diffPolicies,
  migratePolicyV1,
  type PolicyAction,
  type PolicyChange,
  validatePolicy,
} from "@ablationkit/autonomy-policy";
import { readJsonMigrated, SchemaMigrator, serializeJson } from "@ablationkit/core";
import { type ProjectActionPolicy, validateProjectActionPolicy } from "@ablationkit/protocol";
import { HttpError } from "../http.ts";

const REV_RE = /^rev-([0-9]{6})\.json$/;

/** Revisions on disk: version 1 (before ADR 0037) is read as version 2. */
const MIGRATOR = new SchemaMigrator<ProjectActionPolicy>({
  kind: "project action policy",
  currentVersion: 2,
  validate: validateProjectActionPolicy,
  migrations: [
    {
      from: 1,
      description: "ADR 0037: jobs, deployments and a compute limit; ask becomes deny",
      up: migratePolicyV1,
    },
  ],
});

export class PolicyService {
  private readonly cache = new Map<string, ProjectActionPolicy>();

  constructor(
    private readonly stateDir: string,
    private readonly now: () => Date,
  ) {}

  dir(projectId: string): string {
    return join(this.stateDir, projectId, "policy");
  }

  revisions(projectId: string): number[] {
    const d = this.dir(projectId);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .map((f) => REV_RE.exec(f)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  revision(projectId: string, n: number): ProjectActionPolicy | undefined {
    if (n === 0) return defaultPolicy(projectId, "1970-01-01T00:00:00Z");
    const key = `${projectId}:${n}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const path = join(this.dir(projectId), `rev-${String(n).padStart(6, "0")}.json`);
    if (!existsSync(path)) return undefined;
    let p: ProjectActionPolicy;
    try {
      p = readJsonMigrated(path, MIGRATOR).value;
    } catch (e) {
      throw new HttpError(500, "policy_corrupt", `${path}: ${(e as Error).message}`);
    }
    if (p.project_id !== projectId || p.revision !== n)
      throw new HttpError(500, "policy_corrupt", `${path} does not match its project or revision`);
    this.cache.set(key, p);
    return p;
  }

  /** Forget a removed project's cached policy (its files were moved aside). */
  forgetProject(projectId: string): void {
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${projectId}:`)) this.cache.delete(k);
  }

  current(projectId: string): ProjectActionPolicy {
    const revs = this.revisions(projectId);
    const last = revs[revs.length - 1];
    return last === undefined
      ? defaultPolicy(projectId, "1970-01-01T00:00:00Z")
      : (this.revision(projectId, last) as ProjectActionPolicy);
  }

  /** The next revision from a proposed body, validated (schema, then enforceability). */
  private next(
    projectId: string,
    body: unknown,
    by: string,
  ): { policy: ProjectActionPolicy; previous: ProjectActionPolicy; errors: string[] } {
    const previous = this.current(projectId);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new HttpError(400, "invalid_request", "`policy` must be an object");
    const policy = validateProjectActionPolicy({
      ...(body as Record<string, unknown>),
      schema_version: 2,
      project_id: projectId,
      revision: previous.revision + 1,
      created_at: this.now().toISOString(),
      created_by: by,
    });
    return { policy, previous, errors: validatePolicy(policy, projectId) };
  }

  /** Write the next immutable revision. The caller has already authorized the researcher. */
  revise(
    projectId: string,
    body: unknown,
    by: string,
    expectRevision?: number,
  ): { policy: ProjectActionPolicy; previous: ProjectActionPolicy; changes: PolicyChange[] } {
    const current = this.current(projectId).revision;
    if (expectRevision !== undefined && expectRevision !== current)
      throw new HttpError(
        409,
        "revision_conflict",
        `current revision is ${current}, not ${expectRevision}`,
      );
    let out: ReturnType<PolicyService["next"]>;
    try {
      out = this.next(projectId, body, by);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(422, "invalid_policy", (e as Error).message);
    }
    const { policy, previous, errors } = out;
    if (errors.length)
      throw new HttpError(422, "unsupported_policy", errors.join("; "), { errors });
    const d = this.dir(projectId);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    const path = join(d, `rev-${String(policy.revision).padStart(6, "0")}.json`);
    // Exclusive create: an existing revision is never overwritten.
    const fd = openSync(path, "wx", 0o400);
    try {
      writeSync(fd, serializeJson(policy));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(path, 0o400);
    this.cache.set(`${projectId}:${policy.revision}`, policy);
    return { policy, previous, changes: diffPolicies(previous, policy) };
  }

  /**
   * Validate a proposed revision without writing it and show its diff against the current one
   * (§7.7.6 "show policy diffs before saving").
   */
  preview(
    projectId: string,
    body: unknown,
  ): { valid: boolean; errors: string[]; changes: PolicyChange[]; current: number } {
    const current = this.current(projectId);
    let out: ReturnType<PolicyService["next"]>;
    try {
      out = this.next(projectId, body, "preview");
    } catch (e) {
      if (e instanceof HttpError && e.code === "invalid_request") throw e;
      return {
        valid: false,
        errors: [(e as Error).message],
        changes: [],
        current: current.revision,
      };
    }
    return {
      valid: out.errors.length === 0,
      errors: out.errors,
      changes: diffPolicies(out.previous, out.policy),
      current: current.revision,
    };
  }

  /**
   * Refuse an agent's request the current policy denies (ADR 0037): 403 `policy_denied`, with
   * reasons that name the policy field.
   */
  requireAgent(
    projectId: string,
    action: PolicyAction,
    ctx: ActionContext = {},
  ): { policy_revision: number } {
    const e = decide(this.current(projectId), action, ctx);
    if (e.decision !== "allow")
      throw new HttpError(403, "policy_denied", e.reasons.join("; "), {
        action,
        policy_revision: e.policy_revision,
        reasons: e.reasons,
      });
    return { policy_revision: e.policy_revision };
  }

  /** What an agent may see (§7.7.6): the decisions, no editable file or credentials. */
  summary(projectId: string): Record<string, unknown> {
    const p = this.current(projectId);
    return {
      project_id: projectId,
      policy_revision: p.revision,
      // What an agent may *run* (jobs, deployments, compute). Only the researcher edits it; it does
      // not gate recording (research records, tasks, imports). An onboarding agent read an earlier
      // `read_only: true` here as "the project is read-only".
      editable_by_agents: false,
      note: "The policy in force: what jobs and deployments agents may run, and the compute limit. Only the researcher changes it, in AblationKit; files in the repository cannot. It does not limit recording research records, tasks or imported runs.",
      jobs: p.jobs,
      deployments: p.deployments,
      compute: p.compute,
    };
  }
}
