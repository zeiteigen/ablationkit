# Security and operations

Threat model, permission boundaries, secrets and recovery. The trust model is spec §7.11, narrowed by ADR 0037: the agent's own session (its sandbox, its network, its edits and its Git) belongs to the user's harness (Claude Code, Codex, T3 Code). AblationKit decides what an agent may ask *AblationKit* to do, and nothing else.

**Start with the [threat map](threat-map.md):** every threat, the control that answers it, that control's level, where it stops, and the tests that prove it. It also lists what v1.0 leaves out of scope. `bun run test:security` runs the suite written for it; the rest of its tests run in CI.

## The boundary between the researcher and agents

| Control | Mechanism | Level |
| --- | --- | --- |
| Privileged writes (policy revisions, extension approve/enable/rollback and backend enable, Level 2 build activation, restores, project removal, widening LLM data controls) | exist only on the human listener and need the researcher's session; agent and worker tokens are refused there, and their listeners have no such routes | authoritative |
| A stolen session | none beyond the session itself: no passkeys or step-up (ADR 0037). Whoever holds a session cookie or the CLI's session file, or runs as the researcher and asks the login socket for a link, can make privileged writes | — |
| Agent session tokens | one per `ablationkit mcp` session, minted through the login socket (never a human session), bound to one project; a session cancels only the jobs it submitted; ends when the server closes, after 12 idle hours, after 7 days, or in Settings (ADR 0040) | enforced, as identity: not a boundary against an agent running as the researcher (below) |
| Repository files (`AGENTS.md`, `CLAUDE.md`, `.ablationkit/project.json`, skills, prompts) | never grant anything: the policy lives in the coordinator's state, outside every checkout | enforced |
| Agent jobs and deployments | each submission or request is decided by the project policy (`jobs.run_local`, `jobs.submit_remote` with `allowed_targets`, `deployments.*`); a refusal is 403 `policy_denied` naming the field, audited | authoritative for what AblationKit runs |
| The agent guard: Claude Code and Codex settings written into each registered checkout, denying the agent the coordinator home (`~/.ablationkit`: the login socket, the CLI's session) and `.ablationkit/` (ADR 0041) | Claude Code: `permissions.deny` rules bind its own file tools and the Bash file commands it recognizes, not arbitrary programs; its `sandbox.filesystem` entries bind Bash at the OS level only when the researcher turns on `sandbox.enabled`. Codex: a permission profile its sandbox (bubblewrap, seccomp) enforces at the OS level, when the project is trusted and no `--sandbox` or legacy `sandbox_mode` takes precedence. Neither covers an agent run outside these harnesses or with their sandbox bypassed | advisory: written by AblationKit, enforced by the harness (AUTH-10) |
| Agent compute | an agent's job needs a time limit and is admitted only when it fits under the project's compute limit in weighted hours ([project permissions](../autonomy/project-permissions.md)) | admission authoritative; usage after admission bounded by each attempt's time limit (systemd `RuntimeMaxSec`: enforced; direct mode: a process-group kill, which a process that leaves the group escapes) |

What the policy does not cover: an agent that runs `python train.py` in its own shell, uses its own SSH keys or pushes with its own Git credentials does so outside AblationKit. Containing that is the harness's sandbox and approval settings, not AblationKit's. Jobs, once admitted, run unsandboxed as the researcher (spec §7.11).

## How an agent reaches the coordinator

The agent uses AblationKit only through `ablationkit mcp`, which its harness launches (ADR 0040). The server starts an agent session through the login socket (`<home>/run/login.sock`), keeps the session's token in its own memory, and calls the agent API (default `127.0.0.1:7421`, loopback only) for one project. Whether the agent's sandbox lets the MCP server reach loopback and the socket is the harness's setting.

**A session token is identity, not a boundary.** It tells AblationKit that a request is an agent's, which project and which session it is from: the policy, the compute limit and the narrower agent API apply, and work is attributed. It does not contain the agent. The login socket answers any process running as the researcher, and its `/login` gives out a human login link; the CLI's saved session is in `~/.ablationkit` too. An agent that can reach `~/.ablationkit` can therefore act as the researcher, privileged writes included. **Only the harness's sandbox, denying the agent `~/.ablationkit`, prevents that** (the MCP server itself runs outside the agent's sandbox, as the harness launches it). Registration writes that denial into the checkout for Claude Code and Codex, the agent guard above; how far it holds is the harness's (AUTH-10). What AblationKit guarantees is narrower: the session endpoint never issues a human session or a login code, and an agent that stays on its tools never reaches a human route (threats AUTH-1, AUTH-9).

## MLflow compatibility

AblationKit pins one MLflow version (`packages/tracking-mlflow/env/uv.lock`) and talks to it only from the coordinator, over loopback. The [MLflow feature compatibility matrix](../api/mlflow-compatibility.md) lists every endpoint, bridge op and Python API in use. CI proves each one succeeded against the pinned server in the real-MLflow suites (ADR 0026), so an upgrade that breaks a feature fails CI by name. The stock MLflow UI is never linked, framed or proxied.
