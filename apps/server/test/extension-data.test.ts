import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtensionDataError,
  type ExtensionDataErrorCode,
  ExtensionDataStore,
} from "../src/extensions/data.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(maxBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), "ak-extension-data-"));
  roots.push(root);
  return {
    root,
    store: new ExtensionDataStore({ stateDir: root, ...(maxBytes ? { maxBytes } : {}) }),
  };
}
function code(fn: () => unknown, expected: ExtensionDataErrorCode) {
  try {
    fn();
    throw new Error("Expected store error");
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionDataError);
    expect((error as ExtensionDataError).code).toBe(expected);
  }
}
const create = (value: unknown = { name: "first" }) => ({
  schema_version: 1,
  value,
  expected_revision: null,
});

describe("managed extension data", () => {
  test("requires exact revisions, including create, delete and recreation", () => {
    const { root, store } = setup();
    const first = store.put("project", "extension", "records", "one", create());
    expect(first.revision).toBe(1);
    code(() => store.put("project", "extension", "records", "one", create()), "revision_conflict");
    const second = store.put("project", "extension", "records", "one", {
      ...create("second"),
      expected_revision: first.revision,
    });
    expect(second.revision).toBe(2);
    code(
      () => store.delete("project", "extension", "records", "one", first.revision),
      "revision_conflict",
    );
    store.delete("project", "extension", "records", "one", second.revision);
    expect(store.get("project", "extension", "records", "one")).toBeUndefined();
    const third = store.put("project", "extension", "records", "one", create("third"));
    expect(third.revision).toBe(3);
    expect(
      new ExtensionDataStore({ stateDir: root }).get("project", "extension", "records", "one"),
    ).toEqual(third);
    code(
      () =>
        store.put("project", "extension", "records", "two", {
          ...create(),
          expected_revision: undefined as unknown as number,
        }),
      "revision_conflict",
    );
  });

  test("stable pagination by key and isolation across project, extension and collection", () => {
    const { store } = setup();
    for (const key of ["c", "a", "b"])
      store.put("project", "extension", "records", key, create(key));
    const page = store.list("project", "extension", "records", { limit: 2 });
    expect(page.records.map((r) => r.key)).toEqual(["a", "b"]);
    expect(page.next_cursor).toBe("b");
    store.delete("project", "extension", "records", "b", page.records[1]?.revision as number);
    expect(store.list("project", "extension", "records", { cursor: "b", limit: 2 })).toMatchObject({
      records: [{ key: "c" }],
    });
    for (const [project, ext, collection] of [
      ["other", "extension", "records"],
      ["project", "other", "records"],
      ["project", "extension", "other"],
    ] as const) {
      expect(store.get(project, ext, collection, "a")).toBeUndefined();
      store.put(project, ext, collection, "a", create("isolated"));
      expect(store.get(project, ext, collection, "a")?.value).toBe("isolated");
    }
    expect(store.get("project", "extension", "records", "a")?.value).toBe("a");
    code(() => store.list("project", "extension", "records", { limit: 1001 }), "invalid_data");
  });

  test("rejects traversal and symlinks in ancestors, collection files and blob files", () => {
    const { root, store } = setup();
    for (const args of [
      ["../escape", "ext", "col", "key"],
      ["project", "../escape", "col", "key"],
      ["project", "ext", "../escape", "key"],
      ["project", "ext", "col", "../escape"],
    ] as const) {
      code(() => store.put(args[0], args[1], args[2], args[3], create()), "invalid_data");
    }
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "linked"));
    code(() => store.put("linked", "ext", "col", "key", create()), "unsafe_path");
    store.put("project", "ext", "col", "key", create());
    const base = join(root, "project/extensions/data/ext");
    const collection = join(base, "collections/col.json");
    const snapshot = readFileSync(collection);
    rmSync(collection);
    writeFileSync(join(outside, "col.json"), snapshot);
    symlinkSync(join(outside, "col.json"), collection);
    code(() => store.get("project", "ext", "col", "key"), "unsafe_path");
    const blob = store.putBlob("project", "different", new Uint8Array([1, 2, 3]));
    const blobPath = join(root, "project/extensions/data/different/blobs", blob.sha256);
    rmSync(blobPath);
    symlinkSync(join(outside, "col.json"), blobPath);
    code(() => store.getBlob("project", "different", blob.sha256), "unsafe_path");
  });

  test("sequential registered migrations update schema and revisions atomically", () => {
    const { root, store } = setup();
    store.put("project", "ext", "col", "a", create(1));
    store.put("project", "ext", "col", "b", create(2));
    const path = join(root, "project/extensions/data/ext/collections/col.json");
    const before = readFileSync(path, "utf8");
    store.registerMigration("ext", "col", 1, (value) => Number(value) + 10);
    code(() => store.migrate("project", "ext", "col", 3), "migration_missing");
    expect(readFileSync(path, "utf8")).toBe(before);
    store.registerMigration("ext", "col", 2, (value) => ({ result: value }));
    store.migrate("project", "ext", "col", 3);
    expect(store.get("project", "ext", "col", "a")).toMatchObject({
      value: { result: 11 },
      schema_version: 3,
      revision: 5,
    });
    expect(store.get("project", "ext", "col", "b")).toMatchObject({
      value: { result: 12 },
      schema_version: 3,
      revision: 6,
    });
    code(() => store.put("project", "ext", "col", "c", create()), "schema_conflict");
    code(() => store.migrate("project", "ext", "col", 2), "schema_conflict");
    const upgraded = readFileSync(path, "utf8");
    store.registerMigration("ext", "col", 3, () => {
      throw new Error("migration failed");
    });
    expect(() => store.migrate("project", "ext", "col", 4)).toThrow("migration failed");
    expect(readFileSync(path, "utf8")).toBe(upgraded);
  });

  test("snapshot migration atomically advances all records and requires exactly the next version", () => {
    const { store } = setup();
    const a = store.put("project", "ext", "col", "a", create(1));
    const b = store.put("project", "ext", "col", "b", create(2));
    const records = [
      { key: "a", expected_revision: a.revision, value: { migrated: 1 } },
      { key: "b", expected_revision: b.revision, value: { migrated: 2 } },
    ];
    code(
      () =>
        store.migrateRecords("project", "ext", "col", { from_version: 1, to_version: 3, records }),
      "schema_conflict",
    );
    store.migrateRecords("project", "ext", "col", { from_version: 1, to_version: 2, records });
    expect(store.list("project", "ext", "col").records).toEqual([
      { key: "a", schema_version: 2, revision: 3, value: { migrated: 1 } },
      { key: "b", schema_version: 2, revision: 4, value: { migrated: 2 } },
    ]);
    code(
      () =>
        store.migrateRecords("project", "ext", "col", { from_version: 1, to_version: 2, records }),
      "schema_conflict",
    );
    expect(
      store.put("project", "ext", "col", "a", {
        schema_version: 2,
        expected_revision: 3,
        value: "updated",
      }).revision,
    ).toBe(5);
  });

  test("snapshot migration rejects concurrent updates, deletes and new keys without changing data", () => {
    for (const change of ["update", "delete", "create"] as const) {
      const { root, store } = setup();
      const a = store.put("project", "ext", "col", "a", create(1));
      const b = store.put("project", "ext", "col", "b", create(2));
      const records = [
        { key: "a", expected_revision: a.revision, value: 10 },
        { key: "b", expected_revision: b.revision, value: 20 },
      ];
      if (change === "update")
        store.put("project", "ext", "col", "b", { ...create(3), expected_revision: b.revision });
      if (change === "delete") store.delete("project", "ext", "col", "b", b.revision);
      if (change === "create") store.put("project", "ext", "col", "c", create(3));
      const path = join(root, "project/extensions/data/ext/collections/col.json");
      const before = readFileSync(path, "utf8");
      code(
        () =>
          store.migrateRecords("project", "ext", "col", {
            from_version: 1,
            to_version: 2,
            records,
          }),
        "revision_conflict",
      );
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });

  test("snapshot migration requires a full unique key set and valid JSON before committing", () => {
    const { root, store } = setup();
    const a = store.put("project", "ext", "col", "a", create(1));
    const b = store.put("project", "ext", "col", "b", create(2));
    const first = { key: "a", expected_revision: a.revision, value: 10 };
    const second = { key: "b", expected_revision: b.revision, value: 20 };
    const path = join(root, "project/extensions/data/ext/collections/col.json");
    const before = readFileSync(path, "utf8");
    for (const records of [[first], [first, first]]) {
      code(
        () =>
          store.migrateRecords("project", "ext", "col", {
            from_version: 1,
            to_version: 2,
            records,
          }),
        "revision_conflict",
      );
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    code(
      () =>
        store.migrateRecords("project", "ext", "col", {
          from_version: 1,
          to_version: 2,
          records: [first, { ...second, value: { invalid: undefined } }],
        }),
      "invalid_data",
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    store.migrateRecords("project", "ext", "col", {
      from_version: 1,
      to_version: 2,
      records: [first, second],
    });
    expect(store.get("project", "ext", "col", "a")?.revision).toBe(3);
  });

  test("snapshot migration retains quota protection and can upgrade an empty collection", () => {
    const { root, store } = setup(400);
    const a = store.put("project", "ext", "col", "a", create(1));
    const path = join(root, "project/extensions/data/ext/collections/col.json");
    const before = readFileSync(path, "utf8");
    code(
      () =>
        store.migrateRecords("project", "ext", "col", {
          from_version: 1,
          to_version: 2,
          records: [{ key: "a", expected_revision: a.revision, value: "x".repeat(400) }],
        }),
      "quota_exceeded",
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    store.delete("project", "ext", "col", "a", a.revision);
    store.migrateRecords("project", "ext", "col", { from_version: 1, to_version: 2, records: [] });
    expect(
      store.put("project", "ext", "col", "b", {
        schema_version: 2,
        expected_revision: null,
        value: 2,
      }).schema_version,
    ).toBe(2);
  });

  test("immutable blobs deduplicate and verify their hash on both reads and repeated puts", () => {
    const { root, store } = setup();
    const bytes = new TextEncoder().encode("hello");
    const blob = store.putBlob("project", "ext", bytes);
    expect(blob).toEqual({
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      bytes: 5,
    });
    expect(store.putBlob("project", "ext", bytes)).toEqual(blob);
    expect(store.getBlob("project", "ext", blob.sha256)).toEqual(Buffer.from(bytes));
    code(() => store.getBlob("other", "ext", blob.sha256), "not_found");
    code(() => store.getBlob("project", "ext", "../escape"), "invalid_data");
    writeFileSync(join(root, "project/extensions/data/ext/blobs", blob.sha256), "broken");
    code(() => store.getBlob("project", "ext", blob.sha256), "blob_corrupt");
    code(() => store.putBlob("project", "ext", bytes), "blob_corrupt");
  });

  test("quotas cover combined collection and blob bytes per namespace and preserve failed writes", () => {
    const { store } = setup(400);
    const record = store.put("project", "ext", "col", "a", create("small"));
    code(
      () =>
        store.put("project", "ext", "col", "a", {
          ...create("x".repeat(400)),
          expected_revision: record.revision,
        }),
      "quota_exceeded",
    );
    expect(store.get("project", "ext", "col", "a")).toEqual(record);
    store.putBlob("project", "ext", new Uint8Array(100));
    code(() => store.putBlob("project", "ext", new Uint8Array(300)), "quota_exceeded");
    expect(store.putBlob("project", "other", new Uint8Array(300)).bytes).toBe(300);
    expect(store.putBlob("project", "ext", new Uint8Array(100)).bytes).toBe(100);
    store.registerMigration("ext", "col", 1, () => "x".repeat(400));
    code(() => store.migrate("project", "ext", "col", 2), "quota_exceeded");
    expect(store.get("project", "ext", "col", "a")).toEqual(record);
    store.delete("project", "ext", "col", "a", record.revision);
    expect(store.putBlob("project", "ext", new Uint8Array(150)).bytes).toBe(150);
  });

  test("rejects values that cannot round trip through JSON", () => {
    const { store } = setup();
    for (const value of [undefined, NaN, Infinity, 1n, { x: undefined }, new Date()]) {
      code(() => store.put("project", "ext", "col", "a", { ...create(), value }), "invalid_data");
    }
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    code(() => store.put("project", "ext", "col", "a", create(circular)), "invalid_data");
  });
});
