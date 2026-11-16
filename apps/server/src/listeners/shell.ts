/**
 * Routes for the web shell (Stage 6, spec §2.2): the status bar summary, the attention inbox,
 * project task profiles, and Study/Variant views derived from run tags.
 */
import type { ResearchRecord, TaskProfile } from "@ablationkit/protocol";
import { type MlflowRun, TAGS } from "@ablationkit/tracking-mlflow";
import { HttpError, json, readJsonBody } from "../http.ts";
import { studyView, summarizeStudies } from "../research/studies.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";
import { session } from "./common.ts";
import type { HumanHandler } from "./human.ts";

/** Runs scanned per project for study views; beyond this the response says `truncated`. */
export const STUDY_SCAN_MAX = 5000;

export const BUILD_VERSION = "0.1.0";

/**
 * Inbox sources (spec §2.2 Home & Inbox). Sources owned by later stages are listed with
 * `available: false` so the UI can say so instead of implying "nothing pending".
 */
export const INBOX_SOURCES = [
  { kind: "reconcile_required", label: "Offline reconciliation", available: true },
  { kind: "worker_disconnected", label: "Remote workers out of contact", available: true },
  { kind: "sync_failed", label: "MLflow sync failures", available: true },
  { kind: "extension_approval", label: "Extension approvals", available: false, stage: 15 },
  { kind: "export_drift", label: "Hand edits to research exports", available: true },
  {
    kind: "awaiting_run",
    label: "Exported notebooks waiting for you to run them",
    available: true,
  },
  { kind: "compute_limit", label: "Agents at their project's compute limit", available: true },
] as const;

export interface InboxItem {
  id: string;
  kind: (typeof INBOX_SOURCES)[number]["kind"];
  severity: "info" | "warning" | "error";
  title: string;
  detail?: string;
  project_id?: string;
  ref?: string;
  created_at?: string;
}

/** Remote attempts that need a look (spec §5.3, §5.7): counted for the status bar too. */
function remoteAttention(svc: Services): {
  items: InboxItem[];
  reconcile_required: number;
  disconnected: number;
  awaiting_sync: number;
  sync_failed: number;
} {
  const items: InboxItem[] = [];
  let reconcile = 0;
  let disconnected = 0;
  let awaiting = 0;
  let failed = 0;
  const live = new Set(["starting", "running"]);
  for (const a of svc.jobs.remoteAttempts()) {
    const r = a.remote;
    if (!r) continue;
    const where = `${r.target_id}${r.provider_job_id ? ` (${r.provider_job_id})` : ""}`;
    if (r.reconcile_required) {
      reconcile++;
      items.push({
        id: `reconcile_required:${a.attempt_id}`,
        kind: "reconcile_required",
        severity: "error",
        title: `Job ${a.job_id} on ${where} needs reconciliation`,
        detail: `${r.reconcile_required}. Its compute state is ${a.state}; nothing was rerun. Drain, import or resolve it on the job page.`,
        project_id: a.project_id,
        ref: `job:${a.job_id}`,
        created_at: a.ended_at ?? r.last_contact_at ?? a.created_at,
      });
      continue;
    }
    if (r.sync === "sync_failed") {
      failed++;
      items.push(
        compact({
          id: `sync_failed:remote:${a.attempt_id}`,
          kind: "sync_failed" as const,
          severity: "error" as const,
          title: `Results of job ${a.job_id} on ${where} did not sync`,
          detail: r.sync_error ?? "the worker could not deliver; drain it to retry",
          project_id: a.project_id,
          ref: `job:${a.job_id}`,
          created_at: a.ended_at ?? a.created_at,
        }),
      );
    } else if ((r.sync === "awaiting_sync" || r.sync === "syncing") && !r.marked_lost_at)
      awaiting++;
    if (r.overdue_at && live.has(a.state)) {
      // An exported notebook past its expected return (F29): it never called in, so it cannot
      // "disconnect"; it holds its parallel slot until imported or marked lost.
      disconnected++;
      items.push({
        id: `worker_disconnected:${a.attempt_id}`,
        kind: "worker_disconnected",
        severity: "warning",
        title: `The exported notebook for job ${a.job_id} on ${where} is overdue`,
        detail: `It was expected back by ${r.expected_back_by}. If it ran, import its archive (\`ablationkit remote import ${a.job_id} ARCHIVE\`); if its runtime is gone, mark it lost on the job page (\`ablationkit remote resolve ${a.job_id} --lost\`). Nothing fails it automatically.`,
        project_id: a.project_id,
        ref: `job:${a.job_id}`,
        created_at: r.overdue_at,
      });
    } else if (r.connectivity === "disconnected" && live.has(a.state)) {
      disconnected++;
      items.push({
        id: `worker_disconnected:${a.attempt_id}`,
        kind: "worker_disconnected",
        severity: "warning",
        title: `Worker for job ${a.job_id} on ${where} is out of contact`,
        detail:
          "The job may still be running under its target's supervisor; live monitoring and cancellation wait for it to reconnect. Results reconcile when it does.",
        project_id: a.project_id,
        ref: `job:${a.job_id}`,
        created_at: r.last_contact_at ?? a.created_at,
      });
    }
  }
  return {
    items,
    reconcile_required: reconcile,
    disconnected,
    awaiting_sync: awaiting,
    sync_failed: failed,
  };
}

