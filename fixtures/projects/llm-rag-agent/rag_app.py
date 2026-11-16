"""A small RAG + tool-using support agent, instrumented with ablationkit_llm (criteria 10b, 10c).

    python rag_app.py GOLDEN_SET_NAME [MODEL] [--top-k N]

For each example of the exported golden set it records one trace: an AGENT root, a RETRIEVER span
(keyword overlap over docs/faq.md, with chunk IDs, scores, the index revision and the retrieval
configuration), a TOOL span for order questions (the first lookup of an odd order times out and is
retried), and a CHAT_MODEL span calling the OpenAI-compatible endpoint at
OPENAI_BASE_URL with the retrieved context. Each trace is tagged with its example ID, so a
GenAI evaluation can score these recorded traces against the golden set's expectations.
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

import ablationkit_llm as llm
import ablationkit_sdk

HERE = Path(__file__).resolve().parent
WORD = re.compile(r"[a-z0-9]+")
STOP = {"the", "a", "an", "is", "do", "does", "how", "what", "i", "my", "to", "of", "for", "in", "on", "can", "you", "and", "it", "be", "are", "with"}


def chunks() -> list[dict[str, str]]:
    text = (HERE / "docs" / "faq.md").read_text()
    paras = [p.strip() for p in text.split("\n\n") if p.strip() and not p.startswith("#")]
    return [{"doc_uri": "faq.md", "chunk_id": str(i + 1), "content": p} for i, p in enumerate(paras)]


def retrieve(question: str, k: int) -> list[dict[str, object]]:
    q = {w for w in WORD.findall(question.lower()) if w not in STOP}
    scored = []
    for c in chunks():
        words = set(WORD.findall(c["content"].lower()))
        overlap = len(q & words)
        if overlap:
            scored.append({**c, "score": round(overlap / max(len(q), 1), 3)})
    scored.sort(key=lambda d: (-float(d["score"]), int(str(d["chunk_id"]))))  # type: ignore[arg-type]
    return scored[:k]


_attempts: dict[int, int] = {}


def lookup_order(order: int) -> dict[str, object]:
    _attempts[order] = _attempts.get(order, 0) + 1
    if order % 2 == 1 and _attempts[order] == 1:
        raise TimeoutError(f"order service did not answer for order {order}")
    return {"order": order, "status": "shipped"}


def main(argv: list[str]) -> int:
    name = argv[1]
    model = argv[2] if len(argv) > 2 and not argv[2].startswith("--") else "tiny-rag"
    k = int(argv[argv.index("--top-k") + 1]) if "--top-k" in argv else 2
    run = ablationkit_sdk.init()
    revision = hashlib.sha256((HERE / "docs" / "faq.md").read_bytes()).hexdigest()[:12]
    run.log_params({"model": model, "top_k": k, "index_revision": revision})
    answered = 0
    for ex in llm.golden_set(name):
        q = str(ex.inputs["question"])
        with llm.trace("support_agent", inputs=ex.inputs, example_id=ex.example_id, tags={"index_revision": revision}) as t:
            with llm.span("retrieve", "RETRIEVER", inputs={"query": q, "top_k": k}) as s:
                hits = retrieve(q, k)
                s.set_outputs(llm.documents(hits))
                s.set_attribute("ablationkit.rag.index_revision", f"faq-{revision}")
                s.set_attribute("ablationkit.rag.config", {"retriever": "keyword-overlap", "top_k": k, "chunking": "paragraph"})
            m = re.search(r"order (\d+)", q)
            if m:
                order = int(m.group(1))
                for _ in range(2):
                    try:
                        with llm.span("lookup_order", "TOOL", inputs={"order": order}) as tool:
                            tool.set_outputs(lookup_order(order))
                        break
                    except TimeoutError:
                        continue
            context = "\n".join(f"[{h['doc_uri']}#{h['chunk_id']}] {h['content']}" for h in hits)
            reply = llm.chat(
                [
                    {"role": "system", "content": "Answer from the context. Be terse. Cite sources."},
                    {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {q}"},
                ],
                model=model,
                params={"temperature": 0},
            )
            t.set_outputs(reply.text)
            answered += 1
    run.log_metrics({"answered": answered})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
