/**
 * Single writer per runtime directory (spec §5.2): the coordinator holds
 * `<home>/coordinator.lock` (O_EXCL create, containing its PID) for its lifetime. A lock whose
 * PID is no longer alive is stale and is replaced. ADR 0009.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export class CoordinatorLockedError extends Error {
  constructor(
    readonly path: string,
    readonly pid: number,
  ) {
    super(`another coordinator (pid ${pid}) holds ${path}`);
    this.name = "CoordinatorLockedError";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLockPid(path: string): number | undefined {
  try {
    const pid = Number.parseInt(JSON.parse(readFileSync(path, "utf8")).pid, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export class RuntimeLock {
  private released = false;
  private constructor(readonly path: string) {}

  /** Acquire or throw CoordinatorLockedError. `staleReplaced` is true if a dead holder's lock was removed. */
  static acquire(path: string): { lock: RuntimeLock; staleReplaced: boolean } {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let staleReplaced = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeSync(
          fd,
          `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
        );
        closeSync(fd);
        return { lock: new RuntimeLock(path), staleReplaced };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const pid = readLockPid(path);
        if (pid !== undefined && pid !== process.pid && alive(pid))
          throw new CoordinatorLockedError(path, pid);
        if (pid === process.pid) throw new CoordinatorLockedError(path, pid);
        rmSync(path, { force: true });
        staleReplaced = true;
      }
    }
    throw new Error(`could not acquire ${path}`);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (readLockPid(this.path) === process.pid) rmSync(this.path, { force: true });
  }
}
