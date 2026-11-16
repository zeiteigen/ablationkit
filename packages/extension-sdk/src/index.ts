/**
 * @ablationkit/extension-sdk (host API 1.x): the extension side of the sandboxed view bridge
 * (spec §8.2 item 6, §8.4; ADR 0022).
 *
 * A UI contribution runs in an opaque-origin iframe (`sandbox="allow-scripts"`, CSP
 * `connect-src 'none'`): it cannot fetch, read cookies or reach the coordinator, MLflow or a
 * worker. Its only channel is a MessagePort the host hands over after a hello. Every call names a
 * bridge method; the host forwards it to the coordinator, which checks the extension's approved
 * build, project and capabilities, quotas and payload size on every call.
 *
 * ```ts
 * import { connect } from "@ablationkit/extension-sdk";
 * const host = await connect();
 * const runs = await host.call("runs.list", { limit: 20 });
 * ```
 */

export const SDK_VERSION = "1.0.0";
export const PROTOCOL = "ablationkit.ext/1";

export type ContributionPoint =
  | "project.panel"
  | "run.tab"
  | "comparison.view"
  | "report.block"
  | "model.demo";

/** What the host tells a view about where it is mounted. */
export interface HostContext {
  readonly project_id: string;
  readonly extension_id: string;
  readonly build_id: string;
  readonly contribution: {
    readonly id: string;
    readonly point: ContributionPoint;
    readonly title: string;
  };
  /** Granted capabilities for this project. */
  readonly capabilities: readonly string[];
  /** `run.tab`. */
  readonly run_id?: string;
  /** `comparison.view`. */
  readonly run_ids?: readonly string[];
  /** `report.block`. */
  readonly report_id?: string;
  readonly theme: "light" | "dark";
  /** Review preview before approval: every capability call is refused. */
  readonly preview: boolean;
}

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

/** Typed shapes of the common bridge results (the coordinator's JSON, abridged). */
export interface RunSummary {
  run_id: string;
  run_name?: string;
  status?: string;
  start_time?: number;
  params: Record<string, string>;
  metrics: Record<string, number>;
  tags: Record<string, string>;
}

export interface PredictResult {
  result_id: string;
  task: string;
  output: string;
  labels?: Record<string, string>;
  models: {
    model: { model_id: string; name?: string; version?: string };
    status: "ok" | "error";
    error?: { code: string; message: string };
    outputs?: unknown[];
    probabilities?: unknown[];
    timings: Record<string, number>;
  }[];
  rows: number;
}

export interface ExecutionView {
  execution_id: string;
  status: string;
  progress?: { percent: number; message?: string };
  result?: {
    status: "ok" | "error";
    summary: string;
    metrics: Record<string, string>;
    tables: { title: string; columns: string[]; rows: (string | number | boolean)[][] }[];
    data?: Record<string, unknown>;
    artifacts: { path: string; bytes: number; sha256: string }[];
    warnings: string[];
    errors: string[];
  };
  error?: string;
}

export interface Host {
  readonly context: HostContext;
  /** Call one bridge method. Rejects with BridgeError (`capability_denied`, `quota_exceeded`, …). */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** The host re-sends context when, for example, the selected run changes. */
  onContext(fn: (ctx: HostContext) => void): () => void;
  /** Lines shown in the extension's developer console on the Extensions page. */
  log(level: "info" | "warn" | "error", ...args: unknown[]): void;
  /** Ask the host to navigate to an AblationKit path (`/p/<id>/runs/<run>`). */
  navigate(path: string): void;
  /**
   * Ask the researcher to save an inference result as evidence. The host shows its own
   * confirmation; nothing is saved unless the researcher confirms there.
   */
  saveResult(
    resultId: string,
    opts: { title: string; note?: string },
  ): Promise<{ evidence_id: string } | null>;
  /**
   * `report.block`: ask the researcher to store a static fallback (text, a table, an image data
   * URL) with the report, so it stays legible if the extension is removed.
   */
  saveSnapshot(snapshot: Snapshot): Promise<boolean>;
  /** Run this extension's own Python contribution and wait for it (polls). */
  runPython(
    target: string,
    params?: Record<string, unknown>,
    opts?: { refs?: { kind: string; id: string }[]; onProgress?: (v: ExecutionView) => void },
  ): Promise<ExecutionView>;
}

