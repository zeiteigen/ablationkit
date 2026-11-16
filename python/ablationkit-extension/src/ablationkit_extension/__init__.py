"""Python SDK for AblationKit extensions (host API 1.x; spec section 8.4.1, ADR 0022).

A Python contribution is a function ``f(ctx, params) -> ExtensionResult``. The coordinator runs
it in the extension's own ``uv`` environment, under a systemd scope with the manifest's CPU,
memory and time limits, with no AblationKit or MLflow credentials. The function talks to the
coordinator only through ``ctx`` (a broker pipe the coordinator checks on every call), reads
staged inputs from ``ctx.inputs_dir`` and writes artifacts with ``ctx.artifacts``::

    from ablationkit_extension import ExtensionContext, ExtensionResult

    def analyze(ctx: ExtensionContext, params: dict) -> ExtensionResult:
        runs = ctx.runs.list(limit=20)
        artifact = ctx.artifacts.write_json("analysis.json", {"run_count": len(runs)})
        return ExtensionResult(summary="Run analysis complete", metrics={"runs": len(runs)},
                               artifacts=[artifact])

Approved extension code runs as trusted code under the researcher's user. Nothing in this module
is a security boundary.
"""

from __future__ import annotations

import builtins
import json
import math
import os
import re
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any

__all__ = [
    "SDK_VERSION",
    "ArtifactRef",
    "BrokerError",
    "ExtensionContext",
    "ExtensionResult",
    "Table",
]

SDK_VERSION = "1.0.0"

_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$")


class BrokerError(RuntimeError):
    """A broker call the coordinator refused or failed (``capability_denied``, ...)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass(frozen=True)
class ArtifactRef:
    """A file in the execution's output area. The coordinator hashes and records it."""

    path: str


@dataclass
class Table:
    title: str
    columns: list[str]
    rows: list[list[str | int | bool]]


@dataclass
class ExtensionResult:
    summary: str
    status: str = "ok"
    metrics: dict[str, float | int | str] = field(default_factory=dict)
    tables: list[Table] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    artifacts: list[ArtifactRef] = field(default_factory=list)
    data: dict[str, Any] | None = None

    def to_wire(self) -> dict[str, Any]:
        metrics: dict[str, str] = {}
        for k, v in self.metrics.items():
            if isinstance(v, bool):
                raise TypeError(f"metric {k} is a bool; use 0 or 1")
            if isinstance(v, float) and not math.isfinite(v):
                self.warnings.append(f"metric {k} is not finite and was dropped")
                continue
            metrics[str(k)] = repr(v) if isinstance(v, float) else str(v)
        out: dict[str, Any] = {
            "status": self.status,
            "summary": self.summary,
            "metrics": metrics,
            "tables": [
                {"title": t.title, "columns": t.columns, "rows": [_cells(r) for r in t.rows]}
                for t in self.tables
            ],
            "warnings": list(self.warnings),
            "errors": list(self.errors),
            "artifacts": [a.path for a in self.artifacts],
        }
        if self.data is not None:
            out["data"] = self.data
        return out


def _cells(row: list[Any]) -> list[str | int | bool]:
    out: list[str | int | bool] = []
    for v in row:
        if isinstance(v, (bool, int)):
            out.append(v)
        elif isinstance(v, float):
            out.append(repr(v))
        else:
            out.append(str(v))
    return out


class _Broker:
    """JSON lines to the coordinator on the protocol stream; replies on stdin."""

    def __init__(self, out: IO[str], inp: IO[str]) -> None:
        self._out = out
        self._in = inp
        self._next = 1
        self._lock = threading.Lock()

    def send(self, msg: dict[str, Any]) -> None:
        with self._lock:
            self._out.write(json.dumps(msg, separators=(",", ":")) + "\n")
            self._out.flush()

    def call(self, method: str, params: dict[str, Any]) -> Any:
        with self._lock:
            mid = self._next
            self._next += 1
            self._out.write(
                json.dumps({"t": "call", "id": mid, "method": method, "params": params}) + "\n"
            )
            self._out.flush()
            line = self._in.readline()
        if not line:
            raise BrokerError("broker_closed", "the coordinator closed the broker")
        reply = json.loads(line)
        if reply.get("id") != mid:
            raise BrokerError("broker_protocol", "reply out of order")
        if "error" in reply:
            err = reply["error"]
            raise BrokerError(str(err.get("code")), str(err.get("message")))
        return reply.get("result")


