/**
 * Whole-repo docs drift (spec §8.6, criterion 15d). Every maintained doc — README.md, AGENTS.md,
 * docs/** (including HTML guide code examples, except the historical ADRs, the spec and docs/history), the skills and the
 * template READMEs — is checked for:
 *
 * - relative links (and file anchors' targets) that resolve;
 * - `ablationkit <group> [<command> [<sub>]]` mentions that the CLI knows;
 * - `bun run <script>` mentions that exist in the root package.json.
 *
 * The coordinator API reference is checked against the route tables in
 * `apps/server/test/api-docs.test.ts`; generated docs (`docs/api/protocol.md`) by
 * `bun run protocol:check`; the extension tutorials' runnable blocks by `docs.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { cli, ROOT } from "./helpers.ts";

const HISTORICAL = new Set(["docs/decisions", "docs/spec", "docs/history"]);

function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (HISTORICAL.has(relative(ROOT, p))) return [];
    if (n === "node_modules" || n === "dist") return [];
    return statSync(p).isDirectory() ? markdown(p) : n.endsWith(".md") ? [p] : [];
  });
}

export const MAINTAINED_DOCS: string[] = [
  join(ROOT, "README.md"),
  join(ROOT, "AGENTS.md"),
  ...markdown(join(ROOT, "docs")),
  ...readdirSync(join(ROOT, "docs/guide"))
    .filter((name) => name.endsWith(".html"))
    .map((name) => join(ROOT, "docs/guide", name)),
  ...markdown(join(ROOT, "skills")),
  ...markdown(join(ROOT, "packages/extension-host/templates")),
];

/** Groups whose commands start processes, open a TTY or call out; checked against the usage. */
const STATIC_ONLY = new Set(["coordinator", "ui", "login", "mcp", "access", "dev", "backup"]);

/** Markdown code and HTML code elements only: ordinary prose is not a command. */
function codeText(md: string): string {
  const fenced = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const spans = [...md.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const htmlCode = [...md.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((m) => m[1]);
  return [...fenced, ...spans, ...htmlCode].join("\n");
}

describe("maintained docs", () => {
  test("the doc set is the expected one", () => {
    const rel = MAINTAINED_DOCS.map((f) => relative(ROOT, f));
    for (const f of [
      "docs/contributing/dev-setup.md",
      "docs/api/coordinator-api.md",
      "docs/security/README.md",
      "docs/architecture/README.md",
      "skills/README.md",
    ])
      expect(rel).toContain(f);
    expect(rel.some((f) => f.startsWith("docs/decisions/"))).toBe(false);
  });

  test("relative links resolve", () => {
    const broken: string[] = [];
    for (const f of MAINTAINED_DOCS) {
      const md = readFileSync(f, "utf8").replace(/```[\s\S]*?```/g, "");
      for (const [, target] of md.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(target as string)) continue;
        if (!existsSync(resolve(dirname(f), target as string)))
          broken.push(`${relative(ROOT, f)} → ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("every `bun run` script exists", () => {
    const scripts = Object.keys(
      (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: object }).scripts,
    );
    const missing: string[] = [];
    for (const f of MAINTAINED_DOCS) {
      // Template READMEs describe the extension's own package, not this repository.
      if (relative(ROOT, f).startsWith("templates/")) continue;
      for (const [, s] of codeText(readFileSync(f, "utf8")).matchAll(
        /\bbun run ([a-z][a-z0-9:-]*)/g,
      ))
        if (!scripts.includes(s as string)) missing.push(`${relative(ROOT, f)}: bun run ${s}`);
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  test("every `ablationkit` command exists", async () => {
    const mentioned = new Map<string, string>();
    for (const f of MAINTAINED_DOCS)
      for (const [, a, b, c] of codeText(readFileSync(f, "utf8")).matchAll(
        /(?:^|[\s(`$])(?:ablationkit|\$AK)[ \t]+([a-z][a-z0-9]*)(?:[ \t]+([a-z][a-z-]*))?(?:[ \t]+([a-z][a-z-]*))?/gm,
      ))
        mentioned.set([a, b, c].filter(Boolean).join(" "), relative(ROOT, f));
    expect(mentioned.size).toBeGreaterThan(20);
    const home = mkdtempSync(join(tmpdir(), "ak-docs-drift-"));
    const bad: string[] = [];
    try {
      const usage = (await cli(home, ["help"])).out;
      const groups = new Set(
        usage
          .split("\n")
          .map((l) => /^ {2}([a-z0-9]+)\b/.exec(l)?.[1])
          .filter(Boolean),
      );
      for (const [cmd, file] of mentioned) {
        const words = cmd.split(" ");
        const group = words[0] as string;
        // `help` is a standalone command, already exercised above to obtain usage.
        if (group === "help" && words.length === 1) continue;
        if (!groups.has(group) && group !== "agent") {
          bad.push(`${file}: ablationkit ${cmd} (unknown group)`);
          continue;
        }
        // The usage lists every group with its commands ("run status [JOB] | logs JOB | …"). A
        // placeholder in command position (`research KIND add`, `lineage KIND:ID`) takes any word;
        // the run below then checks the CLI really dispatches it.
        const sub = words[1];
        const lines = usage
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith(`${group} `))
          .map((l) => l.slice(group.length));
        const inUsage =
          !sub ||
          lines.some(
            (l) =>
              new RegExp(`(^|[\\s|(])${sub}([\\s|)]|$)`).test(l) ||
              /(^|\|)\s*[A-Z][A-Z_]*(\s|:|$)/.test(l),
          );
        if (!inUsage && group !== "agent") {
          bad.push(`${file}: ablationkit ${cmd} (not in the usage)`);
          continue;
        }
        if (STATIC_ONLY.has(group) || !sub) continue;
        // With no further arguments, a temporary home and no coordinator, a known command fails
        // for lack of arguments (2) or of a coordinator (3); it is never "unknown".
        const { code, err } = await cli(home, words);
        if (/^unknown /i.test(err) || ![0, 1, 2, 3].includes(code))
          bad.push(
            `${file}: ablationkit ${cmd} (the CLI does not dispatch it: ${err.split("\n")[0]})`,
          );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    expect(bad).toEqual([]);
  }, 60_000);
});

describe("package maps", () => {
  const dirs = ["apps", "packages", "python"].flatMap((top) =>
    readdirSync(join(ROOT, top))
      .filter((n) => statSync(join(ROOT, top, n)).isDirectory() && n !== "node_modules")
      .map((n) => `${top}/${n}`),
  );
  for (const doc of ["docs/architecture/README.md", "AGENTS.md"]) {
    test(`${doc} names every app and package`, () => {
      const md = readFileSync(join(ROOT, doc), "utf8");
      const missing = dirs.filter((d) => {
        const name = d.split("/")[1] as string;
        return !md.includes(`\`${d}\``) && !md.includes(`${d}/`) && !md.includes(`\`${name}\``);
      });
      expect(missing).toEqual([]);
    });
  }
});
