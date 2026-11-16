/**
 * Authentication state (spec §7.11): hashed bearer tokens. Stored under
 * `~/.ablationkit/auth/`. Secrets never appear in these files; only SHA-256 hashes. ADR 0008.
 */
import { type Static, Type } from "@sinclair/typebox";
import { AttemptId, describe, JobId, ProjectId, Timestamp } from "./common.ts";
import { ContainerSessionId } from "./containers.ts";

export const TokenId = Type.String({
  title: "TokenId",
  description: "Public identifier of a token, embedded in the token string.",
  pattern: "^[a-f0-9]{16}$",
});

export const TokenScope = Type.Object(
  {
    project_id: Type.Optional(ProjectId),
    job_id: Type.Optional(JobId),
    attempt_id: Type.Optional(AttemptId),
  },
  {
    title: "TokenScope",
    description:
      "What a token is bound to. Agent: a project (ADR 0039); worker: project, job and attempt.",
    additionalProperties: false,
  },
);
export type TokenScope = Static<typeof TokenScope>;

export const TokenKind = Type.Union(
  [Type.Literal("session"), Type.Literal("agent"), Type.Literal("worker")],
  {
    title: "TokenKind",
    description: "session: human API; agent: agent API; worker: worker upload API.",
  },
);
export type TokenKind = Static<typeof TokenKind>;

export const AgentSessionInfo = Type.Object(
  {
    harness: Type.String({
      description: "The agent harness, as `ablationkit mcp` reports it (e.g. claude-code, codex).",
      minLength: 1,
      maxLength: 64,
    }),
    label: Type.String({ description: "The session's label.", minLength: 1, maxLength: 200 }),
    cwd: Type.String({
      description: "The directory `ablationkit mcp` started in.",
      maxLength: 4096,
    }),
    last_used_at: describe(
      Timestamp,
      "Updated at most once a minute while the agent calls the API.",
    ),
    idle_timeout_sec: Type.Integer({
      description: "The session ends after this long without a request.",
      minimum: 60,
    }),
    container_session: Type.Optional(
      describe(
        ContainerSessionId,
        "Set when the session runs in an agent container (ADR 0061): the coordinator minted the token for the container, its jobs run in job containers, and the container is its boundary.",
      ),
    ),
  },
  {
    title: "AgentSessionInfo",
    description:
      "An agent token minted by `ablationkit mcp` for one agent session through the login socket (ADR 0040): who the agent is, for attribution. Identity, not a security boundary.",
    additionalProperties: false,
  },
);
export type AgentSessionInfo = Static<typeof AgentSessionInfo>;

export const ExecutiveSessionInfo = Type.Object(
  {
    harness: Type.String({ minLength: 1, maxLength: 64 }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    cwd: Type.String({ maxLength: 4096 }),
  },
  {
    title: "ExecutiveSessionInfo",
    description:
      "A human-API session minted for `ablationkit executive` (ADR 0064): an agent on the researcher's machine overseeing the research and running the agents. It may read and may only make the writes an executive makes (agent containers, agent sessions, directions); every other write is refused.",
    additionalProperties: false,
  },
);
export type ExecutiveSessionInfo = Static<typeof ExecutiveSessionInfo>;

export const TokenRecord = Type.Object(
  {
    token_id: TokenId,
    kind: TokenKind,
    token_hash: Type.String({
      description: "SHA-256 of the secret, hex.",
      pattern: "^[a-f0-9]{64}$",
    }),
    created_at: Timestamp,
    expires_at: Type.Optional(
      describe(Timestamp, "Absent for worker tokens until the job is terminal."),
    ),
    revoked_at: Type.Optional(Timestamp),
    revoked_reason: Type.Optional(Type.String({ maxLength: 512 })),
    label: Type.Optional(Type.String({ description: "Human-readable note.", maxLength: 200 })),
    scope: TokenScope,
    purpose: Type.Optional(
      Type.Union([Type.Literal("upload"), Type.Literal("launch")], {
        description:
          "Worker tokens only. `launch`: held by a remote worker for the whole job; it can only perform the handshake, which issues short-lived `upload` tokens (ADR 0023). Absent means `upload`.",
      }),
    ),
    executive_session: Type.Optional(ExecutiveSessionInfo),
    agent_session: Type.Optional(
      describe(
        AgentSessionInfo,
        "Agent tokens minted for an agent session (ADR 0040). Absent on agent tokens minted before it.",
      ),
    ),
  },
  {
    title: "TokenRecord",
    description: "One minted bearer token (hash only).",
    additionalProperties: false,
  },
);
export type TokenRecord = Static<typeof TokenRecord>;

/** `~/.ablationkit/auth/tokens.json`. */
export const TokenStore = Type.Object(
  { schema_version: Type.Literal(1), tokens: Type.Array(TokenRecord) },
  {
    title: "TokenStore",
    description: "All minted tokens, including revoked and expired ones until pruned.",
    additionalProperties: false,
  },
);
export type TokenStore = Static<typeof TokenStore>;
