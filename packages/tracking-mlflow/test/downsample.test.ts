import { describe, expect, test } from "bun:test";
import { lttb, type SeriesPoint, sortHistory } from "../src/downsample.ts";

const pt = (step: number, value: number, timestamp = step * 1000): SeriesPoint => ({
  step,
  value,
  timestamp,
});

describe("LTTB downsampling (spec §5.6)", () => {
  test("short series pass through unchanged", () => {
    const s = [pt(0, 1), pt(1, 2), pt(2, 3)];
    expect(lttb(s, 500).points).toEqual(s);
  });

  test("bounds the point count and keeps the endpoints", () => {
    const s = Array.from({ length: 100_000 }, (_, i) => pt(i, Math.sin(i / 500)));
    const out = lttb(s, 500).points;
    expect(out).toHaveLength(500);
    expect(out[0]).toEqual(s[0] as SeriesPoint);
    expect(out.at(-1)).toEqual(s.at(-1) as SeriesPoint);
    // x stays ordered
    for (let i = 1; i < out.length; i++)
      expect((out[i] as SeriesPoint).step).toBeGreaterThan((out[i - 1] as SeriesPoint).step);
  });

  test("a single spike survives downsampling", () => {
    const s = Array.from({ length: 10_000 }, (_, i) => pt(i, i === 6_543 ? 50 : 1));
    const out = lttb(s, 200).points;
    expect(out.some((p) => p.value === 50 && p.step === 6_543)).toBe(true);
  });

  test("returns original points, never interpolated values", () => {
    const s = Array.from({ length: 5000 }, (_, i) => pt(i, Math.random()));
    const set = new Set(s);
    for (const p of lttb(s, 300).points) expect(set.has(p)).toBe(true);
  });

  test("non-finite values are reported, not plotted or dropped silently", () => {
    const s = [pt(0, 1), pt(1, Number.NaN), pt(2, Number.POSITIVE_INFINITY), pt(3, 2)];
    const r = lttb(s, 500);
    expect(r.points.map((p) => p.step)).toEqual([0, 3]);
    expect(r.nonFinite.map((p) => p.step)).toEqual([1, 2]);
  });

  test("x can be wall time", () => {
    const s = Array.from({ length: 1000 }, (_, i) => pt(0, i % 2, i * 10));
    const out = lttb(s, 50, (p) => p.timestamp).points;
    expect(out).toHaveLength(50);
  });

  test("history is ordered by step, then timestamp", () => {
    const sorted = sortHistory([pt(2, 0, 5), pt(1, 0, 9), pt(1, 0, 3)]);
    expect(sorted.map((p) => [p.step, p.timestamp])).toEqual([
      [1, 3],
      [1, 9],
      [2, 5],
    ]);
  });
});
