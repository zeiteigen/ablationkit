"""Project-defined scorers for GenAI evaluations of this fixture (run in the evaluation worker)."""

from __future__ import annotations

from typing import Any


def cites_source(inputs: Any = None, outputs: Any = None, expectations: Any = None, trace: Any = None) -> bool:
    """The answer cites a FAQ chunk as ``[faq.md#N]``."""
    return "[faq.md#" in str(outputs or "")
