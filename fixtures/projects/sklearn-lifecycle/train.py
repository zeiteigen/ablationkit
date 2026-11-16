"""Fixture training script for Stage 12 (criteria 5-8).

Trains a scikit-learn model, saves it as an MLflow model directory with
``mlflow.sklearn.save_model`` (no tracking server needed), and reports the dataset input and the
model through the AblationKit SDK. It needs mlflow, scikit-learn and pandas in the environment it
runs in; AblationKit injects the SDK.
"""

import argparse
import tempfile
from pathlib import Path

import ablationkit_sdk as ak
import mlflow.sklearn
import pandas as pd
from mlflow.models import infer_signature
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.model_selection import train_test_split

p = argparse.ArgumentParser()
p.add_argument("--task", choices=["classify", "regress"], required=True)
p.add_argument("--data", required=True)
p.add_argument("--C", type=float, default=1.0)
p.add_argument("--alpha", type=float, default=0.1)
args = p.parse_args()

df = pd.read_csv(args.data)
target = "target" if args.task == "classify" else "y"
X, y = df.drop(columns=[target]), df[target]
X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.3, random_state=0)

rel = str(Path(args.data).resolve().relative_to(Path.cwd().resolve()))
ak.log_input(
    Path(args.data).stem,
    source=rel,
    path=args.data,
    split="train",
    version="v1",
    profile={"num_rows": len(X_train)},
)
ak.log_input(Path(args.data).stem, source=rel, path=args.data, context="validation", split="val")

if args.task == "classify":
    ak.log_params({"task": "classify", "C": args.C})
    model = LogisticRegression(C=args.C, max_iter=500).fit(X_train, y_train)
    ak.log_metrics({"val/accuracy": float(model.score(X_val, y_val))}, step=0)
    name = "iris-logreg"
else:
    ak.log_params({"task": "regress", "alpha": args.alpha})
    model = Ridge(alpha=args.alpha).fit(X_train, y_train)
    ak.log_metrics({"val/r2": float(model.score(X_val, y_val))}, step=0)
    name = "ridge"

with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "model"
    mlflow.sklearn.save_model(
        model,
        out,
        signature=infer_signature(X_train, model.predict(X_train)),
        input_example=X_train.head(3),
    )
    ak.log_model(out, name, step=0)
print(f"trained {name}")
