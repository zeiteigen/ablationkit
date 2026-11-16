/** Bundled compatibility routes are declarations, dispatched through the extension host. */
import { BUNDLED_EXTENSIONS } from "../extensions/bundled.ts";
import { json, readJsonBody } from "../http.ts";
import type { ResearchOp } from "./research.ts";

const P = "/api/v1/projects/:id";
export const BACKEND_OPS: readonly ResearchOp[] = BUNDLED_EXTENSIONS.flatMap(({ manifest }) =>
  manifest.operations.map((op) => ({
    method: op.method,
    path: `${P}${manifest.pages[0]?.path ?? ""}${op.path}`,
    action: op.id,
    agent: op.agent,
    run: async (c) =>
      c.svc.backends.operation(
        c.params["id"] as string,
        manifest.id,
        op.id,
        {
          url: c.req.url,
          method: c.req.method,
          params: c.params,
          ...(c.req.method === "GET" ? {} : { body: await c.req.text() }),
        },
        { ...c.actor, kind: c.listener },
        c.req.signal,
      ),
  })),
);
export const BACKEND_MANAGEMENT_OPS: readonly ResearchOp[] = [
  {
    method: "GET",
    path: `${P}/extensions/:ext/backend/pages/:page`,
    action: "extension.backend.page",
    agent: false,
    run: (c) =>
      c.svc.backends.page(
        c.params["id"] as string,
        c.params["ext"] as string,
        c.params["page"] as string,
      ),
  },
  {
    method: "GET",
    path: `${P}/extension-backends`,
    action: "extension.backends.list",
    agent: true,
    run: (c) => json(200, { extensions: c.svc.backends.list(c.params["id"] as string) }),
  },
  {
    method: "POST",
    path: `${P}/extensions/:ext/backend/disable`,
    action: "extension.backend.disable",
    agent: false,
    run: async (c) => {
      await c.svc.backends.setEnabled(c.params["id"] as string, c.params["ext"] as string, false, {
        kind: "human",
        ...(c.actor.id ? { id: c.actor.id } : {}),
      });
      return json(200, { enabled: false });
    },
  },
  {
    method: "POST",
    path: `${P}/extensions/:ext/backend/enable`,
    action: "extension.backend.enable",
    agent: false,
    run: async (c) => {
      await c.svc.backends.setEnabled(c.params["id"] as string, c.params["ext"] as string, true, {
        kind: "human",
        ...(c.actor.id ? { id: c.actor.id } : {}),
      });
      return json(200, { enabled: true });
    },
  },
  {
    method: "POST",
    path: `${P}/extensions/:ext/operations/:operation`,
    action: "extension.operation",
    // Human-only operations refuse an agent caller (BackendService.operation).
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const manifest = c.svc.backends.bundle(
        c.params["ext"] as string,
        c.params["id"] as string,
      ).manifest;
      const op = manifest.operations.find((x) => x.id === c.params["operation"]);
      return c.svc.backends.operation(
        c.params["id"] as string,
        c.params["ext"] as string,
        c.params["operation"] as string,
        {
          url: new URL(String(body["path"] ?? op?.path ?? "/"), c.req.url).href,
          method: op?.method ?? "POST",
          params: { ...(body["params"] as Record<string, string>), id: c.params["id"] as string },
          ...(body["body"] === undefined ? {} : { body: JSON.stringify(body["body"]) }),
        },
        { ...c.actor, kind: c.listener },
        c.req.signal,
      );
    },
  },
];
