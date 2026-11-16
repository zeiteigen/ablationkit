# Your executive agent

An agent on your machine can act as your executive through its own MCP server, `ablationkit executive` (ADR 0064). It oversees the research the project's agents do, and runs those agents. It does not do the research itself.

| Your executive can | It cannot |
| --- | --- |
| read every project: the vault, notes, runs, jobs and their logs, tasks, research records, the library, models, evaluations, LLM research | submit jobs, write notes or research records, describe runs, create or complete tasks |
| start contained agents with a first task, read their screens, type into them, wait for them, pause, resume and stop them | change the policy, compute limits, container configuration or the agenda |
| read an agent session's account and egress, end a session, allow an egress host | build or run extensions, restore backups, register or remove projects |
| write, close, reopen and withdraw directions to the agents, marked as its own | mark notes read for you |

## Set it up

`scripts/setup.sh` registers it with Claude Code and Codex, and only it: agents on your machine see the executive's server, and research agents see the agents' server in their containers (`--agent-mcp` registers that one on your machine too, for research agents you run uncontained). By hand:

- **Claude Code:** `claude mcp add --scope user ablationkit-executive -- ablationkit executive`
- **Codex:** `codex mcp add ablationkit-executive -- ablationkit executive`

## Its tools

- **`executive_overview`**: every project at a glance (its bottom line, notes, compute used and left, open tasks), the live agent sessions and agent containers, and what the container runtime lacks. It starts here.
- **`executive_read`**: every read the agents have, in any project (`project`; by default the checkout's, or the only one registered). `{op: "help"}` lists them.
- **`executive_agents`**:
  - **see the agents:** `list`, `show`, `account` (a session's record beside what it wrote), `screen`, `egress`;
  - **run a contained one:** `start` (`project`, `harness`, `prompt`: its first task), `send` (type into it), `wait` (until its screen goes quiet, shows a text, or it ends), `pause`, `resume`, `stop`;
  - **manage:** `end_session`, `allow_hosts`.
- **`executive_direct`**: directions to a project's agents (`write` with `kind`, `text` and `target`; `close`, `reopen`, `withdraw`; `list`).

## How it is held to that

The server starts an **executive session**: a session of the human API that the coordinator marks and restricts. It may read everything (every `GET`), and make only the writes in the left column above. Every other write is refused with `executive_forbidden` and audited. The session ends when the harness closes the server. **Settings → Agent sessions** lists executive sessions, and you can end one there.

- **Directions it writes are marked.** The agents are told a direction was written on your behalf by your executive agent, not by you in person. The web UI shows "your executive agent (…)".
- **What it types into an agent is recorded with the text.** The audit log keeps every input (`agent.container.input`).

The role is enforced for the executive's session, not against the agent. On your machine the agent can still use the `ablationkit` CLI as your operator ([agent containers](agent-containers.md), ADR 0062). The executive server is the interface for an agent that should oversee rather than do the work.
