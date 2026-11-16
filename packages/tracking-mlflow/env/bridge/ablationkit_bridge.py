"""AblationKit MLflow operations bridge (spec §4.1, §4.2, §5.5; ADR 0019).

Runs one Python-side MLflow operation that has no REST equivalent, in a short-lived, supervised
subprocess the coordinator starts (never inside the coordinator, never from a browser):

    python -I ablationkit_bridge.py REQUEST.json RESULT.json

The request names the operation and every input explicitly; the result is one JSON object with
``ok`` and either the operation's structured output or ``error``. Exit code 0 means a result was
written (even a failed evaluation), anything else means the bridge itself broke.

Operations:
  evaluate  classical ``mlflow.models.evaluate`` of a pinned logged model on a fixed dataset file,
            inside an MLflow run the coordinator already created, plus validation thresholds
            (``mlflow.validate_evaluation_results``) against an optional baseline model; with
            ``examples``, also per-example predictions and paired outcomes (batch evaluation).
  predict   one-shot ``pyfunc`` prediction of a pinned model through a task adapter, with
            load and predict times reported apart.
  serve     an interactive session: load once, then answer JSON-line requests on stdin.

Model artifacts are untrusted: loading a model can run code from its flavor's loader, which is why
this runs in its own resource-limited process with only the inputs named here.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

BRIDGE_VERSION = 1
MAX_ROWS_DEFAULT = 1_000_000


def _finite(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _decimal(v: float) -> str:
    return repr(float(v))


def _load_frame(data: dict[str, Any]) -> Any:
    import pandas as pd

    path = Path(data["path"])
    fmt = data.get("format") or path.suffix.lstrip(".").lower()
    max_rows = int(data.get("max_rows") or MAX_ROWS_DEFAULT)
    if fmt == "csv":
        df = pd.read_csv(path, nrows=max_rows + 1)
    elif fmt in ("parquet", "pq"):
        df = pd.read_parquet(path)
    elif fmt in ("jsonl", "ndjson"):
        df = pd.read_json(path, lines=True, nrows=max_rows + 1)
    else:
        raise ValueError(f"unsupported dataset format {fmt!r}: use csv, parquet or jsonl")
    if len(df) > max_rows:
        raise ValueError(f"dataset has more than {max_rows} rows")
    target = data["targets"]
    if target not in df.columns:
        cols = list(df.columns)[:20]
        raise ValueError(f"target column {target!r} is not in the dataset ({cols})")
    return df


def _evaluate_one(
    mlflow: Any, run_id: str, model_uri: str, ds: Any, model_type: str, config: dict[str, Any]
) -> Any:
    with mlflow.start_run(run_id=run_id):
        return mlflow.models.evaluate(
            model=model_uri,
            data=ds,
            model_type=model_type,
            evaluators=["default"],
            evaluator_config=config or None,
        )


def _examples(mlflow: Any, req: dict[str, Any], df: Any, model_type: str) -> dict[str, Any]:
    """Per-example predictions of the candidate (and baseline) on the same ordered rows.

    Logged to the candidate run as ``ablationkit/examples.json``: the summary, and the rows that
    failed or disagree first (bounded). The paired test is computed only where its method is
    standard (exact McNemar on the discordant pairs of a classifier comparison).
    """
    import mlflow.pyfunc

    target = req["data"]["targets"]
    x = df.drop(columns=[target])
    y = df[target].tolist()
    limit = int(req.get("max_examples") or 500)

    def preds(uri: str) -> list[Any]:
        return _jsonable(mlflow.pyfunc.load_model(uri).predict(x))

    cand = preds(req["model_uri"])
    base = preds(req["baseline_model_uri"]) if req.get("baseline_model_uri") else None
    rows: list[dict[str, Any]] = []
    summary: dict[str, Any] = {"rows": len(y), "paired": base is not None, "model_type": model_type}
    if model_type == "classifier":
        c_ok = [str(p) == str(t) for p, t in zip(cand, y, strict=True)]
        summary["candidate_correct"] = sum(c_ok)
        if base is not None:
            b_ok = [str(p) == str(t) for p, t in zip(base, y, strict=True)]
            only_c = sum(1 for a, b in zip(c_ok, b_ok, strict=True) if a and not b)
            only_b = sum(1 for a, b in zip(c_ok, b_ok, strict=True) if b and not a)
            summary.update(
                baseline_correct=sum(b_ok),
                both_correct=sum(1 for a, b in zip(c_ok, b_ok, strict=True) if a and b),
                only_candidate_correct=only_c,
                only_baseline_correct=only_b,
                both_wrong=sum(1 for a, b in zip(c_ok, b_ok, strict=True) if not a and not b),
                disagreements=sum(1 for a, b in zip(cand, base, strict=True) if str(a) != str(b)),
            )
            if only_c + only_b:
                from scipy.stats import binomtest

                p = binomtest(only_c, only_c + only_b, 0.5).pvalue
                summary["paired_test"] = {
                    "method": "exact McNemar (two-sided binomial test on discordant pairs)",
                    "assumptions": "paired predictions on the same ordered rows; rows independent",
                    "discordant": only_c + only_b,
                    "p_value": _decimal(p),
                }
            else:
                summary["paired_test_note"] = "no discordant pairs: no paired test computed"
        for i, (p, t) in enumerate(zip(cand, y, strict=True)):
            b = base[i] if base is not None else None
            if not c_ok[i] or (base is not None and str(b) != str(p)):
                rows.append({"row": i, "target": t, "candidate": p, "baseline": b})
    else:
        c_err = [abs(float(p) - float(t)) for p, t in zip(cand, y, strict=True)]
        summary["candidate_mae"] = _decimal(sum(c_err) / max(len(c_err), 1))
        b_err = None
        if base is not None:
            b_err = [abs(float(p) - float(t)) for p, t in zip(base, y, strict=True)]
            summary["baseline_mae"] = _decimal(sum(b_err) / max(len(b_err), 1))
            summary["candidate_better_rows"] = sum(
                1 for a, b in zip(c_err, b_err, strict=True) if a < b
            )
            summary["paired_test_note"] = "no significance test is computed for regression"
        order = sorted(range(len(y)), key=lambda i: -c_err[i])
        for i in order:
            rows.append(
                {
                    "row": i,
                    "target": y[i],
                    "candidate": cand[i],
                    "baseline": base[i] if base is not None else None,
                    "candidate_abs_error": round(c_err[i], 6),
                    **({"baseline_abs_error": round(b_err[i], 6)} if b_err else {}),
                }
            )
    summary["listed"] = min(len(rows), limit)
    doc = {"summary": summary, "rows": json.loads(json.dumps(rows[:limit], default=str))}
    with mlflow.start_run(run_id=req["run_id"]):
        mlflow.log_dict(doc, "ablationkit/examples.json")
    return summary


def evaluate(req: dict[str, Any]) -> dict[str, Any]:
    import mlflow
    from mlflow.models import MetricThreshold
    from mlflow.models.evaluation.validation import ModelValidationFailedException

    data = req["data"]
    df = _load_frame(data)
    ds = mlflow.data.from_pandas(
        df, source=data.get("source") or data["path"], name=data["name"], targets=data["targets"]
    )
    model_type = req["model_type"]
    if model_type not in ("classifier", "regressor"):
        raise ValueError("model_type must be classifier or regressor")
    config = req.get("evaluator_config") or {}
    t0 = time.monotonic()
    cand = _evaluate_one(mlflow, req["run_id"], req["model_uri"], ds, model_type, config)
    base = None
    if req.get("baseline_model_uri"):
        base = _evaluate_one(
            mlflow, req["baseline_run_id"], req["baseline_model_uri"], ds, model_type, config
        )
    elapsed = time.monotonic() - t0

    thresholds: dict[str, Any] = {}
    for t in req.get("thresholds") or []:

        def num(key: str, t: dict[str, Any] = t) -> float | None:
            return float(t[key]) if t.get(key) is not None else None

        thresholds[t["metric"]] = MetricThreshold(
            threshold=num("threshold"),
            min_absolute_change=num("min_absolute_change"),
            min_relative_change=num("min_relative_change"),
            greater_is_better=bool(t["greater_is_better"]),
        )

    validation = None
    if thresholds:
        # One threshold at a time, through MLflow's own validator, for per-metric outcomes; then
        # all of them together for MLflow's overall verdict. The two must agree.
        outcomes = []
        for name, th in thresholds.items():
            failures: list[str] = []
            try:
                mlflow.validate_evaluation_results({name: th}, cand, base)
            except ModelValidationFailedException as e:
                failures = [ln.strip() for ln in str(e).splitlines() if ln.strip()][:8]
            outcome: dict[str, Any] = {"metric": name, "passed": not failures, "failures": failures}
            cv = _finite(cand.metrics.get(name))
            if cv is not None:
                outcome["candidate"] = _decimal(cv)
            if base is not None:
                bv = _finite(base.metrics.get(name))
                if bv is not None:
                    outcome["baseline"] = _decimal(bv)
            outcomes.append(outcome)
        try:
            mlflow.validate_evaluation_results(thresholds, cand, base)
            verdict = "passed"
        except ModelValidationFailedException:
            verdict = "failed"
        passed = all(o["passed"] for o in outcomes)
        if (verdict == "passed") != passed:
            raise RuntimeError("per-metric validation disagrees with MLflow's overall verdict")
        validation = {"passed": passed, "outcomes": outcomes, "mlflow_verdict": verdict}
        with mlflow.start_run(run_id=req["run_id"]):
            mlflow.log_dict(validation, "ablationkit/validation.json")

    def metrics(res: Any) -> dict[str, float]:
        return {k: f for k, v in res.metrics.items() if (f := _finite(v)) is not None}

    examples = None
    if req.get("examples"):
        examples = _examples(mlflow, req, df, model_type)

    return {
        "examples": examples,
        "ok": True,
        "metrics": metrics(cand),
        "baseline_metrics": metrics(base) if base is not None else None,
        "artifacts": sorted(cand.artifacts.keys()),
        "validation": validation,
        "rows": len(df),
        "elapsed_sec": round(elapsed, 3),
        "mlflow_version": mlflow.__version__,
    }


# ----------------------------------------------------------------------------------- inference
#
# The coordinator picks a task adapter from the model's MLmodel (signature plus optional
# ``metadata.ablationkit``) and validates the payload before it starts a worker; it sends the
# adapter here so both sides read the inputs the same way. MLflow's own pyfunc schema enforcement
# runs as well, on every prediction.

MAX_OUTPUT_BYTES_DEFAULT = 1_000_000
MAX_IMAGE_BYTES = 8 * 1024 * 1024
TOP_K = 5
_DTYPES = {
    "double": "float64",
    "float": "float32",
    "long": "int64",
    "integer": "int32",
    "boolean": "bool",
}


class InputError(ValueError):
    """The payload does not fit the adapter (reported as ``kind: input``)."""


def _ms(t0: float) -> float:
    return round((time.monotonic() - t0) * 1000, 3)


def _decode_image(item: dict[str, Any], spec: dict[str, Any]) -> Any:
    import base64
    import io

    import numpy as np
    from PIL import Image

    raw = base64.b64decode(item.get("data_base64") or "", validate=True)
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise InputError("each image must be 1 byte to 8 MiB")
    with Image.open(io.BytesIO(raw)) as im:
        im = im.convert(spec.get("mode") or "L")
        im = im.resize((int(spec["width"]), int(spec["height"])), Image.Resampling.LANCZOS)
        arr = np.asarray(im, dtype="float64") / 255.0
    if spec.get("invert"):
        arr = 1.0 - arr
    lo, hi = spec.get("value_range") or [0.0, 1.0]
    return arr * (float(hi) - float(lo)) + float(lo)


def _frame(adapter: dict[str, Any], req: dict[str, Any]) -> tuple[Any, list[Any] | None]:
    """The model input (DataFrame or ndarray) and the target column, if the data has one."""
    import numpy as np
    import pandas as pd

    columns = adapter.get("columns") or []
    names = [c["name"] for c in columns]
    targets: list[Any] | None = None
    inputs = req.get("inputs") or {}
    if req.get("data"):
        data = req["data"]
        path = Path(data["path"])
        fmt = data.get("format") or path.suffix.lstrip(".").lower()
        offset, limit = int(data.get("offset") or 0), int(data["limit"])
        if fmt == "csv":
            df = pd.read_csv(path, skiprows=range(1, offset + 1), nrows=limit)
        elif fmt in ("jsonl", "ndjson"):
            df = pd.read_json(path, lines=True).iloc[offset : offset + limit]
        elif fmt in ("parquet", "pq"):
            df = pd.read_parquet(path).iloc[offset : offset + limit]
        else:
            raise InputError(f"unsupported dataset format {fmt!r}: use csv, parquet or jsonl")
        df = df.reset_index(drop=True)
        tcol = data.get("targets")
        if tcol:
            if tcol not in df.columns:
                raise InputError(f"target column {tcol!r} is not in the dataset")
            targets = [None if pd.isna(v) else v for v in df[tcol].tolist()]
        missing = [c["name"] for c in columns if c.get("required", True) and c["name"] not in df]
        if missing:
            raise InputError(f"the dataset lacks the model's input columns {missing[:20]}")
        df = df[[n for n in names if n in df.columns]]
    elif adapter["task"] == "image" and inputs.get("images") is not None:
        spec = adapter["image"]
        arrays = [_decode_image(i, spec) for i in inputs["images"]]
        if spec.get("layout", "columns") == "tensor":
            return np.stack(arrays).astype(spec.get("dtype") or "float32"), None
        flat = [a.reshape(-1) for a in arrays]
        if flat and len(flat[0]) != len(names):
            raise InputError(f"the image gives {len(flat[0])} values; the model takes {len(names)}")
        df = pd.DataFrame(flat, columns=names)
    else:
        records = inputs.get("records")
        if not isinstance(records, list) or not records:
            raise InputError("inputs.records must be a non-empty list of objects")
        df = pd.DataFrame.from_records(records, columns=names)
    for c in columns:
        dt = _DTYPES.get(c["type"])
        if dt and c["name"] in df and not df[c["name"]].isna().any():
            try:
                df[c["name"]] = df[c["name"]].astype(dt)
            except (TypeError, ValueError) as e:
                raise InputError(f"column {c['name']!r} is not {c['type']}: {e}") from e
    return df, targets


def _jsonable(out: Any) -> list[Any]:
    import numpy as np
    import pandas as pd

    if isinstance(out, pd.DataFrame):
        if out.shape[1] == 1:
            out = out.iloc[:, 0]
        else:
            return json.loads(out.to_json(orient="records"))
    if isinstance(out, pd.Series):
        return json.loads(out.to_json(orient="values"))
    if isinstance(out, np.ndarray):
        return json.loads(pd.Series(list(out)).to_json(orient="values"))
    if isinstance(out, list):
        return json.loads(json.dumps(out, default=str))
    return [json.loads(json.dumps(out, default=str))]


def _probabilities(pm: Any, x: Any) -> tuple[list[Any] | None, str | None]:
    """Top-k class probabilities from the flavor's own model, when it exposes predict_proba."""
    try:
        raw = pm.get_raw_model()
    except Exception:
        return None, "the flavor does not expose its model"
    if not hasattr(raw, "predict_proba") or not hasattr(raw, "classes_"):
        return None, "the model has no predict_proba"
    try:
        proba = raw.predict_proba(x)
    except Exception as e:
        return None, f"predict_proba failed: {type(e).__name__}"
    classes = [c.item() if hasattr(c, "item") else c for c in raw.classes_]
    rows = []
    for p in proba:
        order = sorted(range(len(classes)), key=lambda i: -p[i])[:TOP_K]
        rows.append([{"label": classes[i], "p": round(float(p[i]), 6)} for i in order])
    return rows, None


