"""Fixture vision project for Stage 13 (criterion 10d): an 8×8 handwritten-digit classifier.

It trains on ``data/digits_train.csv`` (scikit-learn's bundled digits, 64 pixel columns valued 0–16
and a ``label``), logs the dataset, metrics, a confusion-matrix image and the model through the
AblationKit SDK, and saves the model with ``mlflow.sklearn.save_model`` (skops) plus
``metadata.ablationkit.image``: the image adapter AblationKit uses to turn an uploaded picture
(dark ink on a light background) into the model's 64 pixel columns.
"""

import argparse
import tempfile
from pathlib import Path

import ablationkit_sdk as ak
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import mlflow.sklearn
import pandas as pd
from mlflow.models import infer_signature
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import ConfusionMatrixDisplay

p = argparse.ArgumentParser()
p.add_argument("--C", type=float, default=1.0)
args = p.parse_args()

train = pd.read_csv("data/digits_train.csv")
test = pd.read_csv("data/digits_test.csv")
X, y = train.drop(columns=["label"]), train["label"]
Xt, yt = test.drop(columns=["label"]), test["label"]
for split, path in (("train", "data/digits_train.csv"), ("test", "data/digits_test.csv")):
    ak.log_input(
        "digits",
        source=path,
        path=path,
        split=split,
        version="sklearn-1797",
        context="training" if split == "train" else "validation",
    )
ak.log_params({"task": "image_classification", "C": args.C, "image_size": "8x8"})
model = LogisticRegression(C=args.C, max_iter=3000).fit(X, y)
acc = float(model.score(Xt, yt))
ak.log_metrics({"val/accuracy": acc}, step=0)
with tempfile.TemporaryDirectory() as tmp:
    fig, ax = plt.subplots(figsize=(5, 5))
    ConfusionMatrixDisplay.from_estimator(model, Xt, yt, ax=ax, colorbar=False)
    png = Path(tmp) / "confusion_matrix.png"
    fig.savefig(png, dpi=80)
    ak.log_artifact(png, "plots")
    out = Path(tmp) / "model"
    mlflow.sklearn.save_model(
        model,
        out,
        signature=infer_signature(X, model.predict(X)),
        metadata={
            "ablationkit": {
                "task": "image_classification",
                "image": {
                    "height": 8,
                    "width": 8,
                    "mode": "L",
                    "invert": True,
                    "value_range": [0, 16],
                },
                "labels": {str(i): f"digit {i}" for i in range(10)},
            }
        },
    )
    ak.log_model(out, "digits-logreg", step=0)
print(f"trained digits-logreg accuracy={acc:.3f}")
