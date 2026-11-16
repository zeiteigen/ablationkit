import { describe, expect, test } from "bun:test";
import type { BackendManifest } from "../src/backend.ts";
import { checkBackendValue, validateBackendManifest } from "../src/backend-validation.ts";

type ContractManifest = BackendManifest & {
  service_agents?: string[];
  uses_services?: string[];
  ingest_services?: Record<string, string>;
  workers?: string[];
  operations: (BackendManifest["operations"][number] & {
    widens_data_controls?: true;
    input_schema?: Record<string, unknown>;
    output_schema?: Record<string, unknown>;
  })[];
};

function manifest(): ContractManifest {
  return {
    id: "fixture",
    version: "1.0.0",
    host_api: "1.0.0",
    entry: "src/backend.ts",
    capabilities: ["data.read"],
    operations: [
      {
        id: "fixture.echo",
        method: "POST",
        path: "/echo/:id",
        agent: true,
        input_schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        output_schema: { type: "string" },
      },
    ],
    pages: [{ id: "main", title: "Fixture", path: "/fixture", entry: "ui/view.js" }],
    services: ["echo", "event.ingest"],
    service_agents: ["echo"],
    uses_services: ["other-extension/query"],
    ingest: ["item.logged"],
    ingest_services: { "item.logged": "event.ingest" },
    job_sdks: ["python/sdk"],
    workers: ["workers/collector.py"],
  };
}

describe("backend manifest contracts", () => {
  test("accepts generic operation, page, service, worker and ingestion contracts", () => {
    expect(validateBackendManifest(manifest())).toEqual([]);
  });

  test("rejects unsafe file paths for every backend asset", () => {
    for (const path of [
      "../backend.ts",
      "/tmp/backend.ts",
      "C:/backend.ts",
      "dir/../backend.ts",
      "dir\\backend.ts",
      "./backend.ts",
      "dir//backend.ts",
      "",
      "backend\u0000.ts",
    ]) {
      const entry = manifest();
      entry.entry = path;
      expect(validateBackendManifest(entry).join(" ")).toContain("entry");
      const page = manifest();
      page.pages = [{ id: "main", title: "Fixture", path: "/fixture", entry: path }];
      expect(validateBackendManifest(page).join(" ")).toContain("Page entry");
      const sdk = manifest();
      sdk.job_sdks = [path];
      expect(validateBackendManifest(sdk).join(" ")).toContain("job SDK");
      const worker = manifest();
      worker.workers = [path];
      expect(validateBackendManifest(worker).join(" ")).toContain("worker");
    }
  });

  test("rejects duplicate IDs and ambiguous routes while allowing different HTTP methods", () => {
    const m = manifest();
    const operation = m.operations[0];
    if (!operation) throw new Error("missing fixture operation");
    m.operations = [
      operation,
      { ...operation },
      { ...operation, id: "fixture.other", path: "/echo/:other" },
    ];
    m.services = ["echo", "echo"];
    m.pages = [
      { id: "main", title: "Main", path: "/fixture", entry: "main.js" },
      { id: "main", title: "Copy", path: "/fixture", entry: "copy.js" },
    ];
    const errors = validateBackendManifest(m).join(" ");
    expect(errors).toContain("Duplicate operation id");
    expect(errors).toContain("Duplicate operation route");
    expect(errors).toContain("Duplicate service identifier");
    expect(errors).toContain("Duplicate page id");
    expect(errors).toContain("Duplicate page path");
    const valid = manifest();
    valid.operations.push({ id: "fixture.read", method: "GET", path: "/echo/:id", agent: true });
    expect(validateBackendManifest(valid)).toEqual([]);
  });

  test("rejects unsafe operation and page routes", () => {
    for (const path of [
      "relative",
      "//authority/path",
      "/../outside",
      "/item/../outside",
      "/item?query",
      "/item#hash",
      "/%2e%2e/outside",
      "/item\\outside",
    ]) {
      const m = manifest();
      m.operations = [{ id: "echo", method: "POST", path, agent: true }];
      m.pages = [{ id: "main", title: "Main", path, entry: "view.js" }];
      const errors = validateBackendManifest(m).join(" ");
      expect(errors).toContain("Operation path");
      expect(errors).toContain("Page path");
    }
  });

  test("rejects agent widening, undeclared agent services and invalid dependency identifiers", () => {
    const m = manifest();
    m.operations = [
      { id: "admin", method: "POST", path: "/admin", agent: true, widens_data_controls: true },
    ];
    m.service_agents = ["not-exported"];
    m.uses_services = [
      "extension",
      "../service",
      "extension/service/extra",
      "extension/constructor?x",
    ];
    const errors = validateBackendManifest(m).join(" ");
    expect(errors).toContain("Agent operation cannot widen data controls");
    expect(errors).toContain("Agent service is not declared");
    expect(errors).toContain("extension/service");
  });

  test("validates ingestion mappings and duplicate asset declarations", () => {
    const m = manifest();
    m.ingest_services = { "undeclared.event": "echo", "item.logged": "missing.service" };
    m.workers = ["worker.py", "worker.py"];
    m.job_sdks = ["sdk", "sdk"];
    const errors = validateBackendManifest(m).join(" ");
    expect(errors).toContain("Ingest mapping event is not declared");
    expect(errors).toContain("Ingest mapping service is not declared");
    expect(errors).toContain("Duplicate worker path");
    expect(errors).toContain("Duplicate job SDK path");
  });

  test("reports unsupported schemas instead of ignoring their constraints", () => {
    const m = manifest();
    m.operations = [
      {
        id: "echo",
        method: "POST",
        path: "/echo",
        agent: true,
        input_schema: { type: "string", format: "email" },
        output_schema: { $ref: "other.schema.json" },
      },
    ];
    const errors = validateBackendManifest(m).join(" ");
    expect(errors).toContain("input_schema");
    expect(errors).toContain("format");
    expect(errors).toContain("output_schema");
    expect(errors).toContain("$ref");
  });

  test("reports malformed JSON manifest fields without throwing", () => {
    expect(validateBackendManifest(null as unknown as BackendManifest)).toEqual([
      "Backend manifest must be an object",
    ]);
    const m = {
      ...manifest(),
      operations: [null],
      pages: [null],
      services: null,
    } as unknown as BackendManifest;
    expect(validateBackendManifest(m).join(" ")).toContain("Operation must be an object");
    expect(validateBackendManifest(m).join(" ")).toContain("Page must be an object");
  });
});

