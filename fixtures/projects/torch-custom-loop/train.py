"""Custom training loop instrumented with ablationkit_sdk and ablationkit_pytorch.

The AblationKit packages are not dependencies of this repository: the job runner puts the
central install's SDK on PYTHONPATH (criterion 1). Outside AblationKit the calls are no-ops.
"""

from __future__ import annotations

import argparse
import logging

import torch
from torch import nn

import ablationkit_sdk as ak
from ablationkit_pytorch import TrainingLogger, log_model_info, log_optimizer, save_checkpoint
from model import CharTokenizer, GatedMixer

TEXT = "the quick brown fox jumps over the lazy dog. " * 20

parser = argparse.ArgumentParser()
parser.add_argument("--steps", type=int, default=30)
parser.add_argument("--no-gate", action="store_true")
parser.add_argument("--seed", type=int, default=0)
args = parser.parse_args()

logging.basicConfig(level=logging.INFO)
logging.getLogger().addHandler(ak.LoggingHandler())
log = logging.getLogger("train")

torch.manual_seed(args.seed)
tok = CharTokenizer(TEXT)
data = torch.tensor(tok.encode(TEXT))
model = GatedMixer(len(tok), gate=not args.no_gate)
opt = torch.optim.Adam(model.parameters(), lr=3e-3)
loss_fn = nn.CrossEntropyLoss()

ak.log_params({"steps": args.steps, "gate": not args.no_gate, "seed": args.seed, "vocab": len(tok)})
ak.set_tags({"variant": "no-gate" if args.no_gate else "gated"})
log_model_info(model)
log_optimizer(opt)
tl = TrainingLogger(optimizer=opt, log_every=5)

seq = 32
for step in range(args.steps):
    i = (step * 7) % (len(data) - seq - 1)
    x = data[i : i + seq].unsqueeze(0)
    y = data[i + 1 : i + seq + 1].unsqueeze(0)
    logits = model(x)
    loss = loss_fn(logits.view(-1, len(tok)), y.view(-1))
    opt.zero_grad()
    loss.backward()
    opt.step()
    tl.on_step(step, loss=loss.item())
    if step % 10 == 0:
        print(f"step {step} loss {loss.item():.4f}", flush=True)

with torch.no_grad():
    logits = model(data[:-1].unsqueeze(0))
    val = loss_fn(logits.view(-1, len(tok)), data[1:]).item()
tl.on_epoch_end(0, **{"val/loss": val})
log.info("finished: val loss %.4f", val)
save_checkpoint("outputs/model.pt", model, opt, step=args.steps)
ak.log_dict({"val_loss": val, "vocab": tok.vocab}, "summary.json")
print("done", flush=True)
