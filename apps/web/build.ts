/**
 * Builds the web shell into `apps/web/dist` with Bun's bundler (HTML entrypoint, hashed assets).
 * The coordinator serves `dist/` from the human listener (`apps/server/src/web.ts`).
 *
 * `bun apps/web/build.ts [--watch]`; `buildWeb()` is also called by `ablationkit ui` when the
 * bundle is missing.
 */
import { cpSync, readdirSync, rmSync, watch } from "node:fs";
import { dirname, join } from "node:path";

export const WEB_ROOT = import.meta.dir;
export const WEB_DIST = join(WEB_ROOT, "dist");

export async function buildWeb(opts: { minify?: boolean } = {}): Promise<void> {
  rmSync(WEB_DIST, { recursive: true, force: true });
  const r = await Bun.build({
    entrypoints: [join(WEB_ROOT, "index.html")],
    outdir: WEB_DIST,
    minify: opts.minify ?? true,
    sourcemap: "linked",
    target: "browser",
    external: ["/fonts/*"],
    // Absolute asset URLs: the SPA is served at nested paths like /p/<id>/runs.
    publicPath: "/",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        // KaTeX's stylesheet names its fonts relatively; serve them from /fonts like our own
        // (woff2 only: every browser the shell supports reads it).
        name: "katex-fonts",
        setup(b) {
          b.onLoad({ filter: /katex(\.min)?\.css$/ }, async (a) => ({
            contents: (await Bun.file(a.path).text())
              .replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "")
              .replaceAll("url(fonts/", "url(/fonts/"),
            loader: "css",
          }));
        },
      },
    ],
  });
  if (!r.success) {
    for (const log of r.logs) console.error(log);
    throw new Error("web build failed");
  }
  // The figure runtime (ADR 0053): a classic script vault figures' sandboxed frames load by URL,
  // content-hashed so every frame shares one cached copy.
  const fig = await Bun.build({
    entrypoints: [join(WEB_ROOT, "src/figure/runtime.ts")],
    outdir: WEB_DIST,
    naming: "figure-runtime-[hash].[ext]",
    format: "iife",
    minify: opts.minify ?? true,
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!fig.success) {
    for (const log of fig.logs) console.error(log);
    throw new Error("figure runtime build failed");
  }
  // Absolute CSS URLs keep fonts on this origin instead of Bun inlining blocked data URLs.
  cpSync(join(WEB_ROOT, "src/fonts"), join(WEB_DIST, "fonts"), { recursive: true });
  const katexFonts = join(dirname(Bun.resolveSync("katex/package.json", WEB_ROOT)), "dist/fonts");
  for (const f of readdirSync(katexFonts))
    if (f.endsWith(".woff2")) cpSync(join(katexFonts, f), join(WEB_DIST, "fonts", f));
  cpSync(join(katexFonts, "../../LICENSE"), join(WEB_DIST, "fonts", "KaTeX-LICENSE.txt"));
}

if (import.meta.main) {
  const t = performance.now();
  await buildWeb();
  console.log(`web: built ${WEB_DIST} in ${Math.round(performance.now() - t)} ms`);
  if (process.argv.includes("--watch")) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rebuild = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        buildWeb({ minify: false }).then(
          () => console.log("web: rebuilt"),
          (e) => console.error(String(e)),
        );
      }, 100);
    };
    watch(join(WEB_ROOT, "src"), { recursive: true }, rebuild);
    watch(join(WEB_ROOT, "../../docs/guide"), { recursive: true }, rebuild);
  }
}
