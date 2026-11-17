/**
 * The agent compute limit (ADR 0037). Each project's policy sets `compute.limit_hours`: the
 * weighted hours its agent-submitted jobs may use, never reset. A job's weight is its target's
 * machine-wide weight when it was submitted (`<home>/compute-weights.json`, set by the researcher,
 * 1 by default), recorded on the job. Human jobs never count.
 *
 * The coordinator admits an agent's job only when it carries a time limit and the hours used, the
 * hours live attempts still hold (the rest of their time limits) and the new job's time limit ×
 * weight fit under the limit. A refusal is audited by the route and raises one notification per
 * burst; hours used going over the limit (a remote clock or a late import) raises one per crossing.
 * The limit holds as far as each attempt's time limit holds (see `ENFORCEMENT_NOTE`).
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  admit,
  type ComputeUsage,
  computeUsage,
  DEFAULT_WEIGHT_HUNDREDTHS,
  defaultSlots,
  LOCAL_TARGET,
  parseWeight,
  roundHours,
  targetAllowed,
  weightValue,
} from "@ablationkit/autonomy-policy";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type ComputeLimitState,
  type ComputeWeights,
  validateComputeLimitState,
  validateComputeWeights,
} from "@ablationkit/protocol";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";

/** Where the limit is enforced and what it rests on (spec §7.11: never claim more). */
export const ENFORCEMENT_NOTE =
  "Enforced at agent submission: the coordinator refuses a job without a time limit, or one whose time limit × weight does not fit. Usage after admission is bounded by each attempt's time limit: systemd's RuntimeMaxSec in a user scope (local and remote workers with systemd); in direct mode the collector or the remote shim stops the job's process group, and a process that leaves the group escapes it; a Colab runtime is bounded by the shim on the runtime and stopped once its results are collected; an exported Colab notebook is bounded only by the shim once someone runs it. Remote attempts count the times their worker reports.";

export interface WeightView {
  readonly target_id: string;
  readonly label: string;
  readonly kind: string;
  readonly weight: number;
  readonly weight_hundredths: number;
  /** No weight was set: the default of 1. */
  readonly default: boolean;
  /** How many jobs needing a GPU run there at once (ADR 0068). */
  readonly slots: number;
  /** No slots were set: the default (1, or 2 for Colab). */
  readonly slots_default: boolean;
}

export interface ProjectComputeUsage {
  readonly project_id: string;
  readonly name: string;
  readonly policy_revision: number;
  readonly limit_hours: number;
  readonly used_hours: number;
  readonly reserved_hours: number;
  readonly available_hours: number;
  /** Agent-submitted jobs counted, their attempts, and those still live. */
  readonly jobs: number;
  readonly attempts: number;
  readonly live: number;
  readonly over_limit: boolean;
  /** Agents' jobs of this project waiting for a slot (ADR 0068). */
  readonly queued: number;
  readonly refused?: { readonly at: string; readonly count: number; readonly message: string };
  /**
   * The targets the project policy lets agents run jobs on, with their weights (an hour there
   * counts this many hours) and whether a job's limits are enforced there.
   */
  readonly targets: readonly AgentTargetView[];
}

export interface AgentTargetView {
  readonly target_id: string;
  readonly label: string;
  readonly kind: string;
  readonly weight: number;
  /** How many jobs needing a GPU run there at once; agents' jobs queue for a free one. */
  readonly slots: number;
  /** Jobs needing a GPU live there now, anyone's. */
  readonly busy: number;
  /**
   * `enforced` or `advisory` on this machine (systemd user scopes, or direct mode), with the
   * reason; `reported_per_attempt` on a remote target, whose worker reports it for each attempt.
   */
  readonly limits: "enforced" | "advisory" | "reported_per_attempt";
  readonly limits_reason?: string;
}

const fmt = (h: number): string => String(Math.round(h * 100) / 100);

export class ComputeLimitService {
  private doc: ComputeWeights = { schema_version: 1, weights: {} };
  private readonly states = new Map<string, ComputeLimitState>();
  private unsubscribe: (() => void) | undefined;
  readonly loadProblems: string[] = [];

  constructor(
    private readonly o: {
      readonly svc: () => Services;
      readonly weightsPath: string;
      readonly stateDir: string;
      readonly now: () => Date;
    },
  ) {}

  load(): void {
    if (!existsSync(this.o.weightsPath)) return;
    try {
      this.doc = readJson(this.o.weightsPath, validateComputeWeights);
    } catch (e) {
      this.loadProblems.push(`${this.o.weightsPath}: ${(e as Error).message}`);
    }
  }

