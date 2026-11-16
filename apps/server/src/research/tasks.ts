/**
 * Research tasks (spec §2.3, §7.9; ADR 0039).
 *
 * A task is a record an agent creates to group its work: a goal, optional criteria and, when the
 * agent completes it, an outcome with a report. Jobs carry its `task_id` and research records link
 * it (`task:ID`); both are derived when the task is read. AblationKit does not start, drive or
 * watch the agent: the user's harness owns the session.
 *
 * Completion keeps the evidence gate (criterion 44): it needs a report record of the project, and
 * a `supported` or `not_supported` outcome needs a report that cites evidence.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type ResearchActor,
  type ResearchRecord,
  type ResearchTask,
  type TaskOutcome,
  type TaskStatus,
  validateResearchTask,
} from "@ablationkit/protocol";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";

export interface CreateTaskInput {
  readonly title?: string;
  readonly goal: string;
  readonly criteria?: readonly string[];
  /** The agenda item the task serves (ADR 0058); checked against the agenda. */
  readonly agenda_item?: string;
}

/** What was recorded under a task: its jobs (with their MLflow runs) and research records. */
export interface TaskWork {
  readonly jobs: {
    job_id: string;
    attempt_id?: string;
    state?: string;
    mlflow_run_id?: string;
    run_name?: string;
    description?: string;
    study_id?: string;
    variant_id?: string;
  }[];
  readonly records: {
    record_id: string;
    kind: string;
    title: string;
    status?: string;
    summary?: string;
    created_at: string;
    created_by: string;
  }[];
  /** Notes of the vault written under the task or distilled from it (ADR 0049). */
  readonly notes: {
    note_id: string;
    type: string;
    title: string;
    gist: string;
    standing?: string;
  }[];
  /** Works of the library recorded under the task, with the roles notes cite them in (ADR 0052). */
  readonly works: {
    work_id: string;
    cite: string;
    title: string;
    reading: string;
    standing: string;
    roles: string[];
  }[];
  /** Historical runs imported under the task (ADR 0043). */
  readonly imported_runs: { ref: string; source?: string; mlflow_run_id?: string }[];
  /**
   * Every run the task's jobs produced (each attempt's) and its imports, and how each is accounted
   * for (ADR 0056): cited by a note, set aside with the agent's reason, or unaccounted.
   */
  readonly runs: {
    name?: string;
    mlflow_run_id?: string;
    job_id?: string;
    state?: string;
    standing: string;
    cited_by: string[];
    set_aside?: string;
  }[];
  /**
   * Where the records under the task no longer say what its runs say, or say too little for a
   * reader (ADR 0048). Advice for the agent before it hands back; nothing is refused for them.
   */
  readonly checks: { code: string; ref: string; message: string }[];
}

/** Task files only: leftovers from before ADR 0039 (`T.activity.json`, `T.conversation.json`) are not. */
const TASK_FILE = /^[^.]+\.json$/;

function newTaskId(now: Date): string {
  const d = now.toISOString().slice(0, 10).replaceAll("-", "");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let r = "";
  for (const x of randomBytes(6)) r += alphabet[x % alphabet.length];
  return `task-${d}-${r}`;
}

const listenerOf = (a: ResearchActor) => (a.kind === "agent" ? "agent" : "human");

export class TaskService {
  private readonly tasks = new Map<string, ResearchTask>();

  constructor(private readonly svc: () => Services) {}

  private dir(pid: string): string {
    return join(this.svc().paths.stateDir, pid, "tasks");
  }

  private key(pid: string, tid: string): string {
    return `${pid}/${tid}`;
  }

