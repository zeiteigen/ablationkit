/**
 * Cost estimates, provider locality and per-example alignment of LLM variants (spec §5.6.2 item 2,
 * "LLM measurement and privacy rules"; criteria 10a, 10e).
 */

export interface RateLike {
  readonly model: string;
  readonly input_usd_per_mtok: string;
  readonly output_usd_per_mtok: string;
  readonly source: string;
  readonly version: string;
}

export interface UsageLike {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly reported: number;
  readonly missing: number;
}

export interface CostEstimateView {
  estimated_usd: string;
  basis: string;
  rate_source: string;
  rate_version: string;
  partial: boolean;
}

function decimal(n: number): string {
  if (n === 0) return "0";
  const s = n.toFixed(8).replace(/0+$/, "").replace(/[.]$/, "");
  return s === "-0" ? "0" : s;
}

/**
 * An estimate from reported tokens and a configured rate, or undefined: no rate for the model, or
 * no call reported usage. Missing usage is never filled in.
 */
export function estimateCost(
  usage: UsageLike,
  rate: RateLike | undefined,
): CostEstimateView | undefined {
  if (!rate || usage.reported === 0) return undefined;
  if (usage.input_tokens === undefined && usage.output_tokens === undefined) return undefined;
  const i = usage.input_tokens ?? 0;
  const o = usage.output_tokens ?? 0;
  const usd = (i * Number(rate.input_usd_per_mtok) + o * Number(rate.output_usd_per_mtok)) / 1e6;
  if (!Number.isFinite(usd)) return undefined;
  return {
    estimated_usd: decimal(usd),
    basis: `${i} input + ${o} output tokens at ${rate.model} rates (${rate.input_usd_per_mtok} / ${rate.output_usd_per_mtok} USD per million)`,
    rate_source: rate.source,
    rate_version: rate.version,
    partial: usage.missing > 0,
  };
}

/** Loopback hosts are local; everything else is external egress. */
export function providerLocality(baseUrl: string): "local" | "external" {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "external";
  }
  if (host === "localhost" || host === "[::1]" || host === "::1") return "local";
  if (/^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(host)) return "local";
  return "external";
}

export interface ScoreLike {
  readonly value?: unknown;
  readonly rationale?: string;
  readonly error?: string;
}

export interface ExampleResultLike {
  readonly example_id: string;
  readonly trial?: number;
  readonly output?: unknown;
  readonly error?: string;
  readonly trace_id?: string;
  readonly latency_ms?: number;
  readonly scores?: Readonly<Record<string, ScoreLike>>;
  readonly category?: string;
}

/** Pass or fail for boolean and yes/no feedback; undefined for anything else (a score, a label). */
export function passed(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "yes" || s === "pass" || s === "true") return true;
    if (s === "no" || s === "fail" || s === "false") return false;
  }
  return undefined;
}

export interface AlignedRow<E extends ExampleResultLike> {
  example_id: string;
  category: string | undefined;
  cells: Record<string, E | undefined>;
  /** Outputs are not all equal (as JSON). */
  differs: boolean;
  /** Scorers where the baseline (first label) passed and this label failed. */
  regressions: Record<string, string[]>;
  /** Scorers where the baseline failed and this label passed. */
  improvements: Record<string, string[]>;
  failed: boolean;
}

/**
 * Align per-example results of several variants on the same ordered examples (trial 1 only; other
 * trials stay available in the cells' sources). The first label is the baseline.
 */
export function alignExamples<E extends ExampleResultLike>(
  order: readonly string[],
  variants: readonly { label: string; examples: readonly E[] }[],
): AlignedRow<E>[] {
  const maps = variants.map((v) => {
    const m = new Map<string, E>();
    for (const e of v.examples)
      if ((e.trial ?? 1) === 1 && !m.has(e.example_id)) m.set(e.example_id, e);
    return { label: v.label, m };
  });
  const ids = [...order];
  for (const v of maps) for (const id of v.m.keys()) if (!ids.includes(id)) ids.push(id);
  const base = maps[0];
  return ids.map((id) => {
    const cells: Record<string, E | undefined> = {};
    for (const v of maps) cells[v.label] = v.m.get(id);
    const outs = maps.map((v) => JSON.stringify(v.m.get(id)?.output ?? null));
    const regressions: Record<string, string[]> = {};
    const improvements: Record<string, string[]> = {};
    const b = base?.m.get(id);
    let failed = false;
    for (const v of maps) {
      const e = v.m.get(id);
      if (e?.error) failed = true;
      for (const s of Object.values(e?.scores ?? {})) if (passed(s.value) === false) failed = true;
      if (!base || v === base || !b || !e) continue;
      for (const [name, s] of Object.entries(e.scores ?? {})) {
        const pb = passed(b.scores?.[name]?.value);
        const pe = passed(s.value);
        const into =
          pb === true && pe === false
            ? regressions
            : pb === false && pe === true
              ? improvements
              : undefined;
        if (into) into[v.label] = [...(into[v.label] ?? []), name];
      }
    }
    const cat = maps.map((v) => v.m.get(id)?.category).find((c) => c !== undefined);
    return {
      example_id: id,
      category: cat,
      cells,
      differs: new Set(outs).size > 1,
      regressions,
      improvements,
      failed,
    };
  });
}

export function latencySummary(
  ms: readonly number[],
): { mean: number; p50: number; max: number } | undefined {
  const xs = ms.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!xs.length) return undefined;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return {
    mean: Math.round(mean),
    p50: Math.round(xs[Math.floor((xs.length - 1) / 2)] as number),
    max: Math.round(xs.at(-1) as number),
  };
}
