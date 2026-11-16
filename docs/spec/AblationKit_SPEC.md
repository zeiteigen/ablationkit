# AblationKit — Product & Architecture Specification

**Version:** 0.16 (working draft)  
**Updated:** 2026-11-02  
**Audience:** Individual researcher developing and evaluating diverse ML systems (including novel architectures and training pipelines), with an intermittently offline primary workstation, multiple independent projects, and remote clients/compute workers; broad ML coverage with additional built-in LLM/agent tooling. Primarily a personal tool that is also published as open source  
**Reference platform:** Linux with systemd (developed on Omarchy/Arch Linux). No container runtime is required or used  
**Status:** Living specification; unimplemented design proposals are described as requirements or planned interfaces, not existing functionality.

## 0. Executive summary

**AblationKit** is a local-first, agentic workspace for machine-learning experimentation with **two equally supported entry points**: (1) a **researcher-first, UI-orchestrated workflow** (the primary personal workflow), in which the researcher supplies a goal, spec file, or annotated conversation link, configures a plan and autonomy, and launches a coding agent from AblationKit; and (2) an **agent-first workflow** initiated in Claude Code or Codex, where agents use AblationKit Skills/CLI/MCP for research orchestration and share the same persistent workspace state. It gives an individual researcher a persistent, understandable view of code, hypotheses, experiments, results, visual explanations, and related conversations across independent repositories.

The platform is **installed centrally**, not copied wholesale into each ML project. It supports researcher-agent-authored project extensions that may combine sandboxed React/TypeScript UI with **isolated Python computation** (such as evaluators and analyzers), as well as full coding-agent modification of the platform source, supported by extensive developer documentation. A **single primary workstation operates the authoritative AblationKit coordinator**, but may be shut down or disconnected; remote execution is designed to continue independently when the target/provider permits. Other computers connect as browser/Electron/CLI clients or as execution workers. Agent Skills invoke a shared Bun/TypeScript CLI/API, while lightweight Python SDKs support ML projects. All remote access must be authenticated and use a private tunnel or equivalently secured endpoint.

**MLflow is the canonical, backend-only ML lifecycle backbone.** It provides experiment/run tracking, dataset inputs, logged models, evaluation results, Model Registry, model packaging, reproducible MLflow Projects execution, and model serving for **research-oriented inference, comparison, and demos**, plus (for LLM/agent projects) GenAI tracing, evaluation, and prompt management. **The AblationKit frontend is the sole intended researcher-facing interface for all declared core ML workflows from the first public release.** The Bun API layer integrates MLflow REST APIs with a narrow Python operations bridge where the REST surface cannot perform Python-side evaluation, model loading/serving, MLflow Projects execution, or artifact serialization. Do not embed or require MLflow's stock UI. AblationKit separately owns project registration, research knowledge, hypotheses, conversations, agent activity, console logs, authorization, job orchestration, deployments' operational state, and interactive extensions.

**T3 Code is the primary UI-initiated coding-agent control layer, not AblationKit's research database or a replacement coding harness.** The Bun coordinator uses a version-pinned, typed T3 Code WebSocket RPC adapter to open/steer/observe provider threads on the chosen execution environment and correlates their IDs with AblationKit tasks and campaigns. T3 Code manages provider sessions and conversation/checkpoint state; Claude Code and Codex remain the executing harnesses. The UI must validate provider availability, skills, permissions and tool access in the selected agent environment **before launch**. An adapter fallback for agent-first CLI/MCP invocation (and optionally direct SDK integration) preserves access when T3 Code is unavailable or its RPC contracts change. All app requests go through AblationKit's backend, not directly from a sandboxed UI extension into T3 Code.

**The agent workspace has two switchable views over one T3-backed conversation session.** A compact, research-oriented activity timeline is the default; an expanded native AblationKit conversation view shows available user/assistant messages, tool activity, diffs, approvals and turn controls from that same bound T3 thread. Both use the same server-side adapter, authorization, session identity and event stream, not separate agent instances or duplicated turns. AblationKit may retain concise activity/evidence projections in JSONL; T3 remains authoritative for provider transcript/session history. Offline, unsupported and partially recoverable conversation states must be labeled honestly.

**Configurable autonomy and independently configurable project source-control permissions are first-class product capabilities.** A researcher can run the same project in Review, Implement, Explore, or Autonomous Research mode. Each mode is a preset for project/campaign-scoped permissions, research scope, approval gates, budgets, and stopping conditions—not a distinct LLM or a homegrown coding-agent runtime. AblationKit integrates the current Claude Agent SDK and Codex SDK/app-server interfaces through versioned adapters, while a small research control plane provides campaign planning/ledger, scientific evidence gates, safe isolated worktrees, MLflow-linked comparisons, durable execution and researcher oversight. High autonomy means fewer interruptions **within an explicitly granted envelope**, not permission to bypass protected-file, credential, external-network, compute-cost, release/publish or data-egress controls. A workstation shutdown does not imply the live coding agent survives; only independently supervised, explicitly delegated remote workloads can continue offline.

**Decisions through v0.14:**

1. **Workstation coordinator, intermittently available.** Exactly one workstation coordinator is authoritative for research and tracking state. Remote compute runs independently of its availability where the provider permits. Workers persist status/events/artifacts and reconcile after reconnection; commands requiring the coordinator are unavailable while it is offline. Automatic multiple-master synchronization is out of scope.
2. **JSON-first AblationKit, MLflow-managed tracking store.** AblationKit's own research/state is JSON, JSONL, Markdown, and files, without an application SQL database. MLflow's current recommended backend is SQLite or another SQL store: a single, MLflow-managed SQLite file on the coordinator is an accepted implementation detail, not a reason to reimplement MLflow tracking.
3. **Conversation links and notes.** ChatGPT/Claude links and annotations belong to projects. No automatic ingestion/sync in the initial release.
4. **Agent-authored interactive UI.** Researchers approve project-scoped React/TypeScript views. Build and runtime isolation and a limited capability bridge are mandatory from the beginning.
5. **Explicit ownership.** Job state and research notes belong to AblationKit. Experiment metrics/parameters, tracked ML artifacts, and model registry records belong to MLflow. Do not create a second canonical tracking store. Event spools may temporarily hold data awaiting MLflow ingestion.
6. **All core ML workflows in scope.** Initial release includes AblationKit-native interfaces for MLflow Tracking, Logged Models, Model Registry, dataset lineage, model evaluation, MLflow Projects, model packaging/loading, local inference serving/testing, system metrics, and MLflow GenAI tracing/evaluation/prompt management. Project use of any individual capability remains optional; a run needs neither registration nor serving. No MLflow stock-UI handoff.
7. **Offline coordinator recovery.** Workers preserve remote job identity, track local job completion and deferred uploads, and can reconcile safely after the workstation returns. Remote inference deployments, like training jobs, survive coordinator downtime only if hosted on independently supervised infrastructure. Local inference serving stops when the workstation shuts down.
8. **MLflow scope means a declared, tested lifecycle contract.** Complete *core ML research* does not mean cloning every MLflow administrative page, hosted AI gateway, third-party deployment plugin, or future upstream feature. Explicit first-release coverage and tests are defined in sections 5.5–5.6 and 15.
9. **Research-first inference is mandatory.** AblationKit's initial release supports one-shot prediction, independently supervised interactive inference sessions, tracked batch evaluation, side-by-side model comparison, and agent-authored interactive demos. Persistent, internet-facing production deployments are not a first-release priority. Inference is optional for any given ML run, but these platform workflows must be functional.
10. **Broad ML support with LLM-focused conveniences.** The tracking, evaluation, registry, execution, inference, reporting, and extensibility contracts apply to new or established architectures in every ML domain. The product provides deeper built-in tools for LLM and agent research (traces, prompt comparisons, golden sets, RAG/tool diagnostics), but these are conveniences layered on a research-agnostic core—not assumptions about how a model works.
11. **Architecture research is first-class, not hardcoded.** Researchers must be able to modify tokenization, model structures, training objectives, data representations, and evaluation methods without adopting an AblationKit-defined model architecture or a particular paper's workflow. The core captures configuration, code/data lineage, metrics, artifacts, and comparisons; agents supply project-specific domain knowledge, experimental procedures, and visualization extensions. The platform does **not** embed a particular paper, architecture, tokenizer method, or research approach as a built-in feature.
12. **Two first-class customization levels.** Level 1 is project-scoped, versioned **small extensions**: interactive React/TypeScript UI, reports, adapters, narrowly authorized actions, and **custom Python evaluators/analyzers/compute tools**, primarily written by the research agent. UI executes in an isolated browser context; Python executes in a separately supervised, OS-sandboxed worker with explicit capabilities, resource limits and dependency lock. Neither executes as unrestricted code in the Bun coordinator. Level 2 is **full source-code customization**: a coding agent may edit the AblationKit monorepo itself, rebuild, test and operate a modified distribution. Extensions use stable public contracts; source changes may alter internal implementation and therefore demand explicit build/test/upgrade responsibility. Neither route requires a new hardcoded research domain in the core.
13. **Documentation is a release requirement.** The repo must provide substantial, maintained, agent-navigable architecture maps, module contracts, examples, build/test instructions, API and extension SDK references, security guidance, troubleshooting, and source-modification playbooks. Root `AGENTS.md` and `CLAUDE.md` orient coding agents but defer detail to versioned docs rather than becoming giant instruction files.
14. **Python-backed Level 1 extensions are required.** Approved extensions may run custom Python analysis, evaluators, data processing, or visualization-data preparation in independent worker sandboxes, optionally paired with a UI contribution. They cannot be imported into the coordinator or obtain unrestricted project, network, shell, or MLflow access; the host must enforce project-scoped input/output and permission contracts.
15. **Autonomy policy presets, enforced centrally.** Review, Implement, Explore, and Autonomous Research are selectable at the project task/campaign level; users may separately configure read/write scope, tool access, experiment count, agent-token/time/compute budgets, parallelism, approvals, and stop conditions. Presets are not security boundaries by themselves; the coordinator and worker/agent sandbox enforce a signed/versioned capability envelope. Protected branches, secret/data access, publication, destructive operations and policy escalation need explicit authorization.
16. **Current coding harnesses, narrow research orchestration.** UI-launched work uses T3 Code as the coding-agent controller over Claude Code/Codex; for agent-first or optional direct/headless adapters, use their available Skills, CLI/MCP and SDK/app-server interfaces. Do not reimplement a second generic agent runtime. AblationKit adds only domain-specific state, experiment selection/measurement/provenance, reviewable branch lineage, scientific validation, cost controls, approval routing, and optional search strategies. Default to one capable coding agent; optional parallel worktrees/tree search are benchmarked rather than mandated.
17. **Autonomous research is auditable and interruptible.** A research campaign records its objective, hypotheses, baseline, controls, evaluation protocol, constraints, independent branches, actions, MLflow run links, decisions, negative results, budget consumption and evidence-backed conclusion. Pause/stop/steer and progressively reduced autonomy work without destroying research history; substantive policy changes require researcher consent. Offline delegated work is restricted to preauthorized bounded jobs, not unlimited remote self-expansion.
18. **Source-control and deployment permissions are independently configurable per project (v0.12).** The researcher separately grants experiment execution, commits in agent-owned branches, pushes, merges/integration, and deployment actions. Review/Implement/Explore/Autonomous Research remain presets and never silently expand those rights. Coordinator-owned, versioned JSON is authoritative; Git-tracked project files may *request* policy but cannot grant privileges. Merges can be individually approved or (if explicitly configured) automatically accepted after verified checks, while protected/public destinations retain stronger gates. Every action is reauthorized against the effective project/campaign policy and recorded with provenance. When the coordinator is offline, no newly privileged source-control or deployment actions are accepted by default.

19. **Dual entry points, UI-first personally.** Researchers may start from AblationKit with a spec file, manually linked conversation plus researcher-provided context, or a freeform goal; they may also start in Claude Code/Codex using AblationKit Skills and CLI/MCP. Both lead to common project/task/run/campaign objects. UI-to-agent dispatch goes through an AblationKit-managed T3 Code RPC adapter; external agent sessions use the available CLI/MCP integration rather than requiring every action to originate in T3 Code.
20. **Verified agent environment.** Before a UI-launched task, the coordinator checks the *specific T3 environment, provider instance, workspace and session* for provider readiness, authentication, required skills and versions, commands/tools, configured MCP endpoints, access scopes, repository mapping and effective policy. Missing requirements yield actionable diagnostics and a consented repair plan, not silent skill installation or automatic full-access escalation. Re-check after environment/provider/session changes.
21. **T3 Code is an integration dependency, not authority for scientific state.** AblationKit owns the experiment spec, scientific plan, campaign, evidence/MLflow run references, permissions and cost ceilings; T3 owns the provider thread and provider-native session state. Store correlated IDs and event cursors. Pin/test upstream RPC contracts and handle gaps by explicit unsupported state or approved fallback, not invented method names.
22. **Two views, one conversation (v0.14).** The compact activity view is the default; expand it to a full, native T3-backed conversation interface without launching another session or losing the active task, thread, streamed output, input draft or pending approvals. Collapse preserves continuity. Actions in either view go through the same coordinator permission gates, and research activity is a derived evidence-linked projection—not a second chat transcript. Both views explicitly degrade when a thread is unattached, offline or lacks provider event/history capabilities.

23. **Trust model without containerization (v0.16; normative).** AblationKit does not use containers. Agents, jobs and extensions run as the researcher's Linux user. Permissions are enforced by AblationKit's own gates, by the coding agents' provider-native sandboxes configured from the effective policy, by server-side Git host rules, and by a physical-presence passkey for privileged writes. Every control is labeled in the UI as **enforced** or **advisory**, and the spec never claims isolation that does not exist. See section 7.11.
24. **Three authenticated APIs (v0.15).** The coordinator exposes a human API (session plus passkey step-up for privileged writes), an agent API (per-task tokens, no policy or approval-resolution routes) and a worker API (per-job upload-only tokens). Remote clients connect only over Tailscale.
25. **Agents run on the host in worktrees (v0.16).** One T3 Code server on the workstation runs Claude Code and Codex in per-candidate Git worktrees. AblationKit generates each session's provider sandbox and permission settings (write scope, network, denied commands such as `git push`) from the effective policy.
26. **Git broker for push and merge (v0.16).** Agents commit in worktrees; pushes and merges go through the coordinator's Git broker, which checks policy, SHAs and tests. Because agents run as the researcher's user, a direct push is prevented by the provider sandbox (where enabled) and protected branches are guarded server-side by GitHub rulesets; local-only repositories are labeled "advisory".
27. **Entity naming (v0.15).** The AblationKit planned comparison formerly called `Experiment` is renamed **`Study`** to avoid collision with MLflow experiments. A project maps to exactly one MLflow experiment (`ak/<project-id>`); see section 6.1.
28. **Coordinator-authoritative research records (v0.15).** Hypotheses, approaches, notes, reports, decisions and conversation references are canonical in coordinator state. `.ablationkit/research/` and `.ablationkit/conversations/` in the repository are exports written by the coordinator to the main checkout for the researcher to commit; copies inside agent worktrees are ignored. Agents write research records only through CLI/MCP.
29. **Plan-first dispatch (v0.15).** Implement, Explore and Autonomous Research tasks begin with an agent plan turn that the researcher approves (switchable off per task). Review tasks skip it.
30. **All features in v1.0 (v0.15).** There is no reduced first release. Section 14 phases and the staged build plan describe build order only.

## 1. Problem, vision, and scope

ML research is fragmented across repositories, training processes, terminals, model artifacts, notebooks, papers, agent conversations, and ad hoc notes. Coding agents can change code and run jobs, but their actions, motivations, observations, and durable conclusions often remain difficult to reconstruct.

AblationKit acts as a **research control plane**, not as a replacement for existing coding agents, ML libraries, IDEs, or schedulers. It should:

- Make agent work inspectable: show proposed approaches, source changes, running jobs, failures, results, and succinct evidence-backed summaries.
- Allow the researcher to choose **how independently an agent operates**: inspect only, implement one task, explore alternatives, or autonomously iterate; configure experiment, commit, push, merge and deployment permissions **separately per project** rather than collapsing them into a single autonomy level.
- Preserve **research continuity** across sessions, machines, and experiments, including negative results and abandoned approaches.
- Make capabilities **portable across unrelated ML projects** while retaining the dependencies, datasets, and source code owned by each project.
- Help agents and humans understand complex systems using agent-created interactive visualizations and project-scoped extensions, while also enabling coding agents to modify AblationKit itself using authoritative architecture/developer documentation.
- Enable experiments to run locally or on remote compute through an increasingly capable set of adapters.
- Continue to serve research context locally while the workstation is running without Internet; when the workstation is shut down, remote workers continue autonomously if supported and buffer experiment data for later reconciliation.

### 1.1 Initial non-goals — infrastructure and unrelated product surfaces only

**Do not treat tracking, model evaluation, registry, model serving, MLflow Projects, or GenAI evaluation/tracing as non-goals.** They are now required product capabilities. The following remain outside the initial release:

- Team collaboration, multi-tenant services, organizational RBAC, or a cloud account required for basic use.
- Replacing Git, PyTorch, Hugging Face, upstream MLflow, SLURM, or a cloud provider scheduler; integrate through supported interfaces instead.
- Automatic multi-master synchronization of coordinator state between offline computers.
- Automated ingestion/synchronization of private ChatGPT or Claude chat histories; manual links and notes remain the chosen product behavior.
- Unrestricted execution of agent-authored UI code in the privileged application shell.
- Operating a general-purpose distributed cluster scheduler or guaranteeing unattended execution on ephemeral Colab runtimes.
- Building a production inference platform with public persistent endpoints, autoscaling, traffic splitting, SLAs, production authentication/tenant quotas, or every third-party MLflow deployment plugin. Also excluded: MLflow server-administration screens, AI Gateway administration, and **every future upstream MLflow feature** automatically. These exclusions must not limit local inference, repeatable research comparisons, interactive demos, model registry, or the other required ML workflows.
- A second custom experiment tracking database or an AblationKit-owned SQL research store; MLflow may maintain its own SQL-backed tracking metadata.

**Usage is opt-in per experiment, availability is not:** a researcher may run a training experiment without creating a registered model, using `MLproject`, or launching a serving endpoint. Those workflows must nevertheless be accessible when needed.

## 2. User experience

### 2.1 Application modes

**Coordinator / browser mode:** `ablationkit ui` starts the authoritative Bun service on the main machine. Local web access defaults to loopback (`127.0.0.1`). The coordinator manages research records, remote workers, job state, MLflow lifecycle, and UI APIs.

**Desktop mode:** Electron packages the same frontend and connects to a managed local Bun coordinator or an authenticated remote coordinator. Electron's main process uses its embedded Node.js runtime; Bun is a distinct managed process. The renderer gets no unrestricted OS/Node/Bun access.

**Remote client mode:** Another laptop/desktop connects to the workstation coordinator (when online) through a private network tunnel (such as WireGuard/Tailscale) or a hardened authenticated HTTPS gateway. Remote browser/desktop/CLI access goes through the Bun API; raw project-file shares and exposed MLflow server ports are not assumed. All project paths on the coordinator are server-resolved.

**Remote worker mode:** A compute machine receives a fully staged, self-sufficient run bundle and scoped job identity before launch; its own supervisor or provider scheduler keeps the job alive independently of coordinator connectivity. Events and output are first written to durable worker-local storage. During a workstation shutdown, the worker completes or fails locally and preserves terminal state and artifact manifests. On reconnection it authenticates, reports status, and resumes checkpointed uploads. Live monitoring and cancellation from the UI cannot be guaranteed while offline. Worker jobs are not guaranteed to survive Colab idle eviction, cloud termination, or exhausted storage.

The initial product has **one authoritative coordinator, not two independently writable installations**. The workstation is **not required to stay online for a supported remote job to complete**; it is required to inspect or control that job through AblationKit in real time. Git can transport project-owned research records to separate clones, but not live runtime state. Explicit coordinator migration/backup-and-restore is a future supported operation, not active-active replication.

### 2.2 Navigation

**Project-aware information architecture (v0.8):** every project sees the same universal research, runs, datasets, model registry, evaluation, and artifact capabilities. Projects can declare `task_profiles` such as `llm`, `rag`, `agent`, `computer_vision`, `tabular`, or `other`. This only selects default tabs, schemas, adapters, and starter visualizations; it does **not** remove any core capabilities. The platform remains domain-agnostic and supports arbitrary project-defined model and training code; additional native LLM/agent workflows provide convenience rather than architectural constraints.

**Information architecture (v0.15; normative).** Navigation is organized by research activity, not by MLflow object type. The capability list below is an inventory; every item is reachable from this structure.

| Layer | Item | Contains |
| --- | --- | --- |
| Global | Home & Inbox | Projects, recent updates, running jobs, worker availability; the attention inbox (pending approvals, budget exhaustion, `reconcile_required`/`sync_failed`, blocked preflight, extension approvals) |
| Global | Agents & Compute | T3 agent environments, provider readiness, compute targets and workers |
| Global | System | MLflow sidecar health, delivery backlog, offline reconciliation, backups/restore, build and modified-build info, safe mode |
| Global | Settings | Machine-wide preferences, SDK versions, authentication (passkeys/TOTP), notifications |
| Project | Overview | Goal, baselines, priorities, latest findings, active tasks |
| Project | Tasks | Task/campaign list; the **New task** flow (formerly Experiment Studio) is a primary button on every project page; the task workspace holds plan, diffs/branch graph, approvals, budget, evidence and report |
| Project | Knowledge | Hypotheses, approaches, notes, reports, decisions, conversation links |
| Project | Runs | Studies and MLflow runs, comparison and ablations, jobs and console logs, launch dialog with `MLproject` entrypoints |
| Project | Data & Evals | Datasets and lineage, classical and GenAI evaluations (one page), golden sets |
| Project | Models | Logged models, registry, Inference (one page with one-shot / session / compare modes), demos |
| Project | LLM | Prompts, traces, playground, RAG and tool-call diagnostics; shown by default only for `llm`/`rag`/`agent` task profiles, otherwise under "More" |
| Project | Project settings | Agent permissions, autonomy defaults, extension management (approve/diff/disable/rollback), task profiles, retention/redaction, project compute targets |

**Persistent elements:** an **agent dock** beside every project page (compact Research Activity; expanding it switches the main area to the full Conversation view per section 2.4); a header badge for the **attention inbox**; a **status bar** (coordinator/MLflow/T3 health, offline and sync state, active coordinator, modified-build indicator); a **lineage strip** on every object page showing the section 6 provenance chain with explicit gaps; and a **command palette** mirroring the CLI. Extension contributions render in context (run tabs, panels, report blocks), not as a separate destination.

**Progressive disclosure:** task profiles choose what is visible, never what exists; Registry, Demos and Inference collapse under "More" until a project has a logged model; the New task flow defaults autonomy, permissions, budget and environment into a one-line editable summary and interrupts only for blocking preflight findings; each object shows one primary status badge with the full task/campaign/agent/compute/sync breakdown on demand; policy JSON, raw IDs, event logs and manifests sit behind "Details".

**Capability inventory:**

- **Home:** registered projects, recent updates, current runs, machine and worker availability.
- **Project overview:** goal, repo path, baselines, current research priorities, latest findings.
- **Research:** approaches, hypotheses, architecture/training changes, experiment plans, notes, results, decisions, reports.
- **Experiment Studio / New Research Task:** first-class UI creation from a written goal, uploaded spec/requirements file, existing project note, or annotated external conversation URL. Define intended outcome, success criteria, baseline, evaluation and budget; preview the normalized context package and hand it to a selected Claude/Codex provider through T3 Code after environment preflight. The result is an AblationKit task/campaign, not merely an untracked chat message.
- **Agent & Campaign Center:** start a scoped review/implementation/exploration/autonomous campaign *from either the UI or an agent entry point*; default to a **compact Research Activity view** for objective, milestones, agent state, evidence, diffs, approvals and budgets, with an **expandable, full T3-backed Conversation view** of available user/agent messages, tool activity, file changes and turn controls. These are two projections of one agent thread/session—not separate conversations. Inspect experiment lineage and show the exact effective permission envelope and reason for blocked/approved actions.
- **Agent Environments:** select a T3 Code environment, provider instance/model and repository/worktree mapping; see actual provider health, login/readiness, skills inventory, tools, MCP connections, version compatibility, permissions, remediation and last verified timestamp. Never treat installed binary presence alone as proof of agent readiness.
- **Project → Agent Permissions:** configure project-specific experiment, commit, push, merge and deployment rules independently, preview resulting permissions for each autonomy preset, view approved target branches/environments and required checks, and review the source-control/deployment audit history.
- **Experiments / Runs:** native AblationKit UI for MLflow experiment management, run search/filter, parameters, tags, metric history, comparisons, dataset references, status, console output, provenance, and artifacts.
- **Datasets / Evaluations:** dataset identities, input versions, splits, classical evaluation results, saved diagnostic plots, baselines, and validation thresholds.
- **Models / Registry:** logged models, registered model versions, aliases, lineage, metadata, packaging environments, and download/load actions using MLflow APIs.
- **Projects / Entrypoints:** inspect or run declared `MLproject` entrypoints, parameters, and environments alongside native AblationKit command adapters.
- **Inference Lab:** select pinned models; run one-off or repeated predictions; inspect model inputs/outputs, latency, example-level disagreements, and inference errors; compare candidates side-by-side on identical examples.
- **Evaluations & Comparisons:** execute tracked batch evaluations on versioned datasets, inspect aggregate and per-example results, compare baselines and candidates, and save analysis evidence.
- **Demos:** launch, save and manage approved agent-authored interactive model demonstrations with project-scoped capabilities.
- **Serving / Sessions:** start/stop supervised short-lived local model sessions, inspect readiness/logs/resource use, and optionally target a supported independently supervised remote worker. Persistent public deployments are not the initial focus.
- **LLM Research Lab (prioritized):** prompt playground and version diff; model/prompt/config comparisons; full span and tool-call trace drill-down; golden evaluation datasets; RAG retrieval inspection; example-level quality and cost/latency analysis. These are specialized views over the same MLflow-backed core.
- **Traces / Prompts:** MLflow GenAI trace explorer, evaluation runs/datasets, scorer results, and prompt versions for LLM/agent projects.
- **Extensions / Visualizations:** installed project-scoped views, panels, report widgets, adapters and permitted small actions; permission review, version history, previews, disable/rollback, interactive diagrams, and report snapshots.
- **Conversations:** manually organized references to ChatGPT, Claude, Claude Code, Codex, and other sources, with notes and tags.
- **Settings:** project locations, SDK versions, compute targets, API permissions, backups, extension approvals, compatibility diagnostics, and locally modified build information.

