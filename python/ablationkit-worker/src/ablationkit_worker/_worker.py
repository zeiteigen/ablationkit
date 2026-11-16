"""Remote worker: run one staged attempt and reconcile it with the coordinator (spec §5.3, §5.7).

Layout of a worker directory (``<work_dir>/<attempt_id>/``)::

    bundle/                 the unpacked run bundle (bundle.json, source/, worker/, sdk/)
    credentials.json        launch + upload tokens, ntfy (0600; never in the bundle archive)
    state.json              worker_id, phase, cursors: what survives a worker restart
    spool/journal/          durable, ordered, bounded spool (spool-NNNN.jsonl)
    spool/cursor.json       highest spool seq the coordinator acknowledged
    spool/stdout.log, stderr.log, sdk-events.jsonl, artifacts/, uploads/, job.json, exit.json
    worker.lock, worker.log

The job runs under a separate shim (``_shim.py``), so it never depends on this process or on the
network. This process tails the job's output into the spool, delivers it at least once (the
coordinator dedupes), uploads artifacts resumably (large ones to an optional S3-compatible store
through presigned URLs, then a receipt), sends heartbeats through the handshake,
refreshes its short-lived upload token with the launch token, and posts ntfy notifications.
It never reruns a job: a job whose process vanished without an exit record is reported `lost`.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import math
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from ._common import (
    WORKER_PRODUCER,
    WORKER_VERSION,
    Journal,
    http,
    iso_now,
    read_json,
    read_json_or,
    sha256_file,
    write_json,
)

MAX_LINE_CHARS = 16_384
MAX_PARTIAL_BYTES = 1024 * 1024
MAX_BATCH_EVENTS = 500
MAX_BATCH_BYTES = 4 * 1024 * 1024
CHUNK_BYTES = 8 * 1024 * 1024
STATUS_EVERY_SEC = 300.0
ALWAYS_KEEP = {"attempt.started", "attempt.exited", "worker.status"}
EXIT_DRAINED = 0
EXIT_DEADLINE = 75
EXIT_QUARANTINED = 3
EXIT_BUSY = 4


_FINGERPRINT_BYTES = 4096


def _fingerprint(path: Path, offset: int) -> str:
    h = hashlib.sha256(str(offset).encode())
    if offset > 0:
        with path.open("rb") as fh:
            h.update(fh.read(min(offset, _FINGERPRINT_BYTES)))
            at = max(0, offset - _FINGERPRINT_BYTES)
            fh.seek(at)
            h.update(fh.read(offset - at))
    return h.hexdigest()


def metrics_cursor(path: Path, offset: int, st: os.stat_result | None = None) -> dict[str, Any]:
    """Where the metrics-file adapter stopped and which file it read (F43): device and inode,
    mtime, and a fingerprint of the bytes before the offset (first and last 4 KiB)."""
    st = st or path.stat()
    return {
        "offset": offset,
        "dev": st.st_dev,
        "ino": st.st_ino,
        "mtime_ns": st.st_mtime_ns,
        "fingerprint": _fingerprint(path, offset),
    }


def metrics_rewritten(path: Path, st: os.stat_result, cur: dict[str, Any]) -> bool:
    """Another inode, a size below the offset, or (once written again) changed bytes before the
    offset or no growth: an append only adds bytes after the offset. A rewrite that keeps the old
    bytes as its prefix and grows reads as an append."""
    offset = int(cur.get("offset", 0))
    if "ino" in cur and (st.st_ino != cur["ino"] or st.st_dev != cur["dev"]):
        return True
    if st.st_size < offset:
        return True
    if offset == 0 or "mtime_ns" not in cur or st.st_mtime_ns == cur["mtime_ns"]:
        return False
    if st.st_size == offset:
        return True
    return "fingerprint" in cur and _fingerprint(path, offset) != cur["fingerprint"]


class BundleError(Exception):
    pass


_METRICS_MAX_DEPTH = 8
_SECONDS_BELOW = 1e11  # below this a time is seconds: 1e11 ms is 1973, 1e11 s is 5138


def _number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def flatten_numbers(obj: dict[str, Any]) -> dict[str, float | int]:
    """Numeric leaves of `obj`, nested keys joined with `/` (ADR 0042)."""
    out: dict[str, float | int] = {}

    def walk(o: dict[str, Any], prefix: str, depth: int) -> None:
        for k, v in o.items():
            key = f"{prefix}/{k}" if prefix else str(k)
            if _number(v):
                out[key] = v
            elif isinstance(v, dict) and depth < _METRICS_MAX_DEPTH:
                walk(v, key, depth + 1)

    walk(obj, "", 1)
    return out


def metrics_from_line(
    obj: dict[str, Any], fmt: dict[str, Any] | None, line_no: int, now_ms: int
) -> list[dict[str, Any]]:
    """The metrics one metrics-file line yields, by the job's `metrics_format` (ADR 0042; the
    collector's `metrics-file.ts` applies the same rules)."""
    values = flatten_numbers(obj)
    step_keys = list((fmt or {}).get("step_keys") or ["step"])
    time_key = (fmt or {}).get("timestamp_key") or "timestamp"
    step = line_no
    for k in step_keys:
        v = values.get(k)
        if v is not None and float(v).is_integer() and v >= 0 and abs(v) <= 2**53 - 1:
            step = int(v)
            break
    t = values.get(time_key)
    ts = round(t * 1000 if t < _SECONDS_BELOW else t) if t is not None and t > 0 else now_ms
    skip = {*step_keys, time_key}
    return [
        {"key": k, "value": v, "step": step, "timestamp": ts}
        for k, v in values.items()
        if k not in skip
    ]


