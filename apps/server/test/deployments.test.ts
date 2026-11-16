/**
 * Deployment gates and what survives a restart (ADR 0037), against a fake MLflow, a fake launcher
 * and a real Git checkout. Criteria 32 and 34.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CoordinatorSettings,
  DeploymentRecord,
  ProjectActionPolicy,
} from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import type { DeploymentLauncher } from "../src/compute/deployments.ts";
import { Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

type Json = Record<string, unknown>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "r",
      GIT_AUTHOR_EMAIL: "r@r",
      GIT_COMMITTER_NAME: "r",
      GIT_COMMITTER_EMAIL: "r@r",
    },
  }).trim();
}

class FakeLauncher implements DeploymentLauncher {
  readonly name = "fake";
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  async start(d: DeploymentRecord) {
    this.started.push(d.deployment_id);
    return { endpoint: `http://127.0.0.1:7001/${d.deployment_id}` };
  }
  async stop(d: DeploymentRecord) {
    this.stopped.push(d.deployment_id);
  }
}

interface World {
  project: string;
  main: string;
  home: string;
  launcher: FakeLauncher;
  human<T = Json>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ status: number; body: T }>;
  agent<T = Json>(
    token: string,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ status: number; body: T }>;
  revise(over: Partial<ProjectActionPolicy>): Promise<{ status: number; body: Json }>;
  token(): Promise<string>;
  restart(): Promise<void>;
  services(): import("../src/services.ts").Services;
  /** Another project registered in the same coordinator, sharing the session. */
  sibling(name: string): Promise<World>;
}

function makeRepo(name: string): { main: string; root: string } {
  const root = h.tmp("ak-dep-");
  const main = join(root, name);
  const origin = join(root, `${name}.git`);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", main);
  writeFileSync(join(main, "score.txt"), "0.70\n");
  mkdirSync(join(main, "src"));
  writeFileSync(join(main, "src/model.py"), "WIDTH = 64\n");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "init");
  git(main, "remote", "add", "origin", origin);
  git(main, "push", "-q", "origin", "main");
  return { main, root };
}

async function world(name = "lab"): Promise<World> {
  const { main } = makeRepo(name);
  const fake = new FakeMlflow().start();
  fakes.push(fake);
  const launcher = new FakeLauncher();
  const home = h.tmp("ak-home-");
  const settings: CoordinatorSettings = {
    schema_version: 1,
    human: { host: "127.0.0.1", port: 0 },
    agent: { host: "127.0.0.1", port: 0 },
    worker: { host: "127.0.0.1", port: 0 },
    mlflow: { enabled: false },
    jobs: { supervisor: "direct", deliver_deadline_sec: 30 },
  };
  const start = () =>
    h.start({
      home,
      settings,
      trackingUrl: fake.url,
      trackingIntervalMs: 20,
      deploymentLauncher: launcher,
    });
  let cl = await start();
  let session = await cl.session();
  const register = async (path: string, n: string): Promise<string> => {
    const reg = await cl.json<{ project: { project_id: string } }>(
      cl.human("/api/v1/projects", { token: session, body: { path, name: n } }),
    );
    expect(reg.status).toBe(201);
    git(path, "add", "-A");
    git(path, "commit", "-qm", "register");
    git(path, "push", "-q", "origin", "main");
    return reg.body.project.project_id;
  };
  const make = (project: string, main: string): World => {
    const w: World = {
      project,
      main,
      home,
      launcher,
      human: (path, init = {}) => cl.json(cl.human(path, { token: session, ...init })),
      agent: (token, path, init = {}) => cl.json(cl.agent(path, { token, ...init })),
      revise: async (over) => {
        const cur = (
          await w.human<{ policy: ProjectActionPolicy }>(`/api/v1/projects/${project}/policy`)
        ).body.policy;
        const {
          schema_version: _s,
          project_id: _p,
          revision: _r,
          created_at: _c,
          created_by: _b,
          ...rest
        } = cur;
        return w.human(`/api/v1/projects/${project}/policy/revisions`, {
          body: { policy: { ...rest, ...over } },
        });
      },
      token: async () => {
        return (await cl.agentSession(project)).token;
      },
      restart: async () => {
        await cl.c.stop();
        cl = await start();
        session = await cl.session();
      },
      services: () => cl.c.services,
      sibling: async (n) => {
        const r = makeRepo(n);
        return make(await register(r.main, n), r.main);
      },
    };
    return w;
  };
  return make(await register(main, name), main);
}

function readAudit(w: World): string {
  const d = join(w.home, "audit");
  return readdirSync(d)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => readFileSync(join(d, f), "utf8"))
    .join("");
}

const dep = (w: World, body: Json, token?: string) =>
  token
    ? w.agent<{
        outcome: string;
        deployment: DeploymentRecord;
        reasons?: string[];
        error?: { code: string };
      }>(token, `/api/v1/projects/${w.project}/deployments`, { body })
    : w.human<{
        outcome: string;
        deployment: DeploymentRecord;
        reasons?: string[];
        error?: { code: string };
      }>(`/api/v1/projects/${w.project}/deployments`, { body });

