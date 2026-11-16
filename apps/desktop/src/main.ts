/**
 * The AblationKit desktop shell (spec §2.1 desktop mode, §8.3; ADR 0025). Electron's main process
 * runs in Electron's own Node.js; the coordinator stays a separate Bun process. The window shows
 * the same web UI the browser does, served by the coordinator:
 *
 * - managed: the coordinator of a runtime directory on this machine. If it is not running the app
 *   starts it (the systemd user service, or a child process it stops on quit), then logs in with a
 *   one-time link from the local login socket, exactly as `ablationkit ui` does;
 * - remote: a coordinator elsewhere, over HTTPS (the tailnet) or loopback, logged in with a
 *   one-time link made on the workstation (`ablationkit login --origin URL`).
 *
 * Every window is sandboxed with context isolation and no Node; the coordinator's pages get no
 * preload and no IPC. Only the local connection page has a preload, exposing three calls. Pages
 * stay on the coordinator's origin; other links open in the system browser; the only web
 * permission granted is notifications, to the coordinator's own pages.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  type Session,
  session,
  shell,
  type WebContents,
} from "electron";
import {
  checkLoginLink,
  checkRemoteUrl,
  cliArgv,
  configPath,
  DEFAULT_CONFIG,
  type DesktopConfig,
  loadConfig,
  managedHome,
  navigationAllowed,
  openExternally,
  permissionAllowed,
  SECURE_WEB_PREFERENCES,
  saveConfig,
} from "./policy.ts";

const env = process.env;
/**
 * Where this bundle runs from (`apps/desktop/dist/`). Resolved at run time: the bundler fixes
 * `__dirname` to the source directory.
 */
const HERE = (() => {
  const main = process.argv.find((a) => a.endsWith("main.cjs"));
  return main ? dirname(resolve(main)) : app.getAppPath();
})();
/** `apps/desktop/dist/main.cjs` → the checkout root. */
const REPO_ROOT = resolve(HERE, "../../..");
const STATIC = join(HERE, "static");
const PARTITION = "persist:ablationkit";
const DEVTOOLS = env["ABLATIONKIT_DESKTOP_DEVTOOLS"] === "1";
/** Tests record external opens instead of launching a browser. */
const NO_EXTERNAL = env["ABLATIONKIT_DESKTOP_NO_EXTERNAL"] === "1";

let coordinator: string | undefined;
let mainWindow: BrowserWindow | undefined;
let connectWindow: BrowserWindow | undefined;
let child: ChildProcess | undefined;
let config: DesktopConfig;
const externalOpens: string[] = [];
(globalThis as Record<string, unknown>)["__ablationkitExternalOpens"] = externalOpens;

// A separate profile (tests, or a second desktop for another coordinator): cookies and the
// single-instance lock live there.
if (env["ABLATIONKIT_DESKTOP_USER_DATA"])
  app.setPath("userData", env["ABLATIONKIT_DESKTOP_USER_DATA"]);
app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();

/** Electron's and Bun's Node typings disagree about ChildProcess; it is an EventEmitter. */
const events = (c: unknown): EventEmitter => c as EventEmitter;

// ------------------------------------------------------------------ the login socket (managed)

function socketCall(
  home: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((ok, fail) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath: join(home, "run", "login.sock"),
        path,
        method: data === undefined ? "GET" : "POST",
        headers: data === undefined ? {} : { "content-type": "application/json" },
        timeout: 5000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
        });
        res.on("end", () => {
          try {
            ok({ status: res.statusCode ?? 0, json: JSON.parse(text || "{}") });
          } catch (e) {
            fail(e);
          }
        });
      },
    );
    req.on("error", fail);
    req.on("timeout", () => req.destroy(new Error("login socket timed out")));
    req.end(data);
  });
}

async function healthy(home: string): Promise<boolean> {
  try {
    return (await socketCall(home, "/health")).status === 200;
  } catch {
    return false;
  }
}

