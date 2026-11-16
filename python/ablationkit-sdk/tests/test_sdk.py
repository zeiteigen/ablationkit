"""SDK event file contract: what the collector tails (ADR 0011)."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import pytest

from ablationkit_sdk import LoggingHandler, Run


def _events(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines()]


@pytest.fixture
def run(tmp_path: Path) -> Run:
    (tmp_path / "artifacts").mkdir()
    return Run(str(tmp_path / "events.jsonl"), str(tmp_path / "artifacts"))


def test_metrics_params_tags_are_envelopes_with_producer_sequence(run: Run, tmp_path: Path) -> None:
    run.log_metrics({"train/loss": 0.5, "acc": 1}, step=3)
    run.log_params({"lr": 0.001, "layers": [1, 2], "name": "base"})
    run.set_tags({"variant": "baseline"})
    ev = _events(tmp_path / "events.jsonl")
    assert [e["type"] for e in ev] == ["metric.batch", "param.batch", "tag.batch"]
    assert [e["producer_seq"] for e in ev] == [0, 1, 2]
    assert len({e["producer_id"] for e in ev}) == 1
    assert len({e["event_id"] for e in ev}) == 3
    m = ev[0]["payload"]["metrics"]
    assert [x["key"] for x in m] == ["train/loss", "acc"]
    assert all(x["step"] == 3 and isinstance(x["timestamp"], int) for x in m)
    assert ev[1]["payload"]["params"] == {"lr": "0.001", "layers": "[1, 2]", "name": "base"}
    assert ev[0]["ts"].endswith("Z")


def test_default_step_and_epoch_helper(run: Run, tmp_path: Path) -> None:
    run.set_step(7)
    with run.epoch(2):
        run.log_metric("loss", 1.0)
    ev = _events(tmp_path / "events.jsonl")
    assert [x["payload"]["metrics"][0]["key"] for x in ev] == ["epoch", "loss"]
    assert all(x["payload"]["metrics"][0]["step"] == 7 for x in ev)


def test_bad_keys_reserved_tags_and_nan(run: Run, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="invalid metric key"):
        run.log_metric("bad key!", 1.0)
    with pytest.raises(ValueError, match="reserved"):
        run.set_tag("mlflow.runName", "x")
    with pytest.warns(UserWarning, match="skipped"):
        run.log_metrics({"nan": float("nan"), "ok": 1.0})
    ev = _events(tmp_path / "events.jsonl")
    assert [x["key"] for x in ev[0]["payload"]["metrics"]] == ["ok"]


def test_artifacts_are_staged_copies(run: Run, tmp_path: Path) -> None:
    src = tmp_path / "model.pt"
    src.write_bytes(b"weights")
    run.log_artifact(src, "checkpoints")
    d = tmp_path / "outdir"
    (d / "sub").mkdir(parents=True)
    (d / "a.txt").write_text("a")
    (d / "sub" / "b.txt").write_text("b")
    run.log_artifact(d)
    run.log_dict({"x": 1}, "config/run.json")
    # An in-place rewrite (same inode, like open("w")) must not reach what was staged.
    src.write_bytes(b"changed")
    ev = [e["payload"] for e in _events(tmp_path / "events.jsonl")]
    assert [e["path"] for e in ev] == [
        "checkpoints/model.pt",
        "outdir/a.txt",
        "outdir/sub/b.txt",
        "config/run.json",
    ]
    for e in ev:
        staged = tmp_path / "artifacts" / e["file"]
        assert staged.is_file()
    assert json.loads((tmp_path / "artifacts" / ev[3]["file"]).read_text()) == {"x": 1}
    staged_model = tmp_path / "artifacts" / ev[0]["file"]
    assert staged_model.read_bytes() == b"weights"
    assert staged_model.stat().st_ino != src.stat().st_ino
    with pytest.raises(ValueError, match="inside the run"):
        run.log_artifact(src, "../escape")


def test_logging_handler_records_log_events(run: Run, tmp_path: Path) -> None:
    log = logging.getLogger("ak-test")
    log.setLevel(logging.INFO)
    h = LoggingHandler(run=run)
    log.addHandler(h)
    try:
        log.info("hello %s", "world")
        log.debug("not recorded")
    finally:
        log.removeHandler(h)
    ev = _events(tmp_path / "events.jsonl")
    assert len(ev) == 1
    assert ev[0]["type"] == "log.record"
    assert ev[0]["payload"] == {"level": "INFO", "logger": "ak-test", "message": "hello world"}


def test_disabled_outside_ablationkit_is_a_noop(tmp_path: Path) -> None:
    r = Run(None, None)
    assert not r.enabled
    with pytest.warns(RuntimeWarning, match="not running under AblationKit"):
        r.log_metric("loss", 1.0)
    r.log_metric("loss", 2.0)  # warns only once
    f = tmp_path / "x.txt"
    f.write_text("x")
    r.log_artifact(f)


def test_forked_child_gets_its_own_producer(run: Run, tmp_path: Path) -> None:
    run.log_metric("parent", 1.0)
    pid = os.fork()
    if pid == 0:  # pragma: no cover - child
        run.log_metric("child", 1.0)
        os._exit(0)
    os.waitpid(pid, 0)
    run.log_metric("parent", 2.0)
    ev = _events(tmp_path / "events.jsonl")
    by_key = {e["payload"]["metrics"][0]["key"] + str(e["producer_seq"]): e for e in ev}
    assert by_key["child0"]["producer_id"] != by_key["parent0"]["producer_id"]
    assert by_key["parent1"]["producer_id"] == by_key["parent0"]["producer_id"]


def test_log_input_fingerprints_files_and_records_role_split(run: Run, tmp_path: Path) -> None:
    data = tmp_path / "iris.csv"
    data.write_text("a,b\n1,2\n")
    digest = run.log_input(
        "iris", source="data/iris.csv", path=data, split="train", version="v1", profile={"n": 1}
    )
    import hashlib

    full = hashlib.sha256(b"a,b\n1,2\n").hexdigest()
    assert digest == full[:16]
    ev = _events(tmp_path / "events.jsonl")[-1]
    assert ev["type"] == "dataset.input"
    assert ev["payload"] == {
        "name": "iris",
        "digest": full[:16],
        "source_type": "local",
        "source": "data/iris.csv",
        "context": "training",
        "split": "train",
        "version": "v1",
        "fingerprint": full,
        "profile": '{"n": 1}',
    }
    with pytest.raises(ValueError, match="give a path to fingerprint"):
        run.log_input("x", source="s")  # neither path nor digest
    with pytest.raises(ValueError, match="invalid dataset split"):
        run.log_input("x", source="s", digest="ok", split="bad'quote")


def test_log_model_stages_the_directory_and_declares_its_files(run: Run, tmp_path: Path) -> None:
    d = tmp_path / "model"
    (d / "sub").mkdir(parents=True)
    (d / "MLmodel").write_text("flavors: {}\n")
    (d / "sub" / "w.bin").write_bytes(b"123")
    key = run.log_model(d, "clf", step=3)
    assert key is not None
    assert len(key) == 16
    ev = _events(tmp_path / "events.jsonl")
    staged = {e["payload"]["path"] for e in ev if e["type"] == "artifact.logged"}
    assert staged == {f"models/{key}/MLmodel", f"models/{key}/sub/w.bin"}
    model = ev[-1]
    assert model["type"] == "model.logged"
    assert model["payload"] == {
        "model_key": key,
        "name": "clf",
        "artifact_path": f"models/{key}",
        "files": [{"path": "MLmodel", "size": 12}, {"path": "sub/w.bin", "size": 3}],
        "step": 3,
    }
    with pytest.raises(FileNotFoundError):
        run.log_model(tmp_path, "nope")
