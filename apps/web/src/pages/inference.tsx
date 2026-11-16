/**
 * The Inference page (spec §2.2 Models → Inference, §5.6 Inference Lab, Interactive Sessions and
 * Model Output Comparisons, §5.6.1; criteria 9, 9a, 9b, 9e, 10d; ADR 0020): one page with three
 * modes (one-shot, session, compare) and the saved evidence list.
 *
 * Input forms come from the model's task adapter (the same `@ablationkit/inference-adapters` the
 * coordinator validates with): a row editor for tabular models, a text box for text models and an
 * image picker for image models. Results are transient until "Save as evidence".
 */
import {
  type Adapter,
  blankRecord,
  type InferencePayload,
  validatePayload,
} from "@ablationkit/inference-adapters";
import { type ReactNode, useEffect, useState } from "react";
import { api, qs, useApi, useEvents } from "../api.ts";
import { DeploymentsPanel } from "../components/DeploymentsPanel.tsx";
import {
  Badge,
  Empty,
  ErrorBox,
  KV,
  Link,
  Loading,
  type Tone,
  useAction,
} from "../components/ui.tsx";
import { fmtBytes, fmtTime, shortId } from "../lib/format.ts";
import { navigate } from "../router.ts";
import { ModelPicker, selectorOf } from "./lifecycle.tsx";

// biome-ignore lint/suspicious/noExplicitAny: API JSON shaped by the coordinator
type J = any;
const e = encodeURIComponent;

const MODES = [
  { id: "", label: "One-shot" },
  { id: "session", label: "Session" },
  { id: "compare", label: "Compare" },
  { id: "evidence", label: "Saved evidence" },
] as const;

