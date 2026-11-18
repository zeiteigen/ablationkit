/**
 * The egress proxy of an agent or job container (ADR 0061). A container has no network of its
 * own: its init forwards `127.0.0.1:3128` to this proxy's Unix socket, mounted read-only into it.
 * The proxy speaks HTTP `CONNECT` (HTTPS tunnels: only the host is known) and absolute-form plain
 * HTTP requests (one request per connection), looks the host up itself and connects only to
 * public addresses, asks `allowed` each time (so an allowlist change applies at once), and records
 * every connection, allowed or refused, as an `EgressRecord`.
 *
 * Credential routes (`CredentialProxy`) are a second socket: the container calls
 * `http://127.0.0.1:3129/<name>/…`, and the proxy forwards it to the credential's upstream with the
 * secret in the configured header, so the secret never enters the container.
 */
import { lookup } from "node:dns/promises";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { isPublicAddress, normalizeHost, validHost } from "@ablationkit/agent-containers";
import type { ContainerCredential, EgressRecord } from "@ablationkit/protocol";

const MAX_HEADER = 32 * 1024;
const IDLE_MS = 30 * 60 * 1000;

export type EgressDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface EgressProxyOptions {
  readonly socket: string;
  /** The container session or attempt the connections come from. */
  readonly owner: string;
  readonly allowed: (host: string, port: number) => EgressDecision;
  readonly record: (r: EgressRecord) => void;
  readonly now: () => Date;
  /** Resolve a host to its addresses (tests give their own). */
  readonly resolve?: (host: string) => Promise<string[]>;
  /** Which addresses may be connected to: public ones only, except in tests. */
  readonly isPublic?: (ip: string) => boolean;
}

async function defaultResolve(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  const all = await lookup(host, { all: true, verbatim: true });
  return all.map((a) => a.address);
}

/** The first public address of `host`, or why there is none. */
export async function publicAddress(
  host: string,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
  isPublic: (ip: string) => boolean = isPublicAddress,
): Promise<{ ip: string } | { reason: string }> {
  let ips: string[];
  try {
    ips = await resolve(host);
  } catch (e) {
    return { reason: `cannot resolve ${host}: ${(e as Error).message}` };
  }
  const ip = ips.find(isPublic);
  if (ip) return { ip };
  return {
    reason: `${host} resolves only to addresses that are not public (${ips.join(", ") || "none"}): containers never reach this machine or the local network`,
  };
}

function headerEnd(buf: Buffer): number {
  return buf.indexOf("\r\n\r\n");
}