function inboxItems(svc: Services): InboxItem[] {
  const items: InboxItem[] = [...remoteAttention(svc).items];
  // sync_failed: MLflow rejected a queued write; grouped by run ref (or project for experiments).
  const failed = svc.tracking.outbox.entries({ state: "failed" });
  const groups = new Map<string, typeof failed>();
  for (const e of failed) {
    const k = `${e.op.project_id}:${e.op.ref ?? ""}`;
    const list = groups.get(k) ?? [];
    list.push(e);
    groups.set(k, list);
  }
  for (const [k, list] of groups) {
    const first = list[0];
    if (!first) continue;
    items.push(
      compact({
        id: `sync_failed:${k}`,
        kind: "sync_failed" as const,
        severity: "error" as const,
        title: `${list.length} MLflow write${list.length === 1 ? "" : "s"} rejected${first.op.ref ? ` for ${first.op.ref}` : ""}`,
        detail: first.last_error?.message,
        project_id: first.op.project_id,
        ref: first.op.ref,
        created_at: first.op.enqueued_at,
      }),
    );
  }
  // export_drift: a research export file was edited by hand; the edit was kept in state.
  for (const p of svc.registry.list()) {
    const drift = svc.research.exportState(p.project_id).drift;
    if (!drift.length) continue;
    const first = drift[0];
    items.push(
      compact({
        id: `export_drift:${p.project_id}`,
        kind: "export_drift" as const,
        severity: "warning" as const,
        title: `${drift.length} hand edit${drift.length === 1 ? "" : "s"} to ${p.name}'s research export ${drift.length === 1 ? "was" : "were"} replaced`,
        detail: `Export files are rewritten from the coordinator's records; edit research in AblationKit instead. The edited copies were kept, e.g. ${first?.saved_to}.`,
        project_id: p.project_id,
        ref: first?.path,
        created_at: first?.detected_at,
      }),
    );
  }
  // compute_limit: an agent's job was refused, or agent jobs went over the limit (ADR 0037).
  for (const u of svc.compute.allUsage()) {
    if (!u.refused && !u.over_limit) continue;
    items.push(
      compact({
        id: `compute_limit:${u.project_id}`,
        kind: "compute_limit" as const,
        severity: "warning" as const,
        title: u.over_limit
          ? `Agent jobs in ${u.name} went over the compute limit`
          : `An agent reached the compute limit for ${u.name}`,
        detail: `${u.refused ? `${u.refused.message}${u.refused.count > 1 ? ` (${u.refused.count} jobs refused)` : ""} ` : `Used ${u.used_hours} of ${u.limit_hours} weighted hours. `}Raise the limit in Project settings → Agent permissions.`,
        project_id: u.project_id,
        ref: "settings",
        created_at: u.refused?.at,
      }),
    );
  }
  // awaiting_run: an exported notebook runs only when a person runs it (F32).
  for (const a of svc.jobs.remoteAttempts()) {
    const r = a.remote;
    if (r?.staging !== "exported" || a.state !== "starting" || r.overdue_at || r.imported_at)
      continue;
    items.push(
      compact({
        id: `awaiting_run:${a.attempt_id}`,
        kind: "awaiting_run" as const,
        severity: "info" as const,
        title: `Job ${a.job_id} on ${r.target_id} waits for you to run its notebook`,
        detail: `Run it in Colab, then import its archive (\`ablationkit remote import ${a.job_id} ARCHIVE\`).${r.expected_back_by ? ` Expected back by ${r.expected_back_by}.` : ""}`,
        project_id: a.project_id,
        ref: `job:${a.job_id}`,
        created_at: r.submitted_at ?? a.created_at,
      }),
    );
  }
  return items;
}

