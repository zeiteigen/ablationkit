import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileValidator } from "@ablationkit/protocol";
import { Type } from "@sinclair/typebox";
import {
  type Migration,
  MigrationError,
  preMigrationBackupPath,
  readJson,
  readJsonMigrated,
  SchemaMigrator,
} from "../src/index.ts";
import { tempDir } from "./helpers.ts";

// A test-only record kind with three versions:
// v1 {name}  →  v2 {display_name}  →  v3 {display_name, tags}
const V3 = Type.Object(
  {
    schema_version: Type.Literal(3),
    display_name: Type.String(),
    tags: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
const migrations: Migration[] = [
  {
    from: 2,
    description: "add tags",
    up: (d) => ({ ...d, schema_version: 3, tags: [] }),
  },
  {
    from: 1,
    description: "rename name → display_name",
    up: ({ name, ...rest }) => ({ ...rest, schema_version: 2, display_name: name }),
  },
];
const migrator = new SchemaMigrator({
  kind: "test-record",
  currentVersion: 3,
  validate: compileValidator(V3),
  migrations,
});

const kindOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof MigrationError ? e.kind : `other: ${(e as Error).message}`;
  }
  return "none";
};

describe("SchemaMigrator", () => {
  test("runs the chain in order and validates the result", () => {
    const r = migrator.migrate({ schema_version: 1, name: "Lab" });
    expect(r).toEqual({
      value: { schema_version: 3, display_name: "Lab", tags: [] },
      fromVersion: 1,
      migrated: true,
    });
    expect(migrator.migrate({ schema_version: 3, display_name: "x", tags: ["a"] }).migrated).toBe(
      false,
    );
    expect(migrator.minVersion).toBe(1);
  });

  test("does not mutate its input", () => {
    const input = { schema_version: 1, name: "Lab" };
    migrator.migrate(input);
    expect(input).toEqual({ schema_version: 1, name: "Lab" });
  });

  test("refuses future, too-old, unversioned and non-object documents", () => {
    expect(kindOf(() => migrator.migrate({ schema_version: 4 }))).toBe("future_version");
    expect(kindOf(() => migrator.migrate({ schema_version: 0 }))).toBe("unsupported_version");
    expect(kindOf(() => migrator.migrate({ name: "x" }))).toBe("no_version");
    expect(kindOf(() => migrator.migrate({ schema_version: "1" }))).toBe("no_version");
    expect(kindOf(() => migrator.migrate([1]))).toBe("not_object");
  });

  test("a migrated document that fails validation is an error", () => {
    expect(kindOf(() => migrator.migrate({ schema_version: 2, display_name: 7 }))).toContain(
      "other",
    );
  });

  test("rejects broken chains at construction", () => {
    const validate = compileValidator(V3);
    const make = (ms: Migration[], currentVersion = 3) =>
      kindOf(() => new SchemaMigrator({ kind: "k", currentVersion, validate, migrations: ms }));
    const [m2, m1] = migrations as [Migration, Migration];
    expect(make([m2, m1, m1])).toBe("config");
    expect(make([m1], 3)).toBe("config"); // gap at v2
    expect(make([{ ...m2, from: 3 }], 3)).toBe("config");
    expect(make([], 0)).toBe("config");
    expect(make([m2])).toBe("none"); // v2 → v3 only; v1 unsupported
  });

  test("a migration that forgets schema_version is caught", () => {
    const m = new SchemaMigrator({
      kind: "k",
      currentVersion: 2,
      validate: (v) => v,
      migrations: [{ from: 1, description: "oops", up: (d) => ({ ...d }) }],
    });
    expect(kindOf(() => m.migrate({ schema_version: 1 }))).toBe("bad_migration");
  });
});

describe("readJsonMigrated", () => {
  test("without writeBack the file is untouched", () => {
    const path = join(tempDir(), "rec.json");
    writeFileSync(path, '{"schema_version":1,"name":"Lab"}');
    expect(readJsonMigrated(path, migrator).value.display_name).toBe("Lab");
    expect(readFileSync(path, "utf8")).toBe('{"schema_version":1,"name":"Lab"}');
  });

  test("with writeBack, keeps a permanent pre-migration copy and rewrites atomically", () => {
    const path = join(tempDir(), "rec.json");
    writeFileSync(path, '{"schema_version":1,"name":"Lab"}');
    const r = readJsonMigrated(path, migrator, { writeBack: true });
    expect(r.fromVersion).toBe(1);
    expect(readJson(path)).toEqual({ schema_version: 3, display_name: "Lab", tags: [] });
    expect(readFileSync(preMigrationBackupPath(path, 1), "utf8")).toBe(
      '{"schema_version":1,"name":"Lab"}',
    );
    expect(readJsonMigrated(path, migrator, { writeBack: true }).migrated).toBe(false);
  });
});
