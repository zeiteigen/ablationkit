import {
  type CopySyncOptions,
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** fsync a directory so a rename or create inside it survives power loss. */
export function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write every byte, looping over short writes. */
export function writeAll(fd: number, bytes: Uint8Array, position?: number): void {
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(
      fd,
      bytes,
      offset,
      bytes.length - offset,
      position === undefined ? null : position + offset,
    );
    offset += n;
  }
}

/** Filesystem-safe UTC timestamp, e.g. `20261102T100000.123Z`. */
export function compactTimestamp(date: Date): string {
  return date.toISOString().replaceAll("-", "").replaceAll(":", "");
}

/**
 * Name for a quarantined copy of `path`: `<path>.quarantine-<timestamp>[-n]`.
 * Quarantined files are kept for inspection and are never read back automatically.
 */
export function quarantinePath(path: string, now: Date): string {
  const base = `${path}.quarantine-${compactTimestamp(now)}`;
  let candidate = base;
  for (let n = 1; existsSync(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

export function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === code;
}

/** Create `path` (which must not exist) with `bytes`, fsync it and its directory. */
export function writeNewFileDurable(path: string, bytes: Uint8Array, mode = 0o600): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDir(dirname(path));
}

/**
 * `cpSync` for copies out of the installed tree, made owner-writable: copies keep their source's
 * modes, and a read-only install must not make them read-only (ADR 0028).
 */
export function copyWritable(src: string, dest: string, options: CopySyncOptions = {}): void {
  cpSync(src, dest, { recursive: true, ...options });
  ownerWritable(dest);
}

function ownerWritable(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  chmodSync(path, st.mode | (st.isDirectory() ? 0o700 : 0o600));
  if (st.isDirectory()) for (const n of readdirSync(path)) ownerWritable(join(path, n));
}
