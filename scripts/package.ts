/**
 * Stage a release (ADR 0028). The installed layout is the source tree itself, so every path the
 * code resolves from `import.meta.dir` (packages/tracking-mlflow/env, the Python SDKs, apps/web/dist, templates,
 * skills, the extension SDK, the CLI the coordinator unit and `.mcp.json` run) stays valid:
 *
 *   <out>/bin/ablationkit                         sh launcher: bun lib/ablationkit/apps/cli/src/main.ts
 *   <out>/bin/ablationkit-desktop                 sh launcher: the prebuilt Electron shell
 *   <out>/lib/ablationkit/                        the tree, built web UI and shell, production deps
 *   <out>/share/applications/ablationkit.desktop
 *   <out>/share/icons/hicolor/scalable/apps/ablationkit.svg
 *
 * Nothing writes into the tree at run time; state lives in ABLATIONKIT_HOME (`~/.ablationkit`).
 *
 *   bun scripts/package.ts --out DIR [--tar FILE]    stage from this checkout's tracked files
 *   bun scripts/package.ts --source-tarball FILE      `git archive` of HEAD (the PKGBUILD's source)
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");

export function version(root = ROOT): string {
  const v = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string })
    .version;
  if (!v) throw new Error("package.json has no version");
  return v;
}

/** Tracked paths that are not part of an install: tests, fixtures, CI and dev scripts. */
const EXCLUDE: readonly RegExp[] = [
  /^fixtures\//,
  /^\.github\//,
  /^scripts\//,
  /^(apps|packages)\/[^/]+\/(test|e2e)\//,
  /^python\/[^/]+\/tests\//,
  /^packages\/builtin-llm\/src\/python\/[^/]+\/tests\//,
  /^\.(editorconfig|gitignore)$/,
  /^biome\.json$/,
  /^SOURCE-COMMIT$/,
];

export function releaseFiles(tracked: readonly string[]): string[] {
  return tracked.filter((f) => f.length > 0 && !EXCLUDE.some((r) => r.test(f))).sort();
}

function git(args: string[], cwd = ROOT): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

