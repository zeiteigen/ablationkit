/**
 * `ablationkit access` (spec §2.1 remote clients; ADR 0025) with a fake `tailscale`: it serves the
 * loopback human port on the tailnet name, trusts that origin next to localhost, and a coordinator
 * restarted on those settings logs a remote browser in through it (the `tailscale serve` hop is
 * simulated by the Host header it forwards). `access off` undoes both.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Coordinator } from "@ablationkit/server";
import { tailnetName } from "../src/commands/access.ts";
import { main } from "../src/main.ts";
import { Harness, io } from "./helpers.ts";

const NAME = "ws.tail1234.ts.net";
const h = new Harness();
afterEach(h.cleanup);
const tmp = () => h.tmp("ak-access-");

function fakeTailscale(dir: string): { bin: string; calls: () => string[] } {
  const log = join(dir, "calls.log");
  const bin = join(dir, "tailscale");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> ${log}
case "$1" in
  status) echo '{"BackendState":"Running","Self":{"DNSName":"${NAME}."}}' ;;
  serve) [ "$2" = "status" ] && echo '{"TCP":{"443":{"HTTPS":true}}}' ;;
esac
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => {
      try {
        return readFileSync(log, "utf8").trim().split("\n");
      } catch {
        return [];
      }
    },
  };
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port ?? 0;
  await s.stop(true);
  return p;
}

describe("access", () => {
  test("tailscale: serves the loopback UI on the tailnet name, trusts the origin, and a restarted coordinator logs a remote browser in", async () => {
    const home = tmp();
    const ts = fakeTailscale(tmp());
    const port = await freePort();
    const base = {
      schema_version: 1,
      human: { host: "127.0.0.1", port },
      agent: { host: "127.0.0.1", port: 0 },
      worker: { host: "127.0.0.1", port: 0 },
      mlflow: { enabled: false },
    };
    writeFileSync(join(home, "settings.json"), JSON.stringify(base));
    const env = { ABLATIONKIT_TAILSCALE: ts.bin };

    const a = io(home, env);
    expect(await main(["access", "tailscale", "--json"], a.ctx)).toBe(0);
    const r = JSON.parse(a.o.stdout);
    expect(r.origin).toBe(`https://${NAME}`);
    expect(ts.calls()).toEqual([
      "status --json",
      `serve --bg --https=443 http://127.0.0.1:${port}`,
    ]);
    const s = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(s.trusted_origins).toEqual([
      { origin: `http://localhost:${port}` },
      { origin: `https://${NAME}` },
    ]);
    expect(s.human).toEqual(base.human); // the listener stays on loopback

    // The coordinator reads trusted origins at start; a remote browser logs in through the name.
    const c = h.track(await Coordinator.start({ home, log: () => {} }));
    const link = await fetch("http://localhost/login", {
      unix: c.loginSocket,
      method: "POST",
      body: JSON.stringify({ origin: `https://${NAME}` }),
      headers: { "content-type": "application/json" },
    } as RequestInit);
    expect(link.status).toBe(200);
    const { code, url } = (await link.json()) as { code: string; url: string };
    expect(url).toBe(`https://${NAME}/login?code=${code}`);
    // What `tailscale serve` forwards: the tailnet Host to the loopback listener.
    const login = await fetch(`${c.urls.human}/login?code=${code}`, {
      headers: { host: NAME },
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const me = await fetch(`${c.urls.human}/api/v1/projects`, {
      headers: { host: NAME, cookie, origin: `https://${NAME}` },
    });
    expect(me.status).toBe(200);
    // Another name is still refused (DNS rebinding).
    const other = await fetch(`${c.urls.human}/api/v1/projects`, {
      headers: { host: "evil.example", cookie },
    });
    expect(other.status).not.toBe(200);

    // Off: stop serving and forget the origin.
    const b = io(home, env);
    expect(await main(["access", "off"], b.ctx)).toBe(0);
    expect(b.o.stdout).toContain("restart to apply");
    expect(ts.calls().at(-1)).toBe("serve --https=443 off");
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).trusted_origins).toEqual([
      { origin: `http://localhost:${port}` },
    ]);
  });

  test("dry runs change nothing; a stopped or nameless tailnet is a clear error", async () => {
    const home = tmp();
    const ts = fakeTailscale(tmp());
    const a = io(home, { ABLATIONKIT_TAILSCALE: ts.bin });
    expect(await main(["access", "tailscale", "--dry-run", "--https-port", "8443"], a.ctx)).toBe(0);
    expect(a.o.stdout).toContain(`would serve https://${NAME}:8443`);
    expect(ts.calls()).toEqual(["status --json"]);
    expect(() => tailnetName('{"BackendState":"Stopped"}')).toThrow(/tailscale up/);
    expect(() => tailnetName('{"BackendState":"Running","Self":{"DNSName":""}}')).toThrow(
      /MagicDNS/,
    );
    const missing = io(home, { ABLATIONKIT_TAILSCALE: join(tmp(), "nope") });
    expect(await main(["access", "tailscale"], missing.ctx)).toBe(2);
    expect(missing.o.stderr).toContain("tailscale status");
  });
});
