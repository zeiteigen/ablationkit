# Agents reporting into AblationKit

ADR 0040, building on ADR 0039 and ADR 0037.

AblationKit does not start, drive or talk to agents. You run Claude Code, Codex or another coding agent from your own harness, in the project's checkout. The harness owns:

- the agent's session;
- its worktrees, its Git and its sandbox;
- the requests it asks you to approve.

AblationKit is what the agent reports into, and what you read:

- **jobs** it runs here or on remote targets, within the [project policy](project-permissions.md) and the [compute limit](project-permissions.md#the-agent-compute-limit);
- the **MLflow runs** those jobs log;
- **research records**: hypotheses, approaches, notes, reports, decisions, studies, conversation links;
- **tasks** that group its work.

Agents use AblationKit **only through `ablationkit mcp`**, an MCP server the harness launches. The `ablationkit` CLI is yours, for operating the coordinator and setting projects up.

## Adding the MCP server to your harness

Research agents normally run in [agent containers](agent-containers.md), which register this server for themselves. Your own agent on this machine gets the [executive's server](executive.md) instead, which is what `scripts/setup.sh` registers (ADR 0064). Add `ablationkit mcp` to a harness on this machine only to run a research agent there without a container (`scripts/setup.sh --agent-mcp` does it at user scope).

The project's checkout must be registered first: `ablationkit project add PATH`. The registration writes `.ablationkit/project.json` into the checkout.

- **Claude Code:** `claude mcp add ablationkit -- ablationkit mcp`. From a source checkout without `ablationkit` on `PATH`, use `claude mcp add ablationkit -- bun /path/to/ablationkit/apps/cli/src/main.ts mcp`.
- **Codex:** in `~/.codex/config.toml`, an `[mcp_servers.ablationkit]` table with `command = "ablationkit"` and `args = ["mcp"]`.
- **Other harnesses:** any MCP client that launches a stdio server works.

The server finds the project from `.ablationkit/project.json` in the directory it starts in (or a parent); `--project ID` overrides it. It must run on the coordinator's machine: it starts its session through the local login socket. The Agent Skills in [`skills/`](../../skills/README.md) teach the agent the workflow.

## Agents on your machine are your operators

An agent you run on this machine, outside an agent container, acts for you (ADR 0062). It may use the whole `ablationkit` CLI, as you would:

- run, stop and restart the coordinator;
- register projects and change their policies and configuration;
- start agent containers and drive them (`ablationkit agent start --detach`, `agent screen`, `agent send`, `agent stop`).

Its CLI calls use your session and are audited as yours. It still reports its own research through `ablationkit mcp`, as an agent session. Agents that run experiments for you without supervision belong in [agent containers](agent-containers.md), where AblationKit decides what they reach.

## The agent guard (opt-in)

For agents you still run uncontained on this machine and want kept out of AblationKit, `ablationkit project guard ID|--all` writes the **agent guard** into a registered checkout (ADR 0041). Registration and `scripts/setup.sh` no longer do this; `scripts/setup.sh --guard` does. It keeps Claude Code and Codex, working there, out of two directories:

- **the coordinator home** (`~/.ablationkit`, or `ABLATIONKIT_HOME`), which holds the login socket and the CLI's saved session: an agent that reaches it can act as you;
- **the coordinator-owned parts of the project's `.ablationkit/`**: `project.json`, `research/`, `conversations/` and `llm/` (ADR 0044). Agents need neither: they use AblationKit through `ablationkit mcp`, which the harness runs outside the agent's sandbox. `.ablationkit/extensions/` stays open: it is extension source agents write, and each change waits for your approval as a new build.

| File | What is added | Who enforces it |
| --- | --- | --- |
| `.claude/settings.local.json` (Claude Code's per-machine file) | `permissions.deny`: `Read`/`Edit` of the home and of the owned `.ablationkit/` paths, and `Edit` of the Claude and Codex settings files; `sandbox.filesystem.denyRead`/`denyWrite`: the same paths | Claude Code. The deny rules bind its file tools and the Bash file commands it recognizes (`cat`, `sed`, redirects), not other programs. The sandbox entries bind every Bash command at the OS level, but only when you turn on `sandbox.enabled`; AblationKit never sets it |
| `.codex/config.toml` | a permission profile `ablationkit-guard` (extends `:workspace`, denies the home and the owned `.ablationkit/` paths under the workspace roots), set as `default_permissions`, in two marked blocks | Codex's sandbox (bubblewrap and seccomp on Linux), for the agent's commands. Codex loads a project's config only when **you trust the project**, and `--sandbox` or a legacy `sandbox_mode` takes precedence |

- **Your settings are kept.** Existing keys and rules stay. Invalid JSON or TOML is reported and left alone, and so is a Codex config that already chose a sandbox (`sandbox_mode`, `[sandbox_workspace_write]`, another `default_permissions`).
- **They stay out of Git.** A file the guard creates goes in `.git/info/exclude`. A file Git already tracks is changed, but you get a note: it now holds paths from this machine.
- **Each file is reported** as `created`, `updated`, `unchanged` or `skipped`, with a note. It also tells you when Codex does not trust a checkout yet.
- **Taking it out:** `ablationkit project unguard ID|--all` removes exactly the guard's entries and blocks. A file the guard alone made up is deleted; your own rules stay.

This is configuration, not a boundary AblationKit enforces. It holds only inside these harnesses, and only as far as each enforces it. An agent you run with its sandbox or permissions bypassed, or under another harness, is not covered. See the [security overview](../security/README.md).

## Agent sessions

Each `ablationkit mcp` process is one **agent session**.

- **When it starts:** when the harness connects. The server asks the login socket for an agent token for the project, labelled with:
  - the harness (from the MCP client's name, or `--harness`);
  - a label (`--label`, by default `<harness> in <directory>`);
  - the directory it runs in.
- **Where the token lives:** in the MCP process's memory only. It is never written to disk, never shown to the agent, and never put in an environment the agent or its jobs see. There is nothing to paste, approve or rotate.
- **When it ends:**
  - when the harness closes the server;
  - after 12 hours without a request;
  - 7 days after it began;
  - when you end it in **Settings → Agent sessions**.

**Settings → Agent sessions** lists each session's harness, label, directory, start and last use, whether it is live, and the jobs, records and tasks it recorded. Wherever the web UI shows who made a job, record or task, an agent's work is named by its session.

**What a session token is.** It is identity, not a sandbox. It tells AblationKit:

- that a request is an agent's, so the agent API, the project policy and the compute limit apply;
- which project and which session it is, for attribution and the audit log.

It does not stop an agent that runs as your user from reaching `~/.ablationkit`, including the login socket, which also gives out human login links. For an agent on your machine that is by design: it is [your operator](#agents-on-your-machine-are-your-operators). An agent in an [agent container](agent-containers.md) cannot reach it: there the token is a boundary. To keep an uncontained agent out anyway, use the [agent guard](#the-agent-guard-opt-in). See the [security overview](../security/README.md).

Tokens minted before ADR 0040 (by the removed `POST /api/v1/auth/tokens`) keep working until they expire. They are listed as older agent tokens and you can end them there.

## The tools

The server's tools use the agent API only. A refusal comes back as the coordinator's code and message, for example:

- `policy_denied`;
- `time_limit_required`;
- `compute_limit_reached`;
- `task_closed`;
- `evidence_required`.

Lists page or take a limit, and logs and text artifacts are read a page at a time.

There are nine tools (ADRs 0054, 0060). Each reaches a set of operations, one per coordinator call. A misspelt, missing or mistyped argument is refused before anything is sent, with what the operation takes; a string that plainly is the argument's type (`"50"` for a number, `"true"` for a boolean, JSON text for an array or object) is read as that type. `ablationkit_read` with `{op: "help"}` lists every operation, and `{op: "help", about: "run.metrics"}` describes one.

| Tool | What it does | Operations or actions |
| --- | --- | --- |
| `ablationkit_project` | Start here: the project, this session, the policy summary, the compute limit and what is left, and the targets the agent may use with their weights and whether job limits are enforced there | — |
| `ablationkit_read` (marked read-only, so a harness can allow it at once) | Reads anything and changes nothing; `{op, …arguments}` | `compute`; `job.list`, `job.show`, `job.log`; `run.search`, `run.show`, `run.metrics`, `run.artifacts`, `run.artifact_text`, `run.imports`, `lineage`; `task.list`, `task.show`; `vault.show`, `vault.check`, `note.list`, `note.show`; `work.list`, `work.show`, `work.citations`; `research.list`, `research.show`, `review.list`; `dataset.list`, `model.list`, `model.show`, `model.artifacts`, `registry.list`, `registry.show`, `registry.resolve`, `evaluation.list`, `evaluation.show`, `evaluation.examples`, `evaluation.log`, `mlproject.show`; `inference.describe`, `inference.sessions`, `inference.evidence`, `deployment.list`; the LLM backend's reads (`llm.trace.search`, `llm.prompt.diff`, …); `extension.list`, `extension.show`, `extension.diff`, `extension.executions`, `extension.execution`, `extension.execution_log`, `extension.registry`, `extension.catalog`, `extension.operations` |
| `ablationkit_job` | Run a job (`runtime_max_sec` and a `description` required) or cancel one this session submitted; `{action, …}` | `submit`, `cancel` |
| `ablationkit_wait` (marked read-only) | Wait for jobs instead of sleeping or polling in a shell: until they end with their results in (MLflow synced, a remote target's results collected), start running, or log a metric at a step; any or all of them; this session's live jobs unless it names jobs or runs. It returns at `timeout_sec` (default 600, at most 3600) with where each job is, and at once when the researcher writes to the session (their direction or agenda change comes with the result). Sends MCP progress notifications when the call carries a progress token; a cancelled call stops | — |
| `ablationkit_run` | Say what a run showed (ADR 0048), import a run from before the project used AblationKit (ADR 0043), record or change a study | `describe`, `import`, `study` |
| `ablationkit_task` | Research tasks | `create`, `complete`, `abandon` |
| `ablationkit_note` | The vault (ADR 0049): atomic notes and the ledger (shelf, bottom line, order of claims) | `add`, `update`, `archive`, `ledger` |
| `ablationkit_work` | The library of prior work (ADR 0052); notes cite works with a role (`cites`) | `add`, `update`, `archive` |
| `ablationkit_do` | Everything else that changes something; `{op, …arguments}` | Research records (the older form of the vault's notes): `research.add`, `research.update`, `research.archive`, `report.generate`, `report.regenerate`, `conversation.link`; `deployment.request`; the LLM backend's writes (`llm.trace.link`, `llm.prompt.version`, `llm.golden_set.create`, `llm.golden_set.version`, `llm.evaluation.report`); `extension.validate`, `extension.build`, `extension.run`, `extension.action`, `extension.execution_cancel`, `extension.install`, `extension.call` |

The guide and the skills write a call as the tool and its action or operation: `ablationkit_note add` is `ablationkit_note` with `action: "add"`, and `ablationkit_read run.metrics` is `ablationkit_read` with `op: "run.metrics"`. Every agent operation the bundled LLM backend declares is reachable by its manifest ID, so a new one needs no change here.

## Tasks

A task is a record the agent creates to group its work. It has a title, a goal and optional criteria. It is `open` until the agent completes it with an outcome and the notebook that says what it established, or the agent or you abandon it.

1. **Create.** `ablationkit_task create` with the goal and criteria. It returns the task ID.
2. **Record work under it.**
   - Jobs: `ablationkit_job submit` with `task_id` and a `description` (what the run tests and why). The task must be an open task of the same project.
   - Notes: `ablationkit_note add` with `task_id`: what the runs showed as findings that cite them, the claim they move, the concepts a reader needs. The agent embeds them in the notebook of their question and in the session's edition.
   - Prior work: before it designs an experiment and whenever it is stuck, the agent searches the project's library (`ablationkit_read work.list`), then looks outside with its harness's own search tools; it records every work it consults, used or set aside (`ablationkit_work add`: how closely it read it, what it took from it or why not), and cites it from the notes it bears on with its role. You read the roles beside each note and in Notebooks → Library, and export the citations (ADR 0052).
   - Run outcomes: `ablationkit_run describe` once the agent has read the run.
3. **Complete.** `ablationkit_task complete` with an outcome (`supported`, `not_supported` or `inconclusive`), a `summary` that answers the goal (the task's conclusion) and `notebook_id`: the session's edition, a notebook of the vault that embeds the notes the task wrote. A report record (`report_id`) is still accepted in its place.
   - `supported` and `not_supported` need a note beneath the notebook that cites runs (or a report that cites evidence); without it the coordinator answers 409 `evidence_required`.
   - `inconclusive` needs the notebook, not evidence.
4. **Abandon** an open task with a reason: `ablationkit_task abandon`. You can abandon one too, on its page in the web UI.

**Reading.** You read the project's **Standing** page: the bottom line, the claims by how sure they are, the decisions in force and the open questions, each a note that unfolds in place (its gist, its summary, its full text with the notes it rests on and their runs). **Notebooks** is the shelf, the fundamentals first, each notebook read as one text. Reading marks itself; a note an agent revises comes back as revised. Nothing asks you to rate or mark anything.

**Reading tasks.** Tasks keep their pages (`/p/<project>/tasks`), reached from a note's sources. A task's page is a brief:

- the question (its goal and criteria) and the answer (its conclusion and outcome, with the report);
- loose ends: where the records under it lag its runs or say too little. The agent gets the same list as `checks` from `ablationkit_read task.show` and is told to clear it before it reports back;
- the hypotheses, studies, decisions, approaches, reports and notes that link it, each with its summary;
- the jobs that name it, with their MLflow runs and descriptions.

**Reviewing records.** Research records from before the vault keep the **Review** page (`/p/<project>/review`, no longer in the navigation): every task and record in reading order, with what you have not read yet. Mark an item reviewed from the list or from its page (with a note if you like), and "Reviewed, next" walks the list to its end. An item whose text, status or evidence changes comes back as changed. Marks record your reading and gate nothing; agents can read your notes through `ablationkit_read review.list` (ADR 0048).

Nothing there starts an agent.

## Directions

You steer through the record (ADR 0057). On a line of Standing or a note (*direct*, or `d` on the focused line), or for the project as a whole or the bottom line (*direct the project* at the top of Standing), write a **direction**: `ask` (explain or justify this), `doubt` (bring more evidence or lower its standing), `do` (do this next), `focus`, `park`, or a `rule` for every session until you withdraw it. The API also takes a run, a study or a task as its target.

- **Only you write them.** They are routes of the human API; an agent token that tries gets 403 `researcher_only`, audited. That is what lets `ablationkit mcp` present one to the agent as your words rather than as recorded content.
- **Delivered at the agent's next call.** Every agent API response carries `x-ablationkit-directions: N` while N directions in force have not been shown to that session; `ablationkit mcp` then appends them to the tool's result, framed as written by you in the web UI. `ablationkit_project` lists every direction in force at the start of a session. AblationKit has no other channel to an agent: a session that makes no call sees nothing until it does.
- **Answered on the record.** The agent responds with `ablationkit_do direction.respond`: `ack` (what it will do), `answer` (what it found or changed, with refs to the notes and runs; each must exist) or `decline` (why not). The thread shows under the line; you close it, reopen it (delivered again) or withdraw it.
- **Checked, and one refusal.** An unanswered direction is the `direction_unanswered` check in `vault.check` and `task.show` (advice). `ablationkit_task complete` is refused (409 `direction_unanswered`) while a direction on that task, its notes or its runs is unanswered; declining with a reason is an answer. Nothing enforces that an agent acts on a direction, or that a `park` stops jobs.

## The agenda

You plan on Standing (ADR 0058): an ordered **agenda** of Now, Next, Parked and Dropped items (a claim or question of the vault, or a line of your own) and rules for every session, edited in place, with one key from a ledger line (`n`, `e`, `p`, `x`).

- **Only you write it**, on the human API (`PUT /agenda`); the agent API has only `GET /agenda`.
- **Read first, and told when it changes.** `ablationkit_project` leads with it. While a session has not read the current revision, every agent API response carries `x-ablationkit-agenda-revision: N`; `ablationkit mcp` then reads the agenda and puts what changed at the start of the tool's result. When directions are also waiting, the same result ends with them.
- **Work names its item.** A task or job may name the item it serves (`agenda_item`); one the agenda does not have is refused. The panel shows what agents did for each item and which sessions read the current revision.
- **Checked, not enforced.** `parked_work`, `not_on_agenda` and `off_agenda` (a session working on nothing in Now) are advice; nothing refuses work on a Parked or Dropped item, and `agenda_item` is the agent's own declaration. Agenda rules and `rule` directions overlap for now: an agent sees both.

## Held to the record

What an agent writes is held against what the coordinator recorded on its own (ADR 0056). Every run a task's jobs produced is cited by a note or set aside with the agent's reason (`ablationkit_run describe` with `set_aside`), or it is flagged as `unaccounted_runs`; a number in prose is a live run reference (`[[run:<run>#<metric>]]`, `[[run:<run>#<metric> vs <baseline>]]`), and one typed by hand is flagged as `unreferenced_number`. You see the runs a finding leaves out under it, and each session's account (its jobs by how they ended, time limits hit, weighted hours, beside what it wrote) under *Account* in Project settings → Agents and Settings → Agent sessions; the agent reads its own with `ablationkit_read session.account`. These are views and advice: set-aside reasons and standings are the agent's account, attributed but not verified.

## What an agent can do

- **Records.** Create and update the project's research records, studies and conversation links; generate reports from a study's runs.
- **Historical runs.** Import a run that happened before the project used AblationKit from its files in the checkout: a labelled MLflow run (`import`), no job and no compute.
- **Jobs and runs.** Submit jobs and read them. Read the project's MLflow runs, metrics and text artifacts. Cancel the jobs its own session submitted.
  - Each submission is decided by the policy (`jobs.run_local`, `jobs.submit_remote`), then by the compute limit.
  - A job needs a time limit (`runtime_max_sec`). Without one it gets 400 `time_limit_required`.
  - A refusal is 403 `policy_denied` or 403 `compute_limit_reached`.
- **Deployments.** Request them; the policy decides ([deployment-gates.md](deployment-gates.md)).
- **Tasks.** Create, list, read, complete and abandon the project's tasks.
- **Directions.** Read yours, and acknowledge, answer or decline them.
- **Models, evaluations, inference, LLM research, extensions.** Read them; propose prompt versions and golden sets; build and run approved extensions.
- **Read its limits.** `ablationkit_project` or `ablationkit_read compute`.

## What an agent cannot do through MCP

An agent on your machine can do all of this through the CLI, as your operator (above); an agent in an agent container cannot.

- **Researcher-only actions.** These routes do not exist on the agent API, and no tool reaches them:
  - change the policy or the compute weights, or raise its compute limit;
  - approve or enable extensions, or activate builds;
  - launch evaluations, or move registry or prompt aliases;
  - restore backups or remove projects;
  - register projects;
  - write, close, reopen or withdraw a direction (writing one is a 403 `researcher_only`, so the agent is told why).
  - write the agenda (there is no route for it on the agent API).
- **Other projects.** Its session reaches only its own project (403 `forbidden_scope`, audited).

Every session of a project can complete or abandon any of that project's tasks. A new session cannot cancel an earlier session's jobs; you can.
