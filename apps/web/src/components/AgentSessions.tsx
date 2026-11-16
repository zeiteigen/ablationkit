/**
 * Agent sessions (ADR 0040), live first: each is one agent session `ablationkit mcp` started,
 * with what it recorded. Ending one revokes its token; the agent's next call is refused. With a
 * project, only that project's sessions (Project settings → Agents, ADR 0055). Each session's
 * Account opens its record beside its account (ADR 0056).
 */
import { useState } from "react";
import { api, useApi } from "../api.ts";
import { type AgentSession, agentSessionsPath } from "../lib/agent-sessions.ts";
import { fmtTime } from "../lib/format.ts";
import { Badge, ErrorBox, Loading, useAction } from "./ui.tsx";
import { SessionAccount } from "./Witness.tsx";

export function AgentSessions(props: { pid?: string }) {
  const list = useApi<{ sessions: AgentSession[] }>(agentSessionsPath(props.pid), {
    pollMs: 30_000,
  });
  // The session whose account is open (ADR 0056).
  const [account, setAccount] = useState<string | undefined>();
  const end = useAction(async (id: string) => {
    await api(`/api/v1/agent-sessions/${encodeURIComponent(id)}/end`, {
      body: { reason: "ended in settings" },
    });
    list.reload();
  });
  return (
    <section className="card" data-testid="agent-sessions">
      <h2>{props.pid ? "This project's agent sessions" : "Agent sessions"}</h2>
      <p className="small muted">
        An agent session starts when the agent&apos;s harness runs <code>ablationkit mcp</code>: it
        gets a token for one project, and its jobs and records are attributed to it. Ending a
        session revokes its token. A session token is identity, not a sandbox, except for a
        contained session, which runs in an agent container (below).
      </p>
      <ErrorBox error={list.error ?? end.error} />
      {!list.data ? <Loading /> : null}
      {list.data?.sessions.length === 0 ? (
        <p className="faint small">No agent sessions yet.</p>
      ) : null}
      {list.data?.sessions.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                {props.pid ? null : <th>Project</th>}
                <th>Directory</th>
                <th>Started</th>
                <th>Last used</th>
                <th>Recorded</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.sessions.map((s) => [
                <tr key={s.token_id}>
                  <td>
                    {s.label ?? <span className="faint">older agent token</span>}{" "}
                    <span className="faint small">{s.harness ?? ""}</span>{" "}
                    {s.container_session ? (
                      <Badge tone="info" title={`agent container ${s.container_session}`}>
                        contained
                      </Badge>
                    ) : null}
                    <div className="mono small faint">{s.token_id}</div>
                  </td>
                  {props.pid ? null : <td className="mono small">{s.project_id}</td>}
                  <td className="mono small">{s.cwd ?? "—"}</td>
                  <td className="small">{fmtTime(s.started_at)}</td>
                  <td className="small">{fmtTime(s.last_used_at)}</td>
                  <td className="small">
                    {s.jobs} jobs · {s.records} records · {s.tasks} tasks
                  </td>
                  <td>
                    <Badge tone={s.live ? "ok" : "neutral"}>
                      {s.live ? "live" : `ended: ${s.end_reason ?? "expired"}`}
                    </Badge>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="small"
                      aria-expanded={account === s.token_id}
                      onClick={() => setAccount((a) => (a === s.token_id ? undefined : s.token_id))}
                    >
                      Account
                    </button>{" "}
                    {s.live ? (
                      <button
                        type="button"
                        className="small"
                        disabled={end.busy}
                        onClick={() => void end.run(s.token_id)}
                      >
                        End session
                      </button>
                    ) : null}
                  </td>
                </tr>,
                account === s.token_id ? (
                  <tr key={`${s.token_id}:account`}>
                    <td colSpan={props.pid ? 7 : 8}>
                      <SessionAccount tokenId={s.token_id} />
                    </td>
                  </tr>
                ) : null,
              ])}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

interface ExecutiveSession {
  token_id: string;
  harness: string;
  label: string;
  cwd: string;
  started_at: string;
  live: boolean;
  end_reason?: string;
}

/**
 * Executive sessions (ADR 0064): `ablationkit executive`, an agent on this machine that reads the
 * research and runs the agents but does no research itself. Ending one revokes its session.
 */
export function ExecutiveSessions() {
  const list = useApi<{ sessions: ExecutiveSession[] }>("/api/v1/executive-sessions", {
    pollMs: 30_000,
  });
  const end = useAction(async (id: string) => {
    await api(`/api/v1/executive-sessions/${encodeURIComponent(id)}/end`, {
      body: { reason: "ended in settings" },
    });
    list.reload();
  });
  return (
    <section className="card" data-testid="executive-sessions">
      <h2>Executive sessions</h2>
      <p className="small muted">
        An agent on this machine running <code>ablationkit executive</code> acts as your executive:
        it reads every project's research and runs the agents (starts, prompts, pauses and stops
        agent containers, ends agent sessions, writes directions marked as its own), but cannot
        submit jobs, write notes or records, or change policy and configuration.
      </p>
      <ErrorBox error={list.error ?? end.error} />
      {!list.data ? <Loading /> : null}
      {list.data?.sessions.length === 0 ? (
        <p className="faint small">No executive sessions yet.</p>
      ) : null}
      {list.data?.sessions.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Directory</th>
                <th>Started</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.sessions.map((s) => (
                <tr key={s.token_id}>
                  <td>
                    {s.label} <span className="faint small">{s.harness}</span>
                    <div className="mono small faint">{s.token_id}</div>
                  </td>
                  <td className="mono small">{s.cwd}</td>
                  <td className="small">{fmtTime(s.started_at)}</td>
                  <td>
                    <Badge tone={s.live ? "ok" : "neutral"}>
                      {s.live ? "live" : `ended: ${s.end_reason ?? "expired"}`}
                    </Badge>
                  </td>
                  <td>
                    {s.live ? (
                      <button
                        type="button"
                        className="small"
                        disabled={end.busy}
                        onClick={() => void end.run(s.token_id)}
                      >
                        End session
                      </button>
                    ) : null}
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
