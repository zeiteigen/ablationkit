"""Mean, standard deviation and percentiles of one metric across runs, computed with numpy."""

from __future__ import annotations

from typing import Any

import numpy as np
from ablationkit_extension import ExtensionContext, ExtensionResult, Table


def stats(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    key = str(params.get("metric", "loss"))
    values = np.array([r["metrics"][key] for r in ctx.runs.list(limit=200) if key in r["metrics"]])
    if values.size == 0:
        return ExtensionResult(status="error", summary=f"no runs have {key}")
    p = np.percentile(values, [10, 50, 90])
    return ExtensionResult(
        summary=f"{key}: mean {values.mean():.4g} over {values.size} runs (numpy {np.__version__})",
        metrics={f"{key}.mean": float(values.mean()), f"{key}.std": float(values.std())},
        tables=[Table("percentiles", ["p10", "p50", "p90"], [[repr(float(x)) for x in p]])],
        data={"numpy": np.__version__},
    )
