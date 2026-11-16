import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { Coordinator, type CoordinatorOptions } from "../src/index.ts";

export const TAILNET = { origin: "https://ws.tail1234.ts.net" };

export class Harness {
  readonly dirs: string[] = [];
  readonly coordinators: Coordinator[] = [];

  tmp(prefix = "ak-srv-"): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    this.dirs.push(d);
    return d;
  }

  /** A directory that looks like a Git checkout. */
  repo(name = "repo"): string {
    const d = join(this.tmp(), name);
    mkdirSync(join(d, ".git"), { recursive: true });
    return d;
  }

  async start(
    opts: Partial<CoordinatorOptions> & { remote?: boolean; settings?: CoordinatorSettings } = {},
  ): Promise<Client> {
    const home = opts.home ?? this.tmp("ak-home-");
    const settings: CoordinatorSettings = opts.settings ?? {
      schema_version: 1,
      human: { host: "127.0.0.1", port: 0 },
      agent: { host: "127.0.0.1", port: 0 },
      worker: { host: "127.0.0.1", port: 0 },
      // Tests never start the real sidecar; tracking tests pass `trackingUrl` (a fake MLflow).
      mlflow: { enabled: false },
    };
    const c = await Coordinator.start({ log: () => {}, heartbeatMs: 50, ...opts, home, settings });
    this.coordinators.push(c);
    // With no trusted_origins configured the default is http://localhost:<port>; add the tailnet
    // origin as an operator would in settings.json.
    if (opts.remote) c.services.trustedOrigins = [...c.services.trustedOrigins, TAILNET];
    return new Client(c);
  }

  async cleanup(): Promise<void> {
    for (const c of this.coordinators.splice(0)) await c.stop();
    for (const d of this.dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  }
}

export interface Req {
  method?: string;
  body?: unknown;
  /** A body sent as given (for malformed or oversized payloads); needs a `method`. */
  rawBody?: string;
  token?: string;
  cookie?: string;
  origin?: string;
  host?: string;
  headers?: Record<string, string>;
}

export class Client {
  constructor(readonly c: Coordinator) {}

  get localOrigin(): string {
    return (this.c.services.trustedOrigins[0] as { origin: string }).origin;
  }

  async socket(path: string, body?: unknown): Promise<Response> {
    return fetch(`http://localhost${path}`, {
      unix: this.c.loginSocket,
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    } as RequestInit);
  }

  async loginCode(origin?: string): Promise<string> {
    const r = await this.socket("/login", origin ? { origin } : {});
    if (r.status !== 200) throw new Error(`login socket: ${r.status} ${await r.text()}`);
    return ((await r.json()) as { code: string }).code;
  }

  /** A CLI-style bearer session. */
  async session(): Promise<string> {
    const r = await this.human("/api/v1/auth/session", { body: { code: await this.loginCode() } });
    if (r.status !== 201) throw new Error(`session: ${r.status} ${await r.text()}`);
    return ((await r.json()) as { token: string }).token;
  }

  /** An agent session token for `projectId`, minted the way `ablationkit mcp` does (ADR 0040). */
  async agentSession(
    projectId: string,
    label = "test session",
  ): Promise<{ token: string; token_id: string }> {
    const r = await this.socket("/agent-sessions", {
      project_id: projectId,
      harness: "test",
      label,
      cwd: "/work",
    });
    if (r.status !== 201) throw new Error(`agent session: ${r.status} ${await r.text()}`);
    return (await r.json()) as { token: string; token_id: string };
  }

  /** A browser-style cookie session, logging in through the link for `origin`. */
  async browserSession(origin = this.localOrigin): Promise<string> {
    const code = await this.loginCode(origin);
    const r = await this.human(`/login?code=${code}`, {
      method: "GET",
      host: new URL(origin).host,
    });
    if (r.status !== 303) throw new Error(`login: ${r.status} ${await r.text()}`);
    const set = r.headers.get("set-cookie") ?? "";
    return set.split(";")[0] as string;
  }

  private async call(base: string, path: string, req: Req): Promise<Response> {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (req.body !== undefined) headers["content-type"] = "application/json";
    if (req.token) headers["authorization"] = `Bearer ${req.token}`;
    if (req.cookie) headers["cookie"] = req.cookie;
    if (req.origin) headers["origin"] = req.origin;
    if (req.host) headers["host"] = req.host;
    return fetch(`${base}${path}`, {
      method: req.method ?? (req.body === undefined ? "GET" : "POST"),
      headers,
      redirect: "manual",
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      ...(req.rawBody === undefined ? {} : { body: req.rawBody }),
    });
  }

  human(path: string, req: Req = {}): Promise<Response> {
    return this.call(this.c.urls.human, path, req);
  }
  agent(path: string, req: Req = {}): Promise<Response> {
    return this.call(this.c.urls.agent, path, req);
  }
  worker(path: string, req: Req = {}): Promise<Response> {
    return this.call(this.c.urls.worker, path, req);
  }

  async json<T = Record<string, unknown>>(
    r: Promise<Response> | Response,
  ): Promise<{ status: number; body: T }> {
    const res = await r;
    return { status: res.status, body: (await res.json()) as T };
  }
}
