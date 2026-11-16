/**
 * MLflow Projects (spec §5.5 "MLflow Projects", §5.6 Project Entrypoints; ADR 0019).
 *
 * Reads a checkout's `MLproject` file, lists its entrypoints and parameters, and launches one as an
 * ordinary AblationKit job: the command is rendered the way `mlflow run --env-manager local` renders
 * it (typed parameters, `shlex.quote`, extra parameters appended as `--key value`), then runs under
 * the job runner, so it gets an attempt, a supervised process, console logs and one MLflow run per
 * attempt, tagged `mlflow.project.entryPoint`. An `MLproject` is never required: projects without
 * one keep running plain commands.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JobRecord, MlprojectRunInfo } from "@ablationkit/protocol";
import { HttpError } from "../http.ts";

export type ParamType = "string" | "float" | "path" | "uri";

export interface EntrypointParam {
  readonly name: string;
  readonly type: ParamType;
  readonly default?: string;
}

export interface Entrypoint {
  readonly name: string;
  readonly command: string;
  readonly parameters: EntrypointParam[];
}

export interface MlprojectInfo {
  readonly found: boolean;
  readonly path?: string;
  readonly name?: string;
  readonly environment: {
    readonly kind: MlprojectRunInfo["declared_environment"];
    readonly file?: string;
    /** How AblationKit runs it; `docker_env` is refused (no containers, spec §0). */
    readonly supported: boolean;
    readonly note: string;
  };
  readonly entry_points: Entrypoint[];
  readonly problems: string[];
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const TYPES: readonly ParamType[] = ["string", "float", "path", "uri"];
const MAX_FILE = 256 * 1024;

/** Python's `shlex.quote`. */
export function shlexQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

function asString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** Parse and validate an `MLproject` file's text. Never throws; problems are reported. */
export function parseMlproject(text: string): Omit<MlprojectInfo, "found" | "path"> {
  const problems: string[] = [];
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    return {
      environment: { kind: "none", supported: false, note: "unreadable MLproject" },
      entry_points: [],
      problems: [`MLproject is not valid YAML: ${(e as Error).message}`],
    };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return {
      environment: { kind: "none", supported: false, note: "unreadable MLproject" },
      entry_points: [],
      problems: ["MLproject must be a YAML mapping"],
    };
  const d = doc as Record<string, unknown>;
  const declared = (["python_env", "conda_env", "docker_env"] as const).filter((k) => k in d);
  if (declared.length > 1)
    problems.push(`MLproject declares more than one environment: ${declared.join(", ")}`);
  const kind = declared[0] ?? "none";
  const file = typeof d[kind] === "string" ? (d[kind] as string) : undefined;
  const environment: MlprojectInfo["environment"] =
    kind === "docker_env"
      ? {
          kind,
          supported: false,
          note: "docker_env is not supported: AblationKit runs no containers (spec §0). Use python_env or none.",
        }
      : {
          kind,
          ...(file ? { file } : {}),
          supported: true,
          note:
            kind === "none"
              ? "No environment declared: runs in the project's own environment (uv when it has a pyproject.toml)."
              : `${kind} is declared; AblationKit runs the entrypoint in the project's own environment (uv when it has a pyproject.toml), like \`mlflow run --env-manager local\`. The ${kind} file is not installed.`,
        };
  const eps: Entrypoint[] = [];
  const raw = d["entry_points"];
  if (raw === undefined) problems.push("MLproject has no entry_points");
  else if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    problems.push("entry_points must be a mapping");
  else
    for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
      if (!NAME_RE.test(name)) {
        problems.push(`entrypoint name ${JSON.stringify(name)} is not supported`);
        continue;
      }
      const e = (def ?? {}) as Record<string, unknown>;
      const command = asString(e["command"]);
      if (!command) {
        problems.push(`entrypoint ${name} has no command`);
        continue;
      }
      const params: EntrypointParam[] = [];
      const ps = e["parameters"] ?? {};
      if (typeof ps !== "object" || ps === null || Array.isArray(ps)) {
        problems.push(`entrypoint ${name}: parameters must be a mapping`);
        continue;
      }
      for (const [pn, pd] of Object.entries(ps as Record<string, unknown>)) {
        if (!NAME_RE.test(pn)) {
          problems.push(
            `entrypoint ${name}: parameter name ${JSON.stringify(pn)} is not supported`,
          );
          continue;
        }
        // `name: type` or `name: {type: …, default: …}`; unknown types behave like strings.
        const spec =
          typeof pd === "string" ? { type: pd } : ((pd ?? {}) as Record<string, unknown>);
        const t = asString(spec["type"]) ?? "string";
        const type = (TYPES as readonly string[]).includes(t) ? (t as ParamType) : "string";
        const raw = spec["default"];
        // Python's str(float): MLflow shows a float default of 1 as "1.0".
        const dflt =
          type === "float" && typeof raw === "number" && Number.isInteger(raw)
            ? raw.toFixed(1)
            : asString(raw);
        params.push({ name: pn, type, ...(dflt !== undefined ? { default: dflt } : {}) });
      }
      eps.push({ name, command, parameters: params });
    }
  return {
    ...(typeof d["name"] === "string" ? { name: d["name"] } : {}),
    environment,
    entry_points: eps,
    problems,
  };
}

