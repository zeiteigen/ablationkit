/**
 * Worker API (spec §7.11). Per-job, upload-only tokens bound to job and attempt. A worker token
 * can act only on its own job/attempt (criterion 56). Collectors deliver events at least once
 * (`events:batch`, deduped at ingress) and upload artifact bytes separately (ADR 0011).
 */
import type { TokenRecord } from "@ablationkit/protocol";
import { HttpError, json, readJsonBody, toErrorResponse } from "../http.ts";
import { type Route, Router } from "../router.ts";
import type { Services } from "../services.ts";
import { bearer, notFound } from "./common.ts";
import { safeArtifactPath } from "./tracking.ts";

export const MAX_WORKER_BODY_BYTES = 8 * 1024 * 1024;

export interface WorkerCall {
  readonly req: Request;
  readonly params: Readonly<Record<string, string>>;
  readonly token: TokenRecord;
  readonly svc: Services;
}

export interface WorkerHandler {
  readonly auth: "none" | "worker";
  readonly action: string;
  /** Remote launch tokens may call only routes that allow them (the handshake). */
  readonly launch?: boolean;
  readonly run: (c: WorkerCall) => Response | Promise<Response>;
}

function remote(c: WorkerCall) {
  const r = c.svc.remote;
  if (!r) throw new HttpError(501, "remote_unavailable", "remote compute is not configured");
  return r;
}

function requireOwnAttempt(c: WorkerCall, action: string): void {
  const { id, attemptId } = c.params as { id: string; attemptId: string };
  if (c.token.scope.job_id !== id || c.token.scope.attempt_id !== attemptId) {
    c.svc.audit.record({
      actor: { kind: "worker", id: c.token.token_id },
      listener: "worker",
      action,
      outcome: "denied",
      project_id: c.token.scope.project_id,
      target: `${id}/${attemptId}`,
      reason: "token is bound to a different job attempt",
    });
    throw new HttpError(
      403,
      "forbidden_scope",
      "this token may upload only for its own job attempt",
    );
  }
}

export const WORKER_ROUTES: readonly Route<WorkerHandler>[] = [
  {
    method: "GET",
    path: "/api/v1/health",
    handler: {
      auth: "none",
      action: "health.read",
      run: () => json(200, { status: "ok", api: "worker" }),
    },
  },
  {
    method: "GET",
    path: "/api/v1/whoami",
    handler: {
      auth: "worker",
      action: "auth.whoami",
      run: (c) =>
        json(200, {
          kind: "worker",
          token_id: c.token.token_id,
          scope: c.token.scope,
          expires_at: c.token.expires_at,
        }),
    },
  },
  {
    method: "POST",
    path: "/api/v1/jobs/:id/attempts/:attemptId/events:batch",
    handler: {
      auth: "worker",
      action: "job.events.upload",
      run: async (c) => {
        requireOwnAttempt(c, "job.events.upload");
        const body = await readJsonBody(c.req, MAX_WORKER_BODY_BYTES);
        const through = c.req.headers.get("x-ablationkit-spool-through");
        return json(
          200,
          await c.svc.jobs.ingest(c.token, body, {
            ...(through !== null && /^[0-9]{1,15}$/.test(through)
              ? { spoolThrough: Number(through) }
              : {}),
            workerId: c.req.headers.get("x-ablationkit-worker-id"),
          }),
        );
      },
    },
  },
  {
    method: "PUT",
    path: "/api/v1/jobs/:id/attempts/:attemptId/artifacts",
    handler: {
      auth: "worker",
      action: "job.artifacts.upload",
      run: async (c) => {
        requireOwnAttempt(c, "job.artifacts.upload");
        const path = safeArtifactPath(new URL(c.req.url).searchParams.get("path"), true) as string;
        return json(201, await c.svc.jobs.uploadArtifact(c.token, c.req, path));
      },
    },
  },
];

