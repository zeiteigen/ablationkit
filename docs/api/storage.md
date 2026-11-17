# Storage layouts

Coordinator-owned state is files: JSON snapshots, JSONL journals, Markdown and ordinary files (spec §5.1, criterion 3). The library is `packages/core`. The reasons and edge cases are in ADR 0007.

| File | Meaning |
| --- | --- |
| `<name>.json` | Current snapshot, replaced atomically, always pretty JSON with a trailing newline, mode 0600 |
| `<name>.json.bak` | Previous snapshot, used by recovery |
| `<name>.json.v<N>.bak` | Permanent copy taken before migrating from version N |
| `.<name>.tmp-<pid>-<hex>` | An uncommitted write; startup recovery deletes it |
| `<name>-NNNN.jsonl` | Journal segment; one JSON object per line, each with a strictly increasing `seq` |
| `*.quarantine-<UTC ts>` | Bytes removed by recovery, kept for inspection; never read back |

Rules:

- Every record has an integer `schema_version`. Readers migrate older records with `SchemaMigrator` and refuse newer ones.
- One process writes a given runtime directory. Everyone else goes through the coordinator API.
- A journal line counts as written once its newline is on disk. After a crash, part of an unacknowledged batch may survive, so consumers dedupe by event id.
- Startup calls `diagnoseStorage(root)`, which only reads, and then `recoverJsonFile` / `JsonlLog.open`, which repair.

## Coordinator runtime home

`ABLATIONKIT_HOME`, or `~/.ablationkit` (0700). Written only by the coordinator (ADR 0009), except `cli-session.json`, which the CLI owns, and `spool/`, which collectors own. Startup recovery skips `spool/`, and backups do not include `spool/`, `bundles/`, `builds/`, `operations/` or extension venvs (ADR 0025).

