/**
 * The egress proxy of agent and job containers (ADR 0061): CONNECT tunnels and plain HTTP to
 * allowed hosts, refusals recorded with their reason, no connection to an address that is not
 * public, and credential routes that add the secret on the way out.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerCredential, EgressRecord } from "@ablationkit/protocol";
import { CredentialProxy, EgressProxy, publicAddress } from "../src/agents/egress.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "ak-egress-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A TCP server that answers one HTTP request with `body`, and remembers what it was sent. */
async function upstream(body: string): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const server: Server = createServer((s) => {
    let buf = "";
    s.on("data", (c) => {
      buf += c.toString();
      if (buf.includes("\r\n\r\n")) {
        seen.push(buf);
        s.end(
          `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanup.push(() => server.close());
  return { port: (server.address() as { port: number }).port, seen };
}

/** Send `request` through the proxy's socket; the whole reply. */
function through(socket: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect(socket);
    let out = "";
    c.on("data", (d) => {
      out += d.toString();
    });
    c.on("end", () => resolve(out));
    c.on("error", reject);
    c.write(request);
  });
}

function proxy(opts: { allow: string[]; isPublic?: boolean }) {
  const records: EgressRecord[] = [];
  const socket = join(dir(), "egress.sock");
  const p = new EgressProxy({
    socket,
    owner: "c-0123456789ab",
    allowed: (host) =>
      opts.allow.includes(host) ? { ok: true } : { ok: false, reason: `${host} is not allowed` },
    record: (r) => records.push(r),
    now: () => new Date(),
    resolve: async () => ["127.0.0.1"],
    ...(opts.isPublic ? { isPublic: () => true } : {}),
  });
  cleanup.push(() => p.stop());
  return { p, socket, records };
}

const settle = () => Bun.sleep(50);

describe("egress proxy", () => {
  test("a CONNECT tunnel to an allowed host carries the bytes and is recorded", async () => {
    const up = await upstream("hello");
    const { p, socket, records } = proxy({ allow: ["pypi.org"], isPublic: true });
    await p.start();
    const reply = await through(
      socket,
      `CONNECT pypi.org:${up.port} HTTP/1.1\r\nHost: pypi.org\r\n\r\nGET /simple/ HTTP/1.1\r\nHost: pypi.org\r\n\r\n`,
    );
    expect(reply).toStartWith("HTTP/1.1 200 Connection Established");
    expect(reply).toContain("hello");
    expect(up.seen[0]).toStartWith("GET /simple/ HTTP/1.1");
    await settle();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "connect", host: "pypi.org", outcome: "allowed" });
    expect(records[0]?.bytes_down).toBeGreaterThan(0);
  });

  test("plain HTTP is rewritten to origin form without proxy headers, path recorded", async () => {
    const up = await upstream("ok");
    const { p, socket, records } = proxy({ allow: ["example.org"], isPublic: true });
    await p.start();
    const reply = await through(
      socket,
      `GET http://example.org:${up.port}/a/b?token=secret HTTP/1.1\r\nHost: example.org\r\nProxy-Authorization: x\r\n\r\n`,
    );
    expect(reply).toContain("200 OK");
    expect(up.seen[0]).toStartWith("GET /a/b?token=secret HTTP/1.1");
    expect(up.seen[0]).not.toContain("Proxy-Authorization");
    await settle();
    // The query string is not recorded.
    expect(records[0]).toMatchObject({
      kind: "http",
      method: "GET",
      path: "/a/b",
      outcome: "allowed",
    });
  });

  test("a host off the allowlist is refused with the reason, and recorded", async () => {
    const { p, socket, records } = proxy({ allow: [] });
    await p.start();
    const reply = await through(socket, "CONNECT evil.example:443 HTTP/1.1\r\n\r\n");
    expect(reply).toStartWith("HTTP/1.1 403");
    expect(reply).toContain("evil.example is not allowed");
    expect(records[0]).toMatchObject({ host: "evil.example", outcome: "denied" });
  });

  test("an allowed name that resolves to this machine is refused", async () => {
    const { p, socket, records } = proxy({ allow: ["sneaky.example"] });
    await p.start();
    const reply = await through(socket, "CONNECT sneaky.example:443 HTTP/1.1\r\n\r\n");
    expect(reply).toStartWith("HTTP/1.1 403");
    expect(reply).toContain("not public");
    expect(records[0]?.outcome).toBe("denied");
    expect(await publicAddress("x", async () => ["10.0.0.1", "8.8.8.8"])).toEqual({
      ip: "8.8.8.8",
    });
  });

  test("garbage is a 400", async () => {
    const { p, socket } = proxy({ allow: [] });
    await p.start();
    expect(await through(socket, "HELLO\r\n\r\n")).toStartWith("HTTP/1.1 400");
    expect(await through(socket, "GET /relative HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 400");
  });
});

describe("credential routes", () => {
  test("the secret is added on the way out and never comes from the container", async () => {
    let got: Headers | undefined;
    let path = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        got = req.headers;
        path = new URL(req.url).pathname + new URL(req.url).search;
        return new Response("model");
      },
    });
    cleanup.push(() => void server.stop(true));
    process.env["AK_TEST_HF_TOKEN"] = "hf_secret";
    cleanup.push(() => delete process.env["AK_TEST_HF_TOKEN"]);
    const cred: ContainerCredential = {
      name: "hf",
      upstream: `http://127.0.0.1:${server.port}`,
      header: "authorization",
      prefix: "Bearer ",
      from_env: "AK_TEST_HF_TOKEN",
      env: { HF_ENDPOINT: "{url}" },
    };
    const records: EgressRecord[] = [];
    const socket = join(dir(), "creds.sock");
    const p = new CredentialProxy({
      socket,
      owner: "c-0123456789ab",
      credentials: () => [cred],
      record: (r) => records.push(r),
      now: () => new Date(),
    });
    p.start();
    cleanup.push(() => p.stop());
    const r = await fetch("http://localhost/hf/api/models?x=1", {
      unix: socket,
      headers: { authorization: "Bearer from-the-container" },
    } as RequestInit);
    expect(await r.text()).toBe("model");
    expect(got?.get("authorization")).toBe("Bearer hf_secret");
    expect(path).toBe("/api/models?x=1");
    expect(records[0]).toMatchObject({
      kind: "credential",
      credential: "hf",
      status: 200,
      path: "/api/models",
    });
    const missing = await fetch("http://localhost/nope/x", { unix: socket } as RequestInit);
    expect(missing.status).toBe(404);
  });
});
