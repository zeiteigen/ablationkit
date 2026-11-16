/**
 * @ablationkit/core: file storage for coordinator-owned state (spec §5.1–5.2, ADR 0007).
 *
 * Single writer: every function here assumes the calling process is the only writer of the
 * files it touches (the coordinator serializes mutations). Nothing here takes a lock.
 */
export * from "./atomic-json.ts";
export * from "./diagnose.ts";
export { compactTimestamp, copyWritable, quarantinePath } from "./fs.ts";
export * from "./git.ts";
export * from "./jsonl.ts";
export * from "./migrations.ts";
export { exitAfterFlush, flushStdio, writeStderr, writeStdout } from "./stdio.ts";
