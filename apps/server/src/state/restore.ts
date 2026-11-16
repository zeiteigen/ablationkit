/**
 * `backup restore` and `coordinator move` (spec §5.3, §5.8, §13; criterion 17; ADR 0025).
 *
 * Both run with no coordinator: they take the runtime lock of the home they write, so a running
 * coordinator makes them fail instead of racing it.
 *
 * Restore puts a backup into an empty runtime directory (or, with `force`, one whose previous
 * contents are moved aside first):
 * - every file is checked against the manifest's SHA-256 before anything is written;
 * - only files the manifest lists are copied, so an archive cannot plant anything else;
 * - project paths are remapped (`projects`), and project files (`research/`, `.ablationkit/`)
 *   are written into a checkout only where absent: the checkout's own copy always wins;
 * - browser and CLI sessions are revoked; agent and worker tokens are kept, so remote workers can
 *   still reconcile after a move;
 * - Python extension environments are not in the backup; they are rebuilt from each build's
 *   approved lockfile the first time the extension runs;
 * - `<home>/restored.json` records what happened, for the System page.
 *
 * Move backs up a stopped coordinator, packs the backup into an archive and writes
 * `<home>/moved.json`, which stops this home from starting again (no dual masters, spec §5.3).
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { TokenStore } from "@ablationkit/auth";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type BackupManifest,
  type CoordinatorMovedMarker,
  type CoordinatorSettings,
  type ExtensionBuildRecord,
  type PendingRestore,
  type ProjectRegistry,
  type RestoredProject,
  type RestoreRecord,
  validateCoordinatorMovedMarker,
  validateCoordinatorSettings,
  validateExtensionBuildRecord,
  validatePendingRestore,
  validateProjectManifest,
  validateProjectRegistry,
  validateRestoreRecord,
} from "@ablationkit/protocol";
import { type RuntimePaths, runtimePaths } from "../config.ts";
import { AuditLog } from "./audit.ts";
import {
  exportBackup,
  offlineBackupService,
  safeRelative,
  sameContent,
  verifyBackup,
} from "./backup.ts";
import { RuntimeLock } from "./lock.ts";
import { MANIFEST_RELATIVE } from "./registry.ts";

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

/** Thrown by `Coordinator.start` on a home that `coordinator move` retired. */
export class CoordinatorMovedError extends Error {
  constructor(
    readonly marker: CoordinatorMovedMarker,
    readonly path: string,
  ) {
    super(
      `this runtime directory was moved to another machine at ${marker.moved_at} (backup ${marker.backup_id}, archive ${marker.archive}). ` +
        `Starting it here would make a second writable coordinator. If the move was abandoned and the new machine never started, delete ${path} and start again.`,
    );
    this.name = "CoordinatorMovedError";
  }
}

export function movedMarkerPath(home: string): string {
  return join(home, "moved.json");
}

export function restoredRecordPath(home: string): string {
  return join(home, "restored.json");
}

export function pendingRestorePath(home: string): string {
  return join(home, "restore-pending.json");
}

export function readPendingRestore(home: string): PendingRestore | undefined {
  const p = pendingRestorePath(home);
  if (!existsSync(p)) return undefined;
  return readJson(p, validatePendingRestore);
}

/**
 * Apply a restore requested from the System page. Runs inside `Coordinator.start`, with the lock
 * held and before anything loads. The current contents move to `<home>.pre-restore-<ts>`.
 */
export async function applyPendingRestore(
  home: string,
  now: () => Date,
  log: (line: string) => void,
): Promise<RestoreResult | undefined> {
  const pending = readPendingRestore(home);
  if (!pending) return undefined;
  const source = join(runtimePaths(home).backupsDir, pending.backup_id);
  log(`applying the restore of backup ${pending.backup_id} requested by ${pending.requested_by}`);
  const r = await restoreBackup({ source, home, force: true, now, lockHeld: true });
  rmSync(pendingRestorePath(home), { force: true }); // already moved aside with the rest
  if (r.movedAside) log(`the previous contents of ${home} are in ${r.movedAside}`);
  for (const w of r.record.warnings) log(`restore: ${w}`);
  return r;
}

