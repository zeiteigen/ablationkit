/**
 * What the CLI's tests share: temporary directories, coordinators and fakes cleaned up after each
 * test (`afterEach(h.cleanup)`), and the CLI run with its output captured.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { Coordinator, type CoordinatorOptions } from "@ablationkit/server";
import type { CliContext } from "../src/context.ts";
import { main } from "../src/main.ts";

export const ROOT = resolve(import.meta.dir, "../../..");

export class Harness {
  private readonly dirs: string[] = [];
  private readonly coordinators: Coordinator[] = [];
  private readonly others: { stop(): Promise<void> }[] = [];

  constructor(private readonly base = tmpdir()) {}

  tmp(prefix = "ak-cli-"): string {
    const d = mkdtempSync(join(this.base, prefix));
    this.dirs.push(d);
    return d;
  }

  /**
   * A coordinator of `home` on loopback ports with no MLflow sidecar (tracking tests pass a fake
   * MLflow's `trackingUrl`); `settings` adds to that.
   */
  async start(
    home: string,
    opts: Partial<CoordinatorOptions> = {},
    settings: Partial<CoordinatorSettings> = {},
  ): Promise<Coordinator> {
    const c = await Coordinator.start({
      home,
      log: () => {},
      ...opts,
      settings: {
        schema_version: 1,
        human: { host: "127.0.0.1", port: 0 },
        agent: { host: "127.0.0.1", port: 0 },
        worker: { host: "127.0.0.1", port: 0 },
        mlflow: { enabled: false },
        ...settings,
      },
    });
    this.coordinators.push(c);
    return c;
  }

  /** Something else to stop after the test (a fake MLflow), once the coordinators are. */
  track<T extends { stop(): Promise<void> }>(x: T): T {
    this.others.push(x);
    return x;
  }

  readonly cleanup = async (): Promise<void> => {
    for (const c of this.coordinators.splice(0)) await c.stop();
    for (const x of this.others.splice(0)) await x.stop();
    for (const d of this.dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  };
}

/** A CLI context of `home` whose output collects in `o`. */
export function io(home: string, env: Record<string, string> = {}) {
  const o = { stdout: "", stderr: "" };
  const ctx: CliContext = {
    env,
    home,
    repoRoot: ROOT,
    out: (t) => {
      o.stdout += t;
    },
    err: (t) => {
      o.stderr += t;
    },
  };
  return { o, ctx };
}

/** `ablationkit ARGV` against `home`: its exit code and output. */
export async function cli(home: string, argv: readonly string[]) {
  const { o, ctx } = io(home);
  return { code: await main(argv, ctx), out: o.stdout, err: o.stderr };
}
