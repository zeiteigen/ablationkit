/**
 * Human API (spec §4.3, §7.11): browser, Electron and CLI. Sessions come from one-time login
 * links (login socket). The session alone authorizes privileged writes, locally or remotely over
 * Tailscale; agents never reach these routes (no passkeys, ADR 0037).
 */
import type { TokenRecord } from "@ablationkit/protocol";
import { parseAfter } from "../events.ts";
import { HttpError, json, readJsonBody, safeNext, str, toErrorResponse } from "../http.ts";
import { type Route, Router } from "../router.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";
import { systemDiagnostics } from "../state/diagnostics.ts";
import { removalPlan, removeProject } from "../state/project-removal.ts";
import { readPendingRestore, readRestoreRecord } from "../state/restore.ts";
import { figureFrame } from "../vault/figures.ts";
import { webResponse } from "../web.ts";
import { AGENDA_OPS } from "./agenda.ts";
import { BACKEND_MANAGEMENT_OPS, BACKEND_OPS } from "./backends.ts";
import { audit, bearer, checkHost, notFound } from "./common.ts";
import { COMPUTE_OPS, COMPUTE_ROUTES } from "./compute.ts";
import { CONTAINER_ROUTES } from "./containers.ts";
import { DEPLOYMENT_OPS, POLICY_OPS } from "./deployments.ts";
import { DIRECTION_OPS } from "./directions.ts";
import { EXTENSION_OPS } from "./extensions.ts";
import { INFERENCE_OPS } from "./inference.ts";
import { JOB_ROUTES } from "./jobs.ts";
import { LIFECYCLE_OPS } from "./lifecycle.ts";
import { REMOTE_ROUTES } from "./remote.ts";
import { RESEARCH_OPS } from "./research.ts";
import { RUN_IMPORT_OPS } from "./run-import.ts";
import { SHELL_ROUTES } from "./shell.ts";
import { TASK_OPS } from "./tasks.ts";
import { RUN_DESCRIPTION_OPS, TRACKING_ROUTES } from "./tracking.ts";
import { VAULT_OPS } from "./vault.ts";

export const SESSION_COOKIE = "ak_session";

export interface HumanCall {
  readonly req: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly svc: Services;
  /** Present for `auth: "session"` routes. */
  readonly session: TokenRecord;
}

export interface HumanHandler {
  readonly auth: "none" | "session";
  readonly action: string;
  readonly run: (c: HumanCall) => Response | Promise<Response>;
}

