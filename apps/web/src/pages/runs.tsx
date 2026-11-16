/**
 * Runs (spec §2.2, §5.6 Runs row): run search, filter and pagination; parameters, tags and status;
 * selection for comparison; export; manual runs. Sub-pages: run detail, Studies, Compare, Jobs,
 * Experiments.
 */

import { useMemo, useState } from "react";
import { api, qs, useApi, useEvents } from "../api.ts";
import { plainExcerpt } from "../components/Markdown.tsx";
import {
  Badge,
  Empty,
  ErrorBox,
  Link,
  Loading,
  Modal,
  runTone,
  syncTone,
  Tabs,
  useAction,
} from "../components/ui.tsx";
import { fmtDuration, fmtNum, fmtShortTime, fmtTime, shortId } from "../lib/format.ts";
import type { ResearchRecord } from "../lib/research.ts";
import { buildFilter, rankMetricKeys } from "../lib/tables.ts";
import { AK_TAGS, importedFrom, type Run, type RunsPage, tagValue } from "../lib/types.ts";
import { type NavItem, runsTabs } from "../nav.ts";
import { navigate, setQuery, useLocation } from "../router.ts";
import { ComparePage } from "./compare.tsx";
import { ExperimentsPage } from "./experiments.tsx";
import { JobDetail, JobsPage } from "./jobs.tsx";
import { EntrypointsPage } from "./lifecycle.tsx";
import { RunDetail } from "./run-detail.tsx";
import { StudiesPage, StudyDetail } from "./studies.tsx";

export function RunsRouter(props: { pid: string; base: string; rest: string }) {
  const parts = props.rest.split("/").filter(Boolean);
  const head = parts[0] ?? "";
  const active = head === "r" || head === "" ? "runs" : head;
  const tab = (t: NavItem) => ({ id: t.id, label: t.label, to: `${props.base}${t.path}` });
  const tabs = runsTabs();
  let body: React.JSX.Element;
  if (head === "r" && parts[1])
    body = <RunDetail pid={props.pid} base={props.base} id={decodeURIComponent(parts[1])} />;
  else if (head === "studies" && parts[1])
    body = <StudyDetail pid={props.pid} base={props.base} study={decodeURIComponent(parts[1])} />;
  else if (head === "studies") body = <StudiesPage pid={props.pid} base={props.base} />;
  else if (head === "compare") body = <ComparePage pid={props.pid} base={props.base} />;
  else if (head === "jobs" && parts[1])
    body = <JobDetail pid={props.pid} base={props.base} jobId={decodeURIComponent(parts[1])} />;
  else if (head === "jobs") body = <JobsPage pid={props.pid} base={props.base} />;
  else if (head === "experiments") body = <ExperimentsPage pid={props.pid} />;
  else if (head === "entrypoints") body = <EntrypointsPage pid={props.pid} base={props.base} />;
  else body = <RunsList pid={props.pid} base={props.base} />;
  // A run, a study or a job is named in the trail, which leads back; its page has no tabs.
  const object = (head === "r" || head === "studies" || head === "jobs") && parts[1];
  return (
    <>
      {object ? null : (
        <Tabs items={tabs.primary.map(tab)} more={tabs.more.map(tab)} active={active} />
      )}
      {body}
    </>
  );
}

const STATUSES = ["", "RUNNING", "FINISHED", "FAILED", "KILLED", "SCHEDULED"];
const ORDERS: [string, string][] = [
  ["", "newest first"],
  ["attributes.start_time ASC", "oldest first"],
  ["attributes.run_name ASC", "name A→Z"],
];