function run(cmd: string[], cwd: string): void {
  const r = spawnSync(cmd[0] as string, cmd.slice(1), { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd.join(" ")} exited ${r.status ?? r.signal}`);
}

/** Directories a source tarball grows once it is installed and built; never part of the tree. */
const GENERATED = new Set([
  "node_modules",
  "dist",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".git",
]);

/**
 * A checkout: tracked files plus untracked ones not ignored, as they are in the working tree.
 * A source tarball (`git archive`, the PKGBUILD's source): every file but generated directories.
 */
export function sourceFiles(root: string): string[] {
  if (existsSync(join(root, ".git")))
    return git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root)
      .split("\0")
      .filter((f) => f && existsSync(join(root, f)));
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const n of readdirSync(join(root, rel))) {
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(join(root, r));
      if (st.isDirectory()) {
        if (!GENERATED.has(n)) walk(r);
      } else out.push(r);
    }
  };
  walk("");
  return out;
}

export const CLI_LAUNCHER = `#!/bin/sh
# AblationKit CLI launcher (scripts/package.ts). Bun runs the CLI from the installed tree.
here=$(dirname "$(readlink -f "$0")")
bun=\${ABLATIONKIT_BUN:-$(command -v bun)}
if [ -z "$bun" ]; then
  echo "ablationkit: bun not found; install it (Arch: pacman -S bun) or set ABLATIONKIT_BUN" >&2
  exit 127
fi
exec "$bun" "$here/../lib/ablationkit/apps/cli/src/main.ts" "$@"
`;

export const DESKTOP_LAUNCHER = `#!/bin/sh
# AblationKit desktop launcher (scripts/package.ts): the prebuilt shell on the system Electron.
here=$(dirname "$(readlink -f "$0")")
bun=\${ABLATIONKIT_BUN:-$(command -v bun)}
if [ -z "$bun" ]; then
  echo "ablationkit-desktop: bun not found; install it (Arch: pacman -S bun) or set ABLATIONKIT_BUN" >&2
  exit 127
fi
ABLATIONKIT_BUN=$bun exec "$bun" "$here/../lib/ablationkit/apps/desktop/run.ts" --prebuilt "$@"
`;

export function desktopEntry(exec = "ablationkit-desktop"): string {
  return `[Desktop Entry]
Type=Application
Name=AblationKit
Comment=Local-first ML experimentation workspace
Exec=${exec}
Icon=ablationkit
Terminal=false
Categories=Development;Science;
StartupWMClass=AblationKit
`;
}

export const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#1f2a37"/>
  <path d="M14 46 L26 18 L38 46" fill="none" stroke="#e5e7eb" stroke-width="5" stroke-linejoin="round"/>
  <path d="M19 36 H33" stroke="#e5e7eb" stroke-width="5"/>
  <path d="M42 18 V46 M42 32 L52 20 M44 30 L53 46" fill="none" stroke="#60a5fa" stroke-width="5" stroke-linecap="round"/>
</svg>
`;

export interface StageOptions {
  readonly out: string;
  /** Source checkout (default: this one). It needs `bun install` done, for the builds. */
  readonly root?: string;
  /** Skip the web and desktop builds when their dist/ already exist (tests). */
  readonly reuseBuilds?: boolean;
  readonly log?: (line: string) => void;
}

export async function stage(o: StageOptions): Promise<{ version: string; files: number }> {
  const root = o.root ?? ROOT;
  const log = o.log ?? ((l: string) => console.log(l));
  const v = version(root);
  const out = resolve(o.out);
  const lib = join(out, "lib", "ablationkit");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(lib, { recursive: true });

  const files = releaseFiles(sourceFiles(root));
  for (const f of files) {
    const from = join(root, f);
    const dest = join(lib, f);
    mkdirSync(dirname(dest), { recursive: true });
    if (lstatSync(from).isSymbolicLink()) {
      // Tracked links (skills/ → packages/builtin-llm/src/skills/) stay links inside the tree.
      const target = readlinkSync(from);
      if (isAbsolute(target) || relative(lib, resolve(dirname(dest), target)).startsWith(".."))
        throw new Error(`${f} links outside the tree (${target})`);
      symlinkSync(target, dest);
      continue;
    }
    copyFileSync(from, dest);
    chmodSync(dest, statSync(from).mode & 0o777);
  }
  log(`copied ${files.length} files`);

  const webDist = join(root, "apps/web/dist");
  const deskDist = join(root, "apps/desktop/dist");
  if (!(o.reuseBuilds && existsSync(join(webDist, "index.html")))) {
    const { buildWeb } = await import(join(root, "apps/web/build.ts"));
    await buildWeb({ minify: true });
  }
  if (!(o.reuseBuilds && existsSync(join(deskDist, "main.cjs")))) {
    const { buildDesktop } = await import(join(root, "apps/desktop/build.ts"));
    await buildDesktop();
  }
  cpSync(webDist, join(lib, "apps/web/dist"), { recursive: true });
  cpSync(deskDist, join(lib, "apps/desktop/dist"), { recursive: true });
  log("built the web UI and the desktop shell");

  run(["bun", "install", "--frozen-lockfile", "--production", "--ignore-scripts", "--silent"], lib);
  log("installed production dependencies");

  let commit = "unknown";
  let dirty = false;
  try {
    commit = git(["rev-parse", "HEAD"], root).trim();
    dirty = git(["status", "--porcelain"], root).trim().length > 0;
  } catch {
    // A source tarball (the PKGBUILD's) has no .git; `--source-tarball` records the commit.
    const f = join(root, "SOURCE-COMMIT");
    if (existsSync(f)) commit = readFileSync(f, "utf8").trim();
  }
  writeFileSync(
    join(lib, "BUILD-INFO.json"),
    `${JSON.stringify({ version: v, commit, dirty, built_at: new Date().toISOString() }, null, 2)}\n`,
  );

  mkdirSync(join(out, "bin"), { recursive: true });
  writeFileSync(join(out, "bin/ablationkit"), CLI_LAUNCHER, { mode: 0o755 });
  writeFileSync(join(out, "bin/ablationkit-desktop"), DESKTOP_LAUNCHER, { mode: 0o755 });
  mkdirSync(join(out, "share/applications"), { recursive: true });
  writeFileSync(join(out, "share/applications/ablationkit.desktop"), desktopEntry());
  mkdirSync(join(out, "share/icons/hicolor/scalable/apps"), { recursive: true });
  writeFileSync(join(out, "share/icons/hicolor/scalable/apps/ablationkit.svg"), ICON);
  mkdirSync(join(out, "share/licenses/ablationkit"), { recursive: true });
  copyFileSync(join(root, "LICENSE"), join(out, "share/licenses/ablationkit/LICENSE"));
  copyFileSync(join(root, "scripts/packaging/install.sh"), join(out, "install.sh"));
  chmodSync(join(out, "install.sh"), 0o755);
  return { version: v, files: files.length };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const src = opt("--source-tarball");
  const out = opt("--out");
  if (src) {
    const v = version();
    const head = git(["rev-parse", "HEAD"]).trim();
    git([
      "archive",
      "--format=tar.gz",
      `--prefix=ablationkit-${v}/`,
      `--add-virtual-file=ablationkit-${v}/SOURCE-COMMIT:${head}\n`,
      "-o",
      resolve(src),
      "HEAD",
    ]);
    console.log(`wrote ${src} (ablationkit-${v}, ${git(["rev-parse", "--short", "HEAD"]).trim()})`);
  } else if (out) {
    const r = await stage({ out });
    const tar = opt("--tar");
    if (tar) {
      const name = `ablationkit-${r.version}`;
      run(
        ["tar", "-czf", resolve(tar), `--transform=s,^\\.,${name},`, "--owner=0", "--group=0", "."],
        resolve(out),
      );
      console.log(`wrote ${tar}`);
    }
    console.log(`staged ablationkit ${r.version} in ${out}`);
  } else {
    console.error(
      "usage: bun scripts/package.ts --out DIR [--tar FILE] | --source-tarball FILE.tar.gz",
    );
    process.exit(2);
  }
}
