/** Generic trusted backend fixture, exercised through a real Bun subprocess and coordinator brokers. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendCaller, BackendManifest } from "@ablationkit/extension-host/backend";
import type { ResearchRecord } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { type BackendBundle, ExtensionBackends } from "../src/extensions/backends.ts";
import { Harness } from "./helpers.ts";

const harness = new Harness();
const managers: ExtensionBackends[] = [];
const fakes: FakeMlflow[] = [];
const researcher: BackendCaller = { kind: "human", id: "researcher" };

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await harness.cleanup();
  await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
});

function fixture(
  id = "fixture",
  capabilities = ["data.read", "data.write", "project.research.write"],
): BackendBundle {
  const root = harness.tmp("ak-backend-fixture-");
  const manifest: BackendManifest = {
    id,
    version: "1.0.0",
    host_api: "^2.0.0",
    entry: "backend.ts",
    capabilities: ["backend.execute", ...capabilities],
    operations: [
      { id: "fixture.echo", method: "POST", path: "/echo", agent: true },
      { id: "fixture.broker", method: "POST", path: "/broker", agent: true },
      {
        id: "fixture.admin",
        method: "POST",
        path: "/admin",
        agent: false,
        widens_data_controls: true,
      },
    ],
    pages: [{ id: "fixture", title: "Fixture", path: "/fixture", entry: "view.js" }],
    services: ["echo", "broker"],
    ingest: [],
    job_sdks: [],
  };
  writeFileSync(
    join(root, "backend.ts"),
    `
    import { appendFileSync } from "node:fs";
    import { join } from "node:path";
    export default (ctx) => {
      appendFileSync(join(import.meta.dir, "starts.log"), String(process.pid) + "\\n");
      return {
        async call(method, raw) {
          const operation = method === "operation";
          const action = operation ? raw.operation.split(".").at(-1) : raw.service;
          const input = operation ? JSON.parse(raw.body ?? "{}") : raw.args[0];
          const value = action === "broker"
            ? await ctx.call(input.method, { invocation: raw.invocation, params: input.params })
            : { value: input, project_id: ctx.project.project_id, actor: raw.actor, pid: process.pid };
          return operation ? Response.json(value ?? null) : value;
        },
        shutdown() {
          appendFileSync(join(import.meta.dir, "stops.log"), String(process.pid) + ":" + String(ctx.signal.aborted) + "\\n");
        }
      };
    };
  `,
  );
  return { manifest, root };
}

async function setup(bundles = [fixture()], safeMode = false, trackingUrl?: string) {
  // Keep shipped extensions inactive so this fixture is the only backend under test.
  const client = await harness.start({ safeMode: true, ...(trackingUrl ? { trackingUrl } : {}) });
  const token = await client.session();
  for (const pid of ["alpha", "beta"]) {
    const response = await client.human("/api/v1/projects", {
      token,
      body: { path: harness.repo(pid), project_id: pid },
    });
    expect(response.status).toBe(201);
  }
  const manager = new ExtensionBackends({ svc: () => client.c.services, bundles, safeMode });
  managers.push(manager);
  return { manager, client, bundles };
}

function broker<T = unknown>(
  manager: ExtensionBackends,
  pid: string,
  extension: string,
  method: string,
  params: Record<string, unknown>,
) {
  return manager.service<T>(pid, extension, "broker", [{ method, params }], researcher);
}

function operation(body: unknown) {
  return {
    url: "http://localhost/api/v1/projects/alpha/extensions/fixture/echo",
    method: "POST",
    params: { id: "alpha" },
    body: JSON.stringify(body),
  };
}

describe("generic extension backends", () => {
  test("runs generic declared services and operations in a real project-scoped subprocess", async () => {
    const bundle = fixture();
    const { manager } = await setup([bundle]);
    const result = await manager.service<{
      value: unknown;
      project_id: string;
      actor: BackendCaller;
      pid: number;
    }>("alpha", "fixture", "echo", [{ nested: [1, 2] }], researcher);
    expect(result).toMatchObject({
      value: { nested: [1, 2] },
      project_id: "alpha",
      actor: researcher,
    });
    expect(result.pid).not.toBe(process.pid);
    const response = await manager.operation(
      "alpha",
      "fixture",
      "fixture.echo",
      operation({ from: "operation" }),
      researcher,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      value: { from: "operation" },
      project_id: "alpha",
      actor: researcher,
      pid: result.pid,
    });
    const other = await manager.service<{ project_id: string; pid: number }>(
      "beta",
      "fixture",
      "echo",
      ["other"],
      researcher,
    );
    expect(other.project_id).toBe("beta");
    expect(other.pid).not.toBe(result.pid);
    expect(manager.list("alpha")).toContainEqual(
      expect.objectContaining({
        id: "fixture",
        enabled: true,
        operations: bundle.manifest.operations,
        pages: bundle.manifest.pages,
      }),
    );
  });

  test("denies undeclared services, unknown operations and agents on human-only operations", async () => {
    const bundle = fixture();
    const { manager } = await setup([bundle]);
    await expect(
      manager.service("alpha", "fixture", "not-exported", [], researcher),
    ).rejects.toMatchObject({ code: "service_not_exported", status: 403 });
    await expect(
      manager.operation("alpha", "fixture", "not-exported", operation({}), researcher),
    ).rejects.toMatchObject({ code: "unknown_operation", status: 404 });
    await expect(
      manager.operation("alpha", "fixture", "fixture.admin", operation({}), {
        kind: "agent",
        id: "agent",
      }),
    ).rejects.toMatchObject({ code: "human_only", status: 403 });
    expect(existsSync(join(bundle.root, "starts.log"))).toBe(false);
    expect(
      (await manager.operation("alpha", "fixture", "fixture.admin", operation({}), researcher))
        .status,
    ).toBe(200);
  });

  test("denies broker writes without the declared capability", async () => {
    const { manager } = await setup([fixture("readonly", ["data.read"])]);
    await expect(
      broker(manager, "alpha", "readonly", "data.put", {
        collection: "results",
        key: "item",
        record: { schema_version: 1, expected_revision: null, value: "forbidden" },
      }),
    ).rejects.toMatchObject({ code: "capability_denied", status: 403 });
    expect(manager.data.get("alpha", "readonly", "results", "item")).toBeUndefined();
  });

  test("pins broker data to the invoking project and extension namespace", async () => {
    const { manager } = await setup([fixture("one"), fixture("two")]);
    await broker(manager, "alpha", "one", "data.put", {
      project_id: "beta",
      extension_id: "two",
      collection: "results",
      key: "item",
      record: { schema_version: 1, expected_revision: null, value: { owned: "alpha/one" } },
    });
    expect(
      await broker(manager, "alpha", "one", "data.get", { collection: "results", key: "item" }),
    ).toMatchObject({ value: { owned: "alpha/one" }, revision: 1 });
    expect(manager.data.get("beta", "one", "results", "item")).toBeUndefined();
    expect(manager.data.get("alpha", "two", "results", "item")).toBeUndefined();
    await broker(manager, "beta", "one", "data.put", {
      collection: "results",
      key: "item",
      record: { schema_version: 1, expected_revision: null, value: "beta/one" },
    });
    await broker(manager, "alpha", "two", "data.put", {
      collection: "results",
      key: "item",
      record: { schema_version: 1, expected_revision: null, value: "alpha/two" },
    });
    expect(manager.data.get("alpha", "one", "results", "item")?.value).toEqual({
      owned: "alpha/one",
    });
    expect(manager.data.get("beta", "one", "results", "item")?.value).toBe("beta/one");
    expect(manager.data.get("alpha", "two", "results", "item")?.value).toBe("alpha/two");
  });

  test("uses the host caller identity when a backend spoofs research project or actor fields", async () => {
    const { manager, client } = await setup();
    const agent: BackendCaller = { kind: "agent", id: "actual-agent" };
    const response = await manager.operation(
      "alpha",
      "fixture",
      "fixture.broker",
      operation({
        method: "research.create",
        params: {
          project_id: "beta",
          actor: { kind: "human", id: "spoofed-researcher" },
          kind: "note",
          input: { title: "Fixture note", body: "Created through the host broker" },
        },
      }),
      agent,
    );
    expect(response.status).toBe(200);
    const record = (await response.json()) as ResearchRecord;
    expect(record.project_id).toBe("alpha");
    expect(record.created_by).toEqual(agent);
    expect(client.c.services.research.require("alpha", record.record_id).created_by).toEqual(agent);
    expect(client.c.services.research.get("beta", record.record_id)).toBeUndefined();
  });

  test("audits the host agent identity without accepting spoofed provenance", async () => {
    const { manager, client } = await setup();
    const response = await manager.operation(
      "alpha",
      "fixture",
      "fixture.broker",
      operation({
        method: "audit.record",
        params: {
          action: "fixture.updated",
          actor: { kind: "human", id: "spoofed" },
          details: { item: "result" },
        },
      }),
      { kind: "agent", id: "actual-agent" },
    );
    expect(response.status).toBe(200);
    const entry = (await client.c.services.audit.read()).find(
      (record) => record.action === "fixture.updated",
    );
    expect(entry).toMatchObject({
      project_id: "alpha",
      listener: "agent",
      actor: { kind: "agent", id: "actual-agent" },
      details: { item: "result" },
    });
  });

  test("job ingestion has no researcher authority to launch executions", async () => {
    const bundle = fixture("fixture", ["executions.start"]);
    bundle.manifest = {
      ...bundle.manifest,
      ingest: ["fixture.identity", "fixture.execute"],
      ingest_services: { "fixture.identity": "echo", "fixture.execute": "broker" },
    };
    const entry = join(bundle.root, "backend.ts");
    writeFileSync(entry, readFileSync(entry, "utf8").replace(": raw.args[0]", ": raw.args[1]"));
    const { manager } = await setup([bundle]);
    expect(await manager.ingest("alpha", "fixture.identity", {}, {})).toMatchObject({
      actor: { kind: "agent", id: "extension:fixture:ingest" },
    });
    await expect(
      manager.ingest("alpha", "fixture.execute", { method: "execution.start", params: {} }, {}),
    ).rejects.toMatchObject({ status: 403, code: "human_only" });
  });

  test("disable shuts down and revokes the process, preserves state, and re-enable starts fresh", async () => {
    const bundle = fixture();
    const { manager } = await setup([bundle]);
    const before = await manager.service<{ pid: number }>(
      "alpha",
      "fixture",
      "echo",
      ["first"],
      researcher,
    );
    await broker(manager, "alpha", "fixture", "data.put", {
      collection: "results",
      key: "item",
      record: { schema_version: 1, expected_revision: null, value: "retained" },
    });
    await manager.setEnabled("alpha", "fixture", false, researcher);
    expect(manager.list("alpha")[0]?.enabled).toBe(false);
    expect(readFileSync(join(bundle.root, "stops.log"), "utf8")).toContain(`${before.pid}:true`);
    await expect(
      manager.service("alpha", "fixture", "echo", ["blocked"], researcher),
    ).rejects.toMatchObject({ code: "extension_inactive", status: 403 });
    expect(manager.data.get("alpha", "fixture", "results", "item")?.value).toBe("retained");
    await manager.setEnabled("alpha", "fixture", true, researcher);
    const after = await manager.service<{ pid: number }>(
      "alpha",
      "fixture",
      "echo",
      ["fresh"],
      researcher,
    );
    expect(after.pid).not.toBe(before.pid);
    expect(
      await broker(manager, "alpha", "fixture", "data.get", { collection: "results", key: "item" }),
    ).toMatchObject({ value: "retained" });
  });

  test("safe mode never starts a backend, including after an activation attempt", async () => {
    const bundle = fixture();
    const { manager } = await setup([bundle], true);
    await manager.startAll();
    expect(manager.list("alpha")[0]?.enabled).toBe(false);
    await manager.setEnabled("alpha", "fixture", true, researcher);
    await expect(manager.service("alpha", "fixture", "echo", [], researcher)).rejects.toMatchObject(
      { code: "extension_inactive", status: 403 },
    );
    expect(existsSync(join(bundle.root, "starts.log"))).toBe(false);
  });
  test("service dependencies preserve caller identity and require explicit approval", async () => {
    const caller = fixture("caller", ["services.call"]);
    caller.manifest = { ...caller.manifest, uses_services: ["callee/echo"] };
    const callee = fixture("callee");
    const { manager } = await setup([caller, callee]);
    const result = await broker<{ actor: BackendCaller }>(
      manager,
      "alpha",
      "caller",
      "services.call",
      { extension: "callee", service: "echo", args: ["from caller"] },
    );
    expect(result.actor).toEqual(researcher);
    await expect(
      broker(manager, "alpha", "caller", "services.call", {
        extension: "callee",
        service: "broker",
        args: [],
      }),
    ).rejects.toMatchObject({ status: 403, code: "service_not_allowed" });
    await expect(
      manager.operation(
        "alpha",
        "caller",
        "fixture.broker",
        operation({
          method: "services.call",
          params: { extension: "callee", service: "echo", args: [] },
        }),
        { kind: "agent" },
      ),
    ).rejects.toMatchObject({ status: 403, code: "service_not_exported" });
  });

  test("event replay is project scoped, bounded and cursor based", async () => {
    const { manager, client } = await setup([fixture("observer", ["events.subscribe"])]);
    client.c.services.events.publish("alpha", "fixture.first", { message: "alpha" });
    client.c.services.events.publish("beta", "fixture.first", { message: "beta" });
    client.c.services.events.publish("alpha", "fixture.second", { message: "second" });
    const first = await broker<{ events: { seq: number; payload: unknown }[]; cursor: number }>(
      manager,
      "alpha",
      "observer",
      "events.read",
      { after: -1, limit: 1, types: ["fixture.first", "fixture.second"] },
    );
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.payload).toEqual({ message: "alpha" });
    const second = await broker<{ events: { payload: unknown }[]; cursor: number }>(
      manager,
      "alpha",
      "observer",
      "events.read",
      { after: first.cursor, limit: 1, types: ["fixture.first", "fixture.second"] },
    );
    expect(second.events.map((event) => event.payload)).toEqual([{ message: "second" }]);
    await expect(
      broker(manager, "alpha", "observer", "events.read", { after: -2 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("inactive extension policies still filter another backend and retain authoritative data", async () => {
    const owner = fixture("policy-owner");
    const reader = fixture("reader", ["tracking.read"]);
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const { manager, client } = await setup([owner, reader], false, fake.url);
    const svc = client.c.services;
    const experiment = await svc.tracking.ensureExperimentNow("alpha");
    const trace = await svc.tracking.client.startTrace({
      trace_id: "tr-11111111111111111111111111111111",
      request_time: new Date(svc.now().getTime() - 3 * 86_400_000).toISOString(),
      state: "OK",
      request_preview: "sensitive@example.com",
      trace_location: {
        type: "MLFLOW_EXPERIMENT",
        mlflow_experiment: { experiment_id: experiment },
      },
      tags: { "ablationkit.project": "alpha" },
    });
    manager.policies.update(
      "alpha",
      "policy-owner",
      {
        destinations: [],
        capture: { mode: "redacted", retention_days: 1, builtin_redactions: ["email"] },
      },
      { expected_revision: 0, allowWiden: true },
    );
    await manager.setEnabled("alpha", "policy-owner", false, researcher);
    const info = await broker<{ request_preview: string }>(
      manager,
      "alpha",
      "reader",
      "tracking.call",
      { method: "getTraceInfo", args: [trace.trace_id] },
    );
    expect(info.request_preview).not.toContain("sensitive@example.com");
    const restarted = new ExtensionBackends({
      svc: () => svc,
      bundles: [owner, reader],
      safeMode: true,
      retentionSweepMs: 0,
    });
    managers.push(restarted);
    expect(restarted.policies.list("alpha")).toHaveLength(1);
    expect(await restarted.sweep()).toEqual({ alpha: 1 });
    await expect(svc.tracking.client.getTraceInfo(trace.trace_id)).rejects.toThrow();
  });
});
