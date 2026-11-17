/**
 * Jobs and console logs (spec §2.2 Runs; ADR 0011). Compute status (attempt state) and sync
 * status (MLflow delivery) are shown side by side; resource limits carry their enforcement label
 * and advisory limits are never shown as enforced.
 */
import { useState } from "react";
import { api, useApi, useEvents } from "../api.ts";
import { ConsoleViewer } from "../components/Console.tsx";
import { LineageStrip } from "../components/Lineage.tsx";
import { RemotePanel } from "../components/RemotePanel.tsx";
import {
  attemptTone,
  Badge,
  Empty,
  EnforcementBadge,
  ErrorBox,
  KV,
  Link,
  Loading,
  Modal,
  syncTone,
  TrailActions,
  TrailLeaf,
  useAction,
  usePageProject,
} from "../components/ui.tsx";
import { useAgentSessions } from "../lib/agent-sessions.ts";
import { computeLabel, fmtBytes, fmtDuration, fmtTime, shortId } from "../lib/format.ts";
import { type LaunchForm, launchBody } from "../lib/launch.ts";
import type { AttemptView, JobView } from "../lib/types.ts";
import { navigate, setQuery, useLocation } from "../router.ts";

const ACTIVE = new Set(["starting", "running"]);

export function JobsPage(props: { pid: string; base: string }) {
  const { query } = useLocation();
  const jobs = useApi<{ jobs: JobView[] }>(
    `/api/v1/projects/${encodeURIComponent(props.pid)}/jobs?limit=200`,
  );
  useEvents(() => jobs.reload(), {
    project: props.pid,
    types: [
      "job.state",
      "job.attempt.state",
      "tracking.run.sync",
      "job.attempt.remote",
      "job.worker.disconnected",
      "job.worker.reconnected",
    ],
  });
  const launching = query.get("launch") === "1";
  return (
    <div className="stack">
      <div className="row">
        <button type="button" className="primary" onClick={() => setQuery({ launch: "1" })}>
          Launch job
        </button>
        <span className="faint small">
          Agents submit jobs through <code>ablationkit mcp</code>, within the project policy and its
          compute limit. AblationKit places each on a target of the pool the policy allows, queued
          until one has a free slot.
        </span>
      </div>
      <ErrorBox error={jobs.error} onRetry={jobs.reload} />
      {!jobs.data ? <Loading /> : null}
      {jobs.data?.jobs.length === 0 ? <Empty>No jobs yet.</Empty> : null}
      {jobs.data?.jobs.length ? (
        <div className="table-wrap">
          <table data-testid="jobs-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Compute</th>
                <th>Sync</th>
                <th>Limits</th>
                <th>Command</th>
                <th>Study / variant</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.jobs.map((j) => {
                const a = j.latest_attempt;
                return (
                  <tr key={j.job_id}>
                    <td>
                      <Link to={`${props.base}/runs/jobs/${encodeURIComponent(j.job_id)}`}>
                        {j.run_name ?? shortId(j.job_id, 16)}
                      </Link>
                      {j.attempts.length > 1 ? (
                        <span className="faint small"> · {j.attempts.length} attempts</span>
                      ) : null}
                    </td>
                    <td>
                      <Badge tone={attemptTone(j.state)} title={j.placement?.waiting}>
                        {j.state}
                      </Badge>
                      {j.state === "queued" && j.placement?.waiting ? (
                        <span className="faint small"> · {j.placement.waiting}</span>
                      ) : null}
                      {j.placement?.error && !a ? (
                        <span className="faint small"> · {j.placement.error}</span>
                      ) : null}
                      {a?.remote ? (
                        <span className="faint small" title={a.remote.provider_state}>
                          {" "}
                          on {a.remote.target_id}
                          {a.remote.connectivity === "disconnected" ? " · worker disconnected" : ""}
                        </span>
                      ) : null}
                      {a?.remote?.reconcile_required ? (
                        <Badge tone="err" title={a.remote.reconcile_required}>
                          reconcile
                        </Badge>
                      ) : null}
                      {a?.remote?.overdue_at &&
                      (a.state === "starting" || a.state === "running") ? (
                        <Badge
                          tone="warn"
                          title={`expected back by ${a.remote.expected_back_by}; import it or mark it lost`}
                        >
                          overdue
                        </Badge>
                      ) : null}
                    </td>
                    <td>
                      {a?.remote && a.remote.sync !== "synced" ? (
                        <Badge tone={syncTone(a.remote.sync)} title="worker → coordinator">
                          worker {a.remote.sync.replace("_", " ")}
                        </Badge>
                      ) : null}
                      {a?.tracking.sync_state ? (
                        <Badge tone={syncTone(a.tracking.sync_state)}>
                          {a.tracking.sync_state}
                        </Badge>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>
                      {a ? (
                        <EnforcementBadge
                          enforcement={a.supervisor.enforcement}
                          mode={a.supervisor.mode}
                        />
                      ) : null}
                    </td>
                    <td className="mono small wrap">{j.command.join(" ").slice(0, 80)}</td>
                    <td className="small">
                      {j.study_id ?? "—"}
                      {j.variant_id ? ` / ${j.variant_id}` : ""}
                    </td>
                    <td className="small">{fmtTime(j.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {launching ? (
        <LaunchDialog
          pid={props.pid}
          onClose={() => setQuery({ launch: undefined })}
          onLaunched={(id) => navigate(`${props.base}/runs/jobs/${encodeURIComponent(id)}`)}
        />
      ) : null}
    </div>
  );
}

function LaunchDialog(props: {
  pid: string;
  onClose: () => void;
  onLaunched: (jobId: string) => void;
}) {
  const [f, setF] = useState<LaunchForm>({
    command: "",
    cwd: "",
    environment: "uv",
    memory: "",
    cpu: "",
    timeout: "",
    artifacts: "",
    metricsFile: "",
    runName: "",
    study: "",
    variant: "",
  });
  const sup = useApi<{ mode: string; enforcement: string; reason?: string }>(
    "/api/v1/jobs/supervisor",
  );
  const set = (k: keyof LaunchForm) => (e: { target: { value: string } }) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));
  const launch = useAction(async () => {
    const j = await api<JobView>(`/api/v1/projects/${encodeURIComponent(props.pid)}/jobs`, {
      body: launchBody(f),
    });
    props.onLaunched(j.job_id);
  });
  return (
    <Modal
      title="Launch job"
      onClose={props.onClose}
      footer={
        <>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!f.command.trim() || launch.busy}
            onClick={() => void launch.run()}
          >
            {launch.busy ? "Launching…" : "Launch"}
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="field">
          Command (run directly, not through a shell)
          <input
            className="mono"
            value={f.command}
            onChange={set("command")}
            placeholder="python train.py --lr 0.01"
            aria-label="Command"
          />
        </label>
        <div className="row">
          <label className="field" style={{ flex: 1 }}>
            Environment
            <select value={f.environment} onChange={set("environment")} aria-label="Environment">
              <option value="uv">project uv environment</option>
              <option value="none">none (system PATH)</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            Working directory (relative)
            <input
              value={f.cwd}
              onChange={set("cwd")}
              placeholder="."
              aria-label="Working directory"
            />
          </label>
        </div>
        <div className="row">
          <label className="field" style={{ flex: 1 }}>
            Memory
            <input
              value={f.memory}
              onChange={set("memory")}
              placeholder="4G"
              aria-label="Memory limit"
            />
          </label>
          <label className="field" style={{ flex: 1 }}>
            CPU %
            <input value={f.cpu} onChange={set("cpu")} placeholder="200" aria-label="CPU quota" />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Time limit
            <input
              value={f.timeout}
              onChange={set("timeout")}
              placeholder="2h"
              aria-label="Time limit"
            />
          </label>
        </div>
        {sup.data ? (
          <div className="small">
            <EnforcementBadge
              enforcement={sup.data.enforcement}
              mode={sup.data.mode}
              {...(sup.data.reason ? { reason: sup.data.reason } : {})}
            />{" "}
            {sup.data.enforcement === "advisory" ? (
              <span className="muted">
                Only the time limit is applied in direct mode; memory and CPU are not enforced.
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="row">
          <label className="field" style={{ flex: 1 }}>
            Run name
            <input value={f.runName} onChange={set("runName")} aria-label="Run name" />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Study
            <input value={f.study} onChange={set("study")} aria-label="Study" />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Variant
            <input value={f.variant} onChange={set("variant")} aria-label="Variant" />
          </label>
        </div>
        <label className="field">
          Artifact globs (comma or newline separated)
          <input
            className="mono"
            value={f.artifacts}
            onChange={set("artifacts")}
            placeholder="outputs/*.json"
            aria-label="Artifact globs"
          />
        </label>
        <label className="field">
          Metrics file (for projects without the SDK)
          <input
            className="mono"
            value={f.metricsFile}
            onChange={set("metricsFile")}
            placeholder="outputs/metrics.jsonl"
            aria-label="Metrics file"
          />
        </label>
        <p className="faint small">
          <code>MLproject</code> entrypoints launch from Runs → Entrypoints.
        </p>
        <ErrorBox error={launch.error} />
      </div>
    </Modal>
  );
}

export function JobDetail(props: { pid: string; base: string; jobId: string }) {
  const j = useApi<JobView>(`/api/v1/jobs/${encodeURIComponent(props.jobId)}`);
  const [attemptSel, setAttemptSel] = useState<string>();
  const who = useAgentSessions(props.pid);
  const project = usePageProject();
  useEvents(
    (e) => {
      if (e.payload["job_id"] === props.jobId) j.reload();
    },
    {
      project: props.pid,
      types: [
        "job.state",
        "job.attempt.state",
        "job.artifact.uploaded",
        "tracking.run.sync",
        "job.attempt.remote",
        "job.worker.disconnected",
        "job.worker.reconnected",
      ],
    },
  );
  const cancel = useAction(async () => {
    await api(`/api/v1/jobs/${encodeURIComponent(props.jobId)}/cancel`, { body: {} });
    j.reload();
  });
  const retry = useAction(async () => {
    const a = await api<AttemptView>(`/api/v1/jobs/${encodeURIComponent(props.jobId)}/retry`, {
      body: {},
    });
    setAttemptSel(a.attempt_id);
    j.reload();
  });
  if (j.error) return <ErrorBox error={j.error} onRetry={j.reload} />;
  if (!j.data) return <Loading />;
  const job = j.data;
  const attempts = job.attempt_details ?? [];
  const a = attempts.find((x) => x.attempt_id === attemptSel) ?? job.latest_attempt;
  const queued = job.state === "queued";
  const active = queued || (a ? ACTIVE.has(a.state) : false);
  const runRef = a?.tracking.mlflow_run_id ?? a?.attempt_id;

  const name = job.run_name ?? job.job_id;
  return (
    <div className="stack">
      <header className="ph">
        <TrailLeaf>{name}</TrailLeaf>
        <TrailActions>
          {runRef ? (
            <Link className="btn small" to={`${props.base}/runs/r/${encodeURIComponent(runRef)}`}>
              Open run
            </Link>
          ) : null}
          <button
            type="button"
            className="small danger"
            disabled={!active || cancel.busy}
            onClick={() => void cancel.run()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="small"
            disabled={active || retry.busy}
            onClick={() => void retry.run()}
          >
            Retry
          </button>
        </TrailActions>
        <div className="eyebrow">
          {project ? `${project} · job` : "Job"}
          <Badge tone={attemptTone(job.state)}>
            compute: {computeLabel(job.state, job.latest_attempt?.remote)}
          </Badge>
          {a?.tracking.sync_state ? (
            <Badge tone={syncTone(a.tracking.sync_state)} title={a.tracking.last_error}>
              sync: {a.tracking.sync_state}
            </Badge>
          ) : null}
          {a ? (
            <EnforcementBadge
              enforcement={a.supervisor.enforcement}
              mode={a.supervisor.mode}
              {...(a.supervisor.reason ? { reason: a.supervisor.reason } : {})}
            />
          ) : null}
        </div>
        <h1>{name}</h1>
        <div className="mono small faint">{job.command.join(" ")}</div>
        <div className="small faint" data-testid="job-submitted-by">
          submitted by {who.actor(job.submitted_by)}
          {job.placement?.target
            ? ` · placed on ${job.placement.target === "local" ? "this machine" : job.placement.target}`
            : ""}
        </div>
        {queued ? (
          <div className="small" data-testid="job-queued">
            Queued since {fmtTime(job.placement?.queued_at ?? job.created_at)}
            {job.placement?.waiting ? `: ${job.placement.waiting}` : ""}. It starts on a target of
            the project's pool as soon as one has a free slot; Cancel takes it out of the queue.
          </div>
        ) : null}
        {job.placement?.error ? (
          <div className="small" data-testid="job-placement-error">
            {job.placement.error}
          </div>
        ) : null}
        <ErrorBox error={cancel.error ?? retry.error} />
      </header>
      {attempts.length > 1 ? (
        <nav className="tabs" aria-label="Attempts">
          {attempts.map((x) => (
            <button
              key={x.attempt_id}
              type="button"
              className={x.attempt_id === a?.attempt_id ? "active" : ""}
              onClick={() => setAttemptSel(x.attempt_id)}
            >
              #{x.number} <Badge tone={attemptTone(x.state)}>{x.state}</Badge>
            </button>
          ))}
        </nav>
      ) : null}
      {a ? (
        <div className="grid2">
          <section className="card">
            <h3>Attempt #{a.number}</h3>
            <KV
              rows={[
                [
                  "attempt",
                  <span key="a" className="mono">
                    {a.attempt_id}
                  </span>,
                ],
                [
                  "state",
                  <Badge key="s" tone={attemptTone(a.state)}>
                    {a.state}
                  </Badge>,
                ],
                ["started", fmtTime(a.started_at)],
                ["ended", fmtTime(a.ended_at)],
                [
                  "duration",
                  a.started_at && a.ended_at
                    ? fmtDuration(Date.parse(a.ended_at) - Date.parse(a.started_at))
                    : "—",
                ],
                ["exit", a.exit_code !== undefined ? `code ${a.exit_code}` : (a.signal ?? "—")],
                ["systemd result", a.unit_result ?? "—"],
                ["error", a.error ?? "—"],
                [
                  "limits",
                  Object.entries(job.limits)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(", ") || "none",
                ],
                [
                  "supervisor",
                  `${a.supervisor.mode}${a.supervisor.reason ? ` — ${a.supervisor.reason}` : ""}`,
                ],
              ]}
            />
          </section>
          <section className="card">
            <h3>Provenance and tracking</h3>
            <KV
              rows={[
                ["host", String(a.snapshot?.["hostname"] ?? "—")],
                ["commit", String(a.snapshot?.["source_commit"] ?? "—")],
                [
                  "dirty",
                  a.snapshot?.["source_dirty"] === undefined
                    ? "—"
                    : String(a.snapshot["source_dirty"]),
                ],
                ["python", String(a.snapshot?.["python"] ?? "—")],
                ["SDK", String(a.snapshot?.["sdk_version"] ?? "—")],
                ["MLflow run", a.tracking.mlflow_run_id ?? "pending"],
                ["pending writes", String(a.tracking.pending_ops ?? 0)],
                ["failed writes", String(a.tracking.failed_ops ?? 0)],
                [
                  "ingest",
                  a.ingest
                    ? `${a.ingest.accepted} accepted, ${a.ingest.duplicates} duplicates, ${a.ingest.rejected} rejected`
                    : "—",
                ],
              ]}
            />
            {a.artifacts.length ? (
              <>
                <h3 style={{ marginTop: 10 }}>Uploaded artifacts</h3>
                {a.artifacts.map((x) => (
                  <div key={x.path} className="row small">
                    <span className="mono">{x.path}</span>
                    <span className="faint">{fmtBytes(x.size)}</span>
                    <span className="faint mono" title="SHA-256">
                      {x.sha256.slice(0, 12)}
                    </span>
                  </div>
                ))}
              </>
            ) : null}
          </section>
        </div>
      ) : null}
      {a?.remote ? (
        <RemotePanel
          jobId={job.job_id}
          attempt={a}
          {...(job.limits["runtime_max_sec"]
            ? { runtimeMaxSec: job.limits["runtime_max_sec"] }
            : {})}
          onChange={j.reload}
        />
      ) : null}
      {a ? (
        <section className="card">
          <h2>Console</h2>
          <ConsoleViewer key={a.attempt_id} jobId={job.job_id} attemptId={a.attempt_id} />
        </section>
      ) : null}
      <details className="provenance">
        <summary className="small">Provenance: lineage</summary>
        <LineageStrip pid={props.pid} kind="job" id={job.job_id} base={props.base} />
      </details>
    </div>
  );
}
