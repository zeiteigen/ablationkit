import { describe, expect, test } from "bun:test";
import {
  admit,
  computeUsage,
  defaultSlots,
  parseWeight,
  roundHours,
  weightValue,
} from "../src/index.ts";

const T0 = Date.parse("2026-11-10T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

describe("weights", () => {
  test("decimals become hundredths; zero, negatives, three decimals and huge weights are refused", () => {
    expect(parseWeight(1)).toBe(100);
    expect(parseWeight(0.5)).toBe(50);
    expect(parseWeight("3")).toBe(300);
    expect(parseWeight(1.25)).toBe(125);
    expect(parseWeight(0.07)).toBe(7);
    expect(weightValue(150)).toBe(1.5);
    for (const bad of [0, -1, 0.001, 1.234, 1001, "x", "", null, Number.NaN])
      expect(() => parseWeight(bad)).toThrow();
  });
});

describe("usage", () => {
  test("every attempt counts (retries too) at the job's recorded weight; live attempts reserve the rest of their time limit", () => {
    const u = computeUsage(
      [
        {
          weight_hundredths: 300,
          runtime_max_sec: 7200,
          attempts: [
            { state: "failed", started_at: at(0), ended_at: at(30) }, // 0.5 h × 3
            { state: "succeeded", started_at: at(40), ended_at: at(100) }, // 1 h × 3
          ],
        },
        {
          weight_hundredths: 50,
          runtime_max_sec: 3600,
          attempts: [{ state: "running", started_at: at(60) }], // 1 h so far × 0.5, 0 left
        },
        {
          runtime_max_sec: 1800, // a pre-limit job without a weight counts 1
          attempts: [{ state: "running", started_at: at(110) }], // 10 min, 20 min left
        },
        {
          weight_hundredths: 200,
          runtime_max_sec: 3600,
          attempts: [{ state: "starting" }], // a remote attempt not started yet: all reserved
        },
      ],
      T0 + 120 * 60_000,
    );
    expect(roundHours(u.used_hours)).toBe(roundHours(1.5 + 3 + 0.5 + 10 / 60));
    expect(roundHours(u.reserved_hours)).toBe(roundHours(20 / 60 + 2));
    expect(u).toMatchObject({ jobs: 4, attempts: 5, live: 3 });
  });

  test("an attempt that never started, or ended before it started, uses nothing", () => {
    const u = computeUsage(
      [
        {
          weight_hundredths: 100,
          runtime_max_sec: 60,
          attempts: [
            { state: "failed", ended_at: at(1) },
            { state: "unknown", started_at: at(5), ended_at: at(4) },
          ],
        },
      ],
      T0,
    );
    expect(u.used_hours).toBe(0);
    expect(u.reserved_hours).toBe(0);
  });
});

describe("admission", () => {
  test("used + reserved + time limit × weight must fit under the limit; exactly the limit fits", () => {
    expect(admit({ used_hours: 8, reserved_hours: 1 }, 10, 3600, 100)).toEqual({
      ok: true,
      needed_hours: 1,
      available_hours: 1,
    });
    const no = admit({ used_hours: 8, reserved_hours: 1 }, 10, 1800, 300);
    expect(no.ok).toBe(false);
    expect(no.needed_hours).toBe(1.5);
    expect(admit({ used_hours: 0, reserved_hours: 0 }, 10, 36_000, 100).ok).toBe(true);
    expect(admit({ used_hours: 0, reserved_hours: 0 }, 0, 1, 100).ok).toBe(false);
    expect(admit({ used_hours: 12, reserved_hours: 0 }, 10, 1, 1).available_hours).toBe(0);
  });
});

describe("the queue (ADR 0068)", () => {
  test("a queued job holds its whole time limit at its weight; a Colab target has two slots", () => {
    const u = computeUsage(
      [
        { weight_hundredths: 300, runtime_max_sec: 3600, attempts: [], queued: true },
        { weight_hundredths: 100, runtime_max_sec: 3600, attempts: [] },
      ],
      Date.parse("2026-11-17T12:00:00Z"),
    );
    expect(u.reserved_hours).toBe(3);
    expect(u.used_hours).toBe(0);
    expect(defaultSlots("local")).toBe(1);
    expect(defaultSlots("colab")).toBe(2);
    expect(defaultSlots("ssh")).toBe(1);
  });
});
