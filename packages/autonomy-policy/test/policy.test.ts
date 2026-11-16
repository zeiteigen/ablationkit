import { describe, expect, test } from "bun:test";
import { type ProjectActionPolicy, validateProjectActionPolicy } from "@ablationkit/protocol";
import {
  DEFAULT_COMPUTE_LIMIT_HOURS,
  decide,
  defaultPolicy,
  diffPolicies,
  isPinnedModelUri,
  migratePolicyV1,
  validatePolicy,
} from "../src/index.ts";

const P = "lab";
const base = () => defaultPolicy(P, "2026-11-03T00:00:00Z");
const open = (): ProjectActionPolicy => ({
  ...base(),
  revision: 3,
  jobs: {
    run_local: { decision: "allow" },
    submit_remote: { decision: "allow", allowed_targets: ["slurm", "gpu-a100"] },
  },
  deployments: {
    preview_local: { decision: "allow", exposure: "loopback", max_runtime_minutes: 30 },
    remote_research: { decision: "allow", allowed_targets: ["runpod"], max_runtime_minutes: 120 },
    persistent: { decision: "deny" },
    public: { decision: "deny" },
  },
  compute: { limit_hours: 40 },
});

/** A version 1 revision as Stage 18 wrote it (every gate the old schema had). */
const V1 = {
  schema_version: 1,
  project_id: P,
  revision: 4,
  created_at: "2026-11-03T10:00:00Z",
  created_by: "human:tok-1",
  summary: "allow agent commits",
  defaults: { decision: "deny" },
  experiments: {
    edit: { decision: "allow", paths: ["src/**"], only_isolated_worktrees: true },
    test: { decision: "allow", max_wall_minutes: 20 },
    run_local: { decision: "allow", max_parallel: 2 },
    submit_remote: { decision: "ask", allowed_targets: ["runpod"], max_gpu_hours: 8 },
  },
  network: { decision: "deny", allowed_domains: [] },
  denied_commands: ["curl"],
  git: {
    branch_create: { decision: "allow", ref_prefix: "refs/heads/agent/" },
    commit: { decision: "allow", refs: ["refs/heads/agent/*"], require_secret_scan: true },
    push: { decision: "ask", remote: "origin", refs: ["refs/heads/agent/*"], force: false },
    merge: { decision: "ask", target_refs: ["refs/heads/main"], required_checks: ["tests"] },
  },
  checks: { tests: { argv: ["python", "-m", "pytest", "-q"], timeout_sec: 600 } },
  protected_evaluation: { paths: ["eval/**"], host_paths: [] },
  deployments: {
    preview_local: { decision: "allow", exposure: "loopback", idle_timeout_minutes: 30 },
    remote_research: { decision: "ask", allowed_targets: ["runpod"], max_runtime_minutes: 120 },
    persistent: { decision: "deny" },
    public: { decision: "ask" },
  },
};

describe("defaults", () => {
  test("a new project: local jobs and a loopback preview allowed, the rest denied, 10 hours", () => {
    const p = validateProjectActionPolicy(base());
    expect(p.jobs.run_local.decision).toBe("allow");
    expect(p.jobs.submit_remote).toEqual({ decision: "deny", allowed_targets: [] });
    expect(p.deployments.preview_local.decision).toBe("allow");
    expect(p.deployments.remote_research.decision).toBe("deny");
    expect(p.deployments.persistent.decision).toBe("deny");
    expect(p.deployments.public.decision).toBe("deny");
    expect(p.compute.limit_hours).toBe(DEFAULT_COMPUTE_LIMIT_HOURS);
    expect(DEFAULT_COMPUTE_LIMIT_HOURS).toBe(10);
    expect(validatePolicy(p, P)).toEqual([]);
  });
});

describe("migration of version 1 revisions", () => {
  test("ask becomes deny, experiments become jobs, dropped gates go, compute gets its default", () => {
    const p = validateProjectActionPolicy(migratePolicyV1(V1));
    expect(p.schema_version).toBe(2);
    expect(p.revision).toBe(4);
    expect(p.created_by).toBe("human:tok-1");
    expect(p.summary).toBe("allow agent commits");
    expect(p.jobs.run_local).toEqual({ decision: "allow" });
    // `ask` needed an approval, which no longer exists: conservative.
    expect(p.jobs.submit_remote).toEqual({ decision: "deny", allowed_targets: ["runpod"] });
    expect(p.deployments.preview_local).toEqual({
      decision: "allow",
      exposure: "loopback",
      max_runtime_minutes: 30,
    });
    expect(p.deployments.remote_research).toEqual({
      decision: "deny",
      allowed_targets: ["runpod"],
      max_runtime_minutes: 120,
    });
    expect(p.deployments.public.decision).toBe("deny");
    expect(p.compute).toEqual({ limit_hours: DEFAULT_COMPUTE_LIMIT_HOURS });
    const keys = Object.keys(p);
    for (const gone of [
      "experiments",
      "git",
      "checks",
      "network",
      "denied_commands",
      "protected_evaluation",
      "defaults",
    ])
      expect(keys).not.toContain(gone);
    expect(validatePolicy(p, P)).toEqual([]);
  });

  test("a minimal or partly missing version 1 document still migrates to a valid deny-first policy", () => {
    const p = validateProjectActionPolicy(
      migratePolicyV1({
        schema_version: 1,
        project_id: P,
        revision: 1,
        created_at: "2026-11-03T10:00:00Z",
        created_by: "human:x",
        experiments: { run_local: { decision: "ask" } },
        deployments: {},
      }),
    );
    expect(p.jobs.run_local.decision).toBe("deny");
    expect(p.jobs.submit_remote).toEqual({ decision: "deny", allowed_targets: [] });
    for (const g of Object.values(p.deployments)) expect(g.decision).toBe("deny");
  });
});

