"""``python3 -m ablationkit_worker run|drain|status|exec --dir DIR`` (ADR 0023).

- ``run``: verify the bundle, start the job (once; never again after a restart or a requeue),
  spool and deliver until everything is acknowledged or the delivery deadline passes.
- ``drain``: deliver an existing spool without starting anything. The coordinator runs it on a
  SLURM login node or an SSH host after the provider reports that the job ended.
- ``status``: print the worker's state as JSON.
- ``cancel``: stop the job (provider-native cancellation; the worker then delivers the exit).
- ``exec``: internal; the job shim.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ._common import read_json_or
from ._shim import run_shim
from ._worker import BundleError, Worker, cancel


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="ablationkit_worker")
    p.add_argument("command", choices=["run", "drain", "status", "cancel", "exec"])
    p.add_argument("--dir", required=True, type=Path)
    p.add_argument("--provider-job-id")
    a = p.parse_args(argv)
    root: Path = a.dir.expanduser().resolve()
    if a.command == "exec":
        return run_shim(root)
    if a.command == "cancel":
        return cancel(root)
    if a.command == "status":
        state = read_json_or(root / "state.json", {})
        state.pop("shim_start", None)
        json.dump(
            {**state, "exit": read_json_or(root / "spool" / "exit.json", None)},
            sys.stdout,
            indent=2,
        )
        print()
        return 0
    try:
        return Worker(
            root, drain_only=a.command == "drain", provider_job_id=a.provider_job_id
        ).run()
    except BundleError as e:
        print(f"ablationkit-worker: refusing to run: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
