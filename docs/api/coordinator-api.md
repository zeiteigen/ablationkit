# Coordinator API (Stages 3–11)

The coordinator serves three HTTP listeners and a unix login socket (ADR 0008). Bodies are JSON. Errors are always `{"error": {"code", "message", ...}}` with an explicit status. Route tables live in `apps/server/src/listeners/*.ts`; a route that is not in a listener's table is a 404 on that listener.

## Login socket: `<home>/run/login.sock`

| Route | Result |
| --- | --- |
| `GET /health` | `{status, pid, started_at, urls, trusted_origins}` |
| `POST /login` `{origin?, next?}` | `{url, code, origin, human_api, expires_at}`: a one-time link, valid 2 minutes |
| `POST /agent-sessions` `{project_id, harness, label?, cwd}` | 201 `{token, token_id, project_id, agent_api, expires_at, idle_timeout_sec}`: an agent token for one agent session (ADR 0040). Only ever an agent token, for a registered project (404 `project_not_found`); `harness` is a short lowercase name, `cwd` absolute (400 otherwise). Ends after 12 hours without a request or 7 days after it began. Audited `auth.agent_session.start` |
| `POST /agent-sessions/end` with `Authorization: Bearer aka_…` | `{token_id, ended: true}`: the session ends with its own token (`ablationkit mcp` closing); 401 for a token that is not a live agent token. Audited `auth.agent_session.end` |

| `POST /executive-sessions` `{harness, label?, cwd}` | 201 `{token, token_id, human_api, expires_at}`: a human-API session for `ablationkit executive` (ADR 0064), marked `executive_session` on the token: it may make every GET of the human API and only an executive's writes (below). Lives 7 days at most. Audited `auth.executive_session.start` |
| `POST /executive-sessions/end` with `Authorization: Bearer aks_…` | `{token_id, ended: true}`: the executive session ends with its own token (the MCP server closing); 401 for a token that is not a live executive session. Audited `auth.executive_session.end` |

Any process running as the researcher can reach the socket, and `/login` yields a human session: an agent session token is identity, not a boundary (ADR 0040).

## Human API (default `127.0.0.1:7420`)

Auth is the `ak_session` cookie (browser) or `Authorization: Bearer aks_…` (CLI). Cookie writes need a trusted `Origin`. A request carrying an untrusted `Origin` is refused (403). An unknown `Host` gets 421.

