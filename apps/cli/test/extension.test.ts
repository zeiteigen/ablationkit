/**
 * Extensions from the author's and the agent's side (criteria 15a, 15e; ADR 0022, 0040): offline
 * validation, doctor, templates and scaffold in the CLI; build, run, executions and logs of an
 * approved Python evaluator through `ablationkit mcp`; approval stays the researcher's.
 */
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { AgentSession, handleMcp, MCP_TOOLS, OPERATIONS, toolFor } from "../src/commands/mcp.ts";
import { Harness, ROOT, cli as run } from "./helpers.ts";

const FIXTURES = join(ROOT, "fixtures/extensions");
const h = new Harness();
afterEach(h.cleanup);
const tmp = () => h.tmp("ak-cli-ext-");

test("offline validate and doctor give actionable diagnostics without a coordinator", async () => {
  const home = tmp();
  const ok = await run(home, ["extension", "validate", "--path", join(FIXTURES, "py-evaluator")]);
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("valid (host API 2.0.0)");
  expect(ok.out).toContain("project.analysis.execute [enforced] — 8 s, 192 MiB");
  const repo = tmp();
  const ext = join(repo, ".ablationkit/extensions/run-inspector");
  mkdirSync(join(repo, ".ablationkit/extensions"), { recursive: true });
  cpSync(join(FIXTURES, "run-inspector"), ext, { recursive: true });
  writeFileSync(
    join(ext, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      id: "run-inspector",
      version: "1.0.0",
      host_api: "^3.0.0",
      contributes: [{ id: "t", point: "run.tab", title: "T", entry: "ui/src/RunTab.tsx" }],
      capabilities: ["shell.exec"],
    }),
  );
  const doc = await run(home, ["extension", "doctor", "--path", repo]);
  expect(doc.code).toBe(1);
  expect(doc.out).toContain("✗ run-inspector 1.0.0 (host_api ^3.0.0)");
  expect(doc.out).toContain("host_api_incompatible");
  expect(doc.out).toContain("fix: Port the extension to API 2.0.0");
  expect(doc.out).toContain("unknown_capability");
});

test("an agent builds and runs an approved evaluator through MCP and reads its executions; approval is the researcher's", async () => {
  const home = tmp();
  const fake = h.track(new FakeMlflow().start());
  const c = await h.start(
    home,
    { trackingUrl: fake.url, trackingIntervalMs: 20 },
    { jobs: { supervisor: "direct" } },
  );
  const repo = join(tmp(), "lab");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, ".ablationkit/extensions"), { recursive: true });
  cpSync(join(FIXTURES, "py-evaluator"), join(repo, ".ablationkit/extensions/py-evaluator"), {
    recursive: true,
  });
  expect((await run(home, ["project", "add", repo, "--id", "lab"])).code).toBe(0);
  const P = ["--project", "lab"];
  const exp = await c.services.tracking.ensureExperimentNow("lab");
  const r = await c.services.tracking.client.createRun({ experiment_id: exp, run_name: "r" });
  await c.services.tracking.client.logBatch({
    run_id: r.info.run_id,
    metrics: [{ key: "loss", value: 0.5, timestamp: 1, step: 0 }],
  });

  const session = new AgentSession({ home, cwd: repo, harness: "test" });
  // biome-ignore lint/suspicious/noExplicitAny: tool results are JSON
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const r = (await handleMcp(
      { id: 1, method: "tools/call", params: { name, arguments: args } },
      session,
    )) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
    return r.result.isError
      ? { error: r.result.structuredContent["error"] }
      : r.result.structuredContent;
  };
  const list = await tool("ablationkit_read", { op: "extension.list" });
  expect(list.extensions[0]).toMatchObject({
    extension_id: "py-evaluator",
    status: "needs_build",
    trusted_code: true,
  });
  const b = await tool("ablationkit_do", { op: "extension.build", extension_id: "py-evaluator" });
  expect(b.build).toMatchObject({ status: "ready", python: { status: "ready" } });
  const eb = b.build.build_id as string;
  // No tool approves; the approval itself (as the web UI route makes it).
  expect(MCP_TOOLS.some((t) => /approve|enable|rollback|activate/.test(t.name))).toBe(false);
  c.services.extensions.approve(
    "lab",
    "py-evaluator",
    { build_id: eb, trusted_code: true },
    { kind: "human" },
  );

  let x = (
    await tool("ablationkit_do", {
      op: "extension.run",
      extension_id: "py-evaluator",
      contribution: "evaluate",
      params: { scale: 2 },
      refs: [{ kind: "run", id: r.info.run_id }],
    })
  ).execution;
  while (x.status === "running") {
    await Bun.sleep(200);
    x = (
      await tool("ablationkit_read", { op: "extension.execution", execution_id: x.execution_id })
    ).execution;
  }
  expect(x.status).toBe("succeeded");
  expect(x.result.metrics).toMatchObject({ scaled_loss: "1.0" });
  expect(x.result.artifacts.map((a: { path: string }) => a.path)).toContain("evaluation.json");
  expect(x.mlflow_run_id).toMatch(/\w+/);
  const xs = await tool("ablationkit_read", {
    op: "extension.executions",
    extension: "py-evaluator",
  });
  expect(xs.executions[0].status).toBe("succeeded");
  const log = await tool("ablationkit_read", {
    op: "extension.execution_log",
    execution_id: xs.executions[0].execution_id,
  });
  expect(log.log).toContain("evaluating");
  const show = await tool("ablationkit_read", {
    op: "extension.show",
    extension_id: "py-evaluator",
  });
  expect(show.extension.builds[0]).toMatchObject({ build_id: eb, active: true });
  await c.services.extensions.disable("lab", "py-evaluator", { reason: "done" }, { kind: "human" });
  const again = await tool("ablationkit_do", {
    op: "extension.run",
    extension_id: "py-evaluator",
    contribution: "summarize",
  });
  expect(again.error.code).toBe("extension_inactive");
  // The CLI keeps the author's tools; approval is refused with a pointer to the web UI.
  const ap = await run(home, ["extension", "approve", "py-evaluator", ...P]);
  expect(ap.code).toBe(2);
  expect(ap.err).toContain("is done in the web UI");
  await session.end();
}, 60_000);

