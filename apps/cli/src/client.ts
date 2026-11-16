/**
 * How the CLI reaches the coordinator. Locally it finds the human API through the login socket
 * and logs itself in with a one-time code. Remotely (`--coordinator URL`) it uses a session saved
 * by `ablationkit login --coordinator URL --code CODE`. Either way it uses the same HTTP API
 * as the UI (spec §12). The CLI is the researcher's and the operator's; agents use
 * `ablationkit mcp` and the agent API (ADR 0040).
 */
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import { runtimePaths } from "@ablationkit/server";
import type { CliContext } from "./context.ts";

export class CoordinatorUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorUnavailable";
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface SocketHealth {
  readonly status: string;
  readonly pid: number;
  readonly started_at: string;
  readonly urls: { human: string; agent: string; worker: string };
  readonly trusted_origins: { origin: string }[];
}

interface SavedSessions {
  schema_version: 1;
  sessions: Record<string, { token: string; session_id: string; saved_at: string }>;
}

export async function socketRequest(
  socket: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  try {
    return await fetch(`http://localhost${path}`, {
      unix: socket,
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    } as RequestInit);
  } catch {
    throw new CoordinatorUnavailable(
      "the coordinator is not running (run `ablationkit coordinator start`)",
    );
  }
}

export async function socketHealth(home: string): Promise<SocketHealth | undefined> {
  try {
    const r = await socketRequest(runtimePaths(home).loginSocket, "/health");
    return r.ok ? ((await r.json()) as SocketHealth) : undefined;
  } catch {
    return undefined;
  }
}

export async function requestLoginLink(
  home: string,
  origin?: string,
  next?: string,
): Promise<{ url: string; code: string; origin: string; human_api: string; expires_at: string }> {
  const r = await socketRequest(runtimePaths(home).loginSocket, "/login", {
    ...(origin ? { origin } : {}),
    ...(next ? { next } : {}),
  });
  const body = (await r.json()) as Record<string, unknown>;
  if (!r.ok)
    throw new ApiError(
      r.status,
      "login_failed",
      String((body["error"] as { message?: string })?.message),
      body,
    );
  return body as never;
}

function loadSessions(home: string): SavedSessions {
  try {
    return readJson<SavedSessions>(runtimePaths(home).cliSession);
  } catch {
    return { schema_version: 1, sessions: {} };
  }
}

export function saveSession(home: string, base: string, token: string, sessionId: string): void {
  const s = loadSessions(home);
  s.sessions[base] = { token, session_id: sessionId, saved_at: new Date().toISOString() };
  writeJsonAtomic(runtimePaths(home).cliSession, s, { mode: 0o600 });
}

function forgetSession(home: string, base: string): void {
  const s = loadSessions(home);
  if (!(base in s.sessions)) return;
  delete s.sessions[base];
  writeJsonAtomic(runtimePaths(home).cliSession, s, { mode: 0o600 });
}

/**
 * `method path` at `base` (a URL, or `unix:<socket>`) with a bearer token and a JSON body. An
 * unreachable coordinator is CoordinatorUnavailable, naming `what`; the response is returned
 * whatever its status.
 */
export async function send(
  base: string,
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
  what = base,
): Promise<Response> {
  // `unix:/path/to.sock`: an agent container's agent socket (ADR 0061).
  const unix = base.startsWith("unix:") ? base.slice(5) : undefined;
  try {
    return await fetch(unix ? `http://localhost${path}` : `${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(unix ? { unix } : {}),
    } as RequestInit);
  } catch (e) {
    throw new CoordinatorUnavailable(`cannot reach ${what}: ${(e as Error).message}`);
  }
}

/** The coordinator's refusal in a response body: its error code and message. */
export function refusal(status: number, body: Record<string, unknown>): ApiError {
  const err = (body["error"] ?? {}) as { code?: string; message?: string };
  return new ApiError(status, err.code ?? "error", err.message ?? `HTTP ${status}`, body);
}

/** `r` when it is ok; otherwise its refusal is thrown. */
export async function checked(r: Response): Promise<Response> {
  if (r.ok) return r;
  throw refusal(r.status, (await r.json().catch(() => ({}))) as Record<string, unknown>);
}

export async function exchangeCode(
  base: string,
  code: string,
  label: string,
): Promise<{ token: string; session_id: string }> {
  const r = await send(base, "POST", "/api/v1/auth/session", undefined, { code, label });
  const body = (await r.json()) as Record<string, unknown>;
  if (!r.ok) {
    const err = body["error"] as { code: string; message: string };
    throw new ApiError(r.status, err.code, err.message, body);
  }
  return body as { token: string; session_id: string };
}

export class CoordinatorClient {
  private constructor(
    readonly base: string,
    private token: string | undefined,
    private readonly home: string,
    /** True when we can mint our own session through the local login socket. */
    private readonly local: boolean,
  ) {}

  static async connect(ctx: CliContext, coordinator?: string): Promise<CoordinatorClient> {
    const explicit = coordinator ?? ctx.env["ABLATIONKIT_COORDINATOR"];
    const envToken = ctx.env["ABLATIONKIT_TOKEN"];
    if (explicit) {
      const base = explicit.replace(/\/+$/, "");
      const token = envToken ?? loadSessions(ctx.home).sessions[base]?.token;
      if (!token) {
        throw new CoordinatorUnavailable(
          `no session for ${base}. On the coordinator machine run \`ablationkit login --origin ${base}\`, then here run \`ablationkit login --coordinator ${base} --code CODE\``,
        );
      }
      return new CoordinatorClient(base, token, ctx.home, false);
    }
    const health = await socketHealth(ctx.home);
    if (!health)
      throw new CoordinatorUnavailable(
        "the coordinator is not running (run `ablationkit coordinator start`)",
      );
    const base = health.urls.human;
    return new CoordinatorClient(
      base,
      envToken ?? loadSessions(ctx.home).sessions[base]?.token,
      ctx.home,
      envToken === undefined,
    );
  }

  private async login(): Promise<void> {
    const link = await requestLoginLink(this.home);
    const s = await exchangeCode(this.base, link.code, "cli");
    saveSession(this.home, this.base, s.token, s.session_id);
    this.token = s.token;
  }

  /** A raw authenticated request (event streams). */
  async open(method: string, path: string): Promise<Response> {
    if (!this.token && this.local) await this.login();
    return checked(await send(this.base, method, path, this.token));
  }

  async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.token && this.local) await this.login();
    let r = await send(this.base, method, path, this.token, body);
    if (r.status === 401 && this.local) {
      forgetSession(this.home, this.base);
      await this.login();
      r = await send(this.base, method, path, this.token, body);
    }
    const parsed = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw refusal(r.status, parsed);
    return parsed as T;
  }
}
