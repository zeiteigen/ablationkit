# The `ablationkit_*` operations

Each row is an operation and the tool that reaches it: `ablationkit_read run.metrics` is
`ablationkit_read` with `{op: "run.metrics", run: …, key: …}`, and `ablationkit_note add` is
`ablationkit_note` with `{action: "add", note_id: …, …}`. The arguments go alongside `op` or
`action`. Required arguments in **bold**. `ablationkit_read` with
`{op: "help", about: "<op>"}` gives the authoritative description and schema; this is the map.

## Project

| Call | Arguments | Returns / notes |
| --- | --- | --- |
| `ablationkit_project` | none | The researcher's agenda (Now, rules, Next, Parked, Dropped), then the project, `directions_from_the_researcher` (`rules` and `open`, each with `direction_id`, `kind`, `asks`, `on`, `text`, `status`), your session, policy summary, compute limit with the targets you may use. Call first. |
| `ablationkit_read agenda` | `since` (a revision) | The researcher's agenda whole: `now`, `rules`, `next`, `parked`, `dropped` as `ID: text` lines, `changed` (what changed since this session last read it, or since `since`) and `your_checks` (`off_agenda`, `parked_work`, `not_on_agenda`). Only the researcher writes it. Reading it marks it read for your session. |
| `ablationkit_read compute` | none | `limit_hours`, `used_hours`, `reserved_hours`, `available_hours`, live attempts, the last refusal, and `targets`: each target you may use with its `weight` and `limits` (`enforced`, `advisory` with the reason, or `reported_per_attempt` on a remote target). Check before planning jobs. |

## The researcher's directions

Written by the researcher in the web UI (never by an agent); new ones are also appended to the next
tool result of your session.

| Call | Arguments | Returns / notes |
| --- | --- | --- |
| `ablationkit_read direction.list` | `status` (`open`, `acknowledged`, `answered`, `declined`, `closed`, `withdrawn`), `waiting` (`agent`, `researcher`, `none`), `target` (`note:<id>`, `run:<name>`, `study:<id>`, `task:<id>`, `bottom_line`, `project`) | Newest first, each with its target, `kind`, the researcher's `text`, `status`, `round`, `waiting_on` and `thread`. `waiting: "agent"` is what you owe. |
| `ablationkit_do direction.respond` | **`direction_id`**, **`kind`** (`ack`, `answer`, `decline`), **`text`**, `refs` (`[{kind: note\|run\|job\|study\|task\|work, id}]`) | `ack`: what you will do. `answer`: what you found or changed, with refs to it (each must exist: `unresolved_ref`). `decline`: why not. A rule takes `ack` or `decline`. 409 `direction_state` once answered, declined, closed or withdrawn. |

## Tasks

