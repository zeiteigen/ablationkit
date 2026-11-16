/**
 * Build the desktop shell (ADR 0025): Electron's main process and the connection page's preload,
 * bundled to CommonJS for Electron's Node (sandboxed preloads cannot load other files), and the
 * static connection page. The web UI itself is the coordinator's (`bun run web:build`).
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const OUT = join(HERE, "dist");

export async function buildDesktop(): Promise<string> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const [entry, name] of [
    ["src/main.ts", "main.cjs"],
    ["src/connect-preload.ts", "connect-preload.cjs"],
  ] as const) {
    const r = await Bun.build({
      entrypoints: [join(HERE, entry)],
      target: "node",
      format: "cjs",
      external: ["electron"],
      minify: false,
      sourcemap: "none",
    });
    if (!r.success) throw new AggregateError(r.logs, `desktop build failed: ${entry}`);
    const out = r.outputs[0];
    if (!out) throw new Error(`no output for ${entry}`);
    await Bun.write(join(OUT, name), out);
  }
  cpSync(join(HERE, "static"), join(OUT, "static"), { recursive: true });
  return join(OUT, "main.cjs");
}

if (import.meta.main) console.log(await buildDesktop());
