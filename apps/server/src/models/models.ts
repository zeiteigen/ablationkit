/**
 * Datasets, logged models and the model registry (spec §5.5 rows "Datasets and lineage", "Logged
 * models and packaging", "Model Registry"; §5.6 Datasets, Logged Models, Registry; ADR 0019).
 *
 * MLflow is canonical for all three. This service reads them through the REST client, scoped to a
 * project's experiments (its own `ak/<id>` and read-only imports), and keeps two small provenance
 * joins of its own so the lineage strip can walk model → run → attempt and version → model without
 * calling MLflow:
 *
 *   state/<p>/models/<model-id>.json      ModelLink
 *   state/<p>/registry/<name>@<v>.json    RegistryVersionLink (name URL-encoded)
 *
 * Registered models are global in MLflow; AblationKit scopes them with the
 * `ablationkit.project_id` tag and refuses to mutate one that belongs to another project.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import type { EvaluationModelRef } from "@ablationkit/protocol";
import {
  type ModelLink,
  type RegistryVersionLink,
  validateModelLink,
  validateRegistryVersionLink,
} from "@ablationkit/protocol";
import {
  type LoggedModelResult,
  MlflowError,
  type MlflowLoggedModel,
  type MlflowModelVersion,
  type MlflowRegisteredModel,
  type MlflowRun,
  type MlflowTag,
  TAGS,
} from "@ablationkit/tracking-mlflow";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";

/** How a caller names a model: a logged-model ID, or a registry name with a version or alias. */
export interface ModelSelector {
  readonly model_id?: string;
  readonly name?: string;
  readonly version?: string;
  readonly alias?: string;
}

/** What inference needs to know about a pinned, ready logged model (immutable once ready). */
export interface ModelInferenceInfo {
  readonly model_id: string;
  readonly source_run_id?: string;
  readonly mlmodel?: ReturnType<typeof parseMlmodel>;
  readonly trust: TrustNote;
}

export const REGISTRY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/;
export const ALIAS_RE = /^[A-Za-z0-9_-]{1,100}$/;
export const MODEL_ID_RE = /^m-[A-Za-z0-9]{1,64}$/;
const MAX_TEXT_FILE = 64 * 1024;
const MAX_RUNS_SCANNED = 5000;

export interface ModelServiceOptions {
  readonly svc: () => Services;
  readonly stateDir: string;
  readonly now: () => Date;
}

export interface Flavor {
  readonly name: string;
  readonly loader_module?: string;
  readonly serialization_format?: string;
  readonly framework_version?: string;
  readonly details: Record<string, string>;
}

export interface TrustNote {
  /** `restricted`: a data-only format (skops, ONNX, safetensors). `code`: loading runs code. */
  readonly level: "restricted" | "code" | "unknown";
  readonly warning: string;
}

type Json = Record<string, unknown>;

function tagMap(tags: readonly MlflowTag[] | undefined): Map<string, string> {
  return new Map((tags ?? []).map((t) => [t.key, t.value]));
}

function str(v: unknown): string | undefined {
  return typeof v === "string"
    ? v
    : typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : undefined;
}

function parseJsonString(v: unknown): unknown {
  if (typeof v !== "string") return v ?? undefined;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Parse an `MLmodel` file: flavors, signature, input example and versions. */
export function parseMlmodel(text: string): {
  flavors: Flavor[];
  signature?: { inputs?: unknown; outputs?: unknown; params?: unknown };
  input_example?: { artifact_path?: string; type?: string };
  mlflow_version?: string;
  model_size_bytes?: number;
  utc_time_created?: string;
  python_version?: string;
  /** `metadata` passed to `save_model` (the inference adapter reads `metadata.ablationkit`). */
  metadata?: Record<string, unknown>;
  problems: string[];
} {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    return { flavors: [], problems: [`MLmodel is not valid YAML: ${(e as Error).message}`] };
  }
  if (typeof doc !== "object" || doc === null)
    return { flavors: [], problems: ["MLmodel is not a mapping"] };
  const d = doc as Json;
  const flavors: Flavor[] = [];
  let python: string | undefined;
  for (const [name, raw] of Object.entries((d["flavors"] as Json | undefined) ?? {})) {
    const f = (raw ?? {}) as Json;
    const details: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) {
      const s = str(v);
      if (s !== undefined && s.length <= 500) details[k] = s;
    }
    if (name === "python_function") python = str(f["python_version"]);
    const version = Object.entries(f).find(
      ([k]) => k.endsWith("_version") && k !== "python_version",
    );
    flavors.push(
      compact({
        name,
        loader_module: str(f["loader_module"]),
        serialization_format: str(f["serialization_format"]),
        framework_version: version ? str(version[1]) : undefined,
        details,
      }) as Flavor,
    );
  }
  const sig = d["signature"] as Json | undefined;
  const ex = d["saved_input_example_info"] as Json | undefined;
  const size = d["model_size_bytes"];
  const meta = d["metadata"];
  return compact({
    metadata:
      typeof meta === "object" && meta !== null && !Array.isArray(meta)
        ? (meta as Json)
        : undefined,
    flavors,
    signature: sig
      ? compact({
          inputs: parseJsonString(sig["inputs"]),
          outputs: parseJsonString(sig["outputs"]),
          params: parseJsonString(sig["params"]),
        })
      : undefined,
    input_example: ex
      ? compact({ artifact_path: str(ex["artifact_path"]), type: str(ex["type"]) })
      : undefined,
    mlflow_version: str(d["mlflow_version"]),
    model_size_bytes: typeof size === "number" && Number.isSafeInteger(size) ? size : undefined,
    utc_time_created: str(d["utc_time_created"]),
    python_version: python,
    problems: [],
  });
}

