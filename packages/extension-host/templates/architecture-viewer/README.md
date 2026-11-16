# architecture-viewer

A run tab that renders a model architecture from a JSON artifact the run logged (for example model_architecture.json: {name, children: [...]}).

```sh
ablationkit extension scaffold --template architecture-viewer --id my-architecture-viewer
ablationkit extension validate --path .ablationkit/extensions/my-architecture-viewer
```

Then build, review and approve it in Project settings → Extensions (an agent builds it with the `ablationkit_do extension.build` tool of `ablationkit mcp`).
