/** Shared UI primitives. */
import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../api.ts";
import { linkClick } from "../router.ts";

export function Link(props: {
  to: string;
  children: ReactNode;
  className?: string | undefined;
  title?: string | undefined;
}) {
  return (
    <a href={props.to} onClick={linkClick} className={props.className} title={props.title}>
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

/** Compute status of a job attempt (spec ADR 0011 states). */
export function attemptTone(state: string | undefined): Tone {
  switch (state) {
    case "succeeded":
      return "ok";
    case "running":
    case "starting":
      return "info";
    case "queued":
      return "warn";
    case "failed":
    case "oom_killed":
    case "timed_out":
    case "unknown":
      return "err";
    case "cancelled":
      return "warn";
    default:
      return "neutral";
  }
}

/** MLflow run status. */
export function runTone(status: string | undefined): Tone {
  switch (status) {
    case "FINISHED":
      return "ok";
    case "RUNNING":
    case "SCHEDULED":
      return "info";
    case "FAILED":
      return "err";
    case "KILLED":
      return "warn";
    default:
      return "neutral";
  }
}

export function syncTone(state: string | undefined): Tone {
  if (state === "synced") return "ok";
  if (state === "failed" || state === "sync_failed") return "err";
  if (
    state === "pending" ||
    state === "tracking_pending" ||
    state === "awaiting_sync" ||
    state === "syncing"
  )
    return "warn";
  return "neutral";
}

/** Limits enforcement: never present advisory limits as enforced (spec §7.11). */
export function EnforcementBadge(props: {
  enforcement?: string | undefined;
  mode?: string | undefined;
  reason?: string | undefined;
}) {
  if (!props.enforcement) return null;
  return props.enforcement === "enforced" ? (
    <Badge tone="ok" title={props.reason}>
      limits enforced ({props.mode ?? "systemd"})
    </Badge>
  ) : (
    <Badge tone="warn" title={props.reason}>
      limits advisory{props.mode ? ` (${props.mode})` : ""}
    </Badge>
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

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [props.onClose]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes; Escape is handled on window
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="d-head">
          <h2>{props.title}</h2>
          <button type="button" className="small" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="d-body">{props.children}</div>
        {props.footer ? <div className="d-foot">{props.footer}</div> : null}
      </div>
    </div>
  );
}

/** Run an async action with busy/error state. */
export function useAction<A extends unknown[], R>(
  fn: (...a: A) => Promise<R>,
): { run: (...a: A) => Promise<R | undefined>; busy: boolean; error: unknown; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return {
    busy,
    error,
    clear: () => setError(undefined),
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

/**
 * Tabs, with the rarely used ones in a "More ▾" menu; when one of those is open, the menu's button
 * names it. `label` names the landmark ("Section" by default).
 */
export function Tabs(props: {
  items: readonly { id: string; label: string; to: string }[];
  active: string;
  more?: readonly { id: string; label: string; to: string }[];
  label?: string;
}) {
  const current = props.more?.find((m) => m.id === props.active);
  return (
    <nav className="tabs" aria-label={props.label ?? "Section"}>
      {props.items.map((t) => (
        <Link key={t.id} to={t.to} className={t.id === props.active ? "active" : ""}>
          {t.label}
        </Link>
      ))}
      {props.more?.length ? (
        <span className="more">
          <Menu label={current ? current.label : "More"} className={current ? "active" : ""}>
            {props.more.map((t) => (
              <Link key={t.id} to={t.to} className={t.id === props.active ? "active" : ""}>
                {t.label}
              </Link>
            ))}
          </Menu>
        </span>
      ) : null}
    </nav>
  );
}

/**
 * A button that opens a small menu of links or buttons below it (Tabs' "More ▾", a page's
 * "Export ▾"). It closes on a choice, a click elsewhere, Escape or scrolling.
 */
export function Menu(props: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const [at, setAt] = useState<{ top: number; right: number }>();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(undefined);
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [at]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={props.className}
        title={props.title}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        onClick={() => {
          const r = btn.current?.getBoundingClientRect();
          setAt(at || !r ? undefined : { top: r.bottom + 4, right: window.innerWidth - r.right });
        }}
      >
        {props.label} ▾
      </button>
      {at ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the items are links and buttons; a choice closes the menu
        <div
          ref={pop}
          className="menu-pop"
          role="menu"
          style={{ top: at.top, right: at.right }}
          onClick={() => setAt(undefined)}
        >
          {props.children}
        </div>
      ) : null}
    </>
  );
}

export function download(name: string, data: string | Blob, type = "text/plain"): void {
  const blob = typeof data === "string" ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- the page header (ADR 0055)

/** One step of a trail: a link, or the page the reader is on. */
export interface Crumb {
  label: ReactNode;
  to?: string | undefined;
}

/**
 * Where a page's object puts its name (the trail's last crumb) and its actions (the trail's right
 * end), and the project it belongs to; provided by the page that renders the trail.
 */
interface PageSlots {
  project?: string | undefined;
  leaf: HTMLElement | null;
  actions: HTMLElement | null;
}
const PageSlotsContext = createContext<PageSlots>({ leaf: null, actions: null });

/** The current project's name, for an object page's eyebrow. */
export function usePageProject(): string | undefined {
  return useContext(PageSlotsContext).project;
}

/** An object page names itself in the trail: "project › Runs › Studies › <this>". */
export function TrailLeaf(props: { children: ReactNode }) {
  const host = useContext(PageSlotsContext).leaf;
  return host
    ? createPortal(
        <>
          <span className="trail-sep">›</span>
          <span aria-current="page">{props.children}</span>
        </>,
        host,
      )
    : null;
}

/** A page's actions (Edit, Export ▾, Rename…), at the right of the trail. */
export function TrailActions(props: { children: ReactNode }) {
  const host = useContext(PageSlotsContext).actions;
  return host ? createPortal(props.children, host) : null;
}

/**
 * The trail at the top of every page, as on the vault's pages: where the reader is, from the
 * project down to the object, each step a link back; the page's actions at its right. Its landmark
 * is "Where you are", like the vault's.
 */
export function Trail(props: {
  crumbs: readonly Crumb[];
  /** Whether an object page below will add its own last crumb. */
  leaf?: boolean;
  project?: string | undefined;
  children?: ReactNode;
}) {
  const [leaf, setLeaf] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const n = props.crumbs.length;
  return (
    <PageSlotsContext.Provider value={{ project: props.project, leaf, actions }}>
      <nav className="trail" aria-label="Where you are">
        <div className="trail-path">
          {props.crumbs.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a path, in order
            <span key={i} className="crumb">
              {i ? <span className="trail-sep">›</span> : null}
              {c.to && (i < n - 1 || props.leaf) ? (
                <Link to={c.to}>{c.label}</Link>
              ) : (
                <span aria-current={props.leaf ? undefined : "page"}>{c.label}</span>
              )}
            </span>
          ))}
          {props.leaf ? <span className="crumb leaf" ref={setLeaf} /> : null}
        </div>
        <span className="trail-r" ref={setActions} />
      </nav>
      {props.children}
    </PageSlotsContext.Provider>
  );
}

/**
 * A page's head: the eyebrow (the project, or the kind of object), the title in the handwritten
 * face, a one-line lede, and anything that belongs with them (badges, a meta line).
 */
export function PageHead(props: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  titleTestId?: string;
}) {
  return (
    <header className="ph">
      {props.eyebrow ? <div className="eyebrow">{props.eyebrow}</div> : null}
      <h1 data-testid={props.titleTestId}>{props.title}</h1>
      {props.lede ? <div className="ph-lede">{props.lede}</div> : null}
      {props.children}
    </header>
  );
}

/** A global page (Home, Compute, Settings): the trail, then the head, then the body. */
export function Page(props: {
  trail: readonly Crumb[];
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  tabs?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Trail crumbs={props.trail}>
      <div className="page">
        <PageHead eyebrow={props.eyebrow} title={props.title} lede={props.lede} />
        {props.tabs}
        {props.children}
      </div>
    </Trail>
  );
}