test("templates lists the nine templates; scaffold creates a valid, locked extension offline", async () => {
  const home = tmp();
  const repo = tmp();
  const t = await run(home, ["extension", "templates", "--json"]);
  expect(JSON.parse(t.out).templates).toHaveLength(9);
  const s = await run(home, [
    "extension",
    "scaffold",
    "--template",
    "react-python-demo",
    "--id",
    "my-demo",
    "--name",
    "My demo",
    "--path",
    repo,
  ]);
  expect(s.err).toBe("");
  expect(s.code).toBe(0);
  expect(s.out).toContain("valid");
  const v = await run(home, [
    "extension",
    "validate",
    "--path",
    join(repo, ".ablationkit/extensions/my-demo"),
  ]);
  expect(v.code).toBe(0);
  const again = await run(home, [
    "extension",
    "scaffold",
    "--template",
    "react-python-demo",
    "--id",
    "my-demo",
    "--path",
    repo,
  ]);
  expect(again.code).toBe(2);
  expect(again.err).toContain("already exists");
  const bad = await run(home, [
    "extension",
    "scaffold",
    "--template",
    "nope",
    "--id",
    "x-y",
    "--path",
    repo,
  ]);
  expect(bad.err).toContain("templates: architecture-viewer");
});

test("MCP exposes the extension operations agents use, but nothing that approves or activates", () => {
  const ids = OPERATIONS.map((o) => o.id).filter((n) => n.startsWith("extension."));
  expect(ids).toEqual([
    "extension.list",
    "extension.show",
    "extension.validate",
    "extension.build",
    "extension.diff",
    "extension.run",
    "extension.action",
    "extension.executions",
    "extension.execution",
    "extension.execution_log",
    "extension.execution_cancel",
    "extension.registry",
    "extension.install",
    "extension.catalog",
    "extension.operations",
    "extension.call",
  ]);
  expect(toolFor("extension.show")).toBe("ablationkit_read extension.show");
  expect(toolFor("extension.build")).toBe("ablationkit_do extension.build");
  expect(ids.some((n) => /approve|activate|enable|rollback|publish|disable/.test(n))).toBe(false);
  expect(
    MCP_TOOLS.some((t) => /approve|activate|enable|rollback|publish|disable/.test(t.name)),
  ).toBe(false);
});
