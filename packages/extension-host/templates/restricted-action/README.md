# restricted-action

A project action that runs one allowlisted coordinator operation (here: create a note). Actions cannot run shell commands or call internal or MLflow APIs.

```sh
ablationkit extension scaffold --template restricted-action --id my-restricted-action
ablationkit extension validate --path .ablationkit/extensions/my-restricted-action
```

Then build, review and approve it in Project settings → Extensions (an agent builds it with the `ablationkit_do extension.build` tool of `ablationkit mcp`).
