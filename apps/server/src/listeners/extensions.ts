/**
 * Extension routes (spec §8; ADR 0022). Agents may list, validate, build, install from the
 * registry, run approved Python contributions and actions, and read executions. Approving,
 * enabling, rolling back (activation) and disabling are human-only. The capability bridge (`rpc`) is
 * human-only: it is called by the web shell on behalf of a mounted, sandboxed view.
 */
import type { ExtensionActor } from "@ablationkit/protocol";
import { HttpError, json, readJsonBody } from "../http.ts";
import { compact } from "../state/audit.ts";
import type { ResearchCall, ResearchOp } from "./research.ts";

const pid = (c: ResearchCall) => c.params["id"] as string;
const ext = (c: ResearchCall) => {
  const e = c.params["ext"] as string;
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(e))
    throw new HttpError(400, "invalid_request", "invalid extension id");
  return e;
};
const P = "/api/v1/projects/:id/extensions";
const X = "/api/v1/projects/:id/extension-executions";

function actor(c: ResearchCall): ExtensionActor {
  return compact({
    kind: c.actor.kind === "agent" ? ("agent" as const) : ("human" as const),
    id: c.actor.id,
  });
}

export const EXTENSION_OPS: readonly ResearchOp[] = [
  {
    method: "GET",
    path: "/api/v1/projects/:id/extension-catalog",
    action: "extension.catalog",
    agent: true,
    run: (c) => {
      c.svc.registry.require(pid(c));
      return json(200, c.svc.extensions.capabilityCatalog());
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/extension-registry",
    action: "extension.registry.list",
    agent: true,
    run: (c) => {
      c.svc.registry.require(pid(c));
      return json(200, { extensions: c.svc.extensions.registryList() });
    },
  },
  {
    method: "GET",
    path: P,
    action: "extension.list",
    agent: true,
    run: (c) =>
      json(200, {
        extensions: c.svc.extensions.list(pid(c)),
        safe_mode: c.svc.extensions.safeMode,
        host_api_version: (c.svc.extensions.capabilityCatalog() as { host_api_version: string })
          .host_api_version,
      }),
  },
  {
    method: "POST",
    path: `${P}/install`,
    action: "extension.install",
    agent: true,
    run: async (c) => {
      const b = await readJsonBody(c.req);
      return json(
        201,
        c.svc.extensions.install(
          pid(c),
          String(b["extension_id"] ?? ""),
          String(b["version"] ?? ""),
          actor(c),
        ),
      );
    },
  },
  {
    method: "GET",
    path: `${P}/:ext`,
    action: "extension.read",
    agent: true,
    run: (c) => json(200, { extension: c.svc.extensions.detail(pid(c), ext(c)) }),
  },
  {
    method: "POST",
    path: `${P}/:ext/validate`,
    action: "extension.validate",
    agent: true,
    run: (c) => {
      const i = c.svc.extensions.inspect(pid(c), ext(c));
      if (!i.present)
        throw new HttpError(404, "not_found", `no extension ${ext(c)} in the checkout`);
      return json(200, {
        ok: i.ok,
        diagnostics: i.diagnostics,
        build_id: i.build_id,
        source_sha256: i.source_sha256,
        lockfile_sha256: i.lockfile_sha256,
        capability_sha256: i.capability_sha256,
        files: i.files.length,
      });
    },
  },
  {
    method: "POST",
    path: `${P}/:ext/build`,
    action: "extension.build",
    agent: true,
    run: async (c) => {
      const b = await c.svc.extensions.buildExtension(pid(c), ext(c), actor(c));
      return json(b.status === "ready" ? 201 : 422, {
        build: c.svc.extensions.buildView(pid(c), b),
      });
    },
  },
  {
    method: "GET",
    path: `${P}/:ext/builds/:eb/diff`,
    action: "extension.diff",
    agent: true,
    run: (c) =>
      json(
        200,
        c.svc.extensions.diff(
          pid(c),
          ext(c),
          c.params["eb"] as string,
          c.url.searchParams.get("against") ?? undefined,
        ),
      ),
  },
  {
    method: "GET",
    path: `${P}/:ext/builds/:eb/file`,
    action: "extension.file",
    agent: true,
    run: (c) =>
      new Response(
        c.svc.extensions.sourceFile(
          pid(c),
          ext(c),
          c.params["eb"] as string,
          c.url.searchParams.get("path") ?? "",
        ),
        {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        },
      ),
  },
  {
    method: "POST",
    path: `${P}/:ext/approve`,
    action: "extension.approve",
    agent: false,
    run: async (c) =>
      json(200, {
        state: c.svc.extensions.approve(pid(c), ext(c), await readJsonBody(c.req), actor(c)),
      }),
  },
  {
    method: "POST",
    path: `${P}/:ext/enable`,
    action: "extension.enable",
    agent: false,
    run: (c) =>
      json(200, { state: c.svc.extensions.activate(pid(c), ext(c), undefined, actor(c)) }),
  },
  {
    method: "POST",
    path: `${P}/:ext/rollback`,
    action: "extension.rollback",
    agent: false,
    run: async (c) => {
      const b = await readJsonBody(c.req);
      if (typeof b["build_id"] !== "string")
        throw new HttpError(400, "invalid_request", "give build_id");
      return json(200, {
        state: c.svc.extensions.activate(pid(c), ext(c), b["build_id"] as string, actor(c)),
      });
    },
  },
  {
    method: "POST",
    path: `${P}/:ext/disable`,
    action: "extension.disable",
    agent: false,
    run: async (c) => {
      const b = await readJsonBody(c.req).catch(() => ({}));
      return json(200, { state: await c.svc.extensions.disable(pid(c), ext(c), b, actor(c)) });
    },
  },
  {
    method: "POST",
    path: `${P}/:ext/publish`,
    action: "extension.publish",
    agent: false,
    run: (c) => json(201, c.svc.extensions.publish(pid(c), ext(c), actor(c))),
  },
  {
    method: "POST",
    path: `${P}/:ext/rpc`,
    action: "extension.rpc",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req, 9 * 1024 * 1024);
      return json(200, {
        result: (await c.svc.extensions.rpc(pid(c), ext(c), body, actor(c), c.req.signal)) ?? null,
      });
    },
  },
  {
    method: "POST",
    path: `${P}/:ext/console`,
    action: "extension.console",
    agent: false,
    run: async (c) => {
      const b = await readJsonBody(c.req, 16 * 1024);
      const level = b["level"] === "error" || b["level"] === "warn" ? b["level"] : "info";
      c.svc.extensions.log(
        pid(c),
        ext(c),
        level,
        String(b["source"] ?? "view").slice(0, 80),
        String(b["message"] ?? ""),
      );
      return json(202, {});
    },
  },
  {
    method: "POST",
    path: `${P}/:ext/actions/:cid`,
    action: "extension.action",
    agent: true,
    run: async (c) =>
      json(200, {
        result: await c.svc.extensions.action(
          pid(c),
          ext(c),
          c.params["cid"] as string,
          actor(c),
          c.listener,
        ),
      }),
  },
  {
    method: "POST",
    path: `${P}/:ext/run`,
    action: "extension.execute",
    agent: true,
    run: async (c) => {
      const b = await readJsonBody(c.req);
      const x = await c.svc.extensions.runner.run(
        pid(c),
        ext(c),
        String(b["contribution"] ?? ""),
        { params: b["params"] ?? {}, refs: b["refs"] ?? [] },
        actor(c),
        compact({
          targetId: typeof b["target_id"] === "string" ? b["target_id"] : undefined,
          acceptCost: b["accept_cost"] === true ? true : undefined,
        }),
      );
      return json(202, { execution: c.svc.extensions.runner.view(x) });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/extension-mounts",
    action: "extension.mounts",
    agent: false,
    run: (c) =>
      json(200, {
        mounts: c.svc.extensions.mounts(pid(c), c.url.searchParams.get("point") ?? undefined),
        safe_mode: c.svc.extensions.safeMode,
      }),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/extension-snapshots",
    action: "extension.snapshot.list",
    agent: true,
    run: (c) =>
      json(200, {
        snapshots: c.svc.extensions.snapshots(
          pid(c),
          c.url.searchParams.get("report") ?? undefined,
        ),
      }),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/extension-snapshots/:sid/image",
    action: "extension.snapshot.image",
    agent: false,
    run: (c) =>
      new Response(c.svc.extensions.snapshotImage(pid(c), c.params["sid"] as string), {
        headers: {
          "content-type": "image/png",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
          "content-security-policy": "sandbox; default-src 'none'",
        },
      }),
  },
  {
    method: "GET",
    path: X,
    action: "extension.execution.list",
    agent: true,
    run: (c) =>
      json(200, {
        executions: c.svc.extensions.runner
          .list(pid(c), c.url.searchParams.get("extension") ?? undefined)
          .map((x) => c.svc.extensions.runner.view(x)),
      }),
  },
  {
    method: "GET",
    path: `${X}/:xid`,
    action: "extension.execution.read",
    agent: true,
    run: (c) => {
      const x = c.svc.extensions.runner.get(pid(c), c.params["xid"] as string);
      return json(200, { execution: { ...c.svc.extensions.runner.view(x), record: x } });
    },
  },
  {
    method: "GET",
    path: `${X}/:xid/log`,
    action: "extension.execution.log",
    agent: true,
    run: (c) =>
      new Response(c.svc.extensions.runner.logTail(pid(c), c.params["xid"] as string), {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      }),
  },
  {
    method: "POST",
    path: `${X}/:xid/cancel`,
    action: "extension.execution.cancel",
    agent: true,
    run: async (c) => {
      const x = await c.svc.extensions.runner.cancel(pid(c), c.params["xid"] as string, actor(c));
      return json(200, { execution: c.svc.extensions.runner.view(x) });
    },
  },
];
