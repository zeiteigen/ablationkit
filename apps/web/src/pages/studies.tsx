/**
 * Studies and Variants (spec §6.1): a Study is baseline plus variants; a Variant has many jobs.
 * Runs are grouped by their study/variant tags; a study record (Stage 7) adds the title, stored
 * baseline, protocol and metric goals, and studies with no runs yet. The ablation table
 * aggregates repeated runs per variant (mean ± sample std, n) with deltas against a chosen
 * baseline variant.
 */
import { useState } from "react";
import { api, qs, useApi, useEvents } from "../api.ts";
import { LineageStrip } from "../components/Lineage.tsx";
import { Markdown, plainExcerpt } from "../components/Markdown.tsx";
import { MetricCharts } from "../components/MetricCharts.tsx";
import {
  Badge,
  download,
  Empty,
  ErrorBox,
  Link,
  Loading,
  Menu,
  Modal,
  runTone,
  TrailActions,
  TrailLeaf,
  useAction,
  usePageProject,
} from "../components/ui.tsx";
import { delta, fmtDelta, fmtNum, fmtTime, shortId } from "../lib/format.ts";
import {
  parseLinks,
  type RefName,
  type ResearchRecord,
  type ReviewInfo,
  STUDY_ROLE,
  STUDY_STATUSES,
  statusTone,
} from "../lib/research.ts";
import { ablationCsv, lowerIsBetter } from "../lib/tables.ts";
import { STANDING } from "../lib/vault.ts";
import { useVaultStore } from "../lib/vault-store.ts";
import { navigate } from "../router.ts";
import { RelatedItem } from "./knowledge.tsx";

interface Stats {
  n: number;
  mean: number;
  std?: number;
  min: number;
  max: number;
}
interface Variant {
  variant_id: string;
  runs: {
    run_id: string;
    run_name?: string;
    status: string;
    start_time?: number;
    job_id?: string;
    summary?: string;
  }[];
  metrics: Record<string, Stats>;
  params: Record<string, string>;
  varying_params: string[];
}
interface StudyRecordView {
  title?: string;
  status?: string;
  summary?: string;
  body?: string;
  protocol?: string;
  baseline_variant?: string;
  variants?: { variant_id: string; title?: string; description?: string }[];
  metric_goals?: { key: string; goal: "min" | "max" }[];
  links?: { kind: string; id: string }[];
}
interface StudyResp {
  record?: StudyRecordView;
  study_id: string;
  variants: Variant[];
  metric_keys: string[];
  differing_params: string[];
  truncated: boolean;
}

