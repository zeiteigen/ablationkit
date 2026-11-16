/**
 * `ablationkit extension …` (spec §8, §12; ADR 0022, 0040): the extension author's offline tools
 * (templates, scaffold, validate a directory, doctor) and the researcher's `publish`. Agents
 * validate, build, run and read extensions through `ablationkit mcp`; approving, enabling and
 * rolling back happen in the web UI (Project settings → Extensions), where the researcher reviews
 * the build.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  EXTENSIONS_DIR,
  HOST_API_VERSION,
  IGNORED_DIRS,
  MANIFEST_FILE,
  permissionSummary,
  validateManifest,
} from "@ablationkit/extension-host";
import { listTemplates, scaffoldExtension } from "@ablationkit/extension-host/templates";
import { CoordinatorClient } from "../client.ts";
import {
  type CliContext,
  flag,
  parseArgs,
  printJson,
  projectFromCwd,
  UsageError,
} from "../context.ts";

const EXTENSION_USAGE = `usage:
  ablationkit extension templates                    the templates scaffold can start from
  ablationkit extension scaffold --template T --id ID [--name N] [--model M] [--path CHECKOUT]
                                                     copy a template into .ablationkit/extensions/ID (offline)
  ablationkit extension validate --path DIR          check a manifest and its files (offline)
  ablationkit extension doctor [--path CHECKOUT]     host API compatibility of every extension (offline)
  ablationkit extension publish EXT [--project ID]   publish its approved build to your user registry
  Agents build, run and read extensions through \`ablationkit mcp\`. Approve, enable and roll
  back in the web UI (Project settings → Extensions).`;

// biome-ignore lint/suspicious/noExplicitAny: API JSON rendered for people
type J = any;
const enc = encodeURIComponent;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const f = join(d, n);
      const st = lstatSync(f);
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(n)) walk(f);
      } else if (st.isFile() && !n.endsWith(".pyc")) out.push(relative(dir, f));
    }
  };
  walk(dir);
  return out;
}

/** Validate an extension directory with no coordinator: schema, host API, files, capabilities. */
function validateDir(dir: string): ReturnType<typeof validateManifest> {
  const mf = join(dir, MANIFEST_FILE);
  if (!existsSync(mf))
    return {
      ok: false,
      diagnostics: [{ level: "error", code: "manifest_missing", message: `${mf} does not exist` }],
    };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(mf, "utf8"));
  } catch (e) {
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "manifest_json",
          message: `manifest.json is not valid JSON: ${(e as Error).message}`,
        },
      ],
    };
  }
  return validateManifest(raw, { files: listFiles(dir), dirName: basename(resolve(dir)) });
}

function diagText(d: J): string {
  return `  ${d.level === "error" ? "✗" : "!"} ${d.code}${d.path ? ` (${d.path})` : ""}: ${d.message}${d.fix ? `\n      fix: ${d.fix}` : ""}`;
}

