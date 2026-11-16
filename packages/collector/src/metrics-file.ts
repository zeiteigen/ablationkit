/**
 * The metrics-file adapter's line format (ADR 0042), shared by the local collector; the remote
 * worker (`python/ablationkit-worker`) implements the same rules.
 *
 * Each line is a JSON object. Nested objects are flattened, their keys joined with `/`
 * (`{"val": {"bpb": 1.2}}` is `val/bpb`), up to `MAX_DEPTH` levels; arrays, strings, booleans and
 * non-finite numbers are ignored. The step is the first of `step_keys` (flattened names; default
 * `["step"]`) that holds a non-negative integer, else the line's number in the file. The time is
 * `timestamp_key` (default `timestamp`): milliseconds, or seconds when below 1e11 (before 1973 in
 * milliseconds), else the read time. Every other number is a metric; the step and time keys are
 * never metrics.
 */

export interface MetricsFormat {
  /** Keys that hold the step, first match wins; names after flattening. Default `["step"]`. */
  readonly step_keys?: readonly string[];
  /** Key that holds the time (ms, or s below 1e11). Default `timestamp`. */
  readonly timestamp_key?: string;
}

export interface FileMetric {
  readonly key: string;
  readonly value: number;
  readonly step: number;
  readonly timestamp: number;
}

export const MAX_DEPTH = 8;
/** Below this, a time is seconds: 1e11 ms is 1973, 1e11 s is the year 5138. */
const SECONDS_BELOW = 1e11;

/** Numeric leaves of `obj`, keys joined with `/`. */
export function flattenNumbers(obj: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (o: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? `${prefix}/${k}` : k;
      if (typeof v === "number" && Number.isFinite(v)) out.set(key, v);
      else if (v && typeof v === "object" && !Array.isArray(v) && depth < MAX_DEPTH)
        walk(v as Record<string, unknown>, key, depth + 1);
    }
  };
  walk(obj, "", 1);
  return out;
}

/** The metrics one line yields (`lineNo` counts the file's non-blank lines from 1). */
export function metricsFromLine(
  obj: Record<string, unknown>,
  format: MetricsFormat | undefined,
  lineNo: number,
  now: number,
): FileMetric[] {
  const values = flattenNumbers(obj);
  const stepKeys = format?.step_keys?.length ? format.step_keys : ["step"];
  const timeKey = format?.timestamp_key ?? "timestamp";
  let step = lineNo;
  for (const k of stepKeys) {
    const v = values.get(k);
    if (v !== undefined && Number.isSafeInteger(v) && v >= 0) {
      step = v;
      break;
    }
  }
  const t = values.get(timeKey);
  const timestamp =
    t !== undefined && t > 0 ? Math.round(t < SECONDS_BELOW ? t * 1000 : t) : Math.round(now);
  const skip = new Set([...stepKeys, timeKey]);
  return [...values]
    .filter(([k]) => !skip.has(k))
    .map(([key, value]) => ({ key, value, step, timestamp }));
}
