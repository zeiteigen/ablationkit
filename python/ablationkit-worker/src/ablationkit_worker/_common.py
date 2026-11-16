"""Small stdlib helpers shared by the worker and the job shim (ADR 0023)."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WORKER_VERSION = "0.1.0"
WORKER_PRODUCER = "worker"


def iso_now() -> str:
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def write_json(path: Path, value: Any, mode: int = 0o600) -> None:
    """Atomic replace: write a sibling temp file, fsync, rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(value, fh, separators=(",", ":"))
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def read_json_or(path: Path, default: Any) -> Any:
    try:
        return read_json(path)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Journal:
    """Append-only spool compatible with @ablationkit/core's JsonlLog (ADR 0007).

    Segments ``spool-NNNN.jsonl``; each line is one JSON object with an integer ``seq``, strictly
    increasing from 0. A torn final line (no newline) is dropped on open.
    """

    def __init__(self, directory: Path, name: str = "spool", max_segment_bytes: int = 1 << 20):
        self.dir = directory
        self.name = name
        self.max_segment_bytes = max_segment_bytes
        directory.mkdir(parents=True, exist_ok=True)
        self._re = re.compile(rf"^{re.escape(name)}-([0-9]{{4,}})\.jsonl$")
        segs = self.segments()
        self.index = segs[-1][0] if segs else 1
        self.next_seq = 0
        for _, p in reversed(segs):
            last = self._recover_tail(p)
            if last is not None:
                self.next_seq = last + 1
                break

    def segments(self) -> list[tuple[int, Path]]:
        out = []
        for p in self.dir.iterdir():
            m = self._re.match(p.name)
            if m:
                out.append((int(m.group(1)), p))
        return sorted(out)

    def _path(self) -> Path:
        return self.dir / f"{self.name}-{self.index:04d}.jsonl"

    @staticmethod
    def _recover_tail(path: Path) -> int | None:
        data = path.read_bytes()
        if data and not data.endswith(b"\n"):
            cut = data.rfind(b"\n") + 1
            with path.open("r+b") as fh:
                fh.truncate(cut)
            data = data[:cut]
        for line in reversed(data.splitlines()):
            try:
                seq = json.loads(line)["seq"]
                if isinstance(seq, int):
                    return seq
            except (ValueError, KeyError, TypeError):
                continue
        return None

    def append_batch(self, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not records:
            return []
        stored = []
        lines = []
        for i, r in enumerate(records):
            rec = {"seq": self.next_seq + i, **r}
            stored.append(rec)
            lines.append(json.dumps(rec, separators=(",", ":")))
        blob = ("\n".join(lines) + "\n").encode()
        path = self._path()
        size = path.stat().st_size if path.exists() else 0
        if size > 0 and size + len(blob) > self.max_segment_bytes:
            self.index += 1
            path = self._path()
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, blob)
            os.fsync(fd)
        finally:
            os.close(fd)
        self.next_seq += len(stored)
        return stored

    def read_from(self, seq: int, limit: int, max_bytes: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        size = 0
        for _, p in self.segments():
            with p.open("rb") as fh:
                for line in fh:
                    if not line.endswith(b"\n"):
                        break
                    rec = json.loads(line)
                    if rec["seq"] < seq:
                        continue
                    if out and (len(out) >= limit or size + len(line) > max_bytes):
                        return out
                    out.append(rec)
                    size += len(line)
        return out

    def gc(self, acked: int) -> int:
        """Delete segments whose records are all acknowledged (never the active one)."""
        freed = 0
        segs = self.segments()
        for i in range(len(segs) - 1):
            first_next = self._first_seq(segs[i + 1][1])
            if first_next is None or first_next - 1 > acked:
                break
            freed += segs[i][1].stat().st_size
            segs[i][1].unlink()
        return freed

    @staticmethod
    def _first_seq(path: Path) -> int | None:
        with path.open("rb") as fh:
            line = fh.readline()
        try:
            seq = json.loads(line)["seq"]
            return seq if isinstance(seq, int) else None
        except (ValueError, KeyError, TypeError):
            return None

    def first_available(self) -> int:
        segs = self.segments()
        if not segs:
            return self.next_seq
        first = self._first_seq(segs[0][1])
        return self.next_seq if first is None else first

    def size(self) -> int:
        return sum(p.stat().st_size for _, p in self.segments())


@dataclass
class Response:
    status: int
    body: bytes

    def json(self) -> Any:
        try:
            return json.loads(self.body or b"{}")
        except ValueError:
            return {}


def http(
    method: str,
    url: str,
    *,
    body: bytes | None = None,
    body_file: Path | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> Response:
    """One HTTP call. Network errors raise OSError; HTTP errors return their status.

    ``body_file`` streams a file as the body (a presigned PUT of a large artifact).
    """
    hdrs = dict(headers or {})
    if body_file is None:
        req = urllib.request.Request(url, data=body, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return Response(res.status, res.read())
        except urllib.error.HTTPError as e:
            return Response(e.code, e.read() or b"")
    hdrs["content-length"] = str(body_file.stat().st_size)
    with body_file.open("rb") as fh:
        req = urllib.request.Request(url, data=fh, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return Response(res.status, res.read())
        except urllib.error.HTTPError as e:
            return Response(e.code, e.read() or b"")
