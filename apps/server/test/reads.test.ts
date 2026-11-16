/**
 * Research reads and review (ADR 0048): descriptions on records, studies, runs, jobs and tasks;
 * the names a record's links resolve to; the reading list and the researcher's review marks; and
 * the checks a task returns when its records no longer match its runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CoordinatorSettings, ResearchRecord, ResearchTask } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) f.stop();
});

type Json = Record<string, unknown>;

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

async function setup() {
  const fake = new FakeMlflow().start();
  fakes.push(fake);
  const home = h.tmp("ak-home-");
  const cl = await h.start({
    home,
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    jobWatchdogMs: 200,
    researchExportDelayMs: 0,
    settings: SETTINGS,
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  const made = await call("/api/v1/projects", { body: { path: h.repo("lab"), project_id: "lab" } });
  expect(made.status).toBe(201);
  const minted = await cl.agentSession("lab");
  const agent = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.agent(path, { token: minted.token, ...init }));
  return { cl, call, agent, home };
}

const P = "/api/v1/projects/lab";
type Tags = { key: string; value: string }[];
const tag = (tags: Tags, key: string) => tags.find((t) => t.key === key)?.value;

interface Reading {
  threads: {
    task?: { id: string; review: string; conclusion?: string; gaps: string[] };
    items: { kind: string; id: string; review: string; note?: string; gaps: string[] }[];
  }[];
  counts: { total: number; reviewed: number; new: number; changed: number; gaps: number };
  queue: { kind: string; id: string }[];
}

describe("descriptions (ADR 0048)", () => {
  test("a job's description starts its run's summary; the run is described again once read; a study lists it", async () => {
    const { call, agent } = await setup();
    const job = await agent<{ job_id: string; description: string }>(`${P}/jobs`, {
      body: {
        command: ["true"],
        environment: "none",
        limits: { runtime_max_sec: 60 },
        run_name: "wide-s0",
        description: "Twice the width at seed 0: does the loss fall below the baseline's 0.41?",
        study_id: "width",
        variant_id: "wide",
      },
    });
    expect(job.status).toBe(201);
    expect(job.body.description).toContain("Twice the width");
    const runId = await until(async () => {
      const j = await call<{
        latest_attempt?: {
          state: string;
          tracking: { mlflow_run_id?: string; sync_state?: string };
        };
      }>(`/api/v1/jobs/${job.body.job_id}`);
      const a = j.body.latest_attempt;
      return a?.state === "succeeded" && a.tracking.sync_state === "synced"
        ? a.tracking.mlflow_run_id
        : undefined;
    });
    const run = await call<{ run: { data: { tags: Tags } } }>(`/api/v1/tracking/runs/${runId}`);
    expect(tag(run.body.run.data.tags, "ablationkit.summary")).toContain("Twice the width");

    // The agent replaces the plan with the outcome and adds the in-depth notes.
    const described = await agent<{ run: { data: { tags: Tags } } }>(
      `${P}/runs/${runId}/description`,
      {
        method: "PUT",
        body: {
          summary: "Twice the width at seed 0 reached 0.39, 0.02 below the baseline. One seed.",
          notes: "## Caveat\n\nOne seed, so $\\Delta = -0.02$ is unreplicated.",
        },
      },
    );
    expect(described.status).toBe(200);
    expect(tag(described.body.run.data.tags, "ablationkit.summary")).toContain("reached 0.39");
    expect(tag(described.body.run.data.tags, "mlflow.note.content")).toContain("unreplicated");
    // The generic tag API still refuses the reserved keys; the researcher edits through the route.
    const direct = await call(`/api/v1/tracking/runs/${runId}`, {
      method: "PATCH",
      body: { tags: { "ablationkit.summary": "x" } },
    });
    expect(direct.status).toBe(400);
    const cleared = await call<{ run: { data: { tags: Tags } } }>(
      `${P}/runs/${runId}/description`,
      { method: "PUT", body: { notes: "" } },
    );
    expect(tag(cleared.body.run.data.tags, "mlflow.note.content")).toBeUndefined();
    expect(tag(cleared.body.run.data.tags, "ablationkit.summary")).toContain("reached 0.39");
    expect((await call(`${P}/runs/${runId}/description`, { method: "PUT", body: {} })).status).toBe(
      400,
    );
    expect(
      (
        await call(`${P}/runs/${runId}/description`, {
          method: "PUT",
          body: { summary: "x".repeat(2001) },
        })
      ).status,
    ).toBe(400);
    // Another project's token does not reach the run.
    expect(
      (await call(`/api/v1/projects/nope/runs/${runId}/description`, { method: "PUT", body: {} }))
        .status,
    ).toBe(404);

    const study = await call<{ variants: { variant_id: string; runs: { summary?: string }[] }[] }>(
      `${P}/studies/width`,
    );
    expect(study.body.variants[0]?.runs[0]?.summary).toContain("reached 0.39");
  });

  test("notes take a summary and studies a body; a record's links come back with names", async () => {
    const { call } = await setup();
    const create = async (body: Json) =>
      (await call<{ record: ResearchRecord }>(`${P}/research`, { body })).body.record;
    const hyp = await create({
      kind: "hypothesis",
      title: "Width helps",
      summary: "Doubling the width lowers the loss at equal steps.",
      status: "testing",
    });
    const study = await create({
      kind: "study",
      id: "width",
      title: "Width ablation",
      summary: "Compares 1x and 2x width.",
      body: "## Why\n\nWidth is the cheapest axis to test.",
      variants: [{ variant_id: "base" }, { variant_id: "wide", description: "2x width" }],
      links: [{ kind: "hypothesis", id: hyp.record_id }],
    });
    expect(study.body).toContain("cheapest axis");
    const note = await create({
      kind: "note",
      title: "Audit",
      summary: "The loss code is correct.",
      body: "Checked the masking.",
      links: [{ kind: "study", id: "width" }],
    });
    expect(note.summary).toBe("The loss code is correct.");

    const seen = await call<{
      names: Record<string, { title: string; status?: string; summary?: string }>;
      backlinks: { record_id: string; summary?: string }[];
      review: { state: string };
    }>(`${P}/research/width`);
    expect(seen.body.names[`hypothesis:${hyp.record_id}`]).toEqual({
      title: "Width helps",
      status: "testing",
      summary: "Doubling the width lowers the loss at equal steps.",
    });
    expect(seen.body.names[`note:${note.record_id}`]?.title).toBe("Audit");
    expect(seen.body.backlinks).toEqual([
      expect.objectContaining({ record_id: note.record_id, summary: "The loss code is correct." }),
    ]);
    expect(seen.body.review).toEqual({ state: "new" });
    const listed = await call<{ studies: { record?: { body?: string } }[] }>(`${P}/studies`);
    expect(listed.body.studies[0]?.record?.body).toContain("cheapest axis");
  });
});

describe("review (ADR 0048)", () => {
  test("the reading list orders a task's records, marks survive a restart, and only a change a reader would see brings an item back", async () => {
    const { call, agent, cl, home } = await setup();
    const task = (
      await agent<{ task: ResearchTask }>(`${P}/tasks`, {
        body: { goal: "Does width help?", criteria: ["two widths"] },
      })
    ).body.task;
    const link = [{ kind: "task", id: task.task_id }];
    const add = async (body: Json) =>
      (await agent<{ record: ResearchRecord }>(`${P}/research`, { body: { links: link, ...body } }))
        .body.record;
    const note = await add({ kind: "note", title: "Log", body: "ran it" });
    const hyp = await add({ kind: "hypothesis", title: "Width helps", summary: "It does." });
    const report = await add({
      kind: "report",
      title: "Width: result",
      summary: "No difference at one seed.",
      body: "## Result\n\nNothing.",
    });
    const loose = (
      await call<{ record: ResearchRecord }>(`${P}/research`, {
        body: { kind: "decision", title: "Keep 1x", summary: "Cheaper.", body: "Because." },
      })
    ).body.record;
    await call(`${P}/research`, {
      body: { kind: "conversation", title: "Chat", source: "claude", url: "https://claude.ai/x" },
    });
    const done = await agent<{ task: ResearchTask; checks: unknown[] }>(
      `${P}/tasks/${task.task_id}/complete`,
      {
        body: {
          outcome: "inconclusive",
          report_id: report.record_id,
          conclusion: "One seed shows no difference; width is not settled.",
        },
      },
    );
    expect(done.body.task.conclusion).toContain("not settled");

    const reading = async () => (await call<Reading>(`${P}/review`)).body;
    let r = await reading();
    // The task's thread first, in reading order; conversation links are not reviewed.
    expect(r.threads.map((t) => t.task?.id)).toEqual([task.task_id, undefined]);
    expect(r.threads[0]?.task).toMatchObject({ review: "new", gaps: [] });
    expect(r.threads[0]?.items.map((i) => [i.kind, i.id, i.gaps])).toEqual([
      ["report", report.record_id, []],
      ["hypothesis", hyp.record_id, ["body"]],
      ["note", note.record_id, ["summary"]],
    ]);
    expect(r.threads[1]?.items.map((i) => i.id)).toEqual([loose.record_id]);
    expect(r.counts).toEqual({ total: 5, reviewed: 0, new: 5, changed: 0, gaps: 2 });
    expect(r.queue[0]).toEqual({ kind: "task", id: task.task_id });

    // Marking is the researcher's; an agent reads the list and the notes.
    const refused = await agent(`${P}/review`, {
      body: { kind: "hypothesis", id: hyp.record_id },
    });
    expect(refused.status).toBe(404);
    const marked = await call<{ state: string; note?: string }>(`${P}/review`, {
      body: { kind: "hypothesis", id: hyp.record_id, note: "Run a second seed first." },
    });
    expect(marked.body).toMatchObject({ state: "reviewed", note: "Run a second seed first." });
    await call(`${P}/review`, { body: { kind: "task", id: task.task_id } });
    expect((await call(`${P}/review`, { body: { kind: "note", id: "nope" } })).status).toBe(404);
    expect(
      (await call(`${P}/review`, { body: { kind: "report", id: hyp.record_id } })).status,
    ).toBe(404);
    expect((await call(`${P}/review`, { body: { kind: "conversation", id: "x" } })).status).toBe(
      400,
    );
    const forAgent = (await agent<Reading>(`${P}/review`)).body;
    expect(forAgent.threads[0]?.items[1]).toMatchObject({
      review: "reviewed",
      note: "Run a second seed first.",
    });
    expect(forAgent.counts).toMatchObject({ reviewed: 2, new: 3 });

    // A new link or tag is not a change to what was read; new text or status is.
    await agent(`${P}/research/${hyp.record_id}`, {
      method: "PATCH",
      body: { tags: ["width"], links: [...link, { kind: "report", id: report.record_id }] },
    });
    r = await reading();
    expect(r.threads[0]?.items[1]?.review).toBe("reviewed");
    await agent(`${P}/research/${hyp.record_id}`, {
      method: "PATCH",
      body: { status: "inconclusive" },
    });
    r = await reading();
    expect(r.threads[0]?.items[1]).toMatchObject({ review: "changed" });
    expect(r.counts).toMatchObject({ reviewed: 1, changed: 1 });
    const one = await call<{ review: { state: string; note?: string } }>(
      `${P}/research/${hyp.record_id}`,
    );
    expect(one.body.review).toMatchObject({ state: "changed", note: "Run a second seed first." });
    const t = await call<{ review: { state: string } }>(`${P}/tasks/${task.task_id}`);
    expect(t.body.review.state).toBe("reviewed");

    // Marks are files: they survive a restart, and unmarking removes one.
    await cl.c.stop();
    const again = await h.start({
      home,
      trackingUrl: fakes[0]?.url as string,
      researchExportDelayMs: 0,
      settings: SETTINGS,
    });
    const token = await again.session();
    const after = await again.json<Reading>(again.human(`${P}/review`, { token }));
    expect(after.body.counts).toMatchObject({ reviewed: 1, changed: 1, new: 3 });
    const un = await again.json<{ state: string }>(
      again.human(`${P}/review`, {
        token,
        body: { kind: "task", id: task.task_id, reviewed: false },
      }),
    );
    expect(un.body.state).toBe("new");
  });
});

describe("task checks (ADR 0048)", () => {
  test("a task names the records that no longer match its runs or say too little", async () => {
    const { call, agent } = await setup();
    const task = (
      await agent<{ task: ResearchTask }>(`${P}/tasks`, { body: { goal: "Does width help?" } })
    ).body.task;
    const link = [{ kind: "task", id: task.task_id }];
    await agent(`${P}/research`, {
      body: {
        kind: "study",
        id: "width",
        title: "Width",
        variants: [{ variant_id: "base" }, { variant_id: "wide" }],
        links: link,
      },
    });
    const hyp = (
      await agent<{ record: ResearchRecord }>(`${P}/research`, {
        body: { kind: "hypothesis", title: "Width helps", status: "testing", links: link },
      })
    ).body.record;
    const job = await agent<{ job_id: string }>(`${P}/jobs`, {
      body: {
        command: ["true"],
        environment: "none",
        limits: { runtime_max_sec: 60 },
        study_id: "width",
        variant_id: "wider",
        task_id: task.task_id,
      },
    });
    await until(async () => {
      const j = await call<{
        latest_attempt?: { state: string; tracking: { sync_state?: string } };
      }>(`/api/v1/jobs/${job.body.job_id}`);
      return (
        j.body.latest_attempt?.state === "succeeded" &&
        j.body.latest_attempt.tracking.sync_state === "synced"
      );
    });
    const work = async () =>
      (
        await agent<{
          checks: { code: string; ref: string; message: string }[];
          jobs: { job_id: string; variant_id?: string; description?: string }[];
          records: { record_id: string; summary?: string; status?: string }[];
        }>(`${P}/tasks/${task.task_id}`)
      ).body;
    let w = await work();
    expect(w.jobs).toEqual([
      expect.objectContaining({ job_id: job.body.job_id, variant_id: "wider" }),
    ]);
    expect(w.checks.map((c) => [c.code, c.ref]).sort()).toEqual([
      ["hypothesis_open", `hypothesis:${hyp.record_id}`],
      ["no_description", `job:${job.body.job_id}`],
      // The run ended and nothing in the vault says what it showed (ADR 0049).
      ["no_notes", `task:${task.task_id}`],
      ["no_summary", `hypothesis:${hyp.record_id}`],
      ["no_summary", "study:width"],
      ["study_status", "study:width"],
      // Nothing cites the run and it was not set aside (ADR 0056).
      ["unaccounted_runs", `task:${task.task_id}`],
      ["undeclared_variants", "study:width"],
    ]);
    expect(w.checks.find((c) => c.code === "undeclared_variants")?.message).toContain("wider");
    expect(w.checks.find((c) => c.code === "study_status")?.message).toContain(
      "declared but never run: base, wide",
    );

    // Fixing the records clears the checks.
    await agent(`${P}/research/width`, {
      method: "PATCH",
      body: {
        status: "complete",
        summary: "One run of a wider model; nothing to compare it with yet.",
        variants: [{ variant_id: "wider", description: "4x width" }],
      },
    });
    await agent(`${P}/research/${hyp.record_id}`, {
      method: "PATCH",
      body: { status: "inconclusive", summary: "Not tested against a baseline." },
    });
    w = await work();
    expect(w.checks.map((c) => c.code)).toEqual(["no_description", "unaccounted_runs", "no_notes"]);
    expect(w.records.find((r) => r.record_id === "width")).toMatchObject({
      status: "complete",
      summary: "One run of a wider model; nothing to compare it with yet.",
    });
  });
});
