/**
 * The web shell (spec §2.2, simplified by ADR 0036 and ADR 0055): the global layer (Home, Compute,
 * then the projects, then Settings and Docs at the bottom) and the project layer (Overview …
 * Project settings, and one More), a header with search (the command palette) and the attention
 * inbox badge when something is in it, and a status bar. The UI is for reading results, costs, notes,
 * graphs and compute, including the tasks agents record their work under (read-only, ADR 0039).
 * AblationKit does not start or steer agents.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { ApiError, useApi, useEvents } from "./api.ts";
import { BrandMark } from "./components/Brand.tsx";
import { Palette } from "./components/Palette.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { ErrorBox, Link, Loading } from "./components/ui.tsx";
import { type NotificationPayload, raise } from "./lib/notify.ts";
import { useLedgerUnread } from "./lib/vault-store.ts";
import {
  activeProjectItem,
  backendProjectNav,
  GLOBAL_FOOT,
  GLOBAL_NAV,
  type NavItem,
  ORIGINAL_RECORDS,
  PROJECT_NAV,
  projectNav,
  type RegisteredBackend,
} from "./nav.ts";
import { AgentPage, AgentsPage } from "./pages/agents.tsx";
import { ComputePage } from "./pages/compute.tsx";
import { DocsPage } from "./pages/docs.tsx";
import { panelPath, useProjectPanels } from "./pages/extensions.tsx";
import { HomePage } from "./pages/home.tsx";
import { ProjectRouter } from "./pages/project.tsx";
import { SettingsPage, settingsTab } from "./pages/settings.tsx";
import { matchProject, navigate, useLocation } from "./router.ts";

export interface Project {
  project_id: string;
  name: string;
  path: string;
  registered_at: string;
  updated_at: string;
  previous_paths: string[];
}

interface ShellCtx {
  projects: Project[];
  reloadProjects: () => void;
  openPalette: () => void;
}
const Ctx = createContext<ShellCtx>({
  projects: [],
  reloadProjects: () => {},
  openPalette: () => {},
});
export const useShell = () => useContext(Ctx);

export function App() {
  const session = useApi<{ session_id: string }>("/api/v1/auth/session");
  if (session.loading && !session.data) return <div className="page">Loading…</div>;
  if (session.error instanceof ApiError && session.error.status === 401) return <SignIn />;
  if (session.error) return <ErrorBox error={session.error} onRetry={session.reload} />;
  return <Shell />;
}

function SignIn() {
  return (
    <div className="page" style={{ maxWidth: 560, margin: "10vh auto" }}>
      <h1>AblationKit</h1>
      <p className="muted">You are not signed in to this coordinator.</p>
      <div className="card">
        <p>Open a one-time sign-in link from the workstation:</p>
        <pre className="console">ablationkit ui</pre>
        <p className="small muted">
          Or print a link for another trusted origin with{" "}
          <code>ablationkit login --origin URL</code>. Links are valid for 2 minutes and work once.
        </p>
      </div>
    </div>
  );
}

function Shell() {
  const loc = useLocation();
  const projects = useApi<{ projects: Project[] }>("/api/v1/projects");
  const [palette, setPalette] = useState(false);
  const inbox = useApi<{ items: unknown[] }>("/api/v1/inbox", { pollMs: 15000 });

  useEvents(
    () => {
      projects.reload();
    },
    { types: ["project.registered", "project.remapped"] },
  );
  useEvents(() => inbox.reload(), { types: ["tracking.run.sync"] });
  // Coordinator notifications (findings, failures, budgets) as desktop notifications.
  useEvents(
    (e) => {
      raise(e.payload as NotificationPayload, (link) => navigate(link));
      inbox.reload();
    },
    { types: ["notification.raised"] },
  );

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const list = projects.data?.projects ?? [];
  const pm = matchProject(loc.path);
  const inboxCount = inbox.data?.items.length ?? 0;
  // At phone width the sidebar folds behind a Menu button that says where the reader is (ADR 0055).
  const [menu, setMenu] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page closes the menu
  useEffect(() => setMenu(false), [loc.path]);
  const here = whereLabel(loc.path, list);

  return (
    <Ctx.Provider
      value={{
        projects: list,
        reloadProjects: projects.reload,
        openPalette: () => setPalette(true),
      }}
    >
      <div className={`shell${menu ? " menu-open" : ""}`}>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <header className="header">
          <Link to="/" className="brand" title="Home">
            <BrandMark />
            <span className="brand-name">AblationKit</span>
          </Link>
          <button
            type="button"
            className="small menu-btn"
            aria-expanded={menu}
            aria-controls="sidebar"
            onClick={() => setMenu((m) => !m)}
          >
            Menu <span className="faint">· {here}</span>
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="small"
            onClick={() => setPalette(true)}
            title="Go to a page, find a note or run a command (Ctrl K)"
          >
            Search <kbd>Ctrl K</kbd>
          </button>
          {inboxCount ? (
            <Link to="/#inbox" className="btn small" title="Attention inbox">
              Inbox{" "}
              <span className="count" data-testid="inbox-badge">
                {inboxCount}
              </span>
            </Link>
          ) : null}
        </header>
        <aside className="side" id="sidebar">
          <nav className="group" aria-label="Global">
            {GLOBAL_NAV.map((n) => (
              <Link
                key={n.id}
                to={n.path}
                className={
                  loc.path === n.path || (n.path !== "/" && loc.path.startsWith(`${n.path}/`))
                    ? "active"
                    : ""
                }
                title={n.contains}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="group">
            <div className="group-title">Projects</div>
            {projects.loading && !projects.data ? <Loading /> : null}
            {list.length === 0 && projects.data ? (
              <div className="faint small" style={{ padding: "4px 8px" }}>
                None registered yet.
              </div>
            ) : null}
            {list.map((p) => (
              <ProjectSideNav
                key={p.project_id}
                project={p}
                current={pm?.pid === p.project_id ? pm.rest : undefined}
              />
            ))}
          </div>
          <nav className="group foot" aria-label="Settings and help">
            {GLOBAL_FOOT.map((n) => (
              <Link
                key={n.id}
                to={n.path}
                className={
                  (n.id === "settings" && settingsTab(loc.path)) ||
                  (n.id === "docs" && (loc.path === "/docs" || loc.path.startsWith("/docs/")))
                    ? "active"
                    : ""
                }
                title={n.contains}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </aside>
        <main className="main" id="main-content" tabIndex={-1}>
          <Routes path={loc.path} />
        </main>
        <StatusBar />
      </div>
      {palette ? (
        <Palette onClose={() => setPalette(false)} projectId={pm?.pid} projects={list} />
      ) : null}
    </Ctx.Provider>
  );
}

/** Where the reader is, in a few words, for the phone's Menu button: "fraise › Standing". */
function whereLabel(path: string, projects: readonly Project[]): string {
  const pm = matchProject(path);
  if (pm) {
    const name = projects.find((p) => p.project_id === pm.pid)?.name ?? pm.pid;
    const id = activeProjectItem(pm.rest);
    const item = [...PROJECT_NAV, ...ORIGINAL_RECORDS].find((i) => i.id === id);
    return item && id !== "overview" ? `${name} › ${item.label}` : name;
  }
  if (path === "/system" || path.startsWith("/settings")) return "Settings";
  if (path.startsWith("/docs")) return "Docs";
  if (path.startsWith("/agents")) return "Agents";
  return GLOBAL_NAV.find((n) => n.path === path)?.label ?? "Home";
}

