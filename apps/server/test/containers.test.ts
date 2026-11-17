/**
 * Agent containers (ADR 0061), against a fake Podman and a fake tmux: a session's start (its token
 * minted for the container, its run directory, the Podman command line), the agent socket that
 * accepts only the session's token, egress through the session's proxy, job containers and
 * protected evaluations, host code refused, pause, resume and stop from the human API, the compute
 * limit freezing a session, what a session records when it ends, and recovery after a restart.
 * `bun run test:containers` runs the same paths against real rootless Podman.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type {
  ContainerSessionRecord,
  CoordinatorSettings,
  ProjectActionPolicy,
} from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { type Client, Harness } from "./helpers.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
const fakeDirs: string[] = [];
afterEach(async () => {
  // End every fake container still waiting, so no shell outlives the test.
  for (const d of fakeDirs.splice(0))
    for (const f of readdirSync(d))
      if (f.endsWith(".state")) writeFileSync(join(d, f), "stopped\n");
  await Bun.sleep(100);
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
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

/** A fake rootless Podman and tmux whose state lives in `dir`. */
function fakeRuntime(): { dir: string; podman: string; tmux: string } {
  const dir = h.tmp("ak-fake-podman-");
  fakeDirs.push(dir);
  const podman = join(dir, "podman");
  writeFileSync(
    podman,
    `#!/bin/bash
D=${JSON.stringify(dir)}
echo "$*" >> "$D/calls.log"
case "$1" in
  info) echo "6.1.4|true|2"; exit 0;;
  image) [ -e "$D/no-image" ] && { echo "no such image" >&2; exit 125; }; echo "sha256:0123456789abcdef"; exit 0;;
  container) name="\${@: -1}"; [ -f "$D/$name.state" ] && { cat "$D/$name.state"; exit 0; }; exit 125;;
  pause) echo paused > "$D/$2.state"; exit 0;;
  unpause) echo running > "$D/$2.state"; exit 0;;
  stop) name="\${@: -1}"; [ -f "$D/$name.state" ] && echo stopped > "$D/$name.state"; exit 0;;
  rm) exit 0;;
  run)
    shift; name=""; args=("$@"); n=\${#args[@]}; img=-1
    for ((i=0;i<n;i++)); do
      [ "\${args[$i]}" = "--name" ] && name="\${args[$((i+1))]}"
      if [ "\${args[$i]}" = "localhost/ablationkit-agent:1" ]; then img=$i; break; fi
    done
    printf '%s\\n' "$@" > "$D/$name.args"
    echo running > "$D/$name.state"
    # An environment build (ADR 0066): "install" into the copy it writes.
    if printf '%s\\n' "$@" | grep -qx environment-build; then
      for ((i=0;i<n;i++)); do
        v="\${args[$i]}"
        case "$v" in *:/opt/ablationkit/env:rw) echo "home = /usr/bin" > "\${v%%:*}/pyvenv.cfg";; esac
      done
      rm -f "$D/$name.state"; exit "$(cat "$D/build.exit" 2>/dev/null || echo 0)"
    fi
    case "$name" in
      ak-agent-*)
        while [ "$(cat "$D/$name.state")" != stopped ]; do sleep 0.05; done
        rm -f "$D/$name.state"; exit "$(cat "$D/$name.exit" 2>/dev/null || echo 0)";;
      *) "\${args[@]:$((img+1))}"; code=$?; rm -f "$D/$name.state"; exit $code;;
    esac;;
esac
exit 0
`,
  );
  const tmux = join(dir, "tmux");
  writeFileSync(
    tmux,
    `#!/bin/bash
sock=""; [ "$1" = "-S" ] && { sock="$2"; shift 2; }
[ "$1" = "-f" ] && shift 2
cmd="$1"; shift
case "$cmd" in
  new-session)
    while [ "$#" -gt 0 ] && [ "\${1#-}" != "$1" ]; do case "$1" in -d) shift;; *) shift 2;; esac; done
    nohup "$@" >"$sock.out" 2>&1 &
    echo $! > "$sock.pid"; : > "$sock"; exit 0;;
  has-session) [ -f "$sock.pid" ] && kill -0 "$(cat "$sock.pid")" 2>/dev/null; exit $?;;
  capture-pane) echo "fake screen"; exit 0;;
  send-keys) printf '%s\\n' "$*" >> "$sock.keys"; exit 0;;
  attach-session) exit 0;;
esac
exit 1
`,
  );
  chmodSync(podman, 0o755);
  chmodSync(tmux, 0o755);
  return { dir, podman, tmux };
}

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.org", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

