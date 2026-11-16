# Fixture: uninstrumented script

A standalone repository (its own `pyproject.toml` and `uv.lock`) used by the Stage 5 tests. The
script never imports AblationKit. Submit `python train.py --epochs 3` as a job with the metrics file
`outputs/metrics.jsonl` and the artifacts `outputs/*.json` (the web UI's launch dialog, or an agent's
`ablationkit_job submit` with `metrics_file` and `artifact_paths`).
