/**
 * Child process for crash-recovery tests. Performs a write and SIGKILLs itself at a chosen
 * point, so the parent sees exactly what a real crash leaves on disk.
 *
 *   bun crash.ts json <path> <step> [torn]      step: temp-written | backup-linked | replaced
 *   bun crash.ts jsonl <dir> <committed> <maxSegmentBytes>
 */
import { JsonlLog, type JsonWriteStep, writeJsonAtomic } from "../../src/index.ts";

const die = (): never => {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
};

const [mode, target, a, b] = process.argv.slice(2);
if (!target || !a) throw new Error("usage: crash.ts json|jsonl <path> ...");

if (mode === "json") {
  const step = a as JsonWriteStep;
  const torn = b === "torn";
  writeJsonAtomic(target, { schema_version: 1, value: "old" });
  writeJsonAtomic(
    target,
    { schema_version: 1, value: "new" },
    {
      hooks: {
        onStep: (s) => (s === step ? die() : undefined),
        ...(torn ? { tempBytes: (bytes: Uint8Array) => bytes.subarray(0, bytes.length >> 1) } : {}),
      },
    },
  );
} else if (mode === "jsonl") {
  type Rec = { seq: number; i: number; text: string };
  const committed = Number(a);
  const maxSegmentBytes = Number(b);
  const log = JsonlLog.open<Rec>(target, { maxSegmentBytes });
  for (let i = 0; i < committed; i++) log.append({ i, text: `line ${i} ✓` });
  log.close();
  const crashing = JsonlLog.open<Rec>(target, {
    maxSegmentBytes,
    hooks: {
      appendBytes: (bytes) => bytes.subarray(0, Math.max(1, bytes.length - 7)),
      onStep: (s) => (s === "written" ? die() : undefined),
    },
  });
  crashing.appendBatch([
    { i: committed, text: "torn ✗" },
    { i: committed + 1, text: "torn ✗" },
  ]);
}
throw new Error("child was expected to crash");
