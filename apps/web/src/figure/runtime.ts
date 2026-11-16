/**
 * The figure runtime (ADR 0053): the one script a vault figure's sandboxed frame loads by URL
 * (`/figure-runtime-<hash>.js`, built by `apps/web/build.ts`), before the note's own script.
 *
 * It says hello to the page, takes the MessagePort the page hands back (the frame has no network:
 * the port is its only way out), applies the page's theme, then runs the note's script as
 * `AKFigure.run(async function (el, ak, Plot, d3) { … })`. `ak` reads the project's runs through
 * the port; Observable Plot and d3 are bundled here. Whatever the script throws, synchronously,
 * in a promise or later in an event handler, is shown in place of the figure and reported to the
 * page, which records it so the writer sees it as the `figure_error` check.
 */
import * as Plot from "@observablehq/plot";
import * as d3 from "d3";

const PROTOCOL = "ablationkit.figure/1";

interface Theme {
  dark: boolean;
  bg: string;
  fg: string;
  muted: string;
  faint: string;
  line: string;
  accent: string;
  ink: string;
  ok: string;
  warn: string;
  err: string;
  series: string[];
}

interface Connected {
  port: MessagePort;
  theme: Theme;
}

type Figure = (el: HTMLElement, ak: unknown, plot: typeof Plot, d3m: typeof d3) => unknown;

function connect(): Promise<Connected> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the page did not connect to the figure within 10 s")),
      10_000,
    );
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window.parent) return;
      const d = ev.data as { type?: string; protocol?: string; theme?: Theme } | null;
      if (d?.type !== "ablationkit:figure-connect" || d.protocol !== PROTOCOL) return;
      const port = ev.ports[0];
      if (!port || !d.theme) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve({ port, theme: d.theme });
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "ablationkit:figure-hello", protocol: PROTOCOL }, "*");
  });
}

function applyTheme(t: Theme): void {
  const root = document.documentElement;
  root.dataset["theme"] = t.dark ? "dark" : "light";
  root.style.colorScheme = t.dark ? "dark" : "light";
  for (const k of [
    "bg",
    "fg",
    "muted",
    "faint",
    "line",
    "accent",
    "ink",
    "ok",
    "warn",
    "err",
  ] as const)
    if (t[k]) root.style.setProperty(`--${k}`, t[k]);
  t.series.forEach((c, i) => {
    root.style.setProperty(`--s${i + 1}`, c);
  });
}

function message(e: unknown): string {
  if (e instanceof Error) {
    // The first stack frame in the frame document is in the note's script, which starts on the
    // document's second line: its line N is the script's line N - 1.
    const at = /\/vault-frame\/[^\s)]*:(\d+):(\d+)/.exec(e.stack ?? "");
    const line = at ? Number(at[1]) - 1 : 0;
    return `${e.name}: ${e.message}${line > 0 ? ` (line ${line} of the script)` : ""}`;
  }
  return String(e);
}

async function run(fn: Figure): Promise<void> {
  const el = document.getElementById("figure") as HTMLElement;
  let port: MessagePort | undefined;
  let reported = false;
  const report = (error?: string) => {
    if (reported && !error) return;
    reported = true;
    port?.postMessage({ drawn: error ? { error: error.slice(0, 2000) } : {} });
  };
  const fail = (e: unknown) => {
    const text = message(e);
    const box = document.createElement("div");
    box.className = "ak-figure-error";
    box.textContent = `The figure failed: ${text}`;
    el.replaceChildren(box);
    report(text);
  };
  window.addEventListener("error", (ev) => fail(ev.error ?? ev.message));
  window.addEventListener("unhandledrejection", (ev) => fail(ev.reason));

  let conn: Connected;
  try {
    conn = await connect();
  } catch (e) {
    fail(e);
    return;
  }
  port = conn.port;
  applyTheme(conn.theme);

  let next = 1;
  const pending = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
  port.onmessage = (ev: MessageEvent) => {
    const m = ev.data as {
      id?: number;
      result?: unknown;
      error?: { code: string; message: string };
    };
    if (typeof m?.id !== "number") return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.no(new Error(`${m.error.code}: ${m.error.message}`));
    else p.ok(m.result);
  };
  const call = <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    new Promise<T>((ok, no) => {
      const id = next++;
      pending.set(id, { ok: ok as (v: unknown) => void, no });
      port?.postMessage({ id, method, params });
    });

  type Run = { run_id: string; run_name?: string } & Record<string, unknown>;
  const quote = (s: string) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  const ak = Object.freeze({
    runs: Object.freeze({
      /** Runs of the project, newest first: `{filter, limit}` as MLflow search (limit ≤ 200). */
      list: async (opts: { filter?: string; limit?: number } = {}) =>
        (await call<{ runs: Run[] }>("runs.list", { limit: 200, ...opts })).runs,
      /** One run by its MLflow run ID. */
      get: (runId: string) => call<Run>("runs.get", { run_id: runId }),
      /** One run by its name, or undefined. */
      named: async (name: string) =>
        (
          await call<{ runs: Run[] }>("runs.list", {
            filter: `attributes.run_name = ${quote(name)}`,
            limit: 1,
          })
        ).runs[0],
      /** Every logged value of one metric: `[{step, value, timestamp}]`. */
      history: async (runId: string, key: string) =>
        (
          await call<{ history: { step: number; value: number; timestamp: number }[] }>(
            "runs.metric_history",
            { run_id: runId, key },
          )
        ).history,
    }),
    artifacts: Object.freeze({
      list: async (runId: string, path?: string) =>
        (
          await call<{ files: { path: string; is_dir?: boolean; file_size?: number }[] }>(
            "artifacts.list",
            { run_id: runId, ...(path ? { path } : {}) },
          )
        ).files,
      /** A small artifact: `{text}` (and `json` for a .json file) or `{data_url}` for an image. */
      preview: async (runId: string, path: string) => {
        const r = await call<{ content_type: string; text?: string; data_url?: string }>(
          "artifacts.preview",
          { run_id: runId, path },
        );
        if (r.content_type === "application/json" && typeof r.text === "string")
          try {
            return { ...r, json: JSON.parse(r.text) as unknown };
          } catch {
            return r;
          }
        return r;
      },
    }),
    theme: Object.freeze({ ...conn.theme, series: [...conn.theme.series] }),
  });

  // The page sizes the frame to its content.
  let last = 0;
  const resize = () => {
    // The body's height, not the document's: a document is never shorter than its frame.
    const h = Math.ceil(
      Math.max(document.body.scrollHeight, el.getBoundingClientRect().bottom + window.scrollY),
    );
    if (h !== last) {
      last = h;
      port?.postMessage({ resize: h });
    }
  };
  new ResizeObserver(resize).observe(document.body);

  try {
    await fn(el, ak, Plot, d3);
    if (!el.childNodes.length) throw new Error("the script drew nothing into `el`");
    report();
  } catch (e) {
    fail(e);
  }
  resize();
}

(window as unknown as { AKFigure: unknown }).AKFigure = Object.freeze({
  run: (fn: Figure) => void run(fn),
});
