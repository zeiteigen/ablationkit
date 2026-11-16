/**
 * Append-only JSONL journals with sequence numbers and size-based rotation (spec §5.2, ADR 0007).
 *
 * A journal is a directory of segments `<name>-0001.jsonl`, `<name>-0002.jsonl`, … Each line is
 * one complete JSON object carrying `seq`, assigned here by the single writer and strictly
 * increasing across segments. A line is committed once its terminating `\n` is on disk.
 *
 * Opening a journal recovers the tail of the last segment: an unterminated final line (a torn
 * write) is copied to a quarantine file and truncated away; so is a final terminated line that is
 * not a JSON object with an integer `seq`. Damage anywhere else is reported, never rewritten.
 */
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Validator } from "@ablationkit/protocol";
import type { RecoveryAction } from "./atomic-json.ts";
import { fsyncDir, quarantinePath, writeAll, writeNewFileDurable } from "./fs.ts";

export const DEFAULT_MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

export type AppendStep = "written" | "synced" | "rotated";

/** @internal Fault-injection hooks for crash-recovery tests. Never set in product code. */
export interface AppendHooks {
  onStep?(step: AppendStep): void;
  /** Replace the bytes of one append before they are written (to simulate a torn write). */
  appendBytes?(bytes: Uint8Array): Uint8Array;
}

export interface JsonlOptions<T> {
  /** Segment name prefix. Default `events`. */
  name?: string;
  /** Start a new segment before an append would exceed this size. A single oversized batch still gets written, alone. */
  maxSegmentBytes?: number;
  /** fsync after every append. Default true. When false, a crash can lose acknowledged appends. */
  durable?: boolean;
  /** Validates each full record (including `seq`) before anything is written. */
  validate?: Validator<T>;
  now?: () => Date;
  /** @internal */
  hooks?: AppendHooks;
}

export interface JsonlRecoveryReport {
  readonly actions: readonly RecoveryAction[];
  /** Sequence number of the last committed record, or undefined for an empty journal. */
  readonly lastSeq: number | undefined;
}

export class JsonlCorruptionError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`corrupt journal segment ${path}: ${detail}`);
    this.name = "JsonlCorruptionError";
    this.path = path;
  }
}

export function segmentFileName(name: string, index: number): string {
  return `${name}-${String(index).padStart(4, "0")}.jsonl`;
}

