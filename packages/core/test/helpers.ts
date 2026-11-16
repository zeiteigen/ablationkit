import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

/** A fresh temporary directory, removed after the test. */
export function tempDir(): string {
  const d = mkdtempSync(join(process.env["AK_TEST_TMPDIR"] ?? tmpdir(), "ak-core-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CHILD = join(import.meta.dir, "children/crash.ts");

/** Run the crash child and assert it died from SIGKILL (not an ordinary error). */
export function crashChild(...args: string[]): void {
  const proc = Bun.spawnSync([process.execPath, CHILD, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.signalCode !== "SIGKILL") {
    throw new Error(
      `child did not crash as planned (exit ${proc.exitCode}, signal ${proc.signalCode}):\n${proc.stderr}`,
    );
  }
}