export function readMovedMarker(home: string): CoordinatorMovedMarker | undefined {
  const p = movedMarkerPath(home);
  if (!existsSync(p)) return undefined;
  return readJson(p, validateCoordinatorMovedMarker);
}

export function readRestoreRecord(home: string): RestoreRecord | undefined {
  const p = restoredRecordPath(home);
  if (!existsSync(p)) return undefined;
  try {
    return readJson(p, validateRestoreRecord);
  } catch {
    return undefined;
  }
}

/** Top-level entries that mean a home already holds a coordinator's data. */
const OCCUPIED = ["settings.json", "registry.json", "state", "auth", "audit", "events", "mlflow"];

export interface RestoreOptions {
  /** A backup directory (with `manifest.json`) or a `.tar.gz` made by `backup export`/`coordinator move`. */
  readonly source: string;
  readonly home: string;
  /** `project_id -> checkout path` on this machine; others keep their backed-up path. */
  readonly projectPaths?: Readonly<Record<string, string>>;
  /** Set `remote.worker_url` (where remote workers reach this machine). */
  readonly workerUrl?: string;
  /** Move an occupied home's contents aside (to `<home>.pre-restore-<ts>`) instead of refusing. */
  readonly force?: boolean;
  readonly now?: () => Date;
  /** The caller (a starting coordinator) already holds the runtime lock. */
  readonly lockHeld?: boolean;
}

export interface RestoreResult {
  readonly record: RestoreRecord;
  readonly backupDir: string;
  /** Where an occupied home's previous contents went (`force`). */
  readonly movedAside?: string;
}

function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/\.[0-9]+Z$/, "Z")
    .replaceAll("-", "")
    .replaceAll(":", "");
}

