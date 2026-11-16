/**
 * The agenda (ADR 0058): the researcher writes it on the human listener and no agent
 * token can; an agent session is told by a response header while it has not read the current
 * revision, reads what changed since it last read, and names the item its jobs and tasks serve;
 * the checks (off_agenda, parked_work, not_on_agenda) advise, and only an unknown item is refused.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) f.stop();
});

type Json = Record<string, unknown>;
const HEADER = "x-ablationkit-agenda-revision";

const SETTINGS: CoordinatorSettings = {
  schema_version: 1,
  human: { host: "127.0.0.1", port: 0 },
  agent: { host: "127.0.0.1", port: 0 },
  worker: { host: "127.0.0.1", port: 0 },
  mlflow: { enabled: false },
  jobs: { supervisor: "direct", deliver_deadline_sec: 60 },
};

async function setup() {
  const fake = new FakeMlflow().start();
  fakes.push(fake);
  const home = h.tmp("ak-home-");
  const cl = await h.start({
    home,
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    researchExportDelayMs: 0,
    settings: SETTINGS,
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  expect(
    (await call("/api/v1/projects", { body: { path: h.repo("lab"), project_id: "lab" } })).status,
  ).toBe(201);
  const minted = await cl.agentSession("lab", "claude-code in lab");
  const agentRaw = (path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.agent(path, { token: minted.token, ...init });
  const agent = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(agentRaw(path, init));
  // A question the agenda can point at.
  const q = await agent(`${P}/vault/notes`, {
    body: {
      id: "wd-matters",
      type: "question",
      standing: "open",
      title: "Does weight decay matter at 64k?",
      gist: "Whether weight decay changes the loss of the 64k model is not known.",
      sources: ["repo:train.py"],
    },
  });
  expect(q.status).toBe(201);
  return { cl, call, agent, agentRaw, minted };
}

const P = "/api/v1/projects/lab";
const A = `${P}/agenda`;

interface View {
  revision: number;
  items: { item_id: string; lane: string; text?: string; note_id?: string; work: Json }[];
  rules: { rule_id: string; text: string }[];
  sessions: { token_id: string; label?: string; seen_revision?: number }[];
  checks: { code: string; session?: string; job?: string; task?: string }[];
  changes?: string[];
}

describe("the agenda (ADR 0058)", () => {
  test("the researcher writes it; an agent cannot; a session is told it changed until it reads the diff", async () => {
    const { call, agent, agentRaw, minted } = await setup();
    // Nothing yet: revision 0, no header.
    expect((await agentRaw(`${P}/tasks`)).headers.get(HEADER)).toBeNull();
    expect((await agent(A)).body).toMatchObject({ revision: 0 });

    const put = await call<View>(A, {
      method: "PUT",
      body: {
        items: [
          { note_id: "wd-matters", lane: "now" },
          { text: "Re-run the baseline with three seeds", lane: "next" },
          { text: "Tokenizer ablations", lane: "dropped", reason: "not the paper's question" },
        ],
        rules: [{ text: "Three seeds before anything is established" }],
        if_revision: 0,
      },
    });
    expect(put.status).toBe(200);
    expect(put.body.revision).toBe(1);
    expect(put.body.items.map((i) => i.item_id)).toEqual(["note:wd-matters", "L1", "L2"]);
    expect(put.body.rules.map((r) => r.rule_id)).toEqual(["R1"]);

    // No agent route writes it: the agent listener has no PUT.
    expect((await agent(A, { method: "PUT", body: { items: [] } })).status).toBe(404);

    // Every response says a revision is waiting until the session reads it.
    expect((await agentRaw(`${P}/tasks`)).headers.get(HEADER)).toBe("1");
    const first = await agent<Json>(A);
    expect(first.body).toMatchObject({
      revision: 1,
      now: ["note:wd-matters: Does weight decay matter at 64k? [question, open]"],
      rules: ["R1: Three seeds before anything is established"],
      dropped: ["L2: Tokenizer ablations (reason: not the paper's question)"],
    });
    expect(String(first.body["from"])).toContain("no agent can change it");
    expect(String(first.body["notice"])).toContain("has not read yet");
    expect((await agentRaw(`${P}/tasks`)).headers.get(HEADER)).toBeNull();
    // The researcher sees who has read the current revision.
    const seen = await call<View>(A);
    expect(seen.body.sessions).toEqual([
      expect.objectContaining({ token_id: minted.token_id, seen_revision: 1 }),
    ]);

    // The researcher promotes the baseline line and adds a rule: the session is told what changed.
    await call(A, {
      method: "PUT",
      body: {
        items: [
          { item_id: "L1", text: "Re-run the baseline with three seeds", lane: "now" },
          { note_id: "wd-matters", lane: "now" },
          {
            item_id: "L2",
            text: "Tokenizer ablations",
            lane: "dropped",
            reason: "not the paper's question",
          },
        ],
        rules: [
          { rule_id: "R1", text: "Three seeds before anything is established" },
          { text: "Never evaluate on the held-out split during search" },
        ],
      },
    });
    expect((await agentRaw(`${P}/tasks`)).headers.get(HEADER)).toBe("2");
    const second = await agent<Json>(A);
    const notice = String(second.body["notice"]);
    expect(notice).toContain("revision 1 → 2");
    expect(notice).toContain('Moved from Next to Now: L1 "Re-run the baseline with three seeds"');
    expect(notice).toContain('New rule R2: "Never evaluate on the held-out split during search"');
    expect(second.body["changed"]).toMatchObject({ since_revision: 1 });
    // Read again: nothing new, no notice.
    expect((await agent<Json>(A)).body["notice"]).toBeUndefined();
    // The same agenda again changes nothing.
    const again = await call<View & { unchanged?: boolean }>(A, {
      method: "PUT",
      body: {
        items: (await call<View>(A)).body.items.map(({ item_id, lane, text, note_id }) => ({
          ...(note_id ? { note_id } : { item_id, text }),
          lane,
          ...(item_id === "L2" ? { reason: "not the paper's question" } : {}),
        })),
      },
    });
    expect(again.body).toMatchObject({ revision: 2, unchanged: true });
    // A stale write is refused.
    expect((await call(A, { method: "PUT", body: { items: [], if_revision: 1 } })).status).toBe(
      409,
    );
  });

  test("jobs and tasks name the item they serve; an unknown item is refused; the checks advise", async () => {
    const { call, agent, minted } = await setup();
    await call(A, {
      method: "PUT",
      body: {
        items: [
          { note_id: "wd-matters", lane: "now" },
          { text: "Learning-rate warmup sweep", lane: "parked", reason: "after the seeds" },
        ],
      },
    });
    // An item the agenda does not have: refused, with what it has.
    const bad = await agent<{ error: { code: string; message: string } }>(`${P}/tasks`, {
      body: { goal: "x", agenda_item: "L9" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("unknown_agenda_item");
    // A bare note ID is accepted and stored canonically.
    const t = await agent<{ task: { task_id: string; agenda_item: string } }>(`${P}/tasks`, {
      body: { goal: "Find out whether weight decay matters", agenda_item: "wd-matters" },
    });
    expect(t.status).toBe(201);
    expect(t.body.task.agenda_item).toBe("note:wd-matters");
    // Work on a parked item is not refused: it is a check.
    const parked = await agent<{ task: { task_id: string } }>(`${P}/tasks`, {
      body: { goal: "Warmup sweep", agenda_item: "l1" },
    });
    expect(parked.status).toBe(201);
    const view = await call<View>(A);
    expect(view.body.checks).toEqual([
      expect.objectContaining({ code: "parked_work", task: parked.body.task.task_id }),
    ]);
    const shown = await agent<{ checks: { code: string }[] }>(
      `${P}/tasks/${parked.body.task.task_id}`,
    );
    expect(shown.body.checks.map((c) => c.code)).toContain("parked_work");
    // The agent's own checks come with its reading of the agenda.
    const mine = await agent<{ your_checks?: { code: string }[] }>(A);
    expect(mine.body.your_checks?.map((c) => c.code)).toEqual(["parked_work"]);
    // What agents did for an item shows beside it.
    expect(view.body.items[0]?.work).toMatchObject({
      tasks: [expect.objectContaining({ task_id: t.body.task.task_id, status: "open" })],
    });
    expect(minted.token_id).toBeTruthy();
  });
});
