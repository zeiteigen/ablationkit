# Changing AblationKit's source (Level 2)

Level 2 changes modify AblationKit itself: a core service, a first-party screen, a storage
format, an executor (spec §8.5). They are **trusted application changes**: once you run a
modified build, it has the coordinator's full privileges. That is why every change goes through
a Git branch, the documented checks and a reviewable build, and why only the researcher can
activate a build, from the human API with their session. A prompt or an agent never replaces the
running coordinator: the agent API has no build route.

If what you need fits a run tab, panel, demo, report block, action or Python analysis, write a
Level 1 extension instead ([docs/extensions/](../extensions/README.md)). It needs no source
change, upgrades cleanly and is sandboxed where §7.11 allows.

## Workflow

1. **Branch.** Work in a Git branch or worktree, never on `main` in the installed checkout:
   `git switch -c agent/<topic>`.
2. **Find the code.** [AGENTS.md](../../AGENTS.md) maps every package and server module.
   [docs/architecture/README.md](../architecture/README.md) gives ownership and dependencies.
   The ADR named next to each module explains why it is built the way it is.
3. **Change it, with its contract.** If you change a schema, CLI/API shape, permission, SDK or
   tracking integration, update the docs, types, fixtures and tests in the same change
   (§8.5 item 5). The playbooks below list what each area needs.
4. **Run the checks** in the branch: `bun run lint`, `bun run typecheck`, `bun run test`
   (everything CI runs: `bun run ci`). If you touched the UI, also run `bun run test:web`.
5. **Commit**, then make the build:

   ```sh
   ablationkit dev build                 # runs lint, typecheck and tests, then builds
   ablationkit dev build --check "bun run ci"
   ```

   `dev build` refuses uncommitted changes. It exports the commit to
   `~/.ablationkit/builds/<build-id>/source/`, installs its locked dependencies, builds its web
   UI, and records the commit, branch, changed files, diffstat and every check result
   (`SourceBuildRecord`). A build whose checks failed is listed but cannot be activated.
6. **Review and activate** (the researcher). Open System → Coordinator and build. It shows
   what is running (commit, branch, a **modified build** badge when it is not the original
   install), the builds with their checks and diffstat, and **Activate for next start**.
   Activation changes nothing in the running process.
7. **Restart to run it:** `ablationkit coordinator stop && ablationkit coordinator start`.
   `coordinator start` runs the active build. Back up first if the change touches storage:
   `ablationkit backup create`.
8. **Roll back:** System → Use the original install, then restart.

## Playbooks

| Area | Where | Also update | Checks |
| --- | --- | --- | --- |
| A first-party screen | `apps/web/src/pages/*.tsx`, `components/` | Playwright flow in `apps/web/e2e/smoke.test.ts` when behaviour changes | `bun run typecheck`, `bun run test:web` |
| A coordinator route | `apps/server/src/listeners/*.ts` and the service it calls | `docs/api/coordinator-api.md`; agent routes also need `apps/server/test/listeners.test.ts` (the agent route list is explicit) | `bun test apps/server/test` |
| A core service | `apps/server/src/<domain>/<service>.ts` (the file map in `docs/architecture/README.md`) | its test file in `apps/server/test/`; an ADR if behaviour or a contract changes | `bun test apps/server/test/<service>.test.ts` |
| A stored record | `packages/protocol/src/*.ts` (TypeBox) | `bun run protocol:generate`, a fixture in `packages/protocol/fixtures/`, `docs/api/storage.md`, a migration in `packages/core` for an incompatible change | `bun run protocol:check`, `uv run pytest python/ablationkit-protocol` |
| MLflow tracking | `packages/tracking-mlflow` (coordinator-only) | the fake in `src/testing.ts`; the real contract test | `bun run test:mlflow` |
| Jobs and compute | `apps/server/src/compute/jobs.ts`, `packages/collector`, `packages/process-supervisor` | `docs/api/coordinator-api.md` § Jobs | `bun test apps/server/test/jobs.test.ts packages/collector` |
| The CLI | `apps/cli/src/commands/*.ts` | the usage text; skills that mention the command (`apps/cli/test/skills.test.ts`) | `bun test apps/cli` |
| The extension host API | `packages/extension-host`, `packages/extension-sdk`, `python/ablationkit-extension` | bump `HOST_API_VERSION` (semver) and the SDK versions; [compatibility notes](../extensions/README.md#compatibility); templates | `bun test packages/extension-host apps/server/test/extensions.test.ts` |

## What a fork keeps

A modified build keeps the extension host API it reports (`HOST_API_VERSION`) and the protocol
schemas it generates. Nothing else is promised: internal modules are not public APIs, and an
arbitrary fork may need manual rebasing to take upstream releases (§8.5 item 6).
