/** Bundle a declared backend page and render it under an opaque-origin frame policy. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HttpError } from "../http.ts";
import type { BackendBundle } from "./backend-state.ts";

interface BackendPageContext {
  enabled: (pid: string, ext: string) => boolean;
  bundle: (ext: string, pid?: string) => BackendBundle;
}

/**
 * The app's styles for a page in a frame: its CSP allows only inline styles and no fonts, so the
 * theme's tokens are inlined in place of the `@import`, without the `@font-face` rules.
 */
function frameStyles(): string {
  const web = resolve(import.meta.dir, "../../../web/src");
  const theme = readFileSync(join(web, "styles/theme.css"), "utf8").replace(
    /@font-face\s*\{[^}]*\}\s*/g,
    "",
  );
  return readFileSync(join(web, "styles/styles.css"), "utf8").replace(
    /@import\s+"\.\/theme\.css";/,
    theme,
  );
}

export async function renderExtensionBackendPage(
  context: BackendPageContext,
  pid: string,
  ext: string,
  pageId: string,
): Promise<Response> {
  if (!context.enabled(pid, ext))
    throw new HttpError(403, "extension_inactive", "Extension inactive");
  const b = context.bundle(ext, pid);
  const page = b.manifest.pages.find((p) => p.id === pageId);
  if (!page) throw new HttpError(404, "unknown_page", "No such extension page");
  const entry = resolve(b.root, page.entry);
  if (!entry.startsWith(`${resolve(b.root)}/`))
    throw new HttpError(400, "unsafe_path", "Invalid page entry");
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success)
    throw new HttpError(500, "extension_build_failed", result.logs.map(String).join("\n"));
  const js = await (result.outputs.find((x) => x.path.endsWith(".js")) as Bun.BuildArtifact).text();
  const css =
    frameStyles() +
    "\n" +
    (
      await Promise.all(
        result.outputs
          .filter((output) => output.path.endsWith(".css"))
          .map((output) => output.text()),
      )
    ).join("\n");
  const nonce = randomUUID().replaceAll("-", "");
  return new Response(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.replaceAll("</style", "<\\/style")}</style></head><body><div id="root"></div><script type="module" nonce="${nonce}">${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'`,
      },
    },
  );
}
