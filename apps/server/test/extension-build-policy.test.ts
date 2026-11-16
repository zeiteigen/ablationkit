import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendBuildPolicy } from "../src/extensions/build-policy.ts";
import { bundleEntry } from "../src/extensions/host.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ak-build-policy-"));
  temporary.push(dir);
  const root = join(dir, "snapshot");
  mkdirSync(root);
  const sentinel = join(dir, "backend-executed");
  return { dir, root, sentinel };
}

function macroFixture(attribute: string) {
  const state = fixture();
  writeFileSync(
    join(state.root, "macro.ts"),
    `
    import { writeFileSync } from 'node:fs';
    export function touch() {
      writeFileSync(${JSON.stringify(state.sentinel)}, 'macro executed during build');
      return 'expanded';
    }
  `,
  );
  writeFileSync(
    join(state.root, "entry.ts"),
    `
    import { touch } from './macro.ts' ${attribute};
    export const value = touch();
  `,
  );
  return state;
}

async function build(root: string) {
  return Bun.build({
    entrypoints: [join(root, "entry.ts")],
    target: "bun",
    format: "esm",
    plugins: [backendBuildPolicy(root)],
    throw: false,
  });
}

function messages(result: Awaited<ReturnType<typeof Bun.build>>): string {
  return result.logs.map((log) => log.message).join("\n");
}

const MACRO_ATTRIBUTES = [
  ["plain", 'with { type: "macro" }'],
  ["Unicode escape", String.raw`with { type: "\u006dacro" }`],
  [
    "comments",
    'with /* attribute comment */ { type /* key comment */: /* value comment */ "macro" }',
  ],
] as const;

describe("unapproved backend build policy", () => {
  test.each(MACRO_ATTRIBUTES)(
    "%s macro attributes fail before macro execution",
    async (_label, attribute) => {
      const { root, sentinel } = macroFixture(attribute);
      const result = await build(root);
      expect(result.success).toBe(false);
      expect(messages(result)).toMatch(/cannot execute macros before approval/i);
      expect(existsSync(sentinel)).toBe(false);
    },
  );

  test("outside relative dependencies are rejected", async () => {
    const { dir, root } = fixture();
    writeFileSync(join(dir, "outside.ts"), "export const value = 'outside';");
    writeFileSync(
      join(root, "entry.ts"),
      "import { value } from '../outside.ts'; export { value };",
    );
    const result = await build(root);
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Backend import leaves the extension snapshot");
  });

  test("coordinator implementation imports are rejected", async () => {
    const { root } = fixture();
    writeFileSync(
      join(root, "entry.ts"),
      "import { Coordinator } from '@ablationkit/server'; export { Coordinator };",
    );
    const result = await build(root);
    expect(result.success).toBe(false);
    expect(messages(result)).toContain(
      "Backend dependency is not a public host API: @ablationkit/server",
    );
  });

  test("public backend types and runtime APIs bundle without running extension top-level code", async () => {
    const { root, sentinel } = fixture();
    writeFileSync(join(root, "helper.ts"), "export const local = 'snapshot-local';");
    writeFileSync(
      join(root, "entry.ts"),
      `
      // A comment mentioning with { type: 'macro' } is ordinary source text.
      /* import { touch } from 'macro:./comment-only.ts'; */
      import type { BackendContext } from '@ablationkit/extension-host/backend';
      import { researchHost } from '@ablationkit/extension-host/backend-client';
      import { writeFileSync } from 'node:fs';
      import { local } from './helper.ts';
      writeFileSync(${JSON.stringify(sentinel)}, 'backend executed');
      export function host(ctx: BackendContext) { return researchHost(ctx); }
      export { local };
    `,
    );
    const result = await build(root);
    expect(messages(result)).toBe("");
    expect(result.success).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
    const output = await result.outputs[0]?.text();
    expect(output).toContain("backend-executed");
    expect(output).toContain("snapshot-local");
  });
});

describe("unapproved v1 UI build policy", () => {
  test.each(MACRO_ATTRIBUTES)(
    "%s macro attributes fail without executing the macro",
    async (_label, attribute) => {
      const { root, sentinel } = macroFixture(attribute);
      const result = await bundleEntry(root, "entry.ts");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Unexpected macro build success");
      expect(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(
        /cannot execute macros before approval/i,
      );
      expect(existsSync(sentinel)).toBe(false);
    },
  );
});
