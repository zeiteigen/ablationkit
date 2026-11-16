/**
 * Opt-in (`bun run test:extensions`): criterion 15e with a real third-party wheel. An extension
 * declares `numpy==2.4.6` in its own pyproject and uv.lock; the build creates its environment with
 * `uv sync --locked --no-build` (from the uv cache or the index), and the approved analysis runs
 * under its limits with numpy, results logged to MLflow through the coordinator.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";

const ENABLED = process.env["ABLATIONKIT_EXTENSIONS_E2E"] === "1";
const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

describe.skipIf(!ENABLED)("Python extension with pinned dependencies (criterion 15e)", () => {
  test("numpy from the extension's own lockfile, under limits, results in MLflow", async () => {
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const cl = await h.start({
      trackingUrl: fake.url,
      trackingIntervalMs: 20,
      settings: {
        schema_version: 1,
        human: { host: "127.0.0.1", port: 0 },
        agent: { host: "127.0.0.1", port: 0 },
        worker: { host: "127.0.0.1", port: 0 },
        mlflow: { enabled: false },
      },
    });
    const token = await cl.session();
    const call = (path: string, body?: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: API JSON in assertions
      cl.json<any>(cl.human(path, { token, ...(body === undefined ? {} : { body }) }));
    const repo = h.repo("np");
    mkdirSync(join(repo, ".ablationkit/extensions"), { recursive: true });
    cpSync(
      resolve(import.meta.dir, "../../../fixtures/extensions/np-stats"),
      join(repo, ".ablationkit/extensions/np-stats"),
      { recursive: true },
    );
    writeFileSync(join(repo, "README.md"), "np\n");
    expect((await call("/api/v1/projects", { path: repo, project_id: "np" })).status).toBe(201);
    const s = h.coordinators[0]?.services;
    if (!s) throw new Error("no coordinator");
    const exp = await s.tracking.ensureExperimentNow("np");
    for (const loss of [0.1, 0.2, 0.3, 0.4]) {
      const r = await s.tracking.client.createRun({ experiment_id: exp, run_name: `r${loss}` });
      await s.tracking.client.logBatch({
        run_id: r.info.run_id,
        metrics: [{ key: "loss", value: loss, timestamp: 1, step: 0 }],
      });
    }
    const b = await call("/api/v1/projects/np/extensions/np-stats/build", {});
    expect(b.body.build.python.status, JSON.stringify(b.body.build.diagnostics)).toBe("ready");
    expect(b.body.build.python.packages).toContain("numpy==2.4.6");
    s.extensions.approve(
      "np",
      "np-stats",
      { build_id: b.body.build.build_id, trusted_code: true },
      { kind: "human" },
    );
    const x = await call("/api/v1/projects/np/extensions/np-stats/run", {
      contribution: "stats",
      params: { metric: "loss" },
    });
    expect(x.status).toBe(202);
    let done: Record<string, unknown> | undefined;
    for (let i = 0; i < 600 && !done; i++) {
      await Bun.sleep(100);
      const r = await call(
        `/api/v1/projects/np/extension-executions/${x.body.execution.execution_id}`,
      );
      if (r.body.execution.status !== "running") done = r.body.execution;
    }
    // biome-ignore lint/suspicious/noExplicitAny: API JSON in assertions
    const d = done as any;
    expect(d.status, d.error).toBe("succeeded");
    expect(d.result.data.numpy).toBe("2.4.6");
    expect(Number(d.result.metrics["loss.mean"])).toBeCloseTo(0.25, 6);
    expect(d.record.environment.environment_sha256).toBe(b.body.build.python.environment_sha256);
    expect(fake.run(d.mlflow_run_id)?.tags.get("ablationkit.extension")).toBe("np-stats");
  }, 600_000);
});