  load(): string[] {
    const problems: string[] = [];
    const root = this.svc().paths.stateDir;
    if (!existsSync(root)) return problems;
    for (const pid of readdirSync(root)) {
      const d = this.dir(pid);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) {
        if (!TASK_FILE.test(f)) continue;
        try {
          const t = readJson(join(d, f), validateResearchTask);
          this.tasks.set(this.key(t.project_id, t.task_id), t);
        } catch {
          problems.push(join(d, f));
        }
      }
    }
    return problems;
  }

  /** Drop a removed project's tasks from memory. */
  forgetProject(pid: string): void {
    for (const k of [...this.tasks.keys()]) if (k.startsWith(`${pid}/`)) this.tasks.delete(k);
  }

  private save(t: ResearchTask): ResearchTask {
    const f = join(this.dir(t.project_id), `${t.task_id}.json`);
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    writeJsonAtomic(f, t, { validate: validateResearchTask });
    this.tasks.set(this.key(t.project_id, t.task_id), t);
    return t;
  }

  list(pid: string, q: { status?: string } = {}): ResearchTask[] {
    return [...this.tasks.values()]
      .filter((t) => t.project_id === pid && (!q.status || t.status === q.status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(pid: string, tid: string): ResearchTask | undefined {
    return this.tasks.get(this.key(pid, tid));
  }

  require(pid: string, tid: string): ResearchTask {
    const t = this.get(pid, tid);
    if (!t) throw new HttpError(404, "task_not_found", `no task ${tid} in project ${pid}`);
    return t;
  }

  /** A task new work may be recorded under: it exists in the project and is open. */
  requireOpen(pid: string, tid: string): ResearchTask {
    const t = this.require(pid, tid);
    if (t.status !== "open")
      throw new HttpError(409, "task_closed", `task ${tid} is ${t.status}; create a new task`);
    return t;
  }

  private audit(
    actor: ResearchActor,
    action: string,
    pid: string,
    tid: string,
    outcome: "allowed" | "denied",
    details?: Record<string, unknown>,
    reason?: string,
  ): void {
    this.svc().audit.record({
      actor: { kind: actor.kind, ...(actor.id ? { id: actor.id } : {}) },
      listener: listenerOf(actor),
      action,
      outcome,
      project_id: pid,
      target: tid,
      ...(reason ? { reason } : {}),
      ...(details ? { details: compact(details) } : {}),
    });
  }

  create(pid: string, input: CreateTaskInput, actor: ResearchActor): ResearchTask {
    const svc = this.svc();
    svc.registry.require(pid);
    const goal = input.goal.trim();
    if (!goal) throw new HttpError(400, "invalid_request", "`goal` is required");
    if (goal.length > 20000)
      throw new HttpError(400, "invalid_request", "`goal` is longer than 20000 characters");
    const criteria = (input.criteria ?? []).map((c) => c.trim()).filter(Boolean);
    if (criteria.length > 50 || criteria.some((c) => c.length > 2000))
      throw new HttpError(400, "invalid_request", "at most 50 criteria of 2000 characters each");
    const item = input.agenda_item ? svc.agenda.requireItem(pid, input.agenda_item) : undefined;
    const now = svc.now();
    const tid = newTaskId(now);
    const t = this.save({
      schema_version: 2,
      task_id: tid,
      project_id: pid,
      revision: 1,
      created_by: actor,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      title: (input.title?.trim() || goal.split("\n")[0] || tid).slice(0, 300),
      goal,
      criteria,
      status: "open",
      ...(item ? { agenda_item: item } : {}),
    });
    svc.events.publish(pid, "task.created", { task_id: tid, status: t.status });
    this.audit(actor, "task.created", pid, tid, "allowed");
    return t;
  }

  private close(
    t: ResearchTask,
    status: Exclude<TaskStatus, "open">,
    actor: ResearchActor,
    fields: Partial<ResearchTask>,
  ): ResearchTask {
    const svc = this.svc();
    const now = svc.now().toISOString();
    const saved = this.save({
      ...t,
      ...fields,
      status,
      revision: t.revision + 1,
      updated_at: now,
      closed_at: now,
      closed_by: actor,
    });
    svc.events.publish(t.project_id, "task.updated", {
      task_id: t.task_id,
      status,
      ...(saved.outcome ? { outcome: saved.outcome } : {}),
      revision: saved.revision,
    });
    return saved;
  }

  /**
   * Complete with an outcome and what the task established (criterion 44): a notebook of the vault
   * that compiles the notes the task wrote (ADR 0049), or a report record. `supported` or
   * `not_supported` needs measured evidence: a note beneath the notebook that cites runs, or a
   * report that cites evidence.
   */
  complete(
    pid: string,
    tid: string,
    body: { outcome: TaskOutcome; report_id?: string; notebook_id?: string; conclusion?: string },
    actor: ResearchActor,
  ): ResearchTask {
    const t = this.requireOpen(pid, tid);
    const svc = this.svc();
    const gate = (code: string, msg: string): never => {
      this.audit(actor, "task.complete", pid, tid, "denied", { code }, msg);
      throw new HttpError(409, code, msg);
    };
    if (!body.report_id && !body.notebook_id)
      throw new HttpError(
        400,
        "invalid_request",
        "`notebook_id` (a notebook of the vault) or `report_id` (a report record) is required",
      );
    const fields: { report_id?: string; notebook_id?: string } = {};
    let cited = false;
    if (body.notebook_id) {
      const nb = svc.vault.get(pid, body.notebook_id);
      if (!nb || nb.archived_at || nb.type !== "notebook")
        return gate(
          "notebook_required",
          `${body.notebook_id} is not a notebook in this project's vault`,
        );
      fields.notebook_id = nb.note_id;
      cited ||= svc.vault.citesRuns(pid, nb.note_id);
    }
    if (body.report_id) {
      const report = svc.research.get(pid, body.report_id);
      if (report?.kind !== "report")
        return gate("report_required", `${body.report_id} is not a report record in this project`);
      fields.report_id = report.record_id;
      cited ||= (report.evidence ?? []).length > 0;
    }
    // The researcher's directions on the task, its notes or its runs need an answer on the record
    // first (ADR 0057): declining with a reason is an answer, so this forces a reply, not compliance.
    const owed = svc.directions.owedByTask(pid, tid);
    if (owed.length)
      gate(
        "direction_unanswered",
        `the researcher's ${owed.length === 1 ? "direction" : "directions"} ${owed.map((d) => `${d.direction_id} (${d.kind} on ${d.target.kind}${d.target.id ? ` ${d.target.id}` : ""})`).join(", ")} ${owed.length === 1 ? "is" : "are"} not answered: answer or decline ${owed.length === 1 ? "it" : "each"} with ablationkit_do direction.respond, then complete the task`,
      );
    if (body.outcome !== "inconclusive" && !cited)
      gate(
        "evidence_required",
        fields.notebook_id
          ? `no note in notebook ${fields.notebook_id} cites a run; a ${body.outcome} outcome needs measured evidence: give the findings their \`evidence\``
          : `report ${fields.report_id} cites no evidence; a ${body.outcome} outcome needs measured evidence`,
      );
    const conclusion = body.conclusion?.trim();
    if (conclusion && conclusion.length > 20000)
      throw new HttpError(400, "invalid_request", "`conclusion` is longer than 20000 characters");
    this.audit(actor, "task.complete", pid, tid, "allowed", { outcome: body.outcome, ...fields });
    return this.close(t, "completed", actor, {
      outcome: body.outcome,
      ...fields,
      ...(conclusion ? { conclusion } : {}),
    });
  }

  abandon(pid: string, tid: string, actor: ResearchActor, reason?: string): ResearchTask {
    const t = this.requireOpen(pid, tid);
    this.audit(actor, "task.abandon", pid, tid, "allowed", reason ? { reason } : undefined);
    return this.close(t, "abandoned", actor, reason ? { reason: reason.slice(0, 2000) } : {});
  }

  /** Everything recorded under the task, each kind of ID kept apart (criterion 44). */
  work(pid: string, tid: string): TaskWork {
    this.require(pid, tid);
    const svc = this.svc();
    const jobs = svc.jobs
      .list(pid)
      .filter((j) => j.task_id === tid)
      .map((j) => {
        const a = (
          svc.jobs.jobView(j, false) as {
            latest_attempt?: {
              attempt_id?: string;
              state?: string;
              tracking?: { mlflow_run_id?: string };
            };
          }
        ).latest_attempt;
        return compact({
          job_id: j.job_id,
          attempt_id: a?.attempt_id,
          state: a?.state,
          mlflow_run_id: a?.tracking?.mlflow_run_id,
          run_name: j.run_name,
          description: j.description,
          study_id: j.study_id,
          variant_id: j.variant_id,
        }) as TaskWork["jobs"][number];
      });
    const under = svc.research
      .all(pid)
      .filter((r) => !r.archived_at && r.links.some((l) => l.kind === "task" && l.id === tid));
    const records = under.map(
      (r) =>
        compact({
          record_id: r.record_id,
          kind: r.kind,
          title: r.title,
          status: r.status,
          summary: r.summary && r.summary.length > 600 ? `${r.summary.slice(0, 600)}…` : r.summary,
          created_at: r.created_at,
          created_by: r.created_by.kind,
        }) as TaskWork["records"][number],
    );
    const imported_runs = svc.tracking.mappings
      .forProject(pid)
      .filter((m) => m.kind === "import" && m.task_id === tid)
      .map((m) =>
        compact({ ref: m.ref, source: m.import_source, mlflow_run_id: m.mlflow_run_id }),
      ) as TaskWork["imported_runs"];
    const mine = svc.vault.ofTask(pid, tid);
    const notes = mine.map(
      (n) =>
        compact({
          note_id: n.note_id,
          type: n.type,
          title: n.title,
          gist: n.gist,
          standing: n.standing,
        }) as TaskWork["notes"][number],
    );
    const ids = new Set(mine.map((n) => n.note_id));
    const works = svc.vault.listWorks(pid, { task: tid }).map((w) => ({
      work_id: w.work_id,
      cite: w.cite,
      title: w.title,
      reading: w.reading,
      standing: w.standing,
      roles: w.roles,
    }));
    const workIds = new Set(works.map((w) => w.work_id));
    const checks = this.checks(pid, under, jobs);
    // What is wrong with the notes and works written under the task, in the vault's own words.
    for (const c of svc.vault.checks(pid))
      if (c.note && ids.has(c.note))
        checks.push({
          code: c.code,
          ref: `note:${c.note}`,
          message: `note ${c.note}: ${c.message}`,
        });
      else if (c.work && workIds.has(c.work))
        checks.push({
          code: c.code,
          ref: `work:${c.work}`,
          message: `work ${c.work}: ${c.message}`,
        });
    const runs = svc.witness.accounted(
      pid,
      svc.witness.recorded(pid).filter((r) => r.task_id === tid),
    );
    // A run MLflow has not acknowledged holds no result yet, and cannot be set aside.
    const loose = runs.filter((r) => r.ended && r.id && r.standing === "unaccounted");
    if (loose.length)
      checks.push({
        code: "unaccounted_runs",
        ref: `task:${tid}`,
        message: `${loose.length} of the task's ${runs.filter((r) => r.ended && r.id).length} ended runs ${loose.length === 1 ? "is" : "are"} neither cited by a note nor set aside (${loose
          .slice(0, 6)
          .map((r) => r.name ?? r.id)
          .join(
            ", ",
          )}${loose.length > 6 ? ", …" : ""}): cite each in the note it bears on (evidence, or a live reference [[run:<run>#<metric>]]), or set it aside with the reason (ablationkit_run describe {run, set_aside})`,
      });
    // The researcher's directions on the task itself or its runs (those on its notes come above).
    for (const d of svc.directions.owedByTask(pid, tid))
      if (d.target.kind !== "note")
        checks.push({
          code: "direction_unanswered",
          ref: `direction:${d.direction_id}`,
          message: `the researcher's direction ${d.direction_id} (${d.kind}) on ${d.target.kind} ${d.target.id ?? ""} is not answered: answer or decline it with ablationkit_do direction.respond; the task cannot be completed until you do`,
        });
    // The agenda's checks on the task and its jobs (ADR 0058): advice, like the rest.
    const jobIds = new Set(jobs.map((j) => j.job_id));
    for (const c of svc.agenda.checks(pid))
      if (c.task === tid || (c.job && jobIds.has(c.job)))
        checks.push({
          code: c.code,
          ref: c.task ? `task:${c.task}` : `job:${c.job}`,
          message: c.message,
        });
    const ended = jobs.filter(
      (j) => j.mlflow_run_id && !["starting", "running"].includes(j.state ?? ""),
    );
    if (!notes.length && (ended.length || imported_runs.length))
      checks.push({
        code: "no_notes",
        ref: `task:${tid}`,
        message: `${ended.length + imported_runs.length} runs under this task and no note in the vault: write what they showed as findings (ablationkit_note add with task_id), so the researcher can read it`,
      });
    return {
      jobs,
      records,
      notes,
      works,
      imported_runs,
      runs: runs.map(
        (r) =>
          compact({
            name: r.name,
            mlflow_run_id: r.id,
            job_id: r.job_id,
            state: r.state,
            standing: r.ended ? r.standing : "running",
            cited_by: r.cited_by,
            set_aside: r.set_aside?.reason,
          }) as TaskWork["runs"][number],
      ),
      checks,
    };
  }

  private checks(
    pid: string,
    under: readonly ResearchRecord[],
    jobs: TaskWork["jobs"],
  ): TaskWork["checks"] {
    const svc = this.svc();
    const out: TaskWork["checks"] = [];
    const add = (code: string, ref: string, message: string) => out.push({ code, ref, message });
    const runs = svc.tracking.mappings.forProject(pid);
    const ACTIVE = new Set(["starting", "running"]);
    const jobsActive = jobs.some((j) => ACTIVE.has(j.state ?? ""));
    for (const r of under) {
      const ref = `${r.kind}:${r.record_id}`;
      if (r.kind !== "conversation" && !r.summary?.trim())
        add(
          "no_summary",
          ref,
          `${r.kind} ${r.record_id} has no summary: say what it is, why, what came out and what it means`,
        );
      if (r.kind === "report" && !r.body?.trim())
        add(
          "no_body",
          ref,
          `report ${r.record_id} has no interpretation (body): the evidence is there, the reading is not`,
        );
      if (r.kind === "hypothesis" && r.status === "testing" && jobs.length && !jobsActive)
        add(
          "hypothesis_open",
          ref,
          `hypothesis ${r.record_id} is still testing and no job is running: set supported, refuted or inconclusive once the runs say so`,
        );
      if (r.kind === "study") {
        const mine = runs.filter((m) => m.study_id === r.record_id);
        const declared = new Set((r.variants ?? []).map((v) => v.variant_id));
        const seen = new Set(mine.flatMap((m) => (m.variant_id ? [m.variant_id] : [])));
        const extra = [...seen].filter((v) => !declared.has(v));
        if (extra.length)
          add(
            "undeclared_variants",
            ref,
            `study ${r.record_id} has runs for variants it does not declare (${extra.join(", ")}): add them with add_variants`,
          );
        const active = svc.jobs
          .list(pid)
          .filter((j) => j.study_id === r.record_id)
          .some((j) => {
            const a = (svc.jobs.jobView(j, false) as { latest_attempt?: { state?: string } })
              .latest_attempt;
            return ACTIVE.has(a?.state ?? "");
          });
        if (mine.length && !active && (r.status === "planned" || r.status === "running")) {
          const never = [...declared].filter((v) => !seen.has(v));
          add(
            "study_status",
            ref,
            `study ${r.record_id} is ${r.status} with ${mine.length} runs and none running: set its status and update its summary${never.length ? ` (declared but never run: ${never.join(", ")})` : ""}`,
          );
        }
      }
      if (r.kind === "report" && r.generated) {
        const n = runs.filter(
          (m) => m.study_id === r.generated?.study_id && m.mlflow_run_id,
        ).length;
        if (n > r.generated.runs)
          add(
            "stale_report",
            ref,
            `report ${r.record_id} was generated from ${r.generated.runs} runs of ${r.generated.study_id}, which now has ${n}: regenerate it`,
          );
      }
    }
    const bare = jobs.filter((j) => !j.description);
    if (bare.length)
      add(
        "no_description",
        `job:${(bare[0] as TaskWork["jobs"][number]).job_id}`,
        `${bare.length} of ${jobs.length} jobs have no description (${bare
          .slice(0, 4)
          .map((j) => j.run_name ?? j.job_id)
          .join(
            ", ",
          )}${bare.length > 4 ? ", …" : ""}): describe each run with ablationkit_run describe`,
      );
    return out;
  }
}
