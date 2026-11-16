/**
 * Project layer (spec §2.2, simplified by ADR 0036, ADR 0049, ADR 0055): Overview (the vault in
 * brief and what the agents did), Standing, Notebooks, Runs, Data & Evals, Models, extensions,
 * Project settings. Review, Knowledge and Tasks stay routable as the vault's provenance, under
 * "More". The UI reads results, notes, graphs and compute; agents record their work under tasks
 * through `ablationkit mcp`, and Tasks lists them read-only (ADR 0039). Project settings holds the
 * agents' permissions (the project policy and its compute limit, ADR 0037) and sessions.
 */

import { type ReactNode, useEffect, useState } from "react";
import { api, useApi, useEvents } from "../api.ts";
import { useShell } from "../app.tsx";
import { AgentContainers } from "../components/AgentContainers.tsx";
import { AgentPermissions, type AgentUsage } from "../components/AgentPermissions.tsx";
import { AgentSessions } from "../components/AgentSessions.tsx";
import { BackendProjectPage } from "../components/BackendPage.tsx";
import { plainExcerpt } from "../components/Markdown.tsx";
import {
  attemptTone,
  Badge,
  type Crumb,
  ErrorBox,
  KV,
  Link,
  Loading,
  Modal,
  PageHead,
  Trail,
  useAction,
} from "../components/ui.tsx";
import { shortId } from "../lib/format.ts";
import { fmtWeightedHours } from "../lib/policy.ts";
import { KINDS } from "../lib/research.ts";
import type { JobView } from "../lib/types.ts";
import { cap, edDay, edName, fmtDay, plainLinks } from "../lib/vault.ts";
import { useVaultStore } from "../lib/vault-store.ts";
import { MODELS_TABS, RUNS_TABS, TASK_PROFILES } from "../nav.ts";
import {
  ExtensionActions,
  ExtensionPanelLinks,
  ExtensionPanelPage,
  ExtensionsPage,
} from "./extensions.tsx";
import { KnowledgeRouter, KnowledgeTabs } from "./knowledge.tsx";
import { DataRouter, ModelsRouter } from "./lifecycle.tsx";
import { ReviewPage } from "./review.tsx";
import { RunsRouter } from "./runs.tsx";
import { OverviewBrief } from "./standing.tsx";
import { TasksRouter, type TaskView } from "./tasks.tsx";
import { VaultRouter } from "./vault.tsx";

export function ProjectRouter(props: { pid: string; rest: string }) {
  const { projects } = useShell();
  const project = projects.find((p) => p.project_id === props.pid);
  const seg = props.rest.split("/")[1] ?? "";
  const base = `/p/${encodeURIComponent(props.pid)}`;
  const settings = useApi<{ description?: string }>(
    seg === "" ? `/api/v1/projects/${encodeURIComponent(props.pid)}/settings` : undefined,
  );

  if (!project) {
    return (
      <div className="page">
        {projects.length ? (
          <ErrorBox error={new Error(`no registered project ${props.pid}`)} />
        ) : (
          <Loading />
        )}
      </div>
    );
  }

  // The vault's pages are read full width under their own trail (ADR 0049).
  if (seg === "standing" || seg === "notebooks")
    return <VaultRouter pid={props.pid} base={base} rest={props.rest} name={project.name} />;

  let body: ReactNode;
  switch (seg) {
    case "":
      body = <Overview pid={props.pid} base={base} />;
      break;
    case "x":
      body = (
        <ExtensionPanelPage pid={props.pid} base={base} rest={props.rest.slice("/x".length)} />
      );
      break;
    case "review":
      body = (
        <>
          <KnowledgeTabs base={base} active="review" />
          <ReviewPage pid={props.pid} base={base} />
        </>
      );
      break;
    case "tasks":
      body = <TasksRouter pid={props.pid} base={base} rest={props.rest.slice("/tasks".length)} />;
      break;
    case "knowledge":
      body = (
        <KnowledgeRouter pid={props.pid} base={base} rest={props.rest.slice("/knowledge".length)} />
      );
      break;
    case "runs":
      body = <RunsRouter pid={props.pid} base={base} rest={props.rest.slice("/runs".length)} />;
      break;
    case "data":
      body = <DataRouter pid={props.pid} base={base} rest={props.rest.slice("/data".length)} />;
      break;
    case "models":
      body = <ModelsRouter pid={props.pid} base={base} rest={props.rest.slice("/models".length)} />;
      break;
    case "settings":
      body = props.rest.startsWith("/settings/extensions") ? (
        <ExtensionsPage
          pid={props.pid}
          base={base}
          rest={props.rest.slice("/settings/extensions".length)}
        />
      ) : (
        <ProjectSettings pid={props.pid} base={base} />
      );
      break;
    default:
      body = <BackendProjectPage pid={props.pid} base={base} rest={props.rest} />;
  }

  const head = pageHead(props.rest, base, project.name);
  return (
    <Trail crumbs={head.crumbs} leaf={head.leaf} project={project.name}>
      <div className="page">
        {head.title ? (
          <PageHead
            eyebrow={seg === "" ? "Project" : project.name}
            title={head.title}
            lede={seg === "" ? settings.data?.description : head.lede}
          />
        ) : null}
        {body}
      </div>
    </Trail>
  );
}

