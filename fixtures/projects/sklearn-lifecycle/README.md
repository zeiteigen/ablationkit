# Fixture: scikit-learn model lifecycle

A standalone repository used by the Stage 12 end-to-end test (`bun run test:lifecycle`,
criteria 5–8). It has an `MLproject` with three entrypoints, `main` (iris classifier), `regress`
(ridge regression) and `text` (a TF-IDF sentiment classifier over one string column, used by the
Stage 13 inference test, `bun run test:inference`). `train.py` saves each model with `mlflow.sklearn.save_model` and reports it
with `ablationkit_sdk.log_model`, and records its dataset with `log_input`.

The environment needs `mlflow`, `scikit-learn` and `pandas` (see `python_env.yaml`); the test runs
it with the pinned MLflow sidecar's environment on `PATH`.

`data/iris.csv` is the scikit-learn iris dataset; `data/regression.csv` and `data/reviews.csv` are
generated deterministically (no randomness).
