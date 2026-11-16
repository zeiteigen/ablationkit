import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SCHEMAS, type SchemaEntry } from "../src/index.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

export interface Fixtures {
  readonly entry: SchemaEntry;
  readonly valid: readonly unknown[];
  readonly invalid: readonly { readonly reason: string; readonly value: unknown }[];
}

/** Shared fixtures; the Python tests read the same files. */
export function loadFixtures(): Fixtures[] {
  return SCHEMAS.map((entry) => {
    const path = join(REPO_ROOT, "packages/protocol/fixtures", `${entry.file}.json`);
    const data = JSON.parse(readFileSync(path, "utf8")) as Omit<Fixtures, "entry">;
    return { entry, valid: data.valid, invalid: data.invalid };
  });
}
