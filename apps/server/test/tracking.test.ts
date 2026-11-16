/**
 * Tracking API over HTTP against a fake MLflow (criteria 4 API side, 11, 60). The fake passes the
 * same REST contract as the pinned MLflow (packages/tracking-mlflow/test/contract.test.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { type Client, Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

async function setup(opts: { down?: boolean } = {}) {
  const fake = new FakeMlflow().start();
  fakes.push(fake);
  if (opts.down) await fake.stop();
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

async function addProject(
  cl: Client,
  call: Awaited<ReturnType<typeof setup>>["call"],
  id = "demo",
) {
  const r = await call("/api/v1/projects", { body: { path: h.repo(id), project_id: id } });
  expect(r.status).toBe(201);
  await until(async () => {
    const t = await call<{ links: { experiment_id?: string } }>(`/api/v1/projects/${id}/tracking`);
    return t.body.links.experiment_id !== undefined;
  });
  void cl;
}

describe("tracking API", () => {
  test("project registration creates ak/<project-id>; attempt runs carry study/variant/task tags (criterion 60)", async () => {
    const { cl, call, fake } = await setup();
    await addProject(cl, call);
    const exps = await call<{
      experiments: { name: string; ablationkit: { role: string; project_id: string } }[];
    }>("/api/v1/tracking/experiments?project=demo");
    expect(exps.body.experiments).toHaveLength(1);
    expect(exps.body.experiments[0]).toMatchObject({
      name: "ak/demo",
      ablationkit: { role: "project", project_id: "demo" },
    });

    // The service API Stage 5's job runner calls for each attempt.
    const tracking = cl.c.services.tracking;
    tracking.startRun({
      project_id: "demo",
      kind: "attempt",
      ref: "att-1",
      job_id: "job-1",
      attempt_id: "att-1",
      study_id: "study-a",
      variant_id: "variant-b",
      task_id: "task-1",
    });
    tracking.logBatch("att-1", {
      metrics: [{ key: "loss", value: 0.25, timestamp: 1000, step: 3 }],
    });
    await until(() => tracking.mappings.get("att-1")?.sync_state === "synced");
    const runs = await call<{
      runs: {
        info: { run_id: string; experiment_id: string };
        data: { tags: { key: string; value: string }[] };
        ablationkit: { mapping: { ref: string } };
      }[];
    }>("/api/v1/tracking/runs?project=demo");
    expect(runs.body.runs).toHaveLength(1);
    const run = runs.body.runs[0];
    const tags = Object.fromEntries((run?.data.tags ?? []).map((t) => [t.key, t.value]));
    expect(tags).toMatchObject({
      "ablationkit.project_id": "demo",
      "ablationkit.job_id": "job-1",
      "ablationkit.attempt_id": "att-1",
      "ablationkit.study_id": "study-a",
      "ablationkit.variant_id": "variant-b",
      "ablationkit.task_id": "task-1",
    });
    expect(run?.ablationkit.mapping.ref).toBe("att-1");
    // The mapping is persisted under the project's state directory.
    const file = join(cl.c.services.paths.stateDir, "demo", "tracking", "runs", "att-1.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      project_id: "demo",
      job_id: "job-1",
      mlflow_run_id: run?.info.run_id,
    });
    // Attempt metrics projection.
    const m = await call<{ metrics: { key: string; value: number }[] }>(
      "/api/v1/attempts/att-1/metrics",
    );
    expect(m.body.metrics).toContainEqual(expect.objectContaining({ key: "loss", value: 0.25 }));
    expect(fake.allRuns()).toHaveLength(1);
  });

  test("an imported historical experiment is linked read-only (criterion 60)", async () => {
    const { cl, call, fake } = await setup();
    await addProject(cl, call);
    const c = cl.c.services.tracking.client;
    const legacy = await c.createExperiment("legacy-sweeps");
    const old = await c.createRun({ experiment_id: legacy, run_name: "old" });
    await c.logBatch({
      run_id: old.info.run_id,
      metrics: [{ key: "acc", value: 0.9, timestamp: 1, step: 0 }],
    });

    const imp = await call<{ links: { imports: { experiment_id: string }[] } }>(
      "/api/v1/projects/demo/tracking/imports",
      {
        body: { experiment_id: legacy },
      },
    );
    expect(imp.status).toBe(201);
    expect(imp.body.links.imports.map((i) => i.experiment_id)).toEqual([legacy]);
    // Its runs are visible in the project and flagged read-only…
    const runs = await call<{
      runs: { info: { run_id: string }; ablationkit: { read_only: boolean } }[];
    }>("/api/v1/tracking/runs?project=demo");
    expect(runs.body.runs.map((r) => [r.info.run_id, r.ablationkit.read_only])).toEqual([
      [old.info.run_id, true],
    ]);
    // …and nothing about them can be changed through AblationKit.
    const before = fake.calls.length;
    expect(
      (
        await call(`/api/v1/tracking/runs/${old.info.run_id}`, {
          method: "PATCH",
          body: { name: "x" },
        })
      ).body,
    ).toMatchObject({
      error: { code: "read_only_import" },
    });
    expect(
      (
        await call(`/api/v1/tracking/experiments/${legacy}`, {
          method: "PATCH",
          body: { name: "x" },
        })
      ).body,
    ).toMatchObject({
      error: { code: "read_only_import" },
    });
    expect(
      fake.calls.slice(before).every((x) => !/update|delete|set-tag|log-batch/.test(x.path)),
    ).toBe(true);
    // A project experiment cannot be imported, and an import cannot be claimed twice.
    const own = cl.c.services.tracking.mappings.getLinks("demo").experiment_id;
    expect(
      (await call("/api/v1/projects/demo/tracking/imports", { body: { experiment_id: own } }))
        .status,
    ).toBe(409);
    await call("/api/v1/projects", { body: { path: h.repo("other"), project_id: "other" } });
    expect(
      (await call("/api/v1/projects/other/tracking/imports", { body: { experiment_id: legacy } }))
        .body,
    ).toMatchObject({
      error: { code: "already_imported" },
    });
  });

  test("MLflow down: writes answer 202 tracking_pending, nothing claims commit, then they sync (criterion 11)", async () => {
    const { cl, call, fake } = await setup({ down: true });
    const r = await call("/api/v1/projects", {
      body: { path: h.repo("demo"), project_id: "demo" },
    });
    expect(r.status).toBe(201);

    const created = await call<{ ref: string; state: string; mapping: { mlflow_run_id?: string } }>(
      "/api/v1/tracking/runs",
      {
        body: {
          project_id: "demo",
          run_name: "manual",
          params: { lr: "0.1" },
          metrics: [{ key: "loss", value: 1, timestamp: 1, step: 0 }],
        },
      },
    );
    expect(created.status).toBe(202);
    expect(created.body.state).toBe("tracking_pending");
    expect(created.body.mapping.mlflow_run_id).toBeUndefined();
    const ref = created.body.ref;

    const one = await call<{ state: string; sync: { state: string; pending_ops: number } }>(
      `/api/v1/tracking/runs/${ref}`,
    );
    expect(one.body).toMatchObject({
      state: "tracking_pending",
      sync: { state: "tracking_pending" },
    });
    expect(one.body.sync.pending_ops).toBeGreaterThanOrEqual(2);
    const metrics = await call<{ state: string; metrics: unknown[] }>(
      `/api/v1/tracking/runs/${ref}/metrics`,
    );
    expect(metrics.body).toMatchObject({ state: "tracking_pending", metrics: [] });
    const list = await call<{
      runs: unknown[];
      pending_runs: { mapping: { ref: string } }[];
      mlflow_available: boolean;
    }>("/api/v1/tracking/runs?project=demo");
    expect(list.body.mlflow_available).toBe(false);
    expect(list.body.runs).toEqual([]);
    expect(list.body.pending_runs.map((p) => p.mapping.ref)).toEqual([ref]);
    const status = await call<{
      outbox: { pending: number };
      last_transport_error: { kind: string };
    }>("/api/v1/tracking/status");
    expect(status.body.outbox.pending).toBeGreaterThanOrEqual(3);
    expect(status.body.last_transport_error.kind).toBe("unavailable");
    // Management writes fail explicitly instead of pretending.
    expect(
      (await call("/api/v1/tracking/experiments", { body: { name: "x", confirm: true } })).body,
    ).toMatchObject({
      error: { code: "tracking_unavailable" },
    });
    // Console logs and research do not depend on MLflow: the rest of the API keeps working.
    expect((await call("/api/v1/projects/demo")).status).toBe(200);

    fake.start();
    cl.c.services.tracking.mlflowAvailable();
    await until(() => cl.c.services.tracking.mappings.get(ref)?.sync_state === "synced");
    const after = await call<{
      run: {
        info: { run_id: string };
        data: { params: { key: string; value: string }[] };
        ablationkit: { sync: { state: string } };
      };
    }>(`/api/v1/tracking/runs/${ref}`);
    expect(after.body.run.ablationkit.sync.state).toBe("synced");
    expect(after.body.run.data.params).toContainEqual({ key: "lr", value: "0.1" });
    expect(fake.run(after.body.run.info.run_id)?.metrics).toHaveLength(1);
  });

  test("experiments: create needs confirmation, ak/ names are reserved, rename/tag/archive/restore", async () => {
    const { cl, call } = await setup();
    await addProject(cl, call);
    expect(
      (await call("/api/v1/tracking/experiments", { body: { name: "scratch" } })).body,
    ).toMatchObject({
      error: { code: "confirmation_required" },
    });
    expect(
      (await call("/api/v1/tracking/experiments", { body: { name: "ak/other", confirm: true } }))
        .status,
    ).toBe(409);
    const made = await call<{
      experiment: { experiment_id: string; ablationkit: { role: string } };
    }>("/api/v1/tracking/experiments", {
      body: { name: "scratch", confirm: true, tags: { purpose: "smoke" } },
    });
    expect(made.status).toBe(201);
    expect(made.body.experiment.ablationkit.role).toBe("other");
    const id = made.body.experiment.experiment_id;
    const upd = await call<{
      experiment: { name: string; tags: { key: string; value: string }[] };
    }>(`/api/v1/tracking/experiments/${id}`, {
      method: "PATCH",
      body: { name: "scratch-2", tags: { owner: "me" } },
    });
    expect(upd.body.experiment.name).toBe("scratch-2");
    expect(upd.body.experiment.tags).toContainEqual({ key: "owner", value: "me" });
    await call(`/api/v1/tracking/experiments/${id}`, {
      method: "PATCH",
      body: { lifecycle: "deleted" },
    });
    const deleted = await call<{ experiments: { experiment_id: string }[] }>(
      "/api/v1/tracking/experiments?view=deleted",
    );
    expect(deleted.body.experiments.map((e) => e.experiment_id)).toContain(id);
    await call(`/api/v1/tracking/experiments/${id}`, {
      method: "PATCH",
      body: { lifecycle: "active" },
    });
    expect(
      (
        await call<{ experiment: { lifecycle_stage: string } }>(
          `/api/v1/tracking/experiments/${id}`,
        )
      ).body.experiment.lifecycle_stage,
    ).toBe("active");
    // The project experiment cannot be renamed or archived.
    const own = cl.c.services.tracking.mappings.getLinks("demo").experiment_id as string;
    expect(
      (
        await call(`/api/v1/tracking/experiments/${own}`, {
          method: "PATCH",
          body: { lifecycle: "deleted" },
        })
      ).body,
    ).toMatchObject({
      error: { code: "project_experiment" },
    });
    const page = await call<{ experiments: unknown[]; next_page_token: string }>(
      "/api/v1/tracking/experiments?max_results=1",
    );
    expect(page.body.experiments).toHaveLength(1);
    expect(page.body.next_page_token).toBeDefined();
    const audit = await call<{ records: { action: string }[] }>("/api/v1/audit?limit=1000");
    const actions = audit.body.records.map((r) => r.action);
    expect(actions).toContain("tracking.experiments.create");
    expect(actions).toContain("tracking.experiments.update");
  });

  test("runs: manual create, log, metrics (model and system), history CSV, update, compare, export, artifacts", async () => {
    const { cl, call } = await setup();
    await addProject(cl, call);
    const mk = async (name: string, lr: string, loss: number) => {
      const r = await call<{ ref: string; mlflow_run_id: string }>("/api/v1/tracking/runs", {
        body: {
          project_id: "demo",
          run_name: name,
          study_id: "study-a",
          params: { lr, seed: "1" },
          metrics: [
            { key: "loss", value: loss + 1, timestamp: 1000, step: 0 },
            { key: "loss", value: loss, timestamp: 2000, step: 1 },
            { key: "system/cpu_utilization_percentage", value: 50, timestamp: 2000, step: 0 },
          ],
        },
      });
      expect(r.status).toBe(201);
      return r.body;
    };
    const a = await mk("a", "0.1", 0.5);
    const b = await mk("b", "0.2", 0.4);

    const logged = await call(`/api/v1/tracking/runs/${a.ref}/log`, {
      body: { tags: { note: "first" } },
    });
    expect(logged.status).toBe(200);
    expect(
      (await call(`/api/v1/tracking/runs/${a.ref}/log`, { body: { tags: { "mlflow.user": "x" } } }))
        .status,
    ).toBe(400);

    const m = await call<{ metrics: { key: string }[]; system_metrics: { key: string }[] }>(
      `/api/v1/tracking/runs/${a.mlflow_run_id}/metrics`,
    );
    expect(m.body.metrics.map((x) => x.key)).toEqual(["loss"]);
    expect(m.body.system_metrics.map((x) => x.key)).toEqual(["system/cpu_utilization_percentage"]);
    const hist = await call<{ history: { step: number; value: number }[] }>(
      `/api/v1/tracking/runs/${a.ref}/metrics?key=loss`,
    );
    expect(hist.body.history.map((p) => [p.step, p.value])).toEqual([
      [0, 1.5],
      [1, 0.5],
    ]);
    const histCsv = await cl.human(`/api/v1/tracking/runs/${a.ref}/metrics?key=loss&format=csv`, {
      token: await cl.session(),
    });
    expect(await histCsv.text()).toBe("step,timestamp,value\n0,1000,1.5\n1,2000,0.5\n");

    const upd = await call<{ run: { info: { run_name: string; status: string } } }>(
      `/api/v1/tracking/runs/${a.ref}`,
      {
        method: "PATCH",
        body: { name: "a-renamed", status: "FINISHED", tags: { quality: "good" } },
      },
    );
    expect(upd.body.run.info).toMatchObject({ run_name: "a-renamed", status: "FINISHED" });
    expect(
      (
        await call(`/api/v1/tracking/runs/${a.ref}`, {
          method: "PATCH",
          body: { tags: { "ablationkit.ref": "x" } },
        })
      ).status,
    ).toBe(400);

    const cmp = await call<{
      params: { key: string; values: string[]; differs: boolean }[];
      metrics: { key: string; differs: boolean }[];
    }>(`/api/v1/tracking/compare?runs=${a.ref},${b.mlflow_run_id}`);
    expect(cmp.body.params.find((p) => p.key === "lr")).toEqual({
      key: "lr",
      values: ["0.1", "0.2"],
      differs: true,
    });
    expect(cmp.body.params.find((p) => p.key === "seed")?.differs).toBe(false);
    expect(cmp.body.metrics.find((p) => p.key === "loss")?.differs).toBe(true);

    const exp = await cl.human("/api/v1/tracking/export?project=demo&format=csv", {
      token: await cl.session(),
    });
    expect(exp.headers.get("content-type")).toContain("text/csv");
    const lines = (await exp.text()).trim().split("\n");
    expect(lines[0]).toContain("params.lr");
    expect(lines[0]).toContain("metrics.loss");
    expect(lines[0]).toContain("study_id");
    expect(lines).toHaveLength(3);
    const ej = await call<{ runs: unknown[] }>("/api/v1/tracking/export?project=demo&format=json");
    expect(ej.body.runs).toHaveLength(2);

    // Artifacts are browsed and downloaded through the coordinator, never rendered inline.
    const c = cl.c.services.tracking.client;
    const info = (await c.getRun(a.mlflow_run_id)).info;
    await c.uploadArtifact(info, "plots/index.html", "<script>alert(1)</script>");
    const top = await call<{ files: { path: string; is_dir: boolean }[] }>(
      `/api/v1/tracking/runs/${a.ref}/artifacts`,
    );
    expect(top.body.files).toEqual([{ path: "plots", is_dir: true }]);
    const sub = await call<{ files: { path: string }[] }>(
      `/api/v1/tracking/runs/${a.ref}/artifacts?path=plots`,
    );
    expect(sub.body.files.map((f) => f.path)).toEqual(["plots/index.html"]);
    const dl = await cl.human(
      `/api/v1/tracking/runs/${a.ref}/artifacts/download?path=plots/index.html`,
      { token: await cl.session() },
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.headers.get("content-security-policy")).toContain("sandbox");
    expect(await dl.text()).toBe("<script>alert(1)</script>");
    for (const bad of ["../x", "/etc/passwd", "a/../../b", "file:///etc/passwd", "a//b"]) {
      const r = await call(
        `/api/v1/tracking/runs/${a.ref}/artifacts/download?path=${encodeURIComponent(bad)}`,
      );
      expect(r.status).toBe(400);
    }
    // Models and registry views answer (empty until Stage 12 logs models).
    expect(
      (await call<{ models: unknown[] }>("/api/v1/tracking/models?project=demo")).body.models,
    ).toEqual([]);
    expect((await call("/api/v1/tracking/registered-models")).status).toBe(200);
  });

  test("a rejected write is sync_failed, listed in the outbox and retryable", async () => {
    const { cl, call } = await setup();
    await addProject(cl, call);
    const r = await call<{ ref: string }>("/api/v1/tracking/runs", {
      body: { project_id: "demo", params: { lr: "0.1" } },
    });
    const bad = await call<{ state: string }>(`/api/v1/tracking/runs/${r.body.ref}/log`, {
      body: { params: { lr: "0.9" } },
    });
    expect(bad.status).toBe(202);
    expect(bad.body.state).toBe("sync_failed");
    const failed = await call<{ entries: { op_id: string; last_error: { code: string } }[] }>(
      "/api/v1/tracking/outbox?state=failed",
    );
    expect(failed.body.entries).toHaveLength(1);
    expect(failed.body.entries[0]?.last_error.code).toBe("INVALID_PARAMETER_VALUE");
    const id = failed.body.entries[0]?.op_id as string;
    expect((await call(`/api/v1/tracking/outbox/${id}/retry`, { body: {} })).status).toBe(200);
    expect((await call(`/api/v1/tracking/outbox/${id}/retry`, { body: {} })).status).toBe(404);
    const doctor = await call<{ status: string; checks: { name: string; status: string }[] }>(
      "/api/v1/tracking/doctor",
    );
    await until(
      async () =>
        (await call<{ entries: unknown[] }>("/api/v1/tracking/outbox?state=failed")).body.entries
          .length === 1,
    );
    expect(doctor.body.checks.find((x) => x.name === "mlflow api")?.status).toBe("ok");
  });

  test("backup create: SQLite-safe MLflow snapshot plus coordinator state, with checksums", async () => {
    const { cl, call } = await setup();
    await addProject(cl, call);
    // A real SQLite file stands in for MLflow's database (the fake keeps state in memory).
    const { Database } = await import("bun:sqlite");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const mdir = cl.c.services.paths.mlflowDir;
    mkdirSync(join(mdir, "artifacts", "1", "r1"), { recursive: true });
    writeFileSync(join(mdir, "artifacts", "1", "r1", "model.pkl"), "bytes");
    const db = new Database(join(mdir, "mlflow.db"));
    db.run("CREATE TABLE t (x INTEGER)");
    db.run("INSERT INTO t VALUES (42)");
    // Keep a write transaction open: VACUUM INTO still produces a consistent snapshot.
    db.run("BEGIN");
    db.run("INSERT INTO t VALUES (43)");
    const b = await call<{
      backup_id: string;
      path: string;
      mlflow_database: string;
      files: number;
    }>("/api/v1/backups", { body: {} });
    db.run("COMMIT");
    db.close();
    expect(b.status).toBe(201);
    expect(b.body.mlflow_database).toBe("vacuum_into");
    const snap = new Database(join(b.body.path, "mlflow", "mlflow.db"), { readonly: true });
    expect(snap.query("SELECT x FROM t").all()).toEqual([{ x: 42 }]);
    snap.close();
    for (const f of [
      "mlflow/artifacts/1/r1/model.pkl",
      "coordinator/registry.json",
      "coordinator/state/demo/tracking/experiments.json",
      "projects/demo/.ablationkit/project.json",
      "manifest.json",
    ])
      expect(existsSync(join(b.body.path, f))).toBe(true);
    for (const f of ["run", "coordinator.lock", "cli-session.json", "mlflow/venv"])
      expect(existsSync(join(b.body.path, f))).toBe(false);
    const v = await cl.c.services.backups.verify(b.body.backup_id);
    expect({ ok: v.ok, problems: v.problems }).toEqual({ ok: true, problems: [] });
    expect(v.manifest.quiesce).toBe("tracking_paused");
    expect(v.manifest.projects?.map((p) => p.project_id)).toEqual(["demo"]);
    const list = await call<{ backups: { backup_id: string }[] }>("/api/v1/backups");
    expect(list.body.backups.map((x) => x.backup_id)).toEqual([b.body.backup_id]);
  });

  test("agents read their project's runs, metrics and text artifacts, bounded and paged (ADR 0040)", async () => {
    const { cl, call } = await setup();
    await addProject(cl, call);
    await addProject(cl, call, "other");
    const mk = async (project: string, name: string) => {
      const r = await call<{ ref: string; mlflow_run_id: string }>("/api/v1/tracking/runs", {
        body: {
          project_id: project,
          run_name: name,
          params: { lr: "0.1" },
          metrics: [
            { key: "loss", value: 1.5, timestamp: 1000, step: 0 },
            { key: "loss", value: 0.5, timestamp: 2000, step: 1 },
          ],
        },
      });
      expect(r.status).toBe(201);
      return r.body;
    };
    const a = await mk("demo", "a");
    const theirs = await mk("other", "b");
    const { token } = await cl.agentSession("demo");
    const agent = <T = Record<string, unknown>>(path: string) =>
      cl.json<T>(cl.agent(path, { token }));
    const runs = await agent<{ runs: { info: { run_name: string } }[] }>(
      "/api/v1/projects/demo/runs?max_results=10",
    );
    expect(runs.body.runs.map((r) => r.info.run_name)).toEqual(["a"]);
    expect((await agent(`/api/v1/projects/demo/runs/${a.ref}`)).status).toBe(200);
    expect((await agent(`/api/v1/projects/demo/runs/${a.mlflow_run_id}`)).status).toBe(200);
    // Another project's run is not found, by ID or ref, and the other project is forbidden.
    expect((await agent(`/api/v1/projects/demo/runs/${theirs.mlflow_run_id}`)).status).toBe(404);
    expect((await agent(`/api/v1/projects/demo/runs/${theirs.ref}`)).status).toBe(404);
    expect((await agent(`/api/v1/projects/other/runs`)).status).toBe(403);
    expect((await agent("/api/v1/projects/demo/runs?max_results=1000")).status).toBe(400);
    const hist = await agent<{ history: { step: number }[]; next_page_token?: string }>(
      `/api/v1/projects/demo/runs/${a.ref}/metrics?key=loss&max_results=1`,
    );
    expect(hist.body.history.map((p) => p.step)).toEqual([0]);
    expect(hist.body.next_page_token).toBeDefined();
    const c = cl.c.services.tracking.client;
    const info = (await c.getRun(a.mlflow_run_id)).info;
    await c.uploadArtifact(info, "notes/summary.txt", "héllo world\n");
    await c.uploadArtifact(info, "weights.bin", new Uint8Array([1, 0, 2]) as never);
    const files = await agent<{ files: { path: string }[] }>(
      `/api/v1/projects/demo/runs/${a.ref}/artifacts`,
    );
    expect(files.body.files.map((f) => f.path).sort()).toEqual(["notes", "weights.bin"]);
    const page = await agent<{ text: string; next_offset?: number; size: number }>(
      `/api/v1/projects/demo/runs/${a.ref}/artifacts/text?path=notes/summary.txt&limit=2`,
    );
    // Two bytes would split "é": the page ends before it.
    expect(page.body).toMatchObject({ text: "h", next_offset: 1, size: 13 });
    const rest = await agent<{ text: string; next_offset?: number }>(
      `/api/v1/projects/demo/runs/${a.ref}/artifacts/text?path=notes/summary.txt&offset=1`,
    );
    expect(rest.body).toEqual(expect.objectContaining({ text: "éllo world\n" }));
    expect(rest.body.next_offset).toBeUndefined();
    const bin = await agent<{ error: { code: string } }>(
      `/api/v1/projects/demo/runs/${a.ref}/artifacts/text?path=weights.bin`,
    );
    expect([bin.status, bin.body.error.code]).toEqual([415, "not_text"]);
    expect(
      (
        await agent(
          `/api/v1/projects/demo/runs/${a.ref}/artifacts/text?path=notes/summary.txt&limit=999999`,
        )
      ).status,
    ).toBe(400);
  });

  test("tracking routes need a session and do not exist on the agent listener", async () => {
    const { cl } = await setup();
    expect((await cl.human("/api/v1/tracking/status")).status).toBe(401);
    expect((await cl.agent("/api/v1/tracking/status")).status).toBe(404);
    expect((await cl.worker("/api/v1/tracking/runs")).status).toBe(404);
  });
});

describe("managed sidecar in the coordinator", () => {
  const OPS = join(import.meta.dir, "../../../packages/tracking-mlflow/env");
  const FAKE_MAIN = join(
    import.meta.dir,
    "../../../packages/tracking-mlflow/src/fake-server-main.ts",
  );

  async function freePort(): Promise<number> {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const p = s.port ?? 0;
    await s.stop(true);
    return p;
  }

  test("coordinator start brings MLflow up; an upgrade is backed up first; stop takes it down", async () => {
    const { pinnedMlflowVersion } = await import("@ablationkit/tracking-mlflow");
    const pin = pinnedMlflowVersion(OPS);
    const home = h.tmp("ak-home-");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    // Data left by an older MLflow.
    mkdirSync(join(home, "mlflow"), { recursive: true });
    writeFileSync(join(home, "mlflow", "mlflow.db"), "");
    writeFileSync(
      join(home, "mlflow", "sidecar.json"),
      JSON.stringify({
        schema_version: 1,
        data_mlflow_version: "3.0.0",
        initialized_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        upgrades: [],
      }),
    );
    const port = await freePort();
    const cl = await h.start({
      home,
      settings: {
        schema_version: 1,
        human: { host: "127.0.0.1", port: 0 },
        agent: { host: "127.0.0.1", port: 0 },
        worker: { host: "127.0.0.1", port: 0 },
        mlflow: { port },
      },
      trackingIntervalMs: 20,
      sidecarHooks: {
        install: async () => {},
        installedVersion: async () => pin,
        command: (p) => [process.execPath, FAKE_MAIN, String(p), pin],
      },
    });
    const token = await cl.session();
    await until(() => cl.c.services.sidecarStatus().state === "healthy", 10_000);
    const st = await cl.json<{ sidecar: { state: string; data_version: string } }>(
      cl.human("/api/v1/tracking/status", { token }),
    );
    expect(st.body.sidecar).toMatchObject({ state: "healthy", data_version: pin });
    const backups = cl.c.services.backups.list();
    expect(backups.map((b) => b.manifest.reason)).toEqual(["pre_upgrade"]);
    const audit = await cl.json<{ records: { action: string; details?: { from: string } }[] }>(
      cl.human("/api/v1/audit?limit=1000", { token }),
    );
    expect(audit.body.records.find((r) => r.action === "mlflow.upgrade")?.details).toMatchObject({
      from: "3.0.0",
      to: pin,
    });
    // Writes flow through the managed sidecar.
    await cl.json(
      cl.human("/api/v1/projects", { token, body: { path: h.repo("demo"), project_id: "demo" } }),
    );
    await until(() => cl.c.services.tracking.mappings.getLinks("demo").experiment_id !== undefined);
    const doctor = await cl.json<{ status: string; checks: { name: string; status: string }[] }>(
      cl.human("/api/v1/tracking/doctor", { token }),
    );
    expect(doctor.body.checks.find((x) => x.name === "sidecar")?.status).toBe("ok");
    expect(doctor.body.checks.find((x) => x.name === "mlflow version")?.status).toBe("ok");
    const pid = cl.c.services.sidecarStatus().pid as number;
    await cl.c.stop();
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});
