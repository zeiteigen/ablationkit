# Fixture: custom PyTorch loop

A standalone repository with a project-defined tokenizer and model (`model.py`) and a hand-written
training loop instrumented with `ablationkit_sdk` and `ablationkit_pytorch`. Those packages are
not dependencies here: the AblationKit job runner provides them from the central install.

Run `python train.py --steps 30` as a job: from the web UI's launch dialog, or an agent's
`ablationkit_job submit` (with a `runtime_max_sec`).

Torch comes from the CPU wheel index (about 200 MB on first `uv sync`). The end-to-end test runs
only with `bun run test:torch`.
