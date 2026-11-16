/**
 * Visualization downsampling (spec §5.6: "large metric histories are downsampled for
 * visualization without altering canonical MLflow data"). Largest-Triangle-Three-Buckets keeps
 * the first and last points and, per bucket, the point that best preserves the curve's shape, so
 * spikes and divergences survive. The canonical history stays available unmodified (JSON/CSV).
 */

export interface SeriesPoint {
  readonly step: number;
  readonly timestamp: number;
  readonly value: number;
}

/** Order a raw history by step, then timestamp (MLflow returns pages in no guaranteed order). */
export function sortHistory<T extends SeriesPoint>(points: readonly T[]): T[] {
  return [...points].sort((a, b) => a.step - b.step || a.timestamp - b.timestamp);
}

/**
 * LTTB over x = `x(point)`, y = value. Non-finite values (NaN, ±Inf, which MLflow can store) are
 * kept out of the triangle math but never silently dropped: the caller gets them back in
 * `nonFinite` so a chart can mark them.
 */
export function lttb<T extends SeriesPoint>(
  points: readonly T[],
  threshold: number,
  x: (p: T) => number = (p) => p.step,
): { points: T[]; nonFinite: T[] } {
  const finite = points.filter((p) => Number.isFinite(p.value));
  const nonFinite = points.filter((p) => !Number.isFinite(p.value));
  const n = finite.length;
  if (threshold >= n || threshold < 3) return { points: finite.slice(), nonFinite };

  const out: T[] = [finite[0] as T];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    // Average of the next bucket: the third triangle vertex.
    const nextStart = Math.floor((i + 1) * every) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    const len = Math.max(nextEnd - nextStart, 1);
    for (let j = nextStart; j < nextEnd; j++) {
      const p = finite[j] as T;
      avgX += x(p);
      avgY += p.value;
    }
    avgX /= len;
    avgY /= len;

    const start = Math.floor(i * every) + 1;
    const end = Math.floor((i + 1) * every) + 1;
    const pa = finite[a] as T;
    const ax = x(pa);
    const ay = pa.value;
    let maxArea = -1;
    let pick = start;
    for (let j = start; j < end; j++) {
      const p = finite[j] as T;
      const area = Math.abs((ax - avgX) * (p.value - ay) - (ax - x(p)) * (avgY - ay));
      if (area > maxArea) {
        maxArea = area;
        pick = j;
      }
    }
    out.push(finite[pick] as T);
    a = pick;
  }
  out.push(finite[n - 1] as T);
  return { points: out, nonFinite };
}