function ProjectSideNav(props: { project: Project; current: string | undefined }) {
  const p = props.project;
  const open = props.current !== undefined;
  const api = `/api/v1/projects/${encodeURIComponent(p.project_id)}`;
  const settings = useApi<{ task_profiles: string[] }>(open ? `${api}/settings` : undefined);
  const backends = useApi<{ extensions: RegisteredBackend[] }>(
    open ? `${api}/extension-backends` : undefined,
  );
  useEvents(() => backends.reload(), {
    project: p.project_id,
    types: ["extension.backend.activation"],
  });
  const base = `/p/${encodeURIComponent(p.project_id)}`;
  // Standing's count: lines of the ledger not read as they now stand (ADR 0049).
  const unread = useLedgerUnread(open ? p.project_id : undefined);
  // Enabled project panels (extensions) each get a page in the project's navigation.
  const panels = useProjectPanels(open ? p.project_id : undefined).map(
    (m): NavItem => ({
      id: `panel:${m.extension_id}:${m.contribution.id}`,
      label: m.contribution.title,
      path: panelPath(m),
      contains: `${m.contribution.title} (extension ${m.extension_id})`,
    }),
  );
  // Data & Evals and Models join the list once the project uses the model lifecycle (ADR 0055).
  const models = useApi<{ models: unknown[] }>(open ? `${api}/models` : undefined);
  const evaluations = useApi<{ evaluations: unknown[] }>(open ? `${api}/evaluations` : undefined);
  useEvents(() => models.reload(), { project: p.project_id, types: ["model.logged"] });
  const lifecycle =
    (models.data?.models.length ?? 0) + (evaluations.data?.evaluations.length ?? 0) > 0;
  const staticNav = projectNav(lifecycle);
  const backendNav = backendProjectNav(
    backends.data?.extensions ?? [],
    settings.data?.task_profiles ?? [],
  );
  const primary = [
    ...staticNav.primary.filter((item) => item.id !== "settings"),
    ...backendNav.primary,
    ...panels,
    ...staticNav.primary.filter((item) => item.id === "settings"),
  ];
  const more = [...staticNav.more, ...backendNav.more];
  const active = open
    ? activeProjectItem(props.current ?? "", [...primary, ...more, ...ORIGINAL_RECORDS])
    : "";
  const moreLink = (i: NavItem, title: string) => (
    <Link
      key={i.id}
      to={`${base}${i.path}`}
      className={active === i.id ? "active" : ""}
      title={title}
    >
      {i.label}
    </Link>
  );
  return (
    <div>
      <Link to={base} className={open && active === "overview" ? "active" : ""}>
        {p.name}
      </Link>
      {open ? (
        <nav className="sub" aria-label={`${p.name} navigation`}>
          {primary
            .filter((i) => i.id !== "overview")
            .map((i) => (
              <Link
                key={i.id}
                to={`${base}${i.path}`}
                className={active === i.id ? "active" : ""}
                title={i.contains}
              >
                {i.label}
                {i.id === "standing" && unread ? (
                  <span
                    className="count quiet"
                    data-testid="standing-count"
                    title={`${unread} ${unread === 1 ? "line" : "lines"} of the ledger not read as they now stand`}
                  >
                    {unread}
                  </span>
                ) : null}
              </Link>
            ))}
          <details
            className="more"
            open={[...more, ...ORIGINAL_RECORDS].some((i) => i.id === active)}
          >
            <summary className="small">More</summary>
            {more.map((i) =>
              moreLink(
                i,
                i.id === "data" || i.id === "models"
                  ? `${i.contains} (listed above once the project logs a model or runs an evaluation)`
                  : `${i.contains} (hidden by default for this project's task profiles)`,
              ),
            )}
            <div className="more-title">Original records</div>
            {ORIGINAL_RECORDS.map((i) => moreLink(i, `${i.contains}: the vault's provenance`))}
          </details>
        </nav>
      ) : null}
    </div>
  );
}

function Routes(props: { path: string }) {
  const pm = matchProject(props.path);
  if (pm) return <ProjectRouter pid={pm.pid} rest={pm.rest} />;
  if (props.path === "/docs" || props.path.startsWith("/docs/"))
    return <DocsPage path={props.path} />;
  const agent = /^\/agents\/(c-[a-f0-9]{12})$/.exec(props.path);
  if (agent) return <AgentPage sid={agent[1] as string} />;
  switch (props.path) {
    case "/":
      return <HomePage />;
    case "/compute":
      return <ComputePage />;
    case "/agents":
      return <AgentsPage />;
    case "/system":
    case "/settings":
    case "/settings/agent-sessions":
      return <SettingsPage tab={settingsTab(props.path) ?? "preferences"} />;
    default:
      return (
        <div className="page">
          <h1>Not found</h1>
          <p className="muted">
            No page at <code>{props.path}</code>. <Link to="/">Go home</Link>.
          </p>
        </div>
      );
  }
}
