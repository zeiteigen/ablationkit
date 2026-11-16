/** Capability dispatch for a trusted backend. The manager supplies lifecycle and scope. */
import { realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { BackendCaller } from "@ablationkit/extension-host/backend";
import { MlflowError } from "@ablationkit/tracking-mlflow";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import type { BackendBundle, LiveBackend } from "./backend-state.ts";
import { projectCapture } from "./capture.ts";
import type { ExtensionDataStore } from "./data.ts";
import type { ExtensionPolicyStore } from "./policy.ts";
import { callExtensionTracking } from "./tracking.ts";

export interface ExtensionBackendBrokerContext {
  svc: Services;
  data: ExtensionDataStore;
  policies: ExtensionPolicyStore;
  enabled: (pid: string, ext: string) => boolean;
  bundle: (ext: string, pid?: string) => BackendBundle;
  invoke: (
    pid: string,
    ext: string,
    method: string,
    params: Record<string, unknown>,
    actor: BackendCaller,
    allowWiden: boolean,
    canExecute: boolean,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

export async function callExtensionBackendBroker(
  context: ExtensionBackendBrokerContext,
  pid: string,
  ext: string,
  live: LiveBackend,
  method: string,
  raw: unknown,
): Promise<unknown> {
  if (!context.enabled(pid, ext))
    throw new HttpError(403, "extension_inactive", "Extension inactive");
  const envelope = raw as { invocation?: string; params: Record<string, unknown> };
  const p = envelope.params ?? {};
  const invocation = envelope.invocation ? live.invocations.get(envelope.invocation) : undefined;
  if (envelope.invocation && !invocation)
    throw new HttpError(403, "caller_expired", "Caller context expired");
  const actor = invocation?.actor ?? {
    kind: "agent" as const,
    id: `extension:${ext}:maintenance`,
  };
  const need = (cap: string) => {
    if (!live.bundle.manifest.capabilities.includes(cap))
      throw new HttpError(403, "capability_denied", cap);
  };
  const ensurePid = (value: unknown) => {
    if (value !== undefined && value !== pid)
      throw new HttpError(403, "forbidden_scope", "Cross-project access denied");
  };
  const humanOnly = () => {
    if (!invocation || actor.kind !== "human")
      throw new HttpError(403, "human_only", "Remote compute requires a researcher");
  };
  const ownJob = (id: string) => {
    const j = context.svc.jobs.get(id);
    return j && j.project_id === pid && j.via_extension === ext ? j : undefined;
  };
  switch (method) {
    case "services.call": {
      need("services.call");
      const target = String(p["extension"]);
      const service = String(p["service"]);
      if (!live.bundle.manifest.uses_services?.includes(`${target}/${service}`))
        throw new HttpError(403, "service_not_allowed", "Service dependency not approved");
      const targetBundle = context.bundle(target, pid);
      if (
        !targetBundle.manifest.services.includes(service) ||
        (actor.kind === "agent" && !targetBundle.manifest.service_agents?.includes(service))
      )
        throw new HttpError(403, "service_not_exported", "Service unavailable to caller");
      return context.invoke(
        pid,
        target,
        "service",
        { service, args: p["args"], actor },
        actor,
        false,
        !!invocation?.canExecute && live.bundle.manifest.capabilities.includes("executions.start"),
      );
    }
    case "tracking.ensure":
      need("tracking.write");
      return context.svc.tracking.ensureExperimentNow(pid);
    case "tracking.call": {
      need("tracking.read");
      try {
        return await callExtensionTracking(
          {
            client: context.svc.tracking.client,
            projectId: pid,
            experimentIds: () => context.svc.models.experimentIds(pid),
            ensureExperiment: () => context.svc.tracking.ensureExperimentNow(pid),
            capture: projectCapture(
              context.policies.list(pid).flatMap((p) => (p.capture ? [p.capture] : [])),
            ),
            writable: live.bundle.manifest.capabilities.includes("tracking.write"),
          },
          String(p["method"]),
          p["args"] as unknown[],
        );
      } catch (e) {
        if (e instanceof MlflowError) throw new HttpError(e.status ?? 503, "mlflow", e.message);
        throw e;
      }
    }
    case "audit.record":
      ensurePid(p["project_id"]);
      context.svc.audit.record({
        actor: { kind: actor.kind, id: actor.id },
        listener: actor.kind,
        action: String(p["action"] ?? "extension.action"),
        outcome: "allowed",
        project_id: pid,
        target: String(p["target"] ?? ""),
        details: (p["details"] ?? {}) as Record<string, unknown>,
      });
      return null;
    case "events.publish":
      need("events.publish");
      return context.svc.events.publish(
        pid,
        String(p["type"]),
        p["payload"] as Record<string, unknown>,
      );
    case "events.read": {
      need("events.subscribe");
      const after = Number(p["after"] ?? -1);
      const limit = Number(p["limit"] ?? 100);
      if (
        !Number.isSafeInteger(after) ||
        after < -1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new HttpError(400, "invalid_request", "Invalid event cursor or limit");
      const types = p["types"] as string[] | undefined;
      if (types && (!Array.isArray(types) || !types.every((type) => typeof type === "string")))
        throw new HttpError(400, "invalid_request", "Invalid event types");
      const events = [];
      let cursor = after;
      const last = context.svc.events.lastSeq;
      for await (const event of context.svc.events.replay(after, { projectId: pid })) {
        if (event.seq > last) break;
        cursor = event.seq;
        if (!types?.length || types.includes(event.type)) events.push(event);
        if (events.length === limit) return { events, cursor };
      }
      return { events, cursor: Math.max(cursor, last) };
    }
    case "research.get":
      need("project.research.read");
      return context.svc.research.get(pid, String(p["id"]));
    case "research.require":
      need("project.research.read");
      return context.svc.research.require(pid, String(p["id"]));
    case "research.list":
      need("project.research.read");
      return context.svc.research.list(pid, p["query"] as { link?: string });
    case "research.create":
      need("project.research.write");
      return context.svc.research.create(
        pid,
        p["kind"] as "report",
        p["input"] as Record<string, unknown>,
        actor,
        { listener: actor.kind },
      );
    case "research.update":
      need("project.research.write");
      return context.svc.research.update(
        pid,
        String(p["id"]),
        p["patch"] as Record<string, unknown>,
        actor,
      );
    case "policy.sync": {
      need("credentials.use");
      const current = context.policies.get(pid, ext);
      return context.policies.update(
        pid,
        ext,
        p as unknown as Parameters<ExtensionPolicyStore["update"]>[2],
        { expected_revision: current.revision, allowWiden: invocation?.allowWiden ?? false },
      );
    }
    case "network.request":
      need("credentials.use");
      if (!invocation?.canExecute) throw new HttpError(403, "human_only", "Researcher only");
      return context.policies.request(pid, ext, {
        ...p,
        ...(invocation?.signal ? { signal: invocation.signal } : {}),
      } as unknown as Parameters<ExtensionPolicyStore["request"]>[2]);
    case "execution.start": {
      need("executions.start");
      if (!invocation?.canExecute)
        throw new HttpError(403, "human_only", "Execution requires researcher");
      const id = String(p["id"]);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || live.runs.has(id))
        throw new HttpError(409, "execution_id", "Invalid or repeated execution ID");
      const opts = p["opts"] as Record<string, unknown>;
      const secretEnv: Record<string, string> = {};
      const grants = context.policies.get(pid, ext).destinations;
      for (const [name, handle] of Object.entries(
        (opts["secretEnv"] ?? {}) as Record<string, string>,
      )) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(name) || !handle.startsWith("credential:"))
          throw new HttpError(403, "credential_denied", "Use host credential handles");
        const source = handle.slice(11);
        if (!grants.some((g) => g.credential_env === source))
          throw new HttpError(
            403,
            "credential_denied",
            "Credential is not approved for this extension",
          );
        const value = process.env[source];
        if (!value)
          throw new HttpError(503, "credential_missing", "Configured credential is unavailable");
        secretEnv[name] = value;
      }
      const environment = opts["environment"] === "project" ? "project" : "managed";
      const run = await context.svc.bridge.start(id, p["request"] as Record<string, unknown>, {
        environment,
        projectPath: context.svc.registry.require(pid).path,
        timeoutSec: Math.max(1, Math.min(3600, Number(opts["timeoutSec"]) || 300)),
        memoryMb: Math.max(64, Math.min(65536, Number(opts["memoryMb"]) || 4096)),
        secretEnv,
        ...(live.bundle.manifest.workers?.[0]
          ? { scriptPath: join(live.bundle.root, live.bundle.manifest.workers[0]) }
          : {}),
      });
      live.runs.set(id, run);
      return { unit: run.unit, enforcement: run.enforcement };
    }
    case "execution.wait":
      need("executions.start");
      {
        const run = live.runs.get(String(p["id"]));
        if (!run) throw new HttpError(404, "unknown_execution", "No such execution");
        return run.done;
      }
    case "execution.stop":
      need("executions.start");
      {
        const run = live.runs.get(String(p["id"]));
        if (run) await run.stop();
        return null;
      }
    case "execution.reap":
      need("executions.start");
      {
        const id = String(p["id"]);
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
          throw new HttpError(400, "execution_id", "Invalid ID");
        context.svc.bridge.reap(id);
        return null;
      }
    case "data.get":
      need("data.read");
      return context.data.get(pid, ext, String(p["collection"]), String(p["key"]));
    case "data.list":
      need("data.read");
      return context.data.list(
        pid,
        ext,
        String(p["collection"]),
        p["query"] as { cursor?: string; limit?: number },
      );
    case "data.put":
      need("data.write");
      return context.data.put(
        pid,
        ext,
        String(p["collection"]),
        String(p["key"]),
        p["record"] as Parameters<ExtensionDataStore["put"]>[4],
      );
    case "data.migrate":
      need("data.write");
      return context.data.migrateRecords(
        pid,
        ext,
        String(p["collection"]),
        p["input"] as Parameters<ExtensionDataStore["migrateRecords"]>[3],
      );
    case "data.delete":
      need("data.write");
      return context.data.delete(
        pid,
        ext,
        String(p["collection"]),
        String(p["key"]),
        Number(p["revision"]),
      );
    case "data.blob.put":
      need("data.write");
      return context.data.putBlob(pid, ext, p["bytes"] as unknown as Uint8Array);
    case "data.blob.get":
      need("data.read");
      return context.data.getBlob(pid, ext, String(p["sha256"]));
    // Remote compute (`compute.remote`, ADR 0024): jobs on a compute target carrying staged
    // inputs. Submitting, checking and cancelling need a researcher; reads and cancels cover only
    // this extension's own jobs in this project.
    case "compute.target": {
      need("compute.remote");
      const t = context.svc.targets.get(String(p["target_id"]));
      return t
        ? { target_id: t.target_id, kind: t.kind, ...(t.python ? { python: t.python } : {}) }
        : null;
    }
    case "compute.check": {
      need("compute.remote");
      humanOnly();
      context.svc.remote.check(String(p["target_id"]), {
        acceptCost: p["accept_cost"] === true,
        runtimeSec: Number(p["runtime_sec"]),
      });
      return null;
    }
    case "compute.submit": {
      need("compute.remote");
      humanOnly();
      const root = `${realpathSync(join(context.svc.paths.stateDir, pid))}${sep}`;
      const inputs = ((p["inputs"] ?? []) as { name?: unknown; path?: unknown }[]).map((i) => {
        const name = String(i.name);
        if (!/^[a-z][a-z0-9_-]{0,40}$/.test(name))
          throw new HttpError(400, "invalid_request", `bad input name ${name}`);
        let real: string;
        try {
          real = realpathSync(String(i.path));
        } catch {
          throw new HttpError(400, "invalid_request", `input ${name} does not exist`);
        }
        if (!real.startsWith(root) || !statSync(real).isDirectory())
          throw new HttpError(
            403,
            "forbidden_scope",
            `input ${name} must be a directory in the project's state`,
          );
        return { name, path: real };
      });
      const r = context.svc.jobs.submit({
        project_id: pid,
        command: (p["command"] as unknown[]).map(String),
        environment: p["environment"] === "uv" ? "uv" : "none",
        limits: { runtime_max_sec: Number(p["runtime_max_sec"]) },
        run_name: String(p["run_name"]).slice(0, 250),
        target_id: String(p["target_id"]),
        accept_cost: p["accept_cost"] === true,
        bundle_inputs: inputs,
        submitted_by: actor.id ? { kind: "human", id: actor.id } : { kind: "human" },
        via_extension: ext,
      });
      return {
        job_id: r.job.job_id,
        attempt_id: r.attempt.attempt_id,
        ...(r.attempt.remote?.source_commit
          ? { source_commit: r.attempt.remote.source_commit }
          : {}),
      };
    }
    case "compute.job": {
      need("compute.remote");
      const job = ownJob(String(p["job_id"]));
      if (!job) return null;
      const a = context.svc.jobs.latestAttempt(job);
      if (!a) return { job_id: job.job_id };
      const run = context.svc.tracking.mappings.get(a.attempt_id)?.mlflow_run_id;
      return {
        job_id: job.job_id,
        attempt: {
          attempt_id: a.attempt_id,
          state: a.state,
          ...(a.exit_code !== undefined ? { exit_code: a.exit_code } : {}),
          ...(a.error ? { error: a.error } : {}),
          ...(a.remote?.sync ? { sync: a.remote.sync } : {}),
          ...(a.remote?.reconcile_required
            ? { reconcile_required: a.remote.reconcile_required }
            : {}),
          artifacts: a.artifacts.map((x) => x.path),
          ...(run ? { mlflow_run_id: run } : {}),
        },
      };
    }
    case "compute.cancel": {
      need("compute.remote");
      humanOnly();
      const job = ownJob(String(p["job_id"]));
      if (!job) throw new HttpError(404, "job_not_found", "No such job of this extension");
      context.svc.jobs.cancel(job.job_id);
      return null;
    }
    default:
      throw new HttpError(403, "method_not_allowed", `Unknown backend broker method ${method}`);
  }
}
