"""Hand-written training loop: stream batches into the model, evaluate bits per character."""

from __future__ import annotations

import argparse
import json
import math
import os
import random

import ablationkit_sdk as ak

from model import NGramLM
from project_tokenizers import make

CORPUS = (
    "the quick brown fox jumps over the lazy dog. "
    "a lazy dog sleeps while the quick fox runs. "
    "the dog and the fox are friends in the brown field. "
) * 6
VALIDATION = "the brown dog runs over the quick fox while the lazy fox sleeps. "


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokenizer", default="char")
    ap.add_argument("--context", type=int, default=2)
    ap.add_argument("--steps", type=int, default=6)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    random.seed(args.seed)

    tok = make(args.tokenizer)
    tok.fit(CORPUS)
    model = NGramLM(tok.vocab, context=args.context)
    ak.log_params(
        {"tokenizer": args.tokenizer, "context": args.context, "steps": args.steps, "seed": args.seed}
    )
    sentences = [s.strip() + "." for s in CORPUS.split(".") if s.strip()]
    for step in range(args.steps):
        batch = random.sample(sentences, k=min(4, len(sentences)))
        for s in batch:
            model.update(tok.encode(s + " "))
        val_tokens = tok.encode(VALIDATION)
        bpc = -model.logprob(val_tokens) / math.log(2) / len(VALIDATION)
        ak.log_metrics({"val/bits_per_char": bpc}, step=step)
        print(f"step {step} val/bits_per_char={bpc:.4f}", flush=True)
    ak.log_metrics(
        {
            "vocab_size": float(len(tok.vocab)),
            "tokens_per_char": len(tok.encode(VALIDATION)) / len(VALIDATION),
        }
    )
    os.makedirs("outputs", exist_ok=True)
    with open("outputs/model_config.json", "w") as f:
        json.dump(model.config(), f)
    ak.log_artifact("outputs/model_config.json", artifact_path="model")
    with open("outputs/internals.json", "w") as f:
        json.dump(model.internals(), f)
    ak.log_artifact("outputs/internals.json", artifact_path="model")
    print("done", flush=True)


if __name__ == "__main__":
    main()