**Executive sessions** (ADR 0064; minted on the login socket for `ablationkit executive`) may make every `GET` and only these writes: `agent.container.start`, `.input`, `.pause`, `.resume`, `.stop`, `.allow` (the agent container routes below), `auth.agent_session.end`, `direction.create`, `.close`, `.reopen`, `.withdraw`, and `auth.session.revoke`. Any other write (a job, a note, a research record, a run description, a policy revision, configuration, extensions, backups, projects) is 403 `executive_forbidden`, audited with the route. A direction an executive session writes records `via_executive` (the session's label), shown to agents and in the web UI.

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /api/v1/executive-sessions` | session | `{sessions: [{token_id, harness, label, cwd, started_at, expires_at?, live, ended_at?, end_reason?}]}`, live first |
| `POST /api/v1/executive-sessions/:id/end` `{reason?}` | session | `{token_id, ended}`: revokes it; 404 `executive_session_not_found`. Audited `auth.executive_session.end` |

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /api/v1/health` | none | |
| `GET /` and any other non-`/api/` path | none | the web shell (`apps/web/dist`, client-side routes; ADR 0012); without a build, a page with build instructions |
| `GET /login?code=[&next=PATH]` | none | sets the cookie, 303 to `next` when it is a web UI path on this origin (not `//…`, not `/api/…`, not `/login`), else to `/` |
| `POST /api/v1/auth/session` `{code, label?}` | none | 201 `{token, session_id, expires_at, …}` |
| `GET` / `DELETE /api/v1/auth/session` | session | read, or log out |
| `GET /api/v1/agent-sessions?project=` | session | `{sessions}`: every agent token, live first, newest first: `token_id, project_id, harness?, label?, cwd?, started_at, last_used_at?, expires_at?, idle_timeout_sec?, live, ended_at?, end_reason?` and what it recorded (`jobs`, `records`, `tasks`). Tokens minted before ADR 0040 have no harness or directory |
| `GET /api/v1/agent-sessions/:id/account` | session | The session's account (ADR 0056): `{token_id, project_id, label?, harness?, started_at, ended_at?, live, duration_sec, record: {jobs, attempts, outcomes: {state: count} (latest attempt of each job), hit_time_limit: [{job_id, run_name?}], weighted_hours, tasks: [{task_id, title, status}]}, account: {runs: {cited, set_aside, unaccounted}, unaccounted: [run], set_aside: [{run, reason}], notes_added, notes_revised, standings: [{note_id, title?, from?, to?}], edition?}, checks}`. `record` is what the coordinator recorded on its own; `account` is what the session wrote, measured against it; `checks` are as they stand now. 404 `agent_session_not_found` |
| `POST /api/v1/agent-sessions/:id/end` `{reason?}` | session | `{token_id, ended}`: revokes it at once; 404 `agent_session_not_found` for anything but an agent token. Audited `auth.agent_session.end` |
| `GET /api/v1/coordinator/status` | session | URLs, startup findings and repairs, counts |
| `GET /api/v1/audit?after=&limit=` | session | audit records |
| `GET /api/v1/events/stream?project=&after=` | session | SSE; `id` = journal seq; honours `Last-Event-ID`; `after=latest` sends only new events |
| `GET` / `POST /api/v1/projects` `{path, name?, project_id?}` | session | `path` is absolute, on the coordinator. 201 `{project, manifest_created, research_import?}`. Nothing is written into the checkout for agents: the agent guard is opt-in since ADR 0062 (`ablationkit project guard`) |
| `GET /api/v1/projects/:id` | session | |
| `GET /api/v1/projects/:id/removal` | session | `{plan: {project, blockers, moves, skipped?, destination_root, kept}}`: what removing the project would move aside, and the running work that refuses it (ADR 0034) |
| `DELETE /api/v1/projects/:id` | session | 200 `{removed: {project, moved_to, moved, skipped?}}`; 409 `project_busy` `{blockers}` while jobs, evaluations, inference sessions, extension runs or deployments are live. The code stays; `.ablationkit/` and `state/<id>/` move to `<home>/removed-projects/<id>-<time>/` |
| `POST /api/v1/projects/:id/remap` `{path}` | session | the new checkout must carry the same `project_id`. `{project, changed}` |
| `GET /api/v1/projects/:id/doctor` | session | `{status: ok\|warn\|fail, checks}` |

`format=message` delivers every journal type through standard SSE `message` events; the JSON payload
retains its original `type`. The default retains named events for existing clients. Extension UI
subscriptions use the generic stream, enforce the frame project/capability, and deduplicate
overlapping filters.

### Tracking (Stage 4, ADR 0010)

All `/api/v1/tracking/…` routes need a session; none exist on the agent or worker listeners (agents read their project's runs through the `/api/v1/projects/:id/runs` routes, ADR 0040, which the human API serves too for executive sessions, ADR 0064). MLflow itself listens only on loopback and is never proxied wholesale. A run `:id` is an MLflow run ID or an AblationKit ref (the attempt ID, or `mr-…` for manual runs).

Errors specific to tracking:

- `503 tracking_unavailable`: MLflow is down; synchronous management writes and global searches.
- `503 tracking_outbox_full`: the outbox is at its bound (backpressure).
- `409 tracking_pending`: the run has no MLflow ID yet.
- `409 read_only_import`: the experiment or run was imported read-only.
- `400 mlflow_rejected`: MLflow refused the request; the response includes `mlflow_code`.

| Route | Notes |
| --- | --- |
| `GET /api/v1/tracking/status` | `{sidecar, outbox, last_contact_at?, last_transport_error?}` |
| `GET /api/v1/tracking/doctor` | `{status: ok\|warn\|fail, checks, sidecar}`: sidecar, API, version, upgrade guard, database, artifact store, outbox, mappings, project experiments, disk |
| `GET /api/v1/tracking/outbox?state=pending\|failed&project=&limit=` | queued or rejected writes (no payloads) |
| `POST /api/v1/tracking/outbox/:id/retry` | requeue a failed op |
| `GET /api/v1/tracking/experiments?project=` | the project's `ak/` experiment plus its imports, with `links` |
| `GET /api/v1/tracking/experiments?view=active\|deleted\|all&filter=&order_by=&max_results=&page_token=` | MLflow search; each experiment is annotated `ablationkit: {role: project\|imported\|other, project_id?, read_only}` |
| `POST /api/v1/tracking/experiments` `{name, confirm: true, tags?}` | 201; `confirmation_required` without `confirm`; names under `ak/` are reserved (409) |
| `GET /api/v1/tracking/experiments/:id` | |
| `PATCH /api/v1/tracking/experiments/:id` `{name?, tags?, lifecycle?: active\|deleted}` | rename, tag, archive/restore; a project's `ak/` experiment cannot be renamed or archived |
| `GET /api/v1/tracking/runs?project=\|experiment_ids=&filter=&order_by=&view=&max_results=&page_token=` | MLflow search; each run is annotated with `ablationkit: {read_only, mapping?, sync?}`. With `project`, also `pending_runs`; if MLflow is down, `runs: []` and `mlflow_available: false` |
| `POST /api/v1/tracking/runs` `{project_id, run_name?, study_id?, variant_id?, task_id?, tags?, params?, metrics?}` | manual run via the outbox: 201 when MLflow acknowledged within 2 s, else 202 `{state: tracking_pending, ref, op_ids}` |
| `GET /api/v1/tracking/runs/:id` | `{run}`; for a pending run `{ref, state: tracking_pending, mapping, sync}` |
| `PATCH /api/v1/tracking/runs/:id` `{name?, status?, tags?, delete_tags?, lifecycle?}` | synchronous; status is refused for attempt runs; reserved tags (`ablationkit.*`, `mlflow.*`) are refused |
| `POST /api/v1/tracking/runs/:id/log` `{metrics?, params?, tags?}` | manual runs only; 200 when synced, else 202 with `state` |
| `POST /api/v1/tracking/runs/:id/end` `{status?}` | manual runs only |
| `GET /api/v1/tracking/runs/:id/metrics` | latest values, split into `metrics` and `system_metrics` (`system/…`); pending runs return `state: tracking_pending` and empty lists |
| `GET /api/v1/tracking/runs/:id/metrics?key=&max_results=&page_token=&format=csv` | one metric's history (JSON or CSV), unmodified |
| `GET /api/v1/tracking/runs/:id/metrics/series?keys=a,b&points=500&x=step\|time` | chart series for 1–20 keys, downsampled with LTTB (`points` 10–5000): `{run_id, x, series: [{key, total, downsampled, truncated?, points: [[step, timestamp, value]], non_finite?}]}`; reads at most 250 000 points per key |
| `GET /api/v1/attempts/:id/metrics` | the same projection for an attempt ID |
| `GET /api/v1/tracking/runs/:id/artifacts?path=` | list a directory |
| `GET /api/v1/tracking/runs/:id/artifacts/download?path=` | streamed attachment; sandbox CSP; `octet-stream` unless text, JSON or a raster image; unsafe paths are 400 |
| `GET /api/v1/tracking/compare?runs=a,b[,…]` | 2–20 runs: params and latest metrics side by side, with `differs` |
| `GET /api/v1/tracking/export?project=\|experiment_ids=\|runs=&filter=&format=csv\|json` | up to 10 000 runs; CSV columns are run fields, the AblationKit ID tags, `params.*` and `metrics.*` |
| `GET /api/v1/tracking/models?project=\|experiment_ids=` | logged models (read-only until Stage 12) |
| `GET /api/v1/tracking/registered-models?filter=` | registry search (read-only until Stage 12) |
| `GET /api/v1/projects/:id/tracking` | `{links, runs, pending_ops, failed_ops, sidecar}` |
| `POST /api/v1/projects/:id/tracking/imports` `{experiment_id}` | link a historical experiment read-only; 201, or 200 if already linked here; 409 for an `ak/` experiment or one linked to another project |
| `POST /api/v1/projects/:id/run-imports` | **agent**. Import a run that happened outside AblationKit from its files (ADR 0043): `{run_name, source, started_at?, ended_at?, status?: FINISHED\|FAILED\|KILLED, source_commit?, params?: {k: v}, params_files?: [path] (≤8 JSON objects, nested keys joined with `/`), metrics?: [{key, value, step?, timestamp?}], metrics_file?, metrics_format?, artifact_paths?: [glob] (≤64; ≤256 MiB a file, 1 GiB in all), description?, notes?, study_id?, variant_id?, task_id?, tags?}` (`description` and `notes` are the run's description, ADR 0048). Paths stay inside the checkout (symlinks resolved), never under `.ablationkit/`. At most 200,000 metric points. → 201 `{ref, mlflow_run_id, state, params, metrics, metric_keys, artifacts, warnings}` (202 without `mlflow_run_id` while MLflow has not created the run; its artifacts are then not uploaded and `warnings` says so). The run's mapping kind is `import`; it is tagged `ablationkit.kind=import`, `ablationkit.import.source`, `.by`, `.at` and `.source_commit` (reported, not checked); no job, no compute. 409 `already_imported` `{ref, mlflow_run_id}` for a source imported before; audited `tracking.run.import` |
| `GET /api/v1/projects/:id/run-imports` | **agent**. `{imports: [{ref, source, run_name, mlflow_run_id, sync_state, study_id, variant_id, created_at}], total}` |
| `POST /api/v1/backups` | 201 `{backup_id, path, mlflow_database, files, bytes, outbox, excluded}` |
| `GET /api/v1/backups` | completed backups (`quiesce`, `source` when recorded) and `pending_restore` (or null) |
| `POST /api/v1/backups/:id/verify` | re-hash every file: `{backup_id, ok, problems}` (Stage 17) |
| `POST /api/v1/backups/:id/restore` | Checks the backup, then writes `restore-pending.json`: the next coordinator start applies it, moving the current home aside. `{pending_restore, restart_required: true}`; 409 `backup_damaged` (ADR 0025) |
| `DELETE /api/v1/backups/restore` | cancel a scheduled restore: `{cancelled: backup_id \| null}` |
| `GET /api/v1/backups/:id/archive` | the backup as `application/gzip` (`tar.gz`, one directory named after the ID), for `backup restore` on another machine |

Privileged actions (policy revisions, widening LLM data controls, extension approval, enable and rollback, Level 2 build activation, restores, project removal) need only the researcher's human session; there are no passkeys or step-up grants (ADR 0037). They exist only on the human listener, so an agent or worker token never reaches them.

### Web shell (Stage 6, ADR 0012)

Session auth.

| Route | Notes |
| --- | --- |
| `GET /api/v1/shell/status` | status bar: `{coordinator, mlflow, sync: {pending, failed}, offline: {available, reconcile_required, disconnected, awaiting_sync, sync_failed, remote_attempts}, compute: {supervisor, enforcement, running_attempts}, build: {version, modified, restart_required?}, safe_mode, inbox: {count}}`. `build.modified` is `no` or the running modified build's ID (Stage 17). `offline` counts remote attempts (Stage 16) |
| `GET /api/v1/inbox` | `{items: [{id, kind, severity, title, detail?, project_id?, ref?, created_at?}], sources: [{kind, label, available, stage?}]}`; live: `sync_failed` (rejected MLflow writes, grouped by run), `export_drift` (hand edits to a research export, Stage 7) and the sources below (remote attempts, the compute limit); `extension_approval` is listed unavailable |
| `GET /api/v1/projects/:id/settings` | `{project, manifest_found, description?, task_profiles}` |
| `PATCH /api/v1/projects/:id/settings` `{task_profiles: [llm\|rag\|agent\|computer_vision\|tabular\|other]}` | writes the repository manifest; `[]` removes the field |
| `GET /api/v1/projects/:id/studies` | studies from `ablationkit.study_id` run tags merged with study records: `{studies: [{study_id, variants, runs, status_counts, last_start_time, record?}], scanned, truncated, tracking_error?}` (scans up to 5000 runs; recorded studies with no runs have `runs: 0`; with MLflow down, records still list and `tracking_error` says why) |
| `GET /api/v1/projects/:id/studies/:study` | `{study_id, variants: [{variant_id, runs, metrics: {key: {n, mean, std?, min, max}}, params, varying_params}], metric_keys, differing_params, truncated, record?}`; `record` is `{title, status, summary, protocol, baseline_variant, variants, metric_goals, links}`; 404 when neither runs nor a record exist |

### Research, export and lineage (Stage 7, ADR 0013)

Session auth on the human API. The routes marked **agent** also exist, at the same paths, on the agent API (bound to the token's project). Records are `ResearchRecord` (`docs/api/protocol.md`); kinds `hypothesis`, `approach`, `note`, `report`, `decision`, `conversation`, `study`.

| Route | Notes |
| --- | --- |
| `GET /api/v1/projects/:id/research?kind=&tag=&status=&q=&link=KIND:ID&source=&archived=exclude\|include\|only&sort=updated\|created\|title&order=` | **agent**. `{records, total, tags}` |
| `POST /api/v1/projects/:id/research` `{kind, id?, title, status?, summary?, body?, tags?, links?: [{kind, id, label?}], …kind fields}` | **agent**. 201 `{record}`. Per-kind fields and statuses are checked (400); links to research records, jobs and attempts must exist (422 `unknown_link`); only a study takes `id` (its `study_id` tag; 409 `record_exists`). Conversations need `source` and `url` (http/https) or `local_ref`; nothing is fetched |
| `GET /api/v1/projects/:id/research/:rid` | **agent**. `{record, backlinks: [{record_id, kind, title, status?, summary?}], names: {"kind:id": {title, status?, summary?}}, review: {state: new\|changed\|reviewed, reviewed_at?, note?}}`: `names` resolves what the record links, cites as evidence and is linked from (records, tasks, and runs and jobs by their run name, from the coordinator's own files), so a reader sees names, not IDs (ADR 0048) |
| `PATCH /api/v1/projects/:id/research/:rid` `{…fields, if_revision?, unset?: [field]}` | **agent**. 200 `{record}`; 409 `revision_conflict` `{revision}` when `if_revision` is stale |
| `POST /api/v1/projects/:id/research/:rid/archive` `{archived?: true}` | **agent**. Archive or restore |
| `DELETE /api/v1/projects/:id/research/:rid` | human only. Links to it are left dangling and shown as missing |
| `POST /api/v1/projects/:id/research/reports/generate` `{study_id, title?, metric_keys?, baseline_variant?, hypothesis_ids?}` | **agent**. 201 report with one evidence item per run (run, attempt, job, variant, source commit, values as decimal strings, artifacts, role) and a summary table; links the study and its hypotheses; no interpretation. 422 `no_evidence` without runs, 503 `tracking_unavailable` with MLflow down |
| `POST /api/v1/projects/:id/research/:rid/regenerate` | **agent**. Refresh a generated report's evidence; keeps `body` and `follow_up` |
| `GET /api/v1/projects/:id/research/export` | human only. `{checkout, state: ResearchExportState}` |
| `POST /api/v1/projects/:id/research/export` | human only. Rewrite the main checkout's export now: `{written, removed, unchanged, drift: [{path, saved_to}], redactions}` |
| `POST /api/v1/projects/:id/research/export/drift/clear` | human only. Clear the `export_drift` inbox item |
| `GET /api/v1/projects/:id/review` | **agent**. The reading list (ADR 0048): `{threads: [{task?: {kind: task, id, title, status, outcome?, goal, conclusion?, …item}, items: [{kind, id, title, status?, summary?, updated_at, by, review: new\|changed\|reviewed, reviewed_at?, note?, gaps: [summary\|body]}]}], counts: {total, reviewed, new, changed, gaps}, queue: [{kind, id}]}`. One thread per task, newest first, then the records no task links; in a thread the task's report, other reports, hypotheses, studies, decisions, approaches, notes. `queue` is what is left to read, in that order. Conversation links and archived records are left out |
| `POST /api/v1/projects/:id/review` `{kind, id, reviewed?: true, note?}` | human only. Mark a record (`kind` is its kind) or a task (`kind: task`) as read, with an optional note (≤4000), or remove the mark (`reviewed: false`) → `{state, reviewed_at?, note?}`. The mark stores a hash of what a reader sees (title, status, summary, body, next steps, protocol, variants, evidence values): a later change to those shows the item as `changed`; a new link or tag does not. A mark records reading and gates nothing. Event `review.updated` `{kind, id, reviewed}` |

### The vault (ADR 0049) and its library (ADR 0052)

Session auth on the human API. The routes marked **agent** also exist, at the same paths, on the agent API (bound to the token's project). A note is a `VaultNote`, the index a `VaultIndex`, the read marks a `VaultReadState` (`docs/api/protocol.md`). Note types: `concept`, `method`, `experiment`, `finding`, `claim`, `decision`, `question`, `log`, `figure` (ADR 0053), `notebook`. A note's writable fields: `type`, `title` (≤80), `gist` (≤180), `summary`, `full`, `standing`, `key: {text, label}`, `support`, `would_change`, `evidence: [{run, role: baseline|for|against|context, metric?, vs?, note?}]`, `figure: {script}` (figures only: the JavaScript that draws it), `study`, `aliases`, `bears_on`, `cites: [{work, role: method|solution|baseline|supports|contradicts|inspiration|tool|background, where?, note?}]` (works of the library, ADR 0052), `sources` (`kind:id` or `repo:<path>`), `task_id`, `edition`, `created`, `updated`. In `summary` and `full`, `![[id]]` alone on a line embeds a note and `[[id]]` or `[[id|words]]` links one; the tree is derived from that text. A `check` is `{code, note?, message}`: advice for whoever writes the vault, never a gate.

| Route | Notes |
| --- | --- |
| `GET /api/v1/projects/:id/vault[?brief=1]` | **agent**. `{project_id, notes, shelf: [id], editions: [id] (oldest first), ledger: {bottom_line?, order: [claim id]}, index: {revision, updated_at}, reads: {id: {state: read\|changed, read_at}}, counts: {notes, new, changed, ledger_unread, checks, works, works_cited, works_unread}, works: [VaultWork]}`: every live note with its text (archived ones left out) and every live work of the library (ADR 0052); a note absent from `reads` has not been read. `brief=1` leaves `works` out and replaces each note with `{note_id, type, title, gist, standing?, key?, edition?, task_id?, updated, revision, embeds: [id], parents: [id]}` and adds `checks` |
| `PUT /api/v1/projects/:id/vault/index` `{shelf?: [notebook id], bottom_line?, order?: [claim id], if_revision?}` | **agent**. Each field given replaces the stored one → `{index, checks}` (the vault-wide checks). 400 when the shelf names something that is not a live notebook or the order something that is not a live claim; 409 `revision_conflict` |
| `GET /api/v1/projects/:id/vault/runs` | **agent**. The file drawer (ADR 0056): `{runs}`, every run the project's jobs produced (one per attempt) and every run imported under a task: `name?, id? (MLflow run ID), ended, job_id?, attempt_id?, task_id?, study_id?, variant_id?, state?, imported?, agent? (the session that submitted it), standing: cited\|set_aside\|unaccounted, cited_by: [note id], set_aside?: {reason, at}` |
| `GET /api/v1/projects/:id/vault/check` | **agent**. `{checks, total}`: `unresolved_embed`, `unresolved_link`, `embeds_itself`, `no_summary`, `long_summary`, `long_note`, `headings`, `no_sources`, `embeds_without_prose`, `empty_notebook`, `no_standing`, `no_support`, `claim_without_evidence`, `no_study`, `unknown_study`, `no_figure`, `figure_without_runs`, `figure_error` (the figure threw when the researcher's page last drew this revision), `unknown_run`, `unknown_baseline`, `bears_on_not_a_claim`, `unknown_source`, `off_shelf`, `repeated`, `unknown_work`, `cites_unread`, `question_without_prior_work` (on a note); `work_without_locator`, `duplicate_work` (on a work: `{code, work, message}`); `shelf_unknown`, `shelf_not_a_notebook`, `ledger_unknown`, `empty_shelf`, `no_fundamentals`, `no_bottom_line`, `ledger_order`, `stale_bottom_line`, `task_without_notes`, `unreadable` (on the vault); and the witness's (ADR 0056): `unreferenced_number` (a decimal number typed by hand in a claim's, finding's or experiment's prose, or the bottom line, instead of a live reference `[[run:<run>#<metric>]]`), `unaccounted_runs` (on the vault: a task's ended runs that no note cites and that were not set aside) |
| `POST /api/v1/projects/:id/vault/reads` `{read?: [id], unread?: [id], forget?: true}` | human only. The researcher read these notes as they now stand (the mark stores a hash of what a reader reads), wants them unread, or clears every mark → `{reads: {id: {state: new\|changed\|read, read_at?}}}` |
| `POST /api/v1/projects/:id/vault/notes/:nid/figure/rpc` `{method, params}` | human only. A figure's frame reads runs through the page (ADR 0053): `method` is one of `runs.list` `{filter?, limit?}`, `runs.get` `{run_id}`, `runs.metric_history` `{run_id, key}`, `artifacts.list` `{run_id, path?}`, `artifacts.preview` `{run_id, path}`, answered as the extension bridge answers them → `{result}`. 404 when the note is not a live figure; 403 `method_not_allowed` for anything else; 503 `safe_mode`, `tracking_unavailable`. Audited when refused |
| `POST /api/v1/projects/:id/vault/notes/:nid/figure/drawn` `{revision, error?}` | human only. How the figure fared when the page drew it → `{drawn: {revision, at, error?}}`, kept in `vault/figures.json`; an error on the current revision is the `figure_error` check. Written only when it changes. 409 `revision_conflict` for another revision. Event `vault.figure.drawn` `{note_id, revision, ok}` |
| `GET /api/v1/projects/:id/vault/notes?type=&standing=&q=&task=&archived=only` | **agent**. `{notes: [brief], total}`, newest change first; with `q`, best match first (title and aliases over gist over text) |
| `POST /api/v1/projects/:id/vault/notes` `{id, type, title, gist, …fields}` | **agent**. 201 `{note, checks}` (the checks on this note). 400 with the reason: an ID that is not kebab-case, a title or gist over its limit, a standing the type does not carry or lacks, an unknown field or task, a figure without `figure` or `figure` on another type, `figure_syntax` (the script does not parse; the line is named), `embed_cycle` (the chain is named); 409 `note_exists` |
| `GET /api/v1/projects/:id/vault/notes/:nid` | **agent**. `{note, cites: [{work, role, where?, note?, cite?, title?, reading?, href?, missing?}] (each cited work named as a reader names it; `missing` when the library has no live work by that ID), embeds: [{note_id, type, title, gist, standing?}], places: [[{note_id, type, title}]] (each chain from a shelf notebook down to the note), editions, mentioned_by, in_ledger, read: {state, read_at?}, checks}` |
| `PATCH /api/v1/projects/:id/vault/notes/:nid` `{…fields, if_revision?, unset?: [field]}` | **agent**. Only the fields given change; an empty string or list clears an optional one. `updated` moves to today when what a reader reads changed → `{note, checks}`; 409 `revision_conflict` `{revision}` |
| `PUT /api/v1/projects/:id/vault/notes/:nid` `{type, title, gist, …fields}` | **agent**. Create (201) or replace the note whole (200; fields left out are cleared): what `ablationkit vault import` sends → `{note, checks, created, unchanged?}`. The same note again changes nothing, not even the revision |
| `POST /api/v1/projects/:id/vault/notes/:nid/archive` `{archived?: true}` | **agent**. Archive or restore → `{note, embedded_in: [id]}` (the notes that embedded it) |
| `DELETE /api/v1/projects/:id/vault/notes/:nid` | human only. Notes that embed or link it keep the reference, which the checks then name |
| `GET /api/v1/projects/:id/vault/works?q=&kind=&reading=&role=&standing=used\|considered\|unread&task=&note=&archived=only` | **agent**. The library (ADR 0052): `{works: [{work_id, kind, cite, title, year?, reading, takeaway, href?, standing, roles: [role], cited_by: [note id], task_id?, updated_at}], total}`, newest change first. `q` matches title, authors, venue, summary, takeaway and what it was looked up for (every word); `role` keeps works a note cites in that role; `standing`: `used` (a note cites it), `considered` (read and set aside), `unread`; 400 for a value outside its set |
| `POST /api/v1/projects/:id/vault/works` `{id, kind, title, authors?, year?, venue?, doi?, arxiv?, url?, version?, accessed?, reading, summary?, takeaway, found_for?, found_via?, task_id?}` | **agent**. 201 `{work, checks}`. `id` is the citation key (kebab-case, ≤64). A doi.org URL or `doi:` prefix and an arxiv.org URL or `arXiv:` prefix are stored as the bare identifier. 400 with the reason (an unknown field or task, a malformed locator, no `takeaway`); 409 `work_exists` `{work_id}` when the key is taken or the library holds the same work (by DOI, arXiv ID in any version, or URL) |
| `GET /api/v1/projects/:id/vault/works/:wid` | **agent**. `{work, cite, href?, standing, roles, cited_by: [{note_id, type, title, role, where?, note?}], checks}` |
| `PATCH /api/v1/projects/:id/vault/works/:wid` `{…fields, if_revision?}` | **agent**. Only the fields given change; an empty string or list clears an optional one → `{work, checks}`; 409 `revision_conflict` `{revision}` or `work_exists` |
| `PUT /api/v1/projects/:id/vault/works/:wid` `{kind, title, reading, takeaway, …fields}` | **agent**. Create (201) or replace the work whole (200): what `ablationkit vault import` sends → `{work, checks, created, unchanged?}`. The same work again changes nothing, not even the revision |
| `POST /api/v1/projects/:id/vault/works/:wid/archive` `{archived?: true}` | **agent**. Archive (a work recorded by mistake) or restore → `{work, cited_by: [note id]}` (the notes whose citation now resolves to nothing) |
| `DELETE /api/v1/projects/:id/vault/works/:wid` | human only. Notes that cite it keep the citation, which the checks then name |
| `GET /api/v1/projects/:id/vault/citations?format=bibtex\|csl-json\|markdown&notebook=&cited=1` | **agent**. The library's citations as a download (`content-disposition: attachment`, `x-ablationkit-count`): every live work, used or set aside; `cited=1` only the works a note cites; `notebook` only the works that notebook and the notes beneath it cite. The role each work played and what was taken from it are the annotation (BibTeX `annote`, CSL-JSON `note`); `markdown` is an annotated bibliography grouped by role. Default `bibtex`; 400 for another format, 404 for an unknown notebook |
| `GET /api/v1/projects/:id/agenda[?since=N]` | **agent**. The researcher's agenda (ADR 0058). Human: `{revision, updated_at, updated_by, items: [{item_id, lane: now\|next\|parked\|dropped, note_id?, text?, reason?, added_at, moved_at, note?: {title, type, gist, standing?, archived?}, work: {tasks: [{task_id, title, status, outcome?}], jobs, running, edition?: {note_id, title, edition}}}], rules: [{rule_id, text, added_at}], sessions: [{token_id, label?, harness?, started_at, last_used_at?, seen_revision?, seen_at?}] (the live agent sessions and the revision each last read), checks: [{code: off_agenda\|parked_work\|not_on_agenda, message, item?, job?, task?, session?}], last_change: [sentence]}`. Agent: `{from, revision, updated_at, now: [line], rules: [line], next, parked, dropped, changed?: {since_revision, changes: [sentence]}, your_checks?, notice?}`; reading marks the session as having read the current revision (`agenda-seen.json`, event `agenda.read`), and `since` asks for the changes since that revision instead of since the session last read. While a session has not read the current revision, every agent API response (refusals included, beside `x-ablationkit-directions`) carries `x-ablationkit-agenda-revision: N` |
| `PUT /api/v1/projects/:id/agenda` `{items?: [{item_id?, note_id?, text?, lane, reason?}], rules?: [{rule_id?, text}], if_revision?}` | human only. The researcher writes the agenda whole, items in priority order: a note (`note_id`, a live note of the vault) is `note:<id>`; a new line of text takes the next `L<n>`, a new rule the next `R<n>` → the view above with `changes` (what this revision changed) and `unchanged: true` when nothing did (the revision stays). 400 for an unknown note, item or rule, a line or rule over 300 characters, an item given twice; 409 `revision_conflict` `{revision}`. Event `agenda.updated` `{revision, changes}` |
| `PUT /api/v1/projects/:id/runs/:run/description` `{summary?, notes?, set_aside?}` | **agent**. A run's description (ADR 0048): `summary` (≤2000; what it tests and why, then what came out) and `notes` (≤8000, Markdown) are its `ablationkit.summary` and `mlflow.note.content` tags; an empty string clears one → `{run}`. `set_aside` (≤1000, ADR 0056) is why the run is not reported, kept in the vault's `set-aside.json` by MLflow run ID (an empty string takes it back; audited `vault.run.set_aside`, event `vault.run.set_aside`) → `{mlflow_run_id, set_aside}` alone, or `{run, set_aside}` with the others. 409 `tracking_pending` until MLflow has the run, 409 `read_only_import` in an imported experiment, 404 for a run outside the project. Event `tracking.run.described` `{mlflow_run_id}` |
| `GET /api/v1/projects/:id/runs?filter=&order_by=&max_results=&page_token=&view=` | **agent** (and executive reads, ADR 0064). the project's MLflow runs (its experiment and imports; `max_results` at most 200, default 50) and `pending_runs` (ADR 0040) |
| `GET /api/v1/projects/:id/runs/:run` | **agent** (and executive reads, ADR 0064). one run by MLflow run ID or ref; a run outside the project's experiments is 404 |
| `GET /api/v1/projects/:id/runs/:run/metrics?key=&max_results=&page_token=` | **agent** (and executive reads, ADR 0064). latest values (model and system), or one key's history paged; JSON only |
| `GET /api/v1/projects/:id/runs/:run/artifacts?path=&page_token=` | **agent** (and executive reads, ADR 0064). one directory level |
| `GET /api/v1/projects/:id/runs/:run/artifacts/text?path=&offset=&limit=` | **agent** (and executive reads, ADR 0064). `{run_id, path, size, offset, text, next_offset?}`: at most 256 KiB per read (default 64 KiB), ending on a UTF-8 boundary; 415 `not_text` for a file with NUL bytes |
| `GET /api/v1/projects/:id/lineage?kind=&id=` | **agent**. `{subject, steps: [{step, label, status: subject\|linked\|missing\|unavailable, reason?, items: [{ref, label, status?, exists}], more}], backlinks: [{ref, label, status?}]}`; steps hypothesis, study, variant (`study/variant`), job, attempt, run, evaluation, logged_model, model_version, inference |

`POST /api/v1/projects` also returns `research_import: {imported, problems, note}`: an existing export in the checkout is imported once.

### Project action policy (ADR 0037)

Session auth on the human API; routes marked **agent** also exist on the agent API for the token's project. Schema: `ProjectActionPolicy` (version 2; a version 1 revision on disk is read migrated: `ask` becomes `deny`, `experiments.run_local|submit_remote` become `jobs.*`, the Git, check, network, edit and test gates and protected evaluation are dropped, `compute` gets its default). The policy decides what an agent may ask AblationKit to do: `jobs.run_local`, `jobs.submit_remote` (with `allowed_targets`), `deployments.preview_local|remote_research|persistent|public` (with `exposure`, `allowed_targets`, `max_runtime_minutes`) and `compute.limit_hours`. A refusal is 403 `policy_denied` naming the field, audited. Git, workspaces and the agent's sandbox belong to the user's harness.

| Route | Notes |
| --- | --- |
| `GET /api/v1/projects/:id/access` | **agent**. A summary of the policy in force: `{project_id, policy_revision, editable_by_agents: false, note, jobs, deployments, compute: {limit_hours, …}}`; never the editable policy. It gates what agents run, not what they record |
| `GET /api/v1/projects/:id/policy` | `{policy, revisions, compute_usage: {limit_hours, used_hours, reserved_hours, available_hours}}`; revision 0 is the built-in default (local jobs and a loopback preview allowed, the rest denied, 10 compute hours) |
| `GET /api/v1/projects/:id/policy/revisions/:rev` | one immutable revision (migrated to version 2 when read) |
| `POST /api/v1/projects/:id/policy/revisions` `{policy, expect_revision?}` | session. 201 `{policy, changes: [{path, from, to, effect: widened\|reduced\|changed}]}`; 422 `invalid_policy` / `unsupported_policy` (fails closed: an allowed public endpoint, an unknown target); 409 `revision_conflict` |
| `POST /api/v1/projects/:id/policy/preview` | `{policy}` → `{valid, errors, changes, current}`; writes nothing |

### Agent compute limit (ADR 0037)

`compute.limit_hours` is in weighted hours: an hour on a target counts as its weight (machine-wide, set by the researcher in `<home>/compute-weights.json`, schema `ComputeWeights`; 1 when unset; up to two decimals, stored in hundredths). Only agent-submitted jobs count (`submitted_by.kind: agent`); every attempt counts, a researcher's retry included, as its wall time × the weight the job recorded at submission (`compute_weight_hundredths`), never reset. Remote attempts count the start and end times their worker or import reports. A live attempt reserves the rest of its time limit × the weight. An agent's submission needs `limits.runtime_max_sec` (400 `time_limit_required`) and is admitted only if used + reserved + its time limit × its target's weight fits the limit; otherwise 403 `compute_limit_reached` with `{policy_revision, limit_hours, used_hours, reserved_hours, available_hours, needed_hours, target, weight}`, audited, plus one `notification.raised` per burst of refusals and an inbox item (`compute_limit`, `ref: settings`) until an agent job is admitted or a revision changes the limit. Hours used going over the limit (a remote clock or a late import) notify once per crossing (`state/<project>/compute/limit.json`, schema `ComputeLimitState`). The limit holds as far as each attempt's time limit holds: systemd's `RuntimeMaxSec` locally and on workers with systemd; in direct mode the collector or the remote shim stops the process group, which a process that leaves the group escapes. Raise it with a policy revision.

| Route | Notes |
| --- | --- |
| `GET /api/v1/projects/:id/compute` | **agent**. `{project_id, name, policy_revision, limit_hours, used_hours, reserved_hours, available_hours, jobs, attempts, live, over_limit, refused?: {at, count, message}, targets, note}`. `targets`: the targets the project policy lets agents run jobs on (`local` when `jobs.run_local` allows, then each configured target `jobs.submit_remote` admits), each `{target_id, label, kind, weight, limits, limits_reason?}`; `limits` is `enforced` or `advisory` for `local` (the coordinator's supervisor probe, with its reason) and `reported_per_attempt` for a remote target |
| `GET /api/v1/compute` | every project's usage (`projects`), the `weights` and `note` |
| `GET /api/v1/compute/weights` | also on the agent API. `{weights: [{target_id, label, kind, weight, weight_hundredths, default}], updated_at?, updated_by?}`: `local` (this workstation) and every configured target |
| `PUT /api/v1/compute/weights` | `{weights: {local: 1, a100: 3, cpu-box: 0.5}}` (`null` resets to 1) → the weights and `changes: [{target_id, from, to}]`, audited `compute.weights.set`. 400 `invalid_weight`, 404 `target_not_found`. Jobs already submitted keep their weight |

### Research tasks (ADR 0039)

Agents create tasks to group their work and complete them (both on the Agent API only, below); the researcher reads them and may abandon one. Session auth on the human API; routes marked **agent** exist on the agent API for the token's project. Schema: `ResearchTask` (version 2): `title`, `goal`, `criteria`, `status` (`open`, `completed`, `abandoned`), and when closed `outcome`, `report_id`, `conclusion` (the answer in a few sentences, ADR 0048), `reason`, `closed_at`, `closed_by`. A job names its task with `task_id` (an open task of the same project: 404 `task_not_found`, 409 `task_closed`); a research record links it (`task:ID`, 422 `unknown_link` for a task not in the project). Events: `task.created`, `task.updated`.

| Route | Notes |
| --- | --- |
| `GET /api/v1/projects/:id/tasks?status=` | **agent**. `{tasks, total}`, newest first |
| `GET /api/v1/projects/:id/tasks/:tid` | **agent**. `{task, jobs: [{job_id, attempt_id?, state?, mlflow_run_id?, run_name?, description?, study_id?, variant_id?}], records: [{record_id, kind, title, status?, summary?, created_at, created_by}], notes: [{note_id, type, title, gist, standing?}], works: [{work_id, cite, title, reading, standing, roles}], imported_runs: [{ref, source?, mlflow_run_id?}], checks: [{code, ref, message}], review: {state, reviewed_at?, note?}}`: the jobs that name it, the records that link it (archived ones left out), the notes of the vault written under it or distilled from it (ADR 0049), the works of the library found under it (ADR 0052), and the runs imported under it (ADR 0043). `checks` (ADR 0048) names where its records lag its runs or say too little: `study_status` (a study still `planned` or `running` with runs and none active), `undeclared_variants`, `stale_report` (a generated report older than its study's runs), `hypothesis_open` (still `testing` with no job running), `no_summary`, `no_body` (a report), `no_description` (jobs), `no_notes` (runs ended and no note says what they showed), the vault's checks on the task's notes (ref `note:ID`) and works (ref `work:ID`), `direction_unanswered` (ref `direction:ID`) for a direction of the researcher's on the task or its runs that no agent has answered (ADR 0057), and the agenda's checks on the task and its jobs (`parked_work`, `not_on_agenda`; ADR 0058). Advice only: nothing is refused for them (completing the task is, while a direction on it is unanswered) |
| `POST /api/v1/projects/:id/tasks/:tid/abandon` `{reason?}` | **agent**. 409 `task_closed` |

### Directions (ADR 0057)

The researcher steers through the record: a direction is their own words, anchored where they read (`target`: `{kind: note|run|study|task, id}`, or `{kind: bottom_line}`, `{kind: project}`), with a `kind` (`ask`, `doubt`, `do`, `focus`, `park`, `rule`) and Markdown `text` (≤8000). Only the researcher's session writes, closes, reopens or withdraws one; agents read them and respond on the agent API (below). Schema: `ResearchDirection` (version 1), one file per direction under `state/<project>/directions/`: `status` (`open`, `acknowledged`, `answered`, `declined`, `closed`, `withdrawn`), `round` (one more on each reopen), `thread` (`{act: ack|answer|decline|close|reopen|withdraw, at, by, text?, refs?}`), `deliveries` (`{session, at, round}`: which agent session was shown it). A `rule` stays in force (`open` until a session acknowledges it, then `acknowledged`) until withdrawn. Events: `direction.created`, `direction.updated`.

| Route | Notes |
| --- | --- |
| `GET /api/v1/projects/:id/directions?status=&target=&waiting=agent\|researcher\|none` | **agent**. `{directions, total, sessions: {token_id: {harness?, label?, live}}, live_sessions, counts: {waiting_on_agent, waiting_on_researcher, rules}}`, newest first; each direction with `waiting_on`, `target_title?`, `target_found`. `target` is `kind:id` or `bottom_line` / `project` |
| `POST /api/v1/projects/:id/directions` `{target, kind, text}` | human only (on the agent API: 403 `researcher_only`, audited). 201 `{direction}`, `open`. 404 when the target does not resolve (an archived note, an unknown run) |
| `POST /api/v1/projects/:id/directions/:did/close` `{text?}` | human only. Accept the answer: `closed`. 409 `direction_state` for a rule (withdraw it) or one already closed or withdrawn |
| `POST /api/v1/projects/:id/directions/:did/reopen` `{text?}` | human only. Back to `open` with `round` + 1, so it is delivered again to every session; 409 `direction_state` when it is open |
| `POST /api/v1/projects/:id/directions/:did/withdraw` `{text?}` | human only. `withdrawn`: no longer delivered or owed |

### Agent containers (ADR 0061)

The researcher runs a harness (Claude Code, Codex or a shell) in a rootless Podman container for a registered checkout. The coordinator mints the session's agent token itself (`agent_session.container_session` on the token, never through the login socket), writes it to the session's run directory `<home>/run/ct/<session>/m/` (mounted read-only at `/run/ablationkit`) with the MCP configuration and an `ablationkit` wrapper, and serves three Unix sockets there: `agent.sock` (the agent API, accepting only that session's token), `egress.sock` (the egress proxy) and, with credentials configured, `creds.sock` (credential routes). It runs `podman run` in a tmux server of the session's own (a transient systemd unit `ak-agent-<session>.service`, or a detached process in direct mode). The container has `--network none`, no devices, every capability dropped, `--userns keep-id`, the checkout and AblationKit's tree at their own paths, hidden paths masked (empty tmpfs or `/dev/null`) and read-only paths bound read-only. Records: `<home>/containers/sessions/<session>/session.json` (`ContainerSessionRecord`), `egress.jsonl` (`EgressRecord` lines); the project's configuration `<home>/containers/projects/<project>/config.json` (`ContainerConfig`), the agent's home per harness and the environment volumes beside it. Refusals: 409 `container_runtime_unavailable` (no Podman, not rootless, no tmux; `details.problems`), 409 `container_image_missing`, 409 `harness_binary` (not found, or not an ELF binary), 409 `invalid_container_config`, 409 `container_not_running` / `container_not_paused` / `container_not_live`, 502 `container_runtime_error`, 404 `container_session_not_found`. No agent route reads or changes any of it.

| Route | Notes |
| --- | --- |
| `GET /api/v1/agent-containers?project=` | `{sessions, runtime}`: every session, live first; `runtime` is the runtime report below (cached 30 s) |
| `GET /api/v1/agent-containers/runtime` | `{available, binary?, version?, rootless?, cgroup_version?, gpu_cdi?, tmux?, problems, tree}`: Podman, tmux and the CDI spec job containers take the GPU through |
| `POST /api/v1/projects/:id/agent-containers` `{harness?: claude-code\|codex\|shell, label?, args?: [string], binaries?: {harness?, uv?}, git?: {name?, email?}, login?: {copy?, from?}}` | 201 the session and `attach` (the researcher's tmux command). Claude Code: unless `login.copy` is false, the login in `from` (a Claude Code configuration directory, default `~/.claude`) is copied in, onboarding marked done on the same account and the checkout trusted, and the session records `login: {source, copied_at, synced_back, synced_in, stopped?}`; while it runs the monitor carries the fresher login (later `expiresAt`) to the other side (back only for the same subscription and account; the replaced file backed up under `<home>/containers/login-backups/`; audited `agent.container.login.synced`, or `agent.container.login.stopped`), and deletes the container's copy at the end (ADR 0063). `binaries`: absolute paths on this machine (the CLI finds them on the researcher's PATH, skipping version-manager shims); `git`: the identity written to the agent's home once. The project's default configuration is saved as revision 1 on its first session. Audited `agent.container.start` and `auth.agent_session.start` |
| `GET /api/v1/agent-containers/:sid` | the session, with `attach` while it lives |
| `POST /api/v1/agent-containers/:sid/pause` `{reason?}` | freezes the container (`podman pause`) → `paused`, `paused_by: researcher`. Audited `agent.container.pause` |
| `POST /api/v1/agent-containers/:sid/resume` | thaws it → `running`. Audited `agent.container.resume` |
| `POST /api/v1/agent-containers/:sid/stop` `{reason?}` | 202: stops the container; the session ends when the harness has exited. Audited `agent.container.stop` |
| `GET /api/v1/agent-containers/:sid/screen` | `{session_id, state, text, captured_at}`: the terminal as it is now (`tmux capture-pane`), text only |
| `POST /api/v1/agent-containers/:sid/input` `{text?, keys?: [name], enter?}` | `{session_id, chars, keys}`: types into the running session's terminal (ADR 0062): `text` literally, then `keys` by tmux name (`Enter`, `Escape`, `Tab`, `Up`, `C-c`; at most 64); text is submitted with `Enter` unless `enter: false`. 400 for text over 16384 characters or a key that is not a key name; 409 `container_not_running`; 502 `container_terminal_error`. Audited `agent.container.input` with the text |
| `GET /api/v1/agent-containers/:sid/egress?outcome=&limit=` | `{records, summary: {connections, allowed: [{host, count, bytes_down}], denied: [{host, count, reason?}]}}`, newest last (`limit` ≤ 5000, default 200) |
| `GET /api/v1/jobs/:id/attempts/:attemptId/egress` | the same for a job container's attempt with `jobs.network: egress` |
| `GET /api/v1/projects/:id/agent-containers/config` | the project's `ContainerConfig` (the default when none is saved) |
| `PUT /api/v1/projects/:id/agent-containers/config` | the configurable fields (`image`, `agent`, `egress`, `hidden`, `read_only`, `jobs`, `evaluations`, `credentials`, `host_code`, `pause_on_compute_limit`) → the new revision; 400 `invalid_container_config` with `problems` (a path with `..`, a bad host pattern, an evaluation mount that is not hidden, a credential with not exactly one secret source). Audited `agent.container.config.set` |
| `POST /api/v1/projects/:id/agent-containers/allow` `{hosts: [pattern]}` | adds hosts to the egress allowlist (a new revision) |

When a session's harness exits, the coordinator records the end snapshot (commit, uncommitted files, the environment's packages), `files_changed` (committed between start and end plus newly uncommitted; the researcher's own edits meanwhile show too), `packages_changed`, and the shell commands the harness's transcript holds (`commands`, the agent's own record), revokes the token, removes the run directory and audits `agent.container.end` (`state`: `exited`, `failed` for a Podman error (exit 125–127) or a start that failed, `lost` when the terminal was gone without an exit). While the container lives, its session does not go idle. A restarted coordinator serves a live session's sockets again and finalizes the ones that ended meanwhile.

The egress proxy answers HTTP `CONNECT` and absolute-form `http://` requests (one per connection), checks the host against the allowlist plus the harness's own hosts each time (`egress.mode: open` allows any host and still records it), resolves it itself and connects only to public addresses (never loopback, private, link-local, carrier-grade NAT, multicast or documentation ranges), and records each connection: `kind` (`connect`: only the host is known; `http`: method and path, the query left out; `credential`), `outcome`, bytes and duration. A refusal is 403 with the reason. A credential route `http://127.0.0.1:3129/<name>/<path>` forwards to the credential's `upstream` with `header: prefix + secret`, the secret read from the coordinator's environment or a file at each request.

Local jobs of a contained session carry `container: {session_id, evaluation?}` and run in a job container (`ak-job-<attempt>`, recorded as `supervisor.container`): the GPU through CDI (`--device nvidia.com/gpu=all`, `jobs.gpu: all`; 409 `container_gpu_unavailable` without a CDI spec), no network (`jobs.network: none`: `UV_OFFLINE=1`) or the allowlist through the attempt's own proxy (`egress`), hidden paths masked, the job's own variables and the SDK's only (not the coordinator's environment), the project's environment volumes, and the job's limits as Podman's (`--memory`, `--cpus`, `--pids-limit`, `--timeout`). Cancelling also stops the container; an ended attempt's container is removed. A job of a contained session the coordinator cannot containerize is refused (503 `container_runtime_unavailable`); a remote target runs it as any remote job.

### Deployments (Stage 11, ADR 0018; ADR 0037)

Project-scoped. An agent's request is decided by the project policy (`deployments.<kind>`: decision, exposure, allowed targets, runtime cap); a researcher's own request is theirs to make. A public endpoint is never started. A refusal is 403 `{outcome: blocked, deployment, reasons}`, audited. Journal event: `deployment.updated`.

| Route | Who | Notes |
| --- | --- | --- |
| `GET /api/v1/projects/:id/deployments` | human, agent | deployment records |
| `POST /api/v1/projects/:id/deployments` | human, agent | `{kind, model_uri, ttl_minutes, target?, exposure?, max_cents?}` → 201 started (with `estimate` on a paid target), 403 blocked, 503 the launch failed (`deployment.status: failed`, `status_reason`); 422 `model_not_pinned`; 409 `over_spend_ceiling` (`estimate` above `max_cents`). `preview_local` starts an inference session; `remote_research` on a configured Runpod target with `exposure: tailnet` starts a pod (Stage 16, ADR 0023 decision 20: `endpoint`, `provider: {target_id, target_kind, provider_ref, independent_supervision, model_sha256, model_bytes, estimate_cents?, state, checked_at}`); `persistent` and `public` are never launched. An independently supervised deployment stays `running` across a coordinator restart until its provider reports it gone. A record that waited for an approval before ADR 0037 loads `invalidated` |
| `POST /api/v1/projects/:id/deployments/:did/stop` | human | stops it |

Stage 16 adds `reconcile_required` (an ambiguous remote attempt), `worker_disconnected` (a running attempt's worker out of contact) and remote `sync_failed` items; their `ref` is `job:<job_id>`. Stress finding F32 adds `awaiting_run` (an exported notebook nobody has run yet, severity `info`, `ref: job:<id>`); an overdue exported notebook is a `worker_disconnected` item. ADR 0037 adds `compute_limit` (an agent's job was refused at the project's compute limit, or agent jobs went over it; `ref: settings`).

### Model lifecycle (Stage 12, ADR 0019)

Project-scoped. "Agent" marks routes the agent listener also serves, for the token's own project; everything else is human only. MLflow is canonical for every object here; reads answer 503 `tracking_unavailable` while it is down.

| Route | Who | Notes |
| --- | --- | --- |
| `GET /api/v1/projects/:id/datasets` | human, agent | dataset inputs of the project's runs grouped by name and digest: `{datasets: [{name, digest, source_type, source, schema?, profile?, uses: [{run_id, run_name, context, split?, version?, fingerprint?, source_commit?, job_id?, attempt_id?, evaluation_id?}], models: [{model_id, relation: trained\|evaluated, registered?}]}], scanned_runs, truncated}` (newest 5000 runs) |
| `GET /api/v1/projects/:id/models?run_id=&max_results=&page_token=` | human, agent | logged models: `{model_id, name, status, model_type?, source_run_id?, job_id?, attempt_id?, origin?, read_only}` |
| `GET /api/v1/projects/:id/models/:mid` | human, agent | `model`, `tags`, `params`, `metrics`, `mlmodel` (`flavors`, `signature`, `input_example`, `mlflow_version`, `python_version`, `model_size_bytes`), `trust` (`restricted\|code\|unknown` + warning), `dependencies` (requirements, python_env, conda), `input_example`, `files`, `source_run` (with its dataset inputs), `registry_versions`, `evaluations`. `unsupported` when there is no `MLmodel` |
| `GET /api/v1/projects/:id/models/:mid/artifacts?path=` | human, agent | one directory of the model's files |
| `GET /api/v1/projects/:id/models/:mid/artifacts/download?path=` | human | the file as an attachment (`application/octet-stream` unless text/JSON/raster image), `nosniff`, sandbox CSP; audited |
| `GET /api/v1/projects/:id/registry` | human, agent | registered models tagged with this project |
| `POST /api/v1/projects/:id/registry` | human | `{name, description?, tags?}` → 201; 409 `already_exists` |
| `GET /api/v1/projects/:id/registry/:name` | human, agent | `{name, description, tags, aliases, versions: [{version, model_id, run_id, job_id, attempt_id, source, status, aliases, tags, description, evaluations}]}`; 409 `other_project`, 404 when no project owns it |
| `PATCH /api/v1/projects/:id/registry/:name` | human | `{description?, tags?, delete_tags?}` (reserved `ablationkit.*`/`mlflow.*` refused) |
| `POST /api/v1/projects/:id/registry/:name/versions` | human | `{model_id, description?, tags?}` → 201 `{model_version}`; the logged model must be this project's and ready (409 `model_not_ready`) |
| `PATCH /api/v1/projects/:id/registry/:name/versions/:v` | human | `{description?, tags?, delete_tags?}` |
| `PUT /api/v1/projects/:id/registry/:name/aliases/:alias` | human | `{version}`; `latest` and `v<n>` are refused |
| `DELETE /api/v1/projects/:id/registry/:name/aliases/:alias` | human | |
| `GET /api/v1/projects/:id/registry/:name/resolve?alias=\|version=` | human, agent | `{name, version, model_id, alias?, run_id?}`: the pinned reference |
| `GET /api/v1/projects/:id/evaluations` | human, agent | `EvaluationRecord`s, newest first |
| `POST /api/v1/projects/:id/evaluations` | human | `{model_type: classifier\|regressor, model: {model_id} \| {name, version\|alias}, baseline?, dataset: {path, targets, name?, split?}, thresholds?: [{metric, greater_is_better, threshold?, min_absolute_change?, min_relative_change?}], environment?: managed\|project, examples?: true, timeout_sec?, memory_mb?, target_id?, accept_cost?}` → 202 `{evaluation}`. Values are decimal strings. 400 bad input, 404 `dataset_not_found`, 413 `dataset_too_large`, 422 `baseline_required` / `unsupported_dataset`, 503 `bridge_unavailable` / `tracking_unavailable`. With `target_id` (Stage 16, ADR 0023 decision 21): a remote evaluation, submitted as a job whose bundle carries the model (`evaluation.remote: {target_id, job_id, attempt_id, model_sha256, note?}`); the job's run is the evaluation's run; thresholds are checked once the attempt synced. 422 `dataset_not_committed`, `baseline_not_remote`, plus the remote submission errors (`time_limit_required`, `cost_acceptance_required`, `no_worker_url`). Survives a restart; never rerun |
| `GET /api/v1/projects/:id/evaluations/:eid` | human, agent | `{evaluation, candidate: {run_id, status, metrics, artifacts}, baseline?}` |
| `GET /api/v1/projects/:id/evaluations/:eid/examples` | human, agent | batch evaluation (Stage 13): the candidate run's `ablationkit/examples.json` from MLflow, `{summary, rows}` (failing and disagreeing rows first, at most 500). 404 when the evaluation recorded none (`examples: false`) |
| `GET /api/v1/projects/:id/evaluations/:eid/log` | human, agent | the worker's output (text, last 64 KiB) |
| `POST /api/v1/projects/:id/evaluations/:eid/cancel` | human | stops the worker; the runs end `KILLED`. Remote: cancels its job |
| `GET /api/v1/projects/:id/mlproject` | human, agent | `{found, path?, name?, environment: {kind, file?, supported, note}, entry_points: [{name, command, parameters: [{name, type, default?}]}], problems}` (agents do not get `path`) |
| `POST /api/v1/projects/:id/mlproject/runs` | human | `{entrypoint?: "main", parameters?, environment?: uv\|none, env?, limits?, run_name?, study_id?, variant_id?, target_id?, accept_cost?}` → 202 (with `target_id`, the entrypoint runs from a remote bundle; `path` parameters are rendered relative to the checkout) `{job, attempt, mlproject, environment_note}`. 404 `no_mlproject` / `no_entrypoint`, 422 `missing_parameter` / `invalid_parameter` / `unsupported_environment` (`docker_env`) |

Lineage (`GET /api/v1/projects/:id/lineage`) now links `logged_model` (`m-…`), `model_version` (`<name>/<version>`) and `evaluation` (`ev-…`) steps.

### Research inference (Stage 13, ADR 0020)

Project-scoped. A model selector is `{model_id}` or `{name, version|alias}`; it is pinned to a logged-model ID before anything runs, and every result reports the pinned `{model_id, registered_name?, version?, alias?}`. Inputs are `{records: [{column: value}]}` or, for image adapters, `{images: [{data_base64, media_type?, name?}]}` (8 MiB per image, 16 MiB per request; at most 1000 rows). They are checked against the model's task adapter before a worker starts: 422 `invalid_input` with `issues: [{row?, field?, message}]`; 422 `unsupported_model` with `reason` (`no_pyfunc`, `no_signature`, `unnamed_columns`, `unsupported_column_type`, `tensor_needs_adapter`, `bad_adapter_metadata`); 409 `trust_acknowledgement_required` with `trust` unless `acknowledge_trust: true` for formats that run code on load; 503 `bridge_unavailable`. A worker-side failure is a 200 result whose model has `status: "error"` and `error.code` (`schema_mismatch`, `invalid_input`, `load_failed`, `predict_failed`, `output_too_large`, `timeout`, `out_of_memory`, `canceled`, `worker_failed`, `session_crashed`).

Results (`ir-…`) are kept in memory for an hour and lost on restart; nothing reaches MLflow until saved. A result: `{result_id, kind: prediction|comparison, via: one_shot|session, session_id?, task, output, labels?, models: [{model, source_run_id?, status, error?, outputs, probabilities? ([{label, p}] top 5), timings: {import_ms?, load_ms, predict_ms, postprocess_ms?, worker_ms?, round_trip_ms?}, enforcement}], inputs?, input_rows?, targets?, dataset?, params?, rows, input_sha256, environment, comparison?, trust, created_at, expires_at, saved_as?}`.

| Route | Who | Notes |
| --- | --- | --- |
| `GET /api/v1/projects/:id/inference/describe?model_id=\|name=&version=\|alias=` | human, agent | `{model, source_run_id?, trust, adapter? \| unsupported?, flavors, signature}`: the form the UI builds |
| `POST /api/v1/projects/:id/inference/predict` | human | `{model, inputs, params?, acknowledge_trust?, environment?: managed\|project, timeout_sec? (300), memory_mb? (2048)}` → `{result}`. One short-lived worker; its directory is deleted afterwards. Closing the request stops it (`canceled`) |
| `POST /api/v1/projects/:id/inference/compare` | human | `{models: [2..4 selectors], inputs \| dataset: {path, targets?, offset? (0), limit? (100, ≤1000), split?}, params?, …}` → `{result}` with `comparison: {paired, rows, disagreements, has_targets, summary: [{model_id, rows, correct?, accuracy?, mae?, load_ms, predict_ms, metric_direction?}], examples: [{index, predictions, agree, target?, correct?, abs_errors?}], paired_test: {method, assumptions, only_first_correct, only_second_correct, p_value} \| {note}}`. 422 `incompatible_schemas` with `pairs: [{models, reasons}]` before anything runs |
| `GET /api/v1/projects/:id/inference/results/:rid` | human | the unsaved result; 404 `result_expired` |
| `POST /api/v1/projects/:id/inference/results/:rid/save` | human | `{title?, note?, link?: {kind, id}}` (a research record of the project) → 201 `{evidence}`: an MLflow run tagged `ablationkit.kind=inference_evidence` holding `ablationkit/inference/evidence.json`. 409 `already_saved`, 503 `tracking_unavailable` (nothing saved) |
| `GET /api/v1/projects/:id/inference/sessions` | human, agent | `InferenceSessionRecord`s, newest first |
| `POST /api/v1/projects/:id/inference/sessions` | human | `{model, acknowledge_trust?, environment?, idle_timeout_sec? (900), max_lifetime_sec? (28800), memory_mb? (2048), max_request_bytes? (1 MiB), max_queue? (4), request_timeout_sec? (120), wait?}` → 201 `{session}` when ready (with `wait`), else 202. 409 `too_many_sessions` (4 live) |
| `GET /api/v1/projects/:id/inference/sessions/:sid` | human, agent | `{session, adapter?}`; memory is refreshed from the worker when it is idle |
| `POST /api/v1/projects/:id/inference/sessions/:sid/predict` | human | `{inputs, params?}` → `{result}` (`via: session`). 409 `session_not_ready` (with `state`), 413 `request_too_large`, 422 `invalid_input`, 429 `session_busy`, 504 `prediction_timeout` |
| `POST /api/v1/projects/:id/inference/sessions/:sid/stop` | human | → `{session}` `stopped` |
| `POST /api/v1/projects/:id/inference/sessions/:sid/restart` | human | a fresh worker for the same pinned model → 202 `{session}` (`restarts` + 1) |
| `GET /api/v1/projects/:id/inference/sessions/:sid/log` | human | the worker's stderr (text, last 64 KiB) |
| `GET /api/v1/projects/:id/inference/evidence?deleted=1` | human, agent | `InferenceEvidenceRecord`s (deleted ones only with `deleted=1`) |
| `GET /api/v1/projects/:id/inference/evidence/:eid` | human, agent | `{evidence, document?}` (the MLflow artifact), or `unavailable` |
| `DELETE /api/v1/projects/:id/inference/evidence/:eid` | human | deletes the MLflow run; the record keeps `deleted_at` |

A `preview_local` deployment (Stage 11 gates) of `models:/<name>/<version>` now starts an inference session with the deployment's TTL as its idle timeout; its `endpoint` is `ablationkit:inference-session/<id>` (no network port). Other kinds are refused until remote workers (Stage 16). Lineage has an `inference` step: saved evidence (`inference_evidence`, `ie-…`) and sessions (`inference_session`, `is-…`) of the model or registry version.

### LLM research (Stage 14, ADR 0021)

Project-scoped under `/api/v1/projects/:id/llm`. MLflow is the only span store: trace reads apply the project's *current* capture policy (`full`, `redacted`, `metadata_only`, `off`). Token usage appears only where a provider reported it (`{input_tokens?, output_tokens?, total_tokens?, reported, missing}`); a cost estimate only with a configured rate (`{estimated_usd, basis, rate_source, rate_version, partial}`). Decoding parameters and metric values are decimal strings. A prompt reference is `name@alias`, `name/version` or `{name, version|alias}`; it is pinned to `{name, version, alias?, template_sha256, format}` before anything runs.

| Route | Who | Notes |
| --- | --- | --- |
| `GET …/llm/settings` | human, agent | `{settings}` (`LlmSettings`, each provider with `api_key_present`) |
| `PUT …/llm/settings` | human | `{providers?, capture?, revision?}`; narrowing or neutral changes only. A widening is 403 `widening_requires_confirmation` with `widening: [reasons]` and `route`; a stale `revision` is 409 |
| `POST …/llm/settings/widen` | human | the explicit widening request; same body; approves egress (`providers[].egress: {allow_datasets, note?}`), more capture, longer retention, fewer redactions, remote capture |
| `POST …/llm/providers/:provider/check` | human | `GET {base_url}/models` (sends no project data): `{reachable, status?, latency_ms?, models, listed, error?}` |
| `GET …/llm/traces?status=OK\|ERROR&run_id&name&source&evaluation&example_id&variant&prompt&model&max_results (≤200)&page_token&clusters=1` | human, agent | `{traces: [{trace_id, name, state, request_time, duration_ms, run_id, request_preview?, response_preview?, usage?, tags (ablationkit.*), assessments: [{name, value, source, error?}]}], next_page_token?, clusters?: [{span, error_type, count, trace_ids}]}` |
| `GET …/llm/traces/:tid` | human, agent | `{trace, capture: {now, recorded_under?}, spans_available, spans: [{span_id, parent_id, name, type, kind, depth, offset_ms, duration_ms, status, error?, inputs?, outputs?, bodies_omitted, usage?, model?, attributes}], usage, rag: {instrumented, query, retrievals: [{kind, name, query, documents: [{doc_uri, chunk_id, score, content}], duration_ms, error?, bodies_omitted}], generations, index_revision, retrieval_config}, tools: [{name, arguments, result, error?, attempt, retried, duration_ms}], tool_failures, errors, assessments, links: {run_id?, evaluation_id?, example_id?, variant?, prompt?, golden_set?, job_id?, attempt_id?, research: [{kind, id, title}]}}`; 404 for another project's trace. `index_revision`/`retrieval_config` are `{available: false, reason}` unless the application recorded `ablationkit.rag.index_revision`/`ablationkit.rag.config` |
| `POST …/llm/traces/:tid/feedback` | human | `{name, value: bool\|string\|number, rationale?, span_id?}` → a `HUMAN` MLflow assessment |
| `POST …/llm/traces/:tid/link` | human, agent | `{to: {kind, id}}` (a research record): adds a `trace` link; no span data is copied |
| `GET …/llm/prompts?q` | human, agent | prompts tagged with the project or linked to its experiments: `{prompts: [{name, latest_version, aliases, description?, updated_at?}]}` |
| `GET …/llm/prompts/resolve?ref=` | human, agent | `{pinned, template}`; 404 `alias_not_found` |
| `POST …/llm/prompts` | human, agent | `{name, template: string \| [{role: system\|user\|assistant, content}], commit_message?}` → 201 `{version}` (an immutable MLflow prompt version; agents' are tagged `ablationkit.created_by=agent`). 409 `prompt_in_other_project`, `name_taken_by_model`. Exports `.ablationkit/llm/prompts/<name>.json` |
| `GET …/llm/prompts/:name` | human, agent | `{prompt: {name, aliases, tags, versions: [{version, template, format, variables, template_sha256, commit_message?, aliases, created_at, tags}]}}` |
| `GET …/llm/prompts/:name/diff?from&to[&to_name]` | human, agent | `{from, to, diff: {format, variables: {added, removed, kept}, blocks: [{label, role_from?, role_to?, lines: [{op: same\|add\|del, text}]}], identical}}` |
| `POST …/llm/prompts/:name/alias` | human | `{alias, version \| null}` → `{name, alias, version, previous?}` |
| `GET …/llm/golden-sets` · `GET …/llm/golden-sets/:gs` | human, agent | `GoldenSetRecord`s (by ID or name) |
| `POST …/llm/golden-sets` | human, agent | `{name, examples \| from_file (checkout .jsonl/.json), held_out?, description?, note?}` → 201 `{golden_set}` (v1). 422 `invalid_examples` with `issues: [{index, message}]`; agents get 403 `held_out_guarded` for held-out sets |
| `POST …/llm/golden-sets/:gs/versions` | human, agent | `{examples \| from_file, note?}` → a new immutable version; 409 `unchanged`; `held_out_guarded` for agents on held-out sets |
| `GET …/llm/golden-sets/:gs/examples?version` | human, agent | `{golden_set_id, version, examples, expectations_hidden?}` (agents see no expectations of held-out sets); 500 `golden_set_corrupt` if the file no longer matches its SHA-256 |
| `POST …/llm/golden-sets/export` | human | rewrites `.ablationkit/llm/golden-sets/` |
| `POST …/llm/playground` | human | `{variants: [1..6 {label, prompt \| template, provider_id, model, params?}], inputs: [objects] \| golden_set: {id, version?, limit?}, trials? (1..5), trace?: false}` → `{result: {result_id, variants, golden_set?, inputs_sha256, examples, outputs, rows (aligned), summary: {label: {calls, errors, usage, latency_ms, cost?, cost_unavailable?, distinct_outputs}}, capture, traces_written, trace_errors}}`. Kept one hour. 422 `missing_variables`, `too_many_calls` (> 300); 403 `egress_not_approved`, `dataset_egress_not_approved`; 422 `model_not_allowed`; 503 `api_key_missing` |
| `GET …/llm/playground/:rid` | human | the unsaved result |
| `POST …/llm/playground/:rid/save` | human | `{title?, note?, link?}` → 201 `{evidence}` (`LlmEvidenceRecord`; MLflow run `ablationkit.kind=llm_evidence` with `ablationkit/llm/playground.json`). 409 `unpinned_prompt`, `already_saved` |
| `GET …/llm/evidence` · `GET …/llm/evidence/:lx` | human, agent | saved LLM evidence |
| `DELETE …/llm/evidence/:lx` | human | deletes the MLflow run; the record keeps `deleted_at` |
| `GET …/llm/evaluations` · `GET …/llm/evaluations/:le` | human, agent | `LlmEvaluationRecord`s |
| `POST …/llm/evaluations` | human | `{golden_set: {id, version?}, targets: [1..6 {label, prompt, provider_id, model, params?} \| {label, recorded: {run_id}}], scorers: [1..20 {name, builtin, params?} \| {name, judge: {provider_id, model, rubric, uses?: answer\|grounding, params?}} \| {name, project: {path, function}}], trials? (1..10), max_calls? (1000), timeout_sec? (1800), acknowledge_project_code?, target_id?, environment?: none\|project, accept_cost?}` → 201. 422 `missing_variables`, `no_matching_traces`, `call_budget_exceeded` (`calls`, `max_calls`); 409 `project_code_acknowledgement_required`; egress errors as for the playground; 503 `bridge_unavailable`, `tracking_unavailable`. With `target_id` (ADR 0023 decision 25): a remote evaluation, submitted as a job whose bundle carries the request (`environment: remote`, `remote: {target_id, job_id, attempt_id, request_sha256, note?}`); the targets' runs are created and filled once the attempt synced; survives a restart, never rerun. 403 `remote_humans_only` (agents); 404 `target_not_found`; 422 `provider_key_not_remote`, `recorded_not_remote`, `scorer_not_committed`, plus the remote submission errors |
| `GET …/llm/evaluations/:le/examples` | human, agent | `{evaluation, targets, rows: [{example_id, category?, edge_case?, inputs, expectations?, missing_expectations?, cells: {label: {trial, output?, error?, latency_ms?, usage?, trace_id, scores: {name: {value?, rationale?, error?}}}}, differs, regressions, improvements, failed}], slices, expectations_hidden?, nondeterminism?}` (409 `not_finished`) |
| `GET …/llm/evaluations/compare?a&b&label_a&label_b` | human, agent | `{paired, pairing, a, b, metric_deltas, significance ("not computed: …"), rows, regressions, improvements}` |
| `GET …/llm/evaluations/:le/log` | human, agent | the bridge log (text, last 64 KiB) |
| `POST …/llm/evaluations/:le/cancel` | human | → `canceled` |
| `POST …/llm/evaluations/:le/flag` | human | `{example_id, label?, trial?, note?}` → an `ablationkit.flag` = `important_failure` assessment on that example's trace |
| `POST …/llm/evaluations/:le/report` | human, agent | → 201 `{report}`: a research report linking the evaluation, golden-set version, prompt versions, runs and failing traces |

### Extensions (Stage 15, ADR 0022)

Project-scoped. `P` = `/api/v1/projects/:id/extensions`, `X` = `/api/v1/projects/:id/extension-executions`. An extension's `status` is `invalid`, `needs_build`, `needs_approval`, `active`, `active_outdated` (an approved build runs; the checkout changed), `disabled`, `removed` (source gone: inactive) or `safe_mode`. Diagnostics are `{level, code, message, path?, fix?}`.

| Route | Who | Notes |
| --- | --- | --- |
| `GET /api/v1/projects/:id/extension-catalog` | human, agent | `{host_api_version, capabilities: [{id, risk, description, config?, enforcement}], operations}` |
| `GET /api/v1/projects/:id/extension-registry` | human, agent | the user registry: `{extensions: [{extension_id, version, name?, host_api, compatible}]}` |
| `GET P` | human, agent | `{extensions: [summary], safe_mode, host_api_version}` |
| `GET P/:ext` | human, agent | `{extension}`: summary plus `manifest`, `diagnostics`, `source {path, files, *_sha256}`, `permissions [{capability, description, risk, enforcement, bounds?}]`, `python`, `builds`, `approvals`, `disabled?`, `enforcement`, `console` |
| `POST P/:ext/validate` | human, agent | `{ok, diagnostics, build_id?, source_sha256?, lockfile_sha256?, capability_sha256?, files}` |
| `POST P/:ext/build` | human, agent | 201 `{build}` (ready) or 422 (failed, with `diagnostics`); 422 `extension_invalid` before any snapshot; idempotent per content |
| `GET P/:ext/builds/:eb/diff?against=` | human, agent | `{build_id, against?, capabilities_changed?, lockfile_changed?, capabilities: {before, after}, changes: [{path, change: added\|modified\|removed, before?, after?}]}`; `against` defaults to the last other approved build |
| `GET P/:ext/builds/:eb/file?path=` | human, agent | one snapshot file as text (≤ 1 MiB) |
| `POST P/:ext/approve` | human | `{build_id, trusted_code: true, note?}` → `{state}`; 400 `trusted_code_ack_required`, 409 `build_failed`, `host_api_incompatible` |
| `POST P/:ext/enable` | human | re-enables the active approved build |
| `POST P/:ext/rollback` | human | `{build_id}` (an approved build) → `{state}`; 409 `not_approved` |
| `POST P/:ext/disable` | human | `{reason?}`; stops its running executions |
| `POST P/:ext/publish` | human | copies the checkout source to `~/.ablationkit/extensions/<id>/<version>/`; 409 `version_exists` with different source |
| `POST P/install` | human, agent | `{extension_id, version}` → copies a registry version into the checkout; nothing is enabled |
| `GET /api/v1/projects/:id/extension-mounts?point=` | human | active approved contributions: `{mounts: [{extension_id, build_id, contribution, frame_url, capabilities, trusted_code}], safe_mode}` |
| `GET /vault-frame/:p/:nid/:rev` | human (session) | a vault figure's frame document (ADR 0053): the same CSP as an extension view's; it loads the figure runtime from the web build (`/figure-runtime-<hash>.js`, by nonce) and runs the note's script. 404 when the note is not a figure; 409 `revision_conflict` for another revision. In safe mode, or without a web build, it says so instead of running the script |
| `GET /ext-frame/:p/:ext/:eb/:cid[?preview=1]` | human (session) | the sandboxed frame document (CSP `sandbox allow-scripts; connect-src 'none'; frame-ancestors <trusted origins>`); 403 `extension_inactive` unless it is the active approved build (or `preview=1`) |
| `POST P/:ext/rpc` | human | the bridge: `{build_id, contribution, method, params}` → `{result}`. Errors: 403 `extension_inactive`, `capability_denied`, `method_not_allowed`, `unknown_contribution`, `model_not_allowed`; 409 `extension_changed`; 413 `request_too_large`, `too_many_rows`; 429 `quota_exceeded` (`retry_after_sec`); 429 `cost_ceiling` (`llm.*`); 503 `safe_mode`. `llm.infer` `{target: {provider_id, model}, prompt \| template, inputs: [≤50 objects], params?}` and `llm.compare` `{variants: [2..6 {label, target, prompt \| template, params?}], inputs}` return the playground view; `traces.get` `{trace_id}`; `evaluations.examples` / `evaluations.get` `{evaluation_id}` (agent view: held-out expectations hidden); `report.snapshot` `{report_id, snapshot: {title, text?, table?, image? (PNG data URL ≤ 1 MiB)}}` (report.block only, sent by the host after the researcher confirms) appends the static fallback to the report body. Methods and capabilities: `BRIDGE_METHODS` in `packages/extension-host/src/index.ts` |
| `GET /api/v1/projects/:id/extension-snapshots?report=` | human, agent | report-block snapshots: `{snapshots: [{snapshot_id, report_id, extension_id, build_id, source_sha256, contribution, title, text?, table?, image?: {file, bytes, sha256}, saved_at, saved_by}]}`; kept after the extension is removed |
| `GET /api/v1/projects/:id/extension-snapshots/:sid/image` | human | the snapshot's PNG (`nosniff`, CSP `sandbox`) |
| `POST P/:ext/console` | human | `{level, source, message}` from a frame, for the developer console |
| `POST P/:ext/actions/:cid` | human, agent | runs one `project.action` (`extension.python.run`, `research.note.create`, `report.generate`) → `{result}` |
| `POST P/:ext/run` | human, agent | `{contribution, params?, refs?: [{kind, id}], target_id?, accept_cost?}` → 202 `{execution}`; 429 `too_many_executions`. With `target_id` (humans only, ADR 0023 decision 26): a job on that target whose bundle carries the build's source, the request and the staged refs (`execution.remote: {target_id, job_id, attempt_id, request_sha256, note?}`); recorded once the attempt synced. 403 `remote_humans_only` (agents); 404 `target_not_found`; 422 `dependencies_not_remote`, plus the remote submission errors |
| `GET X?extension=` · `GET X/:xid` | human, agent | execution views; `GET X/:xid` adds the full `record` (`ExtensionExecutionRecord`) |
| `GET X/:xid/log` | human, agent | the execution's stderr and prints (text, last 64 KiB) |
| `POST X/:xid/cancel` | human, agent | stops the process tree → `cancelled` |

### Extension Host API 2 backends (ADR 0024)

These routes coexist with Level 1 builds. Project backends must have an active approved build;
bundled backends use their distribution declaration and per-project activation record.

| Route | Who | Notes |
| --- | --- | --- |
| `GET /api/v1/projects/:id/extension-backends` | human, agent | `{extensions: [{id, version, bundled, enabled, operations, pages, services, agent_skills, capabilities}]}` |
| `GET /api/v1/projects/:id/extensions/:ext/backend/pages/:page` | human | declared sandboxed backend page; inactive backends return 403 |
| `POST /api/v1/projects/:id/extensions/:ext/operations/:operation` | human, agent | `{body?, params?, path?}`; operation metadata checks agent permission and optional input/output schema; an operation declaring `widens_data_controls` is human-only and the only call during which the backend may widen its data controls |
| `POST /api/v1/projects/:id/extensions/:ext/backend/disable` | human | stops the backend and supervised work; retains data and policy |
| `POST /api/v1/projects/:id/extensions/:ext/backend/enable` | human | records accepted capabilities and enables an approved project/distribution backend; safe mode remains inactive |

The LLM routes above are compatibility aliases dispatched by the bundled `llm-research` manifest.
Provider credentials are injected by the host broker; saved capture constraints and retention
continue while the corresponding extension is disabled. Trusted backend/worker processes are
not OS filesystem or network sandboxes; see [the backend contract](../extensions/backends.md).

### Operations (Stage 17, ADR 0025)

| Route | Who | Notes |
| --- | --- | --- |
| `GET /api/v1/system/operations` | human | `{diagnostics: {at, status, checks: [{name, status: ok\|warn\|fail, detail, items?}]}, safe_mode, restored: RestoreRecord \| null, pending_restore: PendingRestore \| null, artifact_store: {configured, endpoint?, bucket?, region?, prefix?, min_bytes?, slots?, key_env?, keys_set?, reachable?, error?}, home}`. Checks (spec §13): storage recovery, unreadable records, pending MLflow writes, stalled MLflow updates, orphaned tracking runs, attempts in unknown state, remote workers, missing artifacts, mlflow sidecar, safe mode, restored from backup. Read-only |

Notifications the coordinator raises are also published as `notification.raised` events on their project: `{key, title, body, urgency?, link?}` (`link` is a web-shell path). The web app shows them with the Notification API when turned on in that browser.

### Level 2 builds (Stage 15, ADR 0022)

| Route | Who | Notes |
| --- | --- | --- |
| `GET /api/v1/system/build` | human | `{build: {running: {root, commit, branch, dirty, modified_build?}, modified, next_start, restart_required}, builds: [SourceBuildRecord]}` |
| `POST /api/v1/system/builds/:bid/activate` | human | the build `coordinator start` runs next; the running coordinator is unchanged. 409 `build_not_ready` (checks failed or the build failed) |
| `POST /api/v1/system/builds/deactivate` | human | back to the original install at the next start |

### Jobs (Stage 5, ADR 0011)

Session auth; routes marked **agent** also exist on the agent API for the token's project (ADR 0037). An agent's submission is decided by the project policy: `jobs.run_local` on this machine, `jobs.submit_remote` and its `allowed_targets` with a `target_id` (403 `policy_denied` naming the field, audited), then the compute limit (400 `time_limit_required`, 403 `compute_limit_reached`; see the agent compute limit above). The job records `submitted_by: {kind: agent, id}` and the token's task; a paid target the policy allows counts as the researcher's cost acceptance. An agent cancels only the jobs it submitted. A job is a logical submission; each attempt is one supervised process with one MLflow run (ref = attempt ID). Views show compute status (`state`) and sync status (`tracking.sync_state`) separately.

| Route | Notes |
| --- | --- |
| `POST /api/v1/projects/:id/jobs` | **agent**. `{command: [argv…], cwd?, environment?: "uv"\|"none", env?, limits?: {memory_max_bytes, cpu_quota_percent, runtime_max_sec, tasks_max}, artifact_paths?: [glob], metrics_file?, metrics_format?: {step_keys?: [key] (1–8), timestamp_key?}, input_paths?: [glob] (≤16), run_name?, description?, study_id?, variant_id?, task_id?, agenda_item?}` (MLproject launches set `mlproject`) → 201 job view with `latest_attempt`. `agenda_item` (ADR 0058): the agenda item the job serves, `note:<id>`, a bare note ID or `L<n>`, stored canonically; 400 `unknown_agenda_item` when the agenda has no such item (its lane refuses nothing; the agenda's checks read it). `description` (≤2000: what the run tests and why) starts each attempt's run summary (the `ablationkit.summary` tag, ADR 0048). `metrics_file` lines are JSON objects; nested objects flatten to `a/b` keys; `metrics_format` names the step and time keys (ADR 0042), 400 `invalid_request` if malformed. `input_paths` files (at most 16 MiB each) are recorded as `inputs/<path>` artifacts as the attempt starts, before the command runs; jobs on this machine only (400 `invalid_request` with `target_id`). 400 `secret_in_job_env` for secret-looking env names; 422 `no_project_environment` for `uv` without `pyproject.toml`; 503 `tracking_backpressure` when the outbox is full |
| `GET /api/v1/projects/:id/jobs?limit=` | **agent**. Newest first, with `latest_attempt` |
| `GET /api/v1/jobs?limit=` | **agent**. Every project (an agent: its token's project) |
| `GET /api/v1/jobs/:id` | **agent**. Job, `latest_attempt` and `attempt_details[]`: state, exit code/signal/systemd result, `supervisor` (`mode`, `enforcement`: `enforced`\|`advisory`, `reason`), `collector` health, `snapshot` (host, commit, dirty, python, SDK), uploaded `artifacts`, `tracking` (`mlflow_run_id`, `sync_state`, `pending_ops`), `ingest` counters |
| `POST /api/v1/jobs/:id/cancel` | **agent** (its own jobs; 403 `forbidden_scope` otherwise). 202; SIGTERM to the job via its collector, SIGKILL after 15 s; the attempt ends `cancelled`. 409 if nothing runs |
| `POST /api/v1/jobs/:id/retry` | 201 new attempt (new token, new MLflow run); 409 while one is active |
| `GET /api/v1/jobs/:id/attempts/:a/console?after=&limit=&stream=` | **agent**. `{lines: [ConsoleRecord], next_after, done, state}`; `stream` filters `stdout,stderr,log,system`; `done` once the exit is ingested. Works with MLflow down |
| `GET /api/v1/jobs/supervisor` | the supervisor probe: `{mode, enforcement, reason?, controllers}` |

Attempt states: `starting`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out`, `oom_killed`, `unknown` (the collector vanished without reporting an exit; never rerun automatically).

### Remote compute (Stage 16, ADR 0023)

Session auth. A job submitted with `target_id` runs each attempt from a staged bundle (the pinned commit, the worker, the SDK) under the target's own supervisor. Remote attempts carry `remote` (`RemoteAttemptInfo`): `staging` (`bundling`, `staging`, `submitted`, `exported` for a Colab notebook, `failed`), `provider_job_id`, `provider_state`, `connectivity` (`pending`, `connected`, `disconnected`), `sync` (`awaiting_sync`, `syncing`, `synced`, `sync_failed`) shown separately from compute status, `worker_spool`, `spool_acked_seq`, `reconcile_required` when the outcome is ambiguous, and on a Colab runtime `compute_units` (`ColabComputeUnits`: its rate, measured as the rise in the account's hourly rate when it was allocated, and when it was allocated and released). Nothing is ever resubmitted automatically.

| Route | Notes |
| --- | --- |
| `POST /api/v1/projects/:id/jobs` with `target_id`, `accept_cost?` | 422 `source_dirty` (modified tracked files outside the project's `.ablationkit/`: remote jobs run the pinned commit), 422 `no_commit`, 422 `no_worker_url` (set `remote.worker_url` or the target's `worker_url`; an offline Colab target, notebook or runtime, needs none), 422 `time_limit_required` (paid targets need `limits.runtime_max_sec`), 409 `cost_acceptance_required` with `estimate: {cents?, basis}` from the target's rate card (paid targets), 404 `target_not_found`, 501 `target_kind_unavailable`. The attempt starts `starting` with `remote.staging: bundling`; staging and submission continue in the background. Kinds: `ssh`, `slurm` (bundle streamed over SSH), `runpod` (a pod per attempt; the pod pulls its bundle), `colab` with `colab.mode: cli` (a Colab runtime per attempt through Google's Colab CLI: allocated, staged and started unattended; the coordinator collects the worker's spool while it runs and after, imports it like `remote/import`, and stops the runtime; a refused accelerator or a CLI that is not signed in fails the attempt before anything runs), `colab` without it (a notebook is exported; nothing runs unattended) |
| `POST /api/v1/jobs/:id/retry` | `{accept_cost?}`; a new bundle and a new submission (an explicit human action) |
| `POST /api/v1/jobs/:id/cancel` | remote: recorded at once; the worker stops the job at its next heartbeat, and provider-native cancel (`scancel`, the worker's `cancel`, stopping a pod, a Colab runtime's `ak-cancel` file) is tried too. An exported Colab attempt is cancelled at once |
| `GET /api/v1/targets` | `{targets: [ComputeTarget + {available, capabilities?, effective_worker_url?}]}` |
| `GET /api/v1/targets/:tid` | one target |
| `PUT /api/v1/targets/:tid` | a `ComputeTarget` body without timestamps → 201/200. 400 `invalid_target` (schema, `local`, kind/config mismatch). Credentials are referenced by environment-variable name only |
| `DELETE /api/v1/targets/:tid` | |
| `POST /api/v1/targets/:tid/doctor` | `{ok, checks: [{name, ok, detail}]}`: worker URL, SSH and Python 3.10+, the worker listener reached *from the target*, the work directory. Runpod: the API key variable, the API, the route from a pod (tailnet secret), pod self-stop (advisory), the rate card. Colab notebook: what an export does. Colab runtime (`mode: cli`): the Colab CLI, its sign-in, the account's compute units, the accelerator, unattended execution (advisory) |
| `GET /api/v1/targets/:tid/usage` | `ColabUsage` `{balance_hundredths, per_hour_hundredths, runtimes, checked_at}` (compute units × 100): the Google account's compute units as `colab usage` reports them (the whole account), reused for 30 s. 409 `no_usage` (not a `mode: cli` Colab target), 502 with the CLI's error (`colab_signin_required`, …) |
| `GET /api/v1/jobs/:id/attempts/:a/remote/notebook` | the exported `.ipynb` of a Colab attempt (`staging: exported`): the bundle (base64, SHA-256 checked), the worker run, and an archive cell for `remote/import`. No credentials unless the target sets `colab.live` |
| `POST /api/v1/jobs/:id/attempts/:a/remote/drain` | 202; deliver a leftover worker spool on the target without starting anything (the watchdog does this when the provider ended the job and results are missing). Runpod: restarts the stopped pod, whose worker finds the spool on the volume. A Colab runtime: collects its final archive (or, while the job runs, its latest progress snapshot) and imports it; 409 `nothing_to_collect`. 409 `cannot_drain` (a terminated pod, a Colab notebook), 502 provider errors |
| `POST /api/v1/jobs/:id/attempts/:a/remote/reauthorize` | new launch and upload tokens, written to the worker (after a disconnection longer than the launch token). 409 `not_supported` for pods and notebooks |
| `POST /api/v1/jobs/:id/attempts/:a/remote/resolve` | `{note}` → clears `reconcile_required` after a human checked the target; never reruns. `{lost: true, note?}` on an exported (Colab) attempt that has not reported back → ends it `unknown` with `remote.marked_lost_at`, releasing its parallel slot; a late `import` still lands and settles it |
| `POST /api/v1/jobs/:id/attempts/:a/remote/import` | `{archive_path}` (an absolute path on the coordinator's machine to `tar -czf … state.json spool`) → `{accepted, duplicates, rejected, artifacts, pending_artifacts?, note?, state}`. Same dedupe as live delivery; idempotent. Artifacts wait up to 10 s for the attempt's MLflow run; any still pending are reported, and importing again stores them |

Once a delivered attempt's provider resources outlive the job (a pod that could not remove itself, a Colab runtime), the watchdog releases them (`provider_state: released`, audited `job.remote.release`). A Colab runtime whose results could not be collected after three tries is released too, and the attempt waits for a human (`reconcile_required`).

## Agent API (default `127.0.0.1:7421`, loopback only)

`Authorization: Bearer aka_…`: an agent session's token, bound to one `project_id` (ADRs 0039, 0040). Agents reach it through `ablationkit mcp`. Each request moves the session's last use (written at most once a minute).

| Route | Notes |
| --- | --- |
| `GET /api/v1/health` | |
| `GET /api/v1/whoami` | token ID, scope, expiry, and `session: {harness, label, idle_timeout_sec}` for a session token |
| `GET /api/v1/projects/:id` | only the token's own project (403 otherwise); ID and name only |
| `GET /api/v1/projects/:id/session/account` | the calling session's own account (ADR 0056), as `GET /api/v1/agent-sessions/:id/account` on the human API |
| research and lineage routes | the routes marked **agent** above, for the token's own project (403 `forbidden_scope` otherwise). Changes are attributed `{kind: "agent", id: token_id}` and audited with `listener: "agent"` |
| the policy summary and jobs (ADR 0037) | `GET /api/v1/projects/:id/access` and the job routes marked **agent**: submit within the policy and the compute limit, read the project's jobs and consoles, cancel its own. No policy, revision, preview or retry routes |
| agent containers (ADR 0061) | A contained session reaches this API through its own socket (`/run/ablationkit/agent.sock` in the container), which accepts only its token. Its local jobs run in job containers. On job submit, `evaluation: <name>` runs that protected evaluation's pinned command, environment and time limit (the agent's `run_name`, `description`, `study_id`, `variant_id`, `task_id`, `agenda_item` kept; anything else ignored); 400 `evaluation_needs_container` outside a container, 404 `evaluation_not_found`; its console is 403 `protected_evaluation`. With `host_code: refuse` (the default), `extension.install`, `extension.build`, `extension.action` and `extension.execute` are 403 `contained_host_code`, audited. A compute-limit refusal pauses the session after a moment when `pause_on_compute_limit` is set |
| `GET /api/v1/compute/weights` | the compute weights (read-only); with `GET /api/v1/projects/:id/compute` (marked **agent** above), what is left of the project's compute limit |
| deployments (Stage 11) | list, and request one: the policy decides |
| task routes (ADR 0039) | the routes marked **agent** in the research tasks table (list, read, abandon), and the two below |
| `POST /api/v1/projects/:id/tasks` `{goal, title?, criteria?: [text], agenda_item?}` | 201 `{task}`, `open`. `agenda_item`: the agenda item the task serves (ADR 0058), as on a job; 400 `unknown_agenda_item` |
| `POST /api/v1/projects/:id/tasks/:tid/complete` `{outcome: supported\|not_supported\|inconclusive, notebook_id?, report_id?, conclusion?}` | → `{task, checks}` (`checks` as on the task read). One of `notebook_id` (a notebook of the vault, ADR 0049) and `report_id` is required (400). The evidence gate: 409 `notebook_required` (not a live notebook of the project's vault) / `report_required` (not a report record of the project) / `evidence_required` (`supported` or `not_supported` with no note beneath the notebook that cites a run and no report that cites evidence) / `direction_unanswered` (a direction of the researcher's on the task, on a note written under it or on a run of its jobs is still `open` or `acknowledged`: answer or decline it first, ADR 0057) / `task_closed`; refusals are audited |
| historical runs (ADR 0043) | the two `run-imports` routes marked **agent** in the tracking table |
| directions (ADR 0057) | `GET /api/v1/projects/:id/directions` (marked **agent** above), and the three below. Every response to an agent token (refusals included) carries `x-ablationkit-directions: N` while N directions in force have not been shown to that agent session in their current round; `ablationkit mcp` then takes them and appends them to the tool's result |
| `POST /api/v1/projects/:id/directions` | 403 `researcher_only`, audited: directions are the researcher's to write |
| `POST /api/v1/projects/:id/directions/deliver` `{all?: true}` | `{directions, total}`: the directions in force not yet shown to this session (rules first), recorded as delivered to it; `all` returns every one in force (the start of a session) |
| `POST /api/v1/projects/:id/directions/:did/respond` `{kind: ack\|answer\|decline, text, refs?: [{kind: note\|run\|job\|study\|task\|work, id}]}` | `{direction}`. `ack` (what it will do) → `acknowledged`; `answer` (with the refs of what it changed) → `answered`; `decline` (why) → `declined`. `text` is required (400). A ref that does not resolve is 400 `unresolved_ref`. 409 `direction_state` when it is not in force (answered, declined, closed or withdrawn) or when answering a rule (a rule is acknowledged or declined) |
| model lifecycle reads (Stage 12) | the routes marked **agent** in the Stage 12 table: datasets, logged models, registry, resolve, evaluations, MLproject. No registry changes, downloads or launches |

## Worker API (default `127.0.0.1:7422`)

`Authorization: Bearer akw_…`, bound to `project_id`, `job_id` and `attempt_id`.

| Route | Notes |
| --- | --- |
| `GET /api/v1/health`, `GET /api/v1/whoami` | |
| `POST /api/v1/jobs/:id/attempts/:attemptId/events:batch` | `{events: [EventEnvelope]}` (≤1000, ≤8 MiB) → `{accepted, duplicates, rejected}`. At-least-once: deduped per `producer_id` by `producer_seq`; invalid events are counted and skipped; envelope IDs naming another attempt → 403; 503 `tracking_backpressure` (retry) |
| `PUT /api/v1/jobs/:id/attempts/:attemptId/artifacts?path=` | raw bytes, `x-ablationkit-sha256` required → 201 `{path, size, sha256, uploaded_at}`. 400 unsafe path, 413 too large, 422 checksum mismatch or MLflow refusal, 503 run not created yet or MLflow down (retry) |

A worker token is accepted only for its own job and attempt (403 otherwise). It stays valid until the job is terminal plus 7 days.

Remote workers (ADR 0023) hold two tokens: a **launch** token (`purpose: launch`, valid for `remote.launch_token_days` and shrunk to the 7-day grace once the job is terminal) that can call only the handshake and the bundle download, and a short-lived **upload** token (`remote.upload_token_ttl_sec`) for everything else. A launch token on any other route → 401. Remote requests carry `x-ablationkit-worker-id`; a second worker for the same attempt → 409 `duplicate_execution` and the attempt gets `reconcile_required`.

| Route | Notes |
| --- | --- |
| `GET /api/v1/jobs/:id/attempts/:attemptId/bundle` | launch token; the staged `bundle.tgz` for a pulling worker (a Runpod pod), which checks its SHA-256 before unpacking. 404 `bundle_not_found` (other kinds, or removed at first contact or once the attempt is terminal) |
| `GET /api/v1/deployments/:depId/model` | not a worker token: the deployment's fetch token (only its SHA-256 is stored). A research endpoint pod downloads its pinned model package (`model.tgz`) while the deployment is running and unexpired; 401 otherwise. Audited `deployment.model.fetch` |
| `POST /api/v1/jobs/:id/attempts/:attemptId/handshake` | `WorkerHandshake` (launch or upload token) → `WorkerHandshakeReply`: `spool_acked_seq` (replay only what follows), `cancel_requested`, `heartbeat_sec`, `upload_token?` (when `refresh` or with the launch token; older upload tokens are revoked), `artifacts` already received. Doubles as the heartbeat. 409 `duplicate_execution` (another worker or bundle) |
| `POST …/events:batch` with `x-ablationkit-spool-through: N` | as above; the coordinator records the worker spool seq it applied |
| `POST /api/v1/jobs/:id/attempts/:attemptId/uploads` | `{path, size, sha256}` → 201 `{upload_id, received}` (an identical start resumes the same upload) or 200 `{done: true}` if already stored. With `store_slot` (ADR 0023 decision 24): a receipt for an artifact the worker put in the S3-compatible store; the coordinator pulls `<prefix><project>/<attempt>/s<nn>`, verifies size and SHA-256, stores it through MLflow and deletes the object → 201 entry. 400 a slot not issued to the attempt; 404 `store_object_missing`; 413; 422 `checksum_mismatch` (object deleted); 503 `artifact_store_unavailable` / `tracking_pending` (object kept; retry) |
| `PUT /api/v1/jobs/:id/attempts/:attemptId/uploads/:uid` | one chunk (≤16 MiB) at `x-ablationkit-offset` → `{received}`; 409 `offset_mismatch` `{received}` resumes an interrupted upload |
| `POST /api/v1/jobs/:id/attempts/:attemptId/uploads/:uid/complete` | verify SHA-256 and store through MLflow → 201; 409 `upload_incomplete`; 422 `checksum_mismatch` (the upload is discarded); 503 retry |

### Job event types (collector and SDK → `events:batch`)

| Type | Producer | Payload → effect |
| --- | --- | --- |
| `console.line` | collector | `{stream: stdout\|stderr\|system, text}` → console journal |
| `log.record` | SDK `LoggingHandler` | `{level, logger, message}` → console journal, stream `log` |
| `metric.batch` | SDK, metrics file | `{metrics: [{key, value, step?, timestamp?}]}` → MLflow `log_batch` (timestamp defaults to the event's `ts`) |
| `param.batch` | SDK | `{params: {k: v}}` → MLflow params (immutable) |
| `tag.batch` | SDK | `{tags: {k: v}}`; `ablationkit.*`/`mlflow.*` refused |
| `artifact.logged` | SDK, collector globs | `{artifact_id, path, sha256, size}`; the bytes come through `PUT …/artifacts` |
| `dataset.input` | SDK `log_input` | `{name, digest, source, source_type, context, split?, version?, fingerprint?, schema?, profile?}` → outbox `log_inputs` (role in `mlflow.data.context`; split/version/fingerprint/source commit as `ablationkit.*` input tags) |
| `model.logged` | SDK `log_model` | `{model_key, name, artifact_path, files: [{path, size}], step, model_type?}` → outbox `log_model`: waits for the files, creates the logged model, copies, finalizes, `runs/outputs` |
| `sdk.started` | SDK | `{sdk_version, python}` → attempt snapshot |
| `trace.logged` | `ablationkit_llm` | `{trace: {trace_id (tr-…), name, request_time, duration_ms, state: OK\|ERROR, tags (ablationkit.* kept), metadata, spans: [MLflow traces.json spans]}}` → the project's capture policy, then outbox `log_trace` (StartTraceV3 + spans). Nothing is queued when capture is `off` |
| `attempt.started` | collector | `{pid, unit, hostname, command, cwd, source_commit?, source_dirty?, collector_version}` → `running`. `source_dirty`: modified, staged or untracked files anywhere in the repository, except the project's `.ablationkit/` |
| `attempt.exited` | collector | `{exit_code?, signal?, unit_result?, timed_out, oom_killed, leftovers_killed, duration_ms, error?}` → terminal state, MLflow run ended |
| `collector.health` | collector | `{pid, spool_bytes, pending_events, pending_artifacts, dropped_events, last_error?}` every 10 s |
| `collector.drained` | drain-only collector | `{exit_recorded}`; without a recorded exit the attempt becomes `unknown` |
| `worker.status` | remote worker | `{phase, next_seq, pending_events, …}`: a timestamped observation every 5 minutes, spooled while offline |

Remote workers (producer `worker`) send the same `console.line`, `attempt.started` (plus `mode`, `enforcement`, `reason`, `worker_id`; the source commit is the bundle's) and `attempt.exited` (plus `cancelled`, and `lost: true` when the job's process vanished without an exit record: the attempt becomes `unknown` with `reconcile_required`, never rerun).

## Events

| Type | Payload |
| --- | --- |
| `project.registered` | `{name, manifest_created}` |
| `project.remapped` | `{from, to}` |
| `tracking.experiment.ready` | `{experiment_id}`: MLflow acknowledged `ak/<project-id>` |
| `tracking.experiment.imported` | `{experiment_id, name}` |
| `tracking.run.sync` | `{ref, sync_state, mlflow_run_id?, job_id?, attempt_id?, last_error?}` |
| `job.attempt.state` | `{job_id, attempt_id, state, exit_code?, signal?, unit_result?, cancel_requested?}` |
| `job.artifact.uploaded` | `{job_id, attempt_id, path, size}` |
| `job.attempt.remote` | `{job_id, attempt_id, target_id, staging, connectivity, sync, provider_state?, reconcile_required?}` on any change |
| `job.worker.disconnected` / `job.worker.reconnected` | `{job_id, attempt_id, target_id, last_contact_at?}` |
| `job.worker.overdue` | `{job_id, attempt_id, target_id, expected_back_by}`: an exported (Colab) attempt is still unreported after its `expected_back_by`; import its archive or mark it lost |
| `research.created`, `research.updated`, `research.archived`, `research.restored`, `research.deleted` | `{record_id, kind, revision, actor}` |
| `research.imported` | `{records}`: the one-time import from the checkout |
| `review.updated` | `{kind, id, reviewed}`: the researcher marked or unmarked a record or task (ADR 0048) |
| `vault.note.created`, `vault.note.updated`, `vault.note.archived`, `vault.note.restored`, `vault.note.deleted` | `{note_id, type, revision, actor}` (ADR 0049) |
| `vault.index.updated` | `{revision, actor}`: the shelf or the ledger changed |
| `vault.reads.updated` | `{notes, forget}`: the researcher's read marks changed |
| `direction.created` | `{direction_id, kind, target}`: the researcher wrote a direction (ADR 0057) |
| `direction.updated` | `{direction_id, status, act}`: an agent acknowledged, answered or declined it, or the researcher closed, reopened or withdrew it |
| `agenda.updated` | `{revision, changes}`: the researcher changed the agenda (ADR 0058) |
| `agenda.read` | `{token_id, revision}`: an agent session read the agenda's current revision |
| `agent.container.state` | `{session_id, state, token_id}`: an agent container session started, was paused, resumed or stopped, or ended (ADR 0061) |
| `vault.work.created`, `vault.work.updated`, `vault.work.archived`, `vault.work.restored`, `vault.work.deleted` | `{work_id, kind, revision, actor}` (ADR 0052) |
| `tracking.run.described` | `{mlflow_run_id}`: a run's summary or notes changed |
| `research.exported` | `{written, removed, drift, redactions}` |
| `policy.revised` | `{revision, changes}` (the changed policy paths) |
| `model.logged` | `{model_id, name, run_id, ref}` |
| `registry.model.created` | `{name}` |
| `registry.version.created` | `{name, version, model_id}` |
| `registry.alias.set`, `registry.alias.deleted` | `{name, alias, version?}` |
| `evaluation.updated` | `{evaluation_id, state, passed?}` |
| `inference.session.updated` | `{session_id, state, model_id}` (each state change) |
| `inference.evidence.saved` | `{evidence_id, kind}` |
| `inference.evidence.deleted` | `{evidence_id}` |
| `llm.settings.updated` | `{revision, capture}` |
| `llm.prompt.updated` | `{name, version?, alias?}` |
| `llm.golden_set.updated` | `{golden_set_id, version}` |
| `llm.evaluation.updated` | `{evaluation_id, state}` |
| `llm.evaluation.flagged` | `{evaluation_id, example_id, trace_id}` |
| `llm.evidence.saved`, `llm.evidence.deleted` | `{evidence_id}` |
| `extension.built` | `{extension_id, build_id, status}` |
| `extension.activated` | `{extension_id, build_id}` (approve, enable, rollback) |
| `extension.backend.activation` | `{extension_id, enabled}` |
| `extension.disabled` | `{extension_id}` |
| `extension.installed` | `{extension_id, version}` |
| `extension.execution.started`, `extension.execution.finished` | `{execution_id, extension_id, status?}` |
| `extension.execution.progress` | `{execution_id, percent, message?}` |
