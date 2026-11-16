/**
 * Agents (ADR 0065): the agents doing the research, each in its own agent container (ADR 0061),
 * as a page of the global layer. `/agents` shows every running agent as a tile with its live
 * terminal, state and controls, and the sessions that ended below; `/agents/<session>` shows one
 * agent: its live terminal, what it was given, its controls, where it connected, what it changed
 * and its account. Terminals are read-only: typing into one is `ablationkit agent attach`, or
 * the executive agent's `send` (ADR 0064).
 */
import "../styles/agents.css";
import { useState } from "react";
import { api, useApi } from "../api.ts";
import {
  ContainerEgress,
  ContainerRecord,
  type ContainerSession,
  LIVE,
  stateText,
  stateTone,
} from "../components/AgentContainers.tsx";
import { LiveTerminal } from "../components/Terminal.tsx";
import { Badge, ErrorBox, Link, Loading, Page, useAction } from "../components/ui.tsx";
import { SessionAccount } from "../components/Witness.tsx";
import { fmtDuration, fmtTime } from "../lib/format.ts";

const enc = encodeURIComponent;

interface Listing {
  sessions: ContainerSession[];
  runtime: { problems: string[] };
}

type Session = ContainerSession & { attach?: string[]; harness_version?: string };

/** Pause, resume and stop, then `done`. */
function useControl(done: () => void) {
  return useAction(async (sid: string, action: "pause" | "resume" | "stop") => {
    await api(`/api/v1/agent-containers/${enc(sid)}/${action}`, {
      body: action === "resume" ? {} : { reason: `${action} in the web UI` },
    });
    done();
  });
}

function Controls(props: { s: ContainerSession; control: ReturnType<typeof useControl> }) {
  const { s, control } = props;
  if (!LIVE.has(s.state)) return null;
  return (
    <span className="agent-controls">
      {s.state === "running" ? (
        <button
          type="button"
          className="small"
          disabled={control.busy}
          onClick={() => void control.run(s.session_id, "pause")}
        >
          Pause
        </button>
      ) : null}
      {s.state === "paused" ? (
        <button
          type="button"
          className="small"
          disabled={control.busy}
          onClick={() => void control.run(s.session_id, "resume")}
        >
          Resume
        </button>
      ) : null}
      <button
        type="button"
        className="small"
        disabled={control.busy}
        onClick={() => void control.run(s.session_id, "stop")}
      >
        Stop
      </button>
    </span>
  );
}

function since(iso: string | undefined): string {
  if (!iso) return "";
  return fmtDuration(Date.now() - Date.parse(iso));
}

function AgentTile(props: { s: ContainerSession; reload: () => void }) {
  const { s } = props;
  const control = useControl(props.reload);
  return (
    <section className="card agent-tile" data-testid="agent-tile">
      <header>
        <div className="grow">
          <Link to={`/agents/${enc(s.session_id)}`}>
            <b>{s.label}</b>
          </Link>
          <div className="small faint">
            {s.project_id} · {s.harness} · {since(s.started_at ?? s.created_at)}
          </div>
        </div>
        <Badge tone={stateTone(s.state)}>{stateText(s)}</Badge>
      </header>
      <LiveTerminal sid={s.session_id} lines={22} pollMs={2_000} />
      <ErrorBox error={control.error} />
      <footer>
        <Link to={`/agents/${enc(s.session_id)}`}>Open</Link>
        <span className="grow" />
        <Controls s={s} control={control} />
      </footer>
    </section>
  );
}