/**
 * Each project page's trail and head (ADR 0055): the trail runs project › section › tab, and an
 * object page (a run, a study, a job, a record, a task, a panel, a backend page) adds its own
 * name to it and writes its own head; a section page gets the section's title and a lede.
 */
export function pageHead(
  rest: string,
  base: string,
  name: string,
): { crumbs: Crumb[]; leaf: boolean; title?: string; lede?: string } {
  const parts = rest.split("/").filter(Boolean);
  const [seg = "", sub, id] = parts;
  const crumbs: Crumb[] = [{ label: name, to: base }];
  const section = (label: string, path: string) => crumbs.push({ label, to: `${base}${path}` });
  switch (seg) {
    case "":
      return { crumbs, leaf: false, title: name };
    case "runs": {
      section("Runs", "/runs");
      const tab = RUNS_TABS.find((t) => t.id === sub);
      if (tab) section(tab.label, tab.path);
      if ((sub === "r" || sub === "studies" || sub === "jobs") && id) return { crumbs, leaf: true };
      return { crumbs, leaf: false, title: "Runs", lede: SECTION_LEDE.runs };
    }
    case "data":
      section("Data & Evals", "/data");
      if (sub === "evaluations") section("Evaluations", "/data/evaluations");
      return { crumbs, leaf: false, title: "Data & Evals", lede: SECTION_LEDE.data };
    case "models": {
      section("Models", "/models");
      const tab = MODELS_TABS.find((t) => t.id === sub);
      if (tab) section(tab.label, tab.path);
      return { crumbs, leaf: false, title: "Models", lede: SECTION_LEDE.models };
    }
    case "knowledge":
    case "tasks":
    case "review": {
      section("Original records", "/knowledge");
      const kind = KINDS.find((k) => k.tab === sub);
      if (seg === "tasks") section("Tasks", "/tasks");
      else if (seg === "review") section("Review", "/review");
      else if (kind) section(kind.label, `/knowledge/${kind.tab}`);
      if ((seg === "tasks" && sub) || (seg === "knowledge" && sub === "r" && id))
        return { crumbs, leaf: true };
      return { crumbs, leaf: false, title: "Original records", lede: SECTION_LEDE.records };
    }
    case "settings":
      section("Project settings", "/settings");
      if (sub === "extensions") {
        section("Extensions", "/settings/extensions");
        return { crumbs, leaf: Boolean(id), title: "Extensions", lede: SECTION_LEDE.extensions };
      }
      return { crumbs, leaf: false, title: "Project settings", lede: SECTION_LEDE.settings };
    default:
      // An extension panel (/x/…) or a backend page names itself.
      return { crumbs, leaf: true };
  }
}

const SECTION_LEDE = {
  runs: "Studies, the runs they compare, and the jobs that made them.",
  data: "The datasets runs used and the evaluations run on them.",
  models: "Logged and registered models, inference and demos.",
  records:
    "Tasks, hypotheses, reports and decisions as they were written: the vault was distilled from them.",
  extensions: "Project views, actions and analyses: review, enable, disable and roll back.",
  settings: "What agents may do here, how the project is shown, and the checkout's health.",
};

/**
 * The Overview (ADR 0055): where the project stands, in brief, from the vault, and what the
 * agents did. The legacy record lists are not repeated here; they are the vault's provenance.
 */