/** Spec §5.6: unsafe model formats need a trust warning before anything loads them. */
export function trustNote(flavors: readonly Flavor[]): TrustNote {
  const names = new Set(flavors.map((f) => f.name));
  const sk = flavors.find((f) => f.name === "sklearn");
  if (sk) {
    const fmt = sk.serialization_format ?? "cloudpickle";
    if (fmt === "skops")
      return {
        level: "restricted",
        warning:
          "scikit-learn model in skops format: loading checks the object types against the trusted list (no arbitrary pickle).",
      };
    return {
      level: "code",
      warning: `scikit-learn model serialized with ${fmt}: loading it unpickles, which can run arbitrary code. Load only models you trust.`,
    };
  }
  if (names.has("onnx"))
    return { level: "restricted", warning: "ONNX graph: data only, loaded by onnxruntime." };
  if (names.has("pytorch"))
    return {
      level: "code",
      warning:
        "PyTorch model: loading uses torch.load (pickle), which can run arbitrary code. Load only models you trust.",
    };
  if (names.has("python_function"))
    return {
      level: "code",
      warning:
        "Loading runs the flavor's loader module and may unpickle custom code. Treat it as untrusted code; AblationKit loads models only in isolated workers.",
    };
  return { level: "unknown", warning: "Unknown flavor: no loader is known to be safe." };
}

function linkFile(name: string, version: string): string {
  return `${encodeURIComponent(name)}@${version}.json`;
}

export class ModelService {
  private readonly infoCache = new Map<string, ModelInferenceInfo>();
  constructor(private readonly o: ModelServiceOptions) {}

  /**
   * Pin a selector to an immutable, ready logged model: an alias resolves to its version and model
   * ID now, and callers store the result, so moving the alias later changes nothing they ran.
   */
  async pin(pid: string, sel: ModelSelector, what: string): Promise<EvaluationModelRef> {
    if (typeof sel !== "object" || sel === null)
      throw new HttpError(400, "invalid_request", `${what} must be an object`);
    const ready = async (id: string) => {
      const m = await this.requireModel(pid, id);
      if (m.info.status !== "LOGGED_MODEL_READY")
        throw new HttpError(409, "model_not_ready", `logged model ${id} is ${m.info.status}`);
    };
    if (sel.model_id !== undefined) {
      if (typeof sel.model_id !== "string" || !MODEL_ID_RE.test(sel.model_id))
        throw new HttpError(400, "invalid_request", `${what}.model_id is not a logged-model ID`);
      await ready(sel.model_id);
      return { model_id: sel.model_id };
    }
    if (typeof sel.name !== "string" || !REGISTRY_NAME_RE.test(sel.name))
      throw new HttpError(
        400,
        "invalid_request",
        `${what}: give model_id, or name with version or alias`,
      );
    if (sel.alias !== undefined && (typeof sel.alias !== "string" || !ALIAS_RE.test(sel.alias)))
      throw new HttpError(400, "invalid_request", `${what}.alias is not valid`);
    if (sel.alias === undefined && !/^[1-9][0-9]{0,9}$/.test(sel.version ?? ""))
      throw new HttpError(400, "invalid_request", `${what}: give a version or an alias`);
    const r = await this.resolve(
      pid,
      sel.name,
      compact({ version: sel.version, alias: sel.alias }),
    );
    await ready(r.model_id);
    return compact({
      model_id: r.model_id,
      registered_name: r.name,
      version: r.version,
      alias: r.alias,
    });
  }

