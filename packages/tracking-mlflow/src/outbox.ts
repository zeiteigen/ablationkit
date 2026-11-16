/**
 * Temporary durable outbox for MLflow writes (spec §4.2, §5.5, §5.8; ADR 0010).
 *
 * Writes are journaled to `outbox-NNNN.jsonl` before anything is sent, so a coordinator crash or
 * an MLflow outage never loses them. Replaying the journal (enqueue / ack / fail / requeue) gives
 * the live set. The outbox is bounded: past its limits `enqueue` throws `OutboxFullError`, and the
 * caller must push back (workers keep spooling). A segment is deleted once every op enqueued in it
 * or before it is resolved, so the outbox holds data only until MLflow acknowledges it.
 *
 * Single writer: only the coordinator opens this directory.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { JsonlLog, listSegments, readJsonl } from "@ablationkit/core";
import {
  type TrackingError,
  type TrackingOp,
  type TrackingOutboxRecord,
  validateTrackingOutboxRecord,
} from "@ablationkit/protocol";

export const OUTBOX_JOURNAL = "outbox";
export const DEFAULT_OUTBOX_LIMITS = { maxOps: 100_000, maxBytes: 256 * 1024 * 1024 } as const;

export interface OutboxLimits {
  readonly maxOps: number;
  readonly maxBytes: number;
}

export type OutboxOpState = "pending" | "failed";

export interface OutboxEntry {
  readonly op_id: string;
  readonly op: TrackingOp;
  state: OutboxOpState;
  /** Delivery attempts since the op was (re)queued. In memory only. */
  attempts: number;
  last_error?: TrackingError;
  /** Epoch ms before which the flusher will not retry it. */
  next_attempt_at: number;
  /** Segment the enqueue record lives in (for garbage collection). */
  readonly segment: number;
  /** Enqueue order. */
  readonly order: number;
}

export interface OutboxStats {
  readonly pending: number;
  readonly failed: number;
  readonly bytes: number;
  readonly oldest_enqueued_at?: string;
  readonly limits: OutboxLimits;
  readonly segments: number;
}

export class OutboxFullError extends Error {
  constructor(
    readonly limits: OutboxLimits,
    readonly stats: { ops: number; bytes: number },
  ) {
    super(
      `tracking outbox is full (${stats.ops} ops, ${stats.bytes} bytes; limits ${limits.maxOps} ops, ${limits.maxBytes} bytes)`,
    );
    this.name = "OutboxFullError";
  }
}

export type NewOp = Omit<TrackingOp, "enqueued_at" | "bytes">;

function segmentIndexOf(path: string): number {
  const m = /-([0-9]+)\.jsonl$/.exec(basename(path));
  return m ? Number(m[1]) : 0;
}

export class Outbox {
  private readonly live = new Map<string, OutboxEntry>();
  private order = 0;
  private bytes = 0;

  private constructor(
    private readonly log: JsonlLog<TrackingOutboxRecord>,
    readonly limits: OutboxLimits,
    private readonly now: () => Date,
  ) {}

  static async open(
    dir: string,
    options: { limits?: Partial<OutboxLimits>; now?: () => Date; maxSegmentBytes?: number } = {},
  ): Promise<Outbox> {
    const now = options.now ?? (() => new Date());
    const limits = { ...DEFAULT_OUTBOX_LIMITS, ...options.limits };
    const log = JsonlLog.open<TrackingOutboxRecord>(dir, {
      name: OUTBOX_JOURNAL,
      maxSegmentBytes: options.maxSegmentBytes ?? 8 * 1024 * 1024,
      validate: validateTrackingOutboxRecord,
      now,
    });
    const box = new Outbox(log, limits, now);
    // Replay. Each record is attributed to its segment so GC knows where every live op lives.
    const segIdx = Outbox.segmentStarts(dir);
    for await (const rec of readJsonl<TrackingOutboxRecord>(dir, {
      name: OUTBOX_JOURNAL,
      validate: validateTrackingOutboxRecord,
    })) {
      box.apply(rec, Outbox.segmentFor(segIdx, rec.seq));
    }
    return box;
  }

  /** First seq of each segment, so replayed records can be attributed to their segment. */
  private static segmentStarts(dir: string): Map<number, number> {
    const starts = new Map<number, number>();
    for (const [index, path] of listSegments(dir, OUTBOX_JOURNAL)) {
      const text = readFileSync(path, "utf8");
      const nl = text.indexOf("\n");
      if (nl > 0) {
        try {
          starts.set(index, (JSON.parse(text.slice(0, nl)) as { seq: number }).seq);
        } catch {
          // a torn first line was already handled by recovery
        }
      }
    }
    return starts;
  }

  private static segmentFor(starts: Map<number, number>, seq: number): number {
    let best = 0;
    for (const [index, first] of starts) if (first <= seq && index > best) best = index;
    return best;
  }

