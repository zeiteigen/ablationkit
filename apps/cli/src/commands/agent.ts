/**
 * `ablationkit agent …` (ADR 0061): the researcher's commands for agent containers. `start` asks
 * the coordinator to run a harness (Claude Code, Codex or a shell) in a rootless Podman container
 * for a registered checkout and attaches this terminal to it; the others attach, list, pause,
 * resume and stop sessions, read a session's terminal and egress, change what a project's
 * containers may reach, and build the image.
 */
import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { CoordinatorClient } from "../client.ts";
import {
  type CliContext,
  flag,
  parseArgs,
  printJson,
  projectFromCwd,
  UsageError,
} from "../context.ts";

const USAGE = `usage:
  ablationkit agent start [--project ID] [--harness claude-code|codex|shell] [--label TEXT]
                          [--harness-binary PATH] [--detach] [-- HARNESS_ARGS...]
  ablationkit agent attach SESSION
  ablationkit agent list [--project ID]
  ablationkit agent show SESSION
  ablationkit agent pause SESSION [--reason TEXT]
  ablationkit agent resume SESSION
  ablationkit agent stop SESSION [--reason TEXT]
  ablationkit agent screen SESSION
  ablationkit agent send SESSION [TEXT...] [--stdin] [--keys K1,K2] [--no-enter]
  ablationkit agent egress SESSION [--denied]
  ablationkit agent allow HOST... [--project ID]
  ablationkit agent config [show | edit | set FILE] [--project ID]
  ablationkit agent image build [--tag IMAGE]
  ablationkit agent doctor
  (most take --json; all but attach and image build take --coordinator URL)

Runs your harness in a rootless Podman container (ADR 0061): no GPU, no network but the project's
egress allowlist, no view of ~/.ablationkit; its local jobs run in job containers with the GPU.
Detach from the terminal with tmux's prefix and d (Ctrl-b d); \`agent attach\` returns to it.
Without a terminal of your own (another agent driving this one): \`agent start --detach\`, give
the first prompt after --, then \`agent screen\` to read it and \`agent send\` to type into it.`;

interface Session {
  session_id: string;
  project_id: string;
  harness: string;
  label: string;
  state: string;
  paused_by?: string;
  image: string;
  checkout: string;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  exit_code?: number;
  error?: string;
  token_id: string;
  attach?: string[];
  boundary: { hidden: string[]; read_only: string[]; egress: string };
}

interface EgressRecord {
  at: string;
  kind: string;
  host: string;
  port: number;
  method?: string;
  path?: string;
  outcome: string;
  reason?: string;
  bytes_down?: number;
}

const HARNESS_ALIASES: Record<string, string> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  shell: "shell",
  sh: "shell",
  bash: "shell",
};

const BINARY: Record<string, string | undefined> = {
  "claude-code": "claude",
  codex: "codex",
  shell: undefined,
};

function isElf(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    const head = Buffer.alloc(4);
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
    return head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF";
  } catch {
    return false;
  }
}

/** Multi-call binaries that pick a tool by the name they are run as (mise's command wrappers). */
export const DISPATCHERS: ReadonlySet<string> = new Set(["mise", "rtx", "busybox", "toybox"]);

/**
 * The real binary for `name` on PATH, symlinks resolved: an ELF executable (a version manager's
 * shell shim is skipped) that is not a multi-call dispatcher such as mise, which would look for
 * the tool again inside the container. One whose own file is called `name` wins; otherwise the
 * first other (Claude Code's installer names its binary after the version).
 */
export function findBinary(name: string, path: string | undefined): string | undefined {
  const found: string[] = [];
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    let real: string;
    try {
      real = realpathSync(join(dir, name));
    } catch {
      continue;
    }
    if (isElf(real) && !DISPATCHERS.has(basename(real))) found.push(real);
  }
  return found.find((r) => basename(r) === name) ?? found[0];
}

