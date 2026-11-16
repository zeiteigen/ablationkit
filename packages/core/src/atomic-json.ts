/**
 * Atomic JSON snapshots (spec §5.2, ADR 0007).
 *
 * Write protocol for `<dir>/<name>`:
 *   1. validate the value (nothing touches disk if it is invalid)
 *   2. write `<dir>/.<name>.tmp-<pid>-<hex>` and fsync it
 *   3. hard-link the current target to `<name>.bak` (atomically, through a temp link)
 *   4. rename the temp file over the target   ← the commit point
 *   5. fsync the directory
 *
 * A crash before step 4 leaves the old target untouched plus a stray temp file; a crash after it
 * leaves the new target. `recoverJsonFile` removes stray temps and, if the target is unreadable,
 * quarantines it and restores `<name>.bak`.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Validator } from "@ablationkit/protocol";
import { fsyncDir, isErrno, quarantinePath, writeAll } from "./fs.ts";

/** Points in the write protocol, exposed to tests that simulate a crash at each one. */
export type JsonWriteStep = "temp-written" | "backup-linked" | "replaced" | "dir-synced";

/** @internal Fault-injection hooks for crash-recovery tests. Never set in product code. */
export interface JsonWriteHooks {
  onStep?(step: JsonWriteStep): void;
  /** Replace the bytes written to the temp file (to simulate a torn write). */
  tempBytes?(bytes: Uint8Array): Uint8Array;
}

export interface WriteJsonOptions<T> {
  validate?: Validator<T>;
  /** fsync the file and directory. Default true; turn off only for rebuildable caches. */
  durable?: boolean;
  /** Keep the previous version as `<name>.bak`. Default true. */
  backup?: boolean;
  /** File mode for new files. Default 0o600: coordinator state is private. */
  mode?: number;
  /** @internal */
  hooks?: JsonWriteHooks;
}

const TEMP_RE = /^\.(.+)\.tmp-[0-9]+-[0-9a-f]{8}$/;
const BACKUP_TEMP_RE = /^\.(.+)\.bak-tmp-[0-9]+-[0-9a-f]{8}$/;

export function backupPath(path: string): string {
  return `${path}.bak`;
}

function tempName(prefix: string, name: string, kind: "tmp" | "bak-tmp"): string {
  return join(prefix, `.${name}.${kind}-${process.pid}-${randomBytes(4).toString("hex")}`);
}

export function serializeJson(value: unknown): Uint8Array {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new TypeError("value is not JSON-serializable");
  return new TextEncoder().encode(`${text}\n`);
}