  /** The MLmodel, source run and trust note of a ready model of this project (cached). */
  async inferenceInfo(pid: string, modelId: string): Promise<ModelInferenceInfo> {
    const m = await this.requireModel(pid, modelId);
    const hit = this.infoCache.get(modelId);
    if (hit) return hit;
    const text = await this.mlflow(() => this.textFile(m.info.artifact_uri, "MLmodel"));
    const mlmodel = text ? parseMlmodel(text) : undefined;
    const info: ModelInferenceInfo = compact({
      model_id: modelId,
      source_run_id: m.info.source_run_id || undefined,
      mlmodel,
      trust: trustNote(mlmodel?.flavors ?? []),
    });
    if (m.info.status === "LOGGED_MODEL_READY") this.infoCache.set(modelId, info);
    return info;
  }

  private get svc(): Services {
    return this.o.svc();
  }

  // ------------------------------------------------------------------ links

  private modelsDir(pid: string): string {
    return join(this.o.stateDir, pid, "models");
  }

  private registryDir(pid: string): string {
    return join(this.o.stateDir, pid, "registry");
  }

  link(pid: string, modelId: string): ModelLink | undefined {
    const f = join(this.modelsDir(pid), `${modelId}.json`);
    if (!MODEL_ID_RE.test(modelId) || !existsSync(f)) return undefined;
    try {
      return readJson(f, validateModelLink);
    } catch {
      return undefined;
    }
  }

