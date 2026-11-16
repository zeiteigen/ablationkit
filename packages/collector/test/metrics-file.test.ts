/** The metrics-file line format (ADR 0042): flattening, step keys, time keys. */
import { describe, expect, test } from "bun:test";
import { flattenNumbers, metricsFromLine } from "../src/metrics-file.ts";

const NOW = 1_800_000_000_000;

describe("metrics file lines", () => {
  test("the default format: step and timestamp keys, other numbers are metrics", () => {
    expect(
      metricsFromLine({ step: 3, timestamp: 1_700_000_000_000, loss: 0.4, tag: "x" }, {}, 9, NOW),
    ).toEqual([{ key: "loss", value: 0.4, step: 3, timestamp: 1_700_000_000_000 }]);
    // No step: the line number; no time: the read time.
    expect(metricsFromLine({ loss: 0.4 }, undefined, 9, NOW)).toEqual([
      { key: "loss", value: 0.4, step: 9, timestamp: NOW },
    ]);
  });

  test("nested objects flatten with /; arrays, strings, booleans are ignored", () => {
    expect([
      ...flattenNumbers({ a: 1, val: { bpb: 1.2, inner: { n: 2 } }, xs: [1, 2], ok: true, s: "1" }),
    ]).toEqual([
      ["a", 1],
      ["val/bpb", 1.2],
      ["val/inner/n", 2],
    ]);
  });

  test("step keys: the first that holds a non-negative integer, names after flattening", () => {
    const format = { step_keys: ["global_step", "validation/global_step"], timestamp_key: "time" };
    // A training event (fraise's events file).
    expect(
      metricsFromLine(
        { time: 1_731_000_000.5, type: "progress", global_step: 40, loss: 3.1 },
        format,
        2,
        NOW,
      ),
    ).toEqual([{ key: "loss", value: 3.1, step: 40, timestamp: 1_731_000_000_500 }]);
    // A validation event: the step is nested; neither step key is a metric.
    expect(
      metricsFromLine(
        { time: 1_731_000_100, type: "validation", validation: { global_step: 40, bpb: 1.21 } },
        format,
        3,
        NOW,
      ),
    ).toEqual([{ key: "validation/bpb", value: 1.21, step: 40, timestamp: 1_731_000_100_000 }]);
    // A negative or fractional step falls back to the line number.
    expect(metricsFromLine({ global_step: -1, loss: 1 }, format, 7, NOW)[0]?.step).toBe(7);
    expect(metricsFromLine({ global_step: 1.5, loss: 1 }, format, 7, NOW)[0]?.step).toBe(7);
  });

  test("a line with only step and time yields nothing", () => {
    expect(metricsFromLine({ step: 1, timestamp: 5 }, {}, 1, NOW)).toEqual([]);
  });
});
