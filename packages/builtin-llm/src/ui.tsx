/**
 * The LLM Research Lab (spec §5.6 GenAI Traces, GenAI Evaluation & Prompts, LLM Research Lab rows;
 * §5.6.2; criteria 10, 10a, 10b, 10c, 10e; ADR 0021). Traces (span tree, waterfall, RAG and tool
 * views, feedback), the prompt registry (versions, diffs, aliases), golden sets, GenAI evaluations
 * (side-by-side per-example results, scorer and judge feedback, flags, reports), the playground
 * with saved evidence, and the project's LLM data controls.
 *
 * Everything shown comes from the coordinator's LLM API; bodies appear only as the project's
 * capture policy allows, token usage only where a provider reported it, costs only as labelled
 * estimates.
 */
import { type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, navigate, qs, useApi, useBackendContext, useEvents } from "./ui/api.ts";
import {
  Badge,
  Empty,
  ErrorBox,
  KV,
  Link,
  Loading,
  Tabs,
  type Tone,
  useAction,
} from "./ui/components.tsx";
import { fmtTime, shortId } from "./ui/format.ts";
import "./ui/styles.css";

// biome-ignore lint/suspicious/noExplicitAny: API JSON shaped by the coordinator
type J = any;
const e = encodeURIComponent;

const LLM_TABS = [
  { id: "traces", label: "Traces", path: "/llm" },
  { id: "prompts", label: "Prompts", path: "/llm/prompts" },
  { id: "golden", label: "Golden sets", path: "/llm/golden" },
  { id: "evaluations", label: "Evaluations", path: "/llm/evaluations" },
  { id: "playground", label: "Playground", path: "/llm/playground" },
  { id: "evidence", label: "Evidence", path: "/llm/evidence" },
  { id: "controls", label: "Data controls", path: "/llm/settings" },
] as const;

