/**
 * Agent sessions (ADR 0040). `ablationkit mcp` mints one agent token per agent session through the
 * login socket: bound to one project, labelled with the harness, the session and its directory,
 * ended by the MCP server when the session closes, after 12 hours without a request, or 7 days
 * after it was minted. The token is identity (the agent API, the project policy and the compute
 * limit apply; jobs and records are attributed to it), not a boundary: any process running as the
 * researcher can reach the login socket.
 */
import { TokenScopeError } from "@ablationkit/auth";
import type { TokenRecord } from "@ablationkit/protocol";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";

/** How often idle and expired sessions are ended (and audited). */
const SWEEP_MS = 5 * 60 * 1000;

export interface AgentSessionStart {
  readonly project_id: string;
  readonly harness: string;
  readonly label: string;
  readonly cwd: string;
  /** Minted by the coordinator for an agent container (ADR 0061), not through the login socket. */
  readonly container_session?: string;
}

/** What the researcher sees of one agent session (or of an agent token minted before ADR 0040). */
export interface AgentSessionView {
  readonly token_id: string;
  readonly project_id: string;
  readonly harness?: string;
  readonly label?: string;
  readonly cwd?: string;
  readonly started_at: string;
  readonly last_used_at?: string;
  readonly expires_at?: string;
  readonly idle_timeout_sec?: number;
  /** The agent container it runs in (ADR 0061), when it does. */
  readonly container_session?: string;
  readonly live: boolean;
  readonly ended_at?: string;
  readonly end_reason?: string;
  /** Jobs this session submitted, research records it created, tasks it created. */
  readonly jobs: number;
  readonly records: number;
  readonly tasks: number;
}

export class AgentSessionService {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly svc: () => Services) {}

  start(): void {
    this.sweep();
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Mint a session token. Only ever an agent token: the login socket's only token issuer. */
  begin(input: AgentSessionStart): { token: string; record: TokenRecord } {
    const svc = this.svc();
    svc.registry.require(input.project_id);
    try {
      const minted = svc.tokens.mint("agent", {
        scope: { project_id: input.project_id },
        label: input.label,
        agentSession: {
          harness: input.harness,
          label: input.label,
          cwd: input.cwd,
          ...(input.container_session ? { container_session: input.container_session } : {}),
        },
      });
      svc.audit.record({
        actor: { kind: "agent", id: minted.record.token_id },
        listener: input.container_session ? "internal" : "login",
        action: "auth.agent_session.start",
        outcome: "allowed",
        project_id: input.project_id,
        target: minted.record.token_id,
        details: compact({
          harness: input.harness,
          label: input.label,
          cwd: input.cwd,
          container_session: input.container_session,
        }),
      });
      return minted;
    } catch (e) {
      if (e instanceof TokenScopeError) throw new HttpError(400, "invalid_scope", e.message);
      throw e;
    }
  }

  /** The session's own token ends it (the MCP server shutting down). */
  endByToken(token: string): TokenRecord {
    const svc = this.svc();
    const record = svc.tokens.verify(token, "agent");
    if (!record)
      throw new HttpError(401, "unauthenticated", "a live agent session token is required");
    svc.tokens.revoke(record.token_id, "ended");
    svc.audit.record({
      actor: { kind: "agent", id: record.token_id },
      listener: "login",
      action: "auth.agent_session.end",
      outcome: "allowed",
      project_id: record.scope.project_id,
      target: record.token_id,
      reason: "ended",
    });
    return record;
  }

  /** The researcher ends a session (Settings → Agent sessions). */
  endByResearcher(tokenId: string, by: string, reason: string): boolean {
    const svc = this.svc();
    const record = svc.tokens.get(tokenId);
    if (record?.kind !== "agent")
      throw new HttpError(404, "agent_session_not_found", "no such agent session");
    const ended = svc.tokens.revoke(tokenId, reason);
    // A contained session's container goes with its token (ADR 0061).
    const sid = record.agent_session?.container_session;
    if (ended && sid)
      try {
        svc.containers.stop(sid, by, reason);
      } catch {
        // It had already ended.
      }
    svc.audit.record({
      actor: { kind: "human", id: by },
      listener: "human",
      action: "auth.agent_session.end",
      outcome: "allowed",
      project_id: record.scope.project_id,
      target: tokenId,
      reason,
    });
    return ended;
  }

  /** End sessions that went idle or reached their maximum age, and audit each once. */
  sweep(): void {
    const svc = this.svc();
    for (const { record, reason } of svc.tokens.endExpiredAgentSessions())
      svc.audit.record({
        actor: { kind: "system" },
        listener: "internal",
        action: "auth.agent_session.expire",
        outcome: "allowed",
        project_id: record.scope.project_id,
        target: record.token_id,
        reason,
      });
  }

  /** Every agent token, newest first, with what it recorded; optionally one project's. */
  list(projectId?: string): AgentSessionView[] {
    const svc = this.svc();
    const agents = svc.tokens
      .list()
      .filter((t) => t.kind === "agent" && (!projectId || t.scope.project_id === projectId));
    const projects = new Set(agents.map((t) => t.scope.project_id as string));
    const jobs = new Map<string, number>();
    const records = new Map<string, number>();
    const tasks = new Map<string, number>();
    const bump = (m: Map<string, number>, id: string | undefined) => {
      if (id) m.set(id, (m.get(id) ?? 0) + 1);
    };
    for (const pid of projects) {
      if (!svc.registry.get(pid)) continue;
      for (const j of svc.jobs.list(pid))
        if (j.submitted_by.kind === "agent") bump(jobs, j.submitted_by.id);
      for (const r of svc.research.all(pid))
        if (r.created_by.kind === "agent") bump(records, r.created_by.id);
      for (const t of svc.tasks.list(pid))
        if (t.created_by.kind === "agent") bump(tasks, t.created_by.id);
    }
    return agents
      .map((t) => {
        const s = t.agent_session;
        const ended = t.revoked_at ?? (svc.tokens.isLive(t) ? undefined : this.endedAt(t));
        return compact({
          token_id: t.token_id,
          project_id: t.scope.project_id as string,
          harness: s?.harness,
          label: s?.label ?? t.label,
          cwd: s?.cwd,
          started_at: t.created_at,
          last_used_at: s?.last_used_at,
          expires_at: t.expires_at,
          idle_timeout_sec: s?.idle_timeout_sec,
          container_session: s?.container_session,
          live: svc.tokens.isLive(t),
          ended_at: ended,
          end_reason:
            t.revoked_reason ??
            (ended ? (svc.tokens.idleSince(t) ? "idle" : "expired") : undefined),
          jobs: jobs.get(t.token_id) ?? 0,
          records: records.get(t.token_id) ?? 0,
          tasks: tasks.get(t.token_id) ?? 0,
        }) as AgentSessionView;
      })
      .sort((a, b) => Number(b.live) - Number(a.live) || b.started_at.localeCompare(a.started_at));
  }

  private endedAt(t: TokenRecord): string | undefined {
    const idle = this.svc().tokens.idleSince(t);
    return idle?.toISOString() ?? t.expires_at;
  }
}
