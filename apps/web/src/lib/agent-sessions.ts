/**
 * Agent sessions (ADR 0040): `ablationkit mcp` mints one agent token per agent session, labelled
 * with its harness and label. Jobs and records name the token in `submitted_by` / `created_by`;
 * these helpers turn that into the session's name. Identity, not a sandbox.
 */
import { useEffect, useState } from "react";
import { api } from "../api.ts";

export interface AgentSession {
  token_id: string;
  project_id: string;
  /** Absent on agent tokens minted before ADR 0040. */
  harness?: string;
  label?: string;
  cwd?: string;
  started_at: string;
  last_used_at?: string;
  expires_at?: string;
  idle_timeout_sec?: number;
  /** The agent container it runs in (ADR 0061). */
  container_session?: string;
  live: boolean;
  ended_at?: string;
  end_reason?: string;
  jobs: number;
  records: number;
  tasks: number;
}

export interface Actor {
  kind: string;
  id?: string;
}

/** "ALiBi sweep (claude-code)", or the label alone, or the token for an older agent token. */
export function sessionName(s: AgentSession): string {
  const label = s.label ?? `token ${s.token_id.slice(0, 8)}`;
  return s.harness ? `${label} (${s.harness})` : label;
}

/** Who did something: "human", "system", or "agent · <session>" when the session is known. */
export function actorText(a: Actor, sessions: ReadonlyMap<string, AgentSession>): string {
  if (a.kind !== "agent") return a.kind;
  const s = a.id ? sessions.get(a.id) : undefined;
  return s ? `agent · ${sessionName(s)}` : "agent";
}

export const agentSessionsPath = (pid?: string): string =>
  `/api/v1/agent-sessions${pid ? `?project=${encodeURIComponent(pid)}` : ""}`;

/** One fetch per project shared by every view on the page, refreshed after a minute. */
const cache = new Map<string, { at: number; sessions: Promise<AgentSession[]> }>();
const FRESH_MS = 60_000;

function fetchSessions(pid: string): Promise<AgentSession[]> {
  const hit = cache.get(pid);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.sessions;
  const sessions = api<{ sessions: AgentSession[] }>(agentSessionsPath(pid)).then(
    (r) => r.sessions,
    () => {
      cache.delete(pid);
      return [];
    },
  );
  cache.set(pid, { at: Date.now(), sessions });
  return sessions;
}

/** The project's agent sessions by token ID, and `actor(a)` naming who did something. */
export function useAgentSessions(pid: string | undefined): {
  sessions: ReadonlyMap<string, AgentSession>;
  actor: (a: Actor) => string;
} {
  const [sessions, setSessions] = useState<ReadonlyMap<string, AgentSession>>(new Map());
  useEffect(() => {
    if (!pid) return;
    let live = true;
    void fetchSessions(pid).then((list) => {
      if (live) setSessions(new Map(list.map((s) => [s.token_id, s])));
    });
    return () => {
      live = false;
    };
  }, [pid]);
  return { sessions, actor: (a) => actorText(a, sessions) };
}