  private apply(rec: TrackingOutboxRecord, segment: number): void {
    switch (rec.type) {
      case "enqueue": {
        if (!rec.op) return;
        this.live.set(rec.op_id, {
          op_id: rec.op_id,
          op: rec.op,
          state: "pending",
          attempts: 0,
          next_attempt_at: 0,
          segment,
          order: this.order++,
        });
        this.bytes += rec.op.bytes;
        return;
      }
      case "ack": {
        const e = this.live.get(rec.op_id);
        if (e) {
          this.live.delete(rec.op_id);
          this.bytes -= e.op.bytes;
        }
        return;
      }
      case "fail": {
        const e = this.live.get(rec.op_id);
        if (e) {
          e.state = "failed";
          if (rec.error) e.last_error = rec.error;
        }
        return;
      }
      case "requeue": {
        const e = this.live.get(rec.op_id);
        if (e) {
          e.state = "pending";
          e.attempts = 0;
          e.next_attempt_at = 0;
        }
        return;
      }
    }
  }

  private append(rec: Omit<TrackingOutboxRecord, "seq" | "schema_version" | "ts">): number {
    this.log.append({ schema_version: 1, ts: this.now().toISOString(), ...rec });
    return segmentIndexOf(this.log.currentSegment);
  }

  /** Journal a write, then return it. Throws OutboxFullError past the configured bounds. */
  enqueue(input: NewOp): OutboxEntry {
    const bytes = Buffer.byteLength(JSON.stringify(input.payload));
    if (this.live.size + 1 > this.limits.maxOps || this.bytes + bytes > this.limits.maxBytes) {
      throw new OutboxFullError(this.limits, { ops: this.live.size, bytes: this.bytes });
    }
    const op: TrackingOp = { ...input, enqueued_at: this.now().toISOString(), bytes };
    const op_id = `op-${randomUUID().replaceAll("-", "")}`;
    const segment = this.append({ type: "enqueue", op_id, op });
    const entry: OutboxEntry = {
      op_id,
      op,
      state: "pending",
      attempts: 0,
      next_attempt_at: 0,
      segment,
      order: this.order++,
    };
    this.live.set(op_id, entry);
    this.bytes += bytes;
    return entry;
  }

  ack(opId: string, result: Record<string, unknown> = {}): void {
    const e = this.live.get(opId);
    if (!e) return;
    this.append({ type: "ack", op_id: opId, result });
    this.live.delete(opId);
    this.bytes -= e.op.bytes;
  }

  /** Park an op after MLflow rejected it. It stays visible (and counted) until requeued or dropped. */
  fail(opId: string, error: TrackingError): void {
    const e = this.live.get(opId);
    if (!e) return;
    this.append({ type: "fail", op_id: opId, error });
    e.state = "failed";
    e.last_error = error;
  }

  /** A transient failure: keep it pending and back off. Not journaled. */
  deferred(opId: string, error: TrackingError, retryAt: number): void {
    const e = this.live.get(opId);
    if (!e) return;
    e.attempts += 1;
    e.last_error = error;
    e.next_attempt_at = retryAt;
  }

  requeue(opId: string): OutboxEntry | undefined {
    const e = this.live.get(opId);
    if (e?.state !== "failed") return undefined;
    this.append({ type: "requeue", op_id: opId });
    e.state = "pending";
    e.attempts = 0;
    e.next_attempt_at = 0;
    return e;
  }

  get(opId: string): OutboxEntry | undefined {
    return this.live.get(opId);
  }

  /** Live entries in enqueue order. */
  entries(filter: { state?: OutboxOpState; projectId?: string; ref?: string } = {}): OutboxEntry[] {
    return [...this.live.values()]
      .filter(
        (e) =>
          (filter.state === undefined || e.state === filter.state) &&
          (filter.projectId === undefined || e.op.project_id === filter.projectId) &&
          (filter.ref === undefined || e.op.ref === filter.ref),
      )
      .sort((a, b) => a.order - b.order);
  }

  stats(): OutboxStats {
    let pending = 0;
    let failed = 0;
    let oldest: string | undefined;
    for (const e of this.live.values()) {
      if (e.state === "pending") pending++;
      else failed++;
      if (oldest === undefined || e.op.enqueued_at < oldest) oldest = e.op.enqueued_at;
    }
    return {
      pending,
      failed,
      bytes: this.bytes,
      ...(oldest ? { oldest_enqueued_at: oldest } : {}),
      limits: this.limits,
      segments: listSegments(this.log.dir, OUTBOX_JOURNAL).length,
    };
  }

  /** Delete segments that hold only resolved ops. Returns how many were removed. */
  gc(): number {
    const current = segmentIndexOf(this.log.currentSegment);
    let keepFrom = current;
    for (const e of this.live.values()) keepFrom = Math.min(keepFrom, e.segment);
    let removed = 0;
    for (const [index, path] of listSegments(this.log.dir, OUTBOX_JOURNAL)) {
      if (index >= keepFrom) break;
      rmSync(path, { force: true });
      removed++;
    }
    return removed;
  }

  close(): void {
    this.log.close();
  }
}
