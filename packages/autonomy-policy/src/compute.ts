/**
 * The agent compute limit (ADR 0037): weighted hours used by a project's agent-submitted jobs,
 * the hours their live attempts still hold, and the admission decision for a new job. Pure
 * functions; the coordinator's `ComputeLimitService` feeds them jobs and attempts.
 *
 * A job's weight is the weight of its target when it was submitted (machine-wide, set by the
 * researcher; 1 by default), kept in hundredths. Every attempt counts, retries included: its wall
 * time × the job's weight. A live attempt also reserves the rest of its time limit × the weight,
 * so the limit holds as long as each attempt's time limit does.
 */

/** This workstation, as a compute target. */
export const LOCAL_TARGET = "local";
/** A target without a weight of its own counts 1 hour per hour. */
export const DEFAULT_WEIGHT_HUNDREDTHS = 100;
export const MAX_WEIGHT_HUNDREDTHS = 100_000;

/**
 * A weight as the researcher writes it (`1`, `0.5`, `3`, `"1.25"`), in hundredths. At most two
 * decimals; positive; at most 1000.
 */
export function parseWeight(v: unknown): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0)
    throw new Error("a weight must be a positive number, for example 1, 0.5 or 3");
  const h = Math.round(n * 100);
  if (Math.abs(h - n * 100) > 1e-6)
    throw new Error(`a weight has at most two decimals (${n} has more)`);
  if (h < 1 || h > MAX_WEIGHT_HUNDREDTHS)
    throw new Error(`a weight is between 0.01 and ${MAX_WEIGHT_HUNDREDTHS / 100}`);
  return h;
}

/** Hundredths as the number shown to people (`150` → `1.5`). */
export function weightValue(hundredths: number): number {
  return hundredths / 100;
}

const LIVE = new Set(["starting", "running"]);

export interface UsageAttempt {
  readonly state: string;
  readonly started_at?: string | undefined;
  readonly ended_at?: string | undefined;
}

export interface UsageJob {
  /** The weight recorded at submission; absent on agent jobs from before the limit (weight 1). */
  readonly weight_hundredths?: number | undefined;
  /** The job's time limit per attempt (agent jobs always have one since ADR 0037). */
  readonly runtime_max_sec?: number | undefined;
  readonly attempts: readonly UsageAttempt[];
}

export interface ComputeUsage {
  /** Weighted hours the attempts ran (live ones until `now`). */
  readonly used_hours: number;
  /** Weighted hours live attempts may still run within their time limits. */
  readonly reserved_hours: number;
  readonly jobs: number;
  readonly attempts: number;
  /** Attempts still starting or running. */
  readonly live: number;
}

const ms = (iso: string | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** Weighted hours used and reserved by agent jobs (the caller passes only agent-submitted ones). */
export function computeUsage(jobs: readonly UsageJob[], now: number): ComputeUsage {
  let usedSec = 0;
  let reservedSec = 0;
  let attempts = 0;
  let live = 0;
  for (const j of jobs) {
    const w = (j.weight_hundredths ?? DEFAULT_WEIGHT_HUNDREDTHS) / 100;
    for (const a of j.attempts) {
      attempts++;
      const start = ms(a.started_at);
      const isLive = LIVE.has(a.state);
      const end = isLive ? now : ms(a.ended_at);
      const ran =
        Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) / 1000 : 0;
      usedSec += ran * w;
      if (isLive) {
        live++;
        // Until the worker reports a start, the whole time limit is held.
        if (j.runtime_max_sec !== undefined)
          reservedSec += Math.max(0, j.runtime_max_sec - ran) * w;
      }
    }
  }
  return {
    used_hours: usedSec / 3600,
    reserved_hours: reservedSec / 3600,
    jobs: jobs.length,
    attempts,
    live,
  };
}

export interface Admission {
  readonly ok: boolean;
  /** Weighted hours the new job may use: its time limit × its target's weight. */
  readonly needed_hours: number;
  /** Weighted hours left before the job: limit − used − reserved (never below 0). */
  readonly available_hours: number;
}

/** Admit a job of `runtimeSec` on a target of `weightHundredths` when it fits under the limit. */
export function admit(
  usage: Pick<ComputeUsage, "used_hours" | "reserved_hours">,
  limitHours: number,
  runtimeSec: number,
  weightHundredths: number,
): Admission {
  const needed = (runtimeSec / 3600) * (weightHundredths / 100);
  const left = limitHours - usage.used_hours - usage.reserved_hours;
  // A float margin: 10 × 1 h on a 10 h limit fits exactly.
  return { ok: needed <= left + 1e-9, needed_hours: needed, available_hours: Math.max(0, left) };
}

/** Hours rounded for display and API responses (3 decimals: about 4 seconds). */
export function roundHours(h: number): number {
  return Math.round(h * 1000) / 1000;
}
