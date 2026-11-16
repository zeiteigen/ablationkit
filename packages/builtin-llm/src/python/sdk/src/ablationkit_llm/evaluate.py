"""Remote GenAI evaluation (ADR 0023 decision 25).

Run by a remote GenAI evaluation job: ``python -m ablationkit_llm.evaluate --request-sha256 H``.
The coordinator puts the request in the bundle at ``$ABLATIONKIT_BUNDLE_INPUTS/genai/request.json``:
the pinned golden-set examples, each prompt target's template, provider endpoint (as reachable from
the target; never an API key) and model, the scorers, the call budget and the capture policy.

For every target and trial it renders the prompt, calls the OpenAI-compatible model inside a trace
(``ablationkit_llm.trace``: the worker's capture rules apply, metadata only unless the project
allows remote capture), and scores the answer with the same scorers as the local evaluation:
builtins, LLM judges (answer only: there is no retrieval span) and project scorers (verified
against the hash the coordinator recorded). Aggregates follow ``mlflow.genai.evaluate``'s names
(``<scorer>/mean``; ``yes`` counts as 1). Everything goes to one artifact,
``eval/genai-results.json``, which travels in the worker's spool; the coordinator fills each
target's MLflow run from it once the attempt has synced.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import chat, render, trace

RESULTS_ARTIFACT = "eval/genai-results.json"
JUDGE_SYSTEM = (
    "You are an evaluator. Reply with 'yes' or 'no' on the first line, "
    "then one sentence of rationale."
)
TRACE_BUILTINS = {"retrieval_recall", "has_citation", "tool_called"}


class Budget:
    def __init__(self, max_calls: int) -> None:
        self.max_calls = max_calls
        self.calls = 0

    def take(self) -> None:
        if self.calls >= self.max_calls:
            raise RuntimeError(f"call budget of {self.max_calls} reached")
        self.calls += 1


def file_sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _call(
    provider: dict[str, Any], model: str, messages: list[dict[str, str]], params: dict[str, Any]
) -> Any:
    p: dict[str, Any] = {}
    for k in ("temperature", "top_p"):
        if params.get(k) is not None:
            p[k] = float(params[k])
    for k in ("max_tokens", "seed"):
        if params.get(k) is not None:
            p[k] = int(params[k])
    if params.get("stop"):
        p["stop"] = params["stop"]
    return chat(
        messages,
        model=model,
        base_url=provider["base_url"],
        api_key="",
        params=p,
        timeout=float(provider.get("timeout_sec") or 60),
    )


def _builtin(b: str, params: dict[str, Any]) -> Callable[..., dict[str, Any]]:
    def fn(inputs: Any, answer: str, expectations: dict[str, Any]) -> dict[str, Any]:
        if b in ("exact_match", "contains_expected"):
            want = expectations.get("expected_response")
            if want is None:
                return {"error": "missing ground truth: no expected_response"}
            a, w = answer.strip().lower(), str(want).strip().lower()
            return {"value": a == w if b == "exact_match" else w in a}
        if b == "expected_facts":
            facts = expectations.get("expected_facts")
            if not isinstance(facts, list) or not facts:
                return {"error": "missing ground truth: no expected_facts"}
            hit = [f for f in facts if str(f).lower() in answer.lower()]
            return {
                "value": len(hit) / len(facts),
                "rationale": f"{len(hit)} of {len(facts)} facts present",
            }
        if b == "regex":
            return {"value": bool(re.search(params.get("pattern", "$^"), answer))}
        if b == "max_length":
            lim = int(params.get("max_chars", "1000"))
            return {"value": len(answer) <= lim, "rationale": f"{len(answer)} characters"}
        if b in TRACE_BUILTINS:
            return {"error": "not instrumented: no retrieval or tool span in a prompt target"}
        return {"error": f"unknown builtin {b}"}

    return fn


def _judge(spec: dict[str, Any], budget: Budget, usage: dict[str, int]) -> Callable[..., Any]:
    j, prov = spec["judge"], spec["judge_provider"]

    def fn(inputs: Any, answer: str, expectations: dict[str, Any]) -> dict[str, Any]:
        if j.get("uses") == "grounding":
            return {"error": "not instrumented: no retrieval span to judge by"}
        parts = [
            f"Rubric:\n{j['rubric']}",
            f"Inputs:\n{json.dumps(inputs, default=str)}",
            f"Answer:\n{answer}",
        ]
        if expectations.get("expected_response") is not None:
            parts.append(f"Reference answer:\n{expectations['expected_response']}")
        msgs = [
            {"role": "system", "content": JUDGE_SYSTEM},
            {"role": "user", "content": "\n\n".join(parts)},
        ]
        try:
            budget.take()
            r = _call(prov, j["model"], msgs, j.get("params") or {})
        except Exception as e:
            return {"error": f"judge failed: {e}"[:1000]}
        if r.usage:
            usage["reported"] += 1
            for k, v in r.usage.items():
                usage[k] = usage.get(k, 0) + int(v)
        else:
            usage["missing"] += 1
        first, _, rest = r.text.strip().partition("\n")
        verdict = first.strip().strip(".").lower()
        if not (verdict.startswith("yes") or verdict.startswith("no")):
            return {"error": f"judge gave no yes/no verdict: {r.text[:200]}"}
        return {
            "value": "yes" if verdict.startswith("yes") else "no",
            "rationale": (rest.strip() or first)[:2000],
        }

    return fn


def _project(spec: dict[str, Any], source: Path) -> Callable[..., Any]:
    p = spec["project"]
    path = (source / p["path"]).resolve()
    if not path.is_relative_to(source.resolve()) or not path.is_file():
        raise RuntimeError(f"{spec['name']}: no file {p['path']} in the bundle")
    if file_sha256(path) != p["sha256"]:
        raise RuntimeError(
            f"{spec['name']}: {p['path']} differs from the file the evaluation was created with"
        )
    mspec = importlib.util.spec_from_file_location(f"ak_project_scorers_{spec['name']}", path)
    if mspec is None or mspec.loader is None:
        raise RuntimeError(f"cannot load {p['path']}")
    mod = importlib.util.module_from_spec(mspec)
    mspec.loader.exec_module(mod)
    target = getattr(mod, p["function"])
    target = (
        getattr(target, "__wrapped__", None) or getattr(target, "_original_func", None) or target
    )

    def fn(inputs: Any, answer: str, expectations: dict[str, Any]) -> dict[str, Any]:
        try:
            v = target(inputs=inputs, outputs=answer, expectations=expectations, trace=None)
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"[:1000]}
        if hasattr(v, "value") and hasattr(v, "name"):
            out = {"value": v.value}
            if getattr(v, "rationale", None):
                out["rationale"] = str(v.rationale)[:4000]
            return out
        return {"value": v}

    return fn


def _numeric(v: Any) -> float | None:
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and v.strip().lower() in ("yes", "no"):
        return 1.0 if v.strip().lower() == "yes" else 0.0
    return None


def _shown(answer: str, capture: dict[str, Any]) -> Any:
    """The output as the capture policy allows it to be stored (the score used the real one)."""
    mode = capture.get("mode", "redacted")
    if mode == "full":
        return answer
    if mode == "redacted":
        for name, rx in capture.get("rules", []):
            answer = re.sub(rx, f"[REDACTED:{name}]", answer)
        return answer
    return {"omitted": "metadata_only", "bytes": len(answer.encode())}


def evaluate(req: dict[str, Any], source: Path) -> dict[str, Any]:
    t_start = time.perf_counter()
    budget = Budget(int(req["max_calls"]))
    examples = req["examples"]
    capture = req.get("capture") or {"mode": "metadata_only"}
    results = []
    for target in req["targets"]:
        label = target["label"]
        judge_usage: dict[str, dict[str, int]] = {}
        scorers: list[tuple[str, Callable[..., dict[str, Any]]]] = []
        for s in req["scorers"]:
            if s["kind"] == "builtin":
                scorers.append((s["name"], _builtin(s["builtin"], s.get("params") or {})))
            elif s["kind"] == "judge":
                u = judge_usage.setdefault(s["name"], {"reported": 0, "missing": 0})
                scorers.append((s["name"], _judge(s, budget, u)))
            else:
                scorers.append((s["name"], _project(s, source)))
        rows: list[dict[str, Any]] = []
        for trial in range(1, int(req.get("trials") or 1) + 1):
            for e in examples:
                eid = e["example_id"]
                row: dict[str, Any] = {"example_id": eid, "trial": trial, "scores": {}}
                if e.get("category"):
                    row["category"] = e["category"]
                answer: str | None = None
                tags = {**(req.get("tags") or {}), "ablationkit.variant": label}
                try:
                    with trace("genai_evaluation", inputs=e["inputs"], example_id=eid, tags=tags):
                        budget.take()
                        r = _call(
                            target["provider"],
                            target["model"],
                            render(target["template"], e["inputs"]),
                            target.get("params") or {},
                        )
                    answer = r.text
                    row["latency_ms"] = round(r.latency_ms)
                    if r.usage:
                        row["usage"] = {k: int(v) for k, v in r.usage.items()}
                except Exception as err:
                    row["error"] = str(err)[:1000]
                if answer is not None:
                    row["output"] = _shown(answer, capture)
                    exp = e.get("expectations") or {}
                    for name, fn in scorers:
                        row["scores"][name] = fn(e["inputs"], answer, exp)
                rows.append(row)
        metrics: dict[str, str] = {}
        for name, _ in scorers:
            vals = [
                v
                for r in rows
                if "error" not in r.get("scores", {}).get(name, {"error": 1})
                and (v := _numeric(r["scores"][name].get("value"))) is not None
            ]
            if vals:
                metrics[f"{name}/mean"] = repr(round(sum(vals) / len(vals), 6))
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
        result: dict[str, Any] = {
            "label": label,
            "metrics": metrics,
            "examples": len({r["example_id"] for r in rows}),
            "errors": sum(1 for r in rows if r.get("error")),
            "scorer_errors": sum(1 for r in rows for s in r["scores"].values() if s.get("error")),
            "usage": usage,
            "judge_usage": judge_usage,
            "doc": {
                "schema": "ablationkit.llm_examples/v1",
                "evaluation_id": (req.get("tags") or {}).get("ablationkit.evaluation"),
                "label": label,
                "golden_set": req["golden_set"],
                "rows": rows,
            },
        }
        if lat:
            result["latency_ms"] = {
                "mean": round(sum(lat) / len(lat)),
                "p50": round(lat[(len(lat) - 1) // 2]),
                "max": round(lat[-1]),
            }
        results.append(result)
    return {
        "schema": "ablationkit.remote_genai/v1",
        "evaluation_id": (req.get("tags") or {}).get("ablationkit.evaluation"),
        "results": results,
        "calls": budget.calls,
        "seconds": round(time.perf_counter() - t_start, 3),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ablationkit_llm.evaluate")
    ap.add_argument("--request-sha256", required=True)
    args = ap.parse_args(argv)
    inputs = Path(os.environ.get("ABLATIONKIT_BUNDLE_INPUTS", "inputs"))
    req_path = inputs / "genai" / "request.json"
    if not req_path.is_file():
        print(f"no evaluation request at {req_path}", file=sys.stderr)
        return 2
    if file_sha256(req_path) != args.request_sha256:
        print("the evaluation request does not match the recorded SHA-256", file=sys.stderr)
        return 2
    req = json.loads(req_path.read_text())
    out = evaluate(req, Path.cwd())
    import ablationkit_sdk as ak

    for r in out["results"]:
        ak.log_metrics({f"{r['label']}.{k}": float(v) for k, v in r["metrics"].items()})
    ak.log_dict(out, RESULTS_ARTIFACT)
    print(
        f"evaluated {len(out['results'])} target(s) with {out['calls']} model calls "
        f"in {out['seconds']}s",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
