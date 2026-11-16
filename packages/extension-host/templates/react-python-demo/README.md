# react-python-demo

A run tab that runs the extension's own Python analysis on the run and shows its typed result.

```sh
ablationkit extension scaffold --template react-python-demo --id my-react-python-demo
ablationkit extension validate --path .ablationkit/extensions/my-react-python-demo
```

Then build, review and approve it in Project settings → Extensions (an agent builds it with the `ablationkit_do extension.build` tool of `ablationkit mcp`).

Python dependencies: `uv add PACKAGE` in `python/`, then commit `python/uv.lock`. Every dependency needs a wheel; source builds are refused.
