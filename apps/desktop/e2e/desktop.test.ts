/**
 * The desktop shell end to end (spec §2.1, §8.3; ADR 0025) with the system Electron and Playwright:
 *
 * - managed: opens the web UI of a running coordinator through a one-time link from its login
 *   socket; the page has no Node, no preload API and only the notifications permission; other
 *   origins open externally and never in the window; a coordinator notification becomes a desktop
 *   notification;
 * - remote: the connection page (the only page with a preload) takes a URL and a one-time link,
 *   refuses a link for another origin, and opens the coordinator;
 * - managed child: a fresh runtime directory's coordinator is started as a child of the app and
 *   stopped when the app quits.
 *
 * Opt-in: `bun run test:desktop` (ABLATIONKIT_DESKTOP_E2E=1). Needs Electron (`electron43` on Arch,
 * or ABLATIONKIT_ELECTRON) and a display (Wayland/X11, or `xvfb-run`). Builds the web UI and shell.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { type Stack, startStack } from "../../web/e2e/stack.ts";
import { buildDesktop } from "../build.ts";
import { findElectron } from "../src/policy.ts";

// biome-ignore lint/suspicious/noExplicitAny: the page's window inside page.evaluate (no DOM lib here)
type Json = any;

const RUN = process.env["ABLATIONKIT_DESKTOP_E2E"] === "1";
const electronBin = findElectron(process.env, (c) => Bun.which(c));
const display = Boolean(process.env["DISPLAY"] || process.env["WAYLAND_DISPLAY"]);
if (RUN && (!electronBin || !display))
  console.error(
    `desktop e2e skipped: ${!electronBin ? "no Electron (install electron43 or set ABLATIONKIT_ELECTRON)" : "no display (run under xvfb-run)"}`,
  );
const dirs: string[] = [];
const apps: ElectronApplication[] = [];
let stack: Stack;
let mainCjs = "";

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function launch(config: Record<string, unknown>): Promise<ElectronApplication> {
  const dir = tmp("ak-desk-");
  const cfg = join(dir, "desktop.json");
  writeFileSync(cfg, JSON.stringify({ schema_version: 1, ...config }));
  const app = await _electron.launch({
    executablePath: electronBin as string,
    args: [mainCjs],
    env: {
      ...(process.env as Record<string, string>),
      ABLATIONKIT_DESKTOP_CONFIG: cfg,
      ABLATIONKIT_DESKTOP_USER_DATA: join(dir, "profile"),
      ABLATIONKIT_DESKTOP_NO_EXTERNAL: "1",
      ABLATIONKIT_NOTIFY: "0",
    },
    timeout: 60_000,
  });
  apps.push(app);
  return app;
}

/** The window whose URL matches, once it exists. */
async function windowAt(app: ElectronApplication, re: RegExp): Promise<Page> {
  const end = Date.now() + 60_000;
  for (;;) {
    const w = app.windows().find((p) => re.test(p.url()));
    if (w) return w;
    if (Date.now() > end)
      throw new Error(`no window at ${re}: ${app.windows().map((p) => p.url())}`);
    await Bun.sleep(100);
  }
}

