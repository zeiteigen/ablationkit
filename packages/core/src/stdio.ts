/**
 * Standard output that survives `process.exit` (stress finding F37).
 *
 * Bun writes to a pipe asynchronously: a write larger than the pipe buffer (64 KiB on Linux)
 * is only partly in the pipe when it returns, and `process.exit` drops the rest. So a CLI
 * printing a long JSON document into `| jq` or an agent's tool call got cut at 65,536 bytes.
 * Every write here registers its completion callback; `exitAfterFlush` waits for all of them
 * (a reader that closed early completes them with EPIPE, so this never waits on a dead pipe).
 */
const pending = new Set<Promise<void>>();

function tracked(stream: NodeJS.WriteStream, text: string): void {
  const done = new Promise<void>((resolve) => {
    stream.write(text, () => resolve());
  });
  pending.add(done);
  void done.then(() => pending.delete(done));
}

export function writeStdout(text: string): void {
  tracked(process.stdout, text);
}

export function writeStderr(text: string): void {
  tracked(process.stderr, text);
}

/** Resolves once every write made through `writeStdout`/`writeStderr` so far has been handed to the OS. */
export async function flushStdio(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

/** `process.exit(code)` after the tracked output has drained. */
export async function exitAfterFlush(code: number): Promise<never> {
  await flushStdio();
  process.exit(code);
}
