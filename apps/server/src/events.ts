/**
 * Coordinator event journal and SSE fan-out (spec §3.3, ADR 0009).
 *
 * Every published event is appended to `<home>/events/events-NNNN.jsonl` first, then pushed to
 * live subscribers. SSE `id` is the journal seq, so a client reconnects with `Last-Event-ID` (or
 * `?after=`) and gets everything it missed from the journal before live events resume. A
 * subscriber that falls too far behind is disconnected rather than buffered without bound; it
 * reconnects and replays.
 */
import { randomUUID } from "node:crypto";
import { JsonlLog, readJsonl } from "@ablationkit/core";
import { type JournalEvent, validateJournalEvent } from "@ablationkit/protocol";

export const PRODUCER_ID = "coordinator";
export const HEARTBEAT_MS = 15_000;
const MAX_QUEUED = 1000;

export interface EventFilter {
  readonly projectId?: string;
}

type Subscriber = (e: JournalEvent) => void;

function matches(e: JournalEvent, f: EventFilter): boolean {
  return f.projectId === undefined || e.project_id === f.projectId;
}

export function sseFrame(e: JournalEvent, format: "named" | "message" = "named"): string {
  return `id: ${e.seq}\n${format === "named" ? `event: ${e.type}\n` : ""}data: ${JSON.stringify(e)}\n\n`;
}

export class EventHub {
  private readonly log: JsonlLog<JournalEvent>;
  private readonly subscribers = new Set<Subscriber>();
  private readonly streams = new Set<() => void>();

  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly heartbeatMs = HEARTBEAT_MS,
  ) {
    this.log = JsonlLog.open<JournalEvent>(dir, { name: "events", validate: validateJournalEvent });
  }

  get recovery(): JsonlLog<JournalEvent>["recovery"] {
    return this.log.recovery;
  }

  get lastSeq(): number {
    return this.log.nextSeq - 1;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  publish(projectId: string, type: string, payload: Record<string, unknown>): JournalEvent {
    const e = this.log.append({
      schema_version: 1,
      event_id: randomUUID(),
      project_id: projectId,
      producer_id: PRODUCER_ID,
      producer_seq: this.log.nextSeq,
      ts: this.now().toISOString(),
      type,
      payload,
    });
    for (const s of this.subscribers) s(e);
    return e;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Journal events with seq > after. */
  async *replay(after: number, filter: EventFilter = {}): AsyncGenerator<JournalEvent> {
    for await (const e of readJsonl<JournalEvent>(this.dir, {
      name: "events",
      fromSeq: after + 1,
    })) {
      if (e.seq > after && matches(e, filter)) yield e;
    }
  }

  /** An SSE response: replay from `after`, then live events, with heartbeats. */
  stream(
    after: number,
    filter: EventFilter = {},
    signal?: AbortSignal,
    format: "named" | "message" = "named",
  ): Response {
    const encoder = new TextEncoder();
    let cleanup = (): void => {};
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        let replaying = true;
        let lastSent = after;
        const pending: JournalEvent[] = [];
        const send = (chunk: string): void => {
          if (closed) return;
          // desiredSize counts queued chunks (default strategy): far behind means disconnect and replay.
          if ((controller.desiredSize ?? 0) < -MAX_QUEUED) {
            close();
            return;
          }
          controller.enqueue(encoder.encode(chunk));
        };
        const deliver = (e: JournalEvent): void => {
          if (e.seq <= lastSent || !matches(e, filter)) return;
          lastSent = e.seq;
          send(sseFrame(e, format));
        };
        const unsubscribe = this.subscribe((e) => {
          if (replaying) {
            if (pending.length >= MAX_QUEUED) close();
            else pending.push(e);
          } else deliver(e);
        });
        const heartbeat = setInterval(() => send(": heartbeat\n\n"), this.heartbeatMs);
        const close = (): void => {
          if (closed) return;
          closed = true;
          unsubscribe();
          clearInterval(heartbeat);
          this.streams.delete(close);
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        };
        cleanup = close;
        this.streams.add(close);
        signal?.addEventListener("abort", close);
        send(`retry: 2000\n: connected after=${after}\n\n`);
        void (async () => {
          try {
            for await (const e of this.replay(after, filter)) deliver(e);
            replaying = false;
            for (const e of pending.splice(0)) deliver(e);
          } catch (e) {
            console.error("coordinator: SSE replay failed", e);
            close();
          }
        })();
      },
      cancel: () => cleanup(),
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  close(): void {
    for (const c of [...this.streams]) c();
    this.subscribers.clear();
    this.log.close();
  }
}

/** Parse `Last-Event-ID` / `?after=` into the last seq the client has; -1 means from the start. */
export function parseAfter(req: Request, url: URL): number {
  const raw = req.headers.get("last-event-id") ?? url.searchParams.get("after");
  if (raw === null || raw === "") return -1;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= -1 ? n : -1;
}
