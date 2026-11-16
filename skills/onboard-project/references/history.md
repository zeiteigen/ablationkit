# Bringing earlier runs and visualisations over

A repository being onboarded usually has history: run directories, training logs, result files,
plots, analysis scripts, notebooks. Onboarding brings it into AblationKit, so the researcher sees
past and new runs side by side, and every figure they relied on has a home.

## Earlier runs: import them

`ablationkit_run import` creates an MLflow run of the project from a run's own files, labelled
`import`: the runs list, the run page, the task and any report that cites it say it was imported,
from where, by whom, and that it did not run under AblationKit. It runs nothing and spends no
compute. One import per `source` (409 `already_imported` gives the existing run).

### 1. Inventory

For each earlier run, find in its files (read them, don't guess):

| Field | Where it usually is | If it is not there |
| --- | --- | --- |
| name | the run directory or `--model-name`/`--run-name` argument | the directory name |
| parameters | hyperparameter/config JSON or YAML dumped beside the run, the command line in a log | leave them out; never copy today's defaults |
| metric history | an events or metrics JSONL, a metadata file with a validation curve, `Step N: loss …` log lines, a CSV | no history: import params and artifacts only, and say so |
| times | start/end timestamps in metadata or logs | leave them out (file modification times are not run times) |
| status | "finished"/"completed" flags, a traceback or `oom` in the log | `FINISHED` only when the files say it finished; else `FAILED` or `KILLED` |
| commit | a commit recorded in metadata or the log | leave it out; don't infer it from dates |
| study and variant | which configuration the run is (the baseline, a variant, an LR) | no study; tag it instead |

Put the inventory in the plan: one line per run with its source, what it has, what it lacks, and
your recommendation. Scratch, debug and test runs (`overfit*`, `test*`, `tmp`) are the
researcher's call: list them and ask. Runs that crashed are worth importing as `FAILED` when they
say something (an OOM at a learning rate).

### 2. Write a history file when the run has none

`metrics_file` reads JSON lines with the ADR 0042 rules: nested values flatten to `a/b`, and
`metrics_format` names the step and time keys. If the run's history is already JSONL, point at
it. If it is in a metadata file or log lines, write a small converter that emits one JSON object
per point, **in a directory Git ignores** (check with `git check-ignore -q DIR`; the run's own
data directory often is), for example:

```python
# outputs/ak-import/convert.py: the run's own numbers, renamed, nothing derived or smoothed
import json, re, sys

run = sys.argv[1]
meta = json.load(open(f"outputs/{run}/metadata.json"))
with open(f"outputs/ak-import/{run}.jsonl", "w") as out:
    for v in meta.get("eval_history", []):
        out.write(
            json.dumps({"step": v["step"], "val/loss": v["loss"], "val/acc": v["accuracy"]}) + "\n"
        )
    for line in open(f"logs/{run}.log"):
        m = re.search(r"step (\d+) loss ([\d.]+)", line)
        if m:
            out.write(json.dumps({"step": int(m[1]), "train/loss": float(m[2])}) + "\n")
```

- Copy values exactly; keep the run's own step numbers; never interpolate, smooth, rescale or
  compute new metrics (a derived metric is analysis: a figure computes it from the runs, or a note states it).
- Use the same metric keys the new runs will log (instrumentation, step 6), so old and new runs
  chart together.
- Show the converter in the plan; run it with the researcher's go-ahead.

### 3. Import

```json
{
  "run_name": "resnet-baseline",
  "source": "outputs/resnet-baseline",
  "started_at": "2026-10-03T09:12:00Z",
  "ended_at": "2026-10-03T11:05:00Z",
  "status": "FINISHED",
  "params_files": ["outputs/resnet-baseline/config.json"],
  "metrics_file": "outputs/ak-import/resnet-baseline.jsonl",
  "artifact_paths": ["outputs/resnet-baseline/*.json", "outputs/resnet-baseline/*.png", "logs/resnet-baseline.log"],
  "study_id": "augmentation-ablation",
  "variant_id": "baseline",
  "task_id": "<onboarding task>"
}
```

- `source` is the run's directory (or its main file): one import per source.
- Artifacts: configs, logs, result files and per-run plots. Never checkpoints or datasets (the
  import skips files over 256 MiB, 1 GiB in all).
- Read `warnings` in the result: skipped keys, malformed lines, files left out, artifacts not
  uploaded. Report them.
- Check one run per kind of source: `ablationkit_read run.metrics` with `key` gives the history; compare
  its first and last points with the file.
- `ablationkit_read run.imports` lists what is imported, so a second session doesn't redo it.

## Visualisations: migrate each one explicitly

Inventory every visualisation the researcher uses, wherever it lives:

- image and HTML files (`*.png`, `*.svg`, `*.pdf`, `*.html`);
- plotting code (`matplotlib`, `plotly`, `seaborn` calls in analysis scripts and notebooks);
- dashboards (W&B, TensorBoard);
- **interactive tools in the source**: a web app (FastAPI, Flask, Streamlit, Gradio or Dash, with
  its static JS), a notebook with widgets, a TUI. Find them by their entry points
  (`[project.scripts]`, `app.py`, `static/`, `uvicorn`/`streamlit run` in docs or scripts) and go
  through each of their views: one inventory line per view.

Nothing is out of scope for not being a run output: a tool the researcher uses to look at
models, tokenizers, data or runs is exactly what onboarding should bring over. Every view gets a
destination, or a reason the researcher agrees to in the plan. For each, say what it shows, then
pick its destination:

| The figure shows | Destination | How |
| --- | --- | --- |
| a metric over steps for one run, or the same metric across runs (loss curves, an LR sweep, validation accuracy vs step for three models) | **AblationKit's own charts** | import (or log) the runs with that metric history; the run page charts it and Runs → Compare overlays runs; a study's page compares variants. Nothing to draw |
| a static figure about one run (sample outputs, an attention map, a confusion matrix) | **a run artifact** | `artifact_paths` on the import (or `ak.log_artifact` in new runs); the run page shows images |
| anything else drawn from runs' metrics, params, histories or artifacts: a metric against another metric or a param (a loss-vs-compute frontier, perplexity against temperature), a scatter, bars, a per-level profile, a table of statistics across runs, small multiples, a sample browser over artifacts | **a figure note** (ADR 0053) | `ablationkit_note add` with `type: figure` and a `figure.script` that reads the runs (`ak.runs.list`, `ak.runs.history`, `ak.artifacts.preview`) and draws with Plot or d3; the runs it draws as `evidence`; embedded in the notebook that argues its point (`research-task` skill, `references/writing.md`, "Figures"). No extension, no build |
| a table of each run's latest metrics, one row per variant | **the study page** | the ablation table, once the study's metric goals name those metrics; a figure only for what it lacks |
| an analysis that needs computation the runs do not hold (a histogram over a dataset, statistics recomputed from checkpoints) | **a job, or an extension** | run it as a tracked job that logs the result, then draw a figure from that run; or `python-analyzer` (the `author-extension` skill) when it must run on demand |
| an interactive tool's view that computes with the project's own code on demand (tokenize text through each tokenizer, show a model's internals for an input) | **an extension running in the project's environment** | the `author-extension` skill with `"python": {"environment": "project"}`: its Python imports the project's own package as of the current commit (data files under `ABLATIONKIT_CHECKOUT`), and a view (`react-python-demo`, `create-run-panel` or a project panel) sends the input and draws the result, like the original tool. Reuse the tool's own functions rather than reimplementing them. Generating from checkpoints is the same pattern (or, once they are logged as MLflow models, the `inference-demo` template) |
| an interactive tool's view over runs (a training monitor, a run browser, live loss charts) or one that launches training | **AblationKit itself** | run pages, Runs → Compare, and jobs replace it; say which page replaces which view |
| the output of an analysis script that recomputes something from data or checkpoints | **a job, then one of the above** | run the script as a tracked job (it then has provenance), its figures as artifacts; or, if the researcher prefers, attach the existing output files to the run they describe |

Rules:

- **Reproduce, don't redraw from memory.** A native chart comes from imported metrics; a
  figure's script and an extension compute from runs' data. Never draw a figure from numbers the
  files don't hold, and never re-plot a PNG by reading values off it.
- **Keep the originals.** Attaching the original image beside a native replacement lets the
  researcher check them against each other.
- **A plan line per figure**, and in the hand-back a table: figure → destination → where to find
  it (run, page, figure note or extension) → anything not migrated and why.
