/** Host facades over the versioned, project-scoped IPC broker. */
import { join } from "node:path";
import { type MlflowClient, MlflowError } from "@ablationkit/tracking-mlflow";
import type { BackendContext, ExtensionPythonBridge, ExtensionResearchHost } from "./backend.ts";

export function researchHost(ctx: BackendContext): ExtensionResearchHost {
  const scope = (pid: string) => {
    if (pid !== ctx.project.project_id) throw new Error("Project scope denied");
  };
  const client = new Proxy(
    {},
    {
      get:
        (_, method: string) =>
        async (...args: unknown[]) => {
          try {
            return await ctx.call("tracking.call", { method, args });
          } catch (e) {
            const error = e as Error & { mlflow_code?: string; code?: string; status?: number };
            if (error.code === "mlflow")
              throw new MlflowError("rejected", error.message, error.status);
            throw e;
          }
        },
    },
  ) as MlflowClient;
  return {
    registry: {
      list: () => [ctx.project],
      require: (pid) => {
        scope(pid);
        return ctx.project;
      },
    },
    models: {
      experimentIds: (pid) => {
        scope(pid);
        return ctx.experimentIds;
      },
    },
    tracking: {
      client,
      ensureExperimentNow: async (pid) => {
        scope(pid);
        const id = await ctx.call<string>("tracking.ensure", {});
        if (!ctx.experimentIds.includes(id)) ctx.experimentIds.push(id);
        ctx.links.experiment_id = id;
        return id;
      },
      mappings: {
        getLinks: (pid) => {
          scope(pid);
          return ctx.links;
        },
      },
    },
    audit: { record: (event) => ctx.notify("audit.record", event) },
    events: {
      publish: (pid, type, payload) => {
        scope(pid);
        ctx.notify("events.publish", { type, payload });
      },
    },
    compute: {
      target: (id) => ctx.call("compute.target", { target_id: id }),
      check: async (targetId, opts) => {
        await ctx.call("compute.check", {
          target_id: targetId,
          accept_cost: opts.acceptCost,
          runtime_sec: opts.runtimeSec,
        });
      },
      submit: (input) => ctx.call("compute.submit", input),
      job: (jobId) => ctx.call("compute.job", { job_id: jobId }),
      cancel: async (jobId) => {
        await ctx.call("compute.cancel", { job_id: jobId });
      },
    },
    research: {
      get: (pid, id) => {
        scope(pid);
        return ctx.call("research.get", { id });
      },
      require: (pid, id) => {
        scope(pid);
        return ctx.call("research.require", { id });
      },
      list: (pid, query) => {
        scope(pid);
        return ctx.call("research.list", { query });
      },
      create: (pid, kind, input, actor, opts) => {
        scope(pid);
        return ctx.call("research.create", { kind, input, actor, opts });
      },
      update: (pid, id, patch, actor) => {
        scope(pid);
        return ctx.call("research.update", { id, patch, actor });
      },
    },
  };
}
export function pythonBridge(ctx: BackendContext): ExtensionPythonBridge {
  return {
    available: () => ctx.bridgeAvailable,
    reap: (id) => ctx.notify("execution.reap", { id }),
    logPath: (id) => join(ctx.operationDir, id, "bridge.log"),
    start: async (id, request, opts) => {
      const info = await ctx.call<{ unit: string; enforcement: "enforced" | "advisory" }>(
        "execution.start",
        { id, request, opts },
      );
      return {
        id,
        ...info,
        done: ctx.call("execution.wait", { id }),
        stop: () => ctx.call<void>("execution.stop", { id }),
      };
    },
  };
}
