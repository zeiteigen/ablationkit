/**
 * SQLite-safe snapshot of MLflow's database (spec §5.8: "use a SQLite-safe snapshot/backup
 * method or quiesce the service, not an unsafe copy of a live database file"). `VACUUM INTO`
 * runs inside a read transaction, so the copy is consistent even while MLflow is writing. This
 * opens the file only to snapshot it; AblationKit never reads or writes MLflow's tables.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export function snapshotSqlite(source: string, dest: string, busyTimeoutMs = 30_000): void {
  if (!existsSync(source)) throw new Error(`no database at ${source}`);
  if (existsSync(dest)) throw new Error(`snapshot target ${dest} already exists`);
  const db = new Database(source, { readwrite: true, create: false });
  try {
    db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    db.run("VACUUM INTO ?", [dest]);
  } finally {
    db.close();
  }
  const check = new Database(dest, { readonly: true });
  try {
    const row = check.query("PRAGMA integrity_check").get() as Record<string, string> | null;
    const v = row ? Object.values(row)[0] : undefined;
    if (v !== "ok") throw new Error(`snapshot ${dest} failed integrity_check: ${v}`);
  } finally {
    check.close();
  }
}
