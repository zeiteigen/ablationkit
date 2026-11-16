# AblationKit Agent Skills

Portable [Agent Skills](https://agentskills.io) shipped with the central install (spec §3.2, §11).
They teach Claude Code and Codex how to use AblationKit through the `ablationkit_*` tools of its
MCP server, `ablationkit mcp` (ADR 0040). They are never copied into ML projects.

| Skill | Use it to |
| --- | --- |
| [`ablationkit-mcp`](ablationkit-mcp/SKILL.md) | use the `ablationkit_*` tools at all: the agent session, starting with `ablationkit_project`, argument shapes, refs and IDs, paging, refusal codes and what to do, what only the researcher does, and which task skill to load next ([every tool](ablationkit-mcp/references/tools.md)) |
| [`onboard-project`](onboard-project/SKILL.md) | bring an existing ML repository onto AblationKit: have the researcher register it, instrument minimally, run a tracked baseline, record the study, import its earlier runs (labelled as imported), migrate each visualisation to a native chart, run artifact or extension, and write the project's first vault (the fundamentals, the open claims, what earlier runs showed) |
| [`research-task`](research-task/SKILL.md) | record agent work in AblationKit as a research task: create the task, run jobs within the project policy and its agent compute limit, look for prior work before designing experiments and whenever stuck, keeping every work consulted in the project's library and citing it with its role, write what was learned into the vault as atomic notes (findings with their runs, claims with a standing, the concepts a reader needs), and complete it with the session's notebook only as far as the evidence goes ([how a note is written](research-task/references/writing.md)) |
| [`inspect-traces`](inspect-traces/SKILL.md) | search MLflow traces and read span trees, errors, retries and reported usage; link traces to notes |
| [`compare-prompts`](compare-prompts/SKILL.md) | browse and diff prompt versions, propose a version, prepare a pinned side-by-side comparison |
| [`build-eval-set`](build-eval-set/SKILL.md) | write and version golden sets (never held-out ones) |
| [`run-llm-evaluation`](run-llm-evaluation/SKILL.md) | prepare and read GenAI evaluations of pinned variants or recorded traces; generate the report |
| [`debug-rag`](debug-rag/SKILL.md) | follow query → chunks → generation in a trace; report uninstrumented fields as unavailable |
| [`summarize-failures`](summarize-failures/SKILL.md) | cluster an evaluation's failures, link traces, keep evidence and interpretation apart |
| [`author-extension`](author-extension/SKILL.md) | scaffold, validate and build a project-scoped extension (views, demos, actions, Python evaluators) from a template; building it enables it |

`ablationkit-mcp` is the general one; each task skill opens with a table of the tools it uses and
points back to it.

The six LLM skills are owned by `packages/builtin-llm/src/skills/` and declared by its backend
manifest. Compatibility links here preserve existing installation paths. These skills only prepare model runs: launching evaluations and playground
runs, feedback, prompt aliases, held-out golden sets and data-control changes are the researcher's,
in the web UI.

## Install the skills

From a source checkout, link every skill here into each Claude Code config (`~/.claude/skills`,
and `<profile>/skills` for every `~/.claude-*` profile) and Codex (`$CODEX_HOME/skills`, default
`~/.codex`, when it exists), register the MCP server below with them, and put the `ablationkit` CLI
on `PATH`:

```sh
sh scripts/setup.sh              # --no-deps to skip bun install / uv sync; --no-mcp to skip the
                                 # MCP registration; --uninstall to undo
```

The links point into the checkout, so skill edits take effect in the next session.
Restart the agent session so it discovers the skill.

## Add the MCP server

Agents use AblationKit only through `ablationkit mcp`, an MCP server over stdio that the harness
launches, one process per agent session. `scripts/setup.sh` adds it for you; by hand, once per
harness (user scope, so it works in every registered project):

- **Claude Code:**

  ```sh
  claude mcp add --scope user ablationkit -- ablationkit mcp
  # a second profile (CLAUDE_CONFIG_DIR), e.g. a claude-pro wrapper:
  CLAUDE_CONFIG_DIR=~/.claude-pro claude mcp add --scope user ablationkit -- ablationkit mcp
  # from a source checkout without the CLI on PATH:
  claude mcp add --scope user ablationkit -- bun /path/to/ablationkit/apps/cli/src/main.ts mcp
  ```

- **Codex:**

  ```sh
  codex mcp add ablationkit -- ablationkit mcp
  ```

  This writes an `[mcp_servers.ablationkit]` table (`command`, `args`) to `$CODEX_HOME/config.toml`
  (default `~/.codex/config.toml`).

Start the agent inside a registered checkout (one with `.ablationkit/project.json`; the researcher
registers it with `ablationkit project add PATH`), or pass `--project ID` (and optionally
`--label TEXT`) after `mcp`. The server starts an agent session for that project through the
coordinator on this machine, with a token it keeps in memory and never shows the agent, and ends
the session when the harness closes it (a session also ends after 12 hours without a request).
Each session is listed in Settings → Agent sessions, with what it recorded, and the researcher can
end it there. The token is identity (the agent API, the project policy and the compute limit
apply, and jobs and records are attributed to the session), not a sandbox: whatever the agent can
run as the researcher's user is the harness's to confine.

## Conventions

- `SKILL.md` has YAML frontmatter with `name` (the directory name, lowercase-hyphenated) and a
  `description` saying when to use the skill. Longer material goes in `references/`, linked from
  `SKILL.md` and loaded only when needed.
- Skills use the `ablationkit_*` MCP tools, never coordinator files or the coordinator's HTTP API
  directly, and never ask the agent to handle a token. The `ablationkit` CLI appears only for the
  researcher's and operator's commands (`project add`, `ui`, …) and the offline extension
  authoring commands.
- `apps/cli/test/skills.test.ts` checks the frontmatter, relative links, that every
  `ablationkit_<tool>` a skill mentions is a tool of `ablationkit mcp`, and that every
  `ablationkit <command>` a skill mentions is a CLI command. Update the skills when tools or
  commands change.