class _Runs:
    def __init__(self, broker: _Broker) -> None:
        self._b = broker

    def list(self, limit: int = 50, filter: str | None = None) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if filter:
            params["filter"] = filter
        result = self._b.call("runs.list", params)
        return list(result.get("runs", []))

    def get(self, run_id: str) -> dict[str, Any]:
        return dict(self._b.call("runs.get", {"run_id": run_id}))

    def metric_history(self, run_id: str, key: str) -> builtins.list[dict[str, Any]]:
        result = self._b.call("runs.metric_history", {"run_id": run_id, "key": key})
        return list(result.get("history", []))


class _Research:
    def __init__(self, broker: _Broker) -> None:
        self._b = broker

    def list(self, kind: str | None = None) -> list[dict[str, Any]]:
        result = self._b.call("research.list", {"kind": kind} if kind else {})
        return list(result.get("records", []))


class _Models:
    def __init__(self, broker: _Broker) -> None:
        self._b = broker

    def list(self) -> list[dict[str, Any]]:
        return list(self._b.call("models.list", {}).get("models", []))


class _Artifacts:
    def __init__(self, out_dir: Path, max_bytes: int) -> None:
        self._dir = out_dir
        self._max = max_bytes

    def _path(self, name: str) -> Path:
        if not _NAME_RE.match(name) or ".." in name.split("/"):
            raise ValueError(f"invalid artifact name {name!r}")
        p = self._dir / name
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def _check(self, extra: int) -> None:
        used = sum(f.stat().st_size for f in self._dir.rglob("*") if f.is_file())
        if used + extra > self._max:
            raise ValueError(f"output area limit of {self._max} bytes exceeded")

    def write_bytes(self, name: str, data: bytes) -> ArtifactRef:
        self._check(len(data))
        self._path(name).write_bytes(data)
        return ArtifactRef(name)

    def write_text(self, name: str, text: str) -> ArtifactRef:
        return self.write_bytes(name, text.encode("utf-8"))

    def write_json(self, name: str, value: Any) -> ArtifactRef:
        return self.write_text(name, json.dumps(value, indent=2, sort_keys=True))

    def path(self, name: str) -> Path:
        """A path to write yourself (for example a matplotlib figure); list it in the result."""
        return self._path(name)


class ExtensionContext:
    """Everything a contribution may use. Built by the runner; do not construct it yourself."""

    def __init__(self, request: dict[str, Any], broker: _Broker) -> None:
        self.project_id: str = request["project_id"]
        self.extension_id: str = request["extension_id"]
        self.execution_id: str = request["execution_id"]
        self.contribution: str = request["contribution"]
        self.capabilities: list[str] = list(request.get("capabilities", []))
        self.refs: list[dict[str, str]] = list(request.get("refs", []))
        self.inputs_dir = Path(request["inputs_dir"])
        self.outputs_dir = Path(request["outputs_dir"])
        self._broker = broker
        self.runs = _Runs(broker)
        self.research = _Research(broker)
        self.models = _Models(broker)
        self.artifacts = _Artifacts(self.outputs_dir, int(request["output_max_bytes"]))

    def progress(self, percent: int, message: str | None = None) -> None:
        msg: dict[str, Any] = {"t": "progress", "percent": max(0, min(100, int(percent)))}
        if message:
            msg["message"] = message[:500]
        self._broker.send(msg)

    def log(self, *args: object) -> None:
        print(*args, file=sys.stderr, flush=True)

    def input_json(self, name: str) -> Any:
        """Read a staged input, for example ``runs/<run_id>.json`` for a run reference."""
        p = (self.inputs_dir / name).resolve()
        if self.inputs_dir.resolve() not in p.parents:
            raise ValueError(f"{name!r} is outside the staged inputs")
        return json.loads(p.read_text(encoding="utf-8"))

    def call(self, method: str, **params: Any) -> Any:
        """A raw broker call; prefer the typed helpers."""
        return self._broker.call(method, params)


def _protocol_streams() -> tuple[IO[str], IO[str]]:
    """Keep the real stdout for the protocol and point fd 1 at stderr, so prints become logs."""
    out = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    return out, sys.stdin
