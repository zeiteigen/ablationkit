"""A run evaluator and a project analysis, stdlib only."""

from __future__ import annotations

from typing import Any

from ablationkit_extension import BrokerError, ExtensionContext, ExtensionResult, Table
from helpers import ratio


def evaluate(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    ctx.progress(10, "reading the staged run")
    run_id = ctx.refs[0]["id"]
    run = ctx.input_json(f"runs/{run_id}.json")
    metrics: dict[str, float] = run["metrics"]
    loss = float(metrics.get("loss", 0.0))
    scale = float(params.get("scale", 2))
    print(f"evaluating {run_id} with scale {scale}")
    ctx.progress(80, "writing the report")
    report = ctx.artifacts.write_json(
        "evaluation.json", {"run_id": run_id, "loss": loss, "scaled": loss * scale}
    )
    note = ctx.artifacts.write_text("notes/readme.txt", "scaled loss\n")
    return ExtensionResult(
        summary=f"scaled loss {loss * scale:.3f}",
        metrics={"scaled_loss": loss * scale, "metric_count": len(metrics), "ratio": ratio(loss, scale)},
        tables=[Table("metrics", ["key", "value"], [[k, repr(v)] for k, v in sorted(metrics.items())])],
        artifacts=[report, note],
        data={"run_id": run_id, "loss": loss},
    )


def summarize(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    runs = ctx.runs.list(limit=int(params.get("limit", 10)))
    return ExtensionResult(
        summary=f"{len(runs)} runs",
        metrics={"runs": len(runs)},
        tables=[Table("runs", ["run", "status"], [[r["run_id"], r.get("status", "")] for r in runs])],
    )


def denied(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    try:
        ctx.research.list()
    except BrokerError as e:
        return ExtensionResult(summary=f"refused: {e.code}", metrics={"refused": 1})
    return ExtensionResult(summary="allowed", metrics={"refused": 0})
