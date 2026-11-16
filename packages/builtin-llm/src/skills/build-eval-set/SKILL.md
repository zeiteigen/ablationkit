---
name: build-eval-set
description: Build or extend a versioned golden set (evaluation dataset) for an AblationKit LLM, RAG or agent project through the ablationkit MCP tools - write examples with inputs, expectations, categories and edge cases as JSONL, create the set or a new version, and leave held-out sets to the researcher. Use when asked to create test cases, an eval set or golden examples, or to add failure cases to one.
---

# Build an evaluation set

You reach AblationKit through the `ablationkit` MCP server (`ablationkit mcp`, launched by your
harness); the `ablationkit-mcp` skill covers the session, argument shapes, paging and refusals.
Call `ablationkit_project` first; if there are no `ablationkit_*` tools, ask the researcher to add
the server.

A golden set version is an immutable JSONL file pinned by SHA-256. Changing a set means adding a
version. Each version is mirrored into an MLflow GenAI evaluation dataset.

## Tools

| Tool | Use it to |
| --- | --- |
| `ablationkit_read llm.golden_set.list` | see which sets exist (and which are held out) before making one |
| `ablationkit_read llm.golden_set.read` (`gs`) | a set's versions, hashes and notes |
| `ablationkit_read llm.golden_set.examples` (`gs`, `query: {"version": "2"}`) | the rows of a version, to start the next one from |
| `ablationkit_do llm.golden_set.create` / `ablationkit_do llm.golden_set.version` | create a set / add a version |
| `ablationkit_read llm.prompt.read` (`name`) | the variables a prompt needs, which `inputs` must fill |
| `ablationkit_read llm.evaluation.examples` (`le`), `ablationkit_read llm.trace.search` | failures worth turning into cases |
| `ablationkit_do research.add` | a note saying why the version changed (with `task_id` when on a task) |

## Write examples

One JSON object per line, in a file in the project checkout (e.g. `evals/golden.jsonl`):

```json
{"example_id": "refund", "inputs": {"question": "How long do refunds take?"}, "expectations": {"expected_response": "Refunds are issued within 5 business days.", "expected_facts": ["5 business days"], "expected_retrieved_context": ["faq.md#1"]}, "category": "billing"}
{"example_id": "money-back", "inputs": {"question": "Can I get my money back?"}, "expectations": {"expected_retrieved_context": ["faq.md#1"]}, "category": "billing", "edge_case": true}
```

- `inputs` names the prompt variables or the application's arguments (check them with
  `ablationkit_read llm.prompt.read`).
- `expectations` is ground truth: `expected_response`, `expected_facts`, `expected_retrieved_context`
  (`doc#chunk` or doc URIs). Leave it out rather than guess: scorers then report missing ground
  truth instead of a value.
- Use `category` for slices and `edge_case: true` for deliberately hard cases.
- Keep `example_id`s stable across versions so results compare example by example.

## Turn failures into cases

Failed rows of an evaluation (`ablationkit_read llm.evaluation.examples` with `le`) and error traces
(`ablationkit_read llm.trace.search` with `query: {"status": "error"}`) show inputs the set does not
cover yet. Copy the *inputs*; write expectations from the source of truth (the docs, the data),
never from a model's output. Mark the new rows `edge_case: true` and give them a `category`.

## Create or version

- New set: `ablationkit_do llm.golden_set.create` with `body: {"name": "faq-golden",
  "description": "support FAQ", "from_file": "evals/golden.jsonl"}` (`from_file` is relative to
  the checkout; `examples` takes the rows inline instead).
- New version: `ablationkit_do llm.golden_set.version` with `gs` (the set's name or ID) and
  `body: {"from_file": "evals/golden-v2.jsonl", "note": "two refund paraphrases"}`. A version is
  the whole set, not a diff: start the file from the current version's rows
  (`ablationkit_read llm.golden_set.examples`) and add to them.
- Check: `ablationkit_read llm.golden_set.read` and `ablationkit_read llm.golden_set.examples`
  (`gs: "faq-golden"`, `query: {"version": "2"}`); `ablationkit_read llm.golden_set.list` lists them.

## Held-out sets

A held-out set is the researcher's. You cannot create one or add versions to it
(`held_out_guarded`), and you do not see its expectations (only inputs). Do not try to reconstruct
them; propose new cases in a separate, non-held-out set and tell the researcher.

Project jobs read sets from `.ablationkit/llm/golden-sets/` (exported by the coordinator; held-out
sets carry inputs only) through `ablationkit_llm.golden_set("faq-golden")`.

Running an evaluation over the new version is the researcher's: see the `run-llm-evaluation`
skill.