/** Segments of journal `name` in `dir`, in order, as `[index, path]`. */
export function listSegments(dir: string, name = "events"): [number, string][] {
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-([0-9]{4,})\\.jsonl$`);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries
    .flatMap((f): [number, string][] => {
      const m = re.exec(f);
      return m?.[1] ? [[Number(m[1]), join(dir, f)]] : [];
    })
    .sort((a, b) => a[0] - b[0]);
}

const NL = 0x0a;
const CHUNK = 64 * 1024;

/** Offset of the last `\n` strictly before `end`, or -1. */
function lastNewlineBefore(fd: number, end: number): number {
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = end;
  while (pos > 0) {
    const start = Math.max(0, pos - CHUNK);
    const n = readSync(fd, buf, 0, pos - start, start);
    const i = buf.subarray(0, n).lastIndexOf(NL);
    if (i >= 0) return start + i;
    pos = start;
  }
  return -1;
}

function readRange(fd: number, start: number, end: number): Buffer {
  const buf = Buffer.allocUnsafe(end - start);
  let off = 0;
  while (off < buf.length) {
    const n = readSync(fd, buf, off, buf.length - off, start + off);
    if (n === 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

/** The seq of a committed line, or undefined if the line is not a JSON object with an integer seq. */
function lineSeq(bytes: Uint8Array): number | undefined {
  try {
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
    const seq = (v as { seq?: unknown }).seq;
    return Number.isSafeInteger(seq) && (seq as number) >= 0 ? (seq as number) : undefined;
  } catch {
    return undefined;
  }
}

type Tail = { kind: "empty" } | { kind: "ok"; seq: number } | { kind: "bad"; start: number };

function inspectLastLine(fd: number, size: number): Tail {
  if (size === 0) return { kind: "empty" };
  const start = lastNewlineBefore(fd, size - 1) + 1;
  const seq = lineSeq(readRange(fd, start, size - 1));
  return seq === undefined ? { kind: "bad", start } : { kind: "ok", seq };
}

/**
 * Recover the tail of one segment in place. Returns the actions taken and the seq of its last
 * committed line. Only the final line is ever removed, and it is always quarantined first.
 */
function recoverSegmentTail(
  path: string,
  now: () => Date,
): { actions: RecoveryAction[]; lastSeq: number | undefined } {
  const actions: RecoveryAction[] = [];
  const fd = openSync(path, "r+");
  try {
    let size = fstatSync(fd).size;
    const cut = (start: number, reason: string) => {
      const bytes = readRange(fd, start, size);
      const q = quarantinePath(path, now());
      writeNewFileDurable(q, bytes);
      actions.push({ kind: "quarantined", path: q, detail: `${bytes.length} bytes: ${reason}` });
      ftruncateSync(fd, start);
      fsyncSync(fd);
      actions.push({ kind: "truncated_tail", path, detail: `to ${start} bytes` });
      size = start;
    };

    if (size > 0) {
      const lastNl = lastNewlineBefore(fd, size);
      if (lastNl !== size - 1) cut(lastNl + 1, "incomplete trailing line");
    }
    let tail = inspectLastLine(fd, size);
    if (tail.kind === "bad") {
      cut(tail.start, "unparseable trailing line");
      tail = inspectLastLine(fd, size);
      if (tail.kind === "bad") {
        throw new JsonlCorruptionError(path, "more than one damaged line at the tail");
      }
    }
    if (actions.length) fsyncDir(dirname(path));
    return { actions, lastSeq: tail.kind === "ok" ? tail.seq : undefined };
  } finally {
    closeSync(fd);
  }
}

export class JsonlLog<T extends { seq: number }> {
  readonly dir: string;
  readonly name: string;
  readonly recovery: JsonlRecoveryReport;
  private readonly maxSegmentBytes: number;
  private readonly durable: boolean;
  private readonly validate: Validator<T> | undefined;
  private readonly hooks: AppendHooks | undefined;
  private segmentIndex: number;
  private fd: number | undefined;
  private size: number;
  private next: number;
  private broken: Error | undefined;

  private constructor(dir: string, options: JsonlOptions<T>) {
    this.dir = dir;
    this.name = options.name ?? "events";
    this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
    this.durable = options.durable ?? true;
    this.validate = options.validate;
    this.hooks = options.hooks;
    const now = options.now ?? (() => new Date());

    mkdirSync(dir, { recursive: true });
    const segments = listSegments(dir, this.name);
    const actions: RecoveryAction[] = [];
    let lastSeq: number | undefined;
    const last = segments.at(-1);
    if (last) {
      const r = recoverSegmentTail(last[1], now);
      actions.push(...r.actions);
      lastSeq = r.lastSeq;
      // An empty last segment (fresh rotation, or a torn first line): the seq lives in an earlier one.
      for (let i = segments.length - 2; lastSeq === undefined && i >= 0; i--) {
        lastSeq = closedSegmentLastSeq((segments[i] as [number, string])[1]);
      }
    }
    this.recovery = { actions, lastSeq };
    this.next = lastSeq === undefined ? 0 : lastSeq + 1;
    this.segmentIndex = last?.[0] ?? 1;
    this.size = 0;
    this.openSegment();
  }

  /** Open (creating if needed) a journal, recovering a damaged tail first. See `recovery`. */
  static open<T extends { seq: number }>(dir: string, options: JsonlOptions<T> = {}): JsonlLog<T> {
    return new JsonlLog<T>(dir, options);
  }

  /** Sequence number the next appended record will receive. */
  get nextSeq(): number {
    return this.next;
  }

  get currentSegment(): string {
    return join(this.dir, segmentFileName(this.name, this.segmentIndex));
  }

  append(record: Omit<T, "seq">): T {
    return this.appendBatch([record])[0] as T;
  }

  /** Append records as one write (and one fsync), assigning consecutive sequence numbers. */
  appendBatch(records: readonly Omit<T, "seq">[]): T[] {
    if (this.broken) throw new Error(`journal is unusable until reopened: ${this.broken.message}`);
    if (this.fd === undefined) throw new Error("journal is closed");
    if (records.length === 0) return [];
    const stored = records.map((r, i) => {
      if ("seq" in r) throw new TypeError("records must not carry seq; the journal assigns it");
      const rec = { seq: this.next + i, ...r } as T;
      this.validate?.(rec);
      return rec;
    });
    let bytes: Uint8Array = new TextEncoder().encode(
      stored.map((r) => `${JSON.stringify(r)}\n`).join(""),
    );
    if (this.size > 0 && this.size + bytes.length > this.maxSegmentBytes) this.rotate();
    if (this.hooks?.appendBytes) bytes = this.hooks.appendBytes(bytes);

    const fd = this.fd as number;
    try {
      writeAll(fd, bytes);
      this.hooks?.onStep?.("written");
      if (this.durable) fsyncSync(fd);
    } catch (e) {
      // Never leave a partial line for the next append to extend: roll back, or refuse more writes.
      try {
        ftruncateSync(fd, this.size);
      } catch {
        this.broken = e instanceof Error ? e : new Error(String(e));
      }
      throw e;
    }
    this.hooks?.onStep?.("synced");
    this.size += bytes.length;
    this.next += stored.length;
    return stored;
  }

  close(): void {
    if (this.fd === undefined) return;
    if (this.durable) fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = undefined;
  }

  private openSegment(): void {
    const path = this.currentSegment;
    this.fd = openSync(path, "a", 0o600);
    this.size = fstatSync(this.fd).size;
    if (this.durable) fsyncDir(this.dir);
  }

  private rotate(): void {
    this.close();
    this.segmentIndex += 1;
    this.openSegment();
    this.hooks?.onStep?.("rotated");
  }
}

/** Last seq of a segment that should already be fully committed (not the active one). */
function closedSegmentLastSeq(path: string): number | undefined {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > 0 && lastNewlineBefore(fd, size) !== size - 1) {
      throw new JsonlCorruptionError(path, "closed segment ends with an incomplete line");
    }
    const tail = inspectLastLine(fd, size);
    if (tail.kind === "bad")
      throw new JsonlCorruptionError(path, "closed segment has a bad last line");
    return tail.kind === "ok" ? tail.seq : undefined;
  } finally {
    closeSync(fd);
  }
}

export interface ReadJsonlOptions<T> {
  name?: string;
  /** Skip records with seq below this. Whole segments before it are skipped without parsing. */
  fromSeq?: number;
  validate?: Validator<T>;
}

/**
 * Stream committed records in seq order without loading the journal into memory. An
 * unterminated final line (an append in progress, or an unrecovered crash) is not yielded. A
 * damaged committed line, or a seq that does not increase, throws JsonlCorruptionError.
 */
export async function* readJsonl<T extends { seq: number }>(
  dir: string,
  options: ReadJsonlOptions<T> = {},
): AsyncGenerator<T> {
  const { fromSeq = 0, validate } = options;
  const segments = listSegments(dir, options.name ?? "events");
  let prev = -1;
  for (const [i, [, path]] of segments.entries()) {
    const following = segments[i + 1];
    if (following && fromSeq > 0) {
      const first = await firstSeq(following[1]);
      if (first !== undefined && first <= fromSeq) continue;
    }
    let lineNo = 0;
    for await (const line of committedLines(path)) {
      lineNo += 1;
      let rec: T;
      try {
        const v = JSON.parse(line) as T;
        rec = validate ? validate(v) : v;
      } catch (e) {
        throw new JsonlCorruptionError(path, `line ${lineNo}: ${(e as Error).message}`);
      }
      if (!Number.isSafeInteger(rec.seq) || rec.seq <= prev) {
        throw new JsonlCorruptionError(path, `line ${lineNo}: seq ${rec.seq} after ${prev}`);
      }
      prev = rec.seq;
      if (rec.seq >= fromSeq) yield rec;
    }
  }
}

async function firstSeq(path: string): Promise<number | undefined> {
  for await (const line of committedLines(path)) {
    return lineSeq(new TextEncoder().encode(line));
  }
  return undefined;
}

/** Newline-terminated lines of a file, streamed. */
async function* committedLines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const chunk of Bun.file(path).stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n", start)) {
      yield pending.slice(start, nl);
      start = nl + 1;
    }
    pending = pending.slice(start);
  }
  // Whatever is left has no terminating newline: not committed.
}
