/**
 * Model lifecycle routes (spec §5.5, §5.6; ADR 0019): datasets, logged models, the registry,
 * classical evaluations and MLflow Projects. All are project-scoped. Agents (bound to the project)
 * get the reads; registry mutations, evaluation launches and MLproject launches are human only
 * (spec §5.6: agent views may not launch evaluation or mutate the registry without a separate grant).
 */
import type { MlflowTag } from "@ablationkit/tracking-mlflow";
import { HttpError, intParam, json, readJsonBody, str, stringList } from "../http.ts";
import type { EvaluationInput } from "../models/evaluations.ts";
import { compact } from "../state/audit.ts";
import { discoverMlproject, planLaunch } from "../tracking/mlprojects.ts";
import { envObject, limits } from "./jobs.ts";
import type { ResearchCall, ResearchOp } from "./research.ts";
import { safeArtifactPath } from "./tracking.ts";

const pid = (c: ResearchCall) => c.params["id"] as string;

function audit(c: ResearchCall, action: string, target: string, details?: Record<string, unknown>) {
  c.svc.audit.record({
    actor: compact({ kind: c.actor.kind, id: c.actor.id }),
    listener: c.listener,
    action,
    outcome: "allowed",
    project_id: pid(c),
    target,
    ...(details ? { details } : {}),
  });
}

function tagsField(body: Record<string, unknown>, key: string): MlflowTag[] | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new HttpError(400, "invalid_request", `\`${key}\` must be an object of strings`);
  return Object.entries(v).map(([k, val]) => {
    if (typeof val !== "string")
      throw new HttpError(400, "invalid_request", `${key}.${k} must be a string`);
    return { key: k, value: val };
  });
}

/** An optional string that may be empty (clearing a description). */
function text(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > 5000)
    throw new HttpError(
      400,
      "invalid_request",
      `\`${key}\` must be a string of at most 5000 chars`,
    );
  return v;
}

const SAFE_INLINE = new Set([
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/gif",
  "application/json",
]);

