/**
 * A contained job's read-only mounts of the checkout's ignored entries (ADR 0068): earlier data
 * and outputs are read-only, and where the job writes stays its copy's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ignoredMounts } from "../src/agents/containers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function checkout(): string {
  const d = mkdtempSync(join(tmpdir(), "ak-job-mounts-"));
  dirs.push(d);
  for (const p of ["data/train", "outputs/run-1", "outputs/run-2"])
    mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, "outputs/run-1/ckpt.pt"), "w");
  writeFileSync(join(d, "outputs/run-1/log.txt"), "l");
  writeFileSync(join(d, "metrics.jsonl"), "{}");
  return d;
}

describe("ignoredMounts", () => {
  test("an entry nothing is written in is mounted whole", () => {
    const d = checkout();
    expect(ignoredMounts(d, ["data", "outputs"], [])).toEqual(["data", "outputs"]);
  });

  test("a directory the job writes in is opened along the path, the rest read-only", () => {
    const d = checkout();
    expect(ignoredMounts(d, ["data", "outputs"], ["outputs/run-3"])).toEqual([
      "data",
      "outputs/run-1",
      "outputs/run-2",
    ]);
  });

  test("an input's place inside an earlier output leaves its siblings read-only", () => {
    const d = checkout();
    expect(ignoredMounts(d, ["outputs"], ["outputs/run-1/ckpt.pt"])).toEqual([
      "outputs/run-1/log.txt",
      "outputs/run-2",
    ]);
  });

  test("an ignored file the job writes is not mounted at all", () => {
    const d = checkout();
    expect(ignoredMounts(d, ["data", "metrics.jsonl"], ["metrics.jsonl"])).toEqual(["data"]);
  });
});
