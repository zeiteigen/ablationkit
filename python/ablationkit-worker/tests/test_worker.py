"""Remote worker against a fake coordinator (ADR 0023; spec §5.7 failure cases).

The end-to-end path through the real coordinator, SSH and SLURM targets is
apps/server/test/remote.test.ts; these tests pin the worker's own behavior.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

import ablationkit_worker
from ablationkit_worker import Journal, Worker, verify_bundle
from ablationkit_worker import _worker as worker_mod

PKG = Path(ablationkit_worker.__file__).parent
SDK = Path(__file__).resolve().parents[2] / "ablationkit-sdk" / "src" / "ablationkit_sdk"
JOB, ATTEMPT = "j-test", "j-test-a1"
BASE = f"/api/v1/jobs/{JOB}/attempts/{ATTEMPT}"


class Fake:
    """Just enough of the coordinator's worker API: dedupe, handshake, refresh, uploads."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.hwm: dict[str, int] = {}
        self.duplicates = 0
        self.spool_acked = -1
        self.tokens = {"up-1": "upload", "launch-1": "launch"}
        self.handshakes: list[dict[str, Any]] = []
        self.cancel = False
        self.fail_next_ack = 0
        self.fail_put_after = -1
        self.uploads: dict[str, dict[str, Any]] = {}
        self.artifacts: dict[str, bytes] = {}
        self.refreshes = 0
        self.notifications: list[tuple[dict[str, str], str]] = []
        self.lock = threading.Lock()
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_a: Any) -> None:
                pass

            def _send(self, status: int, body: Any) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _auth(self) -> str | None:
                tok = self.headers.get("authorization", "").removeprefix("Bearer ")
                return fake.tokens.get(tok)

            def do_POST(self) -> None:
                with fake.lock:
                    self._post()

            def do_PUT(self) -> None:
                with fake.lock:
                    self._put()

            def _body(self) -> bytes:
                return self.rfile.read(int(self.headers.get("content-length", "0")))

            def _post(self) -> None:
                body = self._body()
                if self.path == "/ntfy/topic":
                    fake.notifications.append((dict(self.headers), body.decode()))
                    return self._send(200, {})
                purpose = self._auth()
                if purpose is None:
                    return self._send(401, {"error": {"code": "unauthenticated"}})
                if self.path == f"{BASE}/handshake":
                    hs = json.loads(body)
                    fake.handshakes.append(hs)
                    reply: dict[str, Any] = {
                        "schema_version": 1,
                        "spool_acked_seq": fake.spool_acked,
                        "cancel_requested": fake.cancel,
                        "heartbeat_sec": 1,
                        "artifacts": [],
                    }
                    if hs["refresh"]:
                        fake.refreshes += 1
                        tok = f"up-{fake.refreshes + 1}"
                        fake.tokens[tok] = "upload"
                        reply.update(upload_token=tok, upload_expires_at="2099-01-01T00:00:00.000Z")
                    return self._send(200, reply)
                if purpose != "upload":
                    return self._send(403, {"error": {"code": "forbidden"}})
                if self.path == f"{BASE}/events:batch":
                    for e in json.loads(body)["events"]:
                        seen = fake.hwm.get(e["producer_id"])
                        if seen is not None and e["producer_seq"] <= seen:
                            fake.duplicates += 1
                            continue
                        fake.hwm[e["producer_id"]] = e["producer_seq"]
                        fake.events.append(e)
                    fake.spool_acked = int(self.headers["x-ablationkit-spool-through"])
                    if fake.fail_next_ack > 0:
                        fake.fail_next_ack -= 1
                        return self._send(500, {"error": {"code": "lost"}})  # applied, ack lost
                    return self._send(200, {"accepted": 1, "duplicates": 0, "rejected": 0})
                if self.path == f"{BASE}/uploads":
                    req = json.loads(body)
                    uid = f"u-{len(fake.uploads):016x}"
                    fake.uploads[uid] = {**req, "data": b""}
                    return self._send(201, {"upload_id": uid, "received": 0})
                if self.path.startswith(f"{BASE}/uploads/") and self.path.endswith("/complete"):
                    uid = self.path.split("/")[-2]
                    u = fake.uploads[uid]
                    if hashlib.sha256(u["data"]).hexdigest() != u["sha256"]:
                        return self._send(422, {"error": {"code": "checksum_mismatch"}})
                    fake.artifacts[u["path"]] = u["data"]
                    return self._send(201, {"path": u["path"]})
                return self._send(404, {})

            def _put(self) -> None:
                body = self._body()
                if self._auth() != "upload":
                    return self._send(401, {})
                uid = self.path.split("/")[-1]
                u = fake.uploads[uid]
                off = int(self.headers["x-ablationkit-offset"])
                if off != len(u["data"]):
                    return self._send(409, {"received": len(u["data"])})
                if fake.fail_put_after >= 0 and len(u["data"]) >= fake.fail_put_after:
                    fake.fail_put_after = -1
                    return self._send(503, {"error": {"code": "interrupted"}})
                u["data"] += body
                return self._send(200, {"received": len(u["data"])})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def types(self) -> list[str]:
        return [e["type"] for e in self.events]

    def console(self, stream: str = "stdout") -> list[str]:
        return [
            e["payload"]["text"]
            for e in self.events
            if e["type"] == "console.line" and e["payload"]["stream"] == stream
        ]

    def exited(self) -> dict[str, Any]:
        return next(e["payload"] for e in self.events if e["type"] == "attempt.exited")


