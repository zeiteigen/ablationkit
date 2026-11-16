/**
 * Docs drift (spec §8.6, criterion 15d): `docs/api/coordinator-api.md` against the listeners' route
 * tables, in both directions.
 *
 * - Every human, agent and worker route is documented, in the right place: human routes anywhere
 *   under "## Human API"; agent routes either in "## Agent API" or on a human row marked agent (a
 *   Who/Auth column naming `agent`, or `**agent**` in the notes); worker routes under
 *   "## Worker API".
 * - Every documented route exists on the listener the docs put it on, so a removed or renamed
 *   route cannot linger in the reference, and a row marked agent really is on the agent API.
 * The parser and its conventions are in `api-docs.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENT_ROUTES } from "../src/listeners/agent.ts";
import { HUMAN_ROUTES } from "../src/listeners/human.ts";
import { REMOTE_WORKER_ROUTES, WORKER_ROUTES } from "../src/listeners/worker.ts";
import { type Listener, normalize, parseApiDoc } from "./api-docs.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const DOC = "docs/api/coordinator-api.md";

const key = (method: string, path: string) => `${method} ${normalize(path)}`;

describe(`${DOC} matches the listeners' route tables`, () => {
  const md = readFileSync(join(ROOT, DOC), "utf8");
  const docs = parseApiDoc(md);
  const tables: Record<Listener, Set<string>> = {
    human: new Set(HUMAN_ROUTES.map((r) => key(r.method, r.path))),
    agent: new Set(AGENT_ROUTES.map((r) => key(r.method, r.path))),
    worker: new Set([...WORKER_ROUTES, ...REMOTE_WORKER_ROUTES].map((r) => key(r.method, r.path))),
  };
  const documented: Record<Listener, Set<string>> = {
    human: new Set(),
    agent: new Set(),
    worker: new Set(),
  };
  for (const d of docs) {
    documented[d.listener].add(`${d.method} ${d.path}`);
    if (d.agent) documented.agent.add(`${d.method} ${d.path}`);
  }

  test("the parser finds the reference's routes", () => {
    expect(docs.length).toBeGreaterThan(220);
  });

  for (const l of ["human", "agent", "worker"] as const) {
    test(`every ${l} route is documented`, () => {
      const missing = [...tables[l]].filter((k) => !documented[l].has(k)).sort();
      expect(missing, `undocumented ${l} routes`).toEqual([]);
    });
    test(`every documented ${l} route exists`, () => {
      const stale = docs
        .filter((d) => d.listener === l || (l === "agent" && d.agent))
        .filter((d) => !tables[l].has(`${d.method} ${d.path}`))
        .map(
          (d) =>
            `${DOC}:${d.line} ${d.method} ${d.path}${d.listener !== l ? " (marked agent)" : ""}`,
        );
      expect([...new Set(stale)], `documented but not on the ${l} listener`).toEqual([]);
    });
  }
});
