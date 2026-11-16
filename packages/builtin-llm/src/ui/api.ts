import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export interface CallOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}
export interface CoordinatorEvent {
  seq: number;
  type: string;
  project_id?: string;
  ts?: string;
  payload: Record<string, unknown>;
}
type Context = { pid: string; base: string; rest: string };
type Pending = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  signal?: AbortSignal | undefined;
  abort?: (() => void) | undefined;
};
let port: MessagePort | undefined;
let context: Context | undefined;
let nextId = 0;
const pending = new Map<number, Pending>();
const eventListeners = new Set<(event: CoordinatorEvent) => void>();
const contextListeners = new Set<(value: Context) => void>();
const ready = new Promise<void>((resolve) => {
  const onMessage = (event: MessageEvent) => {
    if (
      event.source !== window.parent ||
      event.data?.type !== "ablationkit.backend.connect" ||
      !event.ports[0]
    )
      return;
    window.removeEventListener("message", onMessage);
    port = event.ports[0];
    port.onmessage = ({ data }: MessageEvent) => {
      if (
        data?.type === "context" ||
        data?.context ||
        (typeof data?.pid === "string" && typeof data?.base === "string")
      ) {
        context = data.context ?? data;
        for (const listener of contextListeners) listener(context as Context);
        resolve();
        return;
      }
      if (data?.type === "event" || data?.event) {
        for (const listener of eventListeners) listener((data.event ?? data) as CoordinatorEvent);
        return;
      }
      if (typeof data?.id === "number") {
        const entry = pending.get(data.id);
        if (!entry) return;
        pending.delete(data.id);
        entry.signal?.removeEventListener("abort", entry.abort as () => void);
        if (data.error)
          entry.reject(
            new ApiError(
              Number(data.error.status ?? 500),
              String(data.error.code ?? "host_error"),
              String(data.error.message ?? "Host request failed"),
              data.error.details ?? {},
            ),
          );
        else entry.resolve(data.result);
      }
    };
    port.start();
    if (event.data.context) {
      context = event.data.context;
      for (const listener of contextListeners) listener(context as Context);
      resolve();
    }
  };
  window.addEventListener("message", onMessage);
  window.parent.postMessage({ type: "ablationkit.backend.hello" }, "*");
});

function request<T>(
  method: "request" | "navigate" | "subscribe",
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return ready.then(
    () =>
      new Promise<T>((resolve, reject) => {
        const id = ++nextId;
        const abort = () => {
          pending.delete(id);
          reject(new DOMException("The operation was aborted", "AbortError"));
        };
        if (signal?.aborted) return abort();
        pending.set(id, { resolve, reject, signal, abort });
        signal?.addEventListener("abort", abort, { once: true });
        port?.postMessage({ id, method, params });
      }),
  );
}

export async function api<T = Record<string, unknown>>(
  path: string,
  opts: CallOptions = {},
): Promise<T> {
  return request<T>(
    "request",
    {
      path,
      init: {
        method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
        ...(opts.body === undefined ? {} : { body: opts.body }),
      },
    },
    opts.signal,
  );
}
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const value = u.toString();
  return value ? `?${value}` : "";
}
export interface Loaded<T> {
  data: T | undefined;
  error: ApiError | Error | undefined;
  loading: boolean;
  reload(): void;
}
export function useApi<T = Record<string, unknown>>(
  path: string | undefined,
  opts: { pollMs?: number } = {},
): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError | Error>();
  const [loading, setLoading] = useState(path !== undefined);
  const [tick, setTick] = useState(0);
  const shown = useRef<string | undefined>(undefined);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick explicitly triggers a user-requested refresh
  useEffect(() => {
    if (path === undefined) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    if (shown.current !== path) setLoading(true);
    api<T>(path, { signal: controller.signal }).then(
      (value) => {
        shown.current = path;
        setData(value);
        setError(undefined);
        setLoading(false);
      },
      (e: unknown) => {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [path, tick]);
  useEffect(() => {
    if (!opts.pollMs || path === undefined) return;
    const timer = setInterval(reload, opts.pollMs);
    return () => clearInterval(timer);
  }, [opts.pollMs, path, reload]);
  return { data, error, loading, reload };
}
export function useEvents(
  cb: (e: CoordinatorEvent) => void,
  filter: { project?: string; types?: readonly string[] } = {},
): void {
  const ref = useRef(cb);
  ref.current = cb;
  const types = filter.types?.join(",");
  useEffect(() => {
    let active = true;
    const subscriptionId = ++nextId;
    const listener = (event: CoordinatorEvent) => {
      if (!active) return;
      if (filter.project && event.project_id && event.project_id !== filter.project) return;
      if (types && !types.split(",").includes(event.type)) return;
      ref.current(event);
    };
    eventListeners.add(listener);
    void request("subscribe", {
      subscription_id: subscriptionId,
      project: filter.project,
      types: types?.split(","),
      active: true,
    }).catch(() => undefined);
    return () => {
      active = false;
      eventListeners.delete(listener);
      void request("subscribe", {
        subscription_id: subscriptionId,
        project: filter.project,
        types: types?.split(","),
        active: false,
      }).catch(() => undefined);
    };
  }, [filter.project, types]);
}
export function useBackendContext(): Context | undefined {
  const [value, setValue] = useState(context);
  useEffect(() => {
    if (context) setValue(context);
    contextListeners.add(setValue);
    return () => {
      contextListeners.delete(setValue);
    };
  }, []);
  return value;
}
export function navigate(path: string): void {
  void request("navigate", { path }).catch(() => undefined);
}