function runCli(args: string[], home: string): { code: number; out: string } {
  const [bin, ...rest] = cliArgv(env, REPO_ROOT);
  const p = spawnSync(bin as string, [...rest, ...args], {
    env: { ...env, ABLATIONKIT_HOME: home },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: p.status ?? -1, out: `${p.stdout ?? ""}${p.stderr ?? ""}`.trim() };
}

function startChild(home: string, safeMode: boolean): void {
  const [bin, ...rest] = cliArgv(env, REPO_ROOT);
  const args = [
    ...rest,
    "coordinator",
    "start",
    "--foreground",
    ...(safeMode ? ["--safe-mode"] : []),
  ];
  let log = "";
  const c = spawn(bin as string, args, {
    env: { ...env, ABLATIONKIT_HOME: home },
    stdio: ["ignore", "ignore", "pipe"],
  });
  c.stderr?.on("data", (d: Buffer) => {
    log = `${log}${d.toString()}`.slice(-4000);
  });
  events(c).on("exit", (code: number | null) => {
    if (child === c) child = undefined;
    if (code !== 0 && code !== null && app.isReady())
      showConnect(`the coordinator exited with status ${code}:\n${log.trim().slice(-1500)}`);
  });
  child = c;
}

async function ensureManaged(home: string, safeMode = false): Promise<void> {
  if (await healthy(home)) return;
  if ((config.launch ?? "service") === "child") startChild(home, safeMode);
  else {
    const r = runCli(["coordinator", "start", ...(safeMode ? ["--safe-mode"] : [])], home);
    if (r.code !== 0) throw new Error(`could not start the coordinator:\n${r.out}`);
  }
  const end = Date.now() + 90_000;
  while (!(await healthy(home))) {
    if (Date.now() > end) throw new Error(`the coordinator for ${home} did not start in time`);
    if ((config.launch ?? "service") === "child" && !child)
      throw new Error("the coordinator process exited during start (see the connection page)");
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function openManaged(): Promise<void> {
  const home = managedHome(config, env);
  await ensureManaged(home);
  const r = await socketCall(home, "/login", {});
  if (r.status !== 200)
    throw new Error(`login failed: ${String((r.json["error"] as { message?: string })?.message)}`);
  coordinator = String(r.json["origin"]);
  await win().loadURL(String(r.json["url"]));
}

async function openRemote(link?: string): Promise<void> {
  if (!config.remote_url) throw new Error("no remote coordinator URL is configured");
  coordinator = checkRemoteUrl(config.remote_url);
  await win().loadURL(link ? checkLoginLink(link, coordinator) : `${coordinator}/`);
}

async function open(link?: string): Promise<void> {
  try {
    if (config.mode === "remote") await openRemote(link);
    else await openManaged();
    // Show first: closing the connection page with no visible window quits the app.
    mainWindow?.show();
    connectWindow?.close();
  } catch (e) {
    showConnect((e as Error).message);
  }
}

// ------------------------------------------------------------------ windows

/** Links to other sites open in the system browser (tests only record them). */
function openOutside(url: string): void {
  if (!openExternally(url, coordinator)) return;
  externalOpens.push(url);
  if (!NO_EXTERNAL) void shell.openExternal(url);
}

function guard(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (navigationAllowed(url, coordinator))
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { ...SECURE_WEB_PREFERENCES, partition: PARTITION },
        },
      };
    openOutside(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (wc === connectWindow?.webContents) {
      if (!url.startsWith("file://")) e.preventDefault();
      return;
    }
    if (!navigationAllowed(url, coordinator)) {
      e.preventDefault();
      openOutside(url);
    }
  });
  wc.on("will-redirect", (e, url) => {
    if (wc !== connectWindow?.webContents && !navigationAllowed(url, coordinator))
      e.preventDefault();
  });
  wc.on("will-attach-webview", (e) => e.preventDefault());
}

function harden(s: Session): void {
  s.setPermissionRequestHandler((_wc, permission, cb, details) =>
    cb(permissionAllowed(permission, details.requestingUrl, coordinator)),
  );
  s.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    permissionAllowed(permission, requestingOrigin, coordinator),
  );
  s.setDevicePermissionHandler(() => false);
}

function win(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    show: false,
    title: "AblationKit",
    backgroundColor: "#111214",
    webPreferences: { ...SECURE_WEB_PREFERENCES, partition: PARTITION, devTools: DEVTOOLS },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  return mainWindow;
}

