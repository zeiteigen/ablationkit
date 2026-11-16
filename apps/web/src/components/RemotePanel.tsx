/**
 * A remote attempt (ADR 0023): compute status and sync status side by side, provider state,
 * worker connectivity and spool, and the human actions: drain (deliver a leftover spool, never a
 * rerun), resolve an ambiguous outcome, download an exported Colab notebook, and mark an exported
 * notebook that will not report back lost (F29).
 */
import { useState } from "react";
import { api } from "../api.ts";
import {
  computeLabel,
  expectedBackBy,
  fmtComputeUnits,
  fmtTime,
  workerLabel,
} from "../lib/format.ts";
import type { AttemptView } from "../lib/types.ts";
import { attemptTone, Badge, ErrorBox, KV, syncTone, type Tone, useAction } from "./ui.tsx";

function isLive(state: string): boolean {
  return state === "queued" || state === "starting" || state === "running";
}

function connTone(c: string): Tone {
  return c === "connected" ? "ok" : c === "disconnected" ? "warn" : "neutral";
}

export function RemotePanel(props: {
  jobId: string;
  attempt: AttemptView;
  /** The job's time limit, for when an exported notebook should be back. */
  runtimeMaxSec?: number;
  onChange: () => void;
}) {
  const a = props.attempt;
  const r = a.remote;
  const [note, setNote] = useState("");
  const base = `/api/v1/jobs/${encodeURIComponent(props.jobId)}/attempts/${encodeURIComponent(a.attempt_id)}/remote`;
  const drain = useAction(async () => {
    await api(`${base}/drain`, { body: {} });
    props.onChange();
  });
  const resolve = useAction(async () => {
    await api(`${base}/resolve`, { body: { note } });
    setNote("");
    props.onChange();
  });
  const [lostNote, setLostNote] = useState("");
  const markLost = useAction(async () => {
    await api(`${base}/resolve`, {
      body: { lost: true, ...(lostNote.trim() ? { note: lostNote.trim() } : {}) },
    });
    setLostNote("");
    props.onChange();
  });
  if (!r) return null;
  const spool = r.worker_spool;
  const exported = r.staging === "exported";
  // The coordinator's deadline (time limit plus slack); older attempts fall back to the limit alone.
  const backBy = r.expected_back_by ?? expectedBackBy(r.submitted_at, props.runtimeMaxSec);
  return (
    <section className="card" data-testid="remote-panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Remote: {r.target_id}</h2>
        <Badge tone="info">{r.target_kind}</Badge>
        <Badge tone={attemptTone(a.state)}>compute: {computeLabel(a.state, r)}</Badge>
        <Badge tone={syncTone(r.sync)} title="worker → coordinator delivery">
          sync: {r.sync.replace("_", " ")}
        </Badge>
        <Badge tone={connTone(r.connectivity)}>worker {workerLabel(a.state, r)}</Badge>
      </div>
      {r.reconcile_required ? (
        <div className="banner err" role="alert" style={{ marginTop: 8 }}>
          <strong>Reconciliation required.</strong> {r.reconcile_required}
          <div className="row" style={{ marginTop: 6 }}>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="what you checked on the target"
              aria-label="Resolution note"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="small"
              disabled={!note.trim() || resolve.busy}
              onClick={() => void resolve.run()}
            >
              Accept recorded outcome
            </button>
          </div>
          <div className="faint small">Nothing is rerun; this only records your decision.</div>
        </div>
      ) : null}
      {r.connectivity === "disconnected" && !r.reconcile_required ? (
        <p className="small" style={{ marginTop: 8 }}>
          The worker stopped reporting at {fmtTime(r.last_contact_at)}. The job continues under the
          target's own supervisor; live monitoring and cancellation are not guaranteed until it
          reconnects.
        </p>
      ) : null}
      {exported ? (
        <div className="small" style={{ marginTop: 8 }} data-testid="colab-help">
          <p>
            <strong>A notebook does not run unattended.</strong> The job runs only while a person
            keeps the notebook's tab open and the runtime connected; AblationKit hears nothing until
            the results are imported. A Colab target added with{" "}
            <code>ablationkit target add ID --kind colab --gpu L4</code> runs jobs unattended
            instead.
          </p>
          <p>
            <a href={`${base}/notebook`} download>
              Download the notebook
            </a>
            , or get one cell to paste into an empty Colab notebook with{" "}
            <code>ablationkit remote notebook {props.jobId} --loader</code>. Then bring the archive
            home with{" "}
            <code>
              ablationkit remote import {props.jobId} ak-{a.attempt_id}-state.tgz
            </code>{" "}
            (or <code>--base64 FILE</code> with the archive the notebook printed).
          </p>
          {isLive(a.state) && !r.overdue_at ? (
            <p className="faint">
              {backBy
                ? `Expected back by ${fmtTime(backBy)} (exported ${fmtTime(r.submitted_at)} plus the job's time limit and set-up slack). Past it the attempt shows as overdue; nothing fails it automatically.`
                : "No time limit is set, so there is no expected return time."}
            </p>
          ) : null}
          {r.marked_lost_at ? (
            <p className="faint" data-testid="remote-lost">
              Marked lost at {fmtTime(r.marked_lost_at)}: it ended unknown and released its parallel
              slot. Importing its archive still settles it.
            </p>
          ) : null}
        </div>
      ) : null}
      {exported && isLive(a.state) ? (
        <div
          className={`banner ${r.overdue_at ? "warn" : ""}`}
          role={r.overdue_at ? "alert" : undefined}
          style={{ marginTop: 8 }}
          data-testid="remote-overdue"
        >
          {r.overdue_at ? (
            <>
              <strong>Overdue.</strong> Expected back by {fmtTime(backBy)}; nothing has come back.
              If it ran, import its archive. If its runtime is gone, mark it lost: it ends unknown
              and frees its parallel slot. A late import still lands.
            </>
          ) : (
            <span className="small">
              If this notebook's runtime is gone (closed, deleted or disconnected before it
              finished), mark it lost. A late import still lands.
            </span>
          )}
          <div className="row" style={{ marginTop: 6 }}>
            <input
              value={lostNote}
              onChange={(e) => setLostNote(e.target.value)}
              placeholder="what happened (optional)"
              aria-label="Lost note"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="small"
              disabled={markLost.busy}
              onClick={() => void markLost.run()}
            >
              Mark lost
            </button>
          </div>
        </div>
      ) : null}
      <KV
        rows={[
          ["staging", r.staging_error ? `${r.staging} — ${r.staging_error}` : r.staging],
          [
            "provider",
            r.provider_job_id
              ? `${r.provider_job_id}${r.provider_state ? ` · ${r.provider_state}` : ""}${r.provider_checked_at ? ` (checked ${fmtTime(r.provider_checked_at)})` : ""}`
              : "—",
          ],
          ["worker", r.worker_host ? `${r.worker_host}` : "—"],
          ["last contact", fmtTime(r.last_contact_at)],
          ["imported", r.imported_at ? fmtTime(r.imported_at) : "—"],
          [
            "worker spool",
            spool
              ? `${spool.pending_events ?? 0} events, ${spool.pending_artifacts ?? 0} artifacts pending${spool.dropped_events ? `, ${spool.dropped_events} dropped` : ""}${spool.disk_pressure ? " · disk pressure" : ""}`
              : "—",
          ],
          ...(r.compute_units
            ? ([
                [
                  "compute units",
                  `${fmtComputeUnits(r.compute_units)} (an estimate from the account's rate)`,
                ],
              ] as [string, string][])
            : []),
          ["bundle", `${r.bundle_id} at ${r.source_commit.slice(0, 12)}`],
          ["drains", String(r.drains ?? 0)],
          ["sync error", r.sync_error ?? "—"],
        ]}
      />
      {!exported && r.staging === "submitted" ? (
        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="small"
            disabled={drain.busy}
            onClick={() => void drain.run()}
            title="Deliver what is left in the worker's spool; never reruns the job"
          >
            Drain spool
          </button>
          <span className="faint small">delivers leftover results; never reruns the job</span>
        </div>
      ) : null}
      <ErrorBox error={drain.error ?? resolve.error ?? markLost.error} />
    </section>
  );
}