/** What the studies pages need from a study record (stored baseline, protocol, goals). */
function studyRecordView(r: ResearchRecord): Record<string, unknown> {
  return compact({
    record_id: r.record_id,
    title: r.title,
    status: r.status,
    summary: r.summary,
    body: r.body,
    protocol: r.protocol,
    baseline_variant: r.baseline_variant,
    variants: r.variants,
    metric_goals: r.metric_goals,
    links: r.links,
    archived_at: r.archived_at,
  });
}

export async function projectRuns(
  svc: Services,
  projectId: string,
  filter?: string,
): Promise<{ runs: MlflowRun[]; truncated: boolean }> {
  svc.registry.require(projectId);
  const l = svc.tracking.mappings.getLinks(projectId);
  const ids = [
    ...(l.experiment_id ? [l.experiment_id] : []),
    ...l.imports.map((i) => i.experiment_id),
  ];
  if (ids.length === 0) return { runs: [], truncated: false };
  const runs: MlflowRun[] = [];
  let token: string | undefined;
  try {
    do {
      const page = await svc.tracking.client.searchRuns(
        compact({ experiment_ids: ids, filter, max_results: 1000, page_token: token }),
      );
      runs.push(...page.items);
      token = page.next_page_token;
    } while (token && runs.length < STUDY_SCAN_MAX);
  } catch (e) {
    throw new HttpError(503, "tracking_unavailable", `MLflow is unavailable: ${String(e)}`, {
      sidecar: svc.sidecarStatus().state,
    });
  }
  return { runs, truncated: token !== undefined };
}

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TASK_PROFILES: ReadonlySet<unknown> = new Set<TaskProfile>([
  "llm",
  "rag",
  "agent",
  "computer_vision",
  "tabular",
  "other",
]);

/** Build status runs git; the running build cannot change under a live process, so cache it. */
let buildCache: { at: number; value: ReturnType<Services["builds"]["status"]> } | undefined;
function cachedBuild(svc: Services): ReturnType<Services["builds"]["status"]> {
  const now = Date.now();
  if (!buildCache || now - buildCache.at > 30_000)
    buildCache = { at: now, value: svc.builds.status() };
  return buildCache.value;
}

