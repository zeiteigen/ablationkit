/**
 * Local login socket (`<home>/run/login.sock`, mode 0600). `ablationkit login` asks it for a
 * one-time login link. Any process running as the researcher can reach it (spec §7.11): it
 * yields a human session, which authorizes privileged writes too (ADR 0037).
 * `next` (a web UI path, checked by `safeNext`) is where the link lands after signing in.
 *
 * `ablationkit mcp` starts and ends its agent session here (ADR 0040): `POST /agent-sessions`
 * mints an agent token for one project and nothing else (never a human session, never a login
 * code); `POST /agent-sessions/end` ends the session whose token it is given.
 */

import { HttpError, json, readJsonBody, safeNext, str, toErrorResponse } from "../http.ts";
import type { Services } from "../services.ts";
import { bearer } from "./common.ts";

const HARNESS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function loginSocketFetch(svc: Services): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return json(200, {
          status: "ok",
          pid: process.pid,
          started_at: svc.startedAt.toISOString(),
          urls: svc.urls,
          trusted_origins: svc.trustedOrigins,
        });
      }
      if (req.method === "POST" && url.pathname === "/login") {
        const body = await readJsonBody(req);
        const requested = str(body, "origin", { optional: true });
        const origin = requested
          ? svc.trustedOrigins.find((o) => o.origin === requested)
          : svc.trustedOrigins[0];
        if (!origin)
          throw new HttpError(400, "untrusted_origin", `${requested} is not a trusted origin`);
        const next = str(body, "next", { optional: true });
        if (next !== undefined && !safeNext(next))
          throw new HttpError(400, "invalid_request", "`next` must be a path in the web UI");
        const { secret, expiresAt } = svc.loginCodes.issue({ origin: origin.origin });
        svc.audit.record({
          actor: { kind: "system" },
          listener: "login",
          action: "auth.login_link.issue",
          outcome: "allowed",
          target: origin.origin,
        });
        return json(200, {
          url: `${origin.origin}/login?code=${secret}${next ? `&next=${encodeURIComponent(next)}` : ""}`,
          code: secret,
          origin: origin.origin,
          human_api: svc.urls.human,
          expires_at: expiresAt.toISOString(),
        });
      }
      if (req.method === "POST" && url.pathname === "/agent-sessions") {
        const body = await readJsonBody(req);
        const harness = str(body, "harness");
        if (!HARNESS_RE.test(harness))
          throw new HttpError(
            400,
            "invalid_request",
            "`harness` is a short lowercase name, e.g. claude-code or codex",
          );
        const cwd = str(body, "cwd");
        if (!cwd.startsWith("/") || cwd.length > 4096)
          throw new HttpError(400, "invalid_request", "`cwd` must be an absolute path");
        const label = (str(body, "label", { optional: true }) ?? `${harness} session`).slice(
          0,
          200,
        );
        const { token, record } = svc.agentSessions.begin({
          project_id: str(body, "project_id"),
          harness,
          label,
          cwd,
        });
        return json(201, {
          token,
          token_id: record.token_id,
          project_id: record.scope.project_id,
          agent_api: svc.urls.agent,
          expires_at: record.expires_at,
          idle_timeout_sec: record.agent_session?.idle_timeout_sec,
        });
      }
      if (req.method === "POST" && url.pathname === "/agent-sessions/end") {
        const token = bearer(req);
        if (!token) throw new HttpError(401, "unauthenticated", "give the session's token");
        const record = svc.agentSessions.endByToken(token);
        return json(200, { token_id: record.token_id, ended: true });
      }
      throw new HttpError(404, "not_found", "no such route on the login socket");
    } catch (e) {
      return toErrorResponse(e);
    }
  };
}
