/**
 * Startup diagnostics (spec §13; ADR 0025): "interrupted JSON replacements, partial JSONL tails,
 * stalled MLflow updates, orphaned tracking runs, unavailable workers, missing artifacts, and
 * pending outbox entries". Computed once when the coordinator starts (non-ok checks are logged)
 * and again on demand for the System page. Read-only: it reports, it never repairs.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_ATTEMPT_STATES } from "@ablationkit/protocol";
import type { Services } from "../services.ts";
import type { CheckStatus } from "../tracking/doctor.ts";
import { readRestoreRecord } from "./restore.ts";

export interface DiagnosticCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** Up to 20 affected items (paths, refs, attempt IDs). */
  readonly items?: readonly string[];
}

export interface SystemDiagnostics {
  readonly at: string;
  readonly status: CheckStatus;
  readonly checks: readonly DiagnosticCheck[];
}

/** An MLflow write still queued after this long is "stalled". */
export const STALLED_AFTER_MS = 10 * 60 * 1000;
const MAX_ITEMS = 20;
/** Artifact files checked on disk per diagnosis (they are stat calls; keep it bounded). */
const MAX_ARTIFACT_CHECKS = 5000;

const RANK: Record<CheckStatus, number> = { ok: 0, warn: 1, fail: 2 };

function check(
  name: string,
  status: CheckStatus,
  detail: string,
  items?: readonly string[],
): DiagnosticCheck {
  return items?.length
    ? { name, status, detail, items: items.slice(0, MAX_ITEMS) }
    : { name, status, detail };
}