function gitConfig(cwd: string, key: string): string | undefined {
  const r = spawnSync("git", ["config", "--get", key], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

/** Attach this terminal to a session's tmux; returns tmux's exit status. */
function attach(ctx: CliContext, argv: readonly string[]): number {
  const env = { ...ctx.env } as Record<string, string>;
  // Inside a tmux of your own: attach anyway (the prefix key reaches the outer one first).
  delete env["TMUX"];
  const r = spawnSync(argv[0] as string, argv.slice(1), { stdio: "inherit", env });
  return r.status ?? 1;
}

function line(s: Session): string {
  const state = s.paused_by ? `${s.state} (${s.paused_by})` : s.state;
  const end = s.exit_code !== undefined ? ` exit ${s.exit_code}` : "";
  return `${s.session_id}  ${state.padEnd(22)} ${s.harness.padEnd(12)} ${s.project_id.padEnd(20)} ${s.label}${end}`;
}

export async function agentCommand(argv: readonly string[], ctx: CliContext): Promise<number> {
  const dash = argv.indexOf("--");
  const [sub, ...rest] = dash >= 0 ? argv.slice(0, dash) : argv;
  const passthrough = dash >= 0 ? argv.slice(dash + 1) : [];
  const args = parseArgs(rest, ["json", "detach", "denied", "help", "stdin", "no-enter"]);
  const asJson = args.flags["json"] === true;
  const coordinator = flag(args, "coordinator");
  if (sub === undefined || sub === "help" || args.flags["help"] === true) {
    ctx.out(`${USAGE}\n`);
    return 0;
  }
  const project = () => {
    const p = flag(args, "project") ?? projectFromCwd(process.cwd());
    if (!p)
      throw new UsageError(
        "no project here: run in a registered checkout (`ablationkit project add PATH`) or give --project ID",
      );
    return p;
  };
  const sessionArg = () => {
    const s = args.positional[0];
    if (!s || !/^c-[a-f0-9]{12}$/.test(s))
      throw new UsageError(`give a session ID (c-…)\n${USAGE}`);
    return s;
  };
  const enc = encodeURIComponent;

  if (sub === "image") {
    if (args.positional[0] !== "build") throw new UsageError(USAGE);
    const tag = flag(args, "tag") ?? "localhost/ablationkit-agent:1";
    const file = resolve(ctx.repoRoot, "packages/agent-containers/image/Containerfile");
    const podman = ctx.env["ABLATIONKIT_PODMAN"] ?? "podman";
    ctx.out(`building ${tag} from ${file}\n`);
    const r = spawnSync(podman, ["build", "--tag", tag, "--file", file, resolve(file, "..")], {
      stdio: "inherit",
    });
    if (r.error) throw new UsageError(`cannot run ${podman}: ${r.error.message} (install Podman)`);
    return r.status ?? 1;
  }

  if (sub === "attach") {
    const client = await CoordinatorClient.connect(ctx, coordinator);
    const s = await client.request<Session>("GET", `/api/v1/agent-containers/${enc(sessionArg())}`);
    if (!s.attach) throw new UsageError(`${s.session_id} has ended (${s.state})`);
    return attach(ctx, s.attach);
  }

  const client = await CoordinatorClient.connect(ctx, coordinator);

  if (sub === "start") {
    const pid = project();
    const harness = HARNESS_ALIASES[flag(args, "harness") ?? "claude-code"];
    if (!harness) throw new UsageError("--harness is claude-code, codex or shell");
    const bin = BINARY[harness];
    const given = flag(args, "harness-binary");
    const harnessBin = given ? resolve(given) : bin ? findBinary(bin, ctx.env["PATH"]) : undefined;
    if (bin && !harnessBin)
      throw new UsageError(`${bin} was not found on PATH as a binary: give --harness-binary PATH`);
    const uv = findBinary("uv", ctx.env["PATH"]);
    const cwd = process.cwd();
    const label = flag(args, "label");
    const name = gitConfig(cwd, "user.name");
    const email = gitConfig(cwd, "user.email");
    const s = await client.request<Session>(
      "POST",
      `/api/v1/projects/${enc(pid)}/agent-containers`,
      {
        harness,
        args: passthrough,
        ...(label ? { label } : {}),
        binaries: { ...(harnessBin ? { harness: harnessBin } : {}), ...(uv ? { uv } : {}) },
        git: { ...(name ? { name } : {}), ...(email ? { email } : {}) },
      },
    );
    if (asJson) {
      printJson(ctx, s);
      return 0;
    }
    ctx.out(`started ${s.session_id}: ${s.harness} in ${s.image} for ${s.project_id}\n`);
    if (s.boundary.hidden.length) ctx.out(`  hidden: ${s.boundary.hidden.join(", ")}\n`);
    if (s.boundary.read_only.length) ctx.out(`  read-only: ${s.boundary.read_only.join(", ")}\n`);
    ctx.out(`  egress: ${s.boundary.egress}; no GPU; jobs run in job containers\n`);
    if (args.flags["detach"] === true || !s.attach) {
      ctx.out(`attach with: ablationkit agent attach ${s.session_id}\n`);
      return 0;
    }
    ctx.out("attaching (detach with Ctrl-b d)…\n");
    attach(ctx, s.attach);
    // Back from the terminal: detached, or the harness ended (give the coordinator a moment).
    let after = s;
    for (let i = 0; i < 6; i++) {
      after = await client.request<Session>("GET", `/api/v1/agent-containers/${enc(s.session_id)}`);
      if (!["starting", "running", "paused"].includes(after.state)) break;
      await Bun.sleep(500);
    }
    if (["starting", "running", "paused"].includes(after.state))
      ctx.out(
        `detached; ${s.session_id} is ${after.state}: \`ablationkit agent attach ${s.session_id}\`\n`,
      );
    else
      ctx.out(
        `${s.session_id} ${after.state}${after.exit_code !== undefined ? ` (exit ${after.exit_code})` : ""}${after.error ? `: ${after.error}` : ""}\n`,
      );
    return 0;
  }

  if (sub === "list") {
    const p = flag(args, "project");
    const r = await client.request<{ sessions: Session[]; runtime: { problems: string[] } }>(
      "GET",
      `/api/v1/agent-containers${p ? `?project=${enc(p)}` : ""}`,
    );
    if (asJson) {
      printJson(ctx, r);
      return 0;
    }
    for (const pr of r.runtime.problems) ctx.out(`! ${pr}\n`);
    if (!r.sessions.length) ctx.out("no agent containers yet\n");
    for (const s of r.sessions) ctx.out(`${line(s)}\n`);
    return 0;
  }

  if (sub === "show") {
    const s = await client.request<Session>("GET", `/api/v1/agent-containers/${enc(sessionArg())}`);
    printJson(ctx, s);
    return 0;
  }

  if (sub === "pause" || sub === "resume" || sub === "stop") {
    const reason = flag(args, "reason");
    const s = await client.request<Session>(
      "POST",
      `/api/v1/agent-containers/${enc(sessionArg())}/${sub}`,
      reason ? { reason } : {},
    );
    if (asJson) printJson(ctx, s);
    else ctx.out(`${line(s)}${sub === "stop" ? "  (stopping)" : ""}\n`);
    return 0;
  }

  if (sub === "screen") {
    const r = await client.request<{ text: string; state: string }>(
      "GET",
      `/api/v1/agent-containers/${enc(sessionArg())}/screen`,
    );
    if (asJson) printJson(ctx, r);
    else ctx.out(`${r.text || `(${r.state}: no terminal)`}\n`);
    return 0;
  }

  if (sub === "send") {
    const sid = sessionArg();
    const words = args.positional.slice(1);
    const text =
      args.flags["stdin"] === true ? (await Bun.stdin.text()).replace(/\n$/, "") : words.join(" ");
    const keys = (flag(args, "keys") ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (!text && !keys.length) throw new UsageError("give the text to type, --stdin or --keys");
    const r = await client.request<{ chars: number; keys: string[] }>(
      "POST",
      `/api/v1/agent-containers/${enc(sid)}/input`,
      { ...(text ? { text } : {}), keys, enter: args.flags["no-enter"] !== true },
    );
    if (asJson) printJson(ctx, r);
    else ctx.out(`sent ${r.chars} characters${r.keys.length ? ` and ${r.keys.join(" ")}` : ""}\n`);
    return 0;
  }

  if (sub === "egress") {
    const q = args.flags["denied"] === true ? "?outcome=denied&limit=500" : "?limit=500";
    const r = await client.request<{
      records: EgressRecord[];
      summary: { connections: number; denied: { host: string; count: number }[] };
    }>("GET", `/api/v1/agent-containers/${enc(sessionArg())}/egress${q}`);
    if (asJson) {
      printJson(ctx, r);
      return 0;
    }
    for (const e of r.records)
      ctx.out(
        `${e.at}  ${e.outcome.padEnd(7)} ${`${e.host}:${e.port}`.padEnd(40)} ${e.method ? `${e.method} ${e.path ?? ""}` : e.kind}${e.reason && e.outcome !== "allowed" ? `  (${e.reason})` : ""}\n`,
      );
    ctx.out(`${r.summary.connections} connections`);
    if (r.summary.denied.length)
      ctx.out(`; refused: ${r.summary.denied.map((d) => `${d.host} ×${d.count}`).join(", ")}`);
    ctx.out("\n");
    return 0;
  }

  if (sub === "allow") {
    if (!args.positional.length) throw new UsageError("give the hosts to allow");
    const c = await client.request<{ revision: number; egress: { allow: string[] } }>(
      "POST",
      `/api/v1/projects/${enc(project())}/agent-containers/allow`,
      { hosts: args.positional },
    );
    if (asJson) printJson(ctx, c);
    else ctx.out(`revision ${c.revision}: ${c.egress.allow.length} hosts allowed\n`);
    return 0;
  }

  if (sub === "config") {
    const pid = project();
    const path = `/api/v1/projects/${enc(pid)}/agent-containers/config`;
    const action = args.positional[0] ?? "show";
    if (action === "show") {
      printJson(ctx, await client.request("GET", path));
      return 0;
    }
    if (action === "set") {
      const file = args.positional[1];
      if (!file) throw new UsageError("agent config set FILE");
      const body = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const c = await client.request<{ revision: number }>("PUT", path, body);
      ctx.out(`revision ${c.revision}\n`);
      return 0;
    }
    if (action === "edit") {
      const cur = await client.request<Record<string, unknown>>("GET", path);
      const dir = mkdtempSync(join(tmpdir(), "ablationkit-agent-config-"));
      const file = join(dir, `${pid}.json`);
      try {
        const text = `${JSON.stringify(cur, null, 2)}\n`;
        writeFileSync(file, text, { mode: 0o600 });
        const editor = ctx.env["VISUAL"] ?? ctx.env["EDITOR"] ?? "vi";
        const r = spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
        if (r.status !== 0) throw new UsageError(`${editor} exited with ${r.status}`);
        const edited = readFileSync(file, "utf8");
        if (edited === text) {
          ctx.out("unchanged\n");
          return 0;
        }
        const c = await client.request<{ revision: number }>("PUT", path, JSON.parse(edited));
        ctx.out(`revision ${c.revision}\n`);
        return 0;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    throw new UsageError(USAGE);
  }

  if (sub === "doctor") {
    const r = await client.request<{
      available: boolean;
      binary?: string;
      version?: string;
      rootless?: boolean;
      gpu_cdi?: string;
      tmux?: string;
      problems: string[];
    }>("GET", "/api/v1/agent-containers/runtime");
    if (asJson) {
      printJson(ctx, r);
      return 0;
    }
    ctx.out(
      `podman   ${r.binary ? `${r.binary} ${r.version ?? ""}${r.rootless ? " (rootless)" : ""}` : "missing"}\n`,
    );
    ctx.out(`tmux     ${r.tmux ?? "missing"}\n`);
    ctx.out(`GPU CDI  ${r.gpu_cdi ?? "none (job containers run without a GPU)"}\n`);
    for (const p of r.problems) ctx.out(`! ${p}\n`);
    return r.problems.length ? 1 : 0;
  }

  throw new UsageError(USAGE);
}
