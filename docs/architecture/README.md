# Architecture map

System map, package ownership, dependency graph and request/event paths (spec §8.6). Keep it current: a change that adds a package or a module updates its row here and its one-line entry in [`AGENTS.md`](../../AGENTS.md); `apps/cli/test/docs-drift.test.ts` checks that both name every app and package. Repository layout: spec §11, as amended by ADR 0038.

## Packages

| Path | Owns | Depends on |
| --- | --- | --- |
| `packages/protocol` | Versioned schemas (TypeBox), validators, the generator for JSON Schema, Python models and [API docs](../api/protocol.md) | — |
| `packages/core` | Coordinator file storage: atomic JSON, JSONL journals, migrations, recovery, diagnosis (ADR 0007); the read-only Git the coordinator needs (`git.ts`: commit, modified files, `git archive`; hooks off; ADR 0037); the JSON HTTP basics the coordinator and the bundled LLM backend share (`http.ts`: `HttpError`, `json`, `readJsonBody`) | `protocol` (types only) |
| `packages/auth` | Hashed bearer tokens (sessions, agent and worker tokens) and one-time login codes (ADR 0008); no passkeys or step-up since ADR 0037 | `core`, `protocol` |
| `packages/tracking-mlflow` | MLflow REST client, durable outbox, run mapping, tracking service, managed sidecar supervisor, SQLite-safe snapshot (ADR 0010); `@ablationkit/tracking-mlflow/testing` is a contract-tested fake MLflow | `core`, `protocol` |
| `packages/tracking-mlflow/env` | The pinned MLflow environment (`pyproject.toml` + `uv.lock`), synced into `<home>/mlflow/venv`; bump the pin only with `bun run test:mlflow`, `test:lifecycle` and `test:llm` passing. `bridge/ablationkit_bridge.py` is the operations bridge run in it as a supervised subprocess: classical and batch evaluation, one-shot `predict`, session `serve`, `genai_evaluate` (ADR 0019, ADRs 0020, 0021) | `uv`, Python 3.12 |
| `packages/process-supervisor` | Runs one attempt under `systemd-run --user --scope` limits (or a direct-mode process group), maps systemd results, cleans up the process tree, launches detached helpers (ADR 0003, ADR 0011) | `protocol` (types) |
| `packages/collector` | The worker collector: starts the job, captures stdout/stderr, tails SDK events and the metrics file, durable bounded spool, at-least-once delivery and artifact uploads; spool layout (ADR 0011) | `core`, `process-supervisor`, `protocol` |
| `packages/compute-targets` | Remote compute: run bundles (`git archive` of the pinned commit + the worker + the SDK, checksummed; `bundle.ts`), the target adapter interface (§10) with capabilities (`targets.ts`), the `ssh` and `slurm` adapters over the user's SSH (bundle streamed over stdin; `sbatch`/`sacct`/`scancel`), `runpod` (REST pods that pull their bundle; `runpod.ts`) and `colab` (notebook export; `colab.ts`) (ADR 0023) | `protocol` |
| `packages/autonomy-policy` | The project action policy (version 2: jobs, deployments, compute limit; the version 1 migration, `ask` → `deny`), enforceability checks, one decision per agent action, diffs, model-URI pinning, the agent compute accounting and admission (`compute.ts`: weighted hours used and reserved) (ADR 0018, ADR 0037) | `protocol` (types) |
| `packages/inference-adapters` | Inference task adapters (tabular, text, image) chosen from a model's signature and `metadata.ablationkit`, payload and params validation, schema compatibility for comparisons, canonical JSON, the exact McNemar test (ADR 0020). Pure; shared by the coordinator and the web UI | none |
| `packages/data-controls` | Domain-neutral capture and redaction primitives used by host brokers and extensions | — |
| `packages/llm-research` | Pure domain helpers used by the bundled LLM backend, CLI and UI: capture and redaction of MLflow spans, the span tree and waterfall, RAG and tool-call views, failure clusters, prompt templates (variables, rendering, diffs, references), usage totals, labelled cost estimates, provider locality and per-example alignment (ADR 0021). Pure | `data-controls` |
| `packages/vault` | The vault's pure logic (ADR 0049): what a note's text embeds and links, the tree those embeds make (children, parents, every place a note sits, editions), the ledger, composition into prose and embeds, search, and the checks; the library of prior work (`works.ts`, ADR 0052: who cites which work in which role, its checks, citations as BibTeX, CSL-JSON and an annotated bibliography); the witness (`witness.ts`, ADR 0056: live run references `[[run:<run>#<metric>]]` in prose, the numbers typed by hand instead, and which runs a note names, so each run of a task is cited, set aside or unaccounted for); the agenda's logic (`agenda.ts`, ADR 0058: naming an item, the diff between revisions, the checks on agents' work against it); `@ablationkit/vault/markdown` is the Markdown form (frontmatter, `<!-- full -->`, `index.yaml`, `works/<id>.md`; Bun only). Pure; shared by the coordinator, the CLI and the web UI | `protocol` |
| `packages/builtin-llm` | Bundled LLM backend: LLM services in a subprocess, operations and route declarations (its agent operations are `ablationkit mcp` operations, reached by their manifest IDs through `ablationkit_read` and `ablationkit_do`) and Agent Skills; the LLM Lab React page and its local frame bridge; plus the GenAI Python worker and project SDK. The backend owns the implementation (ADR 0021 and 0024) | `extension-host`, `llm-research`, `react`, `react-dom` |
| `packages/extension-host` | Public API 2 backend contracts, validation, scoped clients and CLI argument helpers, alongside the pure half of the Level 1 extension host: contribution-point, capability and operation catalogs, manifest validation with fixes, host API ranges, the bridge and broker method tables, source/capability hashes and content-derived build IDs (ADR 0022). Pure; used by the coordinator and the CLI | `protocol` |
| `packages/extension-sdk` | `@ablationkit/extension-sdk` 1.0.0: the frame side of the bridge (`connect`, `mount`, `host.call`, `saveResult`, `runPython`) and React helpers with a small component set. Bundled into extension views; never imported by the host | React |
| `apps/server` | The Bun coordinator: runtime lock, startup recovery, the human, agent and worker listeners, the login socket, registry, audit and SSE (ADR 0009), and every service below. File map: [the coordinator](#the-coordinator-appsserver). Routes: [coordinator API](../api/coordinator-api.md) | `builtin-llm` (distribution catalog only), `inference-adapters`, `data-controls`, `extension-host`, `autonomy-policy`, `auth`, `collector`, `compute-targets`, `core`, `process-supervisor`, `protocol`, `tracking-mlflow` |
| `apps/web` | React web shell (ADR 0012): §2.2 navigation, status bar, command palette, attention inbox; runs, studies, comparison, jobs/console, experiments, artifacts; Knowledge pages and the lineage strip (ADR 0013); research text as Markdown with LaTeX, never HTML (`components/Markdown.tsx`), the Review page and the review bar on record and task pages (`pages/review.tsx`, `components/Review.tsx`), and record, study, task and run pages that lead with the description (ADR 0048); Standing and Notebooks, the vault read at three depths with reading that marks itself, in the project navigation in place of Review and Knowledge, which stay routable (`pages/vault.tsx`, `pages/standing.tsx`, `pages/notebooks.tsx`, `components/Note.tsx`, `lib/vault.ts`, `styles/vault.css`, ADR 0049), with a note's prior work and Notebooks → Library, the works by the role they played and their citations (`pages/library.tsx`, ADR 0052), and figures, notes whose own JavaScript draws them from the runs in a sandboxed frame (`components/Figure.tsx`; the frame's runtime with Observable Plot and d3, `src/figure/runtime.ts`, built to `dist/figure-runtime-<hash>.js`; ADR 0053); Data & Evals, logged models, the registry and Runs → Entrypoints (`pages/lifecycle.tsx`, ADR 0019); the Inference page with one-shot, session and compare modes and saved evidence (`pages/inference.tsx`, ADR 0020); registry-driven backend pages and bundled-backend controls (`components/BackendPage.tsx`, `pages/extensions.tsx`, ADR 0024); the Compute page with per-target compute weights and each project's agent usage (`pages/compute.tsx`, ADRs 0036 and 0037) and Project settings → Agents, the permissions and this project's agent sessions (`components/AgentPermissions.tsx`, `components/AgentSessions.tsx`, ADR 0037). One page header everywhere (the trail, eyebrow, handwritten title and lede: `Trail`, `PageHead` and `Page` in `components/ui.tsx`), the Overview as the vault in brief beside what the agents did (`pages/project.tsx`, `OverviewBrief` in `pages/standing.tsx`), Home's project cards, the global layer (Home, Compute; Settings with its Preferences, Agent sessions and System tabs, and Docs at the bottom) and the project's one More (ADR 0055). No agent orchestration since ADR 0036; Tasks as the first Knowledge tab, each a brief of its question, answer and records, where the researcher can abandon an open one (`pages/tasks.tsx`, ADRs 0039 and 0048); Settings → Agent sessions and session labels wherever an agent made something (`lib/agent-sessions.ts`, `components/AgentSessions.tsx`, ADR 0040); the witness, live run references in vault prose, the runs a note leaves out, a task's runs accounted for and a session's account wherever sessions are listed (Settings → Agent sessions, Project settings → Agents) and on its edition (`components/Witness.tsx`, `styles/witness.css`, ADR 0056); directions, the researcher's words to the agents written on a line of Standing or a note, with their threads folded under it (`components/Directions.tsx`, `lib/directions.ts`, `styles/directions.css`, ADR 0057); the researcher's agenda on Standing, edited in place, with Now, Next, Parked and Dropped from any ledger line (`components/Agenda.tsx`, `lib/agenda.ts`, `styles/agenda.css`, ADR 0058). The HTML user guide in `docs/guide/` is bundled as text and rendered directly by the reusable `src/guide/Guide.tsx` component, with a thin `/docs` and `/docs/:chapter` route adapter in `pages/docs.tsx`. It has no iframe, docs endpoint, or server dependency; the HTML and CSS can also be used independently. Built by Bun into `apps/web/dist`, served by the human listener (`apps/server/src/web.ts`); talks only to the human API | `react`, `react-dom`, `marked`, `katex`, `@observablehq/plot` and `d3` (bundled into the figure runtime) (dev: `playwright-core`, `server` and the fake MLflow for e2e) |
| `apps/desktop` | Electron shell (ADR 0025): opens the coordinator's web UI, managed (the local coordinator, started as the service or a child) or remote (HTTPS over the tailnet); sandboxed windows without Node or preload; the local connection page is the only page with a preload. Pure rules in `src/policy.ts`; Electron API typed in `src/electron.d.ts`; runs on the system Electron | `protocol` (dev: `playwright-core`) |
| `apps/cli` | `ablationkit` CLI, the researcher's and the operator's (ADR 0040): `ui`, `login`, `version`, `coordinator`, `system status`, `access tailscale\|status\|off`, `project`, `target`, `remote`, `tracking`, `backup` (`create\|list\|verify\|export\|restore`), `extension templates\|scaffold\|validate --path\|doctor\|publish`, `dev doctor\|build`; and `mcp` (`commands/mcp.ts`), the agents' MCP server over stdio: one agent session per process, its token minted through the login socket and held in memory, eight tools over the agent API only, each dispatching to operations, one per coordinator call (ADR 0054). Guide: [CLI](../cli.md) | `server` (paths, foreground run), `core`, `builtin-llm` (the manifest its LLM operations come from) |
| `python/ablationkit-protocol` | Generated Pydantic models for the same schemas | `pydantic` |
| `python/ablationkit-sdk` | Project-facing SDK: run context, metrics/params/tags, artifact staging, logging handler, dataset inputs (`log_input`) and MLflow model directories (`log_model`). Stdlib only; put on jobs' `PYTHONPATH` by the coordinator | — |
| `python/ablationkit-pytorch` | Duck-typed helpers for custom PyTorch loops: model/optimizer params, step/epoch logging, checkpoints | `ablationkit-sdk` (torch from the project) |
| `packages/builtin-llm/src/python/sdk` | Bundled project's provider-neutral LLM helpers: MLflow-format traces, OpenAI-compatible calls with reported usage, golden sets and pinned prompts. Stdlib only; contributed to job `PYTHONPATH` by the bundled backend. `src/python/genai.py` is its GenAI evaluation worker (ADR 0021) | `ablationkit-sdk` |
| `python/ablationkit-extension` | Python extension SDK and runner: `ExtensionContext` (broker calls, staged inputs, artifacts, progress), `ExtensionResult`, and `runner.py`, which the coordinator starts in an extension build's venv under a systemd scope (ADR 0022). Stdlib only | — |
| `python/ablationkit-worker` | The remote worker, shipped inside every run bundle: verifies the bundle, runs the job under a shim in its own session (systemd scope when available), tails output and SDK events into a bounded spool, delivers at least once, uploads artifacts resumably, heartbeats through the handshake, refreshes its upload token, ntfy notifications; never reruns a job (ADR 0023). Stdlib only | — |
| `fixtures/projects/` | Standalone fixture repos used by job tests, not workspace members: `uninstrumented-script` and `torch-custom-loop` (each with its own `uv.lock`); `custom-arch-research` (stdlib-only tokenizer, model and loop, plus a project extension and Agent Skill; criteria 1a, 1b); `sklearn-lifecycle` (an `MLproject`, scikit-learn models saved as MLflow models, a text classifier; criteria 5–9c); `vision-digits` (an 8×8 digit classifier with an image adapter and sample PNGs; 10d); `llm-rag-agent` (a RAG + tool app instrumented with `ablationkit_llm`, a deterministic OpenAI-compatible server, a golden set; 10–10c, 10e) | — |
| `fixtures/extensions/` | Level 1 extensions for the extension tests: `run-inspector`, `py-evaluator`, `iris-demo`, `np-stats` | — |
| `packages/extension-host/templates/` | The nine extension templates `extension scaffold` copies; own `tsconfig.json`, typechecked in CI | `extension-sdk` |
| `skills/` | Portable Agent Skills for Claude Code and Codex: `ablationkit-mcp` (how to use the MCP tools at all), `onboard-project`, `research-task`, `author-extension`, and the six LLM skills (`inspect-traces`, `compare-prompts`, `build-eval-set`, `run-llm-evaluation`, `debug-rag`, `summarize-failures`), symlinks into `packages/builtin-llm/src/skills/`. Install by symlinking into `~/.claude/skills` or `~/.codex/skills`; they use the `ablationkit_*` MCP tools, and `apps/cli/test/skills.test.ts` keeps them in step with `ablationkit mcp` ([skills README](../../skills/README.md)) | `ablationkit mcp` |
| `scripts/packaging/` | `install.sh` (per-user install of a staged release) and `aur/PKGBUILD` (+ `.SRCINFO`, regenerate with `makepkg --printsrcinfo`) (ADR 0028) | `scripts/package.ts` |
| `scripts/` | `ci.ts` (the CI step list), `setup.sh` (dev install), `package.ts` (stages a release), `acceptance.ts` and `acceptance-criteria.ts` (the §15 registry and sweep), `mlflow-matrix.ts` (the MLflow matrix doc), `security-threats.ts` and `security-map.ts` (the threat map); tests in `scripts/test/` | — |