/** Atomically replace `path` with `value` as pretty-printed JSON. */
export function writeJsonAtomic<T>(
  path: string,
  value: T,
  options: WriteJsonOptions<T> = {},
): void {
  const { validate, durable = true, backup = true, mode = 0o600, hooks } = options;
  if (validate) validate(value);
  const dir = dirname(path);
  const name = basename(path);
  let bytes = serializeJson(value);
  if (hooks?.tempBytes) bytes = hooks.tempBytes(bytes);

  const tmp = tempName(dir, name, "tmp");
  const fd = openSync(tmp, "wx", mode);
  try {
    writeAll(fd, bytes);
    if (durable) fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  hooks?.onStep?.("temp-written");

  try {
    if (backup && existsSync(path)) {
      linkBackup(path, dir, name);
      hooks?.onStep?.("backup-linked");
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  hooks?.onStep?.("replaced");
  if (durable) fsyncDir(dir);
  hooks?.onStep?.("dir-synced");
}

function linkBackup(path: string, dir: string, name: string): void {
  const tmp = tempName(dir, name, "bak-tmp");
  try {
    linkSync(path, tmp);
  } catch (e) {
    // Filesystems without hard links: fall back to a copy.
    if (!isErrno(e, "EPERM") && !isErrno(e, "ENOTSUP") && !isErrno(e, "EXDEV")) throw e;
    copyFileSync(path, tmp);
  }
  renameSync(tmp, backupPath(path));
}

export type JsonReadErrorKind = "missing" | "parse" | "invalid";

export class JsonReadError extends Error {
  readonly kind: JsonReadErrorKind;
  readonly path: string;

  constructor(kind: JsonReadErrorKind, path: string, cause: unknown) {
    super(`${kind} JSON at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "JsonReadError";
    this.kind = kind;
    this.path = path;
  }
}

/** Read, parse and (optionally) validate a JSON file. Has no side effects. */
export function readJson<T = unknown>(path: string, validate?: Validator<T>): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (isErrno(e, "ENOENT")) throw new JsonReadError("missing", path, e);
    throw e;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new JsonReadError("parse", path, e);
  }
  if (!validate) return value as T;
  try {
    return validate(value);
  } catch (e) {
    throw new JsonReadError("invalid", path, e);
  }
}

export type RecoveryActionKind =
  | "removed_temp"
  | "quarantined"
  | "restored_backup"
  | "truncated_tail";

export interface RecoveryAction {
  readonly kind: RecoveryActionKind;
  readonly path: string;
  readonly detail: string;
}

export interface JsonRecoveryReport {
  readonly path: string;
  /** ok: target readable; restored: rebuilt from backup; missing: no file; unrecoverable: left in place. */
  readonly status: "ok" | "restored" | "missing" | "unrecoverable";
  readonly actions: readonly RecoveryAction[];
  readonly error?: string;
}

/** Uncommitted temp files left by interrupted writes of `path`. */
export function strayTempFiles(path: string): string[] {
  const dir = dirname(path);
  const name = basename(path);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if (isErrno(e, "ENOENT")) return [];
    throw e;
  }
  return entries
    .filter((f) => (TEMP_RE.exec(f) ?? BACKUP_TEMP_RE.exec(f))?.[1] === name)
    .sort()
    .map((f) => join(dir, f));
}

/** If `file` is a temp file from an interrupted write, the path of the file it was replacing. */
export function interruptedWriteTarget(file: string): string | undefined {
  const name = basename(file);
  const m = TEMP_RE.exec(name) ?? BACKUP_TEMP_RE.exec(name);
  return m?.[1] === undefined ? undefined : join(dirname(file), m[1]);
}

/**
 * Startup recovery for one JSON snapshot. Removes uncommitted temps (they were never
 * acknowledged), then checks the target; an unreadable target is quarantined and replaced
 * by a valid backup. Nothing is deleted that could be the only copy of committed data.
 */
export function recoverJsonFile<T>(
  path: string,
  options: { validate?: Validator<T>; now?: Date } = {},
): JsonRecoveryReport {
  const now = options.now ?? new Date();
  const actions: RecoveryAction[] = [];
  for (const tmp of strayTempFiles(path)) {
    rmSync(tmp, { force: true });
    actions.push({ kind: "removed_temp", path: tmp, detail: "uncommitted write" });
  }

  let targetError: JsonReadError | undefined;
  try {
    readJson(path, options.validate);
    if (actions.length) fsyncDir(dirname(path));
    return { path, status: "ok", actions };
  } catch (e) {
    if (!(e instanceof JsonReadError)) throw e;
    targetError = e;
  }

  const bak = backupPath(path);
  try {
    readJson(bak, options.validate);
  } catch (e) {
    if (!(e instanceof JsonReadError)) throw e;
    if (actions.length) fsyncDir(dirname(path));
    if (targetError.kind === "missing" && e.kind === "missing") {
      return { path, status: "missing", actions };
    }
    return {
      path,
      status: "unrecoverable",
      actions,
      error: `${targetError.message}; ${e.message}`,
    };
  }

  if (targetError.kind !== "missing") {
    const q = quarantinePath(path, now);
    renameSync(path, q);
    actions.push({ kind: "quarantined", path: q, detail: targetError.message });
  }
  const tmp = tempName(dirname(path), basename(path), "tmp");
  copyFileSync(bak, tmp);
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
  actions.push({ kind: "restored_backup", path, detail: `from ${basename(bak)}` });
  return { path, status: "restored", actions };
}
