# Tutorial: a React view backed by Python

Pair a run tab with the extension's own Python analysis: the view asks the coordinator to run
the Python contribution, waits for it, and shows the typed result.

## 1. Scaffold

<!-- ci: run -->
```sh
ablationkit extension scaffold --template react-python-demo --id run-insight --name "Run insight"
ablationkit extension validate --path .ablationkit/extensions/run-insight
```

The manifest pairs the two contributions with `target`:

```json
{
  "schema_version": 1,
  "id": "run-insight",
  "version": "0.1.0",
  "host_api": "^1.0.0",
  "contributes": [
    { "id": "tab", "point": "run.tab", "title": "Run insight", "entry": "ui/src/Tab.tsx", "target": "analyze" },
    { "id": "analyze", "point": "run.evaluator", "title": "Analyze this run", "entry": "python/analysis.py:analyze" }
  ],
  "python": {
    "requires_python": ">=3.10", "project": "python", "lockfile": "python/uv.lock",
    "max_runtime_seconds": 120, "max_memory_mb": 512, "gpu": false, "network": "none"
  },
  "capabilities": ["project.analysis.execute", "project.runs.read"]
}
```

## 2. The two halves

The view runs only its own Python contribution, through the bridge:

```tsx
const view = await host.runPython("analyze", {}, { refs: [{ kind: "run", id: ctx.run_id as string }] });
// view.result: { status, summary, metrics, tables, data, artifacts }
```

The Python side returns `data` for the view (at most 256 KiB; larger results go in artifacts):

```python
from typing import Any

from ablationkit_extension import ExtensionContext, ExtensionResult


def analyze(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    metrics = ctx.input_json(f"runs/{ctx.refs[0]['id']}.json")["metrics"]
    key, value = min(metrics.items(), key=lambda kv: kv[1])
    return ExtensionResult(summary=f"lowest: {key}", data={"lowest": {"key": key, "value": value}})
```

A view cannot send code or call a worker directly. It names a contribution of its own extension,
and the coordinator checks that and the `project.analysis.execute` capability.

## 3. Build and approve

Build it in Project settings → Extensions (or have an agent build it with the
`ablationkit_do extension.build` tool), then approve it there, open a run, choose **Run insight**, then
**Analyze in Python**.
