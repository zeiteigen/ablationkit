"""Builtin LLM research evaluation worker (ADR 0021).

Runs only ``genai_evaluate`` under the managed MLflow Python environment::

    python -I genai.py REQUEST.json RESULT.json

The host selects this approved builtin script; the request cannot select Python code. This
standalone worker keeps the request/result protocol of the generic operations bridge without
importing coordinator code or depending on PYTHONPATH in isolated Python mode.
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


def _finite(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _env() -> dict[str, Any]:
    import platform

    import mlflow

    return {"mlflow_version": mlflow.__version__, "python_version": platform.python_version()}


# ---------------------------------------------------------------- GenAI evaluation (ADR 0021)

_VAR_RE = None


def _render(template: Any, inputs: dict[str, Any]) -> list[dict[str, str]]:
    """Fill ``{{var}}`` placeholders; a text template becomes one user message."""
    import re

    global _VAR_RE
    if _VAR_RE is None:
        _VAR_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}")

    def fill(s: str) -> str:
        def one(m: Any) -> str:
            v = inputs.get(m.group(1))
            if v is None:
                return ""
            return v if isinstance(v, str) else json.dumps(v)

        return _VAR_RE.sub(one, s)  # type: ignore[union-attr]

    if isinstance(template, list):
        return [{"role": m["role"], "content": fill(m["content"])} for m in template]
    return [{"role": "user", "content": fill(str(template))}]


class _Budget:
    def __init__(self, max_calls: int) -> None:
        self.max_calls = max_calls
        self.calls = 0

    def take(self) -> None:
        if self.calls >= self.max_calls:
            raise RuntimeError(f"call budget of {self.max_calls} reached")
        self.calls += 1


def _chat(
    provider: dict[str, Any],
    model: str,
    messages: list[dict[str, str]],
    params: dict[str, Any],
    budget: _Budget,
) -> dict[str, Any]:
    """One OpenAI-compatible chat completion (stdlib only); usage only as the provider reports."""
    import urllib.error
    import urllib.request

    budget.take()
    body: dict[str, Any] = {"model": model, "messages": messages, "stream": False}
    for k in ("temperature", "top_p"):
        if params.get(k) is not None:
            body[k] = float(params[k])
    for k in ("max_tokens", "seed"):
        if params.get(k) is not None:
            body[k] = int(params[k])
    if params.get("stop"):
        body["stop"] = params["stop"]
    headers = {"content-type": "application/json"}
    key_env = provider.get("api_key_env")
    if key_env and os.environ.get(key_env):
        headers["authorization"] = f"Bearer {os.environ[key_env]}"
    url = provider["base_url"].rstrip("/") + "/chat/completions"
    t0 = time.perf_counter()
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=float(provider.get("timeout_sec") or 60)) as r:
            raw = r.read(1024 * 1024 + 1)
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"provider_error {e.code}: {e.read(500).decode(errors='replace')}"
        ) from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise RuntimeError(f"unreachable: {e}") from e
    if len(raw) > 1024 * 1024:
        raise RuntimeError("bad_response: larger than 1 MiB")
    j = json.loads(raw)
    content = (((j.get("choices") or [{}])[0]).get("message") or {}).get("content")
    if not isinstance(content, str):
        raise RuntimeError("bad_response: no choices[0].message.content")
    out: dict[str, Any] = {"text": content, "latency_ms": (time.perf_counter() - t0) * 1000}
    u = j.get("usage") or {}
    usage = {}
    for src, dst in (
        ("prompt_tokens", "input_tokens"),
        ("completion_tokens", "output_tokens"),
        ("total_tokens", "total_tokens"),
    ):
        if isinstance(u.get(src), int):
            usage[dst] = u[src]
    if usage:
        if "total_tokens" not in usage and {"input_tokens", "output_tokens"} <= usage.keys():
            usage["total_tokens"] = usage["input_tokens"] + usage["output_tokens"]
        out["usage"] = usage
    if isinstance(j.get("model"), str):
        out["model"] = j["model"]
    return out


def _redaction(capture: dict[str, Any]) -> Any:
    """A span processor applying the project's capture policy before spans are stored."""
    import re

    mode = capture.get("mode", "redacted")
    rules = [(n, re.compile(rx)) for n, rx in capture.get("rules", [])]

    def text(s: str) -> str:
        for name, rx in rules:
            s = rx.sub(f"[REDACTED:{name}]", s)
        return s

    def walk(v: Any, depth: int = 0) -> Any:
        if isinstance(v, str):
            return text(v)
        if depth > 64:
            return v
        if isinstance(v, list):
            return [walk(x, depth + 1) for x in v]
        if isinstance(v, dict):
            return {k: walk(x, depth + 1) for k, x in v.items()}
        return v

    def process(span: Any) -> None:
        if mode == "full":
            return
        for get, put in (("inputs", "set_inputs"), ("outputs", "set_outputs")):
            v = getattr(span, get, None)
            if v is None:
                continue
            if mode == "redacted":
                getattr(span, put)(walk(v))
            else:  # metadata_only (and off: evaluations still need metadata traces)
                getattr(span, put)(
                    {"omitted": "metadata_only", "bytes": len(json.dumps(v, default=str))}
                )

    return process