function refuse(client: Socket, status: number, text: string, message: string): void {
  const body = `${message}\n`;
  client.end(
    `HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

function hostPort(target: string, defaultPort: number): { host: string; port: number } | undefined {
  const m = /^([^:/\s]+)(?::([0-9]{1,5}))?$/.exec(target);
  if (!m) return undefined;
  const port = m[2] === undefined ? defaultPort : Number(m[2]);
  if (port < 1 || port > 65535) return undefined;
  return { host: normalizeHost(m[1] as string), port };
}

export class EgressProxy {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly o: EgressProxyOptions) {}

  start(): Promise<void> {
    rmSync(this.o.socket, { force: true });
    const server = createServer((client) => this.handle(client));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.socket, () => {
        server.off("error", reject);
        chmodSync(this.o.socket, 0o600);
        resolve();
      });
    });
  }

  stop(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = undefined;
    rmSync(this.o.socket, { force: true });
  }

  private base(kind: EgressRecord["kind"], host: string, port: number): EgressRecord {
    return {
      schema_version: 1,
      at: this.o.now().toISOString(),
      owner: this.o.owner,
      kind,
      host: host.slice(0, 260),
      port,
      outcome: "allowed",
    };
  }

  private handle(client: Socket): void {
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => client.destroy());
    client.setTimeout(IDLE_MS, () => client.destroy());
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = headerEnd(buf);
      if (end < 0) {
        if (buf.length > MAX_HEADER) {
          client.off("data", onData);
          refuse(client, 431, "Request Header Fields Too Large", "request header too large");
        }
        return;
      }
      client.off("data", onData);
      client.pause();
      void this.route(client, buf.subarray(0, end).toString("latin1"), buf.subarray(end + 4));
    };
    client.on("data", onData);
  }

  private async route(client: Socket, head: string, rest: Buffer): Promise<void> {
    const lines = head.split("\r\n");
    const [method = "", target = "", version = ""] = (lines[0] ?? "").split(" ");
    if (!/^HTTP\/1\.[01]$/.test(version)) {
      refuse(client, 400, "Bad Request", "not an HTTP/1.x proxy request");
      return;
    }
    if (method === "CONNECT") {
      const hp = hostPort(target, 443);
      if (!hp || !validHost(hp.host)) {
        refuse(client, 400, "Bad Request", `CONNECT to an invalid host: ${target.slice(0, 200)}`);
        return;
      }
      await this.tunnel(client, hp.host, hp.port, rest, undefined);
      return;
    }
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      refuse(
        client,
        400,
        "Bad Request",
        "only CONNECT and absolute-form http:// requests go through this proxy",
      );
      return;
    }
    if (url.protocol !== "http:") {
      refuse(client, 400, "Bad Request", `use CONNECT for ${url.protocol} URLs`);
      return;
    }
    const host = normalizeHost(url.hostname);
    const port = url.port ? Number(url.port) : 80;
    if (!validHost(host)) {
      refuse(client, 400, "Bad Request", `invalid host ${host.slice(0, 200)}`);
      return;
    }
    // One request per connection, to the host that was checked: its Host is that host, its body
    // is what Content-Length says, and nothing the client sends after it reaches the upstream.
    const fields = lines.slice(1);
    if (fields.some((l) => /[\r\n]/.test(l))) {
      refuse(client, 400, "Bad Request", "a header line with a bare CR or LF");
      return;
    }
    if (fields.some((l) => /^transfer-encoding\s*:/i.test(l))) {
      refuse(client, 411, "Length Required", "plain HTTP through this proxy needs Content-Length");
      return;
    }
    const lengths = fields
      .filter((l) => /^content-length\s*:/i.test(l))
      .map((l) => l.slice(l.indexOf(":") + 1).trim());
    if (lengths.some((v) => !/^\d{1,15}$/.test(v)) || new Set(lengths).size > 1) {
      refuse(client, 400, "Bad Request", "an invalid Content-Length");
      return;
    }
    const length = lengths.length ? Number(lengths[0]) : 0;
    // Origin form, no proxy or hop-by-hop headers forwarded.
    const headers = fields.filter(
      (l) =>
        !/^(host|proxy-connection|proxy-authorization|connection|keep-alive|upgrade)\s*:/i.test(l),
    );
    const request = [
      `${method} ${url.pathname}${url.search} ${version}`,
      `Host: ${url.host}`,
      ...headers,
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    const body = rest.subarray(0, length);
    await this.tunnel(
      client,
      host,
      port,
      Buffer.concat([Buffer.from(request, "latin1"), body]),
      { method: method.slice(0, 16), path: url.pathname.slice(0, 2000) },
      length - body.length,
    );
  }

  private async tunnel(
    client: Socket,
    host: string,
    port: number,
    first: Buffer,
    http: { method: string; path: string } | undefined,
    /** Plain HTTP: the request body bytes still to come from the client; nothing after them. */
    remaining = 0,
  ): Promise<void> {
    const rec = { ...this.base(http ? "http" : "connect", host, port), ...(http ?? {}) };
    const decision = this.o.allowed(host, port);
    if (!decision.ok) {
      this.o.record({ ...rec, outcome: "denied", reason: decision.reason.slice(0, 500) });
      refuse(client, 403, "Forbidden", `AblationKit egress: ${decision.reason}`);
      return;
    }
    const addr = await publicAddress(host, this.o.resolve, this.o.isPublic);
    if ("reason" in addr) {
      this.o.record({ ...rec, outcome: "denied", reason: addr.reason.slice(0, 500) });
      refuse(client, 403, "Forbidden", `AblationKit egress: ${addr.reason}`);
      return;
    }
    const started = Date.now();
    let up = 0;
    let down = 0;
    let established = false;
    let done = false;
    const upstream = connect({ host: addr.ip, port });
    this.sockets.add(upstream);
    const finish = (outcome: "allowed" | "error", reason?: string) => {
      if (done) return;
      done = true;
      this.sockets.delete(upstream);
      this.o.record({
        ...rec,
        outcome,
        ...(reason ? { reason: reason.slice(0, 500) } : {}),
        bytes_up: up,
        bytes_down: down,
        duration_ms: Date.now() - started,
      });
    };
    upstream.setTimeout(IDLE_MS, () => upstream.destroy());
    upstream.once("connect", () => {
      established = true;
      upstream.on("data", (c: Buffer) => {
        down += c.length;
      });
      upstream.pipe(client);
      if (http) {
        up += first.length;
        upstream.write(first);
        let left = remaining;
        client.on("data", (c: Buffer) => {
          // The rest of this request's body; a second request on the connection is dropped.
          if (left <= 0) return;
          const part = c.subarray(0, left);
          left -= part.length;
          up += part.length;
          upstream.write(part);
        });
      } else {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (first.length) {
          up += first.length;
          upstream.write(first);
        }
        client.on("data", (c: Buffer) => {
          up += c.length;
        });
        client.pipe(upstream);
      }
      client.resume();
    });
    upstream.on("error", (e) => {
      if (!established) {
        finish("error", `cannot connect to ${host}:${port}: ${e.message}`);
        refuse(client, 502, "Bad Gateway", `AblationKit egress: cannot reach ${host}:${port}`);
      } else {
        finish("error", e.message);
        client.destroy();
      }
    });
    upstream.on("close", () => {
      finish("allowed");
      client.end();
    });
    client.on("close", () => upstream.destroy());
  }
}

/** Read a credential's secret now (from the coordinator's environment or a file). */
export function credentialSecret(c: ContainerCredential): string | undefined {
  if (c.from_env) return process.env[c.from_env] || undefined;
  if (c.from_file) {
    try {
      return readFileSync(c.from_file, "utf8").split("\n")[0]?.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export interface CredentialProxyOptions {
  readonly socket: string;
  readonly owner: string;
  readonly credentials: () => readonly ContainerCredential[];
  readonly record: (r: EgressRecord) => void;
  readonly now: () => Date;
}

/** Credential routes: `/<name>/<path>` to the credential's upstream, with its header set. */
export class CredentialProxy {
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(private readonly o: CredentialProxyOptions) {}

  start(): void {
    rmSync(this.o.socket, { force: true });
    this.server = Bun.serve({
      unix: this.o.socket,
      maxRequestBodySize: 1024 * 1024 * 1024,
      fetch: (req) => this.forward(req),
    });
    chmodSync(this.o.socket, 0o600);
  }

  stop(): void {
    void this.server?.stop(true);
    this.server = undefined;
    rmSync(this.o.socket, { force: true });
  }

  private async forward(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const [, name = "", ...rest] = url.pathname.split("/");
    const cred = this.o.credentials().find((c) => c.name === name);
    const at = this.o.now().toISOString();
    const path = `/${rest.join("/")}`;
    if (!cred) {
      return new Response(`AblationKit egress: no credential route ${name}\n`, { status: 404 });
    }
    const upstream = new URL(`${cred.upstream.replace(/\/$/, "")}${path}${url.search}`);
    const base: EgressRecord = {
      schema_version: 1,
      at,
      owner: this.o.owner,
      kind: "credential",
      credential: cred.name,
      host: upstream.hostname.slice(0, 260),
      port: upstream.port ? Number(upstream.port) : 443,
      method: req.method.slice(0, 16),
      path: path.slice(0, 2000),
      outcome: "allowed",
    };
    const secret = credentialSecret(cred);
    if (!secret) {
      this.o.record({ ...base, outcome: "error", reason: "the credential's secret is not set" });
      return new Response(
        `AblationKit egress: the researcher has not set ${cred.from_env ? `$${cred.from_env}` : cred.from_file} for credential ${cred.name}\n`,
        { status: 503 },
      );
    }
    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (!HOP_HEADERS.has(k.toLowerCase())) headers.set(k, v);
    });
    headers.set(cred.header, `${cred.prefix ?? ""}${secret}`);
    const started = Date.now();
    try {
      const res = await fetch(upstream, {
        method: req.method,
        headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: req.body }),
        redirect: "manual",
      });
      this.o.record({ ...base, status: res.status, duration_ms: Date.now() - started });
      const out = new Headers(res.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: out,
      });
    } catch (e) {
      this.o.record({
        ...base,
        outcome: "error",
        reason: (e as Error).message.slice(0, 500),
        duration_ms: Date.now() - started,
      });
      return new Response(`AblationKit egress: ${cred.upstream} did not answer\n`, { status: 502 });
    }
  }
}
