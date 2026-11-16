from __future__ import annotations


def summarize(metrics: dict[str, float]) -> dict[str, float]:
    values = [float(v) for v in metrics.values()]
    return {"count": len(values), "mean": sum(values) / len(values) if values else 0.0}
