# AblationKit

A local-first, agentic workspace for machine-learning experimentation. One workstation coordinator keeps research records, jobs and agent activity; MLflow is the tracking and model-lifecycle backend behind a native UI; Claude Code and Codex, run from your own harness, report their work into it through AblationKit's MCP server (`ablationkit mcp`) and Agent Skills; the `ablationkit` CLI is the researcher's.

**Status:** v1.0 is built; the release notes and the tag remain. The [acceptance report](docs/release/acceptance-report.md) lists every criterion.

- Docs index: [`docs/README.md`](docs/README.md); the CLI by task: [`docs/cli.md`](docs/cli.md)
- Dev setup: [`docs/contributing/dev-setup.md`](docs/contributing/dev-setup.md)
- Specification: [`docs/spec/AblationKit_SPEC.md`](docs/spec/AblationKit_SPEC.md)
- Coding agents start at [`AGENTS.md`](AGENTS.md)

Reference platform: Linux with systemd. No container runtime is used.

## Install

AblationKit needs [Bun](https://bun.sh) 1.4.4 or later, [uv](https://docs.astral.sh/uv/) (for the managed MLflow) and Git. The desktop app uses the system Electron (`electron43`).

- **Arch Linux:** `scripts/packaging/aur/PKGBUILD`. From a checkout: `bun run package -- --source-tarball scripts/packaging/aur/ablationkit-1.0.0.tar.gz`, then `cd scripts/packaging/aur && makepkg -si`.
- **Any Linux, per user (no root):** `sh scripts/packaging/install.sh` from a checkout, or `sh install.sh` from an unpacked release (`bun run package -- --out DIR --tar FILE` makes one). It installs under `~/.local` and links `ablationkit` and `ablationkit-desktop` into `~/.local/bin`. Remove it with `--uninstall`, which keeps your data in `~/.ablationkit`.

Then `ablationkit coordinator start`, `ablationkit ui`, and `ablationkit project add PATH` for each repository. Agents use AblationKit through `ablationkit mcp`: add it to your harness ([`skills/README.md`](skills/README.md)). `ablationkit version` says which build you are running. How the install is laid out: ADR 0028.
