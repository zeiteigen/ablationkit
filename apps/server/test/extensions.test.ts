/**
 * The extension host against the fake MLflow and the fake bridge (criteria 15, 15a, 15b, 15e,
 * 15f, 9d; ADR 0022): discovery, validation, content-addressed builds, researcher-approved
 * activation per project, the sandboxed frame, the capability bridge's checks, disable, rollback,
 * safe mode, the registry, Python executions under limits, and the demo inference bridge.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { MAX_EXTENSION_BYTES, MAX_EXTENSION_FILES } from "@ablationkit/extension-host";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { unshareAvailable } from "../src/extensions/runner.ts";
import { Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
const FIXTURES = resolve(import.meta.dir, "../../../fixtures/extensions");
const FAKE_BRIDGE = resolve(import.meta.dir, "fake-bridge.ts");

afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

// biome-ignore lint/suspicious/noExplicitAny: loosely typed API JSON in assertions
type Json = any;

const SETTINGS: CoordinatorSettings = {
  schema_version: 1,
  human: { host: "127.0.0.1", port: 0 },
  agent: { host: "127.0.0.1", port: 0 },
  worker: { host: "127.0.0.1", port: 0 },
  mlflow: { enabled: false },
  jobs: { supervisor: "auto", deliver_deadline_sec: 30 },
};

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(50);
  }
}

/**
 * Most of this file exercises the approval workflow, so it runs with `require_approval` on; the
 * default (ADR 0045: enabled as built) has its own describe block below.
 */
async function setup(
  opts: { home?: string; fake?: FakeMlflow; safeMode?: boolean; requireApproval?: boolean } = {},
) {
  const fake = opts.fake ?? new FakeMlflow().start();
  if (!opts.fake) fakes.push(fake);
  const bridgeConfig = join(h.tmp("ak-bridge-"), "config.json");
  writeFileSync(bridgeConfig, "{}");
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    settings: {
      ...SETTINGS,
      extensions: { require_approval: opts.requireApproval ?? true },
    },
    bridgeCommand: [process.execPath, FAKE_BRIDGE, bridgeConfig],
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.safeMode ? { safeMode: true } : {}),
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  // A browser session (cookie and trusted origin), as the web UI approves and activates.
  const cookie = await cl.browserSession();
  const auth = { cookie, origin: cl.localOrigin };
  const browser = <T = Json>(path: string, body: unknown = {}) =>
    cl.json<T>(cl.human(path, { ...auth, body }));
  const svc = () => (h.coordinators.at(-1) as (typeof h.coordinators)[number]).services;
  const agentTokens = new Map<string, string>();
  const agent = async <T = Json>(
    pid: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) => {
    let t = agentTokens.get(pid);
    if (!t) {
      t = (await cl.agentSession(pid)).token;
      agentTokens.set(pid, t);
    }
    return cl.json<T>(cl.agent(path, { token: t, ...init }));
  };
  const config = (c: Json) => writeFileSync(bridgeConfig, JSON.stringify(c));
  return { fake, cl, call, browser, auth, agent, svc, config, home: cl.c.services.paths.home };
}
type World = Awaited<ReturnType<typeof setup>>;

async function project(w: World, id: string, exts: string[] = []): Promise<string> {
  const path = h.repo(id);
  for (const e of exts) install(path, e);
  expect((await w.call("/api/v1/projects", { body: { path, project_id: id } })).status).toBe(201);
  return path;
}

function install(path: string, ext: string): string {
  const dest = join(path, ".ablationkit/extensions", ext);
  mkdirSync(join(path, ".ablationkit/extensions"), { recursive: true });
  cpSync(join(FIXTURES, ext), dest, { recursive: true });
  return dest;
}

async function seedRun(w: World, pid: string, metrics: Record<string, number>): Promise<string> {
  const s = w.svc();
  const exp = await s.tracking.ensureExperimentNow(pid);
  const run = await s.tracking.client.createRun({ experiment_id: exp, run_name: `run ${pid}` });
  await s.tracking.client.logBatch({
    run_id: run.info.run_id,
    metrics: Object.entries(metrics).map(([key, value]) => ({ key, value, timestamp: 1, step: 0 })),
  });
  return run.info.run_id;
}

async function buildAndApprove(w: World, pid: string, ext: string): Promise<string> {
  const b = await w.call(`/api/v1/projects/${pid}/extensions/${ext}/build`, { body: {} });
  if (b.status !== 201) throw new Error(`build ${ext}: ${b.status} ${JSON.stringify(b.body)}`);
  const a = await w.browser(`/api/v1/projects/${pid}/extensions/${ext}/approve`, {
    build_id: b.body.build.build_id,
    trusted_code: true,
  });
  expect(a.status).toBe(200);
  return b.body.build.build_id as string;
}

const rpc = (w: World, pid: string, ext: string, body: Json) =>
  w.call(`/api/v1/projects/${pid}/extensions/${ext}/rpc`, { body });

const auditText = (w: World) => {
  const d = w.svc().paths.auditDir;
  return readdirSync(d)
    .map((f) => readFileSync(join(d, f), "utf8"))
    .join("");
};

