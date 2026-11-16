/**
 * Desktop notifications from the browser or the Electron app (spec §7.11 Notifications, ADR 0025).
 * The coordinator decides what is worth a notification and publishes it as a `notification.raised` event; this raises it with the
 * Notification API when the researcher turned it on here. Each browser opts in for itself.
 */

const KEY = "ablationkit.notifications";

export interface NotificationPayload {
  key?: string;
  title?: string;
  body?: string;
  urgency?: "low" | "normal" | "critical";
  link?: string;
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationsWanted(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function setNotificationsWanted(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: notifications stay off
  }
}

/** Ask for permission (needs a user gesture) and turn notifications on if granted. */
export async function enableNotifications(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  const p =
    Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
  setNotificationsWanted(p === "granted");
  return p;
}

/** Raise one; returns false when off, unsupported or not permitted. */
export function raise(p: NotificationPayload, open: (link: string) => void): boolean {
  if (!notificationsSupported() || !notificationsWanted()) return false;
  if (Notification.permission !== "granted" || !p.title) return false;
  const n = new Notification(p.title, {
    body: p.body ?? "",
    ...(p.key ? { tag: p.key } : {}),
    requireInteraction: p.urgency === "critical",
  });
  n.onclick = () => {
    window.focus();
    if (p.link) open(p.link);
    n.close();
  };
  return true;
}