/** Remote workers (ADR 0023): handshake/heartbeat and resumable artifact uploads. */
export const REMOTE_WORKER_ROUTES: readonly Route<WorkerHandler>[] = [
  {
    method: "POST",
    path: "/api/v1/jobs/:id/attempts/:attemptId/handshake",
    handler: {
      auth: "worker",
      action: "job.remote.handshake",
      launch: true,
      run: async (c) => {
        requireOwnAttempt(c, "job.remote.handshake");
        const body = await readJsonBody(c.req, 256 * 1024);
        return json(200, remote(c).handshake(c.token, body));
      },
    },
  },
  {
    // A pulling worker (a Runpod pod) downloads its staged bundle with the launch token.
    method: "GET",
    path: "/api/v1/jobs/:id/attempts/:attemptId/bundle",
    handler: {
      auth: "worker",
      action: "job.remote.bundle",
      launch: true,
      run: (c) => {
        requireOwnAttempt(c, "job.remote.bundle");
        const file = remote(c).bundleFile(c.token);
        return new Response(Bun.file(file), {
          headers: { "content-type": "application/gzip", "cache-control": "no-store" },
        });
      },
    },
  },
  {
    // A research endpoint pod downloads its pinned model package with the deployment's fetch token
    // (not a worker token: no job exists). Checked and audited by `RemoteEndpoints.modelFile`.
    method: "GET",
    path: "/api/v1/deployments/:depId/model",
    handler: {
      auth: "none",
      action: "deployment.model.fetch",
      run: (c) => {
        const file = c.svc.endpoints.modelFile(
          c.params["depId"] as string,
          bearer(c.req) ?? undefined,
        );
        return new Response(Bun.file(file), {
          headers: { "content-type": "application/gzip", "cache-control": "no-store" },
        });
      },
    },
  },
  {
    method: "POST",
    path: "/api/v1/jobs/:id/attempts/:attemptId/uploads",
    handler: {
      auth: "worker",
      action: "job.artifacts.upload",
      run: async (c) => {
        requireOwnAttempt(c, "job.artifacts.upload");
        const body = await readJsonBody(c.req, 64 * 1024);
        const path = safeArtifactPath(
          typeof body["path"] === "string" ? body["path"] : null,
          true,
        ) as string;
        const r = await remote(c).uploadStart(
          c.token,
          path,
          body,
          c.req.headers.get("x-ablationkit-worker-id"),
        );
        return json(r["done"] ? 200 : 201, r);
      },
    },
  },
  {
    method: "PUT",
    path: "/api/v1/jobs/:id/attempts/:attemptId/uploads/:uploadId",
    handler: {
      auth: "worker",
      action: "job.artifacts.upload",
      run: async (c) => {
        requireOwnAttempt(c, "job.artifacts.upload");
        return json(
          200,
          await remote(c).uploadChunk(c.token, c.params["uploadId"] as string, c.req),
        );
      },
    },
  },
  {
    method: "POST",
    path: "/api/v1/jobs/:id/attempts/:attemptId/uploads/:uploadId/complete",
    handler: {
      auth: "worker",
      action: "job.artifacts.upload",
      run: async (c) => {
        requireOwnAttempt(c, "job.artifacts.upload");
        return json(
          201,
          await remote(c).uploadComplete(
            c.token,
            c.params["uploadId"] as string,
            c.req.headers.get("x-ablationkit-worker-id"),
          ),
        );
      },
    },
  },
];

export function workerFetch(svc: Services): (req: Request) => Promise<Response> {
  const router = new Router([...WORKER_ROUTES, ...REMOTE_WORKER_ROUTES]);
  return async (req) => {
    try {
      // Remote workers reach this listener over Tailscale by IP or name, so Host is not pinned
      // to loopback here (no browser uses this API); every non-health route needs a worker token.
      const url = new URL(req.url);
      const m = router.match(req.method, url.pathname);
      if (m.kind !== "found") throw notFound();
      const h = m.route.handler;
      if (h.auth === "none")
        return await h.run({ req, params: m.params, svc, token: undefined as never });
      const t = bearer(req);
      const token = t ? svc.tokens.verify(t, "worker") : undefined;
      if (!token) {
        svc.audit.record({
          actor: { kind: "worker" },
          listener: "worker",
          action: "auth.token_check",
          outcome: "denied",
          target: `${req.method} ${m.route.path}`,
          reason: t ? "invalid, expired or revoked worker token" : "missing worker token",
        });
        throw new HttpError(401, "unauthenticated", "a valid worker token is required");
      }
      if (token.purpose === "launch" && !h.launch) {
        svc.audit.record({
          actor: { kind: "worker", id: token.token_id },
          listener: "worker",
          action: h.action,
          outcome: "denied",
          project_id: token.scope.project_id,
          target: `${req.method} ${m.route.path}`,
          reason: "a launch token may only hand-shake or download its bundle",
        });
        throw new HttpError(401, "unauthenticated", "use the upload token for this route");
      }
      return await h.run({ req, params: m.params, svc, token });
    } catch (e) {
      return toErrorResponse(e);
    }
  };
}
