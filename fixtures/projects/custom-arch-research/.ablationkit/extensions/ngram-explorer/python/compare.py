"""Compare tokenizers across this project's runs (bits per character and tokens per character)."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from ablationkit_extension import ExtensionContext, ExtensionResult, Table


def compare(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    runs = ctx.runs.list(limit=200)
    by: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in runs:
        tok = r.get("params", {}).get("tokenizer")
        if tok and "val/bits_per_char" in r.get("metrics", {}):
            by[tok].append(r)
    rows = []
    metrics: dict[str, float] = {}
    for tok, rs in sorted(by.items()):
        bpc = sum(r["metrics"]["val/bits_per_char"] for r in rs) / len(rs)
        tpc = sum(r["metrics"].get("tokens_per_char", 0.0) for r in rs) / len(rs)
        rows.append([tok, len(rs), f"{bpc:.4f}", f"{tpc:.4f}"])
        metrics[f"{tok}.bits_per_char"] = round(bpc, 6)
    best = min(by, key=lambda t: metrics[f"{t}.bits_per_char"]) if by else ""
    return ExtensionResult(
        summary=f"lowest bits per character: {best} ({len(runs)} runs read)" if best else "no runs with a tokenizer",
        metrics=metrics,
        tables=[Table("tokenizers", ["tokenizer", "runs", "bits/char", "tokens/char"], rows)],
        data={"best": best},
    )
