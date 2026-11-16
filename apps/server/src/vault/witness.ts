/**
 * The witness (ADR 0056): the agent's account held against the coordinator's record.
 *
 * The coordinator knows some things independently of the agent: which jobs an agent session
 * submitted, their attempts and how each ended (a time limit hit is `timed_out`), the MLflow run
 * each attempt wrote, the weighted hours they used, and when the session began and ended. It knows
 * other things only because the agent said so: a run's description, why a run was set aside, a
 * note's prose. The file drawer (every run a task's jobs produced is cited by a note or set aside)
 * and the session's account compare the second with the first. Every check here is advice: nothing
 * is refused for it.
 */
import { computeUsage, roundHours } from "@ablationkit/autonomy-policy";
import type { ResearchActor } from "@ablationkit/protocol";
import {
  accountFor,
  citations,
  type RecordedRun,
  type RunAccount,
  type RunStanding,
} from "@ablationkit/vault";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";

const LIVE = new Set(["starting", "running"]);

/** One run the coordinator recorded for a job's attempt (or an import under a task). */
export interface JobRun extends RecordedRun {
  readonly job_id?: string;
  readonly attempt_id?: string;
  readonly task_id?: string;
  readonly study_id?: string;
  readonly variant_id?: string;
  /** The attempt's state: how it ended, in the coordinator's record. */
  readonly state?: string;
  readonly submitted_by?: ResearchActor;
  readonly imported?: boolean;
}

/** A run with how it is accounted for, as the reader sees it. */
export type AccountedRun = Omit<JobRun, "submitted_by"> & RunAccount & { agent?: string };

export interface SessionAccount {
  readonly token_id: string;
  readonly project_id: string;
  readonly label?: string;
  readonly harness?: string;
  readonly started_at: string;
  readonly ended_at?: string;
  readonly live: boolean;
  /** From its start to its end (or to now while it lives). */
  readonly duration_sec: number;
  /** What the coordinator recorded independently of the agent. */
  readonly record: {
    readonly jobs: number;
    readonly attempts: number;
    /** Attempts by how they ended (latest attempt of each job). */
    readonly outcomes: Readonly<Record<string, number>>;
    /** Jobs an attempt of which reached its time limit. */
    readonly hit_time_limit: { job_id: string; run_name?: string }[];
    readonly weighted_hours: number;
    readonly tasks: { task_id: string; title: string; status: string }[];
  };
  /** What the agent wrote, measured against the record. */
  readonly account: {
    readonly runs: Readonly<Record<RunStanding, number>>;
    readonly unaccounted: string[];
    readonly set_aside: { run: string; reason: string }[];
    readonly notes_added: string[];
    readonly notes_revised: string[];
    readonly standings: { note_id: string; title?: string; from?: string; to?: string }[];
    readonly edition?: string;
  };
  /** Checks on what it wrote, as they stand now (not frozen when it ended). */
  readonly checks: { code: string; ref: string; message: string }[];
}

export class WitnessService {
  constructor(private readonly svc: () => Services) {}

  /** Every run a job of the project produced, and every run imported under a task. */
  recorded(pid: string): JobRun[] {
    const svc = this.svc();
    const mappings = svc.tracking.mappings.forProject(pid);
    const byAttempt = new Map(mappings.filter((m) => m.attempt_id).map((m) => [m.attempt_id, m]));
    const out: JobRun[] = [];
    for (const j of svc.jobs.list(pid))
      for (const aid of j.attempts) {
        const a = svc.jobs.attempt(aid);
        const m = byAttempt.get(aid);
        out.push(
          compact({
            name: m?.run_name ?? j.run_name,
            id: m?.mlflow_run_id,
            ended: !LIVE.has(a?.state ?? "starting"),
            job_id: j.job_id,
            attempt_id: aid,
            task_id: j.task_id,
            study_id: j.study_id,
            variant_id: j.variant_id,
            state: a?.state,
            submitted_by: j.submitted_by,
          }) as JobRun,
        );
      }
    for (const m of mappings)
      if (m.kind === "import" && m.task_id)
        out.push(
          compact({
            name: m.run_name,
            id: m.mlflow_run_id,
            ended: true,
            task_id: m.task_id,
            study_id: m.study_id,
            imported: true,
          }) as JobRun,
        );
    return out;
  }

  /** The runs of each task, for the vault's `unaccounted_runs` check. */
  taskRuns(pid: string): { task_id: string; title: string; runs: JobRun[] }[] {
    const by = new Map<string, JobRun[]>();
    for (const r of this.recorded(pid))
      if (r.task_id) by.set(r.task_id, [...(by.get(r.task_id) ?? []), r]);
    return this.svc()
      .tasks.list(pid)
      .filter((t) => by.has(t.task_id))
      .map((t) => ({ task_id: t.task_id, title: t.title, runs: by.get(t.task_id) ?? [] }));
  }

  /** Every recorded run with how it is accounted for. */
  accounted(pid: string, runs: readonly JobRun[] = this.recorded(pid)): AccountedRun[] {
    const svc = this.svc();
    const cited = citations(svc.vault.all(pid));
    const aside = (id: string) => svc.vault.setAsideMark(pid, id);
    return runs.map(({ submitted_by, ...r }) =>
      compact({
        ...r,
        ...accountFor(r, cited, aside),
        agent: submitted_by?.kind === "agent" ? submitted_by.id : undefined,
      }),
    ) as AccountedRun[];
  }

