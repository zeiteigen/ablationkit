/**
 * A vault figure (ADR 0053), drawn where its note is read. The note's script runs in the
 * coordinator's figure frame (`/vault-frame/<project>/<note>/<revision>`): an opaque-origin,
 * network-less sandbox like an extension view's. This component is its only way out: it hands the
 * frame a MessagePort, forwards the frame's read-only run calls to the coordinator (which checks
 * them), sizes the frame to its content and reports how the drawing went, so the writer learns of
 * a broken figure from the `figure_error` check.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api.ts";
import { SERIES_COLORS } from "../lib/format.ts";

const PROTOCOL = "ablationkit.figure/1";
const METHODS = new Set([
  "runs.list",
  "runs.get",
  "runs.metric_history",
  "artifacts.list",
  "artifacts.preview",
]);

/** The page's own colours, so a figure reads as part of it in either theme. */
function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string) => cs.getPropertyValue(`--${k}`).trim();
  const t = document.documentElement.dataset["theme"];
  const dark =
    t === "dark" || (t !== "light" && cs.getPropertyValue("color-scheme").trim() !== "light");
  return {
    dark,
    bg: v("bg"),
    fg: v("fg"),
    muted: v("muted"),
    faint: v("faint"),
    line: v("line-strong") || v("line"),
    accent: v("accent"),
    ink: v("ink"),
    ok: v("ok"),
    warn: v("warn"),
    err: v("err"),
    series: [...SERIES_COLORS],
  };
}

export function Figure(props: { pid: string; id: string; revision: number; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let port: MessagePort | undefined;
    const base = `/api/v1/projects/${encodeURIComponent(props.pid)}/vault/notes/${encodeURIComponent(props.id)}/figure`;
    const onHello = (ev: MessageEvent) => {
      // Only this frame's window and its hello; a sandboxed frame's origin is "null".
      if (ev.source !== frame.contentWindow) return;
      const d = ev.data as { type?: string; protocol?: string } | null;
      if (d?.type !== "ablationkit:figure-hello" || d.protocol !== PROTOCOL) return;
      port?.close();
      const ch = new MessageChannel();
      port = ch.port1;
      ch.port1.onmessage = async (e: MessageEvent) => {
        const m = e.data as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
          resize?: number;
          drawn?: { error?: string };
        } | null;
        if (typeof m !== "object" || m === null) return;
        if (typeof m.resize === "number") {
          setHeight(Math.max(48, Math.min(4000, Math.ceil(m.resize))));
          return;
        }
        if (m.drawn) {
          setFailed(Boolean(m.drawn.error));
          void api(`${base}/drawn`, {
            body: {
              revision: props.revision,
              ...(m.drawn.error ? { error: String(m.drawn.error).slice(0, 2000) } : {}),
            },
          }).catch(() => undefined);
          return;
        }
        if (typeof m.id !== "number" || typeof m.method !== "string") return;
        const reply = (r: { result?: unknown; error?: { code: string; message: string } }) =>
          ch.port1.postMessage({ id: m.id, ...r });
        if (!METHODS.has(m.method)) {
          reply({ error: { code: "method_not_allowed", message: "a figure reads runs only" } });
          return;
        }
        try {
          const r = await api<{ result: unknown }>(`${base}/rpc`, {
            body: { method: m.method, params: m.params ?? {} },
          });
          reply({ result: r.result });
        } catch (err) {
          reply({
            error:
              err instanceof ApiError
                ? { code: err.code, message: err.message }
                : { code: "host_error", message: String(err) },
          });
        }
      };
      frame.contentWindow?.postMessage(
        { type: "ablationkit:figure-connect", protocol: PROTOCOL, theme: theme() },
        "*",
        [ch.port2],
      );
    };
    window.addEventListener("message", onHello);
    return () => {
      window.removeEventListener("message", onHello);
      port?.close();
    };
  }, [props.pid, props.id, props.revision]);

  return (
    <div
      className={`v-figure${failed ? " v-figure-failed" : ""}`}
      data-testid={`figure-${props.id}`}
    >
      <iframe
        ref={ref}
        title={props.title}
        src={`/vault-frame/${encodeURIComponent(props.pid)}/${encodeURIComponent(props.id)}/${props.revision}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{ height }}
      />
    </div>
  );
}
