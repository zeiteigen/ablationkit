/**
 * Research records, the main-checkout export, the one-time import and lineage (Stage 7, ADR 0013).
 * Criteria 1a (custom-architecture research to a linked report), 14 (continuity), 16
 * (conversation links without transcript sync) and 59 (agent edits reach the coordinator and the
 * export; worktree export edits have no effect).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CoordinatorSettings, ResearchRecord } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { looksSecret, parseExport, renderExport } from "../src/research/export.ts";
import { Harness } from "./helpers.ts";

const FIXTURES = resolve(import.meta.dir, "../../../fixtures/projects");
const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  for (const c of h.coordinators) {
    for (const j of c.services.jobs.list()) {
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
    }
  }
  await h.cleanup();
  for (const f of fakes.splice(0)) f.stop();
});

type Json = Record<string, unknown>;

function settings(): CoordinatorSettings {
  return {
    schema_version: 1,
    human: { host: "127.0.0.1", port: 0 },
    agent: { host: "127.0.0.1", port: 0 },
    worker: { host: "127.0.0.1", port: 0 },
    mlflow: { enabled: false },
    // Generous: four concurrent training jobs on a machine running other suites. Past this deadline
    // a collector leaves its spool for reconciliation, and the wait below would run out.
    jobs: { supervisor: "direct", deliver_deadline_sec: 120 },
  };
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(50);
  }
}

async function setup(opts: { home?: string; fake?: FakeMlflow } = {}) {
  const fake = opts.fake ?? new FakeMlflow().start();
  if (!opts.fake) fakes.push(fake);
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    jobWatchdogMs: 200,
    researchExportDelayMs: 0,
    settings: settings(),
    ...(opts.home ? { home: opts.home } : {}),
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  return { fake, cl, token, call };
}
type Call = Awaited<ReturnType<typeof setup>>["call"];

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

/** A real Git repository with one commit. */
function gitRepo(name: string, fixture?: string): string {
  const d = join(h.tmp("ak-research-"), name);
  if (fixture) cpSync(join(FIXTURES, fixture), d, { recursive: true });
  else mkdirSync(d, { recursive: true });
  writeFileSync(join(d, ".gitignore"), "outputs/\n__pycache__/\n");
  git(d, "init", "-q", "-b", "main");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "init");
  return d;
}

async function addProject(call: Call, path: string, id: string): Promise<Json> {
  const r = await call<Json>("/api/v1/projects", { body: { path, project_id: id } });
  expect(r.status).toBe(201);
  return r.body;
}

async function create(call: Call, pid: string, body: Json): Promise<ResearchRecord> {
  const r = await call<{ record: ResearchRecord }>(`/api/v1/projects/${pid}/research`, { body });
  if (r.status !== 201) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.record;
}

const exported = (repo: string, rel: string) => {
  const p = join(repo, ".ablationkit", rel);
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
};

