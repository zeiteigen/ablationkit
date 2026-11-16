# llm-rag-agent fixture

A support-FAQ RAG application with one tool, used by the Stage 14 LLM tests (criteria 10, 10a, 10b,
10c, 10e) and the LLM Skills. It needs no model download.

| File | What it is |
| --- | --- |
| `serve_llm.py` | A deterministic OpenAI-compatible server (`tiny-rag`, `tiny-rag-nousage`, `tiny-flaky`; judge mode). Stands in for vLLM, llama.cpp server or Ollama. |
| `rag_app.py` | The application, instrumented with `ablationkit_llm`: retrieval, a retried tool call and an LLM call per golden-set example. Run it as a job. |
| `golden.jsonl` | The golden set: questions, expected answers, expected facts and retrieved chunks, categories and an edge case; one example has no ground truth. |
| `evals/scorers.py` | A project scorer (`cites_source`). |
| `docs/faq.md` | The corpus; each paragraph is a chunk (`faq.md#N`). |

Start the model server with `python serve_llm.py 8765 &` (it prints `READY 8765`). Then:

1. Add the provider (id `fixture`, URL `http://127.0.0.1:8765/v1`, model `tiny-rag`) in the web UI's
   LLM settings.
2. Create the golden set `faq-golden` from `golden.jsonl` (an agent: `ablationkit_do llm.golden_set.create`
   with `{name: "faq-golden", from_file: "golden.jsonl"}`).
3. Run `python rag_app.py faq-golden` as a job with `OPENAI_BASE_URL=http://127.0.0.1:8765/v1` (the web
   UI's launch dialog, or an agent's `ablationkit_job submit` with `env`).
