/** API 1 LLM bridge compatibility is owned by the feature extension. */

import { HttpError } from "@ablationkit/core/http";
import type { BackendLegacyPlan } from "@ablationkit/extension-host/backend";
import type { ExtensionManifest } from "@ablationkit/protocol";
import { compact } from "./helpers.ts";

type Json = Record<string, unknown>;
export function compatibilityPlan(
  pid: string,
  _ext: string,
  method: string,
  params: Json,
  cfg: ExtensionManifest["capability_config"],
): BackendLegacyPlan {
  if (method === "traces.get" || method === "evaluations.examples") {
    const key = method === "traces.get" ? "trace_id" : "evaluation_id";
    const id = params[key];
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw new HttpError(400, "invalid_request", `give a ${key}`);
    return { work: { kind: method, pid, id } };
  }
  const llm = cfg?.llm;
  if (!llm) throw new HttpError(403, "capability_denied", "no LLM allowlist");
  const raw =
    method === "llm.infer"
      ? [{ label: "a", ...(params as Json) }]
      : (params["variants"] as unknown);
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > 6 ||
    (method === "llm.compare" && raw.length < 2)
  )
    throw new HttpError(
      400,
      "invalid_request",
      method === "llm.compare" ? "variants must list 2..6 targets" : "give one target",
    );
  const variants = raw.map((v, i) => {
    const x = (v ?? {}) as Json;
    const t = (x["target"] ?? {}) as Json;
    const provider_id = String(t["provider_id"] ?? "");
    const model = String(t["model"] ?? "");
    if (!llm.targets.some((a) => a.provider_id === provider_id && a.model === model))
      throw new HttpError(
        403,
        "model_not_allowed",
        `${provider_id}/${model} is not in this extension's LLM allowlist (${llm.targets.map((a) => `${a.provider_id}/${a.model}`).join(", ")})`,
      );
    return compact({
      label: typeof x["label"] === "string" ? x["label"] : `v${i + 1}`,
      provider_id,
      model,
      prompt: x["prompt"],
      template: x["template"],
      params: x["params"],
    });
  });
  const inputs = params["inputs"];
  if (
    !Array.isArray(inputs) ||
    inputs.length < 1 ||
    inputs.length > 50 ||
    inputs.some((r) => typeof r !== "object" || r === null || Array.isArray(r))
  )
    throw new HttpError(
      400,
      "invalid_request",
      "inputs must be a list of 1..50 objects (golden sets are not available to extensions)",
    );
  const chars = JSON.stringify(inputs).length + JSON.stringify(variants).length;
  if (chars > llm.max_input_chars)
    throw new HttpError(
      413,
      "request_too_large",
      `this extension may send at most ${llm.max_input_chars} characters per request (got ${chars})`,
    );

  const calls = inputs.length * variants.length;
  return {
    work: { kind: "generation", pid, body: { variants, inputs, trace: true } },
    quotas: [{ key: "generation", count: calls, limit: llm.max_calls_per_hour }],
    ...(llm.max_cost_usd === undefined
      ? {}
      : { cost: { key: "generation-cost", max_usd: Number(llm.max_cost_usd) } }),
  };
}
export function compatibilityCost(view: Json): number {
  let usd = 0;
  for (const summary of Object.values((view["summary"] ?? {}) as Record<string, Json>)) {
    const cost = (summary["cost"] as Json | undefined)?.["estimated_usd"];
    if (typeof cost === "string" || typeof cost === "number") usd += Number(cost) || 0;
  }
  return usd;
}