The UI must show **what the agent proposed, what it actually changed, what ran, and what the evidence supports**, without implying access to hidden reasoning. **Collapsing or expanding the agent panel is presentation state only:** it must not create a new provider session, resend the current task, duplicate approval requests, or silently lose an unsent message draft. It must show clearly whether a task was UI-launched through T3 Code, agent-launched through CLI/MCP, detached, or awaiting an environment repair. A T3 thread is not automatically identical to a scientific experiment: an agent may use multiple turns or threads per task and create multiple MLflow runs.

### 2.3 Primary UI-first research flow and agent-first parity (v0.13; normative)

**UI-first workflow (preferred for the individual researcher):**

1. Open a project and choose **New task**. Provide a freeform research idea, upload/attach a specification file, select a project-owned note, or paste an external ChatGPT/Claude conversation URL with a researcher-written summary or excerpts. A URL is a *reference*, not proof AblationKit can read the conversation; it must not scrape private chat pages or assume browser cookies. The researcher may explicitly provide the complete relevant content via a file or text attachment.
2. AblationKit creates a durable `ResearchTask`/draft `ExperimentSpec`: objective, source references and content hashes, scope, constraints, evaluation/acceptance criteria, repository revision, budget, and provenance. A structured intake is helpful but a natural-language goal must be sufficient to begin drafting. The researcher can review/edit the normalized task before dispatch.
3. Choose autonomy preset and separately constrained project permissions; select provider/model, T3 Code environment, worktree and target compute. The UI runs **Agent Environment Preflight** and displays blocking versus advisory findings.
4. On authorization, the coordinator creates a task dispatch record with an idempotency key, opens or resumes an appropriate T3 thread, sends the contextualized task/goal, and records returned environment/project/thread/turn references. The coordinator is responsible for submitting work **once**, reconciling acknowledgments after reconnect, and never silently duplicating a turn or training job.
5. Stream visible agent messages, action summaries, proposed changes, approvals, tool results, validation and MLflow-linked jobs into a unified project timeline. T3 Code remains the source of provider session state; AblationKit is the source of the task, research/campaign state and evidence. The researcher may steer/pause/approve using the same policy gates as in the agent-first path.
6. The agent uses AblationKit Skills and authorized CLI/MCP tools to register hypotheses, proposed experiments, executions, results and reports. At completion the researcher sees an evidence-linked outcome, exact source changes and remaining unknowns, rather than a chat transcript treated as proof of success.

**Agent-first workflow (equal capability):** a researcher starts Claude Code or Codex in an existing repository, invokes a portable AblationKit Skill/CLI/MCP tool, and creates/links the same task/campaign and run entities. Where the underlying agent's session can be imported/attached through T3 Code, surface it as a linked thread; otherwise store a session reference or event summary and explicitly mark chat streaming unavailable. Do **not** require a duplicate T3 session or rewrite existing conversation history.

**Context packages:** include only authorized source material and file references, with size limits, path validation and clear evidence of what content was actually delivered. Untrusted external text (chat excerpts, papers, repo content) is task data, not authority to change permissions. Protect secrets and private data before forwarding to provider contexts.

### 2.4 Dual-mode agent panel: Research Activity ↔ Conversation (v0.14; normative)

**Interaction requirement:** the agent panel has a compact **Research Activity** presentation (default) and an expandable **Conversation** presentation. Both read the same task-to-T3 thread bindings, authorized backend events and current provider state. Switching views is instant UI navigation, **not** a new thread, turn, copy of conversation, or alternate agent execution path. The panel is available inside a project/task workspace; its selected state can be remembered per project or local client.

**Compact Research Activity view (default):**

- Top line: task/goal, provider/model, active environment/worktree, agent and scientific status, autonomy mode, remaining approved budget and last event time.
- An understandable research timeline: proposed plan or hypothesis, important code changes/diffs, launched/completed/failed MLflow-backed experiments, validation results, notable findings, reports and pending researcher decisions, with exact evidence links.
- A lightweight agent status strip: currently responding, running a tool, waiting for permission, disconnected, paused, or complete, with honest uncertainty and an optional expandable log/detail drawer.
- A short follow-up/steer input and safe actions (approve/deny, interrupt, pause/stop when supported). These invoke the **same session** and gates as full Conversation mode. A pending approval cannot disappear simply because its view is collapsed.
- Prefer concise, *observable* summaries derived from T3-visible messages/tool events and AblationKit research records. Do not invent internal reasoning, claim a hypothesis has been tested when only proposed, or replace evaluation evidence with an agent's success claim.

**Expanded full Conversation view:**

- Show the accessible T3/provider thread history: human and assistant messages, streamed message deltas/final text, visible tool invocations/results, approval requests/responses, attachments and linked source diffs, with appropriate markdown/code rendering and event timestamps.
- Support sending follow-up turns, steering within provider-supported semantics, interrupting, responding to approvals, and navigating related threads under the same research task. Unsupported provider actions must be disabled with an explanation rather than emulated through unsafe RPC calls.
- Keep research context alongside chat (optional split pane or linked sidebar for plan, run IDs, MLflow results, notes and diffs). Conversation mode must never become the sole source of research truth.
- Support multiple T3 threads per research task; label provider, environment and worktree for each. Switching which *thread* is selected is explicit and separate from toggling compact/full presentation.
- Do not expose provider-internal hidden reasoning, raw credentials, or inaccessible historical messages. If T3/provider supplies a redacted or partial transcript, label it **partial**; distinguish provider-authored text from AblationKit's generated research summaries.

**Shared interaction semantics:**

- Both views use one conversation gateway and one set of active thread/turn IDs. Composer drafts, scroll position, active selection, subscription position and pending approvals survive a view toggle where practical; drafts are local/private until explicitly sent.
- Route message submissions and approval decisions **UI → authenticated Bun coordinator → authorized T3 adapter → T3 provider session**. Do not allow a browser, Electron renderer or extension to call privileged T3 RPC directly. Reject stale approvals and scope-changing actions after revalidating the effective project policy.
- When another client or panel submits concurrently, show authoritative turn/approval state and use an operation ID to avoid double submission; a second turn during active execution is either queued under explicit supported semantics or rejected with an actionable message—not injected silently.
- Distinguish a chat turn completing, an AblationKit research task completing, and an MLflow experiment passing evaluation. Compact milestones and full chat messages link to shared task/run/evidence IDs without pretending these objects are 1:1.
- While disconnected, show the last verified activity and an explicit reconnect state. On reconnect, rehydrate from T3 snapshots/cursors where supported; if history cannot be recovered, display a gap marker rather than fabricating messages. Offline message drafts can be preserved locally, but must **not auto-send** when connectivity returns.

**Scope boundary:** This is an AblationKit-native UI implemented over T3 Code's RPC/session data. Reusing upstream T3 UI components is optional, contingent on license/compatibility/security review; **embedding the T3 web app, maintaining a second chat backend or displaying the stock T3 application is not required**. The actual fidelity is limited to capabilities exposed by the pinned T3/provider contracts and must be validated in integration tests.

## 3. Portable platform architecture

```text
        Researcher                                 Researcher
  AblationKit Browser / Electron             Claude Code / Codex terminal
    New task / spec / chat link                AblationKit Skill / CLI / MCP
               |                                         |
          Bun coordinator: authoritative research control plane
       Task intake / campaign / permission gates / experiment IDs
               |                                         |
     T3 Code RPC adapter (WS)                        CLI/MCP API
               |                                         |
       T3 Code server (provider sessions, thread/turn events)
               |                                         |
       Claude Code / Codex agent <------------------ agent-first path
               |
         Shared AblationKit tools / environment preflight
               |
       Local/remote experiment execution + collector + spool
               |
        MLflow tracking, registry, evaluation, models/artifacts
               |
       Bun research API -> unified UI and durable reports

Main workstation: AblationKit coordinator + MLflow + T3 Code
T3 agent environments may be local or remote; filesystem, credentials,
provider processes and skills are checked on the selected execution host.
Remote compute jobs can continue while the workstation is offline when
independently supervised; new T3 turns do not continue without a T3 host.
```

### 3.1 Shared install, separate projects

The **AblationKit installation** contains CLI, backend, UI, Agent Skills, protocol contracts, compute adapters, tracking integration, Python SDK packages, a versioned React-and-Python extension host/SDK with a separate Python worker sandbox, and source-modification documentation/development tooling. It is **installed on the main machine**; other machines may install only an agent CLI or a worker/SDK appropriate to their role.

Each ML project remains an independent repo, containing only a small `.ablationkit/project.json` manifest, optional Git-friendly research records, and optional project-extension source. No project must vendor the AblationKit platform or the MLflow server. An individual project can still use MLflow natively when desired.

### 3.2 Portable agent integration

- User-installable Agent Skills for project inspection, hypothesis generation, experiment planning, execution, analysis, reporting, extension/visualization creation, and research recall; separate coding-agent guidance teaches safe source-level changes to the platform itself.
- **Default UI-initiated path: T3 Code control adapter over authenticated WebSocket RPC.** Let T3 Code own threads, turns, provider selection/sessions, approval interactions and provider-normalized event streams. Implement a small, versioned `AgentTransport` contract inside AblationKit rather than exposing raw upstream message shapes to research logic. Treat T3 Code's current typed RPC as a pinned upstream interface until a stable external contract is guaranteed; inspect its current schemas and smoke-test each supported release, not a historical method list. The adapter must support capability negotiation, create/resume thread, send turn, observe events, respond to approvals, interrupt/stop and reconnect where the installed version actually provides these features.
- **Agent-first path: portable Skills and CLI/MCP.** A user starting directly in Claude Code/Codex can register and control scientific tasks through AblationKit without T3 Code in the execution path. T3 Code's external-agent MCP/host CLI may optionally attach to existing sessions where supported, but is not necessary for AblationKit research object parity.
- **Fallback/direct drivers:** existing Claude Agent SDK and Codex SDK/app-server adapters remain optional compatibility or headless fallbacks, not the default UI-initiated integration. Capabilities must be feature-detected and tested; do not assume agents expose identical methods or that a crashed session resumes exactly in place.
- **No redundant general-purpose agent loop.** Let the existing coding harness manage code navigation, editing and tool interactions. AblationKit manages scoped research campaigns, approval policy, experiment identities, cost budgets, evidence gates, branch comparisons and optional research strategies.
- Stable `ablationkit` CLI, with optional MCP tools; both connect to coordinator APIs and use the same permissions and IDs as the UI.
- Agents may run on the coordinator or a remote client. The coordinator interprets project paths and execution target configuration, not the remote client.
- Load only relevant skill references and project research context, avoiding a giant always-loaded instruction file.
- Agent action proposals, approvals, and executed results remain distinguishable.

### 3.3 Core services and data ownership

**Bun coordinator:** dual-view agent conversation gateway, presentation-independent thread/turn event projection and UI task intake with T3 Code session-link mapping; project registry; research records; conversation references; agent activity; job submission/attempt lifecycle; run/worker mapping; stdout/stderr and diagnostic event stream; private API gateway; sandboxed versioned extension management and a typed broker for supervised extension Python workers; SSE for live UI; secure remote access. The coordinator additionally stores authoritative, versioned project permission policies, autonomy policy revisions and research-campaign state, brokers Claude/Codex adapter sessions and actions, authorizes job/tool invocations against effective scopes, manages approval queues and budget ledgers, and supports pause/resume/steer/stop. An agent-supplied declaration or prompt is never sufficient to authorize privileged execution. A distinct developer workflow supports trusted source builds without granting extension code arbitrary core access.

**MLflow lifecycle backend:** MLflow owns tracking experiments, metrics, parameters, tags, dataset inputs, logged-model records, registry metadata, saved evaluation and comparison results/artifacts, traces, prompt registry data, and MLflow-generated model package metadata. Exploratory inference requests are ephemeral unless explicitly saved; AblationKit owns the UI/session and worker lifecycle without creating a second canonical MLflow run store. MLflow's bundled UI may still ship with upstream software but is **not exposed as a regular user-facing product surface**. AblationKit owns job orchestration and deployment process lifecycle, and exposes the supported MLflow lifecycle workflows through its own frontend. Model evaluation, project execution, and inference serving are performed by isolated Python execution workers or subprocesses, not by arbitrary code inside the Bun API process.

**One writer per domain:** coordinator serializes mutable JSON/JSONL writes. Tracking updates go through MLflow's API, never by editing its SQLite file directly. A retrying outbox/adapter joins the two domains and reports partial delivery explicitly; do not claim distributed exactly-once transactions.

## 4. Shared Python packages and data transport

### 4.1 Shared packages

- **`ablationkit-sdk`** (thin, project-facing Python package): run context, standard `logging` handler, typed event/metric API, artifact declarations, optional epoch/step helpers. It should not require Bun/Electron or a web server inside the project. It can operate in collector mode with no direct MLflow dependency.
- **`ablationkit-protocol`**: minimal versioned Python schemas that match TypeScript API/event contracts.
- **`ablationkit-pytorch`**, optional framework-specific adapters: framework callbacks, custom training loops, checkpoints, MLflow autologging when compatible, model logging, and evaluation helpers. Custom PyTorch models remain usable without conforming to a prescribed architecture or logging flavor.
- **`ablationkit-mlflow`** (project-facing optional Python integration): native MLflow run/model APIs, model signatures/environments, dataset inputs, model validation/evaluation, and GenAI tracing/LLM scoring for projects that opt into these features. Plain SDK mode remains functional without importing MLflow inside every project.
- **`ablationkit-llm`** (optional, provider/framework-neutral helpers): prompt-reference resolution, chat/message input schema, inference metadata normalization, token/usage reporting, trace/run links, offline evaluation hooks, and permissioned RAG/tool-call instrumentation. Native integrations may leverage MLflow auto-tracing, but cannot require every LLM app to use a specific provider or agent framework.
- **Domain adapters** (`ablationkit-tabular`, `ablationkit-vision`, optional task adapters): standard schema/prediction/evaluation/visualization bridges. Keep normal MLflow tracking, registry, and reporting usable even when a richer task adapter is absent.
- **Worker collector**: co-located with the job runner, gathers structured events and stdout/stderr, spools durably, retries authenticated delivery, and reports health.
- **Coordinator MLflow adapter**: maps tracked events into supported MLflow APIs and provides typed lifecycle operations for experiments, models, datasets, registry, traces, prompts, and evaluations.
- **Isolated Python operations bridge**: executes MLflow `run`/model/evaluation/serving functionality not expressible as tracking REST calls, including single-shot `pyfunc` prediction and supervised inference processes, with explicit inputs, subprocess lifecycle, dependency isolation, permissions, timeout, budgets, and structured results. Keep the core coordinator in Bun, not Python.
- **`ablationkit-extension-python`** (optional public Python SDK for project extensions): typed extension context, approved project/run/evidence reads, artifact/result reporting, structured progress, cancellation, and manifest/host compatibility helpers. It does **not** expose privileged coordinator internals or direct MLflow credentials.
- **Python extension runner** (platform-side, distinct from the MLflow operations bridge): launches approved, content-pinned extension entrypoints in an isolated execution environment, brokers scoped inputs/outputs and authorized data operations, and manages cancellation, quotas, logging, and offline-safe recovery for queued jobs.
- **Inference adapters**: type-aware input/output adapters for tabular, text and image-oriented models where supported. The adapter must validate model signatures and explain unsupported flavors and incompatible payload schemas; no promise that an arbitrary checkpoint can be served without the appropriate wrapper and environment.

Existing projects with no SDK still get console logs, job state, and artifacts collected using configured output paths. They may get structured metrics via a file adapter or MLflow-native run integration.

### 4.2 Preferred data flow

```text
Python project / existing train script
    |                         |
    | structured SDK events   | captured stdout/stderr
    +----------+--------------+
               v
         Worker collector
      append-only local spool
               |
          authenticated HTTPS
               v
        Bun coordinator ingest
          |             |
          |             +----> Console + agent/worker events (JSONL)
          |
          +----> MLflow adapter/outbox ----> MLflow Tracking API
                                          metrics / params / tags / artifacts
               |
          SSE + query gateway
               |
       Browser/Electron/agent CLI
```

- Do not duplicate canonical metric history in both AblationKit JSONL and MLflow. A **temporary durable outbox** can retain metric events until MLflow acknowledges them; indexes and UI caches are rebuildable.
- Event envelopes include `schema_version`, `event_id`, `project_id`, `ablationkit_job_id`, `attempt_id`, `producer_id`, producer sequence, timestamp, event type, and typed payload.
- The coordinator creates or associates **one MLflow run per execution attempt**. Logical job ID and MLflow run ID are separate; retries may have fresh attempts and MLflow runs. Keep an explicit persisted mapping and reverse tags.
- The collector should not block training on an unavailable UI or tracking server. It can spool within configured disk limits; flush errors, queue size, and incomplete upload state must remain visible.
- Ingestion is at-least-once. Deduplicate at the AblationKit ingress using event IDs and sequence numbers; MLflow metric logging itself is not a distributed exactly-once transaction. Handle ambiguous acknowledgements/retries and reconcile duplicates where possible.
- The Bun coordinator validates and mediates remote access. **Prefer not to expose MLflow directly to remote workers or custom React extensions.** Direct MLflow SDK mode may be enabled explicitly for advanced autologging, with scoped network/security configuration.
- Artifact bytes travel via controlled upload endpoints / MLflow artifact API or a supported storage proxy, never inline as JSON data. Validate file sizes, paths, checksums, and access to project-owned artifacts.
- UI queries MLflow (via Bun APIs) for every declared lifecycle surface—including registry, evaluation, datasets, traces and prompts—and uses JSONL/SSE for console output, deployment lifecycle and agent activity. Do not assume MLflow itself provides the low-latency multiplexed event stream required by AblationKit's UX.
- Invoke Python-side MLflow operations (model serialization/loading, `mlflow.models.evaluate`, `mlflow.genai.evaluate`, `mlflow.run`, `mlflow models serve`) in dedicated restricted workers with separate dependency environments. These are not generic REST CRUD operations; do not expose arbitrary Python execution through the UI gateway.

### 4.3 Proposed AblationKit APIs

```text
POST /api/v1/projects
GET  /api/v1/projects
POST /api/v1/jobs
POST /api/v1/jobs/:id/attempts/:attemptId/events:batch
GET  /api/v1/jobs/:id
GET  /api/v1/jobs/:id/logs?after=<cursor>
GET  /api/v1/jobs/:id/stream
POST /api/v1/jobs/:id/cancel
GET  /api/v1/tracking/experiments           # MLflow-backed search/pagination
POST /api/v1/tracking/experiments           # Create (with confirmation)
GET  /api/v1/tracking/runs                  # MLflow-backed filter/search
GET  /api/v1/tracking/runs/:id              # Params, tags, status, inputs
GET  /api/v1/tracking/runs/:id/metrics      # Time series / steps
GET  /api/v1/tracking/runs/:id/artifacts    # Browse/download via authorized proxy
GET  /api/v1/tracking/models               # Logged models / registry view
GET  /api/v1/tracking/registered-models    # Registry search and versions
POST /api/v1/inference/predict             # Authorized one-shot prediction
POST /api/v1/inference/sessions            # Start supervised pinned-model session
GET  /api/v1/inference/sessions/:id        # Health, model, resources, idle TTL
POST /api/v1/inference/sessions/:id/predict # Repeat predictions via isolated worker
POST /api/v1/inference/sessions/:id/stop   # Stop and free resources
POST /api/v1/inference/compare             # Same inputs across pinned model versions
POST /api/v1/evaluations                   # Submit tracked batch evaluation
GET  /api/v1/evaluations/:id               # Evidence/results/provenance
POST /api/v1/demos/:id/snapshot            # Explicitly persist approved demo evidence
POST /api/v1/tracking/registered-models    # Register / annotate / alias (authorized)
GET  /api/v1/experiments/:id/runs          # AblationKit + MLflow projection
GET  /api/v1/attempts/:id/metrics          # MLflow-backed projection
POST /api/v1/views/:id/approve
GET  /api/v1/projects/:id/research
GET  /api/v1/llm/prompts                    # MLflow Prompt Registry projection
GET  /api/v1/llm/prompts/:name/versions    # Prompt history/diff inputs
POST /api/v1/llm/playground/infer         # Approved model/prompt + optional RAG config
POST /api/v1/llm/playground/compare       # Same input set, pinned variant specs
GET  /api/v1/llm/traces                   # Filtered MLflow traces
GET  /api/v1/llm/traces/:id               # Nested spans, outputs, resource usage
POST /api/v1/llm/evaluations              # Durable pinned eval dataset/scorer job
GET  /api/v1/llm/evaluations/:id/examples # Per-example errors, feedback, provenance
```

Endpoints are provisional. Enforce scoped authentication, input validation, and explicit errors. Expose a reconciled state such as `tracking_pending` rather than inventing a successfully committed MLflow metric.

## 5. AblationKit file persistence + MLflow-backed ML lifecycle

**No SQL database owned by the AblationKit application.** The goal is readable, portable, backup-friendly research and execution files. **MLflow, as a separate integrated service, uses its recommended metadata backend (SQLite by default)** to provide reliable experiment tracking; the legacy MLflow file backend is in maintenance mode and should not be chosen just to avoid SQLite.

### 5.1 Storage boundaries

**A. Git-friendly project records** under each repository's `.ablationkit/` directory:

```text
my-ml-project/
  .ablationkit/
    project.json
    research/
      hypotheses.json
      approaches.json
      notes/
        2026-11-02-baseline.md
      reports/
        run-abc-summary.md
    conversations/
      references.json
    demos/
      <demo-id>/manifest.json  # Source and capability request; no captured sensitive inputs by default
    extensions/
      model-explorer/
        manifest.json
        src/
          View.tsx            # UI view extension
      result-annotator/
        manifest.json
        src/
          action.ts           # Restricted action extension
    views/                     # Optional legacy/alias location with migration support
```

These files are optional and portable. They contain small structured metadata, human-readable knowledge, and extension **source**, but no credentials, massive logs, caches, or model binaries. Project owners choose what to commit to Git; `.gitignore` templates should exclude generated outputs and secrets.

**Authority (v0.15):** `research/` and `conversations/` are **exports** of coordinator-owned records, written by the coordinator to the project's main checkout (on change or on demand) for the researcher to commit. On project registration an existing export is imported once. The coordinator ignores these files inside agent worktrees, so parallel candidate branches cannot conflict over them or rewrite research history. Extension source and `project.json` remain repository-owned.

**B. Main-coordinator AblationKit data** under the OS application-data directory (examples shown with `~/.ablationkit/` for clarity):

```text
~/.ablationkit/
  registry.json                 # Local paths, endpoint preferences
  state/
    <project-id>/
      runs/
        <run-id>/
          run.json              # Lifecycle + provenance snapshot
          events-0001.jsonl     # Console/lifecycle events; tracking events only in transient outbox
          artifacts/           # Files or pointers
          checkpoints/         # Optional pointers / local outputs
      activity.jsonl
      .cache/                   # Rebuildable indexes/previews
  inference/
    sessions/                  # Bounded JSON session state; TTL / cleanup on crash
    cache/                     # Disposable model cache; never canonical run tracking
  extensions/
    <project-id>/<view-id>/     # Approved compiled bundles
  spools/<worker-id>/           # Retry/outbox and acknowledgments
  tracking-outbox/              # Temporary MLflow delivery queue
  tracking-map.json             # Job/attempt/MLflow run mapping
  mlflow/                       # Managed by MLflow; not a JSON research store
    mlflow.db                   # SQLite by default (managed by MLflow)
    artifacts/                  # MLflow artifact destination
```

Use project IDs, not absolute paths, as stable references. Store machine-specific paths in the local registry. Allow project relocation and remapping without breaking historical IDs.

### 5.2 File-writing contract

- Small JSON snapshots: write a validated temporary file, flush where durability matters, then atomically replace the target on the same filesystem; avoid modifying files in place. Use a backup/recovery strategy for interrupted writes.
- High-frequency data: write **JSONL** append-only events, one complete envelope per line. Use bounded batches, flush policy, sequence numbers, and rotation by file size; detect and quarantine/truncate an incomplete trailing line after a crash.
- **Single writer per AblationKit runtime directory.** The coordinator serializes mutations and owns event appends. Other processes submit changes through its API. MLflow independently manages its database and artifacts via its own API; never edit its storage files directly.
- Schema versions and migration routines are mandatory. Any derived search indexes/cache files are rebuildable from canonical records.
- Do not keep the entire event history in memory. Stream/tail logs, roll up long metric series for chart display, and paginate historical reads.
- Store binary artifacts as ordinary files or remote object references; compute checksums for provenance and integrity.
- Backup/export must capture a consistent snapshot or stop writes briefly; copying active JSONL files without coordination does not guarantee a coherent backup.

### 5.3 Multi-machine behavior (resolved: one coordinator)

