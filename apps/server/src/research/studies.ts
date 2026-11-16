/**
 * Study and Variant views over MLflow runs (spec §6.1). A Study is a planned comparison (baseline
 * plus variants); a Variant is one configuration under test with many jobs. Until research
 * records arrive (Stage 7), studies and variants are derived from the `ablationkit.study_id` and
 * `ablationkit.variant_id` run tags that jobs and manual runs already carry. Repeated runs of one
 * variant (seeds) are aggregated: n, mean, sample standard deviation, min and max of each metric's
 * latest value.
 */
import type { MlflowRun } from "@ablationkit/tracking-mlflow";
import { TAGS } from "@ablationkit/tracking-mlflow";

export const NO_VARIANT = "(no variant)";

export interface MetricStats {
  readonly n: number;
  readonly mean: number;
  /** Sample standard deviation; undefined with fewer than two values. */
  readonly std?: number;
  readonly min: number;
  readonly max: number;
}

export function stats(values: readonly number[]): MetricStats | undefined {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return undefined;
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const base = { n, mean, min: Math.min(...v), max: Math.max(...v) };
  if (n < 2) return base;
  const varSample = v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { ...base, std: Math.sqrt(varSample) };
}

function tag(r: MlflowRun, key: string): string | undefined {
  return r.data.tags?.find((t) => t.key === key)?.value;
}

export interface StudySummary {
  readonly study_id: string;
  readonly variants: number;
  readonly runs: number;
  readonly status_counts: Record<string, number>;
  readonly last_start_time: number;
}

export function summarizeStudies(runs: readonly MlflowRun[]): StudySummary[] {
  const by = new Map<string, MlflowRun[]>();
  for (const r of runs) {
    const s = tag(r, TAGS.study);
    if (!s) continue;
    const list = by.get(s) ?? [];
    list.push(r);
    by.set(s, list);
  }
  return [...by.entries()]
    .map(([study_id, rs]) => {
      const status_counts: Record<string, number> = {};
      for (const r of rs) status_counts[r.info.status] = (status_counts[r.info.status] ?? 0) + 1;
      return {
        study_id,
        variants: new Set(rs.map((r) => tag(r, TAGS.variant) ?? NO_VARIANT)).size,
        runs: rs.length,
        status_counts,
        last_start_time: Math.max(...rs.map((r) => r.info.start_time ?? 0)),
      };
    })
    .sort((a, b) => b.last_start_time - a.last_start_time);
}

export interface VariantView {
  readonly variant_id: string;
  readonly runs: {
    run_id: string;
    run_name?: string;
    status: string;
    start_time?: number;
    attempt_id?: string;
    job_id?: string;
    /** The run's short description (ADR 0048). */
    summary?: string;
  }[];
  readonly metrics: Record<string, MetricStats>;
  /** Parameters equal across every run of the variant. */
  readonly params: Record<string, string>;
  /** Parameters whose value differs between this variant's runs (e.g. seeds). */
  readonly varying_params: string[];
}

export interface StudyView {
  readonly study_id: string;
  readonly variants: VariantView[];
  readonly metric_keys: string[];
  /** Parameters whose (common) value differs between variants: what the study varies. */
  readonly differing_params: string[];
}

export function studyView(studyId: string, runs: readonly MlflowRun[]): StudyView {
  const mine = runs.filter((r) => tag(r, TAGS.study) === studyId);
  const byVariant = new Map<string, MlflowRun[]>();
  for (const r of mine) {
    const v = tag(r, TAGS.variant) ?? NO_VARIANT;
    const list = byVariant.get(v) ?? [];
    list.push(r);
    byVariant.set(v, list);
  }
  const metricKeys = new Set<string>();
  const variants: VariantView[] = [...byVariant.entries()]
    .sort(([a], [b]) => (a === NO_VARIANT ? 1 : b === NO_VARIANT ? -1 : a.localeCompare(b)))
    .map(([variant_id, rs]) => {
      const values = new Map<string, number[]>();
      for (const r of rs)
        for (const m of r.data.metrics ?? []) {
          metricKeys.add(m.key);
          const list = values.get(m.key) ?? [];
          list.push(m.value);
          values.set(m.key, list);
        }
      const metrics: Record<string, MetricStats> = {};
      for (const [k, v] of values) {
        const s = stats(v);
        if (s) metrics[k] = s;
      }
      const paramKeys = new Set(rs.flatMap((r) => (r.data.params ?? []).map((p) => p.key)));
      const params: Record<string, string> = {};
      const varying: string[] = [];
      for (const k of [...paramKeys].sort()) {
        const vals = new Set(rs.map((r) => r.data.params?.find((p) => p.key === k)?.value));
        if (vals.size === 1) {
          const only = [...vals][0];
          if (only !== undefined) params[k] = only;
        } else varying.push(k);
      }
      return {
        variant_id,
        runs: rs
          .map((r) => {
            const att = tag(r, TAGS.attempt);
            const job = tag(r, TAGS.job);
            return {
              run_id: r.info.run_id,
              status: r.info.status,
              ...(r.info.run_name ? { run_name: r.info.run_name } : {}),
              ...(r.info.start_time !== undefined ? { start_time: r.info.start_time } : {}),
              ...(att ? { attempt_id: att } : {}),
              ...(job ? { job_id: job } : {}),
              ...(tag(r, TAGS.summary) ? { summary: tag(r, TAGS.summary) as string } : {}),
            };
          })
          .sort((a, b) => (b.start_time ?? 0) - (a.start_time ?? 0)),
        metrics,
        params,
        varying_params: varying,
      };
    });
  // What the study varies: params whose common value differs between variants. A param that
  // varies inside a variant (a seed) is repetition, not a study dimension.
  const withinVariant = new Set(variants.flatMap((v) => v.varying_params));
  const allParams = new Set(variants.flatMap((v) => Object.keys(v.params)));
  const differing = [...allParams]
    .filter((k) => !withinVariant.has(k))
    .filter((k) => new Set(variants.map((v) => v.params[k] ?? "\u0000")).size > 1)
    .sort();
  return {
    study_id: studyId,
    variants,
    metric_keys: [...metricKeys].sort(),
    differing_params: differing,
  };
}
