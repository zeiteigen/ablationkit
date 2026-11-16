/**
 * The vault (ADR 0049): atomic notes written by agents, the tree their embeds make, the ledger,
 * the checks that say where the vault falls short, the researcher's read marks, and a task
 * completed with a notebook.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorSettings, ResearchTask, VaultNote } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { figureRuntime } from "../src/vault/figures.ts";
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
  const made = await call("/api/v1/projects", { body: { path: h.repo("lab"), project_id: "lab" } });
  expect(made.status).toBe(201);
  const minted = await cl.agentSession("lab");
  const agent = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.agent(path, { token: minted.token, ...init }));
  return { cl, call, agent, home, fake };
}

const P = "/api/v1/projects/lab";
const V = `${P}/vault`;

interface Check {
  code: string;
  note?: string;
  message: string;
}
interface Written {
  note: VaultNote;
  checks: Check[];
}
interface View {
  notes: (VaultNote & { embeds?: string[]; parents?: string[] })[];
  shelf: string[];
  editions: string[];
  ledger: { bottom_line?: string; order: string[] };
  reads: Record<string, { state: string; read_at?: string }>;
  counts: { notes: number; new: number; changed: number; ledger_unread: number; checks: number };
  checks?: Check[];
}

const CONCEPT = {
  id: "bits-per-byte",
  type: "concept",
  title: "Bits per byte",
  gist: "Bits per byte is the loss per byte of text, so models with different tokenizers compare.",
  summary: "It divides the summed cross-entropy in bits by the bytes the tokens decode to.",
  aliases: ["BPB"],
  sources: ["repo:README.md"],
};
const FINDING = {
  id: "wide-beats-base",
  type: "finding",
  title: "The wide model reaches a lower loss than the base model",
  gist: "At equal steps the wide model ends [[run:wide-s0#val_loss vs base-s0]] below the base model, in one seed.",
  summary:
    "Both runs used the same data and budget; only the width differs. See [[bits-per-byte]].",
  evidence: [
    { run: "base-s0", role: "baseline", metric: "val_loss" },
    { run: "wide-s0", role: "for", metric: "val_loss" },
  ],
  sources: ["repo:train.py"],
};
const CLAIM = {
  id: "width-helps",
  type: "claim",
  title: "Width helps at this scale",
  gist: "Doubling the width lowers validation loss at equal steps.",
  summary: "One comparison supports it and nothing contradicts it yet.",
  full: "It rests on a single pair of runs.\n\n![[wide-beats-base]]",
  standing: "leaning",
  support: "2 runs · one seed",
  would_change: "A second seed in which the difference disappears.",
  sources: ["repo:train.py"],
};
const NOTEBOOK = {
  id: "does-width-help",
  type: "notebook",
  title: "Does width help?",
  gist: "Width helps in the one comparison run so far.",
  summary: "This notebook says what was compared and what it showed.",
  full: "The metric first.\n\n![[bits-per-byte]]\n\nThen what the comparison showed.\n\n![[width-helps]]",
};

describe("the vault (ADR 0049)", () => {
  test("agents write notes and the index; the vault reads back as a tree with a ledger, and reading is the researcher's", async () => {
    const { cl, call, agent, home } = await setup();
    for (const name of ["base-s0", "wide-s0"])
      await call("/api/v1/tracking/runs", { body: { project_id: "lab", run_name: name } });

    for (const n of [CONCEPT, FINDING, CLAIM, NOTEBOOK]) {
      const made = await agent<Written>(`${V}/notes`, { body: n });
      expect(made.status).toBe(201);
      expect(made.body.note).toMatchObject({
        note_id: n.id,
        revision: 1,
        created_by: { kind: "agent" },
      });
    }
    expect(existsSync(join(home, "state", "lab", "vault", "notes", "width-helps.json"))).toBe(true);
    // Until the notebook is on the shelf, nothing can be read in order.
    let check = await agent<{ checks: Check[] }>(`${V}/check`);
    expect(check.body.checks.map((c) => c.code)).toContain("empty_shelf");
    const index = await agent<{ index: { shelf: string[]; revision: number }; checks: Check[] }>(
      `${V}/index`,
      {
        method: "PUT",
        body: {
          shelf: ["does-width-help"],
          bottom_line: "Width helps in one seed; a second seed is the next step.",
          order: ["width-helps"],
        },
      },
    );
    expect(index.status).toBe(200);
    expect(index.body.index).toMatchObject({ shelf: ["does-width-help"], revision: 2 });
    check = await agent<{ checks: Check[] }>(`${V}/check`);
    expect(check.body.checks).toEqual([]);

    const view = (await call<View>(V)).body;
    expect(view.shelf).toEqual(["does-width-help"]);
    expect(view.ledger).toEqual({
      bottom_line: "Width helps in one seed; a second seed is the next step.",
      order: ["width-helps"],
    });
    expect(view.notes).toHaveLength(4);
    expect(view.notes.find((n) => n.note_id === "width-helps")?.full).toContain(
      "![[wide-beats-base]]",
    );
    expect(view.reads).toEqual({});
    expect(view.counts).toMatchObject({
      notes: 4,
      new: 4,
      changed: 0,
      ledger_unread: 1,
      checks: 0,
    });

    // An agent's outline carries no text, and says what embeds what.
    const brief = (await agent<View>(`${V}?brief=1`)).body;
    const nb = brief.notes.find((n) => n.note_id === "does-width-help");
    expect(nb?.embeds).toEqual(["bits-per-byte", "width-helps"]);
    expect(nb).not.toHaveProperty("full");
    expect(brief.notes.find((n) => n.note_id === "wide-beats-base")?.parents).toEqual([
      "width-helps",
    ]);

    // One note: every place it sits, from the shelf down.
    const one = await agent<{
      note: VaultNote;
      places: { note_id: string }[][];
      mentioned_by: { note_id: string }[];
      in_ledger: boolean;
      read: { state: string };
    }>(`${V}/notes/bits-per-byte`);
    expect(one.body.places.map((p) => p.map((n) => n.note_id))).toEqual([
      ["does-width-help", "bits-per-byte"],
    ]);
    expect(one.body.mentioned_by.map((n) => n.note_id)).toEqual(["wide-beats-base"]);
    expect(one.body.in_ledger).toBe(false);
    const list = await agent<{ notes: { note_id: string }[] }>(`${V}/notes?type=claim`);
    expect(list.body.notes.map((n) => n.note_id)).toEqual(["width-helps"]);
    const found = await agent<{ notes: { note_id: string }[] }>(`${V}/notes?q=bpb`);
    expect(found.body.notes.map((n) => n.note_id)).toEqual(["bits-per-byte"]);

    // Reading is the researcher's: an agent can neither mark notes read nor delete one.
    expect((await agent(`${V}/reads`, { body: { read: ["width-helps"] } })).status).toBe(404);
    expect((await agent(`${V}/notes/width-helps`, { method: "DELETE" })).status).toBe(404);
    const read = await call<{ reads: Record<string, { state: string }> }>(`${V}/reads`, {
      body: { read: ["width-helps", "bits-per-byte", "no-such-note"] },
    });
    expect(read.body.reads).toMatchObject({
      "width-helps": { state: "read" },
      "bits-per-byte": { state: "read" },
    });
    expect((await call<View>(V)).body.counts).toMatchObject({
      new: 2,
      changed: 0,
      ledger_unread: 0,
    });

    // A new alias is not something a reader reads; a new standing is.
    await agent(`${V}/notes/bits-per-byte`, { method: "PATCH", body: { aliases: ["BPB", "bpb"] } });
    const moved = await agent<Written>(`${V}/notes/width-helps`, {
      method: "PATCH",
      body: { standing: "established", if_revision: 1 },
    });
    expect(moved.body.note).toMatchObject({ standing: "established", revision: 2 });
    const stale = await agent(`${V}/notes/width-helps`, {
      method: "PATCH",
      body: { standing: "open", if_revision: 1 },
    });
    expect(stale.status).toBe(409);
    let after = (await call<View>(V)).body;
    expect(after.reads).toMatchObject({
      "bits-per-byte": { state: "read" },
      "width-helps": { state: "changed" },
    });
    expect(after.counts).toMatchObject({ changed: 1, ledger_unread: 1 });
    // The bottom line was written before the claim changed standing.
    expect((await agent<{ checks: Check[] }>(`${V}/check`)).body.checks.map((c) => c.code)).toEqual(
      ["stale_bottom_line"],
    );

    // Notes, the index and the marks are files: they survive a restart.
    await cl.c.stop();
    const again = await h.start({
      home,
      trackingUrl: fakes[0]?.url as string,
      researchExportDelayMs: 0,
      settings: SETTINGS,
    });
    const token = await again.session();
    after = (await again.json<View>(again.human(V, { token }))).body;
    expect(after.notes).toHaveLength(4);
    expect(after.shelf).toEqual(["does-width-help"]);
    expect(after.reads["width-helps"]?.state).toBe("changed");
    const forgot = await again.json(again.human(`${V}/reads`, { token, body: { forget: true } }));
    expect(forgot.status).toBe(200);
    expect((await again.json<View>(again.human(V, { token }))).body.reads).toEqual({});
    const gone = await again.json<{ deleted: string }>(
      again.human(`${V}/notes/wide-beats-base`, { token, method: "DELETE" }),
    );
    expect(gone.body.deleted).toBe("wide-beats-base");
  });

  test("a malformed note is refused with a reason a writer can act on", async () => {
    const { agent } = await setup();
    const add = (body: Json) =>
      agent<{ error: { code: string; message: string } }>(`${V}/notes`, { body });
    const ok = { type: "concept", title: "A", gist: "A is a thing." };

    let r = await add({ ...ok, id: "Not_Kebab" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("kebab-case");
    r = await add({ ...ok, id: "long-gist", gist: "x".repeat(181) });
    expect(r.body.error.message).toContain("at most 180");
    r = await add({ ...ok, id: "long-title", title: "x".repeat(81) });
    expect(r.body.error.message).toContain("at most 80");
    r = await add({ ...ok, id: "a-claim", type: "claim" });
    expect(r.body.error.message).toContain("established, leaning, open, ruled_out");
    r = await add({ ...ok, id: "a-concept", standing: "open" });
    expect(r.body.error.message).toContain("carries no `standing`");
    r = await add({ ...ok, id: "a-decision", type: "decision", standing: "leaning" });
    expect(r.status).toBe(400);
    r = await add({ ...ok, id: "odd", body: "text" });
    expect(r.body.error.message).toContain("not a field of a note");
    r = await add({ ...ok, id: "under-nothing", task_id: "task-20260101-nonexi" });
    expect(r.body.error.message).toContain("not a task");
    r = await add({ ...ok, id: "self", full: "![[self]]" });
    expect(r.body.error.code).toBe("embed_cycle");

    expect((await add({ ...ok, id: "a" })).status).toBe(201);
    expect((await add({ ...ok, id: "a" })).status).toBe(409);
    expect((await add({ ...ok, id: "b", full: "![[a]]" })).status).toBe(201);
    const cycle = await agent<{ error: { code: string; message: string } }>(`${V}/notes/a`, {
      method: "PATCH",
      body: { full: "![[b]]" },
    });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.message).toContain("a → b → a");
    // The index takes only notebooks on the shelf and claims in the ledger.
    const shelf = await agent(`${V}/index`, { method: "PUT", body: { shelf: ["a"] } });
    expect(shelf.status).toBe(400);
    expect((await agent(`${V}/notes/nope`)).status).toBe(404);
  });

  test("checks name what is not atomic, stated twice, unresolved or unreachable; none of it is refused", async () => {
    const { agent } = await setup();
    const add = (body: Json) => agent<Written>(`${V}/notes`, { body });
    const twice =
      "The comparison used the same data, the same budget and the same seed for both of the models.";
    const first = await add({
      id: "setup-once",
      type: "method",
      title: "How runs are matched",
      gist: "Runs differ in one thing.",
      summary: twice,
      sources: ["repo:train.py"],
    });
    expect(first.body.checks.map((c) => c.code)).toEqual(["off_shelf"]);
    const second = await add({
      id: "a-finding",
      type: "finding",
      title: "Something was seen",
      gist: "It was seen.",
      summary: `${twice} See [[no-such-note]].`,
      full: `## A heading\n\n${"word ".repeat(330)}\n\n![[also-missing]]`,
      evidence: [{ run: "never-ran", role: "for" }],
      sources: ["task:task-20260101-nonexi", "repo:x.py"],
    });
    expect(second.status).toBe(201);
    expect(second.body.checks.map((c) => c.code).sort()).toEqual([
      "headings",
      "long_note",
      "off_shelf",
      "repeated",
      "unknown_run",
      "unknown_source",
      "unresolved_embed",
      "unresolved_link",
    ]);
    expect(second.body.checks.find((c) => c.code === "repeated")?.message).toContain("setup-once");
    const claim = await add({
      id: "a-claim",
      type: "claim",
      title: "A claim",
      gist: "It is so.",
      standing: "leaning",
    });
    expect(claim.body.checks.map((c) => c.code).sort()).toEqual([
      "claim_without_evidence",
      "no_sources",
      "no_summary",
      "no_support",
      "off_shelf",
    ]);
    await add({
      id: "a-notebook",
      type: "notebook",
      title: "A notebook",
      gist: "It compiles.",
      summary: "It opens with what it establishes.",
      full: "![[setup-once]]\n\n![[a-finding]]\n\n![[a-claim]]",
    });
    await agent(`${V}/index`, { method: "PUT", body: { shelf: ["a-notebook"] } });
    const all = (await agent<{ checks: Check[] }>(`${V}/check`)).body.checks;
    const whole = all.filter((c) => !c.note).map((c) => c.code);
    expect(whole.sort()).toEqual(["ledger_order", "no_bottom_line", "no_fundamentals"]);
    expect(all.filter((c) => c.code === "off_shelf")).toEqual([]);
    expect(all.find((c) => c.note === "a-notebook")?.code).toBe("embeds_without_prose");

    // Archiving says which notes now embed nothing there.
    const arch = await agent<{ note: VaultNote; embedded_in: string[] }>(
      `${V}/notes/setup-once/archive`,
      { body: {} },
    );
    expect(arch.body.note.archived_at).toBeDefined();
    expect(arch.body.embedded_in).toEqual(["a-notebook"]);
    const archived = await agent<{ notes: { note_id: string }[] }>(`${V}/notes?archived=only`);
    expect(archived.body.notes.map((n) => n.note_id)).toEqual(["setup-once"]);
    expect((await agent<View>(V)).body.notes.map((n) => n.note_id)).not.toContain("setup-once");
  });

  test("a task completes with a notebook whose notes cite runs; replacing a note whole is idempotent", async () => {
    const { call, agent } = await setup();
    for (const name of ["base-s0", "wide-s0"])
      await call("/api/v1/tracking/runs", { body: { project_id: "lab", run_name: name } });
    const task = (
      await agent<{ task: ResearchTask }>(`${P}/tasks`, { body: { goal: "Does width help?" } })
    ).body.task;
    const { id: _f, evidence, ...finding } = FINDING;
    const put = (id: string, body: Json) =>
      agent<Written & { created: boolean }>(`${V}/notes/${id}`, { method: "PUT", body });
    const { id: _c, ...concept } = CONCEPT;
    await put("bits-per-byte", concept);
    const first = await put("wide-beats-base", { ...finding, task_id: task.task_id });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    const same = await put("wide-beats-base", { ...finding, task_id: task.task_id });
    expect(same.status).toBe(200);
    expect(same.body.note.revision).toBe(1);
    const { id: _n, ...notebook } = NOTEBOOK;
    await put("session-one", {
      ...notebook,
      full: "![[wide-beats-base]]",
      edition: "2026-11-12",
      task_id: task.task_id,
    });

    const complete = (body: Json) =>
      agent<{ task: ResearchTask; error?: { code: string } }>(
        `${P}/tasks/${task.task_id}/complete`,
        {
          body,
        },
      );
    expect((await complete({ outcome: "supported", conclusion: "Yes." })).status).toBe(400);
    let done = await complete({ outcome: "supported", notebook_id: "wide-beats-base" });
    expect(done.body.error?.code).toBe("notebook_required");
    done = await complete({ outcome: "supported", notebook_id: "session-one" });
    expect(done.status).toBe(409);
    expect(done.body.error?.code).toBe("evidence_required");

    const cited = await put("wide-beats-base", { ...finding, evidence, task_id: task.task_id });
    expect(cited.body.note.revision).toBe(2);
    const shown = await agent<{
      notes: { note_id: string }[];
      checks: { code: string; ref: string }[];
    }>(`${P}/tasks/${task.task_id}`);
    expect(shown.body.notes.map((n) => n.note_id).sort()).toEqual([
      "session-one",
      "wide-beats-base",
    ]);
    // The edition is a root of its own; the finding is not yet in a notebook on the shelf.
    expect(shown.body.checks).toEqual([
      expect.objectContaining({ code: "off_shelf", ref: "note:wide-beats-base" }),
    ]);
    done = await complete({
      outcome: "supported",
      notebook_id: "session-one",
      conclusion: "Yes, in one seed.",
    });
    expect(done.status).toBe(200);
    expect(done.body.task).toMatchObject({
      status: "completed",
      outcome: "supported",
      notebook_id: "session-one",
      conclusion: "Yes, in one seed.",
    });
    expect(done.body.task.report_id).toBeUndefined();
    const view = (await call<View>(V)).body;
    expect(view.editions).toEqual(["session-one"]);
  });

  test("a figure is a note whose script draws it in a sandboxed frame that can only read runs (ADR 0053)", async () => {
    const { cl, call, agent } = await setup();
    const err = (r: { body: unknown }) =>
      (r.body as { error: { code: string; message: string } }).error;
    const FIG = {
      id: "loss-by-width",
      type: "figure",
      title: "Validation loss by width",
      gist: "The wide run's validation loss sits below the base run's from the first evaluation on.",
      figure: {
        script:
          "const runs = await ak.runs.list();\nel.append(Plot.plot({ marks: [Plot.lineY([1, 2])] }));",
      },
      evidence: [{ run: "base-s0", role: "baseline" }],
      sources: ["repo:train.py"],
    };
    // A figure carries its script, only a figure does, and the script must parse.
    let r = await agent(`${V}/notes`, { body: { ...FIG, figure: undefined } });
    expect(r.status).toBe(400);
    expect(err(r).message).toContain("`figure: {script}`");
    r = await agent(`${V}/notes`, { body: { ...CONCEPT, figure: FIG.figure } });
    expect(err(r).message).toContain("only a figure carries `figure`");
    r = await agent(`${V}/notes`, {
      body: { ...FIG, figure: { script: "const a = 1;\nconst b = ;" } },
    });
    expect(err(r).code).toBe("figure_syntax");
    expect(err(r).message).toContain("line 2");
    r = await agent(`${V}/notes`, {
      body: { ...FIG, figure: { script: "}); window.x = 1; (function () {" } },
    });
    expect(err(r).code).toBe("figure_syntax");

    const made = await agent<Written>(`${V}/notes`, { body: FIG });
    expect(made.status).toBe(201);
    const n = made.body.note;
    expect(n.figure?.script).toContain("Plot.plot");
    // No summary is owed; the runs it draws are its evidence.
    expect(made.body.checks.map((c) => c.code)).not.toContain("no_summary");
    const bare = await agent<Written>(`${V}/notes`, {
      body: { ...FIG, id: "bare-figure", evidence: undefined },
    });
    expect(bare.body.checks.map((c) => c.code)).toContain("figure_without_runs");

    // The frame: the extension views' sandbox, holding the note's script, for this revision only.
    const token = await cl.session();
    const frame = await cl.human(`/vault-frame/lab/${n.note_id}/${n.revision}`, { token });
    expect(frame.status).toBe(200);
    const csp = frame.headers.get("content-security-policy") ?? "";
    for (const d of ["sandbox allow-scripts", "default-src 'none'", "connect-src 'none'"])
      expect(csp).toContain(d);
    expect(csp).toMatch(/script-src 'nonce-[^']+'(;|$)/);
    const html = await frame.text();
    if (figureRuntime()) {
      expect(html).toContain("AKFigure.run(async function (el, ak, Plot, d3)");
      expect(html).toContain("Plot.lineY([1, 2])");
      expect(html).toMatch(/<script nonce="[^"]+" src="\/figure-runtime-[a-z0-9]+\.js">/i);
    } else expect(html).toContain("not built");
    expect(
      (await cl.human(`/vault-frame/lab/${n.note_id}/${n.revision + 1}`, { token })).status,
    ).toBe(409);
    expect((await cl.human(`/vault-frame/lab/${CONCEPT.id}/1`, { token })).status).toBe(404);
    expect((await cl.human(`/vault-frame/lab/${n.note_id}/${n.revision}`)).status).toBe(401);

    // The bridge reads runs and nothing else, for live figures only, and only for the researcher.
    const F = `${V}/notes/${n.note_id}/figure`;
    r = await call(`${F}/rpc`, { body: { method: "runs.list", params: {} } });
    expect(r.status).toBe(200);
    expect((r.body as { result: { runs: unknown[] } }).result.runs).toEqual([]);
    for (const method of ["python.run", "inference.predict", "host.save_result", "research.list"]) {
      r = await call(`${F}/rpc`, { body: { method, params: {} } });
      expect(r.status).toBe(403);
      expect(err(r).code).toBe("method_not_allowed");
    }
    await agent(`${V}/notes`, { body: CONCEPT });
    r = await call(`${V}/notes/${CONCEPT.id}/figure/rpc`, { body: { method: "runs.list" } });
    expect(r.status).toBe(404);
    expect((await agent(`${F}/rpc`, { body: { method: "runs.list" } })).status).toBe(404);

    // What the page reports comes back to the writer as a check, for the revision drawn.
    r = await call(`${F}/drawn`, {
      body: { revision: n.revision, error: "TypeError: x is undefined" },
    });
    expect(r.status).toBe(200);
    let checks = (await agent<{ checks: Check[] }>(`${V}/check`)).body.checks;
    expect(checks.find((c) => c.code === "figure_error")?.message).toContain("x is undefined");
    expect((await call(`${F}/drawn`, { body: { revision: 99 } })).status).toBe(409);
    const fixed = await agent<Written>(`${V}/notes/${n.note_id}`, {
      method: "PATCH",
      body: { figure: { script: "el.append('fixed');" } },
    });
    expect(fixed.body.note.revision).toBe(n.revision + 1);
    // A report on the old revision says nothing about the new one.
    checks = (await agent<{ checks: Check[] }>(`${V}/check`)).body.checks;
    expect(checks.some((c) => c.code === "figure_error")).toBe(false);
    await call(`${F}/drawn`, { body: { revision: n.revision + 1 } });
    checks = (await agent<{ checks: Check[] }>(`${V}/check`)).body.checks;
    expect(checks.some((c) => c.code === "figure_error")).toBe(false);
  });
});
