"""A plain training script: prints progress, writes metrics as JSON lines and an output file.

It does not import AblationKit. The job runner captures its console output, tails
outputs/metrics.jsonl (the metrics file adapter) and collects outputs/* as artifacts.
"""

import argparse
import json
import math
import random
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--epochs", type=int, default=3)
parser.add_argument("--lr", type=float, default=0.1)
parser.add_argument("--fail", action="store_true", help="exit non-zero after training")
args = parser.parse_args()

out = Path("outputs")
out.mkdir(exist_ok=True)
random.seed(0)
w = 0.0
with (out / "metrics.jsonl").open("w") as metrics:
    for epoch in range(1, args.epochs + 1):
        # Fit w to 2.0 by gradient descent on (w - 2)^2.
        grad = 2 * (w - 2.0)
        w -= args.lr * grad
        loss = (w - 2.0) ** 2
        print(f"epoch {epoch}/{args.epochs} loss={loss:.6f} w={w:.4f}", flush=True)
        print(f"debug: grad={grad:.4f}", file=sys.stderr, flush=True)
        metrics.write(json.dumps({"step": epoch, "loss": loss, "w": w}) + "\n")
        metrics.flush()

(out / "model.json").write_text(json.dumps({"w": w, "rmse": math.sqrt(loss)}) + "\n")
print("done", flush=True)
sys.exit(3 if args.fail else 0)
