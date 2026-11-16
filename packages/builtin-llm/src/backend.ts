/** LLM research backend. Domain services execute in the extension subprocess. */

import { AsyncLocalStorage } from "node:async_hooks";
import type { BackendCaller, BackendContext } from "@ablationkit/extension-host/backend";
import { pythonBridge, researchHost } from "@ablationkit/extension-host/backend-client";
import type { ExtensionManifest } from "@ablationkit/protocol";
import { compatibilityCost, compatibilityPlan } from "./compatibility.ts";
import { LlmService } from "./llm.ts";
import { configureProviderRequest } from "./llm-provider.ts";
import { LLM_OPS } from "./routes.ts";

export default function backend(initial: BackendContext) {
  const invocation = new AsyncLocalStorage<string>();
  const ctx: BackendContext = {
    ...initial,
    call: (method, params) => initial.call(method, { invocation: invocation.getStore(), params }),
    notify: (method, params) =>
      initial.notify(method, { invocation: invocation.getStore(), params }),
  };
  const svc = researchHost(ctx);
  const llm = new LlmService({
    svc: () => svc,
    stateDir: ctx.stateDir,
    bridge: pythonBridge(ctx),
    now: () => new Date(ctx.now),
    env: () => Object.fromEntries(ctx.credentialNames.map((n) => [n, `credential:${n}`])),
    retentionSweepMs: 0,
    detach: (fn) => invocation.exit(fn),
  });
  llm.load([ctx.project.project_id]);
  llm.start();
  configureProviderRequest(async (r) => {
    const provider = llm.settings
      .get(ctx.project.project_id)
      .providers.find((p) => p.base_url === r.baseUrl && (!r.model || p.models.includes(r.model)));
    if (!provider) throw new Error("Provider not configured");
    await syncPolicy();
    return ctx.call<Response>("network.request", {
      destination: provider.provider_id,
      path: r.path,
      method: r.method,
      ...(r.body ? { body: r.body } : {}),
      data: r.data,
      model: r.model,
    });
  });
  async function syncPolicy(s = llm.settings.get(ctx.project.project_id)) {
    return ctx.call("policy.sync", {
      destinations: s.providers.map((p) => ({
        id: p.provider_id,
        base_url: p.base_url,
        ...(p.api_key_env ? { credential_env: p.api_key_env } : {}),
        models: p.models,
        metadata_paths: ["models"],
        allow_external: p.locality === "local" || !!p.egress,
        allow_dataset: p.locality === "local" || !!p.egress?.allow_datasets,
      })),
      capture: s.capture,
    });
  }
  return {
    async call(method: string, raw: unknown, { signal }: { signal: AbortSignal }) {
      const p = raw as {
        invocation: string;
        snapshot: Partial<BackendContext>;
        operation?: string;
        url: string;
        params: Record<string, string>;
        body?: string;
        method: string;
        actor: BackendCaller;
        service?: string;
        args?: unknown[];
      };
      Object.assign(ctx, p.snapshot);
      return invocation.run(p.invocation, async () => {
        if (method === "operation") {
          const op = LLM_OPS.find((x) => x.action === p.operation);
          if (!op) throw new Error("Unknown operation");
          if (p.operation === "llm.evaluation.create") await syncPolicy();
          const req = new Request(p.url, {
            method: p.method,
            signal,
            ...(p.body ? { headers: { "content-type": "application/json" }, body: p.body } : {}),
          });
          if (p.operation === "llm.settings.update" || p.operation === "llm.settings.widen") {
            const next = llm.settings.update(
              ctx.project.project_id,
              (await req.clone().json()) as Record<string, unknown>,
              { ...p.actor, kind: "human" },
              p.operation === "llm.settings.widen",
              true,
            );
            await syncPolicy(next);
          }
          return op.run({
            req,
            url: new URL(req.url),
            params: p.params,
            svc: { ...svc, llm },
            actor: p.actor,
            listener: p.actor.kind,
          });
        }
        const args = p.args ?? [];
        // Service exports are explicit; prototype properties and arbitrary method traversal are refused.
        switch (p.service) {
          case "compat.plan":
            return compatibilityPlan(
              args[0] as string,
              args[1] as string,
              args[2] as string,
              args[3] as Record<string, unknown>,
              args[4] as ExtensionManifest["capability_config"],
            );
          case "compat.execute": {
            const work = args[0] as {
              kind: string;
              pid: string;
              id: string;
              body: Record<string, unknown>;
            };
            if (work.kind === "traces.get")
              return { result: await llm.traces.get(work.pid, work.id) };
            if (work.kind === "evaluations.examples")
              return { result: await llm.evaluations.examples(work.pid, work.id, "agent") };
            if (work.kind !== "generation") throw new Error("Unknown compatibility operation");
            const record = await llm.playground.run(
              work.pid,
              work.body,
              { ...p.actor, kind: "human" },
              signal,
            );
            const result = llm.playground.view(record);
            return { result, estimated_usd: compatibilityCost(result) };
          }

          case "trace.prepare":
            return llm.traces.prepareJobTrace(
              args[0] as string,
              args[1] as Record<string, unknown>,
              args[2] as { attempt_id: string; job_id: string; remote?: boolean },
            );
          case "traces.get":
            return llm.traces.get(args[0] as string, args[1] as string);
          case "traces.write":
            return llm.traces.write(
              args[0] as string,
              args[1] as Parameters<typeof llm.traces.write>[1],
            );
          case "evaluations.examples":
            return llm.evaluations.examples(args[0] as string, args[1] as string, "agent");
          case "playground.run": {
            const r = await llm.playground.run(
              args[0] as string,
              args[1] as Record<string, unknown>,
              { ...p.actor, kind: "human" },
              signal,
            );
            return llm.playground.view(r);
          }
          case "settings.update": {
            const next = llm.settings.update(
              args[0] as string,
              args[1] as Record<string, unknown>,
              { ...p.actor, kind: "human" },
              false,
              true,
            );
            await syncPolicy(next);
            return llm.settings.update(
              args[0] as string,
              args[1] as Record<string, unknown>,
              { ...p.actor, kind: "human" },
              false,
            );
          }
          case "sweep":
            return llm.sweep();
          default:
            throw new Error("Unknown extension service");
        }
      });
    },
    shutdown: () => llm.shutdown(),
  };
}
