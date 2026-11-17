/**
 * `backup create` (spec §5.3, §5.8, §13; ADRs 0010, 0025): one coordinated snapshot of MLflow data
 * and coordinator state, under `<home>/backups/<backup-id>/`.
 *
 * - MLflow's SQLite database is copied with `VACUUM INTO` (consistent while MLflow runs), never
 *   with a raw file copy.
 * - Writes are held still for the duration: in a running coordinator tracking delivery is paused,
 *   so run mappings and the outbox agree with the database snapshot about which AblationKit writes
 *   MLflow has acknowledged; `coordinator move` instead backs up with the coordinator stopped and
 *   the runtime lock held (`quiesce: coordinator_stopped`).
 * - Artifacts are copied after the database, so every artifact the snapshot references exists.
 * - The backup is written to `<id>.partial/` and renamed when complete; a crash leaves no
 *   half-backup that looks finished.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type BackupFile,
  type BackupManifest,
  validateBackupManifest,
  validateMlflowSidecarState,
} from "@ablationkit/protocol";
import { Outbox, snapshotSqlite } from "@ablationkit/tracking-mlflow";
import type { RuntimePaths } from "../config.ts";
import { ProjectRegistryService } from "./registry.ts";

/** How a backup holds writes still while it copies. */
export interface BackupQuiesce {
  readonly mode: NonNullable<BackupManifest["quiesce"]>;
  pause(): Promise<void>;
  resume(): void;
  outboxStats(): { pending: number; failed: number };
}

export interface BackupDeps {
  readonly paths: RuntimePaths;
  readonly now: () => Date;
  readonly quiesce: BackupQuiesce;
  readonly projects: () => readonly { project_id: string; path: string }[];
  readonly mlflowVersion: () => string | undefined;
}

/** What a backup deliberately leaves out. */
export const BACKUP_EXCLUSIONS: readonly string[] = [
  "run/: sockets and pid files, recreated at start",
  "coordinator.lock: belongs to the running process",
  "cli-session.json: the CLI's own bearer sessions",
  "mlflow/venv/: rebuilt from packages/tracking-mlflow/env/uv.lock",
  "mlflow/logs/: sidecar logs",
  "mlflow/mlflow.db (live file): replaced by a VACUUM INTO snapshot",
  "backups/: earlier backups",
  "state/*/extensions/*/builds/*/venv/: Python extension environments hold absolute paths; rebuilt from the approved lockfile on first use",
  "spool/: undelivered local collector data; local attempts do not survive a restart, and what was delivered is in state/ and MLflow",
  "bundles/: staged run bundles, already on their targets",
  "work/: agents' jobs' working copies of their source, and their inputs (downloaded again from MLflow)",
  "builds/: Level 2 builds; a restored coordinator runs the original install",
  "operations/: per-run scratch of the operations bridge",
  "project checkouts: source and Git history stay in each repository; research/ and .ablationkit/ are copied",
];

/** `state/<project>/extensions/<ext>/builds/<eb>/venv`, relative to the state directory. */
const EXTENSION_VENV = /^[^/]+\/extensions\/[^/]+\/builds\/eb-[0-9a-f]{16}\/venv(\/|$)/;