@pytest.fixture
def fake() -> Iterator[Fake]:
    f = Fake()
    yield f
    f.server.shutdown()


@pytest.fixture(autouse=True)
def _direct(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ABLATIONKIT_WORKER_SUPERVISOR", "direct")
    monkeypatch.delenv("ABLATIONKIT_KEEP_SPOOL", raising=False)


def make_bundle(
    tmp: Path,
    url: str,
    script: str,
    *,
    limits: dict[str, int] | None = None,
    upload_token: str = "up-1",
    launch_token: str = "launch-1",
    **extra: Any,
) -> Path:
    root = tmp / ATTEMPT
    b = root / "bundle"
    (b / "source").mkdir(parents=True)
    (b / "source" / "train.py").write_text(script)
    shutil.copytree(
        PKG, b / "worker" / "ablationkit_worker", ignore=shutil.ignore_patterns("__pycache__")
    )
    shutil.copytree(
        SDK, b / "sdk" / "ablationkit_sdk", ignore=shutil.ignore_patterns("__pycache__")
    )
    files = []
    for p in sorted(b.rglob("*")):
        if p.is_file():
            files.append(
                {
                    "path": p.relative_to(b).as_posix(),
                    "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
                    "size": p.stat().st_size,
                }
            )
    manifest = {
        "schema_version": 1,
        "bundle_id": "b-0123456789ab",
        "project_id": "proj",
        "job_id": JOB,
        "attempt_id": ATTEMPT,
        "target_id": "box",
        "target_kind": "ssh",
        "created_at": "2026-11-05T00:00:00.000Z",
        "worker_url": url,
        "argv": [sys.executable, "train.py"],
        "environment": "none",
        "cwd": ".",
        "env": {},
        "limits": limits or {},
        "artifact_paths": [],
        "source_commit": "a" * 40,
        "files": files,
        "heartbeat_sec": 1,
        "max_backoff_sec": 1,
        "spool_max_bytes": 64 * 1024 * 1024,
        "min_free_disk_bytes": 0,
        "deliver_deadline_sec": 30,
        **extra,
    }
    (b / "bundle.json").write_text(json.dumps(manifest))
    (root / "credentials.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "launch_token": launch_token,
                "launch_expires_at": "2099-01-01T00:00:00.000Z",
                "upload_token": upload_token,
                "upload_expires_at": "2099-01-01T00:00:00.000Z",
            }
        )
    )
    return root


def spawn(root: Path) -> subprocess.Popen[bytes]:
    env = {**os.environ, "PYTHONPATH": str(root / "bundle" / "worker")}
    return subprocess.Popen(
        [sys.executable, "-m", "ablationkit_worker", "run", "--dir", str(root)],
        env=env,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )


def wait_for(cond: Any, timeout: float = 20.0) -> None:
    end = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > end:
            raise AssertionError("condition not met in time")
        time.sleep(0.05)


SDK_SCRIPT = """
import ablationkit_sdk as ak
for step in range(3):
    ak.log_metrics({"loss": 1.0 / (step + 1)}, step=step)
    print(f"step {step}", flush=True)
open("model.bin", "wb").write(b"weights" * 1000)
ak.log_artifact("model.bin", artifact_path="ckpt")
"""


def test_journal_matches_the_core_format(tmp_path: Path) -> None:
    j = Journal(tmp_path, max_segment_bytes=200)
    stored = [r for i in range(6) for r in j.append_batch([{"type": f"e{i}", "pad": "x" * 50}])]
    assert [r["seq"] for r in stored] == list(range(6))
    assert len(j.segments()) >= 2
    assert [r["seq"] for r in j.read_from(2, 10, 1 << 20)] == [2, 3, 4, 5]
    # A torn final line is dropped on open; the next append continues the sequence.
    last = j.segments()[-1][1]
    with last.open("ab") as fh:
        fh.write(b'{"seq": 6, "torn')
    j2 = Journal(tmp_path, max_segment_bytes=200)
    assert j2.next_seq == 6
    assert j2.append_batch([{"type": "after"}])[0]["seq"] == 6
    assert j2.gc(3) > 0
    assert j2.first_available() <= 4
    names = sorted(p.name for _, p in j2.segments())
    assert all(n.startswith("spool-") and n.endswith(".jsonl") for n in names)


def test_a_changed_bundle_file_is_refused(tmp_path: Path, fake: Fake) -> None:
    root = make_bundle(tmp_path, fake.url, "print('hi')\n")
    verify_bundle(root / "bundle")
    (root / "bundle" / "source" / "train.py").write_text("print('tampered')\n")
    with pytest.raises(ablationkit_worker.BundleError, match="changed"):
        verify_bundle(root / "bundle")


def test_runs_the_job_and_delivers_console_metrics_artifacts_and_exit(
    tmp_path: Path, fake: Fake
) -> None:
    root = make_bundle(tmp_path, fake.url, SDK_SCRIPT)
    assert Worker(root).run() == 0
    assert fake.console() == ["step 0", "step 1", "step 2"]
    assert fake.types()[0] == "attempt.started"
    started = fake.events[0]["payload"]
    assert started["mode"] == "direct"
    assert started["enforcement"] == "advisory"
    assert started["source_commit"] == "a" * 40
    assert sum(1 for t in fake.types() if t == "metric.batch") == 3
    assert fake.exited()["exit_code"] == 0
    assert fake.artifacts["ckpt/model.bin"] == b"weights" * 1000
    assert fake.handshakes[-1]["drained"] is True
    # Delivered: the spool and credentials are gone; the state says synced.
    assert not (root / "spool").exists()
    assert not (root / "credentials.json").exists()
    assert json.loads((root / "state.json").read_text())["phase"] == "synced"


def test_progress_bars_and_unfinished_lines_are_read_once_in_order(
    tmp_path: Path, fake: Fake
) -> None:
    # A progress bar rewrites one line with carriage returns over several of the worker's reads,
    # then the line ends; the job's last line has no newline. Re-reading an unfinished line once
    # duplicated it and drove the offset negative (seek: Invalid argument).
    script = (
        "import sys, time\n"
        "for i in range(40):\n"
        "    sys.stderr.write('\\rdownloading ' + str(i) * 300)\n"
        "    sys.stderr.flush()\n"
        "    time.sleep(0.02)\n"
        "sys.stderr.write('\\rdownloaded\\n')\n"
        "print('first', flush=True)\n"
        "sys.stdout.write('last without newline')\n"
    )
    root = make_bundle(tmp_path, fake.url, script)
    assert Worker(root).run() == 0
    assert fake.console() == ["first", "last without newline"]
    assert fake.console("stderr") == ["downloaded"]
    assert fake.exited()["exit_code"] == 0