export function StudiesPage(props: { pid: string; base: string }) {
  const s = useApi<{
    studies: {
      study_id: string;
      variants: number;
      runs: number;
      status_counts: Record<string, number>;
      last_start_time: number;
      record?: StudyRecordView;
    }[];
    truncated: boolean;
  }>(`/api/v1/projects/${encodeURIComponent(props.pid)}/studies`);
  useEvents(() => s.reload(), {
    project: props.pid,
    types: ["tracking.run.sync", "research.created", "research.updated"],
  });
  const [creating, setCreating] = useState(false);
  return (
    <div className="stack">
      <div className="row">
        <p
          className="muted small role"
          style={{ flex: 1, margin: 0, maxWidth: "none" }}
          data-testid="kind-role"
        >
          {STUDY_ROLE} Runs join a study through their study ID, set when a job is launched.
        </p>
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          New study
        </button>
      </div>
      {creating ? (
        <StudyForm
          pid={props.pid}
          onClose={() => setCreating(false)}
          onSaved={(id) => navigate(`${props.base}/runs/studies/${encodeURIComponent(id)}`)}
        />
      ) : null}
      <ErrorBox error={s.error} onRetry={s.reload} />
      {!s.data ? <Loading /> : null}
      {s.data?.studies.length === 0 ? (
        <Empty>
          No studies yet. Launch jobs with a study and variant to compare configurations.
        </Empty>
      ) : null}
      {s.data?.studies.length ? (
        <div className="table-wrap">
          <table data-testid="studies-table">
            <thead>
              <tr>
                <th>Study</th>
                <th>Baseline</th>
                <th className="num">Variants</th>
                <th className="num">Runs</th>
                <th>Run status</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              {s.data.studies.map((x) => (
                <tr key={x.study_id}>
                  <td>
                    <Link
                      to={`${props.base}/runs/studies/${encodeURIComponent(x.study_id)}`}
                      className="rtitle"
                    >
                      {x.record?.title ?? x.study_id}
                    </Link>{" "}
                    {x.record?.status ? (
                      <Badge tone={statusTone(x.record.status)}>{x.record.status}</Badge>
                    ) : null}
                    {x.record?.summary ? (
                      <div className="muted rsum">{plainExcerpt(x.record.summary, 300)}</div>
                    ) : x.record ? (
                      <div className="rsum">
                        <Badge tone="warn">no summary</Badge>
                      </div>
                    ) : (
                      <div className="faint small">
                        from run tags only: nobody recorded what this study is for
                      </div>
                    )}
                    {x.record?.title ? <div className="faint small mono">{x.study_id}</div> : null}
                  </td>
                  <td className="mono small">{x.record?.baseline_variant ?? "—"}</td>
                  <td className="num">{x.variants}</td>
                  <td className="num">{x.runs}</td>
                  <td>
                    {Object.entries(x.status_counts).map(([k, v]) => (
                      <Badge key={k} tone={runTone(k)}>
                        {v} {k.toLowerCase()}
                      </Badge>
                    ))}
                  </td>
                  <td className="small">{fmtTime(x.last_start_time)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {s.data?.truncated ? (
        <p className="faint small">Only the newest 5000 runs were scanned.</p>
      ) : null}
    </div>
  );
}

interface StudyRecordResp {
  record: ResearchRecord;
  backlinks: {
    record_id: string;
    kind: string;
    title: string;
    status?: string;
    summary?: string;
  }[];
  names?: Record<string, RefName>;
  review?: ReviewInfo;
}

export function StudyDetail(props: { pid: string; base: string; study: string }) {
  const p = encodeURIComponent(props.pid);
  const s = useApi<StudyResp>(`/api/v1/projects/${p}/studies/${encodeURIComponent(props.study)}`);
  // The study's record, when it has one: the read, what it links, what cites it, its review.
  const full = useApi<StudyRecordResp>(
    s.data?.record
      ? `/api/v1/projects/${p}/research/${encodeURIComponent(props.study)}`
      : undefined,
  );
  const [baseline, setBaseline] = useState<string>();
  const [showSystem, setShowSystem] = useState(false);
  const [allMetrics, setAllMetrics] = useState(false);
  const [recording, setRecording] = useState(false);
  const project = usePageProject();
  const store = useVaultStore(props.pid);
  useEvents(
    () => {
      s.reload();
      full.reload();
    },
    {
      project: props.pid,
      types: [
        "tracking.run.sync",
        "tracking.run.described",
        "research.created",
        "research.updated",
      ],
    },
  );
  const gen = useAction(async () => {
    const r = await api<{ record: { record_id: string } }>(
      `/api/v1/projects/${p}/research/reports/generate`,
      { body: { study_id: props.study, ...(baseline ? { baseline_variant: baseline } : {}) } },
    );
    navigate(`${props.base}/knowledge/r/${encodeURIComponent(r.record.record_id)}`);
  });
  if (s.error) return <ErrorBox error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading />;
  const d = s.data;
  const rec = d.record;
  const goals = new Map((rec?.metric_goals ?? []).map((g) => [g.key, g.goal]));
  const better = (k: string) => (goals.get(k) ? goals.get(k) === "min" : lowerIsBetter(k));
  const base =
    baseline ??
    (rec?.baseline_variant && d.variants.some((v) => v.variant_id === rec.baseline_variant)
      ? rec.baseline_variant
      : d.variants[0]?.variant_id);
  const baseV = d.variants.find((v) => v.variant_id === base);
  const visible = d.metric_keys.filter((k) => showSystem || !k.startsWith("system/"));
  // The metrics that decide the study come first, and alone until the reader asks for the rest.
  const goalKeys = visible.filter((k) => goals.has(k));
  const keys =
    goalKeys.length && !allMetrics
      ? goalKeys
      : [...goalKeys, ...visible.filter((k) => !goals.has(k))];
  // One representative run per variant (newest) for the overlay chart.
  const chartRuns = d.variants
    .map((v) => ({ v, r: v.runs[0] }))
    .filter((x) => x.r)
    .slice(0, 10)
    .map(({ v, r }) => ({
      id: r?.run_id as string,
      label: `${v.variant_id} (${shortId(r?.run_id)})`,
    }));
  const declared = new Map((rec?.variants ?? []).map((v) => [v.variant_id, v]));
  // Baseline first, then the order the study declares, then what was run without being declared.
  const order = [...declared.keys()];
  const pos = (id: string) =>
    id === base ? -1 : order.includes(id) ? order.indexOf(id) : order.length;
  const rows = [...d.variants].sort((a, b) => pos(a.variant_id) - pos(b.variant_id));
  const names = full.data?.names ?? {};
  const hypotheses = (rec?.links ?? []).filter((l) => l.kind === "hypothesis");
  const reports = (full.data?.backlinks ?? []).filter((b) => b.kind === "report");
  const tasks = (rec?.links ?? []).filter((l) => l.kind === "task");
  const neverRun = [...declared.keys()].filter(
    (id) => !d.variants.some((v) => v.variant_id === id),
  );
  const best = (k: string) => {
    const vals = d.variants.flatMap((v) => (v.metrics[k] ? [v.metrics[k].mean] : []));
    if (vals.length < 2) return undefined;
    return better(k) ? Math.min(...vals) : Math.max(...vals);
  };

  // The vault's claims that rest on this study: they, or a note beneath them, describe it, cite it
  // or take its runs as evidence (ADR 0055).
  const v = store?.vault;
  const studyRuns = new Set(
    d.variants.flatMap((x) => x.runs.flatMap((r) => [r.run_id, r.run_name ?? ""])).filter(Boolean),
  );
  const claims = v
    ? v.ledger.claims.filter((c) =>
        v
          .flatten(c.note_id)
          .some(
            ({ note: n }) =>
              n.study === d.study_id ||
              n.sources.includes(`study:${d.study_id}`) ||
              (n.evidence ?? []).some((e) => studyRuns.has(e.run)),
          ),
      )
    : [];
  const title = rec?.title ?? `Study ${d.study_id}`;
  return (
    <div className="stack read">
      <header className="ph">
        <TrailLeaf>{title}</TrailLeaf>
        <TrailActions>
          {d.variants.length ? (
            <button
              type="button"
              className="small"
              disabled={gen.busy}
              onClick={() => void gen.run()}
              title="Freeze the results table into a report record that cites every run"
            >
              Generate report
            </button>
          ) : null}
          <button type="button" className="small" onClick={() => setRecording(true)}>
            {rec ? "Edit" : "Record study"}
          </button>
          <Menu label="Export" className="small">
            <button
              type="button"
              onClick={() => download(`${d.study_id}-ablation.csv`, ablationCsv(d), "text/csv")}
            >
              The table (CSV)
            </button>
            <a
              href={`/api/v1/tracking/export${qs({ project: props.pid, filter: `tags.\`ablationkit.study_id\` = '${d.study_id}'`, format: "csv" })}`}
              download
            >
              Its runs (CSV)
            </a>
          </Menu>
        </TrailActions>
        <div className="eyebrow">
          {project ? `${project} · study` : "Study"}
          {rec?.status ? <Badge tone={statusTone(rec.status)}>{rec.status}</Badge> : null}
          {!rec ? <Badge title="No study record: grouped from run tags">untracked</Badge> : null}
        </div>
        <h1 data-testid="study-title">{title}</h1>
        <div className="ph-lede">
          {rec?.summary ? (
            <Markdown text={rec.summary} base={props.base} testId="study-summary" />
          ) : (
            <p className="faint">
              {rec
                ? "No summary yet: nobody wrote what this study compares, why, and what it found."
                : "These runs share a study ID, but nobody recorded what the study is for. Record it to give it a title, a description, a baseline and the metrics that decide it."}{" "}
              <button type="button" className="link" onClick={() => setRecording(true)}>
                {rec ? "Write one" : "Record it"}
              </button>
            </p>
          )}
        </div>
        <p className="faint small ph-meta">
          {d.variants.length} variants · {d.variants.reduce((n, v) => n + v.runs.length, 0)} runs ·{" "}
          <span className="mono">{d.study_id}</span>
        </p>
      </header>
      <ErrorBox error={gen.error} />
      {recording ? (
        <StudyForm
          pid={props.pid}
          id={d.study_id}
          variants={d.variants.map((v) => v.variant_id)}
          record={full.data?.record}
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            s.reload();
            full.reload();
          }}
        />
      ) : null}
      {d.variants.length === 0 ? (
        <Empty>
          No runs yet. Launch jobs with study <code>{d.study_id}</code> and a variant
          {rec?.variants?.length ? ` (${rec.variants.map((v) => v.variant_id).join(", ")})` : ""}.
        </Empty>
      ) : (
        <section className="card">
          <h2>
            Results
            <span className="row small" style={{ marginLeft: "auto", fontWeight: 400 }}>
              <label className="row small">
                baseline
                <select
                  value={base}
                  onChange={(e) => setBaseline(e.target.value)}
                  aria-label="Baseline variant"
                >
                  {d.variants.map((v) => (
                    <option key={v.variant_id} value={v.variant_id}>
                      {v.variant_id}
                    </option>
                  ))}
                </select>
              </label>
              {goalKeys.length && goalKeys.length < visible.length ? (
                <label className="row small">
                  <input
                    type="checkbox"
                    checked={allMetrics}
                    onChange={(e) => setAllMetrics(e.target.checked)}
                  />
                  all metrics
                </label>
              ) : null}
              <label className="row small">
                <input
                  type="checkbox"
                  checked={showSystem}
                  onChange={(e) => setShowSystem(e.target.checked)}
                />
                system metrics
              </label>
            </span>
          </h2>
          <p className="faint small">
            {goalKeys.length && !allMetrics ? "The metrics that decide the study. " : ""}
            Each cell is the mean of the latest value over a variant's runs, ± sample standard
            deviation, with n runs; the best mean is marked. Differences are against the baseline;
            with n &lt; 2 there is no spread estimate, so treat a single-run difference as
            unreplicated.
          </p>
          <div className="table-wrap">
            <table data-testid="ablation-table">
              <thead>
                <tr>
                  <th>Variant</th>
                  <th className="num">Runs</th>
                  {keys.map((k) => (
                    <th key={k} className="num mono">
                      {k} {better(k) ? "↓" : "↑"}
                      {goals.has(k) ? null : <span className="faint small"> (guessed)</span>}
                    </th>
                  ))}
                  {d.differing_params.map((p) => (
                    <th key={`p${p}`} className="mono">
                      {p}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.variant_id} className={v.variant_id === base ? "selected" : ""}>
                    <td className="variant">
                      <Link
                        to={`${props.base}/runs?study=${encodeURIComponent(d.study_id)}&variant=${encodeURIComponent(v.variant_id)}`}
                      >
                        {declared.get(v.variant_id)?.title ?? v.variant_id}
                      </Link>{" "}
                      {v.variant_id === base ? <Badge tone="info">baseline</Badge> : null}
                      {rec && declared.size && !declared.has(v.variant_id) ? (
                        <Badge
                          tone="warn"
                          title="Runs carry this variant, but the study does not declare it"
                        >
                          undeclared
                        </Badge>
                      ) : null}
                      {declared.get(v.variant_id)?.title ? (
                        <div className="faint small mono">{v.variant_id}</div>
                      ) : null}
                      {v.varying_params.length ? (
                        <div className="faint small">varies: {v.varying_params.join(", ")}</div>
                      ) : null}
                    </td>
                    <td className="num">{v.runs.length}</td>
                    {keys.map((k) => {
                      const st = v.metrics[k];
                      const b = baseV?.metrics[k];
                      return (
                        <td
                          key={k}
                          className={st && st.mean === best(k) ? "num best" : "num"}
                          title={st ? String(st.mean) : undefined}
                        >
                          {st ? (
                            <>
                              {fmtNum(st.mean, 5)}
                              {st.std !== undefined ? (
                                <span className="faint"> ± {fmtNum(st.std, 2)}</span>
                              ) : null}
                              <span className="faint small"> n={st.n}</span>
                              {v.variant_id !== base && b ? (
                                <div className="faint small">
                                  {fmtDelta(delta(st.mean, b.mean))}
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                      );
                    })}
                    {d.differing_params.map((p) => (
                      <td key={`p${p}`} className="mono small">
                        {v.params[p] ?? <span className="faint">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.truncated ? (
            <p className="faint small">Only the newest 5000 runs were scanned.</p>
          ) : null}
        </section>
      )}
      {d.variants.length ? (
        <section className="card">
          <h2>Curves (newest run per variant)</h2>
          <MetricCharts runs={chartRuns} keys={keys.slice(0, 6)} />
        </section>
      ) : null}
      {claims.length || hypotheses.length || reports.length || tasks.length ? (
        <div className="grid2 brief">
          <section className="card" data-testid="study-tests">
            <h2>What it tests</h2>
            {claims.length === 0 && hypotheses.length === 0 ? (
              <p className="faint small">No claim of the vault rests on this study yet.</p>
            ) : null}
            {claims.map((c) => {
              const st = STANDING[c.standing ?? "open"];
              return (
                <div key={c.note_id} className="titleline relrow">
                  <span className={`standing-word tone-${st?.tone ?? "info"}`}>{st?.label}</span>
                  <Link to={`${props.base}/standing?at=${encodeURIComponent(c.note_id)}`}>
                    {c.title}
                  </Link>
                </div>
              );
            })}
            {hypotheses.length ? (
              <>
                <h3 className="faint small">The original hypotheses</h3>
                {hypotheses.map((l) => (
                  <div key={l.id} className="small relrow">
                    <Link to={`${props.base}/knowledge/r/${encodeURIComponent(l.id)}`}>
                      {names[`hypothesis:${l.id}`]?.title ?? l.id}
                    </Link>
                  </div>
                ))}
              </>
            ) : null}
            {tasks.map((l) => (
              <div key={l.id} className="small faint" style={{ marginTop: 8 }}>
                Part of task{" "}
                <Link to={`${props.base}/tasks/${encodeURIComponent(l.id)}`}>
                  {names[`task:${l.id}`]?.title ?? l.id}
                </Link>
              </div>
            ))}
          </section>
          <section className="card" data-testid="study-conclusions">
            <h2>What was concluded</h2>
            {reports.length === 0 ? (
              <p className="faint small">
                No report draws on this study yet. The table below is live; a report is the written
                conclusion, with its evidence frozen.
              </p>
            ) : null}
            {reports.map((b) => (
              <RelatedItem
                key={b.record_id}
                base={props.base}
                item={{
                  kind: b.kind,
                  id: b.record_id,
                  name: compactName(b.title, b.status, b.summary),
                }}
              />
            ))}
          </section>
        </div>
      ) : null}
      {rec?.body ? (
        <section className="card" data-testid="study-body">
          <h2>Reading</h2>
          <Markdown text={rec.body} base={props.base} />
        </section>
      ) : null}
      {rec?.protocol || declared.size || d.variants.length ? (
        <details className="fold" data-testid="study-details">
          <summary className="fold-head">
            <h2>Design and runs</h2>
            <span className="faint small">
              The protocol, the variants and every run by variant.
            </span>
          </summary>
          <div className="stack">
            {rec?.protocol || declared.size ? (
              <section className="card" data-testid="study-design">
                <h2>Design</h2>
                {rec?.protocol ? (
                  <>
                    <h3>Protocol</h3>
                    <Markdown text={rec.protocol} base={props.base} />
                  </>
                ) : null}
                {declared.size ? (
                  <>
                    <h3>Variants</h3>
                    <div className="table-wrap">
                      <table>
                        <tbody>
                          {[...declared.values()].map((v) => (
                            <tr key={v.variant_id}>
                              <td className="mono small" style={{ whiteSpace: "nowrap" }}>
                                {v.variant_id}{" "}
                                {v.variant_id === rec?.baseline_variant ? (
                                  <Badge tone="info">baseline</Badge>
                                ) : null}
                                {neverRun.includes(v.variant_id) ? (
                                  <Badge
                                    tone="warn"
                                    title="Declared, but no run carries this variant"
                                  >
                                    no runs
                                  </Badge>
                                ) : null}
                              </td>
                              <td>
                                {v.title}
                                {v.description ? (
                                  <div className="muted small">{v.description}</div>
                                ) : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : null}
              </section>
            ) : null}
            {d.variants.length ? (
              <section className="card" data-testid="study-runs">
                <h2>Runs by variant</h2>
                {rows.map((v) => (
                  <div key={v.variant_id} className="relitem">
                    <h3>
                      {declared.get(v.variant_id)?.title ?? v.variant_id}{" "}
                      <span className="faint small">
                        {v.runs.length} {v.runs.length === 1 ? "run" : "runs"}
                      </span>
                    </h3>
                    {v.runs.map((r) => (
                      <div key={r.run_id} className="runline">
                        <div className="row small">
                          <Badge tone={runTone(r.status)}>{r.status}</Badge>
                          <Link to={`${props.base}/runs/r/${encodeURIComponent(r.run_id)}`}>
                            {r.run_name ?? shortId(r.run_id)}
                          </Link>
                          <span className="faint">{fmtTime(r.start_time)}</span>
                          {r.job_id ? (
                            <Link
                              to={`${props.base}/runs/jobs/${encodeURIComponent(r.job_id)}`}
                              className="faint"
                            >
                              job
                            </Link>
                          ) : null}
                        </div>
                        {r.summary ? (
                          <p className="muted rsum">{plainExcerpt(r.summary, 400)}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ))}
              </section>
            ) : null}
          </div>
        </details>
      ) : null}
      <details className="provenance">
        <summary className="small">Provenance: lineage</summary>
        <LineageStrip pid={props.pid} kind="study" id={d.study_id} base={props.base} />
      </details>
    </div>
  );
}

function compactName(title: string, status?: string, summary?: string): RefName {
  return { title, ...(status ? { status } : {}), ...(summary ? { summary } : {}) };
}

/** Create or edit a study record: its ID is the `study_id` tag runs carry. */
function StudyForm(props: {
  pid: string;
  id?: string;
  variants?: string[];
  /** The existing record, to edit it. */
  record?: ResearchRecord | undefined;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const r = props.record;
  const [id, setId] = useState(props.id ?? "");
  const [title, setTitle] = useState(r?.title ?? "");
  const [status, setStatus] = useState(r?.status ?? "");
  const [summary, setSummary] = useState(r?.summary ?? "");
  const [body, setBody] = useState(r?.body ?? "");
  const [variants, setVariants] = useState(
    (r?.variants?.map((v) => v.variant_id) ?? props.variants ?? []).join(" "),
  );
  const [baseline, setBaseline] = useState(r?.baseline_variant ?? props.variants?.[0] ?? "");
  const [goals, setGoals] = useState(
    (r?.metric_goals ?? []).map((g) => `${g.key}:${g.goal}`).join(" "),
  );
  const [protocol, setProtocol] = useState(r?.protocol ?? "");
  const [links, setLinks] = useState((r?.links ?? []).map((l) => `${l.kind}:${l.id}`).join("\n"));
  const save = useAction(async () => {
    const vs = variants.split(/[\s,]+/).filter(Boolean);
    const mg = goals
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((g) => {
        const i = g.lastIndexOf(":");
        const goal = g.slice(i + 1);
        if (i <= 0 || (goal !== "min" && goal !== "max"))
          throw new Error(`a goal is KEY:min or KEY:max, got “${g}”`);
        return { key: g.slice(0, i), goal };
      });
    // Keep the titles and descriptions of variants that stay.
    const known = new Map((r?.variants ?? []).map((v) => [v.variant_id, v]));
    const fields: Record<string, unknown> = {
      title: title.trim() || id.trim(),
      variants: vs.map((v) => known.get(v) ?? { variant_id: v }),
      metric_goals: mg,
      links: parseLinks(links),
    };
    const unset: string[] = [];
    const opt = (k: string, v: string) => {
      if (v.trim()) fields[k] = v.trim();
      else if (r && (r as unknown as Record<string, unknown>)[k] !== undefined) unset.push(k);
    };
    opt("summary", summary);
    opt("body", body);
    opt("protocol", protocol);
    opt("baseline_variant", baseline);
    if (status) fields["status"] = status;
    const path = `/api/v1/projects/${encodeURIComponent(props.pid)}/research`;
    if (r)
      await api(`${path}/${encodeURIComponent(r.record_id)}`, {
        method: "PATCH",
        body: { ...fields, if_revision: r.revision, ...(unset.length ? { unset } : {}) },
      });
    else await api(path, { body: { kind: "study", id: id.trim(), ...fields } });
    props.onSaved(id.trim());
  });
  const vs = variants.split(/[\s,]+/).filter(Boolean);
  return (
    <Modal
      title={r ? `Edit study ${r.record_id}` : props.id ? `Record study ${props.id}` : "New study"}
      onClose={props.onClose}
      footer={
        <button
          type="button"
          className="primary"
          disabled={!id.trim() || save.busy}
          onClick={() => void save.run()}
        >
          Save study
        </button>
      }
    >
      <div className="stack">
        <ErrorBox error={save.error} />
        <label className="field">
          Study ID (the <code>study_id</code> tag on its runs)
          <input
            value={id}
            disabled={Boolean(props.id)}
            onChange={(e) => setId(e.target.value)}
            aria-label="Study ID"
          />
        </label>
        <label className="field">
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Study title"
          />
        </label>
        {r ? (
          <label className="field">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              {STUDY_STATUSES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field">
          Summary
          <textarea
            rows={4}
            value={summary}
            placeholder="What the study compares and why; once runs are in, what it found. Markdown; LaTeX as $…$."
            onChange={(e) => setSummary(e.target.value)}
            aria-label="Summary"
          />
        </label>
        <label className="field">
          Variants (space-separated IDs)
          <input
            value={variants}
            onChange={(e) => setVariants(e.target.value)}
            aria-label="Variants"
          />
        </label>
        <label className="field">
          Baseline variant
          <select
            value={baseline}
            onChange={(e) => setBaseline(e.target.value)}
            aria-label="Baseline"
          >
            <option value="">none</option>
            {vs.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Metric goals (KEY:min or KEY:max, space-separated)
          <input
            value={goals}
            onChange={(e) => setGoals(e.target.value)}
            aria-label="Metric goals"
          />
        </label>
        <label className="field">
          Evaluation protocol
          <textarea
            rows={4}
            value={protocol}
            onChange={(e) => setProtocol(e.target.value)}
            aria-label="Protocol"
          />
        </label>
        <label className="field">
          Reading (Markdown)
          <textarea
            rows={8}
            value={body}
            placeholder="The in-depth read: why this comparison, what each variant changes, how to read the result."
            onChange={(e) => setBody(e.target.value)}
            aria-label="Reading"
          />
        </label>
        <label className="field">
          Links (KIND:ID per line, e.g. hypothesis:hyp-…)
          <textarea
            rows={2}
            className="mono"
            value={links}
            onChange={(e) => setLinks(e.target.value)}
            aria-label="Study links"
          />
        </label>
      </div>
    </Modal>
  );
}
