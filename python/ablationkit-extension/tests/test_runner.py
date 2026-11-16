"""The runner protocol: broker calls, progress, prints to stderr, artifacts and the result."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import ablationkit_extension
from ablationkit_extension import ExtensionResult, Table

RUNNER = Path(ablationkit_extension.__file__).parent / "runner.py"

ENTRY = """
from ablationkit_extension import ExtensionContext, ExtensionResult, Table

def analyze(ctx: ExtensionContext, params: dict) -> ExtensionResult:
    print("hello from the extension")
    ctx.progress(50, "half way")
    runs = ctx.runs.list(limit=params["limit"])
    a = ctx.artifacts.write_json("out/summary.json", {"n": len(runs)})
    return ExtensionResult(
        summary=f"{len(runs)} runs",
        metrics={"runs": len(runs), "mean": 0.5},
        tables=[Table("runs", ["id"], [[r["run_id"]] for r in runs])],
        artifacts=[a],
    )

def broken(ctx, params):
    raise ValueError("boom")
"""


def _run(tmp: Path, entry: str, replies: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    src = tmp / "src"
    (src / "python").mkdir(parents=True)
    (src / "python" / "analysis.py").write_text(ENTRY)
    req = {
        "project_id": "p-1",
        "extension_id": "x",
        "execution_id": "xe-abcdef",
        "contribution": "a",
        "capabilities": ["project.runs.read"],
        "refs": [],
        "inputs_dir": str(tmp / "inputs"),
        "outputs_dir": str(tmp / "outputs"),
        "output_max_bytes": 1 << 20,
        "source_dir": str(src),
        "entry": entry,
        "params": {"limit": 2},
    }
    (tmp / "outputs").mkdir()
    (tmp / "inputs").mkdir()
    rf = tmp / "request.json"
    rf.write_text(json.dumps(req))
    p = subprocess.Popen(
        [sys.executable, "-I", "-B", str(RUNNER), str(rf)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert p.stdout
    assert p.stdin
    msgs: list[dict[str, Any]] = []
    for line in p.stdout:
        m = json.loads(line)
        msgs.append(m)
        if m["t"] == "call":
            p.stdin.write(json.dumps({"id": m["id"], "result": replies[m["method"]]}) + "\n")
            p.stdin.flush()
    p.stdin.close()
    err = p.stderr.read() if p.stderr else ""
    assert p.wait() == 0
    return msgs, err


def test_runner_protocol(tmp_path: Path) -> None:
    msgs, err = _run(
        tmp_path,
        "python/analysis.py:analyze",
        {"runs.list": {"runs": [{"run_id": "r1"}, {"run_id": "r2"}]}},
    )
    kinds = [m["t"] for m in msgs]
    assert kinds == ["progress", "call", "result"]
    assert msgs[1]["method"] == "runs.list"
    assert msgs[1]["params"] == {"limit": 2}
    result = msgs[-1]["result"]
    assert result["status"] == "ok"
    assert result["metrics"] == {"runs": "2", "mean": "0.5"}
    assert result["artifacts"] == ["out/summary.json"]
    assert json.loads((tmp_path / "outputs/out/summary.json").read_text()) == {"n": 2}
    # Prints never corrupt the protocol stream.
    assert "hello from the extension" in err


def test_runner_reports_exceptions(tmp_path: Path) -> None:
    msgs, err = _run(tmp_path, "python/analysis.py:broken", {})
    result = msgs[-1]["result"]
    assert result["status"] == "error"
    assert "ValueError: boom" in result["summary"]
    assert "Traceback" in err


def test_result_wire_format() -> None:
    r = ExtensionResult(
        summary="s",
        metrics={"a": 1, "b": float("nan")},
        tables=[Table("t", ["x"], [[1.5, True, "s"]])],  # type: ignore[list-item]
    )
    w = r.to_wire()
    assert w["metrics"] == {"a": "1"}
    assert w["warnings"] == ["metric b is not finite and was dropped"]
    assert w["tables"][0]["rows"] == [["1.5", True, "s"]]


def test_remote_broker_stays_inside_its_capabilities_and_staged_inputs(tmp_path: Path) -> None:
    """Security suite (Stage 18b): a contribution on a target asks for what it was not given."""
    from ablationkit_extension.remote import answer

    inputs = tmp_path / "inputs"
    (inputs / "runs").mkdir(parents=True)
    (inputs / "runs" / "r1.json").write_text(json.dumps({"run_id": "r1"}))
    (tmp_path / "secret.json").write_text(json.dumps({"secret": True}))
    (inputs / "secret.json").write_text(json.dumps({"secret": True}))
    req = {"project_id": "p", "extension_id": "x", "capabilities": ["project.runs.read"]}

    def code(method: Any, **params: Any) -> Any:
        reply = answer(req, inputs, {"id": 1, "method": method, "params": params})
        return reply["error"]["code"] if "error" in reply else reply["result"]

    assert code("runs.get", run_id="r1") == {"run_id": "r1"}
    for method in ("mlflow.raw", "__proto__", "policy.revise", "inference.predict", 7, None):
        assert code(method) == "method_not_allowed"
    # Known methods without the capability; with it, what needs the coordinator is unavailable.
    assert code("research.list") == "capability_denied"
    assert code("models.list") == "capability_denied"
    assert (
        answer(
            {**req, "capabilities": ["project.research.read"]},
            inputs,
            {"id": 1, "method": "research.list"},
        )["error"]["code"]
        == "not_available_remote"
    )
    # Only what was staged, by a plain ID: never a path.
    for rid in ("../secret", "../../secret", "/etc/passwd", "r1/../../secret", "", "nope"):
        assert code("runs.get", run_id=rid) == "not_staged"
