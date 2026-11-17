/**
 * `ablationkit executive` (ADR 0064): the MCP server for an agent on the researcher's machine
 * acting as their executive. It oversees the research the project's agents do and runs those
 * agents, but does not do the research itself.
 *
 * - `executive_overview`: every project at a glance (its bottom line, compute, open tasks), the
 *   live agent sessions and agent containers, and what the container runtime lacks.
 * - `executive_read`: every read the agents have (vault, notes, runs, jobs, tasks, records,
 *   library, models, LLM research, …), in any project.
 * - `executive_agents`: agent sessions and agent containers. Start a contained agent with a first
 *   prompt, read its screen, type into it, wait for it to finish, read its egress, pause, resume,
 *   stop; read a session's account; end a session; allow an egress host.
 * - `executive_direct`: the researcher's directions to the agents, written by the executive on
 *   their behalf (marked so), closed, reopened or withdrawn.
 *
 * It starts an executive session through the login socket: a human-API session the coordinator
 * restricts to reads and an executive's writes. A job, note, record, task, run description,
 * policy or configuration change is refused (`executive_forbidden`): the agents do the research,
 * and policy and configuration are the researcher's. The token stays in this process's memory and
 * ends when the harness closes the server.
 */
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { runtimePaths } from "@ablationkit/server";
import { checked, refusal, send, socketRequest } from "../client.ts";
import { type CliContext, flag, parseArgs, projectFromCwd, UsageError } from "../context.ts";
import { findBinary } from "./agent.ts";
import {
  type AgentApi,
  agentApi,
  brief,
  checkArgs,
  failure,
  harnessName,
  isRead,
  type Json,
  type McpIo,
  OPERATIONS,
  result,
  serveStdio,
  signature,
} from "./mcp.ts";

const PROTOCOL = "2025-06-18";
const enc = encodeURIComponent;

/** The agents' reads an executive has, all but the session's own account (it has every one's). */
const READS = OPERATIONS.filter((o) => isRead(o) && o.id !== "session.account");
const READ_OPS = new Map(READS.map((o) => [o.id, o]));

interface Started {
  readonly token: string;
  readonly token_id: string;
  readonly human_api: string;
}

/** One executive session: minted through the login socket on first need, ended once. */
export class ExecutiveSession {
  private started: Promise<Started> | undefined;
  private ended = false;
  harness: string;

  constructor(
    private readonly o: {
      readonly home: string;
      readonly cwd: string;
      readonly label?: string;
      readonly harness?: string;
      readonly env?: Readonly<Record<string, string | undefined>>;
    },
  ) {
    this.harness = harnessName(o.harness);
  }

  get cwd(): string {
    return this.o.cwd;
  }

  get env(): Readonly<Record<string, string | undefined>> {
    return this.o.env ?? process.env;
  }

  start(): Promise<Started> {
    if (this.ended) return Promise.reject(new UsageError("this executive session has ended"));
    this.started ??= (async () => {
      const r = await socketRequest(runtimePaths(this.o.home).loginSocket, "/executive-sessions", {
        harness: this.harness,
        label: this.o.label ?? `${this.harness} executive in ${basename(this.o.cwd) || this.o.cwd}`,
        cwd: this.o.cwd,
      });
      const body = (await r.json()) as Json;
      if (!r.ok) throw refusal(r.status, body);
      return body as unknown as Started;
    })();
    this.started.catch(() => {
      this.started = undefined;
    });
    return this.started;
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const s = await this.started?.catch(() => undefined);
    if (!s) return;
    try {
      await fetch("http://localhost/executive-sessions/end", {
        unix: runtimePaths(this.o.home).loginSocket,
        method: "POST",
        headers: { authorization: `Bearer ${s.token}` },
      } as RequestInit);
    } catch {
      // The coordinator is gone: the session ends when it expires.
    }
  }

