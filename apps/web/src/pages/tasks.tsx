/**
 * Tasks (ADR 0039, 0048): the questions put to agents and their answers. An agent creates a task
 * (the `ablationkit_task create` tool of `ablationkit mcp`, ADR 0040), runs jobs and writes
 * records under it, and completes it with an outcome, a conclusion and a report. A task's page is
 * a brief: the question, the answer, what was claimed, tested and decided on the way, and only
 * then the jobs and IDs behind it. The researcher reads, reviews and may abandon an open task.
 */
import { api, useApi, useEvents } from "../api.ts";
import { Markdown, plainExcerpt } from "../components/Markdown.tsx";
import { ReviewBar } from "../components/Review.tsx";
import {
  attemptTone,
  Badge,
  Empty,
  ErrorBox,
  KV,
  Link,
  Loading,
  type Tone,
  TrailActions,
  TrailLeaf,
  useAction,
} from "../components/ui.tsx";
import { TaskDrawer, type TaskRun } from "../components/Witness.tsx";
import { useAgentSessions } from "../lib/agent-sessions.ts";
import { fmtTime, shortId } from "../lib/format.ts";
import { RESEARCH_MAP, type ReviewInfo, refHref, statusTone } from "../lib/research.ts";
import { KnowledgeTabs } from "./knowledge.tsx";

export interface TaskView {
  task_id: string;
  title: string;
  goal: string;
  criteria: string[];
  status: "open" | "completed" | "abandoned";
  outcome?: "supported" | "not_supported" | "inconclusive";
  report_id?: string;
  conclusion?: string;
  reason?: string;
  created_by: { kind: string; id?: string };
  created_at: string;
  closed_at?: string;
}

interface TaskRecord {
  record_id: string;
  kind: string;
  title: string;
  status?: string;
  summary?: string;
  created_at: string;
}

interface TaskWork {
  task: TaskView;
  jobs: {
    job_id: string;
    state?: string;
    mlflow_run_id?: string;
    run_name?: string;
    description?: string;
    study_id?: string;
    variant_id?: string;
  }[];
  records: TaskRecord[];
  imported_runs?: { ref: string; source?: string; mlflow_run_id?: string }[];
  /** Every run, cited, set aside or unaccounted for (ADR 0056). */
  runs?: TaskRun[];
  checks?: { code: string; ref: string; message: string }[];
  review?: ReviewInfo;
}

const tasksPath = (pid: string) => `/api/v1/projects/${encodeURIComponent(pid)}/tasks`;
const TASK_EVENTS = ["task.created", "task.updated", "research.created", "research.updated"];
const TASK_ROLE = RESEARCH_MAP.find((k) => k.id === "task")?.role ?? "";

export function taskTone(t: Pick<TaskView, "status" | "outcome">): Tone {
  if (t.status === "open") return "info";
  if (t.status === "abandoned") return "neutral";
  return t.outcome === "supported" ? "ok" : t.outcome === "not_supported" ? "err" : "warn";
}

function taskStatusText(t: Pick<TaskView, "status" | "outcome">): string {
  return t.status === "completed" && t.outcome
    ? `completed · ${t.outcome.replace("_", " ")}`
    : t.status;
}

export function TasksRouter(props: { pid: string; base: string; rest: string }) {
  const tid = props.rest.split("/")[1];
  return (
    <div className="stack">
      <KnowledgeTabs base={props.base} active="task" />
      {tid ? (
        <TaskDetail key={tid} pid={props.pid} base={props.base} tid={decodeURIComponent(tid)} />
      ) : (
        <TaskList pid={props.pid} base={props.base} />
      )}
    </div>
  );
}

