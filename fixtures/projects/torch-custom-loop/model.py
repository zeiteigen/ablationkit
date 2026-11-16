"""Project-defined pieces: a character tokenizer and a small gated recurrent model.

Nothing here follows a prescribed AblationKit architecture or logging flavor (spec §4.1).
"""

from __future__ import annotations

import torch
from torch import nn


class CharTokenizer:
    def __init__(self, text: str) -> None:
        self.vocab = sorted(set(text))
        self.index = {c: i for i, c in enumerate(self.vocab)}

    def encode(self, s: str) -> list[int]:
        return [self.index[c] for c in s]

    def __len__(self) -> int:
        return len(self.vocab)


class GatedMixer(nn.Module):
    """Embedding -> gated mixing block -> GRU -> projection. `gate` is the ablation knob."""

    def __init__(self, vocab: int, dim: int = 32, gate: bool = True) -> None:
        super().__init__()
        self.embed = nn.Embedding(vocab, dim)
        self.gate = nn.Linear(dim, dim) if gate else None
        self.rnn = nn.GRU(dim, dim, batch_first=True)
        self.out = nn.Linear(dim, vocab)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = self.embed(x)
        if self.gate is not None:
            h = h * torch.sigmoid(self.gate(h))
        h, _ = self.rnn(h)
        return self.out(h)
