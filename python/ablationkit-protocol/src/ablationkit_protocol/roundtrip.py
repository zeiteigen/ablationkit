"""Validate JSON documents against a protocol model and echo them back.

Used by the cross-language round-trip test::

    python -m ablationkit_protocol.roundtrip <ModelName>
    python -m ablationkit_protocol.roundtrip --batch

With a model name it reads one JSON document per stdin line. With ``--batch`` each line is
``{"model": "<ModelName>", "doc": <document>}``, so one process (one import of the generated
models) serves every model. Either way it writes, per line, either
``{"ok": <re-serialized document>}`` or ``{"error": "<message>"}``.
"""

from __future__ import annotations

import json
import sys

from pydantic import ValidationError

from ablationkit_protocol.models import MODELS


def _check(model_name: str, doc_json: str) -> object:
    try:
        return {"ok": MODELS[model_name].from_json(doc_json).to_json_obj()}
    except ValidationError as e:
        return {"error": str(e)}


def main(argv: list[str]) -> int:
    batch = argv == ["--batch"]
    if not batch and (len(argv) != 1 or argv[0] not in MODELS):
        print(f"usage: roundtrip --batch | roundtrip <{'|'.join(MODELS)}>", file=sys.stderr)
        return 2
    for line in sys.stdin:
        if not line.strip():
            continue
        if batch:
            req = json.loads(line)
            name = req.get("model") if isinstance(req, dict) else None
            if name not in MODELS:
                result: object = {"error": f"unknown model {name!r}"}
            else:
                result = _check(name, json.dumps(req["doc"]))
        else:
            result = _check(argv[0], line)
        sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
