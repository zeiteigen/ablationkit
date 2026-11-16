/** Managed extension JSON collections and immutable blobs. All methods are synchronous so a
 * coordinator mutation checks its revision and quota in the same turn. This is coordinator-owned
 * state, not a filesystem sandbox against another process modifying the state directory. */
import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readJson, serializeJson, writeJsonAtomic } from "@ablationkit/core";

export type ExtensionDataErrorCode =
  | "invalid_data"
  | "unsafe_path"
  | "revision_conflict"
  | "schema_conflict"
  | "migration_missing"
  | "quota_exceeded"
  | "blob_corrupt"
  | "not_found";

/** Stable codes for bridge/API callers; status is an HTTP-compatible status number. */
export class ExtensionDataError extends Error {
  constructor(
    readonly code: ExtensionDataErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ExtensionDataError";
  }
}

export interface ExtensionDataRecord {
  key: string;
  schema_version: number;
  revision: number;
  value: unknown;
}

interface Collection {
  schema_version: number;
  next_revision: number;
  records: Record<string, ExtensionDataRecord>;
}

type Migration = (value: unknown) => unknown;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function fail(code: ExtensionDataErrorCode, status: number, message: string): never {
  throw new ExtensionDataError(code, status, message);
}

function identifier(value: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("invalid_data", 400, "Invalid extension data identifier");
  }
  return value;
}

function version(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("invalid_data", 400, "Schema versions must be positive integers");
  }
}

