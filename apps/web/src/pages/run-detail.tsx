/**
 * One run (spec §5.6 Runs row): status, provenance, parameters, tags, metrics and system metrics,
 * artifacts and console. `id` is an MLflow run ID or an AblationKit ref (attempt ID, `mr-…`).
 * Compute status (job attempt) and sync status (MLflow delivery) are shown separately.
 */
import { useState } from "react";
import { api, useApi, useEvents } from "../api.ts";
import { ArtifactBrowser } from "../components/Artifacts.tsx";
import { ConsoleViewer } from "../components/Console.tsx";
import { ExtensionFrame, type ExtensionMount } from "../components/ExtensionFrame.tsx";
import { LineageStrip } from "../components/Lineage.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { MetricCharts } from "../components/MetricCharts.tsx";
import {
  attemptTone,
  Badge,
  ErrorBox,
  KV,
  Link,
  Loading,
  Modal,
  runTone,
  syncTone,
  TrailActions,
  TrailLeaf,
  useAction,
  usePageProject,
} from "../components/ui.tsx";
import { delta, fmtDelta, fmtDuration, fmtNum, fmtTime } from "../lib/format.ts";
import { statusTone } from "../lib/research.ts";
import { lowerIsBetter } from "../lib/tables.ts";
import {
  AK_TAGS,
  type AttemptView,
  importedFrom,
  isReservedTag,
  type Metric,
  type Run,
  type RunMapping,
  type SyncSummary,
  tagValue,
} from "../lib/types.ts";
import { RunLifecycleCard } from "./lifecycle.tsx";

interface RunResp {
  run?: Run;
  ref?: string;
  state?: string;
  mapping?: RunMapping;
  sync?: SyncSummary;
  mlflow_available?: boolean;
  error?: string;
}

type Section = "overview" | "metrics" | "system" | "artifacts" | "console" | `ext:${string}`;