export const SHELL_ROUTES: readonly Route<HumanHandler>[] = [
  {
    method: "GET",
    path: "/api/v1/shell/status",
    handler: session("shell.status", async (c) => {
      const sidecar = c.svc.sidecarStatus();
      const outbox = c.svc.tracking.outbox.stats();
      const probe = c.svc.jobs.probe();
      const running = c.svc.jobs
        .list()
        .map((j) => c.svc.jobs.latestAttempt(j))
        .filter((a) => a && (a.state === "running" || a.state === "starting")).length;
      return json(200, {
        coordinator: {
          state: "ok",
          pid: process.pid,
          started_at: c.svc.startedAt.toISOString(),
          url: c.svc.urls.human,
          // One coordinator (spec §5.3): the active one is the one answering.
          active: true,
        },
        mlflow: compact({
          state: sidecar.state,
          last_error: sidecar.last_error,
          last_contact_at: c.svc.tracking.lastContactAt,
        }),
        sync: {
          pending: outbox.pending,
          failed: outbox.failed,
          oldest_pending_at: outbox.oldest_enqueued_at,
        },
        offline: (() => {
          const r = remoteAttention(c.svc);
          return {
            available: true,
            reconcile_required: r.reconcile_required,
            disconnected: r.disconnected,
            awaiting_sync: r.awaiting_sync,
            sync_failed: r.sync_failed,
            remote_attempts: c.svc.jobs
              .remoteAttempts()
              .filter((a) => a.state === "running" || a.state === "starting").length,
          };
        })(),
        compute: {
          supervisor: probe.mode,
          enforcement: probe.enforcement,
          running_attempts: running,
        },
        build: (() => {
          const b = cachedBuild(c.svc) as {
            modified?: boolean;
            running?: { modified_build?: string };
            restart_required?: boolean;
          };
          return compact({
            version: BUILD_VERSION,
            modified: b.modified ? (b.running?.modified_build ?? "yes") : "no",
            restart_required: b.restart_required === true ? true : undefined,
          });
        })(),
        safe_mode: c.svc.extensions.safeMode,
        inbox: { count: inboxItems(c.svc).length },
      });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/inbox",
    handler: session("inbox.read", (c) =>
      json(200, { items: inboxItems(c.svc), sources: INBOX_SOURCES }),
    ),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/settings",
    handler: session("project.settings.read", (c) => {
      const id = c.params["id"] as string;
      const project = c.svc.registry.require(id);
      const m = c.svc.registry.manifest(id);
      return json(
        200,
        compact({
          project,
          manifest_found: m !== undefined,
          description: m?.description,
          task_profiles: m?.task_profiles ?? [],
        }),
      );
    }),
  },
  {
    method: "PATCH",
    path: "/api/v1/projects/:id/settings",
    handler: session("project.settings.update", async (c) => {
      const id = c.params["id"] as string;
      const body = await readJsonBody(c.req);
      const tp = body["task_profiles"];
      if (!Array.isArray(tp) || !tp.every((p) => TASK_PROFILES.has(p)))
        throw new HttpError(
          400,
          "invalid_request",
          "task_profiles must be an array of llm, rag, agent, computer_vision, tabular, other",
        );
      const m = c.svc.registry.setTaskProfiles(id, tp as TaskProfile[]);
      c.svc.audit.record({
        actor: { kind: "human", id: c.session.token_id },
        listener: "human",
        action: "project.settings.update",
        outcome: "allowed",
        project_id: id,
        details: { task_profiles: m.task_profiles ?? [] },
      });
      return json(200, { task_profiles: m.task_profiles ?? [] });
    }),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/studies",
    handler: session("project.studies.list", async (c) => {
      const pid = c.params["id"] as string;
      const records = c.svc.research.list(pid, { kind: "study", archived: "include" });
      let runs: MlflowRun[] = [];
      let truncated = false;
      let tracking_error: string | undefined;
      try {
        ({ runs, truncated } = await projectRuns(c.svc, pid));
      } catch (e) {
        // Study records still list while MLflow is down.
        if (!(e instanceof HttpError) || !records.length) throw e;
        tracking_error = e.message;
      }
      const summaries = summarizeStudies(runs);
      const byId = new Map(records.map((r) => [r.record_id, r]));
      const studies = [
        ...summaries.map((s) => {
          const r = byId.get(s.study_id);
          return r ? { ...s, record: studyRecordView(r) } : s;
        }),
        ...records
          .filter((r) => !summaries.some((s) => s.study_id === r.record_id))
          .map((r) => ({
            study_id: r.record_id,
            variants: r.variants?.length ?? 0,
            runs: 0,
            status_counts: {},
            last_start_time: 0,
            record: studyRecordView(r),
          })),
      ];
      return json(200, compact({ studies, scanned: runs.length, truncated, tracking_error }));
    }),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/studies/:study",
    handler: session("project.studies.read", async (c) => {
      const study = c.params["study"] as string;
      if (!ID_RE.test(study)) throw new HttpError(400, "invalid_request", "bad study id");
      const { runs, truncated } = await projectRuns(
        c.svc,
        c.params["id"] as string,
        `tags.\`${TAGS.study}\` = '${study}'`,
      );
      const rec = c.svc.research.get(c.params["id"] as string, study);
      const record = rec?.kind === "study" ? studyRecordView(rec) : undefined;
      if (runs.length === 0 && !record)
        throw new HttpError(404, "not_found", `no runs in study ${study}`);
      return json(200, { ...studyView(study, runs), truncated, ...(record ? { record } : {}) });
    }),
  },
];
