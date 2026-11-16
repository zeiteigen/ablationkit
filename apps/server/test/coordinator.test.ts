/** Coordinator: login, criterion 2 (remote client via the API), registry, SSE, audit, lock, recovery. */
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CoordinatorLockedError, runtimePaths } from "../src/index.ts";
import { Harness, TAILNET } from "./helpers.ts";

const h = new Harness();
afterEach(() => h.cleanup());

type Project = { project_id: string; name: string; path: string; previous_paths: string[] };

describe("login", () => {
  test("the login socket is private and issues one-time links", async () => {
    const cl = await h.start();
    expect(statSync(cl.c.loginSocket).mode & 0o777).toBe(0o600);
    expect(statSync(join(cl.c.loginSocket, "..")).mode & 0o777).toBe(0o700);
    const r = await cl.json<{ url: string; code: string }>(cl.socket("/login", {}));
    expect(r.body.url).toBe(`${cl.localOrigin}/login?code=${r.body.code}`);

    // The browser link sets an HttpOnly, SameSite=Strict cookie and works once.
    const first = await cl.human(`/login?code=${r.body.code}`, {
      host: new URL(cl.localOrigin).host,
    });
    expect(first.status).toBe(303);
    expect(first.headers.get("set-cookie")).toMatch(
      /^ak_session=aks_[a-f0-9]{16}\.[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=[0-9]+$/,
    );
    expect((await cl.human(`/login?code=${r.body.code}`)).status).toBe(400);
    const cookie = (first.headers.get("set-cookie") as string).split(";")[0] as string;
    expect((await cl.human("/api/v1/auth/session", { cookie })).status).toBe(200);
    // Logout revokes the session.
    expect(
      (await cl.human("/api/v1/auth/session", { cookie, origin: cl.localOrigin, method: "DELETE" }))
        .status,
    ).toBe(200);
    expect((await cl.human("/api/v1/auth/session", { cookie })).status).toBe(401);
  });

  test("a login link can land on a web UI path, never another origin or the API (F30)", async () => {
    const cl = await h.start();
    const host = new URL(cl.localOrigin).host;
    const next = "/p/lab/runs/jobs/j-1?tab=console";
    const r = await cl.json<{ url: string; code: string }>(cl.socket("/login", { next }));
    expect(r.body.url).toBe(
      `${cl.localOrigin}/login?code=${r.body.code}&next=${encodeURIComponent(next)}`,
    );
    const landed = await cl.human(`/login?code=${r.body.code}&next=${encodeURIComponent(next)}`, {
      host,
    });
    expect(landed.status).toBe(303);
    expect(landed.headers.get("location")).toBe(next);
    for (const bad of [
      "//evil.example/x",
      "/\\evil.example",
      "https://evil.example/",
      "/api/v1/auth/session",
      "/login",
      "/p/../api/x",
      "/p/x\n",
    ]) {
      expect(
        (await cl.json<{ error: { code: string } }>(cl.socket("/login", { next: bad }))).status,
      ).toBe(400);
      const code = (await cl.json<{ code: string }>(cl.socket("/login", {}))).body.code;
      const res = await cl.human(`/login?code=${code}&next=${encodeURIComponent(bad)}`, { host });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  test("CLI code exchange, single use, and expiry", async () => {
    let t = Date.parse("2026-11-02T10:00:00Z");
    const cl = await h.start({ now: () => new Date(t) });
    const code = await cl.loginCode();
    expect((await cl.human("/api/v1/auth/session", { body: { code } })).status).toBe(201);
    expect((await cl.human("/api/v1/auth/session", { body: { code } })).status).toBe(401);
    const stale = await cl.loginCode();
    t += 2 * 60 * 1000;
    expect((await cl.human("/api/v1/auth/session", { body: { code: stale } })).status).toBe(401);
  });

  test("requests need a session; cookie writes need a trusted Origin; Host is checked", async () => {
    const cl = await h.start();
    expect((await cl.human("/api/v1/projects")).status).toBe(401);
    expect((await cl.human("/api/v1/health")).status).toBe(200);
    const cookie = await cl.browserSession();
    // CSRF: a cookie-authenticated POST without Origin is refused; with a trusted one it proceeds.
    const noOrigin = await cl.json<{ error: { code: string } }>(
      cl.human("/api/v1/projects", { cookie, body: { path: h.repo() } }),
    );
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe("origin_required");
    expect(
      (
        await cl.human("/api/v1/projects", {
          cookie,
          origin: cl.localOrigin,
          body: { path: h.repo() },
        })
      ).status,
    ).toBe(201);
    // DNS rebinding: an unknown Host is refused.
    expect((await cl.human("/api/v1/health", { host: "attacker.example:80" })).status).toBe(421);
  });
});

describe("criterion 2: one coordinator, remote clients through the API", () => {
  test("a remote Tailscale browser logs in by link and works only through the coordinator API", async () => {
    const cl = await h.start({ remote: true });
    const remoteHost = new URL(TAILNET.origin).host;
    // The researcher asks the workstation for a link for the tailnet origin.
    const link = await cl.json<{ url: string; code: string }>(
      cl.socket("/login", { origin: TAILNET.origin }),
    );
    expect(link.body.url.startsWith(`${TAILNET.origin}/login?code=`)).toBe(true);
    const res = await cl.human(`/login?code=${link.body.code}`, { host: remoteHost });
    expect(res.headers.get("set-cookie")).toContain("; Secure");
    const cookie = (res.headers.get("set-cookie") as string).split(";")[0] as string;

    // Paths are resolved on the coordinator: the remote client names a coordinator path.
    const repo = h.repo("remote-registered");
    const added = await cl.json<{ project: Project }>(
      cl.human("/api/v1/projects", {
        cookie,
        origin: TAILNET.origin,
        host: remoteHost,
        body: { path: repo },
      }),
    );
    expect(added.status).toBe(201);
    const list = await cl.json<{ projects: Project[] }>(
      cl.human("/api/v1/projects", { cookie, host: remoteHost }),
    );
    expect(list.body.projects.map((p) => p.project_id)).toEqual([added.body.project.project_id]);
    // The registry was written by the coordinator, the single writer.
    const registry = JSON.parse(
      readFileSync(runtimePaths(cl.c.services.paths.home).registry, "utf8"),
    );
    expect(registry.projects[0].path).toBe(repo);

    // A remote CLI exchanges a code for a bearer token the same way.
    const code = await cl.loginCode(TAILNET.origin);
    const s = await cl.json<{ token: string }>(
      cl.human("/api/v1/auth/session", { host: remoteHost, body: { code, label: "laptop-cli" } }),
    );
    expect(s.status).toBe(201);
    expect(
      (await cl.human("/api/v1/projects", { token: s.body.token, host: remoteHost })).status,
    ).toBe(200);
  });

  test("an untrusted remote origin cannot use a session", async () => {
    const cl = await h.start();
    const cookie = await cl.browserSession();
    expect(
      (
        await cl.human("/api/v1/projects", {
          cookie,
          origin: TAILNET.origin,
          host: new URL(TAILNET.origin).host,
        })
      ).status,
    ).toBe(421);
  });

  test("a second coordinator cannot open the same runtime directory", async () => {
    const cl = await h.start();
    await expect(h.start({ home: cl.c.services.paths.home })).rejects.toThrow(
      CoordinatorLockedError,
    );
  });

  test("a stale lock from a dead process is replaced", async () => {
    const home = h.tmp("ak-home-");
    writeFileSync(join(home, "coordinator.lock"), `${JSON.stringify({ pid: 2147483646 })}\n`);
    const lines: string[] = [];
    const cl = await h.start({ home, log: (l) => lines.push(l) });
    expect(lines.some((l) => l.includes("stale lock"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "coordinator.lock"), "utf8")).pid).toBe(process.pid);
    await cl.c.stop();
    expect(existsSync(join(home, "coordinator.lock"))).toBe(false);
  });
});

describe("project registry", () => {
  test("add creates a manifest, refuses duplicates, and remaps a moved checkout", async () => {
    const cl = await h.start();
    const token = await cl.session();
    const repo = h.repo("Vision Lab");
    const added = await cl.json<{ project: Project; manifest_created: boolean }>(
      cl.human("/api/v1/projects", { token, body: { path: repo } }),
    );
    expect(added.status).toBe(201);
    expect(added.body.manifest_created).toBe(true);
    expect(added.body.project.project_id).toBe("vision-lab");
    const manifest = JSON.parse(readFileSync(join(repo, ".ablationkit/project.json"), "utf8"));
    expect(manifest).toEqual({ schema_version: 1, project_id: "vision-lab", name: "Vision Lab" });
    expect(statSync(join(cl.c.services.paths.stateDir, "vision-lab")).isDirectory()).toBe(true);

    expect((await cl.human("/api/v1/projects", { token, body: { path: repo } })).status).toBe(409);
    expect(
      (await cl.human("/api/v1/projects", { token, body: { path: "relative/path" } })).status,
    ).toBe(400);
    expect(
      (await cl.human("/api/v1/projects", { token, body: { path: "/no/such/dir/xyz" } })).status,
    ).toBe(400);

    // Move the checkout: doctor fails, re-adding points at remap, remap keeps the ID.
    const moved = join(h.tmp(), "moved");
    renameSync(repo, moved);
    const doc = await cl.json<{ status: string; checks: { name: string; status: string }[] }>(
      cl.human("/api/v1/projects/vision-lab/doctor", { token }),
    );
    expect(doc.body.status).toBe("fail");
    const again = await cl.json<{ error: { code: string } }>(
      cl.human("/api/v1/projects", { token, body: { path: moved } }),
    );
    expect(again.body.error.code).toBe("project_exists");
    const remapped = await cl.json<{ project: Project }>(
      cl.human("/api/v1/projects/vision-lab/remap", { token, body: { path: moved } }),
    );
    expect(remapped.status).toBe(200);
    expect(remapped.body.project.path).toBe(moved);
    expect(remapped.body.project.previous_paths).toEqual([repo]);
    const ok = await cl.json<{ status: string }>(
      cl.human("/api/v1/projects/vision-lab/doctor", { token }),
    );
    expect(ok.body.status).toBe("ok");

    // A checkout of another project cannot be remapped onto this ID.
    const other = h.repo("other");
    await cl.human("/api/v1/projects", { token, body: { path: other } });
    expect(
      (await cl.human("/api/v1/projects/vision-lab/remap", { token, body: { path: other } }))
        .status,
    ).toBe(409);

    // Name collisions get a suffix.
    const twin = join(h.tmp(), "Vision Lab");
    mkdirSync(twin);
    const t2 = await cl.json<{ project: Project }>(
      cl.human("/api/v1/projects", { token, body: { path: twin } }),
    );
    expect(t2.body.project.project_id).toBe("vision-lab-2");
  });

  test("registration and remap write no agent guard into the checkout (ADR 0062)", async () => {
    const cl = await h.start();
    const token = await cl.session();
    const repo = h.repo("open");
    const added = await cl.json<{ project: Project; agent_guard?: unknown }>(
      cl.human("/api/v1/projects", { token, body: { path: repo } }),
    );
    expect(added.status).toBe(201);
    expect(added.body.agent_guard).toBeUndefined();
    expect(existsSync(join(repo, ".claude/settings.local.json"))).toBe(false);
    expect(existsSync(join(repo, ".codex/config.toml"))).toBe(false);
    const moved = join(h.tmp(), "open-moved");
    renameSync(repo, moved);
    const remapped = await cl.json<{ changed: boolean; agent_guard?: unknown }>(
      cl.human(`/api/v1/projects/${added.body.project.project_id}/remap`, {
        token,
        body: { path: moved },
      }),
    );
    expect(remapped.body.changed).toBe(true);
    expect(remapped.body.agent_guard).toBeUndefined();
    expect(existsSync(join(moved, ".claude/settings.local.json"))).toBe(false);
  });

  test("doctor warns until the manifest is committed (bundles and candidates use the committed tree)", async () => {
    const cl = await h.start();
    const token = await cl.session();
    const dir = join(h.tmp(), "real");
    mkdirSync(dir);
    const g = (...a: string[]) =>
      Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir });
    g("init", "-q");
    writeFileSync(join(dir, "a.txt"), "x\n");
    g("add", "-A");
    g("commit", "-qm", "init");
    await cl.human("/api/v1/projects", { token, body: { path: dir, project_id: "real" } });
    const doctor = () =>
      cl.json<{ status: string; checks: { name: string; status: string; detail: string }[] }>(
        cl.human("/api/v1/projects/real/doctor", { token }),
      );
    const before = (await doctor()).body;
    expect(before.status).toBe("warn");
    expect(before.checks.find((c) => c.name === "manifest committed")?.detail).toContain(
      "not committed",
    );
    g("add", ".ablationkit/project.json");
    g("commit", "-qm", "register");
    const after = (await doctor()).body;
    expect(after.checks.some((c) => c.name === "manifest committed")).toBe(false);
    expect(after.status).toBe("ok");
  });

  test("an existing manifest's ID is used; doctor warns without Git", async () => {
    const cl = await h.start();
    const token = await cl.session();
    const dir = join(h.tmp(), "plain");
    mkdirSync(join(dir, ".ablationkit"), { recursive: true });
    writeFileSync(
      join(dir, ".ablationkit/project.json"),
      JSON.stringify({ schema_version: 1, project_id: "nlp-core", name: "NLP" }),
    );
    const r = await cl.json<{ project: Project; manifest_created: boolean }>(
      cl.human("/api/v1/projects", { token, body: { path: dir } }),
    );
    expect(r.body.project.project_id).toBe("nlp-core");
    expect(r.body.manifest_created).toBe(false);
    const d = await cl.json<{ status: string; checks: { name: string; status: string }[] }>(
      cl.human("/api/v1/projects/nlp-core/doctor", { token }),
    );
    expect(d.body.status).toBe("warn");
    expect(d.body.checks.find((c) => c.name === "git")?.status).toBe("warn");
    expect((await cl.human("/api/v1/projects/nope/doctor", { token })).status).toBe(404);
  });

  test("the registry survives a restart", async () => {
    const cl = await h.start();
    const home = cl.c.services.paths.home;
    const token = await cl.session();
    await cl.human("/api/v1/projects", { token, body: { path: h.repo("keep") } });
    await cl.c.stop();
    const cl2 = await h.start({ home });
    // Sessions persist (hashed) across restarts too.
    const list = await cl2.json<{ projects: Project[] }>(cl2.human("/api/v1/projects", { token }));
    expect(list.body.projects.map((p) => p.project_id)).toEqual(["keep"]);
  });
});

async function readSse(
  res: Response,
  count: number,
  timeoutMs = 3000,
): Promise<{ id: number; type: string; data: Record<string, unknown> }[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: { id: number; type: string; data: Record<string, unknown> }[] = [];
  const deadline = Date.now() + timeoutMs;
  while (out.length < count && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(1, deadline - Date.now())).then(() => ({ value: undefined, done: true })),
    ]);
    if (done || !value) break;
    buf += dec.decode(value, { stream: true });
    let i = buf.indexOf("\n\n");
    while (i >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const fields = Object.fromEntries(
        frame
          .split("\n")
          .filter((l) => !l.startsWith(":") && l.includes(": "))
          .map((l) => [l.slice(0, l.indexOf(": ")), l.slice(l.indexOf(": ") + 2)]),
      );
      if (fields["data"])
        out.push({
          id: Number(fields["id"]),
          type: fields["event"] as string,
          data: JSON.parse(fields["data"] as string),
        });
      i = buf.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return out;
}

