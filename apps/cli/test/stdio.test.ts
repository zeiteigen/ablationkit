import { expect, test } from "bun:test";
import { resolve } from "node:path";

const MAIN = resolve(import.meta.dir, "../src/main.ts");
const CORE = resolve(import.meta.dir, "../../../packages/core/src/index.ts");

/** Byte count a slow reader gets: it starts reading only after the writer has called exit. */
async function slowReaderBytes(script: string, env: Record<string, string>): Promise<number> {
  const p = Bun.spawn(["sh", "-c", `${script} | (sleep 0.4; wc -c)`], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return Number(out.trim());
}

// F37: `process.exit` straight after a large write cut piped output at 64 KiB.
test("the CLI's output into a pipe is not cut at 64 KiB when it exits", async () => {
  const big = "x".repeat(100_000);
  // An unknown command echoes its arguments and the usage text to stderr, then exits 2.
  const bytes = await slowReaderBytes(`bun "${MAIN}" "$AK_BIG" 2>&1 >/dev/null`, { AK_BIG: big });
  expect(bytes).toBeGreaterThan(100_000);
});

test("writeStdout output survives exitAfterFlush into a pipe", async () => {
  const code = `import { exitAfterFlush, writeStdout } from ${JSON.stringify(CORE)};
writeStdout("y".repeat(300000));
writeStdout("\\n");
await exitAfterFlush(0);`;
  const bytes = await slowReaderBytes(`bun -e "$AK_CODE"`, { AK_CODE: code });
  expect(bytes).toBe(300_001);
});
