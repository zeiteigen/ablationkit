"""Project-defined model: an add-k smoothed n-gram language model over tokens."""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from typing import Any


class NGramLM:
    def __init__(self, vocab: list[str], context: int = 1, k: float = 0.1) -> None:
        self.vocab = vocab
        self.context = context
        self.k = k
        self.counts: dict[tuple[str, ...], Counter[str]] = defaultdict(Counter)

    def update(self, tokens: list[str]) -> None:
        padded = ["<s>"] * self.context + tokens
        for i in range(self.context, len(padded)):
            self.counts[tuple(padded[i - self.context : i])][padded[i]] += 1

    def logprob(self, tokens: list[str]) -> float:
        """Natural-log probability of `tokens`."""
        padded = ["<s>"] * self.context + tokens
        v = len(self.vocab) + 1
        total = 0.0
        for i in range(self.context, len(padded)):
            c = self.counts.get(tuple(padded[i - self.context : i]), Counter())
            total += math.log((c[padded[i]] + self.k) / (sum(c.values()) + self.k * v))
        return total

    def internals(self, top: int = 8) -> dict[str, object]:
        """What the model learned, for project tooling: per-context next-token entropy."""
        rows: list[dict[str, Any]] = []
        for ctx, c in self.counts.items():
            n = sum(c.values())
            h = -sum((v / n) * math.log2(v / n) for v in c.values())
            rows.append(
                {
                    "context": "".join(ctx) if all(len(t) == 1 for t in ctx) else " ".join(ctx),
                    "count": n,
                    "entropy_bits": round(h, 4),
                    "top_next": [[t, k] for t, k in c.most_common(3)],
                }
            )
        rows.sort(key=lambda r: -r["count"])
        mean = sum(r["entropy_bits"] for r in rows) / len(rows) if rows else 0.0
        return {
            "type": "ngram",
            "contexts": len(rows),
            "mean_entropy_bits": round(mean, 4),
            "top_contexts": rows[:top],
        }

    def config(self) -> dict[str, object]:
        return {"type": "ngram", "context": self.context, "k": self.k, "vocab": len(self.vocab)}
