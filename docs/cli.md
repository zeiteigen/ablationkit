# Using the CLI

The `ablationkit` CLI is the researcher's and the operator's: it runs the coordinator, sets projects and compute targets up, keeps tracking and backups healthy, and authors extensions offline. Its own usage (the `help` command) lists every command; this page says which ones to reach for and what they need. From a checkout without `sh scripts/setup.sh`, prefix every command with `bun run` (`bun run ablationkit project list`).

Research itself happens in the web UI (`ablationkit ui`): jobs, runs, studies, research records, tasks, models, inference and the LLM Lab. Agents never use the CLI: they use AblationKit through its MCP server, `ablationkit mcp`, which their harness launches ([agents reporting into AblationKit](autonomy/agent-first.md), ADR 0040).

Most commands take `--json`. A remote CLI adds `--coordinator URL` (or sets `ABLATIONKIT_COORDINATOR`).

## Coordinator and access

| Task | Commands |
| --- | --- |
| Start, stop, open the UI | `ablationkit coordinator start [--foreground]`, `coordinator stop\|restart\|status`, `ablationkit ui` (a one-time login link) |
| Register a repository | `ablationkit project add PATH`, `project list\|show ID`, `project remap ID PATH` (a moved checkout), `project doctor --project ID` |
| Read or move a project's vault | `ablationkit vault show [--project ID]` (the bottom line, claims by standing, decisions, open questions, the shelf), `vault check` (where its notes fall short: advice for the agent that writes them), `vault import DIR [--dry-run]` and `vault export --out DIR` (Markdown files, one note each, one work of the library each under `works/`, with `index.yaml`; import replaces notes and works whole and is idempotent). `--project` defaults to the registered checkout you are in (ADR 0049) |
| See the prior work behind a project and cite it | `ablationkit vault works [--q WORDS] [--role ROLE] [--standing used\|considered\|unread]` (the library: each work, how closely it was read, what was taken from it and the notes citing it in which role), `vault cite [--format bibtex\|csl-json\|markdown] [--notebook ID] [--cited] [--out FILE]` (its citations, the role each work played as the annotation) (ADR 0052) |
| Keep agents out of `.ablationkit` | `ablationkit project guard ID\|--all [--json]`: writes the agent guard into registered checkouts (Claude Code's `.claude/settings.local.json`, Codex's `.codex/config.toml`) from the registry file, with or without a running coordinator, and says whether Codex trusts each checkout. Registration does this for new projects; `scripts/setup.sh` runs it for all (ADR 0041, [agent-first](autonomy/agent-first.md#what-ablationkit-writes-into-your-checkout-for-agents)) |
| Which build is running | `ablationkit version` |
| Tracking health | `ablationkit tracking doctor`, `tracking status`, `tracking outbox [--failed]`, `tracking retry OP_ID`, `tracking import --project ID --experiment EXP` (a historical MLflow experiment, read-only) |
| Startup diagnostics and safe mode | `ablationkit system status`; `coordinator start --safe-mode` or `coordinator restart --safe-mode` boots with every extension inactive. The System page shows the same |
| Backups | `ablationkit backup create\|list`, `backup verify ID`, `backup export ID --out FILE` |
| Restore or move (coordinator stopped) | `ablationkit backup restore ID\|DIR\|ARCHIVE [--project ID=PATH] [--worker-url URL] [--force]`; `ablationkit coordinator move --out FILE` packs this home and retires it. A restore at the next start is scheduled from the System page |
| Remote clients over the tailnet | `ablationkit access tailscale\|status\|off`, then `ablationkit login --origin https://HOST.TAILNET.ts.net`; a remote CLI logs in with `login --coordinator URL --code CODE` |

Details: [dev setup](contributing/dev-setup.md#running-the-coordinator), ADR 0025.

## Compute

Jobs are launched from the web UI (the Jobs page's launch dialog, or the command palette) or, by an agent, with the `ablationkit_job submit` MCP tool; both can name a remote target. The CLI sets the targets up and looks after remote attempts.

| Task | Commands |
| --- | --- |
| Add a remote target | `ablationkit target add ID --kind ssh\|slurm --host H [--worker-url URL]`; Runpod: `--kind runpod --api-key-env VAR --image IMG --gpu T --cents-per-hour N`; Colab: `--kind colab --gpu L4` (unattended runtimes through Google's Colab CLI; sign it in once with `colab sessions`; also `--tpu`, `--high-mem`, `--keep-after-sec N`, `--auth oauth2\|adc`) or `--kind colab --notebook [--live]` (notebooks you run). Then `target list\|show\|doctor\|usage\|remove` (`usage`: a Colab account's compute units) |
| Remote attempts | `ablationkit remote status\|drain\|reauthorize\|resolve JOB`. The worker runs from a staged bundle of the pinned commit and reconciles later; `drain` delivers a leftover spool and never reruns the job |
| Colab (notebook) | `ablationkit remote notebook JOB [--out F] [--loader]` writes the attempt's notebook (`--loader` also prints one cell to paste into an empty Colab notebook); `ablationkit remote import JOB ARCHIVE` (or `--base64 FILE`, the archive the notebook printed when its download did nothing) brings the results back |
| Policy and the compute limit | Project settings → Agent permissions (the project action policy and the agents' compute limit); compute weights per target on the Compute page ([project permissions](autonomy/project-permissions.md)) |

Settings for remote compute: `worker.host: "tailscale"`, `remote.worker_url`, and optionally `remote.artifact_store` for large artifacts through S3, R2 or MinIO (ADR 0023).

## Agents

| Task | Commands |
| --- | --- |
| Give an agent AblationKit | register the checkout (`ablationkit project add PATH`), then add the MCP server to the harness: Claude Code `claude mcp add ablationkit -- ablationkit mcp`; Codex an `[mcp_servers.ablationkit]` table with `command = "ablationkit"` and `args = ["mcp"]` |
| Options | `ablationkit mcp [--project ID] [--label TEXT] [--harness NAME]`: the project defaults to the checkout's `.ablationkit/project.json` in the directory it starts in or a parent; one process is one agent session |
| See and end sessions | Settings → Agent sessions in the web UI (harness, label, directory, last use, what each recorded, End session) |
| The tools | [agent-first work: the tools](autonomy/agent-first.md#the-tools); the Agent Skills in [`skills/`](../skills/README.md) teach the workflow |

An agent's jobs need a time limit and count against the project's compute limit; its deployments are decided by the policy ([deployment gates](autonomy/deployment-gates.md)).

### Agent containers (ADR 0061)

Run your harness in a rootless Podman container instead of on this machine: no GPU, no network but the project's egress allowlist, no view of `~/.ablationkit`, and its local jobs in job containers with the GPU. Opt-in; needs Podman and tmux ([agent containers](autonomy/agent-containers.md)).

| Task | Commands |
| --- | --- |
| Check and prepare | `ablationkit agent doctor` (Podman rootless, tmux, the GPU's CDI spec); `ablationkit agent image build [--tag IMAGE]` builds `localhost/ablationkit-agent:1` once |
| Start a session | in a registered checkout: `ablationkit agent start [--harness claude-code\|codex\|shell] [--label TEXT] [--harness-binary PATH] [--detach] [-- HARNESS_ARGS…]`. The harness binary and uv are found on your PATH (version-manager shims skipped); the terminal attaches unless `--detach`. Detach with Ctrl-b d |
| Return to it, list, read | `ablationkit agent attach SESSION`; `agent list [--project ID]`; `agent show SESSION`; `agent screen SESSION` (the terminal now); `agent egress SESSION [--denied]` |
| Control it | `ablationkit agent pause SESSION [--reason T]` (freezes it), `agent resume SESSION`, `agent stop SESSION` (ends it and its token); also in the web UI |
| What containers may reach | `ablationkit agent allow HOST…` (egress allowlist: `pypi.org`, `*.hf.co`, `example.com:8443`); `agent config [show\|edit\|set FILE]` for the rest: hidden and read-only paths, job containers' GPU and network, protected evaluations, credentials, host code, pausing at the compute limit |

## Extensions and source changes

| Task | Commands |
| --- | --- |
| Start an extension | `ablationkit extension templates`, `extension scaffold --template T --id ID [--path CHECKOUT]`, `extension validate --path DIR`, `extension doctor` (all offline) |
| Build and run | agents use the `extension.*` operations of `ablationkit_read` and `ablationkit_do`; the researcher builds and runs from Project settings → Extensions |
| Approve, enable, roll back | the web UI (Project settings → Extensions) |
| Share | `ablationkit extension publish EXT [--project ID]` publishes an approved build to your user registry |
| Check the development environment | `ablationkit dev doctor [--json]` (or `bun run doctor`) |
| Change AblationKit itself (Level 2) | `ablationkit dev build [--check CMD]`: checks plus a reviewable build of a branch, activated from the System page and run at the next start |

Details: [extensions](extensions/README.md), [source changes](contributing/source-changes.md).
