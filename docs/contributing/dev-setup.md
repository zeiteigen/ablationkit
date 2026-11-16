# Development setup

Needs Bun 1.4.4+, uv 0.12+ and git. Python 3.14 comes from `.python-version` (`uv python install`).

```sh
bun install --frozen-lockfile   # TypeScript workspace
uv sync --locked                # Python workspace (.venv)
bun run doctor                  # ablationkit dev doctor: checks the above
bun run ci                      # every CI check, exactly as GitHub Actions runs it
```

`sh scripts/setup.sh` does the two installs, writes `~/.local/bin/ablationkit` (a launcher that runs `apps/cli/src/main.ts` from this checkout, so plain `ablationkit` works anywhere and edits take effect at once), links every Agent Skill in `skills/` into each Claude Code config and Codex, and registers the `ablationkit` MCP server (`ablationkit mcp`, ADR 0040) with them at user scope, so agents in any registered project can use it. Claude Code configs are the default (`~/.claude`, `~/.claude.json`) and every `~/.claude-*/` holding a `.claude.json`, a second profile run with `CLAUDE_CONFIG_DIR` (for example a `claude-pro` wrapper); `--claude-config DIR` adds another. Codex is set up when its home (`$CODEX_HOME`, default `~/.codex`) exists. Last, it applies the agent guard (ADR 0041) to every project already registered in `${ABLATIONKIT_HOME:-~/.ablationkit}` (`ablationkit project guard --all`: Claude Code and Codex settings in each checkout that keep agents out of the coordinator home and `.ablationkit/`; new registrations get them from the coordinator); it skips this when no registry exists yet and never fails because of it. It is idempotent; `--no-deps` skips the installs, `--no-mcp` skips the MCP registration, `--no-guard` skips the agent guard, `--prefix DIR` moves the launcher, `--uninstall` removes the launcher, the skill links into this checkout and the MCP entries that run this launcher. It refuses to replace a launcher or an `ablationkit` MCP entry it did not write (a packaged install from `scripts/packaging/install.sh`) unless given `--force`. It reads the harness configs directly to check what is registered: `claude mcp get` would start the server for its health check and open an agent session.

