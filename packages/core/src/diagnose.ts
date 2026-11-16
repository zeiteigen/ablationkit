/**
 * Read-only startup diagnosis of a storage tree (spec §13): interrupted JSON replacements,
 * partial JSONL tails and quarantined files. It changes nothing; callers decide whether to run
 * `recoverJsonFile` / `JsonlLog.open`, which do the repairs.
 */
import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { interruptedWriteTarget } from "./atomic-json.ts";

export type StorageFinding =
  | { readonly kind: "interrupted_json_write"; readonly path: string; readonly target: string }
  | { readonly kind: "jsonl_partial_tail"; readonly path: string; readonly bytes: number }
  | { readonly kind: "quarantined_file"; readonly path: string };

const SEGMENT_RE = /-[0-9]{4,}\.jsonl$/;
const QUARANTINE_RE = /\.quarantine-[0-9]{8}T[0-9]{6}(\.[0-9]+)?Z(-[0-9]+)?$/;

function unterminatedTailBytes(path: string): number {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    const buf = Buffer.allocUnsafe(64 * 1024);
    let pos = size;
    while (pos > 0) {
      const start = Math.max(0, pos - buf.length);
      const n = readSync(fd, buf, 0, pos - start, start);
      const i = buf.subarray(0, n).lastIndexOf(0x0a);
      if (i >= 0) return size - (start + i + 1);
      pos = start;
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

/** Walk `root` and report storage that needs recovery. Findings are sorted by path. */
export function diagnoseStorage(
  root: string,
  options: { readonly exclude?: readonly string[] } = {},
): StorageFinding[] {
  const findings: StorageFinding[] = [];
  const excluded = new Set(options.exclude ?? []);
  const walk = (dir: string) => {
    if (excluded.has(dir)) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const target = interruptedWriteTarget(path);
      if (target) findings.push({ kind: "interrupted_json_write", path, target });
      else if (QUARANTINE_RE.test(entry.name)) findings.push({ kind: "quarantined_file", path });
      else if (SEGMENT_RE.test(entry.name)) {
        const bytes = unterminatedTailBytes(path);
        if (bytes > 0) findings.push({ kind: "jsonl_partial_tail", path, bytes });
      }
    }
  };
  walk(root);
  return findings.sort((a, b) => a.path.localeCompare(b.path));
}
