/** Pure trusted-backend contracts. Supported JSON Schema: explicit JSON types, objects,
 * homogeneous arrays, primitive enum/const, anyOf/allOf/not and ordinary size/range/pattern
 * constraints. References, formats, oneOf, tuples and unknown keywords are rejected, never
 * silently ignored. Schema traversal is bounded to 1,000 nodes and 32 levels. */
import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { BackendManifest } from "./backend.ts";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const ANNOTATIONS = new Set([
  "$schema",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const COMMON = new Set(["type", "enum", "const", "anyOf", "allOf", "not"]);
const KEYWORDS: Record<string, readonly string[]> = {
  object: ["properties", "required", "additionalProperties", "minProperties", "maxProperties"],
  array: ["items", "minItems", "maxItems", "uniqueItems"],
  string: ["minLength", "maxLength", "pattern"],
  number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  boolean: [],
  null: [],
};

interface ContractManifest extends BackendManifest {
  operations: readonly (BackendManifest["operations"][number] & {
    input_schema?: Record<string, unknown>;
    output_schema?: Record<string, unknown>;
  })[];
  service_agents?: readonly string[];
  uses_services?: readonly string[];
  ingest_services?: Readonly<Record<string, string>>;
  workers?: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relative(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes("\\") &&
    !value.includes(":") &&
    ![...value].some((character) => character.charCodeAt(0) < 32) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function route(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.length <= 1024 &&
    !/[\\?#%]/.test(value) &&
    ![...value].some((character) => character.charCodeAt(0) <= 32) &&
    (value === "/" ||
      value
        .slice(1)
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."))
  );
}

/** Diagnostics do not execute the backend or read its filesystem. */
export function validateBackendManifest(value: BackendManifest): string[] {
  const manifest = value as ContractManifest;
  if (!record(manifest)) return ["Backend manifest must be an object"];
  const errors: string[] = [];
  if (typeof manifest.id !== "string" || !IDENTIFIER.test(manifest.id))
    errors.push("Invalid backend id");
  if (!relative(manifest.entry)) errors.push("Backend entry must be a safe relative path");
  const seen = (items: readonly unknown[] | undefined, label: string): Set<string> => {
    const ids = new Set<string>();
    if (!Array.isArray(items)) {
      errors.push(`${label} must be an array`);
      return ids;
    }
    for (const item of items) {
      if (typeof item !== "string" || !IDENTIFIER.test(item)) {
        errors.push(`Invalid ${label} identifier`);
        continue;
      }
      if (ids.has(item)) errors.push(`Duplicate ${label} identifier: ${item}`);
      ids.add(item);
    }
    return ids;
  };
  const services = seen(manifest.services, "service");
  const ingest = seen(manifest.ingest, "ingest");
  if (manifest.service_agents !== undefined) {
    for (const service of seen(manifest.service_agents, "agent service")) {
      if (!services.has(service)) errors.push(`Agent service is not declared: ${service}`);
    }
  }
  if (manifest.uses_services !== undefined) {
    if (!Array.isArray(manifest.uses_services)) errors.push("uses_services must be an array");
    else {
      const dependencies = new Set<string>();
      for (const dependency of manifest.uses_services) {
        const parts = typeof dependency === "string" ? dependency.split("/") : [];
        if (parts.length !== 2 || parts.some((part) => !IDENTIFIER.test(part)))
          errors.push("Service dependency must use extension/service identifiers");
        else if (dependencies.has(dependency))
          errors.push(`Duplicate service dependency: ${dependency}`);
        else dependencies.add(dependency);
      }
    }
  }
  if (manifest.ingest_services !== undefined) {
    if (!record(manifest.ingest_services)) errors.push("ingest_services must be an object");
    else
      for (const [event, service] of Object.entries(manifest.ingest_services)) {
        if (!ingest.has(event)) errors.push(`Ingest mapping event is not declared: ${event}`);
        if (typeof service !== "string" || !services.has(service))
          errors.push(`Ingest mapping service is not declared: ${String(service)}`);
      }
  }
  for (const [label, paths] of [
    ["job SDK", manifest.job_sdks],
    ["agent skill", manifest.agent_skills ?? []],
    ["worker", manifest.workers ?? []],
  ] as const) {
    if (!Array.isArray(paths)) {
      errors.push(`${label} paths must be an array`);
      continue;
    }
    const unique = new Set<string>();
    for (const path of paths) {
      if (!relative(path)) errors.push(`${label} must use a safe relative path`);
      else if (unique.has(path)) errors.push(`Duplicate ${label} path: ${path}`);
      else unique.add(path);
    }
  }
  const operationIds = new Set<string>();
  const operationPaths = new Set<string>();
  if (!Array.isArray(manifest.operations)) errors.push("operations must be an array");
  else
    for (const operation of manifest.operations) {
      if (!record(operation)) {
        errors.push("Operation must be an object");
        continue;
      }
      if (typeof operation["id"] !== "string" || !IDENTIFIER.test(operation["id"]))
        errors.push("Invalid operation id");
      else if (operationIds.has(operation["id"]))
        errors.push(`Duplicate operation id: ${operation["id"]}`);
      else operationIds.add(operation["id"]);
      if (!route(operation["path"])) errors.push("Operation path must be a safe absolute route");
      if (
        typeof operation["method"] !== "string" ||
        !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(operation["method"])
      )
        errors.push("Invalid operation method");
      if (typeof operation["agent"] !== "boolean")
        errors.push("Operation agent permission must be a boolean");
      if (
        operation["widens_data_controls"] !== undefined &&
        operation["widens_data_controls"] !== true
      )
        errors.push("Operation widens_data_controls must be true when present");
      if (operation["agent"] && operation["widens_data_controls"])
        errors.push(`Agent operation cannot widen data controls: ${operation["id"]}`);
      if (route(operation["path"])) {
        const key = `${operation["method"]} ${operation["path"].replace(/:[^/]+/g, ":parameter")}`;
        if (operationPaths.has(key)) errors.push(`Duplicate operation route: ${key}`);
        operationPaths.add(key);
      }
      for (const field of ["input_schema", "output_schema"] as const) {
        if (operation[field] !== undefined) {
          try {
            schema(operation[field]);
          } catch (error) {
            errors.push(`Operation ${operation["id"]} ${field}: ${(error as Error).message}`);
          }
        }
      }
    }
  const pageIds = new Set<string>();
  const pagePaths = new Set<string>();
  if (!Array.isArray(manifest.pages)) errors.push("pages must be an array");
  else
    for (const page of manifest.pages) {
      if (!record(page)) {
        errors.push("Page must be an object");
        continue;
      }
      if (typeof page["id"] !== "string" || !IDENTIFIER.test(page["id"]))
        errors.push("Invalid page id");
      else if (pageIds.has(page["id"])) errors.push(`Duplicate page id: ${page["id"]}`);
      else pageIds.add(page["id"]);
      if (!relative(page["entry"])) errors.push("Page entry must be a safe relative path");
      if (!route(page["path"])) errors.push("Page path must be a safe absolute route");
      else if (pagePaths.has(page["path"])) errors.push(`Duplicate page path: ${page["path"]}`);
      else pagePaths.add(page["path"]);
    }
  return errors;
}

/** Undefined schemas retain compatibility. Invalid schemas are rejected as well as invalid values. */
export function checkBackendValue(
  contract: Record<string, unknown> | undefined,
  value: unknown,
): void {
  if (contract === undefined) return;
  let checker: TSchema;
  try {
    checker = schema(contract);
  } catch (error) {
    throw invalidValue(`Invalid backend schema: ${(error as Error).message}`);
  }
  if (Value.Check(checker, value)) return;
  const issues: string[] = [];
  for (const error of Value.Errors(checker, value)) {
    issues.push(`${error.path || "/"}: ${error.message}`);
    if (issues.length === 5) break;
  }
  throw invalidValue(`Backend value does not match its schema: ${issues.join("; ")}`);
}

function invalidValue(message: string): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code: "invalid_request", status: 400 });
}

function schema(input: unknown): TSchema {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth = 0): TSchema => {
    if (++nodes > 1000 || depth > 32) throw new Error("Schema exceeds its size or depth limit");
    if (value === true) return Type.Unknown();
    if (value === false) return Type.Never();
    if (!record(value)) throw new Error("Schema must be an object or nested boolean schema");
    if (ancestors.has(value)) throw new Error("Schema must not contain cycles");
    ancestors.add(value);
    try {
      const type = value["type"];
      if (type !== undefined && (typeof type !== "string" || !Object.hasOwn(KEYWORDS, type)))
        throw new Error("Unsupported schema type");
      const allowed = typeof type === "string" ? (KEYWORDS[type] ?? []) : [];
      for (const key of Object.keys(value)) {
        if (!ANNOTATIONS.has(key) && !COMMON.has(key) && !allowed.includes(key))
          throw new Error(`Unsupported schema keyword: ${key}`);
      }
      const options: Record<string, unknown> = {};
      for (const name of allowed) {
        if (
          value[name] === undefined ||
          ["properties", "required", "additionalProperties", "items"].includes(name)
        )
          continue;
        const item = value[name];
        if (
          [
            "minProperties",
            "maxProperties",
            "minItems",
            "maxItems",
            "minLength",
            "maxLength",
          ].includes(name)
        ) {
          if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)
            throw new Error(`${name} must be a nonnegative integer`);
        } else if (name === "pattern") {
          if (typeof item !== "string" || item.length > 1000)
            throw new Error("pattern must be a string of at most 1000 characters");
          try {
            new RegExp(item);
          } catch {
            throw new Error("pattern must be a valid regular expression");
          }
        } else if (name === "uniqueItems") {
          if (typeof item !== "boolean") throw new Error("uniqueItems must be a boolean");
        } else if (
          typeof item !== "number" ||
          !Number.isFinite(item) ||
          (name === "multipleOf" && item <= 0)
        )
          throw new Error(
            `${name} must be a finite number${name === "multipleOf" ? " greater than zero" : ""}`,
          );
        options[name] = item;
      }
      for (const [min, max] of [
        ["minLength", "maxLength"],
        ["minItems", "maxItems"],
        ["minProperties", "maxProperties"],
        ["minimum", "maximum"],
      ]) {
        if (
          min &&
          max &&
          typeof options[min] === "number" &&
          typeof options[max] === "number" &&
          options[min] > options[max]
        )
          throw new Error(`${min} exceeds ${max}`);
      }
      let result: TSchema;
      switch (type) {
        case "object": {
          const properties = value["properties"] ?? {};
          if (!record(properties)) throw new Error("properties must be an object");
          const required = value["required"] ?? [];
          if (
            !Array.isArray(required) ||
            required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)) ||
            new Set(required).size !== required.length
          )
            throw new Error("required must list unique declared properties");
          const fields = Object.fromEntries(
            Object.entries(properties).map(([key, field]) => {
              const nested = visit(field, depth + 1);
              return [key, required.includes(key) ? nested : Type.Optional(nested)];
            }),
          );
          const additional = value["additionalProperties"];
          if (additional !== undefined)
            options["additionalProperties"] =
              typeof additional === "boolean" ? additional : visit(additional, depth + 1);
          result = Type.Object(fields, options);
          break;
        }
        case "array":
          result = Type.Array(visit(value["items"] ?? true, depth + 1), options);
          break;
        case "string":
          result = Type.String(options);
          break;
        case "number":
          result = Type.Number(options);
          break;
        case "integer":
          result = Type.Integer(options);
          break;
        case "boolean":
          result = Type.Boolean();
          break;
        case "null":
          result = Type.Null();
          break;
        default:
          result = Type.Unknown();
      }
      const constraints: TSchema[] = [result];
      for (const name of ["anyOf", "allOf"] as const) {
        if (value[name] === undefined) continue;
        const branches = value[name];
        if (!Array.isArray(branches) || branches.length === 0)
          throw new Error(`${name} must be a nonempty schema array`);
        const choices = branches.map((branch) => visit(branch, depth + 1));
        constraints.push(name === "anyOf" ? Type.Union(choices) : Type.Intersect(choices));
      }
      if (value["not"] !== undefined) constraints.push(Type.Not(visit(value["not"], depth + 1)));
      const literal = (item: unknown): TSchema => {
        if (item === null) return Type.Null();
        if (
          typeof item === "string" ||
          typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item))
        )
          return Type.Literal(item);
        throw new Error("enum and const support only finite JSON primitives");
      };
      if (Object.hasOwn(value, "const")) constraints.push(literal(value["const"]));
      if (value["enum"] !== undefined) {
        const values = value["enum"];
        if (!Array.isArray(values) || values.length === 0 || values.length > 1000)
          throw new Error("enum must be a nonempty array of at most 1000 values");
        constraints.push(Type.Union(values.map(literal)));
      }
      return constraints.length === 1 ? result : Type.Intersect(constraints);
    } finally {
      ancestors.delete(value);
    }
  };
  if (!record(input)) throw new Error("Operation schema must be an object");
  return visit(input);
}