Individual checks: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run protocol:check`, `bun run test:mlflow` (starts the pinned MLflow in a temp directory and runs the REST contract; the first run downloads MLflow and Python 3.12 into the uv cache), `bun run test:torch` (opt-in, not in CI: runs `fixtures/projects/torch-custom-loop` as a real job; the first run downloads CPU torch, about 200 MB). `bun run test:web` (Playwright smoke tests of the web shell in Chromium against a real coordinator and the fake MLflow; part of `bun run ci`). Use `bun run format` to fix formatting. After changing a schema in `packages/protocol/src`, run `bun run protocol:generate`. After changing an MLflow call in `packages/tracking-mlflow/src/client.ts` or a bridge op, update `packages/tracking-mlflow/src/feature-matrix.ts` and run `bun run mlflow:matrix`; after adding or renaming a route or a CLI command, update `docs/api/coordinator-api.md` or the CLI usage (the drift tests name what is missing).

`bun run test` runs the Bun suite with `bun test --parallel` (one worker process per core, each file in a fresh global; about 30 s instead of about 4 min) and then pytest. Tests in one file still run in order, so the floor is the slowest file (`apps/server/test/remote.test.ts`, which waits on real heartbeats and offline windows). A test that passes alone but fails in parallel is usually racing something asynchronous: wait for the condition (`until(...)`) rather than reading state once. Run a file serially with `bun test <path>`.

Release qualification: `bun run acceptance` runs the evidence for every spec §15 criterion (the suites CI runs; `--real` adds `test:extensions` and `test:torch`, which download wheels) and writes [`docs/release/acceptance-report.md`](../release/acceptance-report.md). The registry of criteria and evidence is `scripts/acceptance-criteria.ts`; `scripts/test/acceptance.test.ts` keeps it in step with the spec and the tests.

## Web UI

```sh
bun run web:build                 # apps/web/dist (Bun bundler, well under a second); `ablationkit ui` runs it if dist/ is missing
bun run web:dev                   # rebuild on every change under apps/web/src; reload the browser
bun apps/web/e2e/stack.ts         # throwaway coordinator + fake MLflow + seeded study; prints a login link
```

The coordinator serves `apps/web/dist` at every non-API path, so there is no separate dev server. `ABLATIONKIT_E2E_REAL_MLFLOW=1 bun run test:web` (or the same variable with `stack.ts`) runs against the pinned MLflow sidecar instead of the fake. The smoke tests need a Chromium: `ABLATIONKIT_CHROMIUM=/path/to/chrome`, Playwright's own download (`cd apps/web && bunx playwright-core install chromium`), or a system `chromium`.

## Running the coordinator

```sh
bun run ablationkit coordinator start          # systemd user service ablationkit-coordinator.service
bun run ablationkit ui                         # opens a one-time login link
bun run ablationkit project add /path/to/repo
bun run ablationkit coordinator stop
```

- `--foreground` runs the coordinator in the terminal instead of under systemd.
- `ABLATIONKIT_HOME` points at another runtime directory. `ABLATIONKIT_SERVICE=<name>.service` uses another unit name. Use both together to try the service without touching your real `~/.ablationkit`, and put non-default ports in `$ABLATIONKIT_HOME/settings.json`.
- The browser session is the researcher's only credential: privileged actions (policy revisions, extension approval, build activation, restores, project removal, widening LLM data controls) need just that session (ADR 0037). Keep the session to yourself. Agents use `ablationkit mcp`, which mints its own agent session token (ADR 0040); deny agents `~/.ablationkit` in your harness's sandbox, or they can ask the login socket for a session as you.
- The coordinator also starts the managed MLflow sidecar on `127.0.0.1:7423` (ADR 0010). The first start runs `uv sync` into `<home>/mlflow/venv`, which takes a while; the API is up meanwhile. Check it with `ablationkit tracking status` or `ablationkit tracking doctor`. Turn it off with `"mlflow": {"enabled": false}` in `settings.json` (tracking writes then queue in the outbox), or move it with `"mlflow": {"port": N}`.
- `ablationkit backup create` writes a coordinated snapshot to `<home>/backups/`. `backup verify ID` re-hashes it. `backup export ID --out FILE` packs it for another machine, where `backup restore FILE --project ID=PATH` restores it into an empty `ABLATIONKIT_HOME` with the coordinator stopped. `bun run test:restore` proves this against the real MLflow (ADR 0025).
- To hand the coordinator to another machine: `coordinator stop`, then `coordinator move --out FILE`. That retires this home, so it refuses to start again, and the new machine restores the archive. From the web UI, System → Backups can schedule a restore of a backup for the next start.
- `ablationkit system status` shows the startup diagnostics (spec §13); the System page shows the same. `coordinator start --safe-mode` (or `coordinator restart --safe-mode`) boots with every extension inactive for that boot.
- Run a job from the web UI (the Jobs page's launch dialog, or the command palette) or, as an agent, with the `ablationkit_job submit` MCP tool (ADR 0011). Commands run through `uv run --frozen --project <checkout>` when the checkout has a `pyproject.toml`; environment `none` runs them as given. `import ablationkit_sdk` works in any job without installing it. A job an agent submits needs a time limit: it counts against the project's agent compute limit ([project permissions](../autonomy/project-permissions.md)).
- Try the agent side from a source checkout: `claude mcp add ablationkit -- bun "$PWD/apps/cli/src/main.ts" mcp`, then start Claude Code in a registered checkout; Settings → Agent sessions shows the session ([agent-first](../autonomy/agent-first.md)).
- Resource limits are enforced only through systemd user scopes. `GET /api/v1/jobs/supervisor`, and every attempt's `supervisor` field, say `enforced` or `advisory`. Set `"jobs": {"supervisor": "direct"}` in `settings.json` to skip systemd (limits become advisory, only the time limit is applied).
- For a remote browser or the desktop app on another machine, run `ablationkit access tailscale` on the workstation. It runs `tailscale serve --bg --https=443` to the loopback human port, adds `https://<host>.<tailnet>.ts.net` to `trusted_origins`, and tells you to restart the coordinator. Then `ablationkit login --origin https://<host>.<tailnet>.ts.net` prints a one-time link for the remote machine; a remote CLI uses `ablationkit login --coordinator URL --code CODE`. A remote session can do everything a local one can, privileged actions included. `access status` and `access off` show and undo it (ADR 0025). The tailnet needs MagicDNS and HTTPS certificates enabled.

## Desktop app

```sh
bun run desktop          # builds apps/desktop/dist and opens it with the system Electron
bun run test:desktop     # Playwright drives the real Electron against a throwaway coordinator
```

- Electron is not installed by `bun install`. Install it from the distribution (Arch: `pacman -S electron43`) or set `ABLATIONKIT_ELECTRON=/path/to/electron`. The tests need a display (Wayland, X11 or `xvfb-run`) and skip without one.
- The first start opens the coordinator of `ABLATIONKIT_HOME` (starting the systemd service if needed). AblationKit → Connection… switches to a remote coordinator (HTTPS URL plus a one-time link), to another runtime directory, or to running the coordinator as a child of the app. The choice is saved in `~/.config/ablationkit/desktop.json`.
- The windows are sandboxed, without Node and without a preload (spec §8.3). `ABLATIONKIT_DESKTOP_DEVTOOLS=1` enables the developer tools.
- Notifications: Settings → Notifications turns them on in a browser or the app. The workstation also gets them through libnotify.

## Troubleshooting

See [troubleshooting](../troubleshooting/README.md): build and test failures, the MLflow sidecar, systemd limits and stuck jobs.
