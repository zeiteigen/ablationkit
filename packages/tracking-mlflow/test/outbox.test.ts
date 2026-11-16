import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Outbox, OutboxFullError } from "../src/outbox.ts";
import { Env } from "./helpers.ts";

const env = new Env();
afterEach(() => env.cleanup());

const op = (ref: string, n = 1) => ({
  kind: "log_batch" as const,
  project_id: "demo",
  ref,
  payload: {
    metrics: Array.from({ length: n }, (_, i) => ({
      key: "loss",
      value: i,
      timestamp: 1,
      step: i,
    })),
  },
});

describe("Outbox", () => {
  test("journals before delivery and replays pending and failed ops after a restart", async () => {
    const dir = join(env.tmp(), "outbox");
    const a = await Outbox.open(dir);
    const e1 = a.enqueue(op("att-1"));
    const e2 = a.enqueue(op("att-1"));
    const e3 = a.enqueue(op("att-2"));
    a.ack(e1.op_id, { run_id: "r1" });
    a.fail(e2.op_id, { kind: "rejected", message: "bad param", status: 400 });
    a.close();

    const b = await Outbox.open(dir);
    expect(b.entries().map((e) => e.op_id)).toEqual([e2.op_id, e3.op_id]);
    expect(b.get(e2.op_id)?.state).toBe("failed");
    expect(b.get(e2.op_id)?.last_error?.message).toBe("bad param");
    expect(b.stats()).toMatchObject({ pending: 1, failed: 1 });
    expect(b.requeue(e2.op_id)?.state).toBe("pending");
    b.close();
    const c = await Outbox.open(dir);
    expect(c.get(e2.op_id)?.state).toBe("pending");
    c.close();
  });

  test("is bounded by op count and bytes", async () => {
    const box = await Outbox.open(join(env.tmp(), "o"), {
      limits: { maxOps: 2, maxBytes: 10_000 },
    });
    box.enqueue(op("a"));
    const second = box.enqueue(op("a"));
    expect(() => box.enqueue(op("a"))).toThrow(OutboxFullError);
    box.ack(second.op_id);
    box.enqueue(op("a"));
    const small = await Outbox.open(join(env.tmp(), "o2"), {
      limits: { maxOps: 100, maxBytes: 200 },
    });
    expect(() => small.enqueue(op("a", 50))).toThrow(OutboxFullError);
    box.close();
    small.close();
  });

  test("deletes segments once every op in them is resolved", async () => {
    const dir = join(env.tmp(), "o");
    const box = await Outbox.open(dir, { maxSegmentBytes: 600 });
    const ids = Array.from({ length: 12 }, () => box.enqueue(op("a", 2)).op_id);
    const before = readdirSync(dir).length;
    expect(before).toBeGreaterThan(3);
    for (const id of ids.slice(0, 11)) box.ack(id);
    box.gc();
    const after = readdirSync(dir).length;
    expect(after).toBeLessThan(before);
    box.close();
    const again = await Outbox.open(dir);
    expect(again.entries().map((e) => e.op_id)).toEqual([ids[11] as string]);
    again.close();
  });
});
