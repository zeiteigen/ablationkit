/**
 * Human API for remote compute (ADR 0023): compute targets, and actions on remote attempts that
 * only a human takes (drain, re-authorize a worker, import an isolated runtime's spool, resolve an
 * ambiguous outcome). None of them reruns a job.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { HttpError, json, readJsonBody } from "../http.ts";
import type { Route } from "../router.ts";
import { session } from "./common.ts";
import type { HumanCall, HumanHandler } from "./human.ts";

function audit(
  c: HumanCall,
  action: string,
  target: string,
  details?: Record<string, unknown>,
): void {
  c.svc.audit.record({
    actor: { kind: "human", id: c.session.token_id },
    listener: "human",
    action,
    outcome: "allowed",
    target,
    ...(details ? { details } : {}),
  });
}

function attempt(c: HumanCall) {
  const a = c.svc.jobs.requireAttempt(c.params["id"] as string, c.params["attemptId"] as string);
  if (!a.remote) throw new HttpError(409, "not_remote", "this attempt is not a remote attempt");
  return a;
}

function targetView(c: HumanCall, id: string): Record<string, unknown> {
  const t = c.svc.targets.require(id);
  let capabilities: unknown;
  let available = true;
  try {
    capabilities = c.svc.targets.adapter(t).capabilities;
  } catch {
    available = false;
  }
  return {
    ...t,
    available,
    ...(capabilities ? { capabilities } : {}),
    effective_worker_url: c.svc.remote.workerUrlFor(id),
  };
}

export const REMOTE_ROUTES: readonly Route<HumanHandler>[] = [
  {
    method: "GET",
    path: "/api/v1/targets",
    handler: session("target.list", (c) =>
      json(200, { targets: c.svc.targets.list().map((t) => targetView(c, t.target_id)) }),
    ),
  },
  {
    method: "GET",
    path: "/api/v1/targets/:id",
    handler: session("target.read", (c) => json(200, targetView(c, c.params["id"] as string))),
  },
  {
    method: "PUT",
    path: "/api/v1/targets/:id",
    handler: session("target.put", async (c) => {
      const body = await readJsonBody(c.req);
      const id = c.params["id"] as string;
      if (body["target_id"] !== undefined && body["target_id"] !== id)
        throw new HttpError(400, "invalid_request", "`target_id` must match the URL");
      const { created_at: _c, updated_at: _u, ...rest } = body;
      const existed = c.svc.targets.get(id) !== undefined;
      const t = c.svc.targets.put({ ...rest, target_id: id });
      audit(c, "target.put", id, { kind: t.kind, paid: t.paid });
      return json(existed ? 200 : 201, targetView(c, id));
    }),
  },
  {
    method: "DELETE",
    path: "/api/v1/targets/:id",
    handler: session("target.delete", (c) => {
      const id = c.params["id"] as string;
      c.svc.targets.remove(id);
      audit(c, "target.delete", id);
      return json(200, { deleted: id });
    }),
  },
  {
    method: "POST",
    path: "/api/v1/targets/:id/doctor",
    handler: session("target.doctor", async (c) => {
      const id = c.params["id"] as string;
      const checks = await c.svc.targets.doctor(id, c.svc.remote.workerUrlFor(id));
      return json(200, { target_id: id, ok: checks.every((x) => x.ok), checks });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/targets/:id/usage",
    handler: session("target.usage", async (c) =>
      json(200, await c.svc.targets.usage(c.params["id"] as string)),
    ),
  },
  {
    method: "GET",
    path: "/api/v1/jobs/:id/attempts/:attemptId/remote/notebook",
    handler: session("job.remote.notebook", (c) => {
      const file = c.svc.remote.notebookFile(attempt(c));
      return new Response(Bun.file(file), {
        headers: {
          "content-type": "application/x-ipynb+json",
          "content-disposition": `attachment; filename="${c.params["attemptId"]}.ipynb"`,
          "cache-control": "no-store",
        },
      });
    }),
  },
  {
    method: "POST",
    path: "/api/v1/jobs/:id/attempts/:attemptId/remote/drain",
    handler: session("job.remote.drain", async (c) => {
      const a = attempt(c);
      await c.svc.remote.drain(a, c.session.token_id);
      return json(202, c.svc.jobs.attemptView(c.svc.jobs.attempt(a.attempt_id) ?? a));
    }),
  },
  {
    method: "POST",
    path: "/api/v1/jobs/:id/attempts/:attemptId/remote/reauthorize",
    handler: session("job.remote.reauthorize", async (c) => {
      const a = attempt(c);
      const remote = await c.svc.remote.reauthorize(a, c.session.token_id);
      return json(200, { attempt_id: a.attempt_id, remote });
    }),
  },
  {
    method: "POST",
    path: "/api/v1/jobs/:id/attempts/:attemptId/remote/resolve",
    handler: session("job.remote.resolve", async (c) => {
      const a = attempt(c);
      const body = await readJsonBody(c.req);
      const lost = body["lost"] === true;
      const note =
        lost && (body["note"] === undefined || body["note"] === "")
          ? "the runtime will not report back"
          : body["note"];
      if (typeof note !== "string" || note.trim().length === 0)
        throw new HttpError(400, "invalid_request", "`note` (what you checked) is required");
      return json(200, {
        attempt_id: a.attempt_id,
        remote: c.svc.remote.resolve(a, c.session.token_id, note, { lost }),
      });
    }),
  },
  {
    method: "POST",
    path: "/api/v1/jobs/:id/attempts/:attemptId/remote/import",
    handler: session("job.remote.import", async (c) => {
      const a = attempt(c);
      const body = await readJsonBody(c.req);
      const p = body["archive_path"];
      if (typeof p !== "string" || !isAbsolute(p) || !existsSync(p) || !statSync(p).isFile())
        throw new HttpError(
          400,
          "invalid_request",
          "`archive_path` must be an absolute path to a .tar.gz on the coordinator's machine",
        );
      return json(200, await c.svc.remote.importSpool(a, p, c.session.token_id));
    }),
  },
];
