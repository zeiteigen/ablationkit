"""Fixture text classifier for Stage 13 (criteria 9, 9a, 10d).

A scikit-learn pipeline over one string column (TF-IDF, then logistic regression), saved with
``mlflow.sklearn.save_model`` in the default skops format, so inference picks the text adapter from
its signature (one string column). ``metadata.ablationkit`` names the task for the UI.
"""

import argparse
import tempfile
from pathlib import Path

import ablationkit_sdk as ak
import mlflow.sklearn
import pandas as pd
from mlflow.models import infer_signature
from sklearn.compose import ColumnTransformer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline

p = argparse.ArgumentParser()
p.add_argument("--data", required=True)
p.add_argument("--C", type=float, default=1.0)
args = p.parse_args()

df = pd.read_csv(args.data)
X, y = df[["text"]], df["label"]
rel = str(Path(args.data).resolve().relative_to(Path.cwd().resolve()))
ak.log_input(Path(args.data).stem, source=rel, path=args.data, split="train", version="v1")
ak.log_params({"task": "text", "C": args.C})
model = Pipeline(
    [
        ("tfidf", ColumnTransformer([("text", TfidfVectorizer(), "text")])),
        ("clf", LogisticRegression(C=args.C, max_iter=500)),
    ]
).fit(X, y)
ak.log_metrics({"train/accuracy": float(model.score(X, y))}, step=0)
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "model"
    mlflow.sklearn.save_model(
        model,
        out,
        signature=infer_signature(X, model.predict(X)),
        input_example=X.head(2),
        metadata={"ablationkit": {"task": "text_classification"}},
    )
    ak.log_model(out, "sentiment", step=0)
print("trained sentiment")