- **Main machine:** authoritative Bun server, project registry/research store, MLflow tracking server, MLflow SQLite, canonical artifacts, and active job/worker registry.
- **Remote client:** browser, Electron, CLI, or coding agent connects through authenticated private network/tunnel or HTTPS gateway. Remote clients do not write coordinator data files or need access to the underlying SQLite file.
- **Remote worker:** receives run context and short-lived scoped credentials, runs project code and posts events/artifacts through the coordinator. Workers spool during outages. Upload failures remain visible and retryable.
- **Data placement:** source code/datasets may live on different workers; coordinator stores references, checksums/dataset fingerprints, and staged artifacts but does not automatically replicate full datasets or arbitrary project working trees.
- **Coordinator unavailability:** remote jobs must be able to continue and complete on supported targets without a live coordinator connection, because they are already staged and have a durable worker-side supervisor/spool. New submissions, central monitoring, approvals, and interactive cancellation are unavailable until restoration; provider-native controls may remain available independently.
- **Worker reconnection handshake:** persist `(worker_id, job_id, attempt_id, provider_job_id, launch_token, last_acked_sequence)` locally; on reconnect, authenticate, report latest run state and replay only unacknowledged events. Coordinator reconciles with provider job status where available and must not automatically resubmit an `unknown` run.
- **Terminal-state recovery:** if a job completed during downtime, replay its final status, metrics, logs, artifact checksums/manifests, and upload receipts. Display `awaiting_sync`, `syncing`, `synced`, or `sync_failed` separately from `running`, `completed`, or `failed` execution state.
- **Storage and lifecycle limits:** configure spool capacity, drop/aggregation policy for noncritical logs, backpressure, artifact staging budgets, and retention. Protect final metrics/results and manifest metadata where possible; hard capacity failure must be observable. Remote jobs may be evicted by providers or terminate if their storage/network assumptions are violated.
- Add explicit `backup`, `restore`, and `move-coordinator` workflows rather than active-active replication.
- **No dual masters:** do not sync live SQLite, JSONL, or artifact stores using Git/Dropbox/iCloud as though they were a multi-writer database. Project Git remains suitable for small research documents.

### 5.4 When to reconsider AblationKit JSON storage

Reassess if multi-process/multi-user writes become necessary, research-record queries become heavy, or distributed synchronization requires transactional semantics. A future `ResearchStorageAdapter` may introduce a database **for AblationKit's own records** without changing the SDK, CLI, or API. MLflow's existing database is **not** a research note store and is not a reason to migrate unrelated project documents to SQL.

### 5.5 MLflow lifecycle integration contract

**Primary recommendation:** package a pinned MLflow service as a managed sidecar on the coordinator. For a single-user deployment use the **MLflow-managed SQLite tracking backend plus local filesystem artifact storage**; isolate MLflow data from Git-friendly research files. Version the integration and run migration/compatibility tests before MLflow upgrades.

**Canonical ownership:** MLflow stores experiment/run metrics, parameters, tags, dataset-input metadata, logged model/registry records, model and evaluation artifacts, traces, GenAI evaluation records, and prompt registry records where supported. AblationKit stores research reasoning, job scheduling, endpoint/worker supervision state, UI extensions, conversations and event delivery status. Do not implement a competing canonical store.

**All of the following are first-release requirements, not deferred features:**

| Core capability | AblationKit functional contract | Ownership / integration |
| --- | --- | --- |
| Experiment Tracking | Create/search/update/archive experiments and runs; record params/tags/metrics/system metrics; compare curves and export results | MLflow Tracking APIs and artifacts |
| Datasets and lineage | Capture dataset reference, version/fingerprint, source/split/role; inspect which runs/models used each input | MLflow dataset inputs/lineage + AblationKit provenance references |
| Logged models and packaging | Log/search/retrieve model entities, flavors, signatures, dependencies, environment and downloadable artifacts; load supported models for evaluation/inference | MLflow model APIs, Python bridge for flavor-specific serialization/loading |
| Model Registry | Register and version models, compare versions, inspect lineage, edit descriptions/tags, manage aliases and model selection | MLflow Model Registry APIs |
| Classical model evaluation | Launch evaluation against selected dataset, baseline or model; calculate supported built-in/custom metrics and persist diagnostic plots, tables and validation threshold outcomes | `mlflow.models.evaluate` / validation APIs through isolated Python evaluation worker |
| MLflow Projects | Discover `MLproject` metadata and entrypoints; configure parameters/environment; launch/cancel/monitor runs; map project execution IDs to MLflow runs | `mlflow.run`/CLI in execution worker, integrated with AblationKit runner; not a required project format |
| Research inference and model serving | One-shot predictions, supervised interactive sessions, optional MLflow serving endpoints, model-signature validation, predictions/errors/latency and resource inspection, and research demos; local by default | MLflow model loading/serving via isolated Python workers; AblationKit-owned session lifecycle |
| Model comparisons and batch evaluation | Run identical inputs/dataset slices against two or more pinned model versions; persist paired outputs (when explicitly saved), error slices, metrics, plots, evaluator settings, and provenance | MLflow evaluation/model/metric/artifact APIs + AblationKit comparison workflow |
| GenAI traces | Capture/query traces, nested spans, timing, tool calls, input/output previews with redaction; connect traces to project research entities | MLflow tracing APIs/SDK with UI projection |
| GenAI evaluation and prompts | Inspect/manage evaluation datasets and results, run supported scorers/evaluations, view prompt versions and compare prompt/model results | MLflow GenAI evaluation and prompt registry APIs/SDK |
| LLM-first research diagnostics | Compare pinned prompt/model/retrieval variants; inspect nested agent/tool spans, per-example scorer feedback, RAG retrieval evidence, token/latency/cost fields when reported, and fine-tuning checkpoints/evaluations | AblationKit LLM-specific UI and adapters over MLflow prompt/tracing/evaluation/tracking APIs |
| Provenance and export | Link hypothesis → job → run → dataset → evaluation → model/version → optional deployment and report; export references/results | AblationKit joins to MLflow IDs without copying tracking records as canonical state |

The two MLflow evaluation APIs are **distinct**: classical `mlflow.models.evaluate()` for supported predictive models and `mlflow.genai.evaluate()` for GenAI applications. Do not treat their scorer/metric types as interchangeable. An evaluation can execute on a worker and synchronize results after coordinator reconnect, provided its inputs and environment were staged and storage remains durable.

**Execution independence:** model registration, `MLproject`, model serving and GenAI tracing are **optional actions in an individual project's workflow**, but the AblationKit application must ship an end-to-end UI/API/CLI implementation for each. A basic `python train.py` run must not require these mechanisms.

**Serving scope (v0.6):** first-release serving is **research-first**, with three execution modes: (a) one-shot prediction in an isolated, short-lived worker; (b) repeated interactive predictions using a supervised, resource-capped, idle-expiring model session or local MLflow inference endpoint; (c) tracked batch evaluation against versioned data. Local serving is an implementation detail behind AblationKit's own inference API/UI, not a separate researcher portal. Research workflows must include input preview/validation, outputs, error messages, timing, and save-to-evidence actions. An agent may construct approved demo UIs on top of a tightly permissioned inference capability. Serving processes are separate from Bun/Electron, model artifact loading is treated as untrusted code, and automatic public network exposure is prohibited. Remote inference is allowed through supported workers, but persistent production deployment, autoscaling, routing, and public traffic management are not first-release priorities.

**MLflow Projects scope:** recognize and execute supported `MLproject` entrypoints and environments. Existing `uv`/Python/Docker command workflows remain first-class. Do not force repos to add an `MLproject` manifest merely to log metrics. For remote targets, stage a reproducible bundle and translate the project's entrypoint into the target's job contract where available.

**MLflow-specific GenAI scope:** traces, trace search/comparison, evaluation datasets and runs, scorer results, prompt versioning and associated evidence belong to the core integrated ML experience. Full AI Gateway operation, third-party LLM provider administration, bespoke human-labeling collaboration systems, and future MLflow plugin UIs are not implied automatically. The product must expose a visibly unsupported state if a pinned MLflow version lacks a capability instead of hiding it or silently redirecting to upstream MLflow UI.

**API and security boundary:** React calls only typed AblationKit Bun APIs, not raw MLflow endpoints. Prefer version-pinned official MLflow REST APIs for data queries/mutations; use narrowly scoped, subprocess-based Python SDK operations when required (Projects, model serialization/evaluation, serving, some GenAI functions). Validate inputs, paths, model sources, output types, quotas and job permissions; never provide MLflow credentials or broad execution privileges to agent-generated UI views. Track acknowledgments using a bounded durable outbox, and label tracking as pending until MLflow acknowledges it.

**Run mapping:** persist `project_id`, `experiment_id`, `job_id`, `attempt_id`, `mlflow_run_id`, and optionally `logged_model_id`, `registered_model_name/version`, `evaluation_id`, `trace_id`, `deployment_id`, and `mlproject_entrypoint`. Retries create new attempts and run IDs. Keep execution status distinct from MLflow state and synchronization status; do not claim cross-system exactly-once transactions.

**Compatibility contract:** pin/test a specific MLflow version and maintain a feature matrix. Every required lifecycle operation must have a UI entry point, Bun API/CLI equivalent, upstream integration, permissions, lifecycle error state and automated contract test. "Complete core ML experimentation" refers to this finite tested contract, **not** to a commitment to mirror every future MLflow release or cloud plugin.

**SQLite caveat:** MLflow's SQL-backed store is an upstream implementation detail accepted under the earlier JSON-first decision. JSON/JSONL/Markdown remain canonical for AblationKit-owned research records. Use MLflow APIs rather than directly accessing its database tables; back up the MLflow database and artifacts as one coordinated system.

### 5.6 Unified AblationKit MLflow frontend contract

**AblationKit is the only intentional researcher-facing MLflow client**, including for Projects, evaluation, registry and serving. MLflow's bundled UI must not be needed to complete a required workflow.

| UI view | Required behavior |
| --- | --- |
| Experiments | Create, rename, filter, archive/restore experiments; connect MLflow experiments to AblationKit projects/hypotheses |
| Runs | Run search/filter/pagination, parameters/tags/system metrics, console/agent timeline, provenance, status, artifact explorer |
| Comparison & Ablations | Multi-run overlays, aggregation/repetitions, baseline controls, metric and parameter comparison, chart/table export; support sweep/ablation variants and paired model-output comparison on the same input/dataset slice |
| Datasets | Inspect dataset inputs, roles, source/version/fingerprint, run/model lineage, evaluation dataset definitions where available |
| Evaluations | Launch/select evaluation modes, inspect classical metrics, reports, classification/regression plots, validation threshold passes/failures; handle custom evaluator output |
| Logged Models | Search models, inspect flavors/signatures/dependencies, source run and evaluation results, artifact and download/load entry points |
| Registry | Register models/versions, model/version search, lineage, descriptions, tags, aliases and model promotion/selection actions |
| Project Entrypoints | Read `MLproject`, list entrypoints and parameters, choose environment/target, run, monitor and inspect linked tracking records |
| Inference Lab | Select logged/registered model references; resolve aliases to pinned versions; build validated tabular/text/image inputs where adapter support exists; run one-shot predictions; inspect outputs, errors, timing and optional saved evidence |
| Interactive Sessions | Start/stop/restart local supervised model processes, send repeated predictions, inspect readiness/logs/resource use and configured idle timeout; handle unavailable worker/MLflow states |
| Model Output Comparisons | Select 2+ fixed model versions and a shared input sample/dataset slice; display aligned predictions, disagreements, target labels (if present), latency and task-relevant error slices; export/snapshot with provenance |
| Batch Evaluation | Select fixed dataset/split and evaluation protocol; run supported classical/GenAI MLflow evaluation; compare metrics, slices, diagnostic plots and aggregate/paired results with clear uncertainty labeling |
| Interactive Demos | Discover and launch approved, sandboxed project-scoped React/TypeScript demonstrations; restrict inference to explicitly granted model references and APIs; save only requested results/snapshots |
| GenAI Traces | Search/filter traces, inspect span trees/timing/errors, compare trace executions, link trace evidence to research records |
| GenAI Evaluation & Prompts | Manage/view evaluation datasets and runs, inspect scorers and results, browse/edit/version prompts with supporting provenance |
| LLM Research Lab | Prompt/model playground; prompt diffs and pinned versions; trace-to-evaluation navigation; RAG retrieval panels; tool execution tree; token/latency/cost summaries; example-level and pairwise feedback |
| Operations | Sidecar health, API compatibility, delivery backlog, worker/deployment state, offline reconciliation, backup/restore status |

**Implement and test a native frontend** for these workflows; no stock MLflow UI links, iframe, or second researcher portal as a substitute. The backend is a validated façade, not a generic open MLflow proxy. Read operations support pagination, filtering and bounded payloads; large metric histories are downsampled for visualization without altering canonical MLflow data. File downloads/previews are content-type checked, and unsafe model formats require trust warnings.

**MLflow 3 model identity:** distinguish a logged-model ID from a registered model's name/version and from a run ID. Keep explicit references rather than pretending a model is always just a `runs:/...` artifact path.

**Agent-generated React views:** may access selected MLflow-backed project data only through a project-scoped capability bridge. They may not launch evaluation, training, deployment or registry mutation without separately granted capabilities and researcher approval.

#### 5.6.1 Research-first inference, comparisons, and demos — v0.6 contract

**Product priority:** make investigating a trained model effortless, not operating a production endpoint. Model serving, MLflow registry, packaging, batch evaluation, and all previously committed core MLflow capabilities remain in scope. A model may be selected from a logged-model ID or registered model reference; if an alias such as `@champion` is used, resolve and persist its **immutable model version/ID at session start** so later alias changes do not silently change predictions.

**Inference execution modes:**

1. **One-shot:** an isolated Python worker downloads/loads a compatible pinned model, validates the request against its declared signature and selected task adapter, predicts, returns structured output/timings, then releases resources. A long-running HTTP model server is **not** required for this mode. First-call model load times and prediction times must be reported separately.
2. **Interactive session:** a supervisor provisions an isolated model process or local MLflow serving endpoint on demand. AblationKit communicates only through its own authenticated API, with bounded request size, concurrency, memory, idle timeout and explicit stop/cleanup. The user may issue repeated predictions without reloading on every request. Sessions are disposable; crash/restart/timeout produces an honest state, never a fake live endpoint.
3. **Tracked batch evaluation:** a durable `EvaluationJob` reads a fixed dataset/split and executes a supported evaluator against one or more pinned models. Outputs include aggregate metrics, diagnostic plots, task-specific slices and explicit data/evaluator provenance; canonical tracked results and selected artifacts are stored in MLflow. For GenAI, use MLflow GenAI evaluation APIs, not interchangeable classical evaluator classes.

**Comparison correctness:** at least two models can be compared on the *same ordered examples*, ground-truth labels (when available), preprocessing/feature transforms, scoring configuration and dataset fingerprint. The UI must distinguish metric direction, units, sample counts, individual failures, and whether comparison is paired. Report confidence intervals or significance only when computed by a supported method and show method/assumptions; do not fabricate statistical significance. Allow side-by-side predictions, disagreement filtering, error case inspection, and metric/latency overlays. Flag model-signature or input/preprocessing incompatibilities before attempting a comparison.

**Input/output adapters and supported limits:** ship a narrow tested matrix of supported MLflow model flavors and research input types, initially **tabular classification/regression** and **text-oriented compatible Python-function models**, with image-oriented inference via an optional project adapter where available. Validate model `signature`, parameters and payload shape; unsupported tasks/flavors must show an actionable error rather than pretending arbitrary `.pt`/checkpoint files can be served generically. Form fields, plots and preview types are generated from validated schemas or an approved task-specific adapter. For large inputs/outputs, stage bounded attachments through the backend rather than embedding unrestricted bytes in JSON.

**Evidence and privacy:** exploration is transient by default. Do not log raw inference input/output to MLflow automatically; ephemeral request metadata may include counts, status and aggregate timing, with redaction. Saving a comparison, hand-selected example, confusion matrix, diagnostic, or demo snapshot is an **explicit action**, storing evidence in MLflow artifacts/evaluation runs and a corresponding AblationKit research link. Attach resolved model IDs/versions, source run(s), code revision, dataset/split/version, input/preprocessor hash or approved sample reference, inference parameters, evaluation implementation/version, environment and timestamps. Display what is stored and allow deletion under the configured retention policy.

**Demo creation:** agents may author project-scoped interactive React/TypeScript demos such as a text classifier playground, image prediction explorer, model disagreement viewer, or ablation comparison panel. Demo code is built and executed under the existing isolated extension system; source and manifest are reviewable before approval. Provide a typed, capability-checked `inference.predict`/`inference.compare` bridge with allowlisted model IDs, maximum requests/bytes, dataset permissions, optional cost ceiling, and no direct MLflow, worker, filesystem, network, or Electron privileges. Distinguish **demo view** (UI) from **inference session** (compute process). Demo removal must revoke capabilities and terminate unreferenced sessions after cleanup grace period.

**Offline and remote behavior:** with the workstation off, its coordinator UI, MLflow sidecar and locally hosted inference sessions are unavailable. A remote supervised worker may finish an already submitted batch evaluation or keep a deliberately remote inference process alive if its provider supports this; worker-side outputs spool and reconcile later. The default interactive session is local, temporary, and must not imply durable remote availability. Do not provision remote inference or incur GPU cost without approval.

**Operational requirements:** report startup/model-load latency separately from prediction latency; track request counts and errors, worker memory/GPU use when available, idle expiration, last activity and lifecycle transitions. Bound worker cache size and clear secrets. Model files may contain executable code or unsafe deserialization formats; only approved/trusted sources may be loaded and model execution must be isolated outside the privileged backend. Failure to load a model must not crash the Bun server or compromise other projects.

**API semantics:** the Bun coordinator is the sole ingress for clients and extensions; all predictions, batch evaluations and optional managed endpoints are mediated by scoped permissions. `POST /api/v1/inference/compare` is a research workflow, not a raw endpoint proxy. Session creation/stop and evaluation submission are side effects requiring normal human/agent approvals. Support cancellation, bounded request/response sizes and structured error codes. An immutable model reference and relevant provenance must be available for each saved output.

#### 5.6.2 Broad task coverage with LLM-first depth — v0.8 contract

**Product rule:** AblationKit serves **all ML research domains**, but ships the deepest first-party discovery/analysis workflows for LLMs, RAG, and tool-using agents. This is a prioritization of **UI depth and integration effort**, not an exclusivity requirement or removal of the first-release MLflow lifecycle coverage already established in sections 5.5–5.6. When a project is not LLM-oriented, the same Experiments, Runs, Datasets, Evaluations, Registry, Inference Lab, and Demos remain fully usable.

**Custom-architecture principle (v0.8):** an ML project may define its own tokenizer, discrete/continuous representations, model graph, losses, training loop, generation procedure, or experimental evaluation protocol. No built-in architecture family, tokenizer interface, or model-serving flavor is compulsory for **experiment execution, tracking, and comparison**. The runner accepts project-defined commands and outputs, while MLflow records common metadata/metrics/artifacts. Operations needing executable model loading, standardized inference or model registration use an explicit project-supplied adapter/signature, and may report unsupported behavior without blocking the core experiment workflow. Agent Skills and project-scoped views provide specialized explanations, diagnostics, and visualizations; the core must not accumulate bespoke implementations of individual research papers.

**Reusable architecture experiment contract:**

- **Variant definition:** record arbitrary typed configuration fields plus readable change descriptions and parent/baseline links; use project-owned schemas where appropriate. Do not assume the only useful variants are prompts, optimizers, or pretrained checkpoints.
- **Run provenance:** capture source commit and uncommitted-change reference, project command/entrypoint, dependency environment, data and preprocessing identifiers, seeds, model/tokenizer/config fingerprints where the project exposes them, compute details, and artifacts. Missing fields are explicitly marked unavailable rather than inferred.
- **Comparison:** support two or more runs with project-defined metric names/directions, artifacts and custom evaluations. Enable tables, charts, qualitative examples and approved project-authored React views without imposing one domain-specific metric schema.
- **Outputs:** allow arbitrary result and diagnostic files with declared MIME type, size, optional schema, and evidence links. Built-in viewers handle common formats; a project extension handles unfamiliar ones.
- **Agent customization:** project-specific Agent Skills, references, adapters, and views teach the agent the scientific methods of the repository. These are separate from portable AblationKit core Skills and cannot silently change shared platform behavior or access other projects.

**Task profile declaration (optional):** a project may specify `task_profiles: [llm, rag, agent]` or e.g. `[computer_vision]`. Profiles select initial navigation, input/output renderers, evaluator presets, and sample dashboards. Profiles do not affect project storage ownership, MLflow identity, permissions, or API access. A project can combine profiles and switch them without data migration.

**Bundled feature boundary (ADR 0024):** the LLM research workflows are shipped as the
`llm-research` Extension Host API 2 extension. Bundled means included, supported and enabled by
default, using the same public capabilities as an approved project backend. The core owns scoped
infrastructure and data-policy enforcement; the extension owns LLM domain services, UI, CLI,
GenAI worker, job SDK and Agent Skills. Disabling it removes LLM features while preserving stored
evidence and policy, with capture constraints and retention enforced by the host.

**LLM research workflows (first-release deep support):**

1. **Prompt versioning and experimentation:** list/search MLflow Prompt Registry entries, inspect immutable versions/aliases, preview text/chat templates and variables, diff versions, and run saved or exploratory prompt/model combinations through a unified playground. Pin resolved prompt version, model/provider revision, decoding parameters and code revision for a recorded experiment; don't assume alias references are immutable. Keep prompts and app-specific chat-session history distinct from externally linked ChatGPT/Claude conversations.
2. **Model/prompt/config comparisons:** run the **same ordered inputs** through 2+ pinned candidates; align outputs side by side, show differences, scorer feedback, timing and token usage (when reported), and compare evaluation aggregates. Record model ID/revision, prompt version, generation config, random seed (if honored), and dataset fingerprint. Do not treat stochastic samples as exact reproducibility guarantees; support repeated trials and distributions when needed.
3. **Trace and agent-debugging explorer:** inspect MLflow trace tree/waterfall, nested spans, function/LLM/retrieval/tool-call inputs and outputs (subject to redaction), errors/retries, durations and relationships to evaluation feedback. Search/filter by project, model/prompt version, run, operation and failure. Traces refer to exact MLflow trace IDs rather than being duplicated as a second canonical span store.
4. **Evaluation datasets and scorers:** create/select fixed, versioned *golden sets* with expectations, categories and edge cases; invoke `mlflow.genai.evaluate()` with supported built-in and project-defined scorers; inspect per-example feedback and aggregate/slice metrics; identify regressions and select failure examples for follow-up. When an LLM judge is used, preserve the judge model/version, prompt/rubric, settings and cost metadata if available. Surface nondeterminism, evaluator error, and missing ground truth; don't equate judge output with objective truth.
5. **RAG investigations:** show query → retrieved documents/chunks → reranking/context construction → generation in the same trace where instrumented. Compare retriever/index/chunking/prompt variants; annotate retrieval relevance, grounding and citation/source mismatch with supported scorers and human notes. Store safe source references, dataset/index revision, retrieval configuration and chunk identifiers. Don't promise document-level evidence where the application has not instrumented retrieval spans.
6. **Tool-using agent research:** visualize tool-call arguments/results, nested decisions as observable spans, errors, retry paths, external API/tool latency, and failure clusters. Show **observed actions and traces**, not hidden model reasoning or inaccessible reasoning tokens. Allow user annotations and comparisons of tool policy/instructions over fixed tasks.
7. **Fine-tuning and model ablations:** standard training loss, step/epoch curves, checkpoint/artifact/registry views and MLflow Projects/runner integration remain fully available. Provide LLM-specific adapters for tokenization/context length, training configuration, evaluation harness outputs, GPU/system metrics, and pretrained/base-model lineage where supplied by the project. The coordinator does not mandate a training stack or invent training metrics that were not logged.
8. **Research demos:** an approved React/TypeScript extension can assemble chat-style or prompt-comparison interfaces over narrowly scoped `llm.infer`, `llm.compare`, `trace.read` and `evaluation.read` capabilities. Secrets and raw MLflow/worker URLs remain behind the Bun server. Generated extension source and the built bundle are independently sandboxed as in section 8.

**LLM measurement and privacy rules:** show output quality alongside latency, provider-reported tokens, and estimated costs **only where sufficient data exist**. Mark missing usage as unavailable and estimates with rate source/version and calculation basis; do not present estimates as billed cost. LLM prompts, trace bodies and retrieved passages may contain confidential data: default to explicit per-project capture/retention policy, redaction and controlled access, especially on remote workers. Avoid persisting arbitrary exploratory inputs/outputs unless the user intentionally records evidence or enables trace capture. Recorded evaluations must declare their data-retention policy. Never upload private datasets to external judge/model providers without an approved egress configuration.

**Cross-domain baseline and extensibility:**

| Project category | First-release usable baseline | Additional first-party depth priority |
| --- | --- | --- |
| LLM / prompt research | Tracking, model/prompt registry, inference, traces, GenAI evaluation, datasets, comparisons | **High:** prompt playground/diff, detailed traces, golden sets, example-level review, cost/latency and token analyses |
| RAG / tool agents | Same core and task-specific trace/evaluation adapters | **High:** retrieval evidence, context/citation inspection, tool-call trees, run/trace error clustering |
| Computer vision | Runs, metrics, models/registry, dataset/provenance, evaluation, project adapters and sandboxed image views | Baseline built-in image input/output preview; advanced overlays, saliency/attention and segmentation via project views/adapters first |
| Tabular ML | Runs, model registry, structured input/output preview, supported evaluation and comparisons | Baseline tables, confusion matrices, residual/error slices when artifacts/evaluator provide them; richer interpretability through adapters |
| Other ML / multimodal | Full underlying lifecycle, supported task adapter or project-provided wrapper, custom visualizations | Add deeply integrated modality-specific viewers as demand develops; no claim that arbitrary models/weights auto-load |

**Agent workflows:** add LLM-oriented Agent Skills for `inspect-traces`, `compare-prompts`, `build-eval-set`, `run-llm-evaluation`, `debug-rag`, and `summarize-failures` using the same CLI/API. An agent may propose evaluation cases, scorers and reports, but may not silently change held-out golden sets, expose external data to a judge provider, or spend on inference without the existing approval/budget checks.

**Additional LLM-first interaction loop (specialized built-in workflow):** open a project → choose/pin 2 prompt/model variants → run them on an identical saved evaluation set → inspect trace-level and per-example differences → mark important failures → generate a report linking prompt versions, trace IDs, evaluator definitions, data revision and MLflow runs → propose a next experiment. The entire loop must occur within AblationKit's frontend, with CLI parity, without handing the user off to MLflow's UI.

