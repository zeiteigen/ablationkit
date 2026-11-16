/**
 * Packaging (ADR 0028): the release holds every file the code finds from its own location, and
 * the AUR package, install script and package.json agree on the version. The installed tree is
 * exercised for real by `bun run test:package` (package-e2e.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  CLI_LAUNCHER,
  DESKTOP_LAUNCHER,
  desktopEntry,
  ROOT,
  releaseFiles,
  sourceFiles,
  version,
} from "../package.ts";

const shipped = releaseFiles(sourceFiles(ROOT));
const shippedSet = new Set(shipped);
/** Built at package time, so not in the source list. */
const BUILT = ["apps/web/dist", "apps/desktop/dist"];

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f) && !f.includes("node_modules") && !/(^|\/)test\//.test(f))
    .map((f) => join(dir, f));
}

/** `resolve(import.meta.dir, "a", "b")` and `join(import.meta.dir, …)` with literal segments. */
function selfRelativePaths(): { file: string; path: string }[] {
  const re = /(?:resolve|join)\(\s*import\.meta\.dir\s*,\s*((?:"[^"]*"\s*,?\s*)+)\)/g;
  const out: { file: string; path: string }[] = [];
  for (const file of ["apps", "packages"].flatMap((d) =>
    readdirSync(join(ROOT, d)).flatMap((p) =>
      existsSync(join(ROOT, d, p, "src")) ? sources(join(d, p, "src")) : [],
    ),
  )) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const m of text.matchAll(re)) {
      const segs = [...(m[1] as string).matchAll(/"([^"]*)"/g)].map((s) => s[1] as string);
      out.push({ file, path: relative(ROOT, resolve(ROOT, dirname(file), ...segs)) });
    }
  }
  return out;
}

const ships = (p: string) =>
  p === "" ||
  BUILT.some((b) => p === b || p.startsWith(`${b}/`)) ||
  shippedSet.has(p) ||
  shipped.some((f) => f.startsWith(`${p}/`));

describe("packaging", () => {
  test("every path the code resolves from its own location is in the release", () => {
    const paths = selfRelativePaths();
    expect(paths.length).toBeGreaterThan(12);
    expect(paths.filter((p) => !ships(p.path))).toEqual([]);
  });

  test("the release leaves out tests, fixtures and dev scripts, and keeps the runtime", () => {
    for (const f of shipped)
      expect(/^(fixtures|scripts|\.github)\/|\/(test|e2e|tests)\//.test(f) ? f : "").toBe("");
    for (const f of [
      "apps/cli/src/main.ts",
      "apps/server/src/main.ts",
      "apps/desktop/run.ts",
      "packages/tracking-mlflow/env/uv.lock",
      "packages/tracking-mlflow/env/bridge/ablationkit_bridge.py",
      "python/ablationkit-worker/src/ablationkit_worker/__init__.py",
      "skills/research-task/SKILL.md",
      "packages/extension-host/templates/architecture-viewer/manifest.json",
      "bun.lock",
      "LICENSE",
      "docs/guide/index.html",
      "docs/guide/guide.css",
    ])
      expect([f, shippedSet.has(f)]).toEqual([f, true]);
  });

  test("the AUR package and package.json agree on the version", () => {
    const pkgbuild = readFileSync(join(ROOT, "scripts/packaging/aur/PKGBUILD"), "utf8");
    expect(/^pkgver=(.+)$/m.exec(pkgbuild)?.[1]).toBe(version());
    const srcinfo = readFileSync(join(ROOT, "scripts/packaging/aur/.SRCINFO"), "utf8");
    expect(/^\tpkgver = (.+)$/m.exec(srcinfo)?.[1]).toBe(version());
    // The bun floor in the package matches the one the workspace declares.
    const engines = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).engines.bun;
    expect(pkgbuild).toContain(`'bun${engines}'`);
  });

  test("the launchers and the install script are valid sh", () => {
    for (const script of [CLI_LAUNCHER, DESKTOP_LAUNCHER]) {
      const r = spawnSync("sh", ["-n"], { input: script });
      expect(r.status).toBe(0);
    }
    expect(spawnSync("sh", ["-n", join(ROOT, "scripts/packaging/install.sh")]).status).toBe(0);
    expect(CLI_LAUNCHER).toContain("lib/ablationkit/apps/cli/src/main.ts");
    expect(DESKTOP_LAUNCHER).toContain('apps/desktop/run.ts" --prebuilt');
    expect(desktopEntry()).toMatch(/^Exec=ablationkit-desktop$/m);
  });
});
