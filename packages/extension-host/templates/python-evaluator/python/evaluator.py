"""Evaluate one run.

Run it from Project settings → Extensions, or with the ablationkit_do extension.run MCP
tool and a run ref.
"""

from __future__ import annotations

from typing import Any

from scoring import summarize

from ablationkit_extension import ExtensionContext, ExtensionResult, Table


def evaluate(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    runs = [r for r in ctx.refs if r["kind"] == "run"]
    if not runs:
        return ExtensionResult(status="error", summary="pass a run: --ref run:RUN_ID")
    run = ctx.input_json(f"runs/{runs[0]['id']}.json")
    ctx.progress(50, "scoring")
    scores = summarize(run["metrics"])
    report = ctx.artifacts.write_json("evaluation.json", {"run_id": runs[0]["id"], **scores})
    return ExtensionResult(
        summary=f"{scores['count']} metrics, mean {scores['mean']:.4g}",
        metrics={"metric_mean": scores["mean"], "metric_count": scores["count"]},
        tables=[
            Table(
                "metrics",
                ["key", "value"],
                [[k, repr(v)] for k, v in sorted(run["metrics"].items())],
            )
        ],
        artifacts=[report],
    )