  /** A human-API call with this session's token. */
  async call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const s = await this.start();
    const r = await send(
      s.human_api,
      method,
      path,
      s.token,
      body,
      `the coordinator at ${s.human_api}`,
    );
    return (await (await checked(r)).json()) as T;
  }

  /** The agents' read operations, for one project, over the human API. */
  async api(project: string): Promise<AgentApi> {
    const s = await this.start();
    return agentApi(s.human_api, s.token, project);
  }
}

interface Project {
  project_id: string;
  name: string;
  path: string;
}

/** The project a call names, else the checkout's, else the only one registered. */
async function projectOf(x: ExecutiveSession, a: Json): Promise<Project> {
  const { projects } = await x.call<{ projects: Project[] }>("GET", "/api/v1/projects");
  const want = typeof a["project"] === "string" ? a["project"] : projectFromCwd(x.cwd);
  if (want) {
    const p = projects.find((q) => q.project_id === want);
    if (!p)
      throw new UsageError(
        `no project ${want}; registered: ${projects.map((q) => q.project_id).join(", ") || "none"}`,
      );
    return p;
  }
  if (projects.length === 1) return projects[0] as Project;
  throw new UsageError(
    `name the project (\`project\`): ${projects.map((q) => q.project_id).join(", ") || "none registered"}`,
  );
}

