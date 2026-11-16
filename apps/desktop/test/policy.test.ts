/** The desktop shell's rules without Electron (spec §2.1, §8.3; ADR 0025). */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLoginLink,
  checkRemoteUrl,
  configPath,
  DEFAULT_CONFIG,
  findElectron,
  loadConfig,
  managedHome,
  navigationAllowed,
  openExternally,
  permissionAllowed,
  SECURE_WEB_PREFERENCES,
  saveConfig,
} from "../src/policy.ts";

const ORIGIN = "https://ws.tail1234.ts.net";

describe("desktop policy", () => {
  test("config: defaults to managed, round-trips, and refuses invalid files", () => {
    const d = mkdtempSync(join(tmpdir(), "ak-desk-"));
    try {
      const p = join(d, "nested", "desktop.json");
      expect(loadConfig(p)).toEqual(DEFAULT_CONFIG);
      saveConfig(p, { schema_version: 1, mode: "remote", remote_url: ORIGIN });
      expect(loadConfig(p)).toEqual({ schema_version: 1, mode: "remote", remote_url: ORIGIN });
      writeFileSync(
        p,
        JSON.stringify({ schema_version: 1, mode: "remote", remote_url: "http://evil.example" }),
      );
      expect(() => loadConfig(p)).toThrow();
      expect(() =>
        saveConfig(p, { schema_version: 1, mode: "managed", launch: "detached" as never }),
      ).toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
    expect(configPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/ablationkit/desktop.json");
    expect(configPath({ ABLATIONKIT_DESKTOP_CONFIG: "/c.json" })).toBe("/c.json");
    expect(managedHome({ schema_version: 1, mode: "managed" }, { ABLATIONKIT_HOME: "/h" })).toBe(
      "/h",
    );
    expect(
      managedHome({ schema_version: 1, mode: "managed", home: "/k" }, { ABLATIONKIT_HOME: "/h" }),
    ).toBe("/k");
  });

  test("remote URLs are HTTPS, or http on loopback; login links must be the coordinator's own", () => {
    expect(checkRemoteUrl(`${ORIGIN}/`)).toBe(ORIGIN);
    expect(checkRemoteUrl("http://localhost:7420")).toBe("http://localhost:7420");
    expect(() => checkRemoteUrl("http://100.64.0.2:7420")).toThrow(/HTTPS/);
    expect(() => checkRemoteUrl("https://u:p@ws.example")).toThrow(/credentials/);
    expect(checkLoginLink(`${ORIGIN}/login?code=abc`, ORIGIN)).toBe(`${ORIGIN}/login?code=abc`);
    expect(() => checkLoginLink("https://evil.example/login?code=abc", ORIGIN)).toThrow(/is for/);
    expect(() => checkLoginLink(`${ORIGIN}/projects?code=abc`, ORIGIN)).toThrow(/not a login link/);
    expect(() => checkLoginLink(`${ORIGIN}/login`, ORIGIN)).toThrow(/not a login link/);
  });

  test("navigation stays on the coordinator; other http(s) links open externally; nothing else does", () => {
    expect(navigationAllowed(`${ORIGIN}/p/lab/runs`, ORIGIN)).toBe(true);
    expect(navigationAllowed("https://example.com/", ORIGIN)).toBe(false);
    expect(navigationAllowed(`${ORIGIN}/`, undefined)).toBe(false);
    expect(openExternally("https://arxiv.org/abs/1", ORIGIN)).toBe(true);
    expect(openExternally(`${ORIGIN}/x`, ORIGIN)).toBe(false);
    for (const u of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "smb://share/x",
      "data:text/html,x",
    ])
      expect(openExternally(u, ORIGIN)).toBe(false);
  });

  test("only notifications (and sanitized clipboard writes) for the coordinator's own pages", () => {
    expect(permissionAllowed("notifications", `${ORIGIN}/p/lab`, ORIGIN)).toBe(true);
    expect(permissionAllowed("clipboard-sanitized-write", `${ORIGIN}/`, ORIGIN)).toBe(true);
    for (const p of [
      "media",
      "geolocation",
      "clipboard-read",
      "midi",
      "hid",
      "serial",
      "usb",
      "openExternal",
    ])
      expect(permissionAllowed(p, `${ORIGIN}/`, ORIGIN)).toBe(false);
    // An extension frame has an opaque origin ("null"); another site is not the coordinator.
    expect(permissionAllowed("notifications", "null", ORIGIN)).toBe(false);
    expect(permissionAllowed("notifications", "https://example.com/", ORIGIN)).toBe(false);
    expect(permissionAllowed("notifications", `${ORIGIN}/`, undefined)).toBe(false);
  });

  test("every window is sandboxed, isolated and without Node", () => {
    expect(SECURE_WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });
    expect(findElectron({ ABLATIONKIT_ELECTRON: "/opt/e" }, () => null)).toBe("/opt/e");
    expect(findElectron({}, (c) => (c === "electron43" ? "/usr/bin/electron43" : null))).toBe(
      "/usr/bin/electron43",
    );
    expect(findElectron({}, () => null)).toBeUndefined();
  });
});