def _load(model_uri: str) -> tuple[Any, float, float]:
    """The loaded model, the time to import MLflow, and the time to download and load the model."""
    t0 = time.monotonic()
    import mlflow.pyfunc

    import_ms = _ms(t0)
    t1 = time.monotonic()
    pm = mlflow.pyfunc.load_model(model_uri)
    return pm, import_ms, _ms(t1)


def _predict_with(pm: Any, adapter: dict[str, Any], req: dict[str, Any]) -> dict[str, Any]:
    from mlflow.exceptions import MlflowException

    x, targets = _frame(adapter, req)
    t0 = time.monotonic()
    try:
        out = pm.predict(x, params=req.get("params") or None)
    except MlflowException as e:
        msg = str(e)
        kind = "schema" if "schema" in msg.lower() else "predict"
        return {"ok": False, "kind": kind, "error": msg[:4000]}
    predict_ms = _ms(t0)
    outputs = _jsonable(out)
    result: dict[str, Any] = {"ok": True, "outputs": outputs, "rows": len(outputs)}
    if targets is not None:
        result["targets"] = json.loads(json.dumps(targets, default=str))
    if req.get("return_inputs") and hasattr(x, "to_json"):
        result["inputs"] = json.loads(x.to_json(orient="records"))
    if adapter.get("output") == "classification" and req.get("probabilities", True):
        t1 = time.monotonic()
        proba, note = _probabilities(pm, x)
        if proba is not None:
            result["probabilities"] = proba
        else:
            result["probabilities_note"] = note
        result["postprocess_ms"] = _ms(t1)
    result["predict_ms"] = predict_ms
    limit = int(req.get("max_output_bytes") or MAX_OUTPUT_BYTES_DEFAULT)
    if len(json.dumps(result, allow_nan=False)) > limit:
        return {"ok": False, "kind": "output_too_large", "error": f"output exceeds {limit} bytes"}
    return result


