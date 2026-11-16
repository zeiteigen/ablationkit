"""The Python extension runner (ADR 0022). The coordinator starts it as

    <build venv>/bin/python -I -B <sdk>/ablationkit_extension/runner.py <request.json>

under a systemd scope with the manifest's limits. It loads the entry function from the approved
build's source snapshot, calls it with an ExtensionContext and sends one ``result`` message.
Runs as a script (``-I`` ignores PYTHONPATH), so it puts the SDK on ``sys.path`` itself.

With ``--serve`` (a warm worker, ``python.warm``, ADR 0047) it stays up and handles one request
at a time: each arrives on stdin as ``{"t": "request", "request": {...}}`` and gets its own
``result``; loaded entry modules (and whatever they imported) are kept between requests.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import traceback
from pathlib import Path
from types import ModuleType
from typing import Any

_MODULES: dict[str, ModuleType] = {}


def _entry(request: dict[str, Any]) -> Any:
    source = Path(request["source_dir"])
    file_rel, func_name = request["entry"].rsplit(":", 1)
    module_path = (source / file_rel).resolve()
    if source.resolve() not in module_path.parents:
        raise ValueError("entry is outside the extension source")
    key = str(module_path)
    module = _MODULES.get(key)
    if module is None:
        # The entry's directory comes first, so sibling modules import as in development.
        if str(module_path.parent) not in sys.path:
            sys.path.insert(0, str(module_path.parent))
        spec = importlib.util.spec_from_file_location(
            f"_ak_extension_entry_{len(_MODULES)}", module_path
        )
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {file_rel}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _MODULES[key] = module
    return getattr(module, func_name)


def _handle(request: dict[str, Any], broker: Any) -> dict[str, Any]:
    from ablationkit_extension import ExtensionContext, ExtensionResult

    try:
        fn = _entry(request)
        ctx = ExtensionContext(request, broker)
        value = fn(ctx, dict(request.get("params", {})))
        if not isinstance(value, ExtensionResult):
            raise TypeError(
                f"{request['entry']} returned {type(value).__name__}, not ExtensionResult"
            )
        return value.to_wire()
    except Exception as e:
        tb = traceback.format_exc()
        print(tb, file=sys.stderr, flush=True)
        return {
            "status": "error",
            "summary": f"{type(e).__name__}: {e}"[:2000],
            "metrics": {},
            "tables": [],
            "warnings": [],
            "errors": [tb[-2000:]],
            "artifacts": [],
        }


def main(argv: list[str]) -> int:
    sdk_root = Path(__file__).resolve().parent.parent
    if str(sdk_root) not in sys.path:
        sys.path.insert(0, str(sdk_root))
    from ablationkit_extension import _Broker, _protocol_streams

    out, inp = _protocol_streams()
    broker = _Broker(out, inp)
    if argv[1:2] == ["--serve"]:
        broker.send({"t": "ready"})
        while True:
            line = inp.readline()
            if not line:
                return 0
            msg = json.loads(line)
            if msg.get("t") != "request":
                continue
            req: dict[str, Any] = msg["request"]
            result = _handle(req, broker)
            # Marks the end of this run's stderr, so its log holds all of it and nothing after.
            sys.stdout.flush()
            sys.stderr.write(f"\0ak-run-end {req['execution_id']}\n")
            sys.stderr.flush()
            broker.send({"t": "result", "execution_id": req["execution_id"], "result": result})
    one: dict[str, Any] = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    broker.send({"t": "result", "result": _handle(one, broker)})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
