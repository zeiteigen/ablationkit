# Troubleshooting

Start with `bun run doctor` (the development environment) or `ablationkit system status` (a running coordinator's startup diagnostics, also on the System page).

## Building and testing

- The browser shows "The web UI is not built on this machine": run `bun run web:build` and reload.
- A blank page after sign-in, from a source checkout: the web bundle is older than the source (it can call routes the coordinator no longer has). Run `bun run web:build` and reload; `ablationkit ui` rebuilds a stale bundle itself.
- `test:web` fails with "no Chromium found": set `ABLATIONKIT_CHROMIUM=/path/to/chrome`, install Playwright's (`cd apps/web && bunx playwright-core install chromium`), or install a system `chromium`.
- `protocol: generated files are stale`: run `bun run protocol:generate` and commit the result.
- A docs drift test fails: it names the file and the missing command, script, link or route. Fix the doc, or add the route to [`docs/api/coordinator-api.md`](../api/coordinator-api.md).
- doctor `python-deps` fails: run `uv sync --locked`.
- A test passes alone but fails under `bun run test`: it is racing something asynchronous in parallel; wait for the condition (`until(...)`) rather than reading state once. Run the file serially with `bun test <path>`.
- Tests never start the real sidecar: `apps/server/test/helpers.ts` disables it and passes `trackingUrl` to a fake.

## The MLflow sidecar

- `tracking status` shows `failed`: read `<home>/mlflow/logs/sidecar.log`. If the port is taken, set `mlflow.port`. If `uv` is not found under systemd, run `coordinator start` again from a shell where `uv` is on `PATH` (the unit records its absolute path), or set `ABLATIONKIT_UV`.
- `tracking status` shows `upgrade_blocked`: the pinned MLflow differs from the one that last opened `<home>/mlflow`, and either the pre-upgrade backup failed or the pin is older (a downgrade). The reason names which.
- Writes are queued but not reaching MLflow: `ablationkit tracking outbox --failed` lists rejected writes; `tracking retry OP_ID` requeues one.

## Jobs

- doctor warns about `systemd-user`: jobs fall back to direct mode and their CPU, memory and task limits are advisory. Check `systemctl --user is-system-running` and that `cpu memory pids` are in `/sys/fs/cgroup/user.slice/user-$UID.slice/user@$UID.service/cgroup.controllers`.
- A job stays `starting`: its collector failed to launch or start the command. Read `journalctl --user -u ak-col-<attempt>.service` (systemd mode) or `<home>/spool/<attempt>/collector.log` (direct mode). An attempt whose collector vanished becomes `unknown` within about 15 s; nothing is rerun.
- Collectors keep their spool when they cannot deliver. Set `ABLATIONKIT_KEEP_SPOOL=1` in the coordinator's environment to keep it after successful delivery too (debugging).
- An agent's job is refused with `time_limit_required` or `compute_limit_reached`: see [project permissions](../autonomy/project-permissions.md). `policy_denied` names the policy field that refused it.
- A Colab job failed at staging: `ablationkit target doctor colab`. "not signed in": run `colab sessions` once in a terminal and follow the link. "Backend rejected accelerator": the Google account has no entitlement or compute units for that GPU (`colab usage`; pick another with `ablationkit target add colab --kind colab --gpu T4`).
- A remote attempt is stuck or its outcome is ambiguous: `ablationkit remote status JOB`, then `remote drain JOB` (deliver a leftover worker spool; never reruns the job) or, after checking the target, `remote resolve JOB --note T` (`--lost` for an exported Colab attempt that will not report).

## Storage and recovery

- After a crash: `ablationkit system status` reports interrupted JSON replacements, partial JSONL tails, stalled or pending MLflow writes, orphaned tracking runs, unavailable workers and missing artifacts, with the affected paths. It reports and never repairs. Snapshot, journal and migration rules: [storage layouts](../api/storage.md).
- A bad extension blocks startup: `ablationkit coordinator restart --safe-mode` boots with every extension inactive for that boot.
- Restoring a backup or moving to another machine: [dev setup](../contributing/dev-setup.md#running-the-coordinator).
