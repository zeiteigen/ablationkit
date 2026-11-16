"""Optional, provider-neutral LLM helpers for AblationKit projects (spec §4.1, §5.6.2; ADR 0021).

Stdlib only. A project records what its application does as MLflow-format traces, and the
coordinator writes them to MLflow (with the project's capture and redaction policy applied first)::

    import ablationkit_llm as llm

    for ex in llm.golden_set("faq-golden"):            # pinned version exported to the checkout
        with llm.trace("answer", inputs=ex.inputs, example_id=ex.example_id) as t:
            with llm.span("retrieve", "RETRIEVER", inputs={"query": q}) as s:
                s.set_outputs(llm.documents(hits))  # MLflow retriever documents
            with llm.span("lookup_order", "TOOL", inputs={"order": 7}) as s:
                s.set_outputs(lookup(7))
            reply = llm.chat(messages, model="tiny-rag")  # an LLM span with reported usage
            t.set_outputs(reply.text)

Only observed inputs, outputs, timings, errors and provider-reported token usage are recorded; no
hidden reasoning is inferred, and missing usage stays missing. Outside AblationKit (no events file)
everything still runs and nothing is recorded.
"""

from __future__ import annotations

import base64
import contextvars
import hashlib
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

__all__ = [
    "ChatReply",
    "GoldenExample",
    "Span",
    "Trace",
    "chat",
    "documents",
    "golden_set",
    "load_prompt",
    "render",
    "span",
    "trace",
]

SPAN_TYPES = {
    "LLM",
    "CHAT_MODEL",
    "RETRIEVER",
    "RERANKER",
    "TOOL",
    "AGENT",
    "CHAIN",
    "EMBEDDING",
    "PARSER",
    "UNKNOWN",
}
MAX_SPANS = 5000
_VAR = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}")
_current: contextvars.ContextVar[Span | None] = contextvars.ContextVar(
    "ablationkit_llm_span", default=None
)
_trace: contextvars.ContextVar[Trace | None] = contextvars.ContextVar(
    "ablationkit_llm_trace", default=None
)


def _ns() -> int:
    return time.time_ns()


def _b64(n: int) -> str:
    return base64.b64encode(secrets.token_bytes(n)).decode()


def _json(v: Any) -> str:
    return json.dumps(v, default=str, allow_nan=False)


@dataclass
class Span:
    """One observed step: an LLM call, a retrieval, a tool call, or any chain step."""

    name: str
    span_type: str
    span_id: str = field(default_factory=lambda: _b64(8))
    parent_id: str | None = None
    start_ns: int = field(default_factory=_ns)
    end_ns: int | None = None
    inputs: Any = None
    outputs: Any = None
    attributes: dict[str, Any] = field(default_factory=dict)
    error: tuple[str, str] | None = None

    def set_inputs(self, v: Any) -> None:
        self.inputs = v

    def set_outputs(self, v: Any) -> None:
        self.outputs = v

    def set_attribute(self, key: str, value: Any) -> None:
        self.attributes[key] = value

    def set_usage(
        self,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        total_tokens: int | None = None,
    ) -> None:
        """Token usage exactly as a provider reported it. Never pass an estimate."""
        u = {
            k: v
            for k, v in (
                ("input_tokens", input_tokens),
                ("output_tokens", output_tokens),
                ("total_tokens", total_tokens),
            )
            if isinstance(v, int)
        }
        if "total_tokens" not in u and {"input_tokens", "output_tokens"} <= u.keys():
            u["total_tokens"] = u["input_tokens"] + u["output_tokens"]
        if u:
            self.attributes["mlflow.chat.tokenUsage"] = u

    def record_error(self, e: BaseException) -> None:
        self.error = (type(e).__name__, str(e)[:4000])

    def to_mlflow(self, trace_b64: str, request_id: str) -> dict[str, Any]:
        attrs: dict[str, str] = {
            "mlflow.traceRequestId": _json(request_id),
            "mlflow.spanType": _json(self.span_type),
        }
        if self.inputs is not None:
            attrs["mlflow.spanInputs"] = _json(self.inputs)
        if self.outputs is not None:
            attrs["mlflow.spanOutputs"] = _json(self.outputs)
        for k, v in self.attributes.items():
            attrs[k] = _json(v)
        events = []
        if self.error:
            events.append(
                {
                    "name": "exception",
                    "time_unix_nano": self.end_ns or _ns(),
                    "attributes": {
                        "exception.type": self.error[0],
                        "exception.message": self.error[1],
                    },
                }
            )
        return {
            "trace_id": trace_b64,
            "span_id": self.span_id,
            "parent_span_id": self.parent_id,
            "name": self.name,
            "start_time_unix_nano": self.start_ns,
            "end_time_unix_nano": self.end_ns or _ns(),
            "events": events,
            "status": {"code": "STATUS_CODE_ERROR", "message": self.error[1]}
            if self.error
            else {"code": "STATUS_CODE_OK", "message": ""},
            "attributes": attrs,
        }


