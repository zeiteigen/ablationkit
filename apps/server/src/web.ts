/**
 * Serves the web shell (`apps/web/dist`, built by `apps/web/build.ts`) from the human listener.
 * Every non-API GET that is not a built file gets `index.html` (client-side routing). The page
 * needs no session to load; it shows how to sign in when the API answers 401.
 *
 * The CSP allows only same-origin scripts, styles and API calls. Artifact previews use blob: URLs
 * for images; artifacts are never rendered as active content on this origin.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

export const WEB_DIST = resolve(import.meta.dir, "../../web/dist");

export const APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; " +
  "connect-src 'self'; font-src 'self'; manifest-src 'self'; frame-src 'self'; frame-ancestors 'none'; " +
  "base-uri 'none'; form-action 'self'";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
};

const SECURITY = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/** The unbuilt fallback: a pointer to the build. */
const NOT_BUILT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AblationKit</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#57534e}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:32px 16px}
main{max-width:560px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 16px}
</style></head><body><main>
<h1>AblationKit</h1><p>The web UI is not built on this machine: run <code>bun run web:build</code> (or <code>ablationkit ui</code>), then reload.</p>
</main></body></html>
`;

function notBuilt(): Response {
  return new Response(NOT_BUILT_HTML, {
    headers: {
      ...SECURITY,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
  });
}

export function webBuilt(dist = WEB_DIST): boolean {
  return existsSync(join(dist, "index.html"));
}

/** A static response for `pathname`, or the SPA index. */
export function webResponse(pathname: string, dist = WEB_DIST): Response {
  if (!webBuilt(dist)) return notBuilt();
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^\/+/, "");
  } catch {
    rel = "";
  }
  const file = rel ? join(dist, rel) : "";
  const inside = file.startsWith(`${dist}/`);
  if (inside && rel !== "index.html" && existsSync(file) && statSync(file).isFile()) {
    // Bun's bundler content-hashes asset names, so they can be cached for good.
    const hashed = /-[a-z0-9]{8,}\.[a-z0-9]+$/i.test(rel);
    return new Response(readFileSync(file), {
      headers: {
        ...SECURITY,
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  }
  return new Response(readFileSync(join(dist, "index.html")), {
    headers: {
      ...SECURITY,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": APP_CSP,
    },
  });
}
