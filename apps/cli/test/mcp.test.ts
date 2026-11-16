/**
 * `ablationkit mcp` (ADR 0040) against a real coordinator: the agent session it starts through the
 * login socket (labelled, project-bound, never shown to the agent, ended with the server), and the
 * tools agents use instead of the CLI: a task with a job, records and a report, completed through
 * the evidence gate (criterion 38); research records an agent creates and edits (criterion 59) and
 * a conversation link it records (criterion 16); the coordinator's refusals as code and message;
 * and parity with the LLM backend's agent operations.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { manifest as llmManifest } from "@ablationkit/builtin-llm/manifest";
import {
  type AgentApi,
  AgentSession,
  coerceArg,
  handleMcp,
  harnessName,
  MAX_TOOL_TEXT,
  MCP_TOOLS,
  type McpSession,
  OPERATIONS,
  toolFor,
} from "../src/commands/mcp.ts";
import { cli, Harness, ROOT } from "./helpers.ts";

// Under $HOME, not /tmp (Stage 8 trap: sandboxes treat /tmp specially).
const BASE = join(homedir(), ".cache", "ablationkit-tests");
mkdirSync(BASE, { recursive: true });
const h = new Harness(BASE);
afterEach(h.cleanup);
const tmp = () => h.tmp("ak-cli-mcp-");
const ENV = {
  GIT_AUTHOR_NAME: "r",
  GIT_AUTHOR_EMAIL: "r@r",
  GIT_COMMITTER_NAME: "r",
  GIT_COMMITTER_EMAIL: "r@r",
};
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, ...ENV } }).trim();

async function setup() {
  const home = tmp();
  const c = await h.start(home, {}, { jobs: { supervisor: "direct" } });
  const repo = join(tmp(), "lab");
  git(tmp(), "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "train.py"), "print(1)\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  expect((await cli(home, ["project", "add", repo])).code).toBe(0);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "register");
  mkdirSync(join(repo, "src"));
  return { home, c, repo };
}

interface Called {
  text: string;
  isError?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: tool results are JSON
  out: any;
}

function client(session: McpSession) {
  let id = 0;
  const transcript: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Called> => {
    const r = (await handleMcp(
      { id: ++id, method: "tools/call", params: { name, arguments: args } },
      session,
    )) as {
      result: {
        isError?: boolean;
        content: { text: string }[];
        structuredContent: Record<string, unknown>;
      };
    };
    const text = r.result.content[0]?.text ?? "";
    transcript.push(text);
    return {
      text,
      ...(r.result.isError ? { isError: true } : {}),
      out: r.result.structuredContent,
    };
  };
  return { call, transcript };
}

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await Bun.sleep(100);
  }
}

describe("ablationkit mcp (ADR 0040)", () => {
  test("the researcher's agenda (ADR 0058): it leads ablationkit_project; a change is put before the next tool result; work names the item it serves", async () => {
    const { home, c, repo } = await setup();
    const session = new AgentSession({ home, cwd: repo, harness: "claude-code" });
    const { call } = client(session);
    const researcher = { kind: "human" as const, id: "researcher" };
    // Nothing written yet: the project says so and no result carries a notice.
    const before = await call("ablationkit_project");
    expect(before.out.agenda).toMatchObject({ revision: 0 });
    await call("ablationkit_note", {
      action: "add",
      note_id: "wd-matters",
      type: "question",
      standing: "open",
      title: "Does weight decay matter at 64k?",
      gist: "Whether weight decay changes the loss of the 64k model is not known.",
      sources: ["repo:train.py"],
    });
    // The researcher writes the agenda in the web UI (the human listener; here, the service).
    c.services.agenda.put(
      "lab",
      {
        items: [{ note_id: "wd-matters", lane: "now" }],
        rules: [{ text: "Three seeds before anything is established" }],
      },
      researcher,
    );
    // The next tool result, whatever it is, leads with it, as the researcher's instruction.
    const r = (await handleMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "ablationkit_read", arguments: { op: "task.list" } },
      },
      session,
    )) as { result: { content: { text: string }[]; structuredContent: Record<string, unknown> } };
    const [notice, own] = r.result.content;
    expect(notice?.text).toContain("The researcher's agenda for this project (revision 1)");
    expect(notice?.text).toContain("not recorded content");
    expect(notice?.text).toContain("Now: note:wd-matters: Does weight decay matter at 64k?");
    expect(notice?.text).toContain("Rules: R1: Three seeds before anything is established");
    expect(JSON.parse(own?.text ?? "{}")).toMatchObject({ tasks: [] });
    expect(r.result.structuredContent["researcher_changed_agenda"]).toBe(notice?.text);
    // Read once: the next result is the tool's own.
    expect((await call("ablationkit_read", { op: "task.list" })).text).not.toContain("agenda");
    // The project leads with it, Now first, then the rules.
    const p = await call("ablationkit_project");
    expect(Object.keys(p.out)[0]).toBe("agenda");
    expect(p.out.agenda).toMatchObject({
      revision: 1,
      now: ["note:wd-matters: Does weight decay matter at 64k? [question, open]"],
      rules: ["R1: Three seeds before anything is established"],
    });
    expect(p.out.agenda.from).toContain("no agent can change it");
    // The researcher adds a line to Now and a rule; the agent is told in its next call.
    c.services.agenda.put(
      "lab",
      {
        items: [
          { text: "Re-run the baseline with three seeds", lane: "now" },
          { note_id: "wd-matters", lane: "now" },
        ],
        rules: [
          { rule_id: "R1", text: "Three seeds before anything is established" },
          { text: "Keep each job under an hour" },
        ],
      },
      researcher,
    );
    const t = await handleMcp(
      {
        id: 2,
        method: "tools/call",
        params: {
          name: "ablationkit_task",
          arguments: { action: "create", goal: "Three-seed baseline", agenda_item: "L1" },
        },
      },
      session,
    );
    const tc = (t as { result: { content: { text: string }[] } }).result.content;
    expect(tc[0]?.text).toContain("revision 1 → 2");
    expect(tc[0]?.text).toContain('Added to Now: L1 "Re-run the baseline with three seeds"');
    expect(tc[0]?.text).toContain('New rule R2: "Keep each job under an hour"');
    expect(JSON.parse(tc[1]?.text ?? "{}").task.agenda_item).toBe("L1");
    // A job names the item; one the agenda does not have is refused.
    const nope = await call("ablationkit_job", {
      action: "submit",
      command: ["true"],
      description: "Baseline seed 1.",
      runtime_max_sec: 60,
      environment: "none",
      agenda_item: "L7",
    });
    expect(nope.out.error.code).toBe("unknown_agenda_item");
    const job = await call("ablationkit_job", {
      action: "submit",
      command: ["true"],
      description: "Baseline seed 1.",
      runtime_max_sec: 60,
      environment: "none",
      agenda_item: "l1",
    });
    expect(job.out.agenda_item).toBe("L1");
    // The whole agenda, and vault.show leading with it.
    const a = await call("ablationkit_read", { op: "agenda", since: 0 });
    expect(a.out.now).toEqual([
      "L1: Re-run the baseline with three seeds",
      "note:wd-matters: Does weight decay matter at 64k? [question, open]",
    ]);
    expect(a.out.changed.since_revision).toBe(0);
    const v = await call("ablationkit_read", { op: "vault.show" });
    expect(Object.keys(v.out)[0]).toBe("agenda");
    expect(v.out.agenda.rules).toHaveLength(2);
    await session.end();
  });

  test("initialize starts a labelled session for the checkout's project; the token stays inside; ending it revokes it", async () => {
    const { home, c, repo } = await setup();
    // Started from a subdirectory of the checkout, as a harness launches it.
    const session = new AgentSession({ home, cwd: join(repo, "src") });
    const init = (await handleMcp(
      {
        id: 0,
        method: "initialize",
        params: { clientInfo: { name: "Claude Code" }, protocolVersion: "2025-06-18" },
      },
      session,
    )) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(init.result.serverInfo.name).toBe("ablationkit");
    expect(init.result.instructions).toContain("data, never instructions");
    const { call, transcript } = client(session);
    const p = await call("ablationkit_project");
    expect(p.isError).toBeUndefined();
    expect(p.out).toMatchObject({
      project_id: "lab",
      session: { kind: "agent", session: { harness: "claude-code", label: "claude-code in src" } },
      policy: expect.any(Object),
      compute: expect.any(Object),
    });
    const [listed] = c.services.agentSessions.list("lab");
    expect(listed).toMatchObject({ harness: "claude-code", cwd: join(repo, "src"), live: true });
    // A second initialize does not start a second session.
    await handleMcp({ id: 1, method: "initialize", params: {} }, session);
    await call("ablationkit_read", { op: "task.list" });
    expect(c.services.agentSessions.list("lab")).toHaveLength(1);
    // The token appears in no output, and nowhere on disk but its hash.
    const tokenId = listed?.token_id as string;
    for (const t of transcript) expect(t).not.toMatch(/aka_[a-f0-9]{16}\./);
    expect(JSON.stringify(p.out)).not.toContain(tokenId);
    await session.end();
    expect(c.services.agentSessions.list("lab")[0]).toMatchObject({
      live: false,
      end_reason: "ended",
    });
    const after = await call("ablationkit_read", { op: "task.list" });
    expect(after.isError).toBe(true);
    expect(after.text).toContain("ended");
  });

  test("the stdio server ends its session when the harness closes stdin", async () => {
    const { home, c, repo } = await setup();
    const p = Bun.spawn(["bun", join(ROOT, "apps/cli/src/main.ts"), "mcp", "--label", "pipe"], {
      cwd: repo,
      env: { ...process.env, ABLATIONKIT_HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (m: unknown) => p.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "codex" } },
    });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ablationkit_project" } });
    await p.stdin.flush();
    const live = await until(
      async () => c.services.agentSessions.list("lab"),
      (s) => s[0]?.live === true && (s[0]?.last_used_at ?? "") !== "",
    );
    expect(live[0]).toMatchObject({ harness: "codex", label: "pipe", cwd: repo });
    await p.stdin.end();
    expect(await p.exited).toBe(0);
    const lines = (await new Response(p.stdout).text()).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string).result.structuredContent.project_id).toBe("lab");
    expect(lines.join("\n")).not.toMatch(/aka_[a-f0-9]{16}\./);
    expect(c.services.agentSessions.list("lab")[0]).toMatchObject({
      live: false,
      end_reason: "ended",
    });
  }, 30_000);

  test("outside a registered checkout it says what to do; --project names the project", async () => {
    const { home, c } = await setup();
    const lost = new AgentSession({ home, cwd: tmp(), harness: "codex" });
    const r = await client(lost).call("ablationkit_project");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ablationkit project add");
    const named = new AgentSession({ home, cwd: tmp(), project: "lab", harness: "codex" });
    expect((await client(named).call("ablationkit_project")).out.project_id).toBe("lab");
    const unknown = new AgentSession({ home, cwd: tmp(), project: "nope", harness: "codex" });
    expect((await client(unknown).call("ablationkit_project")).text).toContain("nope");
    expect(c.services.agentSessions.list().map((s) => s.harness)).toEqual(["codex"]);
    await named.end();
  });

  test("a task with a job, records and a report, completed through the evidence gate (criterion 38)", async () => {
    const { home, c, repo } = await setup();
    const session = new AgentSession({ home, cwd: repo, harness: "claude-code", label: "alibi" });
    const { call } = client(session);
    const t = (
      await call("ablationkit_task", { action: "create", goal: "Try ALiBi", criteria: ["3 seeds"] })
    ).out.task;
    expect(t).toMatchObject({ status: "open", goal: "Try ALiBi", criteria: ["3 seeds"] });
    // Refusals come back as the coordinator's code and message.
    const why = "Smoke run: checks the job path before the seeds.";
    const noLimit = await call("ablationkit_job", {
      action: "submit",
      command: ["true"],
      description: why,
    });
    expect([noLimit.isError, noLimit.out.error.code]).toEqual([true, "time_limit_required"]);
    // A job says what it tests and why (ADR 0048).
    const noWhy = await call("ablationkit_job", {
      action: "submit",
      command: ["true"],
      runtime_max_sec: 60,
    });
    expect(noWhy.text).toContain(
      "invalid_request: ablationkit_job submit: description is required",
    );
    const tooLong = await call("ablationkit_job", {
      action: "submit",
      command: ["true"],
      description: why,
      runtime_max_sec: 11 * 3600,
    });
    expect(tooLong.out.error).toMatchObject({ code: "compute_limit_reached", status: 403 });
    expect(tooLong.text).toMatch(/^compute_limit_reached: /);
    const remote = await call("ablationkit_job", {
      action: "submit",
      command: ["true"],
      description: why,
      runtime_max_sec: 60,
      target_id: "gpu-box",
    });
    expect(remote.out.error.code).toBe("policy_denied");
    const closed = await call("ablationkit_job", {
      action: "submit",
      command: ["true"],
      description: why,
      runtime_max_sec: 60,
      task_id: "task-nope",
    });
    expect(closed.out.error.code).toBe("task_not_found");
    // A job under the task, its log and its state.
    const job = (
      await call("ablationkit_job", {
        action: "submit",
        command: ["sh", "-c", "for i in 1 2 3; do echo line $i; done"],
        runtime_max_sec: 60,
        environment: "none",
        task_id: t.task_id,
        run_name: "alibi-seed-1",
        description: "ALiBi, seed 1: does the loss match RoPE at the training length?",
        study_id: "alibi",
        variant_id: "alibi-long",
      })
    ).out;
    expect(job.job_id).toMatch(/^j-/);
    expect(job.description).toContain("ALiBi, seed 1");
    const shown = await until(
      () => call("ablationkit_read", { op: "job.show", job_id: job.job_id }),
      (r) => ["succeeded", "failed"].includes(r.out.latest_attempt?.state),
    );
    expect(shown.out.latest_attempt.state).toBe("succeeded");
    const log = await call("ablationkit_read", { op: "job.log", job_id: job.job_id, tail: 2 });
    expect(log.out.lines.map((l: { text: string }) => l.text.trim())).toEqual(["line 2", "line 3"]);
    const paged = await call("ablationkit_read", { op: "job.log", job_id: job.job_id, limit: 1 });
    expect(paged.out.lines).toHaveLength(1);
    expect((await call("ablationkit_read", { op: "job.list", limit: 5 })).out.jobs).toHaveLength(1);
    // Records under the task, a study and a conversation link.
    const noSummary = await call("ablationkit_do", {
      op: "research.add",
      kind: "hypothesis",
      title: "ALiBi extrapolates",
    });
    expect(noSummary.text).toContain("ablationkit_do research.add: summary is required");
    const hyp = (
      await call("ablationkit_do", {
        op: "research.add",
        kind: "hypothesis",
        title: "ALiBi extrapolates",
        summary: "ALiBi keeps its loss beyond the training length, where RoPE degrades.",
        task_id: t.task_id,
      })
    ).out.record;
    // A note carries a summary too.
    const note = await call("ablationkit_do", {
      op: "research.add",
      kind: "note",
      title: "Seed 1 log",
      summary: "The first seed ran clean.",
      body: "Loss $L = 0.41$ at step 3.",
    });
    expect(note.out.record).toMatchObject({ kind: "note", summary: "The first seed ran clean." });
    await call("ablationkit_do", {
      op: "research.update",
      record_id: hyp.record_id,
      add_tags: ["pos-enc"],
    });
    expect(
      (await call("ablationkit_read", { op: "research.show", record_id: hyp.record_id })).out.record
        .tags,
    ).toEqual(["pos-enc"]);
    const study = await call("ablationkit_run", {
      action: "study",
      study_id: "alibi",
      title: "ALiBi against RoPE",
      summary: "Compares ALiBi with RoPE on loss at and beyond the training length.",
      variants: [{ variant_id: "rope" }, { variant_id: "alibi" }],
      baseline_variant: "rope",
      metric_goals: [{ key: "loss", goal: "min" }],
      hypothesis_ids: [hyp.record_id],
      task_id: t.task_id,
    });
    expect(study.out.record).toMatchObject({ kind: "study", baseline_variant: "rope" });
    // The task says where its records have gone stale.
    // Describing a run waits for MLflow to have it (this coordinator runs without one).
    const early = await call("ablationkit_run", {
      action: "describe",
      run: shown.out.latest_attempt.attempt_id,
      summary: "ALiBi, seed 1: three lines printed, no metric logged.",
    });
    expect(early.out.error.code).toBe("tracking_pending");
    const stale = (await call("ablationkit_read", { op: "task.show", task_id: t.task_id })).out
      .checks;
    expect(stale.map((x: { code: string }) => x.code).sort()).toEqual([
      "study_status",
      "undeclared_variants",
    ]);
    // A study's variants and status are the agent's to keep current.
    const grown = await call("ablationkit_run", {
      action: "study",
      study_id: "alibi",
      status: "complete",
      add_variants: [{ variant_id: "alibi-long", title: "ALiBi", description: "At 4x length." }],
    });
    expect(grown.out.record.variants.map((v: { variant_id: string }) => v.variant_id)).toEqual([
      "rope",
      "alibi",
      "alibi-long",
    ]);
    expect(
      (await call("ablationkit_read", { op: "task.show", task_id: t.task_id })).out.checks,
    ).toEqual([]);
    const conv = await call("ablationkit_do", {
      op: "conversation.link",
      source: "claude",
      url: "https://claude.ai/chat/abc",
      notes: "where the idea came from",
    });
    expect(conv.out.record).toMatchObject({ kind: "conversation", source: "claude" });
    // A definite outcome needs a report that cites evidence.
    const bare = (
      await call("ablationkit_do", {
        op: "research.add",
        kind: "report",
        title: "ALiBi: first look",
        summary: "A first look, with nothing measured yet.",
        body: "Nothing to interpret yet.",
        task_id: t.task_id,
      })
    ).out.record;
    const refused = await call("ablationkit_task", {
      action: "complete",
      task_id: t.task_id,
      outcome: "supported",
      summary: "ALiBi extrapolates.",
      report_id: bare.record_id,
    });
    expect(refused.out.error.code).toBe("evidence_required");
    const cited = (
      await call("ablationkit_do", {
        op: "research.add",
        kind: "report",
        title: "ALiBi: one seed",
        summary: "One seed ran; it logged no metric, so nothing is settled.",
        body: "## Result\n\nNo metric.",
        task_id: t.task_id,
        evidence: [{ ref: { kind: "job", id: job.job_id }, role: "candidate", note: "seed 1" }],
      })
    ).out.record;
    expect(cited.evidence[0].captured_at).toBeDefined();
    const done = await call("ablationkit_task", {
      action: "complete",
      task_id: t.task_id,
      outcome: "inconclusive",
      summary: "One seed is not enough to say whether ALiBi extrapolates.",
      report_id: cited.record_id,
    });
    expect(done.out.task).toMatchObject({
      status: "completed",
      outcome: "inconclusive",
      conclusion: "One seed is not enough to say whether ALiBi extrapolates.",
    });
    expect(done.out.checks).toEqual([]);
    // The reading list, as the researcher sees it: nothing reviewed yet.
    const reading = (await call("ablationkit_read", { op: "review.list" })).out;
    expect(reading.threads[0].task).toMatchObject({ id: t.task_id, review: "new", gaps: [] });
    expect(reading.threads[0].items.map((i: { kind: string }) => i.kind)).toEqual([
      "report",
      "report",
      "hypothesis",
      "study",
    ]);
    expect(reading.threads[0].items[0].id).toBe(cited.record_id);
    expect(reading.counts).toMatchObject({ total: 6, reviewed: 0, new: 6 });
    const view = (await call("ablationkit_read", { op: "task.show", task_id: t.task_id })).out;
    expect(view.jobs.map((j: { job_id: string }) => j.job_id)).toEqual([job.job_id]);
    expect(view.records.map((r: { title: string }) => r.title).sort()).toEqual([
      "ALiBi against RoPE",
      "ALiBi extrapolates",
      "ALiBi: first look",
      "ALiBi: one seed",
    ]);
    const linked = await call("ablationkit_read", {
      op: "research.list",
      link: `task:${t.task_id}`,
      limit: 2,
    });
    expect([linked.out.records.length, linked.out.total]).toEqual([2, 4]);
    const lineage = await call("ablationkit_read", { op: "lineage", kind: "task", id: t.task_id });
    expect(lineage.isError).toBeUndefined();
    // Everything is attributed to this session.
    const [s] = c.services.agentSessions.list("lab");
    expect(s).toMatchObject({ label: "alibi", jobs: 1, tasks: 1 });
    expect(s?.records).toBeGreaterThanOrEqual(5);
    // Runs: MLflow is off here, so nothing is listed yet; the tool still answers.
    expect((await call("ablationkit_read", { op: "run.search" })).out).toMatchObject({ runs: [] });
    await session.end();
  }, 60_000);

  test("the vault: notes written through the tools, the outline, and a task completed with a notebook (ADR 0049)", async () => {
    const { home, repo } = await setup();
    const session = new AgentSession({ home, cwd: repo, harness: "claude-code", label: "width" });
    const { call } = client(session);
    const empty = (await call("ablationkit_read", { op: "vault.show" })).out;
    expect(empty).toMatchObject({ bottom_line: null, shelf: [], counts: { notes: 0 } });
    const t = (await call("ablationkit_task", { action: "create", goal: "Does width help?" })).out
      .task;

    // A malformed note is refused with what to do; a well-formed one comes back with its checks.
    const long = await call("ablationkit_note", {
      action: "add",
      note_id: "bits-per-byte",
      type: "concept",
      title: "Bits per byte",
      gist: "x".repeat(181),
    });
    expect(long.text).toContain("at most 180");
    const noStanding = await call("ablationkit_note", {
      action: "add",
      note_id: "width-helps",
      type: "claim",
      title: "Width helps at this scale",
      gist: "Doubling the width lowers validation loss at equal steps.",
    });
    expect(noStanding.isError).toBe(true);
    expect(noStanding.text).toContain("established, leaning, open, ruled_out");
    const concept = await call("ablationkit_note", {
      action: "add",
      note_id: "bits-per-byte",
      type: "concept",
      title: "Bits per byte",
      gist: "Bits per byte is the loss per byte of text, so tokenizers compare.",
      summary: "It divides the summed cross-entropy in bits by the bytes the tokens decode to.",
      aliases: ["BPB"],
      sources: ["repo:train.py"],
      task_id: t.task_id,
    });
    expect(concept.out.note).toMatchObject({ note_id: "bits-per-byte", revision: 1 });
    expect(concept.out.checks.map((c: { code: string }) => c.code)).toEqual(["off_shelf"]);
    await call("ablationkit_note", {
      action: "add",
      note_id: "wide-beats-base",
      type: "finding",
      title: "The wide model reaches a lower loss than the base model",
      gist: "At equal steps the wide model ends 0.04 below the base model, in one seed.",
      summary: "Only the width differs between the two runs. The metric is [[bits-per-byte|BPB]].",
      sources: [`task:${t.task_id}`],
      task_id: t.task_id,
    });
    const claim = await call("ablationkit_note", {
      action: "add",
      note_id: "width-helps",
      type: "claim",
      title: "Width helps at this scale",
      gist: "Doubling the width lowers validation loss at equal steps.",
      summary: "One comparison supports it and nothing contradicts it yet.",
      full: "![[wide-beats-base]]",
      standing: "leaning",
      support: "2 runs · one seed",
      sources: [`task:${t.task_id}`],
      task_id: t.task_id,
    });
    expect(claim.out.checks.map((c: { code: string }) => c.code).sort()).toEqual([
      "claim_without_evidence",
      "off_shelf",
    ]);
    await call("ablationkit_note", {
      action: "add",
      note_id: "does-width-help",
      type: "notebook",
      title: "Does width help?",
      gist: "Width helps in the one comparison run so far.",
      summary: "What was compared and what it showed.",
      full: "The metric first.\n\n![[bits-per-byte]]\n\nThen the comparison.\n\n![[width-helps]]",
      edition: "2026-11-13",
      task_id: t.task_id,
    });
    const index = await call("ablationkit_note", {
      action: "ledger",
      shelf: ["does-width-help"],
      bottom_line: "Width helps in one seed.",
      order: ["width-helps"],
    });
    expect(index.out.index).toMatchObject({ shelf: ["does-width-help"] });

    // The outline: the ledger and the shelf as a tree of IDs and titles, no text.
    const shown = (await call("ablationkit_read", { op: "vault.show" })).out;
    expect(shown.bottom_line).toBe("Width helps in one seed.");
    expect(shown.ledger.leaning).toEqual(["width-helps: Width helps at this scale"]);
    expect(shown.shelf).toEqual([
      "does-width-help [notebook] Does width help?",
      "  bits-per-byte [concept] Bits per byte",
      "  width-helps [claim, leaning] Width helps at this scale",
      "    wide-beats-base [finding] The wide model reaches a lower loss than the base model",
    ]);
    expect(shown.not_on_the_shelf).toEqual([]);
    expect(shown.editions).toEqual(["does-width-help: Does width help?"]);
    expect(
      (await call("ablationkit_read", { op: "vault.show", under: "width-helps" })).out.shelf,
    ).toHaveLength(2);
    const found = (await call("ablationkit_read", { op: "note.list", q: "bpb" })).out;
    // The note whose alias it is comes before the note that only mentions it.
    expect(found.notes.map((n: { note_id: string }) => n.note_id)).toEqual([
      "bits-per-byte",
      "wide-beats-base",
    ]);
    const mine = (
      await call("ablationkit_read", { op: "note.list", task_id: t.task_id, type: "claim" })
    ).out;
    expect(mine.notes.map((n: { note_id: string }) => n.note_id)).toEqual(["width-helps"]);
    const one = (await call("ablationkit_read", { op: "note.show", note_id: "wide-beats-base" }))
      .out;
    expect(one.places.map((p: { note_id: string }[]) => p.map((n) => n.note_id))).toEqual([
      ["does-width-help", "width-helps", "wide-beats-base"],
    ]);
    expect(one.read).toEqual({ state: "new" });

    // A definite outcome needs a note beneath the notebook that cites runs.
    const refused = await call("ablationkit_task", {
      action: "complete",
      task_id: t.task_id,
      outcome: "supported",
      summary: "Width helps.",
      notebook_id: "does-width-help",
    });
    expect(refused.out.error.code).toBe("evidence_required");
    const moved = await call("ablationkit_note", {
      action: "update",
      note_id: "width-helps",
      standing: "open",
      support: "",
      if_revision: 1,
    });
    expect(moved.out.note).toMatchObject({ standing: "open", revision: 2 });
    expect(moved.out.note.support).toBeUndefined();
    const done = await call("ablationkit_task", {
      action: "complete",
      task_id: t.task_id,
      outcome: "inconclusive",
      summary: "One seed is not enough to say.",
      notebook_id: "does-width-help",
    });
    expect(done.out.task).toMatchObject({ status: "completed", notebook_id: "does-width-help" });
    const task = (await call("ablationkit_read", { op: "task.show", task_id: t.task_id })).out;
    expect(task.notes).toHaveLength(4);

    // Prior work: recorded once, found again by a later session, cited with its role, exported.
    const work = await call("ablationkit_work", {
      action: "add",
      work_id: "zagoruyko-2016-wide",
      kind: "paper",
      title: "Wide Residual Networks",
      authors: ["Zagoruyko, Sergey", "Komodakis, Nikos"],
      year: 2016,
      venue: "BMVC 2016",
      arxiv: "1605.07146",
      reading: "skimmed",
      summary: "Widening residual blocks beats deepening them at equal parameters.",
      takeaway: "The width result we test at language-model scale.",
      found_for: "whether width helps: [[width-helps]]",
      task_id: t.task_id,
    });
    expect(work.out.work).toMatchObject({ work_id: "zagoruyko-2016-wide", reading: "skimmed" });
    const again = await call("ablationkit_work", {
      action: "add",
      work_id: "wide-resnets",
      kind: "paper",
      title: "Wide Residual Networks",
      url: "https://arxiv.org/pdf/1605.07146v4.pdf",
      reading: "read",
      takeaway: "x",
    });
    expect(again.out.error.code).toBe("work_exists");
    expect(shown.library).toContain("works of prior work");
    await call("ablationkit_note", {
      action: "update",
      note_id: "width-helps",
      cites: [{ work: "zagoruyko-2016-wide", role: "inspiration", where: "§4" }],
    });
    const lib = (await call("ablationkit_read", { op: "work.list", q: "wide residual" })).out;
    expect(lib.works).toMatchObject([
      { work_id: "zagoruyko-2016-wide", roles: ["inspiration"], cited_by: ["width-helps"] },
    ]);
    expect(
      (await call("ablationkit_read", { op: "work.show", work_id: "zagoruyko-2016-wide" })).out
        .cited_by,
    ).toMatchObject([{ note_id: "width-helps", role: "inspiration", where: "§4" }]);
    const bib = (
      await call("ablationkit_read", { op: "work.citations", notebook_id: "does-width-help" })
    ).out;
    expect(bib.format).toBe("bibtex");
    expect(bib.text).toContain("@inproceedings{zagoruyko-2016-wide,");
    expect(bib.text).toContain("Role: inspiration in “Width helps at this scale” (§4)");
    expect(
      (await call("ablationkit_read", { op: "task.show", task_id: t.task_id })).out.works,
    ).toHaveLength(1);

    // The session's account (ADR 0056): the coordinator's record beside what it wrote, with the
    // claim it moved (from → to), the numbers it typed by hand, and the checks outstanding.
    await call("ablationkit_note", { action: "update", note_id: "width-helps", standing: "open" });
    const account = (await call("ablationkit_read", { op: "session.account" })).out;
    expect(account).toMatchObject({
      label: "width",
      live: true,
      record: { jobs: 0, hit_time_limit: [], weighted_hours: 0 },
      account: {
        runs: { cited: 0, set_aside: 0, unaccounted: 0 },
        notes_revised: [],
        standings: [
          {
            note_id: "width-helps",
            title: "Width helps at this scale",
            from: "leaning",
            to: "open",
          },
        ],
      },
    });
    expect(account.record.tasks).toMatchObject([{ task_id: t.task_id }]);
    expect(account.account.notes_added).toContain("width-helps");
    expect(account.checks.map((c: { code: string }) => c.code)).toContain("unreferenced_number");

    // Archiving says where the note was embedded; the checks then name the hole.
    const gone = (await call("ablationkit_note", { action: "archive", note_id: "wide-beats-base" }))
      .out;
    expect(gone.embedded_in).toEqual(["width-helps"]);
    const checks = (await call("ablationkit_read", { op: "vault.check" })).out;
    expect(checks.checks.map((c: { code: string }) => c.code)).toContain("unresolved_embed");
    await session.end();
  });

  test("a session cancels its own jobs only", async () => {
    const { home, repo } = await setup();
    const a = new AgentSession({ home, cwd: repo, harness: "a" });
    const b = new AgentSession({ home, cwd: repo, harness: "b" });
    const job = (
      await client(a).call("ablationkit_job", {
        action: "submit",
        description: "A long sleep to cancel.",
        command: ["sleep", "30"],
        runtime_max_sec: 60,
        environment: "none",
      })
    ).out;
    const other = await client(b).call("ablationkit_job", { action: "cancel", job_id: job.job_id });
    expect(other.out.error.code).toBe("forbidden_scope");
    expect(
      (await client(a).call("ablationkit_job", { action: "cancel", job_id: job.job_id })).isError,
    ).toBe(undefined);
    await a.end();
    await b.end();
  }, 30_000);

  test("nine tools over every operation; nothing edits policy or approves (ADRs 0054, 0060)", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "ablationkit_project",
      "ablationkit_read",
      "ablationkit_job",
      "ablationkit_wait",
      "ablationkit_run",
      "ablationkit_task",
      "ablationkit_note",
      "ablationkit_work",
      "ablationkit_do",
    ]);
    const ids = OPERATIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((n) => /polic|approv|enable|activate|rollback|token|dispatch/.test(n))).toBe(
      false,
    );
    for (const [id, where] of [
      ["compute", "ablationkit_read compute"],
      ["job.submit", "ablationkit_job submit"],
      ["job.log", "ablationkit_read job.log"],
      ["job.cancel", "ablationkit_job cancel"],
      ["run.search", "ablationkit_read run.search"],
      ["run.describe", "ablationkit_run describe"],
      ["run.metrics", "ablationkit_read run.metrics"],
      ["run.study", "ablationkit_run study"],
      ["research.add", "ablationkit_do research.add"],
      ["report.generate", "ablationkit_do report.generate"],
      ["task.complete", "ablationkit_task complete"],
      ["vault.show", "ablationkit_read vault.show"],
      ["note.add", "ablationkit_note add"],
      ["note.ledger", "ablationkit_note ledger"],
      ["vault.check", "ablationkit_read vault.check"],
      ["work.add", "ablationkit_work add"],
      ["work.citations", "ablationkit_read work.citations"],
      ["review.list", "ablationkit_read review.list"],
      ["deployment.request", "ablationkit_do deployment.request"],
      ["registry.resolve", "ablationkit_read registry.resolve"],
      ["llm.trace.search", "ablationkit_read llm.trace.search"],
      ["llm.prompt.version", "ablationkit_do llm.prompt.version"],
    ])
      expect(toolFor(id as string)).toBe(where as string);
    // Every agent operation of the LLM backend is reachable, by its manifest ID.
    for (const op of llmManifest.operations.filter((o) => o.agent)) expect(ids).toContain(op.id);
    expect(ids).not.toContain("llm.settings.update");
    // Reads are marked read-only, so a harness can allow them at once.
    const hint = (n: string) => MCP_TOOLS.find((t) => t.name === n)?.annotations["readOnlyHint"];
    expect(
      [hint("ablationkit_project"), hint("ablationkit_read"), hint("ablationkit_wait")].concat(
        hint("ablationkit_do"),
      ),
    ).toEqual([true, true, true, false]);
    // Grouped tools are closed objects; every operation's own schema is too.
    for (const t of MCP_TOOLS.filter(
      (t) => !["ablationkit_read", "ablationkit_do"].includes(t.name),
    ))
      expect([t.name, t.inputSchema["additionalProperties"]]).toEqual([t.name, false]);
    for (const o of OPERATIONS)
      expect([o.id, o.inputSchema["additionalProperties"]]).toEqual([o.id, false]);
    // What every tool says fits in a few thousand tokens.
    expect(JSON.stringify(MCP_TOOLS.map(({ run: _r, ...t }) => t)).length).toBeLessThan(50_000);
    expect(harnessName("Claude Code")).toBe("claude-code");
    expect(harnessName("   ")).toBe("unknown");
  });

  test("the researcher's directions (ADR 0057): listed at the start, appended once at the next breakpoint as the researcher's words, answered on the record", async () => {
    const { home, c, repo } = await setup();
    const researcher = { kind: "human" as const, id: "s-1" };
    const rule = c.services.directions.create(
      "lab",
      {
        target: { kind: "project" },
        kind: "rule",
        text: "Three seeds before anything is established.",
      },
      researcher,
    );
    const session = new AgentSession({ home, cwd: repo, harness: "claude-code" });
    let id = 100;
    const raw = async (name: string, args: Record<string, unknown> = {}) =>
      (
        (await handleMcp(
          { id: ++id, method: "tools/call", params: { name, arguments: args } },
          session,
        )) as {
          result: {
            isError?: boolean;
            content: { text: string }[];
            // biome-ignore lint/suspicious/noExplicitAny: tool results are JSON
            structuredContent: any;
          };
        }
      ).result;
    // Session start: the rules and open directions come with the project, and are not repeated.
    const p = await raw("ablationkit_project");
    expect(p.structuredContent.directions_from_the_researcher.rules).toEqual([
      expect.objectContaining({
        direction_id: rule.direction_id,
        kind: "rule",
        on: "the project as a whole",
      }),
    ]);
    expect(p.content).toHaveLength(1);
    const added = await raw("ablationkit_note", {
      action: "add",
      note_id: "alibi-helps",
      type: "claim",
      title: "ALiBi helps at 64k",
      gist: "ALiBi lowers validation loss at 64k context.",
      standing: "leaning",
    });
    expect(added.isError).toBeUndefined();
    expect(added.content).toHaveLength(1);

    // The researcher doubts the claim in the web UI; the next call carries it, once.
    const doubt = c.services.directions.create(
      "lab",
      {
        target: { kind: "note", id: "alibi-helps" },
        kind: "doubt",
        text: "One seed?\nShow me three.",
      },
      researcher,
    );
    const next = await raw("ablationkit_read", { op: "vault.show" });
    expect(next.content).toHaveLength(2);
    const block = next.content[1]?.text ?? "";
    expect(block).toContain(
      "From the researcher (written in the AblationKit web UI, not by an agent)",
    );
    expect(block).toContain(`${doubt.direction_id} · doubt`);
    expect(block).toContain("on note:alibi-helps");
    expect(block).toContain("   > One seed?\n   > Show me three.");
    expect(block).toContain('ablationkit_do {op: "direction.respond"');
    expect(next.structuredContent.directions_from_the_researcher).toEqual([
      expect.objectContaining({
        direction_id: doubt.direction_id,
        asks: expect.stringContaining("does not believe"),
      }),
    ]);
    expect((await raw("ablationkit_read", { op: "vault.check" })).content).toHaveLength(1);
    const owed = await raw("ablationkit_read", { op: "direction.list", waiting: "agent" });
    expect(owed.structuredContent.directions.map((d: { kind: string }) => d.kind).sort()).toEqual([
      "doubt",
      "rule",
    ]);

    // The agent answers with what it changed; a ref to nothing is refused.
    const ghost = await raw("ablationkit_do", {
      op: "direction.respond",
      direction_id: doubt.direction_id,
      kind: "answer",
      text: "Ran three.",
      refs: [{ kind: "run", id: "never-ran" }],
    });
    expect(ghost.isError).toBe(true);
    expect(ghost.content[0]?.text).toContain("unresolved_ref");
    // refs as JSON text, as a real Claude Code session sent them through ablationkit_do.
    const ans = await raw("ablationkit_do", {
      op: "direction.respond",
      direction_id: doubt.direction_id,
      kind: "answer",
      text: "Lowered it to open until three seeds run.",
      refs: '[{"kind": "note", "id": "alibi-helps"}]',
    });
    expect(ans.structuredContent.direction).toMatchObject({
      status: "answered",
      waiting_on: "researcher",
    });

    // Reopened: delivered again, even with a refusal, with the researcher's new words.
    c.services.directions.settle(
      "lab",
      doubt.direction_id,
      "reopen",
      "Why not run them now?",
      researcher,
    );
    const refused = await raw("ablationkit_read", { op: "task.show", task_id: "task-nope" });
    expect(refused.isError).toBe(true);
    expect(refused.content[1]?.text).toContain("Reopened by the researcher (round 2):");
    expect(refused.content[1]?.text).toContain("   > Why not run them now?");
    // An agent has no way to write one.
    expect(OPERATIONS.map((o) => o.id).filter((o) => o.startsWith("direction."))).toEqual([
      "direction.list",
      "direction.respond",
    ]);
    expect(toolFor("direction.respond")).toBe("ablationkit_do direction.respond");
    expect(toolFor("direction.list")).toBe("ablationkit_read direction.list");
    await session.end();
  });

  test("the agenda (ADR 0058) and directions (ADR 0057) on one breakpoint: a change to the agenda leads the tool's result, its own output follows and new directions close it", async () => {
    const { home, c, repo } = await setup();
    const researcher = { kind: "human" as const, id: "s-1" };
    const session = new AgentSession({ home, cwd: repo, harness: "claude-code" });
    let id = 200;
    const raw = async (name: string, args: Record<string, unknown> = {}) =>
      (
        (await handleMcp(
          { id: ++id, method: "tools/call", params: { name, arguments: args } },
          session,
        )) as {
          result: {
            isError?: boolean;
            content: { text: string }[];
            // biome-ignore lint/suspicious/noExplicitAny: tool results are JSON
            structuredContent: any;
          };
        }
      ).result;
    // Session start: the agenda and the directions in force both come with the project.
    const p = await raw("ablationkit_project");
    expect(Object.keys(p.structuredContent).slice(0, 1)).toEqual(["agenda"]);
    expect(p.structuredContent.directions_from_the_researcher).toMatchObject({
      rules: [],
      open: [],
    });
    expect(p.content).toHaveLength(1);

    // While the agent works, the researcher changes the agenda and writes a direction.
    c.services.agenda.put(
      "lab",
      { items: [{ text: "Re-run the baseline with three seeds", lane: "now" }] },
      researcher,
    );
    const ask = c.services.directions.create(
      "lab",
      { target: { kind: "project" }, kind: "ask", text: "Why one seed?" },
      researcher,
    );
    const r = await raw("ablationkit_read", { op: "task.list" });
    expect(r.content).toHaveLength(3);
    const [notice, own, block] = r.content.map((x) => x.text);
    expect(notice).toContain("The researcher's agenda for this project (revision 1)");
    expect(notice).toContain("Re-run the baseline with three seeds");
    expect(JSON.parse(own ?? "{}")).toMatchObject({ tasks: [] });
    expect(block).toContain(
      "From the researcher (written in the AblationKit web UI, not by an agent)",
    );
    expect(block).toContain(`${ask.direction_id} · ask`);
    expect(r.structuredContent.researcher_changed_agenda).toBe(notice);
    expect(r.structuredContent.directions_from_the_researcher).toEqual([
      expect.objectContaining({ direction_id: ask.direction_id }),
    ]);
    expect(r.structuredContent.tasks).toEqual([]);
    // Each is delivered once: the next result is the tool's own.
    expect((await raw("ablationkit_read", { op: "task.list" })).content).toHaveLength(1);
    // A refusal carries both too.
    c.services.agenda.put(
      "lab",
      {
        items: [{ text: "Re-run the baseline with three seeds", lane: "now" }],
        rules: [{ text: "Keep each job under an hour" }],
      },
      researcher,
    );
    c.services.directions.create(
      "lab",
      { target: { kind: "project" }, kind: "do", text: "Log the seed in every run." },
      researcher,
    );
    const refused = await raw("ablationkit_read", { op: "task.show", task_id: "task-nope" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toHaveLength(3);
    expect(refused.content[0]?.text).toContain("revision 1 → 2");
    expect(refused.content[1]?.text).toContain("not_found");
    expect(refused.content[2]?.text).toContain("Log the seed in every run.");
    await session.end();
  });

  test("arguments are checked before anything is sent, and help describes each operation", async () => {
    const sent: string[] = [];
    const api: AgentApi = {
      project: "lab",
      request: async <T>(method: string, path: string) => {
        sent.push(`${method} ${path}`);
        return {} as T;
      },
      text: async () => "",
    };
    const { call } = client({ harness: "test", start: async () => ({}), api: async () => api });
    const typo = await call("ablationkit_read", { op: "run.metrics", run_id: "r1" });
    expect(typo.isError).toBe(true);
    expect(typo.text).toContain("unknown argument run_id");
    expect(typo.text).toContain("run is required");
    expect(typo.text).toContain("(run*, key, max_results, page_token)");
    const type = await call("ablationkit_job", {
      action: "submit",
      command: "python train.py",
      runtime_max_sec: 60,
      description: "d",
    });
    expect(type.text).toContain("command must be a array");
    const wrong = await call("ablationkit_do", { op: "note.add" });
    expect(wrong.text).toContain('note.add is ablationkit_note {action: "add", …}');
    const action = await call("ablationkit_note", { action: "publish" });
    expect(action.text).toContain("action must be one of add, update, archive, ledger");
    expect(sent).toEqual([]);
    const all = await call("ablationkit_read", { op: "help" });
    expect(all.out.read).toContainEqual(expect.stringMatching(/^run\.metrics\(run\*/));
    expect(all.out.do).toContainEqual(expect.stringMatching(/^extension\.build\(extension_id\*\)/));
    const one = await call("ablationkit_read", { op: "help", about: "note.add" });
    expect(one.out).toMatchObject({ op: "note.add", call: 'ablationkit_note {action: "add", …}' });
    expect(one.out.arguments.required).toEqual(["note_id", "type", "title", "gist"]);
    // A valid call goes through to the operation.
    await call("ablationkit_read", { op: "run.metrics", run: "r1", key: "loss" });
    expect(sent).toEqual(["GET /api/v1/projects/lab/runs/r1/metrics?key=loss"]);
  });

  test("a string that plainly is the argument's type is read as that type; anything else is still refused", async () => {
    const sent: { path: string; body?: unknown }[] = [];
    const api: AgentApi = {
      project: "lab",
      request: async <T>(_method: string, path: string, body?: unknown) => {
        sent.push({ path, ...(body === undefined ? {} : { body }) });
        return { notes: [] } as T;
      },
      text: async () => "",
    };
    const { call } = client({ harness: "test", start: async () => ({}), api: async () => api });
    // Integer: a numeric string, through the generic read tool (the live-test failure).
    const page = await call("ablationkit_read", {
      op: "run.search",
      max_results: "50",
      order_by: '["metrics.loss ASC"]',
    });
    expect(page.isError).toBeUndefined();
    expect(sent.at(-1)?.path).toBe(
      "/api/v1/projects/lab/runs?order_by=metrics.loss+ASC&max_results=50",
    );
    // Boolean: "true" is true (note.list sends archived=only only for a real true).
    await call("ablationkit_read", { op: "note.list", archived: "true" });
    expect(sent.at(-1)?.path).toBe("/api/v1/projects/lab/vault/notes?archived=only");
    // Array and object: JSON text of that type, on a grouped tool; the coerced values are sent.
    const job = await call("ablationkit_job", {
      action: "submit",
      command: '["python", "train.py"]',
      env: '{"SEED": "1"}',
      runtime_max_sec: "60",
      description: "d",
    });
    expect(job.isError).toBeUndefined();
    expect(sent.at(-1)?.body).toMatchObject({
      command: ["python", "train.py"],
      env: { SEED: "1" },
      limits: { runtime_max_sec: 60 },
    });
    // Number: a numeric string; anything else stays a string for the type check.
    expect([
      coerceArg("number", "0.5"),
      coerceArg("number", "-1e-3"),
      coerceArg("integer", " 7 "),
    ]).toEqual([0.5, -0.001, 7]);
    expect([
      coerceArg("number", "0x10"),
      coerceArg("number", ""),
      coerceArg("string", "1"),
    ]).toEqual(["0x10", "", "1"]);
    // Strings that are not plainly the type are refused as before, and nothing is sent.
    const before = sent.length;
    const bad = await call("ablationkit_read", {
      op: "run.search",
      max_results: "fifty",
      order_by: "metrics.loss ASC",
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("max_results must be an integer");
    expect(bad.text).toContain("order_by must be a array");
    const half = await call("ablationkit_read", { op: "run.search", max_results: "50.5" });
    expect(half.text).toContain("max_results must be an integer");
    const yes = await call("ablationkit_read", { op: "note.list", archived: "yes" });
    expect(yes.text).toContain("archived must be a boolean");
    const wrongJson = await call("ablationkit_job", {
      action: "submit",
      command: '{"argv": ["python"]}',
      env: '["SEED=1"]',
      runtime_max_sec: 60,
      description: "d",
    });
    expect(wrongJson.text).toContain("command must be a array");
    expect(wrongJson.text).toContain("env must be a object");
    expect(sent.length).toBe(before);
  });

  test("outputs are bounded; failures carry the code and message, never a token", async () => {
    const big: AgentApi = {
      project: "lab",
      request: async <T>() =>
        ({ tasks: Array.from({ length: 5000 }, (_, i) => ({ i, pad: "x".repeat(40) })) }) as T,
      text: async () => "",
    };
    const session = { harness: "test", start: async () => ({}), api: async () => big };
    const r = await client(session).call("ablationkit_read", { op: "task.list" });
    expect(r.text.length).toBeLessThan(MAX_TOOL_TEXT + 200);
    expect(r.text).toContain("ask for a smaller page");
    expect(r.out).toBeUndefined();
    const unknown = await handleMcp(
      { id: 9, method: "tools/call", params: { name: "ablationkit_nope", arguments: {} } },
      session,
    );
    expect(unknown).toMatchObject({ error: { code: -32602 } });
    const missing = await client(session).call("ablationkit_read", { op: "task.show" });
    expect(missing).toMatchObject({ isError: true, out: { error: { code: "invalid_request" } } });
  });
});
