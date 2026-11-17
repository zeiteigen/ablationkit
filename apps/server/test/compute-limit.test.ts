/**
 * The agent compute limit (ADR 0037): machine-wide weights, weighted hours of agent-submitted jobs
 * (every attempt, at the weight recorded when the job was submitted), reservation by live attempts'
 * time limits, admission at agent submission, the refusal and its notification, the agent's read
 * route, and a policy revision that raises the limit.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorSettings, JournalEvent, ProjectActionPolicy } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  for (const c of h.coordinators)
    for (const j of c.services.jobs.list())
      for (const id of j.attempts) {
        const a = c.services.jobs.attempt(id);
        for (const pid of [a?.collector.pid, a?.pid ? -a.pid : undefined]) {
          try {
            if (pid) process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

type Json = Record<string, unknown>;
interface Usage {
  limit_hours: number;
  used_hours: number;
  reserved_hours: number;
  available_hours: number;
  jobs: number;
  attempts: number;
  live: number;
  over_limit: boolean;
  refused?: { count: number; message: string };
  targets: { target_id: string; weight: number; limits: string; limits_reason?: string }[];
}
interface Refusal {
  error: {
    code: string;
    message: string;
    used_hours: number;
    reserved_hours: number;
    limit_hours: number;
    needed_hours: number;
    weight: number;
    target: string;
  };
}

const SETTINGS: CoordinatorSettings = {
  schema_version: 1,
  human: { host: "127.0.0.1", port: 0 },
  agent: { host: "127.0.0.1", port: 0 },
  worker: { host: "127.0.0.1", port: 0 },
  mlflow: { enabled: false },
  jobs: { supervisor: "direct", deliver_deadline_sec: 30 },
};

async function setup() {
  const fake = new FakeMlflow().start();
  fakes.push(fake);
  const cl = await h.start({ trackingUrl: fake.url, trackingIntervalMs: 20, settings: SETTINGS });
  const raised: JournalEvent[] = [];
  cl.c.services.events.subscribe((e) => {
    if (e.type === "notification.raised") raised.push(e);
  });
  const session = await cl.session();
  const human = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token: session, ...init }));
  const repo = h.repo("lab");
  writeFileSync(join(repo, "train.py"), "print('ok')\n");
  expect(
    (await human("/api/v1/projects", { body: { path: repo, project_id: "lab" } })).status,
  ).toBe(201);
  const { token } = await cl.agentSession("lab");
  const agent = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.agent(path, { token, ...init }));
  const submit = <T = Json>(runtime: number | undefined, over: Json = {}) =>
    agent<T>("/api/v1/projects/lab/jobs", {
      body: {
        command: ["sleep", "30"],
        environment: "none",
        ...(runtime ? { limits: { runtime_max_sec: runtime } } : {}),
        ...over,
      },
    });
  const revise = async (over: Partial<ProjectActionPolicy>) => {
    const cur = (await human<{ policy: ProjectActionPolicy }>("/api/v1/projects/lab/policy")).body
      .policy;
    const {
      schema_version: _s,
      project_id: _p,
      revision: _r,
      created_at: _c,
      created_by: _b,
      ...rest
    } = cur;
    const r = await human("/api/v1/projects/lab/policy/revisions", {
      body: { policy: { ...rest, ...over } },
    });
    expect(r.status).toBe(201);
  };
  const usage = async () => (await agent<Usage>("/api/v1/projects/lab/compute")).body;
  const audit = () =>
    readdirSync(join(cl.c.services.paths.home, "audit"))
      .map((f) => readFileSync(join(cl.c.services.paths.home, "audit", f), "utf8"))
      .join("");
  const cancelAll = async () => {
    for (const j of cl.c.services.jobs.list("lab")) {
      const a = cl.c.services.jobs.latestAttempt(j);
      if (a && (a.state === "starting" || a.state === "running"))
        await human(`/api/v1/jobs/${j.job_id}/cancel`, { body: {} });
    }
  };
  const settled = async (jobId: string) => {
    for (let i = 0; i < 300; i++) {
      const s = cl.c.services.jobs.get(jobId)?.state;
      if (s && s !== "starting" && s !== "running") return s;
      await Bun.sleep(50);
    }
    throw new Error(`${jobId} did not finish`);
  };
  return { cl, human, agent, submit, revise, usage, audit, raised, cancelAll, settled };
}

const close = (x: number, y: number) => expect(Math.abs(x - y)).toBeLessThan(0.01);

describe("compute weights", () => {
  test("the researcher sets them, agents read them; each agent job records the weight in effect and keeps it", async () => {
    const { human, agent, submit, usage, cancelAll } = await setup();
    const initial = await agent<{ weights: { target_id: string; weight: number }[] }>(
      "/api/v1/compute/weights",
    );
    expect(initial.body.weights).toEqual([
      expect.objectContaining({ target_id: "local", weight: 1, default: true }),
    ]);
    expect(
      (await human("/api/v1/compute/weights", { method: "PUT", body: { weights: { local: 0 } } }))
        .status,
    ).toBe(400);
    expect(
      (
        await human("/api/v1/compute/weights", {
          method: "PUT",
          body: { weights: { local: 1.005 } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await human("/api/v1/compute/weights", { method: "PUT", body: { weights: { gpu: 2 } } }))
        .status,
    ).toBe(404);
    const set = await human<{ changes: Json[] }>("/api/v1/compute/weights", {
      method: "PUT",
      body: { weights: { local: 2.5 } },
    });
    expect(set.status).toBe(200);
    expect(set.body.changes).toEqual([{ target_id: "local", from: 1, to: 2.5 }]);
    // Agents read, never write.
    expect(
      (await agent("/api/v1/compute/weights", { method: "PUT", body: { weights: { local: 1 } } }))
        .status,
    ).toBe(404);
    expect(
      (await agent<{ weights: { weight: number }[] }>("/api/v1/compute/weights")).body.weights[0]
        ?.weight,
    ).toBe(2.5);
    // The compute view lists the targets the policy lets agents use, with weight and enforcement
    // (direct mode here: advisory, with the reason).
    const view = (await usage()).targets;
    expect(view).toEqual([
      expect.objectContaining({ target_id: "local", weight: 2.5, limits: "advisory" }),
    ]);
    expect(view[0]?.limits_reason).toContain("direct mode");

    const job = await submit<{ compute_weight_hundredths: number }>(3600);
    expect(job.status).toBe(201);
    expect(job.body.compute_weight_hundredths).toBe(250);
    close((await usage()).reserved_hours, 2.5);
    // A new weight applies to new jobs only.
    await human("/api/v1/compute/weights", { method: "PUT", body: { weights: { local: null } } });
    close((await usage()).reserved_hours, 2.5);
    const next = await submit<{ compute_weight_hundredths: number }>(3600);
    expect(next.body.compute_weight_hundredths).toBe(100);
    close((await usage()).reserved_hours, 3.5);
    await cancelAll();
  });
});

describe("admission at agent submission", () => {
  test("a time limit is required; human jobs never count; live jobs reserve their time limit; the refusal names used, reserved, limit and need; raising the limit admits the next job", async () => {
    const { cl, human, agent, submit, revise, usage, audit, raised, cancelAll } = await setup();
    await revise({ compute: { limit_hours: 2 } });

    const untimed = await submit<Refusal>(undefined);
    expect(untimed.status).toBe(400);
    expect(untimed.body.error.code).toBe("time_limit_required");
    expect(untimed.body.error.message).toContain("ablationkit_job submit");

    const mine = await human("/api/v1/projects/lab/jobs", {
      body: { command: ["sleep", "30"], environment: "none" },
    });
    expect(mine.status).toBe(201);
    expect((await usage()).jobs).toBe(0);

    expect((await submit(3600)).status).toBe(201);
    // Exactly the limit fits.
    expect((await submit(3600)).status).toBe(201);
    const u = await usage();
    // The researcher's own job holds this machine's one slot: both wait in the queue (ADR 0068),
    // each holding its whole time limit.
    expect(u).toMatchObject({ limit_hours: 2, jobs: 2, live: 0, queued: 2 });
    close(u.reserved_hours + u.used_hours, 2);

    const refused = await submit<Refusal>(60);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({
      code: "compute_limit_reached",
      limit_hours: 2,
      needed_hours: 0.017,
      weight: 1,
      target: "local",
    });
    close(refused.body.error.used_hours + refused.body.error.reserved_hours, 2);
    expect(refused.body.error.message).toContain("Project settings");
    expect(audit()).toContain('"code":"compute_limit_reached"');
    // A burst of refusals notifies once; it is in the inbox, linked to the project's settings.
    expect((await submit(60)).status).toBe(403);
    const notes = raised.filter((e) => String(e.payload["key"]).startsWith("compute_limit:lab"));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.payload).toMatchObject({
      title: "An agent reached the compute limit for lab",
      link: "/p/lab/settings#agent-permissions",
    });
    expect(String(notes[0]?.payload["body"])).toContain("Raise it in Project settings");
    expect((await usage()).refused?.count).toBe(2);
    const inbox = await human<{ items: { id: string; kind: string; ref?: string }[] }>(
      "/api/v1/inbox",
    );
    expect(inbox.body.items).toContainEqual(
      expect.objectContaining({ id: "compute_limit:lab", kind: "compute_limit", ref: "settings" }),
    );
    // The agent's summary of the policy carries the same numbers.
    const access = await agent<{ compute: Json }>("/api/v1/projects/lab/access");
    expect(access.body.compute).toMatchObject({ limit_hours: 2 });

    // The researcher raises it with a new revision: the next job is admitted, the item goes.
    await revise({ compute: { limit_hours: 3 } });
    expect((await submit(60)).status).toBe(201);
    const after = await human<{ items: { id: string }[] }>("/api/v1/inbox");
    expect(after.body.items.map((i) => i.id)).not.toContain("compute_limit:lab");
    expect((await usage()).refused).toBeUndefined();
    expect(cl.c.services.compute.usage("lab").policy_revision).toBe(2);
    await cancelAll();
  });

  test("remote: the target's weight counts; another project's usage is not the agent's to read", async () => {
    const { human, agent, submit, revise, usage } = await setup();
    expect(
      (
        await human("/api/v1/targets/gpu", {
          method: "PUT",
          body: { kind: "ssh", ssh: { host: "gpu-box" } },
        })
      ).status,
    ).toBe(201);
    await revise({
      jobs: {
        run_local: { decision: "allow" },
        submit_remote: { decision: "allow", allowed_targets: ["gpu"] },
      },
      compute: { limit_hours: 2 },
    });
    await human("/api/v1/compute/weights", { method: "PUT", body: { weights: { gpu: 3 } } });
    // The agent names no target: its job is held at the heaviest weight of its pool (ADR 0068).
    const r = await submit<Refusal>(3600);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({
      code: "compute_limit_reached",
      needed_hours: 3,
      weight: 3,
      target: "gpu",
    });
    // The allowed remote target is listed with its weight; its worker reports enforcement.
    expect((await usage()).targets).toEqual([
      expect.objectContaining({ target_id: "local" }),
      expect.objectContaining({ target_id: "gpu", weight: 3, limits: "reported_per_attempt" }),
    ]);
    const other = h.repo("other");
    await human("/api/v1/projects", { body: { path: other, project_id: "other" } });
    expect((await agent("/api/v1/projects/other/compute")).status).toBe(403);
    const all = await human<{ projects: { project_id: string }[]; weights: Json[] }>(
      "/api/v1/compute",
    );
    expect(all.body.projects.map((p) => p.project_id).sort()).toEqual(["lab", "other"]);
    expect(all.body.weights).toContainEqual(
      expect.objectContaining({ target_id: "gpu", weight: 3 }),
    );
  });
});

describe("accounting", () => {
  test("every attempt counts at the recorded weight, retries included; going over the limit notifies once", async () => {
    const { cl, human, submit, revise, usage, raised, settled } = await setup();
    await human("/api/v1/compute/weights", { method: "PUT", body: { weights: { local: 2 } } });
    const job = await submit<{ job_id: string }>(3600, { command: ["true"] });
    expect(job.status).toBe(201);
    await settled(job.body.job_id);
    // The researcher retries the agent's job: the attempt still counts against the agents' limit.
    expect((await human(`/api/v1/jobs/${job.body.job_id}/retry`, { body: {} })).status).toBe(201);
    await settled(job.body.job_id);
    expect(await usage()).toMatchObject({ jobs: 1, attempts: 2, live: 0, over_limit: false });

    // As a late import would: each attempt ran three hours (× 2 = 12 > 10).
    const jobs = cl.c.services.jobs;
    for (const id of jobs.get(job.body.job_id)?.attempts ?? []) {
      const a = jobs.attempt(id);
      if (a)
        jobs.updateAttempt({
          ...a,
          started_at: "2026-11-10T00:00:00.000Z",
          ended_at: "2026-11-10T03:00:00.000Z",
        });
    }
    const publish = () =>
      cl.c.services.events.publish("lab", "job.attempt.state", {
        job_id: job.body.job_id,
        state: "succeeded",
      });
    publish();
    await Bun.sleep(20);
    publish();
    await Bun.sleep(20);
    const u = await usage();
    expect(u).toMatchObject({ used_hours: 12, reserved_hours: 0, over_limit: true });
    const over = raised.filter((e) => e.payload["key"] === "compute_limit:lab:over");
    expect(over).toHaveLength(1);
    expect(over[0]?.payload["title"]).toBe("Agent jobs in lab went over the compute limit");
    // Raising the limit above what was used re-arms the notice.
    await revise({ compute: { limit_hours: 20 } });
    await Bun.sleep(20);
    expect((await usage()).over_limit).toBe(false);
    const state = JSON.parse(
      readFileSync(join(cl.c.services.paths.stateDir, "lab", "compute", "limit.json"), "utf8"),
    );
    expect(state.over_limit_since).toBeUndefined();
  });
});