function RunsList(props: { pid: string; base: string }) {
  const { query } = useLocation();
  const [selected, setSelected] = useState<string[]>([]);
  const [tokens, setTokens] = useState<string[]>([]);
  const [freeText, setFreeText] = useState(query.get("filter") ?? "");
  const [newRun, setNewRun] = useState(false);
  // At phone width the filters fold behind a button (ADR 0055).
  const [filtering, setFiltering] = useState(false);
  const status = query.get("status") ?? "";
  const study = query.get("study") ?? "";
  const variant = query.get("variant") ?? "";
  const view = query.get("view") ?? "active";
  const order = query.get("order") ?? "";
  const filter = buildFilter({ status, study, variant, filter: query.get("filter") });
  const page = tokens.at(-1);
  const path = `/api/v1/tracking/runs${qs({
    project: props.pid,
    filter,
    view,
    order_by: order,
    max_results: 50,
    page_token: page,
  })}`;
  const runs = useApi<RunsPage>(path);
  useEvents(() => runs.reload(), {
    project: props.pid,
    types: ["tracking.run.sync", "job.attempt.state"],
  });

  // The metrics the project's studies decide on lead the table's columns.
  const studies = useApi<{ records: ResearchRecord[] }>(
    `/api/v1/projects/${encodeURIComponent(props.pid)}/research?kind=study`,
  );
  const data = runs.data;
  const metricKeys = useMemo(() => {
    const goals = new Set(
      (studies.data?.records ?? []).flatMap((r) => (r.metric_goals ?? []).map((g) => g.key)),
    );
    return rankMetricKeys(
      (data?.runs ?? []).flatMap((r) => (r.data.metrics ?? []).map((m) => m.key)),
      goals,
    );
  }, [data, studies.data]);
  // A column whose value is the same on every row says nothing: Sync and Duration only when they vary.
  const same = (f: (r: Run) => string) => new Set((data?.runs ?? []).map(f)).size <= 1;
  const showSync = !same((r) => r.ablationkit.sync?.state ?? "");
  const showDuration = !same((r) => runDuration(r));

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const exportUrl = (format: string) =>
    `/api/v1/tracking/export${qs({
      ...(selected.length ? { runs: selected.join(",") } : { project: props.pid, filter, view }),
      format,
    })}`;

  return (
    <div className="stack">
      <button
        type="button"
        className="small phone-only"
        aria-expanded={filtering}
        onClick={() => setFiltering((f) => !f)}
      >
        Filter{filter ? " (on)" : ""} {filtering ? "▾" : "▸"}
      </button>
      <form
        className={`row runs-filter${filtering ? " open" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          setTokens([]);
          setQuery({ filter: freeText });
        }}
      >
        <input
          aria-label="MLflow filter"
          placeholder={"MLflow filter, e.g. metrics.loss < 0.5 and params.lr = '0.01'"}
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          style={{ flex: 1, minWidth: 260 }}
          className="mono"
        />
        <select
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setTokens([]);
            setQuery({ status: e.target.value });
          }}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s || "any status"}
            </option>
          ))}
        </select>
        <input
          aria-label="Study"
          placeholder="study"
          defaultValue={study}
          onBlur={(e) => setQuery({ study: e.target.value })}
          style={{ width: 120 }}
        />
        <input
          aria-label="Variant"
          placeholder="variant"
          defaultValue={variant}
          onBlur={(e) => setQuery({ variant: e.target.value })}
          style={{ width: 120 }}
        />
        <select aria-label="View" value={view} onChange={(e) => setQuery({ view: e.target.value })}>
          <option value="active">active</option>
          <option value="deleted">deleted</option>
          <option value="all">all</option>
        </select>
        <select
          aria-label="Order"
          value={order}
          onChange={(e) => setQuery({ order: e.target.value })}
        >
          {ORDERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button type="submit">Search</button>
      </form>
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={selected.length < 2 || selected.length > 20}
          onClick={() =>
            navigate(`${props.base}/runs/compare?runs=${encodeURIComponent(selected.join(","))}`)
          }
        >
          Compare {selected.length ? `(${selected.length})` : ""}
        </button>
        <a className="btn" href={exportUrl("csv")} download>
          Export CSV{selected.length ? " (selected)" : ""}
        </a>
        <a className="btn" href={exportUrl("json")} download>
          Export JSON
        </a>
        <button type="button" onClick={() => setNewRun(true)}>
          New manual run
        </button>
        <span className="faint small" style={{ marginLeft: "auto" }}>
          {filter ? <span className="mono">{filter}</span> : "all runs"}
        </span>
      </div>
      <ErrorBox error={runs.error} onRetry={runs.reload} />
      {data && !data.mlflow_available ? (
        <div className="banner warn">
          MLflow is unavailable{data.error ? ` (${data.error})` : ""}. Queued runs are listed below;
          console logs stay available on each job.
        </div>
      ) : null}
      {data?.pending_runs.length ? (
        <div className="card">
          <h3>Waiting for MLflow</h3>
          {data.pending_runs.map((p) => (
            <div key={p.mapping.ref} className="row small">
              <Badge tone={syncTone(p.sync.state)}>{p.sync.state}</Badge>
              <Link to={`${props.base}/runs/r/${encodeURIComponent(p.mapping.ref)}`}>
                {p.mapping.run_name ?? p.mapping.ref}
              </Link>
              {p.sync.last_error ? (
                <span className="faint">{p.sync.last_error.message}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {!data && runs.loading ? <Loading /> : null}
      {data && data.runs.length === 0 && data.mlflow_available ? (
        <Empty>No runs match. Submit a job or create a manual run.</Empty>
      ) : null}
      {data?.runs.length ? (
        <div className="table-wrap">
          <table data-testid="runs-table">
            <thead>
              <tr>
                <th />
                <th>Run</th>
                <th>Status</th>
                {showSync ? <th>Sync</th> : null}
                <th>Study / variant</th>
                <th>Started</th>
                {showDuration ? <th>Duration</th> : null}
                {metricKeys.map((k) => (
                  <th key={k} className="num">
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <RunRow
                  key={r.info.run_id}
                  run={r}
                  base={props.base}
                  metricKeys={metricKeys}
                  showSync={showSync}
                  showDuration={showDuration}
                  selected={selected.includes(r.info.run_id)}
                  onToggle={() => toggle(r.info.run_id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="row">
        <button
          type="button"
          disabled={tokens.length === 0}
          onClick={() => setTokens((t) => t.slice(0, -1))}
        >
          ← Previous
        </button>
        <span className="faint small">page {tokens.length + 1}</span>
        <button
          type="button"
          disabled={!data?.next_page_token}
          onClick={() => {
            const t = data?.next_page_token;
            if (t) setTokens((ts) => [...ts, t]);
          }}
        >
          Next →
        </button>
      </div>
      {newRun ? (
        <NewRunDialog
          pid={props.pid}
          onClose={() => setNewRun(false)}
          onCreated={(ref) => {
            setNewRun(false);
            navigate(`${props.base}/runs/r/${encodeURIComponent(ref)}`);
          }}
        />
      ) : null}
    </div>
  );
}

function RunRow(props: {
  run: Run;
  base: string;
  metricKeys: string[];
  showSync: boolean;
  showDuration: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const r = props.run;
  const metric = (k: string) => r.data.metrics?.find((m) => m.key === k)?.value;
  const study = tagValue(r, AK_TAGS.study);
  const variant = tagValue(r, AK_TAGS.variant);
  const sync = r.ablationkit.sync?.state;
  return (
    <tr className={props.selected ? "selected" : ""}>
      <td>
        <input
          type="checkbox"
          checked={props.selected}
          onChange={props.onToggle}
          aria-label={`select ${r.info.run_name ?? r.info.run_id}`}
        />
      </td>
      <td>
        <Link to={`${props.base}/runs/r/${encodeURIComponent(r.info.run_id)}`}>
          {r.info.run_name ?? shortId(r.info.run_id)}
        </Link>
        {r.ablationkit.read_only ? <Badge>imported</Badge> : null}
        {importedFrom(r) ? (
          <Badge
            title={`Imported from ${importedFrom(r)}: run before the project used AblationKit`}
          >
            imported
          </Badge>
        ) : null}
        {r.info.lifecycle_stage === "deleted" ? <Badge tone="warn">deleted</Badge> : null}
        {tagValue(r, AK_TAGS.summary) ? (
          <div className="muted runsum" title={plainExcerpt(tagValue(r, AK_TAGS.summary), 600)}>
            {plainExcerpt(tagValue(r, AK_TAGS.summary), 200)}
          </div>
        ) : null}
      </td>
      <td>
        <Badge tone={runTone(r.info.status)}>{r.info.status}</Badge>
      </td>
      {props.showSync ? (
        <td>
          {sync ? <Badge tone={syncTone(sync)}>{sync}</Badge> : <span className="faint">—</span>}
        </td>
      ) : null}
      <td className="small nowrap">
        {study ? (
          <Link to={`${props.base}/runs/studies/${encodeURIComponent(study)}`}>{study}</Link>
        ) : (
          <span className="faint">—</span>
        )}
        {variant ? <div className="faint">{variant}</div> : null}
      </td>
      <td className="small nowrap" title={fmtTime(r.info.start_time)}>
        {fmtShortTime(r.info.start_time)}
      </td>
      {props.showDuration ? <td className="small nowrap">{runDuration(r)}</td> : null}
      {props.metricKeys.map((k) => (
        <td key={k} className="num">
          {fmtNum(metric(k))}
        </td>
      ))}
    </tr>
  );
}

function runDuration(r: Run): string {
  return r.info.start_time && r.info.end_time
    ? fmtDuration(r.info.end_time - r.info.start_time)
    : "—";
}

function NewRunDialog(props: {
  pid: string;
  onClose: () => void;
  onCreated: (ref: string) => void;
}) {
  const [name, setName] = useState("");
  const [study, setStudy] = useState("");
  const [variant, setVariant] = useState("");
  const [params, setParams] = useState("");
  const [metrics, setMetrics] = useState("");
  const create = useAction(async () => {
    const kv = (text: string) =>
      Object.fromEntries(
        text
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const i = l.indexOf("=");
            if (i < 1) throw new Error(`expected key=value: ${l}`);
            return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
          }),
      );
    const m = kv(metrics);
    const now = Date.now();
    const r = await api<{ ref: string }>("/api/v1/tracking/runs", {
      body: {
        project_id: props.pid,
        ...(name ? { run_name: name } : {}),
        ...(study ? { study_id: study } : {}),
        ...(variant ? { variant_id: variant } : {}),
        params: kv(params),
        metrics: Object.entries(m).map(([key, v]) => {
          const value = Number(v);
          if (!Number.isFinite(value)) throw new Error(`metric ${key} is not a number`);
          return { key, value, timestamp: now, step: 0 };
        }),
      },
    });
    props.onCreated(r.ref);
  });
  return (
    <Modal
      title="New manual run"
      onClose={props.onClose}
      footer={
        <>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={create.busy}
            onClick={() => void create.run()}
          >
            Create run
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="muted small">
          A manual run records results produced outside an AblationKit job. It is written through
          the durable outbox, so it is created even while MLflow is down.
        </p>
        <label className="field">
          Run name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="row">
          <label className="field" style={{ flex: 1 }}>
            Study
            <input value={study} onChange={(e) => setStudy(e.target.value)} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Variant
            <input value={variant} onChange={(e) => setVariant(e.target.value)} />
          </label>
        </div>
        <label className="field">
          Parameters (key=value per line)
          <textarea
            rows={3}
            value={params}
            onChange={(e) => setParams(e.target.value)}
            className="mono"
          />
        </label>
        <label className="field">
          Metrics (key=value per line)
          <textarea
            rows={3}
            value={metrics}
            onChange={(e) => setMetrics(e.target.value)}
            className="mono"
          />
        </label>
        <ErrorBox error={create.error} />
      </div>
    </Modal>
  );
}
