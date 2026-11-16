/**
 * `ablationkit ui` (spec §2.1): make sure the web bundle is built and current and the coordinator
 * is running, then open a one-time login link in the browser. `--no-open` only prints it.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { WEB_DIST, webBuilt } from "@ablationkit/server";
import { requestLoginLink, socketHealth } from "../client.ts";
import { type CliContext, flag, parseArgs, printJson } from "../context.ts";
import { coordinatorCommand } from "./coordinator.ts";

export async function uiCommand(
  argv: readonly string[],
  ctx: CliContext,
  opener: (url: string) => boolean = xdgOpen,
): Promise<number> {
  const args = parseArgs(argv, ["json", "no-open"]);
  if (!webBuilt() || webStale(ctx.repoRoot)) {
    // A source checkout: build the web shell (Bun's bundler, well under a second). A bundle older
    // than its sources is rebuilt too: a stale one can call routes the coordinator no longer has
    // and render a blank page.
    const p = Bun.spawnSync(["bun", join(ctx.repoRoot, "apps/web/build.ts")], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) ctx.err(`web build failed; serving the sign-in page only\n${p.stderr}`);
  }
  if (!(await socketHealth(ctx.home))) {
    const code = await coordinatorCommand(["start"], { ...ctx, out: () => {} });
    if (code !== 0) return code;
  }
  const link = await requestLoginLink(ctx.home, flag(args, "origin"));
  const opened = args.flags["no-open"] === true ? false : opener(link.url);
  if (args.flags["json"] === true) printJson(ctx, { ...link, opened });
  else ctx.out(opened ? `opened ${link.origin} in your browser\n` : `${link.url}\n`);
  return 0;
}

/** Sources the web bundle is built from (the shell and the workspace packages it imports). */
const WEB_SOURCES = [
  "apps/web/index.html",
  "apps/web/src",
  "packages/protocol/src",
  "packages/inference-adapters/src",
  "packages/extension-host/src",
  "packages/builtin-llm/src",
];

/**
 * In a source checkout, whether a web source is newer than the built bundle. An installed tree
 * ships a prebuilt bundle and no `apps/web/src`, so it is never stale.
 */
export function webStale(repoRoot: string, dist = WEB_DIST): boolean {
  const index = join(dist, "index.html");
  if (!existsSync(index) || !existsSync(join(repoRoot, "apps/web/src"))) return false;
  const built = statSync(index).mtimeMs;
  const newer = (p: string): boolean => {
    const s = statSync(p, { throwIfNoEntry: false });
    if (!s) return false;
    if (!s.isDirectory()) return s.mtimeMs > built;
    return readdirSync(p).some((n) => n !== "node_modules" && newer(join(p, n)));
  };
  return WEB_SOURCES.some((rel) => newer(join(repoRoot, rel)));
}

function xdgOpen(url: string): boolean {
  try {
    const p = Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    p.unref();
    return true;
  } catch {
    return false;
  }
}