describe("Deployment permissions (criterion 32)", () => {
  test("an agent in A opens a loopback preview within its cap but never a persistent or public endpoint; B allows remote sessions on one target; pinned, TTL'd, audited", async () => {
    const a = await world("alpha");
    const pa = (
      await a.human<{ policy: ProjectActionPolicy }>(`/api/v1/projects/${a.project}/policy`)
    ).body.policy;
    expect(
      (
        await a.revise({
          deployments: {
            ...pa.deployments,
            preview_local: { decision: "allow", exposure: "loopback", max_runtime_minutes: 30 },
          },
        })
      ).status,
    ).toBe(201);
    const ta = await a.token();
    const preview = await dep(
      a,
      { kind: "preview_local", model_uri: "models:/width/3", ttl_minutes: 20 },
      ta,
    );
    expect(preview.status).toBe(201);
    expect(preview.body.deployment).toMatchObject({
      status: "running",
      exposure: "loopback",
      model_uri: "models:/width/3",
      target: "local",
      requested_by: { kind: "agent" },
    });
    expect(preview.body.deployment.expires_at).toBeDefined();
    expect(
      (
        await dep(
          a,
          { kind: "preview_local", model_uri: "models:/width@champion", ttl_minutes: 20 },
          ta,
        )
      ).body.error?.code,
    ).toBe("model_not_pinned");
    const long = await dep(
      a,
      { kind: "preview_local", model_uri: "models:/width/3", ttl_minutes: 120 },
      ta,
    );
    expect(long.status).toBe(403);
    expect(long.body.reasons?.join()).toContain("deployments.preview_local.max_runtime_minutes");
    const persistent = await dep(
      a,
      {
        kind: "persistent",
        model_uri: "models:/width/3",
        target: "runpod",
        exposure: "tailnet",
        ttl_minutes: 60,
      },
      ta,
    );
    expect(persistent.body.outcome).toBe("blocked");
    expect(persistent.body.reasons?.[0]).toContain("deployments.persistent.decision");
    // A public endpoint is never started, for an agent or the researcher.
    for (const token of [ta, undefined])
      expect(
        (
          await dep(
            a,
            {
              kind: "public",
              model_uri: "models:/width/3",
              target: "runpod",
              exposure: "public",
              ttl_minutes: 60,
            },
            token,
          )
        ).body.outcome,
      ).toBe("blocked");
    // TTL enforcement: the sweeper expires it.
    const svcA = a.services();
    const rec = svcA.deployments.require(preview.body.deployment.deployment_id);
    (svcA.deployments as unknown as { records: Map<string, DeploymentRecord> }).records.set(
      rec.deployment_id,
      { ...rec, expires_at: new Date(Date.now() - 1000).toISOString() },
    );
    svcA.deployments.sweep();
    expect(svcA.deployments.require(rec.deployment_id).status).toBe("expired");
    expect(a.launcher.stopped).toContain(rec.deployment_id);

    // B's policy is its own: the same agent request is denied until B allows it.
    const b = await a.sibling("beta");
    const tb = await b.token();
    const remote = {
      kind: "remote_research",
      model_uri: "runs:/0123abcd0123abcd/model",
      target: "runpod",
      exposure: "tailnet",
      ttl_minutes: 60,
      max_cents: 500,
    };
    expect((await dep(b, remote, tb)).body.reasons?.[0]).toContain(
      "deployments.remote_research.decision to deny",
    );
    const pb = (
      await b.human<{ policy: ProjectActionPolicy }>(`/api/v1/projects/${b.project}/policy`)
    ).body.policy;
    expect(
      (
        await b.revise({
          deployments: {
            ...pb.deployments,
            remote_research: {
              decision: "allow",
              allowed_targets: ["runpod"],
              max_runtime_minutes: 120,
            },
          },
        })
      ).status,
    ).toBe(201);
    const slurm = await dep(b, { ...remote, target: "slurm" }, tb);
    expect(slurm.body.outcome).toBe("blocked");
    expect(slurm.body.reasons?.join()).toContain(
      "not in deployments.remote_research.allowed_targets",
    );
    const ok = await dep(b, remote, tb);
    expect(ok.status).toBe(201);
    expect(ok.body.deployment).toMatchObject({
      status: "running",
      target: "runpod",
      max_cents: 500,
    });
    // A's policy is unchanged by B's.
    expect((await dep(a, remote, ta)).body.outcome).toBe("blocked");
    const audit = readAudit(b);
    expect(audit).toContain("deployment.start");
    expect(audit).toContain("deployment.request");
  }, 60_000);
});

describe("After a restart (criterion 34)", () => {
  test("nothing starts silently: a local preview does not survive, and a request that waited for an approval before ADR 0037 loads closed", async () => {
    const w = await world();
    const running = await dep(w, {
      kind: "preview_local",
      model_uri: "models:/m/2",
      ttl_minutes: 10,
    });
    expect(running.status).toBe(201);
    // A request a home kept from before approvals were removed.
    const legacy = {
      ...running.body.deployment,
      deployment_id: "dep-20261101-0000aaaa",
      status: "pending_approval",
      approval_id: "appr-20261101-old",
      requested_at: "2026-11-01T00:00:00.000Z",
    } as Record<string, unknown>;
    for (const k of ["started_at", "expires_at", "endpoint"]) delete legacy[k];
    const dir = join(w.home, "state", w.project, "deployments");
    writeFileSync(join(dir, "dep-20261101-0000aaaa.json"), JSON.stringify(legacy));
    const started = w.launcher.started.length;

    await w.restart();
    const svc = w.services();
    expect(svc.deployments.require(running.body.deployment.deployment_id).status).toBe("stopped");
    const old = svc.deployments.require("dep-20261101-0000aaaa");
    expect(old.status).toBe("invalidated");
    expect(old.status_reason).toContain("request it again");
    expect((old as Record<string, unknown>)["approval_id"]).toBeUndefined();
    expect(w.launcher.started.length).toBe(started);
  }, 60_000);
});
