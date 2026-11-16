/**
 * Docs drift checks for the extension and source-change docs (criterion 15d, spec §8.6): every
 * `ablationkit` command they mention is in the CLI's usage, manifest JSON blocks validate, Python blocks parse,
 * relative links resolve, `<!-- ci: run -->` shell blocks run from a fresh checkout, and every
 * extension route is in the coordinator API reference.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateManifest } from "@ablationkit/extension-host";
import { EXTENSION_OPS } from "../../server/src/listeners/extensions.ts";
import { cli, ROOT } from "./helpers.ts";

const DOCS = [
  ...readdirSync(join(ROOT, "docs/extensions"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(ROOT, "docs/extensions", f)),
  join(ROOT, "docs/contributing/source-changes.md"),
  ...readdirSync(join(ROOT, "packages/extension-host/templates"))
    .map((t) => join(ROOT, "packages/extension-host/templates", t, "README.md"))
    .filter((f) => existsSync(f)),
];

function blocks(md: string, lang: string): { code: string; run: boolean }[] {
  const out: { code: string; run: boolean }[] = [];
  const re = new RegExp(`(<!-- ci: run -->\\n)?\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, "g");
  for (const m of md.matchAll(re)) out.push({ code: m[2] as string, run: !!m[1] });
  return out;
}

describe("extension and source-change docs", () => {
  test("the docs exist and are cross-linked from AGENTS.md", () => {
    const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
    expect(agents).toContain("docs/extensions/README.md");
    expect(agents).toContain("docs/contributing/source-changes.md");
    for (const t of [
      "tutorial-react-view.md",
      "tutorial-python-evaluator.md",
      "tutorial-react-python.md",
    ])
      expect(readFileSync(join(ROOT, "docs/extensions/README.md"), "utf8")).toContain(t);
  });

  for (const f of DOCS) {
    const rel = f.slice(ROOT.length + 1);
    test(`${rel}: links, manifests and Python blocks`, () => {
      const md = readFileSync(f, "utf8");
      for (const [, target] of md.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(target as string)) continue;
        expect(existsSync(resolve(dirname(f), target as string)), `${rel} → ${target}`).toBe(true);
      }
      for (const b of blocks(md, "json")) {
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(b.code);
        } catch {
          continue; // a fragment (for example a capability_config excerpt)
        }
        if (!("contributes" in raw)) continue;
        // Files the manifest names are assumed present: this checks the manifest, not a tree.
        const m = raw as {
          contributes: { entry?: string }[];
          python?: { lockfile: string; project: string };
        };
        const files = [
          ...m.contributes.flatMap((c) => (c.entry ? [c.entry.split(":")[0] as string] : [])),
          ...(m.python ? [m.python.lockfile, `${m.python.project}/pyproject.toml`] : []),
        ];
        const v = validateManifest(raw, { files });
        expect(
          v.diagnostics.filter((d) => d.level === "error"),
          `${rel} manifest`,
        ).toEqual([]);
      }
      for (const b of blocks(md, "python")) {
        const p = Bun.spawnSync(["python3", "-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
          stdin: Buffer.from(b.code),
          stderr: "pipe",
        });
        expect(p.exitCode, `${rel} python block:\n${b.code}\n${p.stderr.toString()}`).toBe(0);
      }
    });
  }

  test("every ablationkit command in these docs is in the CLI's usage", async () => {
    // The CLI is the researcher's and the operator's (ADR 0040); a subcommand has to appear on a
    // usage line of its group, so a removed one (e.g. `extension build`) is caught.
    const usage = (await cli(tmpdir(), ["help"])).out;
    const lines = usage.split("\n").map((l) => l.trim());
    const seen = new Set<string>();
    for (const f of DOCS)
      for (const [, a, b] of readFileSync(f, "utf8").matchAll(
        /\bablationkit[ \t]+([a-z]+)(?:[ \t]+([a-z]+))?/g,
      ))
        seen.add([a, b].filter(Boolean).join(" "));
    expect(seen.size).toBeGreaterThan(3);
    for (const cmd of seen) {
      const [group, sub] = cmd.split(" ");
      const known = lines.some(
        (l) =>
          l.startsWith(`${group} `) &&
          (!sub || new RegExp(`(^|[ |])${sub}([ |]|$)`).test(l.slice((group as string).length))),
      );
      expect(known, `ablationkit ${cmd}`).toBe(true);
    }
  });

  test("tutorial blocks marked `ci: run` run in a fresh checkout", async () => {
    const home = mkdtempSync(join(tmpdir(), "ak-docs-home-"));
    const checkout = mkdtempSync(join(tmpdir(), "ak-docs-repo-"));
    try {
      let ran = 0;
      for (const f of DOCS)
        for (const b of blocks(readFileSync(f, "utf8"), "sh").filter((x) => x.run))
          for (const line of b.code
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"))) {
            const argv = (line.match(/"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^"|"$/g, ""));
            expect(argv[0]).toBe("ablationkit");
            // Point the commands at the temporary checkout instead of the current directory.
            const args = argv
              .slice(1)
              .map((w) => (w.startsWith(".ablationkit/") ? join(checkout, w) : w));
            if (args[1] === "scaffold") args.push("--path", checkout);
            const { code, out, err } = await cli(home, args);
            expect(code, `${f}: ${line}\n${out}${err}`).toBe(0);
            ran++;
          }
      expect(ran).toBeGreaterThanOrEqual(6);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  test("every extension route is documented in the coordinator API reference", () => {
    const api = readFileSync(join(ROOT, "docs/api/coordinator-api.md"), "utf8");
    for (const op of EXTENSION_OPS) {
      const short = op.path
        .replace("/api/v1/projects/:id/extensions", "P")
        .replace("/api/v1/projects/:id/extension-executions", "X");
      const found = api
        .split("\n")
        .some(
          (l) =>
            l.includes(op.method) &&
            (l.includes(`${short}\``) || l.includes(`${short}?`) || l.includes(`${short} `)),
        );
      expect(found, `${op.method} ${op.path}`).toBe(true);
    }
  });
});
