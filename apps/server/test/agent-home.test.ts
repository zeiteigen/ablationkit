/**
 * The agent's home (ADR 0061, 0063): the coordinator never follows a link the agent left there,
 * neither to read a host file into the home, nor to write, append to or delete one on this machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHome } from "../src/agents/agent-home.ts";
import { ClaudeLoginSync, claudeLoginSource } from "../src/agents/harness-login.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A host directory with a secret in it, and an agent home beside it. */
function world(): { host: string; home: string; secret: string } {
  const root = mkdtempSync(join(tmpdir(), "ak-agent-home-"));
  dirs.push(root);
  const host = join(root, "host");
  const home = join(root, "home");
  mkdirSync(host);
  mkdirSync(home);
  const secret = join(host, "secret.json");
  writeFileSync(secret, '{"secret": "host"}\n');
  return { host, home, secret };
}

const login = (expiresAt: number, refresh = "sk-ant-ort01-a") =>
  `${JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-a",
      refreshToken: refresh,
      expiresAt,
      subscriptionType: "max",
    },
  })}\n`;

describe("AgentHome", () => {
  test("reads, writes and appends regular files, making directories", () => {
    const { home } = world();
    const h = new AgentHome(home);
    expect(h.read(".profile")).toBeUndefined();
    h.append(".profile", "a\n");
    h.append(".profile", "b\n");
    expect(h.read(".profile")).toBe("a\nb\n");
    h.write(".claude/x.json", "{}\n");
    expect(readFileSync(join(home, ".claude", "x.json"), "utf8")).toBe("{}\n");
    expect(lstatSync(join(home, ".claude", "x.json")).mode & 0o777).toBe(0o600);
    expect(h.exists(".claude/x.json")).toBe(true);
    h.remove(".claude/x.json");
    expect(h.exists(".claude/x.json")).toBe(false);
  });

  test("a linked file reads as none, and writing or appending replaces the link", () => {
    const { home, secret } = world();
    const h = new AgentHome(home);
    symlinkSync(secret, join(home, ".claude.json"));
    symlinkSync(secret, join(home, ".profile"));
    expect(h.read(".claude.json")).toBeUndefined();
    h.write(".claude.json", "{}\n");
    h.append(".profile", "export X=1\n");
    expect(readFileSync(secret, "utf8")).toBe('{"secret": "host"}\n');
    expect(lstatSync(join(home, ".claude.json")).isSymbolicLink()).toBe(false);
    expect(h.read(".profile")).toBe("export X=1\n");
  });

  test("a linked directory is never written through, and removing goes nowhere", () => {
    const { host, home, secret } = world();
    const h = new AgentHome(home);
    symlinkSync(host, join(home, ".claude"));
    expect(h.read(".claude/secret.json")).toBeUndefined();
    h.remove(".claude/secret.json");
    expect(existsSync(secret)).toBe(true);
    h.write(".claude/.credentials.json", "x");
    expect(existsSync(join(host, ".credentials.json"))).toBe(false);
    expect(lstatSync(join(home, ".claude")).isDirectory()).toBe(true);
    expect(h.symlink("/nowhere", ".claude/skills/a")).toBe(true);
    expect(existsSync(join(host, "skills"))).toBe(false);
  });

  test("a FIFO does not block a read", () => {
    const { home } = world();
    expect(Bun.spawnSync(["mkfifo", join(home, ".profile")]).exitCode).toBe(0);
    expect(new AgentHome(home).read(".profile")).toBeUndefined();
  });

  test("paths outside the home are refused", () => {
    const { home } = world();
    expect(() => new AgentHome(home).write("../x", "")).toThrow();
  });
});

describe("the Claude login sync in a home the agent linked", () => {
  test("a host file linked as the container's settings is not copied in", () => {
    const { host, home, secret } = world();
    writeFileSync(join(host, ".credentials.json"), login(Date.now() + 3_600_000));
    symlinkSync(secret, join(home, ".claude.json"));
    const sync = new ClaudeLoginSync({
      source: claudeLoginSource(host, "/nonexistent"),
      home,
      checkout: "/work",
      backupDir: join(host, "backups"),
      now: () => new Date(),
      audit: () => {},
    });
    expect(sync.copyIn()).toBe(true);
    const box = readFileSync(join(home, ".claude.json"), "utf8");
    expect(box).not.toContain("secret");
    expect(readFileSync(secret, "utf8")).toBe('{"secret": "host"}\n');
  });

  test("ending a session whose .claude is a link to this machine deletes nothing there", () => {
    const { host, home } = world();
    const creds = join(host, ".credentials.json");
    writeFileSync(creds, login(Date.now() + 3_600_000));
    const sync = new ClaudeLoginSync({
      source: claudeLoginSource(host, "/nonexistent"),
      home,
      checkout: "/work",
      backupDir: join(host, "backups"),
      now: () => new Date(),
      audit: () => {},
    });
    sync.copyIn();
    rmSync(join(home, ".claude"), { recursive: true });
    symlinkSync(host, join(home, ".claude"));
    sync.end();
    expect(existsSync(creds)).toBe(true);
  });
});