def _guarded(fn: Any, *args: Any) -> dict[str, Any]:
    try:
        return fn(*args)
    except InputError as e:
        return {"ok": False, "kind": "input", "error": str(e)[:4000]}
    except Exception as e:
        traceback.print_exc()
        return {"ok": False, "kind": "predict", "error": f"{type(e).__name__}: {e}"[:4000]}


def _env() -> dict[str, Any]:
    import platform

    import mlflow

    return {"mlflow_version": mlflow.__version__, "python_version": platform.python_version()}


def predict(req: dict[str, Any]) -> dict[str, Any]:
    """One-shot: load the pinned model, predict once, report load and predict times apart."""
    try:
        pm, import_ms, load_ms = _load(req["model_uri"])
    except Exception as e:
        traceback.print_exc()
        return {"ok": False, "kind": "load", "error": f"{type(e).__name__}: {e}"[:4000]}
    res = _guarded(_predict_with, pm, req["adapter"], req)
    res["load_ms"] = load_ms
    res["import_ms"] = import_ms
    res.update(_env())
    return res


def _memory() -> dict[str, Any]:
    import resource

    out: dict[str, Any] = {
        "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
    }
    try:
        pages = int(Path("/proc/self/statm").read_text().split()[1])
        out["rss_bytes"] = pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        pass
    torch = sys.modules.get("torch")
    if torch is not None and getattr(torch, "cuda", None) and torch.cuda.is_available():
        out["gpu_allocated_bytes"] = int(torch.cuda.memory_allocated())
    return out