  /** Re-check a project's usage when its attempts change or its policy is revised. */
  start(): void {
    this.unsubscribe = this.o.svc().events.subscribe((e) => {
      if (e.type !== "job.attempt.state" && e.type !== "policy.revised") return;
      // After the publish that triggered it: a notification publishes an event of its own.
      queueMicrotask(() => {
        try {
          if (this.o.svc().registry.get(e.project_id)) this.check(e.project_id);
        } catch (err) {
          console.error("compute limit check failed", err);
        }
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  // ------------------------------------------------------------------ weights

  weightOf(targetId: string): number {
    return this.doc.weights[targetId] ?? DEFAULT_WEIGHT_HUNDREDTHS;
  }

  /** How many jobs needing a GPU run on a target at once (ADR 0068). */
  slotsOf(targetId: string): number {
    const set = this.doc.slots?.[targetId];
    if (set !== undefined) return set;
    if (targetId === LOCAL_TARGET) return defaultSlots("local");
    return defaultSlots(this.o.svc().targets.get(targetId)?.kind ?? "");
  }

  /** This workstation and every configured target, with their weights. */
  weights(): { weights: WeightView[]; updated_at?: string; updated_by?: string } {
    const svc = this.o.svc();
    const view = (target_id: string, label: string, kind: string): WeightView => {
      const h = this.doc.weights[target_id];
      const slots = this.doc.slots?.[target_id];
      return {
        target_id,
        label,
        kind,
        weight: weightValue(h ?? DEFAULT_WEIGHT_HUNDREDTHS),
        weight_hundredths: h ?? DEFAULT_WEIGHT_HUNDREDTHS,
        default: h === undefined,
        slots: slots ?? defaultSlots(kind),
        slots_default: slots === undefined,
      };
    };
    return {
      weights: [
        view(LOCAL_TARGET, "this workstation", "local"),
        ...svc.targets.list().map((t) => view(t.target_id, t.label ?? t.target_id, t.kind)),
      ],
      ...(this.doc.updated_at ? { updated_at: this.doc.updated_at } : {}),
      ...(this.doc.updated_by ? { updated_by: this.doc.updated_by } : {}),
    };
  }

  /**
   * Set weights (`{ "local": 1, "a100": 3 }`; `null` goes back to 1) and slots (`{ "local": 2 }`;
   * `null` goes back to the default). Jobs already placed keep the weight they recorded.
   */
  setWeights(
    input: unknown,
    by: string,
    slotsInput?: unknown,
  ): {
    changes: { target_id: string; from: number; to: number }[];
    slot_changes: { target_id: string; from: number; to: number }[];
  } {
    if (input === undefined && slotsInput === undefined)
      throw new HttpError(400, "invalid_request", "give `weights`, `slots` or both");
    const isMap = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
    if (input !== undefined && !isMap(input))
      throw new HttpError(400, "invalid_request", "`weights` must be an object of target → weight");
    if (slotsInput !== undefined && !isMap(slotsInput))
      throw new HttpError(400, "invalid_request", "`slots` must be an object of target → slots");
    const svc = this.o.svc();
    const next = { ...this.doc.weights };
    const changes: { target_id: string; from: number; to: number }[] = [];
    const nextSlots: Record<string, number> = { ...(this.doc.slots ?? {}) };
    const slotChanges: { target_id: string; from: number; to: number }[] = [];
    for (const [id, raw] of Object.entries((slotsInput ?? {}) as Record<string, unknown>)) {
      if (id !== LOCAL_TARGET && !svc.targets.get(id))
        throw new HttpError(404, "target_not_found", `no compute target ${id}`);
      const from = this.slotsOf(id);
      if (raw === null) delete nextSlots[id];
      else if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 64)
        nextSlots[id] = raw;
      else
        throw new HttpError(400, "invalid_slots", `${id}: slots are a whole number from 1 to 64`);
      const kind = id === LOCAL_TARGET ? "local" : (svc.targets.get(id)?.kind ?? "");
      const to = nextSlots[id] ?? defaultSlots(kind);
      if (from !== to) slotChanges.push({ target_id: id, from, to });
    }
    for (const [id, raw] of Object.entries((input ?? {}) as Record<string, unknown>)) {
      if (id !== LOCAL_TARGET && !svc.targets.get(id))
        throw new HttpError(404, "target_not_found", `no compute target ${id}`);
      const from = next[id] ?? DEFAULT_WEIGHT_HUNDREDTHS;
      let to: number;
      if (raw === null) {
        delete next[id];
        to = DEFAULT_WEIGHT_HUNDREDTHS;
      } else {
        try {
          to = parseWeight(raw);
        } catch (e) {
          throw new HttpError(400, "invalid_weight", `${id}: ${(e as Error).message}`);
        }
        next[id] = to;
      }
      if (from !== to)
        changes.push({ target_id: id, from: weightValue(from), to: weightValue(to) });
    }
    const doc: ComputeWeights = {
      schema_version: 1,
      weights: next,
      ...(Object.keys(nextSlots).length ? { slots: nextSlots } : {}),
      updated_at: this.o.now().toISOString(),
      updated_by: by,
    };
    mkdirSync(dirname(this.o.weightsPath), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.o.weightsPath, doc, { validate: validateComputeWeights });
    this.doc = doc;
    // More slots can start queued jobs at once.
    if (slotChanges.length) svc.jobs.schedule();
    return { changes, slot_changes: slotChanges };
  }

  // ------------------------------------------------------------------ usage

  private raw(projectId: string): ComputeUsage {
    const jobs = this.o.svc().jobs;
    return computeUsage(
      jobs
        .list(projectId)
        .filter((j) => j.submitted_by.kind === "agent")
        .map((j) => ({
          weight_hundredths: j.compute_weight_hundredths,
          runtime_max_sec: j.limits.runtime_max_sec,
          queued: j.state === "queued",
          attempts: j.attempts.flatMap((id) => {
            const a = jobs.attempt(id);
            return a ? [a] : [];
          }),
        })),
      this.o.now().getTime(),
    );
  }

  usage(projectId: string): ProjectComputeUsage {
    const svc = this.o.svc();
    const project = svc.registry.require(projectId);
    const policy = svc.policy.current(projectId);
    const u = this.raw(projectId);
    const limit = policy.compute.limit_hours;
    const refused = this.state(projectId).refused;
    return {
      project_id: projectId,
      name: project.name,
      policy_revision: policy.revision,
      limit_hours: limit,
      used_hours: roundHours(u.used_hours),
      reserved_hours: roundHours(u.reserved_hours),
      available_hours: roundHours(Math.max(0, limit - u.used_hours - u.reserved_hours)),
      jobs: u.jobs,
      attempts: u.attempts,
      live: u.live,
      over_limit: u.used_hours > limit + 1e-9,
      queued: svc.jobs.queued(projectId).length,
      // Refusals under an earlier revision were answered by the revision.
      ...(refused && refused.policy_revision === policy.revision
        ? { refused: { at: refused.last_at, count: refused.count, message: refused.message } }
        : {}),
      targets: this.agentTargets(policy.jobs),
    };
  }

  /**
   * A project's pool (ADR 0068): the targets its policy lets agents' jobs run on, in the order
   * AblationKit tries them: this machine if `jobs.run_local` allows, then the remote targets
   * `jobs.submit_remote` allows. The agent never picks among them.
   */
  pool(projectId: string): AgentTargetView[] {
    return this.agentTargets(this.o.svc().policy.current(projectId).jobs);
  }

  /** The targets `jobs` lets an agent use: this machine if run_local allows, then remote ones. */
  private agentTargets(jobs: {
    readonly run_local: { readonly decision: string };
    readonly submit_remote: {
      readonly decision: string;
      readonly allowed_targets: readonly string[];
    };
  }): AgentTargetView[] {
    const svc = this.o.svc();
    const out: AgentTargetView[] = [];
    const busy = svc.jobs.occupancy();
    if (jobs.run_local.decision === "allow") {
      const probe = svc.jobs.probe();
      out.push({
        target_id: LOCAL_TARGET,
        label: "this workstation",
        kind: "local",
        weight: weightValue(this.weightOf(LOCAL_TARGET)),
        slots: this.slotsOf(LOCAL_TARGET),
        busy: busy.get(LOCAL_TARGET) ?? 0,
        limits: probe.enforcement,
        ...(probe.reason ? { limits_reason: probe.reason } : {}),
      });
    }
    if (jobs.submit_remote.decision === "allow")
      for (const t of svc.targets.list())
        if (targetAllowed(jobs.submit_remote.allowed_targets, t.target_id, t.kind))
          out.push({
            target_id: t.target_id,
            label: t.label ?? t.target_id,
            kind: t.kind,
            weight: weightValue(this.weightOf(t.target_id)),
            slots: this.slotsOf(t.target_id),
            busy: busy.get(t.target_id) ?? 0,
            limits: "reported_per_attempt",
          });
    return out;
  }

  allUsage(): ProjectComputeUsage[] {
    return this.o
      .svc()
      .registry.list()
      .map((p) => this.usage(p.project_id));
  }

  // ------------------------------------------------------------------ admission

  /**
   * Admit an agent's job of `runtimeSec` that may run on any of `targets` (its pool, ADR 0068), or
   * throw 403 `compute_limit_reached`. It is held at the heaviest of their weights until it is
   * placed. Returns that weight, to record on the job.
   */
  admit(projectId: string, targets: readonly string[], runtimeSec: number): number {
    const svc = this.o.svc();
    const policy = svc.policy.current(projectId);
    const heaviest = targets.reduce(
      (best, t) => (this.weightOf(t) > this.weightOf(best) ? t : best),
      targets[0] ?? LOCAL_TARGET,
    );
    const weight = this.weightOf(heaviest);
    const u = this.raw(projectId);
    const limit = policy.compute.limit_hours;
    const a = admit(u, limit, runtimeSec, weight);
    if (a.ok) {
      const s = this.state(projectId);
      if (s.refused) {
        const { refused: _r, ...rest } = s;
        this.save(rest);
      }
      return weight;
    }
    const name = svc.registry.require(projectId).name;
    const message = `This job may use up to ${fmt(a.needed_hours)} weighted hours (${fmt(runtimeSec / 3600)} h time limit × weight ${weightValue(weight)}${targets.length > 1 ? `, the heaviest of its pool (${heaviest})` : ` on ${heaviest}`}), but agents in ${name} have used ${fmt(u.used_hours)} and reserved ${fmt(u.reserved_hours)} of ${limit} (${fmt(a.available_hours)} left).`;
    this.refused(projectId, name, policy.revision, message);
    throw new HttpError(
      403,
      "compute_limit_reached",
      `${message} The researcher can raise compute.limit_hours in Project settings → Agent permissions.`,
      {
        policy_revision: policy.revision,
        limit_hours: limit,
        used_hours: roundHours(u.used_hours),
        reserved_hours: roundHours(u.reserved_hours),
        available_hours: roundHours(a.available_hours),
        needed_hours: roundHours(a.needed_hours),
        target: heaviest,
        weight: weightValue(weight),
      },
    );
  }

  private refused(projectId: string, name: string, revision: number, message: string): void {
    const s = this.state(projectId);
    const at = this.o.now().toISOString();
    const burst = s.refused && s.refused.policy_revision === revision;
    this.save({
      ...s,
      refused: {
        first_at: burst ? (s.refused?.first_at ?? at) : at,
        last_at: at,
        count: burst ? (s.refused?.count ?? 0) + 1 : 1,
        policy_revision: revision,
        message: message.slice(0, 2000),
      },
    });
    if (burst) return;
    this.o.svc().notifier.notify({
      key: `compute_limit:${projectId}:refused`,
      title: `An agent reached the compute limit for ${name}`,
      body: `${message} Raise it in Project settings.`,
      urgency: "normal",
      project_id: projectId,
      link: settingsLink(projectId),
    });
  }

  /** Notify once when the hours used go over the limit; re-arm once they are within it again. */
  check(projectId: string): void {
    const svc = this.o.svc();
    const project = svc.registry.require(projectId);
    const limit = svc.policy.current(projectId).compute.limit_hours;
    const u = this.raw(projectId);
    const over = u.used_hours > limit + 1e-9;
    const s = this.state(projectId);
    if (over === (s.over_limit_since !== undefined)) return;
    if (!over) {
      const { over_limit_since: _o, ...rest } = s;
      this.save(rest);
      return;
    }
    this.save({ ...s, over_limit_since: this.o.now().toISOString() });
    svc.notifier.notify({
      key: `compute_limit:${projectId}:over`,
      title: `Agent jobs in ${project.name} went over the compute limit`,
      body: `They have used ${fmt(u.used_hours)} of ${limit} weighted hours; new agent jobs are refused. Raise it in Project settings.`,
      urgency: "normal",
      project_id: projectId,
      link: settingsLink(projectId),
    });
  }

  // ------------------------------------------------------------------ state

  private path(projectId: string): string {
    return join(this.o.stateDir, projectId, "compute", "limit.json");
  }

  private state(projectId: string): ComputeLimitState {
    const hit = this.states.get(projectId);
    if (hit) return hit;
    const p = this.path(projectId);
    let s: ComputeLimitState = { schema_version: 1, project_id: projectId };
    if (existsSync(p)) {
      try {
        s = readJson(p, validateComputeLimitState);
      } catch {
        // Only notices: an unreadable file means the next refusal notifies again.
      }
    }
    this.states.set(projectId, s);
    return s;
  }

  private save(s: ComputeLimitState): void {
    const p = this.path(s.project_id);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeJsonAtomic(p, s, { validate: validateComputeLimitState });
    this.states.set(s.project_id, s);
  }

  /** A removed project's notices were moved aside with its state. */
  forgetProject(projectId: string): void {
    this.states.delete(projectId);
  }
}

function settingsLink(projectId: string): string {
  return `/p/${encodeURIComponent(projectId)}/settings#agent-permissions`;
}
