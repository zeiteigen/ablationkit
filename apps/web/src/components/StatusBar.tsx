/**
 * Status bar (spec §2.2): one quiet health item (the coordinator and MLflow) that links to System,
 * and the rest only when it needs a look: sync backlog or failures, remote work, running jobs,
 * live updates reconnecting, safe mode and a modified build (ADR 0055). Everything else is in the
 * health item's tooltip. Unknown or not-yet-built states are labelled as such, never shown as
 * healthy, and advisory limits are never shown as enforced (spec §7.11).
 */
import { useApi, useEvents, useEventsConnected } from "../api.ts";
import { Link } from "./ui.tsx";

interface ShellStatus {
  coordinator: { state: string; url: string; pid: number; started_at: string };
  mlflow: { state: string; last_error?: string; last_contact_at?: string };
  sync: { pending: number; failed: number; oldest_pending_at?: string };
  offline: {
    available: boolean;
    reconcile_required: number;
    disconnected: number;
    awaiting_sync: number;
    sync_failed: number;
    remote_attempts: number;
  };
  compute: { supervisor: string; enforcement: string; running_attempts: number };
  build: { version: string; modified: string; restart_required?: boolean };
  safe_mode?: boolean;
}

type Dot = "ok" | "warn" | "err" | "none";

function dot(state: Dot) {
  return <span className={`dot ${state === "none" ? "" : state}`} />;
}

function mlflowDot(state: string): Dot {
  if (state === "healthy" || state === "external") return "ok";
  if (state === "starting" || state === "installing" || state === "restarting") return "warn";
  return state === "disabled" ? "none" : "err";
}

function remoteText(o: ShellStatus["offline"]): { dot: Dot; text: string } | undefined {
  if (o.reconcile_required) return { dot: "err", text: `${o.reconcile_required} to reconcile` };
  if (o.sync_failed) return { dot: "err", text: `${o.sync_failed} sync failed` };
  if (o.disconnected) return { dot: "warn", text: `${o.disconnected} out of contact` };
  if (o.awaiting_sync) return { dot: "warn", text: `${o.awaiting_sync} awaiting sync` };
  if (o.remote_attempts) return { dot: "ok", text: `${o.remote_attempts} running` };
  return undefined;
}

export function StatusBar() {
  const s = useApi<ShellStatus>("/api/v1/shell/status", { pollMs: 5000 });
  const live = useEventsConnected();
  useEvents(() => s.reload(), {
    types: [
      "tracking.run.sync",
      "job.attempt.state",
      "job.attempt.remote",
      "job.worker.disconnected",
      "job.worker.reconnected",
    ],
  });
  const d = s.data;
  if (!d) {
    return (
      <footer className="statusbar" data-testid="statusbar">
        <span className="item health">
          {dot(s.error ? "err" : "none")}{" "}
          <span className="label">coordinator {s.error ? "unreachable" : "…"}</span>
        </span>
      </footer>
    );
  }
  const ml = mlflowDot(d.mlflow.state);
  const health: Dot = s.error || ml === "err" ? "err" : ml === "warn" ? "warn" : "ok";
  const remote = remoteText(d.offline);
  const limits = `limits ${d.compute.enforcement} (${d.compute.supervisor})`;
  const sync = d.sync.failed
    ? `${d.sync.failed} failed`
    : d.sync.pending
      ? `${d.sync.pending} pending`
      : "up to date";
  const detail = [
    `coordinator pid ${d.coordinator.pid}, since ${d.coordinator.started_at}`,
    `active: ${new URL(d.coordinator.url).host}`,
    `MLflow ${d.mlflow.state}${d.mlflow.last_error ? `: ${d.mlflow.last_error}` : ""}`,
    `sync ${sync}`,
    `remote: ${remote?.text ?? "idle"}`,
    `job ${limits} · ${d.compute.running_attempts} running`,
    `live updates ${live ? "connected" : "reconnecting"}`,
    `build ${d.build.version} · modified: ${d.build.modified}`,
  ].join("\n");
  const modified = d.build.modified !== "no" || d.build.restart_required;
  return (
    <footer className="statusbar" data-testid="statusbar">
      <Link to="/system" className="item health" title={detail}>
        {dot(health)}
        <span className="label">
          coordinator {s.error ? "unreachable" : "ok"} · MLflow {d.mlflow.state}
        </span>
      </Link>
      {d.sync.failed || d.sync.pending ? (
        <Link to="/system" className="item" title="MLflow delivery backlog">
          {dot(d.sync.failed ? "err" : "warn")} sync {sync}
        </Link>
      ) : null}
      {remote ? (
        <Link
          to="/compute"
          className="item"
          data-testid="status-remote"
          title={`${d.offline.remote_attempts} remote attempts running · ${d.offline.awaiting_sync} awaiting sync · ${d.offline.disconnected} workers out of contact · ${d.offline.reconcile_required} need reconciliation · ${d.offline.sync_failed} failed to sync`}
        >
          {dot(remote.dot)} remote: {remote.text}
        </Link>
      ) : null}
      {d.compute.running_attempts ? (
        <Link to="/compute" className="item" title={`job ${limits}`}>
          {dot("ok")} {d.compute.running_attempts} running
        </Link>
      ) : null}
      {live ? null : (
        <span className="item" title="live updates reconnecting">
          {dot("warn")} reconnecting
        </span>
      )}
      {d.safe_mode ? (
        <Link
          to="/system"
          className="item"
          data-testid="status-safe-mode"
          title="Every extension is inactive. Restart without --safe-mode to re-enable them."
        >
          {dot("warn")} SAFE MODE
        </Link>
      ) : null}
      {modified ? (
        <Link
          to="/system"
          className="item build"
          title={`modified build ${d.build.modified} (Level 2 source change)`}
        >
          {dot("warn")} build {d.build.version} · modified: {d.build.modified}
          {d.build.restart_required ? " · restart to apply" : ""}
        </Link>
      ) : null}
    </footer>
  );
}