### 5.7 Workstation-offline execution and eventual reconciliation

**Before launch:** coordinator validates/pins source+environment, reserves execution/attempt and MLflow mapping IDs, creates a worker-local durable job manifest, stages code/config/data access, and obtains the provider's persistent job ID. Once the provider confirms submission, its scheduler/worker is responsible for process lifetime, **not** the Bun coordinator process.

**While coordinator unavailable:** worker uses a local process supervisor/provider-native job scheduler. It records timestamped status/heartbeat observations, metric events, logs, artifact checksums and terminal metadata in a bounded append-only spool; it must avoid unbounded retry loops. Where available, it may upload large artifacts into persistent external storage independent of the workstation, but it must not require workstation availability to finish computation. The research UI is unreachable if the workstation is powered off.

**When online again:** worker reconnects using authenticated, scoped credentials (refreshable by a separate mechanism where needed), resumes event replay with stable IDs and acknowledged cursors, and transmits any missing output. Coordinator queries MLflow and provider status, deduplicates ingested event IDs, forwards tracking writes via outbox, and presents separate **compute status** and **sync status**. If job status is ambiguous, show `unknown`/`reconcile_required` rather than automatically rerunning paid work.

**Failure cases to test:** shutdown mid-epoch, finished job while offline, stale tokens during multi-day disconnection, worker reboot, spool full, interrupted artifact upload, duplicate delivery after acknowledgment loss, provider job already terminated, and disk pressure. Coordinator disappearance is not a guarantee of continued execution on interactive Colab or other ephemeral providers.

### 5.8 Migration, availability, and backups

- Import or link existing MLflow experiments/runs without rewriting them, subject to supported MLflow APIs and project mapping.
- Provide a health check for the MLflow sidecar and explicit startup/upgrade failure states. If MLflow is down, researcher notes and console logs remain accessible; structured tracking writes queue durably within bounded limits and do **not** appear committed until acknowledged.
- Before an MLflow upgrade, back up the database and artifact store together with AblationKit mapping files and research records; use a SQLite-safe snapshot/backup method or quiesce the service, **not an unsafe copy of a live database file**.
- An externally managed MLflow tracking URI can be configured in the future for users with existing infrastructure; remote access credentials and compatibility need validation. The preferred initial installation remains coordinator-local.
- Define export of research records independently from MLflow data: Git-portable research files are not a substitute for a complete MLflow database and artifact backup.


## 6. Research object model and provenance

**Autonomy additions (v0.11):** `ResearchCampaign`, `AutonomyPolicy`, `ProjectActionPolicy`, `PolicyRevision`, `AuthorizedAction`, `CandidateBranch`, `ResearchDecision`, `AgentSessionReference`, `ApprovalRequest` and `BudgetLedger` are distinct from `Experiment`/`Run` and `Job`/`ExecutionAttempt`. See section 7.2 for lifecycle and evidence contracts. MLflow remains the canonical store of run metrics and tracked artifacts.

Entities: `Project`, `Hypothesis`, `Approach`, `Study`, `Variant`, `Job`, `ExecutionAttempt`, `MlflowRunReference`, `DatasetReference`, `Evaluation`, `LoggedModelReference`, `RegistryModelVersion`, `ProjectEntrypoint`, `Deployment`, `InferenceSession`, `InferenceRequestReference`, `ModelComparison`, `DemoReference`, `TraceReference`, `PromptReference`, `PromptVariantReference`, `EvaluationDatasetReference`, `ScorerReference`, `LLMComparisonReference`, `RetrievalEvidenceReference`, `Event`, `MetricReference`, `ArtifactReference`, `Note`, `Report`, `Visualization`, `ConversationReference`, `ExecutionTarget`.

- **Study** (formerly `Experiment`) describes a planned comparison/ablation made of a baseline and **Variants**; **Job** is a logical submission; **ExecutionAttempt** is a concrete process execution; an **MLflow run** tracks one attempt. The attempt-to-MLflow run mapping is explicit and persisted.
- Execution-attempt snapshots record source commit, dirty-tree status/diff reference, effective config, seeds, dataset/split identifiers, dependency lock/config, hardware, compute target, SDK/runtime versions, timestamps, and termination state. MLflow tags/inputs record queryable tracking fields where supported.
- Notes and reports cite exact execution attempts, MLflow run IDs, metric histories, dataset fingerprints, evaluations, logged/registered model identifiers, artifacts, traces where applicable, and source revisions. Separate evidence from agent interpretation or recommended follow-up.
- End-to-end lineage is navigable in both directions: hypothesis → run(s) → evaluation(s) → logged model → registry version/alias → optional pinned inference session/comparison/demo snapshot. For LLM investigations, include prompt version, evaluation dataset/version, scorer configuration, trace ID(s), retriever/index revision and model/provider revision where instrumented. Show missing links explicitly rather than fabricating them. Exploratory inference requests need not be preserved; saved evidence has explicit provenance.
- Maintain forward and reverse references as needed; rebuild in-memory lookup maps by scanning small canonical JSON files, not by inventing a complex index service.
- A running experiment can be monitored by a new agent session without assuming the process can be resumed from a checkpoint.

### 6.1 Glossary and cardinality (v0.15; normative)

| Entity | Meaning | Relationships |
| --- | --- | --- |
| Project | A registered repository | Has many Tasks and Studies; maps to exactly one MLflow experiment `ak/<project-id>` |
| ResearchTask | The researcher-facing unit of agent work (section 7.9) | Belongs to a Project; has 1..n AgentTaskBindings (T3 threads); links many-to-many with Studies |
| ResearchCampaign | Autonomous-loop state: ledger, candidate branches, decisions, budget | Exists only for Explore and Autonomous Research tasks (0..1 per Task) |
| Study | A planned comparison: baseline plus variants, evaluation protocol | Has many Variants |
| Variant | One configuration/code change under test | Has many Jobs |
| Job | A logical submission | Has many ExecutionAttempts (retries) |
| ExecutionAttempt | One concrete process execution | Has exactly one MLflow run |
| MLflow experiment | MLflow's namespace | One per Project; Study, Variant, Task and Campaign IDs are run tags. Imported historical experiments remain separate and are linked read-only |

## 7. Experiment lifecycle and visibility

1. **Inspect** code, previous experiments, data constraints, and baselines.
2. **Hypothesize** a testable change and success criteria; preserve alternative approaches.
3. **Plan** controls, variants, seeds, metrics, cost/time bounds, and expected artifacts.
4. **Approve** privileged actions, expensive compute, or proposed UI extensions when applicable.
5. **Execute** using a supported target; persist run state and capture observable events.
6. **Evaluate** against baseline using MLflow classical/GenAI evaluation as appropriate; inspect uncertainty, error slices, threshold checks and regressions; record limitations and negative results. For LLM research, prioritize pinned prompt/model/retrieval variants on a shared golden dataset, trace-level debugging, judge/rubric provenance and case-level failures.
7. **Package and register if warranted** via MLflow Logged Models and Model Registry; preserve lineage, model signatures and environments.
8. **Investigate models if warranted** using one-shot inference, interactive model sessions, paired comparisons, and tracked batch evaluations. Use supervised local serving when repeated predictions benefit from a warm model; preserve only explicitly saved examples, figures and diagnostics as linked evidence.
9. **Report** concise structured findings with plots, snapshots, and evidence references.
10. **Remember** decisions and next hypotheses, leaving a durable research trail.

The dashboard should display agent activity separately from job/process output, and label proposals versus completed actions unambiguously.

### 7.1 Configurable autonomy: product semantics (v0.11)

Autonomy is **chosen for each task or research campaign**, not as a global "trust this agent forever" switch. **Per-project action policy is a separate, persistent setting:** a project can allow autonomous experiments while requiring researcher approval to commit, push, merge or deploy; see section 7.7. The four modes are opinionated policy presets. The same underlying Claude Code / Codex driver can serve all four; changing modes updates the allowed workflow rather than changing models. A reviewer can also run in parallel with a separate bounded experiment campaign if workspaces and credentials are isolated.

| Mode | Typical request | Research actions | Default change boundary | Default review gate |
| --- | --- | --- | --- | --- |
| **Review** | "Audit the implementation and research methodology" | Read code, inspect MLflow data and history; summarize flaws, evidence and suggestions | Read-only project snapshot; no arbitrary shell, mutations, network or experiment launch | Researcher requests any follow-up action |
| **Implement** | "Implement this requested feature/ablation" | Make bounded changes, run permitted tests/checks, create a diff and report | Isolated Git worktree/branch; defined files or feature scope; no protected-branch write | Review/accept resulting diff; expensive/privileged actions need approval |
| **Explore** | "Find promising approaches to this problem" | Propose multiple hypotheses, branch variants, run controlled comparisons and rank evidence | Dedicated worktrees per candidate; declared objective and evaluation protocol | Researcher approves initial scope/compute envelope; progression allowed within bounds |
| **Autonomous Research** | "Iterate toward this goal within these limits" | Repeated hypothesis → implementation → execution → evaluation → decision cycles; choose next approach, maintain cumulative ledger | Campaign-scoped isolated branches and budgeted execution; optional parallel candidates | Preauthorize bounded scope once; interrupt only on policy gates, stop conditions, or meaningful exception |

UI labels must distinguish **recommendations**, **proposed actions**, **executed actions**, **measured outcomes**, and **interpretations**. Review mode is not equivalent to unconstrained shell access with a read-only prompt; the execution policy must prevent writes and unauthorized side effects.

Autonomy is **multidimensional**. Researcher-configurable controls include: repository/path allowlists, whether edits or arbitrary tests are permitted, worktree/branch restrictions, command and network egress policy, data classification and allowed external destinations, available compute targets, per-run and campaign cost/time/token/GPU-hour/experiment-count ceilings, maximal concurrency, experiment/evaluation protocol, optional report cadence, stopping criteria, and mandatory approval actions. Permissions are bound to the project *and* campaign and can be reduced immediately. Changing the permitted envelope upwards requires explicit consent and records a new policy version. For actions the provider cannot reliably intercept, rely on OS/network/resource controls or disable the mode.

**Always guarded regardless of autonomy preset:** accessing additional credentials/private data, unreviewed egress of sensitive datasets, modifying protected/default branches, deleting project history, changing autonomy/project policy, deploying public persistent endpoints, publishing papers/posts, spending outside approved budgets, and installing new privileged extensions. These actions require a dedicated project-policy rule and/or explicit narrow researcher authorization, plus environment-level enforcement where applicable; no autonomy preset silently overrides protections. A "permitted merge" is only one that passes the project-specific branch rules, evidence checks, and any required approval. Core application source modifications use the trusted source-development approval path from section 8, not implicit project-agent permissions.

### 7.2 Campaign state machine, provenance and evidence

A **ResearchCampaign** is a persisted container for a goal or audit task, across any number of agent sessions or experiments. It is separate from the narrower MLflow `Experiment`/`Run` objects and from the process `Job`/`ExecutionAttempt`. Proposed entities are `AutonomyPolicy`, `ResearchCampaign`, `HypothesisCandidate`, `CandidateBranch`, `ResearchDecision`, `AgentSessionReference`, `BudgetLedger`, `ApprovalRequest`, and `EvidenceAssessment`. Core types are versioned, JSON/JSONL-based and use stable IDs; MLflow keeps the canonical metrics, model artifacts, traces and evaluation results.

Campaign state transitions: `draft → awaiting_authorization → active ↔ paused → completed | stopped | budget_exhausted | failed`. A task-level `needs_approval` gate may suspend one action while independent preauthorized jobs continue; `recovering` explicitly represents an uncertain agent/worker session after a crash or disconnect. Persist each transition and the effective policy revision in an append-only journal. A `stop` revokes authorization for *new* work and attempts best-effort cancellation of existing jobs; it does not imply instantaneous termination of already-submitted cloud workloads. A result only becomes `completed` after durable evidence reconciliation, not merely after an agent claims success.

A campaign manifest should record: researcher goal and exclusions; success metric(s) and direction; minimum acceptable baseline; evaluation protocol/dataset identifiers and splits; resource limits; allowed implementation scope; candidate selection strategy; current parent/child worktree genealogy; source commit and patch hash per branch; agent provider/session/model identifiers where available; scheduled experiments; MLflow run IDs; numerical results/uncertainty; failures and negative findings; budget receipts and estimates; researcher interventions; and next actions. Reports must link claims to observed metrics/plots/artifacts and call out missing or inconclusive evidence. Do not capture or claim access to hidden model reasoning; record observable actions and short *authored rationales* instead.

**Scientific validity controls:** the harness should encourage predeclared metrics and baselines, fixed evaluation inputs/splits, comparison under matched budgets and compute, seed/repetition practices appropriate to the project, detection of leakage and accidental test-set peeking, and confirmation runs before declaring improvement. Distinguish exploratory validation from held-out final evaluation. An LLM reviewer or reward heuristic is *advisory*, not proof of scientific correctness or novelty; researcher can inspect raw run evidence. Reports preserve all tried branches or a verifiable branch index so unsuccessful attempts cannot quietly disappear. No domain-specific methodology is hardcoded; custom evaluators and acceptance gates come from project extensions.

### 7.3 Research strategy: intentionally thin, progressively extensible

**Default strategy:** one strong coding agent with a bounded objective, access to relevant project/MLflow context and tools, and a deterministic loop around *external experiment feedback*: propose candidate → edit isolated worktree → validate/test → submit job → obtain real metrics → compare with baseline → keep, reject or retry → record a concise checkpoint. Context may be compacted/restarted with a durable state summary, but the authoritative record is the campaign ledger and experiment evidence, not an endlessly growing chat.

Search strategy is swappable: `sequential`, `parallel_variants`, `best_first_tree` or a project-defined strategy extension. The default does **not** mandate tree search, an AI "reviewer" agent, a fixed team of specialized agents, paper generation, or multiple nested planners. Parallelism is enabled only when it has a clear hypothesis/rationale and sufficient compute; every concurrent candidate uses its own worktree and tracked runs. Pluggable selection policies may use metric improvement, feasibility, novelty/coverage, cost and uncertainty, but may not silently change declared success criteria or evaluation data.

**Reference design lessons (not mandatory architecture):**

- SakanaAI **AI-Scientist-v2 (2025)**: open-ended hypothesis generation, manager-controlled progressive tree exploration, debugging and ablation stages; useful inspiration for campaign lineage and evidence, but historically model/harness choices and success rates do not establish a current best default. Its README explicitly cautions about LLM-authored code risks and the v1/v2 exploration tradeoff.
- SakanaAI **The Agentic Scientist (October 2026)**: research-focused coordination of existing coding agents, isolated workers, bounded cycles, evidence and shared conclusions. Its investigation includes Claude Code/Codex and finds model choice more consequential than harness choice on its evaluated tasks.
- **Apple/EPFL, *How Much of a Harness Does a Strong Agent Need for Autonomous ML Engineering?* (October 2026)**: tested equal-budget autonomous MLE harnesses against a strong minimal coding-agent baseline and found no advantage from elaborate machinery in those benchmarks. Treat as a reason to measure orchestration value, *not* as proof that search or multiple agents never help.
- **AIDE**: tree/code lineage, objective-directed iterative debugging and measurable results are useful optional strategy primitives.
- **Scientific verification literature**: autonomous ML systems can generate code and papers without adequately supporting the scientific claims. Use traceable datasets, faithful implementations, baselines, repetitions and evidence-linked reporting as release-quality requirements.

Require an **AblationKit harness evaluation suite**: for representative user projects, compare a direct single-agent baseline against sequential campaign orchestration and optional parallel/tree strategies at matched model, tool access, token/time/compute budgets. Measure validated research progress, reproducibility, cost, wall-clock time, correction burden and failure rate. Do not add a permanent orchestrator subsystem unless it improves an agreed measure.

### 7.4 Agent adapters, permissions and offline execution

The Bun coordinator exposes a small, versioned `AgentTransport` contract (section 7.8) for capabilities, environment inspection, thread/turn dispatch, event streaming, approval replies and interruption. **For UI-launched work, the primary implementation is the version-pinned T3 Code WebSocket RPC adapter**: T3 Code then controls Claude Code or Codex using the provider mechanisms supported by the installed T3 version. Direct Claude Agent SDK and Codex SDK/app-server drivers are optional headless/compatibility fallbacks. All adapters forward only provider-supported events; persistent session IDs do not guarantee a process survives host shutdown or resumes an in-flight tool step. Use provider-native approval/sandbox functionality **in addition to** AblationKit coordinator policy and worker-level hard limits. If an adapter cannot enforce a required boundary, refuse that capability rather than falling back to an unrestricted prompt.

Never grant any autonomy mode arbitrary full disk/shell/network access simply to reduce approvals. Repository edits occur in isolated Git worktrees (prefer clean committed baselines), with read-only/protected paths enforced where possible; workers execute untrusted generated code in explicitly approved isolated environments. Committing an isolated branch, pushing a remote ref, merging into a target branch, and launching an inference deployment are **distinct authorization boundaries** governed by the per-project policy in section 7.7; a permission to edit or run experiments does not imply permission for any later step. Run-specific credentials are short-lived and destination-scoped. Prompt content, tool output, repository files and web pages are untrusted input; these cannot broaden a policy.

The **workstation may go offline**. Durable remote jobs can continue on independent workers with a previously issued bounded job capability and offline spool, as specified in section 5.7. **Autonomous *decision-making* loops ordinarily pause when the workstation coordinator/agent driver stops.** An optional `delegated_remote_campaign` capability can allow a separately supervised agent process to continue on a trusted remote worker, but only with pre-staged code/data, independently enforced cost/permission limits, durable state and a time-limited credential; no scope expansion or unsupervised external publishing. This feature is an advanced mode rather than a promise for every Runpod/SLURM/Colab target. Reconnection must reconcile the agent session and actions as well as MLflow events before permitting new work; ambiguous or duplicated execution is quarantined for review.

Budget enforcement should track agent API usage separately from training GPU charges, storage charges and paid external calls. Spending may be estimated/delayed across providers; surface freshness and uncertainty. Use preflight ceilings, worker-enforced time/quantity limits, conservative reservations and automatic circuit breaks, while disclosing that provider-side billing lag can make absolute dollar caps impossible to guarantee. No new paid work begins after budget exhaustion; already-running jobs are canceled best effort.

### 7.5 Autonomy configuration example (illustrative schema)

```json
{
  "schema_version": 1,
  "campaign_id": "research-024",
  "project_id": "custom-architecture-lab",
  "mode": "autonomous_research",
  "agent": {"provider": "codex", "strategy": "sequential"},
  "goal": "Improve the defined validation metric using controlled model changes",
  "evaluation": {
    "metric": "validation/primary_score",
    "direction": "maximize",
    "dataset_ref": "dataset:validation-v3",
    "baseline_run_id": "mlflow-run-abc"
  },
  "limits": {
    "max_experiments": 12,
    "max_parallel_jobs": 1,
    "max_wall_time_minutes": 480,
    "max_gpu_hours": 8,
    "max_compute_usd": 20,
    "max_agent_usd": 10
  },
  "permissions": {
    "editable_paths": ["src/", "configs/", "tests/"],
    "protected_paths": ["data/private/", ".env"],
    "requested_source_actions": ["experiment.edit", "experiment.run_local", "git.branch.create"],
    "allow_public_network_egress": false,
    "allow_extension_install": false,
    "allow_remote_training": true,
    "require_approval_for_new_compute_target": true
  },
  "stop_when": {"metric_at_least": 0.85, "max_no_improvement": 4},
  "report_every_n_experiments": 3,
  "delegated_remote_campaign": false
}
```

This example is an **authorization request**, not an independently enforceable set of safeguards. Source-control and deployment privileges are not inherited from `mode`; `requested_source_actions` is intersected with the authoritative project policy in section 7.7, so this campaign has no implicit commit/push/merge/deploy rights. The coordinator must validate it against system/global policy and supported runtime capabilities, obtain the researcher's explicit authorization, store a policy fingerprint, and enforce a reduced effective policy at all action boundaries. `max_compute_usd` and `max_agent_usd` are separate soft/best-effort financial constraints unless corresponding external hard limits can be verified. Names and API shapes are preliminary.

### 7.6 Autonomy UI and researcher's controls

The Agent & Campaign Center must expose: current mode, project policy revision, effective permission envelope (experiment/commit/push/merge/deploy shown separately), and any policy conflicts; campaign objective, progress and time/compute/cost usage; proposed next experiment and rationale summary; live observable actions/terminal output; diff/worktree and experiment-branch graph; MLflow-linked evidence; current approvals; pause/resume/steer/stop buttons; and an audit log. The researcher can request a concise progress report at any time, change the goal within the authorized boundary, or reduce mode/permissions without losing runs. Increase of permissions or a new spend ceiling always needs a fresh approval. A lightweight notification system may surface decisive findings, budget exhaustion, repeated failures and required approvals without bombarding the researcher with ordinary low-risk actions.

The interface must distinguish `agent_running`, `experiment_running`, `awaiting_approval`, `worker_disconnected`, `reconciling`, `budget_exhausted`, and `agent_session_unavailable`. Do not describe a completed experiment as a finished autonomous campaign, or a provider-side interruption as an intentional agent stop.

### 7.7 Per-project source-control and deployment policy (v0.12; normative)

**Decision:** project autonomy and source-control authority are separate. Autonomy presets describe what research actions an agent is encouraged to attempt; a **project-scoped action policy** describes which actions AblationKit will actually authorize. An agent can be highly autonomous at hypothesis generation and trial execution while having no merge or deployment rights. Every project may choose a different policy, independent of the agent provider and other projects.

#### 7.7.1 Action taxonomy and policy choices

All action classes support an explicit `decision` of **`deny`**, **`ask`** (one bounded researcher approval), or **`allow`** (automated only when every listed condition passes). Unknown actions or missing policies default to `deny`. `allow` never overrides system constraints, credential grants, cost ceilings, protected branches or provider limitations. A policy can narrow conditions by directory, branch, remote, environment, target, action type and campaign ID.

| Independent gate | Examples it covers | Default (new project) | Required safeguards |
| --- | --- | --- | --- |
| **Experiment work** (`experiment.edit`, `.test`, `.run_local`, `.submit_remote`) | Modify an isolated candidate, run tests, start local/remote training or batch evaluation | Edit/test in isolated workspace: `ask`; remote/paid: `ask` | Worktree isolation, allowed paths, network/eval/compute budgets; an experiment run is not a merge or deployment |
| **Commit** (`git.branch.create`, `.commit`) | Create candidate branches, stage approved paths and commit candidate snapshots | `ask` | Isolated nonprotected worktree; staged-file allowlist, diff/secret scan, recorded commit SHA, attribution and campaign linkage |
| **Push** (`git.push`) | Publish a candidate branch/ref to a configured Git remote | `ask` | Explicit remote and ref allowlists, non-force, credential scope, data/secret scan; never imply push permission from commit |
| **Merge / integrate** (`git.merge`) | Merge/cherry-pick/apply candidate changes into a designated target branch, whether local or remote | `ask` | Exact source/target SHAs, clean merge result, required test/evaluation gates, protected-branch rules, researcher approval unless specifically preauthorized |
| **Deployment** (`deployment.preview`, `.remote_research`, `.persistent`, `.public`) | Start research inference demos or remote inference endpoints and manage their lifecycle | Ephemeral local preview: `ask`; remote persistent/public: `deny` | Explicit target, model version, cost/duration/network limits, credentials, endpoint exposure; preview != public deployment |

Separate controls also cover **branch deletion, force push, history rewriting, release tagging, public publishing, extension installation, and core platform source updates**. These remain denied unless deliberately authorized through specialized workflows, not inferred from `git.commit`, `git.merge`, or `deployment.preview`. Read-only project inspection does not grant arbitrary shell access or remote network access.

#### 7.7.2 Storage, precedence, and immutable approvals

- **Authority:** store the actual, researcher-controlled `ProjectActionPolicy` with the coordinator's JSON research state under its managed policy directory (for example `state/policies/{project_id}.json`), **outside agent-editable project worktrees**. Save immutable revisions plus an append-only policy/audit journal. A Git-friendly `.ablationkit/policy.request.json` may suggest defaults for onboarding, but has **zero authority** until the researcher accepts its contents in the UI. Project `AGENTS.md`, `CLAUDE.md`, skills, prompts, generated files, or extension code never grant capabilities.
- **Evaluation:** effective grants = intersection of (1) coordinator/system hard constraints, (2) authoritative project policy, (3) autonomy preset/campaign authorization, (4) particular action's approved scope and budget, and (5) actual OS/provider/remote host enforcement. **Most restrictive rule wins; deny by default.** A session-specific approval may permit an action marked `ask` but cannot silently convert a project-level `deny` into an `allow`. Changing a project-level deny requires a separately authenticated policy revision.
- **Approvals:** bind each approval to an actor, project ID, campaign ID, action type, policy revision, exact file diff/commit/target-ref where meaningful, environment or destination, spend ceiling and expiry. Approvals are single-action by default; reusable approval grants must be explicitly time-limited and narrow. Re-check the binding immediately before execution to prevent stale approvals and branch/target races.
- **Rule evolution:** policy grants/restrictions are edited only via a researcher-authenticated control path, not an agent's own credential or editable repo file. Each change creates a revision, effective timestamp, summary and audit event. Reductions invalidate pending approvals and future actions; enlargements require explicit owner confirmation. Existing offline jobs may continue only within previously issued bounded capabilities until expiry or reconnection; disconnected workers cannot grant themselves new Git/deployment authority.
- **Enforcement:** only the coordinator's authorized source-control and deployment broker holds credentials to write protected remotes/environments. Agents use isolated workspaces and least-privilege tokens. Block mutation through direct shell/Git/API paths using sandboxing, filesystem/credential restrictions, and server-side branch rules where available; provider-native permission callbacks and Git hooks are **defense in depth**, not sole enforcement. If an agent has unrestricted host credentials, the policy cannot guarantee prevention: show the limitation and refuse claims of enforced safety.

