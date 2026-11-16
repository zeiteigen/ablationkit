# Instrumentation paths

Pick the first path that captures what the researcher needs. Every path keeps the script
runnable without AblationKit.

## What every job gets for free

Without any code change, the runner captures:

- console output (stdout, stderr), streamed and kept even while MLflow is down;
- exit status, duration, `oom_killed` and `timed_out`;
- the source commit and dirty flag, the hostname, and the Python and SDK versions. A run is
  **dirty** when the repository has modified, staged or untracked files when it starts; the
  project's `.ablationkit/` never counts. Instrumentation you have not committed makes the smoke
  run dirty;
- files matching the job's `artifact_paths` globs, collected after exit;
- files matching its `input_paths` globs, recorded as `inputs/<path>` as the job starts (up to
  16 MiB each, jobs on this machine only): use it for configs the source commit does not hold,
  such as ones in an ignored directory, so the run records exactly what it was given;
- an MLflow run in `ak/<project-id>` tagged with job, attempt and, if given, study and variant.

Parameters are **not** inferred from the command line. Use the SDK (path B) when params must be
queryable.

## A. Metrics file (no SDK)

The collector tails a JSON-lines file while the job runs. Each line is one JSON object:

```json
{"step": 3, "train/loss": 0.412, "val/acc": 0.871}
```

- `step` (integer) is optional; without it, the line number is used.
- `timestamp` is optional (milliseconds, or seconds when below 1e11); without it, the read time
  is used.
- Nested objects are flattened, keys joined with `/`: `{"val": {"bpb": 1.2}}` logs `val/bpb`.
- Every other key with a finite number is a metric. Strings, booleans and arrays are ignored, so
  event lines with no numbers (a `"type": "checkpoint"` line) log nothing.
- Malformed lines are skipped, with a `system` console note.
- `metrics_file` and the `artifact_paths` globs are resolved against the **checkout root** (not
  the job's `cwd`), and must stay inside the checkout. Write the file fresh per run: the collector
  restarts from 0 if the file shrinks.

### A project that already writes JSONL

Check its lines before writing any code. If the step and time have other names, say so with
`metrics_format` on `ablationkit_job submit` instead of changing the project:

```json
{
  "metrics_file": "data/models/smoke/events.jsonl",
  "metrics_format": {"step_keys": ["global_step", "validation/global_step"], "timestamp_key": "time"}
}
```

- `step_keys` are tried in order; nested keys by their flattened name. The step and time keys are
  never logged as metrics.
- Point `metrics_file` at the path the script writes for this run (pass it on the command line
  if the script takes one, e.g. `--events-file`).
- Check the smoke run's metrics with `ablationkit_read run.metrics`: the keys you expect, at the steps
  you expect.

If the project writes something further off (a CSV, prose log lines), the smallest change is a
few lines where it already logs:

```python
import json, os

_metrics = open(os.environ.get("METRICS_JSONL", "outputs/metrics.jsonl"), "w")


def log_metrics(step, **values):  # call where the loss is already printed
    _metrics.write(json.dumps({"step": step, **values}) + "\n")
    _metrics.flush()
```

Submit with `metrics_file: "outputs/metrics.jsonl"`. Flush after each line, or the metrics only
appear at exit.

## B. Guarded SDK calls

`ablationkit_sdk` is put on `PYTHONPATH` by the runner (stdlib only; the project must **not** add
it as a dependency or copy it). Inside a job it sends params, metrics, tags and artifacts. If the
module is importable outside a job, every call is a no-op with one warning; but outside
AblationKit it is usually not importable at all, so guard the import:

```python
try:
    import ablationkit_sdk as ak
except ImportError:  # running outside AblationKit
    ak = None

if ak:
    ak.log_params({"lr": args.lr, "batch_size": args.batch_size, "model": args.model})

for step, batch in enumerate(loader):
    loss = train_step(batch)
    if ak and step % log_every == 0:
        ak.log_metrics({"train/loss": float(loss)}, step=step)

if ak:
    ak.log_metrics({"val/loss": val_loss, "val/acc": val_acc}, step=step)
    ak.log_artifact("outputs/config.json", artifact_path="config")
```

Other calls: `ak.log_param`, `ak.log_metric`, `ak.set_tags` (keys starting with `ablationkit.` or
`mlflow.` are refused), `ak.log_dict(obj, "summary.json")`, `ak.log_text(text, "notes.txt")`,
`ak.LoggingHandler()` for Python `logging`, and `with ak.epoch(n):`.

For PyTorch loops, `ablationkit_pytorch` is also on the path. It is duck-typed and imports torch
only when saving:

```python
try:
    from ablationkit_pytorch import log_model_info, log_optimizer, grad_norm, save_checkpoint
except ImportError:
    log_model_info = None
```

It provides `log_model_info(model)` (parameter counts), `log_optimizer(opt)`, `grad_norm(model)`
and `save_checkpoint(...)`.

Guidelines:

- Log params once, at start, with the values actually used (after config resolution).
- Metric names: `split/name` (`train/loss`, `val/acc`). Use the same names across variants, or
  studies can't compare them.
- Log the evaluation metrics the study's goals refer to under exactly those names.
- Pass `float(...)`, not tensors.
- Log every N steps in tight loops.
- Artifacts: configs, small result files and plots. Large checkpoints only if the researcher asks
  (they go to MLflow's artifact store).

## C. Project already uses MLflow, W&B or TensorBoard

- Leave it in place. Add path A or B alongside it, so AblationKit has its own copy of the metrics
  the study compares.
- Don't set `MLFLOW_TRACKING_URI` to AblationKit's MLflow. It is a private, coordinator-owned
  sidecar, and the project's own `mlflow.start_run()` would create runs AblationKit does not map
  to jobs.
- Historical runs:
  - W&B, TensorBoard and external `mlruns/` history is **not imported** by AblationKit today.
    Record key past results as untracked notes (see backfill.md), with a pointer to where they
    live.
  - The researcher can link an experiment that already exists in AblationKit's own MLflow,
    read-only (`ablationkit tracking import --project ID --experiment EXPERIMENT_ID`). It is not
    a migration tool for other servers.

## D. Hydra and other config systems

- Hydra changes the working directory per run, but `metrics_file` is a fixed path relative to
  the checkout root. Make the script write the metrics file to a fixed path inside the checkout
  (e.g. `os.environ.get("METRICS_JSONL", "<checkout>/outputs/metrics.jsonl")`, resolved before
  Hydra changes directory), or use the SDK (path B), which doesn't care about directories.
  Artifact globs are relative to the checkout too (`outputs/**/*.json`).
- Variant settings belong on the command line (`model=small lr=3e-4`). The study's variants then
  map one-to-one to override sets. Record the overrides in each variant's description.

## Checks before the smoke run

- `python -c "import ast,sys; ast.parse(open('train.py').read())"` or the project's own tests
  pass.
- The script still runs outside AblationKit (guarded imports).
- The diff is only instrumentation. Show it to the researcher.
