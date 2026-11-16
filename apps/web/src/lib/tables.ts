/** Pure table, filter and export helpers for the Runs pages (unit-tested under bun test). */
import { AK_TAGS } from "./types.ts";

export interface CompareTable {
  runs: { run_id: string; run_name?: string }[];
  params: { key: string; values: (string | undefined)[] }[];
  metrics: { key: string; values: (number | undefined)[] }[];
}

export interface AblationTable {
  variants: {
    variant_id: string;
    runs: unknown[];
    params: Record<string, string>;
    metrics: Record<string, { mean: number; std?: number; n: number }>;
  }[];
  metric_keys: string[];
  differing_params: string[];
}

/** Heuristic direction for highlighting; shown as such in the UI. */
export function lowerIsBetter(key: string): boolean {
  // Rates are higher-is-better even when they name a time unit (tokens_per_sec, samples/s).
  if (/(per_?sec|per_?second|_per_s\b|\/s\b|throughput|speedup|mfu)/i.test(key)) return false;
  return /(loss|error|err\b|perplexity|ppl|mse|mae|rmse|latency|time|seconds?\b|_sec\b|duration|wer|cer|bits|bpb|bpc|nll|flops|cost)/i.test(
    key,
  );
}

export interface DeclaredDirections {
  /** The study's `metric_goals` (all compared runs share the study). */
  readonly studyGoals?: readonly { key: string; goal: "min" | "max" }[];
}

export interface MetricDirection {
  readonly lower: boolean;
  readonly source: "study" | "name";
}

/** Which way is better: a study goal, then the name heuristic. */
export function metricDirection(key: string, d: DeclaredDirections = {}): MetricDirection {
  const goal = d.studyGoals?.find((g) => g.key === key);
  if (goal) return { lower: goal.goal === "min", source: "study" };
  return { lower: lowerIsBetter(key), source: "name" };
}

/** The one value of an ablationkit tag the runs carry (runs without it are ignored), if exactly one. */
export function sharedTag(
  runs: readonly { ablationkit: Record<string, string> }[],
  tag: string,
): string | undefined {
  const vals = new Set(runs.map((r) => r.ablationkit[tag]).filter((v): v is string => !!v));
  return vals.size === 1 ? [...vals][0] : undefined;
}

export function compareCsv(c: CompareTable): string {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const head = ["kind", "key", ...c.runs.map((r) => r.run_name ?? r.run_id)];
  const rows = [
    ...c.params.map((p) => ["param", p.key, ...p.values]),
    ...c.metrics.map((m) => ["metric", m.key, ...m.values]),
  ];
  return `${[head, ...rows].map((r) => r.map(esc).join(",")).join("\n")}\n`;
}

export function ablationCsv(s: AblationTable): string {
  const head = ["variant", "n_runs", ...s.differing_params.map((p) => `param.${p}`)];
  for (const k of s.metric_keys) head.push(`${k}.mean`, `${k}.std`, `${k}.n`);
  const rows = s.variants.map((v) => {
    const r: (string | number)[] = [
      v.variant_id,
      v.runs.length,
      ...s.differing_params.map((p) => v.params[p] ?? ""),
    ];
    for (const k of s.metric_keys) {
      const st = v.metrics[k];
      r.push(st?.mean ?? "", st?.std ?? "", st?.n ?? "");
    }
    return r;
  });
  return `${[head, ...rows].map((r) => r.join(",")).join("\n")}\n`;
}

/** Build the MLflow filter string from quick filters plus free text. */
export function buildFilter(q: {
  status?: string | null;
  study?: string | null;
  variant?: string | null;
  filter?: string | null;
}): string {
  const parts: string[] = [];
  const esc = (v: string) => v.replaceAll("'", "\\'");
  if (q.status) parts.push(`attributes.status = '${esc(q.status)}'`);
  if (q.study) parts.push(`tags.\`${AK_TAGS.study}\` = '${esc(q.study)}'`);
  if (q.variant) parts.push(`tags.\`${AK_TAGS.variant}\` = '${esc(q.variant)}'`);
  if (q.filter?.trim()) parts.push(q.filter.trim());
  return parts.join(" and ");
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step)
    out.push(Number(v.toPrecision(12)));
  return out;
}

/**
 * The metric columns a runs table shows: the metrics the project's studies decide on first, then
 * held-out ones (`validation/`, `val/`, `eval/`, `test/`), then the rest; system metrics never.
 */
export function rankMetricKeys(
  keys: Iterable<string>,
  goals: ReadonlySet<string>,
  max = 6,
): string[] {
  const tier = (k: string) => (goals.has(k) ? 0 : /^(validation|val|eval|test)\//.test(k) ? 1 : 2);
  return [...new Set(keys)]
    .filter((k) => !k.startsWith("system/"))
    .sort((a, b) => tier(a) - tier(b) || a.localeCompare(b))
    .slice(0, max);
}