/** Extract an archive into `<into>/<backup-id>/`; returns that directory. */
async function extractArchive(archive: string, into: string): Promise<string> {
  const tmp = join(into, `.restore-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    const p = Bun.spawn(
      ["tar", "-xzf", archive, "-C", tmp, "--no-same-owner", "--no-same-permissions"],
      { stdout: "ignore", stderr: "pipe" },
    );
    const err = await new Response(p.stderr).text();
    if ((await p.exited) !== 0)
      throw new RestoreError(`could not unpack ${archive}: ${err.trim()}`);
    const tops = readdirSync(tmp);
    const top = tops[0];
    if (
      tops.length !== 1 ||
      top === undefined ||
      !lstatSync(join(tmp, top)).isDirectory() ||
      !existsSync(join(tmp, top, "manifest.json"))
    )
      throw new RestoreError(
        `${archive} is not a backup archive (expected one directory with manifest.json)`,
      );
    const dest = join(into, top);
    if (existsSync(dest)) {
      // Same backup already here (a retried restore): keep the copy that is already in place.
      rmSync(tmp, { recursive: true, force: true });
      return dest;
    }
    renameSync(join(tmp, top), dest);
    rmSync(tmp, { recursive: true, force: true });
    return dest;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** Where a manifest path lands in the runtime directory (undefined: a project file, or unknown). */
function homeTarget(paths: RuntimePaths, rel: string): string | undefined {
  const map: [string, string][] = [
    ["mlflow/", paths.mlflowDir],
    ["coordinator/state/", paths.stateDir],
    ["coordinator/auth/", join(paths.home, "auth")],
    ["coordinator/tracking/outbox/", paths.outboxDir],
    ["coordinator/audit/", paths.auditDir],
    ["coordinator/events/", paths.eventsDir],
    ["coordinator/targets/", paths.targetsDir],
  ];
  if (rel === "coordinator/settings.json") return paths.settings;
  if (rel === "coordinator/registry.json") return paths.registry;
  if (rel === "coordinator/compute-weights.json") return paths.computeWeights;
  for (const [prefix, dir] of map)
    if (rel.startsWith(prefix)) return join(dir, rel.slice(prefix.length));
  return undefined;
}

function place(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  copyFileSync(from, to);
  chmodSync(to, 0o600);
}

/** The trees of a checkout that `backup create` copies. */
function isProjectBackupPath(rel: string): boolean {
  return rel.startsWith("research/") || rel.startsWith(".ablationkit/");
}

/** Whether writing `rel` under `root` would pass through a symlink (an existing one, at any depth). */
function leavesCheckout(root: string, rel: string): boolean {
  let cur = root;
  for (const seg of rel.split("/")) {
    cur = join(cur, seg);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      return false; // Nothing there yet: the rest of the path is created fresh.
    }
  }
  return false;
}

function checkoutState(path: string, projectId: string): RestoredProject["checkout"] {
  if (!existsSync(path) || !statSync(path).isDirectory()) return "missing";
  const m = join(path, MANIFEST_RELATIVE);
  if (!existsSync(m)) return "present"; // the backup's manifest is written below
  try {
    return readJson(m, validateProjectManifest).project_id === projectId
      ? "present"
      : "wrong_project";
  } catch {
    return "wrong_project";
  }
}

export async function restoreBackup(o: RestoreOptions): Promise<RestoreResult> {
  const now = o.now ?? (() => new Date());
  const home = resolve(o.home);
  const paths = runtimePaths(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const lock = o.lockHeld ? undefined : RuntimeLock.acquire(paths.lock).lock;
  try {
    if (existsSync(movedMarkerPath(home)))
      throw new RestoreError(
        `${home} was retired by \`coordinator move\` (moved.json); restore into another directory`,
      );
    const occupied = OCCUPIED.filter((e) => existsSync(join(home, e)));
    let movedAside: string | undefined;
    if (occupied.length > 0) {
      if (!o.force)
        throw new RestoreError(
          `${home} already holds coordinator data (${occupied.join(", ")}); restore into an empty directory, or pass --force to move the current contents aside first`,
        );
      movedAside = `${home}.pre-restore-${stamp(now())}`;
      mkdirSync(movedAside, { recursive: true, mode: 0o700 });
      for (const e of readdirSync(home)) {
        if (e === "coordinator.lock" || e === "backups") continue;
        renameSync(join(home, e), join(movedAside, e));
      }
    }

    // The backup, unpacked into this home's backups/ (it stays there as the restore's source).
    mkdirSync(paths.backupsDir, { recursive: true, mode: 0o700 });
    const src = resolve(o.source);
    if (!existsSync(src)) throw new RestoreError(`${src} does not exist`);
    const backupDir = statSync(src).isDirectory()
      ? src
      : await extractArchive(src, paths.backupsDir);
    const verified = await verifyBackup(backupDir).catch((e: Error) => {
      throw new RestoreError(`${backupDir}: ${e.message}`);
    });
    if (!verified.ok)
      throw new RestoreError(
        `the backup does not match its manifest; nothing was restored: ${verified.problems.slice(0, 10).join("; ")}`,
      );
    const manifest: BackupManifest = verified.manifest;

    // Coordinator files and MLflow data.
    const projectFiles = new Map<string, string[]>();
    for (const f of manifest.files) {
      if (!safeRelative(f.path)) continue; // verifyBackup already refused these
      const m = /^projects\/([^/]+)\/(.+)$/.exec(f.path);
      if (m) {
        const list = projectFiles.get(m[1] as string) ?? [];
        list.push(m[2] as string);
        projectFiles.set(m[1] as string, list);
        continue;
      }
      const to = homeTarget(paths, f.path);
      if (to) place(join(backupDir, f.path), to);
    }

    // Projects: remap, then fill in absent project files.
    const warnings: string[] = [];
    const projects: RestoredProject[] = [];
    const known = new Set<string>();
    if (existsSync(paths.registry)) {
      const reg: ProjectRegistry = readJson(paths.registry, validateProjectRegistry);
      for (const p of reg.projects) {
        known.add(p.project_id);
        const to = resolve(o.projectPaths?.[p.project_id] ?? p.path);
        const from = p.path;
        if (to !== from) {
          p.previous_paths.push(from);
          p.path = to;
          p.updated_at = now().toISOString();
        }
        let state = checkoutState(to, p.project_id);
        let written = 0;
        const kept: string[] = [];
        if (state === "present") {
          const refused: string[] = [];
          for (const rel of projectFiles.get(p.project_id) ?? []) {
            const dest = join(to, rel);
            const file = join(backupDir, "projects", p.project_id, rel);
            // A backup holds only these two trees of a checkout: a crafted manifest cannot reach
            // `.git/hooks` or a dotfile, and a checkout's symlink cannot lead a write out of it.
            if (!isProjectBackupPath(rel) || leavesCheckout(to, rel)) {
              refused.push(rel);
              continue;
            }
            if (!existsSync(dest)) {
              place(file, dest);
              chmodSync(dest, 0o644);
              written += 1;
            } else if (!sameContent(file, dest) && kept.length < 200) kept.push(rel);
          }
          if (refused.length)
            warnings.push(
              `${p.project_id}: ${refused.length} file(s) were not restored into the checkout (outside research/ and .ablationkit/, or behind a symlink): ${refused.slice(0, 5).join(", ")}`,
            );
          state = checkoutState(to, p.project_id);
        }
        if (state === "missing")
          warnings.push(
            `${p.project_id}: no checkout at ${to}; clone the repository there (or \`ablationkit project remap ${p.project_id} PATH\`). Its backed-up project files stay in ${join(backupDir, "projects", p.project_id)}`,
          );
        if (state === "wrong_project")
          warnings.push(
            `${p.project_id}: the checkout at ${to} belongs to another project; nothing was written there. Remap the project to its own checkout.`,
          );
        if (kept.length)
          warnings.push(
            `${p.project_id}: ${kept.length} project file(s) differ from the backup; the checkout's copy was kept`,
          );
        projects.push({
          project_id: p.project_id,
          from_path: from,
          to_path: to,
          checkout: state,
          files_written: written,
          files_kept: kept,
        });
      }
      writeJsonAtomic(paths.registry, reg, { validate: validateProjectRegistry });
    }
    for (const id of Object.keys(o.projectPaths ?? {}))
      if (!known.has(id)) warnings.push(`--project ${id}: the backup has no such project`);

    // Settings.
    const settingsChanges: string[] = [];
    if (o.workerUrl !== undefined) {
      let s: CoordinatorSettings = { schema_version: 1 };
      if (existsSync(paths.settings)) s = readJson(paths.settings, validateCoordinatorSettings);
      const before = s.remote?.worker_url;
      s.remote = { ...(s.remote ?? {}), worker_url: o.workerUrl };
      writeJsonAtomic(paths.settings, s, { validate: validateCoordinatorSettings });
      settingsChanges.push(`remote.worker_url: ${before ?? "(unset)"} -> ${o.workerUrl}`);
    }
    if (existsSync(paths.settings)) {
      const s = readJson(paths.settings, validateCoordinatorSettings);
      const machine: string[] = [];
      for (const k of ["human", "worker"] as const) {
        const h = s[k]?.host;
        if (h && h !== "127.0.0.1" && h !== "::1" && h !== "localhost" && h !== "tailscale")
          machine.push(`${k}.host ${h}`);
      }
      if (s.trusted_origins?.length)
        machine.push(`trusted_origins ${s.trusted_origins.map((t) => t.origin).join(", ")}`);
      if (s.remote?.worker_url && o.workerUrl === undefined)
        machine.push(`remote.worker_url ${s.remote.worker_url}`);
      if (machine.length)
        warnings.push(
          `settings.json names addresses of the backed-up machine (${machine.join("; ")}); edit them if this machine's differ`,
        );
      if (s.remote?.artifact_store)
        warnings.push(
          `remote.artifact_store keys come from environment variables (${s.remote.artifact_store.access_key_id_env}, ${s.remote.artifact_store.secret_access_key_env}); set them for the coordinator here`,
        );
    }

    // Sessions: every browser and CLI logs in again.
    let sessionsRevoked = 0;
    if (existsSync(paths.tokens)) {
      const tokens = new TokenStore(paths.tokens, now);
      sessionsRevoked = tokens.revokeWhere(
        (t) => t.kind === "session",
        `restored from backup ${manifest.backup_id}`,
      );
    }
    rmSync(paths.cliSession, { force: true });

    // Extension environments to rebuild.
    const envs: string[] = [];
    if (existsSync(paths.stateDir))
      for (const pid of readdirSync(paths.stateDir)) {
        const root = join(paths.stateDir, pid, "extensions");
        if (!existsSync(root)) continue;
        for (const ext of readdirSync(root)) {
          const bd = join(root, ext, "builds");
          if (!existsSync(bd)) continue;
          for (const eb of readdirSync(bd)) {
            const f = join(bd, eb, "build.json");
            if (!existsSync(f)) continue;
            try {
              const r: ExtensionBuildRecord = readJson(f, validateExtensionBuildRecord);
              if (r.python?.status === "ready" && !existsSync(join(bd, eb, "venv")))
                envs.push(`${pid}/${ext}@${eb}`);
            } catch {
              // an unreadable build record is reported by the coordinator at start
            }
          }
        }
      }

    if (manifest.outbox.pending > 0)
      warnings.push(
        `${manifest.outbox.pending} MLflow write(s) were still queued at backup time; they are delivered when the coordinator starts`,
      );
    if (existsSync(paths.targetsDir) && readdirSync(paths.targetsDir).length > 0)
      warnings.push(
        "remote workers report to the worker URL they were given at launch; if this machine's differs, in-flight attempts spool until they can reach it (or use `ablationkit remote import`)",
      );

    const record: RestoreRecord = {
      schema_version: 1,
      backup_id: manifest.backup_id,
      backup_reason: manifest.reason,
      backup_created_at: manifest.created_at,
      restored_at: now().toISOString(),
      ...(manifest.source ? { source: manifest.source } : {}),
      hostname: hostname() || "unknown",
      projects,
      sessions_revoked: sessionsRevoked,
      settings_changes: settingsChanges,
      extension_envs: envs.slice(0, 500),
      warnings: warnings.map((w) => w.slice(0, 1000)),
    };
    writeJsonAtomic(restoredRecordPath(home), record, {
      validate: validateRestoreRecord,
      backup: false,
    });
    const audit = new AuditLog(paths.auditDir, now);
    audit.record({
      actor: { kind: "system" },
      listener: "internal",
      action: "coordinator.restore",
      outcome: "allowed",
      target: manifest.backup_id,
      details: {
        from: manifest.source?.hostname ?? "unknown",
        projects: projects.length,
        sessions_revoked: sessionsRevoked,
        ...(movedAside ? { moved_aside: movedAside } : {}),
      },
    });
    audit.close();
    return { record, backupDir, ...(movedAside ? { movedAside } : {}) };
  } finally {
    lock?.release();
  }
}