| Call | Arguments | Returns / notes |
| --- | --- | --- |
| `ablationkit_task create` | **`goal`**, `title`, `criteria` (strings), `agenda_item` (`note:<id>` or `L<n>`: the agenda item it serves) | The task ID (`task-…`). An unknown `agenda_item` is refused (`unknown_agenda_item`). |
| `ablationkit_read task.show` | **`task_id`** | The task with its jobs (and MLflow runs), its `notes` in the vault, the `works` of the library found under it and its records, and `checks`: runs with no note saying what they showed (`no_notes`), what is wrong with its notes (`off_shelf`, `repeated`, `long_note`, `unresolved_embed`, `unknown_run`, …), where its records lag its runs (`study_status`, `undeclared_variants`, `no_description`, …), and directions of the researcher's on it that no agent answered (`direction_unanswered`). Clear them before you report back. |
| `ablationkit_read task.list` | `status` (`open`, `completed`, `abandoned`) | Newest first. |
| `ablationkit_task complete` | **`task_id`**, **`outcome`** (`supported`, `not_supported`, `inconclusive`), **`summary`** (the answer to the goal, 2 to 5 plain sentences), `notebook_id` (the session's edition) or `report_id` (a report record, the older form) | One of the two is required. The first two outcomes need a note beneath the notebook that cites runs (or a report that cites evidence). Refused (`direction_unanswered`) while a direction of the researcher's on the task, its notes or its runs waits for an answer. Returns `checks` too. |
| `ablationkit_task abandon` | **`task_id`**, `reason` | For dead ends. |

## Jobs

| Call | Arguments | Returns / notes |
| --- | --- | --- |
| `ablationkit_job submit` | **`command`** (argv), **`runtime_max_sec`**, **`description`** (what the run tests and why; it starts the run's summary), `run_name`, `task_id`, `agenda_item` (the agenda item it serves; else its task's), `study_id`, `variant_id`, `target_id` (remote; omit for this machine), `cwd`, `environment` (`uv` default with a `uv.lock`, or `none`), `metrics_file`, `metrics_format` (`{step_keys, timestamp_key}`), `artifact_paths`, `input_paths`, `env`, `memory_max_bytes`, `cpu_quota_percent` | The job. The policy, then the compute limit, decide. `metrics_file` lines are JSON objects, nested values flattened to `a/b`; `metrics_format` names the step keys (first match wins) and the time key (ms, or s below 1e11). `input_paths` files are recorded as `inputs/…` artifacts as the job starts (local jobs, ≤16 MiB each). |
| `ablationkit_read job.list` | `limit` | Newest first: state, target, submitter, MLflow run. |
| `ablationkit_read job.show` | **`job_id`** | Attempts, state, exit, compute, MLflow run. |
| `ablationkit_read job.log` | **`job_id`**, `attempt_id`, `tail`, or `after` + `limit`, `stream` (`stdout`, `stderr`) | Console lines; `next_after` continues, `done` says it ended. |
| `ablationkit_job cancel` | **`job_id`** | Only jobs your session submitted. |
| `ablationkit_wait` | `jobs` (job IDs) or `runs` (run names or MLflow run IDs); default: your session's live jobs. `for`: `end` (default: ended, results in MLflow and collected from a remote target), `start` (running), `metric` (with **`metric`**, `step`); `until`: `any` (default) or `all`; `timeout_sec` (default 600, ≤ 3600) | `{done, reason, waited_sec, ready, jobs, next}`. `reason`: `condition`, `timeout` (call again), `researcher` (their direction or agenda change comes with the result) or `nothing_to_wait_for`. Each job: `state`, `ready`, `results`, `run` (for `run.metrics`), `exit_code`, `metric`, `remote`. A job that ended counts for `start` and `metric` too. Sends MCP progress notifications when the call has a progress token. |

## Runs

| Call | Arguments | Returns / notes |
| --- | --- | --- |
| `ablationkit_read run.search` | `filter` (MLflow syntax), `order_by`, `max_results`, `page_token`, `view` | e.g. ``filter: "tags.`ablationkit.study_id` = 'lr-sweep'"``, `order_by: ["metrics.loss ASC"]`. |
| `ablationkit_read run.show` | **`run`** | Params, latest metrics, tags, status. |
| `ablationkit_run describe` | **`run`**, `summary` (≤2000), `notes` (Markdown, ≤8000), `set_aside` (≤1000) | What the run showed, once you have read it: `summary` replaces the job's description with the outcome against the baseline; `notes` holds caveats and what to try next. `set_aside`: why a run you will not report is left out; the researcher sees it beside the findings that leave the run out. An empty string clears one. 409 `tracking_pending` until MLflow has the run. |
| `ablationkit_read run.metrics` | **`run`**, `key`, `max_results`, `page_token` | Latest values; with `key`, that metric's history. |
| `ablationkit_read run.artifacts` | **`run`**, `path`, `page_token` | One directory level. |
| `ablationkit_read run.artifact_text` | **`run`**, **`path`**, `offset`, `limit` | Text a page at a time; binary is `not_text`. |
| `ablationkit_run import` | **`run_name`**, **`source`** (the run's directory in the checkout), `started_at`, `ended_at`, `status`, `source_commit`, `params`, `params_files`, `metrics_file` + `metrics_format`, `metrics`, `artifact_paths`, `description`, `notes`, `study_id`, `variant_id`, `task_id`, `tags` | A run from before the project used AblationKit, from its files, labelled `import` (no job, no compute). One per source (409 `already_imported`). Read its `warnings`. |
| `ablationkit_read run.imports` | none | The imported runs and their sources. |
| `ablationkit_run study` | **`study_id`**; to create one also **`title`** and **`summary`**; `body`, `status` (`planned`, `running`, `complete`, `abandoned`), `variants` (`[{variant_id, title, description}]`), `add_variants`, `baseline_variant`, `metric_goals` (`[{key, goal: "min"/"max"}]`), `protocol`, `hypothesis_ids`, `task_id`, `if_revision` | Records the study, or changes the one with that ID: `variants` replaces, `add_variants` adds (or re-describes). The ID is the `study_id` tag runs carry. Keep its status, summary and variants current as runs land. |

## The vault

What the researcher reads: atomic notes at three depths, composed by embedding, with a ledger.
The `research-task` skill's `references/writing.md` says how each is written.

| Call | Arguments | Returns / notes |
| --- | --- | --- |
| `ablationkit_read vault.show` | `under` (a note ID) | The bottom line; the ledger (claims by standing, decisions in force, open questions) as `id: title` lines; the shelf as an indented tree of `id [type, standing] title` lines; the editions; notes the shelf does not reach; `counts`; `checks`. Read it before writing. |
| `ablationkit_read note.list` | `type`, `standing`, `q`, `task_id`, `archived`, `limit` | Notes with their gists and what they embed, newest change first (best match first with `q`). |
| `ablationkit_read note.show` | **`note_id`** | The note in full, the notes it `embeds`, its `places` (each chain from a shelf notebook down to it), `editions`, `mentioned_by`, `read` (`new`, `changed`, `read`: whether the researcher has read it as it stands) and its `checks`. |
| `ablationkit_note add` | **`note_id`** (kebab-case words), **`type`** (`concept`, `method`, `experiment`, `finding`, `claim`, `decision`, `question`, `log`, `figure`, `notebook`), **`title`** (≤ 80 characters), **`gist`** (one sentence, ≤ 180), `summary`, `full`, `standing` (required for a claim, decision or question), `key` (`{text, label}`), `support`, `would_change`, `evidence` (`[{run, role, metric, vs, note}]`), `figure` (`{script}`: figures only, the JavaScript that draws it from the runs), `study`, `aliases`, `bears_on`, `cites` (`[{work, role, where, note}]`: works of the library, role `method`, `solution`, `baseline`, `supports`, `contradicts`, `inspiration`, `tool` or `background`), `sources` (`kind:id` or `repo:<path>`), `task_id`, `edition`, `created` | The note and its `checks`. `![[id]]` alone on a line embeds a note; `[[id]]` or `[[id\|words]]` links one. Refused: `note_exists`, `embed_cycle`, `figure_syntax` (with the line), a malformed field. |
| `ablationkit_note update` | **`note_id`**, any field above, `updated`, `if_revision` | Only the fields given are replaced; an empty string or list clears an optional one. A change a reader would see shows the note to the researcher as revised. |
| `ablationkit_note archive` | **`note_id`**, `archived` | Archive or restore. Returns `embedded_in`: the notes that embedded it. Deleting is the researcher's. |
| `ablationkit_note ledger` | `shelf` (notebook IDs in reading order), `bottom_line`, `order` (claim IDs, most important first), `if_revision` | Each field given replaces the stored one. Returns the vault-wide `checks`. |
| `ablationkit_read vault.check` | none | Every check: `{code, note?, work?, message}`. Advice, not a gate. |
| `ablationkit_read session.account` | none | Your session's account (ADR 0056): `record` (what the coordinator recorded on its own: duration, jobs by how they ended, `hit_time_limit`, `weighted_hours`, tasks), `account` (runs cited, set aside or unaccounted for, notes added and revised, standings you moved, your edition) and the `checks` outstanding on what you wrote. |

## The library of prior work

Every paper, preprint, repository, doc or thread consulted for the project, used or set aside
(ADR 0052). Search it before you look anything up; record what you read as you read it; cite it
from notes with its role.

| Call | Arguments | Returns / notes |
| --- | --- | --- |
| `ablationkit_read work.list` | `q`, `kind`, `role`, `standing` (`used`, `considered`, `unread`), `reading`, `task_id`, `note_id`, `archived`, `limit` | Works with how they are named (`cite`), how closely they were read, the takeaway, the roles they play and the notes citing them, newest change first. |
| `ablationkit_read work.show` | **`work_id`** | The work in full, `cited_by` (each note and the role it is cited in there) and its `checks`. |
| `ablationkit_work add` | **`work_id`** (citation key, kebab-case: `vaswani-2017-attention`), **`kind`** (`paper`, `preprint`, `book`, `thesis`, `report`, `repo`, `software`, `dataset`, `model`, `docs`, `article`, `thread`, `talk`, `other`), **`title`**, **`reading`** (`unread`, `abstract`, `skimmed`, `read`), **`takeaway`**, `authors` (`Family, Given`; `others` for et al.), `year`, `venue`, `doi`, `arxiv`, `url`, `version`, `accessed`, `summary`, `found_for`, `found_via`, `task_id` | The work and its `checks`. Refused: `work_exists` (the key, or the same DOI, arXiv ID or URL, is already in the library: `details.work_id` names it; update that one). |
| `ablationkit_work update` | **`work_id`**, any field above, `if_revision` | Only the fields given are replaced. |
| `ablationkit_work archive` | **`work_id`**, `archived` | For a work recorded by mistake. Returns `cited_by`: the notes whose citation needs another work. A work read and set aside is kept, not archived. |
| `ablationkit_read work.citations` | `format` (`bibtex`, `csl-json`, `markdown`), `notebook_id`, `cited` | `{format, text}`: the citations, the role each work played and what was taken from it as the annotation. |

## Research records

The older form of what the vault now holds. Read the ones a project has and cite them in a note's
`sources`; write notes instead of new ones unless something must link to a record (an LLM trace)
or the researcher asks.

| Call | Arguments | Returns / notes |
| --- | --- | --- |
| `ablationkit_do research.add` | **`kind`** (`hypothesis`, `approach`, `note`, `report`, `decision`), **`title`**, **`summary`** (what it is, why, what came out, what it means), `body` (the in-depth read: Markdown, tables, LaTeX as `$…$`), `status`, `tags`, `links`, `evidence`, `follow_up`, `task_id`, `from_conversation` | Evidence item: `{ref: {kind: "run", id: RUN_ID}, role, mlflow_run_id, values: {"loss": "0.41"}, note}`, values as exact strings from the run. |
| `ablationkit_do research.update` | **`record_id`**, any field above, `add_tags`, `add_links`, `task_id`, `if_revision`; for a study also `variants`, `add_variants`, `baseline_variant`, `metric_goals`, `protocol` | `tags`, `links`, `evidence`, `variants` replace; `add_*` add. Use it to move a hypothesis to `supported`/`refuted`/`inconclusive` (and rewrite its summary). A study is easier through `ablationkit_run study`. |
| `ablationkit_read research.list` | `kind` (also `study`, `conversation`), `status`, `tag`, `q`, `link` (`task:task-…`, `run:…`), `limit` | Newest first. |
| `ablationkit_read research.show` | **`record_id`** | The record and what links to it. |
| `ablationkit_do research.archive` | **`record_id`**, `archived` | Archive or restore; deleting is the researcher's. |
| `ablationkit_read review.list` | none | The older reading list over tasks and records, with the researcher's `review` of each (`new`, `changed`, `reviewed`) and their `note` if they left one. Notes are feedback, not permission. |
| `ablationkit_do report.generate` | **`study_id`**, `title`, `baseline_variant`, `metric_keys`, `hypothesis_ids`, `task_id` | An evidence-linked report from the study's synced runs. Read it before relying on it. |
| `ablationkit_do report.regenerate` | **`record_id`** | Refresh a generated report from the study's current runs. |
| `ablationkit_do conversation.link` | **`source`** (`chatgpt`, `claude`, `claude_code`, `codex`, `other`), `url` or `local_ref`, `title`, `notes`, `tags`, `links`, `export_notes`, `conversation_created_at` | A reference; nothing is fetched. |
| `ablationkit_read lineage` | **`kind`**, **`id`** | Provenance chain (run, job, report, task, study, logged_model, …) with explicit gaps. |

## Datasets, models, evaluations

| Call | Arguments | Returns / notes |
| --- | --- | --- |
| `ablationkit_read dataset.list` | none | Dataset versions (digest), roles, splits, the runs and models that used them. |
| `ablationkit_read model.list` | `run_id`, `max_results`, `page_token` | Logged models. |
| `ablationkit_read model.show` | **`model_id`** (`m-…`) | Flavors, signature, dependencies, files, lineage. |
| `ablationkit_read model.artifacts` | **`model_id`**, `path` | A logged model's files. |
| `ablationkit_read registry.list` | none | Registered models with versions and aliases. |
| `ablationkit_read registry.show` | **`name`** | Versions, aliases, sources, lineage. |
| `ablationkit_read registry.resolve` | **`name`**, `alias` or `version` | The pinned version. |
| `ablationkit_read evaluation.list` | none | Classical (`mlflow.evaluate`) evaluations. |
| `ablationkit_read evaluation.show` | **`evaluation_id`** (`ev-…`) | Model, data, metrics, threshold results. |
| `ablationkit_read evaluation.examples` | **`evaluation_id`**, `query` | Per-example results, paged. |
| `ablationkit_read evaluation.log` | **`evaluation_id`** | Worker log. |
| `ablationkit_read mlproject.show` | none | `MLproject` entrypoints and parameters. |

## Inference and deployments

| Call | Arguments | Returns / notes |
| --- | --- | --- |
| `ablationkit_read inference.describe` | `model_id`, or `name` with `version` or `alias` | Signature, task adapter, input form. |
| `ablationkit_read inference.sessions` | `session_id` | Warm sessions (starting them is the researcher's). |
| `ablationkit_read inference.evidence` | `evidence_id` | Predictions and comparisons the researcher saved. |
| `ablationkit_read deployment.list` | none | Deployments and their state. |
| `ablationkit_do deployment.request` | **`kind`** (`preview_local`, `remote_research`, `persistent`, `public`), **`model_uri`** (`models:/NAME/VERSION` or `runs:/RUN_ID/PATH`), **`ttl_minutes`**, `target`, `exposure`, `max_cents` | The policy decides; nothing is queued for approval. |

## LLM research

Path parameters by name, then `query` (strings) for reads or `body` for writes.

| Call | Arguments | Returns / notes |
| --- | --- | --- |
| `ablationkit_read llm.settings.read` | none | Providers, locality, egress, capture, redaction, retention. |
| `ablationkit_read llm.trace.search` | `query`: `status`, `run_id`, `name`, `source`, `evaluation`, `example_id`, `variant`, `prompt`, `model`, `clusters: "1"`, `page_token` | Traces, or error clusters. |
| `ablationkit_read llm.trace.read` | **`tid`** | Span tree and waterfall, errors, retries, RAG view, tool calls, reported usage, feedback, links. |
| `ablationkit_do llm.trace.link` | **`tid`**, `body: {to: {kind, id}}` | Link a trace to a record. |
| `ablationkit_read llm.prompt.list` | `query: {q}` | Prompts with versions and aliases. |
| `ablationkit_read llm.prompt.read` | **`name`** | Versions, templates, variables, aliases. |
| `ablationkit_read llm.prompt.diff` | **`name`**, `query: {from, to, to_name}` | Diff two versions (or two prompts). |
| `ablationkit_read llm.prompt.resolve` | `query: {ref}` (`NAME@ALIAS` or `NAME/VERSION`) | The pinned version. |
| `ablationkit_do llm.prompt.version` | `body: {name, template, commit_message}` | A new version, tagged agent-made. Aliases are the researcher's. |
| `ablationkit_read llm.golden_set.list` | none | Golden sets. |
| `ablationkit_read llm.golden_set.read` | **`gs`** | A set and its versions (SHA-256). |
| `ablationkit_read llm.golden_set.examples` | **`gs`**, `query: {version, …}` | Examples, paged; held-out expectations hidden. |
| `ablationkit_do llm.golden_set.create` | `body: {name, description, note, examples or from_file}` | Not held-out sets. |
| `ablationkit_do llm.golden_set.version` | **`gs`**, `body: {examples or from_file, note}` | A new immutable version. |
| `ablationkit_read llm.evaluation.list` | none | GenAI evaluations (launching is the researcher's). |
| `ablationkit_read llm.evaluation.read` | **`le`** | State, variants, scorers, aggregates. |
| `ablationkit_read llm.evaluation.examples` | **`le`**, `query` | Per-example results across variants, with traces. |
| `ablationkit_read llm.evaluation.compare` | `query: {a, b}` | Example by example, same golden-set version only. |
| `ablationkit_read llm.evaluation.log` | **`le`** | Worker log. |
| `ablationkit_do llm.evaluation.report` | **`le`**, `body: {title}` | A report record linking prompts, traces, runs. |
| `ablationkit_read llm.evidence.list` / `ablationkit_read llm.evidence.read` | **`lx`** for read | Playground and comparison results the researcher saved. |

## Extensions

| Call | Arguments | Returns / notes |
| --- | --- | --- |
| `ablationkit_read extension.list` | none | Extensions and status (`needs_build`, `needs_approval`, `active`, …). |
| `ablationkit_read extension.show` | **`extension_id`** | Manifest, contributions, permissions and their enforcement, diagnostics, builds. |
| `ablationkit_read extension.catalog` | none | Contribution points, capabilities and their enforcement. |
| `ablationkit_do extension.validate` | **`extension_id`** | Diagnostics with fixes. |
| `ablationkit_do extension.build` | **`extension_id`** | A build; a ready build is enabled at once (unless the coordinator requires approval, or the researcher disabled the extension). |
| `ablationkit_read extension.diff` | **`extension_id`**, **`build_id`**, `against` | What a build changes against the approved one. |
| `ablationkit_do extension.run` | **`extension_id`**, **`contribution`**, `params`, `refs`, `target_id` | An execution (`xe-…`) of an approved Python contribution. |
| `ablationkit_do extension.action` | **`extension_id`**, **`contribution`** | Run an approved `project.action`. |
| `ablationkit_read extension.executions` | `extension` | Executions. |
| `ablationkit_read extension.execution` | **`execution_id`** | Status, progress, typed result, enforcement labels, MLflow run. Poll until not `running`. |
| `ablationkit_read extension.execution_log` | **`execution_id`** | The log's end. |
| `ablationkit_do extension.execution_cancel` | **`execution_id`** | Cancel a running execution. |
| `ablationkit_read extension.registry` | none | Extensions in the researcher's user registry. |
| `ablationkit_do extension.install` | **`extension_id`**, **`version`** | Install from the registry into the checkout; then build. |
| `ablationkit_read extension.operations` | none | Backend extensions' declared operations. |
| `ablationkit_do extension.call` | **`extension_id`**, **`operation`**, `input: {params, body, path}` | Call one as your session; researcher-only ones stay refused. |