  links(pid: string): ModelLink[] {
    const d = this.modelsDir(pid);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.link(pid, f.slice(0, -5)))
      .filter((x): x is ModelLink => x !== undefined);
  }

  versionLinks(pid: string): RegistryVersionLink[] {
    const d = this.registryDir(pid);
    if (!existsSync(d)) return [];
    const out: RegistryVersionLink[] = [];
    for (const f of readdirSync(d).filter((x) => x.endsWith(".json")))
      try {
        out.push(readJson(join(d, f), validateRegistryVersionLink));
      } catch {
        // unreadable link: lineage shows a gap, MLflow still has the version
      }
    return out;
  }

  private saveLink(l: ModelLink): void {
    mkdirSync(this.modelsDir(l.project_id), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.modelsDir(l.project_id), `${l.model_id}.json`), l, {
      validate: validateModelLink,
    });
  }

  /** The tracking service finished a `log_model` op. */
  onModelLogged(info: LoggedModelResult): void {
    const m = this.svc.tracking.mappings.get(info.ref);
    if (!this.link(info.project_id, info.model_id))
      this.saveLink(
        compact({
          schema_version: 1 as const,
          project_id: info.project_id,
          model_id: info.model_id,
          name: info.name,
          experiment_id: info.experiment_id,
          source_run_id: info.run_id,
          ref: info.ref,
          job_id: m?.job_id,
          attempt_id: m?.attempt_id,
          model_key: info.model_key,
          origin: "sdk" as const,
          created_at: this.o.now().toISOString(),
        }),
      );
    this.svc.events.publish(info.project_id, "model.logged", {
      model_id: info.model_id,
      name: info.name,
      run_id: info.run_id,
      ref: info.ref,
    });
  }

  /** Record a model first seen in MLflow (logged natively), so lineage can reach it. */
  private discovered(pid: string, m: MlflowLoggedModel): void {
    if (this.link(pid, m.info.model_id)) return;
    const mapping = m.info.source_run_id
      ? this.svc.tracking.mappings.getByRunId(m.info.source_run_id)
      : undefined;
    try {
      this.saveLink(
        compact({
          schema_version: 1 as const,
          project_id: pid,
          model_id: m.info.model_id,
          name: m.info.name.slice(0, 250) || m.info.model_id,
          experiment_id: m.info.experiment_id,
          source_run_id: m.info.source_run_id || undefined,
          ref: mapping?.ref,
          job_id: mapping?.job_id,
          attempt_id: mapping?.attempt_id,
          origin: "discovered" as const,
          created_at: this.o.now().toISOString(),
        }),
      );
    } catch {
      // a model ID or name outside our schema: still readable from MLflow, just not linked
    }
  }

  // ------------------------------------------------------------- scoping

  experimentIds(pid: string): string[] {
    this.svc.registry.require(pid);
    const l = this.svc.tracking.mappings.getLinks(pid);
    return [
      ...(l.experiment_id ? [l.experiment_id] : []),
      ...l.imports.map((i) => i.experiment_id),
    ];
  }

  private async mlflow<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof MlflowError) {
        if (e.kind !== "rejected")
          throw new HttpError(503, "tracking_unavailable", `MLflow is unavailable: ${e.message}`);
        if (e.notFound) throw new HttpError(404, "not_found", e.message);
        throw new HttpError(400, "mlflow_rejected", e.message, compact({ mlflow_code: e.code }));
      }
      throw e;
    }
  }

  /** A logged model of this project (its experiments), or 404. */
  async requireModel(pid: string, modelId: string): Promise<MlflowLoggedModel> {
    if (!MODEL_ID_RE.test(modelId)) throw new HttpError(400, "invalid_request", "bad model id");
    const m = await this.mlflow(() => this.svc.tracking.client.getLoggedModel(modelId));
    if (!this.experimentIds(pid).includes(m.info.experiment_id))
      throw new HttpError(404, "not_found", `logged model ${modelId} is not in project ${pid}`);
    return m;
  }

  // ------------------------------------------------------------- logged models

  async listModels(
    pid: string,
    q: { max_results?: number; page_token?: string; run_id?: string },
  ): Promise<{ models: Json[]; next_page_token?: string }> {
    const ids = this.experimentIds(pid);
    if (!ids.length) return { models: [] };
    const page = await this.mlflow(() =>
      this.svc.tracking.client.searchLoggedModels(
        compact({
          experiment_ids: ids,
          max_results: q.max_results ?? 100,
          page_token: q.page_token,
          filter: q.run_id ? `source_run_id = '${q.run_id.replaceAll("'", "")}'` : undefined,
          order_by: [{ field_name: "creation_timestamp", ascending: false }],
        }),
      ),
    );
    for (const m of page.items) this.discovered(pid, m);
    return compact({
      models: page.items.map((m) => this.modelSummary(pid, m)),
      next_page_token: page.next_page_token,
    });
  }

  private modelSummary(pid: string, m: MlflowLoggedModel): Json {
    const tags = tagMap(m.info.tags);
    const link = this.link(pid, m.info.model_id);
    return compact({
      model_id: m.info.model_id,
      name: m.info.name,
      status: m.info.status,
      model_type: m.info.model_type || undefined,
      experiment_id: m.info.experiment_id,
      source_run_id: m.info.source_run_id || undefined,
      created_at: m.info.creation_timestamp_ms
        ? new Date(m.info.creation_timestamp_ms).toISOString()
        : undefined,
      job_id: tags.get(TAGS.job) ?? link?.job_id,
      attempt_id: tags.get(TAGS.attempt) ?? link?.attempt_id,
      origin: link?.origin,
      read_only: this.svc.tracking.mappings.importOwner(m.info.experiment_id) !== undefined,
    });
  }

  private async textFile(uri: string, path: string): Promise<string | undefined> {
    try {
      const res = await this.svc.tracking.client.downloadProxiedArtifact(uri, path);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_TEXT_FILE) return `(${buf.byteLength} bytes; too large to show)`;
      return new TextDecoder().decode(buf);
    } catch (e) {
      if (e instanceof MlflowError && e.kind === "rejected") return undefined;
      throw e;
    }
  }

  /** One logged model: MLflow entity, MLmodel (flavors, signature), dependencies, files, links. */
  async modelDetail(pid: string, modelId: string): Promise<Json> {
    const m = await this.requireModel(pid, modelId);
    this.discovered(pid, m);
    const client = this.svc.tracking.client;
    const uri = m.info.artifact_uri;
    const files = await this.mlflow(() => client.listProxiedArtifacts(uri)).catch((e) => {
      if (e instanceof HttpError && e.status === 404) return [];
      throw e;
    });
    const mlmodelText = await this.mlflow(() => this.textFile(uri, "MLmodel"));
    const mlmodel = mlmodelText ? parseMlmodel(mlmodelText) : undefined;
    const has = (p: string) => files.some((f) => f.path === p);
    const deps = compact({
      requirements: has("requirements.txt")
        ? await this.textFile(uri, "requirements.txt")
        : undefined,
      python_env: has("python_env.yaml") ? await this.textFile(uri, "python_env.yaml") : undefined,
      conda: has("conda.yaml") ? await this.textFile(uri, "conda.yaml") : undefined,
    });
    const example =
      mlmodel?.input_example?.artifact_path && has(mlmodel.input_example.artifact_path)
        ? await this.textFile(uri, mlmodel.input_example.artifact_path)
        : undefined;
    let run: Json | undefined;
    if (m.info.source_run_id) {
      const r = await client.getRun(m.info.source_run_id).catch(() => undefined);
      const mapping = this.svc.tracking.mappings.getByRunId(m.info.source_run_id);
      run = compact({
        run_id: m.info.source_run_id,
        run_name: r?.info.run_name,
        status: r?.info.status,
        job_id: mapping?.job_id,
        attempt_id: mapping?.attempt_id,
        datasets: r ? datasetInputsOf(r) : undefined,
      });
    }
    const versions = await this.versionsOfModel(m.info.model_id, m.info.source_run_id);
    return compact({
      model: this.modelSummary(pid, m),
      tags: m.info.tags ?? [],
      params: m.data.params ?? [],
      metrics: m.data.metrics ?? [],
      mlmodel: mlmodel
        ? compact({ ...mlmodel, problems: mlmodel.problems.length ? mlmodel.problems : undefined })
        : undefined,
      unsupported: mlmodel ? undefined : "no MLmodel file: not an MLflow model directory",
      trust: mlmodel ? trustNote(mlmodel.flavors) : undefined,
      dependencies: deps,
      input_example: example,
      files,
      source_run: run,
      registry_versions: versions,
      evaluations: this.svc.evaluations
        .list(pid)
        .filter((e) => e.model.model_id === modelId || e.baseline?.model_id === modelId)
        .map((e) =>
          compact({
            evaluation_id: e.evaluation_id,
            state: e.state,
            role: e.model.model_id === modelId ? "candidate" : "baseline",
            passed: e.validation?.passed,
            mlflow_run_id: e.mlflow_run_id,
          }),
        ),
    });
  }

  /** Registry versions whose source is this logged model. */
  private async versionsOfModel(modelId: string, runId?: string): Promise<Json[]> {
    if (!runId) return [];
    const page = await this.svc.tracking.client
      .searchModelVersions({ filter: `run_id = '${runId}'`, max_results: 200 })
      .catch(() => ({ items: [] as MlflowModelVersion[] }));
    return page.items
      .filter((v) => versionModelId(v) === modelId)
      .map((v) => ({ name: v.name, version: v.version, aliases: v.aliases ?? [] }));
  }

  // ------------------------------------------------------------- datasets

  /**
   * Every dataset input of the project's runs, grouped by name and digest (a "version"), with the
   * runs that used it (role, split, source commit) and the models those runs produced or evaluated.
   */
  async datasets(
    pid: string,
  ): Promise<{ datasets: Json[]; scanned_runs: number; truncated: boolean }> {
    const ids = this.experimentIds(pid);
    if (!ids.length) return { datasets: [], scanned_runs: 0, truncated: false };
    const runs: MlflowRun[] = [];
    let token: string | undefined;
    do {
      const page = await this.mlflow(() =>
        this.svc.tracking.client.searchRuns(
          compact({ experiment_ids: ids, max_results: 1000, page_token: token }),
        ),
      );
      runs.push(...page.items);
      token = page.next_page_token;
    } while (token && runs.length < MAX_RUNS_SCANNED);
    const groups = new Map<string, Json & { uses: Json[]; models: Map<string, Json> }>();
    const evals = new Map(this.svc.evaluations.list(pid).map((e) => [e.mlflow_run_id, e]));
    for (const r of runs) {
      const tags = tagMap(r.data.tags);
      const mapping = this.svc.tracking.mappings.getByRunId(r.info.run_id);
      const evaluation = evals.get(r.info.run_id);
      const produced = (
        (r.outputs?.["model_outputs"] as { model_id: string }[] | undefined) ?? []
      ).map((o) => o.model_id);
      for (const d of datasetInputsOf(r)) {
        const key = `${d["name"]}\u0000${d["digest"]}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            name: d["name"],
            digest: d["digest"],
            source_type: d["source_type"],
            source: d["source"],
            schema: d["schema"],
            profile: d["profile"],
            uses: [],
            models: new Map(),
          };
          groups.set(key, g);
        }
        g.uses.push(
          compact({
            run_id: r.info.run_id,
            run_name: r.info.run_name,
            status: r.info.status,
            start_time: r.info.start_time ? new Date(r.info.start_time).toISOString() : undefined,
            context: d["context"],
            split: d["split"],
            version: d["version"],
            fingerprint: d["fingerprint"],
            source_commit: d["source_commit"],
            job_id: mapping?.job_id ?? tags.get(TAGS.job),
            attempt_id: mapping?.attempt_id ?? tags.get(TAGS.attempt),
            evaluation_id: evaluation?.evaluation_id ?? tags.get(TAGS.evaluation),
          }),
        );
        for (const id of produced) g.models.set(id, { model_id: id, relation: "trained" });
        if (evaluation)
          g.models.set(evaluation.model.model_id, {
            model_id: evaluation.model.model_id,
            relation: "evaluated",
            ...(evaluation.model.registered_name
              ? { registered: `${evaluation.model.registered_name}@${evaluation.model.version}` }
              : {}),
          });
      }
    }
    const datasets = [...groups.values()]
      .map(({ models, ...g }) => ({ ...g, models: [...models.values()] }))
      .sort((a, b) => String((a as Json)["name"]).localeCompare(String((b as Json)["name"])));
    return { datasets, scanned_runs: runs.length, truncated: Boolean(token) };
  }

  // ------------------------------------------------------------- registry

  private ownerOf(rm: MlflowRegisteredModel): string | undefined {
    return tagMap(rm.tags).get(TAGS.project);
  }

  /** A registered model of this project, or 404 (409 when another project owns it). */
  async requireRegistered(pid: string, name: string): Promise<MlflowRegisteredModel> {
    if (!REGISTRY_NAME_RE.test(name)) throw new HttpError(400, "invalid_request", "bad model name");
    this.svc.registry.require(pid);
    const rm = await this.mlflow(() => this.svc.tracking.client.getRegisteredModel(name));
    const owner = this.ownerOf(rm);
    if (owner !== pid)
      throw new HttpError(
        owner ? 409 : 404,
        owner ? "other_project" : "not_found",
        owner
          ? `registered model ${name} belongs to project ${owner}`
          : `registered model ${name} is not linked to an AblationKit project`,
      );
    return rm;
  }

  async registryList(pid: string): Promise<Json[]> {
    this.svc.registry.require(pid);
    const out: MlflowRegisteredModel[] = [];
    let token: string | undefined;
    do {
      const page = await this.mlflow(() =>
        this.svc.tracking.client.searchRegisteredModels(
          compact({
            filter: `tags.\`${TAGS.project}\` = '${pid}'`,
            max_results: 1000,
            page_token: token,
          }),
        ),
      );
      out.push(...page.items);
      token = page.next_page_token;
    } while (token && out.length < 10_000);
    return out.map((rm) =>
      compact({
        name: rm.name,
        description: rm.description || undefined,
        latest_version: rm.latest_versions?.at(-1)?.version,
        updated_at: rm.last_updated_timestamp
          ? new Date(rm.last_updated_timestamp).toISOString()
          : undefined,
        tags: (rm.tags ?? []).filter((t) => !t.key.startsWith("ablationkit.")),
      }),
    );
  }

  /** A registered model with every version, its aliases and each version's provenance. */
  async registryDetail(pid: string, name: string): Promise<Json> {
    const rm = await this.requireRegistered(pid, name);
    const versions: MlflowModelVersion[] = [];
    let token: string | undefined;
    do {
      const page = await this.mlflow(() =>
        this.svc.tracking.client.searchModelVersions(
          compact({
            filter: `name = '${name.replaceAll("'", "")}'`,
            max_results: 200,
            page_token: token,
          }),
        ),
      );
      versions.push(...page.items);
      token = page.next_page_token;
    } while (token && versions.length < 2000);
    versions.sort((a, b) => Number(b.version) - Number(a.version));
    const evals = this.svc.evaluations.list(pid);
    return compact({
      name: rm.name,
      description: rm.description ?? "",
      tags: (rm.tags ?? []).filter((t) => !t.key.startsWith("ablationkit.")),
      aliases: rm.aliases ?? [],
      created_at: rm.creation_timestamp ? new Date(rm.creation_timestamp).toISOString() : undefined,
      versions: versions.map((v) => {
        const modelId = versionModelId(v);
        const mapping = v.run_id ? this.svc.tracking.mappings.getByRunId(v.run_id) : undefined;
        return compact({
          version: v.version,
          description: v.description || undefined,
          source: v.source,
          model_id: modelId,
          run_id: v.run_id || undefined,
          status: v.status,
          aliases: v.aliases ?? [],
          tags: v.tags ?? [],
          created_at: v.creation_timestamp
            ? new Date(v.creation_timestamp).toISOString()
            : undefined,
          job_id: mapping?.job_id,
          attempt_id: mapping?.attempt_id,
          evaluations: evals
            .filter((e) => modelId && e.model.model_id === modelId)
            .map((e) =>
              compact({
                evaluation_id: e.evaluation_id,
                state: e.state,
                passed: e.validation?.passed,
              }),
            ),
        });
      }),
    });
  }

  async registryCreate(
    pid: string,
    input: { name: string; description?: string; tags?: MlflowTag[] },
  ): Promise<MlflowRegisteredModel> {
    this.svc.registry.require(pid);
    if (!REGISTRY_NAME_RE.test(input.name))
      throw new HttpError(
        400,
        "invalid_request",
        "name: letters, digits, '.', '_', '-' and spaces",
      );
    checkUserTags(input.tags ?? []);
    try {
      return await this.svc.tracking.client.createRegisteredModel(
        compact({
          name: input.name,
          description: input.description,
          tags: [{ key: TAGS.project, value: pid }, ...(input.tags ?? [])],
        }),
      );
    } catch (e) {
      if (e instanceof MlflowError && e.code === "RESOURCE_ALREADY_EXISTS")
        throw new HttpError(409, "already_exists", `registered model ${input.name} already exists`);
      // An ambiguous create may have landed: accept it if it is ours.
      if (e instanceof MlflowError && e.kind === "ambiguous") {
        const rm = await this.mlflow(() => this.svc.tracking.client.getRegisteredModel(input.name));
        if (this.ownerOf(rm) === pid) return rm;
      }
      return this.mlflow(() => Promise.reject(e));
    }
  }

  async registryUpdate(
    pid: string,
    name: string,
    input: { description?: string; tags?: MlflowTag[]; delete_tags?: string[] },
  ): Promise<void> {
    await this.requireRegistered(pid, name);
    checkUserTags(input.tags ?? []);
    checkUserTags((input.delete_tags ?? []).map((key) => ({ key, value: "" })));
    const c = this.svc.tracking.client;
    await this.mlflow(async () => {
      if (input.description !== undefined) await c.updateRegisteredModel(name, input.description);
      for (const t of input.tags ?? []) await c.setRegisteredModelTag(name, t.key, t.value);
      for (const k of input.delete_tags ?? []) await c.deleteRegisteredModelTag(name, k);
    });
  }

  /** Register a logged model of this project as a new version. */
  async registerVersion(
    pid: string,
    name: string,
    input: { model_id: string; description?: string; tags?: MlflowTag[] },
  ): Promise<MlflowModelVersion> {
    await this.requireRegistered(pid, name);
    const m = await this.requireModel(pid, input.model_id);
    if (m.info.status !== "LOGGED_MODEL_READY")
      throw new HttpError(
        409,
        "model_not_ready",
        `logged model ${input.model_id} is ${m.info.status}`,
      );
    checkUserTags(input.tags ?? []);
    const source = `models:/${m.info.model_id}`;
    const c = this.svc.tracking.client;
    let v: MlflowModelVersion;
    try {
      v = await c.createModelVersion(
        compact({
          name,
          source,
          model_id: m.info.model_id,
          run_id: m.info.source_run_id || undefined,
          description: input.description,
          tags: input.tags,
        }),
      );
    } catch (e) {
      // An ambiguous create may have landed: find the newest version with this source.
      if (!(e instanceof MlflowError && e.kind === "ambiguous"))
        return this.mlflow(() => Promise.reject(e));
      const page = await this.mlflow(() =>
        c.searchModelVersions({ filter: `name = '${name}'`, max_results: 200 }),
      );
      const hit = page.items
        .filter((x) => x.source === source)
        .sort((a, b) => Number(b.version) - Number(a.version))[0];
      if (!hit) throw new HttpError(503, "tracking_unavailable", e.message);
      v = hit;
    }
    const link: RegistryVersionLink = compact({
      schema_version: 1 as const,
      project_id: pid,
      name,
      version: v.version,
      model_id: m.info.model_id,
      run_id: m.info.source_run_id || undefined,
      source,
      created_at: this.o.now().toISOString(),
    });
    mkdirSync(this.registryDir(pid), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.registryDir(pid), linkFile(name, v.version)), link, {
      validate: validateRegistryVersionLink,
    });
    this.svc.events.publish(pid, "registry.version.created", {
      name,
      version: v.version,
      model_id: m.info.model_id,
    });
    return v;
  }

  async versionUpdate(
    pid: string,
    name: string,
    version: string,
    input: { description?: string; tags?: MlflowTag[]; delete_tags?: string[] },
  ): Promise<void> {
    await this.requireRegistered(pid, name);
    checkUserTags(input.tags ?? []);
    const c = this.svc.tracking.client;
    await this.mlflow(async () => {
      await c.getModelVersion(name, version);
      if (input.description !== undefined)
        await c.updateModelVersion(name, version, input.description);
      for (const t of input.tags ?? []) await c.setModelVersionTag(name, version, t.key, t.value);
      for (const k of input.delete_tags ?? []) await c.deleteModelVersionTag(name, version, k);
    });
  }

  async setAlias(pid: string, name: string, alias: string, version: string): Promise<void> {
    await this.requireRegistered(pid, name);
    if (!ALIAS_RE.test(alias) || /^v[0-9]+$/i.test(alias) || alias.toLowerCase() === "latest")
      throw new HttpError(
        400,
        "invalid_request",
        "alias: letters, digits, '_' and '-'; `latest` and `v<number>` are reserved by MLflow",
      );
    await this.mlflow(() => this.svc.tracking.client.setAlias(name, alias, version));
    this.svc.events.publish(pid, "registry.alias.set", { name, alias, version });
  }

  async deleteAlias(pid: string, name: string, alias: string): Promise<void> {
    await this.requireRegistered(pid, name);
    await this.mlflow(() => this.svc.tracking.client.deleteAlias(name, alias));
    this.svc.events.publish(pid, "registry.alias.deleted", { name, alias });
  }

  /**
   * Resolve a registered model version or alias to a pinned reference. Every consumer (evaluation,
   * later inference) stores the result, never the alias alone, so moving an alias later never
   * changes what was evaluated.
   */
  async resolve(
    pid: string,
    name: string,
    sel: { version?: string; alias?: string },
  ): Promise<{ name: string; version: string; model_id: string; alias?: string; run_id?: string }> {
    await this.requireRegistered(pid, name);
    const c = this.svc.tracking.client;
    const v = await this.mlflow(() =>
      sel.alias ? c.getVersionByAlias(name, sel.alias) : c.getModelVersion(name, sel.version ?? ""),
    );
    const modelId = versionModelId(v);
    if (!modelId)
      throw new HttpError(
        422,
        "unsupported_source",
        `version ${v.version} of ${name} has source ${v.source}, not a logged model (models:/m-…)`,
      );
    return compact({
      name,
      version: v.version,
      model_id: modelId,
      alias: sel.alias,
      run_id: v.run_id || undefined,
    });
  }
}

