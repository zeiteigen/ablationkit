/**
 * Compute usage for the Compute page and the project overview (ADR 0036): time used per job, a
 * spend estimate from each target's rate card, and utilization from the `system/*` metrics runs
 * report to MLflow. Everything here is derived from what the coordinator already returns; spend is
 * an estimate (rate × time), never a bill, and a target without a rate card has an unknown cost.
 */
import type { ComputeTargetView, JobView, Metric } from "./types.ts";

export const LOCAL_TARGET = "local";

export interface JobUsage {
  job: JobView;
  target_id: string;
  /** Start of the latest attempt, epoch ms (undefined until it starts). */
  started?: number;
  /** Time the latest attempt has run, ms (to now while it runs). */
  ms: number;
  running: boolean;
  /** Estimated cents; undefined when the target is paid but has no rate card. */
  cents?: number;
  paid: boolean;
}

const LIVE = new Set(["starting", "running"]);

/** Usage of each job's latest attempt. Jobs that never started count zero time. */
export function jobUsage(
  jobs: readonly JobView[],
  targets: readonly ComputeTargetView[],
  now: number,
): JobUsage[] {
  const byId = new Map(targets.map((t) => [t.target_id, t]));
  return jobs.map((job) => {
    const a = job.latest_attempt;
    const target_id = job.target_id ?? a?.remote?.target_id ?? LOCAL_TARGET;
    const started = a?.started_at ? Date.parse(a.started_at) : Number.NaN;
    const ended = a?.ended_at ? Date.parse(a.ended_at) : Number.NaN;
    const running = LIVE.has(a?.state ?? job.state);
    const ms = Number.isFinite(started)
      ? Math.max(0, (Number.isFinite(ended) ? ended : running ? now : started) - started)
      : 0;
    const t = byId.get(target_id);
    const paid = t?.paid ?? false;
    const rate = t?.runpod?.cents_per_hour;
    const cents = !paid ? 0 : rate !== undefined ? (rate * ms) / 3_600_000 : undefined;
    return {
      job,
      target_id,
      ...(Number.isFinite(started) ? { started } : {}),
      ms,
      running,
      ...(cents !== undefined ? { cents } : {}),
      paid,
    };
  });
}

/** Usage that overlaps [since, now]; `since` undefined keeps everything. */
export function inWindow(u: readonly JobUsage[], since: number | undefined): JobUsage[] {
  if (since === undefined) return [...u];
  return u.filter((x) => x.running || (x.started !== undefined && x.started + x.ms >= since));
}

export interface TargetTotals {
  target_id: string;
  jobs: number;
  running: number;
  ms: number;
  cents: number;
  /** Jobs on a paid target without a rate card: their cost is unknown, not zero. */
  unpriced: number;
  paid: boolean;
}

export function byTarget(u: readonly JobUsage[]): TargetTotals[] {
  const m = new Map<string, TargetTotals>();
  for (const x of u) {
    const t = m.get(x.target_id) ?? {
      target_id: x.target_id,
      jobs: 0,
      running: 0,
      ms: 0,
      cents: 0,
      unpriced: 0,
      paid: x.paid,
    };
    t.jobs++;
    if (x.running) t.running++;
    t.ms += x.ms;
    if (x.cents === undefined) t.unpriced++;
    else t.cents += x.cents;
    m.set(x.target_id, t);
  }
  return [...m.values()].sort((a, b) => b.ms - a.ms || a.target_id.localeCompare(b.target_id));
}

export function totals(u: readonly JobUsage[]): Omit<TargetTotals, "target_id" | "paid"> {
  const all = byTarget(u);
  return {
    jobs: all.reduce((s, t) => s + t.jobs, 0),
    running: all.reduce((s, t) => s + t.running, 0),
    ms: all.reduce((s, t) => s + t.ms, 0),
    cents: all.reduce((s, t) => s + t.cents, 0),
    unpriced: all.reduce((s, t) => s + t.unpriced, 0),
  };
}

const DAY = 86_400_000;

/** Compute hours per day (by attempt start, local midnight) for the last `days` days, per target. */
export function dailyHours(
  u: readonly JobUsage[],
  now: number,
  days: number,
): { target_id: string; points: [number, number][] }[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const first = today.getTime() - (days - 1) * DAY;
  const targets = [...new Set(u.map((x) => x.target_id))].sort();
  return targets.map((target_id) => {
    const buckets = Array.from({ length: days }, () => 0);
    for (const x of u) {
      if (x.target_id !== target_id || x.started === undefined) continue;
      const d = new Date(x.started);
      d.setHours(0, 0, 0, 0);
      const i = Math.round((d.getTime() - first) / DAY);
      if (i >= 0 && i < days) buckets[i] = (buckets[i] ?? 0) + x.ms / 3_600_000;
    }
    return {
      target_id,
      points: buckets.map((h, i) => [first + i * DAY, Number(h.toFixed(3))] as [number, number]),
    };
  });
}

export interface Utilization {
  cpu?: number;
  memory?: number;
  /** Mean over the GPUs the run reported. */
  gpu?: number;
  gpu_memory?: number;
  gpus: number;
}

const mean = (xs: number[]): number | undefined =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined;

/**
 * Utilization from a run's latest `system/*` metrics (MLflow's system metric names). These are the
 * last values reported, not averages over the run.
 */
export function utilization(metrics: readonly Metric[] | undefined): Utilization | undefined {
  const sys = (metrics ?? []).filter((m) => m.key.startsWith("system/"));
  if (!sys.length) return undefined;
  const get = (k: string) => sys.find((m) => m.key === `system/${k}`)?.value;
  const gpu: number[] = [];
  const gpuMem: number[] = [];
  const ids = new Set<string>();
  for (const m of sys) {
    const g = /^system\/gpu_(\d+)_(utilization|memory_usage)_percentage$/.exec(m.key);
    if (!g) continue;
    ids.add(g[1] as string);
    (g[2] === "utilization" ? gpu : gpuMem).push(m.value);
  }
  const u: Utilization = { gpus: ids.size };
  const cpu = get("cpu_utilization_percentage");
  const mem = get("system_memory_usage_percentage");
  const g = mean(gpu);
  const gm = mean(gpuMem);
  if (cpu !== undefined) u.cpu = cpu;
  if (mem !== undefined) u.memory = mem;
  if (g !== undefined) u.gpu = g;
  if (gm !== undefined) u.gpu_memory = gm;
  const any = [u.cpu, u.memory, u.gpu, u.gpu_memory].some((v) => v !== undefined);
  return any ? u : undefined;
}

export function fmtHours(ms: number): string {
  const h = ms / 3_600_000;
  if (h === 0) return "0 h";
  if (h < 0.1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  return `${h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString()} h`;
}

export function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(cents < 1000 ? 2 : 0)}`;
}

export function fmtPct(v: number | undefined): string {
  return v === undefined ? "—" : `${Math.round(v)}%`;
}
