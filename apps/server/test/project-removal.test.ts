/** Project removal (ADR 0034): the code stays; `.ablationkit/`, state and workspaces move aside. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness } from "./helpers.ts";

const h = new Harness();
afterEach(() => h.cleanup());

interface Plan {
  blockers: string[];
  moves: { what: string; from: string; to: string }[];
  skipped?: string;
  kept: string[];
}

async function setup() {
  const cl = await h.start({ researchExportDelayMs: 0 });
  const cookie = await cl.browserSession();
  const auth = { cookie, origin: cl.localOrigin };
  const repo = h.repo("lab");
  writeFileSync(join(repo, "train.py"), "print('hi')\n");
  const call = <T = Record<string, unknown>>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) => cl.json<T>(cl.human(path, { ...auth, ...init }));
  expect((await call("/api/v1/projects", { body: { path: repo, project_id: "lab" } })).status).toBe(
    201,
  );
  const note = await call("/api/v1/projects/lab/research", {
    body: { kind: "note", title: "Kept aside", body: "recoverable" },
  });
  expect(note.status).toBe(201);
  return { cl, repo, call };
}

describe("project removal", () => {
  test("moves the checkout's .ablationkit and the project's state aside and forgets it", async () => {
    const { cl, repo, call } = await setup();
    const home = cl.c.services.paths.home;
    expect(existsSync(join(repo, ".ablationkit", "project.json"))).toBe(true);

    const plan = await call<{ plan: Plan }>("/api/v1/projects/lab/removal");
    expect(plan.status).toBe(200);
    expect(plan.body.plan.blockers).toEqual([]);
    expect(plan.body.plan.moves.map((m) => m.to).sort()).toEqual(["checkout", "state"]);
    expect(plan.body.plan.kept.join(" ")).toContain("ak/lab");

    // The researcher's session is enough (ADR 0037); an agent has no such route.
    const r = await call<{ removed: { moved_to: string } }>("/api/v1/projects/lab", {
      method: "DELETE",
    });
    expect(r.status).toBe(200);
    const dest = r.body.removed.moved_to;
    expect(dest.startsWith(join(home, "removed-projects", "lab-"))).toBe(true);

    // The code is untouched; only `.ablationkit/` left the checkout (registration wrote nothing
    // else into it since ADR 0062).
    expect(readdirSync(repo).sort()).toEqual([".git", "train.py"]);
    expect(existsSync(join(dest, "checkout", "project.json"))).toBe(true);
    expect(existsSync(join(dest, "state", "research"))).toBe(true);
    expect(existsSync(join(home, "state", "lab"))).toBe(false);
    const record = JSON.parse(readFileSync(join(dest, "removal.json"), "utf8"));
    expect(record.project.project_id).toBe("lab");

    expect((await call<{ projects: unknown[] }>("/api/v1/projects")).body.projects).toEqual([]);
    expect((await call("/api/v1/projects/lab/research")).status).toBe(404);

    // The checkout can be registered again, starting fresh.
    expect(
      (await call("/api/v1/projects", { body: { path: repo, project_id: "lab" } })).status,
    ).toBe(201);
    const notes = await call<{ records: unknown[] }>("/api/v1/projects/lab/research");
    expect(notes.body.records).toEqual([]);
  });

  test("refuses while a job is running, and removes once it is cancelled", async () => {
    const { cl, repo, call } = await setup();
    const job = await call<{ job_id: string }>("/api/v1/projects/lab/jobs", {
      body: { command: ["sleep", "30"], environment: "none" },
    });
    expect(job.status).toBe(201);
    const jid = job.body.job_id;

    const plan = await call<{ plan: Plan }>("/api/v1/projects/lab/removal");
    expect(plan.body.plan.blockers.join("\n")).toContain(`job ${jid}`);
    const busy = await call<{ error: { code: string } }>("/api/v1/projects/lab", {
      method: "DELETE",
    });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("project_busy");
    expect(existsSync(join(repo, ".ablationkit", "project.json"))).toBe(true);

    const until = async (pred: () => boolean) => {
      const end = Date.now() + 30_000;
      while (!pred() && Date.now() < end) await Bun.sleep(50);
    };
    const state = () => {
      const j = cl.c.services.jobs.get(jid);
      return j ? cl.c.services.jobs.latestAttempt(j)?.state : undefined;
    };
    await until(() => state() === "running");
    expect((await call(`/api/v1/jobs/${jid}/cancel`, { body: {} })).status).toBe(202);
    await until(() => cl.c.services.jobs.unfinished("lab").length === 0);
    const ok = await call("/api/v1/projects/lab", {
      method: "DELETE",
    });
    expect(ok.status).toBe(200);
    expect(cl.c.services.jobs.list("lab")).toEqual([]);
  }, 60_000);

  test("leaves a checkout manifest that belongs to another project", async () => {
    const { repo, call } = await setup();
    // The checkout was reused by another project (its manifest now names it).
    writeFileSync(
      join(repo, ".ablationkit", "project.json"),
      JSON.stringify({ schema_version: 1, project_id: "other", name: "other" }),
    );
    const plan = await call<{ plan: Plan }>("/api/v1/projects/lab/removal");
    expect(plan.body.plan.skipped).toContain("other");
    expect(plan.body.plan.moves.map((m) => m.to)).toEqual(["state"]);
    const r = await call("/api/v1/projects/lab", {
      method: "DELETE",
    });
    expect(r.status).toBe(200);
    expect(existsSync(join(repo, ".ablationkit", "project.json"))).toBe(true);
  });
});