def _span_list(trace: Any) -> list[Any]:
    try:
        return list(trace.data.spans) if trace is not None else []
    except AttributeError:
        return []


def _retrieved(trace: Any) -> tuple[list[dict[str, Any]], bool]:
    """Retrieved documents of the trace's RETRIEVER spans, and whether any such span exists."""
    docs: list[dict[str, Any]] = []
    found = False
    for s in _span_list(trace):
        if str(getattr(s, "span_type", "")) not in ("RETRIEVER", "SpanType.RETRIEVER"):
            continue
        found = True
        out = s.outputs
        items = (
            out
            if isinstance(out, list)
            else (out or {}).get("documents", [])
            if isinstance(out, dict)
            else []
        )
        for d in items[:200]:
            if isinstance(d, dict):
                md = d.get("metadata") or {}
                docs.append(
                    {
                        "content": d.get("page_content") or d.get("content") or "",
                        "doc_uri": md.get("doc_uri") or md.get("source"),
                        "chunk_id": md.get("chunk_id"),
                    }
                )
    return docs, found


def _feedback(
    value: Any = None,
    rationale: str | None = None,
    error: str | None = None,
    source: Any = None,
    metadata: dict[str, Any] | None = None,
) -> Any:
    from mlflow.entities import Feedback

    kw: dict[str, Any] = {"value": value}
    if rationale:
        kw["rationale"] = rationale[:4000]
    if error:
        kw["error"] = error[:1000]
    if source is not None:
        kw["source"] = source
    if metadata:
        kw["metadata"] = {k: str(v) for k, v in metadata.items()}
    return Feedback(**kw)


def _answer_text(outputs: Any) -> str:
    if outputs is None or (isinstance(outputs, float) and math.isnan(outputs)):
        return ""
    return outputs if isinstance(outputs, str) else json.dumps(outputs, default=str)


_JUDGE_SYSTEM = (
    "You are an evaluator. Reply with 'yes' or 'no' on the first line, "
    "then one sentence of rationale."
)


