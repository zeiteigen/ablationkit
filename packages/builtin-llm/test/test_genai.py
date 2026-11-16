"""The extracted worker's isolated entry point and policy helpers, without a running MLflow."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
WORKER = PACKAGE / "src/python/genai.py"
CORE = PACKAGE.parents[1] / "packages/tracking-mlflow/env/bridge/ablationkit_bridge.py"


def load(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("bridge_under_test", path)
    assert spec
    assert spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_operations_belong_to_their_own_workers() -> None:
    core = load(CORE)
    builtin = load(WORKER)
    assert set(core.OPS) == {"evaluate", "predict", "serve"}
    assert set(builtin.OPS) == {"genai_evaluate"}
    assert not hasattr(core, "genai_evaluate")
    assert not hasattr(core, "_make_scorers")
    assert not hasattr(builtin, "evaluate")


@pytest.mark.parametrize(
    ("worker", "payload", "error"),
    [
        (WORKER, {"bridge_version": 2, "op": "genai_evaluate"}, "bridge version mismatch"),
        (WORKER, {"bridge_version": 1, "op": "evaluate"}, "unknown op 'evaluate'"),
        (CORE, {"bridge_version": 1, "op": "genai_evaluate"}, "unknown op 'genai_evaluate'"),
    ],
)
def test_isolated_worker_protocol(
    tmp_path: Path, worker: Path, payload: dict[str, Any], error: str
) -> None:
    req = tmp_path / "request.json"
    result = tmp_path / "result.json"
    req.write_text(json.dumps(payload))
    completed = subprocess.run(
        [sys.executable, "-I", str(worker), str(req), str(result)],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(result.read_text()) == {"ok": False, "kind": "bridge", "error": error}
    assert not result.with_suffix(".tmp").exists()


def test_prompt_rendering_and_call_budget() -> None:
    worker = load(WORKER)
    assert worker._render("Answer {{topic}}: {{missing}}", {"topic": "question"}) == [
        {"role": "user", "content": "Answer question: "}
    ]
    assert worker._render(
        [{"role": "system", "content": "Inputs: {{items}}"}], {"items": [1, 2]}
    ) == [{"role": "system", "content": "Inputs: [1, 2]"}]
    budget = worker._Budget(1)
    budget.take()
    with pytest.raises(RuntimeError, match="call budget of 1 reached"):
        budget.take()
    assert budget.calls == 1


def test_capture_policy_redacts_nested_values_before_storage() -> None:
    worker = load(WORKER)
    redacted: dict[str, Any] = {}
    span = SimpleNamespace(
        inputs={"messages": [{"content": "secret 123"}]},
        outputs="secret response",
        set_inputs=lambda value: redacted.update(inputs=value),
        set_outputs=lambda value: redacted.update(outputs=value),
    )
    worker._redaction({"mode": "redacted", "rules": [["test", "secret"]]})(span)
    assert redacted == {
        "inputs": {"messages": [{"content": "[REDACTED:test] 123"}]},
        "outputs": "[REDACTED:test] response",
    }
    worker._redaction({"mode": "metadata_only"})(span)
    assert redacted["inputs"]["omitted"] == "metadata_only"
    assert redacted["outputs"]["bytes"] == len(json.dumps(span.outputs))
    before = redacted.copy()
    worker._redaction({"mode": "full"})(span)
    assert redacted == before


def test_metrics_ignore_nonfinite_values() -> None:
    worker = load(WORKER)
    assert worker._decimal_metrics(
        {"accuracy": 0.123456789, "nan": float("nan"), "inf": float("inf"), "missing": None}
    ) == {"accuracy": "0.123457"}
