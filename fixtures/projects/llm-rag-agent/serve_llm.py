"""A deterministic OpenAI-compatible chat server for tests (stdlib only).

    python serve_llm.py [PORT]      # prints "READY <port>" once listening

It stands in for vLLM, llama.cpp server or Ollama: ``POST /v1/chat/completions`` and
``GET /v1/models``. The "model" is a rule-based FAQ answerer, so outputs are reproducible:

* ``tiny-rag`` answers from ``docs/faq.md`` by keyword overlap and reports token usage. A system
  prompt containing "terse" gives the bare fact; otherwise it adds a friendly sentence. When the
  user message carries a ``Context:`` block it cites the best chunk as ``[doc#chunk]``.
* ``tiny-rag-nousage`` answers the same but reports no usage (usage stays missing).
* ``tiny-flaky`` fails with HTTP 500 on any question containing "flaky".
* A system prompt containing "evaluator" makes it a judge: "yes" when the answer shares a key word
  with the reference answer or the retrieved passages, else "no", then a one-line rationale.

Seeds and temperature are accepted and ignored: identical requests give identical answers.
"""

from __future__ import annotations

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORD = re.compile(r"[a-z0-9]+")
STOP = {
    "the",
    "a",
    "an",
    "is",
    "do",
    "does",
    "how",
    "what",
    "i",
    "my",
    "to",
    "of",
    "for",
    "in",
    "on",
    "can",
    "you",
    "and",
    "it",
    "be",
    "are",
    "with",
    "your",
    "me",
    "long",
    "when",
    "which",
}


def chunks() -> list[tuple[str, str]]:
    """``(chunk_id, text)`` for each paragraph of the FAQ."""
    text = (HERE / "docs" / "faq.md").read_text()
    paras = [p.strip() for p in text.split("\n\n") if p.strip() and not p.startswith("#")]
    return [(str(i + 1), p) for i, p in enumerate(paras)]


def words(s: str) -> set[str]:
    return {w for w in WORD.findall(s.lower()) if w not in STOP}


def best_chunk(question: str) -> tuple[str, str] | None:
    q = words(question)
    scored = sorted(
        ((len(q & words(t)), cid, t) for cid, t in chunks()), key=lambda x: (-x[0], int(x[1]))
    )
    return (scored[0][1], scored[0][2]) if scored and scored[0][0] > 0 else None


def answer(messages: list[dict[str, str]]) -> str:
    system = " ".join(m["content"] for m in messages if m["role"] == "system").lower()
    user = "\n".join(m["content"] for m in messages if m["role"] == "user")
    if "evaluator" in system:
        ans = user.split("Answer:", 1)[-1].split("\n\n")[0]
        ref = user.split("Reference answer:", 1)[1] if "Reference answer:" in user else ""
        ctx = (
            user.split("Retrieved passages:", 1)[1].split("\n\nInputs:")[0]
            if "Retrieved passages:" in user
            else ""
        )
        support = words(ref) | words(ctx)
        shared = sorted(words(ans) & support)
        if shared:
            return f"yes\nThe answer is supported ({', '.join(shared[:3])})."
        return "no\nThe answer is not supported by the reference or the passages."
    question = user.split("Question:", 1)[-1] if "Question:" in user else user
    hit = best_chunk(question)
    if hit is None:
        return "I don't know."
    cid, text = hit
    fact = text.split(". ")[0].rstrip(".") + "."
    cite = f" [faq.md#{cid}]" if "Context:" in user else ""
    if "terse" in system:
        return f"{fact}{cite}"
    return f"Happy to help! {fact}{cite}"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:  # quiet
        pass

    def send(self, code: int, body: dict[str, object]) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path.rstrip("/").endswith("/models"):
            self.send(
                200,
                {
                    "object": "list",
                    "data": [
                        {"id": m, "object": "model"}
                        for m in ("tiny-rag", "tiny-rag-nousage", "tiny-flaky")
                    ],
                },
            )
        else:
            self.send(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self.send(404, {"error": {"message": "not found"}})
            return
        req = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        model = req.get("model", "")
        messages = req.get("messages") or []
        if model not in ("tiny-rag", "tiny-rag-nousage", "tiny-flaky"):
            self.send(404, {"error": {"message": f"model {model} not found"}})
            return
        user = " ".join(m.get("content", "") for m in messages if m.get("role") == "user")
        if model == "tiny-flaky" and "flaky" in user.lower():
            self.send(500, {"error": {"message": "upstream overloaded"}})
            return
        text = answer(messages)
        body: dict[str, object] = {
            "id": "chatcmpl-fixture",
            "object": "chat.completion",
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                }
            ],
        }
        if model != "tiny-rag-nousage":
            p = sum(len(m.get("content", "").split()) for m in messages)
            c = len(text.split())
            body["usage"] = {"prompt_tokens": p, "completion_tokens": c, "total_tokens": p + c}
        self.send(200, body)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"READY {srv.server_address[1]}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