function backupId(now: Date, reason: BackupManifest["reason"]): string {
  const ts = now
    .toISOString()
    .replace(/\.[0-9]+Z$/, "Z")
    .replaceAll("-", "")
    .replaceAll(":", "");
  return reason === "manual" ? ts : `${ts}-${reason.replace("_", "-")}`;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export interface BackupResult {
  readonly manifest: BackupManifest;
  readonly path: string;
}

export class BackupService {
  private running: Promise<BackupResult> | undefined;

  constructor(private readonly deps: BackupDeps) {}

  /** One backup at a time; a concurrent call waits for, and returns, the one in flight. */
  create(reason: BackupManifest["reason"] = "manual"): Promise<BackupResult> {
    if (this.running) return this.running;
    this.running = this.createInner(reason).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async createInner(reason: BackupManifest["reason"]): Promise<BackupResult> {
    const { paths, quiesce } = this.deps;
    mkdirSync(paths.backupsDir, { recursive: true, mode: 0o700 });
    let id = backupId(this.deps.now(), reason);
    for (let n = 2; existsSync(join(paths.backupsDir, id)); n++)
      id = `${backupId(this.deps.now(), reason)}-${n}`;
    const final = join(paths.backupsDir, id);
    const tmp = `${final}.partial`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true, mode: 0o700 });

    await quiesce.pause();
    try {
      const db = join(paths.mlflowDir, "mlflow.db");
      let method: BackupManifest["mlflow_database"] = "absent";
      mkdirSync(join(tmp, "mlflow"), { recursive: true, mode: 0o700 });
      if (existsSync(db) && statSync(db).size > 0) {
        snapshotSqlite(db, join(tmp, "mlflow", "mlflow.db"));
        method = "vacuum_into";
      }
      const copy = (from: string, to: string, filter?: (rel: string) => boolean) => {
        if (!existsSync(from)) return;
        cpSync(from, join(tmp, to), {
          recursive: true,
          preserveTimestamps: true,
          ...(filter ? { filter: (src: string) => filter(relative(from, src)) } : {}),
        });
      };
      copy(join(paths.mlflowDir, "artifacts"), "mlflow/artifacts");
      copy(join(paths.mlflowDir, "sidecar.json"), "mlflow/sidecar.json");
      copy(paths.settings, "coordinator/settings.json");
      copy(paths.registry, "coordinator/registry.json");
      copy(join(paths.home, "auth"), "coordinator/auth");
      copy(paths.stateDir, "coordinator/state", (rel) => !EXTENSION_VENV.test(rel));
      copy(paths.outboxDir, "coordinator/tracking/outbox");
      copy(paths.auditDir, "coordinator/audit");
      copy(paths.eventsDir, "coordinator/events");
      copy(paths.targetsDir, "coordinator/targets");
      copy(paths.computeWeights, "coordinator/compute-weights.json");
      const projects = this.deps
        .projects()
        .map((p) => ({ project_id: p.project_id, path: p.path }));
      for (const p of projects) {
        copy(join(p.path, "research"), `projects/${p.project_id}/research`);
        copy(join(p.path, ".ablationkit"), `projects/${p.project_id}/.ablationkit`);
      }
      const stats = quiesce.outboxStats();
      const files: BackupFile[] = [];
      for (const f of walkFiles(tmp))
        files.push({
          path: relative(tmp, f),
          bytes: statSync(f).size,
          sha256: await sha256File(f),
        });
      files.sort((a, b) => a.path.localeCompare(b.path));
      const version = this.deps.mlflowVersion();
      const manifest: BackupManifest = {
        schema_version: 1,
        backup_id: id,
        created_at: this.deps.now().toISOString(),
        reason,
        quiesce: quiesce.mode,
        source: { hostname: hostname() || "unknown", home: paths.home },
        projects,
        ...(version ? { mlflow_version: version } : {}),
        mlflow_database: method,
        outbox: { pending: stats.pending, failed: stats.failed },
        files,
        excluded: [...BACKUP_EXCLUSIONS],
      };
      writeJsonAtomic(join(tmp, "manifest.json"), manifest, {
        validate: validateBackupManifest,
        backup: false,
      });
      renameSync(tmp, final);
      return { manifest, path: final };
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    } finally {
      quiesce.resume();
    }
  }

  list(): { manifest: BackupManifest; path: string }[] {
    const dir = this.deps.paths.backupsDir;
    if (!existsSync(dir)) return [];
    const out: { manifest: BackupManifest; path: string }[] = [];
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".partial")) continue;
      try {
        out.push({
          manifest: readJson(join(dir, name, "manifest.json"), validateBackupManifest),
          path: join(dir, name),
        });
      } catch {
        // not a backup, or damaged: skipped (doctor reports it)
      }
    }
    return out;
  }

  path(id: string): string {
    if (!/^[0-9]{8}T[0-9]{6}Z(-[a-z0-9-]{1,40})?$/.test(id))
      throw new Error(`not a backup ID: ${id}`);
    return join(this.deps.paths.backupsDir, id);
  }

  /** Re-hash every file of a backup against its manifest. */
  verify(id: string): ReturnType<typeof verifyBackup> {
    return verifyBackup(this.path(id));
  }
}

/** Re-hash every file of the backup in `dir` against its manifest. */
export async function verifyBackup(
  dir: string,
): Promise<{ ok: boolean; problems: string[]; manifest: BackupManifest }> {
  const manifest = readJson(join(dir, "manifest.json"), validateBackupManifest);
  const root = `${realpathSync(dir)}/`;
  const problems: string[] = [];
  for (const f of manifest.files) {
    const p = join(dir, f.path);
    if (!safeRelative(f.path)) problems.push(`unsafe path ${f.path}`);
    else if (!existsSync(p) || !lstatSync(p).isFile()) problems.push(`missing ${f.path}`);
    // A symlinked directory inside an unpacked archive must not lead a restore outside it.
    else if (!realpathSync(p).startsWith(root)) problems.push(`outside the backup ${f.path}`);
    else if ((await sha256File(p)) !== f.sha256) problems.push(`checksum mismatch ${f.path}`);
  }
  return { ok: problems.length === 0, problems, manifest };
}

/** A manifest path stays inside the backup: relative, no `..`, no empty segments. */
export function safeRelative(p: string): boolean {
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/**
 * A backup made while no coordinator runs (`coordinator move`): the caller holds the runtime lock,
 * so nothing writes; the outbox is opened read-only for its counts.
 */
export async function offlineBackupService(
  paths: RuntimePaths,
  now: () => Date = () => new Date(),
): Promise<BackupService> {
  let stats = { pending: 0, failed: 0 };
  if (existsSync(paths.outboxDir)) {
    const outbox = await Outbox.open(paths.outboxDir, { now });
    const s = outbox.stats();
    stats = { pending: s.pending, failed: s.failed };
    outbox.close();
  }
  const registry = new ProjectRegistryService(paths.registry, paths.stateDir, now);
  let version: string | undefined;
  try {
    version = readJson(
      join(paths.mlflowDir, "sidecar.json"),
      validateMlflowSidecarState,
    ).data_mlflow_version;
  } catch {
    version = undefined;
  }
  return new BackupService({
    paths,
    now,
    quiesce: {
      mode: "coordinator_stopped",
      pause: async () => {},
      resume: () => {},
      outboxStats: () => stats,
    },
    projects: () => registry.list(),
    mlflowVersion: () => version,
  });
}

/** Pack a backup directory into `<out>` (tar.gz, one top-level directory named after the ID). */
export async function exportBackup(
  dir: string,
  out: string,
): Promise<{ sha256: string; bytes: number }> {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.partial`;
  rmSync(tmp, { force: true });
  const p = Bun.spawn(["tar", "-czf", tmp, "-C", dirname(dir), relative(dirname(dir), dir)], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) {
    rmSync(tmp, { force: true });
    throw new Error(`tar failed: ${err.trim()}`);
  }
  renameSync(tmp, out);
  return { sha256: await sha256File(out), bytes: statSync(out).size };
}

/** Read a small file fully (used by tests and restore to compare contents). */
export function sameContent(a: string, b: string): boolean {
  return readFileSync(a).equals(readFileSync(b));
}