describe("extension lifecycle (criteria 15, 15a, 15f)", () => {
  test("an agent-authored extension is validated and built, approved by the researcher, mounted in a sandbox, disabled, changed and rolled back", async () => {
    const w = await setup();
    const path = await project(w, "p", ["run-inspector"]);
    const P = "/api/v1/projects/p/extensions";

    // Discovered from the checkout; nothing runs before a build and an approval.
    const list = await w.call(P);
    expect(list.body.extensions).toHaveLength(1);
    expect(list.body.extensions[0]).toMatchObject({
      extension_id: "run-inspector",
      status: "needs_build",
      enabled: false,
    });
    expect((await w.call("/api/v1/projects/p/extension-mounts")).body.mounts).toEqual([]);

    // The agent can validate and build (no source edits to AblationKit), never approve.
    const v = await w.agent("p", `${P}/run-inspector/validate`, { body: {} });
    expect(v.status).toBe(200);
    expect(v.body.ok).toBe(true);
    const built = await w.agent("p", `${P}/run-inspector/build`, { body: {} });
    expect(built.status).toBe(201);
    const eb1 = built.body.build.build_id as string;
    expect(built.body.build).toMatchObject({ status: "ready", version: "0.1.0" });
    expect(built.body.build.ui.map((u: Json) => u.contribution).sort()).toEqual(["panel", "tab"]);
    // Rebuilding identical source is idempotent (content-addressed).
    expect((await w.call(`${P}/run-inspector/build`, { body: {} })).body.build.build_id).toBe(eb1);
    expect(
      (
        await w.agent("p", `${P}/run-inspector/approve`, {
          body: { build_id: eb1, trusted_code: true },
        })
      ).status,
    ).toBe(404);
    expect((await w.call(`${P}/run-inspector`)).body.extension.status).toBe("needs_approval");

    // Approval needs the trusted-code acknowledgement.
    expect((await w.browser(`${P}/run-inspector/approve`, { build_id: eb1 })).body.error.code).toBe(
      "trusted_code_ack_required",
    );
    const ok = await w.browser(`${P}/run-inspector/approve`, {
      build_id: eb1,
      trusted_code: true,
      note: "reviewed",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.state.approvals[0]).toMatchObject({
      build_id: eb1,
      trusted_code: true,
    });
    const detail = (await w.call(`${P}/run-inspector`)).body.extension;
    expect(detail.status).toBe("active");
    expect(detail.permissions.map((x: Json) => x.capability)).toEqual([
      "project.runs.read",
      "project.research.write",
    ]);
    expect(auditText(w)).toContain('"action":"extension.approve"');

    // Mounted contributions: two views and an action.
    const mounts = (await w.call("/api/v1/projects/p/extension-mounts")).body.mounts;
    expect(mounts.map((m: Json) => m.contribution.point).sort()).toEqual([
      "project.action",
      "project.panel",
      "run.tab",
    ]);
    const tab = mounts.find((m: Json) => m.contribution.point === "run.tab");
    expect(tab.frame_url).toBe(`/ext-frame/p/run-inspector/${eb1}/tab`);

    // The frame is an opaque-origin sandbox with no network (criterion 15).
    const frame = await w.cl.human(tab.frame_url, { cookie: w.auth.cookie });
    expect(frame.status).toBe(200);
    const csp = frame.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain(`frame-ancestors ${w.cl.localOrigin}`);
    const html = await frame.text();
    expect(html).toContain('<div id="root">');
    expect(html).not.toContain("ak_session");
    expect(html).not.toContain(w.fake.url);
    // No session, no frame.
    expect((await w.cl.human(tab.frame_url)).status).toBe(401);

    // The bridge: a project run is readable; the action creates an attributed note.
    const runId = await seedRun(w, "p", { loss: 0.5 });
    const got = await rpc(w, "p", "run-inspector", {
      build_id: eb1,
      contribution: "tab",
      method: "runs.get",
      params: { run_id: runId },
    });
    expect(got.status).toBe(200);
    expect(got.body.result.metrics.loss).toBe(0.5);
    const act = await w.agent("p", `${P}/run-inspector/actions/note`, { body: {} });
    expect(act.status).toBe(200);
    const note = w.svc().research.get("p", act.body.result.record_id);
    expect(note).toMatchObject({
      kind: "note",
      title: "Checkpoint",
      tags: ["extension:run-inspector"],
    });

    // Disable: nothing mounts or answers; core stays usable.
    expect(
      (await w.call(`${P}/run-inspector/disable`, { body: { reason: "testing" } })).status,
    ).toBe(200);
    expect((await w.call("/api/v1/projects/p/extension-mounts")).body.mounts).toEqual([]);
    const off = await rpc(w, "p", "run-inspector", {
      build_id: eb1,
      contribution: "tab",
      method: "runs.get",
      params: { run_id: runId },
    });
    expect(off.body.error.code).toBe("extension_inactive");
    expect((await w.cl.human(tab.frame_url, { cookie: w.auth.cookie })).status).toBe(403);
    expect((await w.call(`/api/v1/tracking/runs?project=p`)).body.runs).toHaveLength(1);
    expect((await w.browser(`${P}/run-inspector/enable`)).status).toBe(200);

    // Changing the source does not change what runs: the approved snapshot keeps running and the
    // change needs its own build and approval (criterion 15f).
    const view = join(path, ".ablationkit/extensions/run-inspector/ui/src/format.ts");
    writeFileSync(view, `${readFileSync(view, "utf8")}\nexport const changed = true;\n`);
    expect((await w.call(`${P}/run-inspector`)).body.extension.status).toBe("active_outdated");
    expect((await w.call("/api/v1/projects/p/extension-mounts")).body.mounts[0].build_id).toBe(eb1);
    const b2 = await w.call(`${P}/run-inspector/build`, { body: {} });
    const eb2 = b2.body.build.build_id as string;
    expect(eb2).not.toBe(eb1);
    const diff = await w.call(`${P}/run-inspector/builds/${eb2}/diff`);
    expect(diff.body.against).toBe(eb1);
    expect(diff.body.changes).toEqual([
      expect.objectContaining({ path: "ui/src/format.ts", change: "modified" }),
    ]);
    expect(diff.body.capabilities_changed).toBe(false);
    await w.browser(`${P}/run-inspector/approve`, { build_id: eb2, trusted_code: true });
    expect((await w.call(`${P}/run-inspector`)).body.extension.status).toBe("active");

    // A new capability is a new approval too.
    const m = join(path, ".ablationkit/extensions/run-inspector/manifest.json");
    const manifest = JSON.parse(readFileSync(m, "utf8"));
    manifest.capabilities.push("project.artifacts.preview");
    writeFileSync(m, JSON.stringify(manifest));
    const b3 = await w.call(`${P}/run-inspector/build`, { body: {} });
    expect(
      (await w.call(`${P}/run-inspector/builds/${b3.body.build.build_id}/diff`)).body
        .capabilities_changed,
    ).toBe(true);

    // Roll back to the first approved build.
    const rb = await w.browser(`${P}/run-inspector/rollback`, { build_id: eb1 });
    expect(rb.body.state.active_build).toBe(eb1);
    expect((await w.call("/api/v1/projects/p/extension-mounts")).body.mounts[0].build_id).toBe(eb1);
    // An unapproved build cannot be rolled back to.
    expect(
      (await w.browser(`${P}/run-inspector/rollback`, { build_id: b3.body.build.build_id })).body
        .error.code,
    ).toBe("not_approved");
    expect(auditText(w)).toContain('"action":"extension.rollback"');
  });

  test("the bridge checks project, build, contribution, method and capability on every call (criterion 15)", async () => {
    const w = await setup();
    await project(w, "p", ["run-inspector"]);
    await project(w, "q");
    const eb = await buildAndApprove(w, "p", "run-inspector");
    const own = await seedRun(w, "p", { loss: 1 });
    const other = await seedRun(w, "q", { loss: 2 });
    const call = (method: string, params: Json = {}, extra: Json = {}) =>
      rpc(w, "p", "run-inspector", { build_id: eb, contribution: "tab", method, params, ...extra });
    expect((await call("runs.get", { run_id: own })).status).toBe(200);
    // Another project's run does not exist from this view.
    const cross = await call("runs.get", { run_id: other });
    expect(cross.status).toBe(404);
    expect((await call("runs.list")).body.result.runs.map((r: Json) => r.run_id)).toEqual([own]);
    // Not granted, not a method, wrong build, wrong contribution.
    expect((await call("research.list")).body.error.code).toBe("capability_denied");
    expect((await call("inference.predict", { model: "x" })).body.error.code).toBe(
      "capability_denied",
    );
    expect((await call("mlflow.raw", {})).body.error.code).toBe("method_not_allowed");
    expect((await call("runs.list", {}, { build_id: "eb-0000000000000000" })).body.error.code).toBe(
      "extension_changed",
    );
    expect((await call("runs.list", {}, { contribution: "note" })).body.error.code).toBe(
      "unknown_contribution",
    );
    // The same extension in another project is not approved there.
    expect(
      (
        await rpc(w, "q", "run-inspector", {
          build_id: eb,
          contribution: "tab",
          method: "runs.list",
          params: {},
        })
      ).body.error.code,
    ).toBe("extension_inactive");
    // The agent listener has no bridge.
    expect(
      (await w.agent("p", "/api/v1/projects/p/extensions/run-inspector/rpc", { body: {} })).status,
    ).toBe(404);
    expect(auditText(w)).toContain('"outcome":"denied"');
  });

  test("safe mode keeps every extension inactive while disable and rollback stay available", async () => {
    const w = await setup();
    await project(w, "p", ["run-inspector"]);
    const eb = await buildAndApprove(w, "p", "run-inspector");
    const home = w.home;
    await h.coordinators[0]?.stop();
    const s = await setup({ home, safeMode: true });
    const list = await s.call("/api/v1/projects/p/extensions");
    expect(list.body.safe_mode).toBe(true);
    expect(list.body.extensions[0].status).toBe("safe_mode");
    expect((await s.call("/api/v1/projects/p/extension-mounts")).body.mounts).toEqual([]);
    expect(
      (
        await rpc(s, "p", "run-inspector", {
          build_id: eb,
          contribution: "tab",
          method: "runs.list",
          params: {},
        })
      ).body.error.code,
    ).toBe("safe_mode");
    expect(
      (await s.call("/api/v1/projects/p/extensions/run-inspector/disable", { body: {} })).status,
    ).toBe(200);
  });
});

describe("enabled as built (ADR 0045, the default)", () => {
  test("an agent's build is enabled at once, bound to its hashes; the researcher's disable survives a rebuild", async () => {
    const w = await setup({ requireApproval: false });
    const path = await project(w, "p", ["run-inspector"]);
    const P = "/api/v1/projects/p/extensions/run-inspector";
    const built = await w.agent("p", `${P}/build`, { body: {} });
    expect(built.status).toBe(201);
    const eb = built.body.build.build_id as string;
    const ext = (await w.call(P)).body.extension;
    expect(ext.status).toBe("active");
    const st = (await w.call(P)).body;
    expect(JSON.stringify(st)).toContain(eb);
    expect(auditText(w)).toContain('"extension.enable_on_build"');
    expect(
      (await w.call("/api/v1/projects/p/extension-mounts")).body.mounts.length,
    ).toBeGreaterThan(0);
    // The researcher disables it; a changed source builds, but stays disabled.
    expect((await w.call(`${P}/disable`, { body: { reason: "not now" } })).status).toBe(200);
    writeFileSync(
      join(path, ".ablationkit/extensions/run-inspector/README.md"),
      "changed after the disable\n",
    );
    const again = await w.agent("p", `${P}/build`, { body: {} });
    expect(again.status).toBe(201);
    expect(again.body.build.build_id).not.toBe(eb);
    expect((await w.call(P)).body.extension.enabled).toBe(false);
  });

  test("a build made while approval was required is enabled when it is built again", async () => {
    const before = await setup({ requireApproval: true });
    await project(before, "p", ["run-inspector"]);
    const P = "/api/v1/projects/p/extensions/run-inspector";
    const eb = (await before.agent("p", `${P}/build`, { body: {} })).body.build.build_id;
    expect((await before.call(P)).body.extension.status).toBe("needs_approval");
    await before.cl.c.stop();
    const after = await setup({ requireApproval: false, home: before.home, fake: before.fake });
    expect((await after.call(P)).body.extension.status).toBe("needs_approval");
    const again = await after.agent("p", `${P}/build`, { body: {} });
    expect(again.body.build.build_id).toBe(eb);
    expect((await after.call(P)).body.extension.status).toBe("active");
  });

  test("an agent's Python run is decided by the project policy (jobs.run_local)", async () => {
    const w = await setup({ requireApproval: false });
    await project(w, "p", ["py-evaluator"]);
    const runId = await seedRun(w, "p", { loss: 0.5 });
    const P = "/api/v1/projects/p/extensions/py-evaluator";
    expect((await w.agent("p", `${P}/build`, { body: {} })).status).toBe(201);
    const s = w.svc();
    const cur = s.policy.current("p");
    const {
      schema_version: _s,
      project_id: _p,
      revision: _r,
      created_at: _c,
      created_by: _b,
      ...rest
    } = cur;
    const revised = await w.call("/api/v1/projects/p/policy/revisions", {
      body: { policy: { ...rest, jobs: { ...cur.jobs, run_local: { decision: "deny" } } } },
    });
    expect(revised.status).toBe(201);
    const body = {
      contribution: "evaluate",
      params: { scale: 2 },
      refs: [{ kind: "run", id: runId }],
    };
    const refused = await w.agent("p", `${P}/run`, { body });
    expect([refused.status, refused.body.error.code]).toEqual([403, "policy_denied"]);
    // The researcher's own run is not an agent action.
    expect((await w.call(`${P}/run`, { body })).status).toBe(202);
  });
});

describe("warm workers (ADR 0047)", () => {
  test("python.warm keeps one process per build: state persists, an error does not kill it, a timeout replaces it, disable stops it", async () => {
    const w = await setup({ requireApproval: false });
    const path = await project(w, "p", []);
    const dest = install(path, "py-evaluator");
    const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
    manifest.id = "py-evaluator";
    manifest.contributes = [
      { id: "tick", point: "project.analysis", title: "Tick", entry: "python/warm.py:tick" },
    ];
    manifest.python = { ...manifest.python, warm: true, max_runtime_seconds: 3 };
    manifest.capabilities = ["project.analysis.execute"];
    writeFileSync(join(dest, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(
      join(dest, "python/warm.py"),
      [
        "import os, time",
        "from ablationkit_extension import ExtensionResult",
        "COUNT = 0",
        "def tick(ctx, params):",
        "    global COUNT",
        "    COUNT += 1",
        "    print('tick', COUNT)",
        "    if params.get('sleep'):",
        "        time.sleep(float(params['sleep']))",
        "    if params.get('crash'):",
        "        raise RuntimeError('boom')",
        "    return ExtensionResult(summary='ok', data={'count': COUNT, 'pid': os.getpid()})",
        "",
      ].join("\n"),
    );
    const P = "/api/v1/projects/p/extensions/py-evaluator";
    expect((await w.call(`${P}/build`, { body: {} })).status).toBe(201);
    const run = async (params: Json = {}) => {
      const s = await w.call(`${P}/run`, { body: { contribution: "tick", params } });
      expect(s.status).toBe(202);
      const xid = s.body.execution.execution_id as string;
      return until(async () => {
        const r = await w.call(`/api/v1/projects/p/extension-executions/${xid}`);
        return r.body.execution.status !== "running" && r.body.execution;
      });
    };
    const a = await run();
    const b = await run();
    expect([a.status, b.status]).toEqual(["succeeded", "succeeded"]);
    expect([a.result.data.count, b.result.data.count]).toEqual([1, 2]);
    expect(b.result.data.pid).toBe(a.result.data.pid);
    expect([a.warm.reused, b.warm.reused]).toEqual([false, true]);
    // Each run's log holds its own output.
    const logOf = async (xid: string) =>
      (
        await w.cl.human(`/api/v1/projects/p/extension-executions/${xid}/log`, {
          cookie: w.auth.cookie,
        })
      ).text();
    expect(await logOf(b.execution_id)).toContain("tick 2");
    expect(await logOf(b.execution_id)).not.toContain("tick 1");
    // An error is the run's, not the worker's.
    const c = await run({ crash: true });
    expect(c.status).toBe("failed");
    const d = await run();
    expect([d.result.data.count, d.result.data.pid]).toEqual([4, a.result.data.pid]);
    // The time limit applies to each run: the worker is replaced.
    const slow = await run({ sleep: 10 });
    expect(slow.status).toBe("timed_out");
    const e = await run();
    expect(e.result.data.count).toBe(1);
    expect(e.result.data.pid).not.toBe(a.result.data.pid);
    expect(e.warm.reused).toBe(false);
    // Disabling the extension stops its worker.
    const worker = e.result.data.pid as number;
    expect((await w.call(`${P}/disable`, { body: { reason: "done" } })).status).toBe(200);
    await until(async () => {
      try {
        process.kill(worker, 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000);
  }, 120_000);
});

describe("project environment (ADR 0046)", () => {
  test("a Python contribution imports the project's own package as of its commit; a new commit is a new build", async () => {
    const w = await setup({ requireApproval: false });
    const repo = h.repo("pe");
    const git = (...a: string[]) => {
      const r = Bun.spawnSync(["git", "-C", repo, ...a], {
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "r",
          GIT_AUTHOR_EMAIL: "r@r",
          GIT_COMMITTER_NAME: "r",
          GIT_COMMITTER_EMAIL: "r@r",
        },
      });
      if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
      return r.stdout.toString().trim();
    };
    rmSync(join(repo, ".git"), { recursive: true });
    git("init", "-q");
    writeFileSync(
      join(repo, "pyproject.toml"),
      [
        "[project]",
        'name = "demo-proj"',
        'version = "0.1.0"',
        'requires-python = ">=3.10"',
        "dependencies = []",
        "",
        "[build-system]",
        'requires = ["hatchling"]',
        'build-backend = "hatchling.build"',
        "",
      ].join("\n"),
    );
    mkdirSync(join(repo, "src/demo_proj"), { recursive: true });
    writeFileSync(join(repo, "src/demo_proj/__init__.py"), 'VALUE = "committed"\n');
    const lock = Bun.spawnSync(["uv", "lock", "--project", repo], { stderr: "pipe" });
    expect(lock.exitCode).toBe(0);
    const ext = join(repo, ".ablationkit/extensions/proj-probe");
    mkdirSync(join(ext, "python"), { recursive: true });
    writeFileSync(
      join(ext, "manifest.json"),
      JSON.stringify({
        schema_version: 1,
        id: "proj-probe",
        version: "0.1.0",
        name: "Project probe",
        host_api: "^1.0.0",
        contributes: [
          {
            id: "probe",
            point: "project.analysis",
            title: "Probe",
            entry: "python/probe.py:probe",
          },
        ],
        python: {
          requires_python: ">=3.10",
          environment: "project",
          max_runtime_seconds: 30,
          max_memory_mb: 256,
          gpu: false,
          network: "none",
        },
        capabilities: ["project.analysis.execute"],
      }),
    );
    writeFileSync(
      join(ext, "python/probe.py"),
      [
        "import os",
        "import demo_proj",
        "from ablationkit_extension import ExtensionResult",
        "def probe(ctx, params):",
        '    return ExtensionResult(summary="ok", data={"value": demo_proj.VALUE, "checkout": os.environ.get("ABLATIONKIT_CHECKOUT")})',
        "",
      ].join("\n"),
    );
    git("add", "-A");
    git("commit", "-qm", "first");
    const head = git("rev-parse", "HEAD");
    // An uncommitted edit is not what the environment holds: it is built from the commit.
    writeFileSync(join(repo, "src/demo_proj/__init__.py"), 'VALUE = "working tree"\n');
    expect(
      (await w.call("/api/v1/projects", { body: { path: repo, project_id: "pe" } })).status,
    ).toBe(201);
    const P = "/api/v1/projects/pe/extensions/proj-probe";
    const b1 = await w.agent("pe", `${P}/build`, { body: {} });
    expect([b1.status, b1.body.build?.status, b1.body.build?.diagnostics]).toEqual([
      201,
      "ready",
      [],
    ]);
    expect(b1.body.build.python.project_commit).toBe(head);
    const started = await w.agent("pe", `${P}/run`, { body: { contribution: "probe" } });
    expect(started.status).toBe(202);
    const xid = started.body.execution.execution_id as string;
    const done = await until(async () => {
      const r = await w.call(`/api/v1/projects/pe/extension-executions/${xid}`);
      return r.body.execution.status !== "running" && r.body.execution;
    });
    expect(done.status).toBe("succeeded");
    expect(done.result.data).toEqual({ value: "committed", checkout: repo });
    // Remote targets cannot hold the project's environment.
    const remote = await w.call(`${P}/run`, { body: { contribution: "probe", target_id: "gpu" } });
    expect(remote.status).toBe(400);
    // A new commit of the project makes a new build.
    git("commit", "-qam", "second");
    const b2 = await w.agent("pe", `${P}/build`, { body: {} });
    expect(b2.body.build.build_id).not.toBe(b1.body.build.build_id);
    expect(b2.body.build.python.project_commit).toBe(git("rev-parse", "HEAD"));
  }, 120_000);
});

describe("hostile extensions (criterion 15)", () => {
  test("source: a symlink, an oversized file or too many files never build", async () => {
    const w = await setup();
    const path = await project(w, "p", ["run-inspector"]);
    const dir = join(path, ".ablationkit/extensions/run-inspector");
    const secret = join(h.tmp("ak-secret-"), "id_rsa");
    writeFileSync(secret, "PRIVATE KEY");
    const P = "/api/v1/projects/p/extensions/run-inspector";
    const codes = async () => {
      const b = await w.call(`${P}/build`, { body: {} });
      expect(b.status).toBe(422);
      expect(JSON.stringify(b.body)).not.toContain("PRIVATE KEY");
      return (b.body.diagnostics ?? b.body.error?.diagnostics ?? b.body.build.diagnostics).map(
        (x: Json) => x.code,
      );
    };
    symlinkSync(secret, join(dir, "ui/src/key.txt"));
    symlinkSync("/etc", join(dir, "ui/etc"));
    expect((await codes()).filter((c: string) => c === "symlink_not_allowed")).toHaveLength(2);
    rmSync(join(dir, "ui/src/key.txt"));
    rmSync(join(dir, "ui/etc"));
    // One sparse file over the limit: reported without reading it into memory.
    const big = join(dir, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, MAX_EXTENSION_BYTES + 1);
    expect(await codes()).toContain("too_large");
    rmSync(big);
    for (let i = 0; i <= MAX_EXTENSION_FILES; i++) writeFileSync(join(dir, `f${i}.txt`), "");
    expect(await codes()).toContain("too_large");
  }, 60_000);

  test("a tampered snapshot: the frame and the Python runner refuse bytes that were not approved", async () => {
    const w = await setup();
    await project(w, "p", ["run-inspector", "py-evaluator"]);
    const eb = await buildAndApprove(w, "p", "run-inspector");
    const buildDir = w.svc().extensions.buildDir("p", "run-inspector", eb);
    const mounts = (await w.call("/api/v1/projects/p/extension-mounts")).body.mounts as Json[];
    const url = mounts[0].frame_url as string;
    const ok = await w.cl.human(url, { cookie: w.auth.cookie });
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
    const ui = readdirSync(join(buildDir, "ui")).filter((f) => f.endsWith(".js"));
    const js = join(buildDir, "ui", ui[0] as string);
    for (const f of ui) appendFileSync(join(buildDir, "ui", f), "\nfetch('//evil');\n");
    const bad = await w.cl.json<{ error: { code: string } }>(
      w.cl.human(url, { cookie: w.auth.cookie }),
    );
    expect([bad.status, bad.body.error.code]).toEqual([409, "bundle_tampered"]);
    expect(existsSync(js)).toBe(true);

    const pyb = await buildAndApprove(w, "p", "py-evaluator");
    const src = join(w.svc().extensions.buildDir("p", "py-evaluator", pyb), "src", "python");
    const P = "/api/v1/projects/p/extensions/py-evaluator";
    const run = () => w.call(`${P}/run`, { body: { contribution: "summarize" } });
    const before = await run();
    expect(before.status).toBe(202);
    await until(async () => {
      const r = await w.call(
        `/api/v1/projects/p/extension-executions/${before.body.execution.execution_id}`,
      );
      return r.body.execution.status !== "running";
    });
    // A changed file, then a planted module that would shadow an import.
    const saved = readFileSync(join(src, "helpers.py"), "utf8");
    appendFileSync(join(src, "helpers.py"), "\nimport os; os.system('touch /tmp/owned')\n");
    const changed = await run();
    expect([changed.status, changed.body.error.code]).toEqual([409, "extension_changed"]);
    writeFileSync(join(src, "helpers.py"), saved);
    writeFileSync(join(src, "json.py"), "raise SystemExit('shadowed')\n");
    const planted = await run();
    expect([planted.status, planted.body.error.code]).toEqual([409, "extension_changed"]);
  }, 120_000);

  test("malicious bridge payloads are refused with a code, stay in the project, and leave the console bounded", async () => {
    const w = await setup();
    await project(w, "p", ["run-inspector"]);
    const eb = await buildAndApprove(w, "p", "run-inspector");
    const base = { build_id: eb, contribution: "tab" };
    const code = async (body: Json) => {
      const r = await rpc(w, "p", "run-inspector", body);
      return `${r.status} ${r.body.error?.code}`;
    };
    // Shapes.
    expect(await code({ ...base })).toBe("400 invalid_request");
    expect(await code({ ...base, method: 7 })).toBe("400 invalid_request");
    expect(await code({ ...base, method: "runs.list", params: [] })).toBe("400 invalid_request");
    expect(await code({ ...base, method: "runs.list", params: "x" })).toBe("400 invalid_request");
    // Names that exist on every object are not methods.
    for (const method of ["__proto__", "constructor", "toString", "hasOwnProperty", "mlflow.raw"])
      expect(await code({ ...base, method })).toBe("403 method_not_allowed");
    // A contribution that is not a view, an unknown one, and inherited names.
    for (const contribution of ["__proto__", "constructor", "nope"])
      expect(await code({ build_id: eb, contribution, method: "runs.list" })).toBe(
        "403 unknown_contribution",
      );
    // Hostile values inside a granted method: refused, never a server error.
    for (const run_id of ["../../etc/passwd", "__proto__", "", 7, null, { $ne: "" }, ["x"]]) {
      const r = await rpc(w, "p", "run-inspector", {
        ...base,
        method: "runs.get",
        params: { run_id },
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    // Prototype pollution through JSON: nothing lands on Object.prototype.
    const raw = (body: string) =>
      w.cl.human("/api/v1/projects/p/extensions/run-inspector/rpc", {
        method: "POST",
        cookie: w.auth.cookie,
        origin: w.auth.origin,
        headers: { "content-type": "application/json" },
        rawBody: body,
      });
    const polluted = await raw(
      JSON.stringify(base).replace(
        "{",
        '{"method":"context.get","params":{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}},',
      ),
    );
    await polluted.body?.cancel();
    expect(({} as Json)["polluted"]).toBeUndefined();
    // Bodies: not JSON, absurdly deep, and over the size limit.
    const notJson = await raw("{not json");
    expect(notJson.status).toBe(400);
    await notJson.body?.cancel();
    const deep = await raw(`{"params":${"[".repeat(200_000)}`);
    expect(deep.status).toBe(400);
    await deep.body?.cancel();
    const huge = await raw(
      JSON.stringify({ ...base, method: "runs.list", pad: "x".repeat(10_000_000) }),
    );
    expect(huge.status).toBe(413);
    await huge.body?.cancel();
    // Every refusal above logged a line; the console stays bounded and each line is capped.
    for (let i = 0; i < 300; i++)
      await rpc(w, "p", "run-inspector", { ...base, method: `spam.${"x".repeat(5000)}.${i}` });
    const lines = (await w.call("/api/v1/projects/p/extensions/run-inspector")).body.extension
      .console as { message: string }[];
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(Math.max(...lines.map((l) => l.message.length))).toBeLessThanOrEqual(4000);
    expect(auditText(w)).toContain('"action":"extension.rpc"');
  }, 120_000);

  test("Python results: artifacts outside the output area, links and oversized output are refused; the broker holds the line", async () => {
    const w = await setup();
    const path = await project(w, "p");
    const dest = install(path, "py-evaluator");
    const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
    const secret = join(h.tmp("ak-secret-"), "id_rsa");
    writeFileSync(secret, "PRIVATE KEY");
    for (const id of ["traverse", "absolute", "link", "linkdir", "oversize", "badresult", "broker"])
      manifest.contributes.push({
        id,
        point: "project.analysis",
        title: id,
        entry: `python/hostile.py:${id}`,
      });
    manifest.capability_config = { artifacts: { max_output_bytes: 2048 } };
    writeFileSync(join(dest, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(
      join(dest, "python/hostile.py"),
      `import os
from ablationkit_extension import ArtifactRef, ExtensionResult

def traverse(ctx, params):
    return ExtensionResult(summary="x", artifacts=[ArtifactRef("../../../../etc/passwd")])

def absolute(ctx, params):
    return ExtensionResult(summary="x", artifacts=[ArtifactRef("/etc/passwd")])

def link(ctx, params):
    os.symlink(${JSON.stringify(secret)}, ctx.outputs_dir / "stolen.txt")
    return ExtensionResult(summary="x", artifacts=[ArtifactRef("stolen.txt")])

def linkdir(ctx, params):
    os.symlink(os.path.dirname(${JSON.stringify(secret)}), ctx.outputs_dir / "d")
    return ExtensionResult(summary="x", artifacts=[ArtifactRef("d/id_rsa")])

def oversize(ctx, params):
    (ctx.outputs_dir / "big.bin").write_bytes(b"x" * 5000)
    return ExtensionResult(summary="x", artifacts=[ArtifactRef("big.bin")])

def badresult(ctx, params):
    return {"summary": 7, "artifacts": "nope"}

def broker(ctx, params):
    out = {}
    for method, args in [
        ("mlflow.raw", {}),
        ("__proto__", {}),
        ("policy.revise", {"policy": {}}),
        ("research.list", {}),
        ("runs.get", {"run_id": "../../x"}),
    ]:
        try:
            ctx._broker.call(method, args)
            out[method] = "allowed"
        except Exception as e:
            out[method] = getattr(e, "code", str(e))
    return ExtensionResult(summary="probed", data=out)
`,
    );
    await buildAndApprove(w, "p", "py-evaluator");
    const P = "/api/v1/projects/p/extensions/py-evaluator";
    const finish = async (contribution: string) => {
      const s = await w.call(`${P}/run`, { body: { contribution } });
      expect(s.status).toBe(202);
      return until(async () => {
        const r = await w.call(
          `/api/v1/projects/p/extension-executions/${s.body.execution.execution_id}`,
        );
        return r.body.execution.status !== "running" && r.body.execution;
      }, 40_000);
    };
    for (const [c, why] of [
      ["traverse", /not in the output area|outside/],
      ["absolute", /not in the output area|outside/],
      ["link", /link|regular file/],
      ["linkdir", /link|regular file/],
      ["oversize", /over the 2048 byte limit/],
      ["badresult", /result|summary|artifacts/i],
    ] as const) {
      const x = await finish(c);
      expect([c, x.status]).toEqual([c, "failed"]);
      expect(x.error).toMatch(why);
      expect(JSON.stringify(x)).not.toContain("PRIVATE KEY");
      expect(x.result?.artifacts ?? []).toEqual([]);
    }
    const probed = await finish("broker");
    expect(probed.status).toBe("succeeded");
    expect(probed.result.data).toMatchObject({
      "mlflow.raw": "method_not_allowed",
      __proto__: "method_not_allowed",
      "policy.revise": "method_not_allowed",
      "research.list": "capability_denied",
    });
    expect(probed.result.data["runs.get"]).not.toBe("allowed");
  }, 180_000);
});

describe("portable per-project permissions (criterion 15b)", () => {
  test("the same extension needs its own approval in a second project; registry publish and install; mismatched host APIs are rejected with a fix", async () => {
    const w = await setup();
    await project(w, "p", ["run-inspector"]);
    const q = await project(w, "q");
    const eb = await buildAndApprove(w, "p", "run-inspector");
    // Publish to the user registry, install into q: same source, same content-derived build ID…
    expect(
      (await w.call("/api/v1/projects/p/extensions/run-inspector/publish", { body: {} })).status,
    ).toBe(201);
    expect((await w.call("/api/v1/projects/q/extension-registry")).body.extensions).toEqual([
      expect.objectContaining({
        extension_id: "run-inspector",
        version: "0.1.0",
        compatible: true,
      }),
    ]);
    const inst = await w.agent("q", "/api/v1/projects/q/extensions/install", {
      body: { extension_id: "run-inspector", version: "0.1.0" },
    });
    expect(inst.status).toBe(201);
    expect(existsSync(join(q, ".ablationkit/extensions/run-inspector/manifest.json"))).toBe(true);
    const bq = await w.call("/api/v1/projects/q/extensions/run-inspector/build", { body: {} });
    expect(bq.body.build.build_id).toBe(eb);
    // …but not enabled in q until q's own approval.
    expect(
      (await w.call("/api/v1/projects/q/extensions/run-inspector")).body.extension.status,
    ).toBe("needs_approval");
    expect((await w.call("/api/v1/projects/q/extension-mounts")).body.mounts).toEqual([]);
    await w.browser("/api/v1/projects/q/extensions/run-inspector/approve", {
      build_id: eb,
      trusted_code: true,
    });
    expect((await w.call("/api/v1/projects/q/extension-mounts")).body.mounts).toHaveLength(3);
    // Disabling in q leaves p alone.
    await w.call("/api/v1/projects/q/extensions/run-inspector/disable", { body: {} });
    expect((await w.call("/api/v1/projects/p/extension-mounts")).body.mounts).toHaveLength(3);

    // A manifest for another host API major is rejected with actionable diagnostics.
    const r = await project(w, "r", ["run-inspector"]);
    const mf = join(r, ".ablationkit/extensions/run-inspector/manifest.json");
    writeFileSync(
      mf,
      JSON.stringify({ ...JSON.parse(readFileSync(mf, "utf8")), host_api: "^3.0.0" }),
    );
    const bad = await w.call("/api/v1/projects/r/extensions/run-inspector/build", { body: {} });
    expect(bad.status).toBe(422);
    const d = bad.body.error.diagnostics.find((x: Json) => x.code === "host_api_incompatible");
    expect(d.message).toContain("2.0.0");
    expect(d.fix).toContain("^2.0.0");
    expect((await w.call("/api/v1/projects/r/extensions")).body.extensions[0].status).toBe(
      "invalid",
    );
  });

  test("UI entries may import only the SDK and React; paths stay inside the extension", async () => {
    const w = await setup();
    const path = await project(w, "p", ["run-inspector"]);
    const f = join(path, ".ablationkit/extensions/run-inspector/ui/src/Panel.tsx");
    writeFileSync(
      f,
      `import "left-pad";\nimport "../../../../../secret.ts";\n${readFileSync(f, "utf8")}`,
    );
    const b = await w.call("/api/v1/projects/p/extensions/run-inspector/build", { body: {} });
    expect(b.status).toBe(422);
    const codes = b.body.build.diagnostics.map((x: Json) => x.code);
    expect(codes).toContain("dependency_not_allowed");
    expect(codes).toContain("import_outside_extension");
    expect(b.body.build.status).toBe("failed");
  });
});

describe("Python extensions (criteria 15e, 15f)", () => {
  test("a restored build has no venv: the first run rebuilds it from the lockfile, and it must match the approved environment (ADR 0025)", async () => {
    const w = await setup();
    await project(w, "p", ["py-evaluator"]);
    const runId = await seedRun(w, "p", { loss: 0.5 });
    const P = "/api/v1/projects/p/extensions/py-evaluator";
    const eb = await buildAndApprove(w, "p", "py-evaluator");
    const venv = join(w.svc().paths.stateDir, "p/extensions/py-evaluator/builds", eb, "venv");
    expect(existsSync(join(venv, "bin", "python"))).toBe(true);
    rmSync(venv, { recursive: true }); // what a restore leaves behind
    const body = {
      contribution: "evaluate",
      params: { scale: 2 },
      refs: [{ kind: "run", id: runId }],
    };
    const started = await w.call(`${P}/run`, { body });
    expect(started.status).toBe(202);
    const xid = started.body.execution.execution_id as string;
    const done = await until(async () => {
      const r = await w.call(`/api/v1/projects/p/extension-executions/${xid}`);
      return r.body.execution.status !== "running" && r.body.execution;
    });
    expect(done.status).toBe("succeeded");
    expect(existsSync(join(venv, "bin", "python"))).toBe(true);
    expect(auditText(w)).toContain('"extension.env.rebuild"');
    // An environment that no longer matches the approved one is refused.
    rmSync(venv, { recursive: true });
    const rec = (
      w.svc().extensions as unknown as {
        builds: Map<string, { python: { environment_sha256: string } }>;
      }
    ).builds.get(`p/${eb}`);
    if (!rec) throw new Error("no build record");
    rec.python.environment_sha256 = "0".repeat(64);
    const refused = await w.call(`${P}/run`, { body });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("python_env_mismatch");
    expect(existsSync(venv)).toBe(false);
  });

  test("an approved evaluator runs in its own uv environment under limits, reports progress and logs, returns typed results and logs them to MLflow", async () => {
    const w = await setup();
    await project(w, "p", ["py-evaluator"]);
    const runId = await seedRun(w, "p", { loss: 0.25, acc: 0.9 });
    const P = "/api/v1/projects/p/extensions/py-evaluator";
    // Not approved: refused.
    expect(
      (await w.agent("p", `${P}/run`, { body: { contribution: "evaluate" } })).body.error.code,
    ).toBe("extension_inactive");
    const eb = await buildAndApprove(w, "p", "py-evaluator");
    const build = (await w.call(P)).body.extension.builds[0];
    expect(build.python).toMatchObject({ status: "ready" });
    expect(build.python.environment_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(build.lockfile_sha256).toMatch(/^[a-f0-9]{64}$/);

    const started = await w.agent("p", `${P}/run`, {
      body: { contribution: "evaluate", params: { scale: 4 }, refs: [{ kind: "run", id: runId }] },
    });
    expect(started.status).toBe(202);
    const xid = started.body.execution.execution_id as string;
    const done = await until(async () => {
      const r = await w.agent("p", `/api/v1/projects/p/extension-executions/${xid}`);
      return r.body.execution.status !== "running" && r.body.execution;
    });
    expect(done.status).toBe("succeeded");
    expect(done.result.summary).toBe("scaled loss 1.000");
    expect(done.result.metrics).toEqual({ scaled_loss: "1.0", metric_count: "2", ratio: "0.0625" });
    expect(done.result.artifacts.map((a: Json) => a.path).sort()).toEqual([
      "evaluation.json",
      "notes/readme.txt",
    ]);
    expect(done.result.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(done.progress.percent).toBe(80);
    // Provenance: exact code, lockfile and environment hashes.
    expect(done.record).toMatchObject({
      build_id: eb,
      entry: "python/evaluate.py:evaluate",
      refs: [{ kind: "run", id: runId }],
    });
    expect(done.record.environment.environment_sha256).toBe(build.python.environment_sha256);
    expect(done.record.lockfile_sha256).toBe(build.lockfile_sha256);
    expect(done.record.enforcement.reasons.join(" ")).toContain("trusted code");
    // Logs from print() reach the log, not the protocol.
    const log = await w.cl.human(`/api/v1/projects/p/extension-executions/${xid}/log`, {
      cookie: w.auth.cookie,
    });
    expect(await log.text()).toContain(`evaluating ${runId} with scale 4`);
    // Committed through the coordinator to MLflow (project.results.write).
    const mr = w.fake.run(done.mlflow_run_id);
    expect(mr?.tags.get("ablationkit.extension")).toBe("py-evaluator");
    expect(mr?.tags.get("ablationkit.extension.source_sha256")).toBe(done.record.source_sha256);
    expect(mr?.metrics.find((x) => x.key === "scaled_loss")?.value).toBe(1);
    expect([...(mr?.artifacts.keys() ?? [])].sort()).toEqual([
      "extension/evaluation.json",
      "extension/notes/readme.txt",
      "extension/result.json",
    ]);

    // Broker calls are capability-checked server-side.
    const denied = await w.call(`${P}/run`, { body: { contribution: "denied" } });
    const dd = await until(async () => {
      const r = await w.call(
        `/api/v1/projects/p/extension-executions/${denied.body.execution.execution_id}`,
      );
      return r.body.execution.status !== "running" && r.body.execution;
    });
    expect(dd.result.summary).toBe("refused: capability_denied");
    // Outputs must stay in the output area.
    const esc = await w.call(`${P}/run`, { body: { contribution: "escape" } });
    const ed = await until(async () => {
      const r = await w.call(
        `/api/v1/projects/p/extension-executions/${esc.body.execution.execution_id}`,
      );
      return r.body.execution.status !== "running" && r.body.execution;
    });
    expect(ed.status).toBe("failed");
    expect(ed.error).toContain("not in the output area");
    // Disabling keeps canonical MLflow evidence (criterion 15f).
    await w.call(`${P}/disable`, { body: {} });
    expect(w.fake.run(done.mlflow_run_id)).toBeDefined();
    expect(
      (await w.call(`/api/v1/projects/p/extension-executions/${xid}`)).body.execution.status,
    ).toBe("succeeded");
  }, 60_000);

  test("time and memory limits stop the process; the network and credentials are out of reach where enforced", async () => {
    const w = await setup();
    await project(w, "p", ["py-evaluator"]);
    await buildAndApprove(w, "p", "py-evaluator");
    const P = "/api/v1/projects/p/extensions/py-evaluator";
    const finish = async (contribution: string, params: Json = {}) => {
      const s = await w.call(`${P}/run`, { body: { contribution, params } });
      expect(s.status).toBe(202);
      return until(async () => {
        const r = await w.call(
          `/api/v1/projects/p/extension-executions/${s.body.execution.execution_id}`,
        );
        return r.body.execution.status !== "running" && r.body.execution;
      }, 40_000);
    };
    const spin = await finish("spin");
    expect(spin.status).toBe("timed_out");
    expect(spin.error).toContain("8 s");
    const hog = await finish("hog");
    if (hog.enforcement.limits === "enforced") expect(hog.status).toBe("oom_killed");
    else expect(hog.enforcement.reasons[0]).toContain("limits advisory");
    // The coordinator's own listener is a target: with a network namespace it is unreachable.
    const human = new URL(w.cl.c.urls.human);
    const probe = await finish("probe", {
      targets: [`127.0.0.1:${human.port}`, `127.0.0.1:${new URL(w.fake.url).port}`],
    });
    expect(probe.status).toBe("succeeded");
    expect(probe.result.data.leaked).toEqual([]);
    expect(probe.result.data.cuda).toBe("");
    if (unshareAvailable()) {
      expect(probe.enforcement.network).toBe("enforced");
      expect(probe.result.data.reached).toEqual([]);
    } else expect(probe.enforcement.network).toBe("advisory");
  }, 120_000);

  test("an execution a crash left running is interrupted, never rerun", async () => {
    const w = await setup();
    await project(w, "p", ["py-evaluator"]);
    await buildAndApprove(w, "p", "py-evaluator");
    const s = await w.call("/api/v1/projects/p/extensions/py-evaluator/run", {
      body: { contribution: "spin" },
    });
    const xid = s.body.execution.execution_id as string;
    const home = w.home;
    // Simulate a crash: the record says running, and the next coordinator starts.
    const rec = JSON.parse(
      readFileSync(join(home, "state/p/extensions/executions", `${xid}.json`), "utf8"),
    );
    await h.coordinators[0]?.stop();
    writeFileSync(
      join(home, "state/p/extensions/executions", `${xid}.json`),
      JSON.stringify({ ...rec, status: "running" }),
    );
    const w2 = await setup({ home });
    const r = await w2.call(`/api/v1/projects/p/extension-executions/${xid}`);
    expect(r.body.execution.status).toBe("interrupted");
    expect(r.body.execution.error).toContain("not rerun");
  }, 60_000);
});

describe("interactive demo (criterion 9d)", () => {
  test("an approved demo predicts through the scoped bridge with an allowlist and quotas, and saves only its own results", async () => {
    const w = await setup();
    await project(w, "p", ["iris-demo"]);
    const s = w.svc();
    const exp = await s.tracking.ensureExperimentNow("p");
    const run = await s.tracking.client.createRun({ experiment_id: exp, run_name: "train" });
    const m = await s.tracking.client.createLoggedModel({
      experiment_id: exp,
      name: "clf",
      source_run_id: run.info.run_id,
    });
    await s.tracking.client.uploadProxiedArtifact(
      m.info.artifact_uri,
      "MLmodel",
      `artifact_path: model\nflavors:\n  python_function:\n    loader_module: mlflow.sklearn\n    python_version: 3.12.14\n  sklearn:\n    serialization_format: skops\n    sklearn_version: 1.9.1\nmlflow_version: 3.17.2\nsignature:\n  inputs: '[{"type": "double", "name": "x1", "required": true}, {"type": "double", "name": "x2", "required": true}]'\n  outputs: '[{"type": "long", "required": true}]'\n  params: null\n`,
    );
    await s.tracking.client.finalizeLoggedModel(m.info.model_id, "LOGGED_MODEL_READY");
    await w.call("/api/v1/projects/p/registry", { body: { name: "clf-reg" } });
    await w.call("/api/v1/projects/p/registry/clf-reg/versions", {
      body: { model_id: m.info.model_id },
    });
    await w.call("/api/v1/projects/p/registry/clf-reg/aliases/champion", {
      method: "PUT",
      body: { version: "1" },
    });
    w.config({ predictions: { [m.info.model_id]: [1] } });

    const eb = await buildAndApprove(w, "p", "iris-demo");
    const demos = (await w.call("/api/v1/projects/p/extension-mounts?point=model.demo")).body
      .mounts;
    expect(demos).toHaveLength(1);
    const call = (method: string, params: Json) =>
      rpc(w, "p", "iris-demo", { build_id: eb, contribution: "demo", method, params });
    const p1 = await call("inference.predict", {
      model: "clf-reg@champion",
      inputs: { records: [{ x1: 0.1, x2: 0.2 }] },
    });
    expect(p1.body.error).toBeUndefined();
    expect(p1.status).toBe(200);
    expect(p1.body.result.models[0]).toMatchObject({ status: "ok", outputs: [1] });
    expect(p1.body.result.models[0].model.version).toBe("1");
    // Only allowlisted models; bounded requests; no MLflow or worker methods.
    expect(
      (
        await call("inference.predict", {
          model: m.info.model_id,
          inputs: { records: [{ x1: 1, x2: 2 }] },
        })
      ).body.error.code,
    ).toBe("model_not_allowed");
    expect(
      (
        await call("inference.predict", {
          model: "clf-reg@champion",
          inputs: { records: Array.from({ length: 11 }, () => ({ x1: 1, x2: 2 })) },
        })
      ).body.error.code,
    ).toBe("too_many_rows");
    expect(
      (
        await call("inference.predict", {
          model: "clf-reg@champion",
          inputs: { records: [{ x1: "x".repeat(5000), x2: 1 }] },
        })
      ).body.error.code,
    ).toBe("request_too_large");
    expect((await call("runs.list", {})).body.error.code).toBe("capability_denied");
    expect((await call("tracking.runs.list", {})).body.error.code).toBe("method_not_allowed");
    // Saving is explicit (the host confirms) and only for this demo's own results.
    const saved = await call("inference.save", {
      result_id: p1.body.result.result_id,
      title: "demo prediction",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.result.evidence_id).toMatch(/^ie-/);
    const ev = w.svc().inference.getEvidence("p", saved.body.result.evidence_id);
    expect(ev.models[0]?.model_id).toBe(m.info.model_id);
    const foreign = await w.call("/api/v1/projects/p/inference/predict", {
      body: {
        model: { name: "clf-reg", alias: "champion" },
        inputs: { records: [{ x1: 0.3, x2: 0.4 }] },
        acknowledge_trust: true,
      },
    });
    expect(
      (await call("inference.save", { result_id: foreign.body.result.result_id })).body.error.code,
    ).toBe("not_found");
    // The quota (3 per hour) counts calls that reached a model.
    await call("inference.predict", {
      model: "clf-reg@champion",
      inputs: { records: [{ x1: 0.1, x2: 0.2 }] },
    });
    await call("inference.predict", {
      model: "clf-reg@champion",
      inputs: { records: [{ x1: 0.1, x2: 0.2 }] },
    });
    const over = await call("inference.predict", {
      model: "clf-reg@champion",
      inputs: { records: [{ x1: 0.1, x2: 0.2 }] },
    });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe("quota_exceeded");
    // Removing the demo from the checkout revokes it.
    rmSync(join(s.registry.require("p").path, ".ablationkit/extensions/iris-demo"), {
      recursive: true,
    });
    expect(
      (
        await call("inference.predict", {
          model: "clf-reg@champion",
          inputs: { records: [{ x1: 0.1, x2: 0.2 }] },
        })
      ).body.error.code,
    ).toBe("extension_inactive");
    expect((await w.call("/api/v1/projects/p/extensions")).body.extensions[0].status).toBe(
      "removed",
    );
  });
});

describe("LLM bridge, traces, evaluations and report snapshots (criteria 9d, 15a)", () => {
  function fakeLlm() {
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (r) => {
        if (new URL(r.url).pathname.endsWith("/models"))
          return Response.json({ data: [{ id: "echo" }] });
        const body = (await r.json()) as Json;
        const user = body.messages.filter((m: Json) => m.role === "user").at(-1)?.content ?? "";
        return Response.json({
          model: body.model,
          choices: [
            { message: { role: "assistant", content: `Sure! ${user}` }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        });
      },
    });
    return { url: `http://127.0.0.1:${srv.port}/v1`, stop: () => srv.stop(true) };
  }

  test("allowlisted LLM targets through the data controls with call and cost ceilings; traces and held-out-safe evaluation reads; report snapshots outlive the extension", async () => {
    const llm = fakeLlm();
    try {
      const w = await setup();
      const path = await project(w, "p");
      const s = await w.call("/api/v1/projects/p/llm/settings", {
        method: "PUT",
        body: {
          providers: [
            {
              provider_id: "local",
              base_url: llm.url,
              models: ["echo", "other"],
              rates: [
                {
                  model: "echo",
                  input_usd_per_mtok: "0.5",
                  output_usd_per_mtok: "1.5",
                  source: "test",
                  version: "1",
                },
              ],
            },
          ],
        },
      });
      expect(s.status).toBe(200);
      const ext = join(path, ".ablationkit/extensions/llm-lab");
      mkdirSync(join(ext, "ui"), { recursive: true });
      writeFileSync(
        join(ext, "ui/Demo.tsx"),
        'import { mount } from "@ablationkit/extension-sdk";\nvoid mount((_h, root) => { root.textContent = "demo"; });\n',
      );
      writeFileSync(
        join(ext, "ui/Block.tsx"),
        'import { mount } from "@ablationkit/extension-sdk";\nvoid mount((_h, root) => { root.textContent = "block"; });\n',
      );
      writeFileSync(
        join(ext, "manifest.json"),
        JSON.stringify({
          schema_version: 1,
          id: "llm-lab",
          version: "0.1.0",
          host_api: "^1.0.0",
          contributes: [
            { id: "demo", point: "model.demo", title: "Prompt demo", entry: "ui/Demo.tsx" },
            { id: "block", point: "report.block", title: "Figure", entry: "ui/Block.tsx" },
          ],
          capabilities: ["llm.infer", "llm.compare", "trace.read", "evaluation.read"],
          capability_config: {
            llm: {
              targets: [{ provider_id: "local", model: "echo" }],
              max_calls_per_hour: 10,
              max_input_chars: 2000,
              max_cost_usd: "0.00003",
            },
          },
        }),
      );
      const eb = await buildAndApprove(w, "p", "llm-lab");
      const call = (method: string, params: Json, contribution = "demo") =>
        rpc(w, "p", "llm-lab", { build_id: eb, contribution, method, params });
      const target = { provider_id: "local", model: "echo" };
      const one = await call("llm.infer", { target, template: "Q: {{q}}", inputs: [{ q: "hi" }] });
      expect(one.status, JSON.stringify(one.body)).toBe(200);
      const out = one.body.result.outputs.a[0];
      expect(out.output).toBe("Sure! Q: hi");
      expect(one.body.result.summary.a.usage.total_tokens).toBe(15);
      // Only allowlisted targets, typed rows only, bounded input.
      expect(
        (
          await call("llm.infer", {
            target: { provider_id: "local", model: "other" },
            template: "x",
            inputs: [{}],
          })
        ).body.error.code,
      ).toBe("model_not_allowed");
      expect(
        (await call("llm.infer", { target, template: "x", golden_set: { id: "g" } })).body.error
          .code,
      ).toBe("invalid_request");
      expect(
        (await call("llm.infer", { target, template: "x".repeat(3000), inputs: [{}] })).body.error
          .code,
      ).toBe("request_too_large");
      const cmp = await call("llm.compare", {
        variants: [
          { label: "plain", target, template: "{{q}}" },
          { label: "polite", target, template: "Please: {{q}}" },
        ],
        inputs: [{ q: "refunds" }],
      });
      expect(cmp.status).toBe(200);
      expect(cmp.body.result.rows).toHaveLength(1);
      // Three calls at ~$0.0000105 each passes the $0.00003/hour ceiling.
      const capped = await call("llm.infer", {
        target,
        template: "{{q}}",
        inputs: [{ q: "again" }],
      });
      expect(capped.status).toBe(429);
      expect(capped.body.error.code).toBe("cost_ceiling");
      // Trace read, filtered by the capture policy.
      expect(out.trace_id).toMatch(/^tr-/);
      await until(async () => w.fake.allTraces().length > 0);
      const tr = await call("traces.get", { trace_id: out.trace_id });
      expect(tr.status).toBe(200);
      expect(tr.body.result.capture.now).toBe("redacted");
      expect((await call("evaluations.examples", { evaluation_id: "le-nope" })).status).toBe(404);

      // A report block saves a static snapshot (host-confirmed) into the report.
      const rep = await w.call("/api/v1/projects/p/research", {
        body: { kind: "report", title: "Findings" },
      });
      expect(rep.status).toBe(201);
      const rid = rep.body.record.record_id as string;
      expect(
        (await call("report.snapshot", { report_id: rid, snapshot: { title: "x" } })).body.error
          .code,
      ).toBe("unknown_contribution");
      const snap = await call(
        "report.snapshot",
        {
          report_id: rid,
          snapshot: {
            title: "Loss by variant",
            text: "Variant b wins.",
            table: {
              columns: ["variant", "loss"],
              rows: [
                ["a", "0.3"],
                ["b", "0.2"],
              ],
            },
          },
        },
        "block",
      );
      expect(snap.status).toBe(200);
      const body = (await w.call(`/api/v1/projects/p/research/${rid}`)).body.record.body as string;
      expect(body).toContain("**Loss by variant**");
      expect(body).toContain("| b | 0.2 |");
      rmSync(ext, { recursive: true });
      const list = await w.call(`/api/v1/projects/p/extension-snapshots?report=${rid}`);
      expect(list.body.snapshots).toEqual([
        expect.objectContaining({
          title: "Loss by variant",
          extension_id: "llm-lab",
          build_id: eb,
        }),
      ]);
    } finally {
      llm.stop();
    }
  }, 60_000);
});

describe("templates (spec §8.4; criteria 15a, 15d, 15e)", () => {
  test("every template scaffolds, validates, builds, is approved and works against project fixtures", async () => {
    const { listTemplates, scaffoldExtension } = await import(
      "@ablationkit/extension-host/templates"
    );
    const w = await setup();
    const path = await project(w, "p");
    const s = w.svc();
    const runId = await seedRun(w, "p", { loss: 0.4, acc: 0.8 });
    const run = await s.tracking.client.getRun(runId);
    await s.tracking.client.uploadArtifact(
      run.info,
      "model_architecture.json",
      JSON.stringify({
        name: "Net",
        children: [
          { name: "embed", type: "Embedding", params: 100 },
          { name: "head", params: 10 },
        ],
      }),
    );
    const templates = listTemplates();
    expect(templates.map((t) => t.name)).toEqual([
      "architecture-viewer",
      "create-run-panel",
      "inference-demo",
      "python-analyzer",
      "python-evaluator",
      "react-python-demo",
      "report-widget",
      "restricted-action",
      "result-comparison",
    ]);
    const builds: Record<string, string> = {};
    for (const t of templates) {
      const id = `t-${t.name}`;
      const r = scaffoldExtension({
        template: t.name,
        id,
        checkout: path,
        name: `T ${t.name}`,
        model: "clf-reg@champion",
      });
      if (t.python) expect(r.locked).toBe(true);
      const v = await w.call(`/api/v1/projects/p/extensions/${id}/validate`, { body: {} });
      expect(v.body.diagnostics, t.name).toEqual([]);
      builds[t.name] = await buildAndApprove(w, "p", id);
    }
    const mounts = (await w.call("/api/v1/projects/p/extension-mounts")).body.mounts as Json[];
    for (const m of mounts.filter((x) => x.frame_url)) {
      const f = await w.cl.human(m.frame_url, { cookie: w.auth.cookie });
      expect(f.status, m.extension_id).toBe(200);
      expect((await f.text()).length).toBeGreaterThan(1000);
    }
    const bridge = (name: string, contribution: string, method: string, params: Json) =>
      rpc(w, "p", `t-${name}`, { build_id: builds[name], contribution, method, params });
    expect(
      (await bridge("create-run-panel", "tab", "runs.get", { run_id: runId })).body.result.metrics
        .loss,
    ).toBe(0.4);
    const arch = await bridge("architecture-viewer", "arch", "artifacts.preview", {
      run_id: runId,
      path: "model_architecture.json",
    });
    expect(JSON.parse(arch.body.result.text).children).toHaveLength(2);
    expect(
      (await bridge("result-comparison", "compare", "runs.get", { run_id: runId })).status,
    ).toBe(200);
    expect(
      (
        await bridge("inference-demo", "demo", "inference.predict", {
          model: "other@x",
          inputs: {},
        })
      ).body.error.code,
    ).toBe("model_not_allowed");
    const rep = await w.call("/api/v1/projects/p/research", {
      body: { kind: "report", title: "R" },
    });
    const snap = await bridge("report-widget", "block", "report.snapshot", {
      report_id: rep.body.record.record_id,
      snapshot: {
        title: "loss of recent runs",
        table: { columns: ["run", "loss"], rows: [["r", "0.4"]] },
      },
    });
    expect(snap.status).toBe(200);
    expect(
      (await w.call("/api/v1/projects/p/extensions/t-restricted-action/actions/note", { body: {} }))
        .status,
    ).toBe(200);
    const runPy = async (name: string, contribution: string, refs: Json[]) => {
      const x = await w.call(`/api/v1/projects/p/extensions/t-${name}/run`, {
        body: { contribution, refs },
      });
      expect(x.status, name).toBe(202);
      return until(async () => {
        const r = await w.call(
          `/api/v1/projects/p/extension-executions/${x.body.execution.execution_id}`,
        );
        return r.body.execution.status !== "running" && r.body.execution;
      });
    };
    const ev = await runPy("python-evaluator", "evaluate", [{ kind: "run", id: runId }]);
    expect(ev.status, ev.error).toBe("succeeded");
    expect(ev.result.metrics.metric_count).toBe("2");
    expect(ev.mlflow_run_id).toBeDefined();
    const an = await runPy("python-analyzer", "analyze", []);
    expect(an.status, an.error).toBe("succeeded");
    expect(an.result.tables[0].title).toBe("runs by status");
    // The React + Python template: the view's python.run through the bridge.
    const rp = await bridge("react-python-demo", "tab", "python.run", {
      target: "analyze",
      refs: [{ kind: "run", id: runId }],
    });
    expect(rp.status).toBe(200);
    const done = await until(async () => {
      const v = await bridge("react-python-demo", "tab", "python.execution", {
        execution_id: rp.body.result.execution_id,
      });
      return v.body.result.status !== "running" && v.body.result;
    });
    expect(done.status).toBe("succeeded");
    expect(done.result.data.lowest).toEqual({ key: "loss", value: 0.4 });
  }, 120_000);
});

describe("project-specific domain intelligence (criterion 1b)", () => {
  test("a project-authored skill and approved extension explain a custom model's internals through evidence APIs, with no model-specific code in AblationKit", async () => {
    const w = await setup();
    const repo = h.repo("arch");
    cpSync(resolve(import.meta.dir, "../../../fixtures/projects/custom-arch-research"), repo, {
      recursive: true,
    });
    expect(
      (await w.call("/api/v1/projects", { body: { path: repo, project_id: "arch" } })).status,
    ).toBe(201);
    const jobs: string[] = [];
    for (const tokenizer of ["char", "pairs"]) {
      const r = await w.call("/api/v1/projects/arch/jobs", {
        body: { command: ["python3", "train.py", "--tokenizer", tokenizer], run_name: tokenizer },
      });
      expect(r.status).toBe(201);
      jobs.push(r.body.job_id);
    }
    const runIds: string[] = [];
    for (const id of jobs)
      runIds.push(
        await until(async () => {
          const j = (await w.call(`/api/v1/jobs/${id}`)).body.latest_attempt;
          if (["failed", "unknown", "cancelled"].includes(j.state))
            throw new Error(`job ${id} ${j.state}`);
          return (
            j.state === "succeeded" &&
            j.tracking.sync_state === "synced" &&
            j.artifacts.length >= 2 &&
            j.tracking.mlflow_run_id
          );
        }, 60_000),
      );
    // The extension ships with the project; it runs only after this project's approval.
    const eb = await buildAndApprove(w, "arch", "ngram-explorer");
    const tab = await rpc(w, "arch", "ngram-explorer", {
      build_id: eb,
      contribution: "internals",
      method: "artifacts.preview",
      params: { run_id: runIds[1], path: "model/internals.json" },
    });
    expect(tab.status).toBe(200);
    const internals = JSON.parse(tab.body.result.text);
    expect(internals.type).toBe("ngram");
    expect(internals.top_contexts.length).toBeGreaterThan(0);
    // An agent runs the project's analysis the way the skill says (agent API, no core edits).
    const x = await w.agent("arch", "/api/v1/projects/arch/extensions/ngram-explorer/run", {
      body: { contribution: "compare" },
    });
    expect(x.status).toBe(202);
    const done = await until(async () => {
      const r = await w.agent(
        "arch",
        `/api/v1/projects/arch/extension-executions/${x.body.execution.execution_id}`,
      );
      return r.body.execution.status !== "running" && r.body.execution;
    });
    expect(done.status, done.error).toBe("succeeded");
    expect(done.result.tables[0].rows.map((r: Json) => r[0])).toEqual(["char", "pairs"]);
    expect(["char", "pairs"]).toContain(done.result.data.best);
    const skill = readFileSync(
      join(repo, ".claude/skills/explain-model-internals/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain(
      "`ablationkit_do extension.run` with `extension_id: ngram-explorer, contribution: compare`",
    );
    expect(skill).not.toMatch(/mlflow\.db|state\/|MLFLOW_TRACKING_URI/);
    // Nothing about this model is built into AblationKit.
    const core = Bun.spawnSync(
      [
        "grep",
        "-rliE",
        "ngram|n-gram|bits_per_char",
        "apps/server/src",
        "apps/web/src",
        "apps/cli/src",
        "packages",
        "--include=*.ts",
        "--include=*.tsx",
      ],
      {
        cwd: resolve(import.meta.dir, "../../.."),
      },
    );
    expect(core.stdout.toString().trim()).toBe("");
  }, 120_000);
});

describe("Level 2 builds (criterion 15c)", () => {
  test("a modified build is listed with its checks; activation only changes the next start", async () => {
    const w = await setup();
    const id = "b-0123456789ab-1";
    const dir = join(w.home, "builds", id);
    mkdirSync(join(dir, "source/apps/server/src"), { recursive: true });
    writeFileSync(join(dir, "source/apps/server/src/main.ts"), "// modified build\n");
    const rec = {
      schema_version: 1,
      build_id: id,
      commit: "a".repeat(40),
      branch: "agent/x",
      base_ref: "main",
      changed_files: ["apps/web/src/pages/system.tsx"],
      source_dir: join(dir, "source"),
      checks: [{ command: "bun run typecheck", status: "passed", exit_code: 0, duration_ms: 10 }],
      status: "ready",
      created_at: new Date().toISOString(),
    };
    writeFileSync(join(dir, "build.json"), JSON.stringify(rec));
    const before = await w.call("/api/v1/system/build");
    expect(before.body.build.modified).toBe(false);
    expect(before.body.builds.map((b: Json) => b.build_id)).toEqual([id]);
    const pid = process.pid;
    const ok = await w.browser(`/api/v1/system/builds/${id}/activate`);
    expect(ok.body.error?.message).toBeUndefined();
    // The running coordinator is the same process and source; only the next start changes.
    const after = await w.call("/api/v1/system/build");
    expect(after.body.build).toMatchObject({
      modified: false,
      restart_required: true,
      next_start: { build_id: id },
    });
    expect(process.pid).toBe(pid);
    expect(auditText(w)).toContain('"action":"build.activate"');
    const back = await w.call("/api/v1/system/builds/deactivate", { body: {} });
    expect(back.body.build.restart_required).toBe(false);
  });
});