/** The logged model behind a registry version, when its source is `models:/<model-id>`. */
function versionModelId(v: MlflowModelVersion): string | undefined {
  if (v.model_id && MODEL_ID_RE.test(v.model_id)) return v.model_id;
  const m = /^models:\/(m-[A-Za-z0-9]{1,64})$/.exec(v.source ?? "");
  return m?.[1];
}

/** The dataset inputs of one run, flattened with AblationKit's tags. */
function datasetInputsOf(r: MlflowRun): Json[] {
  const list =
    (r.inputs?.["dataset_inputs"] as
      | { tags?: MlflowTag[]; dataset: Record<string, unknown> }[]
      | undefined) ?? [];
  return list.map((i) => {
    const t = tagMap(i.tags);
    const src = parseJsonString(i.dataset["source"]);
    return compact({
      name: str(i.dataset["name"]),
      digest: str(i.dataset["digest"]),
      source_type: str(i.dataset["source_type"]),
      source:
        typeof src === "object" && src !== null && "uri" in src
          ? str((src as Json)["uri"])
          : str(i.dataset["source"]),
      schema: parseJsonString(i.dataset["schema"]),
      profile: parseJsonString(i.dataset["profile"]),
      context: t.get("mlflow.data.context"),
      split: t.get(TAGS.datasetSplit),
      version: t.get(TAGS.datasetVersion),
      fingerprint: t.get(TAGS.datasetFingerprint),
      source_commit: t.get(TAGS.sourceCommit),
    });
  });
}

function checkUserTags(tags: readonly MlflowTag[]): void {
  for (const t of tags) {
    if (typeof t.key !== "string" || !/^[A-Za-z0-9_\-. /]{1,250}$/.test(t.key))
      throw new HttpError(400, "invalid_request", `bad tag key ${JSON.stringify(t.key)}`);
    if (t.key.startsWith("ablationkit.") || t.key.startsWith("mlflow."))
      throw new HttpError(400, "invalid_request", `tag ${t.key} is reserved`);
    if (typeof t.value !== "string" || t.value.length > 5000)
      throw new HttpError(400, "invalid_request", `tag ${t.key}: value must be a string`);
  }
}
