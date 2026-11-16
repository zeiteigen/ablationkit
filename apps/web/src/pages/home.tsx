/**
 * Home (spec §2.2, simplified by ADR 0036 and ADR 0055): one card per project saying where it
 * stands, the attention inbox, running jobs and compute when any ran this week.
 */
import { useState } from "react";
import { api, useApi, useEvents } from "../api.ts";
import { type Project, useShell } from "../app.tsx";
import { plainExcerpt } from "../components/Markdown.tsx";
import {
  attemptTone,
  Badge,
  Empty,
  ErrorBox,
  Link,
  Loading,
  Page,
  useAction,
} from "../components/ui.tsx";
import { computeLabel, shortId } from "../lib/format.ts";
import type { JobView } from "../lib/types.ts";
import { edDay, edName, fmtDay, plainLinks } from "../lib/vault.ts";
import { useVaultStore } from "../lib/vault-store.ts";
import { navigate } from "../router.ts";
import { ComputeSummary } from "./compute.tsx";

interface InboxResp {
  items: {
    id: string;
    kind: string;
    severity: string;
    title: string;
    detail?: string;
    project_id?: string;
    ref?: string;
    created_at?: string;
  }[];
  sources: { kind: string; label: string; available: boolean; stage?: number }[];
}

function Inbox() {
  const inbox = useApi<InboxResp>("/api/v1/inbox", { pollMs: 10000 });
  useEvents(() => inbox.reload(), {
    types: ["tracking.run.sync", "job.attempt.state", "notification.raised", "policy.revised"],
  });
  const d = inbox.data;
  return (
    <section className="card" id="inbox" aria-label="Attention inbox">
      <h2>
        Attention inbox{" "}
        <span className={`count${d?.items.length ? "" : " zero"}`} data-testid="inbox-count">
          {d?.items.length ?? 0}
        </span>
      </h2>
      <ErrorBox error={inbox.error} />
      {!d ? <Loading /> : null}
      {d && d.items.length === 0 ? (
        <p className="muted small">Nothing needs your attention.</p>
      ) : null}
      {d?.items.map((i) => (
        <div
          key={i.id}
          className={`banner ${i.severity === "error" ? "err" : i.severity === "info" ? "" : "warn"}`}
        >
          <strong>{i.title}</strong>
          {i.project_id ? (
            <>
              {" "}
              · <Link to={`/p/${encodeURIComponent(i.project_id)}`}>{i.project_id}</Link>
            </>
          ) : null}
          {i.ref?.startsWith("job:") && i.project_id ? (
            <>
              {" "}
              ·{" "}
              <Link
                to={`/p/${encodeURIComponent(i.project_id)}/runs/jobs/${encodeURIComponent(i.ref.slice(4))}`}
              >
                open job
              </Link>
            </>
          ) : i.ref === "settings" && i.project_id ? (
            <>
              {" "}
              ·{" "}
              <Link to={`/p/${encodeURIComponent(i.project_id)}/settings#agent-permissions`}>
                open Project settings
              </Link>
            </>
          ) : i.ref && i.project_id && !/^task:/.test(i.ref) ? (
            <>
              {" "}
              ·{" "}
              <Link
                to={`/p/${encodeURIComponent(i.project_id)}/runs/r/${encodeURIComponent(i.ref)}`}
              >
                open run
              </Link>
            </>
          ) : null}
          {i.detail ? <div className="small">{i.detail}</div> : null}
          {i.kind === "sync_failed" && !i.ref?.startsWith("job:") ? (
            <div className="small">
              Review and retry the rejected writes under <Link to="/system">System → outbox</Link>.
            </div>
          ) : null}
        </div>
      ))}
      {d?.items.length ? (
        <details>
          <summary className="small">Sources</summary>
          <ul className="small muted">
            {d.sources.map((s) => (
              <li key={s.kind}>
                {s.label}: {s.available ? "watched" : "not shown in the inbox"}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function RegisterProject() {
  const { reloadProjects } = useShell();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const act = useAction(async () => {
    const r = await api<{ project: { project_id: string } }>("/api/v1/projects", {
      body: { path, ...(name ? { name } : {}) },
    });
    reloadProjects();
    navigate(`/p/${encodeURIComponent(r.project.project_id)}`);
  });
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        void act.run();
      }}
    >
      <input
        placeholder="/absolute/path/to/checkout"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        aria-label="Checkout path"
        style={{ flex: 2, minWidth: 220 }}
        required
      />
      <input
        placeholder="name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Project name"
        style={{ flex: 1, minWidth: 120 }}
      />
      <button type="submit" className="primary" disabled={act.busy || !path}>
        Register project
      </button>
      {act.error ? (
        <div style={{ flexBasis: "100%" }}>
          <ErrorBox error={act.error} />
        </div>
      ) : null}
    </form>
  );
}

/**
 * One project on Home (ADR 0055): where it stands in a sentence or two (the vault's bottom line),
 * what is unread, the last session, and its running jobs.
 */
function ProjectCard(props: { project: Project; running: number }) {
  const p = props.project;
  const store = useVaultStore(p.project_id);
  const v = store?.vault;
  const base = `/p/${encodeURIComponent(p.project_id)}`;
  const bl = v?.ledger.bottom_line;
  const unread = store?.ledgerUnread() ?? 0;
  const ed = v?.editions.at(-1);
  const bits = [
    v?.notes.length
      ? unread
        ? `${unread} ${unread === 1 ? "line" : "lines"} of the ledger unread`
        : "read up"
      : "",
    ed ? `last session ${fmtDay(edDay(ed))}: ${edName(ed)}` : "",
  ].filter(Boolean);
  return (
    <section className="card pcard" data-testid="project-card">
      <h2>
        <Link to={base} className="pc-name">
          {p.name}
        </Link>
        {props.running ? <Badge tone="info">{props.running} running</Badge> : null}
      </h2>
      {bl && v ? (
        <p className="pc-bl" title={plainLinks(bl, (id) => v.get(id)?.title)}>
          {plainExcerpt(
            plainLinks(bl, (id) => v.get(id)?.title),
            400,
          )}
        </p>
      ) : v ? (
        <p className="faint small">
          {v.notes.length ? "The vault has no bottom line yet." : "No vault yet."}
        </p>
      ) : null}
      {bits.length ? (
        <p className="small faint">
          {unread ? <Link to={`${base}/standing`}>{bits[0]}</Link> : bits[0]}
          {bits.slice(1).map((b) => (
            <span key={b}> · {b}</span>
          ))}
        </p>
      ) : null}
    </section>
  );
}

export function HomePage() {
  const { projects } = useShell();
  const jobs = useApi<{ jobs: JobView[] }>("/api/v1/jobs?limit=50");
  useEvents((e) => {
    if (e.type.startsWith("job.")) jobs.reload();
  });
  const running = (jobs.data?.jobs ?? []).filter(
    (j) => j.state === "running" || j.state === "starting",
  );
  const runningIn = (pid: string) => running.filter((j) => j.project_id === pid).length;

  return (
    <Page
      trail={[{ label: "Home" }]}
      title="Home"
      lede="Where each project stands, running work and what needs you."
    >
      <div className="grid2 home">
        <section aria-label="Projects" className="stack">
          {projects.length === 0 ? (
            <Empty>Register a Git checkout to start tracking its runs.</Empty>
          ) : (
            projects.map((p) => (
              <ProjectCard key={p.project_id} project={p} running={runningIn(p.project_id)} />
            ))
          )}
          <details className="register">
            <summary className="small">Register a checkout…</summary>
            <RegisterProject />
          </details>
        </section>
        <div className="stack">
          <Inbox />
          {running.length ? (
            <section className="card">
              <h2>
                Running jobs <Badge>{running.length}</Badge>
              </h2>
              {running.map((j) => (
                <div key={j.job_id} className="row small">
                  <Badge tone={attemptTone(j.state)}>
                    {computeLabel(j.state, j.latest_attempt?.remote)}
                  </Badge>
                  <Link
                    to={`/p/${encodeURIComponent(j.project_id)}/runs/jobs/${encodeURIComponent(j.job_id)}`}
                  >
                    {j.run_name ?? shortId(j.job_id, 14)}
                  </Link>
                  <span className="mono faint">{j.command.join(" ").slice(0, 60)}</span>
                </div>
              ))}
            </section>
          ) : null}
          <ErrorBox error={jobs.error} />
          <ComputeSummary />
        </div>
      </div>
    </Page>
  );
}
