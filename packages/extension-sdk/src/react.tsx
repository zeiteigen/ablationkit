/**
 * React helpers for UI extensions: `mountReact(App)` connects to the host and renders `App` with
 * the host in context; `useHost()` and `useCall()` read it. A small curated component set
 * (`Stat`, `Table`, `Button`, `Notice`) matches the host's look; using it is optional.
 */
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { connect, type Host, type HostContext } from "./index.ts";

const HostCtx = createContext<Host | null>(null);

export function useHost(): Host {
  const h = useContext(HostCtx);
  if (!h) throw new Error("useHost() outside mountReact()");
  return h;
}

/** The host context, re-rendered when the host sends a new one. */
export function useHostContext(): HostContext {
  const host = useHost();
  const [ctx, setCtx] = useState(host.context);
  useEffect(() => host.onContext(setCtx), [host]);
  return ctx;
}

/** Call a bridge method when `deps` change: `{ data, error, loading }`. */
export function useCall<T>(
  method: string,
  params: Record<string, unknown> = {},
  deps: readonly unknown[] = [],
): { data: T | undefined; error: Error | undefined; loading: boolean } {
  const host = useHost();
  const [state, setState] = useState<{
    data: T | undefined;
    error: Error | undefined;
    loading: boolean;
  }>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller chooses when to refetch
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    host.call<T>(method, params).then(
      (data) => live && setState({ data, error: undefined, loading: false }),
      (error: Error) => live && setState({ data: undefined, error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [host, method, ...deps]);
  return state;
}

export async function mountReact(App: () => ReactNode): Promise<void> {
  const el =
    document.getElementById("root") ?? document.body.appendChild(document.createElement("div"));
  try {
    const host = await connect();
    document.documentElement.dataset["theme"] = host.context.theme;
    createRoot(el).render(
      <HostCtx.Provider value={host}>
        <App />
      </HostCtx.Provider>,
    );
  } catch (e) {
    el.textContent = `This extension could not start: ${(e as Error).message}`;
  }
}

// ---------------------------------------------------------------------------- curated components

export function Stat(props: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="ak-stat">
      <div className="ak-stat-label">{props.label}</div>
      <div className="ak-stat-value">{props.value}</div>
      {props.hint ? <div className="ak-stat-hint">{props.hint}</div> : null}
    </div>
  );
}

export function Table(props: {
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
}) {
  return (
    <table className="ak-table">
      <thead>
        <tr>
          {props.columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
          <tr key={i}>
            {r.map((v, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
              <td key={j}>{v}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Button(props: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className="ak-button" onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  );
}

export function Notice(props: { kind?: "info" | "error"; children: ReactNode }) {
  return <div className={`ak-notice ak-notice-${props.kind ?? "info"}`}>{props.children}</div>;
}
