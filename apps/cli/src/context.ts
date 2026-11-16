import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeStderr, writeStdout } from "@ablationkit/core";
import type { CliContext } from "@ablationkit/extension-host/cli";
import { resolveHome } from "@ablationkit/server";

export type { CliContext, ParsedArgs } from "@ablationkit/extension-host/cli";
export { flag, parseArgs, printJson, UsageError } from "@ablationkit/extension-host/cli";

export function processContext(repoRoot: string): CliContext {
  return {
    env: process.env,
    home: resolveHome(process.env),
    repoRoot,
    // Tracked writes: `main.ts` exits only after they drain into a pipe (F37).
    out: writeStdout,
    err: writeStderr,
  };
}

/** `.ablationkit/project.json` in `cwd` or a parent: the registered checkout's project ID. */
export function projectFromCwd(cwd: string): string | undefined {
  let d = cwd;
  for (;;) {
    const m = join(d, ".ablationkit", "project.json");
    if (existsSync(m)) {
      try {
        return (JSON.parse(readFileSync(m, "utf8")) as { project_id?: string }).project_id;
      } catch {
        return undefined;
      }
    }
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}