describe("SSE", () => {
  test("live fan-out to several subscribers, project filter, and replay after reconnect", async () => {
    const cl = await h.start();
    const token = await cl.session();
    const a = await cl.human("/api/v1/events/stream", { token });
    const b = await cl.human("/api/v1/events/stream", { token });
    expect(a.headers.get("content-type")).toContain("text/event-stream");
    await Bun.sleep(20);
    await cl.human("/api/v1/projects", { token, body: { path: h.repo("one") } });
    await cl.human("/api/v1/projects", { token, body: { path: h.repo("two") } });
    const [ea, eb] = await Promise.all([readSse(a, 2), readSse(b, 2)]);
    expect(ea.map((e) => [e.type, e.data["project_id"]])).toEqual([
      ["project.registered", "one"],
      ["project.registered", "two"],
    ]);
    expect(eb.map((e) => e.id)).toEqual(ea.map((e) => e.id));

    // Reconnect with Last-Event-ID after missing an event: the journal replays it.
    await cl.human("/api/v1/projects/one/remap", {
      token,
      body: {
        path: (await cl.json<{ project: Project }>(cl.human("/api/v1/projects/one", { token })))
          .body.project.path,
      },
    });
    const three = h.repo("three");
    await cl.human("/api/v1/projects", { token, body: { path: three } });
    const last = ea[1]?.id as number;
    const replay = await readSse(
      await cl.human("/api/v1/events/stream", {
        token,
        headers: { "last-event-id": String(last) },
      }),
      1,
    );
    expect(replay.map((e) => e.data["project_id"])).toEqual(["three"]);

    // Filtered stream.
    const only = await cl.human("/api/v1/events/stream?project=two&after=-1", { token });
    const filtered = await readSse(only, 1);
    expect(filtered.map((e) => e.data["project_id"])).toEqual(["two"]);
    expect((await cl.human("/api/v1/events/stream?project=missing", { token })).status).toBe(404);
  });

  test("heartbeats keep idle streams alive and the hub forgets closed subscribers", async () => {
    const cl = await h.start();
    const token = await cl.session();
    // The coordinator's own subscribers (the compute limit's re-check) stay.
    const own = cl.c.services.events.subscriberCount;
    const res = await cl.human("/api/v1/events/stream", { token });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    const deadline = Date.now() + 2000;
    while (!text.includes(": heartbeat") && Date.now() < deadline)
      text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain(": heartbeat");
    expect(cl.c.services.events.subscriberCount).toBe(own + 1);
    await reader.cancel();
    const until = Date.now() + 2000;
    while (cl.c.services.events.subscriberCount > own && Date.now() < until) await Bun.sleep(10);
    expect(cl.c.services.events.subscriberCount).toBe(own);
  });
});

