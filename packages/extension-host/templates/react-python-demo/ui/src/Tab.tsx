import type { ExecutionView } from "@ablationkit/extension-sdk";
import {
  Button,
  mountReact,
  Notice,
  useHost,
  useHostContext,
} from "@ablationkit/extension-sdk/react";
import { useState } from "react";

function Tab() {
  const host = useHost();
  const ctx = useHostContext();
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ExecutionView>();
  const [error, setError] = useState<string>();
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setView(
        await host.runPython(
          "analyze",
          {},
          { refs: [{ kind: "run", id: ctx.run_id as string }], onProgress: setView },
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const lowest = view?.result?.data?.["lowest"] as { key: string; value: number } | undefined;
  return (
    <div data-testid="react-python-demo">
      <Button onClick={run} disabled={busy}>
        {busy ? "Running…" : "Analyze in Python"}
      </Button>
      {view ? <p>Status: {view.status}</p> : null}
      {view?.result ? <p data-testid="python-summary">{view.result.summary}</p> : null}
      {lowest ? (
        <p>
          Lowest: {lowest.key} = {lowest.value}
        </p>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </div>
  );
}

void mountReact(Tab);