@dataclass
class Trace:
    """One end-to-end request of the application (the root span plus everything under it)."""

    name: str
    root: Span
    trace_id: str = field(default_factory=lambda: f"tr-{secrets.token_hex(16)}")
    trace_b64: str = field(default_factory=lambda: _b64(16))
    spans: list[Span] = field(default_factory=list)
    tags: dict[str, str] = field(default_factory=dict)
    metadata: dict[str, str] = field(default_factory=dict)

    def set_outputs(self, v: Any) -> None:
        self.root.set_outputs(v)

    def set_tag(self, key: str, value: str) -> None:
        self.tags[key] = str(value)

    def payload(self) -> dict[str, Any]:
        usage: dict[str, int] = {}
        reported = 0
        for s in self.spans:
            u = s.attributes.get("mlflow.chat.tokenUsage")
            if isinstance(u, dict):
                reported += 1
                for k, v in u.items():
                    usage[k] = usage.get(k, 0) + int(v)
        md = dict(self.metadata)
        if reported:
            md["mlflow.trace.tokenUsage"] = _json(usage)
        if self.root.inputs is not None:
            md["mlflow.traceInputs"] = _json(self.root.inputs)[:8000]
        if self.root.outputs is not None:
            md["mlflow.traceOutputs"] = _json(self.root.outputs)[:8000]
        end = self.root.end_ns or _ns()
        return {
            "trace": {
                "trace_id": self.trace_id,
                "name": self.name,
                "request_time": time.strftime(
                    "%Y-%m-%dT%H:%M:%S", time.gmtime(self.root.start_ns / 1e9)
                )
                + f".{(self.root.start_ns // 1_000_000) % 1000:03d}Z",
                "duration_ms": max(0, (end - self.root.start_ns) // 1_000_000),
                # A failed tool call that was retried does not fail the request; the root decides.
                "state": "ERROR" if self.root.error else "OK",
                "tags": self.tags,
                "metadata": md,
                "spans": [s.to_mlflow(self.trace_b64, self.trace_id) for s in self.spans],
            }
        }


def _emit(t: Trace) -> None:
    try:
        import ablationkit_sdk
    except ImportError:
        return
    run = ablationkit_sdk.current()
    if run.enabled:
        run.emit("trace.logged", t.payload())
    else:
        run.emit("trace.logged", {})  # warns once that nothing is recorded


@contextmanager
def trace(
    name: str,
    *,
    inputs: Any = None,
    example_id: str | None = None,
    tags: Mapping[str, str] | None = None,
    span_type: str = "AGENT",
) -> Iterator[Trace]:
    """Record one request. ``example_id`` ties it to a golden-set example (for scoring later)."""
    if span_type not in SPAN_TYPES:
        raise ValueError(f"span_type must be one of {sorted(SPAN_TYPES)}")
    root = Span(name, span_type, inputs=inputs)
    t = Trace(name, root, spans=[root])
    for k, v in (tags or {}).items():
        t.set_tag(k if k.startswith("ablationkit.") else f"ablationkit.{k}", str(v))
    if example_id is not None:
        t.set_tag("ablationkit.example_id", example_id)
    gs = os.environ.get("ABLATIONKIT_GOLDEN_SET")
    if gs and "ablationkit.golden_set" not in t.tags:
        t.set_tag("ablationkit.golden_set", gs)
    tok_t = _trace.set(t)
    tok_s = _current.set(root)
    try:
        yield t
    except BaseException as e:
        root.record_error(e)
        raise
    finally:
        root.end_ns = _ns()
        _current.reset(tok_s)
        _trace.reset(tok_t)
        _emit(t)


@contextmanager
def span(
    name: str,
    span_type: str = "CHAIN",
    *,
    inputs: Any = None,
    attributes: Mapping[str, Any] | None = None,
) -> Iterator[Span]:
    """A nested step inside the current trace. Outside a trace it is recorded nowhere."""
    if span_type not in SPAN_TYPES:
        raise ValueError(f"span_type must be one of {sorted(SPAN_TYPES)}")
    parent = _current.get()
    t = _trace.get()
    s = Span(
        name,
        span_type,
        parent_id=parent.span_id if parent else None,
        inputs=inputs,
        attributes=dict(attributes or {}),
    )
    if t is not None and len(t.spans) < MAX_SPANS:
        t.spans.append(s)
    tok = _current.set(s)
    try:
        yield s
    except BaseException as e:
        s.record_error(e)
        raise
    finally:
        s.end_ns = _ns()
        _current.reset(tok)


def documents(items: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Retrieved chunks in MLflow's retriever format.

    Each becomes ``{page_content, metadata: {doc_uri, chunk_id, score}}``.
    """
    out = []
    for d in items:
        md = {k: d[k] for k in ("doc_uri", "chunk_id", "score") if k in d and d[k] is not None}
        md.update(dict(d.get("metadata") or {}))
        out.append(
            {
                "page_content": str(d.get("content", d.get("page_content", ""))),
                "metadata": md,
                **({"id": str(d["id"])} if "id" in d else {}),
            }
        )
    return out


# ------------------------------------------------------------------ OpenAI-compatible calls


@dataclass
class ChatReply:
    text: str
    usage: dict[str, int] | None
    model: str | None
    latency_ms: float


def chat(
    messages: Sequence[Mapping[str, str]],
    *,
    model: str,
    base_url: str | None = None,
    api_key: str | None = None,
    params: Mapping[str, Any] | None = None,
    timeout: float = 60.0,
    name: str = "chat_completion",
) -> ChatReply:
    """One OpenAI-compatible chat completion (vLLM, llama.cpp server, Ollama), recorded as a
    ``CHAT_MODEL`` span with the provider's reported usage. ``base_url`` defaults to
    ``OPENAI_BASE_URL``; the key to ``OPENAI_API_KEY``.
    """
    url = (base_url or os.environ.get("OPENAI_BASE_URL") or "").rstrip("/")
    if not url:
        raise ValueError("give base_url or set OPENAI_BASE_URL")
    key = api_key or os.environ.get("OPENAI_API_KEY")
    p = dict(params or {})
    body: dict[str, Any] = {
        "model": model,
        "messages": [dict(m) for m in messages],
        "stream": False,
        **p,
    }
    with span(
        name, "CHAT_MODEL", inputs={"messages": body["messages"], "model": model, "params": p}
    ) as s:
        s.set_attribute("ablationkit.llm.model", model)
        headers = {"content-type": "application/json"}
        if key:
            headers["authorization"] = f"Bearer {key}"
        req = urllib.request.Request(
            f"{url}/chat/completions",
            data=json.dumps(body).encode(),
            headers=headers,
            method="POST",
        )
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                j = json.loads(r.read(1024 * 1024 + 1))
        except urllib.error.HTTPError as e:
            raise RuntimeError(
                f"provider_error {e.code}: {e.read(500).decode(errors='replace')}"
            ) from e
        latency = (time.perf_counter() - t0) * 1000
        text = (((j.get("choices") or [{}])[0]).get("message") or {}).get("content")
        if not isinstance(text, str):
            raise RuntimeError("bad_response: no choices[0].message.content")
        u = j.get("usage") or {}
        usage = None
        if isinstance(u, dict) and any(
            isinstance(u.get(k), int)
            for k in ("prompt_tokens", "completion_tokens", "total_tokens")
        ):
            s.set_usage(u.get("prompt_tokens"), u.get("completion_tokens"), u.get("total_tokens"))
            usage = s.attributes["mlflow.chat.tokenUsage"]
        if isinstance(j.get("model"), str):
            s.set_attribute("ablationkit.llm.model", j["model"])
        s.set_outputs(text)
        return ChatReply(text=text, usage=usage, model=j.get("model"), latency_ms=latency)


# ------------------------------------------------------------------ golden sets and prompts


@dataclass(frozen=True)
class GoldenExample:
    example_id: str
    inputs: dict[str, Any]
    expectations: dict[str, Any] | None
    category: str | None


def _root(root: str | os.PathLike[str] | None) -> Path:
    if root is not None:
        return Path(root)
    here = Path.cwd()
    for d in (here, *here.parents):
        if (d / ".ablationkit").is_dir():
            return d
    return here


def golden_set(
    name: str, version: int | None = None, *, root: str | os.PathLike[str] | None = None
) -> list[GoldenExample]:
    """Examples of a golden-set version exported to ``.ablationkit/llm/golden-sets/`` (latest by
    default), checked against the export index's SHA-256. A held-out set carries inputs only.
    Sets ``ABLATIONKIT_GOLDEN_SET`` so traces recorded afterwards are tagged with the version.
    """
    base = _root(root) / ".ablationkit" / "llm" / "golden-sets"
    index = json.loads((base / "index.json").read_text())
    entries = [
        s
        for s in index.get("sets", [])
        if s.get("name") == name and (version is None or s.get("version") == version)
    ]
    if not entries:
        raise LookupError(
            f"no exported golden set {name}{f' v{version}' if version else ''}: "
            "export it from AblationKit first"
        )
    e = max(entries, key=lambda s: int(s["version"]))
    data = (base / e["path"]).read_bytes()
    if hashlib.sha256(data).hexdigest() != e["export_sha256"]:
        raise ValueError(
            f"{e['path']} does not match the export index; re-export it from AblationKit"
        )
    os.environ["ABLATIONKIT_GOLDEN_SET"] = f"{e['golden_set_id']}/{e['version']}"
    out = []
    for line in data.decode().splitlines():
        if line.strip():
            x = json.loads(line)
            out.append(
                GoldenExample(
                    x["example_id"], dict(x["inputs"]), x.get("expectations"), x.get("category")
                )
            )
    return out


def load_prompt(
    ref: str, *, root: str | os.PathLike[str] | None = None
) -> tuple[Any, dict[str, Any]]:
    """A pinned prompt from the checkout export: ``name/3``, ``name@alias`` (the alias as of the
    export) or ``name`` (latest). Returns ``(template, provenance)``; record the provenance on your
    trace (``trace(..., tags={"prompt": f"{p['name']}/{p['version']}"})``).
    """
    m = re.fullmatch(r"(?:prompts:/)?([^@/]+)(?:[@/]([A-Za-z0-9_.-]+))?", ref)
    if not m:
        raise ValueError(f"bad prompt reference {ref!r}")
    name, tail = m.group(1), m.group(2)
    doc = json.loads(
        (_root(root) / ".ablationkit" / "llm" / "prompts" / f"{name}.json").read_text()
    )
    versions = doc["versions"]
    alias = None
    if tail is None:
        v = max(int(k) for k in versions)
    elif tail.isdigit():
        v = int(tail)
    else:
        alias = tail
        if tail not in doc.get("aliases", {}):
            raise LookupError(
                f"prompt {name} had no alias {tail} when exported ({doc.get('exported_at')})"
            )
        v = int(doc["aliases"][tail])
    got = versions.get(str(v))
    if got is None:
        raise LookupError(f"prompt {name} has no exported version {v}")
    prov: dict[str, Any] = {
        "name": name,
        "version": v,
        "sha256": got["sha256"],
        "format": got["format"],
    }
    if alias:
        prov["alias"] = alias
        prov["alias_as_of"] = doc.get("exported_at")
    return got["template"], prov


def render(template: Any, variables: Mapping[str, Any]) -> list[dict[str, str]]:
    """Fill ``{{var}}`` placeholders; a text template becomes one user message.

    Raises ``KeyError`` on a missing variable.
    """
    missing: set[str] = set()

    def fill(s: str) -> str:
        def one(mm: re.Match[str]) -> str:
            v = variables.get(mm.group(1))
            if v is None:
                missing.add(mm.group(1))
                return ""
            return v if isinstance(v, str) else json.dumps(v)

        return _VAR.sub(one, s)

    msgs = (
        [{"role": str(m["role"]), "content": fill(str(m["content"]))} for m in template]
        if isinstance(template, list)
        else [{"role": "user", "content": fill(str(template))}]
    )
    if missing:
        raise KeyError(f"prompt variables not given: {sorted(missing)}")
    return msgs
