/**
 * The lineage strip (spec §2.2 persistent elements, §6): the provenance chain of an object,
 * hypothesis → study → variant → job → attempt → run → evaluation → logged model → registry
 * version → inference/demo, with explicit gaps. Built from research records, job records and the
 * attempt-to-run mapping only (no MLflow call), so it works while MLflow is down.
 *
 * Upstream and downstream are walked separately from the subject, so a run's strip shows the
 * chain through that run, not its siblings in the same study.
 */
import type { ObjectRef, ResearchRecord, TrackingRunMapping } from "@ablationkit/protocol";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { outgoingRefs } from "./records.ts";

export const LINEAGE_STEPS = [
  "hypothesis",
  "study",
  "variant",
  "job",
  "attempt",
  "run",
  "evaluation",
  "logged_model",
  "model_version",
  "inference",
] as const;
export type LineageStepName = (typeof LINEAGE_STEPS)[number];

/** Research records off the chain, traced through what they link to. */
const RECORD_KINDS: ReadonlySet<string> = new Set([
  "approach",
  "note",
  "report",
  "decision",
  "conversation",
]);

/** Steps whose objects are recorded by a later build stage. */
const NOT_YET: Partial<Record<LineageStepName, string>> = {};

const STEP_LABEL: Record<LineageStepName, string> = {
  hypothesis: "Hypothesis",
  study: "Study",
  variant: "Variant",
  job: "Job",
  attempt: "Attempt",
  run: "MLflow run",
  evaluation: "Evaluation",
  logged_model: "Logged model",
  model_version: "Registry version",
  inference: "Inference / demo",
};

export interface LineageItem {
  readonly ref: ObjectRef;
  readonly label: string;
  readonly status?: string;
  /** False when a link points at something that no longer exists (a dangling reference). */
  readonly exists: boolean;
}

export interface LineageStep {
  readonly step: LineageStepName;
  readonly label: string;
  /** linked: has items. missing: nothing links here yet. unavailable: not recorded until a later stage. */
  readonly status: "linked" | "missing" | "unavailable" | "subject";
  readonly items: LineageItem[];
  readonly more: number;
  readonly reason?: string;
}

export interface Lineage {
  readonly subject: ObjectRef;
  readonly steps: LineageStep[];
  /** Research records that point at the subject. */
  readonly backlinks: { ref: ObjectRef; label: string; status?: string }[];
}

const MAX_ITEMS = 25;

type Node = { kind: LineageStepName; id: string };
const key = (n: { kind: string; id: string }) => `${n.kind}:${n.id}`;

