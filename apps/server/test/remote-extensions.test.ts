/**
 * Python extension contributions on remote targets (spec §8.4.1; ADR 0023 decision 26). The job's
 * bundle carries the approved build's source snapshot, the request and the staged inputs;
 * `ablationkit_extension.remote` runs the unchanged runner and answers broker calls from the staged
 * inputs only. A coordinator restart does not interrupt the execution: once the attempt has synced,
 * the result and outputs are validated as a local result would be and recorded once, through the
 * coordinator to MLflow.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";
import { fakeHost, stopRemotes } from "./remote-host.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
const FIXTURES = resolve(import.meta.dir, "../../../fixtures/extensions");

afterEach(async () => {
  stopRemotes();
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

// biome-ignore lint/suspicious/noExplicitAny: loosely typed API JSON in assertions
type Json = any;

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(100);
  }
}

function settings(workerPort = 0): CoordinatorSettings {
  return {
    schema_version: 1,
    human: { host: "127.0.0.1", port: 0 },
    agent: { host: "127.0.0.1", port: 0 },
    worker: { host: "127.0.0.1", port: workerPort },
    mlflow: { enabled: false },
    jobs: { supervisor: "direct", deliver_deadline_sec: 60 },
    remote: {
      heartbeat_sec: 1,
      disconnected_after_sec: 3,
      provider_poll_sec: 1,
      max_backoff_sec: 1,
      min_free_disk_bytes: 0,
    },
  };
}

async function coordinator(home: string, fake: FakeMlflow, workerPort = 0) {
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    jobWatchdogMs: 200,
    remoteTickMs: 200,
    settings: settings(workerPort),
    home,
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  const cookie = await cl.browserSession();
  const auth = { cookie, origin: cl.localOrigin };
  const browser = <T = Json>(path: string, body: unknown = {}) =>
    cl.json<T>(cl.human(path, { ...auth, body }));
  const agent = async <T = Json>(pid: string, path: string, body: unknown) => {
    const minted = await cl.agentSession(pid);
    return cl.json<T>(cl.agent(path, { token: minted.token, body }));
  };
  return { cl, call, browser, agent };
}

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    ["git", "-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
}

describe("Python extension contributions on remote targets", () => {
  test("an approved contribution runs as a job on a target from the staged inputs, survives a coordinator restart and is recorded once", async () => {
    const fakeMl = new FakeMlflow().start();
    fakes.push(fakeMl);
    const home = h.tmp("ak-home-");
    const first = await coordinator(home, fakeMl);
    const workerPort = Number(new URL(first.cl.c.urls.worker).port);
    const host = fakeHost(h.tmp("ak-remote-"));
    const dir = join(h.tmp(), "p");
    mkdirSync(join(dir, ".ablationkit/extensions"), { recursive: true });
    cpSync(join(FIXTURES, "py-evaluator"), join(dir, ".ablationkit/extensions/py-evaluator"), {
      recursive: true,
    });
    writeFileSync(join(dir, "README.md"), "p\n");
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    expect(
      (await first.call("/api/v1/projects", { body: { path: dir, project_id: "p" } })).status,
    ).toBe(201);
    const svc = first.cl.c.services;
    const exp = await svc.tracking.ensureExperimentNow("p");
    const seeded = await svc.tracking.client.createRun({ experiment_id: exp, run_name: "seed" });
    const runId = seeded.info.run_id;
    await svc.tracking.client.logBatch({
      run_id: runId,
      metrics: [
        { key: "loss", value: 0.25, timestamp: 1, step: 0 },
        { key: "acc", value: 0.9, timestamp: 1, step: 0 },
      ],
    });
    const P = "/api/v1/projects/p/extensions/py-evaluator";
    const b = await first.call(`${P}/build`, { body: {} });
    expect(b.status).toBe(201);
    expect(b.body.build.python.packages ?? []).toEqual([]);
    expect(
      (await first.browser(`${P}/approve`, { build_id: b.body.build.build_id, trusted_code: true }))
        .status,
    ).toBe(200);
    const t = await first.call("/api/v1/targets/box", {
      method: "PUT",
      body: {
        kind: "ssh",
        ssh: { host: "box", command: [host.ssh], supervisor: "nohup" },
        worker_url: first.cl.c.urls.worker,
      },
    });
    expect([200, 201]).toContain(t.status);
    const body = {
      contribution: "evaluate",
      params: { scale: 4 },
      refs: [{ kind: "run", id: runId }],
      target_id: "box",
    };
    // Only a researcher runs a contribution remotely.
    const byAgent = await first.agent("p", `${P}/run`, body);
    expect([byAgent.status, byAgent.body.error.code]).toEqual([403, "remote_humans_only"]);

    const started = await first.call(`${P}/run`, { body });
    expect(started.status).toBe(202);
    const x = started.body.execution;
    expect(x.status).toBe("running");
    expect(x.remote).toMatchObject({ target_id: "box" });
    expect(x.enforcement).toMatchObject({ limits: "advisory", network: "advisory" });
    const jobId = x.remote.job_id as string;
    // Submitted to the target; then the workstation goes off.
    await until(
      async () =>
        (await first.call(`/api/v1/jobs/${jobId}`)).body.latest_attempt.remote?.staging ===
        "submitted",
    );
    await first.cl.c.stop();
    h.coordinators.splice(h.coordinators.indexOf(first.cl.c), 1);
    await Bun.sleep(1500);

    const second = await coordinator(home, fakeMl, workerPort);
    const done = await until(async () => {
      const r = await second.call(`/api/v1/projects/p/extension-executions/${x.execution_id}`);
      return r.body.execution.status !== "running" && r.body.execution;
    });
    expect(done.error).toBeUndefined();
    expect(done.status).toBe("succeeded");
    // The same typed result as a local run, from the staged run.
    expect(done.result.summary).toBe("scaled loss 1.000");
    expect(done.result.metrics).toEqual({ scaled_loss: "1.0", metric_count: "2", ratio: "0.0625" });
    expect(done.result.artifacts.map((a: Json) => a.path).sort()).toEqual([
      "evaluation.json",
      "notes/readme.txt",
    ]);
    const job = (await second.call(`/api/v1/jobs/${jobId}`)).body;
    expect(job.attempts).toHaveLength(1);
    expect(job.latest_attempt.state).toBe("succeeded");
    // Recorded through the coordinator to MLflow (project.results.write), once.
    const mr = fakeMl.run(done.mlflow_run_id);
    expect(mr?.tags.get("ablationkit.extension.execution")).toBe(x.execution_id);
    expect(mr?.metrics.find((m) => m.key === "scaled_loss")?.value).toBe(1);
    expect(mr?.artifacts.get("extension/evaluation.json")).toBeDefined();
    const tagged = await second.cl.c.services.tracking.client.searchRuns({
      experiment_ids: [exp],
      filter: `tags.\`ablationkit.extension.execution\` = '${x.execution_id}'`,
    });
    expect(tagged.items.map((r) => r.info.run_id)).toEqual([done.mlflow_run_id]);

    // A call that needs the coordinator is refused on the target, not answered.
    const sum = await second.call(`${P}/run`, {
      body: {
        contribution: "summarize",
        params: {},
        refs: [{ kind: "run", id: runId }],
        target_id: "box",
      },
    });
    expect(sum.status).toBe(202);
    const s2 = await until(async () => {
      const r = await second.call(
        `/api/v1/projects/p/extension-executions/${sum.body.execution.execution_id}`,
      );
      return r.body.execution.status !== "running" && r.body.execution;
    });
    // runs.list answers with the staged runs only.
    expect(s2.result.summary).toBe("1 runs");
  }, 180_000);
});
