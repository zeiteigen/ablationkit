/**
 * `ablationkit agent` and `ablationkit mcp --contained` (ADR 0061): the harness binary found on
 * PATH past a version manager's shim, and the contained MCP session reaching the agent API over
 * the session's Unix socket with the token file the coordinator wrote.
 */
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBinary } from "../src/commands/agent.ts";
import { agentApi, ContainedSession } from "../src/commands/mcp.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ak-agent-cli-"));
  dirs.push(d);
  return d;
}

test("findBinary skips a shell shim earlier on PATH and returns the real binary", () => {
  const d = tmp();
  mkdirSync(join(d, "shims"));
  mkdirSync(join(d, "real"));
  writeFileSync(join(d, "shims", "claude"), '#!/bin/sh\nexec mise x -- claude "$@"\n');
  chmodSync(join(d, "shims", "claude"), 0o755);
  symlinkSync(process.execPath, join(d, "real", "claude"));
  expect(findBinary("claude", `${join(d, "shims")}:${join(d, "real")}`)).toBe(process.execPath);
  expect(findBinary("claude", join(d, "shims"))).toBeUndefined();
  expect(findBinary("nope", undefined)).toBeUndefined();
});

test("findBinary skips a multi-call dispatcher (mise's command wrappers) and prefers the tool's own file", () => {
  const d = tmp();
  for (const x of ["bin", "wrappers", "installs", "versions"]) mkdirSync(join(d, x));
  // Small real ELF files with the names that matter.
  copyFileSync("/usr/bin/true", join(d, "bin", "mise"));
  copyFileSync("/usr/bin/true", join(d, "installs", "claude"));
  copyFileSync("/usr/bin/true", join(d, "versions", "2.1.325"));
  chmodSync(join(d, "bin", "mise"), 0o755);
  chmodSync(join(d, "installs", "claude"), 0o755);
  chmodSync(join(d, "versions", "2.1.325"), 0o755);
  symlinkSync(join(d, "bin", "mise"), join(d, "wrappers", "claude"));
  expect(findBinary("claude", join(d, "wrappers"))).toBeUndefined();
  expect(findBinary("claude", `${join(d, "wrappers")}:${join(d, "installs")}`)).toBe(
    join(d, "installs", "claude"),
  );
  // Claude Code's own installer: `claude` links to a binary named after its version.
  mkdirSync(join(d, "local"));
  symlinkSync(join(d, "versions", "2.1.325"), join(d, "local", "claude"));
  expect(findBinary("claude", `${join(d, "wrappers")}:${join(d, "local")}`)).toBe(
    join(d, "versions", "2.1.325"),
  );
});

test("a contained session reads its token file and calls the agent API over the socket", async () => {
  const d = tmp();
  const socket = join(d, "agent.sock");
  const token = `aka_0123456789abcdef.${"x".repeat(43)}`;
  let auth = "";
  const server = Bun.serve({
    unix: socket,
    fetch: (req) => {
      auth = req.headers.get("authorization") ?? "";
      return Response.json({ path: new URL(req.url).pathname });
    },
  });
  try {
    writeFileSync(join(d, "token"), `${token}\n`);
    const s = new ContainedSession({ socket, tokenFile: join(d, "token"), project: "lab" });
    const started = await s.start();
    expect(started).toMatchObject({
      token_id: "0123456789abcdef",
      project_id: "lab",
      agent_api: `unix:${socket}`,
    });
    const api = await s.api();
    expect(await api.request("GET", "/api/v1/whoami")).toEqual({ path: "/api/v1/whoami" });
    expect(auth).toBe(`Bearer ${token}`);
    // The same transport for any `unix:` base.
    expect(await agentApi(`unix:${socket}`, token, "lab").request("GET", "/api/v1/health")).toEqual(
      { path: "/api/v1/health" },
    );
    const gone = new ContainedSession({ socket, tokenFile: join(d, "missing"), project: "lab" });
    await expect(gone.start()).rejects.toThrow("session has ended");
  } finally {
    void server.stop(true);
  }
});