const str = (v: unknown) =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
const short = (v: unknown, n = 120) => {
  const s = str(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function stateTone(s: string): Tone {
  if (s === "succeeded" || s === "OK") return "ok";
  if (s === "running" || s === "queued") return "info";
  if (s === "canceled" || s === "interrupted") return "neutral";
  return "err";
}

function scoreTone(v: J): Tone {
  if (v?.error) return "warn";
  if (v?.value === true || v?.value === "yes") return "ok";
  if (v?.value === false || v?.value === "no") return "err";
  return "neutral";
}

function Usage(props: { u: J }) {
  const u = props.u;
  if (!u) return <span className="faint">—</span>;
  if (!u.reported)
    return (
      <span className="faint" title="the provider reported no token usage; nothing is estimated">
        usage not reported
      </span>
    );
  return (
    <span title={`${u.reported} call(s) reported usage, ${u.missing} did not`}>
      {u.total_tokens ?? "?"} tokens
      {u.missing ? <span className="faint"> ({u.missing} unreported)</span> : null}
    </span>
  );
}

function Cost(props: { c: J; why?: string }) {
  if (!props.c) return <span className="faint">{props.why ?? "no estimate"}</span>;
  return (
    <span title={props.c.basis}>
      ~${props.c.estimated_usd} <Badge tone="neutral">estimate</Badge>{" "}
      <span className="faint small">
        {props.c.rate_source}, {props.c.rate_version}
        {props.c.partial ? ", partial" : ""}
      </span>
    </span>
  );
}

function Pre(props: { v: unknown; omitted?: boolean }) {
  if (props.omitted) return <span className="faint small">not captured (capture policy)</span>;
  if (props.v === undefined || props.v === null) return <span className="faint small">—</span>;
  return (
    <pre className="small mono pre-wrap">
      {typeof props.v === "string" ? props.v : JSON.stringify(props.v, null, 2)}
    </pre>
  );
}

function LlmRouter(props: { pid: string; base: string; rest: string }) {
  const rest = props.rest.replace(/^\/?llm(?:\/|$)/, "");
  const parts = rest.split("/").filter(Boolean);
  const head = parts[0] ?? "";
  const id = parts[1] ? decodeURIComponent(parts[1]) : undefined;
  const p = { pid: props.pid, base: props.base };
  let body: ReactNode;
  let active = "traces";
  if (head === "traces" && id) body = <TraceDetail {...p} id={id} />;
  else if (head === "prompts") {
    active = "prompts";
    body = id ? <PromptDetail {...p} name={id} /> : <Prompts {...p} />;
  } else if (head === "golden") {
    active = "golden";
    body = id ? <GoldenDetail {...p} id={id} /> : <GoldenSets {...p} />;
  } else if (head === "evaluations") {
    active = "evaluations";
    body =
      id === "new" ? (
        <NewEvaluation {...p} />
      ) : id ? (
        <EvaluationDetail {...p} id={id} />
      ) : (
        <Evaluations {...p} />
      );
  } else if (head === "playground") {
    active = "playground";
    body = <Playground {...p} />;
  } else if (head === "evidence") {
    active = "evidence";
    body = <Evidence {...p} />;
  } else if (head === "settings") {
    active = "controls";
    body = <DataControls {...p} />;
  } else body = <Traces {...p} />;
  return (
    <div className="llm-lab" data-testid="llm-lab">
      <Tabs
        items={LLM_TABS.map((t) => ({ id: t.id, label: t.label, to: `${props.base}${t.path}` }))}
        active={active}
      />
      {body}
    </div>
  );
}

function BackendLlmApp() {
  const context = useBackendContext();
  if (!context) return <Loading />;
  return <LlmRouter pid={context.pid} base={context.base} rest={context.rest} />;
}

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<BackendLlmApp />);

// ===================================================================== traces

function Traces(props: { pid: string; base: string }) {
  const [f, setF] = useState<Record<string, string>>({});
  const d = useApi<J>(
    `/api/v1/projects/${e(props.pid)}/llm/traces${qs({ ...f, clusters: f["status"] === "ERROR" ? 1 : undefined })}`,
  );
  useEvents(() => d.reload(), {
    project: props.pid,
    types: ["llm.evaluation.updated", "tracking.run.sync"],
  });
  const set = (k: string, v: string) =>
    setF((o) => ({
      ...Object.fromEntries(Object.entries(o).filter(([x]) => x !== k)),
      ...(v ? { [k]: v } : {}),
    }));
  return (
    <section className="card" data-testid="traces">
      <h2>Traces</h2>
      <p className="muted small">
        MLflow traces of this project (jobs, the playground and GenAI evaluations). Bodies are shown
        as the project's capture policy allows today.
      </p>
      <div className="row small" style={{ flexWrap: "wrap", gap: 8 }}>
        <label className="field">
          Status
          <select
            value={f["status"] ?? ""}
            onChange={(x) => set("status", x.target.value)}
            aria-label="status"
          >
            <option value="">any</option>
            <option value="ERROR">error</option>
            <option value="OK">ok</option>
          </select>
        </label>
        {(["source", "evaluation", "example_id", "variant", "prompt", "run_id"] as const).map(
          (k) => (
            <label key={k} className="field">
              {k.replace("_", " ")}
              <input
                value={f[k] ?? ""}
                onChange={(x) => set(k, x.target.value.trim())}
                aria-label={k}
                size={14}
              />
            </label>
          ),
        )}
      </div>
      {d.error ? (
        <ErrorBox error={d.error} onRetry={d.reload} />
      ) : !d.data ? (
        <Loading />
      ) : !d.data.traces.length ? (
        <Empty>{d.data.unavailable ?? "No traces match."}</Empty>
      ) : (
        <>
          {d.data.clusters?.length ? (
            <div className="banner warn small">
              Failure clusters:{" "}
              {d.data.clusters.map((c: J) => (
                <span key={`${c.span}-${c.error_type}`} className="mono">
                  {c.count}× {c.error_type} in {c.span}{" "}
                </span>
              ))}
            </div>
          ) : null}
          <div className="table-wrap">
            <table className="small">
              <thead>
                <tr>
                  <th>Trace</th>
                  <th>State</th>
                  <th>Name</th>
                  <th>Duration</th>
                  <th>Tags</th>
                  <th>Request</th>
                  <th>Feedback</th>
                </tr>
              </thead>
              <tbody>
                {d.data.traces.map((t: J) => (
                  <tr key={t.trace_id}>
                    <td>
                      <Link to={`${props.base}/llm/traces/${t.trace_id}`} className="mono">
                        {shortId(t.trace_id)}
                      </Link>
                    </td>
                    <td>
                      <Badge tone={stateTone(t.state)}>{t.state}</Badge>
                    </td>
                    <td>{t.name}</td>
                    <td>{t.duration_ms ?? "?"} ms</td>
                    <td className="faint">
                      {Object.entries(t.tags)
                        .filter(([k]) => /source|example|variant|evaluation/.test(k))
                        .map(([k, v]) => `${k.replace("ablationkit.", "")}=${v}`)
                        .join(" ")}
                    </td>
                    <td>{short(t.request_preview, 60)}</td>
                    <td>
                      {(t.assessments ?? []).slice(0, 4).map((a: J) => (
                        <Badge
                          key={`${a.name}-${a.source}-${str(a.value)}`}
                          tone={scoreTone(a)}
                          title={a.source}
                        >
                          {a.name}
                        </Badge>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function TraceDetail(props: { pid: string; base: string; id: string }) {
  const d = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/traces/${e(props.id)}`);
  const [sel, setSel] = useState<string>();
  const [fb, setFb] = useState({ name: "", value: "true", rationale: "" });
  const save = useAction(async () => {
    const v = fb.value === "true" ? true : fb.value === "false" ? false : fb.value;
    await api(`/api/v1/projects/${e(props.pid)}/llm/traces/${e(props.id)}/feedback`, {
      body: {
        name: fb.name,
        value: v,
        ...(fb.rationale ? { rationale: fb.rationale } : {}),
        ...(sel ? { span_id: sel } : {}),
      },
    });
    setFb({ name: "", value: "true", rationale: "" });
    d.reload();
  });
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const t = d.data;
  const total = Math.max(1, ...t.spans.map((s: J) => s.offset_ms + (s.duration_ms ?? 0)));
  const span = t.spans.find((s: J) => s.span_id === sel) ?? t.spans[0];
  const l = t.links ?? {};
  return (
    <div data-testid="trace-detail">
      <section className="card">
        <h2 className="mono">{t.trace.trace_id}</h2>
        <KV
          rows={[
            [
              "State",
              <Badge key="s" tone={stateTone(t.trace.state)}>
                {t.trace.state}
              </Badge>,
            ],
            ["Duration", `${t.trace.duration_ms ?? "?"} ms`],
            ["Tokens", <Usage key="u" u={t.usage} />],
            [
              "Capture",
              `${t.capture.now}${t.capture.recorded_under ? ` (recorded under ${t.capture.recorded_under})` : ""}`,
            ],
            [
              "Links",
              <span key="l" className="small">
                {l.evaluation_id ? (
                  <Link to={`${props.base}/llm/evaluations/${l.evaluation_id}`}>
                    {l.evaluation_id}
                  </Link>
                ) : null}
                {l.example_id ? ` example ${l.example_id}` : ""}
                {l.variant ? ` · ${l.variant}` : ""}
                {l.prompt ? ` · prompt ${l.prompt}` : ""}
                {l.run_id ? (
                  <>
                    {" "}
                    · run{" "}
                    <Link to={`${props.base}/runs/${l.run_id}`} className="mono">
                      {shortId(l.run_id)}
                    </Link>
                  </>
                ) : null}
                {(l.research ?? []).map((r: J) => (
                  <span key={r.id}>
                    {" "}
                    · <Link to={`${props.base}/knowledge/${r.id}`}>{r.title}</Link>
                  </span>
                ))}
              </span>,
            ],
          ]}
        />
        {!t.spans_available ? (
          <div className="banner warn small">MLflow has no span data for this trace.</div>
        ) : null}
      </section>
      <section className="card" data-testid="span-tree">
        <h2>Span tree and waterfall</h2>
        <div className="table-wrap">
          <table className="small">
            <tbody>
              {t.spans.map((s: J) => (
                <tr key={s.span_id} className={s.span_id === span?.span_id ? "selected" : ""}>
                  <td style={{ paddingLeft: 8 + s.depth * 16 }}>
                    <button type="button" className="link small" onClick={() => setSel(s.span_id)}>
                      {s.name}
                    </button>{" "}
                    <Badge
                      tone={
                        s.kind === "llm"
                          ? "info"
                          : s.kind === "retrieval"
                            ? "ok"
                            : s.kind === "tool"
                              ? "warn"
                              : "neutral"
                      }
                    >
                      {s.kind}
                    </Badge>
                    {s.error ? <Badge tone="err">{s.error.type ?? "error"}</Badge> : null}
                  </td>
                  <td style={{ width: "45%" }}>
                    <div
                      style={{ position: "relative", height: 10, background: "var(--line)" }}
                      aria-hidden="true"
                    >
                      <div
                        style={{
                          position: "absolute",
                          left: `${(s.offset_ms / total) * 100}%`,
                          width: `${Math.max(0.5, ((s.duration_ms ?? 0) / total) * 100)}%`,
                          top: 0,
                          bottom: 0,
                          background: s.error ? "var(--err, #c66)" : "var(--accent)",
                        }}
                      />
                    </div>
                  </td>
                  <td className="mono">{s.duration_ms?.toFixed(1) ?? "?"} ms</td>
                  <td>{s.usage ? `${s.usage.total_tokens ?? "?"} tok` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {span ? (
          <div className="card inset" data-testid="span-detail">
            <h3>
              {span.name}{" "}
              <span className="faint small">
                {span.type}
                {span.model ? ` · ${span.model}` : ""}
              </span>
            </h3>
            {span.error ? (
              <div className="banner err small">
                {span.error.type}: {span.error.message}
              </div>
            ) : null}
            <div className="row" style={{ alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
              <div className="grow">
                <strong className="small">Inputs</strong>
                <Pre v={span.inputs} omitted={span.bodies_omitted && span.inputs === undefined} />
              </div>
              <div className="grow">
                <strong className="small">Outputs</strong>
                <Pre v={span.outputs} omitted={span.bodies_omitted && span.outputs === undefined} />
              </div>
            </div>
          </div>
        ) : null}
      </section>
      <section className="card" data-testid="rag-view">
        <h2>Retrieval (RAG)</h2>
        {!t.rag.instrumented ? (
          <Empty>
            Not instrumented: this trace has no retrieval span, so nothing about retrieval is shown
            or inferred.
          </Empty>
        ) : (
          <>
            <KV
              rows={[
                ["Query", short(t.rag.query, 200)],
                [
                  "Index revision",
                  t.rag.index_revision.available ? (
                    <span key="ir" className="mono">
                      {t.rag.index_revision.value}
                    </span>
                  ) : (
                    <span key="ir" className="faint">
                      unavailable: {t.rag.index_revision.reason}
                    </span>
                  ),
                ],
                [
                  "Retrieval config",
                  t.rag.retrieval_config.available ? (
                    <span key="rc" className="mono small">
                      {JSON.stringify(t.rag.retrieval_config.value)}
                    </span>
                  ) : (
                    <span key="rc" className="faint">
                      unavailable: {t.rag.retrieval_config.reason}
                    </span>
                  ),
                ],
              ]}
            />
            {t.rag.retrievals.map((r: J) => (
              <div key={r.span_id} className="small">
                <strong>
                  {r.kind} {r.name}
                </strong>{" "}
                <span className="faint">{r.duration_ms?.toFixed(1)} ms</span>
                {r.bodies_omitted ? <span className="faint"> · passages not captured</span> : null}
                <ol>
                  {r.documents.map((doc: J) => (
                    <li
                      key={`${doc.doc_uri}-${doc.chunk_id}-${doc.id ?? ""}-${short(doc.content, 24)}`}
                    >
                      <span className="mono">
                        {doc.doc_uri ?? "?"}#{doc.chunk_id ?? "?"}
                      </span>
                      {doc.score !== undefined ? (
                        <span className="faint"> score {doc.score}</span>
                      ) : null}{" "}
                      {short(doc.content, 160)}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </>
        )}
      </section>
      <section className="card" data-testid="tool-view">
        <h2>Tool calls</h2>
        {!t.tools.length ? (
          <Empty>No tool spans in this trace.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="small">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Attempt</th>
                  <th>Arguments</th>
                  <th>Result</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {t.tools.map((c: J) => (
                  <tr key={c.span_id}>
                    <td>{c.name}</td>
                    <td>
                      {c.attempt}
                      {c.retried ? <Badge tone="warn">retried</Badge> : null}
                    </td>
                    <td className="mono">{short(c.arguments, 60)}</td>
                    <td>
                      {c.error ? (
                        <Badge tone="err">{c.error.type ?? "error"}</Badge>
                      ) : (
                        <span className="mono">{short(c.result, 60)}</span>
                      )}
                    </td>
                    <td>{c.duration_ms?.toFixed(1)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="faint small">
          Observed calls only; no hidden reasoning is shown or inferred.
        </p>
      </section>
      <section className="card" data-testid="feedback">
        <h2>Feedback</h2>
        {t.assessments.length ? (
          <ul className="small">
            {t.assessments.map((a: J) => (
              <li key={a.assessment_id}>
                <Badge tone={scoreTone(a)}>{a.name}</Badge> {str(a.value)}{" "}
                <span className="faint">
                  {a.source?.source_type} {a.source?.source_id}
                  {a.source?.source_type === "LLM_JUDGE"
                    ? " (a judge's opinion, not ground truth)"
                    : ""}
                </span>
                {a.error ? <span className="warn"> error: {a.error}</span> : null}
                {a.rationale ? <div className="faint">{a.rationale}</div> : null}
                {a.metadata?.rubric_sha256 ? (
                  <div className="faint mono">
                    rubric {a.metadata.rubric_sha256.slice(0, 12)} · {a.metadata.judge_provider}/
                    {a.metadata.judge_model}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No feedback yet.</Empty>
        )}
        <div className="row small" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="name (e.g. grounded)"
            value={fb.name}
            onChange={(x) => setFb({ ...fb, name: x.target.value })}
            aria-label="feedback name"
          />
          <select
            value={fb.value}
            onChange={(x) => setFb({ ...fb, value: x.target.value })}
            aria-label="feedback value"
          >
            <option value="true">pass</option>
            <option value="false">fail</option>
          </select>
          <input
            placeholder="rationale"
            value={fb.rationale}
            onChange={(x) => setFb({ ...fb, rationale: x.target.value })}
            aria-label="feedback rationale"
            className="grow"
          />
          <button
            type="button"
            className="primary"
            disabled={!fb.name || save.busy}
            onClick={() => save.run()}
          >
            Add feedback{sel ? " on span" : ""}
          </button>
        </div>
        {save.error ? <ErrorBox error={save.error} /> : null}
      </section>
    </div>
  );
}

// ===================================================================== prompts

function Prompts(props: { pid: string; base: string }) {
  const d = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/prompts`);
  useEvents(() => d.reload(), { project: props.pid, types: ["llm.prompt.updated"] });
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const create = useAction(async () => {
    const t = text.trim().startsWith("[") ? JSON.parse(text) : text;
    await api(`/api/v1/projects/${e(props.pid)}/llm/prompts`, { body: { name, template: t } });
    navigate(`${props.base}/llm/prompts/${e(name)}`);
  });
  return (
    <section className="card" data-testid="prompts">
      <h2>Prompt registry</h2>
      {d.error ? (
        <ErrorBox error={d.error} onRetry={d.reload} />
      ) : !d.data ? (
        <Loading />
      ) : !d.data.prompts.length ? (
        <Empty>No prompts linked to this project yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>Prompt</th>
                <th>Latest</th>
                <th>Aliases</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {d.data.prompts.map((p: J) => (
                <tr key={p.name}>
                  <td>
                    <Link to={`${props.base}/llm/prompts/${e(p.name)}`}>{p.name}</Link>
                  </td>
                  <td>v{p.latest_version}</td>
                  <td>
                    {p.aliases.map((a: J) => (
                      <Badge key={a.alias} tone="info">
                        @{a.alias}→v{a.version}
                      </Badge>
                    ))}
                  </td>
                  <td className="faint">{p.updated_at ? fmtTime(p.updated_at) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details>
        <summary className="small">New prompt or version</summary>
        <div className="row small" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="name"
            value={name}
            onChange={(x) => setName(x.target.value)}
            aria-label="prompt name"
          />
        </div>
        <textarea
          rows={5}
          style={{ width: "100%" }}
          placeholder='Text with {{variables}}, or a chat template: [{"role":"system","content":"…"},{"role":"user","content":"{{question}}"}]'
          value={text}
          onChange={(x) => setText(x.target.value)}
          aria-label="prompt template"
        />
        <button
          type="button"
          className="primary"
          disabled={!name || !text || create.busy}
          onClick={() => create.run()}
        >
          Register version
        </button>
        {create.error ? <ErrorBox error={create.error} /> : null}
      </details>
    </section>
  );
}

function PromptDetail(props: { pid: string; base: string; name: string }) {
  const d = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/prompts/${e(props.name)}`);
  const [pick, setPick] = useState<{ from?: number; to?: number }>({});
  const vs: J[] = d.data?.prompt.versions ?? [];
  const from = pick.from ?? vs[1]?.version;
  const to = pick.to ?? vs[0]?.version;
  const diff = useApi<J>(
    from && to && from !== to
      ? `/api/v1/projects/${e(props.pid)}/llm/prompts/${e(props.name)}/diff?from=${from}&to=${to}`
      : undefined,
  );
  const [alias, setAlias] = useState({ alias: "", version: "" });
  const setA = useAction(async () => {
    await api(`/api/v1/projects/${e(props.pid)}/llm/prompts/${e(props.name)}/alias`, {
      body: { alias: alias.alias, version: Number(alias.version) },
    });
    d.reload();
  });
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  return (
    <div data-testid="prompt-detail">
      <section className="card">
        <h2>{props.name}</h2>
        <div className="table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>Version</th>
                <th>Format</th>
                <th>Variables</th>
                <th>Aliases</th>
                <th>Template</th>
                <th>SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {vs.map((v) => (
                <tr key={v.version}>
                  <td>
                    v{v.version}
                    {v.tags?.["ablationkit.created_by"] === "agent" ? (
                      <Badge tone="neutral">agent</Badge>
                    ) : null}
                  </td>
                  <td>{v.format}</td>
                  <td className="mono">{v.variables.join(", ")}</td>
                  <td>
                    {v.aliases.map((a: string) => (
                      <Badge key={a} tone="info">
                        @{a}
                      </Badge>
                    ))}
                  </td>
                  <td>
                    <Pre v={v.template} />
                  </td>
                  <td className="mono faint">{v.template_sha256.slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row small" style={{ gap: 8 }}>
          <input
            placeholder="alias (e.g. champion)"
            value={alias.alias}
            onChange={(x) => setAlias({ ...alias, alias: x.target.value })}
            aria-label="alias"
          />
          <select
            value={alias.version}
            onChange={(x) => setAlias({ ...alias, version: x.target.value })}
            aria-label="alias version"
          >
            <option value="">version…</option>
            {vs.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!alias.alias || !alias.version || setA.busy}
            onClick={() => setA.run()}
          >
            Point alias
          </button>
          <span className="faint">
            Moving an alias changes what @alias resolves to for new runs; past runs keep the version
            they pinned.
          </span>
        </div>
        {setA.error ? <ErrorBox error={setA.error} /> : null}
      </section>
      <section className="card" data-testid="prompt-diff">
        <h2>Diff</h2>
        <div className="row small" style={{ gap: 8 }}>
          {(["from", "to"] as const).map((k) => (
            <label key={k} className="field">
              {k}
              <select
                value={(k === "from" ? from : to) ?? ""}
                onChange={(x) => setPick({ ...pick, [k]: Number(x.target.value) })}
                aria-label={`diff ${k}`}
              >
                {vs.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {!diff.data ? (
          vs.length < 2 ? (
            <Empty>One version only.</Empty>
          ) : (
            <Loading />
          )
        ) : (
          <>
            <p className="small">
              Variables added{" "}
              <span className="mono">{diff.data.diff.variables.added.join(", ") || "—"}</span>,
              removed{" "}
              <span className="mono">{diff.data.diff.variables.removed.join(", ") || "—"}</span>
              {diff.data.diff.identical ? " · identical" : ""}
            </p>
            {diff.data.diff.blocks.map((b: J) => (
              <div key={b.label} className="small">
                <strong>{b.label}</strong>
                {b.role_from !== b.role_to ? (
                  <span className="warn">
                    {" "}
                    role {b.role_from ?? "—"} → {b.role_to ?? "—"}
                  </span>
                ) : null}
                <pre className="mono pre-wrap">
                  {b.lines
                    .map((l: J, n: number) => ({ ...l, n }))
                    .map((l: J) => (
                      <div
                        key={`line-${l.n}-${l.op}`}
                        className={l.op === "add" ? "ok" : l.op === "del" ? "err" : "faint"}
                      >
                        {l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}
                        {l.text}
                      </div>
                    ))}
                </pre>
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}

// ===================================================================== golden sets

function GoldenSets(props: { pid: string; base: string }) {
  const d = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/golden-sets`);
  useEvents(() => d.reload(), { project: props.pid, types: ["llm.golden_set.updated"] });
  const [f, setF] = useState({ name: "", file: "", held_out: false });
  const create = useAction(async () => {
    await api(`/api/v1/projects/${e(props.pid)}/llm/golden-sets`, {
      body: { name: f.name, from_file: f.file, held_out: f.held_out },
    });
    d.reload();
  });
  return (
    <section className="card" data-testid="golden-sets">
      <h2>Golden sets</h2>
      <p className="muted small">
        Fixed, versioned evaluation sets. A version is immutable and pinned by SHA-256; held-out
        sets take versions only from you, and agents never see their expectations.
      </p>
      {d.error ? (
        <ErrorBox error={d.error} onRetry={d.reload} />
      ) : !d.data ? (
        <Loading />
      ) : !d.data.golden_sets.length ? (
        <Empty>No golden sets.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>Set</th>
                <th>Latest</th>
                <th>Examples</th>
                <th>Categories</th>
                <th>No ground truth</th>
                <th>MLflow dataset</th>
              </tr>
            </thead>
            <tbody>
              {d.data.golden_sets.map((g: J) => {
                const v = g.versions.at(-1);
                return (
                  <tr key={g.golden_set_id}>
                    <td>
                      <Link to={`${props.base}/llm/golden/${g.golden_set_id}`}>{g.name}</Link>
                      {g.held_out ? <Badge tone="warn">held out</Badge> : null}
                    </td>
                    <td>v{v.version}</td>
                    <td>
                      {v.examples}
                      {v.edge_cases ? <span className="faint"> ({v.edge_cases} edge)</span> : null}
                    </td>
                    <td className="faint">
                      {Object.entries(v.categories)
                        .map(([k, n]) => `${k} ${n}`)
                        .join(", ")}
                    </td>
                    <td>{v.missing_expectations}</td>
                    <td className="mono faint">
                      {v.mlflow_dataset_id ? shortId(v.mlflow_dataset_id) : "not mirrored"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <details>
        <summary className="small">New golden set from a checkout file</summary>
        <div className="row small" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="name"
            value={f.name}
            onChange={(x) => setF({ ...f, name: x.target.value })}
            aria-label="golden set name"
          />
          <input
            placeholder="golden.jsonl (relative to the checkout)"
            value={f.file}
            onChange={(x) => setF({ ...f, file: x.target.value })}
            aria-label="golden set file"
            size={32}
          />
          <label className="row" style={{ gap: 4 }}>
            <input
              type="checkbox"
              checked={f.held_out}
              onChange={(x) => setF({ ...f, held_out: x.target.checked })}
            />{" "}
            held out
          </label>
          <button
            type="button"
            className="primary"
            disabled={!f.name || !f.file || create.busy}
            onClick={() => create.run()}
          >
            Create
          </button>
        </div>
        {create.error ? <ErrorBox error={create.error} /> : null}
      </details>
    </section>
  );
}

function GoldenDetail(props: { pid: string; base: string; id: string }) {
  const d = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/golden-sets/${e(props.id)}`);
  const [ver, setVer] = useState<number>();
  const v = ver ?? d.data?.golden_set.versions.at(-1)?.version;
  const ex = useApi<J>(
    v
      ? `/api/v1/projects/${e(props.pid)}/llm/golden-sets/${e(props.id)}/examples?version=${v}`
      : undefined,
  );
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const g = d.data.golden_set;
  return (
    <section className="card" data-testid="golden-detail">
      <h2>
        {g.name} {g.held_out ? <Badge tone="warn">held out</Badge> : null}
      </h2>
      {g.description ? <p className="muted small">{g.description}</p> : null}
      <div className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
        {g.versions.map((x: J) => (
          <button
            key={x.version}
            type="button"
            className={x.version === v ? "primary" : ""}
            onClick={() => setVer(x.version)}
            title={x.sha256}
          >
            v{x.version} · {x.examples} · {x.sha256.slice(0, 8)}
          </button>
        ))}
      </div>
      {!ex.data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>Example</th>
                <th>Category</th>
                <th>Inputs</th>
                <th>Expectations</th>
              </tr>
            </thead>
            <tbody>
              {ex.data.examples.map((x: J) => (
                <tr key={x.example_id}>
                  <td className="mono">
                    {x.example_id}
                    {x.edge_case ? <Badge tone="warn">edge</Badge> : null}
                  </td>
                  <td>{x.category ?? ""}</td>
                  <td>{short(x.inputs, 100)}</td>
                  <td>
                    {x.expectations ? (
                      short(x.expectations, 100)
                    ) : (
                      <span className="faint">no ground truth</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ===================================================================== evaluations

function Evaluations(props: { pid: string; base: string }) {
  const d = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/evaluations`);
  useEvents(() => d.reload(), { project: props.pid, types: ["llm.evaluation.updated"] });
  return (
    <section className="card" data-testid="llm-evaluations">
      <div className="row">
        <h2 className="grow">GenAI evaluations</h2>
        <Link to={`${props.base}/llm/evaluations/new`} className="button primary">
          New evaluation
        </Link>
      </div>
      {d.error ? (
        <ErrorBox error={d.error} onRetry={d.reload} />
      ) : !d.data ? (
        <Loading />
      ) : !d.data.evaluations.length ? (
        <Empty>No GenAI evaluations yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>Evaluation</th>
                <th>State</th>
                <th>Golden set</th>
                <th>Targets</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {d.data.evaluations.map((x: J) => (
                <tr key={x.evaluation_id}>
                  <td>
                    <Link to={`${props.base}/llm/evaluations/${x.evaluation_id}`} className="mono">
                      {x.evaluation_id}
                    </Link>
                  </td>
                  <td>
                    <Badge tone={stateTone(x.state)}>{x.state}</Badge>
                  </td>
                  <td>
                    {x.golden_set.name} v{x.golden_set.version}
                  </td>
                  <td>{x.targets.map((t: J) => t.label).join(" vs ")}</td>
                  <td className="faint">{fmtTime(x.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const SCORER_CHOICES = [
  "exact_match",
  "contains_expected",
  "expected_facts",
  "retrieval_recall",
  "has_citation",
];

function TargetRows(props: {
  targets: J[];
  set: (t: J[]) => void;
  providers: J[];
  recorded?: boolean;
}) {
  const upd = (i: number, patch: J) =>
    props.set(props.targets.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  return (
    <>
      {props.targets.map((t, i) => (
        <div key={t.id ?? t.label} className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
          <input
            value={t.label}
            onChange={(x) => upd(i, { label: x.target.value })}
            aria-label={`label ${i + 1}`}
            size={10}
          />
          {t.kind === "recorded" ? (
            <input
              placeholder="MLflow run ID of a job that recorded traces"
              value={t.run_id ?? ""}
              onChange={(x) => upd(i, { run_id: x.target.value.trim() })}
              aria-label={`run ${i + 1}`}
              size={34}
            />
          ) : (
            <>
              <input
                placeholder="prompt@alias or prompt/version"
                value={t.prompt ?? ""}
                onChange={(x) => upd(i, { prompt: x.target.value.trim() })}
                aria-label={`prompt ${i + 1}`}
              />
              <select
                value={`${t.provider_id ?? ""}/${t.model ?? ""}`}
                onChange={(x) => {
                  const [p, ...m] = x.target.value.split("/");
                  upd(i, { provider_id: p, model: m.join("/") });
                }}
                aria-label={`model ${i + 1}`}
              >
                <option value="/">model…</option>
                {props.providers.flatMap((p: J) =>
                  p.models.map((m: string) => (
                    <option key={`${p.provider_id}/${m}`} value={`${p.provider_id}/${m}`}>
                      {p.provider_id}/{m} ({p.locality})
                    </option>
                  )),
                )}
              </select>
              <input
                placeholder="temperature"
                value={t.temperature ?? ""}
                onChange={(x) => upd(i, { temperature: x.target.value })}
                aria-label={`temperature ${i + 1}`}
                size={6}
              />
            </>
          )}
          <button
            type="button"
            className="small"
            onClick={() => props.set(props.targets.filter((_, k) => k !== i))}
            aria-label={`remove ${i + 1}`}
          >
            ✕
          </button>
        </div>
      ))}
    </>
  );
}

function targetBody(t: J): J {
  if (t.kind === "recorded") return { label: t.label, recorded: { run_id: t.run_id } };
  return {
    label: t.label,
    prompt: t.prompt,
    provider_id: t.provider_id,
    model: t.model,
    ...(t.temperature ? { params: { temperature: t.temperature } } : {}),
  };
}

function NewEvaluation(props: { pid: string; base: string }) {
  const gs = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/golden-sets`);
  const st = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/settings`);
  const [golden, setGolden] = useState("");
  const [targets, setTargets] = useState<J[]>([
    { kind: "prompt", label: "a" },
    { kind: "prompt", label: "b" },
  ]);
  const [scorers, setScorers] = useState<string[]>(["exact_match"]);
  const [judge, setJudge] = useState({
    on: false,
    model: "",
    rubric: "Does the answer state the same fact as the reference answer?",
    grounding: false,
  });
  const [maxCalls, setMaxCalls] = useState("500");
  const run = useAction(async () => {
    const [pid, ...m] = judge.model.split("/");
    const body = {
      golden_set: { id: golden },
      targets: targets.map(targetBody),
      scorers: [
        ...scorers.map((s) => ({ name: s, builtin: s })),
        ...(judge.on
          ? [
              {
                name: judge.grounding ? "grounded" : "judge",
                judge: {
                  provider_id: pid,
                  model: m.join("/"),
                  rubric: judge.rubric,
                  uses: judge.grounding ? "grounding" : "answer",
                },
              },
            ]
          : []),
      ],
      max_calls: Number(maxCalls),
    };
    const r = await api<J>(`/api/v1/projects/${e(props.pid)}/llm/evaluations`, { body });
    navigate(`${props.base}/llm/evaluations/${r.evaluation.evaluation_id}`);
  });
  const providers = st.data?.settings.providers ?? [];
  return (
    <section className="card" data-testid="new-llm-evaluation">
      <h2>New GenAI evaluation</h2>
      <p className="muted small">
        Every target runs over the same golden-set version. Prompt aliases are pinned to versions
        when it starts; providers must pass the egress check for dataset rows.
      </p>
      <label className="field">
        Golden set
        <select value={golden} onChange={(x) => setGolden(x.target.value)} aria-label="golden set">
          <option value="">choose…</option>
          {(gs.data?.golden_sets ?? []).map((g: J) => (
            <option key={g.golden_set_id} value={g.golden_set_id}>
              {g.name} v{g.versions.at(-1).version} ({g.versions.at(-1).examples})
              {g.held_out ? " held out" : ""}
            </option>
          ))}
        </select>
      </label>
      <h3>Targets</h3>
      <TargetRows targets={targets} set={setTargets} providers={providers} />
      <div className="row small" style={{ gap: 6 }}>
        <button
          type="button"
          onClick={() =>
            setTargets([
              ...targets,
              { kind: "prompt", label: `v${targets.length + 1}`, id: `t-${Date.now()}` },
            ])
          }
        >
          + prompt/model
        </button>
        <button
          type="button"
          onClick={() =>
            setTargets([
              ...targets,
              { kind: "recorded", label: `rec${targets.length + 1}`, id: `t-${Date.now()}` },
            ])
          }
        >
          + recorded traces of a job
        </button>
      </div>
      <h3>Scorers</h3>
      <div className="row small" style={{ gap: 10, flexWrap: "wrap" }}>
        {SCORER_CHOICES.map((s) => (
          <label key={s} className="row" style={{ gap: 4 }}>
            <input
              type="checkbox"
              checked={scorers.includes(s)}
              onChange={(x) =>
                setScorers(x.target.checked ? [...scorers, s] : scorers.filter((y) => y !== s))
              }
            />{" "}
            {s}
          </label>
        ))}
      </div>
      <div className="card inset small">
        <label className="row" style={{ gap: 4 }}>
          <input
            type="checkbox"
            checked={judge.on}
            onChange={(x) => setJudge({ ...judge, on: x.target.checked })}
            aria-label="use an LLM judge"
          />{" "}
          LLM judge
        </label>
        {judge.on ? (
          <>
            <select
              value={judge.model}
              onChange={(x) => setJudge({ ...judge, model: x.target.value })}
              aria-label="judge model"
            >
              <option value="">judge model…</option>
              {providers.flatMap((p: J) =>
                p.models.map((m: string) => (
                  <option key={`${p.provider_id}/${m}`} value={`${p.provider_id}/${m}`}>
                    {p.provider_id}/{m} ({p.locality})
                  </option>
                )),
              )}
            </select>
            <label className="row" style={{ gap: 4 }}>
              <input
                type="checkbox"
                checked={judge.grounding}
                onChange={(x) => setJudge({ ...judge, grounding: x.target.checked })}
              />{" "}
              judge grounding against retrieved passages
            </label>
            <textarea
              rows={2}
              style={{ width: "100%" }}
              value={judge.rubric}
              onChange={(x) => setJudge({ ...judge, rubric: x.target.value })}
              aria-label="judge rubric"
            />
            <p className="faint">
              The judge model, rubric hash and settings are kept with every verdict.
            </p>
          </>
        ) : null}
      </div>
      <label className="field">
        Call budget (max_calls)
        <input
          type="number"
          value={maxCalls}
          onChange={(x) => setMaxCalls(x.target.value)}
          aria-label="max calls"
        />
      </label>
      <button
        type="button"
        className="primary"
        disabled={!golden || !targets.length || run.busy}
        onClick={() => run.run()}
      >
        Run evaluation
      </button>
      {run.error ? <ErrorBox error={run.error} /> : null}
    </section>
  );
}

function EvaluationDetail(props: { pid: string; base: string; id: string }) {
  const d = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/evaluations/${e(props.id)}`);
  useEvents(() => d.reload(), { project: props.pid, types: ["llm.evaluation.updated"] });
  const ev = d.data?.evaluation;
  const ex = useApi<J>(
    ev?.state === "succeeded"
      ? `/api/v1/projects/${e(props.pid)}/llm/evaluations/${e(props.id)}/examples`
      : undefined,
  );
  const [only, setOnly] = useState<"all" | "failed" | "differs">("all");
  const flag = useAction(async (example_id: string, label: string) => {
    await api(`/api/v1/projects/${e(props.pid)}/llm/evaluations/${e(props.id)}/flag`, {
      body: { example_id, label },
    });
  });
  const report = useAction(async () => {
    const r = await api<J>(
      `/api/v1/projects/${e(props.pid)}/llm/evaluations/${e(props.id)}/report`,
      { body: {} },
    );
    navigate(`${props.base}/knowledge/${r.report.record_id}`);
  });
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!ev) return <Loading />;
  const labels: string[] = ev.targets.map((t: J) => t.label);
  const rows: J[] = (ex.data?.rows ?? []).filter(
    (r: J) => only === "all" || (only === "failed" ? r.failed : r.differs),
  );
  return (
    <div data-testid="llm-evaluation">
      <section className="card">
        <div className="row">
          <h2 className="grow mono">{ev.evaluation_id}</h2>
          <Badge tone={stateTone(ev.state)}>{ev.state}</Badge>
        </div>
        <KV
          rows={[
            [
              "Golden set",
              <Link key="g" to={`${props.base}/llm/golden/${ev.golden_set.golden_set_id}`}>
                {ev.golden_set.name} v{ev.golden_set.version} ({ev.golden_set.examples}) ·{" "}
                {ev.golden_set.sha256.slice(0, 12)}
              </Link>,
            ],
            ["Trials", ev.trials],
            [
              "Data",
              `capture ${ev.retention.capture}, kept ${ev.retention.retention_days} days · sent to ${ev.egress.map((x: J) => `${x.provider_id} (${x.locality}, ${x.purpose})`).join(", ") || "nothing external"}`,
            ],
            [
              "Scorers",
              <span key="s" className="small">
                {ev.scorers.map((s: J) => (
                  <div key={s.name}>
                    <span className="mono">{s.name}</span>{" "}
                    {s.judge ? (
                      <span className="faint">
                        LLM judge {s.judge.provider_id}/{s.judge.model} ({s.judge.locality},{" "}
                        {s.judge.uses}) rubric {s.judge.rubric_sha256.slice(0, 12)}: "
                        {short(s.judge.rubric, 80)}" — an opinion, not ground truth
                      </span>
                    ) : s.project ? (
                      <span className="faint">
                        project {s.project.path}:{s.project.function} (
                        {s.project.sha256.slice(0, 12)})
                      </span>
                    ) : (
                      <span className="faint">built-in {s.builtin}</span>
                    )}
                  </div>
                ))}
              </span>,
            ],
          ]}
        />
        {ev.error ? <div className="banner err small">{ev.error}</div> : null}
        <div className="table-wrap">
          <table className="small" data-testid="llm-eval-targets">
            <thead>
              <tr>
                <th>Target</th>
                <th>What ran</th>
                <th>Metrics</th>
                <th>Tokens</th>
                <th>Latency p50</th>
                <th>Cost</th>
                <th>Run</th>
              </tr>
            </thead>
            <tbody>
              {ev.targets.map((t: J) => {
                const r = ev.results.find((x: J) => x.label === t.label) ?? {};
                return (
                  <tr key={t.label}>
                    <td>
                      <strong>{t.label}</strong>
                    </td>
                    <td>
                      {t.kind === "prompt" ? (
                        <>
                          {t.prompt.name} v{t.prompt.version}
                          {t.prompt.alias ? (
                            <span className="faint"> (@{t.prompt.alias})</span>
                          ) : null}{" "}
                          → {t.provider_id}/{t.model}{" "}
                          <span className="faint mono">{JSON.stringify(t.params)}</span>
                        </>
                      ) : (
                        <>
                          recorded traces of run{" "}
                          <span className="mono">{shortId(t.source_run_id)}</span> ({t.matched})
                        </>
                      )}
                    </td>
                    <td className="mono">
                      {Object.entries(r.metrics ?? {}).map(([k, v]) => (
                        <div key={k}>
                          {k} {String(v)}
                        </div>
                      ))}
                    </td>
                    <td>
                      <Usage u={r.usage} />
                    </td>
                    <td>{r.latency_ms ? `${r.latency_ms.p50} ms` : "—"}</td>
                    <td>
                      <Cost
                        c={r.cost}
                        why={r.usage?.reported === 0 ? "usage not reported" : "no rate configured"}
                      />
                    </td>
                    <td>
                      {r.run_id ? (
                        <Link to={`${props.base}/runs/${r.run_id}`} className="mono">
                          {shortId(r.run_id)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {ev.state === "succeeded" ? (
          <button type="button" disabled={report.busy} onClick={() => report.run()}>
            Generate report
          </button>
        ) : null}
        {report.error ? <ErrorBox error={report.error} /> : null}
      </section>
      {ev.state === "succeeded" ? (
        <section className="card" data-testid="llm-eval-examples">
          <div className="row">
            <h2 className="grow">Per example</h2>
            <select
              value={only}
              onChange={(x) => setOnly(x.target.value as typeof only)}
              aria-label="filter examples"
            >
              <option value="all">all</option>
              <option value="failed">failed</option>
              <option value="differs">outputs differ</option>
            </select>
          </div>
          {ex.error ? (
            <ErrorBox error={ex.error} />
          ) : !ex.data ? (
            <Loading />
          ) : (
            <div className="table-wrap">
              <table className="small">
                <thead>
                  <tr>
                    <th>Example</th>
                    {labels.map((l) => (
                      <th key={l}>{l}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: J) => (
                    <tr key={r.example_id} data-testid={`example-${r.example_id}`}>
                      <td>
                        <div className="mono">{r.example_id}</div>
                        {r.category ? <Badge tone="neutral">{r.category}</Badge> : null}
                        {r.edge_case ? <Badge tone="warn">edge</Badge> : null}
                        <div className="faint">{short(r.inputs, 80)}</div>
                        {r.expectations ? (
                          <div className="faint">
                            expected:{" "}
                            {short(r.expectations.expected_response ?? r.expectations, 80)}
                          </div>
                        ) : r.missing_expectations ? (
                          <div className="warn">no ground truth</div>
                        ) : ex.data.expectations_hidden ? (
                          <div className="faint">expectations hidden (held out)</div>
                        ) : null}
                      </td>
                      {labels.map((l) => {
                        const c = r.cells[l];
                        if (!c)
                          return (
                            <td key={l} className="faint">
                              —
                            </td>
                          );
                        return (
                          <td key={l}>
                            {c.error ? (
                              <div className="err">{short(c.error, 100)}</div>
                            ) : (
                              <div>{short(c.output, 200)}</div>
                            )}
                            <div>
                              {Object.entries(c.scores ?? {}).map(([k, v]: [string, J]) => (
                                <Badge
                                  key={k}
                                  tone={scoreTone(v)}
                                  title={v.error ?? v.rationale ?? ""}
                                >
                                  {k}: {v.error ? "error" : str(v.value)}
                                </Badge>
                              ))}
                              {r.regressions?.[l]?.length ? (
                                <Badge tone="err">regression</Badge>
                              ) : null}
                            </div>
                            <div className="faint">
                              {c.latency_ms ?? "?"} ms ·{" "}
                              {c.usage ? `${c.usage.total_tokens} tok` : "usage not reported"}
                              {c.trace_id ? (
                                <>
                                  {" "}
                                  ·{" "}
                                  <Link
                                    to={`${props.base}/llm/traces/${c.trace_id}`}
                                    className="mono"
                                  >
                                    trace
                                  </Link>
                                </>
                              ) : null}
                              {c.trace_id ? (
                                <>
                                  {" "}
                                  ·{" "}
                                  <button
                                    type="button"
                                    className="link small"
                                    onClick={() => flag.run(r.example_id, l)}
                                  >
                                    flag
                                  </button>
                                </>
                              ) : null}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {flag.error ? <ErrorBox error={flag.error} /> : null}
          <p className="faint small">
            No significance test is computed for scorer feedback; compare example rows. Regressions
            are against the first target.
          </p>
        </section>
      ) : null}
    </div>
  );
}

// ===================================================================== playground

function Playground(props: { pid: string; base: string }) {
  const st = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/settings`);
  const gs = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/golden-sets`);
  const [targets, setTargets] = useState<J[]>([
    { kind: "prompt", label: "a" },
    { kind: "prompt", label: "b" },
  ]);
  const [inputs, setInputs] = useState('[{"question": "How long do refunds take?"}]');
  const [golden, setGolden] = useState("");
  const [res, setRes] = useState<J>();
  const run = useAction(async () => {
    const body = {
      variants: targets.map(targetBody),
      ...(golden ? { golden_set: { id: golden } } : { inputs: JSON.parse(inputs) }),
    };
    const r = await api<J>(`/api/v1/projects/${e(props.pid)}/llm/playground`, { body });
    setRes(r.result);
  });
  const save = useAction(async () => {
    const r = await api<J>(
      `/api/v1/projects/${e(props.pid)}/llm/playground/${res.result_id}/save`,
      { body: {} },
    );
    setRes({ ...res, saved_as: r.evidence.evidence_id });
  });
  return (
    <div data-testid="playground">
      <section className="card">
        <h2>Playground</h2>
        <p className="muted small">
          Run 1–6 variants over the same ordered inputs. Results stay in memory for an hour; each
          call is a trace if the capture policy allows. Save to keep them as evidence (pinned
          prompts only).
        </p>
        <TargetRows
          targets={targets.filter((t) => t.kind === "prompt")}
          set={setTargets}
          providers={st.data?.settings.providers ?? []}
        />
        <button
          type="button"
          className="small"
          onClick={() =>
            setTargets([
              ...targets,
              { kind: "prompt", label: `v${targets.length + 1}`, id: `t-${Date.now()}` },
            ])
          }
        >
          + variant
        </button>
        <div className="row small" style={{ gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <label className="field">
            Golden set
            <select
              value={golden}
              onChange={(x) => setGolden(x.target.value)}
              aria-label="playground golden set"
            >
              <option value="">(typed inputs)</option>
              {(gs.data?.golden_sets ?? []).map((g: J) => (
                <option key={g.golden_set_id} value={g.golden_set_id}>
                  {g.name} v{g.versions.at(-1).version}
                </option>
              ))}
            </select>
          </label>
          {!golden ? (
            <textarea
              rows={3}
              className="grow mono"
              value={inputs}
              onChange={(x) => setInputs(x.target.value)}
              aria-label="playground inputs"
            />
          ) : null}
        </div>
        <button type="button" className="primary" disabled={run.busy} onClick={() => run.run()}>
          Run
        </button>
        {run.error ? <ErrorBox error={run.error} /> : null}
      </section>
      {res ? (
        <section className="card" data-testid="playground-result">
          <div className="row">
            <h2 className="grow mono">{res.result_id}</h2>
            {res.saved_as ? (
              <Badge tone="ok">saved {res.saved_as}</Badge>
            ) : (
              <button type="button" disabled={save.busy} onClick={() => save.run()}>
                Save as evidence
              </button>
            )}
          </div>
          {save.error ? <ErrorBox error={save.error} /> : null}
          <p className="faint small">
            Traces written: {res.traces_written} (capture {res.capture})
          </p>
          <div className="table-wrap">
            <table className="small">
              <thead>
                <tr>
                  <th>Variant</th>
                  <th>What ran</th>
                  <th>Tokens</th>
                  <th>Latency p50</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {res.variants.map((v: J) => (
                  <tr key={v.label}>
                    <td>{v.label}</td>
                    <td>
                      {v.prompt
                        ? `${v.prompt.name} v${v.prompt.version}${v.prompt.alias ? ` (@${v.prompt.alias})` : ""}`
                        : "ad-hoc template"}{" "}
                      → {v.provider_id}/{v.model}
                    </td>
                    <td>
                      <Usage u={res.summary[v.label].usage} />
                    </td>
                    <td>{res.summary[v.label].latency_ms?.p50 ?? "—"} ms</td>
                    <td>
                      <Cost
                        c={res.summary[v.label].cost}
                        why={res.summary[v.label].cost_unavailable}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table className="small">
              <thead>
                <tr>
                  <th>Input</th>
                  {res.variants.map((v: J) => (
                    <th key={v.label}>{v.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {res.rows.map((r: J) => (
                  <tr key={r.example_id}>
                    <td>
                      <div className="mono">{r.example_id}</div>
                      <div className="faint">{short(r.inputs, 80)}</div>
                      {r.expectations ? (
                        <div className="faint">
                          expected: {short(r.expectations.expected_response ?? r.expectations, 60)}
                        </div>
                      ) : null}
                    </td>
                    {res.variants.map((v: J) => {
                      const c = r.cells[v.label];
                      return (
                        <td key={v.label}>
                          {c?.error ? (
                            <span className="err">{short(c.error, 100)}</span>
                          ) : (
                            short(c?.output, 240)
                          )}
                          <div className="faint">
                            {c?.latency_ms} ms
                            {c?.trace_id ? (
                              <>
                                {" "}
                                · <Link to={`${props.base}/llm/traces/${c.trace_id}`}>trace</Link>
                              </>
                            ) : null}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Evidence(props: { pid: string; base: string }) {
  const d = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/evidence`);
  const del = useAction(async (id: string) => {
    await api(`/api/v1/projects/${e(props.pid)}/llm/evidence/${e(id)}`, { method: "DELETE" });
    d.reload();
  });
  return (
    <section className="card" data-testid="llm-evidence">
      <h2>Saved LLM evidence</h2>
      {d.error ? (
        <ErrorBox error={d.error} />
      ) : !d.data ? (
        <Loading />
      ) : !d.data.evidence.length ? (
        <Empty>Nothing saved yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>Evidence</th>
                <th>Title</th>
                <th>Variants</th>
                <th>Stored</th>
                <th>Run</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.data.evidence.map((x: J) => (
                <tr key={x.evidence_id}>
                  <td className="mono">
                    {x.evidence_id}
                    {x.deleted_at ? <Badge tone="neutral">deleted</Badge> : null}
                  </td>
                  <td>{x.title}</td>
                  <td>
                    {x.targets
                      .map((t: J) => `${t.label}: ${t.prompt?.name} v${t.prompt?.version}`)
                      .join(" · ")}
                  </td>
                  <td className="faint">
                    {x.stored.join(", ")} · {x.artifact_bytes} B · {x.trace_ids.length} traces
                  </td>
                  <td className="mono">{shortId(x.mlflow_run_id)}</td>
                  <td>
                    {x.deleted_at ? null : (
                      <button
                        type="button"
                        className="small danger"
                        disabled={del.busy}
                        onClick={() => del.run(x.evidence_id)}
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
      )}
    </section>
  );
}

// ===================================================================== data controls

function DataControls(props: { pid: string; base: string }) {
  const d = useApi<J>(`/api/v1/projects/${e(props.pid)}/llm/settings`);
  const [p, setP] = useState({ provider_id: "", base_url: "", models: "", api_key_env: "" });
  const s = d.data?.settings;
  const strip = (list: J[]) => list.map(({ api_key_present: _a, ...x }: J) => x);
  const put = useAction(async (body: J, widen = false) => {
    if (widen) await api(`/api/v1/projects/${e(props.pid)}/llm/settings/widen`, { body });
    else await api(`/api/v1/projects/${e(props.pid)}/llm/settings`, { method: "PUT", body });
    d.reload();
  });
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!s) return <Loading />;
  const approve = (id: string, datasets: boolean) =>
    put.run(
      {
        providers: strip(s.providers).map((x: J) =>
          x.provider_id === id ? { ...x, egress: { allow_datasets: datasets } } : x,
        ),
      },
      true,
    );
  return (
    <div data-testid="llm-data-controls">
      <section className="card">
        <h2>Trace capture and retention</h2>
        <KV
          rows={[
            [
              "Capture",
              <span key="c">
                <Badge tone="info">{s.capture.mode}</Badge>{" "}
                <span className="faint small">
                  full · redacted · metadata only (no bodies) · off (playground and job traces not
                  written)
                </span>
              </span>,
            ],
            [
              "Redaction",
              [...s.capture.builtin_redactions, ...s.capture.patterns.map((x: J) => x.name)].join(
                ", ",
              ) || "none",
            ],
            [
              "Retention",
              `${s.capture.retention_days} days (older traces are deleted from MLflow; saved evidence is kept until deleted)`,
            ],
            ["Remote capture", s.capture.remote_capture ? "on" : "off"],
            ["Revision", s.revision],
          ]}
        />
        <div className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
          {(["full", "redacted", "metadata_only", "off"] as const).map((m) => {
            const rank = { off: 0, metadata_only: 1, redacted: 2, full: 3 } as const;
            const widen = rank[m] > rank[s.capture.mode as keyof typeof rank];
            return (
              <button
                key={m}
                type="button"
                disabled={m === s.capture.mode || put.busy}
                onClick={() => put.run({ capture: { mode: m } }, widen)}
                title={widen ? "captures more: a widening, recorded in the audit log" : ""}
              >
                {m}
              </button>
            );
          })}
        </div>
      </section>
      <section className="card">
        <h2>Providers and egress</h2>
        <p className="muted small">
          OpenAI-compatible endpoints (vLLM, llama.cpp server, Ollama). Loopback hosts are local.
          External providers need your explicit egress approval; golden-set rows and traces need
          dataset egress too. API keys stay in the coordinator's environment.
        </p>
        {!s.providers.length ? (
          <Empty>No providers configured.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="small">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Endpoint</th>
                  <th>Models</th>
                  <th>Locality</th>
                  <th>Egress</th>
                  <th>Key</th>
                </tr>
              </thead>
              <tbody>
                {s.providers.map((x: J) => (
                  <tr key={x.provider_id}>
                    <td>{x.provider_id}</td>
                    <td className="mono">{x.base_url}</td>
                    <td>{x.models.join(", ")}</td>
                    <td>
                      <Badge tone={x.locality === "local" ? "ok" : "warn"}>{x.locality}</Badge>
                    </td>
                    <td>
                      {x.locality === "local" ? (
                        <span className="faint">not needed</span>
                      ) : x.egress ? (
                        <span>
                          approved {fmtTime(x.egress.approved_at)}
                          {x.egress.allow_datasets ? " (datasets)" : " (ad-hoc inputs only)"}
                          {!x.egress.allow_datasets ? (
                            <button
                              type="button"
                              className="small"
                              onClick={() => approve(x.provider_id, true)}
                            >
                              allow datasets
                            </button>
                          ) : null}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="small"
                          onClick={() => approve(x.provider_id, false)}
                        >
                          approve egress
                        </button>
                      )}
                    </td>
                    <td>
                      {x.api_key_env ? (
                        <span className="mono">
                          ${x.api_key_env}
                          {x.api_key_present ? "" : " (not set)"}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
          <input
            placeholder="id"
            value={p.provider_id}
            onChange={(x) => setP({ ...p, provider_id: x.target.value })}
            aria-label="provider id"
            size={10}
          />
          <input
            placeholder="http://127.0.0.1:11434/v1"
            value={p.base_url}
            onChange={(x) => setP({ ...p, base_url: x.target.value })}
            aria-label="provider url"
            size={28}
          />
          <input
            placeholder="models (comma-separated)"
            value={p.models}
            onChange={(x) => setP({ ...p, models: x.target.value })}
            aria-label="provider models"
          />
          <input
            placeholder="API key env var (optional)"
            value={p.api_key_env}
            onChange={(x) => setP({ ...p, api_key_env: x.target.value })}
            aria-label="provider key env"
          />
          <button
            type="button"
            className="primary"
            disabled={!p.provider_id || !p.base_url || !p.models || put.busy}
            onClick={() =>
              put.run(
                {
                  providers: [
                    ...strip(s.providers),
                    {
                      provider_id: p.provider_id,
                      base_url: p.base_url,
                      models: p.models
                        .split(",")
                        .map((m) => m.trim())
                        .filter(Boolean),
                      ...(p.api_key_env ? { api_key_env: p.api_key_env } : {}),
                    },
                  ],
                },
                !!p.api_key_env,
              )
            }
          >
            Add provider
          </button>
        </div>
        {put.error ? <ErrorBox error={put.error} /> : null}
      </section>
    </div>
  );
}