export function InferencePage(props: { pid: string; base: string; rest: string }) {
  const mode = props.rest.split("/").filter(Boolean)[1] ?? "";
  const root = `${props.base}/models/inference`;
  let body: ReactNode;
  if (mode === "session") body = <SessionMode pid={props.pid} base={props.base} />;
  else if (mode === "compare") body = <CompareMode pid={props.pid} base={props.base} />;
  else if (mode === "evidence") body = <EvidenceList pid={props.pid} base={props.base} />;
  else body = <OneShot pid={props.pid} base={props.base} />;
  return (
    <div data-testid="inference-page">
      <div className="row" role="tablist" aria-label="Inference mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            className={mode === m.id ? "primary small" : "small"}
            onClick={() => navigate(m.id ? `${root}/${m.id}` : root)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="faint small">
        Exploration is transient: inputs and outputs stay in the coordinator's memory for an hour
        and are never written to MLflow unless you save them as evidence. Models load only in
        isolated, resource-limited workers.
      </p>
      {body}
      <DeploymentsPanel pid={props.pid} />
    </div>
  );
}

// ------------------------------------------------------------------ model + adapter

function useDescribe(pid: string, sel: J | undefined) {
  return useApi<J>(sel ? `/api/v1/projects/${e(pid)}/inference/describe${qs(sel)}` : undefined);
}

function AdapterSummary(props: { d: J; ack: boolean; setAck: (v: boolean) => void }) {
  const d = props.d;
  return (
    <div className="small" data-testid="adapter-summary">
      <p>
        Pinned:{" "}
        <span className="mono">
          {d.model.registered_name
            ? `${d.model.registered_name} v${d.model.version}${d.model.alias ? ` (@${d.model.alias})` : ""} → `
            : ""}
          {d.model.model_id}
        </span>
      </p>
      {d.adapter ? (
        <p>
          Adapter: <Badge tone="info">{d.adapter.task}</Badge>{" "}
          <Badge tone="neutral">{d.adapter.output}</Badge>{" "}
          <span className="faint">
            from the {d.adapter.source === "metadata" ? "model's declared metadata" : "signature"}
            {d.adapter.image
              ? ` · ${d.adapter.image.width}×${d.adapter.image.height} ${d.adapter.image.mode}`
              : ""}
          </span>
        </p>
      ) : (
        <div className="banner warn" role="alert" data-testid="unsupported">
          <strong>Not supported</strong>: {d.unsupported?.message}
        </div>
      )}
      <p>
        <Badge tone={d.trust.level === "restricted" ? "ok" : "warn"}>trust: {d.trust.level}</Badge>{" "}
        <span className="faint">{d.trust.warning}</span>
      </p>
      {d.trust.level !== "restricted" ? (
        <label>
          <input
            type="checkbox"
            checked={props.ack}
            onChange={(ev) => props.setAck(ev.target.checked)}
          />{" "}
          I trust this model's files; load them in an isolated worker
        </label>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ inputs

/** Form state for the adapter: rows of fields, text lines, or picked images. */
interface InputState {
  rows: Record<string, unknown>[];
  text: string;
  images: { name: string; media_type: string; data_base64: string; url: string }[];
  json: string;
  useJson: boolean;
}

function emptyInput(a?: Adapter): InputState {
  return { rows: a ? [blankRecord(a)] : [], text: "", images: [], json: "", useJson: false };
}

function payloadOf(a: Adapter, s: InputState): { payload?: InferencePayload; error?: string } {
  if (s.useJson) {
    try {
      const v = JSON.parse(s.json);
      return { payload: Array.isArray(v) ? { records: v } : v };
    } catch (err) {
      return { error: `not JSON: ${(err as Error).message}` };
    }
  }
  if (a.task === "image")
    return {
      payload: {
        images: s.images.map(({ data_base64, media_type, name }) => ({
          data_base64,
          media_type,
          name,
        })),
      },
    };
  if (a.task === "text") {
    const col = a.columns[0]?.name ?? "text";
    const lines = s.text.split("\n").filter((l) => l.trim());
    return { payload: { records: lines.map((l) => ({ [col]: l })) } };
  }
  return { payload: { records: s.rows } };
}

function readFile(
  f: File,
): Promise<{ name: string; media_type: string; data_base64: string; url: string }> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onerror = () => fail(r.error);
    r.onload = () => {
      const url = String(r.result);
      ok({
        name: f.name,
        media_type: f.type || "image/png",
        data_base64: url.slice(url.indexOf(",") + 1),
        url,
      });
    };
    r.readAsDataURL(f);
  });
}

function InputBuilder(props: {
  adapter: Adapter;
  value: InputState;
  onChange: (s: InputState) => void;
}) {
  const { adapter: a, value: s, onChange } = props;
  const set = (patch: Partial<InputState>) => onChange({ ...s, ...patch });
  const p = payloadOf(a, s);
  const check = p.payload ? validatePayload(a, p.payload, { maxRows: 1000 }) : undefined;
  return (
    <fieldset className="card inset" data-testid="input-builder">
      <legend>Inputs</legend>
      <label className="small">
        <input
          type="checkbox"
          checked={s.useJson}
          onChange={(ev) => set({ useJson: ev.target.checked })}
        />{" "}
        Paste JSON instead
      </label>
      {s.useJson ? (
        <textarea
          aria-label="inputs JSON"
          rows={6}
          className="mono"
          value={s.json}
          placeholder='{"records": [{"col": 1}]} or [{"col": 1}]'
          onChange={(ev) => set({ json: ev.target.value })}
        />
      ) : a.task === "image" ? (
        <>
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            multiple
            aria-label="images"
            onChange={async (ev) => {
              const files = [...(ev.target.files ?? [])];
              set({ images: [...s.images, ...(await Promise.all(files.map(readFile)))] });
            }}
          />
          <div className="row">
            {s.images.map((im, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the same file may be picked twice
              <figure key={`${im.name}-${i}`} className="small">
                <img
                  src={im.url}
                  alt={im.name}
                  width={48}
                  height={48}
                  style={{ imageRendering: "pixelated" }}
                />
                <figcaption className="faint">{im.name}</figcaption>
              </figure>
            ))}
          </div>
          {s.images.length ? (
            <button type="button" className="small" onClick={() => set({ images: [] })}>
              Clear images
            </button>
          ) : null}
        </>
      ) : a.task === "text" ? (
        <textarea
          aria-label="text inputs"
          rows={4}
          value={s.text}
          placeholder="One example per line"
          onChange={(ev) => set({ text: ev.target.value })}
        />
      ) : (
        <div className="table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>#</th>
                {a.columns.map((c) => (
                  <th key={c.name}>
                    {c.name} <span className="faint">{c.type}</span>
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
                <tr key={i}>
                  <td>{i}</td>
                  {a.columns.map((c) => (
                    <td key={c.name}>
                      {c.type === "boolean" ? (
                        <input
                          type="checkbox"
                          aria-label={`${c.name} row ${i}`}
                          checked={r[c.name] === true}
                          onChange={(ev) => {
                            const rows = [...s.rows];
                            rows[i] = { ...r, [c.name]: ev.target.checked };
                            set({ rows });
                          }}
                        />
                      ) : (
                        <input
                          aria-label={`${c.name} row ${i}`}
                          type={
                            ["double", "float", "long", "integer"].includes(c.type)
                              ? "number"
                              : "text"
                          }
                          step="any"
                          value={String(r[c.name] ?? "")}
                          onChange={(ev) => {
                            const rows = [...s.rows];
                            const numeric = ["double", "float", "long", "integer"].includes(c.type);
                            rows[i] = {
                              ...r,
                              [c.name]:
                                numeric && ev.target.value !== ""
                                  ? Number(ev.target.value)
                                  : ev.target.value,
                            };
                            set({ rows });
                          }}
                        />
                      )}
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="small"
                      aria-label={`remove row ${i}`}
                      onClick={() => set({ rows: s.rows.filter((_, j) => j !== i) })}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            className="small"
            onClick={() => set({ rows: [...s.rows, blankRecord(a)] })}
          >
            Add row
          </button>
        </div>
      )}
      {p.error ? <p className="small err">{p.error}</p> : null}
      {check?.issues.length ? (
        <ul className="small err" data-testid="input-issues">
          {check.issues.slice(0, 10).map((i, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: issues have no identity
            <li key={k}>
              {i.row !== undefined ? `row ${i.row}: ` : ""}
              {i.field ? `${i.field} ` : ""}
              {i.message}
            </li>
          ))}
        </ul>
      ) : check ? (
        <p className="small faint">{check.rows} validated against the signature</p>
      ) : null}
    </fieldset>
  );
}

// ------------------------------------------------------------------ results

const ms = (v: unknown) => (typeof v === "number" ? `${v.toFixed(1)} ms` : "—");
const show = (v: unknown, labels?: Record<string, string>) =>
  labels?.[String(v)] ??
  (typeof v === "number" && !Number.isInteger(v)
    ? v.toPrecision(5)
    : typeof v === "string"
      ? v
      : JSON.stringify(v));

function Timings(props: { t: J }) {
  const t = props.t ?? {};
  return (
    <span className="small" data-testid="timings">
      load <strong>{ms(t.load_ms)}</strong> · predict <strong>{ms(t.predict_ms)}</strong>
      {t.worker_ms !== undefined ? <> · worker total {ms(t.worker_ms)}</> : null}
      {t.round_trip_ms !== undefined ? <> · round trip {ms(t.round_trip_ms)}</> : null}
    </span>
  );
}

function ProbBars(props: {
  p: { label: unknown; p: number }[] | undefined;
  labels?: Record<string, string>;
}) {
  if (!props.p) return null;
  return (
    <div className="small">
      {props.p.slice(0, 3).map((x) => (
        <div key={String(x.label)} className="row" style={{ gap: 4 }}>
          <span style={{ minWidth: 64 }}>{show(x.label, props.labels)}</span>
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              height: 8,
              width: `${Math.max(2, x.p * 100)}px`,
              background: "var(--accent, currentColor)",
            }}
          />
          <span className="faint">{x.p.toFixed(3)}</span>
        </div>
      ))}
    </div>
  );
}

/** Thumbnail or text for the i-th input, from what was sent. */
function inputCell(r: J, i: number, images: InputState["images"] | undefined): ReactNode {
  const im = images?.[i];
  if (im)
    return (
      <img
        src={im.url}
        alt={im.name}
        width={32}
        height={32}
        style={{ imageRendering: "pixelated" }}
      />
    );
  const rec = r.inputs?.records?.[i] ?? r.input_rows?.[i];
  if (!rec) return r.inputs?.images?.[i]?.name ?? "—";
  const vals = Object.entries(rec);
  const text =
    vals.length === 1 ? String(vals[0]?.[1]) : vals.map(([k, v]) => `${k}=${show(v)}`).join(", ");
  return <span className="small">{text.length > 120 ? `${text.slice(0, 120)}…` : text}</span>;
}

function SaveEvidence(props: { pid: string; base: string; result: J }) {
  const [title, setTitle] = useState("");
  const [saved, setSaved] = useState<J>();
  const save = useAction(async () => {
    const r = await api<J>(
      `/api/v1/projects/${e(props.pid)}/inference/results/${e(props.result.result_id)}/save`,
      {
        body: title ? { title } : {},
      },
    );
    setSaved(r.evidence);
  });
  if (saved || props.result.saved_as)
    return (
      <p className="small" data-testid="saved">
        <Badge tone="ok">saved</Badge> as{" "}
        <Link to={`${props.base}/models/inference/evidence`}>
          {saved?.evidence_id ?? props.result.saved_as}
        </Link>
        {saved ? (
          <>
            {" "}
            · MLflow run <span className="mono">{shortId(saved.mlflow_run_id)}</span> · stored:{" "}
            {saved.stored.join(", ")}
          </>
        ) : null}
      </p>
    );
  return (
    <div className="row">
      <input
        aria-label="evidence title"
        placeholder="Title (optional)"
        value={title}
        onChange={(ev) => setTitle(ev.target.value)}
      />
      <button type="button" onClick={() => void save.run()} disabled={save.busy}>
        Save as evidence
      </button>
      <span className="faint small">unsaved · kept until {fmtTime(props.result.expires_at)}</span>
      <ErrorBox error={save.error} />
    </div>
  );
}

function PredictionView(props: {
  pid: string;
  base: string;
  result: J;
  images?: InputState["images"] | undefined;
}) {
  const r = props.result;
  const m = r.models[0];
  return (
    <section className="card" data-testid="prediction-result">
      <div className="row">
        <h3 className="grow">
          Result <span className="mono small">{r.result_id}</span>
        </h3>
        <Badge tone={m.status === "ok" ? "ok" : "err"}>{m.status}</Badge>
      </div>
      <Timings t={m.timings} />
      {m.error ? (
        <div className="banner err" role="alert" data-testid="prediction-error">
          <strong>{m.error.code}</strong>: <span className="pre-wrap">{m.error.message}</span>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>#</th>
                <th>input</th>
                <th>{r.output === "regression" ? "prediction" : "label"}</th>
                {m.probabilities ? <th>top classes</th> : null}
              </tr>
            </thead>
            <tbody>
              {(m.outputs as unknown[]).map((o, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: aligned by row
                <tr key={i}>
                  <td>{i}</td>
                  <td>{inputCell(r, i, props.images)}</td>
                  <td data-testid="output">
                    <strong>{show(o, r.labels)}</strong>
                  </td>
                  {m.probabilities ? (
                    <td>
                      <ProbBars p={m.probabilities[i]} labels={r.labels} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {m.probabilities_note ? (
        <p className="faint small">No probabilities: {m.probabilities_note}</p>
      ) : null}
      <SaveEvidence pid={props.pid} base={props.base} result={r} />
    </section>
  );
}

// ------------------------------------------------------------------ one-shot

function OneShot(props: { pid: string; base: string }) {
  const [pick, setPick] = useState<J>({ kind: "registry" });
  const sel = selectorOf(pick);
  const d = useDescribe(props.pid, sel);
  const adapter: Adapter | undefined = d.data?.adapter;
  const [ack, setAck] = useState(false);
  const [input, setInput] = useState<InputState>(emptyInput());
  const [result, setResult] = useState<J>();
  const [shown, setShown] = useState<InputState["images"]>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form when the model changes
  useEffect(() => {
    setInput(emptyInput(adapter));
    setResult(undefined);
  }, [d.data?.model?.model_id]);
  const run = useAction(async () => {
    if (!adapter || !sel) return;
    const p = payloadOf(adapter, input);
    if (!p.payload) return;
    setShown(input.images);
    const r = await api<J>(`/api/v1/projects/${e(props.pid)}/inference/predict`, {
      body: { model: sel, inputs: p.payload, ...(ack ? { acknowledge_trust: true } : {}) },
    });
    setResult(r.result);
  });
  return (
    <>
      <section className="card" data-testid="one-shot">
        <h2>One-shot prediction</h2>
        <p className="faint small">
          A short-lived worker loads the pinned model, validates the inputs, predicts once and
          exits. No endpoint stays up.
        </p>
        <ModelPicker pid={props.pid} label="Model" value={pick} onChange={setPick} />
        <ErrorBox error={d.error} />
        {d.data ? <AdapterSummary d={d.data} ack={ack} setAck={setAck} /> : null}
        {adapter ? <InputBuilder adapter={adapter} value={input} onChange={setInput} /> : null}
        <button
          type="button"
          className="primary"
          disabled={!adapter || run.busy}
          onClick={() => void run.run()}
        >
          {run.busy ? "Predicting…" : "Predict"}
        </button>
        <ErrorBox error={run.error} />
      </section>
      {result ? (
        <PredictionView pid={props.pid} base={props.base} result={result} images={shown} />
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ sessions

function sessionTone(s: string): Tone {
  return s === "ready"
    ? "ok"
    : s === "starting" || s === "stopping"
      ? "info"
      : s === "crashed" || s === "failed"
        ? "err"
        : "neutral";
}

function SessionMode(props: { pid: string; base: string }) {
  const list = useApi<{ sessions: J[] }>(`/api/v1/projects/${e(props.pid)}/inference/sessions`);
  useEvents(() => list.reload(), { project: props.pid, types: ["inference.session.updated"] });
  const [pick, setPick] = useState<J>({ kind: "registry" });
  const sel = selectorOf(pick);
  const d = useDescribe(props.pid, sel);
  const [ack, setAck] = useState(false);
  const [idle, setIdle] = useState(15);
  const [mem, setMem] = useState(2048);
  const [open, setOpen] = useState<string>();
  const start = useAction(async () => {
    const r = await api<J>(`/api/v1/projects/${e(props.pid)}/inference/sessions`, {
      body: {
        model: sel,
        idle_timeout_sec: Math.round(idle * 60),
        memory_mb: mem,
        ...(ack ? { acknowledge_trust: true } : {}),
      },
    });
    setOpen(r.session.session_id);
    list.reload();
  });
  return (
    <>
      <section className="card" data-testid="session-start">
        <h2>Interactive session</h2>
        <p className="faint small">
          A supervised worker loads the model once and answers repeated predictions through the
          coordinator. It stops when idle, when you stop it, or when the coordinator stops.
        </p>
        <ModelPicker pid={props.pid} label="Model" value={pick} onChange={setPick} />
        {d.data ? <AdapterSummary d={d.data} ack={ack} setAck={setAck} /> : null}
        <div className="row">
          <label className="field">
            Idle timeout (minutes)
            <input
              type="number"
              min={1}
              value={idle}
              onChange={(ev) => setIdle(Number(ev.target.value))}
            />
          </label>
          <label className="field">
            Memory limit (MB)
            <input
              type="number"
              min={128}
              value={mem}
              onChange={(ev) => setMem(Number(ev.target.value))}
            />
          </label>
          <button
            type="button"
            className="primary"
            disabled={!d.data?.adapter || start.busy}
            onClick={() => void start.run()}
          >
            Start session
          </button>
        </div>
        <ErrorBox error={start.error} />
      </section>
      <section className="card" data-testid="session-list">
        <h2>Sessions</h2>
        <ErrorBox error={list.error} onRetry={list.reload} />
        {list.data && !list.data.sessions.length ? <Empty>No sessions yet.</Empty> : null}
        {list.data?.sessions.length ? (
          <div className="table-wrap">
            <table className="small">
              <thead>
                <tr>
                  <th>session</th>
                  <th>state</th>
                  <th>model</th>
                  <th>load</th>
                  <th>requests</th>
                  <th>idle timeout</th>
                  <th>started</th>
                </tr>
              </thead>
              <tbody>
                {list.data.sessions.map((s) => (
                  <tr key={s.session_id}>
                    <td>
                      <button
                        type="button"
                        className="link small mono"
                        onClick={() => setOpen(s.session_id)}
                      >
                        {s.session_id}
                      </button>
                    </td>
                    <td>
                      <Badge tone={sessionTone(s.state)}>{s.state}</Badge>
                    </td>
                    <td className="mono">
                      {s.model.registered_name
                        ? `${s.model.registered_name} v${s.model.version}`
                        : shortId(s.model.model_id, 12)}
                    </td>
                    <td>{ms(s.timings?.load_ms)}</td>
                    <td>{s.counters.requests}</td>
                    <td>{s.limits.idle_timeout_sec}s</td>
                    <td className="faint">{fmtTime(s.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {open ? <SessionPanel key={open} pid={props.pid} base={props.base} id={open} /> : null}
    </>
  );
}

function SessionPanel(props: { pid: string; base: string; id: string }) {
  const path = `/api/v1/projects/${e(props.pid)}/inference/sessions/${e(props.id)}`;
  const v = useApi<J>(path);
  useEvents(() => v.reload(), { project: props.pid, types: ["inference.session.updated"] });
  const s = v.data?.session;
  const live = s && (s.state === "starting" || s.state === "ready" || s.state === "stopping");
  // biome-ignore lint/correctness/useExhaustiveDependencies: poll while the worker is alive
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => v.reload(), 2000);
    return () => clearInterval(t);
  }, [live]);
  const adapter: Adapter | undefined = v.data?.adapter;
  const [input, setInput] = useState<InputState>(emptyInput());
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialise the form once the adapter is known
  useEffect(() => {
    if (adapter) setInput(emptyInput(adapter));
  }, [adapter?.task]);
  const [result, setResult] = useState<J>();
  const [shown, setShown] = useState<InputState["images"]>();
  const [log, setLog] = useState<string>();
  const predict = useAction(async () => {
    if (!adapter) return;
    const p = payloadOf(adapter, input);
    if (!p.payload) return;
    setShown(input.images);
    setResult((await api<J>(`${path}/predict`, { body: { inputs: p.payload } })).result);
    v.reload();
  });
  const act = useAction(async (what: "stop" | "restart") => {
    await api(`${path}/${what}`, { body: {} });
    v.reload();
  });
  const loadLog = useAction(async () => {
    const r = await fetch(`${path}/log`, { credentials: "same-origin" });
    setLog(await r.text());
  });
  if (v.error) return <ErrorBox error={v.error} onRetry={v.reload} />;
  if (!s) return <Loading />;
  return (
    <>
      <section className="card" data-testid="session-panel">
        <div className="row">
          <h2 className="grow mono">{s.session_id}</h2>
          <Badge tone={sessionTone(s.state)}>{s.state}</Badge>
          {live && s.state !== "stopping" ? (
            <button
              type="button"
              className="small"
              onClick={() => void act.run("stop")}
              disabled={act.busy}
            >
              Stop
            </button>
          ) : null}
          <button
            type="button"
            className="small"
            onClick={() => void act.run("restart")}
            disabled={act.busy}
          >
            Restart
          </button>
        </div>
        <ErrorBox error={act.error} />
        {s.end_reason ? (
          <p className="small" data-testid="end-reason">
            {s.end_reason}
          </p>
        ) : null}
        <KV
          rows={[
            [
              "model",
              <span key="m" className="mono">
                {s.model.registered_name ? `${s.model.registered_name} v${s.model.version} → ` : ""}
                {s.model.model_id}
              </span>,
            ],
            ["task", `${s.task} → ${s.output}`],
            ["readiness", s.ready_at ? `ready at ${fmtTime(s.ready_at)}` : s.state],
            [
              "model load",
              `${ms(s.timings?.load_ms)} (process start to ready ${ms(s.timings?.start_ms)})`,
            ],
            [
              "requests",
              `${s.counters.requests} · errors ${s.counters.errors} · refused ${s.counters.rejected}${s.counters.last_predict_ms !== undefined ? ` · last predict ${s.counters.last_predict_ms} ms` : ""}`,
            ],
            [
              "memory",
              s.memory
                ? `${fmtBytes(s.memory.rss_bytes)} resident · peak ${fmtBytes(s.memory.peak_rss_bytes)} · limit ${s.limits.memory_mb} MB`
                : `limit ${s.limits.memory_mb} MB`,
            ],
            [
              "GPU",
              s.memory?.gpu_allocated_bytes !== undefined
                ? fmtBytes(s.memory.gpu_allocated_bytes)
                : "not reported",
            ],
            [
              "limits",
              `${s.enforcement ?? "?"} · idle ${s.limits.idle_timeout_sec}s · lifetime ${s.limits.max_lifetime_sec}s · queue ${s.limits.max_queue} · request ≤ ${fmtBytes(s.limits.max_request_bytes)}`,
            ],
            ["last activity", s.last_activity_at ? fmtTime(s.last_activity_at) : "—"],
            ["restarts", String(s.restarts)],
          ]}
        />
        <details>
          <summary className="small">Lifecycle ({s.transitions.length})</summary>
          <ul className="small">
            {s.transitions.map((t: J, i: number) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: ordered history
              <li key={i}>
                {fmtTime(t.at)} {t.state}
                {t.reason ? ` (${t.reason})` : ""}
              </li>
            ))}
          </ul>
        </details>
        <button type="button" className="small" onClick={() => void loadLog.run()}>
          Show worker log
        </button>
        {log !== undefined ? (
          <pre className="small mono pre-wrap" data-testid="session-log">
            {log || "(empty)"}
          </pre>
        ) : null}
        {s.state === "ready" && adapter ? (
          <>
            <InputBuilder adapter={adapter} value={input} onChange={setInput} />
            <button
              type="button"
              className="primary"
              onClick={() => void predict.run()}
              disabled={predict.busy}
            >
              {predict.busy ? "Predicting…" : "Predict"}
            </button>
          </>
        ) : null}
        <ErrorBox error={predict.error} />
      </section>
      {result ? (
        <PredictionView pid={props.pid} base={props.base} result={result} images={shown} />
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ compare

function CompareMode(props: { pid: string; base: string }) {
  const [picks, setPicks] = useState<J[]>([{ kind: "registry" }, { kind: "registry" }]);
  const sels = picks.map(selectorOf);
  const first = useDescribe(props.pid, sels[0]);
  const adapter: Adapter | undefined = first.data?.adapter;
  const [source, setSource] = useState<"dataset" | "inputs">("dataset");
  const [ds, setDs] = useState({ path: "", targets: "", offset: 0, limit: 100 });
  const [input, setInput] = useState<InputState>(emptyInput());
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset inputs with the first model
  useEffect(() => setInput(emptyInput(adapter)), [first.data?.model?.model_id]);
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<J>();
  const run = useAction(async () => {
    const body: J = { models: sels, ...(ack ? { acknowledge_trust: true } : {}) };
    if (source === "dataset")
      body.dataset = {
        path: ds.path,
        offset: ds.offset,
        limit: ds.limit,
        ...(ds.targets ? { targets: ds.targets } : {}),
      };
    else if (adapter) body.inputs = payloadOf(adapter, input).payload;
    setResult(
      (await api<J>(`/api/v1/projects/${e(props.pid)}/inference/compare`, { body })).result,
    );
  });
  const ready = sels.every(Boolean) && (source === "dataset" ? ds.path : adapter);
  return (
    <>
      <section className="card" data-testid="compare">
        <h2>Compare models on identical examples</h2>
        <p className="faint small">
          Each model is pinned and runs in its own worker over the same ordered rows. Models whose
          input schemas differ are refused before anything runs.
        </p>
        {picks.map((pk, i) => (
          <ModelPicker
            // biome-ignore lint/suspicious/noArrayIndexKey: positional model slots
            key={i}
            pid={props.pid}
            label={`Model ${String.fromCharCode(65 + i)}`}
            value={pk}
            onChange={(v) => setPicks(picks.map((x, j) => (j === i ? v : x)))}
          />
        ))}
        <div className="row">
          {picks.length < 4 ? (
            <button
              type="button"
              className="small"
              onClick={() => setPicks([...picks, { kind: "registry" }])}
            >
              Add model
            </button>
          ) : null}
          {picks.length > 2 ? (
            <button type="button" className="small" onClick={() => setPicks(picks.slice(0, -1))}>
              Remove last
            </button>
          ) : null}
        </div>
        {first.data ? <AdapterSummary d={first.data} ack={ack} setAck={setAck} /> : null}
        <div className="row">
          <label>
            <input
              type="radio"
              checked={source === "dataset"}
              onChange={() => setSource("dataset")}
            />{" "}
            Dataset slice
          </label>
          <label>
            <input
              type="radio"
              checked={source === "inputs"}
              onChange={() => setSource("inputs")}
            />{" "}
            Hand-made inputs
          </label>
        </div>
        {source === "dataset" ? (
          <div className="row">
            <label className="field grow">
              File in the checkout
              <input
                aria-label="dataset path"
                placeholder="data/test.csv"
                value={ds.path}
                onChange={(ev) => setDs({ ...ds, path: ev.target.value })}
              />
            </label>
            <label className="field">
              Target column
              <input
                aria-label="target column"
                value={ds.targets}
                onChange={(ev) => setDs({ ...ds, targets: ev.target.value })}
              />
            </label>
            <label className="field">
              First row
              <input
                type="number"
                min={0}
                value={ds.offset}
                onChange={(ev) => setDs({ ...ds, offset: Number(ev.target.value) })}
              />
            </label>
            <label className="field">
              Rows
              <input
                type="number"
                min={1}
                max={1000}
                value={ds.limit}
                onChange={(ev) => setDs({ ...ds, limit: Number(ev.target.value) })}
              />
            </label>
          </div>
        ) : adapter ? (
          <InputBuilder adapter={adapter} value={input} onChange={setInput} />
        ) : null}
        <button
          type="button"
          className="primary"
          disabled={!ready || run.busy}
          onClick={() => void run.run()}
        >
          {run.busy ? "Comparing…" : "Compare"}
        </button>
        <ErrorBox error={run.error} />
        {run.error && (run.error as J).details?.pairs ? (
          <ul className="small err" data-testid="incompatible">
            {(run.error as J).details.pairs.map((p: J) => (
              <li key={p.models.join("-")}>
                {p.models.join(" vs ")}: {p.reasons.join("; ")}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {result ? <ComparisonView pid={props.pid} base={props.base} result={result} /> : null}
    </>
  );
}

function ComparisonView(props: { pid: string; base: string; result: J }) {
  const r = props.result;
  const c = r.comparison;
  const [onlyDis, setOnlyDis] = useState(false);
  const [onlyWrong, setOnlyWrong] = useState(false);
  const label = (m: J) =>
    m.model.registered_name
      ? `${m.model.registered_name} v${m.model.version}`
      : shortId(m.model.model_id, 12);
  const rows = (c.examples ?? []).filter(
    (x: J) =>
      (!onlyDis || !x.agree) && (!onlyWrong || (x.correct ?? []).some((ok: boolean) => !ok)),
  );
  return (
    <section className="card" data-testid="comparison-result">
      <h3>
        Comparison <span className="mono small">{r.result_id}</span>
      </h3>
      {r.dataset ? (
        <p className="small faint">
          {r.dataset.path} rows {r.dataset.offset}–{r.dataset.offset + r.dataset.limit - 1} · sha256{" "}
          <span className="mono">{shortId(r.dataset.sha256, 12)}</span>
          {r.dataset.source_commit ? ` · @${shortId(r.dataset.source_commit, 10)}` : ""}
        </p>
      ) : null}
      {r.models
        .filter((m: J) => m.status !== "ok")
        .map((m: J) => (
          <div key={m.model.model_id} className="banner err" role="alert">
            {label(m)}: <strong>{m.error.code}</strong> {m.error.message}
          </div>
        ))}
      <p>
        <Badge tone={c.paired ? "ok" : "warn"}>
          {c.paired ? "paired: same ordered rows" : "not paired"}
        </Badge>{" "}
        {c.rows} rows · <strong data-testid="disagreements">{c.disagreements ?? 0}</strong>{" "}
        disagreements
        {c.note ? <span className="faint"> · {c.note}</span> : null}
      </p>
      {c.summary ? (
        <div className="table-wrap">
          <table className="small" data-testid="comparison-summary">
            <thead>
              <tr>
                <th>model</th>
                <th>
                  {r.output === "regression"
                    ? "MAE (lower is better)"
                    : "accuracy (higher is better)"}
                </th>
                <th>n</th>
                <th>load</th>
                <th>predict</th>
              </tr>
            </thead>
            <tbody>
              {c.summary.map((s: J, i: number) => (
                <tr key={s.model_id}>
                  <td className="mono">{label(r.models[i])}</td>
                  <td>
                    {s.accuracy !== undefined
                      ? `${s.accuracy.toFixed(4)} (${s.correct}/${s.rows})`
                      : s.mae !== undefined
                        ? s.mae.toPrecision(4)
                        : "no targets"}
                  </td>
                  <td>{s.rows}</td>
                  <td>{ms(s.load_ms)}</td>
                  <td>{ms(s.predict_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {c.paired_test ? (
        <p className="small" data-testid="paired-test">
          {c.paired_test.method ? (
            <>
              {c.paired_test.method}: p = {c.paired_test.p_value.toPrecision(3)} (
              {c.paired_test.only_first_correct} vs {c.paired_test.only_second_correct} discordant
              rows). Assumes: {c.paired_test.assumptions}.
            </>
          ) : (
            <span className="faint">{c.paired_test.note}</span>
          )}
        </p>
      ) : null}
      {c.examples?.length ? (
        <>
          <div className="row small">
            <label>
              <input
                type="checkbox"
                checked={onlyDis}
                onChange={(ev) => setOnlyDis(ev.target.checked)}
              />{" "}
              only disagreements
            </label>
            {c.has_targets && r.output !== "regression" ? (
              <label>
                <input
                  type="checkbox"
                  checked={onlyWrong}
                  onChange={(ev) => setOnlyWrong(ev.target.checked)}
                />{" "}
                only errors
              </label>
            ) : null}
            <span className="faint">{rows.length} shown</span>
          </div>
          <div className="table-wrap">
            <table className="small" data-testid="aligned-examples">
              <thead>
                <tr>
                  <th>row</th>
                  <th>input</th>
                  {c.has_targets ? <th>target</th> : null}
                  {r.models.map((m: J) => (
                    <th key={m.model.model_id}>{label(m)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 500).map((x: J) => (
                  <tr key={x.index} className={x.agree ? "" : "warn"}>
                    <td>{x.index}</td>
                    <td>{inputCell(r, x.index - (r.dataset?.offset ?? 0), undefined)}</td>
                    {c.has_targets ? <td>{show(x.target, r.labels)}</td> : null}
                    {x.predictions.map((p: unknown, j: number) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: one cell per model
                      <td key={j} className={x.correct && !x.correct[j] ? "err" : ""}>
                        {show(p, r.labels)}
                        {x.correct ? (x.correct[j] ? " ✓" : " ✗") : ""}
                        {x.abs_errors ? (
                          <span className="faint"> (|e| {show(x.abs_errors[j])})</span>
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <SaveEvidence pid={props.pid} base={props.base} result={r} />
    </section>
  );
}

// ------------------------------------------------------------------ evidence

function EvidenceList(props: { pid: string; base: string }) {
  const [deleted, setDeleted] = useState(false);
  const list = useApi<{ evidence: J[] }>(
    `/api/v1/projects/${e(props.pid)}/inference/evidence${deleted ? "?deleted=1" : ""}`,
  );
  const [open, setOpen] = useState<string>();
  const [confirm, setConfirm] = useState<string>();
  const del = useAction(async (id: string) => {
    await api(`/api/v1/projects/${e(props.pid)}/inference/evidence/${e(id)}`, { method: "DELETE" });
    setConfirm(undefined);
    list.reload();
  });
  return (
    <section className="card" data-testid="evidence-list">
      <h2>Saved inference evidence</h2>
      <p className="faint small">
        Each item is an MLflow run tagged <code>inference_evidence</code> holding one artifact with
        the inputs, outputs and provenance. Deleting it deletes that run.
      </p>
      <label className="small">
        <input type="checkbox" checked={deleted} onChange={(ev) => setDeleted(ev.target.checked)} />{" "}
        include deleted
      </label>
      <ErrorBox error={list.error} onRetry={list.reload} />
      <ErrorBox error={del.error} />
      {list.data && !list.data.evidence.length ? <Empty>Nothing saved yet.</Empty> : null}
      {list.data?.evidence.length ? (
        <div className="table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>title</th>
                <th>kind</th>
                <th>models</th>
                <th>rows</th>
                <th>stored</th>
                <th>saved</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.evidence.map((x) => (
                <tr key={x.evidence_id}>
                  <td>
                    <button
                      type="button"
                      className="link small"
                      onClick={() => setOpen(open === x.evidence_id ? undefined : x.evidence_id)}
                    >
                      {x.title}
                    </button>
                  </td>
                  <td>{x.kind}</td>
                  <td className="mono">
                    {x.models
                      .map((m: J) =>
                        m.registered_name
                          ? `${m.registered_name} v${m.version}`
                          : shortId(m.model_id, 12),
                      )
                      .join(" vs ")}
                  </td>
                  <td>{x.rows}</td>
                  <td>
                    {x.stored.join(", ")} ({fmtBytes(x.artifact_bytes)})
                  </td>
                  <td className="faint">{fmtTime(x.saved_at)}</td>
                  <td>
                    {x.deleted_at ? (
                      <Badge tone="neutral">deleted</Badge>
                    ) : confirm === x.evidence_id ? (
                      <>
                        <button
                          type="button"
                          className="small danger"
                          onClick={() => void del.run(x.evidence_id)}
                        >
                          Delete run
                        </button>
                        <button
                          type="button"
                          className="small"
                          onClick={() => setConfirm(undefined)}
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="small"
                        onClick={() => setConfirm(x.evidence_id)}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? <EvidenceDetail pid={props.pid} base={props.base} id={open} /> : null}
    </section>
  );
}

function EvidenceDetail(props: { pid: string; base: string; id: string }) {
  const v = useApi<J>(`/api/v1/projects/${e(props.pid)}/inference/evidence/${e(props.id)}`);
  if (v.error) return <ErrorBox error={v.error} />;
  if (!v.data) return <Loading />;
  const x = v.data.evidence;
  return (
    <div className="card inset" data-testid="evidence-detail">
      <KV
        rows={[
          [
            "evidence",
            <span key="i" className="mono">
              {x.evidence_id}
            </span>,
          ],
          [
            "models",
            <span key="m">
              {x.models.map((m: J) => (
                <div key={m.model_id}>
                  <Link to={`${props.base}/models/m/${e(m.model_id)}`}>{m.model_id}</Link>
                  {m.registered_name
                    ? ` · ${m.registered_name} v${m.version}${m.alias ? ` (@${m.alias})` : ""}`
                    : ""}
                  {m.source_run_id ? ` · source run ${shortId(m.source_run_id)}` : ""}
                  {m.source_commit ? ` @${shortId(m.source_commit, 10)}` : ""}
                </div>
              ))}
            </span>,
          ],
          [
            "dataset",
            x.dataset
              ? `${x.dataset.path} [${x.dataset.offset}, +${x.dataset.limit}) sha256 ${shortId(x.dataset.sha256, 12)}`
              : "hand-made inputs",
          ],
          [
            "input hash",
            <span key="h" className="mono">
              {x.input_sha256}
            </span>,
          ],
          ["code revision", x.code_revision ?? "—"],
          [
            "environment",
            `${x.environment.kind} · MLflow ${x.environment.mlflow_version ?? "?"} · Python ${x.environment.python_version ?? "?"} · bridge v${x.environment.bridge_version}`,
          ],
          [
            "MLflow",
            x.deleted_at
              ? `deleted ${fmtTime(x.deleted_at)}`
              : `run ${x.mlflow_run_id} · ${x.artifact_path}`,
          ],
          ["predicted / saved", `${fmtTime(x.predicted_at)} / ${fmtTime(x.saved_at)}`],
        ]}
      />
      {v.data.unavailable ? <p className="small warn">MLflow: {v.data.unavailable}</p> : null}
    </div>
  );
}