export function discoverMlproject(checkout: string): MlprojectInfo {
  const path = ["MLproject", "mlproject"].map((f) => join(checkout, f)).find((p) => existsSync(p));
  if (!path)
    return {
      found: false,
      environment: { kind: "none", supported: true, note: "No MLproject file." },
      entry_points: [],
      problems: [],
    };
  if (statSync(path).size > MAX_FILE)
    return {
      found: true,
      path,
      environment: { kind: "none", supported: false, note: "unreadable MLproject" },
      entry_points: [],
      problems: [`MLproject is larger than ${MAX_FILE} bytes`],
    };
  return { found: true, path, ...parseMlproject(readFileSync(path, "utf8")) };
}

/**
 * Render an entrypoint's command (`mlflow.projects._project_spec.EntryPoint.compute_command`):
 * declared parameters fill `{name}` placeholders, quoted; undeclared ones are appended as
 * `--name value`. `path` parameters become absolute paths inside the checkout, `uri` parameters
 * that are local paths too; `float` parameters must parse as numbers.
 */
export function renderCommand(
  ep: Entrypoint,
  given: Readonly<Record<string, string>>,
  checkout: string,
  /** Remote targets run from the bundle's copy of the checkout: paths stay relative. */
  relativePaths = false,
): { command: string; parameters: Record<string, string> } {
  const values: Record<string, string> = {};
  const declared = new Map(ep.parameters.map((p) => [p.name, p]));
  for (const p of ep.parameters) {
    const v = given[p.name] ?? p.default;
    if (v === undefined)
      throw new HttpError(
        422,
        "missing_parameter",
        `entrypoint ${ep.name} needs parameter ${p.name}`,
      );
    values[p.name] = typed(p, v, checkout, relativePaths);
  }
  const extras: [string, string][] = [];
  for (const [k, v] of Object.entries(given)) {
    if (declared.has(k)) continue;
    if (!NAME_RE.test(k)) throw new HttpError(400, "invalid_request", `bad parameter name ${k}`);
    if (typeof v !== "string") throw new HttpError(400, "invalid_request", `${k} must be a string`);
    extras.push([k, v]);
  }
  let missing: string | undefined;
  let command = ep.command.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (m, key: string | undefined) => {
    if (m === "{{") return "{";
    if (m === "}}") return "}";
    const k = key ?? "";
    if (!(k in values)) {
      missing ??= k;
      return m;
    }
    return shlexQuote(values[k] as string);
  });
  if (missing !== undefined)
    throw new HttpError(
      422,
      "invalid_mlproject",
      `entrypoint ${ep.name} uses {${missing}}, which is not a declared parameter`,
    );
  for (const [k, v] of extras) command += ` --${k} ${shlexQuote(v)}`;
  return { command, parameters: { ...values, ...Object.fromEntries(extras) } };
}

function typed(p: EntrypointParam, v: string, checkout: string, rel = false): string {
  if (typeof v !== "string")
    throw new HttpError(400, "invalid_request", `${p.name} must be a string`);
  if (v.length > 4096) throw new HttpError(400, "invalid_request", `${p.name} is too long`);
  switch (p.type) {
    case "float":
      if (v.trim() === "" || !Number.isFinite(Number(v)))
        throw new HttpError(
          422,
          "invalid_parameter",
          `${p.name} must be a float, got ${JSON.stringify(v)}`,
        );
      return v;
    case "path":
    case "uri": {
      if (p.type === "uri" && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) return v; // a real URI
      if (p.type === "path" && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(v))
        throw new HttpError(
          422,
          "invalid_parameter",
          `${p.name}: remote paths are not downloaded; give a path inside the checkout`,
        );
      const abs = isAbsolute(v) ? v : resolve(checkout, v);
      if (abs !== checkout && !abs.startsWith(checkout + sep))
        throw new HttpError(
          422,
          "invalid_parameter",
          `${p.name} must stay inside the project checkout`,
        );
      return rel ? relative(checkout, abs) || "." : abs;
    }
    default:
      return v;
  }
}

export interface LaunchRequest {
  readonly entrypoint: string;
  readonly parameters: Readonly<Record<string, string>>;
  /** Launched on a remote target: path parameters are rendered relative to the checkout. */
  readonly remote?: boolean;
}

/** Validate a launch against the checkout's MLproject: the job fields to submit. */
export function planLaunch(
  checkout: string,
  req: LaunchRequest,
): { command: string[]; mlproject: NonNullable<JobRecord["mlproject"]>; info: MlprojectInfo } {
  const info = discoverMlproject(checkout);
  if (!info.found) throw new HttpError(404, "no_mlproject", "this checkout has no MLproject file");
  if (!info.environment.supported)
    throw new HttpError(422, "unsupported_environment", info.environment.note);
  const ep = info.entry_points.find((e) => e.name === req.entrypoint);
  if (!ep)
    throw new HttpError(
      404,
      "no_entrypoint",
      `MLproject has no entrypoint ${req.entrypoint}${info.problems.length ? ` (${info.problems.join("; ")})` : ""}`,
    );
  const r = renderCommand(ep, req.parameters, checkout, req.remote === true);
  return {
    // MLflow runs entrypoint commands through a shell.
    command: ["/bin/sh", "-c", r.command],
    mlproject: {
      entrypoint: ep.name,
      parameters: r.parameters,
      declared_environment: info.environment.kind,
      ...(info.name ? { project_name: info.name.slice(0, 250) } : {}),
    },
    info,
  };
}
