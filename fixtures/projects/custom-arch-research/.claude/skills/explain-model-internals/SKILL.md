---
name: explain-model-internals
description: Explain what this project's n-gram language model learned in a run, and compare tokenizers across runs, using the approved ngram-explorer extension and AblationKit's evidence APIs. Use when asked why one tokenizer or context length does better, or what a run's model "knows".
---

# Explain this project's model internals

This project trains a smoothed n-gram language model (`model.py`) with a project tokenizer
(`project_tokenizers.py`). Each run of `train.py` logs, through `ablationkit_sdk`:

- metrics: `val/bits_per_char` (per step), `tokens_per_char`, `vocab_size`;
- params: `tokenizer`, `context`, `steps`, `seed`;
- artifacts: `model/model_config.json`, and `model/internals.json` (per-context next-token
  entropy in bits, the most frequent contexts and their likely next tokens).

Work only through AblationKit's MCP tools (the `ablationkit` MCP server, `ablationkit mcp`); never
read MLflow or the coordinator's state directly.

1. Find the runs: `ablationkit_read research.show` with `record_id: tokenizer-ablation` (the study), or
   `ablationkit_read lineage` with `kind: run, id: <RUN_ID>`.
2. Compare tokenizers with the project's approved Python analysis:
   `ablationkit_do extension.run` with `extension_id: ngram-explorer, contribution: compare`, then
   `ablationkit_read extension.execution` until it finishes. It reads the runs through the
   capability broker and returns a table of bits per character and tokens per character per
   tokenizer. If it says `extension_inactive`, ask the researcher to approve `ngram-explorer` in
   Project settings → Extensions; you cannot approve it yourself.
3. For one run, the researcher can open the run's **Model internals** tab (the same extension):
   the table shows which contexts are still uncertain (high entropy) after training.
4. Explain with evidence: cite run IDs, the metric values and the execution ID from step 2.
   A lower mean entropy with a higher `tokens_per_char` means the tokenizer made each prediction
   easier but made more of them; bits per *character* is the fair comparison.
5. Record the explanation: `ablationkit_do research.add` with `kind: note`, a title, and
   `links: [{kind: run, id: <RUN_ID>}]`.

Do not change `.ablationkit/extensions/ngram-explorer/` to get a different answer; a changed
extension needs the researcher's new approval before it runs.