async function setup(
  over: { podman?: string; home?: string; repo?: string; userHome?: string } = {},
) {
  const f = fakeRuntime();
  const fake = new FakeMlflow().start();
  fakes.push(fake);
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    settings: SETTINGS,
    ...(over.home ? { home: over.home } : {}),
    containers: {
      podman: over.podman ?? f.podman,
      tmux: f.tmux,
      monitorMs: 50,
      cdiSpecs: [],
      pauseDelayMs: 50,
      resolve: async () => ["127.0.0.1"],
      // Never the real ~/.claude: a user home of the test's own (no login unless one is written).
      userHome: over.userHome ?? h.tmp("ak-user-"),
    },
  });
  return world(cl, f, over.repo);
}

async function world(
  cl: Client,
  f: { dir: string; podman: string; tmux: string },
  existingRepo?: string,
) {
  const session = await cl.session();
  const human = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token: session, ...init }));
  let repo = existingRepo;
  if (!repo) {
    repo = join(h.tmp(), "lab");
    mkdirSync(join(repo, "eval"), { recursive: true });
    mkdirSync(join(repo, "data"), { recursive: true });
    writeFileSync(join(repo, "eval", "labels.csv"), "secret\n");
    writeFileSync(join(repo, "data", "train.csv"), "x\n");
    writeFileSync(join(repo, "train.py"), "print('ok')\n");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "start");
    expect(
      (await human("/api/v1/projects", { body: { path: repo, project_id: "lab" } })).status,
    ).toBe(201);
    const cfg = await human("/api/v1/projects/lab/agent-containers/config", {
      method: "PUT",
      body: {
        hidden: ["eval"],
        read_only: ["data"],
        jobs: { gpu: "none", network: "none" },
        evaluations: [
          {
            name: "heldout",
            description: "Accuracy on the held-out labels",
            command: ["sh", "-c", "echo the-labels; exit 0"],
            environment: "none",
            mounts: ["eval"],
            runtime_max_sec: 60,
          },
        ],
      },
    });
    expect(cfg.status).toBe(200);
  }
  const start = (body: Json = {}) =>
    human<ContainerSessionRecord & { attach?: string[]; error?: Json }>(
      "/api/v1/projects/lab/agent-containers",
      { body: { harness: "claude-code", binaries: { harness: process.execPath }, ...body } },
    );
  const sessionOf = (sid: string) => cl.c.services.containers.get(sid) as ContainerSessionRecord;
  const until = async (what: string, ok: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (ok()) return;
      await Bun.sleep(25);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const mount = (sid: string) => cl.c.services.containers.mountDir(sid);
  const viaSocket = (sid: string, path: string, token: string, init: RequestInit = {}) =>
    fetch(`http://localhost${path}`, {
      ...init,
      unix: join(mount(sid), "agent.sock"),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    } as RequestInit);
  const tokenOf = (sid: string) => readFileSync(join(mount(sid), "token"), "utf8").trim();
  const settled = async (jobId: string) => {
    for (let i = 0; i < 400; i++) {
      const s = cl.c.services.jobs.get(jobId)?.state;
      if (s && s !== "starting" && s !== "running") return s;
      await Bun.sleep(25);
    }
    throw new Error(`${jobId} did not finish`);
  };
  return { cl, f, human, repo, start, sessionOf, until, mount, viaSocket, tokenOf, settled };
}