export async function extensionCommand(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest, ["json"]);
  const asJson = args.flags["json"] === true;
  const out = (v: unknown, text: () => string): number => {
    if (asJson) printJson(ctx, v);
    else ctx.out(`${text()}\n`);
    return 0;
  };
  const need = (i: number, what: string): string => {
    const v = args.positional[i];
    if (!v) throw new UsageError(`give ${what}\n\n${EXTENSION_USAGE}`);
    return v;
  };

  // Offline commands: no coordinator needed.
  if (sub === "validate") {
    if (!flag(args, "path"))
      throw new UsageError(
        `give --path DIR (agents validate a project's extension with ablationkit mcp)\n\n${EXTENSION_USAGE}`,
      );
    const r = validateDir(flag(args, "path") as string);
    out({ ok: r.ok, diagnostics: r.diagnostics, host_api_version: HOST_API_VERSION }, () =>
      [
        r.ok ? `valid (host API ${HOST_API_VERSION})` : "invalid",
        ...r.diagnostics.map(diagText),
        ...(r.manifest && r.ok
          ? [
              "permissions requested:",
              ...permissionSummary(r.manifest).map(
                (p) => `  ${p.capability} [${p.enforcement}]${p.bounds ? ` — ${p.bounds}` : ""}`,
              ),
            ]
          : []),
      ].join("\n"),
    );
    return r.ok ? 0 : 1;
  }
  if (sub === "templates") {
    const ts = listTemplates();
    out({ templates: ts }, () =>
      ts
        .map(
          (t) =>
            `${t.name.padEnd(20)} ${t.points.join(", ")}${t.python ? " (Python)" : ""}\n  ${t.description}`,
        )
        .join("\n"),
    );
    return 0;
  }
  if (sub === "scaffold") {
    const template = flag(args, "template");
    const id = flag(args, "id");
    if (!template || !id)
      throw new UsageError(`give --template T and --id ID\n\n${EXTENSION_USAGE}`);
    let r: ReturnType<typeof scaffoldExtension>;
    try {
      r = scaffoldExtension({
        template,
        id,
        checkout: resolve(flag(args, "path") ?? process.cwd()),
        ...(flag(args, "name") ? { name: flag(args, "name") as string } : {}),
        ...(flag(args, "model") ? { model: flag(args, "model") as string } : {}),
      });
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const v = validateDir(r.path);
    out({ ...r, ok: v.ok, diagnostics: v.diagnostics }, () =>
      [
        `created ${relative(process.cwd(), r.path) || r.path} from ${template} (${r.files.length} files)`,
        ...(r.lockError ? [`uv lock failed: ${r.lockError}`] : []),
        v.ok ? "valid" : "invalid:",
        ...v.diagnostics.map(diagText),
        "Next: your agent builds it (the ablationkit_do extension.build MCP tool), then you approve it in the web UI.",
      ].join("\n"),
    );
    return v.ok ? 0 : 1;
  }
  if (sub === "doctor") {
    const root = resolve(flag(args, "path") ?? process.cwd());
    const dir = join(root, EXTENSIONS_DIR);
    const ids = existsSync(dir)
      ? readdirSync(dir).filter((n) => existsSync(join(dir, n, MANIFEST_FILE)))
      : [];
    const rows = ids.map((id) => ({ id, ...validateDir(join(dir, id)) }));
    out(
      {
        host_api_version: HOST_API_VERSION,
        extensions: rows.map((r) => ({ id: r.id, ok: r.ok, diagnostics: r.diagnostics })),
      },
      () =>
        [
          `extension host API ${HOST_API_VERSION}; ${ids.length} extension(s) in ${relative(process.cwd(), dir) || dir}`,
          ...rows.flatMap((r) => [
            `${r.ok ? "✓" : "✗"} ${r.id}${r.manifest ? ` ${r.manifest.version} (host_api ${r.manifest.host_api})` : ""}`,
            ...r.diagnostics.map(diagText),
          ]),
        ].join("\n"),
    );
    return rows.every((r) => r.ok) ? 0 : 1;
  }
  if (sub === undefined || sub === "help" || sub === "--help") {
    ctx.out(`${EXTENSION_USAGE}\n`);
    return 0;
  }

  if (sub === "publish") {
    const project = flag(args, "project") ?? projectFromCwd(process.cwd());
    if (!project)
      throw new UsageError(
        `--project is required outside a registered checkout\n\n${EXTENSION_USAGE}`,
      );
    const client = await CoordinatorClient.connect(ctx, flag(args, "coordinator"));
    const r = await client.request<J>(
      "POST",
      `/api/v1/projects/${enc(project)}/extensions/${enc(need(0, "EXT"))}/publish`,
      {},
    );
    return out(r, () => `published ${r.extension_id} ${r.version} to the user registry`);
  }
  if (sub === "approve" || sub === "enable" || sub === "rollback")
    throw new UsageError(
      `${sub} is done in the web UI (Project settings → Extensions). \`ablationkit ui\` opens it.`,
    );
  throw new UsageError(`unknown extension command ${sub}\n\n${EXTENSION_USAGE}`);
}
