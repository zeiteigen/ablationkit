/**
 * Extension templates (spec §8.4): `packages/extension-host/templates/<name>/` with `__ID__`, `__NAME__` and
 * `__MODEL__` placeholders. `scaffoldExtension` copies one into a checkout's
 * `.ablationkit/extensions/<id>/`, fills the placeholders and, for Python templates, writes
 * `python/uv.lock` with `uv lock`. Nothing is built or approved.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { copyWritable } from "@ablationkit/core";
import { EXTENSIONS_DIR } from "./index.ts";

export const TEMPLATES_DIR = resolve(import.meta.dir, "../templates");
const ID_RE = /^[a-z][a-z0-9-]{1,62}$/;
const TEXT = /\.(json|tsx?|py|toml|md|txt|css)$/;

export interface TemplateInfo {
  readonly name: string;
  readonly description: string;
  readonly points: string[];
  readonly python: boolean;
}

export function listTemplates(dir = TEMPLATES_DIR): TemplateInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => existsSync(join(dir, n, "manifest.json")))
    .sort()
    .map((name) => {
      const m = JSON.parse(readFileSync(join(dir, name, "manifest.json"), "utf8")) as {
        description?: string;
        contributes: { point: string }[];
        python?: unknown;
      };
      return {
        name,
        description: m.description ?? "",
        points: m.contributes.map((c) => c.point),
        python: m.python !== undefined,
      };
    });
}

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else out.push(f);
    }
  };
  walk(dir);
  return out;
}

export interface ScaffoldResult {
  readonly path: string;
  readonly files: string[];
  readonly locked: boolean;
  readonly lockError?: string;
}

export function scaffoldExtension(opts: {
  template: string;
  id: string;
  checkout: string;
  name?: string;
  model?: string;
  uv?: string;
  templatesDir?: string;
}): ScaffoldResult {
  const dir = opts.templatesDir ?? TEMPLATES_DIR;
  const known = listTemplates(dir);
  const t = known.find((x) => x.name === opts.template);
  if (!t)
    throw new Error(
      `no template ${opts.template}; templates: ${known.map((x) => x.name).join(", ")}`,
    );
  if (!ID_RE.test(opts.id))
    throw new Error("the id must be lowercase letters, digits and dashes, starting with a letter");
  const dest = join(opts.checkout, EXTENSIONS_DIR, opts.id);
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  copyWritable(join(dir, opts.template), dest);
  const name = opts.name ?? opts.id;
  const model = opts.model ?? "my-model@champion";
  const written: string[] = [];
  for (const f of files(dest)) {
    written.push(relative(dest, f));
    if (!TEXT.test(f)) continue;
    const s = readFileSync(f, "utf8");
    const out = s
      .replaceAll("__ID__", opts.id)
      .replaceAll("__NAME__", f.endsWith(".json") ? JSON.stringify(name).slice(1, -1) : name)
      .replaceAll("__MODEL__", model);
    if (out !== s) writeFileSync(f, out);
  }
  let locked = false;
  let lockError: string | undefined;
  if (t.python) {
    const r = spawnSync(opts.uv ?? "uv", ["lock", "--project", join(dest, "python")], {
      encoding: "utf8",
      env: { ...process.env, UV_NO_CONFIG: "1" },
    });
    locked = r.status === 0;
    if (!locked) lockError = (r.stderr || r.stdout || String(r.error ?? "")).trim().slice(-2000);
    else written.push("python/uv.lock");
  }
  return { path: dest, files: written.sort(), locked, ...(lockError ? { lockError } : {}) };
}
