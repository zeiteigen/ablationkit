---
name: run-llm-evaluation
description: Prepare, check and read GenAI evaluations in AblationKit through the ablationkit MCP tools - pinned prompt/model variants or a project's recorded traces over a golden-set version with built-in, judge and project scorers via mlflow.genai.evaluate - and generate the report. Use when asked to evaluate, benchmark or score an LLM, prompt, RAG pipeline or agent, or to compare two evaluations.
---

# Run an LLM evaluation

You reach AblationKit through the `ablationkit` MCP server (`ablationkit mcp`, launched by your
harness); the `ablationkit-mcp` skill covers the session, argument shapes, paging and refusals.
Call `ablationkit_project` first; if there are no `ablationkit_*` tools, ask the researcher to add
the server.

An evaluation pins everything before it runs: the golden-set version (SHA-256), each prompt
version (aliases resolved and recorded), provider, model and decoding parameters, each scorer
(judge model and a hash of its rubric; project scorers by file hash and commit), and the data
controls in force. Each variant is its own MLflow run with traces and assessments.

## Tools

| Tool | Use it to |
| --- | --- |
| `ablationkit_read llm.settings.read` | providers, locality, egress and capture the evaluation must respect |
| `ablationkit_read llm.golden_set.list`, `ablationkit_read llm.golden_set.read`, `ablationkit_read llm.golden_set.examples` | pick the set and version; check the examples fill the prompt's variables |
| `ablationkit_read llm.prompt.read`, `ablationkit_read llm.prompt.resolve` | pin each variant's prompt version |
| `ablationkit_job submit`, `ablationkit_read job.show`, `ablationkit_read run.show` | produce a recorded run to evaluate (`run:RUN_ID` variants) |
| `ablationkit_read llm.evaluation.list`, `ablationkit_read llm.evaluation.read`, `ablationkit_read llm.evaluation.examples`, `ablationkit_read llm.evaluation.compare`, `ablationkit_read llm.evaluation.log` | read evaluations |
| `ablationkit_read llm.trace.search` (`query: {"evaluation": "le-…"}`) | the traces behind the scores |
| `ablationkit_do llm.evaluation.report` | generate the report record |
| `ablationkit_do research.add`, `ablationkit_task complete` | your interpretation, and a task's outcome when the evaluation settles it |

Classical (`mlflow.evaluate`) evaluations of logged models are different records:
`ablationkit_read evaluation.list`, `ablationkit_read evaluation.show`, `ablationkit_read evaluation.examples`.

## Launching is the researcher's call

Evaluations spend model calls and can send golden-set rows to a provider (which needs an approved
egress configuration), so agents cannot launch them. The researcher launches one in the web UI
(LLM → Evaluations → New GenAI evaluation). Prepare the exact specification and check each part:

- `ablationkit_read llm.settings.read`: providers, locality, egress, capture, retention. A provider the
  data controls do not allow will be refused; say so instead of proposing it.
- `ablationkit_read llm.golden_set.read` (`gs: "faq-golden"`): the set and the version to pin;
  `ablationkit_read llm.golden_set.examples` (`query: {"version": "2"}`) to check that every example
  provides the prompt's variables (`ablationkit_read llm.prompt.read`).
- `ablationkit_read llm.prompt.resolve` (`query: {"ref": "faq-answer@champion"}`): what an alias pins.
- `ablationkit_read llm.evaluation.list`: an earlier evaluation on the same golden-set version, to
  compare against.

Then give the researcher, for example:

- **Dataset:** `faq-golden`, version 2.
- **Variants:** `champion` = `faq-answer@champion` (version 3), `local/llama3.2:3b`,
  temperature 0; `candidate` = `faq-answer/4`, same model and parameters.
- **Scorers:** `exact_match`, `expected_facts`, and a judge `correct` on `local/llama3.2:3b` with
  the rubric "Does the answer state the reference fact?".
- **Budget:** at most 200 calls.

To score what a project application recorded (for example a RAG job run over the golden set with
`ablationkit_llm`), the variant is the recorded run (`run:RUN_ID`). You can make that run:
`ablationkit_job submit` with the application's command, `runtime_max_sec`, `description` and `run_name`, then
`ablationkit_read job.show` until it ends and `ablationkit_read run.show` to confirm it synced and logged
traces (`ablationkit_read llm.trace.search` with `query: {"run_id": RUN_ID}`). Use retrieval scorers
(`retrieval_recall`, `has_citation`, a grounding judge). Project scorers
(`project:evals/scorers.py:FUNC`) run project code in the evaluation worker and need the
researcher's acknowledgement.

## Read the results

- `ablationkit_read llm.evaluation.read` (`le: "le-…"`): state, variants, scorers, aggregate results.
- `ablationkit_read llm.evaluation.examples` (`le`): every example aligned across variants, with each
  scorer's value and the trace; pick the failed rows and the regressions against the first variant.
- `ablationkit_read llm.evaluation.compare` (`query: {"a": "le-A", "b": "le-B"}`): paired only on the
  same golden-set version.
- `ablationkit_read llm.evaluation.log` (`le`) if it failed.
- `ablationkit_do llm.evaluation.report` (`le`): a research report linking prompts, traces and runs.
  On a research task, pass its ID as `report_id` to `ablationkit_task complete`; for failures,
  the `summarize-failures` skill.

When you report:

- Give the metric with its scorer and sample count; say when ground truth is missing.
- No significance test is computed for scorer feedback. Do not claim one.
- Judge verdicts are opinions of a named model with a named rubric.
- Tokens and latency only where reported; cost estimates with their rate source, as estimates.
- With more than one trial, report how many examples gave different outputs across trials.
