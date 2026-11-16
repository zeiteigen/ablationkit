import {
  mountReact,
  Notice,
  Stat,
  Table,
  useHost,
  useHostContext,
} from "@ablationkit/extension-sdk/react";
import { useEffect, useState } from "react";

interface Internals {
  contexts: number;
  mean_entropy_bits: number;
  top_contexts: {
    context: string;
    count: number;
    entropy_bits: number;
    top_next: [string, number][];
  }[];
}

function bar(bits: number): string {
  return "█".repeat(Math.max(1, Math.round(bits * 4)));
}

function InternalsTab() {
  const host = useHost();
  const ctx = useHostContext();
  const [data, setData] = useState<Internals>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    host
      .call<{ text?: string }>("artifacts.preview", {
        run_id: ctx.run_id,
        path: "model/internals.json",
      })
      .then((r) => setData(JSON.parse(r.text ?? "{}") as Internals))
      .catch((e: Error) => setError(`model/internals.json: ${e.message}`));
  }, [host, ctx.run_id]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) return <p>Loading…</p>;
  return (
    <div data-testid="ngram-internals">
      <Stat label="contexts" value={data.contexts} />
      <Stat
        label="mean next-token entropy"
        value={`${data.mean_entropy_bits} bits`}
        hint="lower: more predictable"
      />
      <Table
        columns={["context", "count", "entropy", "", "likely next"]}
        rows={data.top_contexts.map((c) => [
          JSON.stringify(c.context),
          c.count,
          c.entropy_bits,
          bar(c.entropy_bits),
          c.top_next.map(([t, k]) => `${JSON.stringify(t)}×${k}`).join(" "),
        ])}
      />
    </div>
  );
}

void mountReact(InternalsTab);
