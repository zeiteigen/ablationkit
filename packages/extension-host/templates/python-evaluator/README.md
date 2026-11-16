# python-evaluator

A Python evaluator for one run: reads the staged run, computes metrics, writes an artifact; results are logged to MLflow through the coordinator.

```sh
ablationkit extension scaffold --template python-evaluator --id my-python-evaluator
ablationkit extension validate --path .ablationkit/extensions/my-python-evaluator
```

Then build, review and approve it in Project settings → Extensions (an agent builds it with the `ablationkit_do extension.build` tool of `ablationkit mcp`).

Python dependencies: `uv add PACKAGE` in `python/`, then commit `python/uv.lock`. Every dependency needs a wheel; source builds are refused.
