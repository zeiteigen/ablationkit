/**
 * The library (ADR 0052): prior work an agent consulted, kept across sessions, cited by notes with
 * the role it played, checked, exported as citations, and listed under the task it was found for.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorSettings, VaultWork } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
afterEach(async () => {
  await h.cleanup();
  for (const f of fakes.splice(0)) f.stop();
});

type Json = Record<string, unknown>;
interface Check {
  code: string;
  note?: string;
  work?: string;
  message: string;
}

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
  const start = () =>
    h.start({ home, trackingUrl: fake.url, researchExportDelayMs: 0, settings: SETTINGS });
  const cl = await start();
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  expect(
    (await call("/api/v1/projects", { body: { path: h.repo("lab"), project_id: "lab" } })).status,
  ).toBe(201);
  const minted = await cl.agentSession("lab");
  const agent = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.agent(path, { token: minted.token, ...init }));
  return { cl, call, agent, home, token, start };
}

const P = "/api/v1/projects/lab";
const V = `${P}/vault`;

const XIONG = {
  id: "xiong-2020-layernorm",
  kind: "paper",
  title: "On Layer Normalization in the Transformer Architecture",
  authors: ["Xiong, Ruibin", "Yang, Yunchang", "others"],
  year: 2020,
  venue: "ICML 2020",
  arxiv: "https://arxiv.org/abs/2002.04745",
  reading: "read",
  summary: "Pre-LN puts normalisation inside the residual branch and ends with a final LayerNorm.",
  takeaway: "The final LayerNorm is part of the Pre-LN design; our 64k model lacks it.",
  found_for: "Why the 64k model trails: [[gap-64k]]",
  found_via: 'web search "pre-LN final layer norm"',
};

describe("the library", () => {
  test("works are kept, cited with a role, checked, exported and survive a restart", async () => {
    const { cl, agent, call, home, start } = await setup();
    const task = await agent<{ task: { task_id: string } }>(`${P}/tasks`, {
      body: { title: "Close the gap", goal: "Why does the 64k model trail?" },
    });
    const tid = task.body.task.task_id;

    const added = await agent<{ work: VaultWork; checks: Check[] }>(`${V}/works`, {
      body: { ...XIONG, task_id: tid },
    });
    expect(added.status).toBe(201);
    // The arXiv URL is stored as its ID; the work is attributed to the agent.
    expect(added.body.work).toMatchObject({ arxiv: "2002.04745", revision: 1 });
    expect(added.body.work.created_by.kind).toBe("agent");
    expect(existsSync(join(home, "state/lab/vault/works/xiong-2020-layernorm.json"))).toBe(true);

    // The same paper again, under another key and as its versioned abs URL, is refused by name.
    const twice = await agent<{ error: { code: string; message: string; details: Json } }>(
      `${V}/works`,
      {
        body: {
          ...XIONG,
          id: "xiong-layernorm",
          arxiv: undefined,
          url: "https://arxiv.org/abs/2002.04745v2",
        },
      },
    );
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("work_exists");
    expect(twice.body.error.message).toContain("xiong-2020-layernorm");
    // A malformed one says what to change.
    const bad = await agent<{ error: { code: string; message: string } }>(`${V}/works`, {
      body: { ...XIONG, id: "Xiong 2020" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain("citation key");
    const noTake = await agent(`${V}/works`, {
      body: { ...XIONG, id: "other-2021", arxiv: "2101.00001", takeaway: undefined },
    });
    expect(noTake.status).toBe(400);

    // Read and set aside, and found but not read yet.
    await agent(`${V}/works`, {
      body: {
        id: "karpathy-nanogpt",
        kind: "repo",
        title: "nanoGPT",
        authors: ["Karpathy, Andrej"],
        url: "https://github.com/karpathy/nanoGPT",
        version: "93a43d9",
        reading: "skimmed",
        takeaway: "Set aside: it ties embeddings, which we study separately.",
      },
    });
    await agent(`${V}/works`, {
      body: {
        id: "someone-2024-warmup",
        kind: "preprint",
        title: "Warm-up, revisited",
        authors: ["Someone, A."],
        year: "2024",
        arxiv: "arXiv:2401.00001",
        reading: "unread",
        takeaway: "Not read yet.",
      },
    });

    // Notes cite works with a role; a cite of an unread work the note rests on is a check.
    const fix = await agent<{ note: Json; checks: Check[] }>(`${V}/notes`, {
      body: {
        id: "final-layernorm-fixes-gap",
        type: "finding",
        title: "Adding the final LayerNorm closes the gap",
        gist: "With a final LayerNorm the 64k model matches the 8k model.",
        cites: [
          { work: "xiong-2020-layernorm", role: "solution", where: "§3" },
          { work: "someone-2024-warmup", role: "supports" },
        ],
        task_id: tid,
      },
    });
    expect(fix.status).toBe(201);
    expect(fix.body.checks.map((c) => c.code)).toContain("cites_unread");
    expect(fix.body.checks.map((c) => c.code)).not.toContain("no_sources");
    const ask = await agent<{ checks: Check[] }>(`${V}/notes`, {
      body: {
        id: "warmup-matters",
        type: "question",
        standing: "open",
        title: "Does warm-up matter?",
        gist: "Unknown.",
      },
    });
    expect(ask.body.checks.map((c) => c.code)).toContain("question_without_prior_work");
    // An unknown role is refused; an unknown work is a check.
    const badRole = await agent(`${V}/notes`, {
      body: {
        id: "x",
        type: "concept",
        title: "X",
        gist: "X.",
        cites: [{ work: "xiong-2020-layernorm", role: "related" }],
      },
    });
    expect(badRole.status).toBe(400);
    const lost = await agent<{ checks: Check[] }>(`${V}/notes`, {
      body: {
        id: "lost",
        type: "concept",
        title: "Lost",
        gist: "Lost.",
        cites: [{ work: "nobody-1999", role: "background" }],
      },
    });
    expect(lost.body.checks.map((c) => c.code)).toContain("unknown_work");

    // A note names its works as a reader would.
    const shown = await agent<{ cites: Json[] }>(`${V}/notes/final-layernorm-fixes-gap`);
    expect(shown.body.cites[0]).toMatchObject({
      work: "xiong-2020-layernorm",
      role: "solution",
      cite: "Xiong et al. 2020",
      href: "https://arxiv.org/abs/2002.04745",
    });

    // Lists: by words, role and standing; a work shows every note that cites it and its role there.
    const list = (q = "") => agent<{ works: Json[]; total: number }>(`${V}/works${q}`);
    expect((await list()).body.total).toBe(3);
    expect((await list("?q=xiong%20layernorm")).body.works.map((w) => w["work_id"])).toEqual([
      "xiong-2020-layernorm",
    ]);
    expect((await list("?role=solution")).body.works.map((w) => w["work_id"])).toEqual([
      "xiong-2020-layernorm",
    ]);
    expect((await list("?standing=considered")).body.works.map((w) => w["work_id"])).toEqual([
      "karpathy-nanogpt",
    ]);
    expect((await list("?role=nope")).status).toBe(400);
    const one = await agent<{ roles: string[]; cited_by: Json[]; standing: string }>(
      `${V}/works/xiong-2020-layernorm`,
    );
    expect(one.body).toMatchObject({ standing: "used", roles: ["solution"] });
    expect(one.body.cited_by).toEqual([
      {
        note_id: "final-layernorm-fixes-gap",
        type: "finding",
        title: "Adding the final LayerNorm closes the gap",
        role: "solution",
        where: "§3",
      },
    ]);

    // The vault's view carries the library and its counts.
    const view = await call<{ works: VaultWork[]; counts: Json }>(V);
    expect(view.body.works).toHaveLength(3);
    expect(view.body.counts).toMatchObject({ works: 3, works_cited: 2, works_unread: 1 });

    // The task lists the works found for it, with their checks.
    const tw = await agent<{ works: Json[]; checks: { code: string; ref: string }[] }>(
      `${P}/tasks/${tid}`,
    );
    expect(tw.body.works).toEqual([
      {
        work_id: "xiong-2020-layernorm",
        cite: "Xiong et al. 2020",
        title: XIONG.title,
        reading: "read",
        standing: "used",
        roles: ["solution"],
      },
    ]);
    expect(tw.body.checks.map((c) => c.ref)).toContain("note:final-layernorm-fixes-gap");

    // Citations: BibTeX with the role as the annotation, CSL-JSON, an annotated bibliography.
    const bib = await cl.human(`${V}/citations?format=bibtex`, { token: await cl.session() });
    expect(bib.status).toBe(200);
    expect(bib.headers.get("content-type")).toContain("application/x-bibtex");
    expect(bib.headers.get("content-disposition")).toContain('filename="lab.bib"');
    const text = await bib.text();
    expect(text).toContain("@inproceedings{xiong-2020-layernorm,");
    expect(text).toContain("Role: solution in “Adding the final LayerNorm closes the gap” (§3)");
    expect(text).toContain("@misc{karpathy-nanogpt,");
    const cited = (await (
      await cl.agent(`${V}/citations?format=csl-json&cited=1`, {
        token: (await cl.agentSession("lab")).token,
      })
    ).json()) as Json[];
    expect(cited.map((i) => i["id"])).toEqual(["someone-2024-warmup", "xiong-2020-layernorm"]);
    const md = await (
      await cl.human(`${V}/citations?format=markdown`, { token: await cl.session() })
    ).text();
    expect(md).toContain("## Solutions to problems we hit");
    expect(md).toContain("## Considered and set aside");
    expect(
      (await cl.human(`${V}/citations?format=ris`, { token: await cl.session() })).status,
    ).toBe(400);
    expect(
      (await cl.human(`${V}/citations?notebook=none`, { token: await cl.session() })).status,
    ).toBe(404);

    // Update and archive; the archived work's citers are named, and their cite becomes a check.
    const up = await agent<{ work: VaultWork }>(`${V}/works/someone-2024-warmup`, {
      method: "PATCH",
      body: { reading: "read", takeaway: "Warm-up does not explain the gap.", if_revision: 1 },
    });
    expect(up.body.work).toMatchObject({ reading: "read", revision: 2 });
    const stale = await agent(`${V}/works/someone-2024-warmup`, {
      method: "PATCH",
      body: { reading: "skimmed", if_revision: 1 },
    });
    expect(stale.status).toBe(409);
    const arch = await agent<{ cited_by: string[] }>(`${V}/works/someone-2024-warmup/archive`, {
      body: {},
    });
    expect(arch.body.cited_by).toEqual(["final-layernorm-fixes-gap"]);
    const checks = (await agent<{ checks: Check[] }>(`${V}/check`)).body.checks;
    expect(
      checks.find((c) => c.code === "unknown_work" && c.note === "final-layernorm-fixes-gap")
        ?.message,
    ).toContain("archived");
    // Deleting is the researcher's: the agent listener has no such route.
    expect((await agent(`${V}/works/karpathy-nanogpt`, { method: "DELETE" })).status).toBe(404);

    // The library is files: it survives a restart.
    await cl.c.stop();
    const again = await start();
    const token = await again.session();
    const after = await again.json<{ works: Json[] }>(
      again.human(`${V}/works?archived=only`, { token }),
    );
    expect(after.body.works.map((w) => w["work_id"])).toEqual(["someone-2024-warmup"]);
    const gone = await again.json<{ deleted: string }>(
      again.human(`${V}/works/karpathy-nanogpt`, { token, method: "DELETE" }),
    );
    expect(gone.body.deleted).toBe("karpathy-nanogpt");
  });

  test("an import replaces a work whole and changes nothing the second time", async () => {
    const { agent } = await setup();
    const put = (body: Json) =>
      agent<{ created: boolean; unchanged?: boolean; work: VaultWork }>(
        `${V}/works/xiong-2020-layernorm`,
        {
          method: "PUT",
          body,
        },
      );
    const { id: _, ...fields } = XIONG;
    expect((await put(fields)).body.created).toBe(true);
    const same = await put(fields);
    expect(same.body).toMatchObject({ created: false, unchanged: true });
    expect(same.body.work.revision).toBe(1);
    const { summary: _s, ...less } = fields;
    const replaced = await put(less);
    expect(replaced.body.work.summary).toBeUndefined();
    expect(replaced.body.work.revision).toBe(2);
  });
});
