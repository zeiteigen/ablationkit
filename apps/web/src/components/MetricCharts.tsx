/**
 * Metric charts for one run or an overlay of several (Compare). Series come from the coordinator's
 * downsampled endpoint; the "raw" link downloads the canonical history as CSV.
 */
import { useEffect, useState } from "react";
import { api, qs } from "../api.ts";
import { Chart, type ChartSeries } from "./Chart.tsx";
import { ErrorBox, Loading } from "./ui.tsx";

interface SeriesResp {
  run_id?: string;
  state?: string;
  series: {
    key: string;
    total: number;
    downsampled?: boolean;
    truncated?: boolean;
    points: [number, number, number | string][];
    non_finite?: [number, number, string][];
  }[];
}

export interface ChartRun {
  id: string;
  label: string;
}

export function MetricCharts(props: { runs: readonly ChartRun[]; keys: readonly string[] }) {
  const [x, setX] = useState<"step" | "time">("step");
  const [log, setLog] = useState(false);
  const [data, setData] = useState<Map<string, SeriesResp>>();
  const [error, setError] = useState<unknown>();
  const keysStr = props.keys.join(",");
  const runsStr = props.runs.map((r) => r.id).join(",");

  useEffect(() => {
    if (!keysStr || !runsStr) {
      setData(new Map());
      return;
    }
    const ac = new AbortController();
    setError(undefined);
    // At most 20 keys per request; the coordinator bounds work per call.
    const chunks: string[][] = [];
    const ks = keysStr.split(",");
    for (let i = 0; i < ks.length; i += 20) chunks.push(ks.slice(i, i + 20));
    Promise.all(
      runsStr.split(",").map(async (id) => {
        const parts = await Promise.all(
          chunks.map((c) =>
            api<SeriesResp>(
              `/api/v1/tracking/runs/${encodeURIComponent(id)}/metrics/series${qs({
                keys: c.join(","),
                points: 500,
                x,
              })}`,
              { signal: ac.signal },
            ),
          ),
        );
        return [id, { series: parts.flatMap((p) => p.series) }] as const;
      }),
    ).then(
      (pairs) => setData(new Map(pairs)),
      (e) => {
        if (!ac.signal.aborted) setError(e);
      },
    );
    return () => ac.abort();
  }, [keysStr, runsStr, x]);

  if (props.keys.length === 0) return <p className="muted small">No metrics logged.</p>;

  return (
    <div className="stack">
      <div className="row small">
        <span className="muted">x axis</span>
        <select
          value={x}
          onChange={(e) => setX(e.target.value as "step" | "time")}
          aria-label="x axis"
        >
          <option value="step">step</option>
          <option value="time">wall time</option>
        </select>
        <label className="row">
          <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} /> log y
        </label>
        <span className="faint">
          Charts are downsampled (LTTB, ≤500 points); exports of raw history are unmodified.
        </span>
      </div>
      <ErrorBox error={error} />
      {!data && !error ? <Loading /> : null}
      {data ? (
        <div className="grid2">
          {props.keys.map((key) => {
            const series: ChartSeries[] = [];
            const notes: string[] = [];
            for (const r of props.runs) {
              const s = data.get(r.id)?.series.find((x) => x.key === key);
              if (!s) continue;
              series.push({
                label: r.label,
                points: s.points
                  .filter((p): p is [number, number, number] => typeof p[2] === "number")
                  .map((p) => [x === "time" ? p[1] : p[0], p[2]] as const),
              });
              if (s.downsampled) notes.push(`${r.label}: ${s.points.length}/${s.total} points`);
              if (s.truncated) notes.push(`${r.label}: history truncated`);
              if (s.non_finite?.length)
                notes.push(`${r.label}: ${s.non_finite.length} non-finite values not plotted`);
            }
            return (
              <div key={key} className="card" data-testid={`chart-${key}`}>
                <Chart
                  title={key}
                  series={series}
                  logY={log}
                  xIsTime={x === "time"}
                  exportName={key.replaceAll(/[^A-Za-z0-9._-]/g, "_")}
                />
                <div className="row small faint">
                  {notes.join(" · ")}
                  {props.runs.length === 1 && props.runs[0] ? (
                    <a
                      href={`/api/v1/tracking/runs/${encodeURIComponent(props.runs[0].id)}/metrics${qs({ key, format: "csv" })}`}
                      download
                      style={{ marginLeft: "auto" }}
                    >
                      raw history CSV
                    </a>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
