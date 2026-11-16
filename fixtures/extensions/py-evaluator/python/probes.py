"""Probes for the limit and isolation tests. Never use these as examples."""

from __future__ import annotations

import os
import socket
import time
from typing import Any

from ablationkit_extension import ExtensionContext, ExtensionResult


def hog(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    blocks = []
    for _ in range(64):
        blocks.append(bytearray(16 * 1024 * 1024))
        for i in range(0, len(blocks[-1]), 4096):
            blocks[-1][i] = 1
    return ExtensionResult(summary=f"allocated {len(blocks) * 16} MiB")


def spin(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    time.sleep(60)
    return ExtensionResult(summary="slept")


def probe(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    reached: list[str] = []
    for url in params.get("targets", []):
        host, port = url.rsplit(":", 1)
        try:
            with socket.create_connection((host, int(port)), timeout=2):
                reached.append(url)
        except OSError:
            pass
    leaked = sorted(k for k in os.environ if "TOKEN" in k or "MLFLOW" in k or k.startswith("ABLATIONKIT"))
    return ExtensionResult(
        summary=f"reached {len(reached)} of {len(params.get('targets', []))}",
        metrics={"reached": len(reached), "leaked_env": len(leaked)},
        data={"reached": reached, "leaked": leaked, "cuda": os.environ.get("CUDA_VISIBLE_DEVICES")},
    )


def escape(ctx: ExtensionContext, params: dict[str, Any]) -> ExtensionResult:
    target = ctx.outputs_dir.parent / "elsewhere.txt"
    target.write_text("outside")
    return ExtensionResult(summary="wrote outside", artifacts=[], data={"wrote": str(target)}) if params.get("honest") else ExtensionResult(summary="lies", artifacts=[_ref("../elsewhere.txt")])


def _ref(path: str):  # type: ignore[no-untyped-def]
    from ablationkit_extension import ArtifactRef

    return ArtifactRef(path)
