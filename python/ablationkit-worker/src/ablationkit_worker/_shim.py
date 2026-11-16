"""Job shim: runs the bundle's command and records how it ended (ADR 0023).

The worker starts the shim in its own session, so the job outlives a worker crash or restart.
The shim writes the job's stdout/stderr to files the worker tails, applies limits, and writes
``exit.json`` once the job's process tree is gone. With a usable systemd user manager it runs the
job in a transient scope with MemoryMax/CPUQuota/TasksMax/RuntimeMaxSec (enforced); otherwise
only the time limit is applied, by the shim, and the limits are labelled advisory.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from ._common import iso_now, read_json, write_json

STOP_GRACE_SEC = 15.0


def _systemd_usable(env: dict[str, str]) -> bool:
    if env.get("ABLATIONKIT_WORKER_SUPERVISOR") == "direct" or not shutil.which("systemd-run"):
        return False
    try:
        r = subprocess.run(
            ["systemd-run", "--user", "--scope", "--quiet", "true"],
            env=env,
            capture_output=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0


def _limit_props(limits: dict[str, int]) -> list[str]:
    props = []
    if "memory_max_bytes" in limits:
        props += [f"MemoryMax={limits['memory_max_bytes']}", "MemorySwapMax=0"]
    if "cpu_quota_percent" in limits:
        props.append(f"CPUQuota={limits['cpu_quota_percent']}%")
    if "runtime_max_sec" in limits:
        props.append(f"RuntimeMaxSec={limits['runtime_max_sec']}")
    if "tasks_max" in limits:
        props.append(f"TasksMax={limits['tasks_max']}")
    return props


def _show(unit: str, env: dict[str, str]) -> dict[str, str]:
    try:
        r = subprocess.run(
            [
                "systemctl",
                "--user",
                "show",
                "-p",
                "ActiveState",
                "-p",
                "Result",
                "-p",
                "LoadState",
                unit,
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    out = {}
    for line in r.stdout.splitlines():
        k, _, v = line.partition("=")
        if k:
            out[k] = v
    return out


def job_env(root: Path, manifest: dict[str, Any]) -> dict[str, str]:
    """The job's environment: the worker's, the bundle's `env`, and the SDK wiring."""
    spool = root / "spool"
    env = {k: v for k, v in os.environ.items() if not k.startswith("ABLATIONKIT_")}
    env.update(manifest["env"])
    sdk = root / "bundle" / "sdk"
    env["PYTHONPATH"] = os.pathsep.join(
        [str(sdk), *([os.environ["PYTHONPATH"]] if os.environ.get("PYTHONPATH") else [])]
    )
    env["PYTHONUNBUFFERED"] = "1"
    env["ABLATIONKIT_EVENTS_FILE"] = str(spool / "sdk-events.jsonl")
    env["ABLATIONKIT_ARTIFACT_DIR"] = str(spool / "artifacts")
    env["ABLATIONKIT_PROJECT_ID"] = manifest["project_id"]
    env["ABLATIONKIT_JOB_ID"] = manifest["job_id"]
    env["ABLATIONKIT_ATTEMPT_ID"] = manifest["attempt_id"]
    env["ABLATIONKIT_BUNDLE_INPUTS"] = str(root / "bundle" / "inputs")
    if os.environ.get("ABLATIONKIT_WORKER_SUPERVISOR"):
        env["ABLATIONKIT_WORKER_SUPERVISOR"] = os.environ["ABLATIONKIT_WORKER_SUPERVISOR"]
    return env