export function RunDetail(props: { pid: string; base: string; id: string }) {
  const r = useApi<RunResp>(`/api/v1/tracking/runs/${encodeURIComponent(props.id)}`);
  const [section, setSection] = useState<Section>(() => {
    const q = new URLSearchParams(location.search).get("section");
    return q === "metrics" || q === "system" || q === "artifacts" || q === "console"
      ? q
      : "overview";
  });
  const tabs = useApi<{ mounts: ExtensionMount[] }>(
    `/api/v1/projects/${encodeURIComponent(props.pid)}/extension-mounts?point=run.tab`,
  );
  useEvents(
    (e) => {
      const p = e.payload;
      if (p["ref"] === props.id || p["mlflow_run_id"] === props.id || p["attempt_id"] === props.id)
        r.reload();
    },
    {
      project: props.pid,
      types: [
        "tracking.run.sync",
        "tracking.run.described",
        "job.attempt.state",
        "job.artifact.uploaded",
      ],
    },
  );

  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const d = r.data as RunResp;
  const run = d.run;
  const mapping = run?.ablationkit.mapping ?? d.mapping;
  const sync = run?.ablationkit.sync ?? d.sync;
  const runId = run?.info.run_id ?? mapping?.mlflow_run_id;
  const attemptId = mapping?.attempt_id ?? (run ? tagValue(run, AK_TAGS.attempt) : undefined);
  const jobId = mapping?.job_id ?? (run ? tagValue(run, AK_TAGS.job) : undefined);

  const sections: [Section, string][] = [
    ["overview", "Overview"],
    ["metrics", "Metrics"],
    ["system", "System metrics"],
    ["artifacts", "Artifacts"],
    ...(attemptId && jobId ? ([["console", "Console"]] as [Section, string][]) : []),
    ...(runId
      ? (tabs.data?.mounts ?? []).map((m): [Section, string] => [
          `ext:${m.extension_id}/${m.contribution.id}`,
          m.contribution.title,
        ])
      : []),
  ];
  const extTab = section.startsWith("ext:")
    ? (tabs.data?.mounts ?? []).find(
        (m) => `ext:${m.extension_id}/${m.contribution.id}` === section,
      )
    : undefined;

  return (
    <div className="stack">
      <RunHeader
        pid={props.pid}
        base={props.base}
        run={run}
        mapping={mapping}
        sync={sync}
        onChanged={r.reload}
      />
      {run ? (
        <RunDescription pid={props.pid} base={props.base} run={run} onChanged={r.reload} />
      ) : null}
      {d.mlflow_available === false ? (
        <div className="banner warn">
          MLflow is unavailable ({d.error}). The run's console and job state are still available.
        </div>
      ) : null}
      {!run && d.state === "tracking_pending" ? (
        <div className="banner warn">
          Waiting for MLflow to acknowledge this run. Metrics and artifacts appear once it syncs.
        </div>
      ) : null}
      <nav className="tabs" aria-label="Run sections">
        {sections.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={section === id ? "active" : ""}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {section === "overview" ? (
        <Overview
          pid={props.pid}
          base={props.base}
          run={run}
          mapping={mapping}
          onChanged={r.reload}
        />
      ) : null}
      {section === "metrics" && runId ? <MetricsSection runId={runId} system={false} /> : null}
      {section === "system" && runId ? <MetricsSection runId={runId} system /> : null}
      {section === "artifacts" && runId ? <ArtifactBrowser runId={runId} /> : null}
      {(section === "metrics" || section === "system" || section === "artifacts") && !runId ? (
        <p className="muted">Not available until MLflow acknowledges the run.</p>
      ) : null}
      {section === "console" && jobId && attemptId ? (
        <ConsoleViewer jobId={jobId} attemptId={attemptId} />
      ) : null}
      {extTab && runId ? (
        <ExtensionFrame pid={props.pid} mount={extTab} context={{ run_id: runId }} />
      ) : null}
      <details className="provenance">
        <summary className="small">Provenance: lineage</summary>
        <LineageStrip
          pid={props.pid}
          kind="run"
          id={run?.info.run_id ?? mapping?.mlflow_run_id ?? props.id}
          base={props.base}
        />
      </details>
    </div>
  );
}

function RunHeader(props: {
  pid: string;
  base: string;
  run: Run | undefined;
  mapping: RunMapping | undefined;
  sync: SyncSummary | undefined;
  onChanged: () => void;
}) {
  const run = props.run;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(run?.info.run_name ?? "");
  const id = run?.info.run_id ?? props.mapping?.ref ?? "";
  const readOnly = run?.ablationkit.read_only ?? false;
  const manual = props.mapping?.kind === "manual";
  const patch = useAction(async (body: Record<string, unknown>) => {
    await api(`/api/v1/tracking/runs/${encodeURIComponent(id)}`, { method: "PATCH", body });
    setEditing(false);
    props.onChanged();
  });
  const end = useAction(async (status: string) => {
    await api(`/api/v1/tracking/runs/${encodeURIComponent(id)}/end`, { body: { status } });
    props.onChanged();
  });
  const deleted = run?.info.lifecycle_stage === "deleted";
  const project = usePageProject();
  const title = run?.info.run_name ?? props.mapping?.run_name ?? id;
  return (
    <header className="ph">
      <TrailLeaf>{title}</TrailLeaf>
      <TrailActions>
        {run && !readOnly && !editing ? (
          <button type="button" className="small" onClick={() => setEditing(true)}>
            Rename
          </button>
        ) : null}
        {run && manual && run.info.status === "RUNNING" ? (
          <>
            <button type="button" className="small" onClick={() => void end.run("FINISHED")}>
              Mark finished
            </button>
            <button type="button" className="small" onClick={() => void end.run("FAILED")}>
              Mark failed
            </button>
          </>
        ) : null}
        {run && !readOnly ? (
          <button
            type="button"
            className={`small${deleted ? "" : " danger"}`}
            onClick={() => void patch.run({ lifecycle: deleted ? "active" : "deleted" })}
          >
            {deleted ? "Restore" : "Delete"}
          </button>
        ) : null}
      </TrailActions>
      <div className="eyebrow">
        {project ? `${project} · run` : "Run"}
        {run ? <Badge tone={runTone(run.info.status)}>{run.info.status}</Badge> : null}
        {props.sync && props.sync.state !== "synced" ? (
          <Badge tone={syncTone(props.sync.state)} title={props.sync.last_error?.message}>
            sync: {props.sync.state}
          </Badge>
        ) : null}
        {readOnly ? <Badge>imported · read-only</Badge> : null}
        {run && importedFrom(run) ? (
          <Badge
            title={`Run before the project used AblationKit; imported from ${importedFrom(run)}${tagValue(run, AK_TAGS.importCommit) ? ` (reported commit ${tagValue(run, AK_TAGS.importCommit)})` : ""}`}
          >
            imported from {importedFrom(run)}
          </Badge>
        ) : null}
        {deleted ? <Badge tone="warn">deleted</Badge> : null}
      </div>
      {editing ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void patch.run({ name });
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Run name" />
          <button type="submit" className="primary small">
            Save
          </button>
          <button type="button" className="small" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <h1 data-testid="run-name">{title}</h1>
      )}
      <ErrorBox error={patch.error ?? end.error} />
    </header>
  );
}