function cookieFor(token: string, origin: string, maxAgeSec: number): string {
  const secure = origin.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

function sessionInfo(s: TokenRecord): Record<string, unknown> {
  return compact({
    session_id: s.token_id,
    created_at: s.created_at,
    expires_at: s.expires_at,
    label: s.label,
  });
}

export const HUMAN_ROUTES: readonly Route<HumanHandler>[] = [
  {
    method: "GET",
    path: "/api/v1/health",
    handler: {
      auth: "none",
      action: "health.read",
      run: () => json(200, { status: "ok", api: "human" }),
    },
  },
  {
    method: "GET",
    path: "/api/v1/system/build",
    handler: {
      auth: "session",
      action: "system.build.read",
      run: (c) => json(200, { build: c.svc.builds.status(), builds: c.svc.builds.list() }),
    },
  },
  {
    // The System page's operations view (spec §2.2, §13; ADR 0025).
    method: "GET",
    path: "/api/v1/system/operations",
    handler: {
      auth: "session",
      action: "system.operations.read",
      run: async (c) =>
        json(200, {
          diagnostics: systemDiagnostics(c.svc),
          safe_mode: c.svc.extensions.safeMode,
          restored: readRestoreRecord(c.svc.paths.home) ?? null,
          pending_restore: readPendingRestore(c.svc.paths.home) ?? null,
          artifact_store: await c.svc.remote.storeHealth(),
          home: c.svc.paths.home,
        }),
    },
  },
  {
    method: "POST",
    path: "/api/v1/system/builds/:bid/activate",
    handler: {
      auth: "session",
      action: "build.activate",
      run: (c) =>
        json(200, {
          build: c.svc.builds.activate(c.params["bid"] as string, { id: c.session.token_id }),
        }),
    },
  },
  {
    method: "POST",
    path: "/api/v1/system/builds/deactivate",
    handler: {
      auth: "session",
      action: "build.deactivate",
      run: (c) => json(200, { build: c.svc.builds.deactivate({ id: c.session.token_id }) }),
    },
  },
  {
    // A sandboxed extension view (ADR 0022): the document has an opaque origin and no network.
    method: "GET",
    path: "/ext-frame/:pid/:ext/:eb/:cid",
    handler: {
      auth: "session",
      action: "extension.frame",
      run: (c) =>
        c.svc.extensions.frame(
          c.params["pid"] as string,
          c.params["ext"] as string,
          c.params["eb"] as string,
          c.params["cid"] as string,
          {
            preview: c.url.searchParams.get("preview") === "1",
            ancestors: c.svc.trustedOrigins.map((o) => o.origin),
          },
        ),
    },
  },
  {
    // A vault figure (ADR 0053): the extension views' sandbox, holding the note's script.
    method: "GET",
    path: "/vault-frame/:pid/:nid/:rev",
    handler: {
      auth: "session",
      action: "vault.figure.frame",
      run: (c) =>
        figureFrame(
          c.svc,
          c.params["pid"] as string,
          c.params["nid"] as string,
          c.params["rev"] as string,
          { ancestors: c.svc.trustedOrigins.map((o) => o.origin) },
        ),
    },
  },
  {
    // The web shell (Stage 6); unknown non-API GETs also get it (see humanFetch).
    method: "GET",
    path: "/",
    handler: { auth: "none", action: "page.app", run: () => webResponse("/") },
  },
  {
    // Browser and Electron: open the one-time link, get a session cookie.
    method: "GET",
    path: "/login",
    handler: {
      auth: "none",
      action: "auth.session.create",
      run: (c) => {
        const code = c.url.searchParams.get("code") ?? "";
        const issued = code ? c.svc.loginCodes.consume(code) : undefined;
        if (!issued) {
          c.svc.audit.record({
            actor: { kind: "human" },
            listener: "human",
            action: "auth.session.create",
            outcome: "denied",
            reason: "invalid or used login code",
          });
          return new Response(
            "This login link is invalid, expired or already used. Run `ablationkit login` again.\n",
            {
              status: 400,
              headers: {
                "content-type": "text/plain; charset=utf-8",
                "referrer-policy": "no-referrer",
              },
            },
          );
        }
        const { token, record } = c.svc.tokens.mint("session", { label: "browser" });
        c.svc.audit.record({
          actor: { kind: "human", id: record.token_id },
          listener: "human",
          action: "auth.session.create",
          outcome: "allowed",
          target: "browser",
        });
        const maxAge = Math.floor(
          (Date.parse(record.expires_at as string) - c.svc.now().getTime()) / 1000,
        );
        // Only a same-origin web UI path: never another origin, never the API (no open redirect).
        const next = c.url.searchParams.get("next");
        return new Response(null, {
          status: 303,
          headers: {
            location: next && safeNext(next) ? next : "/",
            "set-cookie": cookieFor(token, issued.origin, maxAge),
            "referrer-policy": "no-referrer",
            "cache-control": "no-store",
          },
        });
      },
    },
  },
  {
    // CLI (local or remote): exchange a one-time code for a bearer session token.
    method: "POST",
    path: "/api/v1/auth/session",
    handler: {
      auth: "none",
      action: "auth.session.create",
      run: async (c) => {
        const body = await readJsonBody(c.req);
        const code = str(body, "code");
        const label = str(body, "label", { optional: true }) ?? "cli";
        if (!c.svc.loginCodes.consume(code)) {
          c.svc.audit.record({
            actor: { kind: "human" },
            listener: "human",
            action: "auth.session.create",
            outcome: "denied",
            reason: "invalid or used login code",
          });
          throw new HttpError(
            401,
            "invalid_login_code",
            "login code is invalid, expired or already used",
          );
        }
        const { token, record } = c.svc.tokens.mint("session", { label: label.slice(0, 200) });
        c.svc.audit.record({
          actor: { kind: "human", id: record.token_id },
          listener: "human",
          action: "auth.session.create",
          outcome: "allowed",
          target: label.slice(0, 200),
        });
        return json(201, { token, ...sessionInfo(record) });
      },
    },
  },
  {
    method: "GET",
    path: "/api/v1/auth/session",
    handler: {
      auth: "session",
      action: "auth.session.read",
      run: (c) => json(200, sessionInfo(c.session)),
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/auth/session",
    handler: {
      auth: "session",
      action: "auth.session.revoke",
      run: (c) => {
        c.svc.tokens.revoke(c.session.token_id, "logout");
        audit(c, "auth.session.revoke", { target: c.session.token_id });
        return json(
          200,
          { revoked: true },
          { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` },
        );
      },
    },
  },
  {
    method: "GET",
    path: "/api/v1/agent-sessions",
    handler: {
      auth: "session",
      action: "auth.agent_session.list",
      run: (c) => {
        const project = c.url.searchParams.get("project") ?? undefined;
        if (project) c.svc.registry.require(project);
        return json(200, { sessions: c.svc.agentSessions.list(project) });
      },
    },
  },
  {
    method: "GET",
    path: "/api/v1/agent-sessions/:id/account",
    handler: {
      auth: "session",
      action: "auth.agent_session.account",
      run: async (c) => json(200, await c.svc.witness.account(c.params["id"] as string)),
    },
  },
  {
    method: "POST",
    path: "/api/v1/agent-sessions/:id/end",
    handler: {
      auth: "session",
      action: "auth.agent_session.end",
      run: async (c) => {
        const id = c.params["id"] as string;
        const body = await readJsonBody(c.req);
        const reason = (str(body, "reason", { optional: true }) ?? "ended by researcher").slice(
          0,
          500,
        );
        const ended = c.svc.agentSessions.endByResearcher(id, c.session.token_id, reason);
        return json(200, { token_id: id, ended });
      },
    },
  },
  {
    method: "GET",
    path: "/api/v1/coordinator/status",
    handler: {
      auth: "session",
      action: "coordinator.status",
      run: (c) =>
        json(200, {
          pid: process.pid,
          started_at: c.svc.startedAt.toISOString(),
          urls: c.svc.urls,
          trusted_origins: c.svc.trustedOrigins,
          startup: c.svc.startup,
          projects: c.svc.registry.list().length,
          event_seq: c.svc.events.lastSeq,
          sse_subscribers: c.svc.events.subscriberCount,
          tracking: {
            sidecar: c.svc.sidecarStatus().state,
            outbox: c.svc.tracking.outbox.stats(),
          },
        }),
    },
  },
  {
    method: "GET",
    path: "/api/v1/audit",
    handler: {
      auth: "session",
      action: "audit.read",
      run: async (c) => {
        const after = Number(c.url.searchParams.get("after") ?? "-1");
        const limit = Math.min(1000, Math.max(1, Number(c.url.searchParams.get("limit") ?? "100")));
        if (!Number.isSafeInteger(after) || !Number.isSafeInteger(limit))
          throw new HttpError(400, "invalid_request", "bad after/limit");
        return json(200, { records: await c.svc.audit.read(after, limit) });
      },
    },
  },
  {
    method: "GET",
    path: "/api/v1/events/stream",
    handler: {
      auth: "session",
      action: "events.stream",
      run: (c) => {
        const project = c.url.searchParams.get("project") ?? undefined;
        if (project) c.svc.registry.require(project);
        // `after=latest` (without Last-Event-ID): only events from now on, for live views.
        const latest =
          !c.req.headers.get("last-event-id") && c.url.searchParams.get("after") === "latest";
        return c.svc.events.stream(
          latest ? c.svc.events.lastSeq : parseAfter(c.req, c.url),
          project ? { projectId: project } : {},
          c.req.signal,
          c.url.searchParams.get("format") === "message" ? "message" : "named",
        );
      },
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects",
    handler: {
      auth: "session",
      action: "project.list",
      run: (c) => json(200, { projects: c.svc.registry.list() }),
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects",
    handler: {
      auth: "session",
      action: "project.register",
      run: async (c) => {
        const body = await readJsonBody(c.req);
        const input = compact({
          path: str(body, "path"),
          name: str(body, "name", { optional: true }),
          projectId: str(body, "project_id", { optional: true }),
        });
        try {
          // No agent guard written into the checkout since ADR 0062: agents on the host are the
          // researcher's operators; `ablationkit project guard` still applies it on request.
          const { project, manifestCreated } = c.svc.registry.add(input);
          audit(c, "project.register", {
            project_id: project.project_id,
            target: project.path,
            details: { manifest_created: manifestCreated },
          });
          c.svc.events.publish(project.project_id, "project.registered", {
            name: project.name,
            manifest_created: manifestCreated,
          });
          // One MLflow experiment per project, `ak/<project-id>` (spec §6.1). Queued, so a
          // registration never waits on (or fails because of) MLflow.
          try {
            c.svc.tracking.ensureProject(project.project_id);
          } catch (e) {
            console.error(`coordinator: cannot queue ak/${project.project_id}: ${String(e)}`);
          }
          // An existing `.ablationkit/research/` export is imported once (spec §5.1).
          let research: ReturnType<typeof c.svc.research.importOnce> | undefined;
          try {
            research = c.svc.research.importOnce(project.project_id);
          } catch (e) {
            console.error(`coordinator: research import for ${project.project_id}: ${String(e)}`);
          }
          return json(201, {
            project,
            manifest_created: manifestCreated,
            ...(research ? { research_import: research } : {}),
          });
        } catch (e) {
          if (e instanceof HttpError)
            audit(c, "project.register", {
              outcome: "denied",
              target: input.path,
              reason: e.message,
            });
          throw e;
        }
      },
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id",
    handler: {
      auth: "session",
      action: "project.read",
      run: (c) => json(200, { project: c.svc.registry.require(c.params["id"] as string) }),
    },
  },
  // Project removal (ADR 0034): the plan first, then the removal itself.
  {
    method: "GET",
    path: "/api/v1/projects/:id/removal",
    handler: {
      auth: "session",
      action: "project.read",
      run: (c) => json(200, { plan: removalPlan(c.svc, c.params["id"] as string) }),
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/projects/:id",
    handler: {
      auth: "session",
      action: "project.remove",
      run: async (c) => {
        const id = c.params["id"] as string;
        try {
          const r = await removeProject(c.svc, id, c.session.token_id);
          audit(c, "project.remove", {
            project_id: id,
            target: r.project.path,
            details: { moved_to: r.moved_to, moved: r.moved.map((m) => m.from) },
          });
          c.svc.events.publish(id, "project.removed", { moved_to: r.moved_to });
          return json(200, { removed: r });
        } catch (e) {
          if (e instanceof HttpError)
            audit(c, "project.remove", { outcome: "denied", project_id: id, reason: e.message });
          throw e;
        }
      },
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/remap",
    handler: {
      auth: "session",
      action: "project.remap",
      run: async (c) => {
        const id = c.params["id"] as string;
        const body = await readJsonBody(c.req);
        const path = str(body, "path");
        const before = c.svc.registry.require(id).path;
        try {
          const project = c.svc.registry.remap(id, path);
          if (project.path === before) return json(200, { project, changed: false });
          audit(c, "project.remap", {
            project_id: id,
            target: project.path,
            details: { from: before },
          });
          c.svc.events.publish(id, "project.remapped", { from: before, to: project.path });
          return json(200, { project, changed: true });
        } catch (e) {
          if (e instanceof HttpError)
            audit(c, "project.remap", {
              outcome: "denied",
              project_id: id,
              target: path,
              reason: e.message,
            });
          throw e;
        }
      },
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/doctor",
    handler: {
      auth: "session",
      action: "project.doctor",
      run: (c) => json(200, c.svc.registry.doctor(c.params["id"] as string)),
    },
  },
  // Policy revisions (§7.7.2, criterion 33): immutable, human-only, never from an agent.
  {
    method: "POST",
    path: "/api/v1/projects/:id/policy/revisions",
    handler: {
      auth: "session",
      action: "policy.revise",
      run: async (c) => {
        const id = c.params["id"] as string;
        c.svc.registry.require(id);
        const body = await readJsonBody(c.req);
        const expect = body["expect_revision"];
        if (expect !== undefined && !Number.isInteger(expect))
          throw new HttpError(400, "invalid_request", "`expect_revision` must be an integer");
        let out: ReturnType<typeof c.svc.policy.revise>;
        try {
          out = c.svc.policy.revise(
            id,
            body["policy"],
            `human:${c.session.token_id}`,
            expect as number | undefined,
          );
        } catch (e) {
          if (e instanceof HttpError)
            audit(c, "policy.revise", {
              outcome: "denied",
              project_id: id,
              reason: e.message.slice(0, 1024),
            });
          throw e;
        }
        audit(c, "policy.revised", {
          project_id: id,
          target: `revision ${out.policy.revision}`,
          details: {
            from: out.previous.revision,
            to: out.policy.revision,
            changes: out.changes.map((x) => `${x.path} (${x.effect})`),
          },
        });
        c.svc.events.publish(id, "policy.revised", {
          revision: out.policy.revision,
          changes: out.changes.map((x) => x.path),
        });
        return json(201, { policy: out.policy, changes: out.changes });
      },
    },
  },
  ...TRACKING_ROUTES,
  ...JOB_ROUTES,
  ...REMOTE_ROUTES,
  ...COMPUTE_ROUTES,
  ...CONTAINER_ROUTES,
  ...SHELL_ROUTES,
  ...[
    ...TASK_OPS.filter((op) => !op.agentOnly),
    ...DIRECTION_OPS.filter((op) => !op.agentOnly),
    ...DEPLOYMENT_OPS,
    ...POLICY_OPS,
    ...COMPUTE_OPS,
    ...RUN_IMPORT_OPS,
    ...RESEARCH_OPS,
    ...VAULT_OPS,
    ...AGENDA_OPS,
    ...RUN_DESCRIPTION_OPS,
    ...LIFECYCLE_OPS,
    ...INFERENCE_OPS,
    ...BACKEND_OPS,
    ...BACKEND_MANAGEMENT_OPS,
    ...EXTENSION_OPS,
  ].map(
    (op): Route<HumanHandler> => ({
      method: op.method,
      path: op.path,
      handler: {
        auth: "session",
        action: op.action,
        run: (c) =>
          op.run({
            req: c.req,
            url: c.url,
            params: c.params,
            svc: c.svc,
            actor: { kind: "human", id: c.session.token_id },
            listener: "human",
          }),
      },
    }),
  ),
];

function cookie(req: Request, name: string): string | undefined {
  const h = req.headers.get("cookie");
  if (!h) return undefined;
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function humanFetch(svc: Services, port: () => number): (req: Request) => Promise<Response> {
  const router = new Router(HUMAN_ROUTES);
  return async (req) => {
    try {
      checkHost(
        req,
        port(),
        svc.trustedOrigins.map((o) => new URL(o.origin).host),
      );
      const url = new URL(req.url);
      const m = router.match(req.method, url.pathname);
      if (m.kind === "not_found") {
        // Client-side routes of the web shell; API paths stay strict 404s.
        if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/"))
          return webResponse(url.pathname);
        throw notFound();
      }
      if (m.kind === "method_not_allowed")
        throw new HttpError(405, "method_not_allowed", `allowed: ${m.allow.join(", ")}`);
      const h = m.route.handler;

      // Origin: a browser request from anywhere but a trusted origin is refused outright.
      const originHeader = req.headers.get("origin");
      const origin = originHeader
        ? svc.trustedOrigins.find((o) => o.origin === originHeader)
        : undefined;
      if (originHeader && !origin)
        throw new HttpError(403, "untrusted_origin", `origin ${originHeader} is not trusted`);

      const viaBearer = bearer(req);
      const viaCookie = viaBearer ? undefined : cookie(req, SESSION_COOKIE);
      // CSRF: cookie-authenticated writes must carry a trusted Origin.
      if (viaCookie && !SAFE_METHODS.has(req.method) && !origin) {
        throw new HttpError(
          403,
          "origin_required",
          "cookie-authenticated writes need a trusted Origin header",
        );
      }

      const base = { req, url, params: m.params, svc };
      if (h.auth === "none") return await h.run({ ...base, session: undefined as never });

      const raw = viaBearer ?? viaCookie;
      const session = raw ? svc.tokens.verify(raw, "session") : undefined;
      if (!session)
        throw new HttpError(401, "unauthenticated", "log in with `ablationkit login` first");

      return await h.run({ ...base, session });
    } catch (e) {
      return toErrorResponse(e);
    }
  };
}
