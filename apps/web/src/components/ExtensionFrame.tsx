/**
 * Mounts one extension view (ADR 0022). The view runs in an opaque-origin iframe
 * (`sandbox="allow-scripts"`, served with CSP `sandbox allow-scripts; connect-src 'none'`), so it
 * cannot reach the coordinator, read the session cookie or touch this page. Its only channel is a
 * MessagePort this component hands over after the frame says hello. Calls are forwarded to the
 * coordinator's bridge route, which checks build, project, capability and quotas on every call;
 * this component only refuses methods that are not frame methods and keeps `host.*` methods
 * (navigation, saving with a confirmation in this trusted UI) on this side.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api.ts";
import { navigate } from "../router.ts";
import { Badge, Modal } from "./ui.tsx";

export interface ExtensionMount {
  extension_id: string;
  build_id: string;
  contribution: { id: string; point: string; title: string };
  frame_url: string;
  capabilities: string[];
  trusted_code: boolean;
}

const PROTOCOL = "ablationkit.ext/1";

/** Methods a frame may send (mirrors FRAME_METHODS in @ablationkit/extension-host). */
const FRAME_METHODS = new Set([
  "context.get",
  "host.navigate",
  "runs.list",
  "runs.get",
  "runs.metric_history",
  "artifacts.list",
  "artifacts.preview",
  "research.list",
  "models.list",
  "inference.describe",
  "inference.predict",
  "inference.compare",
  "llm.infer",
  "llm.compare",
  "traces.get",
  "evaluations.examples",
  "evaluations.get",
  "python.run",
  "python.execution",
  "host.save_result",
  "host.save_snapshot",
]);