/**
 * The run's description (ADR 0048): the short summary (what it tests and why, then what came
 * out), the in-depth notes, and where it stands in its study on the metrics that decide it.
 */
function RunDescription(props: { pid: string; base: string; run: Run; onChanged: () => void }) {
  const run = props.run;
  const summary = tagValue(run, AK_TAGS.summary);
  const notes = tagValue(run, AK_TAGS.notes);
  const study = tagValue(run, AK_TAGS.study);
  const variant = tagValue(run, AK_TAGS.variant);
  const [editing, setEditing] = useState(false);
  const [s, setS] = useState(summary ?? "");
  const [n, setN] = useState(notes ?? "");
  const save = useAction(async () => {
    await api(
      `/api/v1/projects/${encodeURIComponent(props.pid)}/runs/${encodeURIComponent(run.info.run_id)}/description`,
      { method: "PUT", body: { summary: s, notes: n } },
    );
    setEditing(false);
    props.onChanged();
  });
  const readOnly = run.ablationkit.read_only;
  return (
    <section className="card" data-testid="run-description">
      <h2>
        Description
        {readOnly ? null : (
          <button
            type="button"
            className="small"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              setS(summary ?? "");
              setN(notes ?? "");
              setEditing(true);
            }}
          >
            {summary || notes ? "Edit" : "Write one"}
          </button>
        )}
      </h2>
      {summary ? (
        <Markdown text={summary} base={props.base} testId="run-summary" lede />
      ) : (
        <p className="faint">
          No description: nobody wrote what this run tests, why, and what came out.
        </p>
      )}
      {study ? (
        <StudyStanding
          pid={props.pid}
          base={props.base}
          run={run}
          study={study}
          variant={variant}
        />
      ) : null}
      {notes ? (
        <>
          <h3 style={{ marginTop: 16 }}>Notes</h3>
          <Markdown text={notes} base={props.base} testId="run-notes" />
        </>
      ) : null}
      {editing ? (
        <Modal
          title="Describe this run"
          onClose={() => setEditing(false)}
          footer={
            <button
              type="button"
              className="primary"
              disabled={save.busy}
              onClick={() => void save.run()}
            >
              Save
            </button>
          }
        >
          <div className="stack">
            <ErrorBox error={save.error} />
            <label className="field">
              Summary
              <textarea
                rows={4}
                maxLength={2000}
                value={s}
                onChange={(e) => setS(e.target.value)}
                aria-label="Run summary"
                placeholder="What the run tests and why, what came out (the key numbers) and what that means."
              />
            </label>
            <label className="field">
              Notes (Markdown)
              <textarea
                rows={10}
                maxLength={8000}
                value={n}
                onChange={(e) => setN(e.target.value)}
                aria-label="Run notes"
                placeholder="The in-depth read: anything odd in the curves or logs, caveats, what to try next. Tables and LaTeX ($…$) render."
              />
            </label>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

interface StudyStandingResp {
  record?: {
    title?: string;
    status?: string;
    baseline_variant?: string;
    metric_goals?: { key: string; goal: "min" | "max" }[];
  };
  variants: { variant_id: string; metrics: Record<string, { n: number; mean: number }> }[];
}

/** This run against its study's baseline, on the metrics that decide the study. */
function StudyStanding(props: {
  pid: string;
  base: string;
  run: Run;
  study: string;
  variant: string | undefined;
}) {
  const s = useApi<StudyStandingResp>(
    `/api/v1/projects/${encodeURIComponent(props.pid)}/studies/${encodeURIComponent(props.study)}`,
  );
  const rec = s.data?.record;
  const baseId = rec?.baseline_variant;
  const baseV = s.data?.variants.find((v) => v.variant_id === baseId);
  const goals = rec?.metric_goals ?? [];
  const rows = goals.flatMap((g) => {
    const mine = props.run.data.metrics?.find((m) => m.key === g.key)?.value;
    if (mine === undefined) return [];
    const b = baseV?.metrics[g.key]?.mean;
    const min = g.goal ? g.goal === "min" : lowerIsBetter(g.key);
    const d = props.variant !== baseId ? delta(mine, b) : undefined;
    return [{ key: g.key, mine, b, d, good: d ? (min ? d.abs < 0 : d.abs > 0) : undefined }];
  });
  return (
    <div className="standing small" data-testid="run-standing">
      <div className="titleline">
        <span className="faint">In study </span>
        <Link to={`${props.base}/runs/studies/${encodeURIComponent(props.study)}`}>
          {rec?.title ?? props.study}
        </Link>{" "}
        {rec?.status ? <Badge tone={statusTone(rec.status)}>{rec.status}</Badge> : null}
        {props.variant ? (
          <>
            <span className="faint">as variant </span>
            <span className="mono">{props.variant}</span>{" "}
            {props.variant === baseId ? <Badge tone="info">baseline</Badge> : null}
          </>
        ) : null}
      </div>
      {rows.map((r) => (
        <div key={r.key} className="row">
          <span className="mono">{r.key}</span>
          <strong title={String(r.mine)}>{fmtNum(r.mine, 5)}</strong>
          {r.d && r.b !== undefined ? (
            <span className={r.good ? "good" : "bad"}>
              {fmtDelta(r.d)} against baseline {baseId} ({fmtNum(r.b, 5)})
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Overview(props: {
  pid: string;
  base: string;
  run: Run | undefined;
  mapping: RunMapping | undefined;
  onChanged: () => void;
}) {
  const run = props.run;
  const m = props.mapping;
  const study = m?.study_id ?? (run ? tagValue(run, AK_TAGS.study) : undefined);
  const variant = m?.variant_id ?? (run ? tagValue(run, AK_TAGS.variant) : undefined);
  const jobId = m?.job_id ?? (run ? tagValue(run, AK_TAGS.job) : undefined);
  const job = useApi<{ latest_attempt?: AttemptView; attempt_details?: AttemptView[] }>(
    jobId ? `/api/v1/jobs/${encodeURIComponent(jobId)}` : undefined,
  );
  const attempt =
    job.data?.attempt_details?.find((a) => a.attempt_id === m?.attempt_id) ??
    job.data?.latest_attempt;
  const metrics = (run?.data.metrics ?? []).filter((x) => !x.key.startsWith("system/"));
  const start = run?.info.start_time;
  const endT = run?.info.end_time;
  return (
    <div className="grid2">
      <div>
        <section className="card">
          <h3>Run</h3>
          <KV
            rows={[
              [
                "MLflow run",
                run ? (
                  <span className="mono" key="r">
                    {run.info.run_id}
                  </span>
                ) : (
                  "pending"
                ),
              ],
              ["experiment", run?.info.experiment_id ?? m?.experiment_id ?? "—"],
              ["AblationKit ref", m?.ref ?? "—"],
              ["kind", m?.kind ?? "external"],
              ["started", fmtTime(start)],
              ["ended", fmtTime(endT)],
              ["duration", start && endT ? fmtDuration(endT - start) : "—"],
              [
                "study / variant",
                study ? (
                  <span key="s">
                    <Link to={`${props.base}/runs/studies/${encodeURIComponent(study)}`}>
                      {study}
                    </Link>
                    {variant ? ` / ${variant}` : ""}
                  </span>
                ) : (
                  "—"
                ),
              ],
              ["artifact URI", run?.info.artifact_uri ?? "—"],
            ]}
          />
        </section>
        {jobId ? (
          <section className="card">
            <h3>
              Job <Link to={`${props.base}/runs/jobs/${encodeURIComponent(jobId)}`}>{jobId}</Link>
            </h3>
            {attempt ? (
              <KV
                rows={[
                  [
                    "compute status",
                    <Badge key="c" tone={attemptTone(attempt.state)}>
                      {attempt.state}
                    </Badge>,
                  ],
                  ["attempt", `#${attempt.number} ${attempt.attempt_id}`],
                  [
                    "exit",
                    attempt.exit_code !== undefined
                      ? `code ${attempt.exit_code}`
                      : (attempt.signal ?? "—"),
                  ],
                  ["host", String(attempt.snapshot?.["hostname"] ?? "—")],
                  [
                    "source",
                    attempt.snapshot?.["source_commit"]
                      ? `${String(attempt.snapshot["source_commit"]).slice(0, 12)}${attempt.snapshot["source_dirty"] ? " (dirty)" : ""}`
                      : "—",
                  ],
                ]}
              />
            ) : (
              <Loading />
            )}
          </section>
        ) : null}
        <RunLifecycleCard pid={props.pid} base={props.base} run={run} />
        <ParamsTable run={run} />
      </div>
      <div>
        <section className="card">
          <h3>Latest metrics</h3>
          {metrics.length === 0 ? <p className="muted small">No metrics.</p> : null}
          {metrics.length ? (
            <div className="table-wrap">
              <table>
                <tbody>
                  {metrics
                    .slice()
                    .sort((a, b) => a.key.localeCompare(b.key))
                    .map((x: Metric) => (
                      <tr key={x.key}>
                        <td className="mono small">{x.key}</td>
                        <td className="num">{fmtNum(x.value, 6)}</td>
                        <td className="num faint small">step {x.step}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
        {run ? <TagsEditor run={run} onChanged={props.onChanged} /> : null}
      </div>
    </div>
  );
}

function ParamsTable(props: { run: Run | undefined }) {
  const params = props.run?.data.params ?? [];
  const [q, setQ] = useState("");
  const shown = params.filter((p) => !q || p.key.toLowerCase().includes(q.toLowerCase()));
  return (
    <section className="card">
      <h3>
        Parameters <Badge>{params.length}</Badge>
        {params.length > 8 ? (
          <input
            placeholder="filter"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ marginLeft: "auto", width: 140 }}
            aria-label="Filter parameters"
          />
        ) : null}
      </h3>
      {params.length === 0 ? <p className="muted small">No parameters.</p> : null}
      {shown.length ? (
        <div className="table-wrap">
          <table data-testid="params-table">
            <tbody>
              {shown
                .slice()
                .sort((a, b) => a.key.localeCompare(b.key))
                .map((p) => (
                  <tr key={p.key}>
                    <td className="mono small">{p.key}</td>
                    <td className="mono small wrap">{p.value}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function TagsEditor(props: { run: Run; onChanged: () => void }) {
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const id = props.run.info.run_id;
  const readOnly = props.run.ablationkit.read_only;
  const tags = (props.run.data.tags ?? []).filter((t) => showSystem || !isReservedTag(t.key));
  const set = useAction(async () => {
    await api(`/api/v1/tracking/runs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { tags: { [k]: v } },
    });
    setK("");
    setV("");
    props.onChanged();
  });
  const del = useAction(async (key: string) => {
    await api(`/api/v1/tracking/runs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { delete_tags: [key] },
    });
    props.onChanged();
  });
  return (
    <section className="card">
      <h3>
        Tags
        <label className="row small" style={{ marginLeft: "auto", fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={showSystem}
            onChange={(e) => setShowSystem(e.target.checked)}
          />
          show system tags
        </label>
      </h3>
      <ErrorBox error={set.error ?? del.error} />
      {tags.length ? (
        <div className="table-wrap">
          <table data-testid="tags-table">
            <tbody>
              {tags.map((t) => (
                <tr key={t.key}>
                  <td className="mono small">{t.key}</td>
                  <td className="mono small wrap">{t.value}</td>
                  <td>
                    {!readOnly && !isReservedTag(t.key) ? (
                      <button
                        type="button"
                        className="small"
                        onClick={() => void del.run(t.key)}
                        aria-label={`delete tag ${t.key}`}
                      >
                        ✕
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No user tags.</p>
      )}
      {!readOnly ? (
        <form
          className="row"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void set.run();
          }}
        >
          <input
            placeholder="key"
            value={k}
            onChange={(e) => setK(e.target.value)}
            aria-label="Tag key"
          />
          <input
            placeholder="value"
            value={v}
            onChange={(e) => setV(e.target.value)}
            aria-label="Tag value"
          />
          <button type="submit" disabled={!k || set.busy}>
            Set tag
          </button>
        </form>
      ) : null}
      <p className="faint small">
        <code>ablationkit.*</code> and <code>mlflow.*</code> tags are the run mapping and cannot be
        edited.
      </p>
    </section>
  );
}

function MetricsSection(props: { runId: string; system: boolean }) {
  const m = useApi<{ metrics: Metric[]; system_metrics: Metric[]; state?: string }>(
    `/api/v1/tracking/runs/${encodeURIComponent(props.runId)}/metrics`,
  );
  const [filter, setFilter] = useState("");
  if (m.error) return <ErrorBox error={m.error} onRetry={m.reload} />;
  if (!m.data) return <Loading />;
  const list = props.system ? m.data.system_metrics : m.data.metrics;
  const keys = list
    .map((x) => x.key)
    .filter((k) => !filter || k.toLowerCase().includes(filter.toLowerCase()))
    .sort();
  if (list.length === 0)
    return (
      <p className="muted">
        {props.system
          ? "No system metrics. MLflow logs CPU, memory and GPU usage under system/… when system metrics logging is enabled for the run."
          : "No metrics logged yet."}
      </p>
    );
  return (
    <div className="stack">
      {list.length > 6 ? (
        <input
          placeholder="filter metrics"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ maxWidth: 260 }}
          aria-label="Filter metrics"
        />
      ) : null}
      <MetricCharts
        runs={[{ id: props.runId, label: props.runId.slice(0, 8) }]}
        keys={keys.slice(0, 24)}
      />
      {keys.length > 24 ? (
        <p className="faint small">Showing 24 of {keys.length}; filter to narrow.</p>
      ) : null}
    </div>
  );
}