function Overview(props: { pid: string; base: string }) {
  const doctor = useApi<{
    status: string;
    checks: { name: string; status: string; detail?: string }[];
  }>(`/api/v1/projects/${encodeURIComponent(props.pid)}/doctor`);
  return (
    <>
      <CheckoutAlert base={props.base} doctor={doctor.data} />
      <div className="grid2 overview">
        <OverviewBrief pid={props.pid} base={props.base} />
        <AgentsDid pid={props.pid} base={props.base} />
      </div>
      <ExtensionActions pid={props.pid} />
      <ExtensionPanelLinks pid={props.pid} base={props.base} />
    </>
  );
}

/**
 * What the agents did (ADR 0055): the last sessions (the vault's editions) with their gists, the
 * tasks one line each, the jobs running now, and the agents' compute against the project's limit
 * when any is used.
 */
function AgentsDid(props: { pid: string; base: string }) {
  const p = encodeURIComponent(props.pid);
  const store = useVaultStore(props.pid);
  const v = store?.vault;
  const tasks = useApi<{ tasks: TaskView[] }>(`/api/v1/projects/${p}/tasks`);
  const jobs = useApi<{ jobs: JobView[] }>(`/api/v1/projects/${p}/jobs?limit=20`);
  const compute = useApi<{ projects: AgentUsage[] }>("/api/v1/compute");
  useEvents(() => tasks.reload(), {
    project: props.pid,
    types: ["task.created", "task.updated"],
  });
  useEvents(
    () => {
      jobs.reload();
      compute.reload();
    },
    { project: props.pid, types: ["job.attempt.state"] },
  );
  const eds = v ? [...v.editions].reverse() : [];
  const all = tasks.data?.tasks ?? [];
  const when = (t: TaskView) => t.closed_at ?? t.created_at;
  const sorted = [...all].sort(
    (a, b) =>
      Number(b.status === "open") - Number(a.status === "open") || when(b).localeCompare(when(a)),
  );
  const running = (jobs.data?.jobs ?? []).filter(
    (j) => j.state === "running" || j.state === "starting",
  );
  const usage = compute.data?.projects.find((u) => u.project_id === props.pid);
  const used = usage && usage.used_hours + usage.reserved_hours > 0 ? usage : undefined;
  const titleOf = (id: string) => v?.get(id)?.title;
  const enc = encodeURIComponent;
  return (
    <section className="card ov-agents" data-testid="findings">
      <h2>What the agents did</h2>
      <ErrorBox error={tasks.error} />
      {eds.length ? (
        <>
          <h3>Sessions</h3>
          {eds.slice(0, 3).map((ed) => (
            <div key={ed.note_id} className="relitem ov-ses">
              <div className="titleline">
                <span className="ov-date">{fmtDay(edDay(ed))}</span>{" "}
                <Link to={`${props.base}/notebooks/n/${enc(ed.note_id)}`} className="rtitle">
                  {cap(edName(ed))}
                </Link>
                {store?.status(ed.note_id) === "read" ? null : (
                  <span className="faint small"> · not read yet</span>
                )}
              </div>
              <p className="muted rsum">{plainExcerpt(plainLinks(ed.gist, titleOf), 260)}</p>
              {ed.task_id ? (
                <Link to={`${props.base}/tasks/${enc(ed.task_id)}`} className="small faint">
                  its task →
                </Link>
              ) : null}
            </div>
          ))}
          {eds.length > 3 ? (
            <Link to={`${props.base}/notebooks`} className="small">
              all {eds.length} sessions →
            </Link>
          ) : null}
        </>
      ) : null}
      {all.length ? (
        <>
          <h3>Tasks</h3>
          {sorted.slice(0, 5).map((t) => (
            <div key={t.task_id} className="titleline small relrow">
              {t.status === "open" ? <Badge tone="info">open</Badge> : null}
              <Link to={`${props.base}/tasks/${enc(t.task_id)}`}>{t.title}</Link>
              {t.status === "open" ? null : (
                <span className="faint">
                  {t.status === "completed" && t.outcome ? t.outcome.replace("_", " ") : t.status}
                </span>
              )}
            </div>
          ))}
          {all.length > 5 ? (
            <Link to={`${props.base}/tasks`} className="small">
              all {all.length} tasks →
            </Link>
          ) : null}
        </>
      ) : null}
      {running.length ? (
        <>
          <h3>Running now</h3>
          {running.map((j) => (
            <div key={j.job_id} className="row small">
              <Badge tone={attemptTone(j.state)}>{j.state}</Badge>
              <Link to={`${props.base}/runs/jobs/${enc(j.job_id)}`}>
                {j.run_name ?? shortId(j.job_id, 14)}
              </Link>
            </div>
          ))}
        </>
      ) : null}
      {used ? (
        <p className="small muted ov-compute">
          Agent compute: {fmtWeightedHours(used.used_hours)} of {used.limit_hours} weighted hours
          used
          {used.reserved_hours ? `, ${fmtWeightedHours(used.reserved_hours)} reserved` : ""}.{" "}
          <Link to={`${props.base}/settings#agents`}>The limit →</Link>
        </p>
      ) : null}
      {!eds.length && !all.length && !running.length && tasks.data ? (
        <p className="faint small">
          No agent has reported into this project yet. An agent session starts when its harness runs{" "}
          <code>ablationkit mcp</code>; its sessions, tasks and jobs appear here.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The checkout's health, only when it needs a look (ADR 0055): one line that names the checks
 * that are not ok and links to Project settings, where the project doctor's full report is.
 */
function CheckoutAlert(props: {
  base: string;
  doctor: { status: string; checks: { name: string; status: string }[] } | undefined;
}) {
  const d = props.doctor;
  if (!d || d.status === "ok") return null;
  const off = d.checks.filter((c) => c.status !== "ok").map((c) => c.name);
  const bad = d.status !== "warn";
  return (
    <p className={bad ? "banner err" : "small muted alertline"} data-testid="checkout-alert">
      <span className={`dot ${bad ? "err" : "warn"}`} /> Checkout {bad ? "check failed" : "warning"}
      {off.length ? `: ${off.join(", ")}` : ""}.{" "}
      <Link to={`${props.base}/settings#health`}>Project settings →</Link>
    </p>
  );
}

function ProjectSettings(props: { pid: string; base: string }) {
  const settings = useApi<{
    manifest_found: boolean;
    task_profiles: string[];
    description?: string;
  }>(`/api/v1/projects/${encodeURIComponent(props.pid)}/settings`);
  const doctor = useApi<{
    status: string;
    checks: { name: string; status: string; detail?: string }[];
  }>(`/api/v1/projects/${encodeURIComponent(props.pid)}/doctor`);
  const [draft, setDraft] = useState<string[] | undefined>();
  const current = draft ?? settings.data?.task_profiles ?? [];
  const save = useAction(async () => {
    await api(`/api/v1/projects/${encodeURIComponent(props.pid)}/settings`, {
      method: "PATCH",
      body: { task_profiles: current },
    });
    setDraft(undefined);
    settings.reload();
    // The sidebar re-reads profiles on navigation; reload to apply now.
    location.reload();
  });
  // Links point at a section (`#agents`, `#health`); arrive there once the page has its height.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (doctor.data && ["agents", "shown", "health"].includes(id))
      document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [doctor.data]);
  return (
    <>
      <section className="ps" id="agents">
        <h2 className="ps-h">Agents</h2>
        <p className="muted small">
          What agents may do in this project and how much compute they may use, and the agent
          sessions that reported into it. An agent works in its own harness and reports in through{" "}
          <code>ablationkit mcp</code>.
        </p>
        <div className="stack">
          <AgentPermissions pid={props.pid} />
          <AgentSessions pid={props.pid} />
          <AgentContainers pid={props.pid} />
        </div>
      </section>
      <section className="ps" id="shown">
        <h2 className="ps-h">What is shown</h2>
        <div className="grid2">
          <section className="card">
            <h2>Task profiles</h2>
            <p className="muted small">
              Profiles choose which views are shown by default; they never remove a capability.
              Backend page metadata can place a page under “More”. Saved to the repository manifest{" "}
              <code>.ablationkit/project.json</code>.
            </p>
            <ErrorBox error={settings.error ?? save.error} />
            {settings.data && !settings.data.manifest_found ? (
              <div className="banner warn">
                The checkout's manifest is missing; see Health below.
              </div>
            ) : null}
            <fieldset className="row" aria-label="Task profiles">
              {TASK_PROFILES.map((p) => (
                <label key={p} className="row small">
                  <input
                    type="checkbox"
                    checked={current.includes(p)}
                    onChange={(e) =>
                      setDraft(e.target.checked ? [...current, p] : current.filter((x) => x !== p))
                    }
                  />
                  {p}
                </label>
              ))}
            </fieldset>
            <div className="row end">
              <button
                type="button"
                className="primary"
                disabled={draft === undefined || save.busy}
                onClick={() => void save.run()}
              >
                Save profiles
              </button>
            </div>
          </section>
          <section className="card">
            <h2>Extensions</h2>
            <p className="muted small">
              Project-scoped views, actions and Python analyses: review, approve, disable and roll
              back.
            </p>
            <Link to={`${props.base}/settings/extensions`}>Manage extensions →</Link>
            <p className="faint small">
              Compute targets and their usage are on <Link to="/compute">Compute</Link>. LLM
              capture, redaction and retention are under{" "}
              <Link to={`${props.base}/llm/settings`}>LLM → Data controls</Link>.
            </p>
          </section>
        </div>
      </section>
      <section className="ps" id="health">
        <h2 className="ps-h">Health</h2>
        <section className="card">
          <h2>
            Project doctor{" "}
            {doctor.data ? (
              <Badge
                tone={
                  doctor.data.status === "ok"
                    ? "ok"
                    : doctor.data.status === "warn"
                      ? "warn"
                      : "err"
                }
              >
                {doctor.data.status}
              </Badge>
            ) : null}
          </h2>
          <ErrorBox error={doctor.error} />
          {doctor.data ? (
            <KV
              rows={[
                [
                  "project id",
                  <span key="id" className="mono">
                    {props.pid}
                  </span>,
                ],
                ...doctor.data.checks.map((c): [string, ReactNode] => [
                  c.name,
                  `${c.status}: ${c.detail ?? ""}`,
                ]),
              ]}
            />
          ) : (
            <Loading />
          )}
        </section>
      </section>
      <RemoveProject pid={props.pid} />
    </>
  );
}

interface RemovalPlan {
  project: { project_id: string; name: string; path: string };
  blockers: string[];
  moves: { what: string; from: string; to: string }[];
  skipped?: string;
  destination_root: string;
  kept: string[];
}

/**
 * Remove the project from AblationKit (ADR 0034): its code stays; the checkout's `.ablationkit/`
 * and its coordinator state move aside. Refused while work is running.
 */
function RemoveProject(props: { pid: string }) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const plan = useApi<{ plan: RemovalPlan }>(
    confirming ? `/api/v1/projects/${encodeURIComponent(props.pid)}/removal` : undefined,
  );
  const remove = useAction(async () => {
    await api(`/api/v1/projects/${encodeURIComponent(props.pid)}`, { method: "DELETE" });
    // The sidebar and project switcher read the registry on load: one full navigation home.
    location.assign("/");
  });
  const close = () => {
    setConfirming(false);
    setTyped("");
    remove.clear();
  };
  const p = plan.data?.plan;
  return (
    <section className="card">
      <h2>Remove project</h2>
      <p className="muted small">
        AblationKit forgets this project. Your code is not touched. The checkout&apos;s{" "}
        <code>.ablationkit/</code> and the project&apos;s jobs, tasks and records are moved aside,
        not deleted. MLflow runs stay.
      </p>
      <div className="row end">
        <button type="button" className="danger" onClick={() => setConfirming(true)}>
          Remove project…
        </button>
      </div>
      {confirming ? (
        <Modal
          title={`Remove ${props.pid}`}
          onClose={close}
          footer={
            <>
              <button type="button" onClick={close}>
                Keep the project
              </button>
              <button
                type="button"
                className="danger"
                disabled={!p || p.blockers.length > 0 || typed !== props.pid || remove.busy}
                onClick={() => void remove.run()}
              >
                Remove
              </button>
            </>
          }
        >
          <ErrorBox error={plan.error ?? remove.error} />
          {!p ? (
            <Loading />
          ) : (
            <>
              {p.blockers.length ? (
                <div className="banner warn">
                  <p>This project still has running work. Finish or stop it first:</p>
                  <ul className="small">
                    {p.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p className="small">
                Moved to{" "}
                <code>
                  {p.destination_root}/{props.pid}-…
                </code>
                :
              </p>
              {p.moves.length ? (
                <ul className="small">
                  {p.moves.map((m) => (
                    <li key={m.from}>
                      {m.what}: <code>{m.from}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="faint small">Nothing on disk; only the registration goes.</p>
              )}
              {p.skipped ? <p className="small muted">{p.skipped}.</p> : null}
              <p className="small">Kept:</p>
              <ul className="small">
                {p.kept.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
              <label className="small">
                Type <code>{props.pid}</code> to confirm
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  aria-label="Project ID to confirm"
                  autoComplete="off"
                />
              </label>
            </>
          )}
        </Modal>
      ) : null}
    </section>
  );
}
