# Fixture: custom architecture research (stdlib only)

A standalone repository for criterion 1a: a project-defined tokenizer (`project_tokenizers.py`), a
project-defined model (`model.py`, a smoothed n-gram language model) and a hand-written training
loop (`train.py`) instrumented with `ablationkit_sdk`. No dependencies, no `pyproject.toml`: the
job runs with `python3`, and the AblationKit runner provides the SDK from the central install.

An agent, through `ablationkit mcp`: `ablationkit_run study` (`study_id: tokenizer-ablation`,
variants `char` and `pairs`, baseline `char`, goal `val/bits_per_char: min`), then one
`ablationkit_job submit` per variant (`command: ["python3", "train.py", "--tokenizer", "char"]`,
`study_id`, `variant_id`, `environment: "none"`, `runtime_max_sec`), then
`ablationkit_do report.generate` for the study. The researcher can do the same from the web UI.

Metrics are arbitrary project metrics (`val/bits_per_char`, `tokens_per_char`, `vocab_size`),
and the model config and samples are logged as artifacts.

## Project-specific tooling (criterion 1b)

- `.ablationkit/extensions/ngram-explorer/`: a project extension with a run tab (**Model
  internals**, from the run's `model/internals.json`) and a Python analysis (`compare`) that
  compares tokenizers across runs. It runs only after the researcher approves it.
- `.claude/skills/explain-model-internals/SKILL.md`: a project Agent Skill telling an agent how to
  explain the model's internals with that extension and AblationKit's evidence APIs.

Neither is part of AblationKit: everything specific to this model lives in this repository.