export function AgentsPage() {
  const projects = useApi<{ projects: { project_id: string; name: string }[] }>("/api/v1/projects");
  const [project, setProject] = useState("");
  const list = useApi<Listing>(
    `/api/v1/agent-containers${project ? `?project=${enc(project)}` : ""}`,
    { pollMs: 5_000 },
  );
  const sessions = list.data?.sessions ?? [];
  const live = sessions.filter((s) => LIVE.has(s.state));
  const ended = sessions.filter((s) => !LIVE.has(s.state)).slice(0, 25);
  return (
    <Page
      trail={[{ label: "Agents" }]}
      title="Agents"
      lede="The agents doing the research, each in its own container: their terminals live, where they connect, and what they changed."
    >
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="small">
          Project{" "}
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {(projects.data?.projects ?? []).map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <span className="small faint">
          {live.length} running · terminals are read-only; type into one with{" "}
          <code>ablationkit agent attach SESSION</code>
        </span>
      </div>
      <ErrorBox error={list.error} />
      {list.data?.runtime.problems.length ? (
        <div className="banner warn small">
          {list.data.runtime.problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      ) : null}
      {!list.data ? <Loading /> : null}
      {list.data && !live.length ? (
        <section className="card">
          <p className="small">
            No agent is running{project ? ` in ${project}` : ""}. Start one in a registered checkout
            with <code>ablationkit agent start -- "its first task"</code>, or ask your executive
            agent to (its <code>executive_agents</code> tool).
          </p>
        </section>
      ) : null}
      {live.length ? (
        <div className="agents-grid" data-testid="agents-live">
          {live.map((s) => (
            <AgentTile key={s.session_id} s={s} reload={list.reload} />
          ))}
        </div>
      ) : null}
      {ended.length ? (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Ended</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Project</th>
                  <th>Ended</th>
                  <th>How</th>
                  <th>Changed</th>
                </tr>
              </thead>
              <tbody>
                {ended.map((s) => (
                  <tr key={s.session_id}>
                    <td>
                      <Link to={`/agents/${enc(s.session_id)}`}>{s.label}</Link>{" "}
                      <span className="faint small">{s.harness}</span>
                    </td>
                    <td className="mono small">{s.project_id}</td>
                    <td className="small">{fmtTime(s.ended_at)}</td>
                    <td>
                      <Badge tone={stateTone(s.state)} title={s.error}>
                        {stateText(s)}
                      </Badge>
                    </td>
                    <td className="small">
                      {s.files_changed ? `${s.files_changed.length} files` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </Page>
  );
}

export function AgentPage(props: { sid: string }) {
  const res = useApi<Session>(`/api/v1/agent-containers/${enc(props.sid)}`, { pollMs: 5_000 });
  const control = useControl(res.reload);
  const s = res.data;
  if (res.error)
    return (
      <Page trail={[{ label: "Agents", to: "/agents" }, { label: props.sid }]} title="Agent">
        <ErrorBox error={res.error} />
      </Page>
    );
  if (!s)
    return (
      <Page trail={[{ label: "Agents", to: "/agents" }, { label: props.sid }]} title="Agent">
        <Loading />
      </Page>
    );
  const live = LIVE.has(s.state);
  return (
    <Page
      trail={[{ label: "Agents", to: "/agents" }, { label: s.label }]}
      eyebrow={
        <>
          <Link to={`/p/${enc(s.project_id)}`}>{s.project_id}</Link> · {s.harness}
          {s.harness_version ? ` ${s.harness_version}` : ""}
        </>
      }
      title={s.label}
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <Badge tone={stateTone(s.state)} title={s.error}>
          {stateText(s)}
        </Badge>
        <span className="small faint agent-facts">
          <span>
            started {fmtTime(s.started_at ?? s.created_at)}
            {live ? ` (${since(s.started_at ?? s.created_at)})` : ""}
          </span>
          {s.ended_at ? <span>ended {fmtTime(s.ended_at)}</span> : null}
          <span className="mono">{s.image}</span>
          <span>
            no GPU · egress {s.boundary.egress} · {s.boundary.hidden.length} hidden ·{" "}
            {s.boundary.cpus} CPU · {s.boundary.memory_mb} MB
          </span>
          {s.login ? <span>signed in with {s.login.source}</span> : null}
        </span>
        <span className="grow" />
        <Controls s={s} control={control} />
      </div>
      <ErrorBox error={control.error} />
      {s.error ? <div className="banner err small">{s.error}</div> : null}
      {live ? (
        <>
          <LiveTerminal sid={s.session_id} pollMs={1_000} />
          <p className="small faint">
            Live and read-only. To type into it:{" "}
            <code>ablationkit agent attach {s.session_id}</code> (detach with Ctrl-b d), or{" "}
            <code>ablationkit agent send {s.session_id} TEXT</code>.
          </p>
        </>
      ) : null}
      <div className="grid2" style={{ marginTop: 12 }}>
        <section className="card">
          <h2>Egress</h2>
          <ContainerEgress session={s} />
        </section>
        <section className="card">
          <h2>What it changed</h2>
          {live ? (
            <p className="small faint">
              Recorded when the session ends: the files it changed, the packages it installed and
              the commands its harness recorded.
            </p>
          ) : (
            <ContainerRecord session={s} />
          )}
        </section>
      </div>
      <section className="card" style={{ marginTop: 12 }}>
        <h2>Its account</h2>
        <SessionAccount tokenId={s.token_id} />
      </section>
    </Page>
  );
}
