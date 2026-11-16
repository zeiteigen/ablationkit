---
name: compare-prompts
description: Compare prompt versions and model settings in an AblationKit LLM project through the ablationkit MCP tools - browse the MLflow Prompt Registry, diff versions, propose a new prompt version, and prepare a pinned side-by-side comparison on identical inputs for the researcher to run. Use when asked to improve, change or compare a prompt, system message, model or decoding parameters.
---

# Compare prompts and models

You reach AblationKit through the `ablationkit` MCP server (`ablationkit mcp`, launched by your
harness); the `ablationkit-mcp` skill covers the session, argument shapes, paging and refusals.
Call `ablationkit_project` first; if there are no `ablationkit_*` tools, ask the researcher to add
the server.

Prompts live in MLflow's Prompt Registry. Versions are immutable; aliases (`@champion`) move, so
every run pins an alias to its version and records both.

## Tools

| Tool | Use it to |
| --- | --- |
| `ablationkit_read llm.prompt.list`, `ablationkit_read llm.prompt.read`, `ablationkit_read llm.prompt.diff`, `ablationkit_read llm.prompt.resolve` | read prompts, versions and aliases |
| `ablationkit_do llm.prompt.version` | propose a new version |
| `ablationkit_read llm.settings.read` | which providers and models the data controls allow |
| `ablationkit_read llm.golden_set.list`, `ablationkit_read llm.golden_set.read` | the inputs to compare on, pinned to a version |
| `ablationkit_read llm.trace.search` (`query: {"prompt": "faq-answer"}`) | how the current version behaves, failures first |
| `ablationkit_read llm.evidence.list`, `ablationkit_read llm.evidence.read` | saved playground results |
| `ablationkit_read llm.evaluation.list`, `ablationkit_read llm.evaluation.examples`, `ablationkit_read llm.evaluation.compare` | recorded, scored comparisons |
| `ablationkit_do research.add` | record the proposal (`kind: "approach"`) and the result (`kind: "note"` or `"report"`) |

## Read

- `ablationkit_read llm.prompt.list`: prompts with their versions and aliases.
- `ablationkit_read llm.prompt.read` (`name: "faq-answer"`): versions, format, variables, aliases.
- `ablationkit_read llm.prompt.diff` (`name`, `query: {"from": "3", "to": "4"}`; `to_name` diffs
  against another prompt).
- `ablationkit_read llm.prompt.resolve` (`query: {"ref": "faq-answer@champion"}`): the pinned version.
- Before changing a prompt, look at where it fails: `ablationkit_read llm.trace.search` with
  `query: {"prompt": "faq-answer", "status": "error"}`, or the failed rows of its last evaluation
  (`ablationkit_read llm.evaluation.examples`).

## Propose a version

You may register a new version (it is tagged as agent-made). You may not move an alias: that
changes what `@champion` means for everyone, so the researcher does it in the web UI.

`ablationkit_do llm.prompt.version` with `body: {"name": "faq-answer", "template": …,
"commit_message": "cite sources inline"}`. `template` is text, or chat messages
(`[{"role": "system", "content": "…"}, {"role": "user", "content": "{{question}}"}]`).

Keep variables the golden set fills (`{{question}}`); a run refuses prompts whose variables an
example does not provide.

## Prepare the comparison

Running models spends calls and may send data to a provider, so the researcher launches it, in the
web UI (LLM → Playground for a quick side-by-side, LLM → Evaluations for a recorded, scored one;
see the `run-llm-evaluation` skill). Give them every variant pinned, for example:

| Variant | Prompt | Provider/model | Parameters |
| --- | --- | --- | --- |
| champion | `faq-answer@champion` (= version 3) | `local/llama3.2:3b` | temperature 0 |
| candidate | `faq-answer/4` | `local/llama3.2:3b` | temperature 0 |

on the same inputs (a golden set and version, from `ablationkit_read llm.golden_set.read`), with
providers and models that `ablationkit_read llm.settings.read` says are allowed. One sample
per example is not a reproduction: suggest 3 trials when outputs vary, and say that seeds are only
honoured if the provider supports them.

## Report

Read the result (`ablationkit_read llm.evidence.list` and `ablationkit_read llm.evidence.read` for saved
playground evidence, or `ablationkit_read llm.evaluation.examples` for an evaluation;
`ablationkit_read llm.evaluation.compare` with `query: {"a": "le-A", "b": "le-B"}` pairs two
evaluations on the same golden-set version) and report per variant: which examples changed,
tokens and latency where reported, and the cost estimate with its rate source, labelled as an
estimate. Record it with `ablationkit_do research.add` (a note, or a report citing the evaluation's
runs) and, if the researcher should move the alias, say so there.