function TaskList(props: { pid: string; base: string }) {
  const tasks = useApi<{ tasks: TaskView[] }>(tasksPath(props.pid));
  useEvents(() => tasks.reload(), { project: props.pid, types: TASK_EVENTS });
  const who = useAgentSessions(props.pid);
  return (
    <>
      <p className="muted small role" data-testid="kind-role">
        {TASK_ROLE}
      </p>
      <ErrorBox error={tasks.error} />
      {!tasks.data ? <Loading /> : null}
      {tasks.data?.tasks.length === 0 ? (
        <Empty>
          No tasks yet. An agent creates one with the <code>ablationkit_task create</code> tool of{" "}
          <code>ablationkit mcp</code>.
        </Empty>
      ) : null}
      {tasks.data?.tasks.length ? (
        <div className="table-wrap">
          <table data-testid="tasks-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {tasks.data.tasks.map((t) => {
                return (
                  <tr key={t.task_id}>
                    <td>
                      <Link
                        to={`${props.base}/tasks/${encodeURIComponent(t.task_id)}`}
                        className="rtitle"
                      >
                        {t.title}
                      </Link>
                      <div className="muted rsum">
                        {t.conclusion ? (
                          plainExcerpt(t.conclusion, 320)
                        ) : (
                          <>
                            <span className="faint">Goal: </span>
                            {plainExcerpt(t.goal, 280)}
                          </>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="row nowrap">
                        <Badge tone={taskTone(t)}>{taskStatusText(t)}</Badge>
                      </span>
                    </td>
                    <td className="small">
                      {fmtTime(t.created_at)}
                      <div className="faint">{who.actor(t.created_by)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

/** Records under a task, in the order a reader wants them. */
const GROUPS: [string, string, string][] = [
  ["hypothesis", "Hypotheses", "What was claimed, and how each claim came out."],
  ["study", "Studies", "The experiments that were run."],
  ["decision", "Decisions", "What was chosen because of it."],
  ["approach", "Approaches", "Methods and designs tried."],
  ["report", "Reports", "The written conclusions."],
  ["note", "Notes", "Observations, audits and logs."],
];

function TaskDetail(props: { pid: string; base: string; tid: string }) {
  const path = `${tasksPath(props.pid)}/${encodeURIComponent(props.tid)}`;
  const w = useApi<TaskWork>(path);
  useEvents(() => w.reload(), { project: props.pid, types: [...TASK_EVENTS, "job.attempt.state"] });
  const who = useAgentSessions(props.pid);
  const abandon = useAction(async () => {
    const reason = window.prompt("Why abandon this task? (optional)");
    if (reason === null) return;
    await api(`${path}/abandon`, { body: reason.trim() ? { reason: reason.trim() } : {} });
    w.reload();
  });
  if (w.error) return <ErrorBox error={w.error} onRetry={w.reload} />;
  if (!w.data) return <Loading />;
  const t = w.data.task;
  const records = w.data.records;
  const report = records.find((r) => r.record_id === t.report_id);
  const checks = w.data.checks ?? [];
  return (
    <div className="stack read">
      <ReviewBar
        pid={props.pid}
        base={props.base}
        kind="task"
        id={t.task_id}
        review={w.data.review}
        onChanged={w.reload}
      />
      <header className="readhead ph">
        <TrailLeaf>{t.title}</TrailLeaf>
        <div className="row">
          <span className="eyebrow" style={{ margin: 0 }}>
            Task
          </span>
          <Badge tone={taskTone(t)}>{taskStatusText(t)}</Badge>
          <span className="faint small">
            by {who.actor(t.created_by)} · {fmtTime(t.created_at)}
            {t.closed_at ? ` → ${fmtTime(t.closed_at)}` : ""}
          </span>
          {t.status === "open" ? (
            <TrailActions>
              <button
                type="button"
                className="small"
                disabled={abandon.busy}
                onClick={() => void abandon.run()}
              >
                Abandon
              </button>
            </TrailActions>
          ) : null}
        </div>
        <h1 className="readtitle" data-testid="task-title">
          {t.title}
        </h1>
      </header>
      <ErrorBox error={abandon.error} />
      <div className="grid2 brief">
        <section className="card" data-testid="task-question">
          <h2>The question</h2>
          <Markdown text={t.goal} base={props.base} />
          {t.criteria.length ? (
            <>
              <h3>What would settle it</h3>
              <ul className="plain">
                {t.criteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
        <section className="card" data-testid="task-answer">
          <h2>
            The answer{" "}
            {t.status === "completed" && t.outcome ? (
              <Badge tone={taskTone(t)}>{t.outcome.replace("_", " ")}</Badge>
            ) : null}
          </h2>
          {t.conclusion ? (
            <Markdown text={t.conclusion} base={props.base} lede />
          ) : t.status === "open" ? (
            <p className="muted">Still open: the agent has not completed it.</p>
          ) : t.status === "abandoned" ? (
            <p className="muted">
              Abandoned{t.reason ? ": " : "."}
              {t.reason ? <span>{t.reason}</span> : null}
            </p>
          ) : report?.summary ? (
            <Markdown text={report.summary} base={props.base} />
          ) : (
            <p className="faint">
              Completed without a written conclusion. Read its report for what was found.
            </p>
          )}
          {report ? (
            <p className="small" style={{ marginTop: 12 }}>
              <span className="faint">Full report: </span>
              <Link to={`${props.base}/knowledge/r/${encodeURIComponent(report.record_id)}`}>
                {report.title}
              </Link>
            </p>
          ) : t.report_id ? (
            <p className="small">
              <Link to={`${props.base}/knowledge/r/${encodeURIComponent(t.report_id)}`}>
                Report {t.report_id}
              </Link>
            </p>
          ) : null}
        </section>
      </div>
      {checks.length ? (
        <section className="card" data-testid="task-checks">
          <h2>
            Loose ends <Badge tone="warn">{checks.length}</Badge>
          </h2>
          <p className="muted small">
            Where the records under this task no longer match its runs, or say too little to read.
            The agent sees the same list and is told to fix it before handing back.
          </p>
          <ul className="plain">
            {checks.map((c) => (
              <li key={`${c.code}:${c.ref}`} className="small">
                {c.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {GROUPS.map(([kind, label, role]) => {
        const items = records.filter((r) => r.kind === kind);
        if (!items.length) return null;
        return (
          <section key={kind} className="card" data-testid={`task-${kind}`}>
            <h2>
              {label} <span className="faint small">{items.length}</span>
            </h2>
            <p className="faint small">{role}</p>
            {items.map((r) => (
              <div key={r.record_id} className="relitem">
                <div className="titleline">
                  {r.status ? <Badge tone={statusTone(r.status)}>{r.status}</Badge> : null}
                  <Link
                    to={refHref(props.base, { kind: r.kind, id: r.record_id }) ?? props.base}
                    className="rtitle"
                  >
                    {r.title}
                  </Link>
                </div>
                {r.summary ? (
                  <p className="muted rsum">{plainExcerpt(r.summary, 360)}</p>
                ) : (
                  <p className="rsum">
                    <Badge tone="warn">no summary</Badge>
                  </p>
                )}
              </div>
            ))}
          </section>
        );
      })}
      {w.data.jobs.length || w.data.imported_runs?.length ? (
        <section className="card" data-testid="task-runs">
          <h2>
            Runs{" "}
            <span className="faint small">
              {w.data.jobs.length + (w.data.imported_runs?.length ?? 0)}
            </span>
          </h2>
          {w.data.jobs.map((j) => (
            <div key={j.job_id} className="relitem">
              <div className="titleline">
                {j.state ? <Badge tone={attemptTone(j.state)}>{j.state}</Badge> : null}
                <Link
                  to={
                    j.mlflow_run_id
                      ? `${props.base}/runs/r/${encodeURIComponent(j.mlflow_run_id)}`
                      : `${props.base}/runs/jobs/${encodeURIComponent(j.job_id)}`
                  }
                >
                  {j.run_name ?? shortId(j.job_id, 22)}
                </Link>
                {j.study_id ? (
                  <Link
                    to={`${props.base}/runs/studies/${encodeURIComponent(j.study_id)}`}
                    className="faint small"
                  >
                    {j.study_id}
                    {j.variant_id ? ` / ${j.variant_id}` : ""}
                  </Link>
                ) : null}
                <Link
                  to={`${props.base}/runs/jobs/${encodeURIComponent(j.job_id)}`}
                  className="faint small"
                >
                  job
                </Link>
              </div>
              {j.description ? <p className="muted rsum">{j.description}</p> : null}
            </div>
          ))}
          {w.data.imported_runs?.map((r) => (
            <div key={r.ref} className="row small">
              <Badge title="Run before the project used AblationKit; imported from its files">
                imported
              </Badge>
              {r.mlflow_run_id ? (
                <Link to={`${props.base}/runs/r/${encodeURIComponent(r.mlflow_run_id)}`}>
                  {r.source ?? shortId(r.mlflow_run_id)}
                </Link>
              ) : (
                <span>{r.source ?? r.ref} (pending)</span>
              )}
            </div>
          ))}
        </section>
      ) : null}
      {w.data.runs?.length ? <TaskDrawer runs={w.data.runs} base={props.base} /> : null}
      <details className="provenance">
        <summary className="small">Provenance: IDs</summary>
        <KV
          rows={[
            [
              "task",
              <span key="id" className="mono">
                {t.task_id}
              </span>,
            ],
            ["created", `${fmtTime(t.created_at)} by ${who.actor(t.created_by)}`],
            ...(t.closed_at ? ([["closed", fmtTime(t.closed_at)]] as [string, string][]) : []),
            ...(t.report_id ? ([["report", t.report_id]] as [string, string][]) : []),
            ["jobs", w.data.jobs.map((j) => j.job_id).join(", ") || "none"],
          ]}
        />
      </details>
    </div>
  );
}
