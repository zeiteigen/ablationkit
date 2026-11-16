# Extending AblationKit

Level 1 extensions add views, actions and Python analyses to one project without changing
AblationKit's source (spec §8). Level 2, changing the source itself, is
[docs/contributing/](../contributing/README.md). Design and trade-offs:
ADR 0022.

## The trust model in one table

| What | Mechanism | Label |
| --- | --- | --- |
| Activating an extension in a project | A successful build is enabled as built (ADR 0045), unless it declares a trusted `backend` or the coordinator sets `extensions.require_approval`, when only the researcher's approval activates it. Enable after a disable, roll back and (with `require_approval`) approve are the researcher's, on the human API; the agent API has no such route | enforced |
| What code runs | Only the active, content-addressed build snapshot; a changed checkout needs a new build | enforced by the coordinator |
| UI contributions | Opaque-origin iframe (`sandbox allow-scripts`, no `allow-same-origin`), CSP `connect-src 'none'`: no network, cookies, storage or parent access | enforced by the browser |
| Every bridge call | Coordinator checks project, active approved build, contribution, method allowlist, capability, quota and size | enforced |
| Python CPU, memory, time and task limits | systemd user scope (`CPUQuota`, `MemoryMax`, `RuntimeMaxSec`, `TasksMax`) | enforced when the cgroup controllers are delegated; advisory otherwise (each execution records which) |
| Python network, MLflow and coordinator access (`network: none`) | Empty network namespace (`unshare -rn`) | enforced when unprivileged user namespaces work; advisory otherwise |
| Python reading files outside its staged inputs | None: enabled Python runs as **trusted code** under your Linux user | advisory: review the source (the build's diff on the Extensions page), or set `require_approval` |
| An agent running Python | The project policy's `jobs.run_local`, like its jobs | enforced |
| Python in the project's environment (`environment: project`) | Built from the checkout's commit and `uv.lock`; the project's build backend runs at build time; the checkout path is given (`ABLATIONKIT_CHECKOUT`) | trusted code, like any extension Python |
| Python capabilities over the broker | Coordinator checks every call against the approval | enforced |

Never describe an advisory control as a guarantee. The Extensions page and every execution record
show these labels.

## Development loop

1. **Scaffold** source under `.ablationkit/extensions/<id>/` in the project checkout (an agent can
   do this; no AblationKit source changes are needed).
2. **Validate offline:** `ablationkit extension validate --path .ablationkit/extensions/<id>`
   checks the schema, host API range, files, capabilities and operations, and prints a fix for
   every error. `ablationkit extension doctor` checks every extension in a checkout.
3. **Build:** in Project settings → Extensions, or by an agent with the `ablationkit_do extension.build`
   tool of `ablationkit mcp`. It snapshots the source, bundles each UI entry and creates the Python
   environment from the lockfile (wheels only).
4. **Enabled as built:** a successful build is the project's active build at once ("enabled as
   built" on the Extensions page). Each build shows its source diff against the previous one,
   whether capabilities or the lockfile changed, the requested permissions with their bounds and
   labels, the Python limits, and a sandbox preview of each view.
5. **With `extensions.require_approval`** in the coordinator settings, a build waits instead: the
   researcher reviews it and approves it, acknowledging that Python runs as trusted code.
   Enabling (either way) holds for this project only.
6. **Use and test:** views mount at their contribution points. Python runs from a view, from
   Project settings → Extensions, or by an agent with the `ablationkit_do extension.run` tool
   (`ablationkit_read extension.execution` and `_execution_log` read the result). Errors from frames,
   the bridge and Python appear in the extension's developer console.
7. **Disable or roll back:** disable stops running executions. Rolling back activates an earlier
   approved build. Both are the researcher's, in the web UI.
   MLflow results logged by earlier executions stay.

## Manifest (`manifest.json`)

Schema: `ExtensionManifest` in [docs/api/protocol.md](../api/protocol.md) (generated). For
example:

```json
{
  "schema_version": 1,
  "id": "loss-explorer",
  "version": "0.1.0",
  "name": "Loss explorer",
  "host_api": "^1.0.0",
  "contributes": [
    { "id": "tab", "point": "run.tab", "title": "Loss", "entry": "ui/src/Tab.tsx", "target": "analyze" },
    { "id": "analyze", "point": "project.analysis", "title": "Analyze", "entry": "python/analysis.py:analyze" },
    { "id": "rerun", "point": "project.action", "title": "Re-run analysis", "operation": "extension.python.run", "target": "analyze" }
  ],
  "python": {
    "requires_python": ">=3.10",
    "project": "python",
    "lockfile": "python/uv.lock",
    "max_runtime_seconds": 120,
    "max_memory_mb": 1024,
    "gpu": false,
    "network": "none"
  },
  "capabilities": ["project.runs.read", "project.analysis.execute", "project.results.write"]
}
```

- `host_api`: `^1.0.0`, `~1.0.0`, `>=1.0.0 <2.0.0` or an exact version. This host implements
  **1.0.0**.
- `capabilities` are listed in the catalog below; `inference.*` and `llm.*` need
  `capability_config`.
- Approval binds the source tree, the lockfile, and a capability hash over the capabilities,
  `capability_config`, Python limits, GPU, network, contributions and `host_api`. The version
  string alone is not bound.

## Contribution points

| Point | Kind | Where it mounts | Context |
| --- | --- | --- | --- |
| `project.panel` | UI | Its own page, `/p/<id>/x/<extension>/<contribution>`, listed in the project's navigation and linked from Overview (Overview mounts no panel) | — |
| `run.tab` | UI | Runs → a run → extra tab | `run_id` |
| `comparison.view` | UI | Runs → Compare, below the comparison | `run_ids` |
| `report.block` | UI | Knowledge → a report; `host.saveSnapshot` stores a static fallback in the report | `report_id` |
| `model.demo` | UI | Models → Demos | — |
| `project.action` | action | Project → Overview → Extension actions | runs one allowlisted `operation` |
| `project.analysis` | Python | `extension run`, a view (`host.runPython`) or an action | `params`, `refs` |
| `run.evaluator` | Python | same, with a run reference | `refs: [{kind: "run", id}]` |

`project.action` operations: `extension.python.run` (with `target`, needs
`project.analysis.execute`), `research.note.create` (`project.research.write`) and
`report.generate` (`project.reports.generate`). Actions cannot run shell commands or call
internal or MLflow APIs.

## Capabilities

| Capability | Grants | Bounds |
| --- | --- | --- |
| `project.runs.read` | runs, params, tags, latest metrics and metric history of this project | — |
| `project.artifacts.preview` | list a run's artifacts; preview text, JSON and images ≤ 1 MiB | — |
| `project.research.read` / `.write` | read hypotheses, notes, reports; create notes (tagged `extension:<id>`) | — |
| `project.reports.generate` | generate a study report | — |
| `project.models.read` | logged and registered models | — |
| `project.analysis.execute` | run this extension's own Python contributions | manifest `python` limits |
| `project.results.write` | log Python metrics and artifacts to an MLflow run tagged with the extension | output size (`capability_config.artifacts.max_output_bytes`, default 64 MiB) |
| `inference.predict` / `inference.compare` | predictions on allowlisted models | `capability_config.inference`: `models`, `max_requests_per_hour`, `max_request_bytes`, `max_rows` |
| `llm.infer` / `llm.compare` | allowlisted LLM targets through the project's data controls (egress gate, capture policy); typed rows only, no golden sets | `capability_config.llm`: `targets`, `max_calls_per_hour`, `max_input_chars`, optional `max_cost_usd` per hour (estimated) |
| `trace.read`, `evaluation.read` | `traces.get` (filtered by the capture policy), `evaluations.examples` (held-out expectations hidden), `evaluations.get` | — |
| `network.egress` | Python keeps the network (`python.network: "egress"`) | advisory |
| `gpu` | Python sees GPUs (`python.gpu: true`) | advisory |

The Extensions page shows the live catalog; agents read it with the `ablationkit_read extension.catalog`
tool.

## UI SDK (`@ablationkit/extension-sdk`)

A UI entry may import only `@ablationkit/extension-sdk`, `@ablationkit/extension-sdk/react`,
React and its own relative files. The host bundles it; nothing is downloaded.

```tsx
import type { RunSummary } from "@ablationkit/extension-sdk";
import { mountReact, Table, useCall, useHostContext } from "@ablationkit/extension-sdk/react";

function Tab() {
  const ctx = useHostContext();
  const run = useCall<RunSummary>("runs.get", { run_id: ctx.run_id }, [ctx.run_id]);
  if (!run.data) return <p>Loading…</p>;
  return <Table columns={["metric", "latest"]} rows={Object.entries(run.data.metrics)} />;
}
void mountReact(Tab);
```

- `host.call(method, params)` sends one bridge method (`runs.list`, `runs.get`,
  `runs.metric_history`, `artifacts.list`, `artifacts.preview`, `research.list`, `models.list`,
  `inference.describe`, `inference.predict`, `inference.compare`, `python.run`,
  `python.execution`).
- `host.runPython(target, params)` runs this extension's own Python contribution and polls it.
- `host.saveResult(resultId, {title})` asks the researcher, in trusted host UI, to save an
  inference result as evidence. It resolves to `null` if they decline.
- `host.navigate(path)`, `host.log(level, …)` and `host.onContext(fn)`.
- Errors are `BridgeError` with a `code`: `capability_denied`, `quota_exceeded`,
  `model_not_allowed`, `request_too_large`, `extension_changed` (reload) and so on.

## Python SDK (`ablationkit-extension`)

The runner puts the SDK on the path; the extension's `pyproject.toml` lists only its own pinned
dependencies.

```python
from ablationkit_extension import ExtensionContext, ExtensionResult, Table


def analyze(ctx: ExtensionContext, params: dict) -> ExtensionResult:
    runs = ctx.runs.list(limit=20)  # broker call, capability-checked
    ctx.progress(50, "summarizing")
    art = ctx.artifacts.write_json("summary.json", {"runs": len(runs)})
    return ExtensionResult(
        summary=f"{len(runs)} runs",
        metrics={"runs": len(runs)},
        tables=[Table("runs", ["id"], [[r["run_id"]] for r in runs])],
        artifacts=[art],
    )
```

- Staged inputs: `ctx.input_json("runs/<run_id>.json")` for each `run` reference (needs
  `project.runs.read`).
- Outputs go only under `ctx.outputs_dir`, through `ctx.artifacts.write_*` or `ctx.artifacts.path`.
- `print()` goes to the execution log; the protocol uses its own stream.
- Results: `status`, `summary`, decimal-string `metrics` (≤ 100), `tables` (≤ 10), `warnings`,
  `errors`, `artifacts` and `data` (≤ 256 KiB, for a paired view).
- Statuses: `succeeded`, `failed`, `timed_out`, `oom_killed`, `cancelled`, `interrupted` (the
  coordinator stopped; never rerun).
- Environment: `uv lock` in the extension's Python project, and commit `uv.lock`. Every
  dependency needs a wheel, because source builds are refused.
- **The project's own environment** (ADR 0046):
  with `"python": {"environment": "project", …}` (and no `project` or `lockfile`), the
  contribution runs in the project's environment, built from the checkout's current commit and
  its committed `uv.lock`, with the project's package installed, so it can `import` the
  project's code. The checkout's path is in `ABLATIONKIT_CHECKOUT` (for data files). A new
  commit makes a new build; uncommitted edits are not in it; it runs on this machine only.
- **Warm workers** (ADR 0047): `"python": {"warm": true, …}`
  keeps one process per build between runs, so imports (torch, the project's package) load
  once. Runs are served one at a time, each with its own record and log; module state persists
  between them; the time limit applies to each run (an overrun replaces the worker); the worker
  exits after 10 idle minutes or when the extension is disabled. Use it for interactive views.

### On a remote compute target

An approved contribution can run on a configured target (`target_id` on the run route, or on the
`ablationkit_do extension.run` tool; the project policy decides for an agent). The rules
(ADR 0023 decision 26):

- It runs as a job. The bundle carries the build's source snapshot, the request and the staged
  references, and the target's Python runs it.
- The worker answers only `context.get`, `runs.get` and `runs.list`, and only from the staged
  runs. Every other broker call gets `not_available_remote`, so pass what it needs as refs.
- Only contributions without third-party dependencies can run remotely, because the build's
  environment is made on the workstation (422 `dependencies_not_remote`).
- Limits and network are the target's, so both are labelled advisory.
- A coordinator restart does not interrupt the job. Its result and outputs are validated like a
  local result and recorded once, after the attempt has synced.
- Agents cannot start remote runs (403 `remote_humans_only`).

## Demos

A demo is a `model.demo` view with `inference.predict` (or `inference.compare`) and an allowlist:

```json
"capabilities": ["inference.predict"],
"capability_config": { "inference": { "models": ["iris@champion"], "max_requests_per_hour": 100, "max_request_bytes": 65536, "max_rows": 50 } }
```

Aliases are pinned to a version on each call. A demo cannot call MLflow, workers, the filesystem
or the network. It can save only results it produced, and only after you confirm. Removing its
source or disabling it revokes it.

## Portability and safe mode

- `ablationkit extension publish <id>` copies the source to your user registry
  (`~/.ablationkit/extensions/<id>/<version>/`). Installing `<id>` `<version>` from the registry (Project settings → Extensions in project Q,
  or an agent's `ablationkit_do extension.install`) copies it into another project's checkout. Q still needs its own build and approval.
- Safe mode (`"extensions": {"safe_mode": true}` in `settings.json`, or
  `ABLATIONKIT_SAFE_MODE=1`) starts the coordinator with every extension inactive. Disable and
  roll back still work.
- General runs and tracking work when feature extensions are disabled.

## Tutorials and templates

- [A React run tab](tutorial-react-view.md)
- [A Python evaluator](tutorial-python-evaluator.md)
- [A React view backed by Python](tutorial-react-python.md)
- [Changing AblationKit's source instead (Level 2)](../contributing/source-changes.md)

`ablationkit extension templates` lists the nine templates, and `ablationkit extension scaffold
--template T --id ID` copies one into the checkout: `create-run-panel`, `architecture-viewer`,
`inference-demo`, `result-comparison`, `report-widget`, `restricted-action`, `python-evaluator`,
`python-analyzer` and `react-python-demo`. CI scaffolds, builds, approves and exercises every one
(`apps/server/test/extensions.test.ts` "templates"). The Agent Skill
[`author-extension`](../../skills/author-extension/SKILL.md) walks an agent through the same loop.
MCP operations: `ablationkit_read extension.list`, `ablationkit_do extension.build`, `ablationkit_do extension.run`, `ablationkit_read extension.execution`.

## Compatibility

This host implements extension API **2.0.0** for manifests with a backend. Existing manifests
without a backend may continue to target API **1.0.0**. A manifest whose `host_api` range excludes
the applicable API is rejected at validate, build and approve time, with a diagnostic naming the
version and the fix. Within each major version, bridge methods, capability names and manifest
fields are only added, never removed or changed.

| Host API | Changes |
| --- | --- |
| 1.0.0 | Contribution points, capabilities and bridge methods for extensions without a backend |
| 2.0.0 | Backend declarations, project-scoped services, operations, pages and broker contracts; API 1 manifests without a backend remain compatible |

## Level 1 or Level 2?

| | Level 1: extension | Level 2: source change |
| --- | --- | --- |
| Where | `.ablationkit/extensions/<id>/` in the project | an AblationKit Git branch |
| Trust | views sandboxed; Python trusted code within limits; capabilities checked per call | trusted application code with the coordinator's privileges |
| Review | source diff, permissions and limits on the Extensions page; approval per project | code review, `ablationkit dev build` checks; activation in System, then restart |
| Portability | publish to the user registry, install in other projects (each approves) | rebuild and rebase onto upstream releases |
| Upgrade cost | low: the host API is versioned | can be high: internals are not public APIs |

## Examples

Working examples, exercised by the coordinator tests, are in
[`fixtures/extensions/`](../../fixtures/extensions/README.md): a run tab, panel and action
(`run-inspector`), a Python evaluator (`py-evaluator`) and a model demo (`iris-demo`). Templates
and the templates above are the starting points for new ones.
