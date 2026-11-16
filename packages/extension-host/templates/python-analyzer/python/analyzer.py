"""Analyze the project's runs.

Run it from Project settings → Extensions, or with the ablationkit_do extension.run MCP tool.
"""

from __future__ import annotations

from typing import Any

from ablationkit_extension import ExtensionContext, ExtensionResult, Table


def analyze(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    runs = ctx.runs.list(limit=int(params.get("limit", 50)))
    by_status: dict[str, int] = {}
    for r in runs:
        by_status[r.get("status", "?")] = by_status.get(r.get("status", "?"), 0) + 1
    return ExtensionResult(
        summary=f"{len(runs)} runs",
        metrics={"runs": len(runs)},
        tables=[
            Table(
                "runs by status", ["status", "runs"], [[k, v] for k, v in sorted(by_status.items())]
            )
        ],
    )