function gitConfig(cwd: string, key: string): string | undefined {
  const r = spawnSync("git", ["config", "--get", key], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

const str = (description: string) => ({ type: "string", description });
const strs = (description: string) => ({ type: "array", items: { type: "string" }, description });
const int = (description: string, minimum: number, maximum: number) => ({
  type: "integer",
  minimum,
  maximum,
  description,
});
const need = (a: Json, k: string): string => {
  const v = a[k];
  if (typeof v !== "string" || !v) throw new UsageError(`\`${k}\` is required`);
  return v;
};

/** The last lines of a screen: enough to see where an agent is, without the whole scrollback. */
function lastLines(text: string, n = 60): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

type Run = (x: ExecutiveSession, a: Json, io: McpIo) => Promise<unknown>;

interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Json;
  readonly annotations: Json;
  readonly run: Run;
}

// ------------------------------------------------------------------ the overview

const overview: Run = async (x) => {
  const [{ projects }, sessions, containers] = await Promise.all([
    x.call<{ projects: Project[] }>("GET", "/api/v1/projects"),
    x.call<{ sessions: Json[] }>("GET", "/api/v1/agent-sessions"),
    x.call<{ sessions: Json[]; runtime: Json }>("GET", "/api/v1/agent-containers"),
  ]);
  const per = await Promise.all(
    projects.map(async (p) => {
      const base = `/api/v1/projects/${enc(p.project_id)}`;
      const [vault, compute, tasks] = await Promise.all([
        x.call<Json>("GET", `${base}/vault?brief=1`).catch(() => undefined),
        x.call<Json>("GET", `${base}/compute`).catch(() => undefined),
        x.call<{ tasks: { status: string }[] }>("GET", `${base}/tasks`).catch(() => undefined),
      ]);
      const ledger = vault?.["ledger"] as Json | undefined;
      return {
        project_id: p.project_id,
        name: p.name,
        bottom_line: ledger?.["bottom_line"],
        notes: (vault?.["counts"] as Json | undefined) ?? undefined,
        compute: compute
          ? {
              limit_hours: compute["limit_hours"],
              used_hours: compute["used_hours"],
              available_hours: compute["available_hours"],
              live_jobs: compute["live"],
            }
          : undefined,
        open_tasks: tasks?.tasks.filter((t) => t.status === "open").length,
      };
    }),
  );
  return {
    projects: per,
    agent_sessions_live: sessions.sessions.filter((s) => s["live"] === true),
    agent_containers_live: containers.sessions.filter((s) =>
      ["starting", "running", "paused"].includes(String(s["state"])),
    ),
    container_runtime_problems: (containers.runtime["problems"] as string[] | undefined) ?? [],
  };
};

// ------------------------------------------------------------------ reads

const read: Run = async (x, a) => {
  const id = need(a, "op");
  if (id === "help") {
    const about = a["about"];
    if (typeof about === "string" && about) {
      const o = READ_OPS.get(about);
      if (!o) throw new UsageError(`no read ${about}: executive_read {op: "help"} lists them`);
      return { op: o.id, description: o.description, arguments: o.inputSchema };
    }
    return {
      reads: READS.map((o) => `${signature(o)}: ${brief(o.description)}`),
      note: 'Every read takes `project` (default: the checkout\'s, or the only one). Details of one: {op: "help", about: OP}.',
    };
  }
  const o = READ_OPS.get(id);
  if (!o)
    throw new UsageError(
      id === "session.account"
        ? 'a session\'s account is executive_agents {action: "account", token_id}'
        : `no read ${id}: executive_read {op: "help"} lists them (the executive reads; it does not write the research)`,
    );
  const { op: _o, project: _p, ...rest } = a;
  const p = await projectOf(x, a);
  return o.run(await x.api(p.project_id), checkArgs(o, rest, `executive_read ${id}`));
};

// ------------------------------------------------------------------ agents

const LIVE = new Set(["starting", "running", "paused"]);

async function waitFor(x: ExecutiveSession, sid: string, a: Json, io: McpIo): Promise<Json> {
  const timeoutSec = Math.min(Math.max(Number(a["timeout_sec"] ?? 300) || 300, 5), 1800);
  const quietSec = Math.min(Math.max(Number(a["quiet_sec"] ?? 10) || 10, 2), 600);
  const text = typeof a["until_text"] === "string" ? a["until_text"] : undefined;
  const started = Date.now();
  let last = "";
  let changed = Date.now();
  for (;;) {
    const s = await x.call<{ state: string; text: string }>(
      "GET",
      `/api/v1/agent-containers/${enc(sid)}/screen`,
    );
    const now = Date.now();
    const done = (reason: string) => ({
      reason,
      state: s.state,
      waited_sec: Math.round((now - started) / 1000),
      screen: lastLines(s.text),
    });
    if (!LIVE.has(s.state)) return done("ended");
    if (text && s.text.includes(text)) return done("text");
    if (s.text !== last) {
      last = s.text;
      changed = now;
    } else if (now - changed >= quietSec * 1000) return done("quiet");
    if (now - started >= timeoutSec * 1000) return done("timeout");
    if (io.signal?.aborted) return done("cancelled");
    await Bun.sleep(2_000);
  }
}

const AGENT_ACTIONS = [
  "list",
  "show",
  "account",
  "start",
  "screen",
  "send",
  "wait",
  "egress",
  "pause",
  "resume",
  "stop",
  "end_session",
  "allow_hosts",
] as const;

const agents: Run = async (x, a, io) => {
  const action = need(a, "action");
  const sid = () => need(a, "session_id");
  const reason = typeof a["reason"] === "string" ? { reason: a["reason"] } : {};
  switch (action) {
    case "list": {
      const q = typeof a["project"] === "string" ? `?project=${enc(a["project"])}` : "";
      const [sessions, containers] = await Promise.all([
        x.call<Json>("GET", `/api/v1/agent-sessions${q}`),
        x.call<Json>("GET", `/api/v1/agent-containers${q}`),
      ]);
      return { agent_sessions: sessions["sessions"], agent_containers: containers["sessions"] };
    }
    case "show":
      return x.call("GET", `/api/v1/agent-containers/${enc(sid())}`);
    case "account":
      return x.call("GET", `/api/v1/agent-sessions/${enc(need(a, "token_id"))}/account`);
    case "start": {
      const p = await projectOf(x, a);
      const harness = typeof a["harness"] === "string" ? a["harness"] : "claude-code";
      if (!["claude-code", "codex", "shell"].includes(harness))
        throw new UsageError("`harness` is claude-code, codex or shell");
      const bin = harness === "claude-code" ? "claude" : harness === "codex" ? "codex" : undefined;
      const harnessBin = bin ? findBinary(bin, x.env["PATH"]) : undefined;
      if (bin && !harnessBin) throw new UsageError(`${bin} was not found on PATH as a binary`);
      const uv = findBinary("uv", x.env["PATH"]);
      const prompt = typeof a["prompt"] === "string" && a["prompt"] ? [a["prompt"]] : [];
      if (prompt.length && harness === "shell")
        throw new UsageError("a shell takes no prompt: start it, then send it commands");
      const name = gitConfig(p.path, "user.name");
      const email = gitConfig(p.path, "user.email");
      return x.call("POST", `/api/v1/projects/${enc(p.project_id)}/agent-containers`, {
        harness,
        args: [...((a["args"] as string[] | undefined) ?? []), ...prompt],
        ...(typeof a["label"] === "string" ? { label: a["label"] } : {}),
        binaries: { ...(harnessBin ? { harness: harnessBin } : {}), ...(uv ? { uv } : {}) },
        git: { ...(name ? { name } : {}), ...(email ? { email } : {}) },
        login: { copy: a["login"] !== false },
        ...(a["remote_control"] === false ? { remote_control: false } : {}),
      });
    }
    case "screen": {
      const s = await x.call<{ state: string; text: string }>(
        "GET",
        `/api/v1/agent-containers/${enc(sid())}/screen`,
      );
      return { state: s.state, screen: lastLines(s.text, 120) };
    }
    case "send":
      return x.call("POST", `/api/v1/agent-containers/${enc(sid())}/input`, {
        ...(typeof a["text"] === "string" ? { text: a["text"] } : {}),
        keys: (a["keys"] as string[] | undefined) ?? [],
        enter: a["enter"] !== false,
      });
    case "wait":
      return waitFor(x, sid(), a, io);
    case "egress":
      return x.call(
        "GET",
        `/api/v1/agent-containers/${enc(sid())}/egress${a["denied"] === true ? "?outcome=denied" : ""}`,
      );
    case "pause":
    case "resume":
    case "stop":
      return x.call("POST", `/api/v1/agent-containers/${enc(sid())}/${action}`, reason);
    case "end_session":
      return x.call(
        "POST",
        `/api/v1/agent-sessions/${enc(need(a, "token_id"))}/end`,
        reason.reason ? reason : { reason: "ended by the executive" },
      );
    case "allow_hosts": {
      const p = await projectOf(x, a);
      return x.call("POST", `/api/v1/projects/${enc(p.project_id)}/agent-containers/allow`, {
        hosts: (a["hosts"] as string[] | undefined) ?? [],
        ...(a["environment"] === true ? { list: "environment" } : {}),
      });
    }
    default:
      throw new UsageError(`\`action\` is one of ${AGENT_ACTIONS.join(", ")}`);
  }
};

// ------------------------------------------------------------------ directions

const direct: Run = async (x, a) => {
  const action = need(a, "action");
  const p = await projectOf(x, a);
  const base = `/api/v1/projects/${enc(p.project_id)}/directions`;
  switch (action) {
    case "list":
      return x.call("GET", base);
    case "write":
      return x.call("POST", base, {
        kind: need(a, "kind"),
        text: need(a, "text"),
        target: a["target"] ?? { kind: "project" },
      });
    case "close":
    case "reopen":
    case "withdraw":
      return x.call("POST", `${base}/${enc(need(a, "direction_id"))}/${action}`, {
        ...(typeof a["text"] === "string" ? { text: a["text"] } : {}),
      });
    default:
      throw new UsageError("`action` is list, write, close, reopen or withdraw");
  }
};

// ------------------------------------------------------------------ the tools

export const EXECUTIVE_TOOLS: readonly Tool[] = [
  {
    name: "executive_overview",
    title: "Where everything stands",
    description:
      "Every project at a glance (its bottom line, notes, compute used and left, open tasks), the agent sessions and agent containers live now, and what the container runtime lacks. Start here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: overview,
  },
  {
    name: "executive_read",
    title: "Read the research",
    description:
      'Every read the agents have, in any project: the vault (vault.show, note.show, vault.check), runs (run.search, run.show, run.metrics), jobs and their logs, tasks, research records, the library, models, evaluations, LLM research, extensions. `op` names it; {op: "help"} lists them all with their arguments. `project` defaults to the checkout\'s, or the only one. Reading marks nothing as read for the researcher.',
    inputSchema: {
      type: "object",
      properties: {
        op: str('The read, e.g. "vault.show", "note.show", "run.metrics", or "help".'),
        project: str("The project (default: the checkout's, or the only one registered)."),
        about: str('With op "help": the read to describe.'),
      },
      required: ["op"],
      additionalProperties: true,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: read,
  },
  {
    name: "executive_agents",
    title: "Run the agents",
    description:
      "The agents doing the research. list: agent sessions and agent containers (`project` to narrow). show: one container session. account: what a session did, against the coordinator's record (`token_id`). start: a contained agent in `project` (`harness` claude-code (default), codex or shell; `prompt`: its first task; `label`; `args`; `login: false` to not copy your Claude Code login; Claude Code starts in bypass permissions mode with Remote Control on, `remote_control: false` for off). screen: what its terminal shows. send: type into it (`text`, submitted with Enter unless `enter: false`; `keys`: tmux key names such as Escape, Enter, C-c). wait: until its screen goes quiet (`quiet_sec`, default 10), shows `until_text`, it ends, or `timeout_sec` (default 300, at most 1800). egress: its connections (`denied: true` for refusals). pause, resume, stop (`reason`). end_session: revoke a session's token (`token_id`). allow_hosts: add `hosts` to `project`'s egress allowlist, or with `environment: true` to what its environment builds may reach (package indexes; agents install nothing themselves). Every input you type is recorded.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...AGENT_ACTIONS] },
        project: str("The project (start, list, allow_hosts)."),
        session_id: str("An agent container session (c-…)."),
        token_id: str("An agent session's token ID (account, end_session)."),
        harness: { type: "string", enum: ["claude-code", "codex", "shell"] },
        prompt: str("start: the agent's first task."),
        label: str("start: a name for the session."),
        args: strs("start: more arguments for the harness."),
        login: { type: "boolean", description: "start: false to not copy your Claude Code login." },
        remote_control: {
          type: "boolean",
          description: "start: false to start Claude Code without Remote Control.",
        },
        text: str("send: what to type."),
        keys: strs("send: keys after the text, by tmux name."),
        enter: { type: "boolean", description: "send: false to leave the text unsubmitted." },
        quiet_sec: int("wait: seconds without change that count as done.", 2, 600),
        until_text: str("wait: return when the screen shows this."),
        timeout_sec: int("wait: give up after this long.", 5, 1800),
        denied: { type: "boolean", description: "egress: refused connections only." },
        hosts: strs("allow_hosts: host patterns (example.com, *.example.com, example.com:8443)."),
        environment: {
          type: "boolean",
          description: "allow_hosts: add them to the environment builds' allowlist instead.",
        },
        reason: str("pause, stop, end_session: why."),
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: agents,
  },
  {
    name: "executive_direct",
    title: "Direct the agents",
    description:
      "The researcher's directions to a project's agents (ADR 0057), written by you on their behalf: each is marked as the executive's, delivered at the agents' next tool call and answered on the record. list. write: `kind` (ask, doubt, do, focus, park or rule), `text`, `target` ({kind: note|run|study|task|bottom_line|project, id?}; default the project). close, reopen, withdraw: `direction_id` (`text` optional).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "write", "close", "reopen", "withdraw"] },
        project: str("The project (default: the checkout's, or the only one)."),
        kind: { type: "string", enum: ["ask", "doubt", "do", "focus", "park", "rule"] },
        text: str("write: the direction; close/reopen/withdraw: an optional note."),
        target: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["note", "run", "study", "task", "bottom_line", "project"],
            },
            id: { type: "string" },
          },
          required: ["kind"],
        },
        direction_id: str("close, reopen, withdraw: the direction."),
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: direct,
  },
];