function stat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function jsonClone(value: unknown): unknown {
  const seen = new Set<object>();
  function check(item: unknown): void {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || item === null || seen.has(item)) {
      fail("invalid_data", 400, "Values must be finite, acyclic JSON");
    }
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    ) {
      fail("invalid_data", 400, "Values must contain only JSON objects and arrays");
    }
    seen.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item)) check(child);
    seen.delete(item);
  }
  check(value);
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export class ExtensionDataStore {
  private readonly stateDir: string;
  private readonly maxBytes: number;
  private readonly migrations = new Map<string, Map<number, Migration>>();

  constructor(options: { stateDir: string; maxBytes?: number }) {
    this.stateDir = resolve(options.stateDir);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      fail("invalid_data", 400, "maxBytes must be a positive integer");
    }
  }

  get(
    project: string,
    ext: string,
    collection: string,
    key: string,
  ): ExtensionDataRecord | undefined {
    identifier(key);
    const state = this.readCollection(this.collectionPath(project, ext, collection));
    return state && Object.hasOwn(state.records, key) ? state.records[key] : undefined;
  }

  /** Keys are sorted by code point; cursor is the last returned key (exclusive). */
  list(
    project: string,
    ext: string,
    collection: string,
    options: { cursor?: string; limit?: number } = {},
  ): { records: ExtensionDataRecord[]; next_cursor?: string } {
    if (options.cursor !== undefined) identifier(options.cursor);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      fail("invalid_data", 400, "List limit must be between 1 and 1000");
    }
    const state = this.readCollection(this.collectionPath(project, ext, collection));
    const keys = Object.keys(state?.records ?? {})
      .sort()
      .filter((key) => options.cursor === undefined || key > options.cursor);
    const records = keys.slice(0, limit).map((key) => state?.records[key] as ExtensionDataRecord);
    return { records, ...(keys.length > limit ? { next_cursor: keys[limit - 1] as string } : {}) };
  }

  put(
    project: string,
    ext: string,
    collection: string,
    key: string,
    input: { schema_version: number; value: unknown; expected_revision: number | null },
  ): ExtensionDataRecord {
    identifier(key);
    version(input.schema_version);
    const value = jsonClone(input.value);
    const path = this.collectionPath(project, ext, collection, true);
    const state = this.readCollection(path) ?? {
      schema_version: input.schema_version,
      next_revision: 1,
      records: {},
    };
    this.checkRevision(
      Object.hasOwn(state.records, key) ? state.records[key] : undefined,
      input.expected_revision,
    );
    if (state.schema_version !== input.schema_version)
      fail(
        "schema_conflict",
        409,
        "Migrate the collection before writing a different schema version",
      );
    const record = {
      key,
      schema_version: state.schema_version,
      revision: state.next_revision++,
      value,
    };
    state.records[key] = record;
    this.writeCollection(project, ext, path, state);
    return record;
  }

  delete(
    project: string,
    ext: string,
    collection: string,
    key: string,
    expectedRevision: number,
  ): void {
    identifier(key);
    const path = this.collectionPath(project, ext, collection);
    const state = this.readCollection(path);
    this.checkRevision(
      state && Object.hasOwn(state.records, key) ? state.records[key] : undefined,
      expectedRevision,
    );
    if (!state) fail("revision_conflict", 409, "Record no longer exists");
    delete state.records[key];
    this.writeCollection(project, ext, path, state);
  }

  registerMigration(ext: string, collection: string, fromVersion: number, fn: Migration): void {
    identifier(ext);
    identifier(collection);
    version(fromVersion);
    const key = `${ext}/${collection}`;
    const steps = this.migrations.get(key) ?? new Map<number, Migration>();
    if (steps.has(fromVersion) || typeof fn !== "function")
      fail("invalid_data", 400, "Migration must be a function registered once per version");
    steps.set(fromVersion, fn);
    this.migrations.set(key, steps);
  }

  /** Each registered step upgrades one version. Failures leave the entire collection unchanged. */
  migrate(project: string, ext: string, collection: string, targetVersion: number): void {
    version(targetVersion);
    const path = this.collectionPath(project, ext, collection);
    const state = this.readCollection(path);
    if (!state) fail("not_found", 404, "Collection does not exist");
    if (targetVersion < state.schema_version)
      fail("schema_conflict", 409, "Schema downgrades are not supported");
    if (targetVersion === state.schema_version) return;
    const steps = this.migrations.get(`${ext}/${collection}`);
    for (let from = state.schema_version; from < targetVersion; from++) {
      if (!steps?.has(from))
        fail("migration_missing", 409, `No migration registered for version ${from}`);
    }
    for (let from = state.schema_version; from < targetVersion; from++) {
      const step = steps?.get(from) as Migration;
      for (const record of Object.values(state.records)) {
        record.value = jsonClone(step(record.value));
        record.schema_version = from + 1;
        record.revision = state.next_revision++;
      }
    }
    state.schema_version = targetVersion;
    this.writeCollection(project, ext, path, state);
  }

  /** Commit extension-computed replacements for one complete collection snapshot. */
  migrateRecords(
    project: string,
    ext: string,
    collection: string,
    input: {
      from_version: number;
      to_version: number;
      records: { key: string; expected_revision: number; value: unknown }[];
    },
  ): void {
    version(input.from_version);
    version(input.to_version);
    if (input.to_version !== input.from_version + 1)
      fail("schema_conflict", 409, "Collection migrations must advance exactly one schema version");
    if (!Array.isArray(input.records))
      fail("invalid_data", 400, "Migration records must be an array");
    const path = this.collectionPath(project, ext, collection);
    const state = this.readCollection(path);
    if (!state) fail("not_found", 404, "Collection does not exist");
    if (state.schema_version !== input.from_version)
      fail("schema_conflict", 409, "Collection schema changed since the migration snapshot");
    const replacements = new Map<string, unknown>();
    for (const record of input.records) {
      if (!record || typeof record !== "object")
        fail("invalid_data", 400, "Invalid migration record");
      identifier(record.key);
      if (replacements.has(record.key) || !Object.hasOwn(state.records, record.key))
        fail("revision_conflict", 409, "Migration keys do not match the collection snapshot");
      this.checkRevision(state.records[record.key], record.expected_revision);
      replacements.set(record.key, jsonClone(record.value));
    }
    if (replacements.size !== Object.keys(state.records).length)
      fail("revision_conflict", 409, "Migration must include every collection record");
    if (!Number.isSafeInteger(state.next_revision + replacements.size))
      fail("revision_conflict", 409, "Collection revision limit reached");
    // All keys, revisions and values have passed validation before any state is replaced.
    for (const [key, value] of replacements) {
      state.records[key] = {
        key,
        schema_version: input.to_version,
        revision: state.next_revision++,
        value,
      };
    }
    state.schema_version = input.to_version;
    this.writeCollection(project, ext, path, state);
  }

  putBlob(project: string, ext: string, bytes: Uint8Array): { sha256: string; bytes: number } {
    if (!(bytes instanceof Uint8Array)) fail("invalid_data", 400, "Blob must be bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const root = this.namespace(project, ext, true);
    const dir = this.directory(join(root, "blobs"), true);
    const path = join(dir, sha256);
    this.checkFile(path);
    if (stat(path)) {
      this.getBlob(project, ext, sha256);
      return { sha256, bytes: bytes.byteLength };
    }
    this.checkQuota(root, bytes.byteLength);
    const tmp = join(dir, `.blob-${randomBytes(12).toString("hex")}`);
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      linkSync(tmp, path);
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } finally {
      rmSync(tmp, { force: true });
    }
    return { sha256, bytes: bytes.byteLength };
  }

  getBlob(project: string, ext: string, sha256: string): Uint8Array {
    if (!HASH.test(sha256)) fail("invalid_data", 400, "Invalid SHA256 blob identifier");
    const path = join(this.directory(join(this.namespace(project, ext), "blobs")), sha256);
    this.checkFile(path);
    if (!stat(path)) fail("not_found", 404, "Blob does not exist");
    const bytes = readFileSync(path);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      fail("blob_corrupt", 409, "Blob content does not match its SHA256");
    return bytes;
  }

  private checkRevision(record: ExtensionDataRecord | undefined, expected: number | null): void {
    if (
      (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) ||
      (record?.revision ?? null) !== expected
    ) {
      fail("revision_conflict", 409, "Expected revision does not match the current record");
    }
  }

  private namespace(project: string, ext: string, create = false): string {
    return this.directory(
      join(this.stateDir, identifier(project), "extensions", "data", identifier(ext)),
      create,
    );
  }

  private collectionPath(project: string, ext: string, collection: string, create = false): string {
    const dir = this.directory(join(this.namespace(project, ext, create), "collections"), create);
    const path = join(dir, `${identifier(collection)}.json`);
    this.checkFile(path);
    return path;
  }

  /** Check every existing ancestor, including stateDir itself, before following a path. */
  private directory(path: string, create = false): string {
    const parent = dirname(path);
    if (parent !== path) this.directory(parent, create);
    const entry = stat(path);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
      fail("unsafe_path", 400, "Extension data paths must be real directories");
    if (!entry && create) mkdirSync(path, { mode: 0o700 });
    return path;
  }

  private checkFile(path: string): void {
    const entry = stat(path);
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1))
      fail("unsafe_path", 400, "Extension data files must be private regular files");
  }

  private readCollection(path: string): Collection | undefined {
    if (!stat(path)) return undefined;
    const value = readJson<Collection>(path);
    if (
      !value ||
      !Number.isSafeInteger(value.schema_version) ||
      value.schema_version < 1 ||
      !Number.isSafeInteger(value.next_revision) ||
      value.next_revision < 1 ||
      typeof value.records !== "object" ||
      value.records === null ||
      Array.isArray(value.records)
    )
      fail("invalid_data", 500, "Invalid stored collection");
    for (const [key, record] of Object.entries(value.records)) {
      identifier(key);
      if (
        !record ||
        record.key !== key ||
        record.schema_version !== value.schema_version ||
        !Number.isSafeInteger(record.revision) ||
        record.revision < 1 ||
        record.revision >= value.next_revision ||
        !Object.hasOwn(record, "value")
      )
        fail("invalid_data", 500, "Invalid stored record");
    }
    return value;
  }

  private writeCollection(project: string, ext: string, path: string, state: Collection): void {
    const bytes = serializeJson(state);
    this.checkQuota(this.namespace(project, ext), bytes.byteLength - (stat(path)?.size ?? 0));
    writeJsonAtomic(path, state, { backup: false });
  }

  private checkQuota(root: string, additional: number): void {
    const size = (path: string): number => {
      const entry = stat(path);
      if (!entry) return 0;
      if (entry.isSymbolicLink())
        fail("unsafe_path", 400, "Symlinks are not allowed in extension data");
      if (entry.isDirectory())
        return readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0);
      this.checkFile(path);
      return entry.size;
    };
    if (size(root) + additional > this.maxBytes)
      fail("quota_exceeded", 413, "Extension data quota exceeded");
  }
}
