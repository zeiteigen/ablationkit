import type { RunSummary } from "@ablationkit/extension-sdk";
import {
  mountReact,
  Notice,
  Table,
  useCall,
  useHostContext,
} from "@ablationkit/extension-sdk/react";
import { fmt } from "./format.ts";

function RunTab() {
  const ctx = useHostContext();
  const run = useCall<RunSummary>("runs.get", { run_id: ctx.run_id }, [ctx.run_id]);
  if (run.error) return <Notice kind="error">{run.error.message}</Notice>;
  if (!run.data) return <p>Loading…</p>;
  const metrics = Object.entries(run.data.metrics).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div data-testid="run-inspector">
      <h3>{run.data.run_name ?? run.data.run_id}</h3>
      <Table columns={["metric", "latest"]} rows={metrics.map(([k, v]) => [k, fmt(v)])} />
    </div>
  );
}

void mountReact(RunTab);
