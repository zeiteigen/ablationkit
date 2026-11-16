# Tutorial: a Python evaluator

Write a Python evaluator that scores one run, logs metrics and an artifact to MLflow through the
coordinator, and pins its dependencies in its own `uv` environment.

## 1. Scaffold

<!-- ci: run -->
```sh
ablationkit extension scaffold --template python-evaluator --id loss-eval --name "Loss evaluator"
ablationkit extension validate --path .ablationkit/extensions/loss-eval
```

## 2. The entrypoint

`python/evaluator.py`:

```python
from typing import Any

from ablationkit_extension import ExtensionContext, ExtensionResult, Table
from scoring import summarize


def evaluate(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    run_id = ctx.refs[0]["id"]  # passed with --ref run:RUN_ID
    run = ctx.input_json(f"runs/{run_id}.json")  # staged by the coordinator
    ctx.progress(50, "scoring")
    scores = summarize(run["metrics"])
    report = ctx.artifacts.write_json("evaluation.json", scores)
    return ExtensionResult(
        summary=f"mean {scores['mean']:.4g}",
        metrics={"metric_mean": scores["mean"]},
        tables=[
            Table("metrics", ["key", "value"], [[k, repr(v)] for k, v in run["metrics"].items()])
        ],
        artifacts=[report],
    )
```

Pin dependencies in `python/`, for example `uv add numpy==2.3.1`, and commit `python/uv.lock`.
Every dependency must have a wheel: builds use `--no-build`, so no package build script ever
runs.

## 3. Build, approve, run

Build it in Project settings → Extensions (the build creates the venv from `uv.lock`), review it
and approve it there. Then run `evaluate` on a run from the same page. An agent does the build and
the run through `ablationkit mcp`:

```json
{"tool": "ablationkit_do", "arguments": {"op": "extension.build", "extension_id": "loss-eval"}}
{"tool": "ablationkit_do", "arguments": {"op": "extension.run", "extension_id": "loss-eval", "contribution": "evaluate", "refs": [{"kind": "run", "id": "RUN_ID"}]}}
```

The execution record shows progress, the summary, metrics, hashed artifacts and the MLflow run it
logged to (`project.results.write`); its log shows what the code printed
(`ablationkit_read extension.execution` and `ablationkit_read extension.execution_log` for an agent).

## 4. Limits and labels

`python.max_runtime_seconds`, `max_memory_mb` and `cpu_percent` become systemd scope limits. A
run that exceeds them ends as `timed_out` or `oom_killed`. With `network: "none"`, Python runs in
an empty network namespace where the host allows it. The execution record labels both
**enforced** or **advisory**. Approved Python is trusted code under your user: review it before
approving.
