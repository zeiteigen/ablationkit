/** `ablationkit tracking …` and `ablationkit backup …` over the human API (spec §12, ADR 0010). */
import { existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CoordinatorLockedError,
  RestoreError,
  restoreBackup,
  runtimePaths,
} from "@ablationkit/server";
import { CoordinatorClient } from "../client.ts";
import { type CliContext, flag, parseArgs, printJson, UsageError } from "../context.ts";

const TRACKING_USAGE = `usage:
  ablationkit tracking doctor                       check MLflow, storage and the outbox
  ablationkit tracking status                       sidecar state and outbox counts
  ablationkit tracking outbox [--failed] [--project ID]
  ablationkit tracking retry OP_ID                  requeue a write MLflow rejected
  ablationkit tracking import --project ID --experiment EXPERIMENT_ID
                                                    link a historical MLflow experiment read-only
  (all take --json and --coordinator URL)`;

const BACKUP_USAGE = `usage:
  ablationkit backup create                consistent coordinator + MLflow snapshot
  ablationkit backup list
  ablationkit backup verify ID             re-hash every file against the manifest
  ablationkit backup export ID --out FILE  pack a backup into a .tar.gz for another machine
  (these take --json and --coordinator URL)
  ablationkit backup restore SOURCE [--project ID=PATH]... [--worker-url URL] [--force] [--json]
        SOURCE is a backup ID, a backup directory or an archive. Runs with the coordinator
        stopped, into ABLATIONKIT_HOME (empty, or --force to move its contents aside first).
        A running coordinator can instead restore at its next start: System page.`;

interface Check {
  name: string;
  status: string;
  detail: string;
}

interface OutboxStats {
  pending: number;
  failed: number;
  bytes: number;
  oldest_enqueued_at?: string;
}

interface Status {
  sidecar: {
    state: string;
    pinned_version: string;
    data_version?: string;
    last_error?: string;
    restarts: number;
  };
  outbox: OutboxStats;
  last_contact_at?: string;
  last_transport_error?: { message: string };
}

export async function trackingCommand(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest, ["json", "failed"]);
  const asJson = args.flags["json"] === true;
  const coordinator = flag(args, "coordinator");
  const connect = () => CoordinatorClient.connect(ctx, coordinator);

  if (sub === "doctor") {
    const r = await (await connect()).request<{ status: string; checks: Check[] }>(
      "GET",
      "/api/v1/tracking/doctor",
    );
    if (asJson) printJson(ctx, r);
    else {
      for (const c of r.checks)
        ctx.out(`${c.status.padEnd(4)}  ${c.name.padEnd(20)} ${c.detail}\n`);
      ctx.out(`\ntracking: ${r.status}\n`);
    }
    return r.status === "fail" ? 1 : 0;
  }
  if (sub === "status") {
    const r = await (await connect()).request<Status>("GET", "/api/v1/tracking/status");
    if (asJson) printJson(ctx, r);
    else {
      const s = r.sidecar;
      ctx.out(
        `mlflow   ${s.state} (pinned ${s.pinned_version}${s.data_version ? `, data ${s.data_version}` : ""}, ${s.restarts} restarts)${s.last_error ? `\n         ${s.last_error}` : ""}\n`,
      );
      ctx.out(
        `outbox   ${r.outbox.pending} pending, ${r.outbox.failed} failed, ${r.outbox.bytes} bytes${r.outbox.oldest_enqueued_at ? `, oldest ${r.outbox.oldest_enqueued_at}` : ""}\n`,
      );
      if (r.last_transport_error) ctx.out(`last error  ${r.last_transport_error.message}\n`);
    }
    return 0;
  }
  if (sub === "outbox") {
    const q = new URLSearchParams();
    if (args.flags["failed"] === true) q.set("state", "failed");
    const project = flag(args, "project");
    if (project) q.set("project", project);
    const r = await (await connect()).request<{
      stats: OutboxStats;
      entries: {
        op_id: string;
        kind: string;
        project_id: string;
        ref?: string;
        state: string;
        attempts: number;
        last_error?: { message: string };
      }[];
    }>("GET", `/api/v1/tracking/outbox?${q}`);
    if (asJson) printJson(ctx, r);
    else if (r.entries.length === 0)
      ctx.out("outbox is empty: MLflow has acknowledged every write\n");
    else
      for (const e of r.entries)
        ctx.out(
          `${e.op_id}\t${e.state}\t${e.kind}\t${e.project_id}/${e.ref ?? "-"}\t${e.attempts} tries${e.last_error ? `\t${e.last_error.message}` : ""}\n`,
        );
    return 0;
  }
  if (sub === "retry") {
    const id = args.positional[0];
    if (!id) throw new UsageError(TRACKING_USAGE);
    const r = await (await connect()).request<{ op_id: string; state: string }>(
      "POST",
      `/api/v1/tracking/outbox/${encodeURIComponent(id)}/retry`,
      {},
    );
    if (asJson) printJson(ctx, r);
    else ctx.out(`requeued ${r.op_id}\n`);
    return 0;
  }
  if (sub === "import") {
    const project = flag(args, "project");
    const experiment = flag(args, "experiment");
    if (!project || !experiment) throw new UsageError(TRACKING_USAGE);
    const r = await (await connect()).request<{
      experiment: { name: string; experiment_id: string };
    }>("POST", `/api/v1/projects/${encodeURIComponent(project)}/tracking/imports`, {
      experiment_id: experiment,
    });
    if (asJson) printJson(ctx, r);
    else
      ctx.out(
        `linked ${r.experiment.name} (${r.experiment.experiment_id}) to ${project}, read-only\n`,
      );
    return 0;
  }
  throw new UsageError(TRACKING_USAGE);
}