const INSTRUCTIONS =
  "You are the researcher's executive for AblationKit on this machine. The research itself (jobs, runs, notes, research records, tasks) is done by the project's agents, which run in agent containers and report through their own MCP server; you oversee it and run them. Start with executive_overview. Read anything with executive_read (the vault, runs, jobs, tasks, the library: {op: \"help\"} lists every read). Run the agents with executive_agents: start a contained agent with a first task, read its screen, type into it, wait for it, pause, resume or stop it, read its account and its egress. Steer them on the record with executive_direct: your directions are marked as the executive's, and the agents answer them. You cannot submit jobs, write notes or records, describe runs, complete tasks, or change policy, compute limits or configuration (executive_forbidden): ask an agent, or tell the researcher. Agents never pick where their jobs run: AblationKit queues them and places each on a target of the project's pool (the researcher's) with a free slot, so GPU jobs never share a GPU unless the researcher gave it more slots; you need not keep agents off the GPU for one another. When an agent must stay off the GPU all the same, tell it to hold its GPU jobs and to run its tests and checks as jobs with gpu \"none\", which run beside the GPU job without touching it; never tell it to stop submitting jobs, or to run code, tests or uv sync in its own shell: in an agent container it has no project environment, and nothing it ran there would be recorded. Report to the researcher what you started, typed, directed and stopped.";

