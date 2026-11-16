import type { RunSummary } from "@ablationkit/extension-sdk";
import { Button, mountReact, Table, useCall, useHost } from "@ablationkit/extension-sdk/react";
import { useState } from "react";

/** The metric this widget reports; change it for your project. */
const METRIC = "loss";

function Block() {
  const host = useHost();
  const runs = useCall<{ runs: RunSummary[] }>("runs.list", { limit: 10 });
  const [saved, setSaved] = useState(false);
  if (!runs.data) return <p>Loading…</p>;
  const rows = runs.data.runs
    .filter((r) => METRIC in r.metrics)
    .map((r) => [r.run_name ?? r.run_id, String(r.metrics[METRIC])]);
  return (
    <div data-testid="report-widget">
      <Table columns={["run", METRIC]} rows={rows} />
      <Button
        disabled={saved}
        onClick={async () =>
          setSaved(
            await host.saveSnapshot({
              title: `${METRIC} of recent runs`,
              table: { columns: ["run", METRIC], rows },
            }),
          )
        }
      >
        {saved ? "Saved to the report" : "Save snapshot to the report"}
      </Button>
    </div>
  );
}

void mountReact(Block);
