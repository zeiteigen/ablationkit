/**
 * Research inference routes (spec §4.3 inference API, §5.6.1; ADR 0020). All are project-scoped.
 *
 * Running a model, starting or stopping a session and saving or deleting evidence are side effects
 * and stay on the human listener. Agents get the reads (adapters, sessions, evidence); an agent
 * that needs a warm model asks for a `preview_local` deployment, which the project policy gates
 * (ADR 0018) and which starts a session through the deployment launcher.
 */

import { HttpError, json, readJsonBody } from "../http.ts";
import type { ModelSelector } from "../models/models.ts";
import { compact } from "../state/audit.ts";
import type { ResearchCall, ResearchOp } from "./research.ts";

const pid = (c: ResearchCall) => c.params["id"] as string;
/** Images travel inline (base64, at most 8 MiB each), so predictions take larger bodies. */
const MAX_INFERENCE_BODY = 16 * 1024 * 1024;

function actor(c: ResearchCall) {
  return compact({
    kind: c.actor.kind === "agent" ? ("agent" as const) : ("human" as const),
    id: c.actor.id,
  });
}

function selectorFromQuery(url: URL): ModelSelector {
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  return compact({
    model_id: q("model_id"),
    name: q("name"),
    version: q("version"),
    alias: q("alias"),
  });
}

export const INFERENCE_OPS: readonly ResearchOp[] = [
  {
    method: "GET",
    path: "/api/v1/projects/:id/inference/describe",
    action: "inference.describe",
    agent: true,
    run: async (c) => json(200, await c.svc.inference.describe(pid(c), selectorFromQuery(c.url))),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/inference/predict",
    action: "inference.predict",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req, MAX_INFERENCE_BODY);
      return json(200, {
        result: await c.svc.inference.predict(pid(c), body, actor(c), c.req.signal),
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/inference/compare",
    action: "inference.compare",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req, MAX_INFERENCE_BODY);
      return json(200, {
        result: await c.svc.inference.compare(pid(c), body, actor(c), c.req.signal),
      });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/inference/results/:rid",
    action: "inference.result.read",
    agent: false,
    run: (c) => json(200, { result: c.svc.inference.result(pid(c), c.params["rid"] as string) }),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/inference/results/:rid/save",
    action: "inference.evidence.save",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      return json(201, {
        evidence: await c.svc.inference.save(pid(c), c.params["rid"] as string, body, actor(c)),
      });
    },
  },
  // ------------------------------------------------------------------ sessions
  {
    method: "GET",
    path: "/api/v1/projects/:id/inference/sessions",
    action: "inference.session.list",
    agent: true,
    run: (c) => json(200, { sessions: c.svc.inference.sessions.list(pid(c)) }),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/inference/sessions",
    action: "inference.session.start",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const s = await c.svc.inference.startSession(pid(c), body, actor(c));
      return json(s.state === "ready" ? 201 : 202, { session: s });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/inference/sessions/:sid",
    action: "inference.session.read",
    agent: true,
    run: async (c) =>
      json(200, {
        session: await c.svc.inference.sessions.view(pid(c), c.params["sid"] as string),
        adapter: c.svc.inference.sessions.adapterOf(c.params["sid"] as string),
      }),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/inference/sessions/:sid/predict",
    action: "inference.session.predict",
    agent: false,
    run: async (c) => {
      const sid = c.params["sid"] as string;
      const s = c.svc.inference.sessions.get(pid(c), sid);
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(c.req, s.limits.max_request_bytes);
      } catch (e) {
        if (e instanceof HttpError && e.status === 413)
          throw new HttpError(
            413,
            "request_too_large",
            `this session takes requests of at most ${s.limits.max_request_bytes} bytes`,
          );
        throw e;
      }
      return json(200, {
        result: await c.svc.inference.sessionPredict(pid(c), sid, body, actor(c)),
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/inference/sessions/:sid/stop",
    action: "inference.session.stop",
    agent: false,
    run: async (c) => {
      const sid = c.params["sid"] as string;
      c.svc.inference.sessions.get(pid(c), sid);
      return json(200, {
        session: await c.svc.inference.sessions.stop(
          sid,
          "stopped",
          "stopped by the researcher",
          actor(c),
        ),
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/inference/sessions/:sid/restart",
    action: "inference.session.restart",
    agent: false,
    run: async (c) =>
      json(202, {
        session: await c.svc.inference.sessions.restart(
          pid(c),
          c.params["sid"] as string,
          actor(c),
        ),
      }),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/inference/sessions/:sid/log",
    action: "inference.session.log",
    agent: false,
    run: (c) =>
      new Response(c.svc.inference.sessions.logTail(pid(c), c.params["sid"] as string), {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      }),
  },
  // ------------------------------------------------------------------ evidence
  {
    method: "GET",
    path: "/api/v1/projects/:id/inference/evidence",
    action: "inference.evidence.list",
    agent: true,
    run: (c) =>
      json(200, {
        evidence: c.svc.inference.listEvidence(pid(c), c.url.searchParams.get("deleted") === "1"),
      }),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/inference/evidence/:eid",
    action: "inference.evidence.read",
    agent: true,
    run: async (c) =>
      json(200, await c.svc.inference.evidenceView(pid(c), c.params["eid"] as string)),
  },
  {
    method: "DELETE",
    path: "/api/v1/projects/:id/inference/evidence/:eid",
    action: "inference.evidence.delete",
    agent: false,
    run: async (c) =>
      json(200, {
        evidence: await c.svc.inference.deleteEvidence(pid(c), c.params["eid"] as string, actor(c)),
      }),
  },
];