export const LIFECYCLE_OPS: readonly ResearchOp[] = [
  // ------------------------------------------------------------------ datasets
  {
    method: "GET",
    path: "/api/v1/projects/:id/datasets",
    action: "datasets.list",
    agent: true,
    run: async (c) => json(200, await c.svc.models.datasets(pid(c))),
  },
  // ------------------------------------------------------------- logged models
  {
    method: "GET",
    path: "/api/v1/projects/:id/models",
    action: "models.list",
    agent: true,
    run: async (c) =>
      json(
        200,
        await c.svc.models.listModels(
          pid(c),
          compact({
            max_results: intParam(c.url, "max_results", 100, 1, 1000),
            page_token: c.url.searchParams.get("page_token") ?? undefined,
            run_id: c.url.searchParams.get("run_id") ?? undefined,
          }),
        ),
      ),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/models/:mid",
    action: "models.read",
    agent: true,
    run: async (c) => json(200, await c.svc.models.modelDetail(pid(c), c.params["mid"] as string)),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/models/:mid/artifacts",
    action: "models.artifacts",
    agent: true,
    run: async (c) => {
      const m = await c.svc.models.requireModel(pid(c), c.params["mid"] as string);
      const path = safeArtifactPath(c.url.searchParams.get("path"), false);
      const files = await c.svc.tracking.client
        .listProxiedArtifacts(m.info.artifact_uri, path)
        .catch((e: unknown) => {
          throw new HttpError(503, "tracking_unavailable", String(e));
        });
      return json(200, { model_id: m.info.model_id, path: path ?? "", files });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/models/:mid/artifacts/download",
    action: "models.download",
    agent: false,
    run: async (c) => {
      const m = await c.svc.models.requireModel(pid(c), c.params["mid"] as string);
      const path = safeArtifactPath(c.url.searchParams.get("path"), true) as string;
      let upstream: Response;
      try {
        upstream = await c.svc.tracking.client.downloadProxiedArtifact(m.info.artifact_uri, path);
      } catch (e) {
        throw new HttpError(
          404,
          "not_found",
          `no file ${path} in model ${m.info.model_id}: ${String(e)}`,
        );
      }
      const type = (upstream.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      const filename = (path.split("/").at(-1) ?? "artifact").replaceAll(/[^A-Za-z0-9._-]/g, "_");
      audit(c, "models.download", m.info.model_id, { path });
      // Model files are untrusted: never active content on the coordinator origin.
      return new Response(upstream.body, {
        headers: compact({
          "content-type": SAFE_INLINE.has(type) ? type : "application/octet-stream",
          "content-length": upstream.headers.get("content-length") ?? undefined,
          "content-disposition": `attachment; filename="${filename}"`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
          "cache-control": "no-store",
        }),
      });
    },
  },
  // ------------------------------------------------------------------ registry
  {
    method: "GET",
    path: "/api/v1/projects/:id/registry",
    action: "registry.list",
    agent: true,
    run: async (c) => json(200, { registered_models: await c.svc.models.registryList(pid(c)) }),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/registry",
    action: "registry.create",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const name = str(body, "name");
      const rm = await c.svc.models.registryCreate(
        pid(c),
        compact({
          name,
          description: str(body, "description", { optional: true }),
          tags: tagsField(body, "tags"),
        }),
      );
      audit(c, "registry.create", name);
      c.svc.events.publish(pid(c), "registry.model.created", { name });
      return json(201, { registered_model: { name: rm.name } });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/registry/:name",
    action: "registry.read",
    agent: true,
    run: async (c) =>
      json(200, {
        registered_model: await c.svc.models.registryDetail(pid(c), c.params["name"] as string),
      }),
  },
  {
    method: "PATCH",
    path: "/api/v1/projects/:id/registry/:name",
    action: "registry.update",
    agent: false,
    run: async (c) => {
      const name = c.params["name"] as string;
      const body = await readJsonBody(c.req);
      const input = compact({
        description: text(body, "description"),
        tags: tagsField(body, "tags"),
        delete_tags: stringList(body, "delete_tags"),
      });
      await c.svc.models.registryUpdate(pid(c), name, input);
      audit(c, "registry.update", name, { fields: Object.keys(input) });
      return json(200, { registered_model: await c.svc.models.registryDetail(pid(c), name) });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/registry/:name/versions",
    action: "registry.version.create",
    agent: false,
    run: async (c) => {
      const name = c.params["name"] as string;
      const body = await readJsonBody(c.req);
      const v = await c.svc.models.registerVersion(
        pid(c),
        name,
        compact({
          model_id: str(body, "model_id"),
          description: str(body, "description", { optional: true }),
          tags: tagsField(body, "tags"),
        }),
      );
      audit(c, "registry.version.create", `${name}/${v.version}`, {
        model_id: str(body, "model_id"),
      });
      return json(201, { model_version: v });
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/projects/:id/registry/:name/versions/:version",
    action: "registry.version.update",
    agent: false,
    run: async (c) => {
      const name = c.params["name"] as string;
      const version = c.params["version"] as string;
      if (!/^[1-9][0-9]{0,9}$/.test(version))
        throw new HttpError(400, "invalid_request", "bad version");
      const body = await readJsonBody(c.req);
      const input = compact({
        description: text(body, "description"),
        tags: tagsField(body, "tags"),
        delete_tags: stringList(body, "delete_tags"),
      });
      await c.svc.models.versionUpdate(pid(c), name, version, input);
      audit(c, "registry.version.update", `${name}/${version}`, { fields: Object.keys(input) });
      return json(200, { registered_model: await c.svc.models.registryDetail(pid(c), name) });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/projects/:id/registry/:name/aliases/:alias",
    action: "registry.alias.set",
    agent: false,
    run: async (c) => {
      const name = c.params["name"] as string;
      const alias = c.params["alias"] as string;
      const body = await readJsonBody(c.req);
      const version = str(body, "version");
      if (!/^[1-9][0-9]{0,9}$/.test(version))
        throw new HttpError(400, "invalid_request", "bad version");
      await c.svc.models.setAlias(pid(c), name, alias, version);
      audit(c, "registry.alias.set", `${name}@${alias}`, { version });
      return json(200, { name, alias, version });
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/projects/:id/registry/:name/aliases/:alias",
    action: "registry.alias.delete",
    agent: false,
    run: async (c) => {
      const name = c.params["name"] as string;
      const alias = c.params["alias"] as string;
      await c.svc.models.deleteAlias(pid(c), name, alias);
      audit(c, "registry.alias.delete", `${name}@${alias}`);
      return json(200, { name, alias, deleted: true });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/registry/:name/resolve",
    action: "registry.resolve",
    agent: true,
    run: async (c) => {
      const alias = c.url.searchParams.get("alias") ?? undefined;
      const version = c.url.searchParams.get("version") ?? undefined;
      if (!alias === !version)
        throw new HttpError(400, "invalid_request", "give exactly one of alias or version");
      return json(
        200,
        await c.svc.models.resolve(pid(c), c.params["name"] as string, compact({ alias, version })),
      );
    },
  },
  // --------------------------------------------------------------- evaluations
  {
    method: "GET",
    path: "/api/v1/projects/:id/evaluations",
    action: "evaluations.list",
    agent: true,
    run: (c) => json(200, { evaluations: c.svc.evaluations.list(pid(c)) }),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/evaluations",
    action: "evaluations.create",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const rec = await c.svc.evaluations.create(
        pid(c),
        body as unknown as EvaluationInput,
        compact({
          kind: c.actor.kind === "agent" ? ("agent" as const) : ("human" as const),
          id: c.actor.id,
        }),
      );
      return json(202, { evaluation: rec });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/evaluations/:eid",
    action: "evaluations.read",
    agent: true,
    run: async (c) => json(200, await c.svc.evaluations.view(pid(c), c.params["eid"] as string)),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/evaluations/:eid/examples",
    action: "evaluations.examples",
    agent: true,
    run: async (c) =>
      json(200, await c.svc.evaluations.examples(pid(c), c.params["eid"] as string)),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/evaluations/:eid/log",
    action: "evaluations.log",
    agent: true,
    run: (c) =>
      new Response(c.svc.evaluations.logTail(pid(c), c.params["eid"] as string), {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      }),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/evaluations/:eid/cancel",
    action: "evaluations.cancel",
    agent: false,
    run: async (c) =>
      json(200, {
        evaluation: await c.svc.evaluations.cancel(
          pid(c),
          c.params["eid"] as string,
          compact({ kind: "human" as const, id: c.actor.id }),
        ),
      }),
  },
  // ------------------------------------------------------------ MLflow Projects
  {
    method: "GET",
    path: "/api/v1/projects/:id/mlproject",
    action: "mlproject.read",
    agent: true,
    run: (c) => {
      const p = c.svc.registry.require(pid(c));
      const info = discoverMlproject(p.path);
      // Agents see the entrypoints, not the coordinator's file layout.
      const { path: _path, ...rest } = info;
      return json(200, c.listener === "agent" ? rest : info);
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/mlproject/runs",
    action: "mlproject.run",
    agent: false,
    run: async (c) => {
      const p = c.svc.registry.require(pid(c));
      const body = await readJsonBody(c.req);
      const params = body["parameters"] ?? {};
      if (typeof params !== "object" || params === null || Array.isArray(params))
        throw new HttpError(400, "invalid_request", "`parameters` must be an object of strings");
      for (const [k, v] of Object.entries(params))
        if (typeof v !== "string")
          throw new HttpError(400, "invalid_request", `parameters.${k} must be a string`);
      const targetId = str(body, "target_id", { optional: true });
      const plan = planLaunch(p.path, {
        entrypoint: str(body, "entrypoint", { optional: true }) ?? "main",
        parameters: params as Record<string, string>,
        remote: targetId !== undefined && targetId !== "local",
      });
      const env = envObject(body);
      const environment = str(body, "environment", { optional: true });
      if (environment !== undefined && environment !== "uv" && environment !== "none")
        throw new HttpError(400, "invalid_request", "environment must be uv or none");
      const lim = limits(body);
      const { job, attempt } = c.svc.jobs.submit(
        compact({
          project_id: p.project_id,
          command: plan.command,
          environment: environment as "uv" | "none" | undefined,
          env,
          limits: lim,
          run_name:
            str(body, "run_name", { optional: true }) ?? `${plan.mlproject.entrypoint} (MLproject)`,
          study_id: str(body, "study_id", { optional: true }),
          variant_id: str(body, "variant_id", { optional: true }),
          mlproject: plan.mlproject,
          target_id: targetId,
          accept_cost: body["accept_cost"] === true ? true : undefined,
          submitted_by: compact({ kind: "human" as const, id: c.actor.id }),
        }),
      );
      return json(202, {
        job: c.svc.jobs.jobView(job, false),
        attempt: c.svc.jobs.attemptView(attempt),
        mlproject: plan.mlproject,
        environment_note: plan.info.environment.note,
      });
    },
  },
];
