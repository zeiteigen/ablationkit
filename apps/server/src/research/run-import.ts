/**
 * Historical-run import (ADR 0043): a run that happened outside AblationKit, before the project
 * was onboarded, becomes an MLflow run of the project from its own files: parameters from inline
 * values or JSON files, metric history from inline points or a JSON-lines file (read by the
 * metrics-file rules, ADR 0042), and artifacts from files in the checkout.
 *
 * An imported run is labelled everywhere: its mapping kind is `import`, and it carries
 * `ablationkit.kind = import`, `ablationkit.import.source` (where its files were), `.by` and `.at`,
 * and the commit the importer says it used (`ablationkit.import.source_commit`, reported, never
 * checked). It has no job, no attempt and no compute, and spends none of the compute limit. One
 * import per source: a second import of the same source is 409 `already_imported`.
 *
 * Only files inside the project's checkout are read, symlinks resolved, never its `.ablationkit/`.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { globArtifacts, type MetricsFormat, metricsFromLine } from "@ablationkit/collector";
import type { ResearchActor } from "@ablationkit/protocol";
import {
  MAX_RUN_NOTES,
  MAX_RUN_SUMMARY,
  MlflowError,
  type MlflowMetric,
  type MlflowParam,
  TrackingInputError,
  validateBatch,
} from "@ablationkit/tracking-mlflow";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";

type Json = Record<string, unknown>;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMMIT_RE = /^[a-f0-9]{7,64}$/;
export const IMPORT_LIMITS = {
  metrics: 200_000,
  /** Metric points per queued write. */
  batch: 10_000,
  metricsFileBytes: 64 * 1024 * 1024,
  paramsFiles: 8,
  paramsFileBytes: 1024 * 1024,
  artifactGlobs: 64,
  artifactFiles: 500,
  artifactFileBytes: 256 * 1024 * 1024,
  artifactTotalBytes: 1024 * 1024 * 1024,
  /** How long the route waits for MLflow to create the run before uploading artifacts. */
  createWaitMs: 60_000,
} as const;

export interface ImportResult {
  readonly ref: string;
  readonly mlflow_run_id?: string;
  readonly state: string;
  readonly params: number;
  readonly metrics: number;
  readonly metric_keys: readonly string[];
  readonly artifacts: readonly { path: string; size: number }[];
  /** Everything left out, and why: skipped keys, malformed lines, files over a cap, uploads. */
  readonly warnings: readonly string[];
}

const bad = (message: string): never => {
  throw new HttpError(400, "invalid_request", message);
};

function optString(b: Json, k: string, max: number, re?: RegExp): string | undefined {
  const v = b[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0 || v.length > max || (re && !re.test(v)))
    bad(`\`${k}\` must be a string of 1 to ${max} characters${re ? ` matching ${re}` : ""}`);
  return v as string;
}

/** RFC 3339 or epoch milliseconds. */
function time(b: Json, k: string): number | undefined {
  const v = b[k];
  if (v === undefined || v === null) return undefined;
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0)
    bad(`\`${k}\` must be an RFC 3339 time or epoch milliseconds`);
  return ms;
}

/** A path inside the checkout (symlinks resolved), never under its `.ablationkit/`. */
function inside(root: string, rel: string, what: string): string {
  if (typeof rel !== "string" || !rel || rel.startsWith("/") || rel.split("/").includes(".."))
    bad(`${what} ${rel} must be a relative path inside the checkout`);
  const abs = resolve(root, rel);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new HttpError(404, "not_found", `${what} ${rel} does not exist in the checkout`);
  }
  const top = realpathSync(root);
  if (!real.startsWith(top + sep)) bad(`${what} ${rel} leaves the checkout`);
  if (relative(top, real).split(sep)[0] === ".ablationkit")
    bad(`${what} ${rel} is AblationKit's own directory`);
  return real;
}

