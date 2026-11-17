/**
 * Compute (ADR 0036; replaces Agents & Compute): time used and estimated spend by target, daily
 * compute hours, utilization the runs reported, recent jobs, the local supervisor and the remote
 * targets. Spend is rate card × time, an estimate; local compute has no dollar rate. The agent
 * compute limit (ADR 0037): each target's weight, and every project's agent usage against its limit.
 */
import { useEffect, useMemo, useState } from "react";
import { api, useApi, useEvents } from "../api.ts";
import { useShell } from "../app.tsx";
import { type AgentUsage, ComputeMeter } from "../components/AgentPermissions.tsx";
import { Chart } from "../components/Chart.tsx";
import {
  attemptTone,
  Badge,
  Empty,
  EnforcementBadge,
  ErrorBox,
  KV,
  Link,
  Loading,
  Page,
  Tabs,
  useAction,
} from "../components/ui.tsx";
import {
  byTarget,
  dailyHours,
  fmtCents,
  fmtHours,
  fmtPct,
  inWindow,
  type JobUsage,
  jobUsage,
  LOCAL_TARGET,
  totals,
  type Utilization,
  utilization,
} from "../lib/compute.ts";
import { fmtDuration, fmtTime, shortId } from "../lib/format.ts";
import { fmtWeightedHours, parseWeightInput } from "../lib/policy.ts";
import type { ColabUsage, ComputeTargetView, JobView, RunsPage } from "../lib/types.ts";
import { useLocation } from "../router.ts";

const WINDOWS = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "all", label: "All", days: undefined },
] as const;

const DAY = 86_400_000;

function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Jobs plus targets, refreshed on job events: the input to every usage view. */
function useUsage(pid?: string): {
  usage: JobUsage[] | undefined;
  targets: ComputeTargetView[];
  error: unknown;
  now: number;
} {
  const jobs = useApi<{ jobs: JobView[] }>(
    pid ? `/api/v1/projects/${encodeURIComponent(pid)}/jobs?limit=500` : "/api/v1/jobs?limit=500",
  );
  const targets = useApi<{ targets: ComputeTargetView[] }>("/api/v1/targets");
  useEvents(() => jobs.reload(), {
    ...(pid ? { project: pid } : {}),
    types: ["job.attempt.state", "job.attempt.remote"],
  });
  const now = useNow();
  const t = targets.data?.targets ?? [];
  const usage = useMemo(
    () => (jobs.data ? jobUsage(jobs.data.jobs, t, now) : undefined),
    [jobs.data, t, now],
  );
  return { usage, targets: t, error: jobs.error ?? targets.error, now };
}

function Stat(props: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="faint small">{props.label}</div>
      <div style={{ fontSize: 26, fontWeight: 600, marginTop: 4 }}>{props.value}</div>
      {props.hint ? <div className="faint small">{props.hint}</div> : null}
    </div>
  );
}

function spendText(t: { cents: number; unpriced: number }): string {
  return `${fmtCents(t.cents)}${t.unpriced ? ` + ${t.unpriced} unpriced` : ""}`;
}

/**
 * Compute in one line for Home (every project) and a project's Overview, shown only when something
 * ran in the last 7 days or is running now (ADR 0055).
 */
export function ComputeSummary(props: { pid?: string }) {
  const { usage, now } = useUsage(props.pid);
  if (!usage) return null;
  const week = totals(inWindow(usage, now - 7 * DAY));
  if (!week.running && !week.ms) return null;
  return (
    <p className="small muted" data-testid="project-compute">
      Compute: {week.running ? `${week.running} running · ` : ""}
      {fmtHours(week.ms)} in the last 7 days
      {week.cents || week.unpriced ? ` · ${spendText(week)} (estimate)` : ""}.{" "}
      <Link to="/compute">Compute →</Link>
    </p>
  );
}

