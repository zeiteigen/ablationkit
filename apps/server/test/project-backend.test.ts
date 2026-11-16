/** A checkout-authored backend uses the same build, approval and revocation as extensions. */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionBuildRecord, ExtensionManifest } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";

const harness = new Harness();
const fakes: FakeMlflow[] = [];
const EXTENSION = "project-echo";
const PROJECT = "backend-lab";
const BASE = `/api/v1/projects/${PROJECT}`;
const EXT = `${BASE}/extensions/${EXTENSION}`;
const OPERATION = `${EXT}/operations/echo`;

// API responses are heterogeneous; concrete build records stay typed below.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous coordinator API assertions
type Json = any;

afterEach(async () => {
  await harness.cleanup();
  for (const fake of fakes.splice(0)) await fake.stop();
});

function install(checkout: string): void {
  const root = join(checkout, ".ablationkit", "extensions", EXTENSION);
  mkdirSync(root, { recursive: true });
  const manifest: ExtensionManifest = {
    schema_version: 1,
    id: EXTENSION,
    version: "1.0.0",
    host_api: "^2.0.0",
    contributes: [],
    capabilities: ["backend.execute", "data.read", "data.write"],
    backend: {
      entry: "backend.ts",
      operations: [
        {
          id: "echo",
          method: "POST",
          path: "/echo",
          agent: true,
          input_schema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
        },
        {
          id: "admin",
          method: "POST",
          path: "/admin",
          agent: false,
          widens_data_controls: true,
          input_schema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
        },
      ],
      services: ["echo"],
      service_agents: ["echo"],
      uses_services: [],
      pages: [],
      ingest: [],
      job_sdks: [],
      workers: [],
    },
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(root, "backend.ts"),
    `
    export default (ctx) => ({
      async call(method, raw) {
        if (method === "operation") return Response.json({ message: JSON.parse(raw.body).message });
        if (method !== "service" || raw.service !== "echo") throw new Error("Unknown fixture service");
        const input = raw.args[0];
        return ctx.call("data.put", {
          invocation: raw.invocation,
          params: {
            project_id: input.project_id ?? ctx.project.project_id,
            extension_id: "spoofed-extension",
            collection: "echoes", key: input.key,
            record: { schema_version: 1, expected_revision: null, value: { message: input.message } },
          },
        });
      },
    });
  `,
  );
}

async function setup() {
  const fake = new FakeMlflow().start();
  fakes.push(fake);
  const client = await harness.start({ trackingUrl: fake.url, trackingIntervalMs: 20 });
  const token = await client.session();
  const call = <T = Json>(path: string, body?: unknown) =>
    client.json<T>(client.human(path, { token, ...(body === undefined ? {} : { body }) }));
  const checkout = harness.repo(PROJECT);
  install(checkout);
  expect((await call("/api/v1/projects", { path: checkout, project_id: PROJECT })).status).toBe(
    201,
  );
  expect(
    (await call("/api/v1/projects", { path: harness.repo("other"), project_id: "other" })).status,
  ).toBe(201);
  const agent = { body: await client.agentSession(PROJECT) };
  const agentCall = <T = Json>(path: string, body?: unknown) =>
    client.json<T>(
      client.agent(path, { token: agent.body.token, ...(body === undefined ? {} : { body }) }),
    );
  const cookie = await client.browserSession();
  const auth = { cookie, origin: client.localOrigin };
  // The web UI approves and enables from a browser session (cookie and trusted origin).
  const browser = (path: string, body: unknown) =>
    client.json<Json>(client.human(path, { ...auth, body }));
  const approve = (build: ExtensionBuildRecord) =>
    browser(`${EXT}/approve`, { build_id: build.build_id, trusted_code: true });
  const build = async () => {
    const result = await call<{ build: ExtensionBuildRecord }>(`${EXT}/build`, {});
    expect(result.status).toBe(201);
    expect(result.body.build.status).toBe("ready");
    expect(result.body.build.diagnostics.filter((item) => item.level === "error")).toEqual([]);
    const record = client.c.services.extensions.build(PROJECT, result.body.build.build_id);
    if (!record) throw new Error("built extension record missing");
    expect(record.backend?.file).toBe("compiled-backend.js");
    expect(record.backend?.sha256).toMatch(/^[a-f0-9]{64}$/);
    return record;
  };
  return { client, call, agentCall, build, approve, browser };
}

