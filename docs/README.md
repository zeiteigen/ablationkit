# AblationKit docs

Maintained docs first, grouped by what you are doing; the historical record (spec, ADRs) last. The docs drift tests (`apps/cli/test/docs-drift.test.ts`) check every maintained doc's links, `ablationkit` commands and `bun run` scripts.

## Using AblationKit

- [User guide](guide/index.html): task-oriented HTML documentation, also available in UI → Docs. Open the file directly for offline reading, or copy `docs/guide/` to a static host; no build is required.

- [CLI guide](cli.md): the researcher's and the operator's `ablationkit` commands by task (the coordinator, projects, backups, remote compute, giving an agent `ablationkit mcp`, extension authoring, Level 2 builds). Research itself happens in the web UI.
- [Agents: policy, tasks and MCP](autonomy/README.md): what an agent may ask AblationKit to do ([project permissions](autonomy/project-permissions.md), the compute limit, [deployment gates](autonomy/deployment-gates.md)) and how agents report in through `ablationkit mcp`: agent sessions, the MCP tools and tasks ([agent-first work](autonomy/agent-first.md)).
- [Extensions](extensions/README.md): manifest, contribution points, capabilities, SDKs, trust labels, [backends](extensions/backends.md) and three tutorials.
- [Troubleshooting](troubleshooting/README.md).
- Agent Skills for Claude Code and Codex: [`skills/`](../skills/README.md).

## Developing AblationKit

- [Development setup](contributing/dev-setup.md): install, checks, the web UI, running the coordinator, the desktop app.
- [Changing AblationKit's source (Level 2)](contributing/source-changes.md): workflow, `ablationkit dev build`, activation and playbooks.
- [Architecture map](architecture/README.md): every package, what it owns and depends on, and the request, job, tracking and agent paths.
- Reference: [coordinator API](api/coordinator-api.md), [protocol schemas](api/protocol.md) (generated), [storage layouts](api/storage.md), [MLflow feature matrix](api/mlflow-compatibility.md) (generated).
- [Security](security/README.md) and the [threat map](security/threat-map.md) (generated): each threat, its control and level, and the tests that prove it.
- [Release qualification](release/README.md): the [acceptance report](release/acceptance-report.md) (generated), opt-in suites, packaging.

## History

Kept as written; current behaviour is in the docs above and the latest ADRs.

- [Specification v0.16](spec/AblationKit_SPEC.md): read by section, never whole. ADRs record where the build deviates.
- Decisions (ADRs): the code and docs cite design decisions by number (ADR 0040 and so on). The decision records themselves are not published; the maintained docs here describe current behaviour.
- [History](history/): one-off reports on the repository, dated, such as the [desloppify pass of 2026-11-13](history/2026-11-13-desloppify.md) and the structural steps it proposed.
