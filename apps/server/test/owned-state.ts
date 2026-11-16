/**
 * Criterion 3 (file-based research): AblationKit's own state is JSON, JSONL, Markdown and plain
 * files. MLflow's SQLite database is allowed only for MLflow data, under `<home>/mlflow/`.
 *
 * `ownedStateAudit` walks a coordinator home (and any project checkouts) and reports every file
 * that is an embedded database: SQLite by its header, LMDB and LevelDB/RocksDB by their file
 * names. It also returns a census of file kinds per top-level directory so a test can assert that
 * record directories hold only JSON, JSONL and Markdown.
 */
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { extname, join, relative } from "node:path";

const SQLITE_MAGIC = "SQLite format 3\0";
/** Embedded key-value stores recognised by their file names. */
const KV_NAMES = [/^data\.mdb$/, /^lock\.mdb$/, /^[0-9]{6}\.(ldb|sst)$/, /^MANIFEST-[0-9]+$/];
/** Directories that are not AblationKit state: Python environments and package caches. */
const SKIP_DIRS = new Set(["venv", ".venv", "node_modules", "__pycache__", ".git"]);

export interface AuditResult {
  /** Paths (relative to the scanned root) of database files outside the allowed MLflow prefix. */
  databases: string[];
  /** Database files found under the allowed prefix (MLflow's own). */
  mlflowDatabases: string[];
  /** Top-level directory → file extensions seen there (`""` for no extension). */
  census: Map<string, Set<string>>;
  files: number;
}

function isSqlite(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return n === 16 && buf.toString("latin1") === SQLITE_MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Scan `root`. `mlflow` (a relative prefix such as `mlflow/`, or a pattern) is where MLflow's
 * database may live; pass `undefined` for a project checkout, where no database is allowed.
 */
export function ownedStateAudit(root: string, mlflow?: string | RegExp): AuditResult {
  const allowed = (rel: string): boolean =>
    mlflow === undefined
      ? false
      : typeof mlflow === "string"
        ? rel.startsWith(mlflow)
        : mlflow.test(rel);
  const out: AuditResult = { databases: [], mlflowDatabases: [], census: new Map(), files: 0 };
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
        continue;
      }
      if (!e.isFile() || lstatSync(p).isSymbolicLink()) continue;
      out.files++;
      const rel = relative(root, p);
      const top = rel.includes("/") ? (rel.split("/")[0] as string) : ".";
      const kinds = out.census.get(top) ?? new Set<string>();
      out.census.set(top, kinds);
      kinds.add(extname(e.name));
      if (isSqlite(p) || KV_NAMES.some((re) => re.test(e.name))) {
        if (allowed(rel)) out.mlflowDatabases.push(rel);
        else out.databases.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Extensions allowed in AblationKit's record directories. `.bak` is the previous version of an
 * atomic JSON write (still JSON) and `.tmp` an atomic write in flight (ADR 0007).
 */
export const RECORD_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".bak", ".tmp"]);
