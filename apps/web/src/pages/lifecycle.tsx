/**
 * Model lifecycle pages (spec §5.6 Datasets, Evaluations, Logged Models, Registry, Project
 * Entrypoints; criteria 5-8; ADR 0019). Everything here reads AblationKit's typed API; MLflow is
 * never linked or framed. Model files are downloads only, with the trust note shown first.
 */
import { type ReactNode, useState } from "react";
import { api, qs, useApi, useEvents } from "../api.ts";
import { LineageStrip } from "../components/Lineage.tsx";
import {
  Badge,
  Empty,
  ErrorBox,
  KV,
  Link,
  Loading,
  Modal,
  Tabs,
  type Tone,
  useAction,
} from "../components/ui.tsx";
import { fmtBytes, fmtNum, fmtTime, shortId } from "../lib/format.ts";
import { modelsTabs } from "../nav.ts";
import { navigate, useLocation } from "../router.ts";
import { ExtensionMounts } from "./extensions.tsx";
import { InferencePage } from "./inference.tsx";

// biome-ignore lint/suspicious/noExplicitAny: API JSON shaped by the coordinator
type J = any;
const e = encodeURIComponent;

function evalTone(state: string, passed?: boolean): Tone {
  if (state === "succeeded") return passed === false ? "warn" : "ok";
  if (state === "running" || state === "queued") return "info";
  if (state === "canceled" || state === "interrupted") return "neutral";
  return "err";
}

function EvalBadge(props: { state: string; passed?: boolean }) {
  return (
    <Badge tone={evalTone(props.state, props.passed)}>
      {props.state === "succeeded" && props.passed !== undefined
        ? props.passed
          ? "thresholds passed"
          : "thresholds failed"
        : props.state}
    </Badge>
  );
}

function Json(props: { value: unknown }) {
  return <pre className="small mono pre-wrap">{JSON.stringify(props.value, null, 2)}</pre>;
}

// ===================================================================== Data & Evals

const DATA_TABS = [
  { id: "datasets", label: "Datasets", path: "/data" },
  { id: "evaluations", label: "Evaluations", path: "/data/evaluations" },
] as const;

export function DataRouter(props: { pid: string; base: string; rest: string }) {
  const parts = props.rest.split("/").filter(Boolean);
  const head = parts[0] ?? "";
  const active = head === "evaluations" ? "evaluations" : "datasets";
  let body: ReactNode;
  if (head === "evaluations" && parts[1] === "new")
    body = <NewEvaluation pid={props.pid} base={props.base} />;
  else if (head === "evaluations" && parts[1])
    body = <EvaluationDetail pid={props.pid} base={props.base} id={decodeURIComponent(parts[1])} />;
  else if (head === "evaluations") body = <Evaluations pid={props.pid} base={props.base} />;
  else body = <Datasets pid={props.pid} base={props.base} />;
  return (
    <>
      <Tabs
        items={DATA_TABS.map((t) => ({ id: t.id, label: t.label, to: `${props.base}${t.path}` }))}
        active={active}
      />
      {body}
      <p className="faint small">
        GenAI evaluations and golden sets are in{" "}
        <Link to={`${props.base}/llm/evaluations`}>LLM → Evaluations</Link> and{" "}
        <Link to={`${props.base}/llm/golden`}>LLM → Golden sets</Link>.
      </p>
    </>
  );
}