def _make_scorers(
    req: dict[str, Any],
    budget: _Budget,
    judge_usage: dict[str, dict[str, int]],
    side: dict[str, dict[str, Any]],
) -> list[Any]:
    """AblationKit's scorers as MLflow ``@scorer`` functions, each recording into ``side``."""
    import re

    from mlflow.entities import AssessmentSource
    from mlflow.genai.scorers import scorer

    out = []

    def record(name: str, trace: Any, fb: Any) -> Any:
        tid = getattr(getattr(trace, "info", None), "trace_id", None)
        if tid:
            side.setdefault(tid, {})[name] = {
                "value": fb.value,
                **({"rationale": fb.rationale} if getattr(fb, "rationale", None) else {}),
                **(
                    {"error": str(getattr(fb.error, "error_message", fb.error))}
                    if getattr(fb, "error", None)
                    else {}
                ),
            }
        return fb

    for spec in req["scorers"]:
        name = spec["name"]
        kind = spec["kind"]
        params = spec.get("params") or {}

        if kind == "builtin":
            b = spec["builtin"]

            def _mk_fn(_b: str, _n: str, _p: dict[str, Any]) -> Any:
                def fn(
                    inputs: Any = None,
                    outputs: Any = None,
                    expectations: Any = None,
                    trace: Any = None,
                ) -> Any:
                    exp = expectations or {}
                    ans = _answer_text(outputs)
                    src = AssessmentSource(source_type="CODE", source_id=f"ablationkit/{_b}")
                    if _b in ("exact_match", "contains_expected"):
                        want = exp.get("expected_response")
                        if want is None:
                            return record(
                                _n,
                                trace,
                                _feedback(
                                    error="missing ground truth: no expected_response", source=src
                                ),
                            )
                        a, w = ans.strip().lower(), str(want).strip().lower()
                        return record(
                            _n,
                            trace,
                            _feedback(
                                value=(a == w) if _b == "exact_match" else (w in a), source=src
                            ),
                        )
                    if _b == "expected_facts":
                        facts = exp.get("expected_facts")
                        if not isinstance(facts, list) or not facts:
                            return record(
                                _n,
                                trace,
                                _feedback(
                                    error="missing ground truth: no expected_facts", source=src
                                ),
                            )
                        hit = [f for f in facts if str(f).lower() in ans.lower()]
                        return record(
                            _n,
                            trace,
                            _feedback(
                                value=len(hit) / len(facts),
                                rationale=f"{len(hit)} of {len(facts)} facts present",
                                source=src,
                            ),
                        )
                    if _b == "regex":
                        return record(
                            _n,
                            trace,
                            _feedback(
                                value=bool(re.search(_p.get("pattern", "$^"), ans)), source=src
                            ),
                        )
                    if _b == "max_length":
                        lim = int(_p.get("max_chars", "1000"))
                        return record(
                            _n,
                            trace,
                            _feedback(
                                value=len(ans) <= lim,
                                rationale=f"{len(ans)} characters",
                                source=src,
                            ),
                        )
                    if _b in ("retrieval_recall", "has_citation"):
                        docs, found = _retrieved(trace)
                        if not found:
                            return record(
                                _n,
                                trace,
                                _feedback(
                                    error="not instrumented: no retrieval span in the trace",
                                    source=src,
                                ),
                            )
                        if _b == "has_citation":
                            uris = {str(d["doc_uri"]) for d in docs if d.get("doc_uri")}
                            cited = [u for u in uris if u in ans]
                            return record(
                                _n,
                                trace,
                                _feedback(
                                    value=bool(cited),
                                    rationale=f"cites {cited}"
                                    if cited
                                    else "no retrieved source cited",
                                    source=src,
                                ),
                            )
                        want = exp.get("expected_retrieved_context")
                        if not isinstance(want, list) or not want:
                            return record(
                                _n,
                                trace,
                                _feedback(
                                    error="missing ground truth: no expected_retrieved_context",
                                    source=src,
                                ),
                            )
                        got = {str(d.get("doc_uri")) for d in docs} | {
                            f"{d.get('doc_uri')}#{d.get('chunk_id')}" for d in docs
                        }
                        hit = [w for w in want if str(w) in got]
                        return record(
                            _n,
                            trace,
                            _feedback(
                                value=len(hit) / len(want),
                                rationale=f"{len(hit)} of {len(want)} expected sources retrieved",
                                source=src,
                            ),
                        )
                    if _b == "tool_called":
                        tool = _p.get("tool", "")
                        called = [
                            s.name
                            for s in _span_list(trace)
                            if str(getattr(s, "span_type", "")) in ("TOOL", "SpanType.TOOL")
                        ]
                        return record(
                            _n,
                            trace,
                            _feedback(
                                value=tool in called,
                                rationale=f"tools called: {called}",
                                source=src,
                            ),
                        )
                    return record(_n, trace, _feedback(error=f"unknown builtin {_b}", source=src))

                return fn

            out.append(scorer(name=name)(_mk_fn(b, name, params)))
        elif kind == "judge":
            j = spec["judge"]
            prov = spec["judge_provider"]

            def _mk_jfn(_j: dict[str, Any], _prov: dict[str, Any], _n: str) -> Any:
                def jfn(
                    inputs: Any = None,
                    outputs: Any = None,
                    expectations: Any = None,
                    trace: Any = None,
                ) -> Any:
                    src = AssessmentSource(
                        source_type="LLM_JUDGE", source_id=f"{_j['provider_id']}/{_j['model']}"
                    )
                    md = {
                        "rubric_sha256": _j["rubric_sha256"],
                        "judge_model": _j["model"],
                        "judge_provider": _j["provider_id"],
                        "judge_locality": _j["locality"],
                    }
                    ans = _answer_text(outputs)
                    parts = [
                        f"Rubric:\n{_j['rubric']}",
                        f"Inputs:\n{json.dumps(inputs, default=str)}",
                        f"Answer:\n{ans}",
                    ]
                    if _j.get("uses") == "grounding":
                        docs, found = _retrieved(trace)
                        if not found:
                            return record(
                                _n,
                                trace,
                                _feedback(
                                    error="not instrumented: no retrieval span to judge by",
                                    source=src,
                                    metadata=md,
                                ),
                            )
                        if not docs or all(not d["content"] for d in docs):
                            return record(
                                _n,
                                trace,
                                _feedback(
                                    error="retrieved passages were not captured (capture policy)",
                                    source=src,
                                    metadata=md,
                                ),
                            )
                        parts.insert(
                            1,
                            "Retrieved passages:\n"
                            + "\n".join(
                                f"[{d.get('doc_uri')}#{d.get('chunk_id')}] {d['content']}"
                                for d in docs
                            ),
                        )
                    elif (expectations or {}).get("expected_response") is not None:
                        parts.append(f"Reference answer:\n{expectations['expected_response']}")
                    msgs = [
                        {
                            "role": "system",
                            "content": _JUDGE_SYSTEM,
                        },
                        {"role": "user", "content": "\n\n".join(parts)},
                    ]
                    try:
                        r = _chat(_prov, _j["model"], msgs, _j.get("params") or {}, budget)
                    except Exception as e:
                        return record(
                            _n,
                            trace,
                            _feedback(error=f"judge failed: {e}", source=src, metadata=md),
                        )
                    u = judge_usage.setdefault(_n, {"reported": 0, "missing": 0})
                    if r.get("usage"):
                        u["reported"] += 1
                        for k, v in r["usage"].items():
                            u[k] = u.get(k, 0) + v
                        md.update({f"judge_{k}": v for k, v in r["usage"].items()})
                    else:
                        u["missing"] += 1
                    first, _, rest = r["text"].strip().partition("\n")
                    verdict = first.strip().strip(".").lower()
                    if verdict.startswith("yes"):
                        value: Any = "yes"
                    elif verdict.startswith("no"):
                        value = "no"
                    else:
                        return record(
                            _n,
                            trace,
                            _feedback(
                                error=f"judge gave no yes/no verdict: {r['text'][:200]}",
                                source=src,
                                metadata=md,
                            ),
                        )
                    return record(
                        _n,
                        trace,
                        _feedback(
                            value=value,
                            rationale=(rest.strip() or first)[:2000],
                            source=src,
                            metadata=md,
                        ),
                    )

                return jfn

            out.append(scorer(name=name)(_mk_jfn(j, prov, name)))
        elif kind == "project":
            import importlib.util

            p = spec["project"]
            path = Path(req["project_path"]) / p["path"]
            mspec = importlib.util.spec_from_file_location(f"ak_project_scorers_{name}", path)
            if mspec is None or mspec.loader is None:
                raise RuntimeError(f"cannot load {p['path']}")
            mod = importlib.util.module_from_spec(mspec)
            mspec.loader.exec_module(mod)
            target = getattr(mod, p["function"])

            def _mk_pfn(_t: Any, _n: str, _ps: dict[str, Any]) -> Any:
                def pfn(
                    inputs: Any = None,
                    outputs: Any = None,
                    expectations: Any = None,
                    trace: Any = None,
                ) -> Any:
                    src = AssessmentSource(
                        source_type="CODE", source_id=f"project/{_ps['path']}:{_ps['function']}"
                    )
                    fn = (
                        getattr(_t, "__wrapped__", None)
                        or getattr(_t, "_original_func", None)
                        or _t
                    )
                    try:
                        v = fn(
                            inputs=inputs, outputs=outputs, expectations=expectations, trace=trace
                        )
                    except Exception as e:
                        return record(
                            _n, trace, _feedback(error=f"{type(e).__name__}: {e}", source=src)
                        )
                    if hasattr(v, "value") and hasattr(v, "name"):
                        return record(
                            _n,
                            trace,
                            _feedback(
                                value=v.value, rationale=getattr(v, "rationale", None), source=src
                            ),
                        )
                    return record(_n, trace, _feedback(value=v, source=src))

                return pfn

            out.append(scorer(name=name)(_mk_pfn(target, name, p)))
    return out