describe("validation (criterion 33: unsupported enforcement fails closed)", () => {
  test("refuses what cannot be enforced", () => {
    const p = open();
    expect(validatePolicy(p, P)).toEqual([]);
    expect(validatePolicy(p, "other")[0]).toContain("project_id");
    const bad: ProjectActionPolicy = {
      ...p,
      jobs: { ...p.jobs, submit_remote: { decision: "allow", allowed_targets: ["Bad Target"] } },
      deployments: {
        ...p.deployments,
        preview_local: { decision: "allow", exposure: "tailnet" },
        public: { decision: "allow" },
      },
    };
    const errs = validatePolicy(bad, P).join("\n");
    expect(errs).toContain("jobs.submit_remote.allowed_targets: Bad Target");
    expect(errs).toContain("loopback only");
    expect(errs).toContain("deployments.public");
    expect(
      validatePolicy(
        {
          ...p,
          jobs: { ...p.jobs, submit_remote: { decision: "allow", allowed_targets: ["local"] } },
        },
        P,
      )[0],
    ).toContain("local is jobs.run_local");
  });

  test("the schema refuses ask, a negative limit and old gates", () => {
    const p = base() as unknown as Record<string, unknown>;
    expect(() =>
      validateProjectActionPolicy({
        ...p,
        jobs: { ...open().jobs, run_local: { decision: "ask" } },
      }),
    ).toThrow();
    expect(() => validateProjectActionPolicy({ ...p, compute: { limit_hours: -1 } })).toThrow();
    expect(() => validateProjectActionPolicy({ ...p, network: { decision: "deny" } })).toThrow();
  });
});

describe("decisions", () => {
  test("local jobs follow jobs.run_local", () => {
    expect(decide(base(), "jobs.run_local").decision).toBe("allow");
    const denied = decide(
      { ...base(), jobs: { ...base().jobs, run_local: { decision: "deny" } } },
      "jobs.run_local",
    );
    expect(denied.decision).toBe("deny");
    expect(denied.reasons[0]).toContain("jobs.run_local.decision");
  });

  test("remote jobs need allow and an allowed target (by ID or kind)", () => {
    const d = decide(base(), "jobs.submit_remote", { target: "gpu-a100", targetKind: "ssh" });
    expect(d.decision).toBe("deny");
    expect(d.reasons[0]).toContain("jobs.submit_remote.decision to deny");
    const p = open();
    expect(
      decide(p, "jobs.submit_remote", { target: "gpu-a100", targetKind: "ssh" }).decision,
    ).toBe("allow");
    expect(decide(p, "jobs.submit_remote", { target: "hpc", targetKind: "slurm" }).decision).toBe(
      "allow",
    );
    const other = decide(p, "jobs.submit_remote", { target: "pod1", targetKind: "runpod" });
    expect(other.decision).toBe("deny");
    expect(other.reasons[0]).toContain("not in jobs.submit_remote.allowed_targets");
    expect(decide(p, "jobs.submit_remote", { target: "local" }).decision).toBe("deny");
  });

  test("deployments: decision, exposure, targets and the runtime cap", () => {
    const p = open();
    expect(
      decide(p, "deployments.preview_local", { exposure: "loopback", minutes: 30 }).decision,
    ).toBe("allow");
    expect(
      decide(p, "deployments.preview_local", { exposure: "tailnet", minutes: 5 }).reasons.join(),
    ).toContain("loopback only");
    expect(decide(p, "deployments.preview_local", { minutes: 31 }).reasons.join()).toContain(
      "max_runtime_minutes",
    );
    expect(
      decide(p, "deployments.remote_research", {
        target: "pod1",
        targetKind: "runpod",
        minutes: 60,
      }).decision,
    ).toBe("allow");
    expect(
      decide(p, "deployments.remote_research", { target: "hpc", targetKind: "slurm" }).decision,
    ).toBe("deny");
    const persistent = decide(p, "deployments.persistent");
    expect(persistent.decision).toBe("deny");
    expect(persistent.reasons[0]).toContain("deployments.persistent.decision");
    expect(decide(base(), "deployments.remote_research").decision).toBe("deny");
  });
});

describe("diffs", () => {
  test("decisions, targets and limits are widened or reduced", () => {
    const changes = diffPolicies(base(), open());
    const by = (path: string) => changes.find((c) => c.path === path);
    expect(by("jobs.submit_remote.decision")?.effect).toBe("widened");
    expect(by("jobs.submit_remote.allowed_targets")?.effect).toBe("widened");
    expect(by("compute.limit_hours")).toMatchObject({ from: 10, to: 40, effect: "widened" });
    expect(by("deployments.preview_local.max_runtime_minutes")?.effect).toBe("reduced");
    const back = diffPolicies(open(), base());
    expect(back.find((c) => c.path === "jobs.submit_remote.decision")?.effect).toBe("reduced");
    expect(back.find((c) => c.path === "compute.limit_hours")?.effect).toBe("reduced");
    expect(diffPolicies(open(), open())).toEqual([]);
  });
});

test("deployments pin an exact model version", () => {
  expect(isPinnedModelUri("models:/width/3")).toBe(true);
  expect(isPinnedModelUri("runs:/0123abcd0123abcd/model")).toBe(true);
  expect(isPinnedModelUri("models:/width@champion")).toBe(false);
  expect(isPinnedModelUri("models:/width/latest")).toBe(false);
  expect(isPinnedModelUri("models:/width/Production")).toBe(false);
});
