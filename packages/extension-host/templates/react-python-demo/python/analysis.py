"""The Python half of the demo: one run in, a typed summary out (result.data feeds the view)."""

from __future__ import annotations

from typing import Any

from ablationkit_extension import ExtensionContext, ExtensionResult


def analyze(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    run_id = ctx.refs[0]["id"]
    metrics = ctx.input_json(f"runs/{run_id}.json")["metrics"]
    best = min(metrics.items(), key=lambda kv: kv[1]) if metrics else ("", 0.0)
    return ExtensionResult(
        summary=f"lowest metric: {best[0]}",
        metrics={"metric_count": len(metrics)},
        data={"run_id": run_id, "lowest": {"key": best[0], "value": best[1]}},
    )
