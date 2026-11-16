# result-comparison

A comparison view: the selected runs' shared metrics side by side, with the best value per metric marked.

```sh
ablationkit extension scaffold --template result-comparison --id my-result-comparison
ablationkit extension validate --path .ablationkit/extensions/my-result-comparison
```

Then build, review and approve it in Project settings → Extensions (an agent builds it with the `ablationkit_do extension.build` tool of `ablationkit mcp`).