## The coordinator (`apps/server`)

Routes are in `src/listeners/*.ts` (one table per listener and area) and documented in the [coordinator API](../api/coordinator-api.md); services are wired in `src/services.ts` and started by `src/coordinator.ts`. The entry point `src/main.ts` and the package export `src/index.ts` stay at the top of `src/`; the services sit in one folder per domain: `agents/`, `compute/`, `extensions/`, `models/`, `research/`, `state/`, `tracking/` and `vault/`.

| Area | Modules (under `src/`) | Routes | ADR |
| --- | --- | --- | --- |
| Runtime | `coordinator.ts` (lock, recovery, listeners), `services.ts`, `config.ts`, `router.ts`, `http.ts`, `events.ts` (SSE); `state/registry.ts` (projects), `state/lock.ts`, `state/audit.ts`, `state/project-removal.ts` | `listeners/human.ts`, `agent.ts`, `worker.ts`, `login-socket.ts` | 0009, 0034 |
| Agent sessions | `agents/sessions.ts` (tokens minted through the login socket for `ablationkit mcp`, the idle sweep, the Settings list), `agents/guard.ts` (the agent guard in registered checkouts) | `listeners/login-socket.ts`, `listeners/human.ts` | 0040, 0041 |
| The witness | `vault/witness.ts` (the runs the coordinator recorded for each job's attempts and each task, how each is accounted for by the vault and its set-aside marks, and an agent session's account: its record beside what it wrote) | `listeners/vault.ts` (`/vault/runs`), `listeners/human.ts` (`/agent-sessions/:id/account`), `listeners/agent.ts` (`/session/account`), `listeners/tracking.ts` (`set_aside`) | 0056 |
| Tracking | `tracking/doctor.ts`; the tracking service is `packages/tracking-mlflow` | `listeners/tracking.ts` | 0010 |
| Historical runs | `research/run-import.ts` (runs from before the project used AblationKit, imported from checkout files as labelled `import` runs) | `listeners/run-import.ts` | 0043 |
| Jobs | `compute/jobs.ts` (job runner, worker ingest) | `listeners/jobs.ts` (agent job routes), `listeners/tracking.ts` (agent run reads) | 0011 |
| Web shell | `web.ts` (serves `apps/web/dist`), `research/studies.ts` | `listeners/shell.ts` | 0012 |
| Research records | `research/records.ts`, `research/export.ts` (the checkout export), `research/lineage.ts`, `research/reports.ts` | `listeners/research.ts` | 0013 |
| Review | `research/reviews.ts` (the researcher's review marks and the reading list) | `listeners/research.ts` | 0048 |
| Directions | `vault/directions.ts` (the researcher's directions to the agents: targets, threads, deliveries per agent session, the `direction_unanswered` check and what a task owes before it completes) | `listeners/directions.ts`, `listeners/agent.ts` (`x-ablationkit-directions` on every agent response) | 0057 |
| The vault | `vault/vault.ts` (notes, the index, read marks, the view a reader gets, checks against the project's runs, studies and tasks; the library of prior work and its citations; how each figure fared when drawn), `vault/figures.ts` (a figure's sandboxed frame document and its read-only run bridge) | `listeners/vault.ts`, `listeners/human.ts` (`/vault-frame/…`) | 0049, 0052, 0053 |
| The agenda | `vault/agenda.ts` (the researcher's plan agents work from: items in lanes, rules, the last revisions, which revision each agent session last read, the checks on agents' work against it; the agent listener's `x-ablationkit-agenda-revision` header) | `listeners/agenda.ts`, `listeners/agent.ts` (`withAgenda`) | 0058 |
| Policy and compute | `agents/policy.ts` (revisions), `agents/compute-limit.ts` (weights, usage, admission, notices) | `listeners/deployments.ts`, `listeners/compute.ts` | 0037 |
| Tasks | `research/tasks.ts` (records agents create; jobs and records link them; the checks where a task's records lag its runs) | `listeners/tasks.ts` | 0039, 0048 |
| Deployments | `compute/deployments.ts` (gates), `compute/remote-endpoints.ts` (Runpod research endpoints) | `listeners/deployments.ts` | 0018, 0023 |
| Model lifecycle | `models/models.ts` (datasets, logged models, the registry), `tracking/bridge.ts` (the operations bridge), `models/evaluations.ts`, `tracking/mlprojects.ts` | `listeners/lifecycle.ts` | 0019 |
| Inference | `models/inference.ts` (one-shot, comparisons, evidence, the preview launcher), `models/inference-sessions.ts` | `listeners/inference.ts` | 0020 |
| LLM research | implemented in `packages/builtin-llm/src/` | `listeners/backends.ts` (the backend's manifest routes) | 0021, 0024 |
| Extensions | `extensions/host.ts` (builds, approvals, mounts, frames, the bridge), `extensions/runner.ts` (the Python runner), `extensions/build-policy.ts`, `extensions/bundled.ts` | `listeners/extensions.ts` | 0022 |
| Extension backends | `extensions/backends.ts` (lifecycle), with `extensions/backend-broker.ts`, `-process.ts`, `-child.ts`, `-codec.ts`, `-state.ts`, `-page.ts` and the `extensions/policy.ts`, `data.ts`, `tracking.ts`, `capture.ts`, `retention.ts` modules | `listeners/backends.ts` | 0024 |
| Remote compute | `compute/targets.ts`, `compute/remote.ts` (staging, handshake, uploads, provider polling, drains, import), `models/export.ts` (models to workers) | `listeners/remote.ts`, `listeners/worker.ts` | 0023 |
| Operations | `state/backup.ts`, `state/restore.ts` (offline restore, `coordinator move`, restore at the next start), `state/diagnostics.ts`, `notifications.ts` (libnotify and `notification.raised`), `builds.ts` (Level 2 build status and activation) | `listeners/human.ts` (system, builds), `listeners/tracking.ts` (backups) | 0025, 0022 |

## Request paths

```text
browser ── login link ──▶ human :7420 ──┐
CLI ── login socket ─▶ code ─▶ human ───┤          ┌─ registry.json
remote (Tailscale https) ─▶ human ──────┼─ coordinator ─┼─ auth/*.json
agent (ablationkit mcp) ── aka_ token ─▶ agent :7421 ──┤          ├─ audit/ (every auth event, denial, mutation)
worker ── akw_ token ─▶ worker :7422 ───┘          └─ events/ ─▶ SSE fan-out to the UI
```

Privileged human routes need the researcher's session (ADR 0037: no passkeys or step-up). The agent and worker tables don't contain them at all.

## Tracking path

```text
human API ─┬─ reads ───────────────────────────▶ MlflowClient ─▶ MLflow 127.0.0.1:7423
           └─ writes ─▶ TrackingService ─▶ outbox (JSONL) ─▶ flusher ─┘   (sqlite + artifacts
Stage 5 ingest ─▶ TrackingService.startRun/logBatch/endRun ──┘              under <home>/mlflow)
mapping: state/<project>/tracking/  ·  events: tracking.run.sync  ·  sidecar: supervised, upgrade-guarded
```

## Job path

```text
launch ─────▶ human API ─▶ JobService ─┬─ startRun (outbox)        state/<project>/jobs/<job>/attempts/<a>/
                                       ├─ worker token ─▶ spool/<a>/token
                                       └─ systemd-run ─▶ collector (ak-col-<a>.service, outlives the coordinator)
collector ─▶ systemd-run --scope (ak-job-<a>.scope, MemoryMax/CPUQuota/RuntimeMaxSec/TasksMax) ─▶ job
   job stdout/stderr ─┐   SDK ─▶ spool/<a>/sdk-events.jsonl ─┐   metrics file ─┐
                      └────────────▶ spool journal (bounded, fsynced) ◀────────┘
spool ─▶ POST events:batch (akw_) ─▶ ingest: dedupe per producer ─┬─ console journal (no MLflow)
                                                                  ├─ TrackingService.logBatch ─▶ outbox ─▶ MLflow
                                                                  └─ attempt lifecycle ─▶ endRun, job.attempt.state
staged artifacts ─▶ PUT artifacts (sha256) ─▶ MLflow artifact proxy
watchdog: dead collector ─▶ drain-only collector ─▶ `unknown` if no exit was recorded (never rerun)
```

## Web path

```text
browser ─▶ GET /p/<id>/runs ─▶ human listener: not an API route ─▶ apps/web/dist/index.html (CSP: self only)
   app ─▶ GET /api/v1/auth/session (ak_session cookie) ─▶ 401 ─▶ "run ablationkit ui"
   app ─▶ human API (same-origin fetch, Origin header on writes) ─▶ tracking / jobs / shell routes
   app ─▶ EventSource /api/v1/events/stream?after=latest ─▶ live reloads (job.attempt.state, tracking.run.sync)
charts ─▶ /tracking/runs/:id/metrics/series ─▶ full history from MLflow ─▶ LTTB ─▶ ≤N points
studies ─▶ /projects/:id/studies[/:study] ─▶ search runs by ablationkit.study_id ─▶ per-variant stats
console ─▶ /jobs/:id/attempts/:a/console?after= (poll until done; no MLflow involved)
```

## Research path

```text
UI (session) ─▶ human API ─┐
ablationkit mcp (session token) ─▶ agent API (token's project) ─┤
                                                             ▼
                         ResearchService ─▶ state/<project>/research/records/<id>.json  (canonical)
                                │  audit (actor, task) · events research.*
                                └─▶ debounced export ─▶ <main checkout>/.ablationkit/research|conversations/
                                        hand edits ─▶ state/<project>/research/drift/ + inbox export_drift
registration ─▶ one-time import of an existing export (never from a linked worktree)
lineage ─▶ research links + job records + attempt→run mapping (no MLflow call)
reports/generate ─▶ MLflow runs of the study + attempt snapshots ─▶ evidence items + summary
```

## Agent job path (ADR 0037)

```text
agent (its harness's session and sandbox) ── ablationkit_job submit (ablationkit mcp) ──► agent API (session token: project)
agent API ── decide(policy rev N, jobs.run_local | jobs.submit_remote + allowed_targets) ──► deny (403 policy_denied, audited)
          └► allow ── time limit? (400 time_limit_required) ── used + reserved + limit × weight ≤ compute.limit_hours?
                        ├► no  ──► 403 compute_limit_reached (audited, notification.raised once per burst, inbox)
                        └► yes ──► JobService (submitted_by: agent, compute_weight_hundredths recorded)
Git, worktrees and the agent's sandbox are the harness's: AblationKit runs only read-only Git (core/git.ts).
```

## Model lifecycle path

```text
job (SDK) ── log_input ──► dataset.input ──► outbox log_inputs ──► MLflow runs/log-inputs
          ── save_model + log_model ──► files staged as run artifacts (models/<key>/) + model.logged
                                       ──► outbox log_model: wait for files ─► logged-models create (by key)
                                           ─► copy to the model's location ─► finalize READY ─► runs/outputs
                                           ─► ModelLink (state/<p>/models/) + event model.logged
registry (human) ──► registered-models / model-versions (source models:/<id> + model_id) / aliases
                     ─► RegistryVersionLink; alias → version → model_id is resolved and pinned by consumers
evaluation (human) ──► EvaluationRecord (pinned model, dataset SHA-256) ─► MLflow run(s) created by the coordinator
                     ─► OperationsBridge: systemd scope (or advisory direct mode), minimal env
                        python -I packages/tracking-mlflow/env/bridge/ablationkit_bridge.py request.json result.json
                        mlflow.models.evaluate + validate_evaluation_results ─► metrics/plots in MLflow
MLproject ──► mlprojects.ts renders the entrypoint (mlflow run --env-manager local rules) ──► job runner
              ─► one attempt, one MLflow run tagged mlflow.project.entryPoint
lineage ──► run ↔ logged model ↔ evaluation / registry version, from the links (no MLflow call)
```
