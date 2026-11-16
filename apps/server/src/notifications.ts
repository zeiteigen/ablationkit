/**
 * Desktop notifications through libnotify (`notify-send`) on the workstation, and as `notification`
 * events for the browser/Electron Notification API (spec §7.6, §7.11; ADR 0025): decisive findings
 * and repeated failures, without bombarding the researcher with ordinary low-risk actions. Each key notifies at most once per window; everything is also kept
 * in a small in-memory list for the UI and tests. A missing `notify-send` or display is not an
 * error: the notification is recorded as `undelivered`.
 */
import { spawn } from "node:child_process";

export interface Notification {
  /** Coalescing key: one notification per key per window. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly urgency?: "low" | "normal" | "critical";
  /** The project it concerns: also published as a `notification.raised` event for browser and desktop clients. */
  readonly project_id?: string;
  /** Where the web UI should open it (a path in the web shell). */
  readonly link?: string;
}

export interface SentNotification extends Notification {
  readonly at: string;
  readonly delivered: "sent" | "undelivered" | "disabled" | "coalesced";
}

export interface Notifier {
  notify(n: Notification): void;
  readonly recent: readonly SentNotification[];
}

export type NotifyRunner = (argv: readonly string[]) => Promise<boolean>;

const defaultRunner: NotifyRunner = (argv) =>
  new Promise((resolve) => {
    try {
      const p = spawn(argv[0] as string, argv.slice(1), { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });

export class LibnotifyNotifier implements Notifier {
  private readonly last = new Map<string, number>();
  private readonly sent: SentNotification[] = [];

  constructor(
    private readonly o: {
      readonly now: () => Date;
      readonly enabled: boolean;
      readonly windowMs?: number;
      readonly runner?: NotifyRunner;
      readonly binary?: string;
    },
  ) {}

  get recent(): readonly SentNotification[] {
    return this.sent;
  }

  private push(n: Notification, delivered: SentNotification["delivered"]): void {
    this.sent.push({ ...n, at: this.o.now().toISOString(), delivered });
    if (this.sent.length > 200) this.sent.splice(0, this.sent.length - 200);
  }

  notify(n: Notification): void {
    const t = this.o.now().getTime();
    const prev = this.last.get(n.key);
    if (prev !== undefined && t - prev < (this.o.windowMs ?? 10 * 60_000)) {
      this.push(n, "coalesced");
      return;
    }
    this.last.set(n.key, t);
    if (!this.o.enabled) {
      this.push(n, "disabled");
      return;
    }
    const argv = [
      this.o.binary ?? "notify-send",
      "--app-name=AblationKit",
      `--urgency=${n.urgency ?? "normal"}`,
      "--",
      n.title.slice(0, 200),
      n.body.slice(0, 1000),
    ];
    const idx = this.sent.length;
    this.push(n, "sent");
    void (this.o.runner ?? defaultRunner)(argv).then((ok) => {
      if (!ok && this.sent[idx]?.key === n.key)
        this.sent[idx] = { ...(this.sent[idx] as SentNotification), delivered: "undelivered" };
    });
  }
}

/**
 * Wrap a notifier so every notification it does not coalesce is also handed to `publish`, whether
 * or not libnotify is enabled here: the coordinator publishes it as an event, so remote browsers
 * and the desktop app see it too.
 */
export function publishingNotifier(base: Notifier, publish: (n: Notification) => void): Notifier {
  return {
    notify(n: Notification): void {
      base.notify(n);
      const last = base.recent.at(-1);
      if (last?.key !== n.key || last.delivered === "coalesced") return;
      try {
        publish(n);
      } catch {
        // a notification never breaks the action that raised it
      }
    },
    get recent() {
      return base.recent;
    },
  };
}
