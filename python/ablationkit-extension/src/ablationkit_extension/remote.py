"""A Python extension contribution on a remote compute target (ADR 0023 decision 26).

Run by a remote extension job: ``python -m ablationkit_extension.remote --request-sha256 H``.
The bundle carries the approved build's source snapshot, the execution request and the inputs the
coordinator staged (``$ABLATIONKIT_BUNDLE_INPUTS/extension/{src,inputs,request.json}``). This
wrapper starts the unchanged runner (``runner.py``) and plays the broker's part offline: it answers
``context.get`` and the staged ``runs.get``/``runs.list`` within the approved capabilities, and
refuses everything that needs the coordinator. The result and the output files are logged through
the SDK (``extension/result.json``, ``extension/outputs/…``), travel in the worker's spool, and the
coordinator validates and records them once the attempt has synced.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

# The broker methods and the capability each needs (as `PYTHON_BROKER_METHODS` on the coordinator).
BROKER_METHODS: dict[str, str | None] = {
    "context.get": None,
    "runs.list": "project.runs.read",
    "runs.get": "project.runs.read",
    "runs.metric_history": "project.runs.read",
    "research.list": "project.research.read",
    "models.list": "project.models.read",
}


def answer(req: dict[str, Any], inputs: Path, m: dict[str, Any]) -> dict[str, Any]:
    mid = m.get("id")
    method = m.get("method")
    params = m.get("params") or {}

    def fail(code: str, message: str) -> dict[str, Any]:
        return {"t": "reply", "id": mid, "error": {"code": code, "message": message}}

    if not isinstance(method, str) or method not in BROKER_METHODS:
        return fail("method_not_allowed", f"{method} is not a broker method")
    need = BROKER_METHODS[method]
    if need and need not in req["capabilities"]:
        return fail("capability_denied", f"{method} needs {need}, which was not granted")
    runs = inputs / "runs"
    if method == "context.get":
        return {
            "t": "reply",
            "id": mid,
            "result": {
                "project_id": req["project_id"],
                "extension_id": req["extension_id"],
                "capabilities": req["capabilities"],
            },
        }
    if method == "runs.get":
        rid = str(params.get("run_id", ""))
        f = runs / f"{rid}.json"
        if not rid.replace("-", "").replace("_", "").isalnum() or not f.is_file():
            return fail(
                "not_staged",
                f"run {rid} was not staged for this remote execution (pass it as a ref)",
            )
        return {"t": "reply", "id": mid, "result": json.loads(f.read_text())}
    if method == "runs.list":
        staged = [json.loads(f.read_text()) for f in sorted(runs.glob("*.json"))]
        return {"t": "reply", "id": mid, "result": {"runs": staged}}
    return fail(
        "not_available_remote",
        f"{method} needs the coordinator, which a remote execution cannot reach; "
        "stage what it needs as refs or run it locally",
    )


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ablationkit_extension.remote")
    ap.add_argument("--request-sha256", required=True)
    args = ap.parse_args(argv)
    base = Path(os.environ.get("ABLATIONKIT_BUNDLE_INPUTS", "inputs")).resolve() / "extension"
    req_path = base / "request.json"
    if not req_path.is_file() or sha256_file(req_path) != args.request_sha256:
        print("the execution request is missing or does not match its SHA-256", file=sys.stderr)
        return 2
    req: dict[str, Any] = json.loads(req_path.read_text())
    work = Path(tempfile.mkdtemp(prefix="ak-ext-"))
    outputs = work / "outputs"
    outputs.mkdir()
    req.update(
        source_dir=str(base / "src"),
        inputs_dir=str(base / "inputs"),
        outputs_dir=str(outputs),
    )
    run_req = work / "request.json"
    run_req.write_text(json.dumps(req))
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": str(work),
        "TMPDIR": str(work),
        "LANG": "C.UTF-8",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "MPLBACKEND": "Agg",
    }
    if not req.get("gpu"):
        env["CUDA_VISIBLE_DEVICES"] = ""
    runner = Path(__file__).with_name("runner.py")
    proc = subprocess.Popen(
        [sys.executable, "-I", "-B", str(runner), str(run_req)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        cwd=work,
        env=env,
        text=True,
    )
    assert proc.stdin is not None
    assert proc.stdout is not None
    result: dict[str, Any] | None = None
    for line in proc.stdout:
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("t") == "call":
            proc.stdin.write(json.dumps(answer(req, base / "inputs", m)) + "\n")
            proc.stdin.flush()
        elif m.get("t") == "progress":
            print(f"progress {m.get('percent')}% {m.get('message') or ''}".rstrip(), flush=True)
        elif m.get("t") == "result" and result is None:
            result = m.get("result") or {}
    proc.stdin.close()
    rc = proc.wait()
    if result is None:
        print(f"the contribution exited ({rc}) without a result", file=sys.stderr)
        return 1
    import ablationkit_sdk as ak

    ak.log_dict(result, "extension/result.json")
    if any(outputs.iterdir()):
        ak.log_artifact(outputs, artifact_path="extension")
    print(f"result: {result.get('status')} {str(result.get('summary', ''))[:200]}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