/** Parameters from a JSON object, nested keys joined with `/`; arrays as JSON text. */
function flattenParams(obj: Json, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}/${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flattenParams(v as Json, key));
    else out.push([key, v === null ? "null" : typeof v === "string" ? v : JSON.stringify(v)]);
  }
  return out;
}

/** Whether one param or metric passes the tracking service's checks. */
function valid(batch: Parameters<typeof validateBatch>[0]): boolean {
  try {
    validateBatch(batch);
    return true;
  } catch (e) {
    if (e instanceof TrackingInputError) return false;
    throw e;
  }
}

export async function importRun(
  svc: Services,
  projectId: string,
  body: Json,
  actor: ResearchActor,
): Promise<ImportResult> {
  const project = svc.registry.require(projectId);
  const root = project.path;
  const warnings: string[] = [];
  for (const k of Object.keys(body))
    if (
      ![
        "run_name",
        "description",
        "notes",
        "source",
        "started_at",
        "ended_at",
        "status",
        "source_commit",
        "params",
        "params_files",
        "metrics",
        "metrics_file",
        "metrics_format",
        "artifact_paths",
        "study_id",
        "variant_id",
        "task_id",
        "tags",
      ].includes(k)
    )
      bad(`unknown field \`${k}\``);

  const runName = optString(body, "run_name", 250) ?? bad("`run_name` is required");
  const source = optString(body, "source", 500) ?? bad("`source` is required");
  const summary = optString(body, "description", MAX_RUN_SUMMARY);
  const notes = optString(body, "notes", MAX_RUN_NOTES);
  const status = body["status"] ?? "FINISHED";
  if (status !== "FINISHED" && status !== "FAILED" && status !== "KILLED")
    bad("`status` must be FINISHED, FAILED or KILLED");
  const commit = optString(body, "source_commit", 64, COMMIT_RE);
  const studyId = optString(body, "study_id", 128, ID_RE);
  const variantId = optString(body, "variant_id", 128, ID_RE);
  const taskId = optString(body, "task_id", 128);
  if (taskId) svc.tasks.requireOpen(projectId, taskId);
  const started = time(body, "started_at");
  const ended = time(body, "ended_at");
  if (started && ended && ended < started) bad("`ended_at` is before `started_at`");
  const tags = body["tags"] ?? {};
  if (typeof tags !== "object" || Array.isArray(tags) || tags === null)
    bad("`tags` must be an object of strings");
  for (const [k, v] of Object.entries(tags as Json))
    if (typeof v !== "string" || k.startsWith("ablationkit.") || k.startsWith("mlflow."))
      bad(`tag ${k}: values are strings, and ablationkit.* and mlflow.* keys are reserved`);

  const existing = svc.tracking.mappings
    .forProject(projectId)
    .find((m) => m.kind === "import" && m.import_source === source);
  if (existing)
    throw new HttpError(409, "already_imported", `${source} was imported as ${existing.ref}`, {
      ref: existing.ref,
      ...(existing.mlflow_run_id ? { mlflow_run_id: existing.mlflow_run_id } : {}),
    });

  // ---- parameters: files first, inline values override
  const params = new Map<string, string>();
  const files = body["params_files"] ?? [];
  if (!Array.isArray(files) || files.length > IMPORT_LIMITS.paramsFiles)
    bad(`\`params_files\` must be a list of at most ${IMPORT_LIMITS.paramsFiles} paths`);
  for (const rel of files as string[]) {
    const abs = inside(root, rel, "params file");
    if (statSync(abs).size > IMPORT_LIMITS.paramsFileBytes)
      bad(`params file ${rel} is over ${IMPORT_LIMITS.paramsFileBytes} bytes`);
    let obj: unknown;
    try {
      obj = JSON.parse(readFileSync(abs, "utf8"));
    } catch {
      bad(`params file ${rel} is not JSON`);
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj))
      bad(`params file ${rel} is not a JSON object`);
    for (const [k, v] of flattenParams(obj as Json)) params.set(k, v);
  }
  const inline = body["params"] ?? {};
  if (typeof inline !== "object" || Array.isArray(inline) || inline === null)
    bad("`params` must be an object");
  for (const [k, v] of Object.entries(inline as Json)) {
    if (!["string", "number", "boolean"].includes(typeof v))
      bad(`param ${k}: values are strings, numbers or booleans`);
    params.set(k, String(v));
  }
  const paramList: MlflowParam[] = [];
  for (const [key, value] of params) {
    if (valid({ params: [{ key, value }] })) paramList.push({ key, value });
    else warnings.push(`param ${key} skipped: invalid key, or a value over 6000 characters`);
  }

  // ---- metrics: inline points and a JSON-lines file
  const defaultTs = started ?? svc.now().getTime();
  const metrics: MlflowMetric[] = [];
  const add = (m: MlflowMetric) => {
    if (metrics.length >= IMPORT_LIMITS.metrics)
      bad(`more than ${IMPORT_LIMITS.metrics} metric points: downsample the history first`);
    metrics.push(m);
  };
  const rawMetrics = body["metrics"] ?? [];
  if (!Array.isArray(rawMetrics)) bad("`metrics` must be a list of {key, value, step, timestamp?}");
  for (const m of rawMetrics as Json[]) {
    const point = {
      key: m?.["key"] as string,
      value: m?.["value"] as number,
      step: (m?.["step"] ?? 0) as number,
      timestamp: (m?.["timestamp"] ?? defaultTs) as number,
    };
    if (!valid({ metrics: [point] }) || !Number.isFinite(point.value))
      bad(`metric ${JSON.stringify(m)}: needs a valid key, a finite value and an integer step`);
    add(point);
  }
  const metricsFile = optString(body, "metrics_file", 1024);
  if (metricsFile) {
    const abs = inside(root, metricsFile, "metrics file");
    if (statSync(abs).size > IMPORT_LIMITS.metricsFileBytes)
      bad(`metrics file ${metricsFile} is over ${IMPORT_LIMITS.metricsFileBytes} bytes`);
    const format = body["metrics_format"] as MetricsFormat | undefined;
    if (format !== undefined && (typeof format !== "object" || Array.isArray(format)))
      bad("`metrics_format` must be {step_keys?, timestamp_key?}");
    let lineNo = 0;
    let malformed = 0;
    const skipped = new Set<string>();
    for (const line of readFileSync(abs, "utf8").split("\n")) {
      if (!line.trim()) continue;
      lineNo++;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        malformed++;
        continue;
      }
      for (const m of metricsFromLine(obj as Json, format, lineNo, defaultTs)) {
        if (valid({ metrics: [m] })) add(m);
        else skipped.add(m.key);
      }
    }
    if (malformed) warnings.push(`metrics file: ${malformed} line(s) were not JSON objects`);
    for (const k of skipped) warnings.push(`metric ${k} skipped: invalid key`);
  } else if (body["metrics_format"] !== undefined) bad("`metrics_format` needs `metrics_file`");

  // ---- artifacts: resolved now, so a bad path fails before anything is written
  const globs = body["artifact_paths"] ?? [];
  if (!Array.isArray(globs) || globs.length > IMPORT_LIMITS.artifactGlobs)
    bad(`\`artifact_paths\` must be a list of at most ${IMPORT_LIMITS.artifactGlobs} globs`);
  const artifacts: { rel: string; abs: string; size: number }[] = [];
  let total = 0;
  for (const g of globs as string[]) {
    if (typeof g !== "string" || !g || g.startsWith("/") || g.split("/").includes(".."))
      bad(`artifact path ${g} must stay inside the checkout`);
    const matches = globArtifacts(root, g);
    if (matches.length === 0) warnings.push(`artifact glob ${g}: no files match`);
    for (const rel of matches) {
      if (rel.split("/")[0] === ".ablationkit") continue;
      if (artifacts.some((a) => a.rel === rel)) continue;
      const abs = join(root, rel);
      const size = statSync(abs).size;
      const max = Math.min(IMPORT_LIMITS.artifactFileBytes, svc.jobs.maxArtifactBytes);
      if (size > max) {
        warnings.push(`artifact ${rel} skipped: ${size} bytes is over ${max}`);
        continue;
      }
      if (total + size > IMPORT_LIMITS.artifactTotalBytes) {
        warnings.push(`artifact ${rel} skipped: the import is over 1 GiB of artifacts`);
        continue;
      }
      if (artifacts.length >= IMPORT_LIMITS.artifactFiles) {
        warnings.push(`artifact ${rel} skipped: more than ${IMPORT_LIMITS.artifactFiles} files`);
        continue;
      }
      total += size;
      artifacts.push({ rel, abs, size });
    }
  }

  // ---- write: the run, its params and metrics, its end (all through the durable outbox)
  const by = actor.id ? `${actor.kind}:${actor.id}` : actor.kind;
  let ref: string;
  const opIds: string[] = [];
  try {
    const run = svc.tracking.startRun(
      compact({
        project_id: projectId,
        kind: "import" as const,
        import: compact({ source, by, commit }),
        run_name: runName,
        summary,
        notes,
        study_id: studyId,
        variant_id: variantId,
        task_id: taskId,
        start_time: started ?? ended ?? svc.now().getTime(),
        tags: tags as Record<string, string>,
      }),
    );
    ref = run.ref;
    opIds.push(...run.op_ids);
    for (let i = 0; i < Math.max(paramList.length, metrics.length); i += IMPORT_LIMITS.batch)
      opIds.push(
        ...svc.tracking.logBatch(ref, {
          params: i === 0 ? paramList : [],
          metrics: metrics.slice(i, i + IMPORT_LIMITS.batch),
        }).op_ids,
      );
    opIds.push(
      ...svc.tracking.endRun(ref, {
        status: status as "FINISHED" | "FAILED" | "KILLED",
        end_time: ended ?? started ?? svc.now().getTime(),
      }).op_ids,
    );
  } catch (e) {
    if (e instanceof TrackingInputError) bad(e.message);
    throw e;
  }
  svc.audit.record({
    actor: { kind: actor.kind, id: actor.id },
    listener: actor.kind === "agent" ? "agent" : "human",
    action: "tracking.run.import",
    outcome: "allowed",
    project_id: projectId,
    target: ref,
    details: { source, params: paramList.length, metrics: metrics.length, files: artifacts.length },
  });

  // ---- artifacts need the MLflow run
  const uploaded: { path: string; size: number }[] = [];
  if (artifacts.length) {
    const create = opIds[0] as string;
    await svc.tracking.waitFor([create], IMPORT_LIMITS.createWaitMs);
    const runId = svc.tracking.mappings.get(ref)?.mlflow_run_id;
    if (!runId)
      warnings.push(
        `artifacts not uploaded (${artifacts.length}): MLflow has not created the run yet; the run, params and metrics are queued`,
      );
    else {
      try {
        const info = (await svc.tracking.client.getRun(runId)).info;
        for (const a of artifacts) {
          try {
            await svc.tracking.client.uploadArtifact(info, a.rel, Bun.file(a.abs));
            uploaded.push({ path: a.rel, size: a.size });
          } catch (e) {
            warnings.push(`artifact ${a.rel} not uploaded: ${(e as Error).message}`);
          }
        }
      } catch (e) {
        if (!(e instanceof MlflowError)) throw e;
        warnings.push(`artifacts not uploaded: ${e.message}`);
      }
    }
  }
  await svc.tracking.waitFor(opIds, 5_000);
  const m = svc.tracking.mappings.get(ref);
  return compact({
    ref,
    mlflow_run_id: m?.mlflow_run_id,
    state: svc.tracking.sync(ref).state,
    params: paramList.length,
    metrics: metrics.length,
    metric_keys: [...new Set(metrics.map((x) => x.key))].sort(),
    artifacts: uploaded,
    warnings,
  }) as ImportResult;
}