def serve(req: dict[str, Any]) -> dict[str, Any]:
    """Interactive session: load once, then answer JSON lines on stdin until it closes.

    The protocol uses the process's original stdout; anything the model prints goes to stderr
    (the session log) so it cannot corrupt a response. Requests are answered one at a time.
    """
    proto = os.fdopen(os.dup(1), "w", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def emit(msg: dict[str, Any]) -> None:
        proto.write(json.dumps(msg, allow_nan=False) + "\n")

    try:
        pm, import_ms, load_ms = _load(req["model_uri"])
    except Exception as e:
        traceback.print_exc()
        err = f"{type(e).__name__}: {e}"[:4000]
        emit({"event": "load_failed", "error": err})
        return {"ok": False, "kind": "load", "error": err}
    emit(
        {
            "event": "ready",
            "load_ms": load_ms,
            "import_ms": import_ms,
            "pid": os.getpid(),
            **_env(),
            **_memory(),
        }
    )
    served = 0
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            emit({"id": None, "ok": False, "kind": "bridge", "error": "not JSON"})
            continue
        rid = msg.get("id")
        if msg.get("op") == "health":
            emit({"id": rid, "ok": True, "served": served, **_memory()})
        elif msg.get("op") == "predict":
            res = _guarded(_predict_with, pm, req["adapter"], msg)
            served += 1
            emit({"id": rid, **res})
        else:
            emit({"id": rid, "ok": False, "kind": "bridge", "error": "unknown op"})
    return {"ok": True, "served": served}


OPS = {"evaluate": evaluate, "predict": predict, "serve": serve}


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: ablationkit_bridge.py REQUEST.json RESULT.json", file=sys.stderr)
        return 2
    req = json.loads(Path(argv[1]).read_text())
    out = Path(argv[2])
    if req.get("bridge_version") != BRIDGE_VERSION:
        result: dict[str, Any] = {"ok": False, "error": "bridge version mismatch", "kind": "bridge"}
    elif req.get("op") not in OPS:
        result = {"ok": False, "error": f"unknown op {req.get('op')!r}", "kind": "bridge"}
    else:
        os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")
        os.environ["MLFLOW_DISABLE_TELEMETRY"] = "true"
        os.environ["DO_NOT_TRACK"] = "true"
        try:
            result = OPS[req["op"]](req)
        except Exception as e:  # every failure becomes a structured result
            traceback.print_exc()
            result = {"ok": False, "error": f"{type(e).__name__}: {e}"[:4000], "kind": "operation"}
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(result, allow_nan=False))
    tmp.replace(out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