describe("agent container sessions", () => {
  test("start: a token minted for the container, its run directory and a confined command line", async () => {
    const w = await setup();
    const r = await w.start({ args: ["--model", "opus"], label: "sweep" });
    expect(r.status).toBe(201);
    const s = r.body;
    expect(s.state).toBe("running");
    expect(s.attach?.[0]).toBe(w.f.tmux);
    expect(s.harness_version).toBeString();
    const token = w.cl.c.services.tokens.get(s.token_id);
    expect(token?.agent_session?.container_session).toBe(s.session_id);
    // The run directory: the session's token, the MCP configuration and the CLI wrapper.
    expect(w.tokenOf(s.session_id)).toStartWith("aka_");
    expect(readFileSync(join(w.mount(s.session_id), "mcp.json"), "utf8")).toContain("--contained");
    expect(existsSync(join(w.mount(s.session_id), "bin", "ablationkit"))).toBe(true);
    // The command line Podman got.
    const argsFile = join(w.f.dir, `ak-agent-${s.session_id}.args`);
    await w.until("podman run", () => existsSync(argsFile));
    const args = readFileSync(argsFile, "utf8").trimEnd().split("\n");
    const joined = args.join(" ");
    expect(joined).toContain("--network none");
    expect(joined).toContain("--userns keep-id");
    expect(joined).toContain("--cap-drop all");
    expect(joined).not.toContain("--device");
    expect(joined).toContain(`type=tmpfs,destination=${w.repo}/eval`);
    expect(joined).toContain(`${w.repo}/data:${w.repo}/data:ro`);
    expect(joined).toContain(`${w.mount(s.session_id)}:/run/ablationkit:ro`);
    expect(joined).not.toContain(join(w.cl.c.services.paths.home, "run", "login.sock"));
    // The researcher's arguments (a first prompt among them) before the variadic --mcp-config.
    expect(args.slice(-5)).toEqual([
      "--model",
      "opus",
      "--mcp-config",
      "/run/ablationkit/mcp.json",
      "--strict-mcp-config",
    ]);
    expect(s.boundary).toMatchObject({ gpu: false, network: "none", egress: "allowlist" });
    expect(s.boundary.hidden).toContain(`${w.repo}/eval`);
    // Listed for the researcher, with the runtime's report.
    const list = await w.human<{ sessions: ContainerSessionRecord[] }>(
      "/api/v1/agent-containers?project=lab",
    );
    expect(list.body.sessions.map((x) => x.session_id)).toEqual([s.session_id]);
    const screen = await w.human<{ text: string }>(
      `/api/v1/agent-containers/${s.session_id}/screen`,
    );
    expect(screen.body.text).toBe("fake screen");
  });

  test("the agent socket takes only the session's own token; agents cannot reach the container routes", async () => {
    const w = await setup();
    const s = (await w.start()).body;
    const token = w.tokenOf(s.session_id);
    const who = await w.viaSocket(s.session_id, "/api/v1/whoami", token);
    expect(who.status).toBe(200);
    expect(((await who.json()) as Json)["token_id"]).toBe(s.token_id);
    const other = await w.cl.agentSession("lab");
    expect((await w.viaSocket(s.session_id, "/api/v1/whoami", other.token)).status).toBe(401);
    // No agent route reads or changes container settings or sessions.
    for (const path of [
      "/api/v1/projects/lab/agent-containers/config",
      `/api/v1/agent-containers/${s.session_id}`,
    ])
      expect((await w.cl.agent(path, { token })).status).toBe(404);
  });

  test("the researcher, or their agent on the host, types into the terminal; it is audited", async () => {
    const w = await setup();
    const s = (await w.start()).body;
    const sent = await w.human<{ chars: number; keys: string[] }>(
      `/api/v1/agent-containers/${s.session_id}/input`,
      { body: { text: "run the baseline", keys: ["Escape"] } },
    );
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ chars: 16, keys: ["Escape", "Enter"] });
    const keys = readFileSync(`${s.attach?.[2]}.keys`, "utf8");
    expect(keys).toContain("-t agent -l -- run the baseline");
    expect(keys).toContain("-t agent Escape Enter");
    const bad = await w.human(`/api/v1/agent-containers/${s.session_id}/input`, {
      body: { keys: ["Enter; rm -rf /"] },
    });
    expect(bad.status).toBe(400);
    const audit = readdirSync(join(w.cl.c.services.paths.home, "audit"))
      .map((x) => readFileSync(join(w.cl.c.services.paths.home, "audit", x), "utf8"))
      .join("");
    expect(audit).toContain("agent.container.input");
    expect(audit).toContain("run the baseline");
  });

  test("Claude Code starts with the researcher's login, kept in step both ways, deleted at the end (ADR 0063)", async () => {
    const user = h.tmp("ak-user-");
    const login = (token: string, expiresAt: number, subscriptionType = "max") =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: `sk-ant-oat01-${token}`,
          refreshToken: `sk-ant-ort01-${token}`,
          expiresAt,
          subscriptionType,
        },
      });
    mkdirSync(join(user, ".claude"));
    const host = join(user, ".claude", ".credentials.json");
    writeFileSync(host, login("A", 1000));
    writeFileSync(
      join(user, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "acct-1" }, lastOnboardingVersion: "2.1.322" }),
    );
    const w = await setup({ userHome: user });
    const s = (await w.start()).body;
    expect(s.login).toMatchObject({ source: join(user, ".claude"), synced_back: 0, synced_in: 0 });
    const home = join(w.cl.c.services.containers.projectDir("lab"), "home-claude-code");
    const box = join(home, ".claude", ".credentials.json");
    expect(readFileSync(box, "utf8")).toBe(login("A", 1000));
    const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(cfg).toMatchObject({
      hasCompletedOnboarding: true,
      oauthAccount: { accountUuid: "acct-1" },
      projects: { [w.repo]: { hasTrustDialogAccepted: true } },
    });
    const sid = s.session_id;
    // Renewed in the container: carried back, the replaced one backed up.
    writeFileSync(box, login("B", 2000));
    await w.until(
      "the renewal carried back",
      () => readFileSync(host, "utf8") === login("B", 2000),
    );
    const backups = join(w.cl.c.services.paths.home, "containers", "login-backups");
    expect(readdirSync(backups).map((f) => readFileSync(join(backups, f), "utf8"))).toEqual([
      login("A", 1000),
    ]);
    // Renewed on this machine: carried in.
    writeFileSync(host, login("C", 3000));
    await w.until("the renewal carried in", () => readFileSync(box, "utf8") === login("C", 3000));
    await w.until("the counts", () => w.sessionOf(sid).login?.synced_in === 1);
    expect(w.sessionOf(sid).login).toMatchObject({ synced_back: 1, synced_in: 1 });
    // Signed in to another account inside: nothing more is carried back.
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ ...cfg, oauthAccount: { accountUuid: "acct-2" } }),
    );
    writeFileSync(box, login("D", 4000));
    await w.until("the sync to stop", () => w.sessionOf(sid).login?.stopped !== undefined);
    expect(w.sessionOf(sid).login?.stopped).toContain("another account");
    expect(readFileSync(host, "utf8")).toBe(login("C", 3000));
    // The session ends: the container's copy is gone, this machine's login stays.
    await w.human(`/api/v1/agent-containers/${sid}/stop`, { body: {} });
    await w.until("the session to end", () => w.sessionOf(sid).state === "exited");
    expect(existsSync(box)).toBe(false);
    expect(readFileSync(host, "utf8")).toBe(login("C", 3000));
    // --no-login: nothing copied.
    const own = (await w.start({ login: { copy: false } })).body;
    expect(own.login).toBeUndefined();
    expect(existsSync(box)).toBe(false);
  });

  test("an over-long first prompt is refused before anything starts, and no token is left behind", async () => {
    const w = await setup();
    const r = await w.start({ args: ["x".repeat(5000)] });
    expect(r.status).toBe(400);
    expect((r.body.error as Json)["message"]).toContain("ablationkit agent send");
    const tokens = w.cl.c.services.tokens
      .list()
      .filter((t) => t.agent_session?.container_session && t.revoked_at === undefined);
    expect(tokens).toEqual([]);
    expect(w.cl.c.services.containers.list("lab")).toEqual([]);
  });

  test("a runtime that is missing, or an image that is not built, is a refusal", async () => {
    const w = await setup({ podman: "/nonexistent/podman" });
    const r = await w.start();
    expect(r.status).toBe(409);
    expect((r.body.error as Json)["code"]).toBe("container_runtime_unavailable");
    const v = await setup();
    writeFileSync(join(v.f.dir, "no-image"), "");
    const r2 = await v.start();
    expect(r2.status).toBe(409);
    expect((r2.body.error as Json)["message"]).toContain("ablationkit agent image build");
  });

  test("egress goes through the session's proxy: refused hosts are recorded, the researcher allows them", async () => {
    const w = await setup();
    const s = (await w.start()).body;
    const send = (host: string) =>
      new Promise<string>((resolve) => {
        const c = connect(join(w.mount(s.session_id), "egress.sock"));
        let out = "";
        c.on("data", (d) => {
          out += d.toString();
        });
        c.on("close", () => resolve(out));
        c.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
      });
    await w.until("egress socket", () => existsSync(join(w.mount(s.session_id), "egress.sock")));
    const first = await send("papers.example.org");
    expect(first).toContain("403");
    expect(first).toContain("not on lab's egress allowlist");
    const allow = await w.human<{ revision: number }>(
      "/api/v1/projects/lab/agent-containers/allow",
      {
        body: { hosts: ["papers.example.org"] },
      },
    );
    expect(allow.status).toBe(200);
    // Allowed now, but the name resolves to this machine: still never connected.
    expect(await send("papers.example.org")).toContain("not public");
    // The harness's own model API is allowed without being listed.
    expect(await send("api.anthropic.com")).toContain("not public");
    const eg = await w.human<{ records: { host: string; outcome: string }[]; summary: Json }>(
      `/api/v1/agent-containers/${s.session_id}/egress?outcome=denied`,
    );
    expect(eg.body.records.map((r) => r.host)).toEqual([
      "papers.example.org",
      "papers.example.org",
      "api.anthropic.com",
    ]);
  });

  test("a contained session's jobs run in job containers; a protected evaluation runs the pinned command, its console withheld", async () => {
    const w = await setup();
    const s = (await w.start()).body;
    const token = w.tokenOf(s.session_id);
    const submit = (body: Json) =>
      w.cl.json<Json & { job_id: string; error?: Json }>(
        w.cl.agent("/api/v1/projects/lab/jobs", { token, body }),
      );
    const j = await submit({
      command: ["sh", "-c", "echo from-the-job-container"],
      environment: "none",
      limits: { runtime_max_sec: 60 },
    });
    expect(j.status).toBe(201);
    const job = w.cl.c.services.jobs.get(j.body.job_id);
    expect(job?.container).toEqual({ session_id: s.session_id });
    expect(await w.settled(j.body.job_id)).toBe("succeeded");
    const attempt = w.cl.c.services.jobs.latestAttempt(job as never);
    expect(attempt?.supervisor.container).toMatchObject({
      name: `ak-job-${attempt?.attempt_id}`,
      gpu: "none",
      network: "none",
      mounts: [],
    });
    const jobArgs = readFileSync(join(w.f.dir, `ak-job-${attempt?.attempt_id}.args`), "utf8");
    expect(jobArgs).toContain(`type=tmpfs,destination=${w.repo}/eval`);
    expect(jobArgs).not.toContain(`${w.repo}/eval:${w.repo}/eval:ro`);
    expect(jobArgs).toContain("UV_OFFLINE=1");
    // The evaluation: the researcher's command, the hidden data mounted read-only for it alone.
    const e = await submit({ evaluation: "heldout", command: ["sh", "-c", "cat eval/labels.csv"] });
    expect(e.status).toBe(201);
    const ej = w.cl.c.services.jobs.get(e.body.job_id);
    expect(ej?.command).toEqual(["sh", "-c", "echo the-labels; exit 0"]);
    expect(ej?.container).toEqual({ session_id: s.session_id, evaluation: "heldout" });
    expect(await w.settled(e.body.job_id)).toBe("succeeded");
    const ea = w.cl.c.services.jobs.latestAttempt(ej as never);
    const evalArgs = readFileSync(join(w.f.dir, `ak-job-${ea?.attempt_id}.args`), "utf8");
    expect(evalArgs).toContain(`${w.repo}/eval:${w.repo}/eval:ro`);
    expect(evalArgs).not.toContain(`destination=${w.repo}/eval`);
    const con = await w.cl.json<{ error: Json }>(
      w.cl.agent(`/api/v1/jobs/${e.body.job_id}/attempts/${ea?.attempt_id}/console`, { token }),
    );
    expect(con.status).toBe(403);
    expect(con.body.error["code"]).toBe("protected_evaluation");
    // Outside a container there is nothing to protect: refused.
    const plain = await w.cl.agentSession("lab");
    const outside = await w.cl.json<{ error: Json }>(
      w.cl.agent("/api/v1/projects/lab/jobs", {
        token: plain.token,
        body: { evaluation: "heldout" },
      }),
    );
    expect(outside.status).toBe(400);
    expect(outside.body.error["code"]).toBe("evaluation_needs_container");
  });

  test("an agent container has no environment; environment builds make the one jobs read (ADR 0066)", async () => {
    const w = await setup();
    const svc = w.cl.c.services;
    writeFileSync(join(w.repo, "pyproject.toml"), '[project]\nname = "lab"\nversion = "0"\n');
    writeFileSync(join(w.repo, "uv.lock"), "version = 1\n");
    mkdirSync(join(w.repo, ".venv", "bin"), { recursive: true });
    const s = (await w.start()).body;
    // The agent container: no environment, no uv, the checkout's .venv hidden, stand-ins on PATH.
    const argsFile = join(w.f.dir, `ak-agent-${s.session_id}.args`);
    await w.until("podman run", () => existsSync(argsFile));
    const agentArgs = readFileSync(argsFile, "utf8");
    expect(agentArgs).not.toContain("/opt/ablationkit/env");
    expect(agentArgs).not.toContain("UV_PROJECT_ENVIRONMENT");
    expect(agentArgs).not.toContain("/opt/ablationkit/bin/uv");
    expect(agentArgs).toContain(`type=tmpfs,destination=${w.repo}/.venv`);
    const shim = readFileSync(join(w.mount(s.session_id), "bin", "uv"), "utf8");
    expect(shim).toContain("ablationkit_job environment");
    const pip = Bun.spawnSync([join(w.mount(s.session_id), "bin", "pip"), "install", "torch"], {
      stderr: "pipe",
    });
    expect(pip.exitCode).toBe(127);
    expect(pip.stderr.toString()).toContain('gpu "none"');

    const token = w.tokenOf(s.session_id);
    const submit = (body: Json) =>
      w.cl.json<Json & { job_id: string; error?: Json }>(
        w.cl.agent("/api/v1/projects/lab/jobs", { token, body }),
      );
    const uvJob = { command: ["python", "train.py"], environment: "uv", gpu: "none" };
    const timed = (b: Json) => ({ ...b, limits: { runtime_max_sec: 60 } });
    // No environment yet: a job that needs one is refused, and says how to get one.
    const early = await submit(timed(uvJob));
    expect(early.status).toBe(409);
    expect(early.body.error?.["code"]).toBe("environment_not_built");
    expect(early.body.error?.["message"]).toContain("ablationkit_job environment");

    // The build: uv sync in a job container with the environment allowlist, no GPU.
    const b = await submit({ build_environment: true, args: ["--extra", "cuda"] });
    expect(b.status).toBe(201);
    const bj = svc.jobs.get(b.body.job_id);
    expect(bj).toMatchObject({
      command: ["uv", "sync", "--extra", "cuda"],
      environment: "none",
      gpu: "none",
      limits: { runtime_max_sec: 1200 },
      container: { session_id: s.session_id, build_environment: true },
    });
    expect(await w.settled(b.body.job_id)).toBe("succeeded");
    const ba = svc.jobs.latestAttempt(bj as never);
    const gen = ba?.attempt_id as string;
    expect(ba?.supervisor.container).toMatchObject({
      gpu: "none",
      network: "egress",
      environment: gen,
    });
    const buildArgs = readFileSync(join(w.f.dir, `ak-job-${gen}.args`), "utf8");
    const pdir = svc.containers.projectDir("lab");
    expect(buildArgs).toContain(`${join(pdir, "envs", gen)}:/opt/ablationkit/env:rw`);
    expect(buildArgs).toContain(`${join(pdir, "uv-cache")}:/opt/ablationkit/uv-cache:rw`);
    expect(buildArgs).not.toContain(":/opt/ablationkit/env-base:ro");
    expect(buildArgs).toContain("HTTPS_PROXY=http://127.0.0.1:3128");
    expect(buildArgs).not.toContain("--device");
    const lock = new Bun.CryptoHasher("sha256").update("version = 1\n").digest("hex");
    expect(svc.containers.environment("lab")).toMatchObject({
      generation: gen,
      lock_sha256: lock,
      built_by: { job_id: b.body.job_id, attempt_id: gen },
    });
    const built = (await svc.audit.read(-1, 10_000)).filter(
      (e) => e.action === "agent.container.environment.built",
    );
    expect(built.map((e) => e.target)).toEqual([gen]);

    // The build's allowlist is the environment's, not the agents'.
    expect(svc.containers.environmentDecision("lab", "pypi.org", 443).ok).toBe(true);
    expect(svc.containers.egressDecision("lab", undefined, "pypi.org", 443).ok).toBe(false);

    // A job now reads that environment, without syncing; with gpu none it needs no GPU at all.
    const cfg = svc.containers.config("lab");
    svc.containers.setConfig("lab", { jobs: { ...cfg.jobs, gpu: "all" } }, "test");
    const gpuJob = await submit(timed({ command: ["python", "train.py"], environment: "uv" }));
    expect(gpuJob.status).toBe(409);
    expect(gpuJob.body.error?.["code"]).toBe("container_gpu_unavailable");
    const ok = await submit(timed(uvJob));
    expect(ok.status).toBe(201);
    await w.settled(ok.body.job_id);
    const oa = svc.jobs.latestAttempt(svc.jobs.get(ok.body.job_id) as never);
    expect(oa?.supervisor.container).toMatchObject({
      gpu: "none",
      network: "none",
      environment: gen,
    });
    const jobArgs = readFileSync(join(w.f.dir, `ak-job-${oa?.attempt_id}.args`), "utf8");
    expect(jobArgs).toContain(`${join(pdir, "envs", gen)}:/opt/ablationkit/env:ro`);
    expect(jobArgs).toContain(`${join(pdir, "python")}:/opt/ablationkit/python:ro`);
    expect(jobArgs).not.toContain("uv-cache");
    expect(jobArgs).not.toContain("--device");
    expect(jobArgs).toContain("CUDA_VISIBLE_DEVICES=");
    expect(jobArgs).toContain("--no-sync");

    // uv.lock changed: refused until the environment is built again.
    writeFileSync(join(w.repo, "uv.lock"), "version = 2\n");
    const stale = await submit(timed(uvJob));
    expect(stale.status).toBe(409);
    expect(stale.body.error?.["code"]).toBe("environment_stale");
    // The next build starts from the current one; on success the old copy goes.
    const b2 = await submit({ build_environment: true });
    expect(await w.settled(b2.body.job_id)).toBe("succeeded");
    const gen2 = svc.jobs.latestAttempt(svc.jobs.get(b2.body.job_id) as never)
      ?.attempt_id as string;
    const build2 = readFileSync(join(w.f.dir, `ak-job-${gen2}.args`), "utf8");
    expect(build2).toContain(`${join(pdir, "envs", gen)}:/opt/ablationkit/env-base:ro`);
    expect(svc.containers.environment("lab")?.generation).toBe(gen2);
    expect(readdirSync(join(pdir, "envs"))).toEqual([gen2]);
    expect((await submit(timed(uvJob))).status).toBe(201);
    // A failed build changes nothing and leaves no copy behind.
    writeFileSync(join(w.f.dir, "build.exit"), "1");
    const b3 = await submit({ build_environment: true });
    expect(await w.settled(b3.body.job_id)).toBe("failed");
    expect(svc.containers.environment("lab")?.generation).toBe(gen2);
    expect(readdirSync(join(pdir, "envs"))).toEqual([gen2]);

    // Builds are for contained agents; hosts for them are the researcher's to allow.
    const plain = await w.cl.agentSession("lab");
    const outside = await w.cl.json<{ error: Json }>(
      w.cl.agent("/api/v1/projects/lab/jobs", {
        token: plain.token,
        body: { build_environment: true },
      }),
    );
    expect(outside.status).toBe(400);
    expect(outside.body.error["code"]).toBe("environment_build_needs_container");
    const allowed = await w.human<{
      environment: { allow: string[] };
      egress: { allow: string[] };
    }>("/api/v1/projects/lab/agent-containers/allow", {
      body: { hosts: ["pypi.example.org"], list: "environment" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.environment.allow).toContain("pypi.example.org");
    expect(allowed.body.egress.allow).not.toContain("pypi.example.org");
  });

  test("a configuration and an environment from before ADR 0066 are brought up to date, on record", async () => {
    const w = await setup();
    const svc = w.cl.c.services;
    const pdir = svc.containers.projectDir("lab");
    const path = join(pdir, "config.json");
    const { environment: _e, ...old } = JSON.parse(readFileSync(path, "utf8"));
    old.egress.allow = [
      "pypi.org",
      "files.pythonhosted.org",
      "github.com",
      "my-papers.example.org",
    ];
    writeFileSync(path, JSON.stringify(old));
    const cfg = svc.containers.config("lab");
    expect(cfg.revision).toBe(old.revision + 1);
    expect(cfg.egress.allow).toEqual(["github.com", "my-papers.example.org"]);
    expect(cfg.environment?.allow).toContain("pypi.org");
    expect(JSON.parse(readFileSync(path, "utf8")).environment).toBeDefined();
    const audit = (await svc.audit.read(-1, 10_000))
      .filter((e) => e.action === "agent.container.config.set")
      .at(-1);
    expect(audit?.details?.["moved_to_environment"]).toEqual([
      "pypi.org",
      "files.pythonhosted.org",
    ]);
    // The agents' environment from before: adopted as built from today's uv.lock.
    writeFileSync(join(w.repo, "uv.lock"), "version = 1\n");
    mkdirSync(join(pdir, "env"), { recursive: true });
    writeFileSync(join(pdir, "env", "pyvenv.cfg"), "home = /usr/bin\n");
    expect(svc.containers.environment("lab")).toMatchObject({
      generation: "legacy",
      adopted: true,
    });
    expect(svc.containers.generationDir("lab", "legacy")).toBe(join(pdir, "env"));
  });

  test("host code is refused for contained sessions unless the project allows it", async () => {
    const w = await setup();
    const s = (await w.start()).body;
    const token = w.tokenOf(s.session_id);
    const build = await w.cl.json<{ error: Json }>(
      w.cl.agent("/api/v1/projects/lab/extensions/my-view/build", { token, body: {} }),
    );
    expect(build.status).toBe(403);
    expect(build.body.error["code"]).toBe("contained_host_code");
    await w.human("/api/v1/projects/lab/agent-containers/config", {
      method: "PUT",
      body: { host_code: "allow" },
    });
    const again = await w.cl.agent("/api/v1/projects/lab/extensions/my-view/build", {
      token,
      body: {},
    });
    expect(again.status).not.toBe(403);
  });

  test("pause, resume and stop; the session records what changed and its token ends", async () => {
    const w = await setup();
    const s = (await w.start()).body;
    const sid = s.session_id;
    // The container is up before it is paused (else the fake's start would overwrite the state).
    await w.until("podman run", () => existsSync(join(w.f.dir, `ak-agent-${sid}.args`)));
    const paused = await w.human<ContainerSessionRecord>(`/api/v1/agent-containers/${sid}/pause`, {
      body: { reason: "reading" },
    });
    expect(paused.body).toMatchObject({ state: "paused", paused_by: "researcher" });
    expect(readFileSync(join(w.f.dir, `ak-agent-${sid}.state`), "utf8").trim()).toBe("paused");
    expect((await w.human(`/api/v1/agent-containers/${sid}/pause`, { body: {} })).status).toBe(409);
    const resumed = await w.human<ContainerSessionRecord>(
      `/api/v1/agent-containers/${sid}/resume`,
      {
        body: {},
      },
    );
    expect(resumed.body.state).toBe("running");
    // What the agent did meanwhile, in the bind-mounted checkout.
    writeFileSync(join(w.repo, "notes.md"), "found something\n");
    writeFileSync(join(w.repo, "train.py"), "print('changed')\n");
    git(w.repo, "commit", "-q", "-am", "agent change");
    const stopped = await w.human(`/api/v1/agent-containers/${sid}/stop`, { body: {} });
    expect(stopped.status).toBe(202);
    await w.until("the session to end", () => w.sessionOf(sid).state === "exited");
    const end = w.sessionOf(sid);
    expect(end.exit_code).toBe(0);
    expect(end.files_changed).toEqual([
      { path: "notes.md", status: "??" },
      { path: "train.py", status: "M" },
    ]);
    expect(end.control.map((c) => c.action)).toEqual(["pause", "resume", "stop"]);
    expect(w.cl.c.services.tokens.get(s.token_id)?.revoked_at).toBeString();
    expect(existsSync(w.mount(sid))).toBe(false);
    // The session's account carries the container's record.
    const acc = await w.human<{ container: Json }>(`/api/v1/agent-sessions/${s.token_id}/account`);
    expect(acc.body.container).toMatchObject({ session_id: sid, state: "exited", paused: 1 });
    const actions = readdirSync(join(w.cl.c.services.paths.home, "audit"))
      .map((x) => readFileSync(join(w.cl.c.services.paths.home, "audit", x), "utf8"))
      .join("");
    for (const a of [
      "agent.container.start",
      "agent.container.pause",
      "agent.container.stop",
      "agent.container.end",
    ])
      expect(actions).toContain(a);
  });

  test("ending a contained session's token in Settings stops its container", async () => {
    const w = await setup();
    const s = (await w.start()).body;
    const r = await w.human(`/api/v1/agent-sessions/${s.token_id}/end`, {
      body: { reason: "enough" },
    });
    expect(r.status).toBe(200);
    await w.until("the session to end", () => w.sessionOf(s.session_id).state === "exited");
    expect(w.sessionOf(s.session_id).control.at(-1)).toMatchObject({
      action: "stop",
      reason: "enough",
    });
  });

  test("the compute limit refusing a contained session's job freezes the session", async () => {
    const w = await setup();
    const s = (await w.start()).body;
    const token = w.tokenOf(s.session_id);
    const cur = (await w.human<{ policy: ProjectActionPolicy }>("/api/v1/projects/lab/policy")).body
      .policy;
    const {
      schema_version: _s,
      project_id: _p,
      revision: _r,
      created_at: _c,
      created_by: _b,
      ...rest
    } = cur;
    await w.human("/api/v1/projects/lab/policy/revisions", {
      body: { policy: { ...rest, compute: { ...rest.compute, limit_hours: 1 } } },
    });
    const r = await w.cl.json<{ error: Json }>(
      w.cl.agent("/api/v1/projects/lab/jobs", {
        token,
        body: { command: ["true"], environment: "none", limits: { runtime_max_sec: 7200 } },
      }),
    );
    expect(r.body.error["code"]).toBe("compute_limit_reached");
    await w.until("the pause", () => w.sessionOf(s.session_id).state === "paused");
    expect(w.sessionOf(s.session_id).paused_by).toBe("compute_limit");
  });

  test("configuration is checked; only the researcher's routes change it", async () => {
    const w = await setup();
    const bad = await w.human<{ error: Json }>("/api/v1/projects/lab/agent-containers/config", {
      method: "PUT",
      body: {
        evaluations: [
          {
            name: "x",
            description: "d",
            command: ["true"],
            environment: "none",
            mounts: ["/elsewhere"],
            runtime_max_sec: 5,
          },
        ],
      },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error["message"]).toContain("is not in hidden");
    const before = (
      await w.human<{ revision: number }>("/api/v1/projects/lab/agent-containers/config")
    ).body.revision;
    await w.human("/api/v1/projects/lab/agent-containers/allow", {
      body: { hosts: ["example.com"] },
    });
    const after = (
      await w.human<{ revision: number; egress: { allow: string[] } }>(
        "/api/v1/projects/lab/agent-containers/config",
      )
    ).body;
    expect(after.revision).toBe(before + 1);
    expect(after.egress.allow).toContain("example.com");
  });

  test("a restarted coordinator gives live sessions their sockets back", async () => {
    const w = await setup();
    const s = (await w.start()).body;
    const token = w.tokenOf(s.session_id);
    const home = w.cl.c.services.paths.home;
    await w.cl.c.stop();
    h.coordinators.splice(h.coordinators.indexOf(w.cl.c), 1);
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const cl2 = await h.start({
      home,
      trackingUrl: fake.url,
      trackingIntervalMs: 20,
      settings: SETTINGS,
      containers: {
        podman: w.f.podman,
        tmux: w.f.tmux,
        monitorMs: 50,
        cdiSpecs: [],
        userHome: h.tmp("ak-user-"),
      },
    });
    expect(cl2.c.services.containers.get(s.session_id)?.state).toBe("running");
    const who = await fetch("http://localhost/api/v1/whoami", {
      unix: join(cl2.c.services.containers.mountDir(s.session_id), "agent.sock"),
      headers: { authorization: `Bearer ${token}` },
    } as RequestInit);
    expect(who.status).toBe(200);
  });
});
