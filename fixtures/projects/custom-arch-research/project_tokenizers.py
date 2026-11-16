"""Project-defined tokenizers: characters, or characters plus the most frequent merged pairs."""

from __future__ import annotations

from collections import Counter


class CharTokenizer:
    name = "char"

    def fit(self, text: str) -> None:
        self.vocab = sorted(set(text))

    def encode(self, text: str) -> list[str]:
        return list(text)


class PairMergeTokenizer:
    """A tiny BPE-like tokenizer: greedily merges the `merges` most frequent adjacent pairs."""

    name = "pairs"

    def __init__(self, merges: int = 24) -> None:
        self.merges = merges
        self.pairs: list[str] = []

    def fit(self, text: str) -> None:
        tokens = list(text)
        for _ in range(self.merges):
            counts = Counter(a + b for a, b in zip(tokens, tokens[1:]))
            if not counts:
                break
            best, n = counts.most_common(1)[0]
            if n < 2:
                break
            self.pairs.append(best)
            tokens = self._merge(tokens, best)
        self.vocab = sorted(set(tokens))

    @staticmethod
    def _merge(tokens: list[str], pair: str) -> list[str]:
        out: list[str] = []
        i = 0
        while i < len(tokens):
            if i + 1 < len(tokens) and tokens[i] + tokens[i + 1] == pair:
                out.append(pair)
                i += 2
            else:
                out.append(tokens[i])
                i += 1
        return out

    def encode(self, text: str) -> list[str]:
        tokens = list(text)
        for p in self.pairs:
            tokens = self._merge(tokens, p)
        return tokens


def make(name: str):
    return {"char": CharTokenizer, "pairs": PairMergeTokenizer}[name]()
