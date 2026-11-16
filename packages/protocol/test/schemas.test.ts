import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../scripts/generate.ts";
import {
  compileValidator,
  ProtocolValidationError,
  SCHEMAS,
  validateAuditRecord,
  validateCoordinatorSettings,
  validateDeploymentRecord,
  validateExtensionState,
  validateJobRecord,
  validateResearchRecord,
  validateResearchTask,
  validateTokenStore,
} from "../src/index.ts";
import { loadFixtures, REPO_ROOT } from "./fixtures.ts";

describe.each(loadFixtures())("$entry.name fixtures", ({ entry, valid, invalid }) => {
  const validate = compileValidator(entry.schema);

  test.each(valid.map((v, i) => [i, v] as const))("valid #%d passes", (_i, value) => {
    expect(validate(value) as unknown).toBe(value);
  });

  test.each(invalid.map((c) => [c.reason, c.value] as const))("rejects: %s", (_reason, value) => {
    expect(() => validate(value)).toThrow(ProtocolValidationError);
  });
});

test("every registered schema has fixtures with at least one valid and one invalid case", () => {
  const fixtures = loadFixtures();
  expect(fixtures.length).toBe(SCHEMAS.length);
  for (const f of fixtures) {
    expect(f.valid.length).toBeGreaterThan(0);
    expect(f.invalid.length).toBeGreaterThan(0);
  }
});

test("generated JSON Schema, Python models and docs are deterministic", () => {
  const a = generate();
  const b = generate();
  expect([...a.entries()]).toEqual([...b.entries()]);
});

test("stored records written before campaigns were removed still load, without them (ADR 0037)", () => {
  const fixtures = loadFixtures();
  const valid = (name: string) => fixtures.find((f) => f.entry.name === name)?.valid[0];
  const job = valid("JobRecord") as Record<string, unknown>;
  const entry = SCHEMAS.find((s) => s.name === "JobRecord");
  if (!entry) throw new Error("JobRecord is not registered");
  const strict = compileValidator(entry.schema);
  expect(() => strict({ ...job, campaign_id: "camp-1" })).toThrow(ProtocolValidationError);
  expect(validateJobRecord({ ...job, campaign_id: "camp-1" }) as unknown).toEqual(job);
  const record = valid("ResearchRecord") as { links: unknown[] };
  const linked = validateResearchRecord({
    ...record,
    links: [...record.links, { kind: "campaign", id: "camp-1" }],
  });
  expect(linked.links).toEqual(record.links as typeof linked.links);
  // Anything else that is wrong is still refused.
  expect(() => validateJobRecord({ ...job, campaign_id: "camp-1", bogus: 1 })).toThrow(
    ProtocolValidationError,
  );
});

test("stored records written before Git management, workspaces and approvals were removed still load (ADR 0037)", () => {
  const fixtures = loadFixtures();
  const valid = (name: string) => fixtures.find((f) => f.entry.name === name)?.valid[0];
  const job = valid("JobRecord") as Record<string, unknown>;
  expect(
    validateJobRecord({
      ...job,
      candidate_id: "cand-20261103-abc123",
      protocol: { commit: "a".repeat(40), paths: ["eval/**"] },
    }) as unknown,
  ).toEqual(job);
  const record = valid("ResearchRecord") as { links: unknown[] };
  expect(
    validateResearchRecord({
      ...record,
      links: [...record.links, { kind: "candidate", id: "cand-20261103-abc123" }],
    }).links,
  ).toEqual(record.links as never);
  // The Git broker's settings block.
  const settings = valid("CoordinatorSettings") as Record<string, unknown>;
  const withBroker = { ...settings, git: { github_token_env: "GH" } };
  expect(validateCoordinatorSettings(withBroker) as unknown).toEqual(settings);
  const dep = valid("DeploymentRecord") as Record<string, unknown>;
  const waiting = validateDeploymentRecord({
    ...dep,
    status: "pending_approval",
    approval_id: "appr-1",
  });
  expect(waiting.status).toBe("invalidated");
  expect((waiting as Record<string, unknown>)["approval_id"]).toBeUndefined();
  expect(validateDeploymentRecord({ ...dep, status: "rejected" }).status).toBe("invalidated");
});