export interface MoveResult {
  readonly marker: CoordinatorMovedMarker;
  readonly backupDir: string;
  readonly bytes: number;
}

/**
 * Hand this home to another machine: back it up with the coordinator stopped, pack the archive,
 * and retire the home. The caller stops the coordinator first; a running one holds the lock.
 */
export async function moveCoordinator(o: {
  readonly home: string;
  readonly out: string;
  readonly now?: () => Date;
}): Promise<MoveResult> {
  const now = o.now ?? (() => new Date());
  const paths = runtimePaths(resolve(o.home));
  const out = resolve(o.out);
  if (existsSync(out)) throw new RestoreError(`${out} already exists`);
  if (!existsSync(paths.registry) && !existsSync(paths.stateDir))
    throw new RestoreError(`${paths.home} holds no coordinator data`);
  const { lock } = RuntimeLock.acquire(paths.lock);
  try {
    const existing = readMovedMarker(paths.home);
    if (existing) throw new CoordinatorMovedError(existing, movedMarkerPath(paths.home));
    const backups = await offlineBackupService(paths, now);
    const b = await backups.create("move");
    const packed = await exportBackup(b.path, out);
    const marker: CoordinatorMovedMarker = {
      schema_version: 1,
      moved_at: now().toISOString(),
      backup_id: b.manifest.backup_id,
      archive: out,
      archive_sha256: packed.sha256,
      hostname: hostname() || "unknown",
    };
    writeJsonAtomic(movedMarkerPath(paths.home), marker, {
      validate: validateCoordinatorMovedMarker,
      backup: false,
    });
    const audit = new AuditLog(paths.auditDir, now);
    audit.record({
      actor: { kind: "system" },
      listener: "internal",
      action: "coordinator.move",
      outcome: "allowed",
      target: b.manifest.backup_id,
      details: { archive: basename(out), sha256: packed.sha256, bytes: packed.bytes },
    });
    audit.close();
    return { marker, backupDir: b.path, bytes: packed.bytes };
  } finally {
    lock.release();
  }
}
