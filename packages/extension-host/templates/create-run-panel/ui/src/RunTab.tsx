import type { RunSummary } from "@ablationkit/extension-sdk";
import {
  mountReact,
  Notice,
  Stat,
  Table,
  useCall,
  useHostContext,
} from "@ablationkit/extension-sdk/react";

function RunTab() {
  const ctx = useHostContext();
  const run = useCall<RunSummary>("runs.get", { run_id: ctx.run_id }, [ctx.run_id]);
  if (run.error) return <Notice kind="error">{run.error.message}</Notice>;
  if (!run.data) return <p>Loading…</p>;
  const metrics = Object.entries(run.data.metrics).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div data-testid="run-panel-tab">
      <Stat label="status" value={run.data.status ?? "?"} />
      <Stat label="metrics" value={metrics.length} />
      <Table columns={["metric", "latest"]} rows={metrics.map(([k, v]) => [k, String(v)])} />
    </div>
  );
}

void mountReact(RunTab);
