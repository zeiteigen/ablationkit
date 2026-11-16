/**
 * Criterion 3 (file-based research): after a coordinator has registered a project, written
 * research records (hypothesis, note, conversation link, study), run a job that logs metrics and
 * an artifact, and restarted, every file it owns is JSON, JSONL, Markdown or a plain file, and no
 * embedded database exists outside `<home>/mlflow/`. The same audit runs on a real-MLflow home in
 * `restore-e2e.test.ts`. The source check pins the one place AblationKit opens SQLite (MLflow's
 * own database, for backups).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";
import { ownedStateAudit, RECORD_EXTENSIONS } from "./owned-state.ts";

const ROOT = resolve(import.meta.dir, "../../..");
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
  jobs: { supervisor: "direct", deliver_deadline_sec: 30 },
};

async function boot(home: string, fake: FakeMlflow) {
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
  return { cl, call };
}

function gitRepo(): string {
  const d = join(h.tmp("ak-filebased-"), "lab");
  execFileSync("mkdir", ["-p", d]);
  writeFileSync(
    join(d, "train.py"),
    [
      "import ablationkit_sdk as ak",
      "for step in range(3):",
      "    ak.log_metrics({'loss': 1.0 / (step + 1)}, step=step)",
      "open('out.txt', 'w').write('result')",
      "ak.log_artifact('out.txt')",
      "print('done', flush=True)",
      "",
    ].join("\n"),
  );
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["commit", "-q", "-m", "init"],
  ])
    execFileSync("git", args, { cwd: d, env });
  return d;
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

describe("file-based state (criterion 3)", () => {
  test("a coordinator's own records are JSON, JSONL, Markdown and files; no database outside mlflow/", async () => {
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const home = h.tmp("ak-home-");
    const repo = gitRepo();
    let { cl, call } = await boot(home, fake);
    expect(
      (await call("/api/v1/projects", { body: { path: repo, project_id: "lab" } })).status,
    ).toBe(201);
    const rec = async (body: Json) => {
      const r = await call(`/api/v1/projects/lab/research`, { body });
      expect(r.status).toBe(201);
    };
    await rec({ kind: "hypothesis", title: "Smaller vocab helps" });
    await rec({ kind: "note", title: "Observations", body: "# Notes\n\nPlateau at step 2." });
    await rec({
      kind: "conversation",
      title: "Brainstorm",
      source: "claude",
      url: "https://claude.ai/chat/abc",
    });
    const s = await call<{ job_id: string }>("/api/v1/projects/lab/jobs", {
      body: { command: ["python3", "train.py"], run_name: "baseline" },
    });
    expect(s.status).toBe(201);
    await until(async () => {
      const j = (await call<{ state: string }>(`/api/v1/jobs/${s.body.job_id}`)).body;
      return ["succeeded", "failed"].includes(j.state) ? j : undefined;
    });
    // Restart: the state is read back from the same files.
    await cl.c.stop();
    h.coordinators.splice(h.coordinators.indexOf(cl.c), 1);
    ({ cl, call } = await boot(home, fake));
    const notes = await call<{ records: unknown[] }>("/api/v1/projects/lab/research?kind=note");
    expect(notes.body.records).toHaveLength(1);

    const audit = ownedStateAudit(home, "mlflow/");
    expect(audit.files).toBeGreaterThan(20);
    expect(audit.databases).toEqual([]);
    // Record directories hold only JSON, JSONL and Markdown.
    for (const dir of ["audit", "events", "state", "auth"]) {
      const kinds = [...(audit.census.get(dir) ?? [])].filter((k) => !RECORD_EXTENSIONS.has(k));
      expect(kinds, `${dir}/ holds ${kinds.join(", ")}`).toEqual([]);
    }
    const checkout = ownedStateAudit(join(repo, ".ablationkit"));
    expect(checkout.databases).toEqual([]);
    expect(checkout.files).toBeGreaterThan(0);
  }, 60_000);

  test("AblationKit source opens SQLite only to snapshot MLflow's own database", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist", "test", ".venv", "venv", "__pycache__"].includes(e.name))
          continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|py)$/.test(e.name) && statSync(p).size < 2_000_000) {
          const src = readFileSync(p, "utf8");
          if (/from "bun:sqlite"|^\s*import sqlite3|^\s*from sqlite3|better-sqlite3/m.test(src))
            hits.push(relative(ROOT, p));
        }
      }
    };
    for (const d of ["apps", "packages", "python"]) walk(join(ROOT, d));
    expect(hits).toEqual(["packages/tracking-mlflow/src/sqlite-snapshot.ts"]);
  });
});
