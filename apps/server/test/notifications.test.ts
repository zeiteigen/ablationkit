/**
 * Notifications (spec §7.11; ADR 0025): libnotify on the workstation, coalesced per key, and the
 * same notification published as a `notification` event for browsers and the desktop app.
 */
import { describe, expect, test } from "bun:test";
import { LibnotifyNotifier, type Notification, publishingNotifier } from "../src/notifications.ts";

describe("notifications", () => {
  test("each key notifies once per window; every non-coalesced one is published, even with libnotify off", async () => {
    let t = 0;
    const seen: Notification[] = [];
    const argvs: (readonly string[])[] = [];
    const base = new LibnotifyNotifier({
      now: () => new Date(t),
      enabled: false,
      windowMs: 1000,
      runner: async (argv) => {
        argvs.push(argv);
        return true;
      },
    });
    const n = publishingNotifier(base, (x) => seen.push(x));
    const note = {
      key: "appr:a1",
      title: "Deployment approval requested",
      body: "preview_local of models:/m/1",
      project_id: "lab",
      link: "/p/lab/runs/jobs/j1",
    };
    n.notify(note);
    n.notify(note);
    t = 2000;
    n.notify(note);
    expect(seen).toEqual([note, note]);
    expect(n.recent.map((r) => r.delivered)).toEqual(["disabled", "coalesced", "disabled"]);
    expect(argvs).toEqual([]);

    const on = new LibnotifyNotifier({
      now: () => new Date(0),
      enabled: true,
      runner: async (argv) => {
        argvs.push(argv);
        return false;
      },
    });
    on.notify({ key: "appr:a1", title: "Approval requested", body: "c1: git.push" });
    await Bun.sleep(0);
    expect(argvs[0]?.slice(0, 3)).toEqual([
      "notify-send",
      "--app-name=AblationKit",
      "--urgency=normal",
    ]);
    expect(on.recent[0]?.delivered).toBe("undelivered");
  });
});
