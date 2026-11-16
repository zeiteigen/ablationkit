"""Optional PyTorch helpers for AblationKit (spec §4.1).

For custom training loops: no base class, no required model architecture and no logging flavor.
Everything is duck-typed (``model.parameters()``, ``optimizer.param_groups``), so this module
imports without torch; only :func:`save_checkpoint` needs it.

    from ablationkit_pytorch import TrainingLogger, log_model_info, save_checkpoint

    log_model_info(model)
    tl = TrainingLogger(optimizer=opt, log_every=10)
    for step, batch in enumerate(loader):
        loss = ...
        tl.on_step(step, loss=loss.item())
    tl.on_epoch_end(epoch, val_loss=v)
    save_checkpoint("ckpt.pt", model, opt, step=step)
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any, Protocol

from ablationkit_sdk import Run, current

__all__ = [
    "TrainingLogger",
    "grad_norm",
    "log_model_info",
    "log_optimizer",
    "save_checkpoint",
]
__version__ = "0.1.0"


class _Param(Protocol):
    requires_grad: bool

    def numel(self) -> int: ...


class _Module(Protocol):
    def parameters(self) -> Iterable[Any]: ...


class _Optimizer(Protocol):
    param_groups: list[dict[str, Any]]


def log_model_info(model: _Module, prefix: str = "model", run: Run | None = None) -> dict[str, Any]:
    """Log parameter counts and the model class as params. Returns what was logged."""
    total = 0
    trainable = 0
    for p in model.parameters():
        n = int(p.numel())
        total += n
        if getattr(p, "requires_grad", False):
            trainable += n
    info = {
        f"{prefix}/class": type(model).__name__,
        f"{prefix}/num_parameters": total,
        f"{prefix}/num_trainable": trainable,
    }
    (run or current()).log_params(info)
    return info


def log_optimizer(optimizer: _Optimizer, prefix: str = "optim", run: Run | None = None) -> None:
    """Log the optimizer class and its first parameter group's scalar settings as params."""
    params: dict[str, Any] = {f"{prefix}/class": type(optimizer).__name__}
    group = optimizer.param_groups[0] if optimizer.param_groups else {}
    for k, v in group.items():
        if k == "params":
            continue
        if isinstance(v, (int, float, str, bool)) or (
            isinstance(v, tuple) and all(isinstance(x, (int, float)) for x in v)
        ):
            params[f"{prefix}/{k}"] = v
    (run or current()).log_params(params)


def grad_norm(model: _Module) -> float:
    """Global L2 norm of the gradients (parameters without a gradient are skipped)."""
    total = 0.0
    for p in model.parameters():
        g = getattr(p, "grad", None)
        if g is None:
            continue
        total += float(g.detach().pow(2).sum().item())
    return float(total**0.5)


class TrainingLogger:
    """Step and epoch logging for a hand-written loop.

    ``on_step`` logs ``train/<name>`` every ``log_every`` steps, plus the learning rate when an
    optimizer is given. ``on_epoch_end`` logs ``epoch`` and ``<name>`` (for example ``val/loss``).
    """

    def __init__(
        self,
        optimizer: _Optimizer | None = None,
        log_every: int = 1,
        prefix: str = "train",
        run: Run | None = None,
    ) -> None:
        if log_every < 1:
            raise ValueError("log_every must be >= 1")
        self.optimizer = optimizer
        self.log_every = log_every
        self.prefix = prefix
        self._run = run
        self.step = 0

    @property
    def run(self) -> Run:
        return self._run or current()

    def on_step(self, step: int, **metrics: float) -> None:
        self.step = step
        self.run.set_step(step)
        if step % self.log_every != 0:
            return
        out = {f"{self.prefix}/{k}": float(v) for k, v in metrics.items()}
        if self.optimizer is not None and self.optimizer.param_groups:
            lr = self.optimizer.param_groups[0].get("lr")
            if isinstance(lr, (int, float)):
                out[f"{self.prefix}/lr"] = float(lr)
        if out:
            self.run.log_metrics(out, step=step)

    def on_epoch_end(self, epoch: int, **metrics: float) -> None:
        out: dict[str, float] = {"epoch": float(epoch)}
        out.update({k: float(v) for k, v in metrics.items()})
        self.run.log_metrics(out, step=self.step)


def save_checkpoint(
    path: str | os.PathLike[str],
    model: Any,
    optimizer: Any | None = None,
    *,
    step: int | None = None,
    extra: Mapping[str, Any] | None = None,
    artifact_path: str = "checkpoints",
    run: Run | None = None,
) -> Path:
    """Atomically ``torch.save`` model (and optimizer) state to ``path``; log it as an artifact."""
    import torch  # type: ignore[import-not-found,unused-ignore]  # optional; provided by the project

    state: dict[str, Any] = {"model": model.state_dict()}
    if optimizer is not None:
        state["optimizer"] = optimizer.state_dict()
    if step is not None:
        state["step"] = step
    if extra:
        state.update(extra)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".tmp")
    os.close(fd)
    try:
        torch.save(state, tmp)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    (run or current()).log_artifact(target, artifact_path)
    return target
