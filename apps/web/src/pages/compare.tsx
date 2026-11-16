/**
 * Comparison (spec §5.6 Comparison & Ablations): 2–20 runs side by side, parameters and latest
 * metrics with differences highlighted, a baseline with deltas, metric overlays, CSV/JSON export.
 */

import { useMemo, useState } from "react";
import { qs, useApi } from "../api.ts";
import { MetricCharts } from "../components/MetricCharts.tsx";
import { Badge, download, Empty, ErrorBox, Link, Loading, runTone } from "../components/ui.tsx";
import { delta, fmtDelta, fmtNum, shortId } from "../lib/format.ts";
import { compareCsv, type DeclaredDirections, metricDirection, sharedTag } from "../lib/tables.ts";
import type { RunsPage } from "../lib/types.ts";
import { setQuery, useLocation } from "../router.ts";
import { ExtensionMounts } from "./extensions.tsx";

interface CompareResp {
  runs: {
    run_id: string;
    run_name?: string;
    status: string;
    experiment_id: string;
    ablationkit: Record<string, string>;
  }[];
  params: { key: string; values: (string | undefined)[]; differs: boolean }[];
  metrics: { key: string; values: (number | undefined)[]; differs: boolean }[];
}

export function ComparePage(props: { pid: string; base: string }) {
  const { query } = useLocation();
  const ids = (query.get("runs") ?? "").split(",").filter(Boolean);
  if (ids.length < 2) return <Picker pid={props.pid} />;
  return <Comparison pid={props.pid} base={props.base} ids={ids} />;
}

function Picker(props: { pid: string }) {
  const runs = useApi<RunsPage>(
    `/api/v1/tracking/runs${qs({ project: props.pid, max_results: 100 })}`,
  );
  const [sel, setSel] = useState<string[]>([]);
  return (
    <div className="stack">
      <p className="muted">Pick 2 to 20 runs to compare, or select them on the Runs tab.</p>
      <ErrorBox error={runs.error} />
      {!runs.data ? <Loading /> : null}
      {runs.data?.runs.length === 0 ? <Empty>No runs yet.</Empty> : null}
      {runs.data?.runs.map((r) => (
        <label key={r.info.run_id} className="row small">
          <input
            type="checkbox"
            checked={sel.includes(r.info.run_id)}
            onChange={(e) =>
              setSel((s) =>
                e.target.checked ? [...s, r.info.run_id] : s.filter((x) => x !== r.info.run_id),
              )
            }
          />
          <Badge tone={runTone(r.info.status)}>{r.info.status}</Badge>
          {r.info.run_name ?? r.info.run_id}
        </label>
      ))}
      <div>
        <button
          type="button"
          className="primary"
          disabled={sel.length < 2 || sel.length > 20}
          onClick={() => setQuery({ runs: sel.join(",") })}
        >
          Compare {sel.length}
        </button>
      </div>
    </div>
  );
}

