import type { RunSummary } from "@ablationkit/extension-sdk";
import { mountReact, Table, useCall } from "@ablationkit/extension-sdk/react";

function Panel() {
  const runs = useCall<{ runs: RunSummary[] }>("runs.list", { limit: 10 });
  if (!runs.data) return <p>Loading…</p>;
  return (
    <Table
      columns={["run", "status"]}
      rows={runs.data.runs.map((r) => [r.run_name ?? r.run_id, r.status ?? ""])}
    />
  );
}

void mountReact(Panel);
