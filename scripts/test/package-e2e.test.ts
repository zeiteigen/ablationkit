/**
 * The installed tree works on its own (ADR 0028). Opt-in: `bun run test:package`.
 *
 * Stages a release, makes the tree read-only (an install must not write into itself), then from
 * that tree: boots a coordinator in the foreground with the managed MLflow, serves the web UI,
 * and, through the installed `ablationkit mcp` (an agent session, ADR 0040), runs a job that
 * imports the SDK and syncs to MLflow, then builds an extension scaffolded from the installed
 * templates and SDK. Then installs with install.sh into a scratch prefix, reinstalls
 * and uninstalls, and, when makepkg is present, builds the AUR package from `git archive HEAD`
 * (the committed tree) and runs the CLI from it. Uses the uv and bun caches; nothing is
 * installed system-wide and no user service is written.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, stage, version } from "../package.ts";

const RUN = process.env["ABLATIONKIT_PACKAGE_E2E"] === "1";
const work = RUN ? mkdtempSync(join(tmpdir(), "ak-package-")) : "";
const out = join(work, "stage");
const home = join(work, "home");
const ak = join(out, "bin", "ablationkit");

/** One `ablationkit mcp` session from the installed tree: send JSON-RPC lines, read the replies. */
async function mcpSession(cwd: string, calls: { name: string; arguments: object }[]) {
  const p = Bun.spawn([ak, "mcp"], {
    cwd,
    env: { ...process.env, ABLATIONKIT_HOME: home, ABLATIONKIT_NOTIFY: "0" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = [
    {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { clientInfo: { name: "package-e2e" } },
    },
    ...calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: c })),
  ];
  for (const l of lines) p.stdin.write(`${JSON.stringify(l)}\n`);
  await p.stdin.end();
  await p.exited;
  type Reply = { result: { structuredContent?: Record<string, unknown>; content: unknown } };
  const replies = (await new Response(p.stdout).text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Reply);
  return (
    replies
      .slice(1)
      // biome-ignore lint/suspicious/noExplicitAny: tool results are JSON read by the assertions
      .map((r): any => r.result.structuredContent ?? { error: r.result.content })
  );
}

