/** Display helpers. Pure, so they are unit-tested under `bun test`. */

export function fmtNum(v: unknown, digits = 4): string {
  if (typeof v !== "number") return v === undefined || v === null ? "—" : String(v);
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e12) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(digits - 1);
  return Number(v.toPrecision(digits)).toString();
}

export function fmtBytes(n: number | undefined): string {
  if (n === undefined) return "—";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

export function fmtTime(ms: number | string | undefined): string {
  if (ms === undefined || ms === "") return "—";
  const d = new Date(typeof ms === "string" && /^\d+$/.test(ms) ? Number(ms) : ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** A date for a table cell: "Nov 13, 03:59", with the year only when it is not this year. */
export function fmtShortTime(ms: number | string | undefined, now = Date.now()): string {
  if (ms === undefined || ms === "") return "—";
  const d = new Date(typeof ms === "string" && /^\d+$/.test(ms) ? Number(ms) : ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function shortId(id: string | undefined, n = 8): string {
  if (!id) return "—";
  return id.length > n + 2 ? id.slice(0, n) : id;
}

/** Metric deltas for ablation tables: absolute and relative to the baseline. */
export function delta(
  value: number | undefined,
  baseline: number | undefined,
): { abs: number; rel: number | undefined } | undefined {
  if (value === undefined || baseline === undefined) return undefined;
  const abs = value - baseline;
  return { abs, rel: baseline === 0 ? undefined : abs / Math.abs(baseline) };
}

export function fmtDelta(d: { abs: number; rel: number | undefined } | undefined): string {
  if (!d) return "";
  const sign = d.abs > 0 ? "+" : "";
  const rel = d.rel === undefined ? "" : ` (${sign}${(d.rel * 100).toFixed(1)}%)`;
  return `${sign}${fmtNum(d.abs, 3)}${rel}`;
}

/** File names that load code when opened: show a trust warning before download (spec §5.6). */
const UNSAFE_MODEL_EXT = /\.(pkl|pickle|pt|pth|joblib|ckpt|bin|npy|npz|h5|keras|sav|dill)$/i;
export function isUnsafeModelFormat(path: string): boolean {
  return UNSAFE_MODEL_EXT.test(path);
}

/** What the preview pane may render, decided by the coordinator's content type, never by sniffing. */
export type PreviewKind = "text" | "json" | "image" | "none";
export function previewKind(contentType: string | null, size: number | undefined): PreviewKind {
  const t = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (size !== undefined && size > PREVIEW_MAX_BYTES) return "none";
  if (t === "application/json") return "json";
  if (t === "text/plain") return "text";
  if (t === "image/png" || t === "image/jpeg" || t === "image/gif") return "image";
  return "none";
}
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** Pick a stable color for series index `i` (categorical palette, light and dark safe). */
export const SERIES_COLORS = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#9333ea",
  "#ea580c",
];
export function seriesColor(i: number): string {
  return SERIES_COLORS[i % SERIES_COLORS.length] as string;
}

const LIVE_ATTEMPT = new Set(["queued", "starting", "running"]);

/** Compute status for a badge: an exported notebook waits on a person, not on a scheduler. */
export function computeLabel(
  state: string,
  remote?: { staging: string; overdue_at?: string; marked_lost_at?: string },
): string {
  if (remote?.staging === "exported" && LIVE_ATTEMPT.has(state) && remote.overdue_at)
    return "overdue (not reported back)";
  if (state === "unknown" && remote?.marked_lost_at) return "lost (marked)";
  return state === "starting" && remote?.staging === "exported"
    ? "waiting for you to run the notebook"
    : state;
}

/** Worker status: an imported spool means the worker ran offline and reported by archive. */
export function workerLabel(
  state: string,
  remote: { connectivity: string; imported_at?: string },
): string {
  if (!remote.imported_at) return remote.connectivity;
  return LIVE_ATTEMPT.has(state) ? "offline (partial import)" : "exited (imported)";
}

/**
 * When an exported (Colab) attempt should be back: its export time plus the job's time limit.
 * Colab gives no signal of its own, so this is an expectation, not a deadline anything enforces.
 */
export function expectedBackBy(
  exportedAt: string | undefined,
  runtimeMaxSec: number | undefined,
): string | undefined {
  const t = exportedAt ? Date.parse(exportedAt) : Number.NaN;
  if (!Number.isFinite(t) || !runtimeMaxSec || runtimeMaxSec <= 0) return undefined;
  return new Date(t + runtimeMaxSec * 1000).toISOString();
}

/**
 * Compute units a Colab runtime used (ADR 0059): its measured rate × the hours from allocation to
 * release (or `now` while it is held). An estimate: Colab reports the rate for the whole account.
 */
export function computeUnitsUsed(
  cu: { per_hour_hundredths: number; allocated_at: string; released_at?: string },
  now: number = Date.now(),
): number {
  const end = cu.released_at ? Date.parse(cu.released_at) : now;
  const hours = Math.max(0, end - Date.parse(cu.allocated_at)) / 3_600_000;
  return (cu.per_hour_hundredths / 100) * hours;
}

/** "1.94 CU/h · 0.42 CU used" (or "free runtime" at 0 CU/h). */
export function fmtComputeUnits(cu: {
  per_hour_hundredths: number;
  allocated_at: string;
  released_at?: string;
}): string {
  if (cu.per_hour_hundredths === 0) return "free runtime (0 compute units per hour)";
  const used = computeUnitsUsed(cu);
  return `${(cu.per_hour_hundredths / 100).toFixed(2)} compute units/h · ${used.toFixed(2)} used${cu.released_at ? "" : " so far (runtime held)"}`;
}
