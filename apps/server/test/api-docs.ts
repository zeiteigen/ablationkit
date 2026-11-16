/**
 * Parser for the route tables in `docs/api/coordinator-api.md` (used by `api-docs.test.ts`).
 *
 * Doc conventions it understands: `…/x` is `/api/v1/projects/:id/x` (a section may redeclare it
 * with `` `…` = `/path` ``), section aliases such as `` `P` = `/api/v1/…` ``, several methods in
 * one cell (`GET` / `DELETE /path`), several routes in one cell, query strings, and any parameter
 * names (`:uid` matches `:uploadId`).
 */
export type Listener = "human" | "agent" | "worker";

const METHOD = "(?:GET|POST|PUT|PATCH|DELETE)";
const ROUTE_RE = new RegExp(
  `\\b(${METHOD}(?:\\s*(?:/|,|and|or)\\s*${METHOD})*)\\s+((?:/|…/|…|[A-Z]\\b)[^\\s\`,|]*)`,
  "g",
);

/** `/api/v1/jobs/:id/attempts/:attemptId` → `/api/v1/jobs/:/attempts/:` */
export function normalize(path: string): string {
  return path
    .replace(/[[?#].*$/, "")
    .replace(/[.;:)]+$/, "")
    .replace(/\/:[A-Za-z_][A-Za-z0-9_]*/g, "/:")
    .replace(/(.)\/$/, "$1");
}

export interface DocRoute {
  method: string;
  path: string;
  listener: Listener;
  /** A human row that also documents the route on the agent API. */
  agent: boolean;
  line: number;
}

export function parseApiDoc(md: string): DocRoute[] {
  const out: DocRoute[] = [];
  let listener: Listener | undefined;
  let aliases: Record<string, string> = {};
  let whoCol = -1;
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const h2 = /^## (.*)/.exec(line);
    if (h2) {
      const t = h2[1] as string;
      listener = t.startsWith("Human API")
        ? "human"
        : t.startsWith("Agent API")
          ? "agent"
          : t.startsWith("Worker API")
            ? "worker"
            : undefined;
      aliases = {};
      continue;
    }
    if (/^### /.test(line)) {
      aliases = {};
      continue;
    }
    // Section aliases: `P` = `/api/v1/projects/:id/extensions`.
    for (const m of line.matchAll(/`([A-Z]|…)` = `(\/[^`]+)`/g))
      aliases[m[1] as string] = m[2] as string;
    if (!listener || !line.startsWith("|")) continue;
    const cells = line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c))) continue;
    if (cells[0] === "Route") {
      whoCol = cells.findIndex((c) => c === "Who" || c === "Auth");
      continue;
    }
    const first = (cells[0] ?? "").replace(/`/g, "");
    const rest = cells.slice(1);
    const agent =
      listener === "human" &&
      ((whoCol > 0 && /\bagent\b/.test(cells[whoCol] ?? "")) ||
        rest.some((c) => /\*\*agent\*\*/i.test(c)));
    for (const m of first.matchAll(ROUTE_RE)) {
      let path = m[2] as string;
      const head = path.startsWith("…") ? "…" : /^[A-Z]\b/.test(path) ? (path[0] as string) : "";
      if (head) {
        const base =
          aliases[head] ??
          (head === "…" ? (listener === "worker" ? undefined : "/api/v1/projects/:id") : undefined);
        if (!base) continue; // `…` in a worker row refers to the row above; checked by the full form
        path = base + path.slice(head === "…" ? (path.startsWith("…/") ? 1 : 1) : 1);
        path = path.replace(/\/\//g, "/");
      }
      if (!path.startsWith("/")) continue;
      for (const method of (m[1] as string).split(/\s*(?:\/|,|and|or)\s*/))
        out.push({ method, path: normalize(path), listener, agent, line: i + 1 });
    }
  }
  return out;
}
