import type { RunSummary } from "@ablationkit/extension-sdk";

/** Metric keys every run has, sorted. */
export function sharedMetrics(runs: readonly RunSummary[]): string[] {
  if (!runs.length) return [];
  const first = Object.keys(runs[0]?.metrics ?? {});
  return first.filter((k) => runs.every((r) => k in r.metrics)).sort();
}
