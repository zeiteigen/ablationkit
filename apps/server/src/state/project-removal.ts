/**
 * Removing a project (Project settings → Remove project; ADR 0034). AblationKit forgets the
 * project and leaves its code alone. Two things move aside to
 * `<home>/removed-projects/<id>-<time>/`, where a person can still recover them by hand:
 *
 * - the checkout's `.ablationkit/` (manifest, research export, project extensions, LLM files);
 * - the project's coordinator state, `<home>/state/<id>/` (jobs, tasks, policy, records,
 *   evidence).
 *
 * MLflow runs stay in experiment `ak/<id>`, and backups and the audit log are untouched.
 * Removal is refused while anything of the project is still running, so no live process
 * writes into a moved directory.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import { type ProjectRegistration, validateProjectManifest } from "@ablationkit/protocol";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { MANIFEST_RELATIVE } from "./registry.ts";

export interface RemovalMove {
  /** What the directory is, for people. */
  readonly what: string;
  readonly from: string;
  /** Where it goes, relative to the removal directory. */
  readonly to: string;
}

export interface RemovalPlan {
  readonly project: ProjectRegistration;
  /** Running work that must finish or be stopped first; removal is refused while any remain. */
  readonly blockers: readonly string[];
  /** Directories that exist and will be moved aside. */
  readonly moves: readonly RemovalMove[];
  /** A checkout `.ablationkit/` left in place, and why (it belongs to another project). */
  readonly skipped?: string;
  /** Where the moved directories go. */
  readonly destination_root: string;
  /** What removal leaves alone. */
  readonly kept: readonly string[];
}

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function blockers(svc: Services, pid: string): string[] {
  const out: string[] = [];
  for (const j of svc.jobs.unfinished(pid))
    out.push(`job ${j.job_id} (${svc.jobs.latestAttempt(j)?.state ?? "queued"}): cancel it`);
  for (const e of svc.evaluations.unfinished(pid))
    out.push(`evaluation ${e.evaluation_id} (${e.state}): cancel it`);
  for (const s of svc.inference.sessions.open(pid))
    out.push(`inference session ${s.session_id} (${s.state}): stop it`);
  for (const x of svc.extensions.running(pid))
    out.push(`extension run ${x.execution_id}: cancel it`);
  for (const d of svc.deployments.active(pid))
    out.push(`deployment ${d.deployment_id} (${d.status}): stop it`);
  return out;
}

/** What removing the project would do, without doing it. */
export function removalPlan(svc: Services, pid: string): RemovalPlan {
  const project = svc.registry.require(pid);
  const moves: RemovalMove[] = [];
  let skipped: string | undefined;
  const checkout = join(project.path, ".ablationkit");
  if (isDir(checkout)) {
    // Only the project's own directory: a checkout that now carries another project's manifest
    // (the path was reused) keeps it.
    let owner: string | undefined;
    try {
      owner = readJson(join(project.path, MANIFEST_RELATIVE), validateProjectManifest).project_id;
    } catch {
      owner = undefined;
    }
    if (owner !== undefined && owner !== pid)
      skipped = `${checkout} belongs to project ${owner}, so it stays`;
    else moves.push({ what: "the checkout's .ablationkit/", from: checkout, to: "checkout" });
  }
  const state = join(svc.paths.stateDir, pid);
  if (isDir(state)) moves.push({ what: "coordinator state", from: state, to: "state" });
  return {
    project,
    blockers: blockers(svc, pid),
    moves,
    ...(skipped ? { skipped } : {}),
    destination_root: join(svc.paths.home, "removed-projects"),
    kept: [
      `the code in ${project.path}`,
      `MLflow runs in experiment ak/${pid}`,
      "backups and the audit log",
    ],
  };
}

/** Rename, or copy and delete across filesystems (a checkout on another disk than the home). */
function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    rmSync(from, { recursive: true, force: true });
  }
}

export interface RemovalResult {
  readonly project: ProjectRegistration;
  readonly moved_to: string;
  readonly moved: readonly RemovalMove[];
  readonly skipped?: string;
}

/** Remove a project: refuse while it has running work, move its files aside, forget it. */
export async function removeProject(
  svc: Services,
  pid: string,
  actor: string,
): Promise<RemovalResult> {
  const plan = removalPlan(svc, pid);
  if (plan.blockers.length)
    throw new HttpError(
      409,
      "project_busy",
      `${pid} still has running work: ${plan.blockers.join("; ")}`,
      { blockers: plan.blockers },
    );
  const at = svc.now();
  const dest = join(plan.destination_root, `${pid}-${at.toISOString().replace(/[:.]/g, "-")}`);
  if (existsSync(dest)) throw new HttpError(409, "removal_conflict", `${dest} already exists`);

  // Quiesce first: no backend or delayed export may write into a directory mid-move.
  await svc.backends.stopProject(pid);
  svc.research.forgetProject(pid);
  svc.reviews.forgetProject(pid);
  svc.vault.forgetProject(pid);
  svc.directions.forgetProject(pid);
  svc.agenda.forgetProject(pid);

  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const done: RemovalMove[] = [];
  try {
    for (const m of plan.moves) {
      move(m.from, join(dest, m.to));
      done.push(m);
    }
  } catch (e) {
    // Put back what already moved, so a failed removal leaves a working project.
    for (const m of done.reverse()) {
      try {
        move(join(dest, m.to), m.from);
      } catch (back) {
        console.error(`project removal: cannot move ${m.to} back to ${m.from}: ${String(back)}`);
      }
    }
    svc.research.load();
    throw new HttpError(
      500,
      "removal_failed",
      `could not move ${plan.moves[done.length]?.from ?? "a directory"} aside: ${(e as Error).message}; nothing was removed`,
    );
  }

  svc.registry.remove(pid);
  svc.jobs.forgetProject(pid);
  svc.tasks.forgetProject(pid);
  svc.evaluations.forgetProject(pid);
  svc.deployments.forgetProject(pid);
  svc.inference.forgetProject(pid);
  svc.extensions.forgetProject(pid);
  svc.policy.forgetProject(pid);
  svc.compute.forgetProject(pid);

  writeJsonAtomic(
    join(dest, "removal.json"),
    {
      schema_version: 1,
      removed_at: at.toISOString(),
      removed_by: actor,
      project: plan.project,
      moved: done,
      ...(plan.skipped ? { skipped: plan.skipped } : {}),
      kept: plan.kept,
    },
    { backup: false },
  );
  return {
    project: plan.project,
    moved_to: dest,
    moved: done,
    ...(plan.skipped ? { skipped: plan.skipped } : {}),
  };
}