def verify_bundle(bundle: Path) -> dict[str, Any]:
    """Check every file of the bundle against its manifest (sizes and SHA-256)."""
    manifest: dict[str, Any] = read_json(bundle / "bundle.json")
    if manifest.get("schema_version") != 1:
        raise BundleError("unsupported bundle schema_version")
    root = bundle.resolve()
    for f in manifest["files"]:
        rel = f["path"]
        if rel.startswith("/") or ".." in rel.split("/"):
            raise BundleError(f"bundle path escapes the bundle: {rel}")
        p = bundle / rel
        if not p.resolve().is_relative_to(root) or p.is_symlink() or not p.is_file():
            raise BundleError(f"missing or unsafe bundle file: {rel}")
        if p.stat().st_size != f["size"] or sha256_file(p) != f["sha256"]:
            raise BundleError(f"bundle file changed: {rel}")
    return manifest


def _clean_line(raw: str) -> str:
    cr = raw.rfind("\r", 0, max(0, len(raw) - 1))
    s = raw[cr + 1 :] if cr >= 0 else raw
    return s[:-1] if s.endswith("\r") else s


def _proc_start(pid: int) -> str | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    return stat[stat.rfind(")") + 2 :].split()[19]


def _alive(pid: int | None, start: str | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    cur = _proc_start(pid)
    if cur is None:
        return start is None
    status = Path(f"/proc/{pid}/status").read_text() if Path(f"/proc/{pid}/status").exists() else ""
    if "State:\tZ" in status:
        return False
    return start is None or cur == start


class Worker:
    def __init__(
        self,
        root: Path,
        *,
        drain_only: bool = False,
        provider_job_id: str | None = None,
        log: Any = None,
    ) -> None:
        self.root = root
        self.bundle = root / "bundle"
        self.spool = root / "spool"
        self.drain_only = drain_only
        # An isolated runtime (an exported Colab notebook without credentials): spool everything,
        # never call the coordinator; results come back with `ablationkit remote import`.
        self.offline = os.environ.get("ABLATIONKIT_WORKER_OFFLINE") == "1"
        self.log = log or (
            lambda line: print(f"ablationkit-worker: {line}", file=sys.stderr, flush=True)
        )
        self.state_path = root / "state.json"
        self.creds_path = root / "credentials.json"
        self.state: dict[str, Any] = read_json_or(self.state_path, {})
        if provider_job_id:
            self.state["provider_job_id"] = provider_job_id
        self.buffer: list[dict[str, Any]] = []
        self.dropped = int(self.state.get("dropped", 0))
        self.backoff = 0.0
        self.retry_at = 0.0
        self.store_retry_at = 0.0
        self.next_handshake = 0.0
        self.creds_mtime = 0.0
        self.cancel_sent = False
        self.disk_pressure = False
        self.last_status = time.monotonic()

    # ------------------------------------------------------------------ setup

    def _save_state(self) -> None:
        self.state["dropped"] = self.dropped
        write_json(self.state_path, self.state)

    def _load_creds(self) -> dict[str, Any]:
        self.creds_mtime = self.creds_path.stat().st_mtime
        creds: dict[str, Any] = read_json(self.creds_path)
        return creds

    def run(self) -> int:
        self.root.mkdir(parents=True, exist_ok=True)
        lock = (self.root / "worker.lock").open("a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.log("another worker process is active for this attempt")
            return EXIT_BUSY
        try:
            return self._run()
        finally:
            lock.close()

    def _run(self) -> int:
        if not self.state.get("verified"):
            self.manifest = verify_bundle(self.bundle)
        else:
            self.manifest = read_json(self.bundle / "bundle.json")
        m = self.manifest
        self.creds = self._load_creds()
        self.base = (
            f"{m['worker_url'].rstrip('/')}/api/v1/jobs/{m['job_id']}/attempts/{m['attempt_id']}"
        )
        for d in ("journal", "artifacts", "uploads", "uploads/failed"):
            (self.spool / d).mkdir(parents=True, exist_ok=True, mode=0o700)
        if "worker_id" not in self.state:
            self.state.update(
                worker_id=f"w-{uuid.uuid4().hex[:16]}",
                hostname=socket.gethostname(),
                created_at=iso_now(),
                verified=True,
            )
        self.state["hostname"] = socket.gethostname()
        self.state["worker_pid"] = os.getpid()
        self._save_state()
        self.journal = Journal(
            self.spool / "journal",
            max_segment_bytes=max(64 * 1024, min(8 * 1024 * 1024, m["spool_max_bytes"] // 16)),
        )
        self.acked = int(read_json_or(self.spool / "cursor.json", {"acked_seq": -1})["acked_seq"])
        self._start_or_resume()
        deadline: float | None = None
        while True:
            self._tick()
            now = time.monotonic()
            exited = bool(self.state.get("exit_emitted"))
            if exited and deadline is None:
                limit = float(m["deliver_deadline_sec"])
                # SLURM: deliver briefly inside the allocation; the rest drains from the login node.
                override = os.environ.get("ABLATIONKIT_WORKER_DELIVER_DEADLINE_SEC")
                if override and override.isdigit() and not self.drain_only:
                    limit = min(limit, float(override))
                deadline = now + limit
            if self.state.get("quarantined") and exited:
                self.log(f"quarantined: {self.state['quarantined']}")
                return EXIT_QUARANTINED
            if exited and self._drained() and self._final_handshake():
                self._finish()
                return EXIT_DRAINED
            if deadline is not None and now >= deadline:
                self.log(f"delivery deadline passed; leaving the spool at {self.spool}")
                self._notify(
                    "sync pending",
                    "the job ended but its results are not delivered yet; "
                    "run `ablationkit remote drain` or import the spool",
                    once="deadline",
                )
                return EXIT_DEADLINE
            busy = self.buffer or (
                self.acked < self.journal.next_seq - 1 and time.monotonic() >= self.retry_at
            )
            time.sleep(0.05 if busy else 0.2)

    def _start_or_resume(self) -> None:
        phase = self.state.get("phase")
        exit_path = self.spool / "exit.json"
        if exit_path.exists():
            self.state.setdefault("phase", "exited")
            return
        if phase is None and not self.drain_only:
            self._start_shim()
            return
        alive = _alive(self.state.get("shim_pid"), self.state.get("shim_start"))
        if phase in ("running", "starting") and not self.drain_only and alive:
            self.log("resuming: the job is still running")
            return
        # The job's process is gone without an exit record (a reboot, a requeue, a drain after the
        # provider ended the job): never rerun it.
        why = (
            "the job never started on the worker"
            if phase is None
            else "the worker restarted and the job's process was gone without an exit record "
            "(a reboot, a requeue or a provider termination); it was not rerun"
        )
        write_json(
            exit_path,
            {
                "lost": True,
                "error": why,
                "timed_out": False,
                "oom_killed": False,
                "ended_at": iso_now(),
            },
        )
        self.state["phase"] = "lost"
        self._save_state()

    def _start_shim(self) -> None:
        log = (self.root / "worker.log").open("ab")
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(self.bundle / "worker"), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
        )
        proc = subprocess.Popen(
            [sys.executable, "-m", "ablationkit_worker", "exec", "--dir", str(self.root)],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        log.close()
        self.state.update(phase="starting", shim_pid=proc.pid, shim_start=_proc_start(proc.pid))
        self._save_state()
        # The shim is our child: reap it when it exits so it does not linger as a zombie.
        signal.signal(signal.SIGCHLD, lambda *_: _reap())

    # ------------------------------------------------------------------ loop

    def _tick(self) -> None:
        self._check_started()
        self._tail_output("stdout")
        self._tail_output("stderr")
        self._tail_sdk()
        self._tail_metrics()
        self._check_exit()
        self._flush()
        now = time.monotonic()
        if now - self.last_status >= STATUS_EVERY_SEC:
            self.last_status = now
            self._emit("worker.status", {"phase": self.state.get("phase"), **self._spool_report()})
        if self.creds_path.exists() and self.creds_path.stat().st_mtime != self.creds_mtime:
            self.creds = self._load_creds()  # re-authorized from the coordinator
            self.state.pop("credentials_failed", None)
            self.retry_at = 0.0
        # The store needs no coordinator: large artifacts leave the worker while it is offline.
        if not self.offline and not self.state.get("quarantined") and now >= self.store_retry_at:
            try:
                self._store_some()
            except OSError as e:
                self.store_retry_at = now + float(self.manifest["max_backoff_sec"])
                self.log(f"artifact store unreachable: {e}")
        if self.offline or self.state.get("credentials_failed") or self.state.get("quarantined"):
            return
        if now < self.retry_at:
            return
        try:
            if now >= self.next_handshake:
                self._handshake()
            for _ in range(4):
                if not self._deliver():
                    break
            self._upload_some()
            self.backoff = 0.0
        except OSError as e:
            self._fail(f"coordinator unreachable: {e}")

    def _fail(self, why: str) -> None:
        cap = float(self.manifest["max_backoff_sec"])
        self.backoff = min(cap, max(0.5, self.backoff * 2))
        self.retry_at = time.monotonic() + self.backoff
        if self.state.get("last_error") != why:
            self.state["last_error"] = why
            self.log(why)

    # ------------------------------------------------------------------ events

    def _emit(self, type_: str, payload: dict[str, Any], ts: str | None = None) -> None:
        m = self.manifest
        self.buffer.append(
            {
                "schema_version": 1,
                "event_id": str(uuid.uuid4()),
                "project_id": m["project_id"],
                "ablationkit_job_id": m["job_id"],
                "attempt_id": m["attempt_id"],
                "producer_id": WORKER_PRODUCER,
                "producer_seq": 0,
                "ts": ts or iso_now(),
                "type": type_,
                "payload": payload,
            }
        )
        if len(self.buffer) >= 1000:
            self._flush()

    def _spool_bytes(self) -> int:
        staged = 0
        for meta in (self.spool / "uploads").glob("*.json"):
            u = read_json_or(meta, {})
            if "store_slot" not in u:  # a stored artifact left the disk; only its receipt remains
                staged += int(u.get("size", 0))
        return self.journal.size() + staged

    def _check_disk(self) -> None:
        try:
            free = shutil.disk_usage(self.spool).free
        except OSError:
            return
        pressure = free < int(self.manifest["min_free_disk_bytes"])
        if pressure and not self.disk_pressure:
            self.log(f"disk pressure: {free} bytes free")
            self._notify(
                "disk pressure",
                f"{free} bytes free on the worker; noncritical events are dropped",
                once="disk",
            )
        self.disk_pressure = pressure
        self.disk_free = free

    def _flush(self) -> None:
        if not self.buffer:
            return
        self._check_disk()
        batch, self.buffer = self.buffer, []
        kept = []
        used = self._spool_bytes()
        cap = int(self.manifest["spool_max_bytes"])
        nxt = self.journal.next_seq
        for e in batch:
            size = len(json.dumps(e)) + 40
            if (used + size > cap or self.disk_pressure) and e["type"] not in ALWAYS_KEEP:
                self.dropped += 1
                continue
            used += size
            if e["producer_id"] == WORKER_PRODUCER:
                e = {**e, "producer_seq": nxt}
            kept.append(e)
            nxt += 1
        try:
            self.journal.append_batch(kept)
        except OSError as err:
            self.dropped += len(kept)
            self.log(f"spool append failed: {err}")

    def _check_started(self) -> None:
        if self.state.get("started_emitted"):
            return
        job = read_json_or(self.spool / "job.json", None)
        if job is None:
            return
        m = self.manifest
        self._emit(
            "attempt.started",
            {
                "pid": job["pid"],
                "mode": job["mode"],
                "enforcement": job["enforcement"],
                "reason": job["reason"],
                **({"unit": job["unit"]} if job.get("unit") else {}),
                "hostname": socket.gethostname(),
                "command": m["argv"],
                "cwd": m["cwd"],
                "collector_version": f"ablationkit-worker {WORKER_VERSION}",
                "worker_id": self.state["worker_id"],
                "source_commit": m["source_commit"],
                "source_dirty": False,
            },
            ts=job.get("started_at"),
        )
        self._flush()
        self.state.update(started_emitted=True, phase="running")
        self._save_state()

    def _check_exit(self) -> None:
        if self.state.get("exit_emitted"):
            return
        ex = read_json_or(self.spool / "exit.json", None)
        phase = self.state.get("phase")
        if (
            ex is None
            and phase in ("starting", "running")
            and not _alive(self.state.get("shim_pid"), self.state.get("shim_start"))
        ):
            time.sleep(0.2)  # the shim writes exit.json just before it exits
            ex = read_json_or(self.spool / "exit.json", None)
            if ex is None:
                ex = {
                    "lost": True,
                    "error": "the job shim stopped without recording how the job ended; "
                    "it was not rerun",
                    "timed_out": False,
                    "oom_killed": False,
                    "ended_at": iso_now(),
                }
                write_json(self.spool / "exit.json", ex)
        if ex is None:
            return
        # Everything the job wrote comes before its exit in the spool.
        self._tail_output("stdout", final=True)
        self._tail_output("stderr", final=True)
        self._tail_sdk()
        self._tail_metrics()
        if not ex.get("lost"):
            self._collect_globs()
        if ex.get("leftovers_killed"):
            self._emit(
                "console.line",
                {
                    "stream": "system",
                    "text": "the job left processes running after its main process exited; "
                    "they were killed",
                },
            )
        if ex.get("lost"):
            self._emit("console.line", {"stream": "system", "text": str(ex.get("error"))})
        ended = ex.pop("ended_at", None)
        self._emit("attempt.exited", ex, ts=ended)
        self._flush()
        self.state.update(exit_emitted=True, phase="lost" if ex.get("lost") else "exited")
        self._save_state()
        if ex.get("lost"):
            self._notify("job lost", str(ex.get("error")), once="lost")
        else:
            outcome = (
                "timed out"
                if ex.get("timed_out")
                else "was killed (out of memory)"
                if ex.get("oom_killed")
                else f"exited with {ex.get('exit_code', ex.get('signal'))}"
            )
            self._notify("job finished", f"{self.manifest['attempt_id']} {outcome}", once="exit")

    def _tail_output(self, stream: str, final: bool = False) -> None:
        path = self.spool / f"{stream}.log"
        if not path.exists():
            return
        key = f"{stream}_offset"
        offset = int(self.state.get(key, 0))
        while True:
            size = path.stat().st_size
            if size <= offset:
                return
            with path.open("rb") as fh:
                fh.seek(offset)
                data = fh.read(min(size - offset, 8 * 1024 * 1024))
            # The offset is the first byte not yet emitted: an unfinished last line stays in the
            # file and is read again with what follows it (also after a restart). It is emitted
            # as it is once the job ended, or once it outgrew MAX_PARTIAL_BYTES (progress bars
            # rewrite one line with carriage returns and may never end it).
            cut = data.rfind(b"\n") + 1
            if final or (cut == 0 and len(data) >= MAX_PARTIAL_BYTES):
                cut = len(data)
            if cut == 0:
                return
            lines = data[:cut].decode("utf-8", errors="replace").split("\n")
            if lines[-1] == "":
                lines.pop()
            for raw in lines:
                text = _clean_line(raw)
                while len(text) > MAX_LINE_CHARS:
                    self._emit("console.line", {"stream": stream, "text": text[:MAX_LINE_CHARS]})
                    text = text[MAX_LINE_CHARS:]
                self._emit("console.line", {"stream": stream, "text": text})
            self._flush()
            offset += cut
            self.state[key] = offset
            self._save_state()
            if not final:
                return

    def _tail_sdk(self) -> None:
        path = self.spool / "sdk-events.jsonl"
        if not path.exists():
            return
        offset = int(self.state.get("sdk_offset", 0))
        size = path.stat().st_size
        if size <= offset:
            return
        with path.open("rb") as fh:
            fh.seek(offset)
            data = fh.read(min(size - offset, 8 * 1024 * 1024))
        end = data.rfind(b"\n")
        if end < 0:
            return
        complete = data[: end + 1]
        m = self.manifest
        for line in complete.decode("utf-8", errors="replace").split("\n"):
            if not line.strip():
                continue
            try:
                v = json.loads(line)
                ev = {
                    "schema_version": 1,
                    "event_id": str(v["event_id"]),
                    "project_id": m["project_id"],
                    "ablationkit_job_id": m["job_id"],
                    "attempt_id": m["attempt_id"],
                    "producer_id": str(v["producer_id"]),
                    "producer_seq": int(v["producer_seq"]),
                    "ts": str(v["ts"]),
                    "type": str(v["type"]),
                    "payload": dict(v["payload"]),
                }
                if ev["producer_id"] in (WORKER_PRODUCER, "collector"):
                    raise ValueError("reserved producer")
            except (ValueError, KeyError, TypeError):
                self._emit(
                    "console.line", {"stream": "system", "text": "dropped a malformed SDK event"}
                )
                continue
            if ev["type"] == "artifact.logged" and not self._queue_sdk_artifact(ev):
                continue
            self.buffer.append(ev)
        self._flush()
        self.state["sdk_offset"] = offset + len(complete)
        self._save_state()

    def _tail_metrics(self) -> None:
        rel = self.manifest.get("metrics_file")
        if not rel:
            return
        path = self.bundle / "source" / rel
        if "metrics_offset" not in self.state:
            # Lines already in the file when the job starts belong to an earlier run.
            self.state["metrics_offset"] = path.stat().st_size if path.exists() else 0
            if path.exists():
                self.state["metrics_cursor"] = metrics_cursor(path, path.stat().st_size)
        if not path.exists():
            return
        offset = int(self.state["metrics_offset"])
        st = path.stat()
        size = st.st_size
        cur = self.state.get("metrics_cursor") or {"offset": offset}
        if metrics_rewritten(path, st, cur):
            # Rewritten since it was last read (F43): read it from the start.
            offset = 0
            self.state.update(
                metrics_offset=0, metrics_lines=0, metrics_cursor=metrics_cursor(path, 0, st)
            )
            self._emit(
                "console.line",
                {
                    "stream": "system",
                    "text": (
                        "metrics file: rewritten since it was last read; reading it from the start"
                    ),
                },
            )
            self._save_state()
        if size == offset:
            return
        with path.open("rb") as fh:
            fh.seek(offset)
            data = fh.read(min(size - offset, 8 * 1024 * 1024))
        end = data.rfind(b"\n")
        if end < 0:
            return
        complete = data[: end + 1]
        line_no = int(self.state.get("metrics_lines", 0))
        for line in complete.decode("utf-8", errors="replace").split("\n"):
            if not line.strip():
                continue
            line_no += 1
            try:
                obj = json.loads(line)
                if not isinstance(obj, dict):
                    raise ValueError
            except ValueError:
                self._emit(
                    "console.line",
                    {
                        "stream": "system",
                        "text": "metrics file: skipped a line that is not a JSON object",
                    },
                )
                continue
            metrics = metrics_from_line(
                obj, self.manifest.get("metrics_format"), line_no, int(time.time() * 1000)
            )
            if metrics:
                self._emit("metric.batch", {"metrics": metrics, "source": "metrics_file"})
        self._flush()
        self.state.update(
            metrics_offset=offset + len(complete),
            metrics_lines=line_no,
            metrics_cursor=metrics_cursor(path, offset + len(complete), st),
        )
        self._save_state()

    # ------------------------------------------------------------------ artifacts

    def _queue(self, artifact_id: str, staged: Path, dest: str) -> tuple[str, int] | None:
        size = staged.stat().st_size
        if self.disk_pressure or self._spool_bytes() + size > int(self.manifest["spool_max_bytes"]):
            shutil.rmtree(staged.parent, ignore_errors=True)
            self.dropped += 1
            self._emit(
                "console.line",
                {"stream": "system", "text": f"artifact {dest} not collected: spool full"},
            )
            return None
        sha = sha256_file(staged)
        write_json(
            self.spool / "uploads" / f"{artifact_id}.json",
            {
                "artifact_id": artifact_id,
                "file": str(staged.relative_to(self.spool)),
                "dest": dest,
                "sha256": sha,
                "size": size,
            },
        )
        return sha, size

    def _queue_sdk_artifact(self, ev: dict[str, Any]) -> bool:
        p = ev["payload"]
        aid, file, dest = (
            str(p.get("artifact_id", "")),
            str(p.get("file", "")),
            str(p.get("path", "")),
        )
        arts = (self.spool / "artifacts").resolve()
        abs_ = (arts / file).resolve()
        if (
            not aid.replace("-", "").isalnum()
            or len(aid) > 64
            or not abs_.is_relative_to(arts)
            or not dest
        ):
            self._emit(
                "console.line",
                {"stream": "system", "text": "dropped an artifact event with a bad path"},
            )
            return False
        if (self.spool / "uploads" / f"{aid}.json").exists() or not abs_.exists():
            return True  # replayed line
        q = self._queue(aid, abs_, dest)
        if q is None:
            return False
        ev["payload"] = {**p, "sha256": q[0], "size": q[1]}
        return True

    def _collect_globs(self) -> None:
        root = (self.bundle / "source").resolve()
        for pattern in self.manifest["artifact_paths"]:
            for p in sorted(root.glob(pattern)):
                if p.is_symlink() or not p.is_file() or not p.resolve().is_relative_to(root):
                    continue
                rel = p.relative_to(root).as_posix()
                aid = str(uuid.uuid4())
                d = self.spool / "artifacts" / aid
                d.mkdir(parents=True, mode=0o700)
                staged = d / p.name
                # A copy, not a hard link: a later in-place write would change the staged bytes
                # after they were checksummed (ADR 0011).
                shutil.copyfile(p, staged)
                q = self._queue(aid, staged, rel)
                if q:
                    self._emit(
                        "artifact.logged",
                        {
                            "artifact_id": aid,
                            "path": rel,
                            "sha256": q[0],
                            "size": q[1],
                            "source": "glob",
                        },
                    )

    # ------------------------------------------------------------------ network

    def _headers(self, token: str, extra: dict[str, str] | None = None) -> dict[str, str]:
        return {
            "authorization": f"Bearer {token}",
            "x-ablationkit-worker-id": str(self.state["worker_id"]),
            **(extra or {}),
        }

    def _spool_report(self) -> dict[str, Any]:
        pending = max(0, self.journal.next_seq - 1 - self.acked) + len(self.buffer)
        report = {
            "next_seq": self.journal.next_seq,
            "pending_events": pending,
            "pending_artifacts": len(list((self.spool / "uploads").glob("*.json"))),
            "bytes": self._spool_bytes(),
            "dropped_events": self.dropped,
            "disk_pressure": self.disk_pressure,
        }
        if hasattr(self, "disk_free"):
            report["disk_free_bytes"] = self.disk_free
        return report

    def _phase(self) -> str:
        if self.drain_only and not self.state.get("exit_emitted"):
            return "draining"
        return str(self.state.get("phase") or "starting")

    def _handshake(self, drained: bool = False, refresh: bool = False) -> bool:
        body = {
            "schema_version": 1,
            "worker_id": self.state["worker_id"],
            "hostname": socket.gethostname(),
            "worker_version": WORKER_VERSION,
            "bundle_id": self.manifest["bundle_id"],
            **(
                {"provider_job_id": self.state["provider_job_id"]}
                if self.state.get("provider_job_id")
                else {}
            ),
            "phase": self._phase(),
            "last_acked_seq": self.acked,
            "spool": self._spool_report(),
            "drained": drained,
            "refresh": refresh,
        }
        token = self.creds["launch_token"] if refresh else self.creds["upload_token"]
        res = http(
            "POST",
            f"{self.base}/handshake",
            body=json.dumps(body).encode(),
            headers=self._headers(token, {"content-type": "application/json"}),
        )
        if res.status == 401 and not refresh:
            return self._handshake(drained, refresh=True)
        if res.status == 401:
            why = (
                "the coordinator refused the launch token (expired or revoked); results stay "
                "in the spool until `ablationkit remote reauthorize` or `remote import`"
            )
            self.state["credentials_failed"] = why
            self._save_state()
            self.log(why)
            self._notify("credentials expired", why, once="credentials")
            return False
        if res.status == 409:
            err = res.json().get("error", {})
            self.state["quarantined"] = str(err.get("message", "duplicate execution"))
            self._save_state()
            self._notify("quarantined", self.state["quarantined"], once="quarantine")
            return False
        if res.status != 200:
            self._fail(f"handshake: HTTP {res.status} {res.body[:300]!r}")
            return False
        reply = res.json()
        if reply.get("upload_token"):
            self.creds = {
                **self.creds,
                "upload_token": reply["upload_token"],
                "upload_expires_at": reply.get(
                    "upload_expires_at", self.creds["upload_expires_at"]
                ),
            }
            write_json(self.creds_path, self.creds)
            self.creds_mtime = self.creds_path.stat().st_mtime
        theirs = int(reply.get("spool_acked_seq", -1))
        if theirs > self.acked:
            # Our acknowledgment was lost but the coordinator applied the events: skip them.
            self._set_acked(min(theirs, self.journal.next_seq - 1))
        elif theirs < self.acked and theirs + 1 >= self.journal.first_available():
            self.acked = theirs  # the coordinator is behind (restored); resend what we still have
        for a in reply.get("artifacts", []):
            self._drop_received(a["path"], a["sha256"])
        if reply.get("cancel_requested"):
            self._cancel()
        self.next_handshake = time.monotonic() + float(
            reply.get("heartbeat_sec", self.manifest["heartbeat_sec"])
        )
        self.state.pop("last_error", None)
        return True

    def _final_handshake(self) -> bool:
        if time.monotonic() < self.retry_at:
            return False
        try:
            return self._handshake(drained=True)
        except OSError as e:
            self._fail(f"coordinator unreachable: {e}")
            return False

    def _cancel(self) -> None:
        if self.cancel_sent or self.state.get("exit_emitted"):
            return
        job = read_json_or(self.spool / "job.json", None)
        shim = self.state.get("shim_pid")
        shim_alive = _alive(shim, self.state.get("shim_start"))
        if job is None and shim_alive:
            return  # still starting: the next heartbeat repeats the request
        self.cancel_sent = True
        if job is None:
            write_json(
                self.spool / "exit.json",
                {
                    "signal": "SIGTERM",
                    "cancelled": True,
                    "timed_out": False,
                    "oom_killed": False,
                    "error": "cancelled before the job started",
                    "ended_at": iso_now(),
                },
            )
            return
        self.log("cancel requested by the coordinator; stopping the job")
        if isinstance(shim, int) and shim > 0:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(shim, signal.SIGTERM)
        if job is not None:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(int(job["pid"]), signal.SIGTERM)

    def _set_acked(self, seq: int) -> None:
        self.acked = seq
        write_json(self.spool / "cursor.json", {"acked_seq": seq})
        self.journal.gc(seq)

    def _deliver(self) -> bool:
        if self.acked >= self.journal.next_seq - 1:
            return False
        events = self.journal.read_from(self.acked + 1, MAX_BATCH_EVENTS, MAX_BATCH_BYTES)
        if not events:
            return False
        last = events[-1]["seq"]
        body = json.dumps(
            {"events": [{k: v for k, v in e.items() if k != "seq"} for e in events]}
        ).encode()
        res = http(
            "POST",
            f"{self.base}/events:batch",
            body=body,
            headers=self._headers(
                self.creds["upload_token"],
                {"content-type": "application/json", "x-ablationkit-spool-through": str(last)},
            ),
        )
        if res.status == 401:
            self.next_handshake = 0.0
            self._handshake(refresh=True)
            return False
        if res.status == 409:
            err = res.json().get("error", {})
            self.state["quarantined"] = str(err.get("message", "duplicate execution"))
            self._save_state()
            return False
        if res.status != 200:
            self._fail(f"event delivery: HTTP {res.status} {res.body[:300]!r}")
            return False
        self._set_acked(last)
        return True

    def _drop_received(self, path: str, sha: str) -> None:
        for meta_path in (self.spool / "uploads").glob("*.json"):
            u = read_json_or(meta_path, None)
            if u and u["dest"] == path and u["sha256"] == sha:
                self._finish_upload(meta_path, u)

    def _finish_upload(self, meta_path: Path, u: dict[str, Any]) -> None:
        shutil.rmtree(self.spool / "artifacts" / str(u["artifact_id"]), ignore_errors=True)
        meta_path.unlink(missing_ok=True)

    def _upload_some(self) -> None:
        for meta_path in sorted((self.spool / "uploads").glob("*.json"))[:4]:
            u = read_json_or(meta_path, None)
            if u is None:
                continue
            if not self._upload_one(meta_path, u):
                return

    # ------------------------------------------------------------------ artifact store

    def _store_slot(self, n: int) -> dict[str, Any] | None:
        for s in (self.creds.get("artifact_store") or {}).get("slots", []):
            if s["slot"] == n and s["expires_at"] > iso_now():
                return dict(s)
        return None

    def _free_slot(self) -> int | None:
        used = set(self.state.get("store_used", []))
        for s in (self.creds.get("artifact_store") or {}).get("slots", []):
            if s["slot"] not in used and s["expires_at"] > iso_now():
                return int(s["slot"])
        return None

    def _wants_store(self, u: dict[str, Any]) -> bool:
        cfg = self.creds.get("artifact_store")
        if not cfg or "store_slot" in u or u.get("store_failed") or u.get("upload_id"):
            return False
        if "store_trying" in u:
            return True
        return int(u["size"]) >= int(cfg["min_bytes"]) and self._free_slot() is not None

    def _store_some(self) -> None:
        for meta_path in sorted((self.spool / "uploads").glob("*.json"))[:4]:
            u = read_json_or(meta_path, None)
            if u is None or not self._wants_store(u):
                continue
            staged = self.spool / u["file"]
            if not staged.exists():
                continue
            n = u.get("store_trying")
            if n is None:
                # Claim the slot before the PUT: a slot never holds two different files.
                n = self._free_slot()
                if n is None:
                    return
                self.state["store_used"] = [*self.state.get("store_used", []), n]
                self._save_state()
                u = {**u, "store_trying": n}
                write_json(meta_path, u)
            slot = self._store_slot(int(n))
            if slot is None:  # expired (a long disconnection): the coordinator path takes it
                write_json(meta_path, {**u, "store_failed": True})
                continue
            res = http(
                "PUT",
                slot["url"],
                body_file=staged,
                headers={"content-type": "application/octet-stream"},
                timeout=3600.0,
            )
            if res.status in (200, 201, 204):
                rest = {k: v for k, v in u.items() if k != "store_trying"}
                write_json(meta_path, {**rest, "store_slot": int(n)})
                # The store holds it now: free the worker's disk, keep the receipt.
                shutil.rmtree(self.spool / "artifacts" / str(u["artifact_id"]), ignore_errors=True)
            elif res.status >= 500 or res.status == 429:
                raise OSError(f"HTTP {res.status} from the store")
            else:
                self.log(
                    f"the artifact store refused {u['dest']} (HTTP {res.status}); "
                    "uploading it to the coordinator"
                )
                write_json(meta_path, {**u, "store_failed": True})

    def _store_receipt(self, meta_path: Path, u: dict[str, Any]) -> bool:
        res = http(
            "POST",
            f"{self.base}/uploads",
            body=json.dumps(
                {
                    "path": u["dest"],
                    "size": u["size"],
                    "sha256": u["sha256"],
                    "store_slot": u["store_slot"],
                }
            ).encode(),
            headers=self._headers(self.creds["upload_token"], {"content-type": "application/json"}),
            timeout=1800.0,
        )
        if not self._upload_ok(res, meta_path, u):
            return False
        self._finish_upload(meta_path, u)
        return True

    def _upload_one(self, meta_path: Path, u: dict[str, Any]) -> bool:
        if "store_slot" in u:
            return self._store_receipt(meta_path, u)
        if self._wants_store(u):
            return True  # `_store_some` puts it in the store first
        staged = self.spool / u["file"]
        if not staged.exists():
            self._finish_upload(meta_path, u)
            return True
        hdr = {"content-type": "application/json"}
        token = self.creds["upload_token"]
        if not u.get("upload_id"):
            res = http(
                "POST",
                f"{self.base}/uploads",
                body=json.dumps(
                    {"path": u["dest"], "size": u["size"], "sha256": u["sha256"]}
                ).encode(),
                headers=self._headers(token, hdr),
            )
            if not self._upload_ok(res, meta_path, u):
                return False
            r = res.json()
            if r.get("done"):
                self._finish_upload(meta_path, u)
                return True
            u = {**u, "upload_id": r["upload_id"], "received": int(r.get("received", 0))}
            write_json(meta_path, u)
        received = int(u.get("received", 0))
        with staged.open("rb") as fh:
            while received < u["size"]:
                fh.seek(received)
                chunk = fh.read(CHUNK_BYTES)
                res = http(
                    "PUT",
                    f"{self.base}/uploads/{u['upload_id']}",
                    body=chunk,
                    headers=self._headers(
                        token,
                        {
                            "content-type": "application/octet-stream",
                            "x-ablationkit-offset": str(received),
                        },
                    ),
                    timeout=300.0,
                )
                if res.status == 409:
                    received = int(res.json().get("received", received))
                    continue
                if not self._upload_ok(res, meta_path, u):
                    return False
                received = int(res.json()["received"])
                u = {**u, "received": received}
                write_json(meta_path, u)
        res = http(
            "POST",
            f"{self.base}/uploads/{u['upload_id']}/complete",
            body=b"{}",
            headers=self._headers(token, hdr),
        )
        if res.status == 404:
            # The coordinator lost the partial upload (restored, or expired): start over.
            write_json(
                meta_path, {k: v for k, v in u.items() if k not in ("upload_id", "received")}
            )
            return False
        if not self._upload_ok(res, meta_path, u):
            return False
        self._finish_upload(meta_path, u)
        return True

    def _upload_ok(self, res: Any, meta_path: Path, u: dict[str, Any]) -> bool:
        if res.status in (200, 201):
            return True
        if res.status == 401:
            self._handshake(refresh=True)
            return False
        if res.status in (429, 503) or res.status >= 500:
            self._fail(f"artifact {u['dest']}: HTTP {res.status} (will retry)")
            return False
        # Refused for good (bad path, too large, checksum mismatch): park it and say so.
        failed = self.spool / "uploads" / "failed" / meta_path.name
        os.replace(meta_path, failed)
        detail = res.body[:300].decode(errors="replace")
        msg = f"artifact {u['dest']} refused: HTTP {res.status} {detail}"
        self._emit("console.line", {"stream": "system", "text": msg})
        return False

    # ------------------------------------------------------------------ end

    def _drained(self) -> bool:
        return (
            not self.buffer
            and self.acked >= self.journal.next_seq - 1
            and not list((self.spool / "uploads").glob("*.json"))
        )

    def _finish(self) -> None:
        self.state["phase"] = "synced"
        self.state["synced_at"] = iso_now()
        self._save_state()
        if os.environ.get("ABLATIONKIT_KEEP_SPOOL"):
            return
        # Everything is delivered: drop the spool, the credentials and the source copy.
        shutil.rmtree(self.spool, ignore_errors=True)
        shutil.rmtree(self.bundle / "source", ignore_errors=True)
        self.creds_path.unlink(missing_ok=True)

    def _notify(self, title: str, message: str, once: str) -> None:
        sent = set(self.state.get("notified", []))
        ntfy = self.creds.get("ntfy") if hasattr(self, "creds") else None
        if once in sent or not ntfy:
            return
        headers = {
            "title": f"AblationKit {self.manifest['attempt_id']}: {title}",
            "tags": "ablationkit",
        }
        if ntfy.get("token"):
            headers["authorization"] = f"Bearer {ntfy['token']}"
        try:
            http("POST", ntfy["url"], body=message.encode(), headers=headers, timeout=10.0)
        except OSError as e:
            self.log(f"ntfy: {e}")
            return
        sent.add(once)
        self.state["notified"] = sorted(sent)
        self._save_state()


def cancel(root: Path) -> int:
    """Stop the job of the worker directory `root` (SIGTERM to the shim and the job's group)."""
    state = read_json_or(root / "state.json", {})
    job = read_json_or(root / "spool" / "job.json", None)
    sent = False
    shim = state.get("shim_pid")
    if isinstance(shim, int) and shim > 0 and _alive(shim, state.get("shim_start")):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(shim, signal.SIGTERM)
            sent = True
    if job is not None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(int(job["pid"]), signal.SIGTERM)
            sent = True
    print("stopping the job" if sent else "the job is not running")
    return 0


def _reap() -> None:
    with contextlib.suppress(ChildProcessError):
        while True:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                return
