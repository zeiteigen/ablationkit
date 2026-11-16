import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a subscriber that stops reading is disconnected instead of buffered without bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ak-events-"));
  dirs.push(dir);
  const hub = new EventHub(dir, () => new Date(), 60_000);
  const res = hub.stream(-1);
  // Let the (empty) replay finish so the stream is live.
  await Bun.sleep(20);
  expect(hub.subscriberCount).toBe(1);
  for (let i = 0; i < 1100; i++) hub.publish("p1", "test.tick", { i });
  expect(hub.subscriberCount).toBe(0);
  // What was queued is still readable, and the stream ends; the client then reconnects and replays.
  const text = await res.text();
  expect(text).toContain("event: test.tick");
  expect(hub.lastSeq).toBe(1099);
  hub.close();
});

test("message-format SSE delivers arbitrary extension event types during replay and live delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ak-extension-events-"));
  dirs.push(dir);
  const hub = new EventHub(dir, () => new Date(), 60_000);
  hub.publish("project", "custom_extension.first", { value: 1 });
  const response = hub.stream(-1, { projectId: "project" }, undefined, "message");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing event stream");
  let text = "";
  while (!text.includes("custom_extension.first")) {
    const chunk = await reader.read();
    text += new TextDecoder().decode(chunk.value);
  }
  hub.publish("foreign", "custom_extension.hidden", {});
  hub.publish("project", "custom_extension.second", { value: 2 });
  while (!text.includes("custom_extension.second")) {
    const chunk = await reader.read();
    text += new TextDecoder().decode(chunk.value);
  }
  expect(text).not.toContain("event:");
  expect(text).not.toContain("custom_extension.hidden");
  expect(text).toContain('"value":1');
  expect(text).toContain('"value":2');
  await reader.cancel();
  hub.close();
});
