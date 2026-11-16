# python-analyzer

A Python analysis over the project's runs: a table and metrics, no run reference needed.

```sh
ablationkit extension scaffold --template python-analyzer --id my-python-analyzer
ablationkit extension validate --path .ablationkit/extensions/my-python-analyzer
```

Then build, review and approve it in Project settings → Extensions (an agent builds it with the `ablationkit_do extension.build` tool of `ablationkit mcp`).

Python dependencies: `uv add PACKAGE` in `python/`, then commit `python/uv.lock`. Every dependency needs a wheel; source builds are refused.
