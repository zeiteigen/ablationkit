"""Remote evaluation metrics and hashes (ablationkit_sdk.evaluate; ADR 0023 decision 21)."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from ablationkit_sdk.evaluate import (
    classifier_metrics,
    main,
    read_rows,
    regressor_metrics,
    tree_sha256,
)


def test_binary_classifier_metrics_use_label_one_as_positive() -> None:
    m = classifier_metrics([0, 0, 1, 1, 1], [0, 1, 1, 1, 0])
    assert m["accuracy_score"] == pytest.approx(0.6)
    assert m["precision_score"] == pytest.approx(2 / 3)
    assert m["recall_score"] == pytest.approx(2 / 3)
    assert m["f1_score"] == pytest.approx(2 / 3)
    assert m["example_count"] == 5


def test_multiclass_metrics_are_support_weighted() -> None:
    m = classifier_metrics(["a", "a", "b", "c"], ["a", "b", "b", "c"])
    assert m["accuracy_score"] == pytest.approx(0.75)
    # a: p=1 r=.5, b: p=.5 r=1, c: p=1 r=1; weights 2,1,1
    assert m["recall_score"] == pytest.approx((0.5 * 2 + 1 + 1) / 4)
    assert m["precision_score"] == pytest.approx((1 * 2 + 0.5 + 1) / 4)


def test_regressor_metrics() -> None:
    m = regressor_metrics([1.0, 2.0, 3.0], [1.0, 2.0, 5.0])
    assert m["mean_squared_error"] == pytest.approx(4 / 3)
    assert m["mean_absolute_error"] == pytest.approx(2 / 3)
    assert m["max_error"] == 2
    assert m["r2_score"] == pytest.approx(1 - 4 / 2)


def test_tree_hash_matches_the_coordinator_format(tmp_path: Path) -> None:
    (tmp_path / "d").mkdir()
    (tmp_path / "MLmodel").write_text("a")
    (tmp_path / "d" / "w.bin").write_bytes(b"b")

    def h(b: bytes) -> str:
        return hashlib.sha256(b).hexdigest()

    lines = f"{h(b'a')}  MLmodel\n{h(b'b')}  d/w.bin\n"
    assert tree_sha256(tmp_path) == h(lines.encode())


def test_csv_rows_parse_numbers(tmp_path: Path) -> None:
    p = tmp_path / "t.csv"
    p.write_text("x,y,name\n0.5,1,a\n")
    assert read_rows(p) == [{"x": 0.5, "y": 1, "name": "a"}]


def test_checksums_are_verified_before_anything_runs(tmp_path: Path) -> None:
    model = tmp_path / "model"
    model.mkdir()
    (model / "MLmodel").write_text("x")
    data = tmp_path / "t.csv"
    data.write_text("x,label\n1,1\n")
    args = [
        "--type",
        "classifier",
        "--data",
        str(data),
        "--targets",
        "label",
        "--model",
        str(model),
    ]
    with pytest.raises(SystemExit, match="model checksum mismatch"):
        main([*args, "--dataset-sha256", "0" * 64, "--model-sha256", "0" * 64])
    with pytest.raises(SystemExit, match="dataset checksum mismatch"):
        main([*args, "--dataset-sha256", "0" * 64, "--model-sha256", tree_sha256(model)])
