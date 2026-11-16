/**
 * An in-memory stand-in for the pinned MLflow tracking server, implementing the REST subset
 * AblationKit uses. test/contract.test.ts runs the same contract against this fake and (with
 * ABLATIONKIT_MLFLOW_CONTRACT=1) against the real pinned sidecar, so the fake cannot drift.
 */
type Json = Record<string, unknown>;

interface Exp {
  experiment_id: string;
  name: string;
  artifact_location: string;
  lifecycle_stage: "active" | "deleted";
  creation_time: number;
  last_update_time: number;
  tags: { key: string; value: string }[];
}

interface Run {
  info: {
    run_id: string;
    run_uuid: string;
    experiment_id: string;
    run_name: string;
    status: string;
    start_time: number;
    end_time?: number;
    artifact_uri: string;
    lifecycle_stage: "active" | "deleted";
  };
  metrics: { key: string; value: number; timestamp: number; step: number }[];
  params: Map<string, string>;
  tags: Map<string, string>;
  artifacts: Map<string, Uint8Array>;
  inputs: { tags: { key: string; value: string }[]; dataset: Json }[];
  outputs: { model_id: string; step: number }[];
}

interface LoggedModel {
  info: {
    model_id: string;
    experiment_id: string;
    name: string;
    creation_timestamp_ms: number;
    last_updated_timestamp_ms: number;
    artifact_uri: string;
    status: string;
    model_type: string;
    source_run_id?: string;
    tags: { key: string; value: string }[];
  };
  params: { key: string; value: string }[];
}

interface Version {
  name: string;
  version: string;
  creation_timestamp: number;
  last_updated_timestamp: number;
  current_stage: string;
  description: string;
  source: string;
  run_id: string;
  status: string;
  tags: Map<string, string>;
  run_link: string;
}

interface RegModel {
  name: string;
  creation_timestamp: number;
  last_updated_timestamp: number;
  description: string;
  tags: Map<string, string>;
  aliases: Map<string, string>;
  versions: Version[];
}

/** MLflow's `_guess_mime_type` (mlflow/utils/mime_type_utils.py, 3.17): text extensions first. */
const TEXT_EXTENSIONS = new Set(
  "txt log err cfg conf cnf cf ini properties prop hocon toml yaml yml xml json js py py3 csv tsv md rst ipynb MLmodel MLproject".split(
    " ",
  ),
);
const GUESSED: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  html: "text/html",
  pdf: "application/pdf",
};
function guessType(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : name;
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain";
  return GUESSED[ext.toLowerCase()] ?? "application/octet-stream";
}

class Fail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface FakeTrace {
  info: Json;
  tags: Record<string, string>;
  spans: Json[] | undefined;
  assessments: Json[];
  experiment_id: string;
}

export interface FakeMlflowOptions {
  readonly port?: number;
  readonly version?: string;
}

export class FakeMlflow {
  private server: ReturnType<typeof Bun.serve> | undefined;
  private readonly exps = new Map<string, Exp>();
  private readonly runs = new Map<string, Run>();
  private readonly models = new Map<string, LoggedModel>();
  private readonly registered = new Map<string, RegModel>();
  /** Artifacts under `<exp>/models/<id>/artifacts/…`, by proxied path. */
  private readonly modelArtifacts = new Map<string, Uint8Array>();
  /** MLflow 3 traces: info, spans (`traces.json`) and assessments. */
  private readonly traces = new Map<string, FakeTrace>();
  private readonly datasets = new Map<
    string,
    { dataset_id: string; name: string; experiment_ids: string[]; tags: string; records: Json[] }
  >();
  private nextModel = 1;
  private nextExp = 1;
  private nextRun = 1;
  /** Answer every API call with 503 while true. */
  down = false;
  /** Called before each API request; throw a `Response` or return one to inject a failure. */
  intercept: ((path: string, body: Json) => Response | undefined) | undefined;
  readonly calls: { path: string; body: Json }[] = [];
  readonly version: string;
  private port: number;

  constructor(options: FakeMlflowOptions = {}) {
    this.version = options.version ?? "3.17.2";
    this.port = options.port ?? 0;
    const t = Date.now();
    this.exps.set("0", {
      experiment_id: "0",
      name: "Default",
      artifact_location: "mlflow-artifacts:/0",
      lifecycle_stage: "active",
      creation_time: t,
      last_update_time: t,
      tags: [],
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  start(): this {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: this.port,
      fetch: (r) => this.handle(r),
    });
    this.port = this.server.port ?? 0;
    return this;
  }

  /** Stop listening (connection refused), keeping state; `start()` resumes on the same port. */
  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = undefined;
  }

  run(id: string): Run | undefined {
    return this.runs.get(id);
  }

  allRuns(): Run[] {
    return [...this.runs.values()];
  }

  /** Every stored trace (tests inspect what reached MLflow). */
  allTraces(): FakeTrace[] {
    return [...this.traces.values()];
  }

  datasetRecords(id: string): Json[] | undefined {
    return this.datasets.get(id)?.records;
  }

  loggedModel(id: string): LoggedModel | undefined {
    return this.models.get(id);
  }

  modelArtifact(modelId: string, path: string): Uint8Array | undefined {
    const m = this.models.get(modelId);
    if (!m) return undefined;
    return this.modelArtifacts.get(
      `${m.info.artifact_uri.slice("mlflow-artifacts:/".length)}/${path}`,
    );
  }