describe("research records", () => {
  test("create, read, update with revisions, filter, archive and delete", async () => {
    const { call } = await setup();
    const repo = h.repo("lab");
    await addProject(call, repo, "lab");
    const hyp = await create(call, "lab", {
      kind: "hypothesis",
      title: "Pair merges lower bits per char",
      summary: "Merging frequent pairs helps an n-gram model.",
      tags: ["tokenizer"],
    });
    expect(hyp.record_id).toMatch(/^hyp-[0-9]{8}-[0-9a-f]{6}$/);
    expect(hyp.status).toBe("proposed");
    expect(hyp.created_by.kind).toBe("human");
    expect(hyp.revision).toBe(1);

    const note = await create(call, "lab", {
      kind: "note",
      title: "Baseline observations",
      body: "# Findings\n\nThe char model plateaus.",
      links: [{ kind: "hypothesis", id: hyp.record_id }],
    });

    // Per-kind fields, statuses and links are checked.
    for (const [body, code] of [
      [{ kind: "note", title: "x", status: "testing" }, "invalid_request"],
      [{ kind: "hypothesis", title: "x", status: "done" }, "invalid_request"],
      [{ kind: "hypothesis", title: "x", url: "https://x" }, "invalid_request"],
      [
        { kind: "note", title: "x", links: [{ kind: "hypothesis", id: "hyp-nope" }] },
        "unknown_link",
      ],
      [{ kind: "note", title: "x", links: [{ kind: "job", id: "job-nope" }] }, "unknown_link"],
      [{ kind: "note", title: "x", revision: 5 }, "invalid_request"],
      [{ kind: "note", title: "" }, "invalid_request"],
      [{ kind: "idea", title: "x" }, "invalid_request"],
    ] as const) {
      const r = await call<{ error: { code: string } }>("/api/v1/projects/lab/research", { body });
      expect([400, 422]).toContain(r.status);
      expect(r.body.error.code).toBe(code);
    }
    // An unknown link kind is refused with the kinds that exist.
    const badKind = await call<{ error: { message: string } }>("/api/v1/projects/lab/research", {
      body: { kind: "note", title: "x", links: [{ kind: "candidate", id: "c" }] },
    });
    expect(badKind.status).toBe(400);
    expect(badKind.body.error.message).toContain("unknown link kind candidate");
    expect(badKind.body.error.message).toContain("llm_evidence, extension_execution");
    // A note has no protocol, and says so.
    const noSummary = await call<{ error: { message: string } }>("/api/v1/projects/lab/research", {
      body: { kind: "note", title: "x", protocol: "s" },
    });
    expect(noSummary.body.error.message).toContain("a note has no `protocol` field");

    const upd = await call<{ record: ResearchRecord }>(
      `/api/v1/projects/lab/research/${hyp.record_id}`,
      { method: "PATCH", body: { status: "testing", if_revision: 1 } },
    );
    expect(upd.status).toBe(200);
    expect(upd.body.record.revision).toBe(2);
    const stale = await call<{ error: { code: string; revision: number } }>(
      `/api/v1/projects/lab/research/${hyp.record_id}`,
      { method: "PATCH", body: { title: "stale edit", if_revision: 1 } },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("revision_conflict");
    expect(stale.body.error.revision).toBe(2);

    // Read with backlinks; filters.
    const read = await call<{ record: ResearchRecord; backlinks: { record_id: string }[] }>(
      `/api/v1/projects/lab/research/${hyp.record_id}`,
    );
    expect(read.body.backlinks.map((b) => b.record_id)).toEqual([note.record_id]);
    const list = async (q: string) =>
      (
        await call<{ records: ResearchRecord[] }>(`/api/v1/projects/lab/research?${q}`)
      ).body.records.map((r) => r.record_id);
    expect(await list("kind=note")).toEqual([note.record_id]);
    expect(await list("tag=tokenizer")).toEqual([hyp.record_id]);
    expect(await list("q=plateaus")).toEqual([note.record_id]);
    expect(await list(`link=hypothesis:${hyp.record_id}`)).toEqual([note.record_id]);
    expect(await list("status=testing")).toEqual([hyp.record_id]);
    expect(await list("sort=title")).toEqual([note.record_id, hyp.record_id]);

    const arch = await call(`/api/v1/projects/lab/research/${note.record_id}/archive`, {
      body: {},
    });
    expect(arch.status).toBe(200);
    expect(await list("kind=note")).toEqual([]);
    expect(await list("kind=note&archived=only")).toEqual([note.record_id]);
    await call(`/api/v1/projects/lab/research/${note.record_id}/archive`, {
      body: { archived: false },
    });
    expect(await list("kind=note")).toEqual([note.record_id]);

    const del = await call(`/api/v1/projects/lab/research/${note.record_id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await call(`/api/v1/projects/lab/research/${note.record_id}`)).status).toBe(404);
  });

  test("study records carry baseline, variants and metric goals, and feed the studies view", async () => {
    const { call } = await setup();
    await addProject(call, h.repo("lab"), "lab");
    const bad = await call("/api/v1/projects/lab/research", {
      body: {
        kind: "study",
        id: "tok",
        title: "t",
        variants: [{ variant_id: "a" }],
        baseline_variant: "b",
      },
    });
    expect(bad.status).toBe(400);
    const s = await create(call, "lab", {
      kind: "study",
      id: "tok",
      title: "Tokenizer ablation",
      protocol: "two seeds per variant",
      variants: [{ variant_id: "char" }, { variant_id: "pairs" }],
      baseline_variant: "char",
      metric_goals: [{ key: "val/bits_per_char", goal: "min" }],
    });
    expect(s.record_id).toBe("tok");
    expect(
      (
        await call("/api/v1/projects/lab/research", {
          body: { kind: "study", id: "tok", title: "again" },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call("/api/v1/projects/lab/research", { body: { kind: "note", id: "x", title: "t" } }))
        .status,
    ).toBe(400);
    // A study record with no runs yet still lists, and its detail falls back to the record.
    const list = await call<{ studies: { study_id: string; runs: number; record?: Json }[] }>(
      "/api/v1/projects/lab/studies",
    );
    expect(
      list.body.studies.map((x) => [x.study_id, x.runs, x.record?.["baseline_variant"]]),
    ).toEqual([["tok", 0, "char"]]);
    const one = await call<{ record?: Json; variants: unknown[] }>(
      "/api/v1/projects/lab/studies/tok",
    );
    expect(one.status).toBe(200);
    expect(one.body.record?.["title"]).toBe("Tokenizer ablation");
    expect(one.body.variants).toEqual([]);
  });
});

describe("main-checkout export and one-time import (spec §5.1)", () => {
  test("changes are exported; private notes and secrets stay out of Git; deleted records are removed", async () => {
    const { call } = await setup();
    const repo = h.repo("lab");
    await addProject(call, repo, "lab");
    const hyp = await create(call, "lab", { kind: "hypothesis", title: "H1" });
    const note = await create(call, "lab", {
      kind: "note",
      title: "Baseline",
      body: "Body *markdown* with a --> comment closer.",
    });
    const conv = await create(call, "lab", {
      kind: "conversation",
      title: "Brainstorm",
      source: "claude",
      url: "https://claude.ai/chat/abc",
      body: "my private thoughts",
    });
    await create(call, "lab", {
      kind: "decision",
      title: "Keep the char baseline",
      body: "token sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 pasted by mistake",
    });

    const hyps = JSON.parse(exported(repo, "research/hypotheses.json") as string);
    expect(hyps.records.map((r: ResearchRecord) => r.record_id)).toEqual([hyp.record_id]);
    expect(hyps.notice).toContain("not read back");
    const date = note.created_at.slice(0, 10);
    const md = exported(repo, `research/notes/${date}-baseline.md`) as string;
    expect(md).toContain("# Baseline");
    expect(md).toContain("Body *markdown* with a --> comment closer.");
    const convs = JSON.parse(exported(repo, "conversations/references.json") as string);
    expect(convs.records[0].url).toBe("https://claude.ai/chat/abc");
    expect(convs.records[0].body).toBeUndefined();
    const decisions = exported(repo, "research/decisions.json") as string;
    expect(decisions).not.toContain("sk-proj-");
    expect(decisions).toContain("withheld from the Git export");
    // The canonical record keeps the text; only the export withholds it.
    expect(
      JSON.stringify((await call("/api/v1/projects/lab/research?kind=decision")).body),
    ).toContain("sk-proj-");

    // Opting in exports the conversation's notes.
    await call(`/api/v1/projects/lab/research/${conv.record_id}`, {
      method: "PATCH",
      body: { export_notes: true },
    });
    expect(exported(repo, "conversations/references.json")).toContain("my private thoughts");

    // Renaming moves the file; deleting removes it (it was ours and unedited).
    await call(`/api/v1/projects/lab/research/${note.record_id}`, {
      method: "PATCH",
      body: { title: "Baseline v2" },
    });
    expect(exported(repo, `research/notes/${date}-baseline.md`)).toBeUndefined();
    expect(exported(repo, `research/notes/${date}-baseline-v2.md`)).toContain("# Baseline v2");
    await call(`/api/v1/projects/lab/research/${note.record_id}`, { method: "DELETE" });
    expect(readdirSync(join(repo, ".ablationkit/research/notes"))).toEqual([]);

    const st = await call<{ state: { files: Json; last_export_redactions: number } }>(
      "/api/v1/projects/lab/research/export",
    );
    expect(Object.keys(st.body.state.files).sort()).toEqual([
      "conversations/references.json",
      "research/decisions.json",
      "research/hypotheses.json",
    ]);
    expect(st.body.state.last_export_redactions).toBe(1);
  });

  test("hand edits to the main checkout's export are kept aside, flagged in the inbox, and do not change records", async () => {
    const { call } = await setup();
    const repo = h.repo("lab");
    await addProject(call, repo, "lab");
    const hyp = await create(call, "lab", { kind: "hypothesis", title: "Original" });
    const path = join(repo, ".ablationkit/research/hypotheses.json");
    const edited = readFileSync(path, "utf8").replace("Original", "Edited by hand");
    writeFileSync(path, edited);

    const run = await call<{ drift: { path: string; saved_to: string }[]; written: string[] }>(
      "/api/v1/projects/lab/research/export",
      { body: {} },
    );
    expect(run.body.drift.map((d) => d.path)).toEqual(["research/hypotheses.json"]);
    expect(readFileSync(run.body.drift[0]?.saved_to as string, "utf8")).toBe(edited);
    expect(readFileSync(path, "utf8")).toContain("Original");
    const rec = await call<{ record: ResearchRecord }>(
      `/api/v1/projects/lab/research/${hyp.record_id}`,
    );
    expect(rec.body.record.title).toBe("Original");

    const inbox = await call<{ items: { kind: string; project_id: string }[] }>("/api/v1/inbox");
    expect(
      inbox.body.items.filter((i) => i.kind === "export_drift").map((i) => i.project_id),
    ).toEqual(["lab"]);
    await call("/api/v1/projects/lab/research/export/drift/clear", { body: {} });
    const after = await call<{ items: { kind: string }[] }>("/api/v1/inbox");
    expect(after.body.items.some((i) => i.kind === "export_drift")).toBe(false);
  });

  test("registering a checkout with an existing export imports it once, losslessly", async () => {
    const first = await setup();
    const repo = h.repo("lab");
    await addProject(first.call, repo, "lab");
    const hyp = await create(first.call, "lab", { kind: "hypothesis", title: "Imported H" });
    const note = await create(first.call, "lab", {
      kind: "note",
      title: "Imported note",
      body: "line 1\n\nline 2\n",
      links: [{ kind: "hypothesis", id: hyp.record_id }],
    });
    const study = await create(first.call, "lab", {
      kind: "study",
      id: "s1",
      title: "S",
      variants: [{ variant_id: "a" }],
    });
    // A second, unrelated coordinator (another machine's install) registers the same checkout.
    const second = await setup();
    const reg = await addProject(second.call, repo, "lab");
    expect((reg["research_import"] as Json)["imported"]).toBe(3);
    const got = await second.call<{ records: ResearchRecord[] }>(
      "/api/v1/projects/lab/research?sort=created&order=asc",
    );
    const byId = new Map(got.body.records.map((r) => [r.record_id, r]));
    expect(byId.get(note.record_id)).toEqual(note);
    expect(byId.get(hyp.record_id)).toEqual(hyp);
    expect(byId.get(study.record_id)).toEqual(study);

    // Only once: later export edits are never read back, even across restarts.
    const path = join(repo, ".ablationkit/research/hypotheses.json");
    writeFileSync(path, readFileSync(path, "utf8").replace("Imported H", "Changed in Git"));
    const home = second.cl.c.services.paths.home;
    await second.cl.c.stop();
    h.coordinators.splice(h.coordinators.indexOf(second.cl.c), 1);
    const third = await setup({ home, fake: second.fake });
    const again = await third.call<{ record: ResearchRecord }>(
      `/api/v1/projects/lab/research/${hyp.record_id}`,
    );
    expect(again.body.record.title).toBe("Imported H");
  });

  test("render and parse round-trip; unparseable export files are reported, not imported", () => {
    const rec = (over: Partial<ResearchRecord>): ResearchRecord => ({
      schema_version: 1,
      record_id: "note-1",
      project_id: "p",
      kind: "note",
      title: "T",
      tags: [],
      links: [],
      created_at: "2026-11-02T10:00:00Z",
      updated_at: "2026-11-02T10:00:00Z",
      created_by: { kind: "human" },
      updated_by: { kind: "human" },
      revision: 1,
      ...over,
    });
    const records = [
      rec({ body: "ends with marker <!-- ablationkit:body -->\nmore\n\n" }),
      rec({ record_id: "note-2", title: "T" }),
      rec({
        record_id: "rep-1",
        kind: "report",
        title: "R",
        status: "final",
        summary: "| a | b |\n<!-- ablationkit:body -->\nnot the body",
        follow_up: "next",
        body: "interp",
        evidence: [
          {
            ref: { kind: "run", id: "r1" },
            values: { "a|b": "1" },
            captured_at: "2026-11-02T10:00:00Z",
          },
        ],
      }),
    ];
    const { files } = renderExport(records);
    expect([...files.keys()].sort()).toEqual([
      "research/notes/2026-11-02-t-2.md",
      "research/notes/2026-11-02-t.md",
      "research/reports/2026-11-02-r.md",
    ]);
    const parsed = parseExport(
      "p",
      (rel) => (rel === "research/notes/junk.md" ? "# hand written\n" : files.get(rel)),
      (dir) =>
        [...files.keys(), "research/notes/junk.md"]
          .filter((k) => k.startsWith(`${dir}/`))
          .map((k) => k.slice(dir.length + 1)),
    );
    const sorted = (l: ResearchRecord[]) =>
      [...l].sort((a, b) => a.record_id.localeCompare(b.record_id));
    expect(sorted(parsed.records)).toEqual(sorted(records));
    expect(parsed.problems).toEqual([
      "research/notes/junk.md: no AblationKit record header; not imported",
    ]);
    expect(looksSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true);
    expect(looksSecret("a perfectly normal sentence about skip-connections")).toBe(false);
  });
});

describe("agent edits (criterion 59)", () => {
  test("an agent token edits research in its own project only; edits appear in the coordinator and the export; worktree export edits have no effect", async () => {
    const { call, cl } = await setup();
    const repo = gitRepo("lab");
    await addProject(call, repo, "lab");
    await addProject(call, h.repo("other"), "other");
    const minted = { body: await cl.agentSession("lab") };
    const agent = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
      cl.json<T>(cl.agent(path, { token: minted.body.token, ...init }));

    const made = await agent<{ record: ResearchRecord }>("/api/v1/projects/lab/research", {
      body: { kind: "hypothesis", title: "Agent hypothesis", summary: "from an agent" },
    });
    expect(made.status).toBe(201);
    expect(made.body.record.created_by).toEqual({ kind: "agent", id: expect.any(String) });
    const id = made.body.record.record_id;
    const upd = await agent<{ record: ResearchRecord }>(`/api/v1/projects/lab/research/${id}`, {
      method: "PATCH",
      body: { status: "testing" },
    });
    expect(upd.status).toBe(200);

    // Scope and human-only operations.
    expect((await agent("/api/v1/projects/other/research")).status).toBe(403);
    expect(
      (await agent("/api/v1/projects/other/research", { body: { kind: "note", title: "x" } }))
        .status,
    ).toBe(403);
    expect((await agent(`/api/v1/projects/lab/research/${id}`, { method: "DELETE" })).status).toBe(
      404,
    );
    expect((await agent("/api/v1/projects/lab/research/export", { body: {} })).status).toBe(404);
    expect((await agent("/api/v1/projects/lab/research")).status).toBe(200);

    // The coordinator sees the agent's edit, attributed, and the main checkout's export has it.
    const seen = await call<{ record: ResearchRecord }>(`/api/v1/projects/lab/research/${id}`);
    expect(seen.body.record.status).toBe("testing");
    expect(seen.body.record.updated_by).toMatchObject({ kind: "agent" });
    expect(exported(repo, "research/hypotheses.json")).toContain("Agent hypothesis");
    const audit = await call<{ records: { action: string; listener: string; target?: string }[] }>(
      "/api/v1/audit?limit=200",
    );
    expect(
      audit.body.records.some(
        (r) => r.action === "research.updated" && r.listener === "agent" && r.target === id,
      ),
    ).toBe(true);

    // An agent worktree has its own copy of the export. Editing it changes nothing canonical.
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "research export");
    const wt = join(h.tmp("ak-wt-"), "candidate");
    git(repo, "worktree", "add", "-q", "-b", "candidate", wt);
    const wtFile = join(wt, ".ablationkit/research/hypotheses.json");
    writeFileSync(
      wtFile,
      readFileSync(wtFile, "utf8").replace("Agent hypothesis", "Rewritten in worktree"),
    );
    mkdirSync(join(wt, ".ablationkit/research/notes"), { recursive: true });
    writeFileSync(join(wt, ".ablationkit/research/notes/2026-11-02-sneaky.md"), "# sneaky\n");
    // Registering the worktree as a project is refused (same manifest ID).
    const reg = await call<{ error: { code: string } }>("/api/v1/projects", { body: { path: wt } });
    expect(reg.status).toBe(409);
    // Another change and a forced export only ever touch the main checkout.
    await call(`/api/v1/projects/lab/research/${id}`, { method: "PATCH", body: { tags: ["x"] } });
    await call("/api/v1/projects/lab/research/export", { body: {} });
    const after = await call<{ records: ResearchRecord[] }>("/api/v1/projects/lab/research");
    expect(after.body.records.map((r) => r.title)).toEqual(["Agent hypothesis"]);
    expect(readFileSync(wtFile, "utf8")).toContain("Rewritten in worktree");
    expect(exported(repo, "research/hypotheses.json")).toContain("Agent hypothesis");
    expect(existsSync(join(repo, ".ablationkit/research/notes/2026-11-02-sneaky.md"))).toBe(false);

    // Even the one-time import refuses to read a linked worktree.
    const { isLinkedWorktree } = await import("../src/research/records.ts");
    expect(isLinkedWorktree(wt)).toBe(true);
    expect(isLinkedWorktree(repo)).toBe(false);
  });
});

describe("conversation links (criterion 16)", () => {
  test("links are organized and linked to hypotheses, runs and reports; nothing is fetched", async () => {
    let hits = 0;
    const chat = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return new Response("transcript");
      },
    });
    try {
      const { call } = await setup();
      await addProject(call, h.repo("lab"), "lab");
      const hyp = await create(call, "lab", { kind: "hypothesis", title: "H" });
      const a = await create(call, "lab", {
        kind: "conversation",
        title: "Tokenizer brainstorm",
        source: "chatgpt",
        url: `http://127.0.0.1:${chat.port}/c/1`,
        tags: ["idea"],
        body: "remember the pair-merge idea",
        conversation_created_at: "2026-10-01T09:00:00Z",
        links: [
          { kind: "hypothesis", id: hyp.record_id },
          { kind: "run", id: "0123456789abcdef", label: "baseline run" },
        ],
      });
      const b = await create(call, "lab", {
        kind: "conversation",
        title: "Claude Code session",
        source: "claude_code",
        local_ref: "session 6f2c…",
      });
      expect(
        (
          await call("/api/v1/projects/lab/research", {
            body: { kind: "conversation", title: "x", source: "claude" },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call("/api/v1/projects/lab/research", {
            body: { kind: "conversation", title: "x", url: "https://x" },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call("/api/v1/projects/lab/research", {
            body: { kind: "conversation", title: "x", source: "codex", url: "javascript:alert(1)" },
          })
        ).status,
      ).toBe(400);

      const list = async (q: string) =>
        (
          await call<{ records: ResearchRecord[] }>(
            `/api/v1/projects/lab/research?kind=conversation&${q}`,
          )
        ).body.records.map((r) => r.record_id);
      expect(await list("source=chatgpt")).toEqual([a.record_id]);
      expect(await list("tag=idea")).toEqual([a.record_id]);
      expect(await list("sort=title")).toEqual([b.record_id, a.record_id]);
      expect(await list("link=run:0123456789abcdef")).toEqual([a.record_id]);

      // A note quoting the conversation, attributed to it.
      const note = await create(call, "lab", {
        kind: "note",
        title: "Pair merges",
        body: "> merge the most frequent pairs",
        attribution: { conversation_id: a.record_id, mode: "quote" },
      });
      const back = await call<{ backlinks: { record_id: string }[] }>(
        `/api/v1/projects/lab/research/${a.record_id}`,
      );
      expect(back.body.backlinks.map((x) => x.record_id)).toEqual([note.record_id]);
      expect(
        (
          await call("/api/v1/projects/lab/research", {
            body: {
              kind: "note",
              title: "x",
              attribution: { conversation_id: hyp.record_id, mode: "quote" },
            },
          })
        ).status,
      ).toBe(422);
      // The run's lineage lists the conversation as a backlink.
      const lin = await call<{ backlinks: { ref: { id: string } }[] }>(
        "/api/v1/projects/lab/lineage?kind=run&id=0123456789abcdef",
      );
      expect(lin.body.backlinks.map((x) => x.ref.id)).toEqual([a.record_id]);

      const edited = await call<{ record: ResearchRecord }>(
        `/api/v1/projects/lab/research/${b.record_id}`,
        {
          method: "PATCH",
          body: { tags: ["session"], links: [{ kind: "note", id: note.record_id }] },
        },
      );
      expect(edited.body.record.tags).toEqual(["session"]);
      await call(`/api/v1/projects/lab/research/${b.record_id}`, { method: "DELETE" });
      expect(await list("")).toEqual([a.record_id]);
      expect(hits).toBe(0);
    } finally {
      chat.stop(true);
    }
  });
});

describe("arbitrary architecture research to a linked report (criteria 1a, 14)", () => {
  test("a custom tokenizer/model/training-loop repo defines baseline and candidate variants, runs both, compares, and gets an evidence-linked report that survives a restart", async () => {
    const { call, fake, cl } = await setup();
    const repo = gitRepo("custom-arch", "custom-arch-research");
    const commit = git(repo, "rev-parse", "HEAD");
    await addProject(call, repo, "arch");

    const hyp = await create(call, "arch", {
      kind: "hypothesis",
      title: "Pair-merge tokenization lowers validation bits per character",
      status: "testing",
    });
    await create(call, "arch", {
      kind: "study",
      id: "tokenizer-ablation",
      title: "Tokenizer ablation",
      protocol: "Two seeds per variant; compare val/bits_per_char at the last step.",
      variants: [
        { variant_id: "char", title: "Character tokenizer" },
        { variant_id: "pairs", title: "Pair-merge tokenizer" },
      ],
      baseline_variant: "char",
      metric_goals: [
        { key: "val/bits_per_char", goal: "min" },
        { key: "tokens_per_char", goal: "min" },
      ],
      links: [{ kind: "hypothesis", id: hyp.record_id }],
    });

    const jobs: string[] = [];
    for (const variant of ["char", "pairs"])
      for (const seed of [0, 1]) {
        const r = await call<{ job_id: string }>("/api/v1/projects/arch/jobs", {
          body: {
            command: ["python3", "train.py", "--tokenizer", variant, "--seed", String(seed)],
            study_id: "tokenizer-ablation",
            variant_id: variant,
            run_name: `${variant}-s${seed}`,
          },
        });
        expect(r.status).toBe(201);
        jobs.push(r.body.job_id);
      }
    for (const id of jobs)
      await until(async () => {
        const j = (
          await call<{
            latest_attempt: {
              state: string;
              tracking: { sync_state?: string };
              artifacts: unknown[];
            };
          }>(`/api/v1/jobs/${id}`)
        ).body;
        if (
          j.latest_attempt.state !== "succeeded" &&
          ["failed", "unknown", "cancelled"].includes(j.latest_attempt.state)
        )
          throw new Error(`job ${id} ${j.latest_attempt.state}`);
        return (
          j.latest_attempt.state === "succeeded" &&
          j.latest_attempt.tracking.sync_state === "synced" &&
          j.latest_attempt.artifacts.length > 0
        );
      }, 150_000);

    // Compare: the study view aggregates both variants, with the stored baseline.
    const view = await call<{
      variants: {
        variant_id: string;
        runs: unknown[];
        metrics: Record<string, { mean: number }>;
      }[];
      record?: Json;
    }>("/api/v1/projects/arch/studies/tokenizer-ablation");
    expect(view.body.record?.["baseline_variant"]).toBe("char");
    expect(view.body.variants.map((v) => [v.variant_id, v.runs.length])).toEqual([
      ["char", 2],
      ["pairs", 2],
    ]);
    for (const v of view.body.variants)
      expect(v.metrics["val/bits_per_char"]?.mean).toBeGreaterThan(0);

    const gen = await call<{ record: ResearchRecord }>(
      "/api/v1/projects/arch/research/reports/generate",
      {
        body: { study_id: "tokenizer-ablation" },
      },
    );
    expect(gen.status).toBe(201);
    const report = gen.body.record;
    expect(report.generated).toMatchObject({
      study_id: "tokenizer-ablation",
      baseline_variant: "char",
      runs: 4,
    });
    expect(report.links).toEqual([
      { kind: "study", id: "tokenizer-ablation" },
      { kind: "hypothesis", id: hyp.record_id },
    ]);
    expect(report.body).toBeUndefined(); // interpretation is never generated
    expect(report.evidence).toHaveLength(4);
    const runIds = new Set<string>();
    for (const e of report.evidence ?? []) {
      expect(e.ref.kind).toBe("run");
      runIds.add(e.ref.id);
      expect(fake.run(e.ref.id)).toBeDefined();
      expect(e.attempt_id).toBeDefined();
      expect(e.job_id && jobs.includes(e.job_id)).toBe(true);
      expect(e.source_commit).toBe(commit);
      expect(e.role).toBe(e.variant_id === "char" ? "baseline" : "candidate");
      expect(Number(e.values?.["val/bits_per_char"])).toBeGreaterThan(0);
      expect(e.artifacts).toContain("model/model_config.json");
    }
    expect(runIds.size).toBe(4);
    expect(report.summary).toContain("| char (baseline) | 2 |");
    expect(report.summary).toMatch(/\| pairs \| 2 \| .*Δ/);
    expect(report.summary).toContain("val/bits_per_char (↓)");

    // The researcher writes the interpretation; regenerating refreshes evidence and keeps it.
    await call(`/api/v1/projects/arch/research/${report.record_id}`, {
      method: "PATCH",
      body: {
        body: "Pair merges help at this scale.",
        follow_up: "Try more merges.",
        status: "final",
      },
    });
    const regen = await call<{ record: ResearchRecord }>(
      `/api/v1/projects/arch/research/${report.record_id}/regenerate`,
      { body: {} },
    );
    expect(regen.body.record.body).toBe("Pair merges help at this scale.");
    expect(regen.body.record.evidence).toHaveLength(4);

    // Exported for Git, with run and attempt IDs in the evidence table.
    const reportFile = readdirSync(join(repo, ".ablationkit/research/reports"))[0] as string;
    const md = exported(repo, `research/reports/${reportFile}`) as string;
    for (const e of report.evidence ?? []) expect(md).toContain(e.ref.id);
    expect(md).toContain("## Interpretation");
    expect(md).toContain("Pair merges help at this scale.");

    // Lineage from a run: hypothesis → study → variant → job → attempt → run, gaps explicit.
    const someRun = report.evidence?.[0]?.ref.id as string;
    const lin = await call<{
      steps: { step: string; status: string; items: { ref: { id: string } }[]; reason?: string }[];
      backlinks: { ref: { id: string } }[];
    }>(`/api/v1/projects/arch/lineage?kind=run&id=${someRun}`);
    const step = (s: string) => lin.body.steps.find((x) => x.step === s);
    expect(step("hypothesis")?.items.map((i) => i.ref.id)).toEqual([hyp.record_id]);
    expect(step("study")?.items.map((i) => i.ref.id)).toEqual(["tokenizer-ablation"]);
    expect(step("variant")?.items).toHaveLength(1);
    expect(step("job")?.items).toHaveLength(1);
    expect(step("attempt")?.status).toBe("linked");
    expect(step("run")?.status).toBe("subject");
    // Stage 12: the run logged no model, so the model steps are explicit gaps.
    expect(step("logged_model")).toMatchObject({
      status: "missing",
      reason: "the run logged no model",
    });
    expect(step("evaluation")?.status).toBe("missing");
    expect(step("inference")?.status).toBe("missing");
    expect(lin.body.backlinks.map((b) => b.ref.id)).toEqual([report.record_id]);
    // From the hypothesis downward: all four runs.
    const down = await call<{ steps: { step: string; items: unknown[] }[] }>(
      `/api/v1/projects/arch/lineage?kind=hypothesis&id=${hyp.record_id}`,
    );
    expect(down.body.steps.find((s) => s.step === "run")?.items).toHaveLength(4);
    // From the report: through its links.
    const fromReport = await call<{ steps: { step: string; status: string }[] }>(
      `/api/v1/projects/arch/lineage?kind=report&id=${report.record_id}`,
    );
    expect(fromReport.body.steps.find((s) => s.step === "run")?.status).toBe("linked");

    // Criterion 14: a restart keeps notes, job history, evidence and research links.
    await create(call, "arch", {
      kind: "note",
      title: "Restart note",
      links: [{ kind: "job", id: jobs[0] as string }],
    });
    const before = (
      await call<{ records: ResearchRecord[] }>("/api/v1/projects/arch/research?archived=include")
    ).body.records;
    const home = cl.c.services.paths.home;
    await cl.c.stop();
    h.coordinators.splice(h.coordinators.indexOf(cl.c), 1);
    const next = await setup({ home, fake });
    const afterList = (
      await next.call<{ records: ResearchRecord[] }>(
        "/api/v1/projects/arch/research?archived=include",
      )
    ).body.records;
    expect(afterList).toEqual(before);
    const jobsAfter = await next.call<{ jobs: { job_id: string; state: string }[] }>(
      "/api/v1/projects/arch/jobs",
    );
    expect(jobsAfter.body.jobs.map((j) => j.job_id).sort()).toEqual([...jobs].sort());
    const linAfter = await next.call<{ steps: { step: string; items: unknown[] }[] }>(
      `/api/v1/projects/arch/lineage?kind=run&id=${someRun}`,
    );
    expect(linAfter.body.steps.find((s) => s.step === "hypothesis")?.items).toHaveLength(1);
  }, 240_000);
});

describe("lineage gaps", () => {
  test("missing links are explicit, never fabricated", async () => {
    const { call, cl } = await setup();
    await addProject(call, h.repo("lab"), "lab");
    const hyp = await create(call, "lab", { kind: "hypothesis", title: "Lonely" });
    const lin = await call<{
      steps: { step: string; status: string; reason?: string; items: unknown[] }[];
    }>(`/api/v1/projects/lab/lineage?kind=hypothesis&id=${hyp.record_id}`);
    const by = Object.fromEntries(lin.body.steps.map((s) => [s.step, s]));
    expect(by["hypothesis"]?.status).toBe("subject");
    expect(by["study"]).toMatchObject({
      status: "missing",
      reason: "no study is linked to the hypothesis yet",
    });
    expect(by["run"]?.status).toBe("missing");
    expect(by["logged_model"]).toMatchObject({ status: "missing", reason: "no logged model" });
    expect(by["inference"]).toMatchObject({ status: "missing", reason: "no model to run" });
    // An unknown run has no upstream; its strip says so.
    const run = await call<{ steps: { step: string; status: string; reason?: string }[] }>(
      "/api/v1/projects/lab/lineage?kind=run&id=deadbeef",
    );
    expect(run.body.steps.find((s) => s.step === "study")).toMatchObject({
      status: "missing",
      reason: "not part of a study (no study_id)",
    });
    expect((await call("/api/v1/projects/lab/lineage?kind=note&id=nope")).status).toBe(404);
    expect((await call("/api/v1/projects/lab/lineage")).status).toBe(400);
    // A kind lineage can't trace says which kinds it can, instead of a misleading 404.
    const odd = await call<{ error: { message: string } }>(
      "/api/v1/projects/lab/lineage?kind=trace&id=tr-1",
    );
    expect(odd.status).toBe(400);
    expect(odd.body.error.message).toContain("lineage traces hypothesis, study");
    expect(odd.body.error.message).toContain("inference_session, task");
    // A task is traced through the jobs it ran. Agents create tasks (ADR 0039).
    const { token } = await cl.agentSession("lab");
    const task = await cl.json<{ task: { task_id: string } }>(
      cl.agent("/api/v1/projects/lab/tasks", { token, body: { goal: "Try ALiBi" } }),
    );
    expect(task.status).toBe(201);
    const tid = task.body.task.task_id;
    const job = await call<{ job_id: string }>("/api/v1/projects/lab/jobs", {
      body: { command: ["true"], environment: "none", task_id: tid },
    });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    const byTask = await call<{ steps: { step: string; items: { ref: { id: string } }[] }[] }>(
      `/api/v1/projects/lab/lineage?kind=task&id=${tid}`,
    );
    expect(byTask.status).toBe(200);
    expect(byTask.body.steps.find((s) => s.step === "job")?.items.map((i) => i.ref.id)).toEqual([
      job.body.job_id,
    ]);
    expect((await call("/api/v1/projects/lab/lineage?kind=task&id=task-nope")).status).toBe(404);
  });
});