export function lineage(svc: Services, pid: string, subject: ObjectRef): Lineage {
  svc.registry.require(pid);
  const research = svc.research;
  const jobs = svc.jobs;
  const mappings = svc.tracking.mappings.forProject(pid);
  const records = research.all(pid);
  const studyRecord = (id: string) => {
    const r = research.get(pid, id);
    return r?.kind === "study" ? r : undefined;
  };

  const modelLinks = svc.models.links(pid);
  const versionLinks = svc.models.versionLinks(pid);
  const evals = svc.evaluations.list(pid);
  const evidence = svc.inference.listEvidence(pid);
  const sessions = svc.inference.sessions.list(pid);
  const versionId = (name: string, version: string) => `${name}/${version}`;
  /** Saved evidence and sessions that used a model (or a registry version). */
  const inferenceOf = (modelId?: string, version?: string): Node[] => [
    ...evidence
      .filter((e) =>
        e.models.some(
          (m) =>
            m.model_id === modelId ||
            (version &&
              m.registered_name &&
              versionId(m.registered_name, m.version ?? "") === version),
        ),
      )
      .map((e): Node => ({ kind: "inference", id: e.evidence_id })),
    ...sessions
      .filter(
        (x) =>
          x.model.model_id === modelId ||
          (version &&
            x.model.registered_name &&
            versionId(x.model.registered_name, x.model.version ?? "") === version),
      )
      .map((x): Node => ({ kind: "inference", id: x.session_id })),
  ];

  const runMap = (runId: string): TrackingRunMapping | undefined =>
    mappings.find((m) => m.mlflow_run_id === runId);
  const attemptMap = (attemptId: string) => mappings.find((m) => m.attempt_id === attemptId);

  /** One step up the chain. */
  const up = (n: Node): Node[] => {
    switch (n.kind) {
      case "run": {
        const m = runMap(n.id);
        if (!m) return [];
        if (m.attempt_id) return [{ kind: "attempt", id: m.attempt_id }];
        // A manual run: no job; go straight to its variant/study tags.
        if (m.study_id && m.variant_id)
          return [{ kind: "variant", id: `${m.study_id}/${m.variant_id}` }];
        if (m.study_id) return [{ kind: "study", id: m.study_id }];
        return [];
      }
      case "attempt": {
        const a = jobs.attempt(n.id);
        return a ? [{ kind: "job", id: a.job_id }] : [];
      }
      case "job": {
        const j = jobs.get(n.id);
        if (!j?.study_id) return [];
        if (j.variant_id) return [{ kind: "variant", id: `${j.study_id}/${j.variant_id}` }];
        return [{ kind: "study", id: j.study_id }];
      }
      case "variant":
        return [{ kind: "study", id: n.id.split("/")[0] as string }];
      case "logged_model": {
        const l = modelLinks.find((x) => x.model_id === n.id);
        return l?.source_run_id ? [{ kind: "run", id: l.source_run_id }] : [];
      }
      case "model_version": {
        const v = versionLinks.find((x) => versionId(x.name, x.version) === n.id);
        return v?.model_id ? [{ kind: "logged_model", id: v.model_id }] : [];
      }
      case "evaluation": {
        const e = evals.find((x) => x.evaluation_id === n.id);
        if (!e) return [];
        const out: Node[] = [{ kind: "logged_model", id: e.model.model_id }];
        // The registry version it was launched from (pinned at launch).
        if (e.model.registered_name && e.model.version)
          out.push({
            kind: "model_version",
            id: versionId(e.model.registered_name, e.model.version),
          });
        return out;
      }
      case "inference": {
        const refs = n.id.startsWith("ie-")
          ? (evidence.find((e) => e.evidence_id === n.id)?.models ?? [])
          : [sessions.find((x) => x.session_id === n.id)?.model].filter((m) => m !== undefined);
        return refs.flatMap((m): Node[] => [
          { kind: "logged_model", id: m.model_id },
          ...(m.registered_name && m.version
            ? [{ kind: "model_version" as const, id: versionId(m.registered_name, m.version) }]
            : []),
        ]);
      }
      case "study": {
        const ids = new Set<string>();
        for (const l of studyRecord(n.id)?.links ?? []) if (l.kind === "hypothesis") ids.add(l.id);
        for (const r of records)
          if (r.kind === "hypothesis" && r.links.some((l) => l.kind === "study" && l.id === n.id))
            ids.add(r.record_id);
        return [...ids].map((id) => ({ kind: "hypothesis", id }));
      }
      default:
        return [];
    }
  };

  /** One step down the chain. */
  const down = (n: Node): Node[] => {
    switch (n.kind) {
      case "hypothesis": {
        const ids = new Set<string>();
        const h = research.get(pid, n.id);
        for (const l of h?.links ?? []) if (l.kind === "study") ids.add(l.id);
        for (const r of records)
          if (r.kind === "study" && r.links.some((l) => l.kind === "hypothesis" && l.id === n.id))
            ids.add(r.record_id);
        return [...ids].map((id) => ({ kind: "study", id }));
      }
      case "study": {
        const ids = new Set<string>((studyRecord(n.id)?.variants ?? []).map((v) => v.variant_id));
        for (const j of jobs.list(pid))
          if (j.study_id === n.id && j.variant_id) ids.add(j.variant_id);
        for (const m of mappings) if (m.study_id === n.id && m.variant_id) ids.add(m.variant_id);
        const out: Node[] = [...ids].map((v) => ({ kind: "variant", id: `${n.id}/${v}` }));
        // Jobs and runs tagged with the study but no variant hang off the study directly.
        for (const j of jobs.list(pid))
          if (j.study_id === n.id && !j.variant_id) out.push({ kind: "job", id: j.job_id });
        return out;
      }
      case "variant": {
        const [s, v] = n.id.split("/") as [string, string];
        const out: Node[] = jobs
          .list(pid)
          .filter((j) => j.study_id === s && j.variant_id === v)
          .map((j) => ({ kind: "job", id: j.job_id }));
        for (const m of mappings)
          if (m.kind === "manual" && m.study_id === s && m.variant_id === v && m.mlflow_run_id)
            out.push({ kind: "run", id: m.mlflow_run_id });
        return out;
      }
      case "job":
        return (jobs.get(n.id)?.attempts ?? []).map((id) => ({ kind: "attempt", id }));
      case "attempt": {
        const m = attemptMap(n.id);
        return m?.mlflow_run_id ? [{ kind: "run", id: m.mlflow_run_id }] : [];
      }
      case "run":
        return modelLinks
          .filter((l) => l.source_run_id === n.id)
          .map((l) => ({ kind: "logged_model", id: l.model_id }));
      case "logged_model":
        return [
          ...evals
            .filter((e) => e.model.model_id === n.id)
            .map((e): Node => ({ kind: "evaluation", id: e.evaluation_id })),
          ...versionLinks
            .filter((v) => v.model_id === n.id)
            .map((v): Node => ({ kind: "model_version", id: versionId(v.name, v.version) })),
          ...inferenceOf(n.id),
        ];
      case "model_version":
        return inferenceOf(undefined, n.id);
      default:
        return [];
    }
  };

  const found = new Map<LineageStepName, Map<string, Node>>();
  const add = (n: Node) => {
    let m = found.get(n.kind);
    if (!m) {
      m = new Map();
      found.set(n.kind, m);
    }
    m.set(key(n), n);
  };
  const walk = (start: Node, next: (n: Node) => Node[]) => {
    const seen = new Set<string>([key(start)]);
    let frontier = [start];
    while (frontier.length) {
      const nxt: Node[] = [];
      for (const n of frontier)
        for (const m of next(n)) {
          if (seen.has(key(m))) continue;
          seen.add(key(m));
          add(m);
          nxt.push(m);
        }
      frontier = nxt.slice(0, 500);
    }
  };

  const isStep = (k: string): k is LineageStepName =>
    (LINEAGE_STEPS as readonly string[]).includes(k);
  // Seeds: the subject itself if it is on the chain; otherwise (a note, report, decision,
  // conversation or approach) everything it links to that is on the chain.
  let seeds: Node[];
  let subjectRecord: ResearchRecord | undefined;
  if (isStep(subject.kind)) seeds = [{ kind: subject.kind, id: subject.id }];
  else if (subject.kind === "inference_evidence" || subject.kind === "inference_session")
    seeds = [{ kind: "inference", id: subject.id }];
  else if (subject.kind === "task") {
    // A task is traced through the jobs it ran.
    if (!svc.tasks.get(pid, subject.id))
      throw new HttpError(404, "not_found", `no task ${subject.id} in ${pid}`);
    seeds = jobs
      .list(pid)
      .filter((j) => j.task_id === subject.id)
      .map((j): Node => ({ kind: "job", id: j.job_id }));
  } else if (!RECORD_KINDS.has(subject.kind))
    throw new HttpError(
      400,
      "invalid_request",
      `lineage traces ${[...LINEAGE_STEPS.filter((k) => k !== "inference"), "inference_evidence", "inference_session", "task", ...RECORD_KINDS].join(", ")}; not ${subject.kind}`,
    );
  else {
    subjectRecord = research.get(pid, subject.id);
    if (!subjectRecord)
      throw new HttpError(404, "not_found", `no ${subject.kind} ${subject.id} in ${pid}`);
    seeds = outgoingRefs(subjectRecord)
      .filter((r) => isStep(r.kind))
      .map((r) => ({ kind: r.kind as LineageStepName, id: r.id }));
  }
  for (const s of seeds) {
    add(s);
    walk(s, up);
    walk(s, down);
  }
  // Links from research records (or the subject) straight to later-stage objects.
  for (const r of subjectRecord ? [subjectRecord] : [])
    for (const l of r.links) {
      if (isStep(l.kind)) add({ kind: l.kind, id: l.id });
      else if (l.kind === "inference_evidence" || l.kind === "inference_session") {
        const n: Node = { kind: "inference", id: l.id };
        add(n);
        walk(n, up);
      }
    }

  const describeNode = (n: Node): LineageItem => {
    const ref = { kind: n.kind, id: n.id } as ObjectRef;
    switch (n.kind) {
      case "hypothesis":
      case "study": {
        const r = research.get(pid, n.id);
        if (n.kind === "study" && !r) {
          const tagged =
            jobs.list(pid).some((j) => j.study_id === n.id) ||
            mappings.some((m) => m.study_id === n.id);
          return { ref, label: n.id, exists: tagged, status: tagged ? "from run tags" : "missing" };
        }
        return r
          ? { ref, label: r.title, exists: true, ...(r.status ? { status: r.status } : {}) }
          : { ref, label: n.id, exists: false, status: "missing" };
      }
      case "variant": {
        const [s, v] = n.id.split("/") as [string, string];
        const title = studyRecord(s)?.variants?.find((x) => x.variant_id === v)?.title;
        const base = studyRecord(s)?.baseline_variant === v;
        return {
          ref,
          label: title ? `${v} · ${title}` : v,
          exists: true,
          ...(base ? { status: "baseline" } : {}),
        };
      }
      case "job": {
        const j = jobs.get(n.id);
        return j
          ? {
              ref,
              label: j.run_name ?? j.command.join(" ").slice(0, 80),
              exists: true,
              status: j.state,
            }
          : { ref, label: n.id, exists: false, status: "missing" };
      }
      case "attempt": {
        const a = jobs.attempt(n.id);
        return a
          ? { ref, label: `attempt ${a.number}`, exists: true, status: a.state }
          : { ref, label: n.id, exists: false, status: "missing" };
      }
      case "run": {
        const m = runMap(n.id);
        return {
          ref,
          label: m?.run_name ?? n.id,
          exists: true,
          ...(m ? { status: m.sync_state } : {}),
        };
      }
      case "logged_model": {
        const l = modelLinks.find((x) => x.model_id === n.id);
        return l
          ? { ref, label: `${l.name} · ${n.id.slice(0, 10)}`, exists: true }
          : { ref, label: n.id, exists: true, status: "not linked" };
      }
      case "model_version": {
        const v = versionLinks.find((x) => versionId(x.name, x.version) === n.id);
        const [name, version] = [n.id.slice(0, n.id.lastIndexOf("/")), n.id.split("/").at(-1)];
        return { ref, label: `${name} v${version}`, exists: v !== undefined };
      }
      case "evaluation": {
        const e = evals.find((x) => x.evaluation_id === n.id);
        if (!e) return { ref, label: n.id, exists: false, status: "missing" };
        const verdict = e.validation
          ? e.validation.passed
            ? "thresholds passed"
            : "thresholds failed"
          : e.state;
        return {
          ref,
          label: `${e.model_type} on ${e.dataset.name}`,
          exists: true,
          status: verdict,
        };
      }
      case "inference": {
        if (n.id.startsWith("ie-")) {
          const e = evidence.find((x) => x.evidence_id === n.id);
          return e
            ? {
                ref: { kind: "inference_evidence", id: n.id },
                label: e.title,
                exists: true,
                status: `saved ${e.kind}`,
              }
            : {
                ref: { kind: "inference_evidence", id: n.id },
                label: n.id,
                exists: false,
                status: "missing",
              };
        }
        const x = sessions.find((s) => s.session_id === n.id);
        return x
          ? {
              ref: { kind: "inference_session", id: n.id },
              label: `session · ${x.task}`,
              exists: true,
              status: x.state,
            }
          : {
              ref: { kind: "inference_session", id: n.id },
              label: n.id,
              exists: false,
              status: "missing",
            };
      }
      default:
        return { ref, label: n.id, exists: true };
    }
  };

  const subjectStep = isStep(subject.kind)
    ? subject.kind
    : subject.kind === "inference_evidence" || subject.kind === "inference_session"
      ? "inference"
      : undefined;
  const steps: LineageStep[] = LINEAGE_STEPS.map((step) => {
    const nodes = [...(found.get(step)?.values() ?? [])];
    const items = nodes.slice(0, MAX_ITEMS).map(describeNode);
    const more = Math.max(0, nodes.length - MAX_ITEMS);
    if (step === subjectStep)
      return { step, label: STEP_LABEL[step], status: "subject", items, more };
    if (items.length) return { step, label: STEP_LABEL[step], status: "linked", items, more };
    const notYet = NOT_YET[step];
    if (notYet)
      return { step, label: STEP_LABEL[step], status: "unavailable", items, more, reason: notYet };
    return {
      step,
      label: STEP_LABEL[step],
      status: "missing",
      items,
      more,
      reason: gapReason(step, found),
    };
  });

  const backlinkRefs: ObjectRef[] = [subject];
  if (subject.kind === "run") {
    const m = runMap(subject.id);
    if (m?.attempt_id) backlinkRefs.push({ kind: "attempt", id: m.attempt_id });
  }
  const seen = new Set<string>();
  const backlinks = backlinkRefs
    .flatMap((r) => research.backlinks(pid, r))
    .filter((r) => {
      if (seen.has(r.record_id)) return false;
      seen.add(r.record_id);
      return true;
    })
    .map((r) => ({
      ref: { kind: r.kind, id: r.record_id } as ObjectRef,
      label: r.title,
      ...(r.status ? { status: r.status } : {}),
    }));
  return { subject, steps, backlinks };
}

function gapReason(step: LineageStepName, found: Map<LineageStepName, Map<string, Node>>): string {
  const has = (s: LineageStepName) => (found.get(s)?.size ?? 0) > 0;
  switch (step) {
    case "hypothesis":
      return has("study") ? "no hypothesis links this study" : "no hypothesis is linked";
    case "study":
      return has("hypothesis")
        ? "no study is linked to the hypothesis yet"
        : "not part of a study (no study_id)";
    case "variant":
      return has("study") ? "no variant recorded" : "no variant_id";
    case "job":
      return has("run") ? "a manual run: no job" : "no job submitted yet";
    case "attempt":
      return has("job") ? "no attempt has started" : "no attempt";
    case "run":
      return has("attempt") ? "no MLflow run mapped yet" : "no MLflow run";
    case "evaluation":
      return has("logged_model")
        ? "the model has not been evaluated"
        : "no logged model to evaluate";
    case "logged_model":
      return has("run") ? "the run logged no model" : "no logged model";
    case "model_version":
      return has("logged_model") ? "not registered" : "no registry version";
    case "inference":
      return has("logged_model")
        ? "no saved inference evidence or session for this model (unsaved exploration is not kept)"
        : "no model to run";
    default:
      return "not linked";
  }
}
