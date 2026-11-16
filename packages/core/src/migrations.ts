/**
 * Schema migrations for versioned JSON records (spec §5.2, §13; ADR 0007).
 *
 * Every record carries an integer `schema_version`. A `SchemaMigrator` holds a contiguous chain
 * of single-step `up` migrations ending at the current version, plus the validator for that
 * version. Reading a record older than current runs the chain and validates the result; a record
 * newer than current is refused (never silently downgraded or rewritten).
 */
import { existsSync, readFileSync } from "node:fs";
import type { Validator } from "@ablationkit/protocol";
import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import { writeNewFileDurable } from "./fs.ts";

export type JsonObject = { [key: string]: unknown };

export interface Migration {
  /** Version this migration reads; it produces `from + 1`. */
  readonly from: number;
  readonly description: string;
  /** Pure function from a `from` document to a `from + 1` document. Must set schema_version. */
  up(doc: JsonObject): JsonObject;
}

export class MigrationError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(`${kind}: ${message}`);
    this.name = "MigrationError";
    this.kind = kind;
  }
}

export interface MigrationResult<T> {
  readonly value: T;
  /** Version found on disk. */
  readonly fromVersion: number;
  /** True when at least one migration ran. */
  readonly migrated: boolean;
}

export class SchemaMigrator<T> {
  readonly kind: string;
  readonly currentVersion: number;
  readonly minVersion: number;
  private readonly validate: Validator<T>;
  private readonly steps: ReadonlyMap<number, Migration>;

  constructor(options: {
    kind: string;
    currentVersion: number;
    validate: Validator<T>;
    migrations?: readonly Migration[];
  }) {
    const { kind, currentVersion, validate, migrations = [] } = options;
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
      throw new MigrationError("config", `${kind}: currentVersion must be a positive integer`);
    }
    const steps = new Map<number, Migration>();
    for (const m of migrations) {
      if (steps.has(m.from))
        throw new MigrationError("config", `${kind}: two migrations from v${m.from}`);
      if (m.from >= currentVersion) {
        throw new MigrationError(
          "config",
          `${kind}: migration from v${m.from} is not below current v${currentVersion}`,
        );
      }
      steps.set(m.from, m);
    }
    const minVersion = currentVersion - steps.size;
    for (let v = minVersion; v < currentVersion; v++) {
      if (!steps.has(v))
        throw new MigrationError("config", `${kind}: migration chain has a gap at v${v}`);
    }
    this.kind = kind;
    this.currentVersion = currentVersion;
    this.minVersion = minVersion;
    this.validate = validate;
    this.steps = steps;
  }

  /** Migrate an in-memory document to the current version and validate it. */
  migrate(doc: unknown): MigrationResult<T> {
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
      throw new MigrationError("not_object", `${this.kind}: expected a JSON object`);
    }
    const version = (doc as JsonObject)["schema_version"];
    if (!Number.isSafeInteger(version)) {
      throw new MigrationError(
        "no_version",
        `${this.kind}: schema_version is missing or not an integer`,
      );
    }
    const from = version as number;
    if (from > this.currentVersion) {
      throw new MigrationError(
        "future_version",
        `${this.kind}: v${from} is newer than this build supports (v${this.currentVersion}); upgrade AblationKit`,
      );
    }
    if (from < this.minVersion) {
      throw new MigrationError(
        "unsupported_version",
        `${this.kind}: v${from} is older than the oldest migratable v${this.minVersion}`,
      );
    }
    let current: JsonObject = structuredClone(doc as JsonObject);
    for (let v = from; v < this.currentVersion; v++) {
      const step = this.steps.get(v) as Migration;
      current = step.up(current);
      if (current["schema_version"] !== v + 1) {
        throw new MigrationError(
          "bad_migration",
          `${this.kind}: migration from v${v} did not set schema_version ${v + 1}`,
        );
      }
    }
    return {
      value: this.validate(current),
      fromVersion: from,
      migrated: from !== this.currentVersion,
    };
  }
}

/** Path of the permanent pre-migration copy kept when a file is upgraded on disk. */
export function preMigrationBackupPath(path: string, fromVersion: number): string {
  return `${path}.v${fromVersion}.bak`;
}

/**
 * Read a JSON record, migrating it to the current version. With `writeBack`, a migrated record
 * is first copied to `<path>.v<old>.bak` (kept permanently) and then atomically rewritten.
 */
export function readJsonMigrated<T>(
  path: string,
  migrator: SchemaMigrator<T>,
  options: { writeBack?: boolean } = {},
): MigrationResult<T> {
  const result = migrator.migrate(readJson(path));
  if (result.migrated && options.writeBack) {
    const keep = preMigrationBackupPath(path, result.fromVersion);
    if (!existsSync(keep)) {
      writeNewFileDurable(keep, readFileSync(path));
    }
    writeJsonAtomic(path, result.value);
  }
  return result;
}