def run_shim(root: Path) -> int:
    manifest = read_json(root / "bundle" / "bundle.json")
    spool = root / "spool"
    exit_path = spool / "exit.json"
    if exit_path.exists():
        return 0
    # Handlers first: a cancel can arrive while the job is still being set up.
    state: dict[str, Any] = {"cancelled": False, "timed_out": False, "pid": None}

    def stop(_sig: int = signal.SIGTERM, _frame: object = None) -> None:
        state["cancelled"] = True
        if state["pid"]:
            _kill_group(state["pid"], signal.SIGTERM)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    source = root / "bundle" / "source"
    cwd = (source / manifest["cwd"]).resolve()
    env = job_env(root, manifest)
    argv = list(manifest["argv"])
    if manifest["environment"] == "uv":
        uv = shutil.which("uv")
        if not uv:
            write_json(
                exit_path,
                {
                    "exit_code": 127,
                    "timed_out": False,
                    "oom_killed": False,
                    "error": "the bundle uses environment `uv` but uv is not on this worker's PATH",
                    "ended_at": iso_now(),
                },
            )
            return 0
        argv = [uv, "run", "--frozen", "--project", str(source), "--", *argv]
    limits: dict[str, int] = manifest["limits"]
    target = manifest["target_kind"]
    systemd = bool(limits) and _systemd_usable(env)
    unit = f"ak-job-{manifest['attempt_id']}-{os.getpid()}"
    if systemd:
        argv = [
            "systemd-run",
            "--user",
            "--scope",
            "--quiet",
            f"--unit={unit}",
            *[
                f"--property={p}"
                for p in [*_limit_props(limits), f"TimeoutStopSec={int(STOP_GRACE_SEC)}s"]
            ],
            "--",
            *argv,
        ]
        mode, enforcement = "systemd", "enforced"
        reason = "systemd user scope on the worker"
    elif target == "slurm":
        mode, enforcement = "slurm", "advisory"
        reason = (
            "SLURM enforces --time; memory and CPU depend on the cluster's cgroup configuration"
        )
    else:
        mode, enforcement = "direct", "advisory"
        reason = (
            "no systemd user manager on the worker: only the time limit is applied, by the shim"
        )
    out = (spool / "stdout.log").open("ab")
    err = (spool / "stderr.log").open("ab")
    started = time.monotonic()
    if state["cancelled"]:
        write_json(
            exit_path,
            {
                "signal": "SIGTERM",
                "cancelled": True,
                "timed_out": False,
                "oom_killed": False,
                "error": "cancelled before the job started",
                "ended_at": iso_now(),
            },
        )
        return 0
    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=err,
            start_new_session=True,
        )
    except OSError as e:
        write_json(
            exit_path,
            {
                "exit_code": 127,
                "timed_out": False,
                "oom_killed": False,
                "error": f"could not start the job: {e}",
                "ended_at": iso_now(),
            },
        )
        return 0
    write_json(
        spool / "job.json",
        {
            "pid": proc.pid,
            "shim_pid": os.getpid(),
            "mode": mode,
            "enforcement": enforcement,
            "reason": reason,
            **({"unit": f"{unit}.scope"} if systemd else {}),
            "started_at": iso_now(),
        },
    )
    state["pid"] = proc.pid
    if state["cancelled"]:
        _kill_group(proc.pid, signal.SIGTERM)
    deadline = (
        None if systemd or "runtime_max_sec" not in limits else started + limits["runtime_max_sec"]
    )
    killed_at: float | None = None
    while True:
        try:
            code = proc.wait(timeout=0.5)
            break
        except subprocess.TimeoutExpired:
            pass
        now = time.monotonic()
        if deadline is not None and now >= deadline and not state["timed_out"]:
            state["timed_out"] = True
            _kill_group(proc.pid, signal.SIGTERM)
            killed_at = now
        if (state["cancelled"] or state["timed_out"]) and killed_at is None:
            killed_at = now
        if killed_at is not None and now - killed_at > STOP_GRACE_SEC:
            _kill_group(proc.pid, signal.SIGKILL)
    leftovers = _kill_group(proc.pid, signal.SIGKILL)
    result: dict[str, Any] = {}
    if systemd:
        st = _show(f"{unit}.scope", env)
        for _ in range(50):
            if st.get("ActiveState") != "deactivating":
                break
            time.sleep(0.1)
            st = _show(f"{unit}.scope", env)
        if st.get("ActiveState") == "active":
            leftovers = True
            subprocess.run(
                ["systemctl", "--user", "stop", f"{unit}.scope"], env=env, capture_output=True
            )
        unit_result = st.get("Result") if st.get("LoadState") != "not-found" else None
        result["unit_result"] = unit_result or "success"
        subprocess.run(
            ["systemctl", "--user", "reset-failed", f"{unit}.scope"], env=env, capture_output=True
        )
    exit_info: dict[str, Any] = {
        **({"exit_code": code} if code >= 0 else {"signal": signal.Signals(-code).name}),
        "timed_out": state["timed_out"] or result.get("unit_result") == "timeout",
        "oom_killed": result.get("unit_result") == "oom-kill",
        "leftovers_killed": leftovers,
        "cancelled": state["cancelled"],
        "duration_ms": int((time.monotonic() - started) * 1000),
        "ended_at": iso_now(),
        **result,
    }
    out.close()
    err.close()
    write_json(exit_path, exit_info)
    return 0


def _kill_group(pgid: int, sig: int) -> bool:
    try:
        os.killpg(pgid, sig)
        return True
    except (ProcessLookupError, PermissionError):
        return False


if __name__ == "__main__":  # pragma: no cover
    sys.exit(run_shim(Path(sys.argv[1])))
