# report-widget

A report block that summarizes recent runs and saves a static snapshot into the report (it stays legible if the extension is removed).

```sh
ablationkit extension scaffold --template report-widget --id my-report-widget
ablationkit extension validate --path .ablationkit/extensions/my-report-widget
```

Then build, review and approve it in Project settings → Extensions (an agent builds it with the `ablationkit_do extension.build` tool of `ablationkit mcp`).
