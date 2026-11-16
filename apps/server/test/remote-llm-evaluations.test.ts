/**
 * Remote GenAI evaluations (ADR 0023 decision 25). A GenAI evaluation on a compute target is a
 * job whose bundle carries the request: the pinned golden-set examples, the prompt templates, the
 * keyless provider endpoints and the scorers. `ablationkit_llm.evaluate` calls the model and scores
 * on the worker; the coordinator creates and fills each target's MLflow run from the job's
 * `eval/genai-results.json` once it has synced. A coordinator shutdown does not interrupt it:
 * the model calls happen once, and it reconciles after the restart.
 *
 * The target is the fake SSH host from `remote-host.ts`; the model is an in-test
 * OpenAI-compatible server that holds its answers until the test releases them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";
import { fakeHost, remoteDir, stopRemotes } from "./remote-host.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  stopRemotes();
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
  for (const s of servers.splice(0)) await s.stop(true);
});

// biome-ignore lint/suspicious/noExplicitAny: loosely typed API JSON in assertions
type Json = any;

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(100);
  }
}

function settings(workerPort = 0): CoordinatorSettings {
  return {
    schema_version: 1,
    human: { host: "127.0.0.1", port: 0 },
    agent: { host: "127.0.0.1", port: 0 },
    worker: { host: "127.0.0.1", port: workerPort },
    mlflow: { enabled: false },
    jobs: { supervisor: "direct", deliver_deadline_sec: 60 },
    remote: {
      heartbeat_sec: 1,
      disconnected_after_sec: 3,
      provider_poll_sec: 1,
      max_backoff_sec: 1,
      min_free_disk_bytes: 0,
    },
  };
}

/** Echoes the last user message ("yes" for a judge); answers wait until `open` is true. */
function fakeLlm() {
  const state = { open: false, calls: 0, judged: 0 };
  const srv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (r) => {
      const body = (await r.json()) as Json;
      while (!state.open) await Bun.sleep(50);
      state.calls++;
      const system = body.messages.find((m: Json) => m.role === "system")?.content ?? "";
      const user = body.messages.filter((m: Json) => m.role === "user").at(-1)?.content ?? "";
      const judge = system.startsWith("You are an evaluator");
      if (judge) state.judged++;
      const text = judge
        ? "yes\nIt answers."
        : `${system.includes("terse") ? "" : "Sure! "}${user}`;
      return Response.json({
        model: body.model,
        choices: [{ message: { role: "assistant", content: text } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    },
  });
  servers.push(srv);
  return { url: `http://127.0.0.1:${srv.port}/v1`, state };
}

async function coordinator(home: string, fake: FakeMlflow, workerPort = 0) {
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    jobWatchdogMs: 200,
    remoteTickMs: 200,
    llmRetentionSweepMs: 0,
    settings: settings(workerPort),
    home,
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  return { cl, call };
}

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    ["git", "-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
}

const P = "/api/v1/projects/rag/llm";
const GOLDEN = [
  {
    example_id: "e1",
    inputs: { question: "refunds?" },
    expectations: { expected_response: "refunds?" },
  },
  {
    example_id: "e2",
    inputs: { question: "shipping?" },
    expectations: { expected_response: "free" },
  },
  { example_id: "e3", inputs: { question: "hours?" }, category: "account" },
];

describe("remote GenAI evaluations", () => {
  test("a GenAI evaluation runs as a job on a target, finishes while the coordinator is off, and fills its runs once after the restart", async () => {
    const llm = fakeLlm();
    const fakeMl = new FakeMlflow().start();
    fakes.push(fakeMl);
    const home = h.tmp("ak-home-");
    const first = await coordinator(home, fakeMl);
    const workerPort = Number(new URL(first.cl.c.urls.worker).port);
    const host = fakeHost(h.tmp("ak-remote-"));
    const dir = join(h.tmp(), "rag");
    mkdirSync(join(dir, "evals"), { recursive: true });
    writeFileSync(join(dir, "golden.jsonl"), GOLDEN.map((x) => JSON.stringify(x)).join("\n"));
    writeFileSync(
      join(dir, "evals", "scorers.py"),
      "def polite(inputs, outputs, expectations, trace):\n    return 'Sure' in str(outputs)\n",
    );
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    expect(
      (await first.call("/api/v1/projects", { body: { path: dir, project_id: "rag" } })).status,
    ).toBe(201);
    process.env["AK_TEST_LLM_KEY"] = "sk-test";
    // A keyed provider is a sensitive destination: a widening, applied as the widening route does.
    const providers = {
      providers: [
        { provider_id: "cluster", base_url: llm.url, models: ["echo"] },
        {
          provider_id: "keyed",
          base_url: llm.url,
          models: ["echo"],
          api_key_env: "AK_TEST_LLM_KEY",
        },
      ],
    };
    await first.cl.c.services.backends.operation(
      "rag",
      "llm-research",
      "llm.settings.widen",
      {
        url: `http://localhost${P}/settings/widen`,
        method: "POST",
        params: { id: "rag" },
        body: JSON.stringify(providers),
      },
      { kind: "human", id: "test" },
    );
    for (const template of [
      [
        { role: "system", content: "Be terse." },
        { role: "user", content: "{{question}}" },
      ],
      [
        { role: "system", content: "Be friendly." },
        { role: "user", content: "{{question}}" },
      ],
    ])
      expect((await first.call(`${P}/prompts`, { body: { name: "faq", template } })).status).toBe(
        201,
      );
    expect(
      (await first.call(`${P}/golden-sets`, { body: { name: "g", from_file: "golden.jsonl" } }))
        .status,
    ).toBe(201);
    const t = await first.call("/api/v1/targets/box", {
      method: "PUT",
      body: {
        kind: "ssh",
        ssh: { host: "box", command: [host.ssh], supervisor: "nohup" },
        worker_url: first.cl.c.urls.worker,
      },
    });
    expect([200, 201]).toContain(t.status);
    const body = {
      golden_set: { id: "g" },
      target_id: "box",
      acknowledge_project_code: true,
      targets: [
        { label: "terse", prompt: "faq/1", provider_id: "cluster", model: "echo" },
        { label: "friendly", prompt: "faq/2", provider_id: "cluster", model: "echo" },
      ],
      scorers: [
        { name: "exact", builtin: "exact_match" },
        { name: "polite", project: { path: "evals/scorers.py", function: "polite" } },
        {
          name: "helpful",
          judge: { provider_id: "cluster", model: "echo", rubric: "Does it answer?" },
        },
      ],
    };
    // Refusals before anything is submitted: keys never ride in a bundle; recorded traces and
    // uncommitted scorers stay local.
    const keyed = await first.call(`${P}/evaluations`, {
      body: { ...body, targets: [{ ...body.targets[0], provider_id: "keyed" }] },
    });
    expect([keyed.status, keyed.body.error.code]).toEqual([422, "provider_key_not_remote"]);
    const recorded = await first.call(`${P}/evaluations`, {
      body: { ...body, targets: [{ label: "app", recorded: { run_id: "r1" } }] },
    });
    expect([recorded.status, recorded.body.error.code]).toEqual([422, "recorded_not_remote"]);
    writeFileSync(join(dir, "evals", "scorers.py"), "def polite(**_):\n    return True\n");
    const dirty = await first.call(`${P}/evaluations`, { body });
    expect([dirty.status, dirty.body.error.code]).toEqual([422, "scorer_not_committed"]);
    git(dir, "checkout", "--", "evals/scorers.py");
    expect(llm.state.calls).toBe(0);

    const c = await first.call(`${P}/evaluations`, { body });
    expect(c.status).toBe(201);
    const ev = c.body.evaluation;
    expect(ev).toMatchObject({ environment: "remote", state: "running", enforcement: "advisory" });
    expect(ev.remote).toMatchObject({ target_id: "box" });
    expect(ev.results.map((x: Json) => x.run_id)).toEqual([undefined, undefined]);
    // Remote capture is off: trace bodies and stored outputs are metadata only.
    expect(ev.retention.capture).toBe("metadata_only");
    const jobId = ev.remote.job_id as string;
    const attemptId = ev.remote.attempt_id as string;
    // The job is waiting on the model; the workstation goes off.
    await until(
      async () =>
        (await first.call(`/api/v1/jobs/${jobId}`)).body.latest_attempt.state === "running",
    );
    await first.cl.c.stop();
    h.coordinators.splice(h.coordinators.indexOf(first.cl.c), 1);
    llm.state.open = true;
    await until(
      async () => existsSync(join(remoteDir(host.home, attemptId), "spool", "exit.json")),
      30_000,
    );
    // 3 examples × 2 targets generations, plus one judge call per answer.
    expect(llm.state.calls).toBe(12);
    expect(llm.state.judged).toBe(6);

    const second = await coordinator(home, fakeMl, workerPort);
    const done = await until(async () => {
      const r = (await second.call(`${P}/evaluations/${ev.evaluation_id}`)).body.evaluation;
      return r.state === "succeeded" ? r : undefined;
    }, 60_000);
    const job = (await second.call(`/api/v1/jobs/${jobId}`)).body;
    expect(job.attempts).toHaveLength(1);
    expect(llm.state.calls).toBe(12); // nothing ran twice
    const terse = done.results.find((x: Json) => x.label === "terse");
    const friendly = done.results.find((x: Json) => x.label === "friendly");
    // terse echoes the question: e1's expected response is the question itself.
    expect(Number(terse.metrics["exact/mean"])).toBeCloseTo(1 / 2, 5);
    expect(Number(terse.metrics["polite/mean"])).toBe(0);
    expect(Number(friendly.metrics["polite/mean"])).toBe(1);
    expect(Number(friendly.metrics["helpful/mean"])).toBe(1);
    expect(terse.examples).toBe(3);
    expect(terse.usage).toMatchObject({ reported: 3, missing: 0, total_tokens: 36 });
    expect(terse.judge_usage).toMatchObject({ reported: 3 });
    // Each target is its own finished MLflow run, filled from the job's results.
    const run = fakeMl.run(terse.run_id);
    expect(run?.info.status).toBe("FINISHED");
    expect(run?.tags.get("ablationkit.llm_evaluation")).toBe(ev.evaluation_id);
    expect(run?.metrics.find((m) => m.key === "exact/mean")?.value).toBeCloseTo(0.5, 5);
    // Per-example results work as for a local evaluation; outputs are metadata only.
    const ex = (await second.call(`${P}/evaluations/${ev.evaluation_id}/examples`)).body;
    expect(ex.targets.map((x: Json) => x.unavailable)).toEqual([undefined, undefined]);
    expect(ex.rows.map((x: Json) => x.example_id)).toEqual(["e1", "e2", "e3"]);
    const cell = ex.rows[0].cells.terse;
    expect(cell.output).toEqual({ omitted: "metadata_only", bytes: 8 });
    expect(cell.scores.exact.value).toBe(true);
    expect(ex.slices.friendly.account).toEqual({ n: 1, failed: 0 });
    // The job's own run carries the raw results and is linked to the evaluation.
    const jobRun = fakeMl.run(job.latest_attempt.tracking.mlflow_run_id);
    expect(jobRun?.artifacts.has("eval/genai-results.json")).toBe(true);
    expect(jobRun?.tags.get("ablationkit.llm_evaluation")).toBe(ev.evaluation_id);
  }, 150_000);
});
