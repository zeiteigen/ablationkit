import { mountReact, Notice, useHost, useHostContext } from "@ablationkit/extension-sdk/react";
import { type ReactNode, useEffect, useState } from "react";
import { type ArchNode, countParams } from "./tree.ts";

/** The artifact this view looks for; change it to match what your training script logs. */
const ARTIFACT = "model_architecture.json";

function Node(props: { n: ArchNode; depth: number }): ReactNode {
  return (
    <div style={{ marginLeft: props.depth * 16 }}>
      <span data-testid="arch-node">{props.n.name}</span>
      {props.n.type ? <span style={{ opacity: 0.7 }}> · {props.n.type}</span> : null}
      {props.n.params !== undefined ? (
        <span style={{ opacity: 0.7 }}> · {props.n.params} params</span>
      ) : null}
      {(props.n.children ?? []).map((c, i) => (
        <Node key={`${i}-${c.name}`} n={c} depth={props.depth + 1} />
      ))}
    </div>
  );
}

function Architecture() {
  const host = useHost();
  const ctx = useHostContext();
  const [tree, setTree] = useState<ArchNode>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    host
      .call<{ text?: string }>("artifacts.preview", { run_id: ctx.run_id, path: ARTIFACT })
      .then((r) => setTree(JSON.parse(r.text ?? "{}") as ArchNode))
      .catch((e: Error) => setError(`${ARTIFACT}: ${e.message}`));
  }, [host, ctx.run_id]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!tree) return <p>Loading…</p>;
  return (
    <div data-testid="architecture">
      <p>{countParams(tree)} parameters in total</p>
      <Node n={tree} depth={0} />
    </div>
  );
}

void mountReact(Architecture);
