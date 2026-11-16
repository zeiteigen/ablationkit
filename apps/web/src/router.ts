/** A tiny history router: the coordinator serves `index.html` for every non-API path. */
import { type MouseEvent, useEffect, useState } from "react";

const subs = new Set<() => void>();

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  for (const s of subs) s();
  window.scrollTo(0, 0);
}

export function useLocation(): { path: string; query: URLSearchParams } {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    subs.add(f);
    window.addEventListener("popstate", f);
    return () => {
      subs.delete(f);
      window.removeEventListener("popstate", f);
    };
  }, []);
  return { path: location.pathname, query: new URLSearchParams(location.search) };
}

/** Replace the query string, keeping the path (filters, pagination, selections). */
export function setQuery(params: Record<string, string | undefined>): void {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  navigate(`${location.pathname}${s ? `?${s}` : ""}`, { replace: true });
}

/** onClick for <a href>: client-side navigation unless a modifier key asks for a new tab. */
export function linkClick(e: MouseEvent<HTMLAnchorElement>): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return;
  const href = e.currentTarget.getAttribute("href");
  if (!href?.startsWith("/") || href.startsWith("/api/")) return;
  e.preventDefault();
  navigate(href);
}

/** Match `/p/:pid/rest...`. */
export function matchProject(path: string): { pid: string; rest: string } | undefined {
  const m = /^\/p\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return undefined;
  return { pid: decodeURIComponent(m[1] as string), rest: m[2] ?? "" };
}
