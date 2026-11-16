import { describe, expect, test } from "bun:test";
import {
  byTarget,
  dailyHours,
  fmtCents,
  fmtHours,
  inWindow,
  jobUsage,
  totals,
  utilization,
} from "../src/lib/compute.ts";
import type { ComputeTargetView, JobView } from "../src/lib/types.ts";

const H = 3_600_000;
const NOW = Date.parse("2026-11-10T12:00:00.000Z");

function job(id: string, state: string, start?: number, end?: number, target?: string): JobView {
  return {
    job_id: id,
    project_id: "p",
    command: ["python", "train.py"],
    environment: "uv",
    limits: {},
    artifact_paths: [],
    submitted_by: { kind: "human", id: "h" },
    state,
    attempts: [`${id}-a1`],
    created_at: new Date(start ?? NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...(target ? { target_id: target } : {}),
    latest_attempt: {
      attempt_id: `${id}-a1`,
      job_id: id,
      project_id: "p",
      number: 1,
      state,
      created_at: new Date(start ?? NOW).toISOString(),
      ...(start !== undefined ? { started_at: new Date(start).toISOString() } : {}),
      ...(end !== undefined ? { ended_at: new Date(end).toISOString() } : {}),
      supervisor: { mode: "systemd", enforcement: "enforced" },
      collector: {},
      artifacts: [],
      tracking: { ref: `${id}-a1` },
    },
  };
}

const TARGETS: ComputeTargetView[] = [
  {
    target_id: "pod",
    kind: "runpod",
    paid: true,
    available: true,
    runpod: { image: "img", gpu_type_ids: ["A100"], cents_per_hour: 200 },
  },
  { target_id: "pod-norate", kind: "runpod", paid: true, available: true },
  { target_id: "lab", kind: "ssh", paid: false, available: true, ssh: { host: "lab" } },
];

describe("compute usage", () => {
  test("time is the latest attempt's wall time; running attempts count to now", () => {
    const u = jobUsage(
      [
        job("a", "succeeded", NOW - 3 * H, NOW - 1 * H),
        job("b", "running", NOW - 0.5 * H),
        job("c", "queued"),
      ],
      TARGETS,
      NOW,
    );
    expect(u.map((x) => x.ms)).toEqual([2 * H, 0.5 * H, 0]);
    expect(u.map((x) => x.running)).toEqual([false, true, false]);
    expect(u.every((x) => x.target_id === "local" && x.cents === 0 && !x.paid)).toBe(true);
  });

  test("spend is rate card × time; a paid target without a rate is unknown, not free", () => {
    const u = jobUsage(
      [
        job("a", "succeeded", NOW - 3 * H, NOW, "pod"),
        job("b", "succeeded", NOW - 1 * H, NOW, "pod-norate"),
        job("c", "succeeded", NOW - 1 * H, NOW, "lab"),
      ],
      TARGETS,
      NOW,
    );
    expect(u.map((x) => x.cents)).toEqual([600, undefined, 0]);
    const t = byTarget(u);
    expect(t.map((x) => x.target_id)).toEqual(["pod", "lab", "pod-norate"]);
    expect(t.find((x) => x.target_id === "pod-norate")?.unpriced).toBe(1);
    expect(totals(u)).toEqual({ jobs: 3, running: 0, ms: 5 * H, cents: 600, unpriced: 1 });
  });

  test("the window keeps jobs that overlap it and everything running", () => {
    const u = jobUsage(
      [
        job("old", "succeeded", NOW - 10 * 24 * H, NOW - 9 * 24 * H),
        job("recent", "succeeded", NOW - 2 * H, NOW - H),
        job("live", "running", NOW - 30 * 24 * H),
      ],
      TARGETS,
      NOW,
    );
    expect(inWindow(u, NOW - 7 * 24 * H).map((x) => x.job.job_id)).toEqual(["recent", "live"]);
    expect(inWindow(u, undefined)).toHaveLength(3);
  });

  test("daily hours bucket by start day per target", () => {
    const u = jobUsage(
      [job("a", "succeeded", NOW - 2 * H, NOW - H), job("b", "succeeded", NOW - 2 * H, NOW, "pod")],
      TARGETS,
      NOW,
    );
    const d = dailyHours(u, NOW, 3);
    expect(d.map((s) => s.target_id)).toEqual(["local", "pod"]);
    expect(d[0]?.points).toHaveLength(3);
    expect(d[0]?.points.reduce((s, [, y]) => s + y, 0)).toBe(1);
    expect(d[1]?.points.reduce((s, [, y]) => s + y, 0)).toBe(2);
  });
});

describe("utilization", () => {
  const m = (key: string, value: number) => ({ key, value, timestamp: 0, step: 0 });

  test("reads MLflow system metric names and averages GPUs", () => {
    expect(
      utilization([
        m("train/loss", 1),
        m("system/cpu_utilization_percentage", 40),
        m("system/system_memory_usage_percentage", 55),
        m("system/gpu_0_utilization_percentage", 90),
        m("system/gpu_1_utilization_percentage", 70),
        m("system/gpu_0_memory_usage_percentage", 60),
        m("system/gpu_1_memory_usage_percentage", 40),
      ]),
    ).toEqual({ cpu: 40, memory: 55, gpu: 80, gpu_memory: 50, gpus: 2 });
  });

  test("no system metrics, no utilization", () => {
    expect(utilization([m("train/loss", 1)])).toBeUndefined();
    expect(utilization(undefined)).toBeUndefined();
    expect(utilization([m("system/network_receive_megabytes", 3)])).toBeUndefined();
  });

  test("formatting", () => {
    expect(fmtHours(0)).toBe("0 h");
    expect(fmtHours(2 * 60_000)).toBe("2 min");
    expect(fmtHours(1.5 * H)).toBe("1.5 h");
    expect(fmtCents(1234)).toBe("$12");
    expect(fmtCents(250)).toBe("$2.50");
  });
});