export interface Snapshot {
  readonly title: string;
  readonly text?: string;
  readonly table?: { columns: string[]; rows: (string | number | boolean)[][] };
  /** A PNG data URL (at most 1 MiB). */
  readonly image?: string;
}

type Reply = { id: number; result?: unknown; error?: { code: string; message: string } };
type HostMessage = Reply | { event: "context"; context: HostContext };

let connecting: Promise<Host> | undefined;

/** Connect to the host. Safe to call more than once. */
export function connect(opts: { timeoutMs?: number } = {}): Promise<Host> {
  connecting ??= open(opts.timeoutMs ?? 10_000);
  return connecting;
}

function open(timeoutMs: number): Promise<Host> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new BridgeError(
            "no_host",
            "no AblationKit host answered: open this view from AblationKit",
          ),
        ),
      timeoutMs,
    );
    const onMessage = (ev: MessageEvent) => {
      // Only the parent can hand over the port, and only once.
      if (ev.source !== window.parent) return;
      const d = ev.data as { type?: string; protocol?: string; context?: HostContext } | null;
      if (d?.type !== "ablationkit:connect" || d.protocol !== PROTOCOL) return;
      const port = ev.ports[0];
      if (!port) return;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(makeHost(port, d.context as HostContext));
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage(
      { type: "ablationkit:hello", protocol: PROTOCOL, sdk: SDK_VERSION },
      "*",
    );
  });
}

function makeHost(port: MessagePort, initial: HostContext): Host {
  let context = initial;
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(c: HostContext) => void>();
  port.onmessage = (ev: MessageEvent<HostMessage>) => {
    const m = ev.data;
    if ("event" in m) {
      if (m.event === "context") {
        context = m.context;
        host.context = context;
        for (const l of listeners) l(context);
      }
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new BridgeError(m.error.code, m.error.message));
    else p.resolve(m.result);
  };
  port.start();
  const send = (msg: Record<string, unknown>) => port.postMessage(msg);
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      send({ id, method, params });
    });
  // Keep the frame as tall as its content.
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() =>
      send({ resize: Math.ceil(document.documentElement.scrollHeight) }),
    );
    ro.observe(document.documentElement);
  }
  window.addEventListener("error", (e) =>
    send({ log: "error", message: String(e.message).slice(0, 2000) }),
  );
  window.addEventListener("unhandledrejection", (e) =>
    send({ log: "error", message: `unhandled rejection: ${String(e.reason).slice(0, 2000)}` }),
  );
  const host: { -readonly [K in keyof Host]: Host[K] } = {
    context,
    call,
    onContext: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    log: (level, ...args) =>
      send({
        log: level,
        message: args
          .map((a) => (typeof a === "string" ? a : safeJson(a)))
          .join(" ")
          .slice(0, 4000),
      }),
    navigate: (path) => send({ navigate: path }),
    saveResult: (resultId, opts) =>
      call<{ evidence_id: string } | null>("host.save_result", { result_id: resultId, ...opts }),
    saveSnapshot: (snapshot) => call<boolean>("host.save_snapshot", { snapshot }),
    runPython: async (target, params = {}, opts = {}) => {
      const started = await call<ExecutionView>("python.run", {
        target,
        params,
        refs: opts.refs ?? [],
      });
      let v = started;
      // Short runs (a warm worker answers in milliseconds) come back quickly; long ones are
      // polled every 500 ms as before.
      let wait = 50;
      while (v.status === "running") {
        opts.onProgress?.(v);
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(500, wait * 2);
        v = await call<ExecutionView>("python.execution", { execution_id: started.execution_id });
      }
      return v;
    },
  };
  return host;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Mount a framework-free view: `render` gets the host and an element to fill. */
export async function mount(
  render: (host: Host, root: HTMLElement) => void | Promise<void>,
): Promise<void> {
  const root = document.getElementById("root") ?? document.body;
  try {
    const host = await connect();
    await render(host, root);
  } catch (e) {
    root.textContent = `This extension could not start: ${(e as Error).message}`;
  }
}