describe.skipIf(!RUN || !electronBin || !display)("desktop shell (Electron)", () => {
  beforeAll(async () => {
    const { buildWeb } = await import("../../web/build.ts");
    await buildWeb();
    mainCjs = await buildDesktop();
    stack = await startStack();
  }, 300_000);

  afterAll(async () => {
    for (const a of apps.splice(0)) await a.close().catch(() => {});
    await stack?.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("managed: the web UI of a running coordinator, sandboxed, with no Node, no preload API and only notifications", async () => {
    const home = stack.coordinator.services.paths.home;
    const app = await launch({ mode: "managed", home });
    const page = await windowAt(app, new RegExp(`^${stack.origin}/`));
    await page.getByTestId("statusbar").waitFor({ timeout: 60_000 });
    await page.locator("main").getByText("Demo model").first().waitFor();

    // The renderer has no Node and no desktop API.
    expect(
      await page.evaluate(() => {
        const g = globalThis as Record<string, unknown>;
        return [typeof g["require"], typeof g["process"], typeof g["ablationkitDesktop"]];
      }),
    ).toEqual(["undefined", "undefined", "undefined"]);
    const prefs = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w: Json) => {
        // Electron's own record of the preferences the page runs with (not in its public typings).
        const wc = w.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> };
        const p = wc.getLastWebPreferences();
        return [
          p["contextIsolation"],
          p["nodeIntegration"],
          p["sandbox"],
          p["webSecurity"],
          p["preload"] ?? null,
        ];
      }),
    );
    expect(prefs).toEqual([[true, false, true, true, null]]);

    // Another origin never loads in the window; links to it go to the system browser.
    const before = app.windows().length;
    expect(
      await page.evaluate(() => (globalThis as Json).open("https://example.com/paper") === null),
    ).toBe(true);
    await page.evaluate(() => {
      (globalThis as Json).location.href = "https://example.com/elsewhere";
    });
    await Bun.sleep(500);
    expect(page.url().startsWith(stack.origin)).toBe(true);
    expect(app.windows().length).toBe(before);
    const opened = await app.evaluate(
      () =>
        (globalThis as unknown as { __ablationkitExternalOpens: string[] })
          .__ablationkitExternalOpens,
    );
    expect(opened).toEqual(["https://example.com/paper", "https://example.com/elsewhere"]);

    // Notifications are the only web permission.
    expect(await page.evaluate(() => (globalThis as Json).Notification.requestPermission())).toBe(
      "granted",
    );
    expect(
      await page.evaluate(() =>
        (globalThis as Json).navigator.mediaDevices
          .getUserMedia({ video: true })
          .then(() => "granted")
          .catch((e: Error) => e.name),
      ),
    ).not.toBe("granted");

    // A coordinator notification becomes a desktop notification (the API is observed in-page).
    await page.evaluate(() => {
      (globalThis as Json).localStorage.setItem("ablationkit.notifications", "on");
      const shown: unknown[] = [];
      (globalThis as Json).__shown = shown;
      const Real = (globalThis as Json).Notification;
      class Spy {
        static get permission() {
          return Real.permission;
        }
        onclick: (() => void) | null = null;
        constructor(title: string, opts: { body?: string; tag?: string }) {
          shown.push({ title, body: opts.body, tag: opts.tag });
        }
        close() {}
      }
      (globalThis as Json).Notification = Spy;
    });
    stack.coordinator.services.notifier.notify({
      key: "appr:desk",
      title: "Deployment approval requested",
      body: "desk: cost",
      urgency: "critical",
      project_id: stack.projectId,
      link: `/p/${stack.projectId}`,
    });
    const end = Date.now() + 10_000;
    let shown: unknown[] = [];
    while (Date.now() < end) {
      shown = await page.evaluate(
        () => (globalThis as unknown as Record<string, unknown[]>)["__shown"] ?? [],
      );
      if (shown.length) break;
      await Bun.sleep(100);
    }
    expect(shown).toEqual([
      { title: "Deployment approval requested", body: "desk: cost", tag: "appr:desk" },
    ]);
    await app.close();
  }, 180_000);

  test("remote: the connection page takes a URL and a one-time link, refuses another origin's link, and opens the coordinator", async () => {
    const app = await launch({ mode: "remote" });
    const connect = await windowAt(app, /connect\.html/);
    // Only this local page has the desktop API.
    expect(
      await connect.evaluate(
        () => typeof (globalThis as Record<string, unknown>)["ablationkitDesktop"],
      ),
    ).toBe("object");
    await connect.locator('input[name="mode"][value="remote"]').check();
    await connect.locator("#remote_url").fill(stack.origin);
    await connect.locator("#link").fill("http://localhost:1/login?code=abc");
    await connect.getByRole("button", { name: "Connect" }).click();
    await connect
      .getByRole("alert")
      .getByText(/the login link is for http:\/\/localhost:1/)
      .waitFor();

    await connect.locator("#link").fill(await stack.loginUrl());
    await connect.getByRole("button", { name: "Connect" }).click();
    const page = await windowAt(app, new RegExp(`^${stack.origin}/(?!login)`));
    await page.getByTestId("statusbar").waitFor({ timeout: 60_000 });
    await page.locator("main").getByText("Demo model").first().waitFor();
    expect(
      await page.evaluate(
        () => typeof (globalThis as Record<string, unknown>)["ablationkitDesktop"],
      ),
    ).toBe("undefined");
    await app.close();
  }, 180_000);

  test("managed child: a fresh runtime directory's coordinator starts with the app and stops when it quits", async () => {
    const home = tmp("ak-desk-home-");
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({
        schema_version: 1,
        human: { host: "127.0.0.1", port: 0 },
        agent: { host: "127.0.0.1", port: 0 },
        worker: { host: "127.0.0.1", port: 0 },
        mlflow: { enabled: false },
      }),
    );
    const app = await launch({ mode: "managed", home, launch: "child" });
    const page = await windowAt(app, /^http:\/\/localhost:\d+\//);
    await page.getByTestId("statusbar").waitFor({ timeout: 90_000 });
    expect(existsSync(join(home, "run", "login.sock"))).toBe(true);
    await app.close();
    const end = Date.now() + 20_000;
    while (existsSync(join(home, "run", "login.sock")) && Date.now() < end) await Bun.sleep(100);
    expect(existsSync(join(home, "run", "login.sock"))).toBe(false);
  }, 180_000);
});