function Datasets(props: { pid: string; base: string }) {
  const d = useApi<{ datasets: J[]; scanned_runs: number; truncated: boolean }>(
    `/api/v1/projects/${e(props.pid)}/datasets`,
  );
  useEvents(() => d.reload(), {
    project: props.pid,
    types: ["tracking.run.sync", "model.logged", "evaluation.updated"],
  });
  const groups = new Map<string, J[]>();
  for (const x of d.data?.datasets ?? []) groups.set(x.name, [...(groups.get(x.name) ?? []), x]);
  return (
    <section className="card" data-testid="datasets">
      <h2>Datasets</h2>
      <p className="muted small">
        Dataset inputs recorded on this project's MLflow runs (SDK <code>log_input</code>, or
        MLflow-native logging), grouped by name; each digest is a version. Roles and splits come
        from the input's tags.
      </p>
      <ErrorBox error={d.error} onRetry={d.reload} />
      {d.loading && !d.data ? <Loading /> : null}
      {d.data && groups.size === 0 ? (
        <Empty>
          No dataset inputs yet. Record one from a job with{" "}
          <code>ablationkit_sdk.log_input("name", source=…, path=…, split="train")</code>.
        </Empty>
      ) : null}
      {d.data?.truncated ? (
        <div className="banner warn">Only the newest {d.data.scanned_runs} runs were scanned.</div>
      ) : null}
      {[...groups].map(([name, versions]) => (
        <div key={name} className="stack" data-testid="dataset">
          <h3>
            {name} <span className="faint small">{versions.length} version(s)</span>
          </h3>
          {versions.map((v) => (
            <div key={v.digest} className="card inset">
              <KV
                rows={[
                  [
                    "digest",
                    <span key="d" className="mono">
                      {v.digest}
                    </span>,
                  ],
                  ["source", `${v.source_type}: ${v.source ?? "—"}`],
                  [
                    "fingerprint",
                    v.uses[0]?.fingerprint ? (
                      <span key="f" className="mono small">
                        sha256 {v.uses[0].fingerprint}
                      </span>
                    ) : (
                      "not reported"
                    ),
                  ],
                  ["profile", v.profile ? <code key="p">{JSON.stringify(v.profile)}</code> : "—"],
                  [
                    "schema",
                    v.schema?.mlflow_colspec ? (
                      <span key="s" className="small">
                        {v.schema.mlflow_colspec.map((c: J) => `${c.name}: ${c.type}`).join(", ")}
                      </span>
                    ) : (
                      "—"
                    ),
                  ],
                  [
                    "models",
                    v.models.length ? (
                      <span key="m">
                        {v.models.map((m: J) => (
                          <span key={m.model_id + m.relation}>
                            <Link to={`${props.base}/models/m/${e(m.model_id)}`}>
                              {shortId(m.model_id, 12)}
                            </Link>{" "}
                            <span className="faint">
                              ({m.relation}
                              {m.registered ? ` · ${m.registered}` : ""})
                            </span>{" "}
                          </span>
                        ))}
                      </span>
                    ) : (
                      "—"
                    ),
                  ],
                ]}
              />
              <div className="table-wrap">
                <table className="small">
                  <thead>
                    <tr>
                      <th>role</th>
                      <th>split</th>
                      <th>version</th>
                      <th>run</th>
                      <th>job / evaluation</th>
                      <th>source commit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.uses.map((u: J) => (
                      <tr key={u.run_id + (u.context ?? "") + (u.split ?? "")}>
                        <td>{u.context ?? "—"}</td>
                        <td>{u.split ?? "—"}</td>
                        <td>{u.version ?? "—"}</td>
                        <td>
                          <Link to={`${props.base}/runs/r/${e(u.run_id)}`}>
                            {u.run_name ?? shortId(u.run_id)}
                          </Link>
                        </td>
                        <td>
                          {u.job_id ? (
                            <Link to={`${props.base}/runs/jobs/${e(u.job_id)}`}>
                              {shortId(u.job_id, 14)}
                            </Link>
                          ) : null}
                          {u.evaluation_id ? (
                            <Link to={`${props.base}/data/evaluations/${e(u.evaluation_id)}`}>
                              {u.evaluation_id}
                            </Link>
                          ) : null}
                          {!u.job_id && !u.evaluation_id ? "—" : null}
                        </td>
                        <td className="mono">
                          {u.source_commit ? u.source_commit.slice(0, 12) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function Evaluations(props: { pid: string; base: string }) {
  const list = useApi<{ evaluations: J[] }>(`/api/v1/projects/${e(props.pid)}/evaluations`);
  useEvents(() => list.reload(), { project: props.pid, types: ["evaluation.updated"] });
  return (
    <section className="card" data-testid="evaluations">
      <div className="row">
        <h2 className="grow">Classical evaluations</h2>
        <button
          type="button"
          className="primary"
          onClick={() => navigate(`${props.base}/data/evaluations/new`)}
        >
          New evaluation
        </button>
      </div>
      <p className="muted small">
        <code>mlflow.models.evaluate</code> for classifiers and regressors, run in an isolated
        worker; metrics, plots and tables are saved in MLflow.
      </p>
      <ErrorBox error={list.error} />
      {list.data?.evaluations.length === 0 ? <Empty>No evaluations yet.</Empty> : null}
      {list.data?.evaluations.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>evaluation</th>
                <th>status</th>
                <th>type</th>
                <th>model</th>
                <th>dataset</th>
                <th>created</th>
              </tr>
            </thead>
            <tbody>
              {list.data.evaluations.map((v) => (
                <tr key={v.evaluation_id}>
                  <td>
                    <Link to={`${props.base}/data/evaluations/${e(v.evaluation_id)}`}>
                      {v.evaluation_id}
                    </Link>
                  </td>
                  <td>
                    <EvalBadge state={v.state} passed={v.validation?.passed} />
                  </td>
                  <td>{v.model_type}</td>
                  <td className="small">
                    {v.model.registered_name
                      ? `${v.model.registered_name} v${v.model.version}`
                      : shortId(v.model.model_id, 12)}
                    {v.baseline ? <span className="faint"> vs baseline</span> : null}
                  </td>
                  <td className="small">{v.dataset.path}</td>
                  <td className="small faint">{fmtTime(v.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

interface ThresholdRow {
  key: number;
  metric: string;
  dir: ">=" | "<=";
  threshold: string;
  abs: string;
  rel: string;
}

export function ModelPicker(props: {
  pid: string;
  label: string;
  value: J;
  onChange: (v: J) => void;
  optional?: boolean;
}) {
  const models = useApi<{ models: J[] }>(`/api/v1/projects/${e(props.pid)}/models`);
  const reg = useApi<{ registered_models: J[] }>(`/api/v1/projects/${e(props.pid)}/registry`);
  const kind: string = props.value?.kind ?? (props.optional ? "none" : "registry");
  const detail = useApi<{ registered_model: J }>(
    kind === "registry" && props.value?.name
      ? `/api/v1/projects/${e(props.pid)}/registry/${e(props.value.name)}`
      : undefined,
  );
  const rm = detail.data?.registered_model;
  return (
    <fieldset className="card inset">
      <legend>{props.label}</legend>
      <div className="row">
        <label className="field">
          Source
          <select
            value={kind}
            onChange={(ev) => props.onChange({ kind: ev.target.value })}
            aria-label={`${props.label} source`}
          >
            {props.optional ? <option value="none">none</option> : null}
            <option value="registry">registered model</option>
            <option value="logged">logged model</option>
          </select>
        </label>
        {kind === "registry" ? (
          <>
            <label className="field">
              Registered model
              <select
                value={props.value?.name ?? ""}
                onChange={(ev) => props.onChange({ kind, name: ev.target.value })}
                aria-label={`${props.label} registered model`}
              >
                <option value="">choose…</option>
                {(reg.data?.registered_models ?? []).map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Version or alias
              <select
                value={props.value?.pick ?? ""}
                onChange={(ev) => props.onChange({ ...props.value, pick: ev.target.value })}
                aria-label={`${props.label} version`}
              >
                <option value="">choose…</option>
                {(rm?.aliases ?? []).map((a: J) => (
                  <option key={`a:${a.alias}`} value={`a:${a.alias}`}>
                    @{a.alias} (v{a.version})
                  </option>
                ))}
                {(rm?.versions ?? []).map((v: J) => (
                  <option key={`v:${v.version}`} value={`v:${v.version}`}>
                    v{v.version}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : kind === "logged" ? (
          <label className="field grow">
            Logged model
            <select
              value={props.value?.model_id ?? ""}
              onChange={(ev) => props.onChange({ kind, model_id: ev.target.value })}
              aria-label={`${props.label} logged model`}
            >
              <option value="">choose…</option>
              {(models.data?.models ?? [])
                .filter((m) => m.status === "LOGGED_MODEL_READY")
                .map((m) => (
                  <option key={m.model_id} value={m.model_id}>
                    {m.name} · {m.model_id}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
      </div>
      {kind === "registry" && props.value?.pick?.startsWith("a:") ? (
        <p className="faint small">
          The alias is resolved to its version when the evaluation starts, and pinned.
        </p>
      ) : null}
    </fieldset>
  );
}

export function selectorOf(v: J): J | undefined {
  if (!v || v.kind === "none") return undefined;
  if (v.kind === "logged") return v.model_id ? { model_id: v.model_id } : undefined;
  if (!v.name || !v.pick) return undefined;
  return v.pick.startsWith("a:")
    ? { name: v.name, alias: v.pick.slice(2) }
    : { name: v.name, version: v.pick.slice(2) };
}

function NewEvaluation(props: { pid: string; base: string }) {
  const [modelType, setModelType] = useState("classifier");
  const [model, setModel] = useState<J>({ kind: "registry" });
  const [baseline, setBaseline] = useState<J>({ kind: "none" });
  const [path, setPath] = useState("");
  const [targets, setTargets] = useState("");
  const [split, setSplit] = useState("");
  const [rows, setRows] = useState<ThresholdRow[]>([]);
  const launch = useAction(async () => {
    const m = selectorOf(model);
    if (!m) throw new Error("choose a model and a version or alias");
    const b = selectorOf(baseline);
    const thresholds = rows
      .filter((r) => r.metric.trim())
      .map((r) => ({
        metric: r.metric.trim(),
        greater_is_better: r.dir === ">=",
        ...(r.threshold.trim() ? { threshold: r.threshold.trim() } : {}),
        ...(r.abs.trim() ? { min_absolute_change: r.abs.trim() } : {}),
        ...(r.rel.trim() ? { min_relative_change: r.rel.trim() } : {}),
      }));
    const r = await api<{ evaluation: J }>(`/api/v1/projects/${e(props.pid)}/evaluations`, {
      body: {
        model_type: modelType,
        model: m,
        ...(b ? { baseline: b } : {}),
        dataset: { path, targets, ...(split ? { split } : {}) },
        thresholds,
      },
    });
    navigate(`${props.base}/data/evaluations/${e(r.evaluation.evaluation_id)}`);
  });
  const setRow = (i: number, patch: Partial<ThresholdRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <section className="card" data-testid="new-evaluation">
      <h2>New classical evaluation</h2>
      <div className="row">
        <label className="field">
          Model type
          <select
            value={modelType}
            onChange={(ev) => setModelType(ev.target.value)}
            aria-label="Model type"
          >
            <option value="classifier">classifier</option>
            <option value="regressor">regressor</option>
          </select>
        </label>
      </div>
      <ModelPicker pid={props.pid} label="Model" value={model} onChange={setModel} />
      <ModelPicker
        pid={props.pid}
        label="Baseline (optional)"
        value={baseline}
        onChange={setBaseline}
        optional
      />
      <div className="row">
        <label className="field grow">
          Dataset file (in the checkout: .csv, .parquet, .jsonl)
          <input
            value={path}
            onChange={(ev) => setPath(ev.target.value)}
            placeholder="data/test.csv"
            aria-label="Dataset path"
          />
        </label>
        <label className="field">
          Target column
          <input
            value={targets}
            onChange={(ev) => setTargets(ev.target.value)}
            placeholder="label"
            aria-label="Target column"
          />
        </label>
        <label className="field">
          Split (optional)
          <input
            value={split}
            onChange={(ev) => setSplit(ev.target.value)}
            placeholder="test"
            aria-label="Split"
          />
        </label>
      </div>
      <h3>Validation thresholds</h3>
      <p className="faint small">
        MLflow <code>MetricThreshold</code>: a value threshold, and change thresholds against the
        baseline.
      </p>
      {rows.map((r, i) => (
        <div key={r.key} className="row">
          <input
            value={r.metric}
            placeholder="accuracy_score"
            aria-label="Threshold metric"
            onChange={(ev) => setRow(i, { metric: ev.target.value })}
          />
          <select
            value={r.dir}
            aria-label="Better direction"
            onChange={(ev) => setRow(i, { dir: ev.target.value as ">=" | "<=" })}
          >
            <option value=">=">higher is better (≥)</option>
            <option value="<=">lower is better (≤)</option>
          </select>
          <input
            value={r.threshold}
            placeholder="threshold"
            aria-label="Threshold value"
            onChange={(ev) => setRow(i, { threshold: ev.target.value })}
          />
          <input
            value={r.abs}
            placeholder="min abs. change"
            aria-label="Minimum absolute change"
            onChange={(ev) => setRow(i, { abs: ev.target.value })}
          />
          <input
            value={r.rel}
            placeholder="min rel. change"
            aria-label="Minimum relative change"
            onChange={(ev) => setRow(i, { rel: ev.target.value })}
          />
          <button
            type="button"
            className="small"
            onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="small"
        onClick={() =>
          setRows((rs) => [
            ...rs,
            { key: Date.now() + rs.length, metric: "", dir: ">=", threshold: "", abs: "", rel: "" },
          ])
        }
      >
        Add threshold
      </button>
      <ErrorBox error={launch.error} />
      <div className="row end">
        <button type="button" onClick={() => navigate(`${props.base}/data/evaluations`)}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={launch.busy || !path || !targets}
          onClick={() => void launch.run()}
        >
          {launch.busy ? "Starting…" : "Run evaluation"}
        </button>
      </div>
    </section>
  );
}

/** Batch evaluation: paired example-level results (the candidate run's ablationkit/examples.json). */
function ExamplesCard(props: { pid: string; id: string; ex: J }) {
  const x = props.ex;
  const [rows, setRows] = useState<J[]>();
  const load = useAction(async () => {
    const r = await api<J>(`/api/v1/projects/${e(props.pid)}/evaluations/${e(props.id)}/examples`);
    setRows(r.rows);
  });
  return (
    <section className="card" data-testid="eval-examples">
      <h2>Examples</h2>
      <p className="small">
        {x.rows} rows{x.paired ? ", candidate and baseline paired on the same ordered rows" : ""}.
      </p>
      {x.model_type === "classifier" ? (
        <KV
          rows={[
            ["candidate correct", String(x.candidate_correct ?? "—")],
            ...(x.paired
              ? ([
                  ["baseline correct", String(x.baseline_correct)],
                  [
                    "both / only candidate / only baseline / neither",
                    `${x.both_correct} / ${x.only_candidate_correct} / ${x.only_baseline_correct} / ${x.both_wrong}`,
                  ],
                  ["disagreements", String(x.disagreements)],
                ] as [string, string][])
              : []),
          ]}
        />
      ) : (
        <KV
          rows={[
            ["candidate MAE", x.candidate_mae ?? "—"],
            ...(x.paired
              ? ([
                  ["baseline MAE", x.baseline_mae],
                  ["rows where candidate is better", String(x.candidate_better_rows)],
                ] as [string, string][])
              : []),
          ]}
        />
      )}
      {x.paired_test ? (
        <p className="small" data-testid="eval-paired-test">
          {x.paired_test.method}: p = {x.paired_test.p_value} on {x.paired_test.discordant}{" "}
          discordant rows. Assumes: {x.paired_test.assumptions}.
        </p>
      ) : x.paired_test_note ? (
        <p className="small faint">{x.paired_test_note}</p>
      ) : null}
      <button type="button" className="small" onClick={() => void load.run()} disabled={load.busy}>
        Show failing and disagreeing rows ({x.listed})
      </button>
      <ErrorBox error={load.error} />
      {rows ? (
        <div className="table-wrap">
          <table className="small" data-testid="eval-example-rows">
            <thead>
              <tr>
                <th>row</th>
                <th>target</th>
                <th>candidate</th>
                {x.paired ? <th>baseline</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.row}>
                  <td>{r.row}</td>
                  <td>{String(r.target)}</td>
                  <td className={String(r.candidate) !== String(r.target) ? "err" : ""}>
                    {String(r.candidate)}
                    {r.candidate_abs_error !== undefined ? ` (|e| ${r.candidate_abs_error})` : ""}
                  </td>
                  {x.paired ? (
                    <td className={String(r.baseline) !== String(r.target) ? "err" : ""}>
                      {String(r.baseline)}
                      {r.baseline_abs_error !== undefined ? ` (|e| ${r.baseline_abs_error})` : ""}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function EvaluationDetail(props: { pid: string; base: string; id: string }) {
  const v = useApi<J>(`/api/v1/projects/${e(props.pid)}/evaluations/${e(props.id)}`);
  useEvents(() => v.reload(), { project: props.pid, types: ["evaluation.updated"] });
  const [log, setLog] = useState<string>();
  const cancel = useAction(async () => {
    await api(`/api/v1/projects/${e(props.pid)}/evaluations/${e(props.id)}/cancel`, { body: {} });
    v.reload();
  });
  if (v.error) return <ErrorBox error={v.error} onRetry={v.reload} />;
  if (!v.data) return <Loading />;
  const ev = v.data.evaluation;
  const cand = v.data.candidate;
  const base = v.data.baseline;
  const metricKeys = Object.keys(cand?.metrics ?? {}).sort();
  const images = (cand?.artifacts ?? []).filter((a: J) => /\.(png|jpe?g|gif)$/i.test(a.path));
  const tables = (cand?.artifacts ?? []).filter((a: J) => /\.(csv|json)$/i.test(a.path));
  const modelLabel = (m: J) =>
    m.registered_name
      ? `${m.registered_name} v${m.version}${m.alias ? ` (@${m.alias} at launch)` : ""}`
      : m.model_id;
  return (
    <div data-testid="evaluation-detail">
      <LineageStrip pid={props.pid} kind="evaluation" id={props.id} base={props.base} />
      <div className="grid2">
        <section className="card">
          <div className="row">
            <h2 className="grow">{ev.evaluation_id}</h2>
            <EvalBadge state={ev.state} passed={ev.validation?.passed} />
            {ev.state === "running" || ev.state === "queued" ? (
              <button
                type="button"
                className="small"
                disabled={cancel.busy}
                onClick={() => void cancel.run()}
              >
                Cancel
              </button>
            ) : null}
          </div>
          <ErrorBox error={cancel.error} />
          {ev.error ? <div className="banner err small">{ev.error}</div> : null}
          <KV
            rows={[
              ["type", ev.model_type],
              [
                "model",
                <Link key="m" to={`${props.base}/models/m/${e(ev.model.model_id)}`}>
                  {modelLabel(ev.model)}
                </Link>,
              ],
              [
                "baseline",
                ev.baseline ? (
                  <Link key="b" to={`${props.base}/models/m/${e(ev.baseline.model_id)}`}>
                    {modelLabel(ev.baseline)}
                  </Link>
                ) : (
                  "—"
                ),
              ],
              [
                "dataset",
                `${ev.dataset.path} · target ${ev.dataset.targets}${ev.dataset.split ? ` · split ${ev.dataset.split}` : ""}`,
              ],
              [
                "dataset sha256",
                <span key="s" className="mono small">
                  {ev.dataset.sha256}
                </span>,
              ],
              [
                "source commit",
                ev.dataset.source_commit ? ev.dataset.source_commit.slice(0, 12) : "—",
              ],
              [
                "MLflow run",
                ev.mlflow_run_id ? (
                  <Link key="r" to={`${props.base}/runs/r/${e(ev.mlflow_run_id)}`}>
                    {ev.mlflow_run_id}
                  </Link>
                ) : (
                  "—"
                ),
              ],
              [
                "worker",
                `${ev.environment} environment · limits ${ev.enforcement ?? "pending"} · timeout ${ev.limits.timeout_sec}s`,
              ],
              ["started", fmtTime(ev.started_at)],
              ["ended", fmtTime(ev.ended_at)],
            ]}
          />
          <button
            type="button"
            className="link small"
            onClick={() =>
              void fetch(`/api/v1/projects/${e(props.pid)}/evaluations/${e(props.id)}/log`, {
                credentials: "same-origin",
              })
                .then((r) => r.text())
                .then(setLog)
            }
          >
            Show worker log
          </button>
          {log !== undefined ? (
            <pre className="small mono pre-wrap console-box">{log || "(empty)"}</pre>
          ) : null}
        </section>
        {ev.examples ? <ExamplesCard pid={props.pid} id={props.id} ex={ev.examples} /> : null}
        <section className="card" data-testid="thresholds">
          <h2>Thresholds</h2>
          {!ev.thresholds.length ? (
            <p className="muted small">No validation thresholds were set.</p>
          ) : null}
          {ev.thresholds.length && !ev.validation ? (
            <p className="muted small">Not evaluated yet.</p>
          ) : null}
          {ev.validation ? (
            <>
              <p>
                <Badge tone={ev.validation.passed ? "ok" : "err"}>
                  {ev.validation.passed ? "passed" : "failed"}
                </Badge>{" "}
                <span className="faint small">MLflow verdict: {ev.validation.mlflow_verdict}</span>
              </p>
              <div className="table-wrap">
                <table className="small">
                  <thead>
                    <tr>
                      <th>metric</th>
                      <th>result</th>
                      <th>candidate</th>
                      <th>baseline</th>
                      <th>rule</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ev.validation.outcomes.map((o: J) => {
                      const t = ev.thresholds.find((x: J) => x.metric === o.metric) ?? {};
                      const op = t.greater_is_better ? "≥" : "≤";
                      return (
                        <tr key={o.metric}>
                          <td>{o.metric}</td>
                          <td>
                            <Badge tone={o.passed ? "ok" : "err"}>
                              {o.passed ? "pass" : "fail"}
                            </Badge>
                          </td>
                          <td className="mono">
                            {o.candidate ? fmtNum(Number(o.candidate)) : "missing"}
                          </td>
                          <td className="mono">{o.baseline ? fmtNum(Number(o.baseline)) : "—"}</td>
                          <td className="small">
                            {t.threshold !== undefined ? `${op} ${t.threshold}` : ""}
                            {t.min_absolute_change !== undefined
                              ? ` · Δ ${op} ${t.min_absolute_change}`
                              : ""}
                            {t.min_relative_change !== undefined
                              ? ` · Δ% ${op} ${Number(t.min_relative_change) * 100}%`
                              : ""}
                            {o.failures.length ? (
                              <div className="faint">{o.failures.join(" ")}</div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      </div>
      <section className="card" data-testid="eval-metrics">
        <h2>Metrics</h2>
        {cand?.unavailable ? (
          <div className="banner warn">MLflow is unavailable: {cand.unavailable}</div>
        ) : null}
        {metricKeys.length === 0 ? <p className="muted small">No metrics yet.</p> : null}
        {metricKeys.length ? (
          <div className="table-wrap">
            <table className="small">
              <thead>
                <tr>
                  <th>metric</th>
                  <th>candidate</th>
                  {base ? <th>baseline</th> : null}
                  {base ? <th>difference</th> : null}
                </tr>
              </thead>
              <tbody>
                {metricKeys.map((k) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="mono">{fmtNum(cand.metrics[k])}</td>
                    {base ? <td className="mono">{fmtNum(base.metrics?.[k])}</td> : null}
                    {base ? (
                      <td className="mono">
                        {base.metrics?.[k] !== undefined
                          ? fmtNum(cand.metrics[k] - base.metrics[k])
                          : "—"}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="faint small">
          Single evaluation on one dataset: no uncertainty estimate is implied.
        </p>
      </section>
      {images.length ? (
        <section className="card" data-testid="eval-plots">
          <h2>Diagnostic plots</h2>
          <div className="plot-grid">
            {images.map((a: J) => (
              <figure key={a.path}>
                <img
                  className="preview-img"
                  alt={a.path}
                  src={`/api/v1/tracking/runs/${e(ev.mlflow_run_id)}/artifacts/download${qs({ path: a.path })}`}
                />
                <figcaption className="small faint">{a.path}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}
      {tables.length ? (
        <section className="card">
          <h2>Tables</h2>
          {tables.map((a: J) => (
            <div key={a.path} className="row small">
              <a
                href={`/api/v1/tracking/runs/${e(ev.mlflow_run_id)}/artifacts/download${qs({ path: a.path })}`}
              >
                {a.path}
              </a>
              <span className="faint">{fmtBytes(a.file_size)}</span>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

// ========================================================================= Models

export function ModelsRouter(props: { pid: string; base: string; rest: string }) {
  const models = useApi<{ models: J[] }>(`/api/v1/projects/${e(props.pid)}/models`);
  useEvents(() => models.reload(), { project: props.pid, types: ["model.logged"] });
  const has = (models.data?.models.length ?? 0) > 0;
  const tabs = modelsTabs(has);
  const to = (t: { id: string; label: string; path: string }) => ({
    id: t.id,
    label: t.label,
    to: `${props.base}${t.path}`,
  });
  const parts = props.rest.split("/").filter(Boolean);
  const head = parts[0] ?? "";
  const active = head === "" || head === "m" ? "logged" : head;
  let body: ReactNode;
  if (head === "m" && parts[1])
    body = <ModelDetail pid={props.pid} base={props.base} id={decodeURIComponent(parts[1])} />;
  else if (head === "registry" && parts[1])
    body = <RegistryDetail pid={props.pid} base={props.base} name={decodeURIComponent(parts[1])} />;
  else if (head === "registry") body = <Registry pid={props.pid} base={props.base} />;
  else if (head === "inference")
    body = <InferencePage pid={props.pid} base={props.base} rest={props.rest} />;
  else if (head === "demos")
    body = (
      <section className="card" data-testid="demos">
        <h2>Demos</h2>
        <p className="muted small">
          Interactive model demos are project extensions (<code>model.demo</code>). Each runs in a
          sandboxed frame and predicts only through allowlisted models within its quota; saving a
          result asks you first. Manage them in Project settings → Extensions.
        </p>
        <ExtensionMounts
          pid={props.pid}
          point="model.demo"
          empty={<Empty>No approved demos in this project.</Empty>}
        />
      </section>
    );
  else
    body = (
      <section className="card" data-testid="logged-models">
        <h2>Logged models</h2>
        <ErrorBox error={models.error} onRetry={models.reload} />
        {models.loading && !models.data ? <Loading /> : null}
        {models.data && !has ? (
          <Empty>
            No logged models yet. Save a model with <code>mlflow.&lt;flavor&gt;.save_model</code>{" "}
            and report it with <code>ablationkit_sdk.log_model(dir, name)</code>. Registry,
            Inference and Demos stay under “More” until the project logs one.
          </Empty>
        ) : null}
        {has ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>name</th>
                  <th>model ID</th>
                  <th>status</th>
                  <th>source run</th>
                  <th>created</th>
                </tr>
              </thead>
              <tbody>
                {models.data?.models.map((m) => (
                  <tr key={m.model_id}>
                    <td>
                      <Link to={`${props.base}/models/m/${e(m.model_id)}`}>{m.name}</Link>
                      {m.read_only ? <span className="faint small"> (imported)</span> : null}
                    </td>
                    <td className="mono small">{m.model_id}</td>
                    <td>
                      <Badge
                        tone={
                          m.status === "LOGGED_MODEL_READY"
                            ? "ok"
                            : m.status === "LOGGED_MODEL_PENDING"
                              ? "info"
                              : "err"
                        }
                      >
                        {String(m.status).replace("LOGGED_MODEL_", "").toLowerCase()}
                      </Badge>
                    </td>
                    <td>
                      {m.source_run_id ? (
                        <Link to={`${props.base}/runs/r/${e(m.source_run_id)}`}>
                          {shortId(m.source_run_id)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="small faint">{fmtTime(m.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    );
  return (
    <>
      <Tabs items={tabs.primary.map(to)} more={tabs.more.map(to)} active={active} />
      {body}
    </>
  );
}

function ModelDetail(props: { pid: string; base: string; id: string }) {
  const d = useApi<J>(`/api/v1/projects/${e(props.pid)}/models/${e(props.id)}`);
  useEvents(() => d.reload(), {
    project: props.pid,
    types: ["registry.version.created", "registry.alias.set", "evaluation.updated"],
  });
  const [register, setRegister] = useState(false);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const m = d.data;
  const dl = (path: string) =>
    `/api/v1/projects/${e(props.pid)}/models/${e(props.id)}/artifacts/download${qs({ path })}`;
  return (
    <div data-testid="model-detail">
      <LineageStrip pid={props.pid} kind="logged_model" id={props.id} base={props.base} />
      <div className="grid2">
        <div>
          <section className="card">
            <div className="row">
              <h2 className="grow">{m.model.name}</h2>
              {m.model.status === "LOGGED_MODEL_READY" && !m.model.read_only ? (
                <button type="button" className="primary" onClick={() => setRegister(true)}>
                  Register
                </button>
              ) : null}
            </div>
            <KV
              rows={[
                [
                  "logged model ID",
                  <span key="i" className="mono">
                    {m.model.model_id}
                  </span>,
                ],
                ["status", String(m.model.status).replace("LOGGED_MODEL_", "").toLowerCase()],
                ["model type", m.model.model_type ?? "—"],
                [
                  "source run",
                  m.source_run ? (
                    <Link key="r" to={`${props.base}/runs/r/${e(m.source_run.run_id)}`}>
                      {m.source_run.run_name ?? m.source_run.run_id}
                    </Link>
                  ) : (
                    "—"
                  ),
                ],
                [
                  "job",
                  m.source_run?.job_id ? (
                    <Link key="j" to={`${props.base}/runs/jobs/${e(m.source_run.job_id)}`}>
                      {m.source_run.job_id}
                    </Link>
                  ) : (
                    "—"
                  ),
                ],
                ["created", fmtTime(m.model.created_at)],
                ["MLflow", m.mlmodel?.mlflow_version ?? "—"],
                ["python", m.mlmodel?.python_version ?? "—"],
                ["size", m.mlmodel?.model_size_bytes ? fmtBytes(m.mlmodel.model_size_bytes) : "—"],
              ]}
            />
          </section>
          <section className="card" data-testid="flavors">
            <h2>Flavors</h2>
            {m.unsupported ? <div className="banner warn">{m.unsupported}</div> : null}
            {m.trust ? (
              <div
                className={`banner ${m.trust.level === "restricted" ? "info" : "warn"} small`}
                data-testid="trust"
              >
                <strong>
                  {m.trust.level === "restricted"
                    ? "Restricted format"
                    : m.trust.level === "code"
                      ? "Loading runs code"
                      : "Unknown format"}
                  :
                </strong>{" "}
                {m.trust.warning}
              </div>
            ) : null}
            {(m.mlmodel?.flavors ?? []).map((f: J) => (
              <div key={f.name} className="stack">
                <strong>
                  {f.name}
                  {f.framework_version ? ` ${f.framework_version}` : ""}
                </strong>
                <span className="small faint">
                  {Object.entries(f.details)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(" · ")}
                </span>
              </div>
            ))}
          </section>
          <section className="card" data-testid="signature">
            <h2>Signature</h2>
            {m.mlmodel?.signature ? (
              <div className="grid2">
                <div>
                  <h3>inputs</h3>
                  <SchemaTable schema={m.mlmodel.signature.inputs} />
                </div>
                <div>
                  <h3>outputs</h3>
                  <SchemaTable schema={m.mlmodel.signature.outputs} />
                </div>
              </div>
            ) : (
              <p className="muted small">No signature was logged with this model.</p>
            )}
            {m.input_example ? (
              <>
                <h3>input example</h3>
                <pre className="small mono pre-wrap">{m.input_example}</pre>
              </>
            ) : null}
          </section>
        </div>
        <div>
          <section className="card">
            <h2>Registry versions</h2>
            {m.registry_versions.length === 0 ? (
              <p className="muted small">Not registered.</p>
            ) : null}
            {m.registry_versions.map((v: J) => (
              <div key={`${v.name}/${v.version}`} className="row small">
                <Link to={`${props.base}/models/registry/${e(v.name)}`}>
                  {v.name} v{v.version}
                </Link>
                {v.aliases.map((a: string) => (
                  <Badge key={a} tone="info">
                    @{a}
                  </Badge>
                ))}
              </div>
            ))}
          </section>
          <section className="card">
            <h2>Evaluations</h2>
            {m.evaluations.length === 0 ? (
              <p className="muted small">
                Not evaluated. <Link to={`${props.base}/data/evaluations/new`}>New evaluation</Link>
              </p>
            ) : null}
            {m.evaluations.map((x: J) => (
              <div key={x.evaluation_id} className="row small">
                <Link to={`${props.base}/data/evaluations/${e(x.evaluation_id)}`}>
                  {x.evaluation_id}
                </Link>
                <span className="faint">{x.role}</span>
                <EvalBadge state={x.state} passed={x.passed} />
              </div>
            ))}
          </section>
          <section className="card">
            <h2>Training datasets</h2>
            {(m.source_run?.datasets ?? []).length === 0 ? (
              <p className="muted small">No dataset inputs on the source run.</p>
            ) : null}
            {(m.source_run?.datasets ?? []).map((x: J) => (
              <div key={`${x.name}${x.digest}${x.context}${x.split}`} className="row small">
                <Link to={`${props.base}/data`}>{x.name}</Link>
                <span className="mono faint">{x.digest}</span>
                <span>
                  {x.context ?? "—"}
                  {x.split ? `/${x.split}` : ""}
                </span>
              </div>
            ))}
          </section>
          <section className="card" data-testid="dependencies">
            <h2>Dependencies</h2>
            {!m.dependencies?.requirements &&
            !m.dependencies?.python_env &&
            !m.dependencies?.conda ? (
              <p className="muted small">No environment files were logged.</p>
            ) : null}
            {m.dependencies?.requirements ? (
              <>
                <h3>requirements.txt</h3>
                <pre className="small mono pre-wrap">{m.dependencies.requirements}</pre>
              </>
            ) : null}
            {m.dependencies?.python_env ? (
              <>
                <h3>python_env.yaml</h3>
                <pre className="small mono pre-wrap">{m.dependencies.python_env}</pre>
              </>
            ) : null}
          </section>
          <section className="card" data-testid="model-files">
            <h2>Files</h2>
            <p className="faint small">
              Downloads only; model files are never opened in the browser.
            </p>
            <div className="table-wrap">
              <table className="small">
                <tbody>
                  {m.files.map((f: J) =>
                    f.is_dir ? (
                      <tr key={f.path}>
                        <td>{f.path}/</td>
                        <td />
                      </tr>
                    ) : (
                      <tr key={f.path}>
                        <td>
                          <a href={dl(f.path)} download>
                            {f.path}
                          </a>
                        </td>
                        <td className="faint">{fmtBytes(f.file_size)}</td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
      {register ? (
        <RegisterModal
          pid={props.pid}
          modelId={props.id}
          onClose={() => setRegister(false)}
          onDone={(name) => navigate(`${props.base}/models/registry/${e(name)}`)}
        />
      ) : null}
    </div>
  );
}

function SchemaTable(props: { schema: unknown }) {
  if (!Array.isArray(props.schema)) return <Json value={props.schema ?? "none"} />;
  return (
    <table className="small">
      <tbody>
        {props.schema.map((c: J, i: number) => (
          <tr key={c.name ?? i}>
            <td>{c.name ?? `#${i}`}</td>
            <td className="mono">{c.type}</td>
            <td className="faint">{c.required === false ? "optional" : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RegisterModal(props: {
  pid: string;
  modelId: string;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const reg = useApi<{ registered_models: J[] }>(`/api/v1/projects/${e(props.pid)}/registry`);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState(false);
  const [description, setDescription] = useState("");
  const go = useAction(async () => {
    const base = `/api/v1/projects/${e(props.pid)}/registry`;
    if (fresh) await api(base, { body: { name } });
    await api(`${base}/${e(name)}/versions`, {
      body: { model_id: props.modelId, ...(description ? { description } : {}) },
    });
    props.onDone(name);
  });
  const existing = reg.data?.registered_models ?? [];
  return (
    <Modal
      title="Register model"
      onClose={props.onClose}
      footer={
        <>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!name || go.busy}
            onClick={() => void go.run()}
          >
            {go.busy ? "Registering…" : "Register version"}
          </button>
        </>
      }
    >
      <label className="field">
        Registered model
        <select
          value={fresh ? "__new" : name}
          aria-label="Registered model"
          onChange={(ev) => {
            setFresh(ev.target.value === "__new");
            setName(ev.target.value === "__new" ? "" : ev.target.value);
          }}
        >
          <option value="">choose…</option>
          {existing.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
          <option value="__new">new registered model…</option>
        </select>
      </label>
      {fresh ? (
        <label className="field">
          New name
          <input
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            aria-label="New registered model name"
          />
        </label>
      ) : null}
      <label className="field">
        Version description (optional)
        <input
          value={description}
          onChange={(ev) => setDescription(ev.target.value)}
          aria-label="Version description"
        />
      </label>
      <ErrorBox error={go.error} />
    </Modal>
  );
}

function Registry(props: { pid: string; base: string }) {
  const reg = useApi<{ registered_models: J[] }>(`/api/v1/projects/${e(props.pid)}/registry`);
  useEvents(() => reg.reload(), {
    project: props.pid,
    types: ["registry.model.created", "registry.version.created"],
  });
  const [name, setName] = useState("");
  const create = useAction(async () => {
    await api(`/api/v1/projects/${e(props.pid)}/registry`, { body: { name } });
    navigate(`${props.base}/models/registry/${e(name)}`);
  });
  return (
    <section className="card" data-testid="registry">
      <h2>Registry</h2>
      <div className="row">
        <input
          value={name}
          onChange={(ev) => setName(ev.target.value)}
          placeholder="new registered model name"
          aria-label="New registered model"
        />
        <button type="button" disabled={!name || create.busy} onClick={() => void create.run()}>
          Create
        </button>
      </div>
      <ErrorBox error={create.error ?? reg.error} />
      {reg.data?.registered_models.length === 0 ? (
        <Empty>No registered models yet. Register one from a logged model's page.</Empty>
      ) : null}
      {reg.data?.registered_models.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>latest</th>
                <th>description</th>
                <th>updated</th>
              </tr>
            </thead>
            <tbody>
              {reg.data.registered_models.map((r) => (
                <tr key={r.name}>
                  <td>
                    <Link to={`${props.base}/models/registry/${e(r.name)}`}>{r.name}</Link>
                  </td>
                  <td>{r.latest_version ? `v${r.latest_version}` : "—"}</td>
                  <td className="small">{r.description ?? ""}</td>
                  <td className="small faint">{fmtTime(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function RegistryDetail(props: { pid: string; base: string; name: string }) {
  const { query } = useLocation();
  const path = `/api/v1/projects/${e(props.pid)}/registry/${e(props.name)}`;
  const d = useApi<{ registered_model: J }>(path);
  useEvents(() => d.reload(), {
    project: props.pid,
    types: [
      "registry.version.created",
      "registry.alias.set",
      "registry.alias.deleted",
      "evaluation.updated",
    ],
  });
  const [editing, setEditing] = useState<{ version?: string; text: string }>();
  const [aliasFor, setAliasFor] = useState<string>();
  const [aliasName, setAliasName] = useState("champion");
  const [compare, setCompare] = useState<string[]>([]);
  const act = useAction(async (fn: () => Promise<unknown>) => {
    await fn();
    d.reload();
  });
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const rm = d.data.registered_model;
  const focus = query.get("v") ?? rm.versions[0]?.version;
  const compareRuns = rm.versions
    .filter((v: J) => compare.includes(v.version) && v.run_id)
    .map((v: J) => v.run_id as string);
  return (
    <div data-testid="registry-detail">
      {focus ? (
        <LineageStrip
          pid={props.pid}
          kind="model_version"
          id={`${rm.name}/${focus}`}
          base={props.base}
        />
      ) : null}
      <section className="card">
        <div className="row">
          <h2 className="grow">{rm.name}</h2>
          {compareRuns.length >= 2 ? (
            <button
              type="button"
              onClick={() =>
                navigate(`${props.base}/runs/compare${qs({ runs: compareRuns.join(",") })}`)
              }
            >
              Compare {compareRuns.length} source runs
            </button>
          ) : null}
        </div>
        <p className="small">
          {rm.description || <span className="faint">No description.</span>}{" "}
          <button
            type="button"
            className="link small"
            onClick={() => setEditing({ text: rm.description ?? "" })}
          >
            edit
          </button>
        </p>
        <div className="row small">
          Aliases: {rm.aliases.length === 0 ? <span className="faint">none</span> : null}
          {rm.aliases.map((a: J) => (
            <span key={a.alias} className="row">
              <Badge tone="info">
                @{a.alias} → v{a.version}
              </Badge>
              <button
                type="button"
                className="link small"
                aria-label={`Remove alias ${a.alias}`}
                onClick={() =>
                  void act.run(() => api(`${path}/aliases/${e(a.alias)}`, { method: "DELETE" }))
                }
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        {(rm.tags ?? []).length ? (
          <div className="small faint">
            tags: {rm.tags.map((t: J) => `${t.key}=${t.value}`).join(", ")}
          </div>
        ) : null}
        <ErrorBox error={act.error} />
      </section>
      <section className="card" data-testid="versions">
        <h2>Versions</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th aria-label="compare" />
                <th>version</th>
                <th>logged model</th>
                <th>source run / job</th>
                <th>aliases</th>
                <th>evaluations</th>
                <th>description</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rm.versions.map((v: J) => (
                <tr key={v.version} className={v.version === focus ? "selected" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Compare version ${v.version}`}
                      checked={compare.includes(v.version)}
                      onChange={(ev) =>
                        setCompare((c) =>
                          ev.target.checked ? [...c, v.version] : c.filter((x) => x !== v.version),
                        )
                      }
                    />
                  </td>
                  <td>
                    <Link to={`${props.base}/models/registry/${e(rm.name)}${qs({ v: v.version })}`}>
                      v{v.version}
                    </Link>
                  </td>
                  <td className="small">
                    {v.model_id ? (
                      <Link to={`${props.base}/models/m/${e(v.model_id)}`}>
                        {shortId(v.model_id, 12)}
                      </Link>
                    ) : (
                      v.source
                    )}
                  </td>
                  <td className="small">
                    {v.run_id ? (
                      <Link to={`${props.base}/runs/r/${e(v.run_id)}`}>{shortId(v.run_id)}</Link>
                    ) : (
                      "—"
                    )}
                    {v.job_id ? (
                      <>
                        {" · "}
                        <Link to={`${props.base}/runs/jobs/${e(v.job_id)}`}>
                          {shortId(v.job_id, 14)}
                        </Link>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {v.aliases.map((a: string) => (
                      <Badge key={a} tone="info">
                        @{a}
                      </Badge>
                    ))}
                  </td>
                  <td className="small">
                    {v.evaluations.map((x: J) => (
                      <span key={x.evaluation_id}>
                        <Link to={`${props.base}/data/evaluations/${e(x.evaluation_id)}`}>
                          <EvalBadge state={x.state} passed={x.passed} />
                        </Link>{" "}
                      </span>
                    ))}
                  </td>
                  <td className="small">
                    {v.description ?? ""}{" "}
                    <button
                      type="button"
                      className="link small"
                      onClick={() => setEditing({ version: v.version, text: v.description ?? "" })}
                    >
                      edit
                    </button>
                  </td>
                  <td>
                    <button type="button" className="small" onClick={() => setAliasFor(v.version)}>
                      Set alias
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="faint small">
          Choose a version by giving it an alias (for example <code>champion</code>). Evaluations
          and later inference resolve an alias to its version when they start and keep the exact
          version.
        </p>
      </section>
      {editing ? (
        <Modal
          title={editing.version ? `Describe v${editing.version}` : `Describe ${rm.name}`}
          onClose={() => setEditing(undefined)}
          footer={
            <button
              type="button"
              className="primary"
              disabled={act.busy}
              onClick={() =>
                void act
                  .run(() =>
                    api(editing.version ? `${path}/versions/${e(editing.version)}` : path, {
                      method: "PATCH",
                      body: { description: editing.text },
                    }),
                  )
                  .then(() => setEditing(undefined))
              }
            >
              Save
            </button>
          }
        >
          <label className="field">
            Description
            <textarea
              value={editing.text}
              onChange={(ev) => setEditing({ ...editing, text: ev.target.value })}
              aria-label="Description"
            />
          </label>
        </Modal>
      ) : null}
      {aliasFor ? (
        <Modal
          title={`Alias for v${aliasFor}`}
          onClose={() => setAliasFor(undefined)}
          footer={
            <button
              type="button"
              className="primary"
              disabled={!aliasName || act.busy}
              onClick={() =>
                void act
                  .run(() =>
                    api(`${path}/aliases/${e(aliasName)}`, {
                      method: "PUT",
                      body: { version: aliasFor },
                    }),
                  )
                  .then(() => setAliasFor(undefined))
              }
            >
              Set alias
            </button>
          }
        >
          <label className="field">
            Alias
            <input
              value={aliasName}
              onChange={(ev) => setAliasName(ev.target.value)}
              aria-label="Alias name"
            />
          </label>
          <p className="faint small">
            An alias points at one version; setting it here moves it from any other version.
          </p>
          <ErrorBox error={act.error} />
        </Modal>
      ) : null}
    </div>
  );
}

// ============================================================ Project entrypoints

export function EntrypointsPage(props: { pid: string; base: string }) {
  const info = useApi<J>(`/api/v1/projects/${e(props.pid)}/mlproject`);
  const [chosen, setChosen] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [environment, setEnvironment] = useState("");
  const launch = useAction(async (entrypoint: string) => {
    const r = await api<{ job: { job_id: string } }>(
      `/api/v1/projects/${e(props.pid)}/mlproject/runs`,
      {
        body: {
          entrypoint,
          parameters: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "")),
          ...(environment ? { environment } : {}),
        },
      },
    );
    navigate(`${props.base}/runs/jobs/${e(r.job.job_id)}`);
  });
  if (info.error) return <ErrorBox error={info.error} onRetry={info.reload} />;
  if (!info.data) return <Loading />;
  const d = info.data;
  if (!d.found)
    return (
      <section className="card" data-testid="entrypoints">
        <h2>Project entrypoints</h2>
        <Empty>
          This checkout has no <code>MLproject</code> file. That is fine: any command runs as a job
          from <Link to={`${props.base}/runs/jobs`}>Jobs</Link>. Add an <code>MLproject</code> to
          describe entrypoints and parameters.
        </Empty>
      </section>
    );
  const ep = d.entry_points.find((x: J) => x.name === chosen);
  return (
    <section className="card" data-testid="entrypoints">
      <h2>
        Project entrypoints <span className="faint small">{d.name ?? ""}</span>
      </h2>
      <div className={`banner ${d.environment.supported ? "info" : "warn"} small`}>
        Environment: <strong>{d.environment.kind}</strong>
        {d.environment.file ? ` (${d.environment.file})` : ""}. {d.environment.note}
      </div>
      {d.problems.map((p: string) => (
        <div key={p} className="banner warn small">
          {p}
        </div>
      ))}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>entrypoint</th>
              <th>parameters</th>
              <th>command</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.entry_points.map((x: J) => (
              <tr key={x.name}>
                <td>
                  <strong>{x.name}</strong>
                </td>
                <td className="small">
                  {x.parameters.length === 0 ? "—" : null}
                  {x.parameters.map((p: J) => (
                    <div key={p.name}>
                      {p.name} <span className="faint">({p.type})</span>
                      {p.default !== undefined ? (
                        <span className="faint"> = {p.default}</span>
                      ) : (
                        <Badge tone="warn">required</Badge>
                      )}
                    </div>
                  ))}
                </td>
                <td className="mono small">{x.command}</td>
                <td>
                  <button
                    type="button"
                    disabled={!d.environment.supported}
                    onClick={() => {
                      setChosen(x.name);
                      setValues(
                        Object.fromEntries(x.parameters.map((p: J) => [p.name, p.default ?? ""])),
                      );
                    }}
                  >
                    Run…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ep ? (
        <Modal
          title={`Run ${ep.name}`}
          onClose={() => setChosen(undefined)}
          footer={
            <button
              type="button"
              className="primary"
              disabled={launch.busy}
              onClick={() => void launch.run(ep.name)}
            >
              {launch.busy ? "Starting…" : "Run as a job"}
            </button>
          }
        >
          {ep.parameters.map((p: J) => (
            <label key={p.name} className="field">
              {p.name} ({p.type})
              <input
                value={values[p.name] ?? ""}
                aria-label={`Parameter ${p.name}`}
                onChange={(ev) => setValues((v) => ({ ...v, [p.name]: ev.target.value }))}
              />
            </label>
          ))}
          <label className="field">
            Environment
            <select
              value={environment}
              onChange={(ev) => setEnvironment(ev.target.value)}
              aria-label="Environment"
            >
              <option value="">project default (uv when it has a pyproject.toml)</option>
              <option value="uv">uv (the project's environment)</option>
              <option value="none">none (run the command as given)</option>
            </select>
          </label>
          <p className="faint small mono">{ep.command}</p>
          <ErrorBox error={launch.error} />
        </Modal>
      ) : null}
    </section>
  );
}

/** Datasets and models of one run, for the run page. */
export function RunLifecycleCard(props: { pid: string; base: string; run: J }) {
  const inputs: J[] = props.run?.inputs?.dataset_inputs ?? [];
  const outputs: J[] = props.run?.outputs?.model_outputs ?? [];
  if (!inputs.length && !outputs.length) return null;
  return (
    <section className="card" data-testid="run-lifecycle">
      <h3>Datasets and models</h3>
      {inputs.map((i) => {
        const tag = (k: string) => i.tags?.find((t: J) => t.key === k)?.value;
        return (
          <div
            key={`${i.dataset.name}${i.dataset.digest}${tag("mlflow.data.context")}`}
            className="row small"
          >
            <Link to={`${props.base}/data`}>{i.dataset.name}</Link>
            <span className="mono faint">{i.dataset.digest}</span>
            <span>
              {tag("mlflow.data.context") ?? "—"}
              {tag("ablationkit.split") ? `/${tag("ablationkit.split")}` : ""}
            </span>
          </div>
        );
      })}
      {outputs.map((o) => (
        <div key={o.model_id} className="row small">
          produced <Link to={`${props.base}/models/m/${e(o.model_id)}`}>{o.model_id}</Link>
          <span className="faint">step {o.step}</span>
        </div>
      ))}
    </section>
  );
}
