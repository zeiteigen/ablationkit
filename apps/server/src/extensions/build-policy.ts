/** Build unapproved source as data: no macros and no imports outside its snapshot/public SDKs. */

import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { parse } from "@babel/parser";

export function rejectBuildMacros(file: string, source: string): void {
  const tree = parse(source, {
    sourceType: "unambiguous",
    plugins: ["typescript", ...(file.endsWith("x") ? ["jsx" as const] : [])],
  });
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (
      node["type"] === "StringLiteral" &&
      typeof node["value"] === "string" &&
      node["value"].startsWith("macro:")
    )
      throw new Error("Extension builds cannot execute macro imports");
    const attributes = node["attributes"] as { value?: { value?: unknown } }[] | undefined;
    if (attributes?.some((attribute) => attribute.value?.value === "macro"))
      throw new Error("Extension builds cannot execute macros before approval");
    const callee = node["callee"] as { type?: string } | undefined;
    if (
      (node["type"] === "ImportExpression" && node["options"]) ||
      (callee?.type === "Import" && (node["arguments"] as unknown[]).length > 1)
    )
      throw new Error("Dynamic import attributes are not supported in extension builds");
    for (const child of Object.values(node)) visit(child);
  };
  visit(tree);
}

const PUBLIC = [
  "@ablationkit/extension-host",
  "@ablationkit/extension-sdk",
  "@ablationkit/protocol",
  "@ablationkit/core",
  "@ablationkit/data-controls",
];

export function backendBuildPolicy(srcDir: string): Bun.BunPlugin {
  const root = resolve(srcDir);
  return {
    name: "approved-public-backend-api",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.importer && !resolve(args.importer).startsWith(`${root}/`)) return undefined;
        const spec = args.path;
        if (spec.startsWith(".") || spec.startsWith("/")) {
          const path = resolve(args.importer ? dirname(args.importer) : root, spec);
          if (!path.startsWith(`${root}/`))
            throw new Error("Backend import leaves the extension snapshot");
          return undefined;
        }
        if (spec === "bun" || spec.startsWith("node:") || spec.startsWith("bun:"))
          return { path: spec, external: true };
        if (PUBLIC.some((name) => spec === name || spec.startsWith(`${name}/`)))
          return { path: import.meta.resolve(spec).replace("file://", "") };
        throw new Error(`Backend dependency is not a public host API: ${spec}`);
      });
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
        if (!resolve(args.path).startsWith(`${root}/`)) return undefined;
        const source = readFileSync(args.path, "utf8");
        rejectBuildMacros(args.path, source);
        const extension = extname(args.path);
        const loader =
          extension === ".tsx"
            ? "tsx"
            : extension === ".jsx"
              ? "jsx"
              : extension.includes("ts")
                ? "ts"
                : "js";
        return { contents: source, loader };
      });
    },
  };
}