function theme(): "light" | "dark" {
  const t = document.documentElement.dataset["theme"];
  if (t === "light" || t === "dark") return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

interface PendingSave {
  /** `result`: an inference result as evidence; `snapshot`: a report block's static fallback. */
  kind: "result" | "snapshot";
  resultId: string;
  title: string;
  note?: string;
  snapshot?: Record<string, unknown>;
  resolve: (v: unknown) => void;
}

export function ExtensionFrame(props: {
  pid: string;
  mount: ExtensionMount;
  context?: { run_id?: string; run_ids?: string[]; report_id?: string };
  /** Review preview: the frame loads, every capability call is refused. */
  preview?: boolean;
  minHeight?: number;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const [height, setHeight] = useState(props.minHeight ?? 160);
  const [pendingSave, setPendingSave] = useState<PendingSave>();
  const [saveNote, setSaveNote] = useState("");
  const m = props.mount;
  const ctx = {
    project_id: props.pid,
    extension_id: m.extension_id,
    build_id: m.build_id,
    contribution: m.contribution,
    capabilities: props.preview ? [] : m.capabilities,
    theme: theme(),
    preview: props.preview === true,
    ...(props.context ?? {}),
  };
  const ctxKey = JSON.stringify(ctx);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the frame is rebuilt only when its build changes
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const P = `/api/v1/projects/${encodeURIComponent(props.pid)}/extensions/${encodeURIComponent(m.extension_id)}`;
    const log = (level: string, message: string) =>
      void api(`${P}/console`, { body: { level, source: m.contribution.id, message } }).catch(
        () => undefined,
      );
    const call = async (method: string, params: Record<string, unknown>) =>
      (
        await api<{ result: unknown }>(`${P}/rpc`, {
          body: { build_id: m.build_id, contribution: m.contribution.id, method, params },
        })
      ).result;
    const onHello = (ev: MessageEvent) => {
      // Only this frame's window, and only its hello; a sandboxed frame's origin is "null".
      if (ev.source !== frame.contentWindow) return;
      const d = ev.data as { type?: string; protocol?: string } | null;
      if (d?.type !== "ablationkit:hello" || d.protocol !== PROTOCOL) return;
      portRef.current?.close();
      const ch = new MessageChannel();
      portRef.current = ch.port1;
      ch.port1.onmessage = async (e: MessageEvent) => {
        const msg = e.data as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
          resize?: number;
          log?: string;
          message?: string;
          navigate?: string;
        };
        if (typeof msg !== "object" || msg === null) return;
        if (typeof msg.resize === "number") {
          setHeight(Math.max(props.minHeight ?? 80, Math.min(4000, Math.ceil(msg.resize))));
          return;
        }
        if (typeof msg.log === "string") {
          log(msg.log, String(msg.message ?? "").slice(0, 4000));
          return;
        }
        if (typeof msg.navigate === "string") {
          if (msg.navigate.startsWith(`/p/${props.pid}/`)) navigate(msg.navigate);
          return;
        }
        if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
        const reply = (r: { result?: unknown; error?: { code: string; message: string } }) =>
          ch.port1.postMessage({ id: msg.id, ...r });
        const method = msg.method;
        const params = (msg.params ?? {}) as Record<string, unknown>;
        if (!FRAME_METHODS.has(method)) {
          reply({
            error: { code: "method_not_allowed", message: `${method} is not a bridge method` },
          });
          return;
        }
        if (props.preview && method !== "context.get") {
          reply({
            error: {
              code: "preview",
              message: "capability calls are refused in the review preview",
            },
          });
          return;
        }
        try {
          if (method === "context.get") reply({ result: ctx });
          else if (method === "host.navigate") {
            const to = String(params["path"] ?? "");
            if (to.startsWith(`/p/${props.pid}/`)) navigate(to);
            reply({ result: null });
          } else if (method === "host.save_result") {
            // Saving is explicit: the researcher confirms here, in trusted UI, or nothing is saved.
            const result = await new Promise<unknown>((resolve) =>
              setPendingSave({
                kind: "result",
                resultId: String(params["result_id"] ?? ""),
                title: String(params["title"] ?? "Demo result").slice(0, 200),
                ...(typeof params["note"] === "string" ? { note: params["note"] as string } : {}),
                resolve,
              }),
            );
            reply({ result });
          } else if (method === "host.save_snapshot") {
            const snap = (params["snapshot"] ?? {}) as Record<string, unknown>;
            if (m.contribution.point !== "report.block" || !props.context?.report_id) {
              reply({
                error: { code: "not_a_report_block", message: "only report blocks save snapshots" },
              });
              return;
            }
            const result = await new Promise<unknown>((resolve) =>
              setPendingSave({
                kind: "snapshot",
                resultId: props.context?.report_id as string,
                title: String(snap["title"] ?? "Snapshot").slice(0, 200),
                snapshot: snap,
                resolve,
              }),
            );
            reply({ result: result !== null });
          } else reply({ result: await call(method, params) });
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
        { type: "ablationkit:connect", protocol: PROTOCOL, context: ctx },
        "*",
        [ch.port2],
      );
    };
    window.addEventListener("message", onHello);
    return () => {
      window.removeEventListener("message", onHello);
      portRef.current?.close();
      portRef.current = null;
    };
  }, [props.pid, m.build_id, m.contribution.id, props.preview]);

  // A new context (another run selected) goes to the live view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ctxKey is the serialized context
  useEffect(() => {
    portRef.current?.postMessage({ event: "context", context: ctx });
  }, [ctxKey]);

  const confirmSave = async (ok: boolean) => {
    const s = pendingSave;
    if (!s) return;
    setPendingSave(undefined);
    if (!ok) return s.resolve(null);
    try {
      const r = (
        await api<{ result: unknown }>(
          `/api/v1/projects/${encodeURIComponent(props.pid)}/extensions/${encodeURIComponent(m.extension_id)}/rpc`,
          {
            body: {
              build_id: m.build_id,
              contribution: m.contribution.id,
              ...(s.kind === "snapshot"
                ? {
                    method: "report.snapshot",
                    params: { report_id: s.resultId, snapshot: s.snapshot },
                  }
                : {
                    method: "inference.save",
                    params: { result_id: s.resultId, title: s.title, note: saveNote || s.note },
                  }),
            },
          },
        )
      ).result;
      s.resolve(r);
    } catch {
      s.resolve(null);
    }
    setSaveNote("");
  };

  const src = `${m.frame_url}${props.preview ? "?preview=1" : ""}`;
  return (
    <div className="ext-frame" data-testid={`ext-${m.extension_id}-${m.contribution.id}`}>
      <div className="row small faint">
        <span>
          {m.contribution.title} · extension <span className="mono">{m.extension_id}</span>
        </span>
        {m.trusted_code ? (
          <Badge tone="warn" title="Its Python runs as trusted code under your user">
            trusted code
          </Badge>
        ) : null}
        {props.preview ? <Badge tone="warn">preview: no capabilities</Badge> : null}
      </div>
      <iframe
        ref={ref}
        title={`${m.extension_id}: ${m.contribution.title}`}
        src={src}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        style={{ width: "100%", height, border: "1px solid var(--line)", borderRadius: 6 }}
      />
      {pendingSave ? (
        <Modal
          title={
            pendingSave.kind === "snapshot"
              ? "Add this snapshot to the report?"
              : "Save this result as evidence?"
          }
          onClose={() => void confirmSave(false)}
          footer={
            <div className="row end">
              <button type="button" onClick={() => void confirmSave(false)}>
                Don't save
              </button>
              <button type="button" className="primary" onClick={() => void confirmSave(true)}>
                {pendingSave.kind === "snapshot" ? "Add to report" : "Save evidence"}
              </button>
            </div>
          }
        >
          {pendingSave.kind === "snapshot" ? (
            <p>
              The extension <span className="mono">{m.extension_id}</span> asks to store a static
              snapshot with this report and append its text and table to the report body, so the
              report stays legible if the extension is removed.
            </p>
          ) : (
            <p>
              The extension <span className="mono">{m.extension_id}</span> asks to save inference
              result <span className="mono">{pendingSave.resultId}</span> as evidence: its inputs
              and outputs become an MLflow artifact with the pinned model versions.
            </p>
          )}
          <p>
            <strong>{pendingSave.title}</strong>
          </p>
          {pendingSave.kind === "result" ? (
            <label className="stack small">
              Note (optional)
              <textarea value={saveNote} onChange={(e) => setSaveNote(e.target.value)} rows={2} />
            </label>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