describe("project-authored trusted backend", () => {
  test("builds, requires the researcher's approval, lists and invokes human/agent operations, validates input and revokes on disable", async () => {
    const world = await setup();
    const unapproved = await world.call(OPERATION, { body: { message: "not approved" } });
    expect([403, 404]).toContain(unapproved.status);
    expect(
      (await world.call(`${BASE}/extension-backends`)).body.extensions.some(
        (item: Json) => item.id === EXTENSION,
      ),
    ).toBe(false);
    const build = await world.build();
    const pending = await world.agentCall(OPERATION, { body: { message: "built but unapproved" } });
    expect([403, 404]).toContain(pending.status);
    expect(
      (
        await world.agentCall(`${EXT}/approve`, {
          build_id: build.build_id,
          trusted_code: true,
        })
      ).status,
    ).toBe(404);
    expect((await world.approve(build)).status).toBe(200);

    const registry = await world.call(`${BASE}/extension-backends`);
    expect(registry.status).toBe(200);
    expect(registry.body.extensions).toContainEqual(
      expect.objectContaining({
        id: EXTENSION,
        bundled: false,
        enabled: true,
        operations: build.manifest.backend?.operations,
      }),
    );
    expect((await world.agentCall(`${BASE}/extension-backends`)).body.extensions).toContainEqual(
      expect.objectContaining({ id: EXTENSION }),
    );
    const human = await world.call(OPERATION, { body: { message: "hello human" } });
    expect(human.status).toBe(200);
    expect(human.body).toEqual({ message: "hello human" });
    const agent = await world.agentCall(OPERATION, { body: { message: "hello agent" } });
    expect(agent.status).toBe(200);
    expect(agent.body).toEqual({ message: "hello agent" });
    for (const input of [{}, { message: 3 }, { message: "extra", unexpected: true }]) {
      const invalid = await world.agentCall(OPERATION, { body: input });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe("invalid_request");
    }

    const services = world.client.c.services;
    const backend = services.extensions.backendBundle(PROJECT, EXTENSION);
    expect(backend?.manifest.entry).toBe("compiled-backend.js");
    if (!backend || !build.backend) throw new Error("approved backend bundle missing");
    expect(
      createHash("sha256")
        .update(readFileSync(join(backend.root, backend.manifest.entry)))
        .digest("hex"),
    ).toBe(build.backend.sha256);
    expect(services.extensions.approval(PROJECT, EXTENSION, build.build_id)?.bundle_sha256).toBe(
      build.bundle_sha256,
    );
    const stored = await services.backends.service(
      PROJECT,
      EXTENSION,
      "echo",
      [{ key: "agent", message: "scoped", project_id: "other" }],
      { kind: "agent", id: "fixture-agent" },
    );
    expect(stored).toMatchObject({ value: { message: "scoped" } });
    expect(services.backends.data.get(PROJECT, EXTENSION, "echoes", "agent")?.value).toEqual({
      message: "scoped",
    });
    expect(services.backends.data.get("other", EXTENSION, "echoes", "agent")).toBeUndefined();
    expect(
      services.backends.data.get(PROJECT, "spoofed-extension", "echoes", "agent"),
    ).toBeUndefined();
    expect(
      (
        await world.agentCall(`/api/v1/projects/other/extensions/${EXTENSION}/operations/echo`, {
          body: { message: "cross project" },
        })
      ).status,
    ).toBe(403);

    expect((await world.call(`${EXT}/disable`, { reason: "test revocation" })).status).toBe(200);
    const revoked = await world.call(OPERATION, { body: { message: "disabled" } });
    expect([403, 404]).toContain(revoked.status);
    await expect(
      services.backends.service(PROJECT, EXTENSION, "echo", [
        { key: "after", message: "disabled" },
      ]),
    ).rejects.toThrow();
    expect(services.backends.data.get(PROJECT, EXTENSION, "echoes", "agent")?.value).toEqual({
      message: "scoped",
    });
  });

  test("backend disable overlay revokes calls and enabling restores approved permissions and state", async () => {
    const world = await setup();
    const build = await world.build();
    expect((await world.approve(build)).status).toBe(200);
    expect((await world.agentCall(OPERATION, { body: { message: "before overlay" } })).status).toBe(
      200,
    );
    const manager = world.client.c.services.backends;
    const grant = manager.policies.update(
      PROJECT,
      EXTENSION,
      {
        destinations: [
          {
            id: "local",
            base_url: "http://127.0.0.1:9000/api",
            allow_external: false,
            allow_dataset: false,
          },
        ],
      },
      { expected_revision: 0, allowWiden: false },
    );
    await manager.service(PROJECT, EXTENSION, "echo", [
      { key: "retained", message: "stored before overlay" },
    ]);
    expect((await world.call(`${EXT}/backend/disable`, {})).status).toBe(200);
    expect((await world.call(OPERATION, { body: { message: "blocked human" } })).status).toBe(403);
    expect((await world.agentCall(OPERATION, { body: { message: "blocked agent" } })).status).toBe(
      403,
    );
    await expect(
      manager.service(PROJECT, EXTENSION, "echo", [{ key: "disabled", message: "blocked" }]),
    ).rejects.toMatchObject({ status: 403, code: "extension_inactive" });
    expect(manager.list(PROJECT)).toContainEqual(
      expect.objectContaining({ id: EXTENSION, enabled: false }),
    );
    expect([403, 404]).toContain((await world.agentCall(`${EXT}/backend/enable`, {})).status);
    expect((await world.browser(`${EXT}/backend/enable`, {})).status).toBe(200);
    expect(
      (await world.agentCall(OPERATION, { body: { message: "restored agent" } })).body,
    ).toEqual({ message: "restored agent" });
    expect(manager.policies.get(PROJECT, EXTENSION)).toEqual(grant);
    expect(manager.data.get(PROJECT, EXTENSION, "echoes", "retained")?.value).toEqual({
      message: "stored before overlay",
    });
    expect(manager.list(PROJECT)).toContainEqual(
      expect.objectContaining({ id: EXTENSION, enabled: true }),
    );
  });

  test("an operation that widens data controls is human-only; the researcher's session runs it", async () => {
    const world = await setup();
    const build = await world.build();
    expect((await world.approve(build)).status).toBe(200);
    const admin = `${EXT}/operations/admin`;
    const input = { body: { message: "widening operation" } };
    const agent = await world.agentCall(admin, input);
    expect(agent.status).toBe(403);
    expect(agent.body.error.code).toBe("human_only");
    const human = await world.call(admin, input);
    expect(human.status).toBe(200);
    expect(human.body).toEqual({ message: "widening operation" });
    // There is no separate privileged route any more (ADR 0037).
    expect((await world.call(`${admin}/privileged`, input)).status).toBe(404);
  });

  test("refuses a modified compiled bundle even after its approved process has started", async () => {
    const world = await setup();
    const build = await world.build();
    expect((await world.approve(build)).status).toBe(200);
    expect((await world.call(OPERATION, { body: { message: "before tamper" } })).status).toBe(200);
    const backend = world.client.c.services.extensions.backendBundle(PROJECT, EXTENSION);
    if (!backend) throw new Error("approved backend bundle missing");
    const file = join(backend.root, "compiled-backend.js");
    chmodSync(file, 0o600);
    writeFileSync(file, `${readFileSync(file, "utf8")}\n// changed after approval\n`);
    const rejected = await world.call(OPERATION, { body: { message: "after tamper" } });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("extension_changed");
    await expect(
      world.client.c.services.backends.service(PROJECT, EXTENSION, "echo", [
        { key: "tampered", message: "refused" },
      ]),
    ).rejects.toMatchObject({ status: 409, code: "extension_changed" });
  });
});
