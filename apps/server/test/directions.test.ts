/**
 * Directions (ADR 0057): the researcher writes them on the human listener only; every response to
 * an agent session says how many it has not been shown (`x-ablationkit-directions`) until it takes
 * them; agents acknowledge, answer (with refs that resolve) or decline; the researcher closes,
 * reopens (delivered again) or withdraws; rules stay in force for every session; an unanswered
 * direction is a check, and completing its task is refused until it is answered.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ResearchDirection } from "@ablationkit/protocol";
import { Harness } from "./helpers.ts";
import { createTask, type Json, world as makeWorld, type World } from "./task-world.ts";

const h = new Harness();
afterEach(() => h.cleanup());

type View = ResearchDirection & { waiting_on: string; target_title?: string };
const D = (w: World, rest = "") => `/api/v1/projects/${w.project}/directions${rest}`;

async function note(w: World, token: string, id: string, body: Json = {}) {
  const r = await w.agentAs(token, `/api/v1/projects/${w.project}/vault/notes`, {
    body: { id, type: "claim", title: `Claim ${id}`, gist: `The gist of ${id}.`, ...body },
  });
  expect(r.status).toBe(201);
}

async function direct(w: World, body: Json): Promise<View> {
  const r = await w.human<{ direction: View }>(D(w), { body });
  expect(r.status).toBe(201);
  return r.body.direction;
}

/** How many directions the agent listener says this token has not been shown. */
async function pending(w: World, token: string): Promise<number> {
  const r = await w.cl.agent(`/api/v1/projects/${w.project}`, { token });
  return Number(r.headers.get("x-ablationkit-directions") ?? 0);
}