#### 7.7.3 Illustrative project action policy (proposed JSON contract)

This JSON is a **schema proposal**, not an implemented endpoint or an upstream Git format. The main coordinator owns the authoritative file. A researcher's chosen settings can differ across projects; campaigns cannot escalate beyond them.

```json
{
  "schema_version": 1,
  "project_id": "custom-architecture-lab",
  "revision": 4,
  "defaults": {"decision": "deny"},
  "experiments": {
    "edit": {"decision": "allow", "paths": ["src/**", "configs/**", "tests/**"], "only_isolated_worktrees": true},
    "test": {"decision": "allow", "max_wall_minutes": 20},
    "run_local": {"decision": "allow", "max_parallel": 2},
    "submit_remote": {"decision": "ask", "allowed_targets": ["runpod"], "max_gpu_hours": 8}
  },
  "git": {
    "branch_create": {"decision": "allow", "ref_prefix": "refs/heads/agent/"},
    "commit": {"decision": "allow", "refs": ["refs/heads/agent/*"], "require_secret_scan": true},
    "push": {"decision": "ask", "remote": "origin", "refs": ["refs/heads/agent/*"], "force": false},
    "merge": {
      "decision": "ask",
      "source_refs": ["refs/heads/agent/*"],
      "target_refs": ["refs/heads/main"],
      "required_checks": ["tests", "reproducibility", "eval-regression"],
      "require_clean_target": true,
      "require_review_of_exact_diff": true
    }
  },
  "deployments": {
    "preview_local": {"decision": "allow", "exposure": "loopback", "idle_timeout_minutes": 30},
    "remote_research": {"decision": "ask", "allowed_targets": ["runpod"], "max_runtime_minutes": 120},
    "persistent": {"decision": "deny"},
    "public": {"decision": "deny"}
  }
}
```

Policy must validate referentially against registered `project_id`, real Git roots, validated ref names and registered execution targets. Glob syntax and path normalization must be specified and tested for symlinks, linked worktrees, submodules, case sensitivity, Windows paths, nested repositories and Git internals. No user-supplied project file can redirect the policy engine to another project. This example allows autonomous candidate edits and isolated commits, but **not** unapproved pushes or merges, and not public deployments.

#### 7.7.4 Git, evaluation and deployment integration gates

1. **Edits / experiments:** create a distinct Git worktree per concurrent candidate where possible. Snapshot baseline commit/config/data references. Deny access to policy and protected paths. Test/evaluation jobs run with bounded CPU/GPU/network scopes and retain MLflow evidence. Launching experiments does not implicitly authorize committing.
2. **Commits:** authorize branch/ref and staged diff, scan for secrets and forbidden paths, create a commit only in the permitted isolated branch, and record the resulting commit object ID plus code/evaluation provenance. A commit is **not** a push, merge, publication or model deployment.
3. **Pushes:** validate destination remote and exact refspec; prohibit force, ref deletion or credential reuse unless separately configured. Prefer short-lived credentials limited to allowed refs where the host supports such restrictions. Report unavailable remote protection mechanisms explicitly.
4. **Merges:** re-fetch target ref, pin both source and target SHAs, construct/test the **actual merge result** in isolation, verify required checks against that result, ensure branch rules and policy still apply, then ask/auto-merge according to *that project's* `git.merge.decision`. If refs or artifacts change between approval and execution, invalidate approval and repeat checks. Do not suppress failed checks; preserve the proposal and failure evidence. Prefer hosted Git provider PR/ruleset protections for protected remote branches. Local Git hooks alone are bypassable and must not be treated as the authoritative barrier.
5. **Deployments:** distinguish local short-lived research inference sessions from bounded remote research endpoints and persistent/public services. Pin the exact model artifact/version and image/source revision, preflight cost/network exposure, approve the named target, set TTL/resource limits, and log start/stop/rollback. Starting a demo or registering an MLflow model does **not** itself grant permission to expose an endpoint. Resource cleanup is brokered and audited; destructive cleanup affecting unrelated resources requires a separate grant.
6. **Core-code modifications:** a project agent's permissions cover its **registered ML project**, not the AblationKit monorepo. Modifying core uses the separately authorized trusted source-development workflow in section 8.5, even if the project grants its agent broad edit and commit rights.

**Required gate behavior:** an agent can propose a denied action and request an approval, but cannot execute it until the policy permits. `ask` yields a durable pending approval; `deny` yields a clear blocked reason; `allow` executes only after preconditions pass. Every result includes policy revision, actor, relevant SHA/target/environment, preflight checks, action outcome, and an audit reference. UI shows **proposed / approved / executed / rejected / failed** distinctly. Never claim a merge or deployment completed on the basis of an agent message alone.

#### 7.7.5 Offline workstation behavior and recovery

- While the primary coordinator is offline, remote workers may **finish already authorized experiments** and write bounded local artifacts/logs. A preauthorized isolated commit may be possible only on a specifically trusted independent worker with a locally enforceable policy snapshot; do not assume that every cloud worker supports this.
- **New pushes, merges, persistent/public deployments and policy expansions default to unavailable** while the coordinator is offline. A future remote authorization broker would require its own enforceable capabilities, revocation model and audit log, and cannot be implied by the current worker design.
- On reconnection, reconcile job status, candidate branches, commit SHAs, target-ref changes, model artifacts, approvals and audit events. Validate current project policy before acting on a deferred request; never replay a privileged action merely because it was queued before disconnection. Prevent duplicate merges/deployments with stable operation IDs and state reconciliation.

#### 7.7.6 UI and developer documentation contract

The Project **Agent Permissions** page exposes each gate as an independent control with its effective mode (Blocked / Ask each time / Automatically permit within conditions), bounded scopes, allowed refs/targets, required checks, and active exceptions. It must clearly distinguish autonomy modes from Git/deployment permissions, show policy diffs before saving, and list blocked/approved actions with explanations. An agent inspecting policy sees a **read-only effective-permissions summary**—not the privilege-bearing editable policy file or privileged API token.

Provide `docs/autonomy/project-permissions.md`, `docs/autonomy/git-integration.md`, `docs/autonomy/deployment-gates.md`, policy examples, a threat model, and adapter/CLI tests. Document which controls are technically enforced by AblationKit vs. dependent on provider branch protection or worker infrastructure, and prohibit describing an unverified control as a hard guarantee.

### 7.8 Dual entry-point orchestration and T3 Code integration (v0.13; normative)

**Separation of concerns.** T3 Code is the **coding-agent session control plane** for UI-launched work: execution-host/project association, provider instances, thread/turn lifecycle, provider events and approvals. AblationKit is the **research control plane**: task specification, scientific hypotheses, research campaigns, MLflow run/evidence provenance, budgets, per-project action permissions, experiment execution targets, and investigator reports. An `AgentTaskBinding` relates one AblationKit task/campaign to an environment ID, T3 project ID, one or more thread/turn IDs, repository/worktree root, provider instance/model, event cursor, dispatcher idempotency token and observed capabilities. Bindings are not treated as a one-to-one mapping from chat turn to experiment or MLflow run.

**T3 transport abstraction (proposed internal TypeScript interface, *not* verbatim upstream RPC):**

```ts
interface AgentTransport {
  capabilities(environmentId: string): Promise<AgentCapabilities>;
  inspectEnvironment(selection: AgentSelection): Promise<AgentEnvironmentSnapshot>;
  ensureThread(task: ResearchTask, selection: AgentSelection, idempotencyKey: string): Promise<ThreadBinding>;
  sendTurn(thread: ThreadBinding, context: TaskContextPackage, key: string): Promise<TurnReceipt>;
  subscribe(binding: ThreadBinding, cursor?: string): AsyncIterable<AgentEvent>;
  respondToApproval(binding: ThreadBinding, decision: ApprovalDecision): Promise<void>;
  interrupt(binding: ThreadBinding): Promise<void>;
}
```

The adapter translates this contract to **the installed T3 Code version's current typed WebSocket RPC**. The actual RPC method names, parameter schemas, subscriptions and feature set must be generated/verified from pinned upstream contracts and exercised in integration tests. Never invent guaranteed stability for T3's internals. Connection loss means *unknown until reconciled*, not 'task failed' or 'retry submit immediately'. Implement sequence/cursor catch-up where provided, otherwise re-query thread/read-model state and mark any irrecoverable event gap visibly. Idempotency cannot be assumed at the T3 boundary: record an outbox intent first, query existing bindings on recovery and require user intervention if the outcome cannot be disambiguated.

**Agent-ready environment preflight:** execute checks on the machine that actually hosts the selected T3 environment and provider process, not in the browser or on an unrelated workstation client. At minimum validate:

1. **Connection and compatibility:** T3 server reachable/authenticated; RPC protocol/version supported; selected environment and T3 project mapped to the intended repository; correct absolute path/worktree, Git state, permissions and sandbox working directory.
2. **Agent provider:** the selected Claude Code/Codex provider instance is enabled, installed, authenticated, responsive, and supports requested model, turn/approval mode and required control operations. Report provider-native limitations rather than guessing.
3. **Skills:** every required AblationKit Skill and task-required project Skill is present, valid (`SKILL.md` + metadata), allowed/enabled for the **selected provider instance**, discoverable from the effective project and user/config skill paths, and compatible with requested versions/capabilities. Duplicates, overrides, disablement, provider-specific naming/path precedence and session restarts are checked explicitly. Do not equate 'folder exists' with 'the agent can use it'; use provider/T3 reported inventory plus a session-level probe when needed.
4. **Tools and access:** Bun `ablationkit` CLI or permitted MCP endpoint is reachable from that environment and authorized for the target project; Python/project environment and relevant adapters are available for requested task; compute credentials and MLflow connectivity are checked separately according to planned workflow. Confirm access to files explicitly attached to the task.
5. **Effective safety policy:** reconcile AblationKit project/campaign grants, environment sandboxing and provider/T3 runtime mode. The narrowest enforceable authorization wins. **Never silently select T3's permissive/full-access mode** to make an autonomy preset work. If a policy cannot be enforced at the actual tool/OS/credential boundary, block the mode or ask for an explicitly narrowed execution plan.
6. **Configuration freshness:** report checked-at timestamp, T3/provider/version, selected environment, required vs optional skills, status (`ready` / `ready_with_warnings` / `blocked`) and a machine-readable issue list. Re-check on provider/environment/skill/permissions changes, config edits, session restart, and before materially privileged actions.

**Repair behavior:** show concrete guidance to install/update/enable skills or configure a missing CLI/MCP connection. Allow researcher-initiated, reviewable setup actions only with matching authorization, trusted sources and pinned versions. Re-run preflight after repairs and restart the selected agent session when changes require it. Optional missing capabilities may degrade specific UI functions; missing mandatory permissions/skills block dispatch. Never exfiltrate provider credentials or auto-install arbitrary skill code from linked websites.

**Context and approvals:** store a `ResearchTask` source bundle (files and their hashes, external conversation URL metadata, optional researcher-provided excerpt/summary, goal, experiment plan, constraints, evaluation, budget, data restrictions). A linked ChatGPT/Claude conversation is not implicitly readable by T3/AblationKit or the model. Before forwarding content to the selected agent, show what will be included. Map T3/provider approval requests into AblationKit's authoritative project policies. An agent response claiming completion does not bypass validation or merge/deployment gates.

**Session resilience and offline operation:** on coordinator restart, reconnect to the configured T3 environment and reconcile known task/thread/turn IDs before sending more turns. State is `connecting`, `ready`, `waiting_approval`, `running`, `disconnected`, `unknown`, `failed`, or `completed` according to authoritative evidence; do not infer completion from absence of streaming events. If workstation-local T3 stops, live agent planning stops. Remotely supervised training jobs may still complete, spool outputs and reconcile with MLflow later. A separately hosted T3 runtime could continue agents only if independently configured, credentialed, supervised, and authorized under the existing offline-campaign model.

**Existing sessions:** project agents started outside AblationKit can create a corresponding ResearchTask via Skills/CLI/MCP. The UI may link to or attach an existing T3 thread when the upstream supports it. Never spawn a second agent turn just to display a task in AblationKit, and never mislabel a manually linked external chat as a live T3 agent session.

**Security:** T3 Code is a separately privileged service. The renderer and untrusted extensions never see T3 authentication material and never connect directly to privileged T3 RPC; AblationKit authenticates/authorizes requests, binds them to a project/campaign and forwards through its server-side adapter. Guard against prompt injection in imported specs/chats, cross-project thread mapping, unauthorized approval forwarding, and expansion from scoped to full-access runtime modes. Document trust boundaries and update tests when upstream T3 permissions change.

### 7.9 UI-intake experiment specification and task states (v0.13)

Proposed `ResearchTask` fields: `id`, `project_id`, `created_via` (`ui` / `skill` / `cli` / `mcp`), `objective`, `specification_sources[]` (kind/URI/path/content hash/attached-vs-reference), `instructions`, `acceptance_criteria[]`, `hypothesis_ids[]`, `evaluation_plan`, `dataset_references[]`, `budget_policy_id`, `autonomy_mode`, `project_policy_revision`, `execution_environment`, `provider_selection`, `preflight_report_id`, `agent_task_bindings[]`, `campaign_id?`, `created_at`, `status`, and `result_report_id?`.

Task state machine: `draft -> preflight -> awaiting_researcher_authorization -> dispatch_pending -> dispatched -> active -> awaiting_approval | paused | disconnected -> completed | failed | canceled`, with reconcilable transitions and full attempt history. A failed preflight returns to `draft`/`blocked` with actionable issues. A task is only **scientifically completed** after the declared evaluation/report gates finish; provider turn completion alone means execution finished or handed off, not that the research goal is proven.

The UI supports an editable draft experiment plan generated by the coding agent as a **proposal**; the researcher may approve, revise, or grant an exploratory/autonomous envelope. Standard form inputs are optional: pasting a goal or uploading a file is a valid way to initiate the flow. Imported specs are stored as private project attachments with explicit retention rules; only researcher-selected contents are forwarded to providers. The `ConversationReference` entity remains URL + title + notes and can be attached to a task without transcript synchronization.

### 7.10 Dual-view conversation gateway and event contract (v0.14; normative)

**One authoritative conversation adapter:** The Bun coordinator exposes a `ConversationGateway` *over* the existing `AgentTransport` and task/thread binding store; it must not create a second independent provider client, agent loop, or transcript datastore. T3 Code owns the provider conversation/session history and thread lifecycle. AblationKit persists a **small, durable research-activity projection** from visible events and research actions, plus references/cursors required for recovery. If a researcher opts to retain additional visible conversation excerpts, store them according to explicit privacy/retention settings and mark their source; a cache is not automatically authoritative or a provider export.

**Proposed internal operations (not literal upstream method names):**

```ts
interface ConversationGateway {
  listTaskThreads(taskId: string): Promise<ThreadSummary[]>;
  getThreadSnapshot(taskId: string, threadId: string): Promise<ThreadViewSnapshot>;
  streamThread(taskId: string, threadId: string, after?: string): AsyncIterable<ConversationEvent>;
  sendMessage(taskId: string, threadId: string, message: OutgoingMessage, operationId: string): Promise<TurnReceipt>;
  resolveApproval(taskId: string, approvalId: string, decision: ApprovalDecision, operationId: string): Promise<ApprovalReceipt>;
  interruptTurn(taskId: string, threadId: string, operationId: string): Promise<OperationReceipt>;
}
```

- Normalize the T3/provider events into versioned event categories such as `message_delta`, `message_completed`, `tool_started`, `tool_finished`, `approval_requested`, `approval_resolved`, `turn_status`, `file_changed`, `thread_snapshot`, and `history_gap`. Preserve event origin, provider/thread/turn IDs, ordering metadata and source references. These are **proposed AblationKit schema categories**, not assertions about current T3 RPC method names.
- Build the **compact view** from a filtered/reconciled projection of research-relevant events and MLflow/job/campaign state. Build the **full view** from the same provider thread's available messages/events, with explicit partial-history indicators. Do not infer hidden thinking or conflate agent commentary with a verified experiment outcome.
- Subscribe once per currently observed thread on the coordinator as useful, fan out authorized projections through existing SSE or similarly authenticated streaming to both frontend presentations; batch or throttle high-frequency text deltas to avoid excessive UI and JSONL load. Switching views should not multiply T3 subscriptions, reconnect supervisors, or model token usage.
- Snapshot first and subscribe from a cursor/revision where supported; detect gaps and re-query the authoritative T3 snapshot after a reconnect. If no reliable cursor/history API exists for the pinned T3 release, define tested best-effort replay semantics and show a `partial_history`/`gap` indicator.
- Preserve approvals as durable AblationKit authorization events with stable IDs and revalidate against provider request identity, current policy revision, actor, expected turn and authorization scope. Do not cache an approval decision as a blanket authorization or replay it automatically after reconnection.
- The coordinator mediates all messages/interrupts/approvals. Apply project-scoped permissions to both compact and full views, prevent cross-project/thread access, and validate source of attachments and untrusted content. Agent-written extension views do not gain conversation-control capabilities by default.
- The conversation composer must avoid duplicate sends after a WebSocket/HTTP disconnect: persist `operationId` before dispatch, reconcile unknown receipts against T3 state, and require a researcher decision if ambiguous. If an active turn cannot accept another user message, respond with a clear blocked/queued state according to tested provider behavior.
- Keep session availability distinct from scientific progress: an inaccessible T3 thread may still have durable task/experiment/report history. For agent-first sessions not attached to a compatible T3 thread, the compact evidence timeline remains usable, while full conversation is clearly **unavailable or externally linked** rather than simulated.

**Proposed Bun API resources (not upstream RPC syntax):**

```text
GET  /api/v1/tasks/:taskId/agent/threads
GET  /api/v1/tasks/:taskId/agent/threads/:threadId/snapshot
GET  /api/v1/tasks/:taskId/agent/threads/:threadId/stream?after=<cursor>
POST /api/v1/tasks/:taskId/agent/threads/:threadId/messages
POST /api/v1/tasks/:taskId/agent/approvals/:approvalId/decision
POST /api/v1/tasks/:taskId/agent/threads/:threadId/interrupt
GET  /api/v1/tasks/:taskId/activity                  # Research-oriented compact projection
```

**Operational outcomes:** toggling views changes presentation only; sending through either view acts on the same thread; approvals appear consistently across both; reconnect restores supported history or marks gaps; the researcher can inspect exact run/commit evidence from either view. Support provider-specific unsupported states rather than baking UI assumptions about private T3 protocol fields into application logic.

### 7.11 Trust model, authentication and resource limits (v0.16; normative)

**Decision:** v1.0 uses **no containerization**. Agents, experiment jobs, MLflow Python operations and Python extensions run as processes under the researcher's Linux user. This section supersedes requirements elsewhere in this spec (notably sections 8.3, 8.4.1, 8.7 and 13) that call for OS-enforced isolation, container sandboxes or failing closed without them; those become an optional future **hardened mode** and are not v1.0 requirements.