def _decimal_metrics(metrics: dict[str, Any]) -> dict[str, str]:
    out = {}
    for k, v in metrics.items():
        f = _finite(v)
        if f is not None:
            out[str(k)] = repr(round(f, 6))
    return out


def genai_evaluate(req: dict[str, Any]) -> dict[str, Any]:
    """``mlflow.genai.evaluate`` of pinned targets over one golden-set version (ADR 0021).

    A ``prompt`` target renders a pinned prompt version with each example's inputs and calls one
    OpenAI-compatible model (stdlib HTTP, inside traced spans). A ``recorded`` target scores traces
    the project's own application already recorded. Every target is the MLflow run the coordinator
    created; traces carry ``ablationkit.*`` tags, and the capture policy's span processor runs
    before anything is stored. Per-example results go to ``ablationkit/llm/examples.json``.
    """
    import mlflow
    import mlflow.tracing

    t_start = time.perf_counter()
    mlflow.set_tracking_uri(os.environ["MLFLOW_TRACKING_URI"])
    examples = {e["example_id"]: e for e in req["examples"]}
    order = [e["example_id"] for e in req["examples"]]
    budget = _Budget(int(req["max_calls"]))
    mlflow.tracing.configure(span_processors=[_redaction(req["capture"])])
    results = []
    base_tags = dict(req.get("tags") or {})
    gs_ref = f"{req['golden_set']['golden_set_id']}/{req['golden_set']['version']}"
    for target in req["targets"]:
        label = target["label"]
        side: dict[str, dict[str, Any]] = {}
        calls: dict[str, dict[str, Any]] = {}
        judge_usage: dict[str, dict[str, int]] = {}
        scorers = _make_scorers(req, budget, judge_usage, side)
        tags = {**base_tags, "ablationkit.variant": label}
        if target["kind"] == "prompt":
            tags["ablationkit.prompt"] = f"{target['prompt']['name']}/{target['prompt']['version']}"
            tags["ablationkit.model"] = target["model"]
            data = []
            for _ in range(int(req.get("trials") or 1)):
                for eid in order:
                    e = examples[eid]
                    row: dict[str, Any] = {
                        "inputs": dict(e["inputs"]),
                        "tags": {**tags, "ablationkit.example_id": eid},
                    }
                    if e.get("expectations"):
                        row["expectations"] = e["expectations"]
                    data.append(row)

            def _mk_predict(_t: dict[str, Any], _calls: dict[str, Any]) -> Any:
                def predict_fn(**inputs: Any) -> str:
                    messages = _render(_t["template"], inputs)
                    with mlflow.start_span(name="chat_completion", span_type="CHAT_MODEL") as span:
                        span.set_inputs(
                            {
                                "messages": messages,
                                "model": _t["model"],
                                "params": _t.get("params") or {},
                            }
                        )
                        span.set_attribute(
                            "ablationkit.llm.provider", _t["provider"]["provider_id"]
                        )
                        root = mlflow.get_current_active_span()
                        tid = getattr(root, "trace_id", None)
                        try:
                            r = _chat(
                                _t["provider"],
                                _t["model"],
                                messages,
                                _t.get("params") or {},
                                budget,
                            )
                        except Exception as err:
                            if tid:
                                _calls[tid] = {"error": str(err)[:1000]}
                            raise
                        span.set_outputs(r["text"])
                        span.set_attribute("ablationkit.llm.model", r.get("model") or _t["model"])
                        if r.get("usage"):
                            span.set_attribute("mlflow.chat.tokenUsage", r["usage"])
                        if tid:
                            _calls[tid] = {
                                "latency_ms": r["latency_ms"],
                                **({"usage": r["usage"]} if r.get("usage") else {}),
                            }
                        return r["text"]

                return predict_fn

            os.environ["MLFLOW_GENAI_EVAL_SKIP_TRACE_VALIDATION"] = "True"
            with mlflow.start_run(run_id=target["run_id"]):
                mlflow.log_params(
                    {
                        "ablationkit.golden_set": gs_ref,
                        "ablationkit.prompt": tags["ablationkit.prompt"],
                        "ablationkit.model": target["model"],
                        **{f"gen.{k}": v for k, v in (target.get("params") or {}).items()},
                    }
                )
                res = mlflow.genai.evaluate(
                    data=data, predict_fn=_mk_predict(target, calls), scorers=scorers
                )
        else:
            data = []
            for t in target["traces"]:
                tr = mlflow.get_trace(t["trace_id"])
                e = examples.get(t["example_id"])
                if tr is None or e is None:
                    continue
                for k, v in {
                    **tags,
                    "ablationkit.example_id": t["example_id"],
                    "ablationkit.evaluation": base_tags.get("ablationkit.evaluation", ""),
                }.items():
                    try:
                        mlflow.set_trace_tag(t["trace_id"], k, v)
                    except Exception:
                        traceback.print_exc()
                row = {"trace": tr}
                if e.get("expectations"):
                    row["expectations"] = e["expectations"]
                data.append(row)
                ms = tr.info.execution_time_ms
                calls[t["trace_id"]] = {"latency_ms": ms} if ms is not None else {}
                try:
                    u = json.loads(
                        (tr.info.trace_metadata or {}).get("mlflow.trace.tokenUsage") or "null"
                    )
                    if u:
                        calls[t["trace_id"]]["usage"] = u
                except ValueError:
                    pass
            with mlflow.start_run(run_id=target["run_id"]):
                mlflow.log_params(
                    {
                        "ablationkit.golden_set": gs_ref,
                        "ablationkit.source_run": target["source_run_id"],
                    }
                )
                res = mlflow.genai.evaluate(data=data, scorers=scorers)
        df = res.result_df
        rows = []
        seen_trials: dict[str, int] = {}
        for rec in df.to_dict("records"):
            tid = rec.get("trace_id")
            rtags = rec.get("tags") or {}
            eid = rtags.get("ablationkit.example_id") if isinstance(rtags, dict) else None
            if not eid or eid not in examples:
                continue
            seen_trials[eid] = seen_trials.get(eid, 0) + 1
            c = calls.get(tid, {})
            out_val = rec.get("response")
            row = {
                "example_id": eid,
                "trial": seen_trials[eid],
                "trace_id": tid,
                "scores": side.get(tid, {}),
                **(
                    {"category": examples[eid]["category"]} if examples[eid].get("category") else {}
                ),
            }
            missing = out_val is None or (isinstance(out_val, float) and math.isnan(out_val))
            if not missing:
                row["output"] = out_val
            if c.get("error") or rec.get("state") == "ERROR":
                row["error"] = c.get("error") or "generation failed (see the trace)"
            if c.get("latency_ms") is not None:
                row["latency_ms"] = round(float(c["latency_ms"]))
            if c.get("usage"):
                row["usage"] = c["usage"]
            rows.append(row)
        rows.sort(key=lambda r: (order.index(r["example_id"]), r["trial"]))
        usage: dict[str, int] = {"reported": 0, "missing": 0}
        for r in rows:
            if r.get("error"):
                continue
            if r.get("usage"):
                usage["reported"] += 1
                for k, v in r["usage"].items():
                    usage[k] = usage.get(k, 0) + int(v)
            else:
                usage["missing"] += 1
        lat = sorted(r["latency_ms"] for r in rows if "latency_ms" in r)
        doc = {
            "schema": "ablationkit.llm_examples/v1",
            "evaluation_id": base_tags.get("ablationkit.evaluation"),
            "label": label,
            "golden_set": req["golden_set"],
            "rows": rows,
        }
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "examples.json"
            f.write_text(json.dumps(doc, default=str, allow_nan=False))
            mlflow.log_artifact(str(f), artifact_path="ablationkit/llm", run_id=target["run_id"])
        results.append(
            {
                "label": label,
                "run_id": target["run_id"],
                "metrics": _decimal_metrics(res.metrics or {}),
                "examples": len({r["example_id"] for r in rows}),
                "errors": sum(1 for r in rows if r.get("error")),
                "scorer_errors": sum(
                    1 for r in rows for s in r["scores"].values() if s.get("error")
                ),
                "usage": usage,
                "judge_usage": judge_usage,
                **(
                    {
                        "latency_ms": {
                            "mean": round(sum(lat) / len(lat)),
                            "p50": round(lat[(len(lat) - 1) // 2]),
                            "max": round(lat[-1]),
                        }
                    }
                    if lat
                    else {}
                ),
            }
        )
    return {
        "ok": True,
        "results": results,
        "calls": budget.calls,
        "seconds": round(time.perf_counter() - t_start, 3),
        **_env(),
    }


OPS = {"genai_evaluate": genai_evaluate}


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: genai.py REQUEST.json RESULT.json", file=sys.stderr)
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