| Path | Schema | Meaning |
| --- | --- | --- |
| `settings.json` | `CoordinatorSettings` | optional listener binds and trusted origins |
| `registry.json` | `ProjectRegistry` | project IDs mapped to local paths, with earlier paths |
| `coordinator.lock` | — | `{pid, started_at}` of the single writer |
| `run/login.sock` | — | login socket, 0600 |
| `auth/tokens.json` | `TokenStore` | hashed session, agent and worker tokens; an agent session token carries its `agent_session` (harness, label, directory, last use; ADR 0040) |
| `compute-weights.json` | `ComputeWeights` | machine-wide compute weights for the agent compute limit: `local` and each target ID in hundredths (100 is a weight of 1; a target without an entry has weight 1), set by the researcher; backed up and restored (ADR 0037) |
| `audit/audit-NNNN.jsonl` | `AuditRecord` | append-only audit journal |
| `events/events-NNNN.jsonl` | `JournalEvent` | coordinator events; the SSE replay source |
| `state/<project-id>/` | — | per-project runtime state |
| `state/<project-id>/tracking/experiments.json` | `TrackingProjectLinks` | the project's `ak/<project-id>` experiment ID and read-only imports |
| `state/<project-id>/tracking/runs/<ref>.json` | `TrackingRunMapping` | one attempt (or manual run) mapped to its MLflow run, with sync state |
| `state/<project-id>/jobs/<job-id>/job.json` | `JobRecord` | one job: command, environment, limits, attempt IDs, latest state; an agent's job also records the compute weight in effect when it was submitted (`compute_weight_hundredths`) (ADR 0011) |
| `state/<project-id>/jobs/<job-id>/attempts/<attempt-id>/attempt.json` | `AttemptRecord` | compute status, supervisor and enforcement level, collector health, provenance snapshot, uploaded artifacts |
| `…/attempts/<attempt-id>/ingest.json` | `IngestState` | per-producer high-water marks (dedupe) and ingest counters |
| `…/attempts/<attempt-id>/console/console-NNNN.jsonl` | `ConsoleRecord` | console output (stdout, stderr, log records, system notes); independent of MLflow |
| `state/<project-id>/research/records/<record-id>.json` | `ResearchRecord` | canonical hypotheses, approaches, notes, reports, decisions, conversation links and study records (ADR 0013) |
| `state/<project-id>/research/export.json` | `ResearchExportState` | one-time import marker, hashes of the files the last export wrote, detected hand edits |
| `state/<project-id>/research/drift/<ts>/<path>` | — | a hand-edited export file, kept before it was rewritten |
| `state/<project-id>/research/reviews.json` | `ReviewState` | what the researcher has read (ADR 0048): per record or task (`kind:id`), when, a hash of what they read and their note. Not exported to the checkout |
| `state/<project-id>/vault/notes/<note-id>.json` | `VaultNote` | one atomic note of the project's vault (ADR 0049): type, title, the three depths (gist, summary, full text with `![[embeds]]` and `[[links]]`), standing, evidence by run name, sources. Archived notes stay as files |
| `state/<project-id>/vault/index.json` | `VaultIndex` | the shelf (top-level notebooks in reading order) and the ledger's bottom line and order of claims |
| `state/<project-id>/vault/works/<work-id>.json` | `VaultWork` | one work of the project's library of prior work (ADR 0052): a paper, preprint, repository, doc or thread consulted for the project, used or set aside, with where to find it, how closely it was read, what it says and what was taken from it. Notes cite it (`cites`) with a role. Archived works stay as files |
| `state/<project-id>/vault/reads.json` | `VaultReadState` | what the researcher has read: per note, when and a hash of what a reader reads. Not exported; an unreadable file starts over |
| `state/<project-id>/vault/figures.json` | `{schema_version, project_id, figures: {note_id: {revision, at, error?}}}` | how each figure fared when the researcher's page last drew it (ADR 0053): an error on the current revision is the `figure_error` check. Not exported; an unreadable file starts over |
| `state/<project-id>/policy/rev-NNNNNN.json` | `ProjectActionPolicy` | immutable policy revisions, schema version 2: `jobs`, `deployments`, `compute.limit_hours` (0400, exclusive create; version 1 files stay as written and are read migrated, `ask` becoming `deny`, ADR 0037); no file means revision 0, the built-in default ([project permissions](../autonomy/project-permissions.md)) |
| `state/<project-id>/compute/limit.json` | `ComputeLimitState` | what the researcher was told about the project's agent compute limit: the current burst of refused agent submissions and when hours used went over the limit, so each notifies once (ADR 0037) |
| `state/<project-id>/tasks/<task-id>.json` | `ResearchTask` | a research task an agent created: title, goal, criteria, status, and the outcome and report or the reason it was closed (ADR 0039). Version 1 tasks (dispatch, T3 bindings, plans) load upgraded; their old `.activity.json`, `.conversation.json` and `task-attachments/` files are no longer read |
| `state/<project-id>/directions/<direction-id>.json` | `ResearchDirection` | one of the researcher's directions to the agents (ADR 0057): its target, kind and text, its status and round, the thread of acknowledgements, answers (with refs) and the researcher's closes, reopens and withdrawals, and which agent session was shown it in which round. Written by the researcher's session; agents respond. Not exported to the checkout |
| `state/<project-id>/tasks/<task-id>.activity.json` | — | Stage 9's activity list; read once into `.conversation.json`, no longer written |
| `state/<project-id>/deployments/<deployment-id>.json` | `DeploymentRecord` | a deployment request and its lifecycle (pinned model, target, exposure, TTL; `provider` for an independently supervised research endpoint) |
| `state/<project-id>/deployments/endpoints/<deployment-id>/` | `model.tgz`, `fetch.json` | a research endpoint's exported model package and `{token_sha256, sha256, bytes, expires_at}` for the pod's download (Stage 16). Removed when the deployment stops |
| `state/<project-id>/models/<model-id>.json` | `ModelLink` | provenance join for a logged model: source run, ref, attempt, job, SDK key, `sdk` or `discovered` (ADR 0019). MLflow holds the model |
| `state/<project-id>/registry/<name>@<version>.json` | `RegistryVersionLink` | provenance join for a registry version created through AblationKit (name URL-encoded). MLflow holds the version, aliases, tags and descriptions |
| `state/<project-id>/evaluations/<evaluation-id>.inputs/model/` | files | a remote evaluation's exported model, copied into each attempt's bundle at `inputs/model` (Stage 16) |
| `state/<project-id>/llm/evaluations/<evaluation-id>.inputs/genai/request.json` | JSON (0600) | a remote GenAI evaluation's request (examples, prompts, keyless provider endpoints, scorers), copied into the bundle at `inputs/genai`; its SHA-256 is `remote.request_sha256` |
| `state/<project-id>/evaluations/<evaluation-id>.json` | `EvaluationRecord` | a classical evaluation: pinned model/baseline, dataset path + SHA-256, thresholds, limits, state, MLflow run IDs, threshold outcomes. Metrics, plots and tables are in MLflow |
| `state/<project-id>/inference/sessions/<session-id>.json` | `InferenceSessionRecord` | an inference session's lifecycle: pinned model, limits, state transitions, timings, counters, memory. No inputs or outputs. A restart marks open ones `stopped` |
| `state/<project-id>/llm/settings.json` | `LlmSettings` | LLM data controls: OpenAI-compatible providers (locality, egress approval, rates, the *name* of the key variable), capture mode, redactions, retention, remote capture. Absent: the default (`redacted`, 30 days, no providers) |
| `state/<project-id>/llm/golden-sets/<gs>.json` | `GoldenSetRecord` | a golden set and its versions (SHA-256, counts, categories, MLflow dataset ID) |
| `state/<project-id>/llm/golden-sets/<gs>/v<N>.jsonl` | `GoldenExample` per line | one immutable version (mode 0400), checked against its SHA-256 on every read |
| `state/<project-id>/llm/evaluations/<le>.json` | `LlmEvaluationRecord` | a GenAI evaluation: pinned golden set, targets and scorers, declared retention, egress, state, per-target aggregates, usage, latency and cost estimates. Per-example results are each run's `ablationkit/llm/examples.json` |
| `state/<project-id>/llm/evidence/<lx>.json` | `LlmEvidenceRecord` | saved playground comparison; the inputs and outputs are the MLflow artifact `ablationkit/llm/playground.json`. `deleted_at` once deleted |
| `state/<project-id>/inference/evidence/<evidence-id>.json` | `InferenceEvidenceRecord` | provenance of a saved prediction or comparison (models, versions, source runs and commits, dataset slice and SHA-256, input hash, environment); the inputs and outputs are the MLflow artifact `ablationkit/inference/evidence.json` of its run. `deleted_at` once deleted |
| `state/<project-id>/extensions/<ext>/state.json` | `ExtensionState` | one extension in one project: enabled, active build, every approval (hashes, capabilities, `trusted_code`), disable reason |
| `state/<project-id>/extensions/<ext>/builds/<eb>/` | `ExtensionBuildRecord` (`build.json`) | an immutable, content-addressed build: `src/` (the snapshot that runs), `ui/<contribution>.js[.css]` (bundles), `venv/` (from the lockfile, wheels only) |
| `state/<project-id>/extensions/executions/<xe>.json` | `ExtensionExecutionRecord` | one Python execution: code, lockfile and environment hashes, inputs hash and refs, limits, enforcement labels, termination, typed result, MLflow run |
| `state/<project-id>/extensions/executions/<xe>/` | — | `request.json`, `inputs/` (staged, read-only files), `outputs/` (the artifact area), `log.txt`, `tmp/` (its HOME and TMPDIR). A remote execution also has `remote/extension/` (`src/`, `inputs/`, `request.json`), copied into the bundle at `inputs/extension`; its `outputs/` is filled from the job's run when it reconciles |
| `state/<project-id>/extensions/snapshots/<xs>.json[.png]` | — | a report block's static snapshot (title, text, table, PNG), kept with the report |
| `builds/<build-id>/` | `SourceBuildRecord` (`build.json`) | a Level 2 build from `ablationkit dev build`: `source/` (the exported commit, with its dependencies and web bundle) |
| `builds/active.json` | — | `{build_id, activated_at, activated_by}`: the build `coordinator start` runs (activated by the researcher in System) |
| `extensions/<ext>/<version>/` | — | the user-level registry: published extension source, installable into other projects |
| `operations/<evaluation-id>/` | — | an operations-bridge run: `request.json`, `result.json`, `bridge.log` (the worker's output). Excluded from startup recovery |
| `operations/inf-<id>/` | — | a one-shot prediction's worker directory (it holds the inputs); deleted as soon as the worker exits |
| `operations/<session-id>/` | — | a session worker: `request.json` (model URI and adapter only; inputs go over stdin) and `bridge.log` |
| `state/<project-id>/task-attachments/<task-id>/` | — | private source content (`S<n>.txt`, 0600) and every package sent (`package-<sha256>.txt`), so a resend after a crash sends the same bytes |
| `spool/<attempt-id>/` | `CollectorManifest` (`manifest.json`) | a collector's spool, written by the collector (and the SDK's event file), not the coordinator; removed after full delivery. Layout in `packages/collector/src/layout.ts` |
| `targets/<target-id>.json` | `ComputeTarget` | a remote compute target (ADR 0023); credentials are referenced by environment-variable name, never stored |
| `bundles/<attempt-id>/` | `RunBundleManifest` (`bundle/bundle.json`) | a remote attempt's staged bundle: `bundle/source/` (`git archive` of the pinned commit), `bundle/worker/`, `bundle/sdk/`; `bundle.tgz` is deleted once staged (a Runpod pod downloads it: kept until the worker's first contact or the attempt is terminal); `notebook.ipynb` for a Colab export |
| `colab/sessions.json` | — | the Colab CLI's session state (`colab --config`) for the runtimes the coordinator allocates for `colab.mode: cli` targets (ADR 0059): one `ak-<attempt-id>` session per attempt, removed when the runtime is released; written by the Colab CLI (0600). The CLI's sign-in token stays in the OS keyring, never here |
| `state/<project-id>/jobs/<job-id>/attempts/<attempt-id>/uploads/` | `ResumableUpload` (`u-….json`) | a remote worker's chunked artifact uploads in progress (`u-….part`); removed when complete. `store-s<nn>.part`: an object being pulled from the artifact store (removed after the receipt) |
| `containers/projects/<project-id>/config.json` | `ContainerConfig` | a project's agent container configuration (ADR 0061), the researcher's only; each change a new revision |
| `containers/projects/<project-id>/environment.json` | `ContainerEnvironment` | which copy of the project's environment its contained jobs run in, the SHA-256 of the `uv.lock` it was built from and the environment build that made it (ADR 0066) |
| `containers/projects/<project-id>/envs/<attempt-id>/` | — | copies of the project's uv environment, each written by one environment build; mounted read-only into job containers. Copies that are neither current nor used by a live attempt are pruned. `env/` beside it is an environment from before ADR 0066, adopted as `legacy` and never pruned automatically |
| `containers/projects/<project-id>/uv-cache/`, `python/`, `home-<harness>/` | — | uv's cache and Python installs (environment builds write them; jobs read `python/`), and the agent's home per harness, kept between sessions |
| `containers/sessions/<session-id>/` | `ContainerSessionRecord` (`session.json`), `EgressRecord` (`egress.jsonl`) | an agent container session: its record, its connections, `launch.sh` and Podman's errors. A job attempt's connections are in `containers/attempts/<attempt-id>/egress.jsonl` |
| `tracking/outbox/outbox-NNNN.jsonl` | `TrackingOutboxRecord` | the bounded durable outbox; resolved segments are deleted |
| `mlflow/mlflow.db` | — | MLflow's SQLite store (MLflow data only; never read by AblationKit except to snapshot it) |
| `mlflow/artifacts/` | — | MLflow's artifact store |
| `mlflow/sidecar.json` | `MlflowSidecarState` | MLflow version that last opened the data, and upgrade history |
| `mlflow/sidecar.pid` | — | the running sidecar's process group, to clean up after a crash |
| `mlflow/venv/`, `mlflow/logs/sidecar.log` | — | the uv environment synced from `packages/tracking-mlflow/env/uv.lock`, and the server log |
| `backups/<YYYYMMDDTHHMMSSZ>[-pre-upgrade\|-move]/` | `BackupManifest` (`manifest.json`) | coordinated snapshot (ADR 0010, ADR 0025): `mlflow/` (`mlflow.db` from `VACUUM INTO`, `artifacts/`, `sidecar.json`), `coordinator/` (`settings.json`, `registry.json`, `compute-weights.json`, `auth/`, `state/` without extension venvs, `tracking/outbox/`, `audit/`, `events/`, `targets/`), `projects/<id>/` (`research/`, `.ablationkit/` without `agent-sessions/`). Every file's SHA-256 is in the manifest; `excluded` says what is left out and why. `*.partial/` is an unfinished one |
| `backups/.exports/<id>.tar.gz` | — | the archive made for the last `GET /api/v1/backups/:id/archive` (one is kept) |
| `restored.json` | `RestoreRecord` | what `backup restore` did here: backup, source machine, projects and their checkouts, revoked sessions, settings changes, extension environments to rebuild, warnings |
| `restore-pending.json` | `PendingRestore` | a restore scheduled from the System page (the researcher's session); the next start applies it and moves the current contents to `<home>.pre-restore-<ts>/` |
| `moved.json` | `CoordinatorMovedMarker` | `coordinator move` handed this home to another machine: the coordinator refuses to start here |
| `cli-session.json` | — | the CLI's saved bearer sessions per coordinator URL, 0600 |

## Project checkout export (`<checkout>/.ablationkit/`)

Written by the coordinator to the registered main checkout only, for the researcher to commit (ADR 0013). Files are 0644, written atomically, and never read back except by the one-time import at registration. `project.json` and extension source stay repository-owned.

| Path | Content |
| --- | --- |
| `project.json` | `ProjectManifest` (repository-owned) |
| `research/hypotheses.json`, `approaches.json`, `decisions.json`, `studies.json` | `{schema_version, kind, exported_by, notice, records: [ResearchRecord]}` |
| `research/notes/<date>-<slug>.md`, `research/reports/<date>-<slug>.md` | line 1: `<!-- ablationkit:record {…record JSON without body…} -->`; readable rendering (reports: evidence summary, evidence table, follow-up); then `<!-- ablationkit:body -->` and the body verbatim |
| `conversations/references.json` | conversation links; personal notes only when `export_notes` is set |
| `llm/golden-sets/index.json`, `llm/golden-sets/<name>/v<N>.jsonl` | golden-set versions for project jobs (`ablationkit_llm.golden_set`), with the canonical and export SHA-256. Held-out sets carry inputs only (ADR 0021) |
| `llm/prompts/<name>.json` | a prompt's versions and an alias snapshot for `ablationkit_llm.load_prompt` |
| `extensions/<id>/` | Level 1 extension source (repository-owned, never written by the coordinator except `extension install`): `manifest.json` (`ExtensionManifest`), UI entries, the Python project and its `uv.lock` (ADR 0022) |

Secret-looking strings are withheld from these files. A file that differs from what the last export wrote is copied to `state/<project-id>/research/drift/` and rewritten.

**The agent guard** (ADR 0041; opt-in since ADR 0062) writes outside `.ablationkit/`, but only when the researcher runs `ablationkit project guard` (`ablationkit project unguard` takes exactly its entries out again): it merges deny rules into `<checkout>/.claude/settings.local.json` and two marked blocks (`# >>> ablationkit-guard:default`, `# >>> ablationkit-guard:profile`) into `<checkout>/.codex/config.toml`. A file it creates is listed in `.git/info/exclude`.

## Remote worker directory (`<work_dir>/<attempt-id>/` on the target)

Written by `ablationkit-worker` (ADR 0023), never by the coordinator. `work_dir` defaults to `~/.ablationkit-worker`; on SLURM it must be shared by the login and compute nodes. On Runpod it defaults to `/workspace/.ablationkit-worker` on the pod volume (so a stopped pod keeps its spool); in a Colab notebook, `/content/ablationkit`.

| Path | Schema | Notes |
| --- | --- | --- |
| `bundle/` | `RunBundleManifest` | the unpacked bundle; every file is checked against `bundle.json` before the job starts |
| `credentials.json` | `WorkerCredentials` | launch and upload tokens, ntfy (0600); removed after a full delivery |
| `state.json` | — | `worker_id`, `phase` (`starting`, `running`, `exited`, `lost`, `synced`), the shim and worker PIDs, tail offsets: what survives a worker restart |
| `spool/journal/spool-NNNN.jsonl` | `JournalEvent` | the bounded spool, in the `@ablationkit/core` journal format; acknowledged segments are deleted |
| `spool/cursor.json` | — | `{acked_seq}`: the highest spool seq the coordinator acknowledged |
| `spool/stdout.log`, `spool/stderr.log`, `spool/sdk-events.jsonl` | — | the job's output and the SDK's event file, tailed by the worker |
| `spool/artifacts/<id>/`, `spool/uploads/<id>.json` | — | staged artifact bytes and pending uploads (with `upload_id` and `received` once started; `store_trying`/`store_slot` for one going through the artifact store, whose bytes leave the spool once stored; `store_failed` when the store refused it) |
| `spool/job.json`, `spool/exit.json` | — | written by the job shim: how the job was started (mode, enforcement) and how it ended |
| `job.sbatch`, `slurm-<id>.out` | — | SLURM only |
| `worker.out`, `tailscaled.log` | — | Runpod only: the worker's output and the tailnet daemon's log |

## Desktop app (`$XDG_CONFIG_HOME/ablationkit/`)

Written by the desktop app, never by the coordinator (ADR 0025).

| Path | Schema | Meaning |
| --- | --- | --- |
| `desktop.json` | `DesktopConfig` | which coordinator the app opens: `managed` (a runtime directory here, started as the service or a child) or `remote` (an HTTPS origin, or loopback). `ABLATIONKIT_DESKTOP_CONFIG` overrides the path |