**Consequence, stated plainly:** a process running as the researcher can in principle read anything the researcher can (including `~/.ssh`, Git credentials and `~/.ablationkit`). AblationKit therefore labels each control as **enforced** (a mechanism outside the agent's control blocks it) or **advisory** (AblationKit's gates and the agent's instructions, which a misbehaving agent could bypass). The UI, docs and reports must never describe an advisory control as a guarantee.

**Layers of control:**

| Control | Mechanism | Level |
| --- | --- | --- |
| Policy edits, permission/budget increases, privileged approvals, extension activation, activating a modified build | Passkey step-up (WebAuthn with a security key or phone hybrid flow) requiring physical presence | Enforced |
| Agent API surface | Separate listener with no policy-edit, approval-resolution or extension-activation routes | Enforced for that API (an agent could still attempt the human API, which requires step-up for privileged writes) |
| Merge into protected branches | GitHub rulesets (required PR, checks, no direct push) configured on the host | Enforced server-side |
| Agent file writes, network and commands such as `git push`/`gh` | Provider-native sandbox and permission rules (Claude Code sandbox and permission deny rules; Codex `workspace-write` sandbox with network off), generated per session from the effective policy | Enforced where the provider sandbox is available and enabled; otherwise advisory |
| Experiment, commit, push, merge and deployment gates | AblationKit policy engine, Git broker and approvals (section 7.7) | Advisory against a misbehaving agent; authoritative for everything AblationKit itself executes |
| Job and extension CPU, memory and time limits | `systemd-run --user --scope` with `MemoryMax`, `CPUQuota`, `RuntimeMaxSec` and `TasksMax` | Enforced |
| Python extension behavior | Researcher review and approval of exact source, lockfile and capability hashes; changes invalidate approval | Advisory (approved code runs as trusted code) |

**Authentication:**

- **Human API.** `ablationkit login` connects to a local unix socket and returns a one-time browser/Electron login link that creates a session. Privileged writes require a **passkey** step-up; there is no TOTP fallback, because a TOTP secret stored on the workstation is readable by any process running as the researcher. Remote clients connect only over Tailscale and use the same login and step-up. No public HTTPS gateway in v1.0.
- **Agent API.** Per-task tokens bound to project, task and campaign, passed to the T3 session's environment. Exposes research, proposal, job-submission-within-policy and approval-*request* routes only.
- **Worker API.** Per-job, upload-only tokens bound to job and attempt, valid until the job reaches a terminal state plus a 7-day grace period; revoked on reconciliation.
- **UI extensions** run in an opaque-origin sandboxed iframe (browser isolation, not containerization) and never receive a network credential.

**Agent execution:** one T3 Code server runs on the workstation. Each candidate gets its own Git worktree; Review tasks run with a read-only provider sandbox. Before dispatch, preflight reports whether the provider sandbox is available and enabled for the selected provider (for example, whether bubblewrap is installed for Claude Code's Linux sandbox) and shows the resulting enforcement level. Modes that depend on a denied push or network being enforced (for example Autonomous Research with `git.push: deny`) require explicit researcher acknowledgment when enforcement is only advisory.

**Jobs and extensions:** run as subprocesses in their own `uv` environments under systemd user scopes with resource limits. GPU access is ordinary host access. Network is not restricted for jobs or extensions in v1.0; capability declarations about network remain in manifests for review and a future hardened mode.

**Notifications:** desktop notifications from the coordinator via libnotify and the Electron/browser Notification API; optional ntfy push, including from remote workers on terminal job state.

**Out of scope:** the researcher's own direct Git or shell commands are not governed. A future hardened mode may reintroduce OS-level isolation (separate Linux user, bubblewrap or containers) behind the same policy model.

## 8. Two-level customization architecture (v0.10)

**Goal:** AblationKit must remain a general-purpose research platform. Researchers and agents can add new behaviors without modifying core (Level 1), or modify any part of the application's source to create a custom build (Level 2). These are **separate, intentionally supported paths**, not an undocumented fallback from one to the other.

| Property | Level 1 — project-scoped extensions | Level 2 — full source changes |
| --- | --- | --- |
| Typical author | Research agent using project context | Coding agent using AblationKit development docs |
| Purpose | Specialized visualization, custom Python evaluation/analysis, small workflow/action | Change fundamental data models, architecture, services, UI, permissions, executors |
| Distribution | Versioned extension manifest/source, portable between projects with compatible host | Git branch/fork/patch series and rebuildable application |
| Execution/trust | Sandboxed browser view and/or sandboxed Python worker, explicit capabilities | Trusted core code; **not** protected by the extension sandbox |
| Upgrade contract | Stable, documented extension API with semver and migrations | May require manual rebasing, tests and compatibility fixes |
| Approval | Researcher approves extension version/hash and requested permissions | Researcher reviews source diff/build and chooses to run a modified application |

### 8.1 Level 1 — extension types and boundaries

A **real extension host**, not just ad hoc display of TSX files, is a first-release requirement. Supported categories are:

- **Views and panels:** React/TypeScript visualizations, architecture explorers, run inspectors, model-output viewers, interactive demos, and project dashboard panels.
- **Report components:** interactive or static figures, rich comparisons, reusable renderers, and snapshot-capable report blocks.
- **Data adapters / formatters:** bounded, deterministic transforms from authorized project/MLflow-backed results into typed display data; do not mutate canonical MLflow records.
- **Small actions / workflow contributions:** project-scoped menu/toolbar actions such as “compare selected runs” or “generate report”; actions invoke allowlisted coordinator operations and can trigger standard supervised jobs through existing job APIs. No arbitrary JS execution in the Bun server process.
- **Python computation contributions:** custom evaluators, post-run analyzers, metric/diagnostic generators, structured data preparation, and approved model- or dataset-specific probes. These are run-to-completion tasks or explicitly supervised bounded sessions, not Python modules imported into the Bun coordinator. They may be headless or supply data to a companion React visualization.

The host exposes **contribution points** (`project.panel`, `run.tab`, `comparison.view`, `report.block`, `project.action`, `project.analysis`, `run.evaluator`, and similar documented locations). An extension registers what it contributes through a manifest; the UI discovers it, displays its permissions and compatibility, and mounts it only for the permitted project. Core navigation and experiment tracking must remain fully usable with every extension disabled.

**Scope and portability:** default to project-scoped extensions under `.ablationkit/extensions/<extension-id>/`. A researcher may install a compatible reusable extension into a user-level registry and explicitly enable it in selected projects. No extension is silently enabled for other projects or given broad cross-project data access. Extension source is Git-friendly; approved bundles, locks and permissions are managed by the coordinator. A project-specific Agent Skill may describe how to author/use the extension, but the extension's functionality must not depend on the continuing presence of that agent session.

### 8.2 Extension contract and lifecycle

Every extension includes a versioned `manifest.json`, entrypoint(s), declared contribution points, host API compatibility range, a build/dependency lock, and requested capabilities. A *proposed* mixed UI + Python manifest (the precise schema will be finalized with implementation):

```json
{
  "schema_version": 1,
  "id": "model-explorer",
  "version": "0.2.0",
  "host_api": "^1.0.0",
  "contributes": [
    {"point": "run.tab", "entry": "ui/src/View.tsx"},
    {"point": "project.analysis", "entry": "python/analysis.py:analyze"}
  ],
  "python": {
    "requires_python": ">=3.11,<3.14",
    "lockfile": "python/uv.lock",
    "max_runtime_seconds": 300,
    "max_memory_mb": 2048,
    "gpu": false,
    "network": "none"
  },
  "capabilities": [
    "project.runs.read",
    "project.artifacts.preview",
    "project.analysis.execute",
    "project.results.write"
  ]
}
```

The lockfile identifies reproducible dependencies; it is **not** an OS security boundary. A UI-only or Python-only extension may omit the other entrypoint. The manifest is declarative: paths, resource settings and capabilities are validated by the host, not trusted because an agent wrote them.

1. Research agent generates extension source in the target project's extension directory, preferably using a documented template and typed SDK; the researcher can inspect the source and manifest.
2. `ablationkit extension validate` checks schema, supported contribution points, dependency policy, requested capability scopes, build rules, and relevant host API versions.
3. Controlled **build isolation** compiles a reproducible UI artifact, resolves/pins any Python environment from its approved lockfile and computes content hashes of all executable source and dependencies. Untrusted install hooks, arbitrary build scripts, dependency downloads and code execution are not silently permitted; isolated build/install or explicit trusted-development approval is required. A changed dependency graph invalidates the previous approval.
4. The UI shows **source/diff, dependency lock, Python execution limits, permissions, project scope and preview**. Researcher approves the exact extension version and build/environment hashes before activation; changed code, dependency lock, resource limit, or capability invalidates approval.
5. UI contributions execute in sandboxed, isolated-origin views. Python contributions run under a dedicated **Python extension runner** with a per-extension environment, restricted project input staging, limited artifact output area, resource/time quotas, no default network, and explicit approved operations. Python workers are **never** imported into the Bun coordinator or MLflow sidecar; model evaluation and tracking requests go through the authorized broker.
6. The UI uses `@ablationkit/extension-sdk` and Python uses `ablationkit-extension-python`; both communicate through typed, authenticated capability RPC mediated by the coordinator/runner. The backend rechecks project scope and permissions for every operation, including reads. Sensitive requests, model inference, network egress, writes or compute costs require granular approval and quotas.
7. The researcher can inspect health/errors, disable, revoke permissions, uninstall or roll back to an approved version. Saved reports contain static fallback snapshots and evidence references so they remain legible after an extension is removed.

**Extension-facing APIs are intentionally narrower than internal core modules.** They may read authorized research/MLflow-backed projections, request artifact previews, navigate to evidence, subscribe to bounded run updates, and invoke approved job/inference/report actions. They cannot call internal Bun methods, bypass the coordinator, mutate MLflow's store directly, or read arbitrary filesystem paths.

### 8.3 Extension security and isolation

- Run third-party React/UI code in an opaque-origin sandboxed iframe or equivalent separately isolated browser context, with restrictive CSP, navigation/popup limits, and an audited message bridge. Avoid the dangerous `allow-scripts` + `allow-same-origin` combination for same-origin iframe content.
- Electron views have Node integration disabled, context isolation enabled, renderer sandboxing enabled, and no privileged preload/IPC exposed to extensions. Do not disable `webSecurity` or grant extension code OS/shell credentials.
- Build isolation is **independent** of runtime isolation. A sandboxed iframe does not make `bun install`, native dependencies, bundler plugins, or package lifecycle scripts safe to execute on the host.
- Extension permissions are **capability- and project-scoped**, never general-purpose bearer credentials. Validate message origin/channel identity, extension build hash, schema, target project, authorization, quotas, and payload size on every operation.
- Python extensions are permitted to import their **approved, pinned** dependencies inside the isolated worker, including computation libraries. They cannot inject arbitrary modules into the host, invoke unapproved process/shell operations, make raw network requests, read unrelated project files, or contact MLflow directly by default. Python import and package isolation alone must **never** be represented as security isolation.
- Execute agent-generated Python as lower-trust code using OS-enforced boundaries (hardened container, sandbox/VM, or comparable mechanism) with non-root identity, bounded CPU/RAM/runtime, restricted mounts, no host credential exposure, and network disabled unless explicitly permitted. A plain Python `venv` or unrestricted same-user subprocess is inadequate for sandboxing; on unsupported host platforms, block automatic untrusted execution or require an explicit **trusted code** opt-in with a clear warning. A container also needs hardening and is not an absolute security guarantee.
- GPU, additional network access, downloads, additional filesystem paths, and secrets are independently grantable capabilities with separate approvals; default to no GPU, no external network, no secrets, and read-only staged inputs.
- Enforce permission checks and quotas on every broker operation **server-side**, never solely by cooperation from the Python SDK. Use bounded JSON/event payloads, project-bound artifact references, rate limits, output size quotas, and cancellation/process-tree cleanup.
- **v0.16:** v1.0 uses no containerization; the trust model in section 7.11 supersedes the OS-isolation requirements in this section, which describe an optional future hardened mode.
- Safe-mode boot disables third-party extensions, preserves core functionality, and exposes a recovery/rollback view. Test attempted escape, malicious message payloads, denied permissions, resource exhaustion, and disabled/uninstalled extensions.

### 8.3.1 Trusted backend services (Extension Host API 2, ADR 0024)

A Level 1 extension may declare a Bun backend, HTTP operations with input/output contracts and
human/agent permissions, complete project pages, exported/dependent services, ingestion adapters,
Python workers, job SDKs and portable skills. Project backends use the existing content-addressed
build and passkey approval; no build-time source execution or macros are allowed. API 1 remains
compatible for extensions without a backend. Backends run in supervised subprocesses with bounded
IPC and cancellation; they never receive the coordinator's private service object.

Public broker capabilities cover scoped tracking, research records, events and replay, atomic JSON
collections and blobs with version/revision checks, destination/model/data-scoped outbound
requests, host-resolved credential handles, and supervised Python execution. Widening capture,
retention, redaction or egress requires a human passkey step-up at the host. Persisted project
constraints apply even when their contributing backend is disabled. Trusted backend/worker code
runs as the user's OS account; broker scope checks do not imply an OS filesystem/network sandbox.
Safe mode disables bundled and third-party extensions; core tracking/research/recovery remains
available. See `docs/extensions/backends.md` for the implemented public contracts and routes.

### 8.4 Extension developer experience and public compatibility contract

Publish `@ablationkit/extension-sdk` with typed manifests, view mounting, state/host-data subscriptions, preview artifacts, notifications, navigation and bounded capability calls. Publish `ablationkit-extension-python` with corresponding typed input/output schemas and a minimal Python entrypoint contract. Provide a curated UI component set as an aid, not a requirement for arbitrary React layout. Publish types and reference implementations generated/verified against the Bun API's versioned schemas.

- **Stable extension APIs:** document supported host/extension versions, deprecations and migrations; internal modules are *not* public APIs.
- **Templates:** create-run-panel, architecture-viewer, inference-demo, result-comparison, report-widget, restricted action, **python-evaluator**, **python-analyzer**, and **react-python-demo**, with runnable fixtures and tests.
- **Development loop:** scaffold → run against mock/project fixtures → validate → sandbox preview → permission review → activate → test → roll back. Provide descriptive error messages and a developer console for extension failures.
- **Data access:** typed queries or subscriptions to MLflow-backed runs, traces and artifacts go **only** through the Bun coordinator; extensions never receive MLflow connection secrets. Python jobs receive only approved run IDs, bounded metadata or staged file handles and may publish typed evaluation results, diagnostics, artifacts and progress via the broker, never mutate MLflow storage directly.
- **Documentation:** each contribution point and capability has a worked example, permissions matrix, schema/type reference, failure modes, performance guidance and security guidance.

### 8.4.1 Python extension execution and UI integration (v0.10 contract)

**Execution flow:** approved extension action (researcher or agent) → coordinator permission check → supervised Python extension runner → typed execution request → project-scoped staged inputs / capability broker → typed result and artifacts → coordinator persistence / MLflow adapter as appropriate → SSE updates / paired React extension. The Python worker may run on the workstation or an explicitly selected compatible remote execution target; remote execution must honor independent supervision and offline reconciliation rules.

- **Input contract:** immutable extension/build ID, project ID, optional run/model/dataset references, constrained parameters, execution ID, and granted capabilities. Avoid passing arbitrary host paths or bearer tokens in the request payload.
- **Result contract:** `status`, short summary, structured diagnostic tables/metrics, bounded JSON outputs, artifact references, warnings/errors, and links to source runs. Large arrays, figures and model files use managed artifacts instead of returning huge JSON blobs.
- **State and provenance:** record exact Python entrypoint, code hash, dependency lock hash, runtime image/environment, referenced run/dataset/model versions, inputs, resource usage and output artifact hashes. Evaluation metrics or MLflow-tracked artifacts are committed **through the coordinator/MLflow adapter**; research notes and extension job status belong to AblationKit. Do not create a second canonical metric store.
- **Concurrency and failure:** per-project and global quotas, timeout, cancellation, partial/progress events, process-tree cleanup, retry only for declared idempotent jobs, and bounded durable log/event spooling. If a job is interrupted or the coordinator is unavailable, report `interrupted`/`sync_pending` rather than silently rerunning or claiming its outputs were recorded.
- **Permission boundaries:** no initial network egress, no direct coordinator/MLflow credentials, no unrestricted filesystem access, no dynamic package installation at execution time, and no cross-project access. Approve exceptional resource/network/secret needs individually, and never grant an entire project environment or host shell by default.
- **UI integration:** React views can invoke only their own approved Python contribution through typed coordinator RPC, monitor progress and show the validated output. Direct React-to-worker communication, arbitrary Python snippets passed as UI parameters, and extension-defined unvalidated server routes are forbidden.

**Illustrative Python entrypoint** (proposed SDK, not implemented):

```python
from ablationkit_extension import ExtensionContext, ExtensionResult


def analyze(ctx: ExtensionContext, params: dict) -> ExtensionResult:
    runs = ctx.runs.list(limit=20)  # Authorized, project-scoped broker call
    summary = {"run_count": len(runs)}
    artifact = ctx.artifacts.write_json("analysis.json", summary)
    return ExtensionResult(summary="Run analysis complete", artifacts=[artifact])
```

A Python virtual environment solves dependency conflicts but does **not** isolate arbitrary executable code from the workstation. The platform must provide an actual runtime sandbox for untrusted extension code; if it cannot on a specific operating system, it must fail closed rather than silently falling back to an unsandboxed process. A separate explicitly approved trusted-development mode may run less restricted extensions, labeled as trusted code and excluded from the untrusted-extension guarantees.

### 8.5 Level 2 — complete source modification by coding agents

**Full source changes are supported by design**, not treated as a prohibited or accidental use. A researcher may ask Claude Code, Codex, or another coding agent to modify the AblationKit monorepo itself: add a core screen, change the storage model, build a new compute adapter, modify the extension host, replace an internal orchestration strategy, or add MLflow functionality. This path deliberately has **no extension-API ceiling**; it has correspondingly higher maintenance and trust costs.

**Repository and workflow requirements:**

1. Publish source, reproducible setup, pinned development dependencies, required environment variables, local service bootstrap, architecture diagrams, module boundaries, generated contracts, and unit/integration/E2E test commands.
2. Provide root `AGENTS.md` (Codex), `CLAUDE.md` (Claude Code), and short pointers to precise docs, architecture decision records (ADRs), package-level READMEs, and the relevant source directories. Avoid a massive duplicated always-loaded instruction file.
3. Agent begins from a Git branch/worktree, identifies affected services and external contracts, changes source, runs focused tests/lint/typechecks, exercises both browser/Electron paths when affected, and generates a human-reviewable diff and compatibility notes. **A prompt or agent-run edit must never silently replace the installed coordinator executable.**
4. The modified build is activated explicitly by the researcher. Back up coordinator/MLflow state before schema changes or breaking upgrades; use documented migrations and rollback paths. Show a modified-build indicator and commit/build revision in diagnostics.
5. Source changes that alter Python SDKs, CLI/API contracts, extension permissions, research schemas, or tracking integration must update the corresponding documentation, types, test fixtures, migrations and compatibility matrix as part of the same change.
6. A source fork need not preserve internal API compatibility, but must clearly report which upstream and extension compatibility guarantees it retains. Do not promise seamless upstream upgrades for arbitrary forks.

**Trust boundary:** source-level modifications are **trusted application changes**, not sandboxed extensions. They may execute with the coordinator's effective privileges and access research files/MLflow, so they require normal code review, dependency inspection and safe build practices. The extension host remains a strict security boundary for lower-trust agent-authored mini-applications.

### 8.6 Documentation is a first-release product requirement

The source repository must include an **agent-navigable documentation system**, not merely a user README. Required sections:

| Documentation set | Minimum contents |
| --- | --- |
| **Getting started / dev setup** | Bun/Python/Electron setup, MLflow sidecar, local fixtures, launch, build, test, lint, typecheck, debug and troubleshooting commands |
| **Architecture map** | Service boundaries, package ownership, dependency graph, source directory map, request/event paths, sequence diagrams, coordinator/worker offline recovery, MLflow ownership |
| **Core contracts** | Versioned Bun REST/SSE and CLI schemas, Python SDK/event protocol, JSON/JSONL layouts, persisted IDs, compatibility and migration rules |
| **Extending AblationKit** | Extension manifest schema, React and Python contribution points, both SDKs, worker execution RPC and result contracts, dependency locking, capabilities/security model, scaffolding, fixtures, previews, validation, approvals, examples, rollback |
| **Modifying the source** | Where to change common features, safe change playbooks for UI/API/storage/tracking/compute, development modes, Git workflow, test suites, ADRs and release/upgrade policy |
| **Security and operations** | Threat model, permission boundaries, sandbox design, worker isolation, secrets, backup/restore, MLflow compatibility, remote access and failure recovery |
| **Agent entrypoints** | Small maintained `AGENTS.md` and `CLAUDE.md` referring to the same source-of-truth docs, plus topic-specific Agent Skills for common tasks |

Docs must be **source-versioned and discoverable** (cross-linked from README, code package docs and agent instructions), with examples that run in CI. Typed API/schema references should be generated from machine-readable contracts where feasible; check drift between docs/examples and code. Any changed public behavior requires documentation and test updates before a release. Include a deterministic `doctor` command for the development environment and one for extension compatibility.

### 8.7 Two-level customization acceptance boundaries

- A project-specific agent can install a new UI/panel extension **without editing AblationKit source**, and the same extension can be enabled for another project only after explicit project-scoped authorization.
- A small action extension can invoke a permitted coordinator operation but cannot invoke privileged internal code, arbitrary shell commands, or raw MLflow APIs. An unsafe extension can be disabled without preventing core research tracking, registry, inference or job management.
- A project research agent can create a Python-only evaluator, a Python-only analyzer, and a combined React + Python extension without changing AblationKit source. They run under independently constrained workers with content-pinned environments, return typed outputs and artifact references, and can be revoked/rolled back per project.
- Security tests demonstrate that an unapproved Python extension cannot read outside staged project inputs, access host credentials/MLflow, use network or GPU without approval, or exhaust CPU/RAM/time beyond configured limits. If the host cannot supply an adequate sandbox, the workflow fails clearly rather than pretending a `venv` is sufficient.
- A separate coding agent can implement a genuinely new **core** capability in a Git branch using the repository docs, run the documented checks, build the changed application, and activate it only after researcher review. This does not rely on pretending the change is a sandboxed extension.
- Extension and source pathways have clearly documented differences in trust, portability, review, compatibility, and upgrade cost. Both must pass real tests in **browser and Electron** modes where relevant.

## 9. Conversation links and research notes

The `Conversations` section is an **organization layer**, not another chat client.

Record: source (`ChatGPT`, `Claude`, `Claude Code`, `Codex`, other), display title, URL or local session reference, created/added timestamps, tags, personal notes, and related project/hypothesis/run/report IDs.

- Support add/edit/delete, tagging, sorting, filtering, and deep-link opening.
- Support quoting or summarizing a useful idea in an ordinary research note with attribution to the linked conversation.
- Do **not** fetch, scrape, copy, search inside, synchronize, or automatically import external chat content in the MVP.
- Links are pointers, not guarantees of access: a conversation may be unavailable on another machine/account or after deletion.
- Store user notes locally in portable project files where requested; secrets and sensitive content must not be silently copied to Git-tracked files.

Future import/sync support is a new product decision, not an assumed prerequisite.

## 10. Compute and environments

Provide a target interface with optional operations: `validate -> package -> estimate -> submit -> status -> logs -> artifacts -> cancel`. Adapters declare capabilities rather than promising feature parity.

- **Local:** execute in the project's environment; send structured metrics to MLflow via the collector/adapter; capture stdout/stderr and record separate job lifecycle.
- **Runpod:** provision or submit compute, securely establish a collector route to the coordinator, capture logs/metrics/artifacts, terminate work, and require approval for paid compute.
- **SLURM:** produce reproducible `sbatch` bundles and optionally submit/poll/retrieve using configured SSH or worker gateway. Do not require direct access to the cluster's internal filesystem.
- **Google Colab:** export notebooks and integrate through supported runtime tooling when available; don't promise unattended execution or permanent connectivity. For isolated runtimes, spool output and support later artifact collection.

A worker does **not** need the SQLite DB or MLflow artifact filesystem mounted. It sends events through authorized coordinator endpoints. An advanced configuration may allow a worker to call MLflow Tracking directly, but then access control, artifact proxying, token management, and duplicate delivery become explicit concerns.

MLflow **Tracking** does not replace remote schedulers; **MLflow Projects support is required in AblationKit** as a selectable execution mechanism alongside `uv`/Docker/SLURM/Runpod packaging. `MLproject` files remain optional per repository. MLflow **Serving** is separately available for local model inference and as an adapter for supported remote deployment, not a training scheduler. Secrets stay out of Git, manifests, log events, UI extension code, and model artifacts. Cloud cost defaults to approval-required.

**Offline nuance:** remote training and inference endpoints continue only when their hosting/supervision is independent of the workstation. MLflow metadata commits and the AblationKit UI are unavailable while its coordinator is powered off; workers stage events/evaluation outputs/models locally or in durable remote storage and reconcile later. Local MLflow model serving necessarily stops with the workstation.

## 11. Proposed repository layout

```text
ablationkit/
  apps/
    cli/                     # Bun CLI (local or remote coordinator)
    server/                  # Bun coordinator API / auth / SSE
    web/                     # Browser UI
    desktop/                 # Electron client/shell
  packages/
    core/                    # Domain models / research file storage
    protocol/                # Versioned event/API schemas
    tracking-mlflow/         # MLflow REST gateway, mapping, outbox/recovery
    mlflow-lifecycle/       # Typed Projects / evaluation / registry / serving operations
    inference/              # One-shot, paired comparison, session and demo capabilities
    llm-research/           # Prompt/model comparisons, traces, RAG and GenAI eval projection
    deployments/            # Local serving process lifecycle and health management
    extension-sdk/           # Public typed extension manifest, host bridge and capabilities
    extension-host/          # Scoped registration, build/preview, isolation, approval
    extension-python/        # Python extension job broker, manifests, execution contracts
    autonomy-policy/         # Authoritative per-project grants, campaign intersection, approvals, budget ledger
    git-broker/              # Authorized worktree/commit/push/merge operations + evidence checks
    deployment-gates/        # Per-project approval and target/endpoint controls
    auth/                    # Human/agent/worker APIs, login socket, sessions, passkey/TOTP step-up, tokens
    process-supervisor/      # systemd user scopes, resource limits, process-tree cleanup for jobs/extensions
    provider-sandbox/        # Generates Claude Code / Codex sandbox and permission settings from effective policy
    research-campaigns/      # Durable campaign state, candidate branches, decision/evidence ledger
    agent-transport/         # Versioned internal transport contract and session bindings
    agent-t3code/            # Primary UI-launch WebSocket RPC adapter + compatibility tests
    agent-readiness/         # Provider/skills/MCP/CLI/worktree preflight and repair plans
    agent-drivers/           # Optional direct Claude/Codex compatibility/headless adapters
    research-strategies/     # Sequential default; optional parallel/tree plugins
    view-sdk/                # Compatibility alias / view helpers for extension SDK
    ui-components/
  python/
    ablationkit-sdk/         # Lightweight collector-compatible APIs
    ablationkit-protocol/
    ablationkit-pytorch/     # Optional MLflow autologging integration
    ablationkit-mlflow/      # Optional project-facing native MLflow integration
    tracking-helper/         # Isolated Python operations bridge for Projects/models/evaluation/serving
    ablationkit-extension-python/ # Public Python extension SDK and typed context/results
    extension-runner/        # Sandboxed Python extension executor; never imported into Bun
    inference-adapters/       # Tabular/text task adapters, optional image adaptors
    # ablationkit-llm lives in packages/builtin-llm/src/python/sdk/
    ablationkit-vision/     # Optional computer vision task adapter
  skills/
    research/
    plan-experiment/
    run-experiment/
    analyze-results/
    build-visualization/
    build-extension/
    modify-ablationkit-source/
    review-project/
    implement-task/
    explore-approaches/
    autonomous-research/
    publish-report/
  adapters/
    local/
    runpod/
    slurm/
    colab/
  ops/
    mlflow/                 # Pinned runtime config/launch/backup scripts
  templates/
    extensions/             # UI, Python evaluator/analyzer, combined React+Python starters
  examples/
    extensions/             # Runnable, CI-tested extension samples
  docs/
    architecture/           # System map, ownership, data/event flows
    api/                    # Generated types/REST/SSE/protocol contracts
    extensions/             # Manifest, host SDK, capabilities, security, tutorial
    contributing/           # Source-modification playbooks, testing, upgrades
    security/               # Trusted-core and sandboxed-extension threat model
    autonomy/               # Modes, project action policies, Git/merge/deployment gates, adapters
    agent-integration/       # T3 Code RPC version pinning, environment doctor, receipts/reconnect, native-agent entry paths
    research-task-intake/    # UI-first specs, conversation-link context, attachments and provenance
    research-methods/       # Baselines, leakage, valid comparisons and evidence gates
    decisions/              # ADRs and rationale
    build-plan.md           # Staged v1.0 build plan (stage list, status)
    handoffs/               # One handoff file per completed build stage
    troubleshooting/
  AGENTS.md                 # Short Codex entrypoint + docs map
  CLAUDE.md                 # Short Claude Code entrypoint + docs map
  tests/
```

A monorepo develops the platform, while agents, Python projects, UI clients, and workers consume separately versioned components. MLflow remains an upstream dependency/service, not vendored into the product source tree.

## 12. Proposed CLI

```bash
ablationkit coordinator start                # Start Bun + managed MLflow sidecar
ablationkit project add /path/to/repo
ablationkit project doctor --project PROJECT_ID
ablationkit agent drivers list
ablationkit agent environments list                  # Discovered T3 environments/provider instances
ablationkit agent environment doctor --project PROJECT_ID --provider claude --environment ENV_ID
ablationkit task draft --project PROJECT_ID --spec-file experiment-spec.md
ablationkit task draft --project PROJECT_ID --conversation-url URL --notes-file context.md
ablationkit task preflight TASK_ID --environment ENV_ID --provider codex
ablationkit task dispatch TASK_ID --environment ENV_ID --provider codex
ablationkit task events TASK_ID --follow              # UI-first or agent-first task timeline
ablationkit task threads TASK_ID                     # Available bound T3 threads and capability status
ablationkit task conversation TASK_ID --thread THREAD_ID  # Inspect available visible thread messages
ablationkit task message TASK_ID --thread THREAD_ID --file followup.md # New turn, policy-checked
ablationkit task attach --project PROJECT_ID --campaign CAMPAIGN_ID --session-ref SESSION_REF
ablationkit agent campaign new --project PROJECT_ID --mode review --goal-file goal.md
ablationkit agent campaign new --project PROJECT_ID --mode implement --goal-file goal.md
ablationkit project policy show --project PROJECT_ID
ablationkit project policy validate --file project-policy.json
ablationkit project policy propose --project PROJECT_ID --file project-policy.json
# A researcher-authenticated UI/control path must approve any policy update.
ablationkit project approvals list --project PROJECT_ID
ablationkit git proposal commit --project PROJECT_ID --campaign CAMPAIGN_ID
ablationkit git proposal merge --project PROJECT_ID --source agent/candidate --target main
ablationkit deployment proposal create --project PROJECT_ID --target local-preview
ablationkit agent campaign new --project PROJECT_ID --mode explore --policy policy.json
ablationkit agent campaign new --project PROJECT_ID --mode autonomous_research --policy policy.json
ablationkit agent campaign status CAMPAIGN_ID
ablationkit agent campaign events CAMPAIGN_ID --follow
ablationkit agent campaign pause CAMPAIGN_ID
ablationkit agent campaign resume CAMPAIGN_ID
ablationkit agent campaign stop CAMPAIGN_ID
ablationkit agent campaign steer CAMPAIGN_ID --note-file steering.md
ablationkit agent campaign approve APPROVAL_ID --decision accept
ablationkit agent campaign evidence CAMPAIGN_ID
ablationkit agent campaign budget CAMPAIGN_ID
ablationkit run submit --project PROJECT_ID --config configs/exp.json --target local
ablationkit run status JOB_ID
ablationkit run logs JOB_ID --follow
ablationkit compare ATTEMPT_A ATTEMPT_B   # Read MLflow metrics + research context
ablationkit evaluation run --model MODEL_URI --dataset DATASET_REF
ablationkit registry register --model MODEL_URI --name MODEL_NAME
ablationkit registry alias set --name MODEL_NAME --alias champion --version VERSION
ablationkit project entrypoints --project PROJECT_ID
ablationkit project run --project PROJECT_ID --entry train --params params.json
ablationkit inference predict --model MODEL_URI --input sample.json
ablationkit inference session start --model MODEL_URI --idle-timeout 15m
ablationkit inference session predict SESSION_ID --input sample.json
ablationkit inference session stop SESSION_ID
ablationkit inference compare --models MODEL_A,MODEL_B --input sample.json
ablationkit evaluation compare --models MODEL_A,MODEL_B --dataset DATASET_REF
ablationkit demo open --project PROJECT_ID --demo DEMO_ID
ablationkit model serve --model MODEL_URI --port 7001    # Optional explicit endpoint
ablationkit trace list --project PROJECT_ID
ablationkit prompt list --project PROJECT_ID
ablationkit research note add --project PROJECT_ID --file note.md
ablationkit conversation link --project PROJECT_ID --url URL --title TITLE
ablationkit view build --project PROJECT_ID --view model-explorer
ablationkit view approve --project PROJECT_ID --view model-explorer  # Legacy/view convenience
ablationkit extension new --template run-panel --project PROJECT_ID --id model-explorer
ablationkit extension validate --project PROJECT_ID --id model-explorer
ablationkit extension preview --project PROJECT_ID --id model-explorer
ablationkit extension run --project PROJECT_ID --id model-explorer --contribution project.analysis --input args.json
ablationkit extension jobs --project PROJECT_ID --id model-explorer
ablationkit extension logs EXTENSION_JOB_ID --follow
ablationkit extension approve --project PROJECT_ID --id model-explorer
ablationkit extension disable --project PROJECT_ID --id model-explorer
ablationkit extension rollback --project PROJECT_ID --id model-explorer --version 0.1.0
ablationkit dev doctor                     # Source build + docs/test prerequisites
ablationkit tracking doctor                 # Check MLflow + storage + outbox
ablationkit backup create                  # Consistent coordinator + MLflow snapshot
ablationkit ui
```

These commands specify intent, not stable syntax. All machine-facing responses support structured JSON, and CLI operations use the same coordinator APIs as the UI and Agent Skills. A remote CLI connects via an explicit coordinator URL with scoped authentication.

### 12.1 LLM-first CLI/API examples (proposed)

```text
ablationkit llm prompts list --project <project-id>
ablationkit llm prompts diff <prompt-name> --from <version-a> --to <version-b>
ablationkit llm traces list --project <project-id> --status error
ablationkit llm traces show <trace-id>
ablationkit llm eval run --dataset <dataset-id> --variants <variant-set-id>
ablationkit llm eval compare <evaluation-a> <evaluation-b>
ablationkit llm rag inspect <trace-id>
```

These are *proposed* commands, not current binaries. Each must map to a typed Bun API and scoped MLflow integration; CLI operations that incur inference/judge expense or remote data transfer require explicit policy checks. Models, prompts and datasets are resolved to pinned identifiers before executing a recorded evaluation.

## 13. Versioning, recovery, and trust

- Version all manifests, schemas, SDK event envelopes, public extension capabilities/contribution points, Python extension environment locks/result schemas, and MLflow adapter compatibility profiles. Track modified core builds separately from installed third-party extensions.
- Explicitly distinguish agent proposals, approved actions, jobs actually launched, MLflow tracking acknowledgements, and completed results. Versioned campaign policy revisions, observable agent events, approvals/denials, resource usage and research decisions are retained and auditable; no unverifiable hidden-reasoning capture.
- Coordinator ingest deduplicates event IDs and sequences; tracking-to-MLflow delivery uses a durable outbox, reconciliation and visible partial-failure states.
- Keep original run evidence and console events append-only; reports and research summaries preserve version history or provenance where practical.
- Startup diagnoses interrupted JSON replacements, partial JSONL tails, stalled MLflow updates, orphaned tracking runs, unavailable workers, missing artifacts, and pending outbox entries.
- A **backup** includes the MLflow SQLite snapshot, MLflow artifacts, tracking mappings/outbox, project research files, AblationKit settings, and job history. Test restore and migration.
- Manage MLflow version updates and schema migrations deliberately: pin supported versions, back up first, run migration/checks, and show failures clearly.
- Keep the MLflow tracking server private by default; authentication and the coordinator's project-scoped authorization apply to remote workers and clients. MLflow's bind, host-header, and CORS security settings are defense in depth, not a replacement for authentication and network isolation.
- Autonomy policy is checked at the coordinator, agent adapter tool boundary, execution worker and provider/resource layer where available. No level, model, prompt or project extension bypasses hard restrictions; paused/offline campaigns cannot silently acquire broader permissions.
- Sandboxed extensions (React or Python) get no direct credentials, privileged IPC, general filesystem/network access, or direct MLflow server access. Python environments and build artifacts are pinned and independently approved; OS-level isolation is mandatory for untrusted execution. Source-level modifications are trusted core changes and cannot inherit the extension sandbox guarantees; require explicit review/activation and release metadata.

## 14. Implementation phases (internal; all core capabilities required for first public release)

These phases describe the order of implementation, **not feature deferrals after launch**. The staged build plan (`docs/build-plan.md`) refines P0–P4 into smaller stages, each executed by a fresh coding-agent session with a written handoff. A public v1.0 release must meet all section 5.5–5.6 lifecycle contracts and section 15 acceptance criteria, even if the work is built incrementally.

**P0 — Platform, tracking and agent-control foundation:** Bun coordinator + private MLflow sidecar; register two independent repos; execute local Python job; capture logs to JSONL; track params/metrics/artifacts and system metrics; build AblationKit-native experiment/run explorer, metric history, comparison and artifact views; integrate an approved sandboxed React extension and initial Claude Code/Codex Skill. Establish the four-mode policy schema, **a working T3 Code WebSocket RPC adapter for UI-first Claude/Codex task launch**, a scoped agent transport contract, environment preflight (provider, skills, CLI/MCP, workspace permissions), read-only Review and bounded Implement task runs, observable action/approval events and isolated Git worktrees. Implement the minimal Experiment Studio (goal/spec/annotated conversation URL → task draft → preflight → dispatch → T3 thread/events → evidence report), **with compact research activity and expandable full T3 conversation viewing the same thread** and parity with an externally initiated Skill/CLI research task. Establish the manifest/host boundary for **both React and Python** extensions, a Python worker sandbox prototype, repository architecture map, agent entrypoints, and reproducible source dev/test setup.

**P1 — Architecture research and bounded exploration vertical slice:** ship a project-scoped custom Python evaluator/analyzer in an isolated worker and a paired React view using typed result references; hypotheses, reports, conversation links and portable JSON/Markdown; task context-package provenance and T3 thread/turn correlation, conversation/approval parity, snapshot/reconnect recovery and honest partial-history states; arbitrary project-defined training entrypoints, variant configurations, baselines, experiment grouping, custom metrics, qualitative artifacts and evidence-backed reports. Prove the workflow with a custom model/training loop and a replaceable preprocessing/tokenization component **without building special knowledge of that component into AblationKit**. Add logged-model/registry and dataset views plus initial MLflow trace and prompt-registry browsing. General ML workflows remain independently usable without an LLM profile.

**P2 — Evaluation, deeper LLM workflows and cross-domain inference:** classical MLflow evaluation and threshold/diagnostic UI; one-shot and warm interactive sessions with signature validation, supervised local serving, paired comparison and tracked batch evaluation; first-class RAG retrieval/tool-call diagnostics and LLM judge provenance; non-LLM tabular and image task-adapter tests; research-first Inference Lab; `MLproject` discovery/execution and grouped ablations.

**P3 — Interactive demo studio and offline compute:** finish GenAI evaluation/slice/feedback UX, prompt/model comparison reports, approved React/TypeScript LLM and vision/tabular demos with sandboxed inference capabilities; finish the extensible contribution registry, Python evaluator/analyzer contribution points, restricted action and report extensions, locked dependency builds, resource-permission diagnostics and rollback; Electron mode; remote clients; independently supervised workers with durable spool/reconciliation; provider job IDs and shutdown/restart recovery.

**P4 — Autonomy hardening, compute adapters and release qualification:** Runpod, SLURM package/export and supported Colab operations; compute approvals; cloud artifact transport; permission/security testing including Python worker escapes/limits, both extension SDKs/examples and modified-source build smoke tests; docs-as-code drift checks; tested Review/Implement/Explore/Autonomous modes, scientifically valid campaign lineage, approval/stop/steer and resource-exhaustion recovery, source diff review, provider-specific agent adapter capability negotiation and matched-budget harness baseline evaluation; end-to-end UI/API/CLI parity against pinned MLflow; backup/restore and upgrade tests. **Release gate:** all required core lifecycle workflows complete in the AblationKit UI without stock MLflow UI access, and both customization tiers satisfy section 8.7.

## 15. Acceptance criteria for v0.15 design

1. **Portability:** two unrelated ML repos use one centrally installed platform and shared skills, without copying the entire workspace.
1a. **Arbitrary architecture research:** a repository with a custom training loop, project-defined model and tokenizer/preprocessing component can define baseline and candidate variants, run both, record arbitrary metrics and artifacts, compare outcomes, and produce a linked research report without modifying the AblationKit core or adopting an LLM prompt workflow.
1b. **Project-specific domain intelligence:** a project-authored Agent Skill and approved sandboxed visualization can explain and analyze custom model internals through authorized evidence APIs, with no built-in code specific to a named paper or architecture.
2. **One coordinator:** a remote browser/CLI connects securely to a main-machine coordinator; data files are never edited through a remote share.
3. **File-based research:** AblationKit-owned project/research/job records are JSON, JSONL, Markdown, and files; MLflow's managed SQLite is permitted only for MLflow data.
4. **Tracking UI parity:** researcher can create/manage MLflow experiments/runs, inspect metrics/params/artifacts/system metrics, filter/compare/export results completely in AblationKit with no MLflow UI handoff.
5. **Data lineage:** UI displays datasets, versions/fingerprints, input roles/splits, and linked runs/models where supported; source revision/provenance is preserved.
6. **Model lifecycle:** model logged with supported MLflow flavor is inspectable/downloadable; researcher can register/version/alias it, inspect lineage and choose a version in AblationKit.
7. **Classical evaluation:** launch supported classification/regression evaluation, view metrics/plots and threshold results, link evaluation to runs/models in UI without manual MLflow CLI usage.
8. **Projects execution:** detect a test `MLproject`, display entrypoints/params, launch a project run, and observe it through AblationKit's job and MLflow tracking views. Another project runs without an `MLproject` file.
9. **Research inference:** from AblationKit, load a pinned logged/registered model and run a one-shot prediction without starting a permanent inference endpoint; display validated input, output, errors, load time and prediction latency.
9a. **Interactive sessions:** open a supervised warm model session, make repeated predictions without reloading each time, inspect readiness/logs/resource use, and verify idle expiry, explicit stop and crash cleanup.
9b. **Model comparison:** compare at least two supported pinned model versions on identical examples; show aligned predictions and disagreements, enforce compatible input schemas, and link saved comparisons to exact versions/dataset/provenance.
9c. **Tracked batch evaluation:** execute a reproducible fixed-dataset comparison, inspect aggregate metrics and example-level failures/diagnostics in AblationKit, and verify MLflow holds canonical saved evaluation artifacts.
9d. **Interactive demo:** researcher approves an agent-authored React/TypeScript model demo, uses it to submit predictions via a narrowly scoped capability bridge, and can explicitly save a result/snapshot; the extension cannot call MLflow or worker endpoints directly.
9e. **Privacy and offline behavior:** unsaved exploratory inputs are not automatically persisted in MLflow; workstation shutdown stops local sessions; a previously submitted independently supervised remote evaluation reconciles without duplicate execution. Serving remains optional per model.
10. **GenAI lifecycle:** ingest a representative LLM/agent trace, inspect spans, run supported GenAI evaluation against a dataset, and browse prompt versions through AblationKit UI; use a pinned MLflow version supporting tested operations.
10a. **LLM prompt/model comparison:** pin two prompt/model/config variants, execute both over the identical versioned golden evaluation set, show side-by-side per-example outputs, scorer feedback, errors and recorded latency/token usage; resolve prompt aliases to exact versions.
10b. **LLM trace and agent analysis:** inspect a nested trace with an LLM span, retrieval span and tool invocation; show durations/errors and safe (redacted) inputs/outputs; link a failed evaluation example to its trace and report without duplicating canonical span data.
10c. **RAG/evaluator provenance:** for an instrumented RAG project, inspect retrieval references and grounding feedback; record evaluator/judge model, rubric, dataset version and index/config revision. Unsupported or non-instrumented fields show explicit unavailable states rather than invented evidence.
10d. **Non-LLM parity:** tabular classification/regression and at least one vision project can execute experiments, inspect metrics/artifacts/model lineage, perform supported evaluations/inference through adapters, and render task-specific output in the AblationKit UI; neither is required to use GenAI tracing/prompt flows.
10e. **LLM data controls:** external judge/provider egress is permissioned; raw prompts, trace payloads and retrieved content honor capture/retention/redaction settings; estimated token costs are labeled estimates and missing usage stays missing.
11. **Reliable partial failure:** training logs remain viewable when MLflow is down (while workstation runs); tracking operations show pending/retry state instead of claiming commit.
12. **Coordinator offline:** a remotely submitted durable training job completes while workstation is off; after restoration, status/metrics/models/artifacts reconcile without duplicate submission. A remote inference endpoint is persistent only if independently supervised.
13. **Observability:** show agent actions, console output, curves and model/evaluation links for local and remote runs; native extensions remain project-scoped.
14. **Continuity:** restart retains notes, job history, evidence, datasets, model provenance and research links.
15. **Extensions:** approved React/TypeScript view is build/runtime isolated and cannot read other projects or MLflow credentials.
15a. **General small-extension support:** an agent adds a scoped run tab or report component and a restricted project action through the versioned extension host—without changing platform source. The researcher can inspect, approve, disable and roll back; the host stays functional when all extensions are disabled.
15b. **Portable per-project permissions:** installing the same extension into a second independent project requires that project's own approval/capability grant. Mismatched host API versions are rejected with actionable diagnostics.
15c. **Trusted source changes:** a coding agent follows the published architecture/source-edit guide, modifies a Bun core service or first-party screen in a Git branch, executes automated checks, and produces a reviewable build; the running coordinator remains unchanged until explicitly replaced.
15d. **Documentation quality:** a new agent can discover relevant source locations from `AGENTS.md` or `CLAUDE.md`, follow runnable React extension, Python evaluator, React+Python extension and source-change tutorials, and run tests without undocumented setup steps. Docs/API types/examples are validated in CI.
15e. **Python extension execution:** a research agent creates a project-scoped evaluator using extension-declared, pinned Python dependencies in its own `uv` environment, runs it as a resource-limited subprocess, receives logs/progress and typed summary/artifact references, and displays its findings in an approved React tab. No core edits or direct MLflow credentials are required.
15f. **Python extension approval and limits (v0.16):** an extension runs only after approval of its exact source, lockfile and capability hashes; any change invalidates approval; it cannot exceed declared CPU/memory/time limits; the same source installs in another project only after per-project approval and can be disabled/rolled back without losing canonical MLflow evidence. The UI labels approved extensions as trusted code.
16. **Conversations:** external chat links and researcher notes are linked to projects/hypotheses/runs without transcript sync.
17. **Backups:** restore covers AblationKit research/job state, MLflow database and artifacts, model registry state, and prompt/trace/evaluation data where stored by MLflow.
18. **API coverage:** maintain tests for the MLflow feature compatibility matrix and UI workflows; no stock MLflow UI iframe/link is needed to satisfy a required feature.
19. **Review autonomy:** an agent reviews source and MLflow experiment evidence and produces findings without modifying project files, starting a training job, or invoking unapproved shell/network actions; attempts are denied at the tool boundary.
20. **Implement autonomy:** an agent implements a specified task in an isolated worktree, runs allowed validation, and produces a reviewable diff and evidence summary; cannot merge protected branches or exceed approved scope.
21. **Explore autonomy:** given a fixed objective and baseline, an agent independently proposes at least two controlled variants, records hypothesis/branch lineage, runs allowed evaluations and compares verified MLflow metrics within one approved resource envelope.
22. **Autonomous-research loop:** after one bounded authorization, a coding agent autonomously executes multiple propose/implement/run/compare/iterate cycles, preserving negative outcomes and policy-versioned decisions, stops on exhaustion/goal/stagnation, and produces an evidence-linked report without routine per-experiment approval.
23. **Permission enforcement:** a campaign cannot access prohibited files/secrets, change approval or spending policy, merge protected code, install privileged extensions, publish externally or send restricted data off-machine merely by requesting these actions. Privileged scopes require independent explicit authorization and enforcement; failures fail closed.
24. **Budget enforcement and transparency:** separate agent API costs, GPU-time/compute charges and external service use; no new work after a configured cap, surface estimate freshness and delayed provider billing, and expose unavoidable best-effort cancellation limitations.
25. **Control and recovery:** researcher can pause/stop/steer an active campaign and inspect worktrees/events/branch graph; a host restart restores durable decisions and resumes safely from reconciled state, never fabricating continued in-flight agent execution.
26. **Offline semantics:** when coordinator shuts down, independently supervised queued remote jobs may finish and reconcile later; a coordinator-bound autonomous decision loop visibly pauses. Optional delegated remote campaigns enforce their own bounded policies and fail closed if they cannot enforce them.
27. **Minimal-harness performance baseline:** use a pinned coding-agent baseline versus research orchestration modes on at least two representative tasks with matched models and budgets; record measurable improvement or remove/rework complexity. Parallel/tree search is optional, not required to claim core autonomy support.
28. **Scientific evidence:** comparisons preserve baseline, evaluation dataset/split, source changes, budget, seeds/repetitions where appropriate and MLflow run IDs; outputs distinguish evidence from interpretation and prevent unsubstantiated success/novelty assertions.
29. **Per-project independent controls:** two projects with different policies can run the same autonomous campaign; one permits isolated commits but denies all pushes/merges, while another requires approval before committing; no project inherits rights from another project or an agent preset.
30. **Explicit commit/push/merge separation:** allowing edits or a commit never enables a push or merge in AblationKit's gates. With the provider sandbox enabled, a direct `git push` from an agent session is refused; a direct push or merge to a ruleset-protected GitHub branch is rejected server-side; any remaining path is labeled advisory and every attempt AblationKit observes is audited.
31. **Guarded integration:** a project allowing `git.merge` after checks validates source/target SHAs and tests the actual merge result; a changed target, failed check, protected-branch rule, or expired approval prevents integration and requires revalidation.
32. **Deployment permissions:** project A can auto-open a loopback research preview but cannot create a persistent/public endpoint; project B can require approval for an explicitly scoped remote research session. Both get model-version pinning, TTL/budget enforcement and audit records.
33. **Policy integrity:** an agent modifying `.ablationkit/project.json`, a policy proposal, prompts or files in its worktree cannot modify the coordinator-owned effective policy. Owner edits produce immutable revisions; pending grants are invalidated on reduction; unsupported enforcement fails closed.
34. **Offline privileged-action behavior:** remote experiments complete with pre-issued bounded authorizations while the workstation is unavailable, but queued new pushes/merges/deployments do not execute silently on reconnection. Reconciliation identifies the current policy and target state before any action.
35. **Provider-independent policy:** run the same action-policy conformance tests against supported Claude and Codex adapters, including direct shell attempts, project-path escapes, push-to-protected-ref attempts, denied remote network operations and explicit approval workflows. If adapter/sandbox enforcement is insufficient, mark unsupported action modes unavailable.


36. **UI-first launch:** researcher opens AblationKit, enters a goal or uploads an experiment specification, chooses a project/provider/autonomy and successfully launches a Claude Code/Codex turn through a pinned T3 Code WebSocket RPC adapter; streaming events, changes, MLflow runs, and reports appear in the native UI under one task ID.
37. **Conversation-link intake:** researcher may paste a ChatGPT or Claude conversation URL plus their own notes and launch a task without pretending to have fetched private transcript content; an explicitly uploaded excerpt/file reaches the agent with a visible source hash and accepted data-egress scope.
38. **Agent-first parity:** a project researcher starts Claude Code or Codex externally, invokes an AblationKit Skill/CLI/MCP workflow and creates/links the same task, campaign, policies and MLflow evidence; existing session attachment is optional and never creates duplicate turns.
39. **Environment readiness:** preflight blocks a UI task if its selected provider is unauthenticated, a required skill is unavailable/disabled in that actual provider session, CLI/MCP authorization is missing, or the mapped worktree is incorrect; optional skill absence yields warnings and actionable repair paths.
40. **Safe setup:** after the researcher approves and completes skill/tool configuration from trusted sources, the relevant agent session is refreshed and preflight passes; changing to a different T3 environment invalidates prior readiness. No silent auto-installation or privilege elevation occurs.
41. **T3 adapter compatibility:** test at least one pinned T3 Code version against each selected Claude/Codex provider; incompatible upstream RPC shape/version results in an explicit blocked/unsupported message, not silent execution or a fake success; a documented fallback exists for agent-first CLI/MCP use.
42. **Reconnection and deduplication:** restart AblationKit during/after T3 turn submission and reconcile its dispatch receipt/thread/turn; no duplicate agent turn, training job or MLflow run is launched automatically when the original result is uncertain.
43. **Permission separation:** a T3 provider runtime mode permitting broad access cannot override AblationKit's narrower per-project experiment/Git/deployment gates; an unenforceable combination is blocked or narrowed before dispatch, including when the coding agent invokes Git directly.
44. **Scientific vs. agent status:** a T3 turn ending successfully does not mark the scientific experiment successful without the declared evaluation/evidence gates. Task, session, campaign, execution job and MLflow run IDs remain distinguishable.
45. **Single-session dual view:** open a task in compact Research Activity mode, expand Conversation, then collapse; the active T3 environment/thread/turn and submitted task remain unchanged, and no new turn or token use is triggered by toggling.
46. **View continuity:** unsent composer draft, selected thread, pending approval and meaningful scroll/selection state survive a view toggle; sending a message from either view targets the same authorized thread and appears in both projections.
47. **Research activity fidelity:** the compact view links a hypothesis, code diff, agent action and MLflow run/result to authoritative evidence; it never labels a proposed experiment as completed or exposes hidden reasoning.
48. **Full conversation behavior:** the expanded view renders available provider messages, streaming output, visible tool interactions, approval requests and diff links; unsupported events are labeled without synthetic content or a stock T3 UI handoff.
49. **Approval parity:** one pending approval appears in both views, is resolved at most once through current project policy, and a stale or concurrently resolved approval is rejected without silently accepting it.
50. **Reconnection:** drop the T3 connection and resume it; use snapshots/cursors for recovery where available, visibly mark unrecoverable transcript gaps, retain evidence/summary state and never auto-send a saved draft or duplicate a turn.
51. **Multi-thread task:** one research task can link several T3 threads; selecting a different thread is explicit, and switching compact/full presentation never changes selected thread without the researcher's action.
52. **Agent-first fallback:** a task created through Claude Code/Codex CLI/MCP without an attached T3 transcript still shows its research timeline, while full Conversation explicitly reports unavailable/external history rather than inventing a chat.
53. **Cross-client isolation:** two authenticated clients observing one thread see consistent turns/approvals; unauthorized project clients and sandboxed project extensions cannot read conversation content or invoke privileged T3 operations.
54. **Contract compatibility/performance:** against pinned T3/Claude/Codex versions, test event normalization, snapshot/stream recovery, high-volume streamed text, view toggling without duplicate subscriptions, and provider capability fallbacks.
55. **Provider sandbox enforcement (v0.16):** for a task whose policy denies push and external network, Claude Code and Codex sessions launched by AblationKit refuse `git push` and requests to non-provider hosts; preflight shows the enforcement level for each control.
56. **API separation:** an agent token cannot call policy-edit, approval-resolution or extension-activation routes (they do not exist on the agent listener); a worker token can only upload for its own job/attempt.
57. **Step-up:** policy revisions, permission/budget increases and privileged approvals fail without a fresh passkey step-up, including from a remote Tailscale client.
58. **Honest enforcement labels (v0.16):** when a provider sandbox is unavailable, the task shows affected controls as advisory, and modes relying on enforced denial require explicit researcher acknowledgment before dispatch.
59. **Research export:** research records edited by an agent through CLI/MCP appear in the coordinator and in the main-checkout export; edits to export files inside an agent worktree have no effect on canonical records.
60. **Study naming and MLflow mapping:** a project's runs land in MLflow experiment `ak/<project-id>` with study, variant, task and campaign tags; an imported historical MLflow experiment is linked read-only.


## 16. Resolved decisions and remaining tradeoffs

### Resolved through v0.14

| Decision | Choice | Consequence |
| --- | --- | --- |
| Primary audience | Individual researcher | No collaborative organization or multi-user RBAC in MVP |
| Cross-machine topology | One primary workstation coordinator; independently supervised remote workers | Workstation may power off while jobs finish; live control unavailable until it returns |
| Research storage | JSON/Markdown/JSONL | Portable and transparent; needs atomic writes, recovery, backup |
| Experiment tracking | MLflow canonical backend behind Bun | Avoid duplicating metrics/params/artifacts; accept MLflow-managed SQLite |
| MLflow user interface | AblationKit native UI for entire declared core ML lifecycle | API coverage/contract tests required for tracking, datasets, evaluation, models, registry, Projects, serving, traces and prompts; no stock UI handoff |
| Research-first serving / MLflow Projects | One-shot prediction, temporary interactive sessions, paired model comparison, batch evaluation and sandboxed demos are first-release workflows; MLflow Projects remains supported | Persistent public production endpoints are not the goal; all workflows are optional per project/run, and none is a prerequisite for tracking |
| Model evaluation | Both classic and GenAI evaluation supported as applicable | Use distinct upstream APIs and isolated Python workers; surface metrics and evidence in UI |
| GenAI tracing and prompt registry | Core optional-by-project MLflow lifecycle capability | Native trace, evaluation and prompt UI required in first release |
| ML domain breadth vs. specialization | Architecture-agnostic ML core, custom training/model/tokenizer support, plus deeper first-party LLM/RAG/agent UI tools | Domain-specific research methodology lives in project adapters, Agent Skills and approved UI views, not in the core or a named paper implementation |
| Primary interaction model | Dual entry points: AblationKit UI-first personally; Claude Code/Codex agent-first equally supported | Both create the same durable research task/campaign/evidence records; neither UI nor agent session is the sole system of record |
| UI-to-agent bridge | T3 Code as primary provider/session controller through versioned authenticated WebSocket RPC | Bun coordinator wraps T3, pins RPC compatibility and correlates T3 environment/thread/turn IDs; direct SDK adapters are optional fallbacks |
| T3-backed agent panel (v0.14) | Compact Research Activity by default, expandable full Conversation view, same bound T3 thread/session | One coordinator-gated conversation gateway and event source; no separate chat backend or new turn on toggle; partial history/unsupported states must be explicit |
| Agent environment readiness | Check selected execution host/provider instance for discoverable skills, tools, MCP, auth, workspace and enforceable permissions before UI launch | Missing mandatory capability blocks dispatch; repair needs researcher consent and a fresh session-level check |
| CLI and agent integration | Bun API + shared Agent Skills / optional MCP | Same API/IDs for humans and agents |
| Conversations | Links + notes | External sources are referenced, not ingested/synchronized |
| Level 1 — project extensions | Agent-authored versioned React/UI contributions **and Python evaluators/analyzers** through sandboxed extension host and separate worker runner | Project-specific, portable, independently permissioned and dependency-pinned; no core edits, unsandboxed Python or unrestricted host code |
| Level 2 — full source modification | Supported coding-agent modification of the Bun/Python/Electron monorepo | Unlimited core changes, but trusted execution, review, testing and fork upgrade responsibility |
| Developer documentation | Architecture map, public SDK/contracts, code-edit guides, `AGENTS.md`/`CLAUDE.md`, examples and CI checks | Coding agents can implement changes without reverse-engineering hidden internals |
| Compute adapters | AblationKit orchestrates; MLflow records outcomes | Runpod/SLURM/Colab do not require replacing MLflow tracking |
| Agent autonomy | Four project/campaign-level presets: Review, Implement, Explore and Autonomous Research; fine-grained policy overrides | Increasing independence changes research-workflow latitude only inside approved capability/budget gates |
| Per-project source-control and deployment authority | Separate decisions for experiments, isolated commits, pushes, merges and research/public deployments; deny/ask/allow with explicit conditions | Highly autonomous research need not imply integration or deployment privileges; all actions are audited and checked against authoritative coordinator-side project policy |
| Agent runtime | For UI launch, reuse T3 Code's provider/turn orchestration of Claude Code/Codex; keep default strategy minimal and single-agent | AblationKit owns campaign state, evaluation evidence, worktree isolation and approvals, not a duplicate coding harness; optionally use direct SDKs in supported fallbacks |
| Research exploration | Sequential evidence-driven loop by default; strategy plugins for bounded parallel/tree search | Avoid hardcoded multi-agent planners; benchmark value against matched-budget minimal baseline |
| Offline autonomous work | Independently supervised jobs persist; autonomous agent process pauses unless explicitly delegated to a capable, bounded remote supervisor | Workstation shutdown never implies automatic agent-loop survival |

### Resolved in v0.15

| Question | Decision |
| --- | --- |
| Release scope | All features in v1.0; phases and stages are build order only |
| Audience | Personal first, published as open source; Linux reference platform |
| Host sandbox | None in v1.0: no containerization. Provider-native agent sandboxes, systemd resource limits, passkey step-up and GitHub rulesets; each control labeled enforced or advisory (section 7.11) |
| Researcher vs agent authentication | Three APIs; passkey step-up (physical presence) for privileged writes; no TOTP fallback (section 7.11) |
| T3 dependency | T3 is the only UI agent transport for v1.0, pinned; direct Codex app-server / Claude Agent SDK transport added behind `AgentTransport` only if the T3 validation below fails |
| Plan before execution | Yes for Implement/Explore/Autonomous (switchable per task); Review skips it |
| Entity naming / MLflow mapping | `Study`/`Variant`; one MLflow experiment per project (section 6.1) |
| Research record authority | Coordinator state canonical; repository files are exports (section 5.1) |
| Agent cost measurement | Tokens, turns and wall time by default; `max_agent_usd` enforced only for API-key billing, labeled in UI |
| Notifications | libnotify + Electron/browser; optional ntfy, including from workers |
| Worker credentials | Per-job upload-only tokens valid to terminal state + 7-day grace |
| MLflow packaging | Managed sidecar in a coordinator-owned `uv` environment, pinned to the latest MLflow 3.x at implementation time; SQLite + local artifacts |
| SDK ingestion | Collector-mediated by default; explicit MLflow-native logging opt-in |
| Artifacts | Local filesystem; optional S3-compatible store (MinIO/R2) for remote workers with large uploads |
| Remote network | Tailscale only; no public gateway in v1.0 |
| Persistence semantics | JSONL for console/agent activity, MLflow for metrics; 10 GB default spool per worker; job refused if free disk < 2x declared output estimate |
| Compute order | Local, Runpod, SLURM, Colab |
| First framework | Custom PyTorch loop plus uninstrumented Python command |
| Model flavors | pyfunc, sklearn, pytorch, transformers |
| First remote inference adapter | Runpod (generic container worker) |
| Local LLM serving | One OpenAI-compatible endpoint adapter (vLLM, llama.cpp server, Ollama) |
| Extension dependencies | Curated SDK + pinned npm allowlist; Python from a pinned `uv.lock`, installed into a per-extension `uv` environment at approval time |
| Trace privacy | Local raw payloads retained 30 days; remote capture off unless enabled per project; saved evidence kept until deleted |
| Default budgets | Review: 30 min, no compute. Implement: 2 h, local tests only. Explore: 8 h, 4 GPU-hours, $10 compute. Autonomous: must be set explicitly |
| Git hosts / auto-merge | GitHub first (GitHub App or fine-grained token in broker, rulesets); auto-merge only on GitHub with rulesets; local-only repos ask-only, labeled "locally enforced" |
| Owner's direct Git commands | Not governed by design |
| Existing experiment import | Link historical MLflow experiments read-only to a project |
| Extension contribution points in v1.0 | `project.panel`, `run.tab`, `comparison.view`, `report.block`, `project.action`, `project.analysis`, `run.evaluator`, demos |
| Marketplace | Not needed; Git-friendly extensions plus signed/hashed export |

### Remaining validation items (do not change decisions)

1. **T3 Code:** pin a release; verify event subscription, streaming deltas, approval request/response, interrupt, snapshot/cursor replay and authentication against it. Creating a project and starting a thread are already confirmed working.
2. **T3 crash window:** recovery when T3 acknowledges a turn but the coordinator crashes before persisting the receipt.
3. **Skill inventory:** prove provider skill inventory and session refresh for Claude and Codex in T3 sessions on the workstation.
4. **Provider sandboxes:** confirm Claude Code's and Codex's Linux sandboxes (and their permission rules) can be generated per session from policy and actually block `git push` and non-provider network on the reference workstation.
5. **Matched-budget harness baseline (criterion 27):** run before shipping orchestration complexity beyond the sequential default.

### External reference documentation

T3 Code integration sources reviewed for v0.13 (2026-11-02):

- T3 Code repository and architecture: https://github.com/pingdotgg/t3code
- T3 Code internals, execution and transport ownership: https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md
- T3 Code client connection runtime/reconnect semantics: https://github.com/pingdotgg/t3code/blob/main/docs/internals/connection-runtime.md
- T3 Code WebSocket/RPC and provider design guidance: https://github.com/pingdotgg/t3code/blob/main/docs/internals/effect-services.md
- T3 Code external-agent MCP and host CLI integration: https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md
- T3 Code skills/composer discovery and restart semantics: https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md
- T3 Code Claude skill/config directory behavior: https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md
- T3 Code provider runtime and account isolation: https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md



Research harness and agent runtime sources reviewed for v0.11 (as of 2026-11-02):

- SakanaAI AI-Scientist-v2 README and tree-search methodology: https://github.com/SakanaAI/AI-Scientist-v2
- SakanaAI The Agentic Scientist (October 2026): https://pub.sakana.ai/agentic-scientist/
- Apple/EPFL minimal-harness MLE study (October 2026): https://machinelearning.apple.com/research/harness-autonomous-ml-engineering
- WecoAI AIDE algorithm and tooling: https://github.com/WecoAI/aideml
- Agentic research verification gap survey (2026): https://arxiv.org/abs/2608.05179
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Claude Agent SDK permissions/hooks: https://code.claude.com/docs/en/agent-sdk/permissions
- Codex SDK: https://learn.chatgpt.com/docs/codex-sdk
- Codex app-server agent lifecycle and approvals: https://learn.chatgpt.com/docs/app-server
- Git hooks and why client-side hooks are insufficient for security policy: https://git-scm.com/book/en/v2/Customizing-Git-Git-Hooks
- GitHub protected branches and checks/reviews: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- Claude Code lifecycle hooks and permission configuration: https://claude.com/blog/how-to-configure-hooks
- Codex execution sandbox/approval security guidance: https://learn.chatgpt.com/docs/agent-approvals-security



- MLflow architecture and server: https://mlflow.org/docs/latest/self-hosting/architecture/tracking-server/
- MLflow metadata backend: https://mlflow.org/docs/latest/self-hosting/architecture/backend-store/
- MLflow Tracking REST API: https://mlflow.org/docs/latest/api_reference/rest-api.html
- MLflow tracking / experiments: https://mlflow.org/docs/latest/ml/tracking/
- MLflow Model Registry: https://mlflow.org/docs/latest/model-registry/
- MLflow Model Serving: https://mlflow.org/docs/latest/ml/deployment
- MLflow local serving and batch prediction: https://mlflow.org/docs/latest/ml/deployment/deploy-model-locally/
- MLflow Model Registry aliases and lineage: https://mlflow.org/docs/latest/model-registry/
- MLflow Projects: https://mlflow.org/docs/latest/projects/
- MLflow classical model evaluation: https://mlflow.org/docs/latest/ml/evaluation
- MLflow GenAI evaluation: https://mlflow.org/docs/latest/genai/eval-monitor/
- MLflow GenAI datasets: https://mlflow.org/docs/latest/genai/datasets
- MLflow prompt registry: https://mlflow.org/docs/latest/genai/prompt-registry/
- MLflow GenAI tracing: https://mlflow.org/docs/latest/genai/tracing/
- MLflow LLM evaluation scorers: https://mlflow.org/docs/latest/genai/eval-monitor/scorers/
- MLflow evaluation datasets: https://mlflow.org/docs/latest/genai/datasets/
- MLflow system metrics: https://mlflow.org/docs/latest/ml/tracking/system-metrics/
- Electron security architecture: https://www.electronjs.org/docs/latest/tutorial/security/
- Python virtual environments (dependency isolation, not a security sandbox): https://docs.python.org/3/library/venv.html
- Docker engine isolation/security and daemon attack surface: https://docs.docker.com/engine/security/
- Kubernetes OS isolation / seccomp limits: https://kubernetes.io/docs/concepts/security/linux-kernel-security-constraints/
- MDN iframe sandbox and CSP: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- OpenAI Codex AGENTS.md instructions: https://learn.chatgpt.com/docs/agent-configuration/agents-md

## 17. Change log

### v0.16 — 2026-11-02

- Removed containerization from v1.0 at the researcher's direction. Rewrote section 7.11 as a trust model: agents, jobs and extensions run as the researcher's user; controls are provider-native agent sandboxes, systemd resource limits, passkey step-up and GitHub rulesets, each labeled enforced or advisory. OS-isolation requirements in sections 8.3, 8.4.1, 8.7 and 13 become an optional future hardened mode.
- Dropped TOTP fallback (a stored secret is readable by same-user processes). Replaced Podman and egress-proxy packages with process-supervisor and provider-sandbox. Revised acceptance criteria 15e, 15f, 30, 55, 57, 58.

### v0.15 — 2026-11-02

- Recorded researcher answers: all features in v1.0; personal tool also published as open source; Linux (Omarchy/Arch) reference platform; T3 RPC confirmed for project creation and thread start.
- Added section 7.11 security architecture: reachability-based enforcement, trust zones, three authenticated APIs with passkey/TOTP step-up, per-task rootless Podman agent containers, egress proxy, Git broker as sole credential holder.
- Added normative information architecture to section 2.2 (global layer, seven project sections, agent dock, attention inbox, status bar, lineage strip, command palette).
- Renamed AblationKit `Experiment` to `Study` (+ `Variant`); added section 6.1 glossary and one-MLflow-experiment-per-project mapping.
- Made coordinator state authoritative for research records; repository files are exports.
- Replaced section 16 open questions with a resolved table and a short validation list; added acceptance criteria 55–60; fixed undefined "L4" reference; added repo layout entries for auth, sandbox, egress proxy, build plan and handoffs.

### v0.14 — 2026-11-02

- Established a **two-mode agent panel** as a first-release requirement: compact research-oriented activity view by default, expandable **full T3-backed Conversation** view on demand. Both presentations bind to the same provider environment/thread/turn, with no duplicate dispatch or provider session on toggle.
- Defined the **ConversationGateway** and normalized event flow, research evidence/activity projection vs authoritative T3 transcript, text streaming/approvals/visible tool events, multi-thread navigation, and preservation of draft/selection/pending approval across view changes.
- Specified coordinator-enforced messages, interruptions and approval decisions; recover from disconnect via snapshots/cursors and mark unsupported provider capabilities or irrecoverable history gaps clearly. No hidden reasoning or simulated transcript.
- Extended UX, architecture, proposed API/CLI, internal phases, tradeoffs, and ten acceptance tests for dual-view parity, reconnect, session identity, access control and performance. Preserved v0.13's UI-first T3 orchestration and agent-first CLI/MCP parity.

### v0.13 — 2026-11-02

- Resolved primary interaction ambiguity: **AblationKit UI-first is the preferred personal workflow**, while **Claude Code/Codex agent-first is equally capable**. Both use the same projects, task/campaign state, permissions, experiment jobs, MLflow evidence, and reports.
- Made **T3 Code** the default UI-to-agent session/provider abstraction via a version-pinned, server-side typed WebSocket RPC adapter. Kept direct Claude/Codex SDK drivers optional and Skills/CLI/MCP as the agent-first path. No redundant coding-agent loop.
- Added **Experiment Studio intake** from freeform goal, file/spec and annotated ChatGPT/Claude conversation URL; private chat links remain references unless researcher supplies content explicitly. Added source hashes, context-package preview and stable task/session/experiment mappings.
- Defined **Agent Environment Preflight**: selected T3 host, provider authentication/readiness, discoverable/enabled Agent Skills and versions, project/worktree mapping, CLI/MCP/tool availability and effective authorization before dispatch; actionable user-approved fixes and restart/re-probe rules.
- Defined research task lifecycle, T3 thread/turn correlation, disconnected/reconnect behavior, nonduplicating dispatch, provider capability negotiation, fail-closed permission mapping, UI/CLI examples and nine additional acceptance tests.
- Preserved full MLflow-backed research lifecycle, local-first storage, offline-worker guarantees, project extension model, two-tier customizations, and per-project source-control/deployment permissions.


### v0.12 — 2026-11-02

- Made **experiment execution, commits, pushes, merges and deployment actions independently configurable per project**, instead of implying Git/deployment privileges from autonomy mode; new action policies use `deny` / `ask` / `allow` and explicit conditions.
- Defined **coordinator-owned authoritative JSON policy**, policy revision/approval audit, precedence/intersection with campaign grants and provider sandboxes, reauthorization at action time, and denial of agent-authored privilege escalation.
- Added a concrete illustrative `ProjectActionPolicy` schema, Git worktree/branch/ref controls, exact-source-and-target merge revalidation, evidence/test gating, deployment target pinning, and protection against direct shell/remote bypasses.
- Specified offline constraints: preauthorized experiments may finish, but disconnected workers cannot expand Git/deployment authority; deferred privileged actions revalidate after coordinator reconnection.
- Extended UI, CLI, repository layout, developer docs, resolved decisions and seven acceptance tests. Preserved architecture-agnostic ML scope, MLflow backend, local-first JSON research state, and Claude/Codex as coding agents.

### v0.11 — 2026-11-02

- Added **four autonomy modes** (Review, Implement, Explore, Autonomous Research) as project/campaign-scoped presets over fine-grained permissions, approval gates, scope, budgets, concurrency and stop conditions; high-autonomy research is supported without universal blanket permissions.
- Added `ResearchCampaign`, `AutonomyPolicy`, branch/decision/approval/budget and agent-session objects with a durable state machine, a researcher-facing Agent & Campaign Center, steering/pause/stop/approval UX, and source/MLflow evidence lineage.
- Made **Claude Agent SDK and Codex SDK/app-server adapters** the default implementation direction; avoid duplicating existing coding-agent harnesses. The research layer owns reproducible experiments, comparison/evidence gates, policy enforcement, resumable campaign state and investigator oversight.
- Reviewed **AI-Scientist-v2, Sakana's October 2026 Agentic Scientist, AIDE, and Apple/EPFL October 2026 minimal-harness study**. Made sequential single-agent orchestration the starting baseline; optional parallel/tree search requires matched-budget performance justification.
- Defined the difference between remote jobs surviving workstation shutdown and a live *autonomous agent loop* surviving: only explicitly delegated, independently supervised and bounded remote campaigns can continue making new decisions offline.
- Updated core services, UI, CLI, repository layout, documentation, implementation phases, testable acceptance criteria, security, budgets and outstanding decisions. Preserved MLflow canonical tracking, JSON research records, two-tier extensions and broad ML support with LLM-first conveniences.

### v0.10 — 2026-11-02

- Confirmed that **Level 1 small extensions may include custom Python backend logic** (project-specific evaluators, analyzers, data processors and small approved tools), including headless and React+Python combinations; this is a first-release requirement, not a future fallback to core source edits.
- Specified a distinct sandboxed Python extension runner, public Python extension SDK, typed entrypoint/result protocol, separate dependency locks, per-project approvals, data brokerage, resource/time limits, and structured artifacts/progress/recovery. Python never executes inside the Bun coordinator.
- Clarified that Python `venv` is package isolation, **not a security boundary**. Untrusted Python requires actual OS-enforced isolation; unsupported platforms fail closed unless the researcher explicitly opts into a separately labeled trusted-code mode.
- Updated manifest, repo layout, templates, CLI, docs, implementation phases, acceptance and security tests, and extension compatibility/portability requirements. Preserved MLflow as the canonical tracking backend and the two-level customization architecture.

### v0.9 — 2026-11-02

- Declared **two first-class customization tiers**: research-agent-authored project extensions using a permissioned host, and coding-agent-authored full platform source changes using the trusted development workflow.
- Expanded UI-only customization into a real **small-extension architecture**, including panel/view/report contributions, bounded adapters, restricted actions, a manifest/contribution registry, capability-scoped APIs, controlled builds, approvals, rollback and per-project enablement.
- Preserved strong sandbox/build isolation for Level 1, while explicitly explaining that Level 2 source edits execute as trusted core code and require review, tests, backups and a modified-build activation step.
- Made **extensive agent-navigable developer documentation** a first-release requirement: architecture maps, public/internal contracts, source modification playbooks, `AGENTS.md` and `CLAUDE.md`, tutorials, package docs, runnable examples, security notes and CI checks.
- Updated repo layout, CLI sketches, milestones, acceptance tests and remaining tradeoffs. No change to MLflow ownership, JSON-first research state, offline workstation topology or broad ML/LLM workflow coverage.

### v0.8 — 2026-11-02

- Clarified that an example research topic (such as experimenting with tokenizers or novel language-model architectures) is **user context, not a requested AblationKit feature specialization**. No named paper or technique is encoded into the core.
- Established a research-agnostic custom architecture experiment contract: project-defined models, tokenization/preprocessing, objectives, train loops, variant fields, metrics, evaluations and artifacts work without modifying AblationKit.
- Assigned model-specific knowledge and visualization to project-local Agent Skills, adapters, and sandboxed React/TypeScript extensions; retained all v0.7 LLM research capabilities as built-in conveniences.
- Reordered the first end-to-end vertical slice to validate a general custom training/architecture ablation before deeper LLM-specific workflows; added acceptance tests for project-specific domain intelligence and custom loops.
- Preserved the MLflow backend, JSON/JSONL/Markdown research state, intermittent-workstation coordinator, remote worker reconciliation and unified UI requirements.

### v0.7 — 2026-11-02

- Chose **broad ML domain coverage with first-party LLM/agent research depth first**. All previous tracking, registry, evaluation, inference, MLflow Projects and non-LLM lifecycle commitments remain.
- Added a project-aware **LLM Research Lab**, prompt/model playground and version diffs, pinned variant comparisons, evaluation golden sets, per-example feedback, nested span/tool-call debugging, RAG retrieval diagnostics, fine-tuning provenance, and token/latency/cost views (with availability/estimation caveats).
- Defined cross-domain acceptance baselines for tabular, computer vision and other task adapters while recognizing that deep modality-specific viewers may be authored by agents first.
- Added optional `ablationkit-llm` SDK helpers, typed LLM Bun APIs/CLI workflows, evidence/provenance/privacy requirements, revised implementation order, and concrete LLM-first release tests.
- Preserved one intermittently offline workstation coordinator, remote-worker reconciliation, JSON/JSONL research state, private MLflow backend and sandboxed React/TypeScript extensions.


### v0.6 — 2026-11-02

- Prioritized **research-oriented inference**, not permanent production deployment: defined one-shot isolated prediction, warm interactive sessions, tracked fixed-dataset evaluation, and side-by-side pinned model comparisons.
- Added the **Inference Lab**, **Demos**, and enhanced evaluation/comparison frontend contracts; every workflow remains accessible through AblationKit, without the upstream MLflow UI.
- Specified approved agent-authored React/TypeScript demos with project-scoped `inference.predict` / `inference.compare` capabilities, session cleanup, budget controls and no direct backend credentials.
- Defined model alias resolution to immutable versions for reproducibility, shared inputs/preprocessing for paired comparisons, evidence/privacy defaults, signature/task adapter boundaries, and model execution isolation.
- Extended Bun API sketches, proposed CLI, object model, storage, implementation phases and testable first-release acceptance criteria.
- Preserved MLflow tracking/registry/packaging/Projects/classical and GenAI evaluation, single intermittently offline coordinator, remote-worker reconciliation, and JSON/Markdown research storage.

### v0.5 — 2026-11-02

- Promoted **the complete declared core ML experimentation lifecycle** to first-release scope: tracking, datasets/lineage, logged models, Model Registry, classical evaluation, MLflow Projects, model packaging, supervised local serving/inference, system metrics, and MLflow GenAI tracing/evaluation/prompt management.
- Clarified that feature support in the application is mandatory while using registration, `MLproject` or serving is optional for any particular run. Removed prior wording deferring Projects, serving and GenAI workflows.
- Expanded native UI coverage, Bun gateway/Python bridge responsibilities, object model, CLI examples, internal development phases, testable acceptance criteria and pinned-upstream compatibility contract.
- Preserved earlier single-workstation offline/reconnect model, JSON/JSONL research state, private MLflow backend, and no MLflow stock UI dependence.
- Kept provider-specific deployment plugins, AI Gateway administration, team collaboration, and future unpinned MLflow features outside the declared core lifecycle scope.

### v0.4 — 2026-11-02

- Fixed deployment model to **main workstation that can be shut down/offline** while independently supervised remote jobs complete. Added worker-side staging, durable spools, stable job IDs, post-downtime reconciliation, separate compute/sync statuses, recovery test cases, and a no-auto-resubmit rule for ambiguous jobs.
- Promoted the **native AblationKit frontend for the complete declared MLflow tracking and Model Registry surface** to a first-release requirement. MLflow runs only as a managed backend dependency; no researcher-facing handoff to the upstream MLflow UI.
- Added an explicit UI/API compatibility matrix, MLflow-backed feature table, security boundaries, and M0 integration acceptance criteria for search, curves, comparisons, artifacts, and model registration/version/alias operations.
- Clarified three MLflow modules: **Model Registry is included in first-release UI but optional per run**; **Model Serving** (inference hosting) and **MLflow Projects** (code packaging/execution format) are separate optional workflows, not prerequisites for tracking.
- Retained JSON/JSONL/Markdown for AblationKit-owned state and MLflow-managed SQLite for tracking metadata, with independent authority and recovery.

### v0.3 — 2026-11-02

- Selected **one authoritative coordinator machine** with private/authenticated remote clients and execution workers. De-emphasized independent/multi-writer installations and specified temporary disconnection behavior.
- Adopted **MLflow as the preferred canonical experiment tracking backend** for metrics, parameters, tags, and ML artifacts; retained Bun as the research orchestration/UI system.
- Reconciled JSON-first requirements with MLflow's modern default SQLite: no AblationKit SQL research store, but **one MLflow-managed SQLite metadata database** on the coordinator.
- Separated `Job`, `ExecutionAttempt`, and `MlflowRunReference`, including retry and mapping behavior.
- Added tracking adapter/outbox, pending delivery UI states, MLflow-backed query gateway, and explicit avoidance of double-logging canonical metrics.
- Updated MVP, remote worker, backup/restore, security, and custom-view contracts to account for MLflow sidecar and central coordinator.

### v0.2 — 2026-11-02

- Fixed target audience to a **single researcher working across projects and machines**.
- Replaced SQLite persistence with **JSON snapshots, JSONL event streams, and regular files**. Defined atomic writes, single-writer coordination, rotation, crash repair, and future migration boundaries.
- Differentiated Git-friendly project research state from machine-local run history, and defined two cross-machine operating modes without claiming transparent synchronization.
- Reduced conversation integration to **manual links, notes, and organizational metadata**.
- Elevated **agent-generated interactive React/TypeScript visualizations with sandboxing** to an initial product capability, including isolated builds, explicit approval, opaque-origin execution, typed capability bridges, and safe-mode recovery.
- Updated milestones and acceptance criteria to reflect these decisions.

### v0.1 — 2026-11-02

- Initial product vision, multi-project architecture, shared Python SDK and event pipeline, compute adapters, research memory, UI modes, and agent integration.

---

*Living-spec policy: increment the version when decisions change; keep this change log and preserve older snapshots if a revision is substantively different. Everything here is planned design unless explicitly identified as an existing upstream MLflow capability.*
