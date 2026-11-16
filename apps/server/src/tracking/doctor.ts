/**
 * `tracking doctor` (spec §12: "Check MLflow + storage + outbox"). Read-only: it reports, it never
 * repairs. Each check is ok, warn or fail; the overall status is the worst of them.
 */
import { accessSync, constants, existsSync, statfsSync, statSync } from "node:fs";
import type { MlflowSidecar, SidecarStatus, TrackingService } from "@ablationkit/tracking-mlflow";
import type { RuntimePaths } from "../config.ts";
import type { ProjectRegistryService } from "../state/registry.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface TrackingDoctorReport {
  readonly status: CheckStatus;
  readonly checks: readonly DoctorCheck[];
  readonly sidecar: SidecarStatus;
}

export interface DoctorDeps {
  readonly paths: RuntimePaths;
  readonly now: () => Date;
  readonly tracking: TrackingService;
  readonly sidecar: MlflowSidecar | undefined;
  readonly sidecarStatus: () => SidecarStatus;
  readonly registry: ProjectRegistryService;
  readonly mappingProblems: readonly string[];
}

const RANK: Record<CheckStatus, number> = { ok: 0, warn: 1, fail: 2 };

export async function trackingDoctor(d: DoctorDeps): Promise<TrackingDoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: CheckStatus, detail: string) =>
    checks.push({ name, status, detail });
  const st = d.sidecarStatus();

  if (st.state === "healthy")
    add("sidecar", "ok", `MLflow ${st.pinned_version} healthy since ${st.since}`);
  else if (st.state === "external")
    add("sidecar", "ok", `not managed: tracking uses the MLflow server at ${st.url ?? "?"}`);
  else if (st.state === "disabled")
    add("sidecar", "warn", "managed sidecar disabled in settings.json; tracking writes queue");
  else if (st.state === "installing" || st.state === "starting" || st.state === "restarting")
    add("sidecar", "warn", `${st.state}${st.last_error ? `: ${st.last_error}` : ""}`);
  else add("sidecar", "fail", `${st.state}${st.last_error ? `: ${st.last_error}` : ""}`);

  const reachable = await d.tracking.client.health();
  add(
    "mlflow api",
    reachable ? "ok" : st.state === "disabled" ? "warn" : "fail",
    reachable ? "/health answered OK" : "MLflow is not reachable",
  );
  if (reachable) {
    const v = await d.tracking.client.version().catch(() => "?");
    add(
      "mlflow version",
      v === st.pinned_version ? "ok" : "fail",
      `server ${v}, pinned ${st.pinned_version}`,
    );
  }
  if (d.sidecar) {
    if (st.data_version && st.data_version !== st.pinned_version)
      add(
        "upgrade guard",
        "warn",
        `data last opened by ${st.data_version}; pinned ${st.pinned_version} will back up and migrate at next start`,
      );
    else
      add(
        "upgrade guard",
        "ok",
        st.data_version ? `data at ${st.data_version}` : "no MLflow data yet",
      );
    const db = st.paths.database;
    add(
      "database",
      existsSync(db) ? "ok" : "warn",
      existsSync(db) ? `${db} (${statSync(db).size} bytes)` : `${db} not created yet`,
    );
    try {
      accessSync(st.paths.artifacts, constants.W_OK);
      add("artifact store", "ok", `${st.paths.artifacts} writable`);
    } catch {
      add(
        "artifact store",
        existsSync(st.paths.artifacts) ? "fail" : "warn",
        `${st.paths.artifacts} missing or not writable`,
      );
    }
  }

  const o = d.tracking.outbox.stats();
  const fill = Math.max(o.pending / o.limits.maxOps, o.bytes / o.limits.maxBytes);
  const age = o.oldest_enqueued_at
    ? Math.round((d.now().getTime() - Date.parse(o.oldest_enqueued_at)) / 1000)
    : 0;
  add(
    "outbox",
    fill >= 0.8 ? "fail" : o.pending > 0 && age > 300 ? "warn" : "ok",
    `${o.pending} pending, ${o.failed} failed, ${o.bytes} bytes (${Math.round(fill * 100)}% of bound)${o.pending ? `; oldest ${age}s` : ""}`,
  );
  add(
    "outbox failures",
    o.failed > 0 ? "warn" : "ok",
    o.failed > 0
      ? `${o.failed} writes rejected by MLflow; see GET /api/v1/tracking/outbox?state=failed`
      : "none",
  );
  if (d.tracking.lastTransportError)
    add("last delivery error", "warn", d.tracking.lastTransportError.message);

  add(
    "mapping files",
    d.mappingProblems.length ? "fail" : "ok",
    d.mappingProblems.length
      ? d.mappingProblems.join("; ")
      : `${d.tracking.mappings.all().length} run mappings readable`,
  );
  const failedRuns = d.tracking.mappings.all().filter((m) => m.sync_state === "sync_failed");
  if (failedRuns.length)
    add(
      "runs sync_failed",
      "warn",
      failedRuns
        .map((m) => m.ref)
        .slice(0, 20)
        .join(", "),
    );

  const missing = d.registry
    .list()
    .filter((p) => !d.tracking.mappings.getLinks(p.project_id).experiment_id)
    .map((p) => p.project_id);
  add(
    "project experiments",
    missing.length ? "warn" : "ok",
    missing.length
      ? `not yet in MLflow: ${missing.join(", ")}`
      : "every project has its ak/<project-id> experiment",
  );

  try {
    const fs = statfsSync(d.paths.home);
    const free = fs.bavail * fs.bsize;
    add(
      "disk",
      free < 1024 ** 3 ? "warn" : "ok",
      `${Math.round(free / 1024 ** 2)} MiB free under ${d.paths.home}`,
    );
  } catch {
    add("disk", "warn", "could not read free space");
  }

  const status = checks.reduce<CheckStatus>(
    (w, c) => (RANK[c.status] > RANK[w] ? c.status : w),
    "ok",
  );
  return { status, checks, sidecar: st };
}
