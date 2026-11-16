# Tutorial: a React run tab

Build a run tab that shows the run's latest metrics. It needs no AblationKit source changes.
CI runs the blocks marked `ci: run` from a fresh checkout (`apps/cli/test/docs.test.ts`).

## 1. Scaffold

From the project checkout (a registered AblationKit project):

<!-- ci: run -->
```sh
ablationkit extension scaffold --template create-run-panel --id run-metrics --name "Run metrics"
ablationkit extension validate --path .ablationkit/extensions/run-metrics
```

This creates `.ablationkit/extensions/run-metrics/` with `manifest.json`, `ui/src/RunTab.tsx`
(the `run.tab`) and `ui/src/Panel.tsx` (a `project.panel`).

## 2. Read the view

```tsx
import type { RunSummary } from "@ablationkit/extension-sdk";
import { mountReact, Table, useCall, useHostContext } from "@ablationkit/extension-sdk/react";

function RunTab() {
  const ctx = useHostContext();                       // run_id comes from the host
  const run = useCall<RunSummary>("runs.get", { run_id: ctx.run_id }, [ctx.run_id]);
  if (!run.data) return <p>Loading…</p>;
  return <Table columns={["metric", "latest"]} rows={Object.entries(run.data.metrics)} />;
}
void mountReact(RunTab);
```

`runs.get` needs the `project.runs.read` capability, which the manifest requests. The view runs
in a sandboxed frame with no network, so `fetch` is blocked. Everything goes through
`host.call`, and the coordinator checks each call.

## 3. Build, review, approve

Open Project settings → Extensions → `run-metrics` and build it (an agent builds it with the
`ablationkit_do extension.build` tool of `ablationkit mcp`). A successful build is enabled as it is
built (ADR 0045; with `extensions.require_approval`, **Approve…** it first). The page shows the
source, a sandbox preview and what the build may do. Then open any run: it has a **Run metrics**
tab, and the panel has its own page in the project's navigation (Overview links to it).

## 4. Change it

Edit `RunTab.tsx` and build again. The approved build keeps running and the page shows
*active (an approved build); the checkout has changed since*. Review the diff, approve the new
build, or roll back to an earlier one from the same page.