function sh(cmd: string[], env: Record<string, string> = {}, cwd = work) {
  const r = spawnSync(cmd[0] as string, cmd.slice(1), {
    cwd,
    env: { ...process.env, ABLATIONKIT_HOME: home, ABLATIONKIT_NOTIFY: "0", ...env },
    encoding: "utf8",
    timeout: 300_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!RUN)("installed package (opt-in)", () => {
  let coordinator: ReturnType<typeof spawn> | undefined;
  let log = "";

  beforeAll(async () => {
    await stage({ out, log: () => {} });
    expect(spawnSync("chmod", ["-R", "a-w", join(out, "lib")]).status).toBe(0);
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({
        schema_version: 1,
        human: { host: "127.0.0.1", port: 0 },
        agent: { host: "127.0.0.1", port: 0 },
        worker: { host: "127.0.0.1", port: 0 },
      }),
    );
  }, 600_000);

  afterAll(async () => {
    if (coordinator && coordinator.exitCode === null) {
      coordinator.kill("SIGTERM");
      await new Promise((r) => coordinator?.once("exit", r));
    }
    spawnSync("chmod", ["-R", "u+w", work]);
    rmSync(work, { recursive: true, force: true });
  });

  test("version names the install and its commit", () => {
    const r = sh([ak, "version"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`ablationkit ${version()} (commit `);
    expect(r.out).toContain(`installed at ${join(out, "lib", "ablationkit")}`);
  });

  test("a read-only install boots a coordinator with the managed MLflow and serves the UI", async () => {
    coordinator = spawn(ak, ["coordinator", "start", "--foreground"], {
      cwd: work,
      env: { ...process.env, ABLATIONKIT_HOME: home, ABLATIONKIT_NOTIFY: "0" },
    });
    coordinator.stdout?.on("data", (d) => {
      log += d;
    });
    coordinator.stderr?.on("data", (d) => {
      log += d;
    });
    const end = Date.now() + 300_000;
    let status = "";
    while (Date.now() < end) {
      const r = sh([ak, "system", "status"]);
      if (r.code === 0 && /mlflow sidecar: healthy/.test(r.out)) {
        status = r.out;
        break;
      }
      await Bun.sleep(1000);
    }
    expect(status, log).toContain(": ok");
    const human = /human (http:\/\/127\.0\.0\.1:\d+)/.exec(log)?.[1];
    expect(human, log).toBeDefined();
    const index = await (await fetch(`${human}/`)).text();
    const asset = /\/(chunk-[a-z0-9]+\.js)/.exec(index)?.[1];
    expect(asset).toBeDefined();
    expect((await fetch(`${human}/${asset}`)).status).toBe(200);
  }, 360_000);

  test("an agent session from the install runs a job that imports the SDK and syncs to MLflow", async () => {
    const proj = join(work, "proj");
    mkdirSync(proj);
    writeFileSync(
      join(proj, "train.py"),
      'import ablationkit_sdk as ak\nak.log_metric("loss", 0.5, step=1)\nprint("sdk ok")\n',
    );
    const git = (...a: string[]) =>
      sh(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...a], {}, proj);
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "init");
    expect(sh([ak, "project", "add", proj]).code).toBe(0);
    git("add", "-A");
    git("commit", "-qm", "register");
    const [job] = await mcpSession(proj, [
      {
        name: "ablationkit_job",
        arguments: {
          action: "submit",
          command: ["python3", "train.py"],
          description: "The installed SDK logs a metric from a job.",
          runtime_max_sec: 600,
          environment: "none",
        },
      },
    ]);
    expect(job.job_id, JSON.stringify(job)).toMatch(/^j-/);
    // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC replies
    let shown: any;
    for (const end = Date.now() + 240_000; Date.now() < end; await Bun.sleep(1000)) {
      [shown] = await mcpSession(proj, [
        { name: "ablationkit_read", arguments: { op: "job.show", job_id: job.job_id } },
      ]);
      const a = shown.latest_attempt;
      if (a?.state === "succeeded" && a.tracking?.sync_state === "synced") break;
    }
    expect(shown.latest_attempt).toMatchObject({ state: "succeeded", exit_code: 0 });
    expect(shown.latest_attempt.tracking.sync_state).toBe("synced");
    const [log] = await mcpSession(proj, [
      { name: "ablationkit_read", arguments: { op: "job.log", job_id: job.job_id, tail: 20 } },
    ]);
    expect(log.lines.map((l: { text: string }) => l.text).join("")).toContain("sdk ok");
  }, 300_000);

  test("an extension scaffolds from the installed templates and builds against the installed SDK", async () => {
    const proj = join(work, "proj");
    const s = sh(
      [ak, "extension", "scaffold", "--template", "architecture-viewer", "--id", "arch-view"],
      {},
      proj,
    );
    expect(s.out).toContain("valid");
    sh(["git", "add", "-A"], {}, proj);
    sh(
      ["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "ext"],
      {},
      proj,
    );
    const [b] = await mcpSession(proj, [
      {
        name: "ablationkit_do",
        arguments: { op: "extension.build", extension_id: "arch-view" },
      },
    ]);
    expect(b.build, JSON.stringify(b)).toMatchObject({ version: "0.1.0", status: "ready" });
    expect(log).not.toMatch(/EACCES|EROFS/);
  }, 300_000);

  test("install.sh installs, upgrades in place and uninstalls without touching the data", () => {
    const prefix = join(work, "prefix");
    spawnSync("chmod", ["-R", "u+w", out]);
    const i = sh(["sh", join(out, "install.sh"), "--prefix", prefix]);
    expect(i.code, i.out).toBe(0);
    const bin = join(prefix, "bin", "ablationkit");
    expect(sh([bin, "version"]).out).toContain(
      `installed at ${join(prefix, "share", "ablationkit", version(), "lib", "ablationkit")}`,
    );
    const entry = readFileSync(join(prefix, "share/applications/ablationkit.desktop"), "utf8");
    expect(entry).toMatch(/^Exec=env ABLATIONKIT_BUN=\/\S+ \S+\/bin\/ablationkit-desktop$/m);
    expect(sh(["sh", join(out, "install.sh"), "--prefix", prefix]).code).toBe(0);
    const u = sh(["sh", join(out, "install.sh"), "--prefix", prefix, "--uninstall"]);
    expect(u.code).toBe(0);
    expect(existsSync(bin)).toBe(false);
    expect(existsSync(join(prefix, "share", "ablationkit"))).toBe(false);
    expect(existsSync(join(home, "settings.json"))).toBe(true);
  }, 300_000);

  test.skipIf(!Bun.which("makepkg"))(
    "the AUR package builds from the committed tree and its CLI runs",
    () => {
      const aur = join(work, "aur");
      mkdirSync(aur);
      writeFileSync(
        join(aur, "PKGBUILD"),
        readFileSync(join(ROOT, "scripts/packaging/aur/PKGBUILD")),
      );
      const tarball = join(aur, `ablationkit-${version()}.tar.gz`);
      expect(
        sh(["bun", join(ROOT, "scripts/package.ts"), "--source-tarball", tarball], {}, ROOT).code,
      ).toBe(0);
      const m = sh(["makepkg", "--nodeps", "--noconfirm", "--clean"], { PKGDEST: aur }, aur);
      expect(m.code, m.out.slice(-3000)).toBe(0);
      const pkg = join(aur, `ablationkit-${version()}-1-any.pkg.tar.zst`);
      const list = sh(["bsdtar", "-tf", pkg]).out;
      for (const f of [
        "usr/bin/ablationkit",
        "usr/bin/ablationkit-desktop",
        "usr/lib/ablationkit/apps/web/dist/index.html",
        "usr/lib/ablationkit/apps/desktop/dist/main.cjs",
        "usr/lib/ablationkit/packages/tracking-mlflow/env/uv.lock",
        "usr/share/applications/ablationkit.desktop",
        "usr/share/licenses/ablationkit/LICENSE",
      ])
        expect([f, list.includes(`${f}\n`)]).toEqual([f, true]);
      const head = sh(["git", "rev-parse", "HEAD"], {}, ROOT).out.trim();
      const root = join(aur, "root");
      mkdirSync(root);
      expect(sh(["bsdtar", "-xf", pkg, "-C", root]).code).toBe(0);
      const v = sh([join(root, "usr/bin/ablationkit"), "version"]);
      expect(v.out).toContain(
        `ablationkit ${version()} (commit ${head.slice(0, 12)}, installed at ${join(root, "usr/lib/ablationkit")})`,
      );
    },
    600_000,
  );
});
