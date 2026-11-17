/**
 * Agent containers against real rootless Podman and tmux (ADR 0061), opt-in:
 * `bun run test:containers` (sets ABLATIONKIT_CONTAINERS_E2E=1; builds the agent image when it is
 * missing, which pulls Debian once).
 *
 * A `shell` session is driven through its tmux terminal: inside the container it probes the
 * boundary (no coordinator home, no login socket, hidden paths empty, read-only paths unwritable,
 * no GPU devices, no network but the proxy, which refuses a host off the allowlist) and talks to
 * AblationKit through `ablationkit mcp --contained`. Then a contained job runs in a job container,
 * the session is paused and resumed for real, and when the shell exits the session records what it
 * changed. Last, environment builds (ADR 0066): real `uv sync` into a new copy of the project's
 * environment, which a job then reads read-only.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ContainerSessionRecord, CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Client, Harness } from "./helpers.ts";

const E2E = process.env["ABLATIONKIT_CONTAINERS_E2E"] === "1";
const IMAGE = "localhost/ablationkit-agent:1";
const ROOT = resolve(import.meta.dir, "../../..");

const h = new Harness();
const fakes: FakeMlflow[] = [];
afterAll(async () => {
  // Containers outlive the coordinator by design: stop what a failed test left running.
  for (const c of h.coordinators)
    for (const s of c.services.containers.list())
      if (["starting", "running", "paused"].includes(s.state))
        c.services.containers.podman.stop(s.container, 2);
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

function run(argv: string[], timeout = 600_000): { code: number; out: string } {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout });
  return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() };
}

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.org", ...args], {
    cwd,
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

describe.skipIf(!E2E)("agent containers on rootless Podman", () => {
  test("a contained shell meets the boundary, reports through MCP, runs a job container, ends with its record", async () => {
    expect(run(["podman", "info", "--format", "{{.Host.Security.Rootless}}"]).out.trim()).toBe(
      "true",
    );
    if (run(["podman", "image", "exists", IMAGE]).code !== 0) {
      const b = run([
        "podman",
        "build",
        "--tag",
        IMAGE,
        "--file",
        join(ROOT, "packages/agent-containers/image/Containerfile"),
        join(ROOT, "packages/agent-containers/image"),
      ]);
      expect(b.code).toBe(0);
    }
    const fake = new FakeMlflow().start();
    fakes.push(fake);
    const settings: CoordinatorSettings = {
      schema_version: 1,
      human: { host: "127.0.0.1", port: 0 },
      agent: { host: "127.0.0.1", port: 0 },
      worker: { host: "127.0.0.1", port: 0 },
      mlflow: { enabled: false },
      jobs: { deliver_deadline_sec: 60 },
    };
    const cl = await h.start({
      trackingUrl: fake.url,
      trackingIntervalMs: 50,
      settings,
      containers: { monitorMs: 500 },
    });
    const session = await cl.session();
    const human = <T = Record<string, unknown>>(
      path: string,
      init: { method?: string; body?: unknown } = {},
    ) => cl.json<T>(cl.human(path, { token: session, ...init }));

    const repo = join(h.tmp(), "lab");
    mkdirSync(join(repo, "eval"), { recursive: true });
    mkdirSync(join(repo, "data"), { recursive: true });
    writeFileSync(join(repo, "eval", "labels.csv"), "secret\n");
    writeFileSync(join(repo, "data", "train.csv"), "x\n");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "start");
    expect(
      (await human("/api/v1/projects", { body: { path: repo, project_id: "lab" } })).status,
    ).toBe(201);
    const gpu = existsSync("/var/run/cdi/nvidia.yaml") || existsSync("/etc/cdi/nvidia.yaml");
    expect(
      (
        await human("/api/v1/projects/lab/agent-containers/config", {
          method: "PUT",
          body: {
            hidden: ["eval"],
            read_only: ["data"],
            jobs: { gpu: gpu ? "all" : "none", network: "none" },
          },
        })
      ).status,
    ).toBe(200);

    const started = await human<ContainerSessionRecord & { attach: string[] }>(
      "/api/v1/projects/lab/agent-containers",
      { body: { harness: "shell", label: "e2e shell" } },
    );
    expect(started.status).toBe(201);
    const sid = started.body.session_id;
    const tmux = started.body.attach.slice(0, 3); // tmux -S <socket>
    const keys = (text: string) => run([...tmux, "send-keys", "-t", "agent", text, "Enter"]);
    // Wait for the shell's prompt.
    for (let i = 0; i < 100; i++) {
      if (run([...tmux, "capture-pane", "-p", "-t", "agent"]).out.trim()) break;
      await Bun.sleep(200);
    }
    const probe = join(repo, "probe.txt");
    const home = join(homedir(), ".ablationkit");
    const mcpIn = [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"e2e"}}}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ablationkit_project","arguments":{}}}',
    ].join("\\n");
    const script = [
      `echo token=$(head -c 4 /run/ablationkit/token)`,
      `echo coordinator_home=$(ls ${cl.c.services.paths.home} 2>/dev/null | wc -l)`,
      `echo user_home=$(ls ${home} 2>/dev/null | wc -l)`,
      `echo login_socket=$(test -e ${cl.c.services.paths.loginSocket} && echo yes || echo no)`,
      `echo hidden=$(ls eval | wc -l)`,
      `echo readonly=$(touch data/new 2>/dev/null && echo writable || echo refused)`,
      `echo gpu=$(ls /dev/nvidia* 2>/dev/null | wc -l)`,
      `echo env=$(ls /opt/ablationkit/env 2>/dev/null | wc -l)`,
      `echo uv=$(uv sync >/dev/null 2>&1; echo $?)`,
      `echo direct=$(curl -sS --noproxy '*' --max-time 5 https://example.com >/dev/null 2>&1 && echo reached || echo blocked)`,
      `echo proxied=$(curl -s -o /dev/null -w '%{http_connect}' --max-time 10 https://example.com)`,
      // stdin stays open a moment: the server answers calls in flight only while its client is there.
      `echo mcp=$( (printf '${mcpIn}\\n'; sleep 8) | ablationkit mcp --contained | grep -c '"lab"')`,
    ].join("; ");
    const line = `{ ${script}; } > ${probe} 2>&1; touch ${repo}/agent-wrote-this; exit`;
    keys(line);
    for (let i = 0; i < 600 && cl.c.services.containers.get(sid)?.state === "running"; i++)
      await Bun.sleep(200);
    const s = cl.c.services.containers.get(sid) as ContainerSessionRecord;
    const out = readFileSync(probe, "utf8");
    expect(out).toContain("token=aka_");
    expect(out).toContain("coordinator_home=0");
    expect(out).toContain("user_home=0");
    expect(out).toContain("login_socket=no");
    expect(out).toContain("hidden=0");
    expect(out).toContain("readonly=refused");
    expect(out).toContain("gpu=0");
    expect(out).toContain("env=0");
    expect(out).toContain("uv=127");
    expect(out).toContain("direct=blocked");
    expect(out).toContain("proxied=403");
    expect(out).toMatch(/mcp=[1-9]/);
    expect(s.state).toBe("exited");
    expect(s.files_changed?.map((f) => f.path)).toEqual(
      expect.arrayContaining(["agent-wrote-this", "probe.txt"]),
    );
    const eg = await human<{ summary: { denied: { host: string }[] } }>(
      `/api/v1/agent-containers/${sid}/egress`,
    );
    expect(eg.body.summary.denied.map((d) => d.host)).toContain("example.com");
  });

  test("a contained session's job runs in a job container that cannot see hidden paths; pause and resume are real", async () => {
    const c = h.coordinators.at(-1);
    if (!c) throw new Error("the first test starts the coordinator");
    const svc = c.services;
    const human = await new Client(c).session();
    const r0 = await fetch(`${svc.urls.human}/api/v1/projects/lab/agent-containers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${human}` },
      body: JSON.stringify({ harness: "shell", label: "e2e jobs" }),
    });
    expect(r0.status).toBe(201);
    const sessionToken = (await r0.json()) as ContainerSessionRecord;
    const sid = sessionToken.session_id;
    const token = readFileSync(join(svc.containers.mountDir(sid), "token"), "utf8").trim();
    const sock = join(svc.containers.mountDir(sid), "agent.sock");
    const r = await fetch("http://localhost/api/v1/projects/lab/jobs", {
      method: "POST",
      unix: sock,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        command: ["sh", "-c", "echo hidden=$(ls eval | wc -l); echo job-ok"],
        environment: "none",
        limits: { runtime_max_sec: 300 },
        description: "e2e job container",
      }),
    } as RequestInit);
    expect(r.status).toBe(201);
    const job = (await r.json()) as { job_id: string };
    for (let i = 0; i < 600; i++) {
      const st = svc.jobs.get(job.job_id)?.state;
      if (st && st !== "starting" && st !== "running") break;
      await Bun.sleep(200);
    }
    expect(svc.jobs.get(job.job_id)?.state).toBe("succeeded");
    const attempt = svc.jobs.latestAttempt(svc.jobs.get(job.job_id) as never);
    const con = await fetch(
      `${svc.urls.human}/api/v1/jobs/${job.job_id}/attempts/${attempt?.attempt_id}/console`,
      { headers: { authorization: `Bearer ${human}` } },
    );
    const text = await con.text();
    expect(text).toContain("job-ok");
    expect(text).toContain("hidden=0");
    expect(attempt?.supervisor.container?.gpu).toBe(
      existsSync("/var/run/cdi/nvidia.yaml") || existsSync("/etc/cdi/nvidia.yaml") ? "all" : "none",
    );
    const pause = svc.containers.pause(sid, "e2e");
    expect(pause.state).toBe("paused");
    expect(svc.containers.podman.status(`ak-agent-${sid}`)).toBe("paused");
    expect(svc.containers.resume(sid, "e2e").state).toBe("running");
    svc.containers.stop(sid, "e2e");
    for (let i = 0; i < 300 && svc.containers.get(sid)?.state === "running"; i++)
      await Bun.sleep(200);
    expect(svc.containers.get(sid)?.state).toBe("exited");
  });

  test("an environment build runs uv sync into a new copy; jobs read it and cannot change it (ADR 0066)", async () => {
    const c = h.coordinators.at(-1);
    if (!c) throw new Error("the first test starts the coordinator");
    const svc = c.services;
    const human = await new Client(c).session();
    const repo = svc.registry.require("lab").path;
    writeFileSync(
      join(repo, "pyproject.toml"),
      '[project]\nname = "lab"\nversion = "0.0.0"\nrequires-python = ">=3.10"\ndependencies = []\n',
    );
    const r0 = await fetch(`${svc.urls.human}/api/v1/projects/lab/agent-containers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${human}` },
      body: JSON.stringify({ harness: "shell", label: "e2e environment" }),
    });
    expect(r0.status).toBe(201);
    const sid = ((await r0.json()) as ContainerSessionRecord).session_id;
    const token = readFileSync(join(svc.containers.mountDir(sid), "token"), "utf8").trim();
    const sock = join(svc.containers.mountDir(sid), "agent.sock");
    const submit = async (body: Record<string, unknown>) => {
      const r = await fetch("http://localhost/api/v1/projects/lab/jobs", {
        method: "POST",
        unix: sock,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      } as RequestInit);
      return { status: r.status, body: (await r.json()) as { job_id: string; error?: unknown } };
    };
    const settle = async (jobId: string) => {
      for (let i = 0; i < 900; i++) {
        const st = svc.jobs.get(jobId)?.state;
        if (st && st !== "starting" && st !== "running") return st;
        await Bun.sleep(200);
      }
      return svc.jobs.get(jobId)?.state;
    };
    const consoleOf = async (jobId: string) => {
      const a = svc.jobs.latestAttempt(svc.jobs.get(jobId) as never);
      const r = await fetch(
        `${svc.urls.human}/api/v1/jobs/${jobId}/attempts/${a?.attempt_id}/console`,
        { headers: { authorization: `Bearer ${human}` } },
      );
      return { attempt: a, text: await r.text() };
    };
    const probe = {
      command: [
        "python",
        "-c",
        "import sys\nprint('prefix=' + sys.prefix)\ntry:\n    open(sys.prefix + '/x', 'w')\n    print('env=writable')\nexcept OSError:\n    print('env=read-only')",
      ],
      environment: "uv",
      gpu: "none",
      limits: { runtime_max_sec: 300 },
    };
    expect((await submit(probe)).status).toBe(409);
    const b = await submit({ build_environment: true, limits: { runtime_max_sec: 600 } });
    expect(b.status).toBe(201);
    const built = await settle(b.body.job_id);
    const bc = await consoleOf(b.body.job_id);
    expect({ built, log: bc.text.slice(-2000) }).toMatchObject({ built: "succeeded" });
    expect(existsSync(join(repo, "uv.lock"))).toBe(true);
    const gen = bc.attempt?.attempt_id as string;
    expect(svc.containers.environment("lab")?.generation).toBe(gen);
    const j = await submit(probe);
    expect(j.status).toBe(201);
    expect(await settle(j.body.job_id)).toBe("succeeded");
    const jc = await consoleOf(j.body.job_id);
    expect(jc.text).toContain("prefix=/opt/ablationkit/env");
    expect(jc.text).toContain("env=read-only");
    expect(jc.attempt?.supervisor.container).toMatchObject({ gpu: "none", environment: gen });
    // A second build starts from the first: a copy, then uv sync finds nothing to do.
    const b2 = await submit({ build_environment: true, limits: { runtime_max_sec: 600 } });
    expect(await settle(b2.body.job_id)).toBe("succeeded");
    expect((await consoleOf(b2.body.job_id)).text).toContain(
      "starting from the current environment",
    );
    const gen2 = svc.containers.environment("lab")?.generation as string;
    expect(gen2).not.toBe(gen);
    expect(existsSync(join(svc.containers.generationDir("lab", gen), "pyvenv.cfg"))).toBe(false);
    expect((await submit(probe)).status).toBe(201);
    svc.containers.stop(sid, "e2e");
    for (let i = 0; i < 300 && svc.containers.get(sid)?.state === "running"; i++)
      await Bun.sleep(200);
  });
});
