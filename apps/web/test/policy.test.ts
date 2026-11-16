import { describe, expect, test } from "bun:test";
import {
  describeChange,
  fmtWeightedHours,
  meterParts,
  type ProjectPolicy,
  parseWeightInput,
  revisionAuthor,
  revisionBody,
} from "../src/lib/policy.ts";

describe("agent permissions in plain language", () => {
  test("each policy change reads as before → after with what it means for agents", () => {
    expect(
      describeChange({ path: "compute.limit_hours", from: 10, to: 24, effect: "widened" }),
    ).toEqual({
      label: "Compute limit",
      from: "10 weighted hours",
      to: "24 weighted hours",
      effect: "agents may do more",
    });
    expect(
      describeChange({
        path: "jobs.run_local.decision",
        from: "allow",
        to: "deny",
        effect: "reduced",
      }),
    ).toEqual({
      label: "Run jobs on this workstation",
      from: "allowed",
      to: "denied",
      effect: "agents may do less",
    });
    expect(
      describeChange({
        path: "jobs.submit_remote.allowed_targets",
        from: [],
        to: ["gpu", "slurm"],
        effect: "widened",
      }),
    ).toMatchObject({ label: "Remote targets agents may use", from: "none", to: "gpu, slurm" });
    expect(
      describeChange({
        path: "deployments.remote_research.max_runtime_minutes",
        from: undefined,
        to: 60,
        effect: "reduced",
      }),
    ).toMatchObject({
      label: "Start remote research endpoints: max runtime minutes",
      from: "not set",
      to: "60",
    });
  });

  test("who wrote a revision; the editable body leaves the metadata to the coordinator", () => {
    expect(revisionAuthor("system:default")).toBe("the built-in default");
    expect(revisionAuthor("human:0123456789abcdef")).toBe("the researcher (session 01234567)");
    const p: ProjectPolicy = {
      schema_version: 2,
      project_id: "lab",
      revision: 3,
      created_at: "2026-11-10T00:00:00Z",
      created_by: "human:x",
      jobs: {
        run_local: { decision: "allow" },
        submit_remote: { decision: "deny", allowed_targets: [] },
      },
      deployments: {
        preview_local: { decision: "allow" },
        remote_research: { decision: "deny" },
        persistent: { decision: "deny" },
        public: { decision: "deny" },
      },
      compute: { limit_hours: 10 },
    };
    expect(Object.keys(revisionBody(p)).sort()).toEqual(["compute", "deployments", "jobs"]);
  });
});

describe("usage meter and weights", () => {
  test("used and reserved as shares of the limit, never past 100%", () => {
    expect(meterParts(2, 3, 10)).toEqual({ used: 20, reserved: 30, full: false });
    expect(meterParts(8, 2, 10)).toEqual({ used: 80, reserved: 20, full: true });
    expect(meterParts(12, 1, 10)).toEqual({ used: 100, reserved: 0, full: true });
    expect(meterParts(0, 0, 0)).toEqual({ used: 0, reserved: 0, full: true });
  });

  test("a weight is a positive number with at most two decimals", () => {
    expect(parseWeightInput("1")).toBe(1);
    expect(parseWeightInput(" 0.5 ")).toBe(0.5);
    expect(parseWeightInput("3")).toBe(3);
    expect(parseWeightInput(".25")).toBe(0.25);
    for (const bad of ["0", "-1", "1.234", "abc", "", "1001", "1e2"])
      expect(typeof parseWeightInput(bad)).toBe("object");
    expect(fmtWeightedHours(0)).toBe("0");
    expect(fmtWeightedHours(1.26)).toBe("1.3");
    expect(fmtWeightedHours(0.04)).toBe("0.04");
    expect(fmtWeightedHours(12.6)).toBe("13");
  });
});
