import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { renderUnit, unitHome } from "../src/commands/coordinator.ts";
import { uiCommand, webStale } from "../src/commands/ui.ts";
import type { CliContext } from "../src/context.ts";
import { main } from "../src/main.ts";
import { Harness, ROOT } from "./helpers.ts";

const h = new Harness();
afterEach(h.cleanup);
const tmp = () => h.tmp();

class Io {
  stdout = "";
  stderr = "";
  ctx(home: string, env: Record<string, string> = {}): CliContext {
    return {
      env,
      home,
      repoRoot: ROOT,
      out: (t) => {
        this.stdout += t;
      },
      err: (t) => {
        this.stderr += t;
      },
    };
  }
}

async function coordinator(home = tmp(), trackingUrl?: string) {
  const c = await h.start(home, trackingUrl ? { trackingUrl, trackingIntervalMs: 20 } : {});
  return { c, home };
}

describe("cli against a local coordinator", () => {
  test("project add, list, show, doctor and remap; the CLI logs itself in through the socket", async () => {
    const { home } = await coordinator();
    const repo = join(tmp(), "my-repo");
    mkdirSync(join(repo, ".git"), { recursive: true });

    const io = new Io();
    expect(await main(["project", "add", repo, "--json"], io.ctx(home))).toBe(0);
    const added = JSON.parse(io.stdout);
    expect(added.project.project_id).toBe("my-repo");
    // The CLI saved its session, privately.
    expect(statSync(join(home, "cli-session.json")).mode & 0o777).toBe(0o600);

    const io2 = new Io();
    expect(await main(["project", "list"], io2.ctx(home))).toBe(0);
    expect(io2.stdout).toBe(`my-repo\tmy-repo\t${repo}\n`);

    const io3 = new Io();
    expect(await main(["project", "doctor", "--project", "my-repo"], io3.ctx(home))).toBe(0);
    expect(io3.stdout).toContain("my-repo: ok");

    const io4 = new Io();
    expect(await main(["project", "show", "nope"], io4.ctx(home))).toBe(1);
    expect(io4.stderr).toContain("project_not_found");

    const moved = join(tmp(), "moved");
    const { renameSync } = await import("node:fs");
    renameSync(repo, moved);
    const io5 = new Io();
    expect(await main(["project", "doctor", "my-repo"], io5.ctx(home))).toBe(1);
    expect(await main(["project", "remap", "my-repo", moved], io5.ctx(home))).toBe(0);
    expect(io5.stdout).toContain(`remapped my-repo to ${moved}`);
  });

  test("project add prints the agent guard; project guard re-applies it without a coordinator", async () => {
    const { c, home } = await coordinator();
    const repo = join(tmp(), "guarded");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const env = { CODEX_HOME: join(tmp(), "no-codex") };
    const io = new Io();
    expect(await main(["project", "add", repo], io.ctx(home, env))).toBe(0);
    expect(io.stdout).toContain(
      `agent guard  created   ${join(repo, ".claude/settings.local.json")}`,
    );
    expect(io.stdout).toContain(`agent guard  created   ${join(repo, ".codex/config.toml")}`);
    await c.stop();

    rmSync(join(repo, ".claude"), { recursive: true });
    const io2 = new Io();
    expect(await main(["project", "guard", "--all", "--json"], io2.ctx(home, env))).toBe(0);
    const r = JSON.parse(io2.stdout);
    expect(r.projects[0].project_id).toBe("guarded");
    expect(r.projects[0].agent_guard.map((g: { action: string }) => g.action)).toEqual([
      "created",
      "unchanged",
    ]);
    const io3 = new Io();
    expect(await main(["project", "guard", "guarded"], io3.ctx(home, env))).toBe(0);
    expect(io3.stdout).toContain("unchanged");
    const io4 = new Io();
    expect(await main(["project", "guard", "nope"], io4.ctx(home, env))).toBe(1);
    expect(io4.stderr).toContain("no registered project nope");
    expect(await main(["project", "guard"], new Io().ctx(home, env))).toBe(2);
    // No home yet: nothing registered, nothing to do.
    const io5 = new Io();
    expect(await main(["project", "guard", "--all"], io5.ctx(join(tmp(), "fresh"), env))).toBe(0);
    expect(io5.stdout).toContain("no projects registered");
  });

  test("a stale saved session is replaced transparently", async () => {
    const { c, home } = await coordinator();
    const io = new Io();
    expect(await main(["project", "list"], io.ctx(home))).toBe(0);
    const saved = JSON.parse(readFileSync(join(home, "cli-session.json"), "utf8"));
    const sid = (Object.values(saved.sessions)[0] as { session_id: string }).session_id;
    c.services.tokens.revoke(sid, "test");
    expect(await main(["project", "list"], io.ctx(home))).toBe(0);
  });

  test("login prints a one-time link; a remote CLI exchanges the code and uses --coordinator", async () => {
    const { c, home } = await coordinator();
    const io = new Io();
    expect(await main(["login", "--json"], io.ctx(home))).toBe(0);
    const link = JSON.parse(io.stdout);
    expect(link.url).toBe(`${c.services.trustedOrigins[0]?.origin}/login?code=${link.code}`);

    // "Remote" machine: its own home, no login socket, only the coordinator URL.
    const remoteHome = tmp();
    const base = c.urls.human;
    const io2 = new Io();
    expect(await main(["project", "list", "--coordinator", base], io2.ctx(remoteHome))).toBe(3);
    expect(io2.stderr).toContain("no session for");
    const io3 = new Io();
    expect(
      await main(["login", "--coordinator", base, "--code", link.code], io3.ctx(remoteHome)),
    ).toBe(0);
    const io4 = new Io();
    expect(
      await main(["project", "list", "--coordinator", base, "--json"], io4.ctx(remoteHome)),
    ).toBe(0);
    expect(JSON.parse(io4.stdout)).toEqual({ projects: [] });
    // Relative paths are refused for a remote coordinator: paths are the coordinator's.
    const io5 = new Io();
    expect(
      await main(["project", "add", "rel/path", "--coordinator", base], io5.ctx(remoteHome)),
    ).toBe(2);
    // A used code fails.
    expect(
      await main(["login", "--coordinator", base, "--code", link.code], io5.ctx(remoteHome)),
    ).toBe(1);
  });

  test("ui prints or opens a login link", async () => {
    const { home } = await coordinator();
    const io = new Io();
    const opened: string[] = [];
    expect(await uiCommand([], io.ctx(home), (u) => opened.push(u) > 0)).toBe(0);
    expect(opened[0]).toMatch(/\/login\?code=/);
    const io2 = new Io();
    expect(await uiCommand(["--no-open"], io2.ctx(home), () => true)).toBe(0);
    expect(io2.stdout).toMatch(/^http:\/\/localhost:[0-9]+\/login\?code=/);
  });

  test("ui treats a web bundle older than its sources as stale", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-web-"));
    const dist = join(root, "apps/web/dist");
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(root, "apps/web/src/pages"), { recursive: true });
    const src = join(root, "apps/web/src/pages/runs.tsx");
    writeFileSync(src, "x");
    writeFileSync(join(dist, "index.html"), "<html>");
    const old = new Date(Date.now() - 60_000);
    utimesSync(src, old, old);
    expect(webStale(root, dist)).toBe(false);
    utimesSync(src, new Date(), new Date(Date.now() + 1000));
    expect(webStale(root, dist)).toBe(true);
    // An installed tree has no web sources: never stale.
    rmSync(join(root, "apps/web/src"), { recursive: true });
    expect(webStale(root, dist)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("commands report a stopped coordinator clearly", async () => {
    const io = new Io();
    expect(await main(["project", "list"], io.ctx(tmp()))).toBe(3);
    expect(io.stderr).toContain("coordinator is not running");
    expect(
      await main(
        ["coordinator", "status"],
        io.ctx(tmp(), { ABLATIONKIT_SERVICE: "ablationkit-test-nonexistent.service" }),
      ),
    ).toBe(1);
    expect(io.stdout).toContain("not running");
  });

  test("start and stop leave a unit that serves a different runtime home alone", async () => {
    const config = tmp();
    const dir = join(config, "systemd", "user");
    mkdirSync(dir, { recursive: true });
    const unitPath = join(dir, "ablationkit-test-other.service");
    const original = renderUnit({
      bun: "/b",
      serverMain: "/s",
      home: "/home/someone/.ablationkit",
      workingDirectory: "/r",
    });
    writeFileSync(unitPath, original);
    const io = new Io();
    const code = await main(
      ["coordinator", "start"],
      io.ctx(tmp(), {
        XDG_CONFIG_HOME: config,
        ABLATIONKIT_SERVICE: "ablationkit-test-other.service",
      }),
    );
    expect(code).toBe(1);
    expect(io.stderr).toContain("ABLATIONKIT_HOME=/home/someone/.ablationkit");
    expect(readFileSync(unitPath, "utf8")).toBe(original);
    // Nor does stop touch a service that runs another home.
    const io2 = new Io();
    expect(
      await main(
        ["coordinator", "stop"],
        io2.ctx(tmp(), {
          XDG_CONFIG_HOME: config,
          ABLATIONKIT_SERVICE: "ablationkit-test-other.service",
        }),
      ),
    ).toBe(0);
    expect(io2.stdout).toBe("not running\n");
    expect(unitHome(original)).toBe("/home/someone/.ablationkit");
    expect(
      unitHome(
        renderUnit({ bun: "/b", serverMain: "/s", home: '/h/"q"%x', workingDirectory: "/r" }),
      ),
    ).toBe('/h/"q"%x');
  });

  test("usage errors exit 2", async () => {
    const io = new Io();
    expect(await main(["project"], io.ctx(tmp()))).toBe(2);
    expect(await main(["project", "add", "--name"], io.ctx(tmp()))).toBe(2);
    expect(await main(["nope"], io.ctx(tmp()))).toBe(2);
  });
});

test("the systemd unit runs the coordinator with the runtime home", () => {
  const unit = renderUnit({
    bun: "/usr/bin/bun",
    serverMain: "/repo/apps/server/src/main.ts",
    home: "/home/r/.ablationkit",
    workingDirectory: "/repo",
    uv: "/home/r/.local/bin/uv",
  });
  expect(unit).toContain('ExecStart="/usr/bin/bun" "/repo/apps/server/src/main.ts"');
  expect(unit).toContain('Environment="ABLATIONKIT_UV=/home/r/.local/bin/uv"');
  expect(unit).toContain('Environment="ABLATIONKIT_HOME=/home/r/.ablationkit"');
  expect(unit).toContain("RestartPreventExitStatus=3");
  expect(unit).toContain("WantedBy=default.target");
  // systemd rejects a quoted WorkingDirectory.
  expect(unit).toContain("WorkingDirectory=/repo\n");
  expect(
    renderUnit({ bun: "/b", serverMain: "/a%b", home: "/h", workingDirectory: "/r" }),
  ).toContain('"/a%%b"');
});

const analyze = Bun.which("systemd-analyze");
test.skipIf(!analyze)("systemd accepts the generated unit (systemd-analyze verify)", () => {
  const dir = tmp();
  const path = join(dir, "ablationkit-verify-test.service");
  const unit = renderUnit({
    bun: process.execPath,
    serverMain: join(ROOT, "apps/server/src/main.ts"),
    home: join(dir, "home dir"),
    workingDirectory: ROOT,
    uv: "/usr/local/bin/uv",
  });
  writeFileSync(path, unit);
  const p = Bun.spawnSync([analyze as string, "--user", "verify", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = `${p.stdout}${p.stderr}`;
  // verify can warn about unrelated units on the machine; only lines naming our file matter.
  expect(out.split("\n").filter((l) => l.includes("ablationkit-verify-test"))).toEqual([]);
});

describe("tracking and backup commands", () => {
  test("tracking doctor/status/outbox/import and backup create/list", async () => {
    const fake = new FakeMlflow().start();
    try {
      const { c, home } = await coordinator(tmp(), fake.url);
      const repo = join(tmp(), "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      expect(await main(["project", "add", repo, "--id", "demo"], new Io().ctx(home))).toBe(0);
      const deadline = Date.now() + 5000;
      while (!c.services.tracking.mappings.getLinks("demo").experiment_id && Date.now() < deadline)
        await Bun.sleep(20);

      const doc = new Io();
      expect(await main(["tracking", "doctor"], doc.ctx(home))).toBe(0);
      expect(doc.stdout).toContain("mlflow api");
      expect(doc.stdout).toContain("every project has its ak/<project-id> experiment");
      const docJson = new Io();
      await main(["tracking", "doctor", "--json"], docJson.ctx(home));
      expect(JSON.parse(docJson.stdout).status).toMatch(/ok|warn/);

      const st = new Io();
      expect(await main(["tracking", "status"], st.ctx(home))).toBe(0);
      expect(st.stdout).toContain("external");
      expect(st.stdout).toContain("0 pending, 0 failed");

      const ob = new Io();
      expect(await main(["tracking", "outbox"], ob.ctx(home))).toBe(0);
      expect(ob.stdout).toContain("outbox is empty");

      const legacy = await c.services.tracking.client.createExperiment("legacy");
      const imp = new Io();
      expect(
        await main(
          ["tracking", "import", "--project", "demo", "--experiment", legacy],
          imp.ctx(home),
        ),
      ).toBe(0);
      expect(imp.stdout).toContain("read-only");
      const bad = new Io();
      expect(await main(["tracking", "retry", "op-nope"], bad.ctx(home))).toBe(1);
      expect(bad.stderr).toContain("not_found");

      const b = new Io();
      expect(await main(["backup", "create"], b.ctx(home))).toBe(0);
      expect(b.stdout).toMatch(/backup [0-9]{8}T[0-9]{6}Z/);
      const bl = new Io();
      expect(await main(["backup", "list", "--json"], bl.ctx(home))).toBe(0);
      expect(JSON.parse(bl.stdout).backups).toHaveLength(1);
      expect(await main(["tracking"], new Io().ctx(home))).toBe(2);
    } finally {
      await fake.stop();
    }
  });
});