function Comparison(props: { pid: string; base: string; ids: string[] }) {
  const c = useApi<CompareResp>(
    `/api/v1/tracking/compare?runs=${encodeURIComponent(props.ids.join(","))}`,
  );
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [baseline, setBaseline] = useState(0);
  const [chartKeys, setChartKeys] = useState<string[]>();
  const data = c.data;
  // Declared directions: the study's metric goals, when the runs share one (a baseline without
  // the tag still counts).
  const studyId = data ? sharedTag(data.runs, "study_id") : undefined;
  const e = encodeURIComponent;
  const study = useApi<{
    record: { kind: string; metric_goals?: DeclaredDirections["studyGoals"] };
  }>(studyId ? `/api/v1/projects/${e(props.pid)}/research/${e(studyId)}` : undefined);
  const declared: DeclaredDirections = {
    ...(study.data?.record.kind === "study" && study.data.record.metric_goals
      ? { studyGoals: study.data.record.metric_goals }
      : {}),
  };
  const labels = useMemo(
    () => (data?.runs ?? []).map((r) => r.run_name ?? shortId(r.run_id)),
    [data],
  );
  if (c.error) return <ErrorBox error={c.error} onRetry={c.reload} />;
  if (!data) return <Loading />;
  const params = data.params.filter((p) => !onlyDiff || p.differs);
  const metrics = data.metrics.filter(
    (m) => !m.key.startsWith("system/") && (!onlyDiff || m.differs),
  );
  const keys = chartKeys ?? metrics.map((m) => m.key).slice(0, 6);

  return (
    <div className="stack">
      <div className="row">
        <label className="row small">
          <input
            type="checkbox"
            checked={onlyDiff}
            onChange={(e) => setOnlyDiff(e.target.checked)}
          />
          only rows that differ
        </label>
        <label className="row small">
          baseline
          <select
            value={baseline}
            onChange={(e) => setBaseline(Number(e.target.value))}
            aria-label="Baseline run"
          >
            {labels.map((l, i) => (
              <option key={data.runs[i]?.run_id} value={i}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => download(`${props.pid}-compare.csv`, compareCsv(data), "text/csv")}
        >
          Export table CSV
        </button>
        <a
          className="btn"
          href={`/api/v1/tracking/export${qs({ runs: props.ids.join(","), format: "csv" })}`}
          download
        >
          Export runs CSV
        </a>
        <a
          className="btn"
          href={`/api/v1/tracking/export${qs({ runs: props.ids.join(","), format: "json" })}`}
          download
        >
          Export runs JSON
        </a>
      </div>
      <div className="table-wrap">
        <table data-testid="compare-table">
          <thead>
            <tr>
              <th />
              {data.runs.map((r, i) => (
                <th key={r.run_id}>
                  <Link to={`${props.base}/runs/r/${encodeURIComponent(r.run_id)}`}>
                    {labels[i]}
                  </Link>{" "}
                  {i === baseline ? <Badge tone="info">baseline</Badge> : null}
                  <div>
                    <Badge tone={runTone(r.status)}>{r.status}</Badge>
                  </div>
                  {r.ablationkit["variant_id"] ? (
                    <div className="faint small">variant {r.ablationkit["variant_id"]}</div>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {params.length ? (
              <tr>
                <td colSpan={data.runs.length + 1}>
                  <strong className="small">Parameters</strong>
                </td>
              </tr>
            ) : null}
            {params.map((p) => (
              <tr key={`p:${p.key}`} className={p.differs ? "differs" : ""}>
                <td className="mono small">{p.key}</td>
                {p.values.map((v, i) => (
                  <td key={data.runs[i]?.run_id} className="mono small wrap">
                    {v ?? <span className="faint">—</span>}
                  </td>
                ))}
              </tr>
            ))}
            {metrics.length ? (
              <tr>
                <td colSpan={data.runs.length + 1}>
                  <strong className="small">Metrics (latest value)</strong>{" "}
                  <span className="faint small">
                    best by the declared direction
                    {declared.studyGoals ? ` (study ${studyId})` : ""}, else by name (loss, error,
                    bits, perplexity, time ↓; rates and everything else ↑)
                  </span>
                </td>
              </tr>
            ) : null}
            {metrics.map((m) => {
              const finite = m.values.filter((v): v is number => typeof v === "number");
              const dir = metricDirection(m.key, declared);
              const best = finite.length
                ? dir.lower
                  ? Math.min(...finite)
                  : Math.max(...finite)
                : undefined;
              const base = m.values[baseline];
              return (
                <tr key={`m:${m.key}`} className={m.differs ? "differs" : ""}>
                  <td className="mono small">
                    {m.key}
                    {dir.source !== "name" ? (
                      <span
                        className="faint"
                        title={`${dir.lower ? "lower" : "higher"} is better, declared by the ${dir.source}`}
                      >
                        {" "}
                        {dir.lower ? "↓" : "↑"} {dir.source}
                      </span>
                    ) : null}
                  </td>
                  {m.values.map((v, i) => (
                    <td
                      key={data.runs[i]?.run_id}
                      className={`num${v !== undefined && v === best && finite.length > 1 ? " best" : ""}`}
                    >
                      {fmtNum(v, 5)}
                      {i !== baseline && v !== undefined ? (
                        <div className="faint small">{fmtDelta(delta(v, base))}</div>
                      ) : null}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <section className="card">
        <h2>Overlay</h2>
        <div className="row small" style={{ marginBottom: 8 }}>
          {metrics.map((m) => (
            <label key={m.key} className="row">
              <input
                type="checkbox"
                checked={keys.includes(m.key)}
                onChange={(e) =>
                  setChartKeys(
                    e.target.checked ? [...keys, m.key] : keys.filter((k) => k !== m.key),
                  )
                }
              />
              <span className="mono">{m.key}</span>
            </label>
          ))}
        </div>
        <MetricCharts
          runs={data.runs.map((r, i) => ({ id: r.run_id, label: labels[i] ?? r.run_id }))}
          keys={keys}
        />
      </section>
      <ExtensionMounts
        pid={props.pid}
        point="comparison.view"
        context={{ run_ids: data.runs.map((r) => r.run_id) }}
      />
    </div>
  );
}
