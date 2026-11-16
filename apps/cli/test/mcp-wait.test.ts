/**
 * `ablationkit_wait` (ADR 0060): an agent waits for its jobs through MCP instead of sleeping in a
 * shell. Real coordinator, real jobs (direct supervisor), a fake MLflow, so "results in" is real.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { AgentSession, handleMcp, type McpIo, MCP_TOOLS } from "../src/commands/mcp.ts";
import { cli, Harness, ROOT } from "./helpers.ts";

const BASE = join(homedir(), ".cache", "ablationkit-tests");
mkdirSync(BASE, { recursive: true });
const h = new Harness(BASE);
afterEach(h.cleanup);
const tmp = () => h.tmp("ak-cli-wait-");
const ENV = {
  GIT_AUTHOR_NAME: "r",
  GIT_AUTHOR_EMAIL: "r@r",
  GIT_COMMITTER_NAME: "r",
  GIT_COMMITTER_EMAIL: "r@r",
};
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, ...ENV } }).trim();

process.env["ABLATIONKIT_WAIT_POLL_MS"] = "200";

// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON
type Out = any;

const METRICS = `
import json, sys, time
steps, pause = int(sys.argv[1]), float(sys.argv[2])
with open("m.jsonl", "a") as f:
    for s in range(steps):
        f.write(json.dumps({"step": s, "loss": 1.0 / (s + 1)}) + "\\n")
        f.flush()
        print("step", s, flush=True)
        time.sleep(pause)
`;

async function setup() {
  const home = tmp();
  const fake = h.track(new FakeMlflow().start());
  const c = await h.start(
    home,
    { trackingUrl: fake.url, trackingIntervalMs: 20, jobWatchdogMs: 200 },
    { jobs: { supervisor: "direct" } },
  );
  const repo = join(tmp(), "lab");
  git(tmp(), "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "train.py"), METRICS);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  expect((await cli(home, ["project", "add", repo])).code).toBe(0);
  const session = new AgentSession({ home, cwd: repo, harness: "test" });
  let id = 0;
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
    io: McpIo = {},
    meta?: unknown,
  ): Promise<Out> => {
    const r = (await handleMcp(
      {
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
      },
      session,
      io,
    )) as {
      result: { content: { text: string }[]; structuredContent: unknown; isError?: boolean };
    };
    return {
      ...(r.result.structuredContent as object),
      _text: r.result.content.map((x) => x.text).join("\n"),
      _error: r.result.isError,
    };
  };
  const submit = async (args: string[], extra: Record<string, unknown> = {}) => {
    const j = await call("ablationkit_job", {
      action: "submit",
      command: ["python3", "train.py", ...args],
      description: "A test run.",
      runtime_max_sec: 120,
      environment: "none",
      metrics_file: "m.jsonl",
      ...extra,
    });
    expect(j._error).toBeUndefined();
    return j.job_id as string;
  };
  return { c, session, call, submit, home, repo };
}

describe("ablationkit_wait (ADR 0060)", () => {
  test("waits on this session's live jobs: any, then all, with their results in", async () => {
    const { call, submit, session } = await setup();
    const tools = MCP_TOOLS.map((t) => t.name);
    expect(tools.indexOf("ablationkit_wait")).toBe(tools.indexOf("ablationkit_job") + 1);
    const none = await call("ablationkit_wait", {});
    expect(none).toMatchObject({ done: true, reason: "nothing_to_wait_for" });
    const quick = await submit(["2", "0.05"], { run_name: "quick" });
    const slow = await submit(["6", "0.4"], { run_name: "slow" });
    const t0 = Date.now();
    const any = await call("ablationkit_wait", { timeout_sec: 60 });
    expect(any).toMatchObject({ done: true, reason: "condition", for: "end", until: "any" });
    expect(any.ready).toEqual([quick]);
    const q = any.jobs.find((j: { job_id: string }) => j.job_id === quick);
    expect(q).toMatchObject({ state: "succeeded", ready: true, results: "in", exit_code: 0 });
    expect(any.jobs.find((j: { job_id: string }) => j.job_id === slow).ready).toBe(false);
    expect(any.next).toContain("1 still going");
    // The ended run is readable at once: MLflow has it.
    const m = await call("ablationkit_read", { op: "run.metrics", run: q.run });
    expect(m.metrics.find((x: { key: string }) => x.key === "loss").step).toBe(1);
    // Live jobs only: the quick one is no longer waited on implicitly.
    const all = await call("ablationkit_wait", { until: "all", timeout_sec: 60 });
    expect(all).toMatchObject({ done: true, reason: "condition", ready: [slow] });
    expect(Date.now() - t0).toBeLessThan(30_000);
    // By run name, a job that ended long ago is there at once.
    const byRun = await call("ablationkit_wait", { runs: ["quick"], timeout_sec: 5 });
    expect(byRun).toMatchObject({ done: true, ready: [quick] });
    const unknown = await call("ablationkit_wait", { runs: ["nope"] });
    expect(unknown._error).toBe(true);
    expect(unknown._text).toContain("no job of this project has the run nope");
    await session.end();
  }, 60_000);

  test("start and metric conditions; a timeout says where each job is", async () => {
    const { call, submit, session } = await setup();
    const job = await submit(["40", "0.3"]);
    const start = await call("ablationkit_wait", { jobs: [job], for: "start", timeout_sec: 60 });
    expect(start).toMatchObject({ done: true, ready: [job] });
    expect(start.jobs[0].state).toBe("running");
    const step = await call("ablationkit_wait", {
      jobs: [job],
      for: "metric",
      metric: "loss",
      step: 3,
      timeout_sec: 60,
    });
    expect(step).toMatchObject({ done: true, reason: "condition", metric: "loss", step: 3 });
    expect(step.jobs[0].metric.step).toBeGreaterThanOrEqual(3);
    expect(step.jobs[0].state).toBe("running");
    const short = await call("ablationkit_wait", { jobs: [job], timeout_sec: 1 });
    expect(short).toMatchObject({ done: false, reason: "timeout", ready: [] });
    expect(short.jobs[0]).toMatchObject({ job_id: job, state: "running", ready: false });
    expect(short.next).toContain("Call ablationkit_wait again");
    const bad = await call("ablationkit_wait", { for: "metric" });
    expect(bad._text).toContain('for "metric" needs metric');
    await call("ablationkit_job", { action: "cancel", job_id: job });
    await session.end();
  }, 60_000);

  test("the researcher writing ends the wait, with their words; progress is reported and a cancelled call stops", async () => {
    const { c, call, submit, session } = await setup();
    const job = await submit(["100", "0.3"]);
    await call("ablationkit_wait", { jobs: [job], for: "start", timeout_sec: 60 });
    // Progress notifications while waiting, when the client asks for them.
    const notes: Record<string, unknown>[] = [];
    const ac = new AbortController();
    const waiting = call(
      "ablationkit_wait",
      { jobs: [job], timeout_sec: 60 },
      { notify: (m) => notes.push(m), signal: ac.signal },
      { progressToken: "p1" },
    );
    await Bun.sleep(1200);
    ac.abort();
    const cancelled = await Promise.race([waiting, Bun.sleep(3000).then(() => "hung")]);
    expect(cancelled).not.toBe("hung");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: "p1", total: 60 },
    });
    expect(String((notes[0]?.["params"] as { message?: string } | undefined)?.message)).toContain(
      "waiting for any of 1 to end",
    );
    // A direction while waiting: the wait returns at once, and the researcher's words come with it.
    const pending = call("ablationkit_wait", { jobs: [job], timeout_sec: 60 });
    await Bun.sleep(500);
    c.services.directions.create(
      "lab",
      { target: { kind: "project" }, kind: "ask", text: "Why this learning rate?" },
      { kind: "human", id: "s-1" },
    );
    const r = await pending;
    expect(r).toMatchObject({ done: false, reason: "researcher" });
    expect(r._text).toContain("Why this learning rate?");
    await call("ablationkit_job", { action: "cancel", job_id: job });
    await session.end();
  }, 60_000);

  test("over stdio: a wait runs beside other requests, reports progress, and a cancelled one is not answered", async () => {
    const { submit, call, session, home, repo } = await setup();
    const job = await submit(["100", "0.3"]);
    const p = Bun.spawn(["bun", join(ROOT, "apps/cli/src/main.ts"), "mcp"], {
      cwd: repo,
      env: { ...process.env, ABLATIONKIT_HOME: home, ABLATIONKIT_WAIT_POLL_MS: "200" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const got: Record<string, unknown>[] = [];
    void (async () => {
      let buf = "";
      for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
        buf += new TextDecoder().decode(chunk);
        let i = buf.indexOf("\n");
        while (i >= 0) {
          got.push(JSON.parse(buf.slice(0, i)));
          buf = buf.slice(i + 1);
          i = buf.indexOf("\n");
        }
      }
    })();
    const send = (m: unknown) => p.stdin.write(`${JSON.stringify(m)}\n`);
    const seen = async (f: (m: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 200 && !got.some(f); i++) await Bun.sleep(50);
      return got.find(f);
    };
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "test" } } });
    expect(await seen((m) => m["id"] === 1)).toBeDefined();
    send({
      id: 2,
      method: "tools/call",
      params: {
        name: "ablationkit_wait",
        arguments: { jobs: [job], timeout_sec: 60 },
        _meta: { progressToken: 7 },
      },
    });
    // Another request is answered while the wait runs.
    send({ id: 3, method: "ping" });
    expect(await seen((m) => m["id"] === 3)).toMatchObject({ result: {} });
    expect(
      await seen(
        (m) =>
          m["method"] === "notifications/progress" &&
          (m["params"] as { progressToken?: number }).progressToken === 7,
      ),
    ).toBeDefined();
    send({ method: "notifications/cancelled", params: { requestId: 2, reason: "test" } });
    send({ id: 4, method: "ping" });
    expect(await seen((m) => m["id"] === 4)).toBeDefined();
    await Bun.sleep(800);
    expect(got.some((m) => m["id"] === 2)).toBe(false);
    p.stdin.end();
    await p.exited;
    await call("ablationkit_job", { action: "cancel", job_id: job });
    await session.end();
  }, 60_000);
});
