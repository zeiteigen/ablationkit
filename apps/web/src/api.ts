/**
 * The human API client. The browser authenticates with the `ak_session` cookie set by the
 * one-time login link; the coordinator requires a trusted `Origin` on writes, which browsers send
 * on same-origin non-GET fetches. Errors are always `{error: {code, message, ...}}`.
 */
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

export async function api<T = Record<string, unknown>>(
  path: string,
  opts: CallOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers,
    credentials: "same-origin",
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const text = await r.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const err = (data as { error?: { code?: string; message?: string } }).error ?? {};
    const { code, message, ...rest } = err as Record<string, unknown>;
    throw new ApiError(
      r.status,
      String(code ?? "http_error"),
      String(message ?? `${r.status} ${r.statusText}`),
      rest,
    );
  }
  // 202 bodies (tracking_pending) are successes the caller may inspect.
  return data as T;
}

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

export interface Loaded<T> {
  data: T | undefined;
  error: ApiError | Error | undefined;
  loading: boolean;
  reload: () => void;
}

/** GET `path` (undefined skips), re-fetching when it changes or on `reload()`. */
export function useApi<T = Record<string, unknown>>(
  path: string | undefined,
  opts: { pollMs?: number } = {},
): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError | Error>();
  const [loading, setLoading] = useState(path !== undefined);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // Show "loading" only for a new path, not for background reloads.
  const shown = useRef<string | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a refetch
  useEffect(() => {
    if (path === undefined) {
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    if (shown.current !== path) setLoading(true);
    api<T>(path, { signal: ac.signal }).then(
      (d) => {
        shown.current = path;
        setData(d);
        setError(undefined);
        setLoading(false);
      },
      (e: unknown) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
    return () => ac.abort();
  }, [path, tick]);

  useEffect(() => {
    if (!opts.pollMs || path === undefined) return;
    const t = setInterval(reload, opts.pollMs);
    return () => clearInterval(t);
  }, [opts.pollMs, path, reload]);

  return { data, error, loading, reload };
}

// ----------------------------------------------------------------- events (SSE)

export interface CoordinatorEvent {
  seq: number;
  type: string;
  project_id?: string;
  ts?: string;
  payload: Record<string, unknown>;
}

type Listener = (e: CoordinatorEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | undefined;
let connected = false;
const connListeners = new Set<(c: boolean) => void>();

function setConnected(c: boolean): void {
  connected = c;
  for (const l of connListeners) l(c);
}

function ensureSource(): void {
  if (source || typeof EventSource === "undefined") return;
  // Only events from now on; pages load current state over REST.
  const s = new EventSource("/api/v1/events/stream?after=latest&format=message");
  source = s;
  s.onopen = () => setConnected(true);
  s.onerror = () => setConnected(false);
  const dispatch = (m: MessageEvent<string>) => {
    try {
      const e = JSON.parse(m.data) as CoordinatorEvent;
      for (const l of listeners) l(e);
    } catch {
      // ignore malformed frames
    }
  };
  s.onmessage = dispatch;
}

/** Subscribe to coordinator events (optionally only one project's). */
export function useEvents(
  cb: Listener,
  filter: { project?: string | undefined; types?: readonly string[] } = {},
): void {
  const ref = useRef(cb);
  ref.current = cb;
  const types = filter.types?.join(",");
  useEffect(() => {
    ensureSource();
    const wanted = types ? new Set(types.split(",")) : undefined;
    const l: Listener = (e) => {
      if (filter.project && e.project_id && e.project_id !== filter.project) return;
      if (wanted && !wanted.has(e.type)) return;
      ref.current(e);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [filter.project, types]);
}

export function useEventsConnected(): boolean {
  const [c, setC] = useState(connected);
  useEffect(() => {
    ensureSource();
    connListeners.add(setC);
    return () => {
      connListeners.delete(setC);
    };
  }, []);
  return c;
}
