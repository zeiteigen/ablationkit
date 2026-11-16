"""Run context and event writer (spec §4.1; ADR 0011).

The SDK never talks to the network or to MLflow. Under an AblationKit job it appends one JSON
event per line to the file named by ``ABLATIONKIT_EVENTS_FILE``; the attempt's collector tails
that file, spools the events durably and delivers them to the coordinator. Artifacts are staged
by copying them into ``ABLATIONKIT_ARTIFACT_DIR`` (never hard-linking: a job that rewrites the
file in place would change the staged bytes after they were checksummed).

Outside AblationKit every call is a no-op (with one warning), so instrumented code still runs.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import platform
import re
import shutil
import threading
import uuid
import warnings
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

__all__ = ["Run", "current", "init"]

SDK_VERSION = "0.1.0"
ENV_EVENTS = "ABLATIONKIT_EVENTS_FILE"
ENV_ARTIFACTS = "ABLATIONKIT_ARTIFACT_DIR"
ENV_PROJECT = "ABLATIONKIT_PROJECT_ID"
ENV_JOB = "ABLATIONKIT_JOB_ID"
ENV_ATTEMPT = "ABLATIONKIT_ATTEMPT_ID"

# Same key rule as MLflow (and the coordinator's validation): fail early, in the training script.
_KEY_RE = re.compile(r"^[A-Za-z0-9_\-. /]{1,250}$")
_RESERVED = ("ablationkit.", "mlflow.")
MAX_PARAM_VALUE = 6000
MAX_TAG_VALUE = 8000


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _fingerprint(path: Path) -> str:
    """SHA-256 over a file's bytes, or over a directory's sorted relative paths and bytes."""
    h = hashlib.sha256()
    if path.is_file():
        files = [(path.name, path)]
    elif path.is_dir():
        files = sorted(
            (p.relative_to(path).as_posix(), p)
            for p in path.rglob("*")
            if p.is_file() and not p.is_symlink()
        )
    else:
        raise FileNotFoundError(str(path))
    for rel, p in files:
        if path.is_dir():
            h.update(rel.encode() + b"\0")
        with p.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
    return h.hexdigest()


def _check_key(kind: str, key: str) -> str:
    if not isinstance(key, str) or not _KEY_RE.match(key):
        raise ValueError(
            f"invalid {kind} key {key!r}: use letters, digits, '_', '-', '.', ' ' and '/'"
        )
    return key


class Run:
    """One attempt's event stream. Thread-safe and fork-aware (a child gets its own producer)."""

    def __init__(
        self,
        events_file: str | None,
        artifact_dir: str | None,
        *,
        project_id: str | None = None,
        job_id: str | None = None,
        attempt_id: str | None = None,
    ) -> None:
        self.events_file = events_file
        self.artifact_dir = artifact_dir
        self.project_id = project_id
        self.job_id = job_id
        self.attempt_id = attempt_id
        self._lock = threading.Lock()
        self._fd: int | None = None
        self._pid = -1
        self._producer = ""
        self._seq = 0
        self._step = 0
        self._warned = False

    @property
    def enabled(self) -> bool:
        """True when events are recorded (running under AblationKit, or an explicit events file)."""
        return self.events_file is not None

    # ------------------------------------------------------------------ plumbing

    def _ensure_open(self) -> int:
        pid = os.getpid()
        if self._fd is None or pid != self._pid:
            # New process (first use, or after fork): a fresh producer with its own sequence.
            if self._fd is not None and pid != self._pid:
                self._fd = None
            assert self.events_file is not None
            self._fd = os.open(self.events_file, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            self._pid = pid
            self._producer = f"sdk-{pid}-{uuid.uuid4().hex[:8]}"
            self._seq = 0
        return self._fd

    def emit(self, type_: str, payload: Mapping[str, Any]) -> None:
        """Append one event. Never blocks on the network; raises only on local I/O errors."""
        if not self.enabled:
            if not self._warned:
                self._warned = True
                warnings.warn(
                    "ablationkit_sdk: not running under AblationKit (no ABLATIONKIT_EVENTS_FILE); "
                    "metrics, params and artifacts are not recorded",
                    RuntimeWarning,
                    stacklevel=3,
                )
            return
        with self._lock:
            fd = self._ensure_open()
            event = {
                "schema_version": 1,
                "event_id": uuid.uuid4().hex,
                "producer_id": self._producer,
                "producer_seq": self._seq,
                "ts": _iso(_now()),
                "type": type_,
                "payload": dict(payload),
            }
            if self.project_id:
                event["project_id"] = self.project_id
            line = (json.dumps(event, separators=(",", ":"), allow_nan=False) + "\n").encode()
            # One write() per line on an O_APPEND fd: lines from several processes never interleave.
            os.write(fd, line)
            self._seq += 1

    def close(self) -> None:
        with self._lock:
            if self._fd is not None and self._pid == os.getpid():
                os.close(self._fd)
            self._fd = None

    # ------------------------------------------------------------------ steps

    @property
    def step(self) -> int:
        """Default step for metrics logged without one."""
        return self._step

    def set_step(self, step: int) -> None:
        if not isinstance(step, int) or isinstance(step, bool):
            raise TypeError("step must be an int")
        self._step = step

    @contextmanager
    def epoch(self, n: int) -> Iterator[None]:
        """``with run.epoch(3): ...`` records ``epoch=3`` at the current step."""
        self.log_metric("epoch", n)
        yield

    # ------------------------------------------------------------------ tracking

    def log_metric(self, key: str, value: float, step: int | None = None) -> None:
        self.log_metrics({key: value}, step=step)

    def log_metrics(self, metrics: Mapping[str, float], step: int | None = None) -> None:
        """Log scalar metrics. NaN and infinite values are skipped with a warning."""
        s = self._step if step is None else step
        if not isinstance(s, int) or isinstance(s, bool):
            raise TypeError("step must be an int")
        ts = int(_now().timestamp() * 1000)
        items = []
        for k, v in metrics.items():
            _check_key("metric", k)
            f = float(v)
            if math.isnan(f) or math.isinf(f):
                warnings.warn(f"ablationkit_sdk: metric {k} is {f}; skipped", stacklevel=2)
                continue
            items.append({"key": k, "value": f, "step": s, "timestamp": ts})
        if items:
            self.emit("metric.batch", {"metrics": items})

    def log_param(self, key: str, value: Any) -> None:
        self.log_params({key: value})

    def log_params(self, params: Mapping[str, Any]) -> None:
        """Log parameters. MLflow params are immutable: log each key once per run."""
        out: dict[str, str] = {}
        for k, v in params.items():
            _check_key("param", k)
            s = v if isinstance(v, str) else json.dumps(v, default=str)
            if len(s) > MAX_PARAM_VALUE:
                raise ValueError(f"param {k}: value longer than {MAX_PARAM_VALUE} characters")
            out[k] = s
        if out:
            self.emit("param.batch", {"params": out})

    def set_tag(self, key: str, value: Any) -> None:
        self.set_tags({key: value})

    def set_tags(self, tags: Mapping[str, Any]) -> None:
        out: dict[str, str] = {}
        for k, v in tags.items():
            _check_key("tag", k)
            if k.startswith(_RESERVED):
                raise ValueError(f"tag {k} is reserved")
            s = str(v)
            if len(s) > MAX_TAG_VALUE:
                raise ValueError(f"tag {k}: value longer than {MAX_TAG_VALUE} characters")
            out[k] = s
        if out:
            self.emit("tag.batch", {"tags": out})

    # ------------------------------------------------------------------ artifacts

    def log_artifact(self, local_path: str | os.PathLike[str], artifact_path: str = "") -> None:
        """Stage a file (or a directory, recursively) for upload to the run's artifacts.

        The bytes are copied into the spool right away, so later changes to the file do not
        affect what is uploaded. (On copy-on-write filesystems the copy shares blocks.)
        """
        src = Path(local_path)
        dest_dir = artifact_path.strip("/")
        if any(p in ("..", ".") for p in dest_dir.split("/") if p):
            raise ValueError("artifact_path must stay inside the run")
        if src.is_dir():
            for f in sorted(p for p in src.rglob("*") if p.is_file() and not p.is_symlink()):
                rel = f.relative_to(src).parent.as_posix()
                sub = "/".join(x for x in (dest_dir, src.name, rel) if x and x != ".")
                self._stage(f, sub)
            return
        if not src.is_file():
            raise FileNotFoundError(str(src))
        self._stage(src, dest_dir)

    def log_text(self, text: str, artifact_file: str) -> None:
        """Write ``text`` to ``artifact_file`` (a path inside the run's artifacts)."""
        self._stage_bytes(text.encode("utf-8"), artifact_file)

    def log_dict(self, data: Mapping[str, Any], artifact_file: str) -> None:
        """Write ``data`` as JSON to ``artifact_file``."""
        self._stage_bytes(
            (json.dumps(data, indent=2, sort_keys=True, default=str) + "\n").encode(),
            artifact_file,
        )

    # ------------------------------------------------------------------ datasets and models

    def log_input(
        self,
        name: str,
        *,
        source: str,
        path: str | os.PathLike[str] | None = None,
        digest: str | None = None,
        context: str = "training",
        split: str | None = None,
        version: str | None = None,
        source_type: str = "local",
        schema: Mapping[str, Any] | None = None,
        profile: Mapping[str, Any] | None = None,
    ) -> str:
        """Record a dataset input of this run (an MLflow dataset input; spec §5.5).

        ``context`` is the input's role (``training``, ``validation``, ``evaluation``, …) and
        ``split`` its split. Pass ``path`` to fingerprint a local file or directory (SHA-256 of its
        bytes); otherwise pass ``digest``. Returns the digest MLflow stores (16 hex characters).
        """
        if not isinstance(name, str) or not name or len(name) > 500:
            raise ValueError("dataset name must be 1-500 characters")
        for label, v in (("context", context), ("split", split), ("version", version)):
            if v is not None and (not isinstance(v, str) or not _KEY_RE.match(v)):
                raise ValueError(f"invalid dataset {label} {v!r}")
        fingerprint: str | None = None
        if path is not None:
            fingerprint = _fingerprint(Path(path))
            digest = digest or fingerprint[:16]
        if not digest or not re.fullmatch(r"[A-Za-z0-9_.-]{1,36}", digest):
            raise ValueError("give a path to fingerprint, or a digest of 1-36 [A-Za-z0-9_.-]")
        payload: dict[str, Any] = {
            "name": name,
            "digest": digest,
            "source_type": source_type,
            "source": source,
            "context": context,
        }
        for k, v2 in (("split", split), ("version", version), ("fingerprint", fingerprint)):
            if v2 is not None:
                payload[k] = v2
        if schema is not None:
            payload["schema"] = json.dumps(dict(schema), sort_keys=True, default=str)
        if profile is not None:
            payload["profile"] = json.dumps(dict(profile), sort_keys=True, default=str)
        self.emit("dataset.input", payload)
        return digest

    def log_model(
        self,
        local_dir: str | os.PathLike[str],
        name: str,
        *,
        step: int | None = None,
        model_type: str | None = None,
    ) -> str | None:
        """Log an MLflow model directory (one saved with ``mlflow.<flavor>.save_model``).

        The files are staged like artifacts (under ``models/<key>/`` in the run); once they have
        uploaded, the coordinator creates an MLflow logged model with its own ID, flavors and
        signature, linked to this run. Returns the SDK key of the model, or None when disabled.
        """
        src = Path(local_dir)
        if not (src / "MLmodel").is_file():
            raise FileNotFoundError(
                f"{src}/MLmodel not found: save the model with mlflow.<flavor>.save_model first"
            )
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,200}", name):
            raise ValueError("model name: letters, digits, '_', '-', '.' (1-200)")
        if not self.enabled or self.artifact_dir is None:
            self.emit("model.logged", {})  # warns once when disabled
            return None
        key = uuid.uuid4().hex[:16]
        dest = f"models/{key}"
        files: list[dict[str, Any]] = []
        for f in sorted(p for p in src.rglob("*") if p.is_file() and not p.is_symlink()):
            rel = f.relative_to(src).as_posix()
            sub = "/".join(x for x in (dest, f.relative_to(src).parent.as_posix()) if x != ".")
            self._stage(f, sub)
            files.append({"path": rel, "size": f.stat().st_size})
        s = self._step if step is None else step
        payload: dict[str, Any] = {
            "model_key": key,
            "name": name,
            "artifact_path": dest,
            "files": files,
            "step": s,
        }
        if model_type:
            payload["model_type"] = model_type
        self.emit("model.logged", payload)
        return key

    def _stage_dir(self) -> tuple[str, Path]:
        assert self.artifact_dir is not None
        aid = uuid.uuid4().hex
        d = Path(self.artifact_dir) / aid
        d.mkdir(parents=True, mode=0o700)
        return aid, d

    def _stage(self, src: Path, dest_dir: str) -> None:
        if not self.enabled or self.artifact_dir is None:
            self.emit("artifact.logged", {})  # warns once when disabled
            return
        aid, d = self._stage_dir()
        target = d / src.name
        # A copy, not a hard link: a link shares the inode, so a later in-place write (open "w")
        # would change what was staged after it was checksummed (ADR 0011).
        shutil.copy2(src, target)
        dest = f"{dest_dir}/{src.name}" if dest_dir else src.name
        self.emit(
            "artifact.logged", {"artifact_id": aid, "file": f"{aid}/{src.name}", "path": dest}
        )

    def _stage_bytes(self, data: bytes, artifact_file: str) -> None:
        name = artifact_file.strip("/")
        if not name or any(p in ("..", ".", "") for p in name.split("/")):
            raise ValueError("artifact_file must be a relative path inside the run")
        if not self.enabled or self.artifact_dir is None:
            self.emit("artifact.logged", {})
            return
        aid, d = self._stage_dir()
        base = name.rsplit("/", 1)[-1]
        (d / base).write_bytes(data)
        self.emit("artifact.logged", {"artifact_id": aid, "file": f"{aid}/{base}", "path": name})


_current: Run | None = None
_current_lock = threading.Lock()


def init(events_file: str | None = None, artifact_dir: str | None = None) -> Run:
    """Return the process-wide run, creating it from the environment on first use.

    Pass ``events_file``/``artifact_dir`` to record outside AblationKit (file-adapter mode).
    """
    global _current
    with _current_lock:
        if _current is not None and events_file is None:
            return _current
        run = Run(
            events_file or os.environ.get(ENV_EVENTS),
            artifact_dir or os.environ.get(ENV_ARTIFACTS),
            project_id=os.environ.get(ENV_PROJECT),
            job_id=os.environ.get(ENV_JOB),
            attempt_id=os.environ.get(ENV_ATTEMPT),
        )
        if run.enabled:
            run.emit(
                "sdk.started",
                {"sdk_version": SDK_VERSION, "python": platform.python_version()},
            )
        _current = run
        return run


def current() -> Run:
    """The process-wide run (``init()`` on first use)."""
    return _current if _current is not None else init()
