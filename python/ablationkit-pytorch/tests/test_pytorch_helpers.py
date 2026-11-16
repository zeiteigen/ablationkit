"""Duck-typed helpers work with any module/optimizer shape; torch is not needed for these tests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ablationkit_pytorch import TrainingLogger, log_model_info, log_optimizer
from ablationkit_sdk import Run


class P:
    def __init__(self, n: int, requires_grad: bool = True) -> None:
        self.n = n
        self.requires_grad = requires_grad

    def numel(self) -> int:
        return self.n


class TinyNet:
    def parameters(self) -> list[P]:
        return [P(10), P(5, requires_grad=False)]


class Adamish:
    def __init__(self) -> None:
        self.param_groups: list[dict[str, Any]] = [
            {"params": [], "lr": 0.01, "betas": (0.9, 0.99), "weight_decay": 0.0, "foreach": None}
        ]


def _events(p: Path) -> list[dict[str, Any]]:
    return [json.loads(x) for x in p.read_text().splitlines()]


def test_model_and_optimizer_params(tmp_path: Path) -> None:
    run = Run(str(tmp_path / "e.jsonl"), str(tmp_path))
    info = log_model_info(TinyNet(), run=run)
    assert info["model/num_parameters"] == 15
    assert info["model/num_trainable"] == 10
    log_optimizer(Adamish(), run=run)
    ev = _events(tmp_path / "e.jsonl")
    assert ev[0]["payload"]["params"]["model/class"] == "TinyNet"
    assert ev[1]["payload"]["params"] == {
        "optim/class": "Adamish",
        "optim/lr": "0.01",
        "optim/betas": "[0.9, 0.99]",
        "optim/weight_decay": "0.0",
    }


def test_training_logger_steps_and_epochs(tmp_path: Path) -> None:
    run = Run(str(tmp_path / "e.jsonl"), str(tmp_path))
    tl = TrainingLogger(optimizer=Adamish(), log_every=2, run=run)
    for step in range(5):
        tl.on_step(step, loss=1.0 / (step + 1))
    tl.on_epoch_end(0, **{"val/loss": 0.3})
    ev = _events(tmp_path / "e.jsonl")
    steps = [e["payload"]["metrics"][0]["step"] for e in ev]
    assert steps == [0, 2, 4, 4]
    keys = {m["key"] for m in ev[0]["payload"]["metrics"]}
    assert keys == {"train/loss", "train/lr"}
    assert {m["key"] for m in ev[-1]["payload"]["metrics"]} == {"epoch", "val/loss"}
