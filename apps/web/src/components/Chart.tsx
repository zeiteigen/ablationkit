/**
 * A dependency-free SVG line chart for metric histories. The data it receives is already
 * downsampled by the coordinator (LTTB); the chart never alters canonical values, and exports
 * the plotted points as CSV (or the drawing as SVG).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtNum, seriesColor } from "../lib/format.ts";
import { niceTicks } from "../lib/tables.ts";
import { download } from "./ui.tsx";

export interface ChartSeries {
  readonly label: string;
  /** [x, y] pairs, x ascending. */
  readonly points: readonly (readonly [number, number])[];
  readonly color?: string;
}

export interface ChartProps {
  readonly series: readonly ChartSeries[];
  readonly xLabel?: string;
  readonly title?: string;
  readonly height?: number;
  readonly logY?: boolean;
  readonly xIsTime?: boolean;
  /** File name stem for exports. */
  readonly exportName?: string;
}

const PAD = { l: 56, r: 12, t: 10, b: 26 };

export function Chart(props: ChartProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<{ x: number; px: number; py: number } | undefined>();
  const height = props.height ?? 240;

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setWidth(Math.max(240, Math.floor(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tf = (y: number) => (props.logY ? (y > 0 ? Math.log10(y) : Number.NaN) : y);
  const dom = useMemo(() => {
    let x0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const s of props.series)
      for (const [x, yRaw] of s.points) {
        const y = props.logY ? (yRaw > 0 ? Math.log10(yRaw) : Number.NaN) : yRaw;
        if (!Number.isFinite(y)) continue;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    if (!Number.isFinite(x0)) return undefined;
    if (x0 === x1) x1 = x0 + 1;
    if (y0 === y1) {
      y0 -= Math.abs(y0) * 0.1 || 1;
      y1 += Math.abs(y1) * 0.1 || 1;
    }
    const pad = (y1 - y0) * 0.05;
    return { x0, x1, y0: y0 - pad, y1: y1 + pad };
  }, [props.series, props.logY]);

  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const sx = (x: number) => (dom ? PAD.l + ((x - dom.x0) / (dom.x1 - dom.x0)) * iw : 0);
  const sy = (y: number) => (dom ? PAD.t + (1 - (y - dom.y0) / (dom.y1 - dom.y0)) * ih : 0);

  const fmtX = (x: number) =>
    props.xIsTime
      ? new Date(x).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : fmtNum(x, 4);
  const fmtY = (y: number) => fmtNum(props.logY ? 10 ** y : y, 4);

  const exportCsv = () => {
    const rows = ["series,x,y"];
    for (const s of props.series)
      for (const [x, y] of s.points) rows.push(`"${s.label.replaceAll('"', '""')}",${x},${y}`);
    download(`${props.exportName ?? "chart"}.csv`, `${rows.join("\n")}\n`, "text/csv");
  };
  const exportSvg = () => {
    if (!svg.current) return;
    const clone = svg.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    download(`${props.exportName ?? "chart"}.svg`, clone.outerHTML, "image/svg+xml");
  };

  if (!dom) {
    return <div className="empty small">No finite values to plot.</div>;
  }

  const yTicks = niceTicks(dom.y0, dom.y1, 5);
  const xTicks = niceTicks(dom.x0, dom.x1, Math.max(2, Math.floor(iw / 90)));

  // Hover readout: nearest point of each series to the cursor's x.
  const readout = hover
    ? props.series.map((s, i) => {
        let best: readonly [number, number] | undefined;
        let bd = Number.POSITIVE_INFINITY;
        for (const p of s.points) {
          const d = Math.abs(p[0] - hover.x);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        return { label: s.label, color: s.color ?? seriesColor(i), p: best };
      })
    : [];

  return (
    <div className="stack" style={{ gap: 6 }}>
      {props.title ? (
        <div className="row">
          <strong className="small">{props.title}</strong>
          <span className="faint small" style={{ marginLeft: "auto" }}>
            <button type="button" className="link small" onClick={exportCsv}>
              CSV
            </button>{" "}
            ·{" "}
            <button type="button" className="link small" onClick={exportSvg}>
              SVG
            </button>
          </span>
        </div>
      ) : null}
      <div ref={wrap} style={{ position: "relative" }}>
        <svg
          ref={svg}
          className="chart"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={props.title ?? "metric chart"}
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = e.clientX - r.left;
            const py = e.clientY - r.top;
            if (px < PAD.l || px > width - PAD.r) return setHover(undefined);
            setHover({ x: dom.x0 + ((px - PAD.l) / iw) * (dom.x1 - dom.x0), px, py });
          }}
          onMouseLeave={() => setHover(undefined)}
        >
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line className="grid" x1={PAD.l} x2={width - PAD.r} y1={sy(t)} y2={sy(t)} />
              <text x={PAD.l - 6} y={sy(t) + 4} textAnchor="end">
                {fmtY(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={`x${t}`} x={sx(t)} y={height - 8} textAnchor="middle">
              {fmtX(t)}
            </text>
          ))}
          <line className="axis" x1={PAD.l} x2={width - PAD.r} y1={PAD.t + ih} y2={PAD.t + ih} />
          {props.series.map((s, i) => {
            const color = s.color ?? seriesColor(i);
            const pts = s.points
              .map(([x, y]) => [x, tf(y)] as const)
              .filter(([, y]) => Number.isFinite(y));
            if (pts.length === 1) {
              const [x, y] = pts[0] as readonly [number, number];
              return <circle key={s.label} cx={sx(x)} cy={sy(y)} r={3} fill={color} />;
            }
            const d = pts
              .map(([x, y], j) => `${j ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`)
              .join("");
            return (
              <path key={s.label} d={d} fill="none" stroke={color} strokeWidth={1.6}>
                <title>{s.label}</title>
              </path>
            );
          })}
          {hover ? (
            <line className="axis" x1={hover.px} x2={hover.px} y1={PAD.t} y2={PAD.t + ih} />
          ) : null}
        </svg>
        {hover && readout.some((r) => r.p) ? (
          <div
            className="tooltip"
            style={{
              left: Math.min(hover.px + 12, width - 180),
              top: Math.max(0, hover.py - 10),
            }}
          >
            {readout.map((r) =>
              r.p ? (
                <div key={r.label}>
                  <span className="legend">
                    <span className="sw" style={{ background: r.color }} />
                  </span>
                  {r.label}: <strong>{fmtNum(r.p[1], 5)}</strong>{" "}
                  <span className="faint">@ {fmtX(r.p[0])}</span>
                </div>
              ) : null,
            )}
          </div>
        ) : null}
      </div>
      {props.series.length > 1 ? (
        <div className="legend">
          {props.series.map((s, i) => (
            <span key={s.label}>
              <span className="sw" style={{ background: s.color ?? seriesColor(i) }} />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