export function systemDiagnostics(svc: Services): SystemDiagnostics {
  const now = svc.now();
  const checks: DiagnosticCheck[] = [];
  const { startup } = svc;

  // Interrupted JSON replacements and partial JSONL tails (repaired at start).
  const torn = startup.findings.map((f) => `${f.kind}: ${f.path}`);
  checks.push(
    check(
      "storage recovery",
      startup.findings.length ? "warn" : "ok",
      startup.findings.length
        ? `${startup.findings.length} interrupted write(s) found at start; ${startup.repairs.length} repair(s) made`
        : "no interrupted JSON replacements or partial JSONL tails at start",
      [...torn, ...startup.repairs],
    ),
  );
  checks.push(
    check(
      "unreadable records",
      startup.unreadable.length ? "fail" : "ok",
      startup.unreadable.length
        ? `${startup.unreadable.length} record(s) could not be loaded; the coordinator started without them`
        : "every record loaded",
      startup.unreadable,
    ),
  );

  // Pending outbox entries and stalled MLflow updates.
  const o = svc.tracking.outbox.stats();
  const age = o.oldest_enqueued_at ? now.getTime() - Date.parse(o.oldest_enqueued_at) : 0;
  checks.push(
    check(
      "pending MLflow writes",
      o.failed > 0 ? "warn" : o.pending > 0 && age > STALLED_AFTER_MS ? "warn" : "ok",
      o.pending || o.failed
        ? `${o.pending} pending, ${o.failed} rejected${o.pending ? `; oldest queued ${Math.round(age / 1000)}s ago` : ""}${svc.tracking.lastTransportError ? `; last error: ${svc.tracking.lastTransportError.message}` : ""}`
        : "the outbox is empty",
    ),
  );
  const mappings = svc.tracking.mappings.all();
  const stalled = mappings.filter(
    (m) =>
      m.sync_state === "tracking_pending" &&
      now.getTime() - Date.parse(m.updated_at) > STALLED_AFTER_MS,
  );
  const failed = mappings.filter((m) => m.sync_state === "sync_failed");
  checks.push(
    check(
      "stalled MLflow updates",
      failed.length ? "warn" : stalled.length ? "warn" : "ok",
      stalled.length || failed.length
        ? `${stalled.length} run(s) pending for more than ${STALLED_AFTER_MS / 60000} min, ${failed.length} sync_failed`
        : "no run is waiting on MLflow",
      [...failed.map((m) => `${m.ref} sync_failed`), ...stalled.map((m) => `${m.ref} pending`)],
    ),
  );

  // Orphaned tracking runs: an attempt mapping whose attempt record is gone.
  const orphans = mappings.filter(
    (m) => m.kind === "attempt" && m.attempt_id !== undefined && !svc.jobs.attempt(m.attempt_id),
  );
  checks.push(
    check(
      "orphaned tracking runs",
      orphans.length ? "warn" : "ok",
      orphans.length
        ? `${orphans.length} MLflow run mapping(s) point at attempts the coordinator has no record of`
        : "every attempt run maps to a known attempt",
      orphans.map((m) => `${m.ref}${m.mlflow_run_id ? ` (MLflow ${m.mlflow_run_id})` : ""}`),
    ),
  );

  // Attempts nothing will finish on its own.
  const attempts = svc.jobs.list().flatMap((j) => {
    const out = [];
    for (const id of j.attempts) {
      const a = svc.jobs.attempt(id);
      if (a) out.push(a);
    }
    return out;
  });
  const unknown = attempts.filter((a) => a.state === "unknown");
  checks.push(
    check(
      "attempts in unknown state",
      unknown.length ? "warn" : "ok",
      unknown.length
        ? `${unknown.length} attempt(s) lost their supervisor without an exit record; nothing reruns them`
        : "none",
      unknown.map((a) => `${a.project_id}/${a.job_id}/${a.attempt_id}`),
    ),
  );

  // Unavailable workers.
  const remote = svc.jobs.remoteAttempts();
  const live = remote.filter((a) => !TERMINAL_ATTEMPT_STATES.includes(a.state));
  const away = live.filter(
    (a) => a.remote?.connectivity === "disconnected" || a.remote?.overdue_at !== undefined,
  );
  // An exported attempt marked lost (F29) awaits a late import that may never come: not a fault.
  const unsynced = remote.filter(
    (a) =>
      a.remote?.reconcile_required !== undefined ||
      a.remote?.sync === "sync_failed" ||
      (TERMINAL_ATTEMPT_STATES.includes(a.state) &&
        a.remote?.sync === "awaiting_sync" &&
        !a.remote.marked_lost_at),
  );
  checks.push(
    check(
      "remote workers",
      unsynced.length ? "warn" : away.length ? "warn" : "ok",
      remote.length === 0
        ? "no remote attempts"
        : `${live.length} running remotely, ${away.length} disconnected or overdue, ${unsynced.length} needing reconciliation or sync`,
      [
        ...away.map(
          (a) =>
            `${a.attempt_id} on ${a.remote?.target_id}: ${a.remote?.overdue_at ? `overdue (expected back by ${a.remote.expected_back_by})` : "disconnected"}`,
        ),
        ...unsynced.map(
          (a) =>
            `${a.attempt_id} on ${a.remote?.target_id}: ${a.remote?.reconcile_required ? "reconcile_required" : a.remote?.sync}`,
        ),
      ],
    ),
  );

  // Missing artifacts: never uploaded by their collector, or uploaded but absent from the managed
  // artifact store (for example after a partial restore).
  const notUploaded = attempts.filter(
    (a) => TERMINAL_ATTEMPT_STATES.includes(a.state) && (a.collector.pending_artifacts ?? 0) > 0,
  );
  const missing: string[] = [];
  const sc = svc.sidecarStatus();
  let checked = 0;
  if (svc.sidecar && sc.paths.artifacts && existsSync(sc.paths.artifacts)) {
    const byAttempt = new Map(
      mappings.filter((m) => m.attempt_id).map((m) => [m.attempt_id as string, m]),
    );
    outer: for (const a of attempts) {
      const m = byAttempt.get(a.attempt_id);
      if (!m?.experiment_id || !m.mlflow_run_id) continue;
      for (const art of a.artifacts) {
        if (++checked > MAX_ARTIFACT_CHECKS) break outer;
        const p = join(sc.paths.artifacts, m.experiment_id, m.mlflow_run_id, "artifacts", art.path);
        if (!existsSync(p)) missing.push(`${a.attempt_id}: ${art.path}`);
      }
    }
  }
  checks.push(
    check(
      "missing artifacts",
      missing.length ? "fail" : notUploaded.length ? "warn" : "ok",
      `${notUploaded.length} finished attempt(s) with artifacts never uploaded; ${missing.length} uploaded artifact(s) missing from the store${svc.sidecar ? ` (${Math.min(checked, MAX_ARTIFACT_CHECKS)} checked)` : " (store not managed here: not checked)"}`,
      [
        ...missing,
        ...notUploaded.map((a) => `${a.attempt_id}: ${a.collector.pending_artifacts} not uploaded`),
      ],
    ),
  );

  // MLflow and the boot mode.
  checks.push(
    check(
      "mlflow sidecar",
      sc.state === "healthy" || sc.state === "external"
        ? "ok"
        : sc.state === "disabled" || sc.state === "installing" || sc.state === "starting"
          ? "warn"
          : "fail",
      `${sc.state}${sc.last_error ? `: ${sc.last_error}` : ""}`,
    ),
  );
  checks.push(
    check(
      "safe mode",
      svc.extensions.safeMode ? "warn" : "ok",
      svc.extensions.safeMode
        ? "every extension is inactive; core features work. Restart without --safe-mode to re-enable them"
        : "off",
    ),
  );
  const restored = readRestoreRecord(svc.paths.home);
  if (restored)
    checks.push(
      check(
        "restored from backup",
        restored.warnings.length ? "warn" : "ok",
        `backup ${restored.backup_id} (${restored.backup_reason}, ${restored.backup_created_at}${restored.source ? ` on ${restored.source.hostname}` : ""}) restored ${restored.restored_at}`,
        restored.warnings,
      ),
    );

  const status = checks.reduce<CheckStatus>(
    (w, c) => (RANK[c.status] > RANK[w] ? c.status : w),
    "ok",
  );
  return { at: now.toISOString(), status, checks };
}
