/**
 * Figures (ADR 0053): a vault note of type `figure` carries the JavaScript that draws it, and the
 * web UI runs that script where the note is read, in the sandbox extension views use (ADR 0022):
 * an opaque-origin frame (`sandbox allow-scripts`, CSP `default-src 'none'`, `connect-src
 * 'none'`) whose only channel is a MessagePort to the page. What the frame may ask for is fixed and
 * read-only: the project's runs, their metric histories and their artifacts (`READ_RUN_METHODS`),
 * checked here on every call. No manifest, build or approval: a figure is a note, and it can do no
 * more than read what the researcher's own run pages show.
 *
 * The frame loads the figure runtime (`apps/web/src/figure/runtime.ts`: the bridge, Observable
 * Plot and d3) from the web build by a nonce'd script tag, then the note's script as the body of
 * an async function; the runtime catches what it throws and the page reports it back
 * (`VaultService.figureDrawn`), so a writer learns of a broken figure from the `figure_error` check.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { MlflowError } from "@ablationkit/tracking-mlflow";
import { escapeTag, FRAME_BASE_CSS, READ_RUN_METHODS } from "../extensions/host.ts";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";
import { WEB_DIST } from "../web.ts";

type Json = Record<string, unknown>;

/** The runtime's file in the web build (`figure-runtime-<hash>.js`), or undefined when unbuilt. */
export function figureRuntime(dist = WEB_DIST): string | undefined {
  if (!existsSync(dist)) return undefined;
  return readdirSync(dist).find((f) => /^figure-runtime-[a-z0-9]+\.js$/i.test(f));
}

const FIGURE_CSS = `
body{padding:0}
#figure{min-height:24px;overflow-x:auto}
#figure svg{max-width:100%;height:auto}
.ak-figure-error{color:var(--err);white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;border-left:3px solid var(--err);padding:6px 10px}
`;

/** The frame document of one figure at one revision. */
export function figureFrame(
  svc: Services,
  pid: string,
  id: string,
  revision: string,
  opts: { ancestors: string[]; dist?: string },
): Response {
  const n = svc.vault.require(pid, id);
  if (n.type !== "figure" || !n.figure)
    throw new HttpError(404, "not_found", `${id} is not a figure`);
  if (String(n.revision) !== revision)
    throw new HttpError(409, "revision_conflict", `${id} is at revision ${n.revision}; reload`);
  const runtime = figureRuntime(opts.dist);
  const nonce = randomBytes(16).toString("base64");
  const body = svc.extensions.safeMode
    ? `<div class="ak-figure-error">Safe mode: figures, like extensions, are not run. Restart the coordinator without safe mode to draw them.</div>`
    : runtime
      ? `<div id="figure"></div><script nonce="${nonce}" src="/${runtime}"></script><script nonce="${nonce}">AKFigure.run(async function (el, ak, Plot, d3) {\n${escapeTag(n.figure.script, "script")}\n});</script>`
      : `<div class="ak-figure-error">The web UI is not built on this machine, so figures cannot be drawn: run bun run web:build.</div>`;
  // Everything before the note's script stays on the document's first line, so a line in an
  // error's stack is the script's line plus one (the runtime reports it as the script's).
  const css = `${FRAME_BASE_CSS}${FIGURE_CSS}`.replace(/\n/g, "");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // As an extension view: an opaque origin even when opened directly, and no network at all.
      // The runtime is the only script loaded by URL, and only because it carries the nonce.
      "content-security-policy": [
        "sandbox allow-scripts",
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "font-src data:",
        "media-src data: blob:",
        "connect-src 'none'",
        "frame-src 'none'",
        "worker-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        `frame-ancestors ${opts.ancestors.length ? opts.ancestors.join(" ") : "'self'"}`,
      ].join("; "),
    },
  });
}

/**
 * One call from a figure's frame, forwarded by the page with the researcher's session: the note
 * must be a live figure of this project and the method one of the read-only run methods.
 */
export async function figureRpc(
  svc: Services,
  pid: string,
  id: string,
  input: Json,
  actor: { kind: "human"; id?: string | undefined },
): Promise<unknown> {
  const method = input["method"];
  const params = (input["params"] ?? {}) as Json;
  const deny = (status: number, code: string, message: string): never => {
    svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: "human",
      action: "vault.figure.rpc",
      outcome: "denied",
      project_id: pid,
      target: id,
      details: compact({
        method: typeof method === "string" ? method.slice(0, 80) : undefined,
        code,
      }),
    });
    throw new HttpError(status, code, message);
  };
  if (svc.extensions.safeMode)
    return deny(503, "safe_mode", "figures, like extensions, are not run in safe mode");
  const n = svc.vault.get(pid, id);
  if (!n || n.archived_at || n.type !== "figure")
    return deny(404, "not_found", `${id} is not a figure of this project`);
  if (typeof method !== "string" || !(READ_RUN_METHODS as readonly string[]).includes(method))
    return deny(
      403,
      "method_not_allowed",
      `a figure reads runs only: ${READ_RUN_METHODS.join(", ")}`,
    );
  if (typeof params !== "object" || params === null || Array.isArray(params))
    return deny(400, "invalid_request", "params must be an object");
  try {
    return await svc.extensions.readRuns(pid, method as (typeof READ_RUN_METHODS)[number], params);
  } catch (e) {
    if (e instanceof MlflowError) throw new HttpError(503, "tracking_unavailable", e.message);
    throw e;
  }
}