export async function handleExecutive(
  msg: { id?: number | string; method?: string; params?: Json },
  x: ExecutiveSession,
  io: McpIo = {},
): Promise<Json | undefined> {
  const reply = (r: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result: r });
  const error = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: { code, message },
  });
  if (msg.id === undefined) return undefined;
  switch (msg.method) {
    case "initialize": {
      const client = (msg.params?.["clientInfo"] as { name?: string } | undefined)?.name;
      if (client && x.harness === "unknown") x.harness = harnessName(client);
      x.start().catch(() => {});
      return reply({
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "ablationkit-executive", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: EXECUTIVE_TOOLS.map(({ run: _r, ...t }) => t),
      });
    case "tools/call": {
      const tool = EXECUTIVE_TOOLS.find((t) => t.name === msg.params?.["name"]);
      if (!tool) return error(-32602, `unknown tool ${String(msg.params?.["name"])}`);
      try {
        return reply(result(await tool.run(x, (msg.params?.["arguments"] as Json) ?? {}, io)));
      } catch (e) {
        return reply(failure(e));
      }
    }
    default:
      return error(-32601, `method not found: ${msg.method}`);
  }
}

const USAGE = `usage: ablationkit executive [--label TEXT] [--harness NAME]

An MCP server over stdio for an agent on this machine acting as your executive (ADR 0064): it
reads every project's research and runs the agents (agent containers, agent sessions, directions),
but cannot submit jobs, write notes or records, or change policy and configuration. Add it to
your harness, e.g.
  claude mcp add ablationkit-executive -- ablationkit executive`;

export async function executiveCommand(argv: readonly string[], ctx: CliContext): Promise<number> {
  const args = parseArgs(argv, ["help"]);
  if (args.flags["help"] === true || args.positional[0] === "help") {
    ctx.out(`${USAGE}\n`);
    return 0;
  }
  if (args.positional.length > 0) throw new UsageError(USAGE);
  const label = flag(args, "label");
  const harness = flag(args, "harness");
  const x = new ExecutiveSession({
    home: ctx.home,
    cwd: process.cwd(),
    env: ctx.env,
    ...(label ? { label } : {}),
    ...(harness ? { harness } : {}),
  });
  const stop = () => {
    void x.end().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("SIGHUP", stop);
  await serveStdio(
    ctx,
    (msg, io) => handleExecutive(msg, x, io),
    () => x.end(),
  );
  return 0;
}
