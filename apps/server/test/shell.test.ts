/**
 * Web shell routes (Stage 6): static serving of the web bundle, status bar summary, attention
 * inbox, task profiles, Study/Variant aggregation and downsampled metric series.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MlflowRun } from "@ablationkit/tracking-mlflow";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { NO_VARIANT, stats, studyView, summarizeStudies } from "../src/research/studies.ts";
import { APP_CSP, webResponse } from "../src/web.ts";
import { Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const fake = new FakeMlflow().start();
  fakes.push(fake);
  const cl = await h.start({ trackingUrl: fake.url, trackingIntervalMs: 20 });
  const token = await cl.session();
  const call = <T = Record<string, unknown>>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) => cl.json<T>(cl.human(path, { token, ...init }));
  return { fake, cl, token, call };
}

async function until(cond: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not met in time");
}

async function project(call: Awaited<ReturnType<typeof setup>>["call"], id = "demo") {
  const repo = h.repo(id);
  const r = await call("/api/v1/projects", { body: { path: repo, project_id: id } });
  expect(r.status).toBe(201);
  await until(async () => {
    const t = await call<{ links: { experiment_id?: string } }>(`/api/v1/projects/${id}/tracking`);
    return t.body.links.experiment_id !== undefined;
  });
  return repo;
}

function run(
  id: string,
  tags: Record<string, string>,
  metrics: Record<string, number>,
  params: Record<string, string> = {},
): MlflowRun {
  return {
    info: {
      run_id: id,
      experiment_id: "1",
      status: "FINISHED",
      start_time: Number(id.replace(/\D/g, "")) || 0,
      lifecycle_stage: "active",
    },
    data: {
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      metrics: Object.entries(metrics).map(([key, value]) => ({
        key,
        value,
        step: 0,
        timestamp: 0,
      })),
      params: Object.entries(params).map(([key, value]) => ({ key, value })),
    },
  };
}

describe("study aggregation (spec §6.1)", () => {
  test("stats: mean, sample std, min, max; std needs two values", () => {
    expect(stats([])).toBeUndefined();
    expect(stats([2])).toEqual({ n: 1, mean: 2, min: 2, max: 2 });
    const s = stats([1, 2, 3, 4]);
    expect(s?.mean).toBe(2.5);
    expect(s?.std).toBeCloseTo(Math.sqrt(5 / 3), 12);
    expect(stats([1, Number.NaN, 3])?.n).toBe(2);
  });

  test("variants aggregate repeated runs; differing params describe the study", () => {
    const S = "ablationkit.study_id";
    const V = "ablationkit.variant_id";
    const runs = [
      run("r1", { [S]: "s", [V]: "base" }, { loss: 1 }, { lr: "0.1", seed: "0" }),
      run("r2", { [S]: "s", [V]: "base" }, { loss: 3 }, { lr: "0.1", seed: "1" }),
      run("r3", { [S]: "s", [V]: "hi" }, { loss: 0.5, acc: 0.9 }, { lr: "0.5", seed: "0" }),
      run("r4", { [S]: "s" }, { loss: 9 }, { lr: "0.1" }),
      run("r5", { [S]: "other", [V]: "x" }, { loss: 7 }),
      run("r6", {}, { loss: 7 }),
    ];
    const v = studyView("s", runs);
    expect(v.variants.map((x) => x.variant_id)).toEqual(["base", "hi", NO_VARIANT]);
    const base = v.variants[0];
    expect(base?.metrics["loss"]).toMatchObject({ n: 2, mean: 2, min: 1, max: 3 });
    expect(base?.params).toEqual({ lr: "0.1" });
    expect(base?.varying_params).toEqual(["seed"]);
    expect(v.metric_keys).toEqual(["acc", "loss"]);
    expect(v.differing_params).toEqual(["lr"]);

    const sums = summarizeStudies(runs);
    expect(sums.map((x) => [x.study_id, x.variants, x.runs])).toEqual([
      ["other", 1, 1],
      ["s", 3, 4],
    ]);
  });
});

describe("web bundle serving", () => {
  function dist(): string {
    const d = mkdtempSync(join(tmpdir(), "ak-dist-"));
    dirs.push(d);
    writeFileSync(join(d, "index.html"), "<!doctype html><title>AblationKit</title>");
    writeFileSync(join(d, "chunk-abcd1234.js"), "console.log(1)");
    mkdirSync(join(d, "sub"));
    return d;
  }

  test("client routes get index.html with a strict CSP; hashed assets are immutable", async () => {
    const d = dist();
    const page = webResponse("/p/demo/runs/r/abc", d);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toBe(APP_CSP);
    expect(APP_CSP).toContain("script-src 'self'");
    expect(APP_CSP).not.toContain("unsafe-inline");
    expect(APP_CSP).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("AblationKit");

    const js = webResponse("/chunk-abcd1234.js", d);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("paths never escape the bundle directory", async () => {
    const d = dist();
    writeFileSync(join(d, "..", `secret-${d.split("/").at(-1)}`), "nope");
    for (const p of ["/../secret", "/%2e%2e/%2e%2e/etc/passwd", "/sub", "/%zz"]) {
      const r = webResponse(p, d);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(await r.text()).toContain("<title>AblationKit</title>");
    }
    rmSync(join(d, "..", `secret-${d.split("/").at(-1)}`));
  });

  test("an unbuilt bundle serves the sign-in page with build instructions", async () => {
    const r = webResponse("/", join(tmpdir(), "ak-no-such-dist"));
    expect(await r.text()).toContain("bun run web:build");
  });

  test("the human listener serves the app for non-API paths and 404s unknown API paths", async () => {
    const cl = await h.start();
    const page = await cl.human("/p/demo/runs");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const api = await cl.human("/api/v1/nope");
    expect(api.status).toBe(404);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe("not_found");
    // Unknown hosts are still refused before anything is served.
    expect((await cl.human("/p/demo", { host: "evil.example:80" })).status).toBe(421);
  });
});

describe("shell routes", () => {
  test("status bar summary never reports unbuilt integrations as healthy", async () => {
    const { call } = await setup();
    const unauth = await h.coordinators[0]?.urls.human;
    expect((await fetch(`${unauth}/api/v1/shell/status`)).status).toBe(401);
    const s = await call<Record<string, Record<string, unknown>>>("/api/v1/shell/status");
    expect(s.status).toBe(200);
    expect(s.body["coordinator"]).toMatchObject({ state: "ok", active: true });
    expect(s.body["mlflow"]?.["state"]).toBe("external");
    expect(s.body["t3"]).toBeUndefined();
    expect(s.body["offline"]).toMatchObject({
      available: true,
      reconcile_required: 0,
      disconnected: 0,
      remote_attempts: 0,
    });
    // A checkout run, not a Level 2 build (ADR 0022); safe mode off.
    expect(s.body["build"]).toMatchObject({ modified: "no" });
    expect(s.body["safe_mode"] as unknown).toBe(false);
    expect(["enforced", "advisory"]).toContain(String(s.body["compute"]?.["enforcement"]));
    expect(s.body["sync"]).toMatchObject({ pending: 0, failed: 0 });
  });

  test("inbox lists rejected MLflow writes as sync_failed; later sources are marked unavailable", async () => {
    const { call, fake } = await setup();
    await project(call);
    const empty = await call<{
      items: unknown[];
      sources: { kind: string; available: boolean }[];
    }>("/api/v1/inbox");
    expect(empty.body.items).toEqual([]);
    expect(empty.body.sources.find((s) => s.kind === "sync_failed")?.available).toBe(true);
    // Agent requests and plans wait in the agent's own harness now (ADR 0039).
    expect(empty.body.sources.map((s) => s.kind)).not.toContain("agent_request");
    expect(empty.body.sources.map((s) => s.kind)).not.toContain("plan_approval");
    expect(empty.body.sources.find((s) => s.kind === "reconcile_required")?.available).toBe(true);
    expect(empty.body.sources.find((s) => s.kind === "extension_approval")?.available).toBe(false);

    fake.intercept = (path) =>
      path.endsWith("runs/log-batch")
        ? Response.json(
            { error_code: "INVALID_PARAMETER_VALUE", message: "bad metric" },
            { status: 400 },
          )
        : undefined;
    const created = await call<{ ref: string }>("/api/v1/tracking/runs", {
      body: { project_id: "demo", metrics: [{ key: "x", value: 1, timestamp: 1, step: 0 }] },
    });
    await until(async () => {
      const i = await call<{ items: { kind: string; ref?: string }[] }>("/api/v1/inbox");
      return i.body.items.some((x) => x.kind === "sync_failed" && x.ref === created.body.ref);
    });
    const s = await call<{ inbox: { count: number }; sync: { failed: number } }>(
      "/api/v1/shell/status",
    );
    expect(s.body.inbox.count).toBe(1);
    expect(s.body.sync.failed).toBeGreaterThan(0);
  });

  test("task profiles live in the repository manifest", async () => {
    const { call } = await setup();
    const repo = await project(call);
    const before = await call<{ task_profiles: string[]; manifest_found: boolean }>(
      "/api/v1/projects/demo/settings",
    );
    expect(before.body).toMatchObject({ task_profiles: [], manifest_found: true });
    const bad = await call("/api/v1/projects/demo/settings", {
      method: "PATCH",
      body: { task_profiles: ["llm", "quantum"] },
    });
    expect(bad.status).toBe(400);
    const ok = await call<{ task_profiles: string[] }>("/api/v1/projects/demo/settings", {
      method: "PATCH",
      body: { task_profiles: ["llm", "rag", "llm"] },
    });
    expect(ok.body.task_profiles).toEqual(["llm", "rag"]);
    const manifest = JSON.parse(readFileSync(join(repo, ".ablationkit/project.json"), "utf8"));
    expect(manifest.task_profiles).toEqual(["llm", "rag"]);
    const cleared = await call<{ task_profiles: string[] }>("/api/v1/projects/demo/settings", {
      method: "PATCH",
      body: { task_profiles: [] },
    });
    expect(cleared.body.task_profiles).toEqual([]);
    expect(
      JSON.parse(readFileSync(join(repo, ".ablationkit/project.json"), "utf8")),
    ).not.toHaveProperty("task_profiles");
  });

  test("studies and ablation aggregates from tagged runs", async () => {
    const { call } = await setup();
    await project(call);
    for (const [variant, losses] of [
      ["base", [1, 3]],
      ["hi", [0.5]],
    ] as const)
      for (const [i, loss] of losses.entries()) {
        const r = await call("/api/v1/tracking/runs", {
          body: {
            project_id: "demo",
            run_name: `${variant}-${i}`,
            study_id: "sweep",
            variant_id: variant,
            params: { lr: variant === "base" ? "0.1" : "0.5", seed: String(i) },
            metrics: [{ key: "loss", value: loss, timestamp: Date.now(), step: 0 }],
          },
        });
        expect(r.status).toBe(201);
      }
    const list = await call<{ studies: { study_id: string; variants: number; runs: number }[] }>(
      "/api/v1/projects/demo/studies",
    );
    expect(list.body.studies).toEqual([
      expect.objectContaining({ study_id: "sweep", variants: 2, runs: 3 }),
    ]);
    const d = await call<{
      variants: { variant_id: string; metrics: Record<string, { mean: number; n: number }> }[];
      differing_params: string[];
    }>("/api/v1/projects/demo/studies/sweep");
    expect(
      d.body.variants.map((v) => [v.variant_id, v.metrics["loss"]?.mean, v.metrics["loss"]?.n]),
    ).toEqual([
      ["base", 2, 2],
      ["hi", 0.5, 1],
    ]);
    expect(d.body.differing_params).toEqual(["lr"]);
    expect((await call("/api/v1/projects/demo/studies/nope")).status).toBe(404);
    expect((await call("/api/v1/projects/demo/studies/bad'id")).status).toBe(400);
  });

  test("metric series are downsampled for charts while raw history stays exact", async () => {
    const { call } = await setup();
    await project(call);
    const r = await call<{ ref: string; mlflow_run_id: string }>("/api/v1/tracking/runs", {
      body: { project_id: "demo" },
    });
    const metrics = Array.from({ length: 3000 }, (_, step) => ({
      key: "loss",
      value: 1 / (step + 1),
      step,
      timestamp: 1_000 + step,
    }));
    for (let i = 0; i < metrics.length; i += 1000)
      expect(
        (
          await call(`/api/v1/tracking/runs/${r.body.ref}/log`, {
            body: { metrics: metrics.slice(i, i + 1000) },
          })
        ).status,
      ).toBe(200);
    const s = await call<{
      x: string;
      series: {
        key: string;
        total: number;
        downsampled: boolean;
        points: [number, number, number][];
      }[];
    }>(`/api/v1/tracking/runs/${r.body.ref}/metrics/series?keys=loss,missing&points=100`);
    expect(s.status).toBe(200);
    const loss = s.body.series[0];
    expect(loss).toMatchObject({ key: "loss", total: 3000, downsampled: true });
    expect(loss?.points).toHaveLength(100);
    expect(loss?.points[0]).toEqual([0, 1000, 1]);
    expect(loss?.points.at(-1)).toEqual([2999, 3999, 1 / 3000]);
    expect(s.body.series[1]).toMatchObject({ key: "missing", total: 0, points: [] });

    const raw = await call<{ history: unknown[] }>(
      `/api/v1/tracking/runs/${r.body.ref}/metrics?key=loss`,
    );
    expect(raw.body.history).toHaveLength(3000);

    for (const q of ["", "?keys=", "?keys=loss&points=5", "?keys=loss&x=epoch"])
      expect((await call(`/api/v1/tracking/runs/${r.body.ref}/metrics/series${q}`)).status).toBe(
        400,
      );
  });

  test("run search filters by status, params and metrics", async () => {
    const { call } = await setup();
    await project(call);
    for (const [name, loss] of [
      ["a", 0.2],
      ["b", 0.8],
    ] as const)
      await call("/api/v1/tracking/runs", {
        body: {
          project_id: "demo",
          run_name: name,
          params: { opt: name === "a" ? "adam" : "sgd" },
          metrics: [{ key: "loss", value: loss, timestamp: 1, step: 0 }],
        },
      });
    const names = async (filter: string) =>
      (
        await call<{ runs: { info: { run_name: string } }[] }>(
          `/api/v1/tracking/runs?project=demo&filter=${encodeURIComponent(filter)}`,
        )
      ).body.runs
        .map((r) => r.info.run_name)
        .sort();
    expect(await names("metrics.loss < 0.5")).toEqual(["a"]);
    expect(await names("params.opt = 'sgd'")).toEqual(["b"]);
    expect(await names("attributes.status = 'RUNNING'")).toEqual(["a", "b"]);
    expect(await names("attributes.status = 'FINISHED'")).toEqual([]);
  });
});
