/**
 * A tiny, enumerable router. Each listener gets its own route table, so a route that is not in
 * the agent table cannot be reached through the agent listener at all (spec §7.11, criterion 56).
 */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Route<H> {
  readonly method: Method;
  /** `/api/v1/projects/:id`. A segment is a parameter only if it starts with `:`. */
  readonly path: string;
  readonly handler: H;
}

interface Compiled<H> {
  readonly route: Route<H>;
  readonly segments: readonly string[];
}

export type Match<H> =
  | {
      readonly kind: "found";
      readonly route: Route<H>;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly kind: "method_not_allowed"; readonly allow: readonly Method[] }
  | { readonly kind: "not_found" };

function split(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export class Router<H> {
  private readonly compiled: Compiled<H>[];

  constructor(readonly routes: readonly Route<H>[]) {
    this.compiled = routes.map((route) => ({ route, segments: split(route.path) }));
    const seen = new Set<string>();
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) throw new Error(`duplicate route ${key}`);
      seen.add(key);
    }
  }

  match(method: string, pathname: string): Match<H> {
    const parts = split(pathname);
    const allow: Method[] = [];
    for (const c of this.compiled) {
      const params = matchSegments(c.segments, parts);
      if (!params) continue;
      if (c.route.method === method || (method === "HEAD" && c.route.method === "GET")) {
        return { kind: "found", route: c.route, params };
      }
      allow.push(c.route.method);
    }
    return allow.length ? { kind: "method_not_allowed", allow } : { kind: "not_found" };
  }
}

function matchSegments(
  pattern: readonly string[],
  parts: readonly string[],
): Record<string, string> | undefined {
  if (pattern.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] as string;
    let v: string;
    try {
      v = decodeURIComponent(parts[i] as string);
    } catch {
      return undefined;
    }
    if (p.startsWith(":")) {
      if (v.length === 0) return undefined;
      params[p.slice(1)] = v;
    } else if (p !== v) {
      return undefined;
    }
  }
  return params;
}