def test_a_stale_upload_token_is_refreshed_with_the_launch_token(
    tmp_path: Path, fake: Fake
) -> None:
    root = make_bundle(tmp_path, fake.url, "print('hello', flush=True)\n", upload_token="stale")
    assert Worker(root).run() == 0
    assert fake.refreshes >= 1
    assert any(h["refresh"] for h in fake.handshakes)
    assert fake.console() == ["hello"]


def test_an_expired_launch_token_keeps_the_spool_for_later(tmp_path: Path, fake: Fake) -> None:
    root = make_bundle(
        tmp_path,
        fake.url,
        "print('hello', flush=True)\n",
        upload_token="stale",
        launch_token="gone",
        deliver_deadline_sec=1,
    )
    assert Worker(root).run() == worker_mod.EXIT_DEADLINE
    state = json.loads((root / "state.json").read_text())
    assert "launch token" in state["credentials_failed"]
    assert list((root / "spool" / "journal").glob("spool-*.jsonl"))
    assert (root / "spool" / "exit.json").exists()


def test_offline_mode_spools_everything_and_never_calls_the_coordinator(
    tmp_path: Path, fake: Fake, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ABLATIONKIT_WORKER_OFFLINE", "1")
    root = make_bundle(tmp_path, fake.url, SDK_SCRIPT, deliver_deadline_sec=0)
    assert Worker(root).run() == worker_mod.EXIT_DEADLINE
    assert fake.handshakes == []
    assert fake.events == []
    assert (root / "spool" / "exit.json").exists()
    assert list((root / "spool" / "journal").glob("spool-*.jsonl"))


def test_a_lost_acknowledgment_is_replayed_and_deduplicated(tmp_path: Path, fake: Fake) -> None:
    fake.fail_next_ack = 2
    root = make_bundle(tmp_path, fake.url, "for i in range(5):\n    print(i, flush=True)\n")
    assert Worker(root).run() == 0
    assert fake.console() == ["0", "1", "2", "3", "4"]
    assert len({e["event_id"] for e in fake.events}) == len(fake.events)


def test_an_interrupted_artifact_upload_resumes_at_the_received_offset(
    tmp_path: Path, fake: Fake, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(worker_mod, "CHUNK_BYTES", 1024)
    fake.fail_put_after = 2048
    root = make_bundle(tmp_path, fake.url, SDK_SCRIPT)
    assert Worker(root).run() == 0
    assert fake.artifacts["ckpt/model.bin"] == b"weights" * 1000
    assert len(fake.uploads) == 1  # resumed, not restarted


def test_the_time_limit_ends_the_job_as_timed_out(tmp_path: Path, fake: Fake) -> None:
    root = make_bundle(
        tmp_path, fake.url, "import time\ntime.sleep(30)\n", limits={"runtime_max_sec": 1}
    )
    assert Worker(root).run() == 0
    assert fake.exited()["timed_out"] is True


def test_cancel_from_the_heartbeat_stops_the_job(tmp_path: Path, fake: Fake) -> None:
    fake.cancel = True
    root = make_bundle(tmp_path, fake.url, "import time\nprint('up', flush=True)\ntime.sleep(30)\n")
    t0 = time.monotonic()
    assert Worker(root).run() == 0
    assert time.monotonic() - t0 < 20
    ex = fake.exited()
    assert ex.get("cancelled") is True
    assert ex.get("signal") == "SIGTERM"


def test_disk_pressure_drops_noncritical_events_but_keeps_the_exit(
    tmp_path: Path, fake: Fake
) -> None:
    root = make_bundle(
        tmp_path,
        fake.url,
        "for i in range(50):\n    print(i, flush=True)\n",
        min_free_disk_bytes=1 << 62,
    )
    assert Worker(root).run() == 0
    assert fake.console() == []
    assert fake.exited()["exit_code"] == 0
    assert fake.handshakes[-1]["spool"]["disk_pressure"] is True
    assert fake.handshakes[-1]["spool"]["dropped_events"] >= 50


def test_a_worker_crash_does_not_stop_the_job_and_a_restart_resumes(
    tmp_path: Path, fake: Fake
) -> None:
    script = (
        "import time\nopen('runs.txt', 'a').write('run\\n')\n"
        "for i in range(8):\n    print(f'tick {i}', flush=True)\n    time.sleep(0.25)\n"
    )
    root = make_bundle(tmp_path, fake.url, script)
    w = spawn(root)
    wait_for(lambda: "tick 1" in fake.console())
    os.kill(w.pid, signal.SIGKILL)  # the worker only; the shim and the job keep going
    w.wait()
    w2 = spawn(root)
    assert w2.wait(timeout=60) == 0
    assert fake.console() == [f"tick {i}" for i in range(8)]
    assert fake.exited()["exit_code"] == 0
    assert (root / "bundle" / "source").exists() is False  # synced and cleaned up


def test_after_a_reboot_the_job_is_reported_lost_and_never_rerun(
    tmp_path: Path, fake: Fake
) -> None:
    script = (
        "import time\nopen('runs.txt', 'a').write('run\\n')\n"
        "print('started', flush=True)\ntime.sleep(60)\n"
    )
    os.environ["ABLATIONKIT_KEEP_SPOOL"] = "1"
    try:
        root = make_bundle(tmp_path, fake.url, script)
        w = spawn(root)
        wait_for(lambda: "started" in fake.console())
        job = json.loads((root / "spool" / "job.json").read_text())
        # A reboot: the worker, the shim and the job all die at once.
        for pid in (w.pid, job["shim_pid"]):
            os.kill(pid, signal.SIGKILL)
        os.killpg(job["pid"], signal.SIGKILL)
        w.wait()
        time.sleep(0.3)
        w2 = spawn(root)
        assert w2.wait(timeout=60) == 0
    finally:
        del os.environ["ABLATIONKIT_KEEP_SPOOL"]
    ex = fake.exited()
    assert ex["lost"] is True
    assert "not rerun" in ex["error"]
    assert (root / "bundle" / "source" / "runs.txt").read_text() == "run\n"
    assert fake.handshakes[-1]["phase"] == "lost"


def test_drain_delivers_an_existing_spool_without_starting_the_job(
    tmp_path: Path, fake: Fake
) -> None:
    root = make_bundle(tmp_path, fake.url, "open('ran', 'w').write('x')\n")
    assert Worker(root, drain_only=True).run() == 0
    assert not (root / "bundle" / "source" / "ran").exists()
    assert fake.exited()["lost"] is True
    assert "never started" in fake.exited()["error"]


def test_ntfy_gets_the_terminal_status_once(tmp_path: Path, fake: Fake) -> None:
    root = make_bundle(tmp_path, fake.url, "print('hi', flush=True)\n")
    creds = json.loads((root / "credentials.json").read_text())
    creds["ntfy"] = {"url": f"{fake.url}/ntfy/topic", "token": "tk_test"}
    (root / "credentials.json").write_text(json.dumps(creds))
    assert Worker(root).run() == 0
    assert len(fake.notifications) == 1
    headers, body = fake.notifications[0]
    lower = {k.lower(): v for k, v in headers.items()}
    assert lower["title"] == f"AblationKit {ATTEMPT}: job finished"
    assert lower["authorization"] == "Bearer tk_test"
    assert body == f"{ATTEMPT} exited with 0"


def test_expired_store_slots_fall_back_to_the_coordinator(tmp_path: Path, fake: Fake) -> None:
    """Security suite (Stage 18b): a presigned URL past its expiry is never tried."""
    root = make_bundle(tmp_path, fake.url, SDK_SCRIPT)
    creds = json.loads((root / "credentials.json").read_text())
    creds["artifact_store"] = {
        "min_bytes": 1,
        "slots": [
            {
                "slot": 0,
                "url": "http://127.0.0.1:9/never?X-Amz-Signature=x",
                "expires_at": "2020-01-01T00:00:00.000Z",
            }
        ],
    }
    (root / "credentials.json").write_text(json.dumps(creds))
    assert Worker(root).run() == 0
    assert fake.artifacts["ckpt/model.bin"] == b"weights" * 1000


def test_a_rewritten_metrics_file_is_told_from_an_append(tmp_path: Path) -> None:
    """F43: same-size and larger rewrites in place, and a replaced file, restart the cursor."""
    f = tmp_path / "m.jsonl"
    f.write_text('{"acc": 0.1}\n')
    cur = worker_mod.metrics_cursor(f, f.stat().st_size)
    assert not worker_mod.metrics_rewritten(f, f.stat(), cur)
    time.sleep(0.01)
    with f.open("a") as fh:  # an append
        fh.write('{"acc": 0.2}\n')
    assert not worker_mod.metrics_rewritten(f, f.stat(), cur)
    cur = worker_mod.metrics_cursor(f, f.stat().st_size)
    time.sleep(0.01)
    f.write_text('{"acc": 0.3}\n{"acc": 0.4}\n')  # same size, other bytes, same inode
    assert f.stat().st_size == cur["offset"]
    assert worker_mod.metrics_rewritten(f, f.stat(), cur)
    cur = worker_mod.metrics_cursor(f, f.stat().st_size)
    time.sleep(0.01)
    f.write_text('{"acc": 0.3}\n{"acc": 0.4}\n')  # byte-identical rewrite
    assert worker_mod.metrics_rewritten(f, f.stat(), cur)
    cur = worker_mod.metrics_cursor(f, 13)
    time.sleep(0.01)
    f.write_text('{"acc": 0.5}\n{"acc": 0.6}\n{"acc": 0.7}\n')  # larger, changed prefix
    assert worker_mod.metrics_rewritten(f, f.stat(), cur)
    cur = worker_mod.metrics_cursor(f, f.stat().st_size)
    tmp = tmp_path / "m.tmp"
    tmp.write_text(f.read_text())
    os.replace(tmp, f)  # another inode
    assert worker_mod.metrics_rewritten(f, f.stat(), cur)
    f.write_text("")
    assert worker_mod.metrics_rewritten(f, f.stat(), cur)  # truncated


# ---------------------------------------------------------------- metrics-file lines (ADR 0042)
# The same cases as packages/collector/test/metrics-file.test.ts: both adapters read alike.

NOW = 1_800_000_000_000


def test_metrics_lines_default_format() -> None:
    line = {"step": 3, "timestamp": 1_700_000_000_000, "loss": 0.4, "tag": "x"}
    assert worker_mod.metrics_from_line(line, {}, 9, NOW) == [
        {"key": "loss", "value": 0.4, "step": 3, "timestamp": 1_700_000_000_000}
    ]
    assert worker_mod.metrics_from_line({"loss": 0.4}, None, 9, NOW) == [
        {"key": "loss", "value": 0.4, "step": 9, "timestamp": NOW}
    ]


def test_metrics_lines_flatten_nested_objects() -> None:
    obj = {"a": 1, "val": {"bpb": 1.2, "inner": {"n": 2}}, "xs": [1, 2], "ok": True, "s": "1"}
    assert worker_mod.flatten_numbers(obj) == {"a": 1, "val/bpb": 1.2, "val/inner/n": 2}
    assert worker_mod.flatten_numbers({"nan": float("nan"), "inf": float("inf")}) == {}


def test_metrics_lines_step_and_time_keys() -> None:
    fmt = {"step_keys": ["global_step", "validation/global_step"], "timestamp_key": "time"}
    progress = {"time": 1_731_000_000.5, "type": "progress", "global_step": 40, "loss": 3.1}
    assert worker_mod.metrics_from_line(progress, fmt, 2, NOW) == [
        {"key": "loss", "value": 3.1, "step": 40, "timestamp": 1_731_000_000_500}
    ]
    validation = {
        "time": 1_731_000_100,
        "type": "validation",
        "validation": {"global_step": 40, "bpb": 1.21},
    }
    assert worker_mod.metrics_from_line(validation, fmt, 3, NOW) == [
        {"key": "validation/bpb", "value": 1.21, "step": 40, "timestamp": 1_731_000_100_000}
    ]
    assert worker_mod.metrics_from_line({"global_step": -1, "loss": 1}, fmt, 7, NOW)[0]["step"] == 7
    assert (
        worker_mod.metrics_from_line({"global_step": 1.5, "loss": 1}, fmt, 7, NOW)[0]["step"] == 7
    )
    assert worker_mod.metrics_from_line({"step": 1, "timestamp": 5}, {}, 1, NOW) == []
