/**
 * `ablationkit access tailscale|status|off`: remote clients over the tailnet (spec §2.1 remote
 * client mode, §7.11; ADRs 0008, 0025). The human listener stays on loopback; `tailscale serve`
 * terminates HTTPS on this machine's tailnet name and proxies to it, and that origin is added to
 * `settings.json` `trusted_origins` (https, so the session cookie is `Secure`). No public gateway:
 * the name resolves only inside the tailnet.
 */
import { existsSync } from "node:fs";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type CoordinatorSettings,
  type TrustedOrigin,
  validateCoordinatorSettings,
} from "@ablationkit/protocol";
import { DEFAULT_PORTS, resolveSettings, runtimePaths } from "@ablationkit/server";
import { socketHealth } from "../client.ts";
import { type CliContext, flag, parseArgs, printJson, UsageError } from "../context.ts";

const USAGE = `usage:
  ablationkit access tailscale [--https-port 443] [--dry-run]
                     serve the UI on this machine's tailnet name over HTTPS and trust that origin
  ablationkit access status        what is served, and the trusted origins
  ablationkit access off [--https-port 443]
                     stop serving and forget the origin
  (all take --json; the coordinator reads trusted origins at start: restart it afterwards)`;

function tailscale(ctx: CliContext, args: string[]): { code: number; out: string; err: string } {
  const bin = ctx.env["ABLATIONKIT_TAILSCALE"] || "tailscale";
  try {
    const p = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
  } catch (e) {
    return { code: -1, out: "", err: (e as Error).message };
  }
}

/** This machine's MagicDNS name (`host.tailnet.ts.net`) from `tailscale status --json`. */
export function tailnetName(statusJson: string): string {
  let s: { BackendState?: string; Self?: { DNSName?: string } };
  try {
    s = JSON.parse(statusJson);
  } catch {
    throw new UsageError("`tailscale status --json` did not answer JSON; is Tailscale installed?");
  }
  if (s.BackendState && s.BackendState !== "Running")
    throw new UsageError(`Tailscale is ${s.BackendState}; run \`tailscale up\` first`);
  const name = (s.Self?.DNSName ?? "").replace(/\.$/, "");
  if (!name)
    throw new UsageError(
      "this machine has no MagicDNS name; enable MagicDNS and HTTPS certificates in the tailnet admin console",
    );
  return name;
}

function loadRaw(path: string): CoordinatorSettings {
  if (!existsSync(path)) return { schema_version: 1 };
  return readJson(path, validateCoordinatorSettings);
}

/** The human port the coordinator listens on (running, or as configured). */
async function humanPort(ctx: CliContext, s: CoordinatorSettings): Promise<number> {
  const h = await socketHealth(ctx.home);
  if (h) return Number(new URL(h.urls.human).port);
  return s.human?.port || DEFAULT_PORTS.human;
}

export async function accessCommand(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest, ["json", "dry-run"]);
  const asJson = args.flags["json"] === true;
  const httpsPort = Number(flag(args, "https-port") ?? "443");
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535)
    throw new UsageError("--https-port must be a port number");
  const paths = runtimePaths(ctx.home);
  const settings = loadRaw(paths.settings);

  if (sub === "status") {
    const serve = tailscale(ctx, ["serve", "status", "--json"]);
    const out = {
      trusted_origins: settings.trusted_origins ?? [],
      serve: serve.code === 0 ? safeJson(serve.out) : { error: (serve.err || serve.out).trim() },
    };
    if (asJson) printJson(ctx, out);
    else {
      ctx.out(
        `trusted origins: ${(out.trusted_origins.length ? out.trusted_origins.map((o) => o.origin) : ["http://localhost:<port> (default)"]).join(", ")}\n`,
      );
      ctx.out(
        serve.code === 0
          ? `tailscale serve: ${serve.out.trim() || "{}"}\n`
          : `tailscale serve: ${(serve.err || serve.out).trim()}\n`,
      );
    }
    return 0;
  }

  if (sub === "tailscale" || sub === "off") {
    const st = tailscale(ctx, ["status", "--json"]);
    if (st.code !== 0)
      throw new UsageError(
        `\`tailscale status\` failed: ${(st.err || st.out).trim() || "is Tailscale installed?"}`,
      );
    const name = tailnetName(st.out);
    const origin = `https://${name}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
    const port = await humanPort(ctx, settings);
    const local: TrustedOrigin = { origin: `http://localhost:${port}` };
    const current = settings.trusted_origins ?? [local];
    const next =
      sub === "tailscale"
        ? [...current.filter((o) => o.origin !== origin), { origin }]
        : current.filter((o) => o.origin !== origin);
    const serveArgs =
      sub === "tailscale"
        ? ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`]
        : ["serve", `--https=${httpsPort}`, "off"];
    const updated: CoordinatorSettings = { ...settings, trusted_origins: next };
    // Validate exactly as the coordinator will at start (https off loopback).
    resolveSettings(updated);
    if (args.flags["dry-run"] !== true) {
      const r = tailscale(ctx, serveArgs);
      if (r.code !== 0)
        throw new UsageError(
          `\`tailscale ${serveArgs.join(" ")}\` failed: ${(r.err || r.out).trim()}${/HTTPS|cert/i.test(r.err) ? "\nEnable HTTPS certificates for the tailnet (admin console → DNS → HTTPS Certificates)." : ""}`,
        );
      writeJsonAtomic(paths.settings, updated, { validate: validateCoordinatorSettings });
    }
    const running = (await socketHealth(ctx.home)) !== undefined;
    const result = {
      origin,
      proxied_to: `http://127.0.0.1:${port}`,
      trusted_origins: next,
      tailscale: serveArgs,
      dry_run: args.flags["dry-run"] === true,
      restart_required: running,
    };
    if (asJson) printJson(ctx, result);
    else if (sub === "tailscale")
      ctx.out(
        `${result.dry_run ? "would serve" : "serving"} ${origin} → http://127.0.0.1:${port} (tailnet only)\n` +
          `trusted origin added to settings.json${running ? "; restart to apply: ablationkit coordinator restart" : ""}\n` +
          `on the remote machine: open the link from \`ablationkit login --origin ${origin}\` (browser or desktop app),\n` +
          `  or log a remote CLI in: ablationkit login --coordinator ${origin} --code CODE\n`,
      );
    else
      ctx.out(
        `stopped serving ${origin}; origin removed from settings.json${running ? "; restart to apply: ablationkit coordinator restart" : ""}\n`,
      );
    return 0;
  }

  throw new UsageError(USAGE);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return { raw: text.trim() };
  }
}
