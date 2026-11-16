# Agents: policy, tasks and MCP

What an agent may ask AblationKit to do, and how agents report into it (spec §7, as amended by ADR 0037, ADR 0039 and ADR 0040). AblationKit does not start or drive agents: the agent's session, Git, worktrees and sandbox belong to the researcher's harness (Claude Code, Codex, T3 Code).

- [project-permissions.md](project-permissions.md): the per-project action policy (schema version 2) and the agent compute limit. Covers jobs here and on remote targets, deployment gates, `compute.limit_hours` in weighted hours, target weights, admission, notifications, where each is enforced, who changes the policy and how, and how old revisions migrate.
- [deployment-gates.md](deployment-gates.md): pinned models, targets, exposure and TTLs for previews and research endpoints, decided by the policy for agents.
- [agent-first.md](agent-first.md): how agents report in: adding `ablationkit mcp` to your harness, agent sessions (identity, not a sandbox), the tools, tasks (create, record work under, complete), and what an agent can and cannot do.
