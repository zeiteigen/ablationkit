/**
 * Remote research endpoints (criterion 12, endpoint half; spec §10 offline nuance; ADR 0023
 * decision 20). A `remote_research` deployment on a Runpod target is a pod that pulls the pinned
 * model package with a per-deployment fetch token, verifies it and serves it until the
 * deployment's expiry. The pod is supervised by the provider, so it keeps serving while the
 * coordinator is off and stays `running` after a restart; stopping the deployment removes the pod.
 *
 * Runpod is `FakeRunpod` (pods are local process groups running the real start command); MLflow is
 * `FakeMlflow`. The serve command is a tiny HTTP server answering the SHA-256 of the served MLmodel.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CoordinatorSettings,
  DeploymentRecord,
  ProjectActionPolicy,
} from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";
import { FakeRunpod, stopRemotes } from "./remote-host.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
const pods: FakeRunpod[] = [];
const KEY_ENV = "AK_TEST_RUNPOD_KEY";

afterEach(async () => {
  for (const p of pods.splice(0)) await p.stop();
  stopRemotes();
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

type Json = Record<string, unknown>;

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(100);
  }
}

function settings(workerPort: number): CoordinatorSettings {
  return {
    schema_version: 1,
    human: { host: "127.0.0.1", port: 0 },
    agent: { host: "127.0.0.1", port: 0 },
    worker: { host: "127.0.0.1", port: workerPort },
    mlflow: { enabled: false },
    jobs: { supervisor: "direct" },
    remote: { provider_poll_sec: 1 },
  };
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port as number;
  s.stop(true);
  return p;
}

const MLMODEL = "flavors:\n  python_function:\n    loader_module: mlflow.sklearn\n";

/** A registered model version `width/1` whose logged model holds MLmodel and model.pkl. */
async function seedModel(fake: FakeMlflow): Promise<void> {
  const post = async (path: string, body: Json) => {
    const r = await fetch(`${fake.url}/api/2.0/mlflow/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return (await r.json()) as Json;
  };
  const exp = (await post("experiments/create", { name: "seed" })) as { experiment_id: string };
  const m = (await post("logged-models", { experiment_id: exp.experiment_id, name: "w" })) as {
    model: { info: { model_id: string; artifact_uri: string } };
  };
  const root = m.model.info.artifact_uri.slice("mlflow-artifacts:/".length);
  for (const [p, body] of [
    ["MLmodel", MLMODEL],
    ["data/model.pkl", "pickled-weights"],
  ] as const) {
    const r = await fetch(`${fake.url}/api/2.0/mlflow-artifacts/artifacts/${root}/${p}`, {
      method: "PUT",
      body,
    });
    if (!r.ok) throw new Error(`upload ${p}: ${r.status}`);
  }
  await post("registered-models/create", { name: "width" });
  await post("model-versions/create", {
    name: "width",
    source: `models:/${m.model.info.model_id}`,
    model_id: m.model.info.model_id,
  });
}

const SERVE = `python3 -c 'import hashlib, http.server, os
d = open(os.path.join(os.environ["MODEL_DIR"], "MLmodel"), "rb").read()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(s):
        b = hashlib.sha256(d).hexdigest().encode()
        s.send_response(200); s.end_headers(); s.wfile.write(b)
    def log_message(s, *a): pass
http.server.HTTPServer(("127.0.0.1", int(os.environ["PORT"])), H).serve_forever()'`;

async function serving(port: number): Promise<string | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.text() : undefined;
  } catch {
    return undefined;
  }
}

async function coordinator(home: string, fake: FakeMlflow, workerPort: number) {
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    settings: settings(workerPort),
    home,
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  return { cl, call };
}

describe("Remote research endpoints (criterion 12, endpoint half)", () => {
  test("a Runpod endpoint pulls the pinned model, serves it while the coordinator is off, stays running after a restart, and is removed when stopped", async () => {
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    await seedModel(fake);
    const home = h.tmp("ak-home-");
    const podHome = h.tmp("ak-pod-");
    process.env[KEY_ENV] = "rp-test-key";
    const rp = new FakeRunpod(podHome, "rp-test-key", { ts: "" }).start();
    pods.push(rp);
    const workerPort = await freePort();
    const servePort = await freePort();
    const first = await coordinator(home, fake, workerPort);
    const repo = join(h.tmp(), "proj");
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", repo]);
    expect(
      (await first.call("/api/v1/projects", { body: { path: repo, project_id: "ep" } })).status,
    ).toBe(201);
    const put = await first.call("/api/v1/targets/pods", {
      method: "PUT",
      body: {
        kind: "runpod",
        runpod: {
          api_url: rp.url,
          api_key_env: KEY_ENV,
          image: "python:3.12",
          gpu_type_ids: ["NVIDIA A40"],
          cents_per_hour: 50,
          tailscale_authkey_secret: "ts",
          serve_command: SERVE,
          serve_port: servePort,
        },
        work_dir: join(podHome, "workspace", ".ablationkit-worker"),
        worker_url: first.cl.c.urls.worker,
      },
    });
    expect([200, 201]).toContain(put.status);

    // The researcher allows agents research endpoints on this target only.
    const cookie = await first.cl.browserSession();
    const auth = { cookie, origin: first.cl.localOrigin };
    const cur = (await first.call<{ policy: ProjectActionPolicy }>("/api/v1/projects/ep/policy"))
      .body.policy;
    const {
      schema_version: _s,
      project_id: _p,
      revision: _r,
      created_at: _c,
      created_by: _b,
      ...rest
    } = cur;
    const rev = await first.cl.json(
      first.cl.human("/api/v1/projects/ep/policy/revisions", {
        ...auth,
        body: {
          policy: {
            ...rest,
            deployments: {
              ...cur.deployments,
              remote_research: {
                decision: "allow",
                allowed_targets: ["pods"],
                exposure: "tailnet",
                max_runtime_minutes: 120,
              },
            },
          },
        },
      }),
    );
    expect(rev.status).toBe(201);

    const request = (body: Json) =>
      first.call<{
        outcome: string;
        deployment: DeploymentRecord;
        estimate?: { cents: number };
        error?: { code: string };
      }>("/api/v1/projects/ep/deployments", {
        body: {
          kind: "remote_research",
          model_uri: "models:/width/1",
          target: "pods",
          exposure: "tailnet",
          ttl_minutes: 30,
          ...body,
        },
      });
    // 50 cents/hour for 30 minutes is about 25 cents: a ceiling of 10 is refused up front.
    const over = await request({ max_cents: 10 });
    expect(over.status).toBe(409);
    expect(over.body.error?.code).toBe("over_spend_ceiling");
    const req = await request({ max_cents: 100 });
    expect(req.status).toBe(201);
    expect(req.body.estimate?.cents).toBe(25);
    const dep = req.body.deployment;
    expect(dep).toMatchObject({
      status: "running",
      endpoint: `http://ak-${dep.deployment_id}:${servePort}`,
      provider: {
        target_id: "pods",
        target_kind: "runpod",
        provider_ref: "pod1",
        independent_supervision: true,
        estimate_cents: 25,
      },
    });

    // The pod pulled and verified the exact model files and serves them.
    const digest = createHash("sha256").update(MLMODEL).digest("hex");
    const served = await until(() => serving(servePort));
    expect(served).toBe(digest);
    // The fetch token is the only key to the package.
    const wrong = await fetch(
      `${first.cl.c.urls.worker}/api/v1/deployments/${dep.deployment_id}/model`,
      { headers: { authorization: "Bearer nope" } },
    );
    expect(wrong.status).toBe(401);

    // The coordinator goes away: the endpoint keeps serving (supervised by the provider).
    await first.cl.c.stop();
    await Bun.sleep(500);
    expect(await serving(servePort)).toBe(digest);

    // Back again: the deployment is still running once the provider confirms the pod.
    const second = await coordinator(home, fake, workerPort);
    const view = await until(async () => {
      const d = (
        await second.call<{ deployments: DeploymentRecord[] }>("/api/v1/projects/ep/deployments")
      ).body.deployments.find((x) => x.deployment_id === dep.deployment_id);
      return d?.provider?.state === "RUNNING" ? d : undefined;
    });
    expect(view.status).toBe("running");
    expect(rp.calls.filter((c) => c === "POST /pods")).toHaveLength(1);
    expect(await serving(servePort)).toBe(digest);

    // Stopping the deployment removes the pod and its package.
    const stop = await second.call<{ deployment: DeploymentRecord }>(
      `/api/v1/projects/ep/deployments/${dep.deployment_id}/stop`,
      { body: {} },
    );
    expect(stop.body.deployment.status).toBe("stopped");
    await until(async () => rp.pods.size === 0 && true);
    await until(async () => (await serving(servePort)) === undefined && true);
    // The pod's environment never held the Runpod API key.
    const out = await Bun.file(join(podHome, "pod1.out")).text();
    expect(out).not.toContain("rp-test-key");
  }, 90_000);
  test("the fetch token is the only key: missing, wrong, another deployment's, expired and stopped are all refused and audited", async () => {
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    await seedModel(fake);
    const home = h.tmp("ak-home-");
    const podHome = h.tmp("ak-pod-");
    process.env[KEY_ENV] = "rp-test-key";
    const rp = new FakeRunpod(podHome, "rp-test-key", { ts: "" }).start();
    pods.push(rp);
    const servePort = await freePort();
    const w = await coordinator(home, fake, await freePort());
    const repo = join(h.tmp(), "proj");
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", repo]);
    await w.call("/api/v1/projects", { body: { path: repo, project_id: "ep" } });
    await w.call("/api/v1/targets/pods", {
      method: "PUT",
      body: {
        kind: "runpod",
        runpod: {
          api_url: rp.url,
          api_key_env: KEY_ENV,
          image: "python:3.12",
          gpu_type_ids: ["NVIDIA A40"],
          cents_per_hour: 50,
          tailscale_authkey_secret: "ts",
          serve_command: SERVE,
          serve_port: servePort,
        },
        work_dir: join(podHome, "workspace", ".ablationkit-worker"),
        worker_url: w.cl.c.urls.worker,
      },
    });
    const cookie = await w.cl.browserSession();
    const auth = { cookie, origin: w.cl.localOrigin };
    const cur = (await w.call<{ policy: ProjectActionPolicy }>("/api/v1/projects/ep/policy")).body
      .policy;
    const {
      schema_version: _s,
      project_id: _p,
      revision: _r,
      created_at: _c,
      created_by: _b,
      ...rest
    } = cur;
    await w.cl.json(
      w.cl.human("/api/v1/projects/ep/policy/revisions", {
        ...auth,
        body: {
          policy: {
            ...rest,
            deployments: {
              ...cur.deployments,
              remote_research: {
                decision: "allow",
                allowed_targets: ["pods"],
                exposure: "tailnet",
                max_runtime_minutes: 120,
              },
            },
          },
        },
      }),
    );
    const deploy = async (): Promise<DeploymentRecord> => {
      const req = await w.call<{ deployment: DeploymentRecord }>(
        "/api/v1/projects/ep/deployments",
        {
          body: {
            kind: "remote_research",
            model_uri: "models:/width/1",
            target: "pods",
            exposure: "tailnet",
            ttl_minutes: 30,
            max_cents: 100,
          },
        },
      );
      expect(req.status).toBe(201);
      return req.body.deployment;
    };
    const dep = await deploy();
    const located = Bun.spawnSync(
      ["find", home, "-name", "fetch.json", "-path", `*${dep.deployment_id}*`],
      {
        stdout: "pipe",
      },
    )
      .stdout.toString()
      .trim();
    expect(located.length).toBeGreaterThan(0);
    // The real token, as the pod's environment holds it.
    const token = rp.pods.get("pod1")?.env["AK_MODEL_TOKEN"] as string;
    const fetchModel = (id: string, t?: string) =>
      fetch(`${w.cl.c.urls.worker}/api/v1/deployments/${id}/model`, {
        headers: t ? { authorization: `Bearer ${t}` } : {},
      });
    const status = async (id: string, t?: string) => {
      const r = await fetchModel(id, t);
      await r.body?.cancel();
      return r.status;
    };
    // The token stays in the pod's environment: the coordinator stores only its hash.
    const meta = JSON.parse(readFileSync(located, "utf8")) as { token_sha256: string };
    expect(meta.token_sha256).toBe(createHash("sha256").update(token).digest("hex"));
    expect(readFileSync(located, "utf8")).not.toContain(token);

    expect(await status(dep.deployment_id, token)).toBe(200);
    expect(await status(dep.deployment_id)).toBe(401);
    expect(await status(dep.deployment_id, "nope")).toBe(401);
    expect(await status(dep.deployment_id, token.slice(0, -1))).toBe(401);
    expect(await status("d-unknown", token)).toBe(401);
    expect(await status("..%2F..%2Fauth", token)).toBe(401);
    // A worker or session credential is not a fetch token.
    expect(await status(dep.deployment_id, await w.cl.session())).toBe(401);
    // Expired: the file's deadline passed, even though the deployment still runs.
    const saved = readFileSync(located, "utf8");
    writeFileSync(
      located,
      JSON.stringify({ ...JSON.parse(saved), expires_at: "2020-01-01T00:00:00.000Z" }),
    );
    expect(await status(dep.deployment_id, token)).toBe(401);
    writeFileSync(located, saved);
    expect(await status(dep.deployment_id, token)).toBe(200);
    // Stopped: the same token no longer works.
    const stop = await w.call<{ deployment: DeploymentRecord }>(
      `/api/v1/projects/ep/deployments/${dep.deployment_id}/stop`,
      { body: {} },
    );
    expect(stop.body.deployment.status).toBe("stopped");
    expect(await status(dep.deployment_id, token)).toBe(401);
    const audit = Bun.spawnSync(["grep", "-rh", "deployment.model.fetch", join(home, "audit")], {
      stdout: "pipe",
    }).stdout.toString();
    for (const why of ["wrong fetch token", "no token"]) expect(audit).toContain(why);
    expect(audit).toContain("no model package for this deployment"); // stopping removes it
    expect(audit).toContain("deployment expired");
    expect(audit).not.toContain(token);
  }, 90_000);
});
