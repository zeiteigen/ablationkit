/** Shared UI primitives. */
import { Fragment, type MouseEvent, type ReactNode, useState } from "react";
import { ApiError, navigate } from "./api.ts";

function linkClick(e: MouseEvent<HTMLAnchorElement>): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return;
  const href = e.currentTarget.getAttribute("href");
  if (!href?.startsWith("/") || href.startsWith("/api/")) return;
  e.preventDefault();
  navigate(href);
}

export function Link(props: { to: string; children: ReactNode; className?: string | undefined }) {
  return (
    <a href={props.to} onClick={linkClick} className={props.className}>
      {props.children}
    </a>
  );
}

export type Tone = "ok" | "warn" | "err" | "info" | "neutral";

export function Badge(props: { tone?: Tone; children: ReactNode; title?: string | undefined }) {
  const t = props.tone && props.tone !== "neutral" ? ` ${props.tone}` : "";
  return (
    <span className={`badge${t}`} title={props.title}>
      {props.children}
    </span>
  );
}

export function Loading() {
  return <div className="muted small">Loading…</div>;
}

export function ErrorBox(props: { error: unknown; onRetry?: () => void }) {
  if (!props.error) return null;
  const e = props.error;
  const isApi = e instanceof ApiError;
  const msg = e instanceof Error ? e.message : String(e);
  let hint = "";
  if (isApi && e.code === "tracking_unavailable")
    hint =
      "MLflow is unavailable. Console logs and job state still work; tracking reads resume when the sidecar is back.";
  else if (isApi && e.code === "unauthenticated") hint = "Your session has ended. Sign in again.";
  return (
    <div className="banner err" role="alert">
      <strong>{isApi ? e.code : "Error"}</strong>: {msg}
      {hint ? <div className="small">{hint}</div> : null}
      {props.onRetry ? (
        <div>
          <button type="button" className="small" onClick={props.onRetry}>
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Empty(props: { children: ReactNode }) {
  return <div className="empty">{props.children}</div>;
}

/** Run an async action with busy/error state. */
export function useAction<A extends unknown[], R>(
  fn: (...a: A) => Promise<R>,
): { run: (...a: A) => Promise<R | undefined>; busy: boolean; error: unknown } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return {
    busy,
    error,
    run: async (...a: A) => {
      setBusy(true);
      setError(undefined);
      try {
        return await fn(...a);
      } catch (e) {
        setError(e);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
  };
}

export function KV(props: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {props.rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function Tabs(props: {
  items: readonly { id: string; label: string; to: string }[];
  active: string;
}) {
  return (
    <nav className="tabs" aria-label="Section">
      {props.items.map((t) => (
        <Link key={t.id} to={t.to} className={t.id === props.active ? "active" : ""}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
