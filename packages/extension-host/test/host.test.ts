import { describe, expect, test } from "bun:test";
import type { ExtensionManifest } from "@ablationkit/protocol";
import {
  buildId,
  capabilityHash,
  modelAllowed,
  parseModelEntry,
  permissionSummary,
  safeRelative,
  satisfies,
  treeHash,
  validateManifest,
} from "../src/index.ts";

const base = (): ExtensionManifest => ({
  schema_version: 1,
  id: "model-explorer",
  version: "0.2.0",
  host_api: "^1.0.0",
  contributes: [
    { id: "tab", point: "run.tab", title: "Explorer", entry: "ui/src/View.tsx" },
    {
      id: "analyze",
      point: "project.analysis",
      title: "Analyze",
      entry: "python/analysis.py:analyze",
    },
  ],
  python: {
    requires_python: ">=3.11",
    project: "python",
    lockfile: "python/uv.lock",
    max_runtime_seconds: 60,
    max_memory_mb: 512,
    gpu: false,
    network: "none",
  },
  capabilities: ["project.runs.read", "project.analysis.execute"],
});
const FILES = [
  "manifest.json",
  "ui/src/View.tsx",
  "python/analysis.py",
  "python/pyproject.toml",
  "python/uv.lock",
];

describe("semver ranges", () => {
  test("caret, tilde, comparators and exact", () => {
    expect(satisfies("1.0.0", "^1.0.0")).toBe(true);
    expect(satisfies("1.4.2", "^1.0.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfies("0.2.5", "^0.2.0")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.0")).toBe(false);
    expect(satisfies("1.0.9", "~1.0.0")).toBe(true);
    expect(satisfies("1.1.0", "~1.0.0")).toBe(false);
    expect(satisfies("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfies("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfies("1.0.0", "1.0.0")).toBe(true);
    expect(satisfies("1.0.0-rc.1", "^1.0.0")).toBe(false);
    expect(satisfies("1.0.0", "latest")).toBeUndefined();
  });
});

describe("manifest validation", () => {
  test("a valid manifest passes", () => {
    const r = validateManifest(base(), { files: FILES, dirName: "model-explorer" });
    expect(r.diagnostics).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test("schema errors are reported, not thrown", () => {
    const r = validateManifest({ id: "X" }, { files: [] });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.code).toBe("manifest_schema");
  });

  test("an incompatible host API is rejected with an actionable fix (criterion 15b)", () => {
    const r = validateManifest({ ...base(), host_api: "^3.0.0" }, { files: FILES });
    const d = r.diagnostics.find((x) => x.code === "host_api_incompatible");
    expect(r.ok).toBe(false);
    expect(d?.message).toContain("2.0.0");
    expect(d?.fix).toContain("^2.0.0");
    expect(
      validateManifest({ ...base(), host_api: "whatever" }, { files: FILES }).diagnostics[0]?.code,
    ).toBe("host_api_range");
  });

  test("unknown capabilities, missing config and missing lockfile", () => {
    const m = base();
    m.capabilities = [...m.capabilities, "shell.exec", "inference.predict"];
    const r = validateManifest(m, { files: FILES.filter((f) => f !== "python/uv.lock") });
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain("unknown_capability");
    expect(codes).toContain("capability_config_missing");
    expect(codes).toContain("lockfile_missing");
  });

  test("actions only name allowlisted operations with their capability", () => {
    const m = base();
    m.contributes.push({
      id: "sh",
      point: "project.action",
      title: "Shell",
      operation: "shell.exec",
    });
    m.contributes.push({
      id: "note",
      point: "project.action",
      title: "Note",
      operation: "research.note.create",
    });
    m.contributes.push({
      id: "run",
      point: "project.action",
      title: "Run",
      operation: "extension.python.run",
      target: "nope",
    });
    const codes = validateManifest(m, { files: FILES }).diagnostics.map((d) => d.code);
    expect(codes).toContain("operation_not_allowed");
    expect(codes).toContain("action_capability_missing");
    expect(codes).toContain("target_unknown");
  });

  test("paths must stay inside the extension", () => {
    const m = base();
    (m.contributes[0] as { entry: string }).entry = "../other/View.tsx";
    expect(validateManifest(m, { files: FILES }).diagnostics.map((d) => d.code)).toContain(
      "ui_entry_invalid",
    );
    expect(safeRelative("a/b.ts")).toBe(true);
    expect(safeRelative("/etc/passwd")).toBe(false);
    expect(safeRelative("a/../../b")).toBe(false);
  });

  test("gpu and network egress must be requested as capabilities", () => {
    const m = base();
    (m.python as { gpu: boolean }).gpu = true;
    (m.python as { network: string }).network = "egress";
    const codes = validateManifest(m, { files: FILES }).diagnostics.map((d) => d.code);
    expect(codes).toContain("gpu_not_requested");
    expect(codes).toContain("network_not_requested");
  });
});

describe("hashes", () => {
  test("capability hash changes with capabilities, limits and contributions, not with order", () => {
    const a = base();
    const h = capabilityHash(a);
    expect(capabilityHash({ ...a, capabilities: [...a.capabilities].reverse() })).toBe(h);
    expect(
      capabilityHash({ ...a, capabilities: [...a.capabilities, "project.research.read"] }),
    ).not.toBe(h);
    const b = base();
    (b.python as { max_memory_mb: number }).max_memory_mb = 1024;
    expect(capabilityHash(b)).not.toBe(h);
    // The version string alone is not a capability change.
    expect(capabilityHash({ ...a, version: "9.9.9" })).toBe(h);
  });

  test("tree hash and build id are content-derived", () => {
    const f = [
      { path: "b", sha256: "2".repeat(64) },
      { path: "a", sha256: "1".repeat(64) },
    ];
    expect(treeHash(f)).toBe(treeHash([...f].reverse()));
    expect(treeHash(f)).not.toBe(treeHash([f[0] as never]));
    const id = buildId({ source_sha256: "a", capability_sha256: "b", host_api_version: "1.0.0" });
    expect(id).toMatch(/^eb-[a-f0-9]{16}$/);
  });
});

describe("permissions and allowlists", () => {
  test("summary shows bounds for inference and execution", () => {
    const m = base();
    m.capabilities.push("inference.predict");
    m.capability_config = {
      inference: { models: ["iris@champion"], max_requests_per_hour: 50, max_request_bytes: 4096 },
    };
    const s = permissionSummary(m);
    expect(s.find((x) => x.capability === "inference.predict")?.bounds).toContain("iris@champion");
    expect(s.find((x) => x.capability === "project.analysis.execute")?.bounds).toContain("512 MiB");
  });

  test("model allowlist entries", () => {
    expect(parseModelEntry("m-abc123")).toEqual({ model_id: "m-abc123" });
    expect(parseModelEntry("iris@champion")).toEqual({ name: "iris", alias: "champion" });
    expect(parseModelEntry("iris/3")).toEqual({ name: "iris", version: "3" });
    expect(parseModelEntry("../x")).toBeUndefined();
    expect(modelAllowed(["iris@champion"], "iris@champion")).toBe(true);
    expect(modelAllowed(["iris@champion"], "iris@challenger")).toBe(false);
  });
});