describe("audit and startup recovery", () => {
  test("mutations and auth events are audited with no secrets", async () => {
    const cl = await h.start();
    const token = await cl.session();
    await cl.human("/api/v1/projects", { token, body: { path: h.repo("aud") } });
    const minted = { body: await cl.agentSession("aud") };
    const { body } = await cl.json<{ records: { action: string; outcome: string }[] }>(
      cl.human("/api/v1/audit?limit=1000", { token }),
    );
    const actions = body.records.map((r) => `${r.action}:${r.outcome}`);
    for (const a of [
      "coordinator.start:allowed",
      "auth.login_link.issue:allowed",
      "auth.session.create:allowed",
      "project.register:allowed",
      "auth.agent_session.start:allowed",
    ]) {
      expect(actions).toContain(a);
    }
    const raw = readFileSync(join(cl.c.services.paths.auditDir, "audit-0001.jsonl"), "utf8");
    for (const secret of [token, minted.body.token]) {
      expect(raw).not.toContain(secret.split(".")[1] as string);
    }
    const tokensFile = readFileSync(cl.c.services.paths.tokens, "utf8");
    expect(tokensFile).not.toContain(minted.body.token.split(".")[1] as string);
    expect(statSync(cl.c.services.paths.tokens).mode & 0o777).toBe(0o600);
  });

  test("startup repairs a torn audit tail and an interrupted registry write, and reports them", async () => {
    const cl = await h.start();
    const home = cl.c.services.paths.home;
    const token = await cl.session();
    await cl.human("/api/v1/projects", { token, body: { path: h.repo("survivor") } });
    await cl.c.stop();
    const paths = runtimePaths(home);
    appendFileSync(join(paths.auditDir, "audit-0001.jsonl"), '{"seq": 99, "torn');
    // An interrupted replace: a leftover temp next to the registry.
    writeFileSync(
      join(home, ".registry.json.tmp-1-deadbeef"),
      '{"schema_version": 1, "projects": [',
    );
    const lines: string[] = [];
    const cl2 = await h.start({ home, log: (l) => lines.push(l) });
    const status = await cl2.json<{ startup: { findings: { kind: string }[]; repairs: string[] } }>(
      cl2.human("/api/v1/coordinator/status", { token }),
    );
    const kinds = status.body.startup.findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(["interrupted_json_write", "jsonl_partial_tail"]);
    expect(status.body.startup.repairs.some((r) => r.startsWith("removed_temp"))).toBe(true);
    expect(status.body.startup.repairs.some((r) => r.startsWith("truncated_tail"))).toBe(true);
    expect(lines.some((l) => l.startsWith("startup finding"))).toBe(true);
    const list = await cl2.json<{ projects: Project[] }>(cl2.human("/api/v1/projects", { token }));
    expect(list.body.projects.map((p) => p.project_id)).toEqual(["survivor"]);
  });

  test("an unrecoverable registry stops startup with a clear error", async () => {
    const home = h.tmp("ak-home-");
    writeFileSync(join(home, "registry.json"), "{ not json");
    await expect(h.start({ home })).rejects.toThrow(
      /registry\.json is unreadable and has no valid backup/,
    );
    // The lock was released, so a fixed directory can start.
    writeFileSync(join(home, "registry.json"), JSON.stringify({ schema_version: 1, projects: [] }));
    await h.start({ home });
  });
});
