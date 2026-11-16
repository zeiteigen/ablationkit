import type { RunSummary } from "@ablationkit/extension-sdk";
import { mountReact, Table, useHost, useHostContext } from "@ablationkit/extension-sdk/react";
import { useEffect, useState } from "react";
import { sharedMetrics } from "./metrics.ts";

function Compare() {
  const host = useHost();
  const ctx = useHostContext();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  useEffect(() => {
    void Promise.all(
      (ctx.run_ids ?? []).map((id) => host.call<RunSummary>("runs.get", { run_id: id })),
    ).then(setRuns);
  }, [host, ctx.run_ids]);
  const keys = sharedMetrics(runs);
  return (
    <div data-testid="result-comparison">
      <Table
        columns={["metric", ...runs.map((r) => r.run_name ?? r.run_id)]}
        rows={keys.map((k) => [k, ...runs.map((r) => String(r.metrics[k]))])}
      />
    </div>
  );
}

void mountReact(Compare);
