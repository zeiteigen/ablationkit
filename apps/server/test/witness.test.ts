/**
 * The witness (ADR 0056): every run a task's jobs produced is cited by a note or set aside with
 * the agent's reason, numbers in reporting prose are live references, and an agent session's
 * account sets the coordinator's record (jobs, how they ended, time limits hit, hours) beside what
 * the session wrote. All of it is advice: nothing here refuses a write.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CoordinatorSettings, ResearchTask } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) f.stop();
});

type Json = Record<string, unknown>;
const P = "/api/v1/projects/lab";

const SETTINGS: CoordinatorSettings = {
  schema_version: 1,
  human: { host: "127.0.0.1", port: 0 },
  agent: { host: "127.0.0.1", port: 0 },
  worker: { host: "127.0.0.1", port: 0 },
  mlflow: { enabled: false },
  jobs: { supervisor: "direct", deliver_deadline_sec: 60 },
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

interface Run {
  name?: string;
  mlflow_run_id?: string;
  state?: string;
  standing: string;
  cited_by: string[];
  set_aside?: string;
}

describe("the witness (ADR 0056)", () => {
  test("a task's runs are cited or set aside; the session's account holds its record against what it wrote", async () => {
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const cl = await h.start({
      home: h.tmp("ak-home-"),
      trackingUrl: fake.url,
      trackingIntervalMs: 20,
      jobWatchdogMs: 200,
      researchExportDelayMs: 0,
      settings: SETTINGS,
    });
    const token = await cl.session();
    const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
      cl.json<T>(cl.human(path, { token, ...init }));
    await call("/api/v1/projects", { body: { path: h.repo("lab"), project_id: "lab" } });
    const minted = await cl.agentSession("lab");
    const agent = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
      cl.json<T>(cl.agent(path, { token: minted.token, ...init }));

    const task = (
      await agent<{ task: ResearchTask }>(`${P}/tasks`, { body: { goal: "Does width help?" } })
    ).body.task;
    const submit = (run_name: string, command: string[], limit: number) =>
      agent<{ job_id: string }>(`${P}/jobs`, {
        body: {
          command,
          environment: "none",
          limits: { runtime_max_sec: limit },
          task_id: task.task_id,
          run_name,
        },
      });
    await submit("base", ["true"], 60);
    await submit("wide", ["true"], 60);
    await submit("probe", ["true"], 60);
    await submit("long", ["sleep", "30"], 1);
    const runs = async () => (await agent<{ runs: Run[] }>(`${P}/tasks/${task.task_id}`)).body.runs;
    await until(async () => {
      const r = await runs();
      return r.length === 4 && r.every((x) => x.mlflow_run_id && x.standing !== "running");
    });

    // Nothing cites them yet: all four are unaccounted for, and the task and the vault say so.
    let shown = await agent<{ runs: Run[]; checks: { code: string; message: string }[] }>(
      `${P}/tasks/${task.task_id}`,
    );
    expect(shown.body.runs.map((r) => r.standing)).toEqual(Array(4).fill("unaccounted"));
    expect(shown.body.checks.find((c) => c.code === "unaccounted_runs")?.message).toStartWith(
      "4 of the task's 4 ended runs are neither cited by a note nor set aside",
    );
    const vaultChecks = (await agent<{ checks: { code: string }[] }>(`${P}/vault/check`)).body
      .checks;
    expect(vaultChecks.map((c) => c.code)).toContain("unaccounted_runs");

    // A finding cites two (one by a live reference only), the probe is set aside with a reason.
    const added = await agent<{ checks: { code: string; message: string }[] }>(`${P}/vault/notes`, {
      body: {
        id: "wide-wins",
        type: "finding",
        title: "The wide model wins",
        gist: "The wide model ends [[run:wide#loss vs base]] lower, and 0.04 by hand.",
        evidence: [{ run: "wide", role: "for" }],
        task_id: task.task_id,
        sources: [`task:${task.task_id}`],
      },
    });
    expect(added.body.checks.find((c) => c.code === "unreferenced_number")?.message).toContain(
      "`0.04`",
    );
    const probe = (await runs()).find((r) => r.name === "probe")?.mlflow_run_id as string;
    const aside = await agent<{ mlflow_run_id: string; set_aside: { reason: string } }>(
      `${P}/runs/${probe}/description`,
      { method: "PUT", body: { set_aside: "A smoke test of the launcher, not an experiment." } },
    );
    expect(aside.status).toBe(200);
    expect(aside.body.set_aside.reason).toBe("A smoke test of the launcher, not an experiment.");
    shown = await agent(`${P}/tasks/${task.task_id}`);
    const by = Object.fromEntries(shown.body.runs.map((r) => [r.name, r]));
    expect(by["base"]).toMatchObject({ standing: "cited", cited_by: ["wide-wins"] });
    expect(by["wide"]).toMatchObject({ standing: "cited", cited_by: ["wide-wins"] });
    expect(by["probe"]).toMatchObject({
      standing: "set_aside",
      set_aside: "A smoke test of the launcher, not an experiment.",
    });
    expect(by["long"]).toMatchObject({ standing: "unaccounted", state: "timed_out" });

    // The drawer for the web UI lists every run with its task and how it stands.
    const drawer = await call<{ runs: (Run & { task_id?: string; agent?: string })[] }>(
      `${P}/vault/runs`,
    );
    expect(drawer.body.runs).toHaveLength(4);
    expect(drawer.body.runs.every((r) => r.task_id === task.task_id)).toBe(true);
    expect(drawer.body.runs.every((r) => r.agent === minted.token_id)).toBe(true);

    // A claim's standing moves; the account shows from → to beside the record.
    await agent(`${P}/vault/notes`, {
      body: {
        id: "width-helps",
        type: "claim",
        title: "Width helps",
        gist: "Width helps at this scale.",
        standing: "open",
        support: "one comparison",
        full: "![[wide-wins]]",
        sources: [`task:${task.task_id}`],
      },
    });
    await agent(`${P}/vault/notes/width-helps`, { method: "PATCH", body: { standing: "leaning" } });
    await agent(`${P}/vault/notes/width-helps`, {
      method: "PATCH",
      body: { standing: "established" },
    });
    const mine = await agent<Json>(`${P}/session/account`);
    const theirs = await call<Json>(`/api/v1/agent-sessions/${minted.token_id}/account`);
    expect(theirs.body).toEqual(
      expect.objectContaining({ token_id: minted.token_id, project_id: "lab", live: true }),
    );
    for (const a of [mine.body, theirs.body])
      expect(a).toMatchObject({
        record: {
          jobs: 4,
          attempts: 4,
          outcomes: { succeeded: 3, timed_out: 1 },
          hit_time_limit: [{ run_name: "long" }],
          tasks: [{ task_id: task.task_id, status: "open" }],
        },
        account: {
          runs: { cited: 2, set_aside: 1, unaccounted: 1 },
          unaccounted: ["long"],
          set_aside: [{ run: "probe", reason: "A smoke test of the launcher, not an experiment." }],
          notes_added: ["wide-wins", "width-helps"],
          standings: [{ note_id: "width-helps", from: "open", to: "established" }],
        },
      });
    expect((theirs.body["checks"] as { code: string }[]).map((c) => c.code)).toContain(
      "unreferenced_number",
    );

    // Taking the mark back leaves the run unaccounted for again; the researcher's 404 is plain.
    await agent(`${P}/runs/${probe}/description`, { method: "PUT", body: { set_aside: "" } });
    expect((await runs()).find((r) => r.name === "probe")?.standing).toBe("unaccounted");
    expect((await call("/api/v1/agent-sessions/nope/account")).status).toBe(404);
  }, 60_000);
});