export function ComputePage() {
  const loc = useLocation();
  const win = WINDOWS.find((w) => w.id === loc.query.get("window")) ?? WINDOWS[0];
  const { usage, targets, error, now } = useUsage();
  const since = win.days !== undefined ? now - win.days * DAY : undefined;
  const scoped = usage ? inWindow(usage, since) : undefined;
  const sum = scoped ? totals(scoped) : undefined;
  const rows = scoped ? byTarget(scoped) : [];
  const target = new Map(targets.map((t) => [t.target_id, t]));
  const paidMs = rows.filter((r) => r.paid).reduce((s, r) => s + r.ms, 0);
  const days = win.days ?? 30;
  const series = scoped
    ? dailyHours(scoped, now, days).map((s) => ({ label: s.target_id, points: s.points }))
    : [];

  return (
    <Page
      trail={[{ label: "Compute" }]}
      title="Compute"
      lede="Time used, estimated spend and utilization across projects and targets."
      tabs={
        <Tabs
          label="Period"
          items={WINDOWS.map((w) => ({
            id: w.id,
            label: w.label,
            to: w.id === "7d" ? "/compute" : `/compute?window=${w.id}`,
          }))}
          active={win.id}
        />
      }
    >
      <ErrorBox error={error} />
      {!sum ? (
        <Loading />
      ) : sum.jobs === 0 && sum.running === 0 ? (
        <p className="muted" data-testid="compute-none">
          No jobs {win.days !== undefined ? `in the last ${win.days} days` : "yet"}.
        </p>
      ) : (
        <>
          <div className="grid3" data-testid="compute-totals">
            <Stat
              label="Running now"
              value={String(sum.running)}
              hint={`${sum.jobs} jobs in window`}
            />
            <Stat
              label="Compute time"
              value={fmtHours(sum.ms)}
              hint="wall time of each job's latest attempt"
            />
            <Stat
              label="Estimated spend"
              value={fmtCents(sum.cents)}
              hint={
                sum.unpriced
                  ? `${sum.unpriced} jobs on paid targets without a rate card are not counted`
                  : "rate card × time; not a bill"
              }
            />
            <Stat label="Paid compute time" value={fmtHours(paidMs)} />
          </div>
          <div className="grid2">
            <section className="card" data-testid="compute-by-target">
              <h2>By target</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Target</th>
                      <th>Rate</th>
                      <th>Jobs</th>
                      <th>Running</th>
                      <th>Time</th>
                      <th>Est. spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const t = target.get(r.target_id);
                      const rate = t?.runpod?.cents_per_hour;
                      return (
                        <tr key={r.target_id}>
                          <td>
                            {r.target_id === LOCAL_TARGET
                              ? "this workstation"
                              : (t?.label ?? r.target_id)}
                            {t ? <span className="faint small"> · {t.kind}</span> : null}
                          </td>
                          <td className="small">
                            {!r.paid
                              ? "free"
                              : rate !== undefined
                                ? `${fmtCents(rate)}/h`
                                : "no rate card"}
                          </td>
                          <td>{r.jobs}</td>
                          <td>{r.running}</td>
                          <td>{fmtHours(r.ms)}</td>
                          <td>{r.paid ? spendText(r) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
            {series.some((s) => s.points.some(([, y]) => y > 0)) ? (
              <section className="card">
                <h2>Compute hours per day</h2>
                <Chart series={series} xIsTime height={200} exportName="compute-hours" />
              </section>
            ) : null}
          </div>
          <RecentJobs usage={scoped} target={target} />
        </>
      )}

      <AgentCompute />

      <UtilizationCard />

      <details className="fold" data-testid="compute-targets" open={targets.length > 0}>
        <summary className="fold-head">
          <h2>Targets</h2>
          <span className="faint small">
            This workstation's supervisor and the remote targets jobs can run on.
          </span>
        </summary>
        <div className="grid2">
          <LocalSupervisor />
          <RemoteTargets />
        </div>
      </details>

      <Weights />
    </Page>
  );
}

function RecentJobs(props: {
  usage: JobUsage[] | undefined;
  target: Map<string, ComputeTargetView>;
}) {
  const list = (props.usage ?? [])
    .slice()
    .sort((a, b) => (b.started ?? 0) - (a.started ?? 0))
    .slice(0, 25);
  return (
    <section className="card" data-testid="compute-jobs">
      <h2>Recent jobs</h2>
      {list.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Project</th>
                <th>Target</th>
                <th>State</th>
                <th>Started</th>
                <th>Time</th>
                <th>Est. spend</th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.job.job_id}>
                  <td>
                    <Link
                      to={`/p/${encodeURIComponent(u.job.project_id)}/runs/jobs/${encodeURIComponent(u.job.job_id)}`}
                    >
                      {u.job.run_name ?? shortId(u.job.job_id, 14)}
                    </Link>
                  </td>
                  <td className="small">{u.job.project_id}</td>
                  <td className="small">{u.target_id === LOCAL_TARGET ? "local" : u.target_id}</td>
                  <td>
                    <Badge tone={attemptTone(u.job.state)}>{u.job.state}</Badge>
                  </td>
                  <td className="small">{u.started ? fmtTime(u.started) : "—"}</td>
                  <td className="small">{u.started ? fmtDuration(u.ms) : "—"}</td>
                  <td className="small">
                    {!u.paid ? "—" : u.cents !== undefined ? fmtCents(u.cents) : "unknown"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

interface UtilRow {
  project_id: string;
  run_id: string;
  run_name?: string | undefined;
  status: string;
  start?: number | undefined;
  u: Utilization;
}

/** Utilization the latest runs of every project reported as `system/*` metrics. */
function UtilizationCard() {
  const { projects } = useShell();
  const [rows, setRows] = useState<UtilRow[] | undefined>();
  const [err, setErr] = useState<unknown>();
  const ids = projects.map((p) => p.project_id).join("\n");
  useEffect(() => {
    let live = true;
    const pids = ids ? ids.split("\n") : [];
    // One project's MLflow error doesn't hide the others; the first error is shown.
    let failed: unknown;
    Promise.all(
      pids.map((pid) =>
        api<RunsPage>(
          `/api/v1/tracking/runs?project=${encodeURIComponent(pid)}&max_results=50`,
        ).then(
          (page) =>
            page.runs.flatMap((r): UtilRow[] => {
              const u = utilization(r.data.metrics);
              return u
                ? [
                    {
                      project_id: pid,
                      run_id: r.info.run_id,
                      run_name: r.info.run_name,
                      status: r.info.status,
                      start: r.info.start_time,
                      u,
                    },
                  ]
                : [];
            }),
          (e: unknown) => {
            failed ??= e;
            return [] as UtilRow[];
          },
        ),
      ),
    ).then((all) => {
      if (!live) return;
      setRows(all.flat().sort((a, b) => (b.start ?? 0) - (a.start ?? 0)));
      setErr(failed);
    });
    return () => {
      live = false;
    };
  }, [ids]);
  const avg = (k: "cpu" | "memory" | "gpu" | "gpu_memory") => {
    const xs = (rows ?? []).map((r) => r.u[k]).filter((v): v is number => v !== undefined);
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined;
  };
  // Shown only when a run reported system metrics (ADR 0055).
  if (!err && !rows?.length) return null;
  return (
    <section className="card" data-testid="compute-utilization">
      <h2>Utilization</h2>
      <p className="faint small">
        The last <code>system/*</code> values each run reported (MLflow system metric names), from
        the latest 50 runs per project. Open a run's System metrics for the full history.
      </p>
      <ErrorBox error={err} />
      {rows?.length ? (
        <>
          <div className="row small" style={{ marginBottom: 8 }}>
            <span>Mean over {rows.length} runs:</span>
            <Badge>CPU {fmtPct(avg("cpu"))}</Badge>
            <Badge>memory {fmtPct(avg("memory"))}</Badge>
            <Badge>GPU {fmtPct(avg("gpu"))}</Badge>
            <Badge>GPU memory {fmtPct(avg("gpu_memory"))}</Badge>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Project</th>
                  <th>Started</th>
                  <th>CPU</th>
                  <th>Memory</th>
                  <th>GPU</th>
                  <th>GPU memory</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 25).map((r) => (
                  <tr key={r.run_id}>
                    <td>
                      <Link
                        to={`/p/${encodeURIComponent(r.project_id)}/runs/r/${encodeURIComponent(r.run_id)}?section=system`}
                      >
                        {r.run_name ?? shortId(r.run_id)}
                      </Link>
                    </td>
                    <td className="small">{r.project_id}</td>
                    <td className="small">{fmtTime(r.start)}</td>
                    <td>{fmtPct(r.u.cpu)}</td>
                    <td>{fmtPct(r.u.memory)}</td>
                    <td>
                      {fmtPct(r.u.gpu)}
                      {r.u.gpus > 1 ? (
                        <span className="faint small"> ({r.u.gpus} GPUs)</span>
                      ) : null}
                    </td>
                    <td>{fmtPct(r.u.gpu_memory)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function LocalSupervisor() {
  const sup = useApi<{
    mode: string;
    enforcement: string;
    reason?: string;
    controllers?: string[];
  }>("/api/v1/jobs/supervisor");
  return (
    <section className="card">
      <h2>This workstation</h2>
      <ErrorBox error={sup.error} />
      {sup.data ? (
        <KV
          rows={[
            ["supervisor", sup.data.mode],
            [
              "resource limits",
              <EnforcementBadge
                key="e"
                enforcement={sup.data.enforcement}
                mode={sup.data.mode}
                {...(sup.data.reason ? { reason: sup.data.reason } : {})}
              />,
            ],
            ["reason", sup.data.reason ?? "—"],
            ["cgroup controllers", sup.data.controllers?.join(", ") || "—"],
          ]}
        />
      ) : (
        <Loading />
      )}
    </section>
  );
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Remote compute targets (ADR 0023): rate cards, what each can do, and a doctor run on demand. */
/** A Colab account's compute units, refreshed every minute (the whole account, ADR 0059). */
function ColabUsageLine(props: { targetId: string }) {
  const u = useApi<ColabUsage>(`/api/v1/targets/${encodeURIComponent(props.targetId)}/usage`, {
    pollMs: 60_000,
  });
  if (u.error)
    return (
      <div className="small faint" data-testid="colab-usage">
        compute units unavailable: {u.error.message}
      </div>
    );
  if (!u.data) return null;
  const balance = u.data.balance_hundredths / 100;
  const perHour = u.data.per_hour_hundredths / 100;
  const d = u.data;
  return (
    <div className="row small" data-testid="colab-usage">
      <Badge tone={balance < Math.max(5, perHour * 2) ? "warn" : "neutral"}>
        {balance.toFixed(2)} compute units left
      </Badge>
      <span>
        using {perHour.toFixed(2)}/h on {d.runtimes} runtime{d.runtimes === 1 ? "" : "s"}
      </span>
      <span className="faint">
        (the whole Google account
        {perHour > 0 ? `; about ${(balance / perHour).toFixed(1)} h left at this rate` : ""},
        checked {fmtTime(d.checked_at)})
      </span>
    </div>
  );
}

function RemoteTargets() {
  const list = useApi<{ targets: ComputeTargetView[] }>("/api/v1/targets");
  const [checks, setChecks] = useState<Record<string, Check[]>>({});
  const doctor = useAction(async (id: string) => {
    const r = await api<{ checks: Check[] }>(`/api/v1/targets/${encodeURIComponent(id)}/doctor`, {
      body: {},
    });
    setChecks((c) => ({ ...c, [id]: r.checks }));
  });
  return (
    <section className="card" data-testid="remote-targets">
      <h2>Remote targets</h2>
      <p className="faint small">
        Add one with <code>ablationkit target add ID --kind ssh|slurm|runpod|colab</code> (Colab:{" "}
        <code>--kind colab --gpu L4</code>, after signing in once with <code>colab sessions</code>).
        Jobs on a target keep running when this workstation is off and reconcile when it is back.
      </p>
      <ErrorBox error={list.error ?? doctor.error} onRetry={list.reload} />
      {!list.data ? <Loading /> : null}
      {list.data?.targets.length === 0 ? <Empty>No remote targets.</Empty> : null}
      {list.data?.targets.map((t) => {
        const cap = t.capabilities ?? {};
        const colabCli = t.kind === "colab" && t.colab?.mode === "cli";
        return (
          <div key={t.target_id} className="stack" style={{ marginTop: 10, gap: 4 }}>
            <div className="row">
              <strong>{t.label ?? t.target_id}</strong>
              <Badge tone="info">{t.kind}</Badge>
              {t.paid ? (
                <Badge tone="warn" title="each submission needs accepted cost">
                  paid
                  {t.runpod?.cents_per_hour !== undefined
                    ? ` · ${fmtCents(t.runpod.cents_per_hour)}/h (estimate)`
                    : " · no rate card"}
                </Badge>
              ) : null}
              {t.runpod?.gpu_type_ids.length ? (
                <Badge>{t.runpod.gpu_type_ids.join(", ")}</Badge>
              ) : null}
              {colabCli ? (
                <Badge>
                  {t.colab?.tpu
                    ? `TPU ${t.colab.tpu}`
                    : t.colab?.gpu
                      ? `GPU ${t.colab.gpu}`
                      : "CPU"}
                  {t.colab?.high_mem ? " · high RAM" : ""}
                </Badge>
              ) : null}
              {!t.available ? <Badge tone="err">adapter unavailable</Badge> : null}
              {cap["exports"] ? (
                <Badge>notebook export only</Badge>
              ) : cap["independent_supervision"] ? (
                <Badge tone="ok" title="the job's lifetime does not depend on this workstation">
                  runs while offline
                </Badge>
              ) : null}
              <button
                type="button"
                className="small"
                style={{ marginLeft: "auto" }}
                disabled={doctor.busy}
                onClick={() => void doctor.run(t.target_id)}
              >
                Doctor
              </button>
            </div>
            {t.kind === "colab" && !t.colab?.live ? (
              <div className="faint small">
                {colabCli
                  ? "Unattended through Google's Colab CLI: a runtime per job, results collected while it runs, the runtime stopped after."
                  : "Exported notebooks you run in Colab; results come back with remote import."}
              </div>
            ) : (
              <div className="faint small mono">
                {t.ssh?.host ?? t.runpod?.image ?? ""}
                {t.effective_worker_url ? ` → ${t.effective_worker_url}` : " · no worker URL"}
              </div>
            )}
            {colabCli ? <ColabUsageLine targetId={t.target_id} /> : null}
            {checks[t.target_id]?.map((c) => (
              <div key={c.name} className="row small">
                <Badge tone={c.ok ? "ok" : "err"}>{c.ok ? "ok" : "fail"}</Badge>
                <span>{c.name}</span>
                <span className="faint">{c.detail}</span>
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}

interface WeightRow {
  target_id: string;
  label: string;
  kind: string;
  weight: number;
  default: boolean;
  /** Jobs needing a GPU at once there (ADR 0068). */
  slots: number;
  slots_default: boolean;
}

/** A slot count as typed: a whole number from 1 to 64, or an error to show. */
function parseSlotsInput(v: string): number | { error: string } {
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : { error: "a whole number from 1 to 64" };
}

interface ComputeOverview {
  weights: WeightRow[];
  updated_at?: string;
  projects: AgentUsage[];
}

function useOverview() {
  const o = useApi<ComputeOverview>("/api/v1/compute");
  useEvents(() => o.reload(), { types: ["job.state", "job.attempt.state", "policy.revised"] });
  return o;
}

/** Every project's agent-submitted jobs against its compute limit (ADR 0037). */
function AgentCompute() {
  const o = useOverview();
  const rows = o.data?.projects ?? [];
  return (
    <section className="card" data-testid="agent-compute">
      <h2>Agent compute</h2>
      <p className="faint small">
        Weighted hours of agent-submitted jobs against each project's limit. Running jobs reserve
        the rest of their time limit, and queued ones all of it. Raise a limit in the project's
        settings.
      </p>
      <ErrorBox error={o.error} />
      {!o.data ? <Loading /> : null}
      {o.data && rows.length === 0 ? <Empty>No projects.</Empty> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Used</th>
                <th>Reserved</th>
                <th>Limit</th>
                <th style={{ width: "30%" }}>Usage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.project_id}>
                  <td>
                    <Link to={`/p/${encodeURIComponent(u.project_id)}/settings#agent-permissions`}>
                      {u.name}
                    </Link>
                    {u.over_limit || u.refused ? (
                      <>
                        {" "}
                        <Badge tone="warn" title={u.refused?.message}>
                          {u.over_limit
                            ? "over the limit"
                            : `${u.refused?.count ?? 0} job${u.refused?.count === 1 ? "" : "s"} refused`}
                        </Badge>
                      </>
                    ) : null}
                  </td>
                  <td className="nowrap">{fmtWeightedHours(u.used_hours)} h</td>
                  <td className="nowrap">
                    {fmtWeightedHours(u.reserved_hours)} h
                    {u.queued ? <span className="faint small"> · {u.queued} queued</span> : null}
                  </td>
                  <td className="nowrap">{u.limit_hours} h</td>
                  <td>
                    <ComputeMeter
                      used={u.used_hours}
                      reserved={u.reserved_hours}
                      limit={u.limit_hours}
                      label={`Agent compute in ${u.name}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Machine-wide weights (an hour on a target counts as its weight against agent limits) and slots
 * (how many jobs needing a GPU run there at once; agents' jobs queue for a free one, ADR 0068).
 */
function Weights() {
  const o = useOverview();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [slotDraft, setSlotDraft] = useState<Record<string, string>>({});
  const errors = Object.fromEntries(
    Object.entries(draft).flatMap(([k, v]) => {
      const p = parseWeightInput(v);
      return typeof p === "number" ? [] : [[k, p.error]];
    }),
  );
  const slotErrors = Object.fromEntries(
    Object.entries(slotDraft).flatMap(([k, v]) => {
      const p = parseSlotsInput(v);
      return typeof p === "number" ? [] : [[k, p.error]];
    }),
  );
  const save = useAction(async () => {
    const weights = Object.fromEntries(
      Object.entries(draft).map(([k, v]) => [k, parseWeightInput(v) as number]),
    );
    const slots = Object.fromEntries(
      Object.entries(slotDraft).map(([k, v]) => [k, parseSlotsInput(v) as number]),
    );
    await api("/api/v1/compute/weights", { method: "PUT", body: { weights, slots } });
    setDraft({});
    setSlotDraft({});
    o.reload();
  });
  const dirty = Object.keys(draft).length > 0 || Object.keys(slotDraft).length > 0;
  const invalid = Object.keys(errors).length > 0 || Object.keys(slotErrors).length > 0;
  return (
    <details className="fold" data-testid="compute-weights">
      <summary className="fold-head">
        <h2>Compute weights and slots</h2>
        <span className="faint small">
          How much an hour on each target counts against the agent compute limits, and how many GPU
          jobs run there at once.
        </span>
      </summary>
      <section className="card">
        <p className="faint small">
          Weights: for example 1 for this workstation and 3 for an A100; an agent's job counts at
          the weight of the target it was placed on. Slots: how many jobs needing a GPU run on a
          target at once (1 by default, 2 for Colab); agents' jobs wait in a queue for a free one,
          and jobs without a GPU run on this workstation beside them.
        </p>
        <ErrorBox error={o.error ?? save.error} />
        {!o.data ? (
          <Loading />
        ) : (
          <>
            {o.data.weights.map((w) => (
              <div key={w.target_id} className="perm-row">
                <div>
                  <div>{w.target_id === "local" ? "This workstation" : w.label}</div>
                  <div className="faint small">
                    {w.kind}
                    {w.target_id !== "local" && w.label !== w.target_id ? ` · ${w.target_id}` : ""}
                  </div>
                </div>
                <div className="perm-control">
                  <input
                    aria-label={`Weight of ${w.target_id}`}
                    inputMode="decimal"
                    style={{ width: 80 }}
                    value={draft[w.target_id] ?? String(w.weight)}
                    onChange={(e) => setDraft((d) => ({ ...d, [w.target_id]: e.target.value }))}
                  />
                  <span className="small">×</span>
                  <input
                    aria-label={`Slots on ${w.target_id}`}
                    inputMode="numeric"
                    style={{ width: 56 }}
                    value={slotDraft[w.target_id] ?? String(w.slots)}
                    onChange={(e) => setSlotDraft((d) => ({ ...d, [w.target_id]: e.target.value }))}
                  />
                  <span className="small">{w.slots === 1 ? "slot" : "slots"}</span>
                  {errors[w.target_id] || slotErrors[w.target_id] ? (
                    <span className="small" style={{ color: "var(--err)" }}>
                      {errors[w.target_id] ?? slotErrors[w.target_id]}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
            <div className="row end">
              <span className="faint small">
                {o.data.updated_at
                  ? `Last changed ${fmtTime(o.data.updated_at)}`
                  : "All weights are 1."}
              </span>
              <button
                type="button"
                disabled={!dirty}
                onClick={() => {
                  setDraft({});
                  setSlotDraft({});
                }}
              >
                Discard
              </button>
              <button
                type="button"
                className="primary"
                disabled={!dirty || invalid || save.busy}
                onClick={() => void save.run()}
              >
                Save
              </button>
            </div>
          </>
        )}
      </section>
    </details>
  );
}
