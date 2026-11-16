"""AblationKit SDK: thin, dependency-free instrumentation for ML projects (spec §4.1).

    import ablationkit_sdk as ak

    ak.log_params({"lr": 1e-3, "batch_size": 64})
    for step in range(100):
        ak.log_metrics({"train/loss": loss}, step=step)
    ak.log_artifact("model.pt", artifact_path="checkpoints")
    ak.log_input("iris", source="data/iris.csv", path="data/iris.csv", split="train")
    ak.log_model("out/model", name="classifier")  # a dir saved by mlflow.<flavor>.save_model

Outside an AblationKit job every call is a no-op, so instrumented scripts still run anywhere.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from contextlib import AbstractContextManager
from typing import Any

from ._logging import LoggingHandler
from ._run import SDK_VERSION, Run, current, init

__version__ = SDK_VERSION
__all__ = [
    "LoggingHandler",
    "Run",
    "current",
    "epoch",
    "init",
    "log_artifact",
    "log_dict",
    "log_input",
    "log_metric",
    "log_metrics",
    "log_model",
    "log_param",
    "log_params",
    "log_text",
    "set_step",
    "set_tag",
    "set_tags",
]


def log_metric(key: str, value: float, step: int | None = None) -> None:
    current().log_metric(key, value, step)


def log_metrics(metrics: Mapping[str, float], step: int | None = None) -> None:
    current().log_metrics(metrics, step)


def log_param(key: str, value: Any) -> None:
    current().log_param(key, value)


def log_params(params: Mapping[str, Any]) -> None:
    current().log_params(params)


def set_tag(key: str, value: Any) -> None:
    current().set_tag(key, value)


def set_tags(tags: Mapping[str, Any]) -> None:
    current().set_tags(tags)


def log_artifact(local_path: str | os.PathLike[str], artifact_path: str = "") -> None:
    current().log_artifact(local_path, artifact_path)


def log_text(text: str, artifact_file: str) -> None:
    current().log_text(text, artifact_file)


def log_dict(data: Mapping[str, Any], artifact_file: str) -> None:
    current().log_dict(data, artifact_file)


def set_step(step: int) -> None:
    current().set_step(step)


def epoch(n: int) -> AbstractContextManager[None]:
    return current().epoch(n)


def log_input(name: str, **kwargs: Any) -> str:
    """Record a dataset input (see ``Run.log_input``)."""
    return current().log_input(name, **kwargs)


def log_model(
    local_dir: str | os.PathLike[str],
    name: str,
    *,
    step: int | None = None,
    model_type: str | None = None,
) -> str | None:
    """Log an MLflow model directory (see ``Run.log_model``)."""
    return current().log_model(local_dir, name, step=step, model_type=model_type)