/** Every `--project ID=PATH` (the flag may repeat). */
export function projectMappings(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    let v: string | undefined;
    if (a === "--project") v = argv[++i];
    else if (a.startsWith("--project=")) v = a.slice("--project=".length);
    else continue;
    const eq = v?.indexOf("=") ?? -1;
    if (!v || eq <= 0 || eq === v.length - 1)
      throw new UsageError(
        "--project takes ID=PATH (the checkout of that project on this machine)",
      );
    out[v.slice(0, eq)] = resolve(v.slice(eq + 1));
  }
  return out;
}

export async function backupCommand(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest, ["json", "force"]);
  const asJson = args.flags["json"] === true;
  const client = () => CoordinatorClient.connect(ctx, flag(args, "coordinator"));
  if (sub === "create") {
    const r = await (await client()).request<{
      backup_id: string;
      path: string;
      mlflow_database: string;
      files: number;
      bytes: number;
      outbox: { pending: number; failed: number };
    }>("POST", "/api/v1/backups", {});
    if (asJson) printJson(ctx, r);
    else {
      ctx.out(`backup ${r.backup_id}: ${r.files} files, ${r.bytes} bytes\n  ${r.path}\n`);
      ctx.out(
        `  MLflow database: ${r.mlflow_database === "vacuum_into" ? "SQLite snapshot (VACUUM INTO)" : "none yet"}\n`,
      );
      if (r.outbox.pending || r.outbox.failed)
        ctx.out(
          `  note: ${r.outbox.pending} pending and ${r.outbox.failed} failed tracking writes are in the snapshot's outbox\n`,
        );
    }
    return 0;
  }
  if (sub === "list") {
    const r = await (await client()).request<{
      backups: { backup_id: string; reason: string; files: number; bytes: number; path: string }[];
      pending_restore: { backup_id: string } | null;
    }>("GET", "/api/v1/backups");
    if (asJson) printJson(ctx, r);
    else if (r.backups.length === 0) ctx.out("no backups (ablationkit backup create)\n");
    else
      for (const b of r.backups)
        ctx.out(`${b.backup_id}\t${b.reason}\t${b.files} files\t${b.bytes} bytes\t${b.path}\n`);
    if (!asJson && r.pending_restore)
      ctx.out(`restore of ${r.pending_restore.backup_id} pending: applied at the next start\n`);
    return 0;
  }
  if (sub === "verify") {
    const id = args.positional[0];
    if (!id) throw new UsageError(BACKUP_USAGE);
    const r = await (await client()).request<{ ok: boolean; problems: string[] }>(
      "POST",
      `/api/v1/backups/${encodeURIComponent(id)}/verify`,
      {},
    );
    if (asJson) printJson(ctx, r);
    else
      ctx.out(
        r.ok ? `${id}: every file matches\n` : `${id}: DAMAGED\n  ${r.problems.join("\n  ")}\n`,
      );
    return r.ok ? 0 : 1;
  }
  if (sub === "export") {
    const id = args.positional[0];
    const out = flag(args, "out");
    if (!id || !out) throw new UsageError(BACKUP_USAGE);
    const dest = resolve(out);
    if (existsSync(dest)) throw new UsageError(`${dest} already exists`);
    const res = await (await client()).open(
      "GET",
      `/api/v1/backups/${encodeURIComponent(id)}/archive`,
    );
    await Bun.write(`${dest}.partial`, res);
    renameSync(`${dest}.partial`, dest);
    const bytes = Bun.file(dest).size;
    if (asJson) printJson(ctx, { backup_id: id, archive: dest, bytes });
    else
      ctx.out(
        `wrote ${dest} (${bytes} bytes)\n  on the other machine: ablationkit backup restore ${dest} [--project ID=PATH]\n`,
      );
    return 0;
  }
  if (sub === "restore") {
    const source = args.positional[0];
    if (!source) throw new UsageError(BACKUP_USAGE);
    const home = ctx.home;
    const src = /^[0-9]{8}T[0-9]{6}Z(-[a-z0-9-]{1,40})?$/.test(source)
      ? join(runtimePaths(home).backupsDir, source)
      : resolve(source);
    const projectPaths = projectMappings(rest);
    const workerUrl = flag(args, "worker-url");
    let r: Awaited<ReturnType<typeof restoreBackup>>;
    try {
      r = await restoreBackup({
        source: src,
        home,
        projectPaths,
        ...(workerUrl ? { workerUrl } : {}),
        force: args.flags["force"] === true,
      });
    } catch (e) {
      if (e instanceof CoordinatorLockedError)
        throw new UsageError(
          `a coordinator (pid ${e.pid}) is running on ${home}; stop it first (ablationkit coordinator stop), or schedule the restore for its next start from the System page`,
        );
      if (e instanceof RestoreError) throw new UsageError(e.message);
      throw e;
    }
    if (asJson) printJson(ctx, r);
    else {
      const rec = r.record;
      ctx.out(
        `restored backup ${rec.backup_id} (${rec.backup_reason}, ${rec.backup_created_at}${rec.source ? ` from ${rec.source.hostname}` : ""}) into ${home}\n`,
      );
      if (r.movedAside) ctx.out(`  previous contents moved to ${r.movedAside}\n`);
      for (const p of rec.projects)
        ctx.out(
          `  ${p.project_id}: ${p.to_path} (${p.checkout}${p.files_written ? `, ${p.files_written} project files written` : ""})\n`,
        );
      ctx.out(`  ${rec.sessions_revoked} session(s) revoked: log in again (ablationkit login)\n`);
      for (const c of rec.settings_changes) ctx.out(`  settings: ${c}\n`);
      if (rec.extension_envs.length)
        ctx.out(
          `  ${rec.extension_envs.length} Python extension environment(s) are rebuilt from their lockfile on first use\n`,
        );
      for (const w of rec.warnings) ctx.out(`  note: ${w}\n`);
      ctx.out("next: ablationkit coordinator start\n");
    }
    return 0;
  }
  throw new UsageError(BACKUP_USAGE);
}
