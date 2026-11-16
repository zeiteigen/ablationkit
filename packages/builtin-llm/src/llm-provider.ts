/**
 * The OpenAI-compatible endpoint adapter (spec §16 "Local LLM serving": vLLM, llama.cpp server,
 * Ollama; ADR 0021). One chat-completion call with a timeout, a bounded response, the provider's
 * reported usage (or none: never estimated) and the wall time.
 */

import type { ChatMessage, Usage } from "@ablationkit/llm-research";
import { usageOf } from "@ablationkit/llm-research";
import type { GenerationParams } from "@ablationkit/protocol";

export const MAX_COMPLETION_BYTES = 1024 * 1024;

export interface ChatRequest {
  readonly baseUrl: string;
  readonly data?: "adhoc" | "dataset";
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly params: GenerationParams;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface ChatResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly finish_reason?: string;
  readonly usage?: Usage;
  /** The model name the provider reports (may differ from the requested alias). */
  readonly model?: string;
  readonly latency_ms: number;
  readonly error?: {
    code: "unreachable" | "timeout" | "provider_error" | "bad_response" | "canceled";
    message: string;
    status?: number;
  };
}

export function chatBody(
  r: Pick<ChatRequest, "model" | "messages" | "params">,
): Record<string, unknown> {
  const p = r.params;
  return {
    model: r.model,
    messages: r.messages,
    stream: false,
    ...(p.temperature !== undefined ? { temperature: Number(p.temperature) } : {}),
    ...(p.top_p !== undefined ? { top_p: Number(p.top_p) } : {}),
    ...(p.max_tokens !== undefined ? { max_tokens: p.max_tokens } : {}),
    ...(p.seed !== undefined ? { seed: p.seed } : {}),
    ...(p.stop?.length ? { stop: p.stop } : {}),
  };
}

interface ProviderRequest {
  baseUrl: string;
  model?: string;
  path: string;
  method: string;
  body?: Record<string, unknown>;
  data: "adhoc" | "dataset" | "metadata";
}
let providerRequest: ((r: ProviderRequest) => Promise<Response>) | undefined;
export function configureProviderRequest(request: NonNullable<typeof providerRequest>): void {
  providerRequest = request;
}
export function inspectProvider(baseUrl: string): Promise<Response> {
  if (!providerRequest)
    return fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000), redirect: "error" });
  return providerRequest({ baseUrl, path: "models", method: "GET", data: "metadata" });
}
export async function chatCompletion(r: ChatRequest): Promise<ChatResult> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), r.timeoutMs);
  const onAbort = () => ctrl.abort(new Error("canceled"));
  r.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = providerRequest
        ? await providerRequest({
            baseUrl: r.baseUrl,
            model: r.model,
            path: "chat/completions",
            method: "POST",
            body: chatBody(r),
            data: r.data ?? "adhoc",
          })
        : await fetch(`${r.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            signal: ctrl.signal,
            redirect: "error",
            headers: {
              "content-type": "application/json",
              ...(r.apiKey ? { authorization: `Bearer ${r.apiKey}` } : {}),
            },
            body: JSON.stringify(chatBody(r)),
          });
    } catch (e) {
      const why = String((ctrl.signal.reason as Error | undefined)?.message ?? "");
      if (why === "timeout")
        return {
          ok: false,
          latency_ms: ms(),
          error: { code: "timeout", message: `no answer within ${r.timeoutMs} ms` },
        };
      if (why === "canceled")
        return { ok: false, latency_ms: ms(), error: { code: "canceled", message: "canceled" } };
      return {
        ok: false,
        latency_ms: ms(),
        error: { code: "unreachable", message: (e as Error).message.slice(0, 500) },
      };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_COMPLETION_BYTES)
      return {
        ok: false,
        latency_ms: ms(),
        error: {
          code: "bad_response",
          message: `response larger than ${MAX_COMPLETION_BYTES} bytes`,
        },
      };
    const text = new TextDecoder().decode(buf);
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        latency_ms: ms(),
        error: {
          code: res.ok ? "bad_response" : "provider_error",
          status: res.status,
          message: text.slice(0, 500),
        },
      };
    }
    if (!res.ok) {
      const err = j["error"];
      const msg =
        typeof err === "object" && err !== null
          ? String((err as Record<string, unknown>)["message"] ?? "")
          : String(err ?? "");
      return {
        ok: false,
        latency_ms: ms(),
        error: { code: "provider_error", status: res.status, message: (msg || text).slice(0, 500) },
      };
    }
    const choice = (j["choices"] as Record<string, unknown>[] | undefined)?.[0];
    const content = (choice?.["message"] as Record<string, unknown> | undefined)?.["content"];
    if (typeof content !== "string")
      return {
        ok: false,
        latency_ms: ms(),
        error: { code: "bad_response", message: "no choices[0].message.content in the response" },
      };
    const usage = usageOf(j["usage"]);
    return {
      ok: true,
      text: content,
      latency_ms: ms(),
      ...(typeof choice?.["finish_reason"] === "string"
        ? { finish_reason: choice["finish_reason"] as string }
        : {}),
      ...(usage ? { usage } : {}),
      ...(typeof j["model"] === "string" ? { model: j["model"] as string } : {}),
    };
  } finally {
    clearTimeout(timer);
    r.signal?.removeEventListener("abort", onAbort);
  }
}
