"""Remote classical evaluation (criterion 9e; ADR 0023 decision 21).

Run by a remote evaluation job: ``python -m ablationkit_sdk.evaluate --type classifier --data
data/test.csv --targets label --dataset-sha256 H --model-sha256 M``. The pinned model is in the
bundle at ``$ABLATIONKIT_BUNDLE_INPUTS/model``; the dataset is the committed file in the bundle's
source. Both are verified against the hashes the coordinator recorded before anything is computed.

The model is loaded with ``mlflow.pyfunc`` (the worker's environment needs MLflow and the model's
dependencies); the metrics are computed here with the standard library and logged through the SDK,
so they travel in the worker's spool like any other job's metrics and reconcile once. The
coordinator checks the thresholds against the synced metrics. Metric names follow
``mlflow.models.evaluate`` (classifier: binary for two labels, weighted averages otherwise).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib
import json
import math
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import ablationkit_sdk as ak


def tree_sha256(root: Path) -> str:
    """SHA-256 of ``<file sha256>  <relative path>`` lines in path order (as the coordinator)."""
    lines = []
    for p in sorted(root.rglob("*"), key=lambda x: x.relative_to(root).as_posix()):
        if p.is_file() and not p.is_symlink():
            lines.append(f"{file_sha256(p)}  {p.relative_to(root).as_posix()}\n")
    return hashlib.sha256("".join(lines).encode()).hexdigest()


def file_sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _number(v: Any) -> Any:
    if isinstance(v, str):
        try:
            f = float(v)
        except ValueError:
            return v
        return int(f) if f.is_integer() and "." not in v and "e" not in v.lower() else f
    return v


def read_rows(path: Path) -> list[dict[str, Any]]:
    """CSV or JSON lines as a list of records (numbers parsed where they look like numbers)."""
    suffix = path.suffix.lower()
    if suffix in (".jsonl", ".ndjson"):
        with path.open(encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]
    if suffix == ".csv":
        with path.open(newline="", encoding="utf-8") as f:
            return [{k: _number(v) for k, v in r.items()} for r in csv.DictReader(f)]
    raise SystemExit(
        f"unsupported dataset format {suffix} (remote evaluation reads .csv and .jsonl)"
    )


def classifier_metrics(y: Sequence[Any], p: Sequence[Any]) -> dict[str, float]:
    n = len(y)
    labels = sorted({str(v) for v in y} | {str(v) for v in p})
    ys = [str(v) for v in y]
    ps = [str(v) for v in p]
    acc = sum(a == b for a, b in zip(ys, ps, strict=True)) / n

    def prf(label: str) -> tuple[float, float, float, int]:
        tp = sum(a == label and b == label for a, b in zip(ys, ps, strict=True))
        fp = sum(a != label and b == label for a, b in zip(ys, ps, strict=True))
        fn = sum(a == label and b != label for a, b in zip(ys, ps, strict=True))
        pr = tp / (tp + fp) if tp + fp else 0.0
        rc = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * pr * rc / (pr + rc) if pr + rc else 0.0
        return pr, rc, f1, tp + fn

    if len(labels) <= 2:
        pos = "1" if "1" in labels else labels[-1]
        pr, rc, f1, _ = prf(pos)
    else:
        parts = [prf(lab) for lab in labels]
        pr = sum(x[0] * x[3] for x in parts) / n
        rc = sum(x[1] * x[3] for x in parts) / n
        f1 = sum(x[2] * x[3] for x in parts) / n
    return {
        "example_count": float(n),
        "accuracy_score": acc,
        "precision_score": pr,
        "recall_score": rc,
        "f1_score": f1,
    }


def regressor_metrics(y: Sequence[Any], p: Sequence[Any]) -> dict[str, float]:
    yt = [float(v) for v in y]
    yp = [float(v) for v in p]
    n = len(yt)
    err = [b - a for a, b in zip(yt, yp, strict=True)]
    mse = sum(e * e for e in err) / n
    mean = sum(yt) / n
    ss_tot = sum((a - mean) ** 2 for a in yt)
    return {
        "example_count": float(n),
        "mean_squared_error": mse,
        "root_mean_squared_error": math.sqrt(mse),
        "mean_absolute_error": sum(abs(e) for e in err) / n,
        "max_error": max(abs(e) for e in err),
        "mean_on_target": mean,
        "r2_score": 1 - sum(e * e for e in err) / ss_tot if ss_tot else 0.0,
    }


def _flatten(pred: Any) -> list[Any]:
    """Model output as one value per row (a DataFrame/Series/array or a list)."""
    if hasattr(pred, "to_numpy"):
        pred = pred.to_numpy()
    if hasattr(pred, "tolist"):
        pred = pred.tolist()
    out = []
    for v in list(pred):
        if isinstance(v, list | tuple) and len(v) == 1:
            v = v[0]
        if hasattr(v, "item"):
            v = v.item()
        out.append(v)
    return out


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ablationkit_sdk.evaluate")
    ap.add_argument("--type", choices=["classifier", "regressor"], required=True)
    ap.add_argument("--data", required=True, help="dataset path relative to the source")
    ap.add_argument("--targets", required=True, help="label column")
    ap.add_argument("--dataset-sha256", required=True)
    ap.add_argument("--model-sha256", required=True)
    ap.add_argument("--model", help="model directory (default $ABLATIONKIT_BUNDLE_INPUTS/model)")
    a = ap.parse_args(argv)

    model_dir = Path(
        a.model or Path(os.environ.get("ABLATIONKIT_BUNDLE_INPUTS", "inputs")) / "model"
    )
    data = Path(a.data)
    if not model_dir.is_dir():
        raise SystemExit(f"no model at {model_dir}")
    if (got := tree_sha256(model_dir)) != a.model_sha256:
        raise SystemExit(f"model checksum mismatch: {got} is not {a.model_sha256}")
    if (got := file_sha256(data)) != a.dataset_sha256:
        raise SystemExit(f"dataset checksum mismatch: {got} is not {a.dataset_sha256}")
    try:
        pyfunc: Any = importlib.import_module("mlflow.pyfunc")
    except ImportError:
        raise SystemExit(
            "remote evaluation loads the model with mlflow.pyfunc: install mlflow (and the model's "
            "dependencies) in the target's environment"
        ) from None

    rows = read_rows(data)
    if not rows:
        raise SystemExit("the dataset is empty")
    if a.targets not in rows[0]:
        raise SystemExit(f"no column {a.targets} in the dataset")
    y = [r[a.targets] for r in rows]
    features: Any = [{k: v for k, v in r.items() if k != a.targets} for r in rows]
    try:
        pd: Any = importlib.import_module("pandas")
        features = pd.DataFrame(features)
    except ImportError:
        pass
    model = pyfunc.load_model(str(model_dir))
    pred = _flatten(model.predict(features))
    if len(pred) != len(y):
        raise SystemExit(f"the model returned {len(pred)} predictions for {len(y)} rows")
    metrics = classifier_metrics(y, pred) if a.type == "classifier" else regressor_metrics(y, pred)

    ak.log_params(
        {
            "model_type": a.type,
            "dataset": a.data,
            "targets": a.targets,
            "dataset_sha256": a.dataset_sha256,
            "model_sha256": a.model_sha256,
        }
    )
    ak.log_metrics(metrics)
    lines = ["row,target,prediction"] + [
        f"{i},{json.dumps(t)},{json.dumps(q)}" for i, (t, q) in enumerate(zip(y, pred, strict=True))
    ]
    ak.log_text("\n".join(lines) + "\n", "eval/predictions.csv")
    ak.log_dict({"metrics": metrics, "rows": len(y)}, "eval/summary.json")
    print(json.dumps({"metrics": metrics}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