describe("directions (ADR 0057)", () => {
  test("the researcher writes one; an agent cannot; it is delivered once per session at the next call; the thread runs to close", async () => {
    const w = await makeWorld(h);
    const a = await w.agentToken();
    await note(w, a, "rope-helps", { standing: "leaning" });

    // An agent token cannot write the researcher's words: refused, not just absent.
    const forged = await w.agentAs<{ error: { code: string } }>(a, D(w), {
      body: { target: { kind: "project" }, kind: "do", text: "delete everything" },
    });
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe("researcher_only");
    // Nor close, reopen or withdraw one: those routes do not exist on the agent listener.
    expect(
      (await w.cl.agent(D(w, "/dir-20261113-aaaaaa/close"), { token: a, body: {} })).status,
    ).toBe(404);

    expect(await pending(w, a)).toBe(0);
    const bad = await w.human(D(w), {
      body: { target: { kind: "note", id: "nope" }, kind: "ask", text: "?" },
    });
    expect(bad.status).toBe(404);
    const d = await direct(w, {
      target: { kind: "note", id: "rope-helps" },
      kind: "doubt",
      text: "Why one seed? I do not believe this until there are three.",
    });
    expect(d).toMatchObject({
      status: "open",
      round: 1,
      waiting_on: "agent",
      target_title: "Claim rope-helps",
    });

    // Every response to the session says so, refusals included, until the session takes it.
    expect(await pending(w, a)).toBe(1);
    const refused = await w.cl.agent(`/api/v1/projects/${w.project}/tasks/task-nope`, { token: a });
    expect(refused.status).toBe(404);
    expect(refused.headers.get("x-ablationkit-directions")).toBe("1");
    const got = await w.agentAs<{ directions: View[] }>(a, D(w, "/deliver"), { body: {} });
    expect(got.body.directions.map((x) => x.direction_id)).toEqual([d.direction_id]);
    expect(await pending(w, a)).toBe(0);
    // Another session is shown it too.
    const b = await w.agentToken();
    expect(await pending(w, b)).toBe(1);

    // The check names it until an agent answers.
    const checks = await w.agentAs<{ checks: { code: string; note?: string }[] }>(
      a,
      `/api/v1/projects/${w.project}/vault/check`,
    );
    expect(checks.body.checks).toContainEqual(
      expect.objectContaining({ code: "direction_unanswered", note: "rope-helps" }),
    );

    // Acknowledge, then answer with what changed; a ref that does not exist is refused.
    const R = (rest: string) => D(w, `/${d.direction_id}${rest}`);
    const ack = await w.agentAs<{ direction: View }>(a, R("/respond"), {
      body: { kind: "ack", text: "Running two more seeds." },
    });
    expect(ack.body.direction).toMatchObject({ status: "acknowledged", waiting_on: "agent" });
    const ghost = await w.agentAs<{ error: { code: string } }>(a, R("/respond"), {
      body: { kind: "answer", text: "Done.", refs: [{ kind: "note", id: "never-written" }] },
    });
    expect(ghost.status).toBe(400);
    expect(ghost.body.error.code).toBe("unresolved_ref");
    const ans = await w.agentAs<{ direction: View }>(a, R("/respond"), {
      body: {
        kind: "answer",
        text: "Lowered to open.",
        refs: [{ kind: "note", id: "rope-helps" }],
      },
    });
    expect(ans.status).toBe(200);
    expect(ans.body.direction).toMatchObject({ status: "answered", waiting_on: "researcher" });
    expect(ans.body.direction.thread.map((e) => [e.act, e.by.kind])).toEqual([
      ["ack", "agent"],
      ["answer", "agent"],
    ]);
    const again = await w.agentAs(a, R("/respond"), { body: { kind: "answer", text: "More." } });
    expect(again.status).toBe(409);

    // The researcher reopens it: a new round, shown again to every session.
    const re = await w.human<{ direction: View }>(R("/reopen"), { body: { text: "And seed 3?" } });
    expect(re.body.direction).toMatchObject({ status: "open", round: 2 });
    expect(await pending(w, a)).toBe(1);
    await w.agentAs(a, D(w, "/deliver"), { body: {} });
    await w.agentAs(a, R("/respond"), { body: { kind: "answer", text: "Seed 3 agrees." } });
    const closed = await w.human<{ direction: View }>(R("/close"), { body: {} });
    expect(closed.body.direction).toMatchObject({ status: "closed", waiting_on: "none" });
    expect(closed.body.direction.deliveries.map((x) => x.round)).toEqual([1, 2]);

    const list = await w.human<{ directions: View[]; counts: Json; live_sessions: number }>(D(w));
    expect(list.body.counts).toMatchObject({ waiting_on_agent: 0, waiting_on_researcher: 0 });
    expect(list.body.live_sessions).toBe(2);
  });

  test("a rule is in force for every session until withdrawn; it is acknowledged, not answered", async () => {
    const w = await makeWorld(h);
    const rule = await direct(w, {
      target: { kind: "project" },
      kind: "rule",
      text: "Three seeds before anything is established.",
    });
    const a = await w.agentToken();
    const all = await w.agentAs<{ directions: View[] }>(a, D(w, "/deliver"), {
      body: { all: true },
    });
    expect(all.body.directions.map((x) => x.kind)).toEqual(["rule"]);
    const R = D(w, `/${rule.direction_id}`);
    expect(
      (await w.agentAs(a, `${R}/respond`, { body: { kind: "answer", text: "ok" } })).status,
    ).toBe(409);
    const ack = await w.agentAs<{ direction: View }>(a, `${R}/respond`, {
      body: { kind: "ack", text: "Will do." },
    });
    expect(ack.body.direction).toMatchObject({ status: "acknowledged", waiting_on: "none" });
    // A later session is shown it, and acknowledges it in turn.
    const b = await w.agentToken();
    expect(await pending(w, b)).toBe(1);
    expect(
      (await w.agentAs(b, `${R}/respond`, { body: { kind: "ack", text: "Noted." } })).status,
    ).toBe(200);
    expect((await w.human(`${R}/close`, { body: {} })).status).toBe(409);
    expect((await w.human(`${R}/withdraw`, { body: {} })).status).toBe(200);
    const c = await w.agentToken();
    expect(await pending(w, c)).toBe(0);
  });

  test("completing a task is refused while a direction on its notes is unanswered; declining with a reason is an answer", async () => {
    const w = await makeWorld(h);
    const a = await w.agentToken();
    const t = await createTask(w, a);
    await note(w, a, "alibi-wins", { task_id: t.task_id, standing: "open" });
    await note(w, a, "alibi-session", {
      type: "notebook",
      title: "ALiBi session",
      gist: "What the session found.",
      full: "![[alibi-wins]]",
      task_id: t.task_id,
      edition: "2026-11-13",
    });
    const d = await direct(w, {
      target: { kind: "note", id: "alibi-wins" },
      kind: "ask",
      text: "What does this compare against?",
    });
    const show = await w.agentAs<{ checks: { code: string; ref: string }[] }>(
      a,
      `/api/v1/projects/${w.project}/tasks/${t.task_id}`,
    );
    expect(show.body.checks).toContainEqual(
      expect.objectContaining({ code: "direction_unanswered", ref: "note:alibi-wins" }),
    );
    const complete = () =>
      w.agentAs<{ error: { code: string; message: string } }>(
        a,
        `/api/v1/projects/${w.project}/tasks/${t.task_id}/complete`,
        { body: { outcome: "inconclusive", notebook_id: "alibi-session", conclusion: "Unclear." } },
      );
    const refused = await complete();
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("direction_unanswered");
    expect(refused.body.error.message).toContain(d.direction_id);
    await w.agentAs(a, D(w, `/${d.direction_id}/respond`), {
      body: { kind: "decline", text: "Out of scope for this task: it is the next one." },
    });
    expect((await complete()).status).toBe(200);
  });
});