test("stored records written before passkeys were removed still load (ADR 0037)", () => {
  const fixtures = loadFixtures();
  const valid = (name: string, i = 0) => fixtures.find((f) => f.entry.name === name)?.valid[i];
  const audit = valid("AuditRecord", 1) as Record<string, unknown>;
  expect(validateAuditRecord({ ...audit, step_up: true }) as unknown).toEqual(audit);
  const settings = valid("CoordinatorSettings", 1) as { trusted_origins: { origin: string }[] };
  const withRpIds = {
    ...settings,
    trusted_origins: settings.trusted_origins.map((o) => ({
      ...o,
      rp_id: new URL(o.origin).hostname,
    })),
  };
  expect(validateCoordinatorSettings(withRpIds) as unknown).toEqual(settings);
  const state = valid("ExtensionState") as { approvals: Record<string, unknown>[] };
  const approved = { ...state, approvals: state.approvals.map((a) => ({ ...a, step_up: true })) };
  expect(validateExtensionState(approved) as unknown).toEqual(state);
});

describe("stored records written before T3 orchestration was removed still load (ADR 0039)", () => {
  const fixtures = loadFixtures();
  const valid = (name: string, i = 0) => fixtures.find((f) => f.entry.name === name)?.valid[i];
  const legacy = () =>
    JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/protocol/test/legacy/research-task.v1.json"), "utf8"),
    ) as Record<string, unknown>;

  test("a dispatched task becomes an open, lean task without its sessions, plan or package", () => {
    const old = { ...legacy(), campaign_id: "camp-1" };
    const t = validateResearchTask(old);
    expect(t).toEqual({
      schema_version: 2,
      task_id: "task-20261103-abc123",
      project_id: "custom-architecture-lab",
      revision: 3,
      created_by: { kind: "human", id: "tok-1" },
      created_at: "2026-11-03T10:00:00Z",
      updated_at: "2026-11-03T10:05:00Z",
      title: "Ablate rotary embeddings",
      goal: "Measure the effect of removing rotary embeddings on validation loss.",
      criteria: ["val_loss compared over 3 seeds"],
      status: "open",
    });
  });

  test("completed keeps its outcome and report; failed and canceled become abandoned", () => {
    const by = { kind: "human", id: "tok-1", task_id: "task-20261103-abc123" };
    const completed = validateResearchTask({
      ...legacy(),
      status: "completed",
      scientific_status: "supported",
      result_report_id: "rep-1",
      completion: {
        outcome: "supported",
        report_id: "rep-1",
        criteria: [],
        at: "2026-11-03T12:00:00Z",
        by,
      },
    });
    expect(completed).toMatchObject({
      status: "completed",
      outcome: "supported",
      report_id: "rep-1",
      closed_at: "2026-11-03T12:00:00Z",
      closed_by: { kind: "human", id: "tok-1" },
    });
    for (const status of ["failed", "canceled"]) {
      const t = validateResearchTask({
        ...legacy(),
        status,
        status_reason: "stopped",
        history: [{ at: "2026-11-03T11:00:00Z", from_status: "active", to_status: status, by }],
      });
      expect(t).toMatchObject({
        status: "abandoned",
        reason: "stopped",
        closed_at: "2026-11-03T11:00:00Z",
        closed_by: { kind: "human", id: "tok-1" },
      });
      expect(t.outcome).toBeUndefined();
    }
  });

  test("a task-bound agent token loads bound to its project", () => {
    const store = valid("TokenStore") as { tokens: { scope: Record<string, unknown> }[] };
    const old = {
      ...store,
      tokens: store.tokens.map((t, i) =>
        i === 0 ? { ...t, scope: { ...t.scope, task_id: "task-1" } } : t,
      ),
    };
    expect(validateTokenStore(old) as unknown).toEqual(store);
  });

  test("a record an agent wrote under its token's task links the task instead", () => {
    const record = valid("ResearchRecord") as Record<string, unknown> & { links: unknown[] };
    const old = {
      ...record,
      created_by: { kind: "agent", id: "fedcba9876543210", task_id: "task-1" },
      updated_by: { kind: "agent", id: "fedcba9876543210", task_id: "task-1" },
    };
    const loaded = validateResearchRecord(old);
    expect(loaded.created_by).toEqual({ kind: "agent", id: "fedcba9876543210" });
    expect(loaded.updated_by).toEqual({ kind: "agent", id: "fedcba9876543210" });
    expect(loaded.links).toEqual([...record.links, { kind: "task", id: "task-1" }] as never);
    // Linked already: not twice.
    const twice = validateResearchRecord({
      ...old,
      links: [...record.links, { kind: "task", id: "task-1" }],
    });
    expect(twice.links.filter((l) => l.kind === "task")).toHaveLength(1);
  });

  test("a deployment an agent requested drops its token's task", () => {
    const dep = valid("DeploymentRecord") as Record<string, unknown>;
    const old = { ...dep, requested_by: { kind: "agent", id: "tok-2", task_id: "task-1" } };
    expect(validateDeploymentRecord(old) as unknown).toEqual(dep);
  });
});