describe("backend schema values", () => {
  test("validates nested plain JSON schemas and preserves schema-less compatibility", () => {
    const schema = {
      type: "object",
      properties: {
        label: { type: "string", minLength: 2, maxLength: 8, pattern: "^[a-z]+$" },
        values: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 10 },
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
        },
        optional: { anyOf: [{ type: "null" }, { type: "boolean" }] },
      },
      required: ["label", "values"],
      additionalProperties: false,
    };
    expect(() => checkBackendValue(schema, { label: "good", values: [1, 3] })).not.toThrow();
    expect(() =>
      checkBackendValue(schema, { label: "good", values: [1], optional: null }),
    ).not.toThrow();
    for (const value of [
      { label: "x", values: [1] },
      { label: "Good", values: [1] },
      { label: "good", values: [1.5] },
      { label: "good", values: [1, 1] },
      { label: "good", values: [] },
      { label: "good", values: [11] },
      { label: "good", values: [1], extra: true },
      { values: [1] },
    ]) {
      try {
        checkBackendValue(schema, value);
        throw new Error("accepted invalid value");
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_request", status: 400 });
      }
    }
    expect(() => checkBackendValue(undefined, undefined)).not.toThrow();
    expect(() => checkBackendValue({}, { arbitrary: "value" })).not.toThrow();
  });

  test("checks enum, const, unions, intersections, not and schema-valued additionalProperties", () => {
    expect(() => checkBackendValue({ enum: ["a", 1, null] }, null)).not.toThrow();
    expect(() => checkBackendValue({ enum: ["a", 1, null] }, "b")).toThrow();
    expect(() => checkBackendValue({ type: "string", const: "exact" }, "exact")).not.toThrow();
    expect(() => checkBackendValue({ const: "exact" }, "other")).toThrow();
    expect(() =>
      checkBackendValue(
        {
          allOf: [
            { type: "number", minimum: 2 },
            { type: "number", maximum: 4 },
          ],
          not: { const: 3 },
        },
        2,
      ),
    ).not.toThrow();
    expect(() =>
      checkBackendValue(
        {
          allOf: [
            { type: "number", minimum: 2 },
            { type: "number", maximum: 4 },
          ],
          not: { const: 3 },
        },
        3,
      ),
    ).toThrow();
    const extras = { type: "object", additionalProperties: { type: "number" } };
    expect(() => checkBackendValue(extras, { extra: 1 })).not.toThrow();
    expect(() => checkBackendValue(extras, { extra: "bad" })).toThrow();
  });

  test("rejects unsupported, malformed, cyclic and overly deep schemas", () => {
    for (const schema of [
      { oneOf: [{ type: "string" }] },
      { $ref: "#" },
      { type: ["string", "null"] },
      { type: "array", items: [{ type: "string" }] },
      { type: "number", multipleOf: 0 },
      { type: "string", pattern: "[" },
      { type: "string", minLength: 3, maxLength: 1 },
      { type: "object", required: ["undeclared"] },
      { enum: [] },
      { const: {} },
      { type: "number", minimum: Number.NaN },
    ])
      expect(() => checkBackendValue(schema, null)).toThrow("Invalid backend schema");
    const cyclic: Record<string, unknown> = { type: "array" };
    cyclic["items"] = cyclic;
    expect(() => checkBackendValue(cyclic, [])).toThrow("cycles");
    let deep: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 34; index++) deep = { type: "array", items: deep };
    expect(() => checkBackendValue(deep, [])).toThrow("depth limit");
    expect(() =>
      checkBackendValue({ anyOf: Array.from({ length: 1001 }, () => ({ type: "string" })) }, "ok"),
    ).toThrow("size or depth limit");
  });

  test("bounds value error details without exposing submitted values", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    };
    try {
      checkBackendValue(schema, { count: "sensitive-input-value" });
      throw new Error("accepted invalid value");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_request", status: 400 });
      expect((error as Error).message).toContain("/count");
      expect((error as Error).message).not.toContain("sensitive-input-value");
    }
  });
});
