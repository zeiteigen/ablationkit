/**
 * Research tasks (ADR 0039): agents create a task with a project token, record jobs and research
 * records under it, and complete it with an outcome and a report; the researcher reads tasks and may
 * abandon one. AblationKit does not start or drive the agent (criteria 38, 44, 52).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResearchTask } from "@ablationkit/protocol";
import { Harness } from "./helpers.ts";
import { createTask, type Json, world as makeWorld, P, type World } from "./task-world.ts";

const h = new Harness();
afterEach(() => h.cleanup());
const world = () => makeWorld(h);

type Work = {
  task: ResearchTask;
  jobs: { job_id: string; attempt_id?: string; state?: string; mlflow_run_id?: string }[];
  records: { record_id: string; kind: string; title: string }[];
};

async function report(w: World, token: string, body: Json = {}): Promise<string> {
  const r = await w.agentAs<{ record: { record_id: string } }>(
    token,
    `/api/v1/projects/${w.project}/research`,
    { body: { kind: "report", title: "RoPE ablation", ...body } },
  );
  expect(r.status).toBe(201);
  return r.body.record.record_id;
}

const EVIDENCE = [
  {
    ref: { kind: "run", id: "mlflow-run-1" },
    mlflow_run_id: "mlflow-run-1",
    captured_at: "2026-11-03T10:00:00Z",
  },
];

describe("agent-first tasks (criterion 38)", () => {
  test("an agent creates a task with its project token and records a job and a note under it; the researcher reads the same task", async () => {
    const w = await world();
    const token = await w.agentToken();
    const t = await createTask(w, token, { title: "RoPE ablation" });
    expect(t).toMatchObject({
      schema_version: 2,
      project_id: w.project,
      title: "RoPE ablation",
      criteria: ["val_loss compared over 3 seeds"],
      status: "open",
      created_by: { kind: "agent" },
    });
    // A job under the task (a time limit: the compute limit holds through it).
    const job = await w.agentAs<{ job_id: string; task_id?: string }>(
      token,
      `/api/v1/projects/${w.project}/jobs`,
      {
        body: {
          command: ["python3", "-c", "print(1)"],
          environment: "none",
          limits: { runtime_max_sec: 60 },
          task_id: t.task_id,
        },
      },
    );
    expect(job.status).toBe(201);
    expect(job.body.task_id).toBe(t.task_id);
    // A note under the task.
    const note = await w.agentAs(token, `/api/v1/projects/${w.project}/research`, {
      body: { kind: "note", title: "ALiBi run 1", links: [{ kind: "task", id: t.task_id }] },
    });
    expect(note.status).toBe(201);
    // The researcher sees the task with its job and record.
    const seen = await w.human<Work>(P(w, `/${t.task_id}`));
    expect(seen.status).toBe(200);
    expect(seen.body.task).toEqual(t);
    expect(seen.body.jobs.map((j) => j.job_id)).toEqual([job.body.job_id]);
    expect(seen.body.records.map((r) => r.title)).toEqual(["ALiBi run 1"]);
    const list = await w.human<{ tasks: ResearchTask[] }>(P(w));
    expect(list.body.tasks.map((x) => x.task_id)).toEqual([t.task_id]);
    // Lineage traces a task through its jobs.
    const lin = await w.human<{ nodes?: unknown[] }>(
      `/api/v1/projects/${w.project}/lineage?kind=task&id=${t.task_id}`,
    );
    expect(lin.status).toBe(200);
    await w.human(`/api/v1/jobs/${job.body.job_id}/cancel`, { body: {} });
  });

  test("work names only an open task of the token's project", async () => {
    const w = await world();
    const token = await w.agentToken();
    const other = await w.addProject("other");
    const otherToken = await w.agentToken(other);
    // A token reaches only its own project's tasks.
    const cross = await w.agentAs<{ error: { code: string } }>(otherToken, P(w), {
      body: { goal: "not mine" },
    });
    expect([cross.status, cross.body.error.code]).toEqual([403, "forbidden_scope"]);
    const theirs = (
      await w.agentAs<{ task: ResearchTask }>(otherToken, P(w, "", other), {
        body: { goal: "theirs" },
      })
    ).body.task;
    expect((await w.agentAs(token, P(w, `/${theirs.task_id}`))).status).toBe(404);
    const job = (task_id: string) =>
      w.agentAs<{ error: { code: string } }>(token, `/api/v1/projects/${w.project}/jobs`, {
        body: {
          command: ["true"],
          environment: "none",
          limits: { runtime_max_sec: 60 },
          task_id,
        },
      });
    expect((await job(theirs.task_id)).body.error.code).toBe("task_not_found");
    expect((await job("task-20990101-zzzzzz")).body.error.code).toBe("task_not_found");
    const link = await w.agentAs<{ error: { code: string } }>(
      token,
      `/api/v1/projects/${w.project}/research`,
      { body: { kind: "note", title: "x", links: [{ kind: "task", id: theirs.task_id }] } },
    );
    expect([link.status, link.body.error.code]).toEqual([422, "unknown_link"]);
    // A closed task takes no new jobs.
    const mine = await createTask(w, token);
    await w.human(P(w, `/${mine.task_id}/abandon`), { body: { reason: "wrong idea" } });
    const closed = await job(mine.task_id);
    expect([closed.status, closed.body.error.code]).toEqual([409, "task_closed"]);
    // The researcher's own jobs are checked the same way.
    const human = await w.human<{ error: { code: string } }>(`/api/v1/projects/${w.project}/jobs`, {
      body: { command: ["true"], environment: "none", task_id: theirs.task_id },
    });
    expect(human.body.error.code).toBe("task_not_found");
  });

  test("tasks are the agent's: the researcher cannot create or complete one, only read and abandon", async () => {
    const w = await world();
    const token = await w.agentToken();
    const t = await createTask(w, token);
    // Not on the human listener: 405 where the path has other methods, 404 otherwise.
    for (const [path, body] of [
      [P(w), { goal: "from the UI" }],
      [P(w, `/${t.task_id}/complete`), { outcome: "inconclusive", report_id: "x" }],
    ] as const)
      expect([404, 405]).toContain((await w.human(path, { body })).status);
    // The orchestration routes are gone from both listeners.
    for (const path of ["dispatch", "preflight", "plan", "plan/decision", "bindings", "cancel"]) {
      expect((await w.human(P(w, `/${t.task_id}/${path}`), { body: {} })).status).toBe(404);
      expect((await w.agentAs(token, P(w, `/${t.task_id}/${path}`), { body: {} })).status).toBe(
        404,
      );
    }
    expect((await w.human("/api/v1/t3/status")).status).toBe(404);
    const ab = await w.human<{ task: ResearchTask }>(P(w, `/${t.task_id}/abandon`), {
      body: { reason: "superseded" },
    });
    expect(ab.body.task).toMatchObject({
      status: "abandoned",
      reason: "superseded",
      closed_by: { kind: "human" },
    });
    const again = await w.agentAs<{ error: { code: string } }>(
      token,
      P(w, `/${t.task_id}/abandon`),
      { body: {} },
    );
    expect([again.status, again.body.error.code]).toEqual([409, "task_closed"]);
  });
});

describe("scientific outcome vs agent work (criterion 44)", () => {
  test("only a report with evidence completes a task as supported or not supported; IDs stay distinct", async () => {
    const w = await world();
    const token = await w.agentToken();
    const t = await createTask(w, token);
    const C = (body: Json) =>
      w.agentAs<{ error?: { code: string }; task?: ResearchTask }>(
        token,
        P(w, `/${t.task_id}/complete`),
        { body },
      );
    expect((await C({ outcome: "supported", report_id: "nope" })).body.error?.code).toBe(
      "report_required",
    );
    const note = await w.agentAs<{ record: { record_id: string } }>(
      token,
      `/api/v1/projects/${w.project}/research`,
      { body: { kind: "note", title: "not a report" } },
    );
    expect(
      (await C({ outcome: "supported", report_id: note.body.record.record_id })).body.error?.code,
    ).toBe("report_required");
    const claims = await report(w, token, { title: "claims only" });
    for (const outcome of ["supported", "not_supported"])
      expect((await C({ outcome, report_id: claims })).body.error?.code).toBe("evidence_required");
    expect((await C({ outcome: "succeeded", report_id: claims })).status).toBe(400);
    const rid = await report(w, token, {
      evidence: EVIDENCE,
      links: [{ kind: "task", id: t.task_id }],
    });
    const ok = await C({ outcome: "supported", report_id: rid });
    expect(ok.body.task).toMatchObject({
      status: "completed",
      outcome: "supported",
      report_id: rid,
      closed_by: { kind: "agent" },
    });
    expect((await C({ outcome: "supported", report_id: rid })).body.error?.code).toBe(
      "task_closed",
    );
    // Task, record and MLflow run IDs are distinct.
    const ids = [t.task_id, rid, "mlflow-run-1"];
    expect(new Set(ids).size).toBe(ids.length);
    // The refusals and the completion are audited.
    const audit = readdirSync(join(w.home, "audit"))
      .map((f) => readFileSync(join(w.home, "audit", f), "utf8"))
      .join("");
    expect(audit).toContain('"action":"task.complete","outcome":"denied"');
    expect(audit).toContain('"action":"task.complete","outcome":"allowed"');
  });

  test("an inconclusive outcome needs a report but no evidence", async () => {
    const w = await world();
    const token = await w.agentToken();
    const t = await createTask(w, token);
    const rid = await report(w, token, { title: "Too noisy to tell" });
    const r = await w.agentAs<{ task: ResearchTask }>(token, P(w, `/${t.task_id}/complete`), {
      body: { outcome: "inconclusive", report_id: rid },
    });
    expect(r.body.task).toMatchObject({ status: "completed", outcome: "inconclusive" });
  });
});

describe("agent-first timeline without a transcript (criterion 52)", () => {
  test("a task shows what was recorded under it, and nothing else; it survives a restart", async () => {
    const w = await world();
    const token = await w.agentToken();
    const t = await createTask(w, token);
    await report(w, token, { title: "Interim", links: [{ kind: "task", id: t.task_id }] });
    await w.restart();
    const seen = await w.human<Work & Json>(P(w, `/${t.task_id}`));
    expect(Object.keys(seen.body).sort()).toEqual([
      "checks",
      "imported_runs",
      "jobs",
      "notes",
      "records",
      "review",
      "runs",
      "task",
      "works",
    ]);
    expect(seen.body["notes"]).toEqual([]);
    expect(seen.body["imported_runs"]).toEqual([]);
    expect(seen.body.records.map((r) => r.title)).toEqual(["Interim"]);
    expect(seen.body.task).toEqual(t);
  });
});

describe("tasks written before ADR 0039", () => {
  test("a dispatched task with its old activity and conversation files loads open and lean", async () => {
    const home = h.tmp("ak-home-");
    const first = await makeWorld(h, { home });
    const pid = first.project;
    await first.cl.c.stop();
    const legacy = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../packages/protocol/test/legacy/research-task.v1.json"),
        "utf8",
      ),
    ) as Json;
    const dir = join(home, "state", pid, "tasks");
    mkdirSync(dir, { recursive: true });
    const tid = "task-20261103-abc123";
    writeFileSync(join(dir, `${tid}.json`), JSON.stringify({ ...legacy, project_id: pid }));
    writeFileSync(join(dir, `${tid}.activity.json`), "[]");
    writeFileSync(join(dir, `${tid}.conversation.json`), "{}");
    const cl = await h.start({ home });
    const session = await cl.session();
    const r = await cl.json<Work>(
      cl.human(`/api/v1/projects/${pid}/tasks/${tid}`, { token: session }),
    );
    expect(r.status).toBe(200);
    expect(r.body.task).toMatchObject({
      schema_version: 2,
      status: "open",
      goal: "Measure the effect of removing rotary embeddings on validation loss.",
      criteria: ["val_loss compared over 3 seeds"],
    });
    // The upgraded record is written back lean on the next change.
    const ab = await cl.json<{ task: ResearchTask }>(
      cl.human(`/api/v1/projects/${pid}/tasks/${tid}/abandon`, { token: session, body: {} }),
    );
    expect(ab.body.task.status).toBe("abandoned");
    const disk = readFileSync(join(dir, `${tid}.json`), "utf8");
    expect(disk).not.toContain("agent_task_bindings");
    expect(disk).not.toContain("dispatches");
  });
});
