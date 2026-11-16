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
 * changed.
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
      `{`,
      `echo token=$(head -c 4 /run/ablationkit/token)`,
      `echo coordinator_home=$(ls ${cl.c.services.paths.home} 2>/dev/null | wc -l)`,
      `echo user_home=$(ls ${home} 2>/dev/null | wc -l)`,
      `echo login_socket=$(test -e ${cl.c.services.paths.loginSocket} && echo yes || echo no)`,
      `echo hidden=$(ls eval | wc -l)`,
      `echo readonly=$(touch data/new 2>/dev/null && echo writable || echo refused)`,
      `echo gpu=$(ls /dev/nvidia* 2>/dev/null | wc -l)`,
      `echo direct=$(curl -sS --noproxy '*' --max-time 5 https://example.com >/dev/null 2>&1 && echo reached || echo blocked)`,
      `echo proxied=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://example.com)`,
      `echo mcp=$(printf '${mcpIn}\\n' | ablationkit mcp --contained | grep -c '"lab"')`,
      `} > ${probe} 2>&1; touch ${repo}/agent-wrote-this; exit`,
    ].join("; ");
    keys(script);
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
    const pause = svc.containers.pause(sid, "e2e");
    expect(pause.state).toBe("paused");
    expect(svc.containers.podman.status(`ak-agent-${sid}`)).toBe("paused");
    expect(svc.containers.resume(sid, "e2e").state).toBe("running");
    svc.containers.stop(sid, "e2e");
    for (let i = 0; i < 300 && svc.containers.get(sid)?.state === "running"; i++)
      await Bun.sleep(200);
    expect(svc.containers.get(sid)?.state).toBe("exited");
  });
});
