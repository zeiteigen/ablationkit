/**
 * Settings (spec §2.2, ADR 0055): three tabs. Preferences (the session, the SDK, notifications),
 * Agent sessions (every project's, ADR 0040: ending one revokes its token; and the agent
 * containers they run in, ADR 0061) and System (the
 * coordinator's health, delivery, backups and build, at `/system`). Privileged actions need only
 * the signed-in session (ADR 0037).
 */
import { useState } from "react";
import { api, useApi } from "../api.ts";
import { AgentContainers } from "../components/AgentContainers.tsx";
import { AgentSessions } from "../components/AgentSessions.tsx";
import { Badge, ErrorBox, KV, Loading, Page, Tabs, useAction } from "../components/ui.tsx";
import { fmtTime } from "../lib/format.ts";
import {
  enableNotifications,
  notificationsSupported,
  notificationsWanted,
  setNotificationsWanted,
} from "../lib/notify.ts";
import { SystemSection } from "./system.tsx";

interface Session {
  session_id: string;
  created_at: string;
  expires_at: string;
  label?: string;
}

export const SETTINGS_TABS = [
  { id: "preferences", label: "Preferences", to: "/settings" },
  { id: "agents", label: "Agent sessions", to: "/settings/agent-sessions" },
  { id: "system", label: "System", to: "/system" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/** The tab a path opens: `/settings`, `/settings/agent-sessions` or `/system`. */
export function settingsTab(path: string): SettingsTab | undefined {
  return SETTINGS_TABS.find((t) => t.to === path)?.id;
}

export function SettingsPage(props: { tab: SettingsTab }) {
  const tab = SETTINGS_TABS.find((t) => t.id === props.tab) ?? SETTINGS_TABS[0];
  return (
    <Page
      trail={[{ label: "Settings", to: "/settings" }, { label: tab.label }]}
      title="Settings"
      lede="Your preferences, every project's agent sessions, and the coordinator's health."
      tabs={<Tabs items={SETTINGS_TABS} active={tab.id} />}
    >
      {tab.id === "agents" ? (
        <div className="stack">
          <AgentSessions />
          <AgentContainers />
        </div>
      ) : null}
      {tab.id === "system" ? <SystemSection /> : null}
      {tab.id === "preferences" ? <Preferences /> : null}
    </Page>
  );
}

function Preferences() {
  const session = useApi<Session>("/api/v1/auth/session");
  const logout = useAction(async () => {
    await api("/api/v1/auth/session", { method: "DELETE" });
    location.assign("/");
  });
  return (
    <div className="grid2">
      <section className="card">
        <h2>
          Session
          <button
            type="button"
            className="small"
            style={{ marginLeft: "auto" }}
            onClick={() => void logout.run()}
          >
            Sign out
          </button>
        </h2>
        {session.data ? (
          <KV
            rows={[
              [
                "session",
                <span key="s" className="mono">
                  {session.data.session_id}
                </span>,
              ],
              ["created", fmtTime(session.data.created_at)],
              ["expires", fmtTime(session.data.expires_at)],
            ]}
          />
        ) : (
          <Loading />
        )}
      </section>
      <Notifications />
      <section className="card">
        <h2>SDK</h2>
        <p className="small muted">
          Jobs get the central <code>ablationkit-sdk</code> and <code>ablationkit-pytorch</code> on{" "}
          <code>PYTHONPATH</code>; projects do not install them.
        </p>
      </section>
    </div>
  );
}

/**
 * Desktop notifications (spec §7.11): the coordinator's curated notifications reach this browser or
 * the desktop app through the Notification API; the workstation also gets them through libnotify.
 */
function Notifications() {
  const [on, setOn] = useState(notificationsWanted());
  const [perm, setPerm] = useState<string>(
    notificationsSupported() ? Notification.permission : "unsupported",
  );
  const toggle = useAction(async () => {
    if (on) {
      setNotificationsWanted(false);
      setOn(false);
      return;
    }
    const p = await enableNotifications();
    setPerm(p);
    setOn(p === "granted");
  });
  return (
    <section className="card" data-testid="notifications">
      <h2>Notifications</h2>
      <p className="small muted">
        Decisive findings, repeated failures and agent requests waiting for you. The workstation
        shows them through libnotify; turn them on here to get them in this browser or the desktop
        app, including on a remote client.
      </p>
      <ErrorBox error={toggle.error} />
      <div className="row small">
        <Badge tone={on ? "ok" : "neutral"}>{on ? "on in this browser" : "off"}</Badge>
        <span className="faint">permission: {perm}</span>
        <button
          type="button"
          className="small"
          disabled={toggle.busy || perm === "unsupported" || (!on && perm === "denied")}
          onClick={() => void toggle.run()}
        >
          {on ? "Turn off" : "Turn on"}
        </button>
      </div>
      {perm === "denied" ? (
        <p className="faint small">Notifications are blocked for this site in the browser.</p>
      ) : null}
      <p className="faint small">
        Remote workers can also push terminal job states to ntfy (target <code>ntfy</code> setting).
      </p>
    </section>
  );
}