  /** The bytes behind a proxied artifact path (run or model), if any. */
  private proxied(rel: string): Uint8Array | undefined {
    const parts = rel.split("/");
    if (parts[1] === "models") return this.modelArtifacts.get(rel);
    const run = this.runs.get(parts[1] ?? "");
    return run?.artifacts.get(parts.slice(3).join("/"));
  }

  private proxiedList(rel: string): Json[] {
    const parts = rel.split("/");
    let entries: [string, Uint8Array][];
    let root: string;
    if (parts[1] === "models") {
      root = parts.slice(0, 4).join("/");
      entries = [...this.modelArtifacts]
        .filter(([k]) => k.startsWith(`${root}/`))
        .map(([k, v]) => [k.slice(root.length + 1), v]);
    } else {
      root = parts.slice(0, 3).join("/");
      entries = [...(this.runs.get(parts[1] ?? "")?.artifacts ?? new Map<string, Uint8Array>())];
    }
    const sub = rel.length > root.length ? rel.slice(root.length + 1) : "";
    const prefix = sub ? `${sub}/` : "";
    const seen = new Map<string, Json>();
    for (const [path, data] of entries) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) seen.set(rest.slice(0, slash), { path: rest.slice(0, slash), is_dir: true });
      else seen.set(rest, { path: rest, is_dir: false, file_size: data.byteLength });
    }
    return [...seen.values()].sort((a, c) => String(a["path"]).localeCompare(String(c["path"])));
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/health") return new Response("OK");
    if (p === "/version") return new Response(this.version);
    let body: Json = {};
    if (req.method === "POST") body = ((await req.json().catch(() => ({}))) as Json) ?? {};
    else for (const [k, v] of url.searchParams) body[k] = v;
    this.calls.push({ path: p, body });
    if (this.down)
      return Response.json(
        { error_code: "TEMPORARILY_UNAVAILABLE", message: "down" },
        { status: 503 },
      );
    const injected = this.intercept?.(p, body);
    if (injected) return injected;
    try {
      if (p.startsWith("/api/3.0/mlflow/") || p === "/ajax-api/3.0/mlflow/get-trace-artifact") {
        if (req.method === "PATCH" || req.method === "DELETE")
          body = ((await req.json().catch(() => ({}))) as Json) ?? {};
        return Response.json(
          this.v3(p.replace(/^\/(ajax-)?api\/3\.0\/mlflow\//, ""), body, req.method),
        );
      }
      if (p.startsWith("/api/2.0/mlflow-artifacts/artifacts/") && req.method === "PUT") {
        const rel = decodeURIComponent(p.slice("/api/2.0/mlflow-artifacts/artifacts/".length));
        const rest = rel.split("/");
        const data = new Uint8Array(await req.arrayBuffer());
        if (rest[1] === "traces") {
          const t = this.traces.get(rest[2] ?? "");
          if (!t) throw new Fail(404, "RESOURCE_DOES_NOT_EXIST", "no such trace");
          t.spans = (JSON.parse(new TextDecoder().decode(data)) as { spans: Json[] }).spans;
          return Response.json({});
        }
        if (rest[1] === "models") this.modelArtifacts.set(rel, data);
        else this.mustRun(rest[1] as string).artifacts.set(rest.slice(3).join("/"), data);
        return Response.json({});
      }
      if (p === "/api/2.0/mlflow-artifacts/artifacts" && req.method === "GET") {
        const files = this.proxiedList(String(body["path"] ?? ""));
        return Response.json(files.length ? { files } : {});
      }
      if (p.startsWith("/api/2.0/mlflow-artifacts/artifacts/") && req.method === "GET") {
        const rel = decodeURIComponent(p.slice("/api/2.0/mlflow-artifacts/artifacts/".length));
        const data = this.proxied(rel);
        if (!data) throw new Fail(404, "RESOURCE_DOES_NOT_EXIST", "no such artifact");
        return new Response(data, { headers: { "content-type": guessType(rel) } });
      }
      if (p === "/get-artifact") {
        const run = this.mustRun(String(body["run_uuid"]));
        const data = run.artifacts.get(String(body["path"]));
        if (!data) throw new Fail(404, "RESOURCE_DOES_NOT_EXIST", "no such artifact");
        // MLflow guesses the type from the file name (mimetypes); do the same.
        return new Response(data, {
          headers: { "content-type": guessType(String(body["path"])) },
        });
      }
      const ep = p.replace(/^\/api\/2\.0\/mlflow\//, "");
      if (req.method === "PATCH" || req.method === "DELETE")
        body = ((await req.json().catch(() => ({}))) as Json) ?? {};
      return Response.json(this.api(ep, body, req.method));
    } catch (e) {
      if (e instanceof Fail)
        return Response.json({ error_code: e.code, message: e.message }, { status: e.status });
      throw e;
    }
  }

  private mustExp(id: string): Exp {
    const e = this.exps.get(id);
    if (!e) throw new Fail(404, "RESOURCE_DOES_NOT_EXIST", `No Experiment with id=${id} exists`);
    return e;
  }

  private mustRun(id: string): Run {
    const r = this.runs.get(id);
    if (!r) throw new Fail(404, "RESOURCE_DOES_NOT_EXIST", `Run '${id}' not found`);
    return r;
  }

  private runJson(r: Run): Json {
    const latest = new Map<string, Run["metrics"][number]>();
    for (const m of r.metrics) {
      const cur = latest.get(m.key);
      if (!cur || m.step > cur.step || (m.step === cur.step && m.timestamp >= cur.timestamp))
        latest.set(m.key, m);
    }
    return {
      info: { ...r.info },
      data: {
        metrics: [...latest.values()],
        params: [...r.params].map(([key, value]) => ({ key, value })),
        tags: [...r.tags].map(([key, value]) => ({ key, value })),
      },
      inputs: r.inputs.length ? { dataset_inputs: r.inputs } : {},
      outputs: r.outputs.length ? { model_outputs: r.outputs } : {},
    };
  }

  private mustModel(id: string): LoggedModel {
    const m = this.models.get(id);
    if (!m)
      throw new Fail(404, "RESOURCE_DOES_NOT_EXIST", `Logged model with ID '${id}' not found`);
    return m;
  }

  private mustReg(name: string): RegModel {
    const m = this.registered.get(name);
    if (!m)
      throw new Fail(
        404,
        "RESOURCE_DOES_NOT_EXIST",
        `Registered Model with name=${name} not found`,
      );
    return m;
  }

  private mustVersion(name: string, version: string): Version {
    const v = this.mustReg(name).versions.find((x) => x.version === version);
    if (!v)
      throw new Fail(
        404,
        "RESOURCE_DOES_NOT_EXIST",
        `Model Version (name=${name}, version=${version}) not found`,
      );
    return v;
  }

  private versionJson(v: Version, withAliases = true): Json {
    const reg = this.mustReg(v.name);
    const aliases = [...reg.aliases].filter(([, ver]) => ver === v.version).map(([a]) => a);
    return {
      name: v.name,
      version: v.version,
      creation_timestamp: v.creation_timestamp,
      last_updated_timestamp: v.last_updated_timestamp,
      current_stage: v.current_stage,
      description: v.description,
      source: v.source,
      run_id: v.run_id,
      status: v.status,
      ...(v.tags.size ? { tags: [...v.tags].map(([key, value]) => ({ key, value })) } : {}),
      run_link: v.run_link,
      ...(withAliases && aliases.length ? { aliases } : {}),
    };
  }

  private regJson(m: RegModel, _full: boolean): Json {
    const latest = m.versions.at(-1);
    return {
      name: m.name,
      creation_timestamp: m.creation_timestamp,
      last_updated_timestamp: m.last_updated_timestamp,
      ...(m.description ? { description: m.description } : {}),
      ...(latest ? { latest_versions: [this.versionJson(latest, false)] } : {}),
      ...(m.tags.size ? { tags: [...m.tags].map(([key, value]) => ({ key, value })) } : {}),
      ...(m.aliases.size
        ? { aliases: [...m.aliases].map(([alias, version]) => ({ alias, version })) }
        : {}),
    };
  }

  /** `tags.\`k\` = 'v'`, `name = 'v'`, `run_id = 'v'`, `source_run_id = 'v'` joined by `and`. */
  private simpleFilter(
    filter: string | undefined,
    get: (field: string) => string | undefined,
  ): boolean {
    if (!filter) return true;
    for (const clause of filter.split(/\s+and\s+/i)) {
      const m = /^\s*(tags\.)?`?([^`=!\s]+?)`?\s*(=|!=)\s*'([^']*)'\s*$/.exec(clause);
      if (!m)
        throw new Fail(
          400,
          "INVALID_PARAMETER_VALUE",
          `fake: unsupported filter clause: ${clause}`,
        );
      const [, tag, key, op, want] = m as unknown as [
        string,
        string | undefined,
        string,
        string,
        string,
      ];
      const got = get(tag ? `tags.${key}` : key);
      if ((op === "=") !== (got === want)) return false;
    }
    return true;
  }

  /**
   * A subset of MLflow's search grammar: `and`-joined clauses of `tags.k = 'v'`,
   * `params.k = 'v'`, `attributes.status|run_name = 'v'` and `metrics.k <op> number`. Keys may be
   * backquoted. Anything else is rejected like MLflow rejects a bad filter.
   */
  private matches(r: Run, filter: string | undefined): boolean {
    if (!filter) return true;
    for (const clause of filter.split(/\s+and\s+/i)) {
      const str = /^\s*(tags|params|attributes)\.`?([^`=!<>\s]+?)`?\s*(=|!=)\s*'([^']*)'\s*$/.exec(
        clause,
      );
      if (str) {
        const [, kind, key, op, want] = str as unknown as [string, string, string, string, string];
        const got =
          kind === "tags"
            ? r.tags.get(key)
            : kind === "params"
              ? r.params.get(key)
              : key === "status"
                ? r.info.status
                : key === "run_name"
                  ? r.info.run_name
                  : undefined;
        if (kind === "attributes" && key !== "status" && key !== "run_name")
          throw new Fail(400, "INVALID_PARAMETER_VALUE", `fake: unsupported attribute ${key}`);
        if ((op === "=") !== (got === want)) return false;
        continue;
      }
      const num = /^\s*metrics\.`?([^`=!<>\s]+?)`?\s*(<=|>=|!=|=|<|>)\s*(-?[0-9.eE+-]+)\s*$/.exec(
        clause,
      );
      if (num) {
        const [, key, op, raw] = num as unknown as [string, string, string, string];
        const latest = r.metrics
          .filter((m) => m.key === key)
          .sort((a, c) => a.step - c.step || a.timestamp - c.timestamp)
          .at(-1)?.value;
        if (latest === undefined) return false;
        const v = Number(raw);
        const ok =
          op === "<"
            ? latest < v
            : op === "<="
              ? latest <= v
              : op === ">"
                ? latest > v
                : op === ">="
                  ? latest >= v
                  : op === "="
                    ? latest === v
                    : latest !== v;
        if (!ok) return false;
        continue;
      }
      throw new Fail(400, "INVALID_PARAMETER_VALUE", `fake: unsupported filter clause: ${clause}`);
    }
    return true;
  }

  private api(ep: string, b: Json, method = "POST"): Json {
    const s = (k: string) => (b[k] === undefined ? undefined : String(b[k]));
    const now = Date.now();
    switch (ep) {
      case "experiments/create": {
        const name = s("name") ?? "";
        if (!name) throw new Fail(400, "INVALID_PARAMETER_VALUE", "name required");
        if ([...this.exps.values()].some((e) => e.name === name))
          throw new Fail(400, "RESOURCE_ALREADY_EXISTS", `Experiment '${name}' already exists.`);
        const id = String(this.nextExp++);
        this.exps.set(id, {
          experiment_id: id,
          name,
          artifact_location: `mlflow-artifacts:/${id}`,
          lifecycle_stage: "active",
          creation_time: now,
          last_update_time: now,
          tags: ((b["tags"] as Exp["tags"] | undefined) ?? []).map((t) => ({ ...t })),
        });
        return { experiment_id: id };
      }
      case "experiments/get":
        return { experiment: this.mustExp(s("experiment_id") ?? "") };
      case "experiments/get-by-name": {
        const e = [...this.exps.values()].find((x) => x.name === s("experiment_name"));
        if (!e)
          throw new Fail(
            404,
            "RESOURCE_DOES_NOT_EXIST",
            `Could not find experiment with name '${s("experiment_name")}'`,
          );
        return { experiment: e };
      }
      case "experiments/search": {
        const view = s("view_type") ?? "ACTIVE_ONLY";
        if (!b["max_results"])
          throw new Fail(
            400,
            "INVALID_PARAMETER_VALUE",
            "Invalid value 0 for parameter 'max_results' supplied. It must be a positive integer",
          );
        const max = Number(b["max_results"]);
        const start = Number(s("page_token") ?? 0);
        const all = [...this.exps.values()]
          .filter(
            (e) =>
              view === "ALL" || (view === "DELETED_ONLY") === (e.lifecycle_stage === "deleted"),
          )
          .sort(
            (a, c) =>
              c.creation_time - a.creation_time ||
              Number(c.experiment_id) - Number(a.experiment_id),
          );
        const page = all.slice(start, start + max);
        return {
          experiments: page,
          ...(start + max < all.length ? { next_page_token: String(start + max) } : {}),
        };
      }
      case "experiments/update": {
        const e = this.mustExp(s("experiment_id") ?? "");
        e.name = s("new_name") ?? e.name;
        e.last_update_time = now;
        return {};
      }
      case "experiments/delete":
        this.mustExp(s("experiment_id") ?? "").lifecycle_stage = "deleted";
        return {};
      case "experiments/restore":
        this.mustExp(s("experiment_id") ?? "").lifecycle_stage = "active";
        return {};
      case "experiments/set-experiment-tag": {
        const e = this.mustExp(s("experiment_id") ?? "");
        e.tags = [
          ...e.tags.filter((t) => t.key !== s("key")),
          { key: s("key") ?? "", value: s("value") ?? "" },
        ];
        return {};
      }
      case "runs/create": {
        const exp = this.mustExp(s("experiment_id") ?? "");
        const id = `${String(this.nextRun++).padStart(8, "0")}fakefakefakefakefakefake`;
        const tags = new Map(
          ((b["tags"] as { key: string; value: string }[] | undefined) ?? []).map((t) => [
            t.key,
            t.value,
          ]),
        );
        const name = s("run_name") ?? `run-${id.slice(0, 6)}`;
        tags.set("mlflow.runName", name);
        const r: Run = {
          info: {
            run_id: id,
            run_uuid: id,
            experiment_id: exp.experiment_id,
            run_name: name,
            status: "RUNNING",
            start_time: Number(b["start_time"] ?? now),
            artifact_uri: `mlflow-artifacts:/${exp.experiment_id}/${id}/artifacts`,
            lifecycle_stage: "active",
          },
          metrics: [],
          params: new Map(),
          tags,
          artifacts: new Map(),
          inputs: [],
          outputs: [],
        };
        this.runs.set(id, r);
        return { run: this.runJson(r) };
      }
      case "runs/get":
        return { run: this.runJson(this.mustRun(s("run_id") ?? "")) };
      case "runs/search": {
        const ids = new Set((b["experiment_ids"] as string[] | undefined) ?? []);
        const view = s("run_view_type") ?? "ACTIVE_ONLY";
        const max = Number(b["max_results"] ?? 1000);
        const start = Number(s("page_token") ?? 0);
        const all = [...this.runs.values()]
          .filter((r) => ids.has(r.info.experiment_id))
          .filter(
            (r) =>
              view === "ALL" ||
              (view === "DELETED_ONLY") === (r.info.lifecycle_stage === "deleted"),
          )
          .filter((r) => this.matches(r, s("filter")))
          .sort((a, c) => c.info.start_time - a.info.start_time);
        const page = all.slice(start, start + max).map((r) => this.runJson(r));
        return {
          runs: page,
          ...(start + max < all.length ? { next_page_token: String(start + max) } : {}),
        };
      }
      case "runs/update": {
        const r = this.mustRun(s("run_id") ?? "");
        if (s("status")) r.info.status = s("status") as string;
        if (b["end_time"] !== undefined) r.info.end_time = Number(b["end_time"]);
        if (s("run_name")) {
          r.info.run_name = s("run_name") as string;
          r.tags.set("mlflow.runName", r.info.run_name);
        }
        return { run_info: { ...r.info } };
      }
      case "runs/delete":
        this.mustRun(s("run_id") ?? "").info.lifecycle_stage = "deleted";
        return {};
      case "runs/restore":
        this.mustRun(s("run_id") ?? "").info.lifecycle_stage = "active";
        return {};
      case "runs/set-tag":
        this.mustRun(s("run_id") ?? "").tags.set(s("key") ?? "", s("value") ?? "");
        return {};
      case "runs/delete-tag": {
        const r = this.mustRun(s("run_id") ?? "");
        if (!r.tags.delete(s("key") ?? ""))
          throw new Fail(404, "RESOURCE_DOES_NOT_EXIST", "no such tag");
        return {};
      }
      case "runs/log-batch": {
        const r = this.mustRun(s("run_id") ?? "");
        const params = (b["params"] as { key: string; value: string }[] | undefined) ?? [];
        const changed = params.filter(
          (p) => r.params.has(p.key) && r.params.get(p.key) !== p.value,
        );
        if (changed.length)
          throw new Fail(
            400,
            "INVALID_PARAMETER_VALUE",
            `Changing param values is not allowed. Params were already logged='${JSON.stringify(changed)}'`,
          );
        for (const p of params) r.params.set(p.key, p.value);
        for (const t of (b["tags"] as { key: string; value: string }[] | undefined) ?? [])
          r.tags.set(t.key, t.value);
        for (const m of (b["metrics"] as Run["metrics"] | undefined) ?? []) {
          const dup = r.metrics.some(
            (x) =>
              x.key === m.key &&
              x.step === m.step &&
              x.timestamp === m.timestamp &&
              x.value === m.value,
          );
          if (!dup)
            r.metrics.push({ key: m.key, value: m.value, timestamp: m.timestamp, step: m.step });
        }
        return {};
      }
      case "metrics/get-history": {
        const r = this.mustRun(s("run_id") ?? "");
        const key = s("metric_key");
        const all = r.metrics
          .filter((m) => m.key === key)
          .sort((a, c) => a.step - c.step || a.timestamp - c.timestamp);
        const max = Number(b["max_results"] ?? 25000);
        const start = Number(s("page_token") ?? 0);
        return {
          metrics: all.slice(start, start + max),
          ...(start + max < all.length ? { next_page_token: String(start + max) } : {}),
        };
      }
      case "artifacts/list": {
        const r = this.mustRun(s("run_id") ?? "");
        const prefix = s("path") ? `${s("path")}/` : "";
        const seen = new Map<string, Json>();
        for (const [path, data] of r.artifacts) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash >= 0)
            seen.set(prefix + rest.slice(0, slash), {
              path: prefix + rest.slice(0, slash),
              is_dir: true,
            });
          else seen.set(path, { path, is_dir: false, file_size: data.byteLength });
        }
        const files = [...seen.values()].sort((a, c) =>
          String(a["path"]).localeCompare(String(c["path"])),
        );
        return { root_uri: r.info.artifact_uri, ...(files.length ? { files } : {}) };
      }
      case "runs/log-inputs": {
        const r = this.mustRun(s("run_id") ?? "");
        for (const d of (b["datasets"] as
          | { tags?: Run["inputs"][number]["tags"]; dataset: Json }[]
          | undefined) ?? []) {
          const tags = d.tags ?? [];
          const ctx = tags.find((t) => t.key === "mlflow.data.context")?.value;
          const dup = r.inputs.some(
            (x) =>
              x.dataset["name"] === d.dataset["name"] &&
              x.dataset["digest"] === d.dataset["digest"] &&
              x.tags.find((t) => t.key === "mlflow.data.context")?.value === ctx,
          );
          if (!dup) r.inputs.push({ tags, dataset: { ...d.dataset } });
        }
        return {};
      }
      case "runs/outputs": {
        const r = this.mustRun(s("run_id") ?? "");
        for (const m of (b["models"] as { model_id: string; step?: number }[] | undefined) ?? []) {
          this.mustModel(m.model_id);
          if (!r.outputs.some((o) => o.model_id === m.model_id))
            r.outputs.push({ model_id: m.model_id, step: Number(m.step ?? 0) });
        }
        return {};
      }
      case "logged-models": {
        const exp = this.mustExp(s("experiment_id") ?? "");
        const id = `m-${String(this.nextModel++).padStart(6, "0")}fakefakefakefakefakefake`;
        const m: LoggedModel = {
          info: {
            model_id: id,
            experiment_id: exp.experiment_id,
            name: s("name") ?? "model",
            creation_timestamp_ms: now,
            last_updated_timestamp_ms: now,
            artifact_uri: `mlflow-artifacts:/${exp.experiment_id}/models/${id}/artifacts`,
            status: "LOGGED_MODEL_PENDING",
            model_type: s("model_type") ?? "",
            ...(s("source_run_id") ? { source_run_id: s("source_run_id") as string } : {}),
            tags: ((b["tags"] as LoggedModel["info"]["tags"] | undefined) ?? []).map((t) => ({
              ...t,
            })),
          },
          params: ((b["params"] as LoggedModel["params"] | undefined) ?? []).map((t) => ({ ...t })),
        };
        this.models.set(id, m);
        return { model: this.modelJson(m) };
      }
      case "logged-models/search": {
        const ids = new Set((b["experiment_ids"] as string[] | undefined) ?? []);
        const max = Number(b["max_results"] ?? 100);
        const start = Number(s("page_token") ?? 0);
        const all = [...this.models.values()]
          .filter((m) => ids.has(m.info.experiment_id))
          .filter((m) =>
            this.simpleFilter(s("filter"), (f) =>
              f.startsWith("tags.")
                ? m.info.tags.find((t) => t.key === f.slice(5))?.value
                : f === "source_run_id"
                  ? m.info.source_run_id
                  : f === "name"
                    ? m.info.name
                    : undefined,
            ),
          )
          .sort((a, c) => c.info.creation_timestamp_ms - a.info.creation_timestamp_ms);
        return {
          models: all.slice(start, start + max).map((m) => this.modelJson(m)),
          ...(start + max < all.length ? { next_page_token: String(start + max) } : {}),
        };
      }
      case "registered-models/create": {
        const name = s("name") ?? "";
        if (this.registered.has(name))
          throw new Fail(
            400,
            "RESOURCE_ALREADY_EXISTS",
            `Registered Model (name=${name}) already exists.`,
          );
        const m: RegModel = {
          name,
          creation_timestamp: now,
          last_updated_timestamp: now,
          description: s("description") ?? "",
          tags: new Map(
            ((b["tags"] as { key: string; value: string }[] | undefined) ?? []).map((t) => [
              t.key,
              t.value,
            ]),
          ),
          aliases: new Map(),
          versions: [],
        };
        this.registered.set(name, m);
        return { registered_model: this.regJson(m, true) };
      }
      case "registered-models/get":
        return { registered_model: this.regJson(this.mustReg(s("name") ?? ""), true) };
      case "registered-models/search": {
        const max = Number(b["max_results"] ?? 100);
        const start = Number(s("page_token") ?? 0);
        const wantPrompts = (s("filter") ?? "").includes("mlflow.prompt.is_prompt");
        const all = [...this.registered.values()]
          .filter((m) => wantPrompts || m.tags.get("mlflow.prompt.is_prompt") !== "true")
          .filter((m) =>
            this.simpleFilter(s("filter"), (f) =>
              f.startsWith("tags.") ? m.tags.get(f.slice(5)) : f === "name" ? m.name : undefined,
            ),
          )
          .sort((a, c) => a.name.localeCompare(c.name));
        return {
          registered_models: all.slice(start, start + max).map((m) => this.regJson(m, false)),
          ...(start + max < all.length ? { next_page_token: String(start + max) } : {}),
        };
      }
      case "registered-models/update": {
        const m = this.mustReg(s("name") ?? "");
        m.description = s("description") ?? m.description;
        m.last_updated_timestamp = now;
        return { registered_model: this.regJson(m, true) };
      }
      case "registered-models/set-tag":
        this.mustReg(s("name") ?? "").tags.set(s("key") ?? "", s("value") ?? "");
        return {};
      case "registered-models/delete-tag":
        this.mustReg(s("name") ?? "").tags.delete(s("key") ?? "");
        return {};
      case "registered-models/alias": {
        const m = this.mustReg(s("name") ?? "");
        const alias = s("alias") ?? "";
        if (method === "GET") {
          const v = m.aliases.get(alias);
          if (!v) throw new Fail(404, "RESOURCE_DOES_NOT_EXIST", `alias ${alias} not found`);
          return { model_version: this.versionJson(this.mustVersion(m.name, v)) };
        }
        if (method === "DELETE") {
          m.aliases.delete(alias);
          return {};
        }
        this.mustVersion(m.name, s("version") ?? "");
        m.aliases.set(alias, s("version") ?? "");
        return {};
      }
      case "model-versions/create": {
        const m = this.mustReg(s("name") ?? "");
        const src = s("source") ?? "";
        if (src.startsWith("models:/") && src !== `models:/${s("model_id") ?? ""}`)
          throw new Fail(
            400,
            "INVALID_PARAMETER_VALUE",
            `Invalid model version source: '${src}'. The model_id request parameter must identify the resource that contains the source.`,
          );
        const v: Version = {
          name: m.name,
          version: String(m.versions.length + 1),
          creation_timestamp: now,
          last_updated_timestamp: now,
          current_stage: "None",
          description: s("description") ?? "",
          source: s("source") ?? "",
          run_id: s("run_id") ?? "",
          status: "READY",
          tags: new Map(
            ((b["tags"] as { key: string; value: string }[] | undefined) ?? []).map((t) => [
              t.key,
              t.value,
            ]),
          ),
          run_link: "",
        };
        m.versions.push(v);
        m.last_updated_timestamp = now;
        return { model_version: this.versionJson(v) };
      }
      case "model-versions/get":
        return {
          model_version: this.versionJson(this.mustVersion(s("name") ?? "", s("version") ?? "")),
        };
      case "model-versions/search": {
        const max = Number(b["max_results"] ?? 100);
        const start = Number(s("page_token") ?? 0);
        const wantPromptVersions = (s("filter") ?? "").includes("mlflow.prompt.is_prompt");
        const all = [...this.registered.values()]
          .flatMap((m) => m.versions)
          .filter((v) => wantPromptVersions || v.tags.get("mlflow.prompt.is_prompt") !== "true")
          .filter((v) =>
            this.simpleFilter(s("filter"), (f) =>
              f.startsWith("tags.")
                ? v.tags.get(f.slice(5))
                : f === "name"
                  ? v.name
                  : f === "run_id"
                    ? v.run_id
                    : f === "source"
                      ? v.source
                      : undefined,
            ),
          )
          .sort((a, c) => a.name.localeCompare(c.name) || Number(c.version) - Number(a.version));
        return {
          model_versions: all.slice(start, start + max).map((v) => this.versionJson(v)),
          ...(start + max < all.length ? { next_page_token: String(start + max) } : {}),
        };
      }
      case "model-versions/update": {
        const v = this.mustVersion(s("name") ?? "", s("version") ?? "");
        v.description = s("description") ?? v.description;
        v.last_updated_timestamp = now;
        return { model_version: this.versionJson(v) };
      }
      case "model-versions/set-tag":
        this.mustVersion(s("name") ?? "", s("version") ?? "").tags.set(
          s("key") ?? "",
          s("value") ?? "",
        );
        return {};
      case "model-versions/delete-tag":
        this.mustVersion(s("name") ?? "", s("version") ?? "").tags.delete(s("key") ?? "");
        return {};
      default: {
        const lm = /^logged-models\/(m-[A-Za-z0-9]+)$/.exec(ep);
        if (lm) {
          const m = this.mustModel(lm[1] as string);
          if (method === "PATCH") {
            if (!b["model_id"])
              throw new Fail(
                400,
                "INVALID_PARAMETER_VALUE",
                "Missing value for required parameter 'model_id'.",
              );
            m.info.status = s("status") ?? m.info.status;
            m.info.last_updated_timestamp_ms = now;
          }
          return { model: this.modelJson(m) };
        }
        throw new Fail(404, "ENDPOINT_NOT_FOUND", `fake MLflow does not implement ${ep}`);
      }
    }
  }

  private mustTrace(id: string): FakeTrace {
    const t = this.traces.get(id);
    if (!t) throw new Fail(404, "RESOURCE_DOES_NOT_EXIST", `Trace with ID ${id} not found.`);
    return t;
  }

  private traceJson(t: FakeTrace): Json {
    return {
      ...t.info,
      tags: { ...t.tags },
      ...(t.assessments.length ? { assessments: t.assessments.map((a) => ({ ...a })) } : {}),
    };
  }

  /**
   * Trace search filter subset: `and`-joined `tag.k = 'v'`, `metadata.k = 'v'`,
   * `trace.status = 'v'`, `trace.name = 'v'`, `run_id = 'v'` (backquoted keys allowed).
   */
  private traceMatches(t: FakeTrace, filter: string | undefined): boolean {
    if (!filter) return true;
    for (const clause of filter.split(/\s+and\s+/i)) {
      const m =
        /^\s*(tag|tags|metadata|trace|attributes)?\.?`?([^`=!\s]+?)`?\s*(=|!=)\s*'([^']*)'\s*$/.exec(
          clause,
        );
      if (!m)
        throw new Fail(400, "INVALID_PARAMETER_VALUE", `fake: unsupported trace filter: ${clause}`);
      const [, kind, key, op, want] = m as unknown as [
        string,
        string | undefined,
        string,
        string,
        string,
      ];
      const md = (t.info["trace_metadata"] ?? {}) as Record<string, string>;
      const got =
        kind === "tag" || kind === "tags"
          ? t.tags[key]
          : kind === "metadata"
            ? md[key]
            : key === "status"
              ? String(t.info["state"])
              : key === "name"
                ? t.tags["mlflow.traceName"]
                : key === "run_id"
                  ? md["mlflow.sourceRun"]
                  : undefined;
      if ((op === "=") !== (got === want)) return false;
    }
    return true;
  }

  private v3(ep: string, b: Json, method: string): Json {
    if (ep === "traces" && method === "POST") {
      const info = ((b["trace"] as Json)?.["trace_info"] ?? {}) as Json;
      const id = String(info["trace_id"] ?? "");
      if (!/^tr-[a-f0-9]{32}$/.test(id))
        throw new Fail(400, "INVALID_PARAMETER_VALUE", "bad trace_id");
      const exp = String(
        ((info["trace_location"] as Json)?.["mlflow_experiment"] as Json)?.["experiment_id"] ?? "",
      );
      this.mustExp(exp);
      const tags = { ...((info["tags"] as Record<string, string>) ?? {}) };
      tags["mlflow.artifactLocation"] = `mlflow-artifacts:/${exp}/traces/${id}/artifacts`;
      const t: FakeTrace = {
        info: {
          ...info,
          trace_metadata: {
            ...((info["trace_metadata"] as Json) ?? {}),
            "mlflow.trace.infoFinalized": "true",
          },
        },
        tags,
        spans: undefined,
        assessments: [],
        experiment_id: exp,
      };
      delete t.info["tags"];
      this.traces.set(id, t);
      return { trace: { trace_info: this.traceJson(t) } };
    }
    if (ep === "traces/search") {
      const locs = (b["locations"] as Json[] | undefined) ?? [];
      const exps = new Set(
        locs.map((l) => String((l["mlflow_experiment"] as Json)?.["experiment_id"])),
      );
      const max = Number(b["max_results"] ?? 100);
      const start = b["page_token"]
        ? Number(JSON.parse(atob(String(b["page_token"])))["offset"])
        : 0;
      const all = [...this.traces.values()]
        .filter(
          (t) =>
            exps.has(t.experiment_id) && this.traceMatches(t, b["filter"] as string | undefined),
        )
        .sort((a, c) =>
          String(c.info["request_time"]).localeCompare(String(a.info["request_time"])),
        );
      return {
        traces: all.slice(start, start + max).map((t) => this.traceJson(t)),
        ...(start + max < all.length
          ? { next_page_token: btoa(JSON.stringify({ offset: start + max })) }
          : {}),
      };
    }
    if (ep === "get-trace-artifact") {
      const t = this.mustTrace(String(b["request_id"] ?? ""));
      if (!t.spans) throw new Fail(404, "RESOURCE_DOES_NOT_EXIST", "Trace data not found");
      return { spans: t.spans };
    }
    if (ep === "traces/delete-traces") {
      const ids = b["request_ids"] as string[] | undefined;
      const maxTs = b["max_timestamp_millis"] as number | undefined;
      let n = 0;
      for (const [id, t] of [...this.traces]) {
        if (t.experiment_id !== String(b["experiment_id"])) continue;
        const hit = ids
          ? ids.includes(id)
          : maxTs !== undefined && Date.parse(String(t.info["request_time"])) <= maxTs;
        if (hit) {
          this.traces.delete(id);
          n++;
        }
      }
      return { traces_deleted: n };
    }
    if (ep === "datasets/create") {
      const id = `d-${crypto.randomUUID().replaceAll("-", "")}`;
      const dataset = {
        dataset_id: id,
        name: String(b["name"]),
        experiment_ids: [...((b["experiment_ids"] as string[] | undefined) ?? [])],
        tags: String(b["tags"] ?? "{}"),
      };
      this.datasets.set(id, { ...dataset, records: [] });
      return { dataset: { ...dataset, digest: id.slice(2, 10) } };
    }
    const dsg = /^datasets\/(d-[a-f0-9]+)$/.exec(ep);
    if (dsg && method === "GET") {
      const d = this.datasets.get(dsg[1] as string);
      if (!d) throw new Fail(404, "RESOURCE_DOES_NOT_EXIST", "no such dataset");
      return {
        dataset: {
          dataset_id: d.dataset_id,
          name: d.name,
          experiment_ids: [...d.experiment_ids],
          tags: d.tags,
          digest: d.dataset_id.slice(2, 10),
        },
      };
    }
    const dsr = /^datasets\/(d-[a-f0-9]+)\/records$/.exec(ep);
    if (dsr) {
      const d = this.datasets.get(dsr[1] as string);
      if (!d) throw new Fail(404, "RESOURCE_DOES_NOT_EXIST", "no such dataset");
      const recs = JSON.parse(String(b["records"] ?? "[]")) as Json[];
      d.records.push(...recs);
      return { inserted_count: recs.length, updated_count: 0 };
    }
    const tagm = /^traces\/(tr-[a-f0-9]{32})\/tags$/.exec(ep);
    if (tagm) {
      this.mustTrace(tagm[1] as string).tags[String(b["key"])] = String(b["value"]);
      return {};
    }
    const am = /^traces\/(tr-[a-f0-9]{32})\/assessments$/.exec(ep);
    if (am) {
      const t = this.mustTrace(am[1] as string);
      const a = {
        ...((b["assessment"] as Json) ?? {}),
        assessment_id: `a-${crypto.randomUUID().replaceAll("-", "")}`,
        trace_id: t.info["trace_id"],
        create_time: new Date().toISOString(),
        valid: true,
      };
      t.assessments.push(a);
      return { assessment: a };
    }
    const gm = /^traces\/(tr-[a-f0-9]{32})$/.exec(ep);
    if (gm) return { trace: { trace_info: this.traceJson(this.mustTrace(gm[1] as string)) } };
    throw new Fail(404, "ENDPOINT_NOT_FOUND", `fake MLflow does not implement 3.0/${ep}`);
  }

  private modelJson(m: LoggedModel): Json {
    return {
      info: { ...m.info, tags: m.info.tags.map((t) => ({ ...t })) },
      data: m.params.length ? { params: m.params.map((p) => ({ ...p })) } : {},
    };
  }
}
