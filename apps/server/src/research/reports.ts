/**
 * Evidence-linked report generation (spec §6: "Notes and reports cite exact execution attempts,
 * MLflow run IDs, metric histories … and source revisions. Separate evidence from agent
 * interpretation"). The coordinator writes the evidence (one item per run, with its attempt, job,
 * source commit, metric values and artifacts) and a generated summary table. The interpretation
 * (`body`) and follow-up are left to the researcher or agent and are never generated.
 */
import type { EvidenceItem, ResearchActor, ResearchRecord } from "@ablationkit/protocol";
import { TAGS } from "@ablationkit/tracking-mlflow";
import { HttpError } from "../http.ts";
import { projectRuns } from "../listeners/shell.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";
import { type MetricStats, NO_VARIANT, studyView } from "./studies.ts";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_KEYS = 20;

export interface GenerateInput {
  readonly study_id: string;
  readonly title?: string | undefined;
  readonly metric_keys?: readonly string[] | undefined;
  readonly baseline_variant?: string | undefined;
  readonly hypothesis_ids?: readonly string[] | undefined;
}

/** Shortest exact decimal of a double (what JSON would print). */
const exact = (v: number) => String(v);
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toPrecision(5));
const fmtStats = (s: MetricStats | undefined) =>
  s ? `${fmt(s.mean)}${s.std !== undefined ? ` ± ${fmt(s.std)}` : ""}` : "—";

