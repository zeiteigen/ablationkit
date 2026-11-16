# inference-demo

An interactive model demo: a form, a prediction through the inference bridge, and an explicit save as evidence. Set the allowed model in capability_config.

```sh
ablationkit extension scaffold --template inference-demo --id my-inference-demo
ablationkit extension validate --path .ablationkit/extensions/my-inference-demo
```

Then build, review and approve it in Project settings → Extensions (an agent builds it with the `ablationkit_do extension.build` tool of `ablationkit mcp`).

Pass `--model NAME@ALIAS` (or `m-…`, `NAME/VERSION`) to `scaffold` to set the allowlisted model.