function showConnect(error?: string): void {
  if (connectWindow && !connectWindow.isDestroyed()) {
    connectWindow.webContents.send("desktop:error", error ?? "");
    connectWindow.focus();
    return;
  }
  connectWindow = new BrowserWindow({
    width: 620,
    height: 640,
    title: "Connect to a coordinator",
    autoHideMenuBar: true,
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      // A separate in-memory session: the connection page never shares cookies with the UI.
      partition: "ablationkit-connect",
      preload: join(HERE, "connect-preload.cjs"),
      devTools: DEVTOOLS,
    },
  });
  const query = error ? { error } : undefined;
  void connectWindow.loadFile(join(STATIC, "connect.html"), query ? { query } : {});
  connectWindow.on("closed", () => {
    connectWindow = undefined;
    if (!mainWindow?.isVisible()) app.quit();
  });
}

// ------------------------------------------------------------------ connection page IPC

/** IPC answers only the connection page, never the coordinator's pages. */
function fromConnect(e: IpcMainInvokeEvent): void {
  if (!connectWindow || e.sender !== connectWindow.webContents)
    throw new Error("not the connection page");
}

ipcMain.handle("desktop:config", (e) => {
  fromConnect(e);
  return { config, home: managedHome(config, env), path: configPath(env) };
});

ipcMain.handle("desktop:connect", async (e, input: unknown) => {
  fromConnect(e);
  const i = (input ?? {}) as Record<string, unknown>;
  const mode = i["mode"] === "remote" ? "remote" : "managed";
  const next: DesktopConfig =
    mode === "remote"
      ? { schema_version: 1, mode, remote_url: checkRemoteUrl(String(i["remote_url"] ?? "")) }
      : {
          schema_version: 1,
          mode,
          ...(typeof i["home"] === "string" && i["home"].trim() ? { home: i["home"].trim() } : {}),
          launch: i["launch"] === "child" ? "child" : "service",
        };
  const link = typeof i["link"] === "string" && i["link"].trim() ? i["link"] : undefined;
  if (mode === "remote" && link) checkLoginLink(link, next.remote_url as string);
  saveConfig(configPath(env), next);
  config = next;
  await open(link);
  return { ok: true };
});

// ------------------------------------------------------------------ menu

async function restartManaged(safeMode: boolean): Promise<void> {
  const home = managedHome(config, env);
  try {
    if ((config.launch ?? "service") === "child") {
      const c = child;
      if (c) {
        const exited = new Promise((r) => events(c).once("exit", r));
        c.kill("SIGTERM");
        await exited;
      }
    } else {
      const r = runCli(["coordinator", "stop"], home);
      if (r.code !== 0) throw new Error(r.out);
      const end = Date.now() + 30_000;
      while ((await healthy(home)) && Date.now() < end)
        await new Promise((r) => setTimeout(r, 200));
    }
    await ensureManaged(home, safeMode);
    await open();
  } catch (e) {
    showConnect((e as Error).message);
  }
}

function menu(): void {
  const managed = config.mode === "managed";
  const template: MenuItemConstructorOptions[] = [
    {
      label: "AblationKit",
      submenu: [
        { label: "Connection…", click: () => showConnect() },
        { type: "separator" },
        {
          label: "Restart the coordinator",
          enabled: managed,
          click: () => void restartManaged(false),
        },
        {
          label: "Restart in safe mode (extensions off)",
          enabled: managed,
          click: () => void restartManaged(true),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(DEVTOOLS ? [{ role: "toggleDevTools" } as MenuItemConstructorOptions] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------ lifecycle

app.on("web-contents-created", (_e, wc) => guard(wc));

app.on("second-instance", () => {
  const w = mainWindow ?? connectWindow;
  if (w) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  // A child coordinator belongs to this app; the systemd service keeps running.
  child?.kill("SIGTERM");
});

void app.whenReady().then(async () => {
  try {
    config = loadConfig(configPath(env));
  } catch (e) {
    dialog.showErrorBox("AblationKit", `${configPath(env)}: ${(e as Error).message}`);
    config = DEFAULT_CONFIG;
  }
  harden(session.fromPartition(PARTITION));
  harden(session.fromPartition("ablationkit-connect"));
  menu();
  if (config.mode === "remote" && !config.remote_url) showConnect();
  else await open();
});