async function evidenceFor(
  svc: Services,
  pid: string,
  input: GenerateInput,
): Promise<{
  evidence: EvidenceItem[];
  summary: string;
  keys: string[];
  baseline: string | undefined;
  runs: number;
  study: ResearchRecord | undefined;
}> {
  if (!ID_RE.test(input.study_id)) throw new HttpError(400, "invalid_request", "bad study_id");
  const rec = svc.research.get(pid, input.study_id);
  const study = rec?.kind === "study" ? rec : undefined;
  const { runs, truncated } = await projectRuns(
    svc,
    pid,
    `tags.\`${TAGS.study}\` = '${input.study_id}'`,
  );
  if (runs.length === 0)
    throw new HttpError(
      422,
      "no_evidence",
      `study ${input.study_id} has no MLflow runs to cite yet`,
    );
  const view = studyView(input.study_id, runs);
  const variantIds = view.variants.map((v) => v.variant_id);
  const baseline =
    input.baseline_variant ?? study?.baseline_variant ?? variantIds.find((v) => v !== NO_VARIANT);
  if (input.baseline_variant && !variantIds.includes(input.baseline_variant))
    throw new HttpError(400, "invalid_request", `no runs in variant ${input.baseline_variant}`);
  const goals = new Map((study?.metric_goals ?? []).map((g) => [g.key, g.goal]));
  const keys = (
    input.metric_keys?.length
      ? [...input.metric_keys]
      : goals.size
        ? [...goals.keys()]
        : view.metric_keys.filter((k) => !k.startsWith("system/"))
  ).slice(0, MAX_KEYS);
  const now = svc.now().toISOString();
  const evidence: EvidenceItem[] = [];
  let importedRuns = 0;
  for (const r of runs) {
    const tag = (k: string) => r.data.tags?.find((t) => t.key === k)?.value;
    const variant = tag(TAGS.variant);
    const attemptId = tag(TAGS.attempt);
    const attempt = attemptId ? svc.jobs.attempt(attemptId) : undefined;
    const values: Record<string, string> = {};
    for (const m of r.data.metrics ?? []) if (keys.includes(m.key)) values[m.key] = exact(m.value);
    // An imported run (ADR 0043) happened outside AblationKit: say so on its evidence.
    const imported = tag(TAGS.kind) === "import";
    const importNote = imported
      ? `imported from ${tag(TAGS.importSource) ?? "files"}, not run under AblationKit${tag(TAGS.importCommit) ? ` (reported commit ${tag(TAGS.importCommit)?.slice(0, 12)})` : ""}`
      : undefined;
    if (imported) importedRuns++;
    evidence.push(
      compact({
        ref: compact({ kind: "run" as const, id: r.info.run_id, label: r.info.run_name }),
        role: variant && variant === baseline ? ("baseline" as const) : ("candidate" as const),
        mlflow_run_id: r.info.run_id,
        attempt_id: attemptId,
        job_id: tag(TAGS.job),
        variant_id: variant,
        source_commit: attempt?.snapshot?.source_commit,
        source_dirty: attempt?.snapshot?.source_dirty,
        values,
        artifacts: attempt?.artifacts.slice(0, 50).map((a) => a.path),
        note:
          [importNote, r.info.status === "FINISHED" ? undefined : `run status ${r.info.status}`]
            .filter(Boolean)
            .join("; ") || undefined,
        captured_at: now,
      }) as EvidenceItem,
    );
  }
  // Summary: one row per variant, mean ± sample std over its runs, delta vs the baseline.
  const base = view.variants.find((v) => v.variant_id === baseline);
  const lines = [
    `Generated from ${runs.length} run(s) of study \`${input.study_id}\`${baseline ? `; baseline variant \`${baseline}\`` : ""}${truncated ? " (scan truncated)" : ""}. Values are the latest logged value per run; mean ± sample standard deviation over runs.${importedRuns ? ` ${importedRuns} of the runs were imported from files written before the project used AblationKit (not run under it); their evidence says so.` : ""}`,
    "",
    `| Variant | n | ${keys.map((k) => `${k}${goals.get(k) ? ` (${goals.get(k) === "min" ? "↓" : "↑"})` : ""}`).join(" | ")} |`,
    `| --- | --- |${keys.map(() => " --- |").join("")}`,
  ];
  for (const v of view.variants) {
    const cells = keys.map((k) => {
      const s = v.metrics[k];
      let cell = fmtStats(s);
      const b = base?.metrics[k];
      if (s && b && v !== base) {
        const d = s.mean - b.mean;
        const goal = goals.get(k);
        const verdict = goal && d !== 0 ? ((goal === "min") === d < 0 ? " better" : " worse") : "";
        cell += ` (Δ ${d >= 0 ? "+" : ""}${fmt(d)}${verdict})`;
      }
      return cell;
    });
    lines.push(
      `| ${v.variant_id}${v === base ? " (baseline)" : ""} | ${v.runs.length} | ${cells.join(" | ")} |`,
    );
  }
  if (view.differing_params.length)
    lines.push(
      "",
      `Parameters that differ between variants: ${view.differing_params.map((p) => `\`${p}\``).join(", ")}.`,
    );
  lines.push(
    "",
    "Deltas are descriptive; no significance test is applied. The interpretation below is written by a researcher or agent, not generated.",
  );
  return { evidence, summary: lines.join("\n"), keys, baseline, runs: runs.length, study };
}

export async function generateReport(
  svc: Services,
  pid: string,
  input: GenerateInput,
  actor: ResearchActor,
  listener: "human" | "agent",
): Promise<ResearchRecord> {
  const e = await evidenceFor(svc, pid, input);
  const hyp = new Set<string>(input.hypothesis_ids ?? []);
  for (const l of e.study?.links ?? []) if (l.kind === "hypothesis") hyp.add(l.id);
  for (const r of svc.research.backlinks(pid, { kind: "study", id: input.study_id }))
    if (r.kind === "hypothesis") hyp.add(r.record_id);
  const links = [
    ...(e.study ? [{ kind: "study" as const, id: input.study_id }] : []),
    ...[...hyp].map((id) => ({ kind: "hypothesis" as const, id })),
  ];
  return svc.research.create(
    pid,
    "report",
    {
      title: input.title ?? `${e.study?.title ?? input.study_id}: results`,
      summary: e.summary,
      evidence: e.evidence,
      links,
      tags: ["generated"],
    },
    actor,
    {
      listener,
      generated: compact({
        study_id: input.study_id,
        baseline_variant: e.baseline,
        metric_keys: e.keys,
        runs: e.runs,
        generated_at: svc.now().toISOString(),
      }),
    },
  );
}

/** Refresh a generated report's evidence and summary; the interpretation is kept. */
export async function regenerateReport(
  svc: Services,
  pid: string,
  reportId: string,
  actor: ResearchActor,
  listener: "human" | "agent",
): Promise<ResearchRecord> {
  const r = svc.research.require(pid, reportId);
  if (r.kind !== "report" || !r.generated)
    throw new HttpError(400, "invalid_request", `${reportId} is not a generated report`);
  const e = await evidenceFor(svc, pid, {
    study_id: r.generated.study_id,
    metric_keys: r.generated.metric_keys,
    baseline_variant: r.generated.baseline_variant,
  });
  return svc.research.update(pid, reportId, { summary: e.summary, evidence: e.evidence }, actor, {
    listener,
    generated: compact({
      study_id: r.generated.study_id,
      baseline_variant: e.baseline,
      metric_keys: e.keys,
      runs: e.runs,
      generated_at: svc.now().toISOString(),
    }),
  });
}
