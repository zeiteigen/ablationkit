import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type JournalEvent, validateJournalEvent } from "@ablationkit/protocol";
import {
  diagnoseStorage,
  JsonlCorruptionError,
  JsonlLog,
  listSegments,
  readJsonl,
  segmentFileName,
} from "../src/index.ts";
import { crashChild, tempDir } from "./helpers.ts";

type Rec = { seq: number; i: number; text: string };

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const now = () => new Date("2026-11-02T10:00:00.000Z");

describe("JsonlLog", () => {
  test("assigns strictly increasing seq from 0 and survives reopen", async () => {
    const dir = tempDir();
    const log = JsonlLog.open<Rec>(dir);
    expect(log.recovery).toEqual({ actions: [], lastSeq: undefined });
    expect(log.append({ i: 0, text: "a" }).seq).toBe(0);
    expect(
      log
        .appendBatch([
          { i: 1, text: "b" },
          { i: 2, text: "c" },
        ])
        .map((r) => r.seq),
    ).toEqual([1, 2]);
    log.close();

    const again = JsonlLog.open<Rec>(dir);
    expect(again.recovery.lastSeq).toBe(2);
    expect(again.nextSeq).toBe(3);
    again.append({ i: 3, text: "d" });
    again.close();
    expect((await collect(readJsonl<Rec>(dir))).map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(readFileSync(join(dir, "events-0001.jsonl"), "utf8").split("\n")[0]).toBe(
      '{"seq":0,"i":0,"text":"a"}',
    );
    expect(statSync(join(dir, "events-0001.jsonl")).mode & 0o777).toBe(0o600);
  });

  test("rotates by size; seq continues across segments; fromSeq skips whole segments", async () => {
    const dir = tempDir();
    const log = JsonlLog.open<Rec>(dir, { maxSegmentBytes: 100 });
    for (let i = 0; i < 20; i++) log.append({ i, text: "x".repeat(20) });
    log.close();
    const segments = listSegments(dir);
    expect(segments.length).toBeGreaterThan(5);
    for (const [, p] of segments) expect(statSync(p).size).toBeLessThanOrEqual(100);
    expect(segments.map(([n]) => n)).toEqual(segments.map((_, k) => k + 1));

    const all = await collect(readJsonl<Rec>(dir));
    expect(all.map((r) => r.seq)).toEqual([...Array(20).keys()]);
    expect((await collect(readJsonl<Rec>(dir, { fromSeq: 17 }))).map((r) => r.i)).toEqual([
      17, 18, 19,
    ]);
    expect(JsonlLog.open<Rec>(dir, { maxSegmentBytes: 100 }).nextSeq).toBe(20);
  });

  test("an oversized batch is written whole into its own segment", () => {
    const dir = tempDir();
    const log = JsonlLog.open<Rec>(dir, { maxSegmentBytes: 50 });
    log.append({ i: 0, text: "small" });
    log.appendBatch([{ i: 1, text: "y".repeat(80) }]);
    log.close();
    expect(listSegments(dir).length).toBe(2);
  });

  test("validates every record before writing anything", async () => {
    const dir = tempDir();
    const log = JsonlLog.open<JournalEvent>(dir, { validate: validateJournalEvent });
    const event = {
      schema_version: 1 as const,
      event_id: "e1",
      project_id: "lab",
      producer_id: "p",
      producer_seq: 0,
      ts: "2026-11-02T10:00:00Z",
      type: "run.started",
      payload: {},
    };
    log.append(event);
    expect(() =>
      log.appendBatch([
        { ...event, event_id: "e2" },
        { ...event, type: "BAD" },
      ]),
    ).toThrow();
    expect(() => log.append({ ...event, seq: 9 } as never)).toThrow(TypeError);
    log.close();
    const stored = await collect(readJsonl(dir, { validate: validateJournalEvent }));
    expect(stored.map((e) => e.event_id)).toEqual(["e1"]);
    expect(JsonlLog.open(dir).nextSeq).toBe(1);
  });

  test("custom journal names coexist in one directory", () => {
    const dir = tempDir();
    JsonlLog.open<Rec>(dir, { name: "activity" }).append({ i: 0, text: "a" });
    JsonlLog.open<Rec>(dir).append({ i: 0, text: "e" });
    expect(listSegments(dir, "activity").map(([, p]) => p)).toEqual([
      join(dir, "activity-0001.jsonl"),
    ]);
    expect(listSegments(dir).map(([, p]) => p)).toEqual([join(dir, "events-0001.jsonl")]);
  });
});

describe("partial JSONL tail after a crash (real SIGKILL in a child process)", () => {
  test("torn batch: complete prefix is kept, torn line is quarantined and truncated", async () => {
    const dir = tempDir();
    crashChild("jsonl", dir, "5", String(64 * 1024 * 1024));

    const seg = join(dir, segmentFileName("events", 1));
    expect(readFileSync(seg, "utf8").endsWith("\n")).toBe(false);
    expect(diagnoseStorage(dir)).toEqual([
      expect.objectContaining({ kind: "jsonl_partial_tail", path: seg }) as never,
    ]);
    // Readers never see the torn line, even before recovery.
    expect((await collect(readJsonl<Rec>(dir))).length).toBe(6);

    const log = JsonlLog.open<Rec>(dir, { now });
    // The batch was never acknowledged, but its first line is complete and committed:
    // batches are not atomic, and ingest dedupes by event id (ADR 0007).
    expect(log.recovery.lastSeq).toBe(5);
    expect(log.recovery.actions.map((a) => a.kind)).toEqual(["quarantined", "truncated_tail"]);
    const q = `${seg}.quarantine-20261102T100000.000Z`;
    // The torn line was cut inside the multi-byte "✗": quarantined as raw bytes, exactly.
    const quarantined = readFileSync(q);
    expect(quarantined.toString("latin1")).toBe(
      Buffer.from('{"seq":6,"i":6,"text":"torn ✗"}\n')
        .subarray(0, quarantined.length)
        .toString("latin1"),
    );
    expect(quarantined.length).toBe(Buffer.byteLength('{"seq":6,"i":6,"text":"torn ✗"}\n') - 7);
    expect(readFileSync(seg, "utf8").endsWith("\n")).toBe(true);

    log.append({ i: 99, text: "after recovery" });
    log.close();
    const records = await collect(readJsonl<Rec>(dir));
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(records.at(-1)?.i).toBe(99);
    expect(diagnoseStorage(dir).map((f) => f.kind)).toEqual(["quarantined_file"]);
  });

  test("crash right after rotation: the empty segment's seq comes from the previous one", async () => {
    const dir = tempDir();
    // Each line is ~40 bytes, so the torn batch forces a rotation into segment 2.
    crashChild("jsonl", dir, "3", "130");
    const before = listSegments(dir);
    expect(before.length).toBe(2);

    const log = JsonlLog.open<Rec>(dir, { maxSegmentBytes: 130, now });
    expect(log.recovery.lastSeq).toBe(3);
    expect(log.nextSeq).toBe(4);
    log.append({ i: 4, text: "ok" });
    log.close();
    expect((await collect(readJsonl<Rec>(dir))).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("tail damage without a crash child", () => {
  test("an unparseable newline-terminated last line is quarantined", () => {
    const dir = tempDir();
    const log = JsonlLog.open<Rec>(dir);
    log.appendBatch([
      { i: 0, text: "a" },
      { i: 1, text: "b" },
    ]);
    log.close();
    appendFileSync(join(dir, "events-0001.jsonl"), "\0\0\0\0\n");
    const again = JsonlLog.open<Rec>(dir, { now });
    expect(again.recovery.lastSeq).toBe(1);
    expect(again.recovery.actions[0]?.detail).toContain("unparseable trailing line");
  });

  test("a torn first line leaves an empty journal starting at seq 0", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "events-0001.jsonl"), '{"seq":0,"te');
    const log = JsonlLog.open<Rec>(dir, { now });
    expect(log.recovery.lastSeq).toBeUndefined();
    expect(log.nextSeq).toBe(0);
  });

  test("two damaged tail lines are refused rather than silently eaten", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "events-0001.jsonl"), '{"seq":0}\nnot json\nalso not json\n');
    expect(() => JsonlLog.open<Rec>(dir, { now })).toThrow(JsonlCorruptionError);
  });

  test("damage in the middle is reported by readers, never rewritten", async () => {
    const dir = tempDir();
    const seg = join(dir, "events-0001.jsonl");
    const content = '{"seq":0}\n{"seq":1,broken\n{"seq":2}\n';
    writeFileSync(seg, content);
    const log = JsonlLog.open<Rec>(dir, { now });
    expect(log.recovery.actions).toEqual([]);
    log.close();
    await expect(collect(readJsonl(dir))).rejects.toThrow(JsonlCorruptionError);
    expect(readFileSync(seg, "utf8")).toBe(content);
  });

  test("readers reject a seq that does not increase", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "events-0001.jsonl"), '{"seq":0}\n{"seq":0}\n');
    await expect(collect(readJsonl(dir))).rejects.toThrow("seq 0 after 0");
  });
});

test("diagnoseStorage skips excluded directories", () => {
  const root = tempDir();
  for (const sub of ["state", "mlflow"]) {
    mkdirSync(join(root, sub));
    writeFileSync(join(root, sub, "x.json.quarantine-20261102T100000Z"), "bad");
  }
  expect(diagnoseStorage(root).map((f) => f.path)).toHaveLength(2);
  expect(diagnoseStorage(root, { exclude: [join(root, "mlflow")] }).map((f) => f.path)).toEqual([
    join(root, "state", "x.json.quarantine-20261102T100000Z"),
  ]);
});