  /** One agent session's account: what it did, in the coordinator's record and in its own words. */
  async account(tokenId: string): Promise<SessionAccount> {
    const svc = this.svc();
    const t = svc.tokens.get(tokenId);
    if (t?.kind !== "agent")
      throw new HttpError(404, "agent_session_not_found", "no such agent session");
    const pid = t.scope.project_id as string;
    const view = svc.agentSessions.list(pid).find((s) => s.token_id === tokenId);
    const now = svc.now();
    const end = view?.ended_at ? Date.parse(view.ended_at) : now.getTime();
    const mine = (a: ResearchActor | undefined) => a?.kind === "agent" && a.id === tokenId;

    const jobs = svc.jobs.list(pid).filter((j) => mine(j.submitted_by));
    const outcomes: Record<string, number> = {};
    const hit: { job_id: string; run_name?: string }[] = [];
    let attempts = 0;
    for (const j of jobs) {
      const as = j.attempts.flatMap((id) => svc.jobs.attempt(id) ?? []);
      attempts += as.length;
      const last = as.at(-1)?.state ?? "pending";
      outcomes[last] = (outcomes[last] ?? 0) + 1;
      if (as.some((a) => a.state === "timed_out"))
        hit.push(compact({ job_id: j.job_id, run_name: j.run_name }));
    }
    const usage = computeUsage(
      jobs.map((j) => ({
        weight_hundredths: j.compute_weight_hundredths,
        runtime_max_sec: j.limits.runtime_max_sec,
        attempts: j.attempts.flatMap((id) => svc.jobs.attempt(id) ?? []),
      })),
      now.getTime(),
    );
    const jobIds = new Set(jobs.map((j) => j.job_id));
    const runs = this.accounted(
      pid,
      this.recorded(pid).filter((r) => r.job_id && jobIds.has(r.job_id) && r.ended),
    );
    const counts: Record<RunStanding, number> = { cited: 0, set_aside: 0, unaccounted: 0 };
    for (const r of runs) counts[r.standing]++;

    // Notes: what it added and revised, and every change of standing, from the audit journal.
    const added = new Set<string>();
    const revised = new Set<string>();
    const standings = new Map<string, { from?: string; to?: string }>();
    for await (const rec of this.audit()) {
      if (rec.project_id !== pid || rec.actor.kind !== "agent" || rec.actor.id !== tokenId)
        continue;
      const id = rec.target;
      if (!id) continue;
      if (rec.action === "vault.note.created") added.add(id);
      else if (rec.action === "vault.note.updated") {
        if (!added.has(id)) revised.add(id);
        const d = rec.details as { standing_from?: string; standing_to?: string } | undefined;
        if (d && (d.standing_from !== undefined || d.standing_to !== undefined)) {
          const prev = standings.get(id);
          standings.set(
            id,
            compact({ from: prev ? prev.from : d.standing_from, to: d.standing_to }),
          );
        }
      }
    }
    const notes = svc.vault.all(pid);
    const title = (id: string) => notes.find((n) => n.note_id === id)?.title;
    const edition = notes
      .filter((n) => n.edition && mine(n.created_by) && !n.archived_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.note_id;

    const tasks = svc.tasks.list(pid).filter((x) => mine(x.created_by));
    const written = new Set([...added, ...revised]);
    const checks: SessionAccount["checks"] = [];
    for (const c of svc.vault.checks(pid))
      if (c.note && written.has(c.note))
        checks.push({
          code: c.code,
          ref: `note:${c.note}`,
          message: `note ${c.note}: ${c.message}`,
        });
    for (const task of tasks)
      for (const c of svc.tasks.work(pid, task.task_id).checks)
        if (!c.ref.startsWith("note:")) checks.push(c);

    return compact({
      token_id: tokenId,
      project_id: pid,
      label: view?.label,
      harness: view?.harness,
      started_at: t.created_at,
      ended_at: view?.ended_at,
      live: view?.live ?? false,
      duration_sec: Math.max(0, Math.round((end - Date.parse(t.created_at)) / 1000)),
      record: {
        jobs: jobs.length,
        attempts,
        outcomes,
        hit_time_limit: hit,
        weighted_hours: roundHours(usage.used_hours),
        tasks: tasks.map((x) => ({ task_id: x.task_id, title: x.title, status: x.status })),
      },
      account: compact({
        runs: counts,
        unaccounted: runs
          .filter((r) => r.standing === "unaccounted")
          .map((r) => r.name ?? r.id ?? ""),
        set_aside: runs.flatMap((r) =>
          r.standing === "set_aside" && r.set_aside
            ? [{ run: r.name ?? r.id ?? "", reason: r.set_aside.reason }]
            : [],
        ),
        notes_added: [...added].filter((id) => notes.some((n) => n.note_id === id)),
        notes_revised: [...revised].filter((id) => notes.some((n) => n.note_id === id)),
        standings: [...standings]
          .filter(([, s]) => s.from !== s.to)
          .map(([note_id, s]) => compact({ note_id, title: title(note_id), ...s })),
        edition,
      }),
      checks,
    }) as SessionAccount;
  }

  /** The audit journal, oldest first. */
  private async *audit() {
    const log = this.svc().audit;
    let after = -1;
    for (;;) {
      const page = await log.read(after, 2000);
      if (!page.length) return;
      yield* page;
      after = page.at(-1)?.seq ?? after;
      if (page.length < 2000) return;
    }
  }
}
