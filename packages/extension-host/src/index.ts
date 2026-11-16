/**
 * @ablationkit/extension-host: the pure part of the Level 1 extension host (spec §8; ADR 0022).
 * Manifest validation with actionable diagnostics, the contribution-point and capability catalogs,
 * the host API version check, the bridge method table and the hashes approvals bind to. Used by
 * the coordinator, the CLI (`extension validate`) and the web UI (permission review).
 */

import { createHash } from "node:crypto";
import {
  type ContributionPoint,
  type ExtensionContribution,
  type ExtensionDiagnostic,
  type ExtensionManifest,
  ProtocolValidationError,
  validateExtensionManifest,
} from "@ablationkit/protocol";
import { validateBackendManifest } from "./backend-validation.ts";

/** The extension host API this build implements. Extensions declare a compatible range. */
export const HOST_API_VERSION = "2.0.0";

/** Manifest file name inside `.ablationkit/extensions/<id>/`. */
export const MANIFEST_FILE = "manifest.json";
/** Where project-scoped extensions live in a checkout. */
export const EXTENSIONS_DIR = ".ablationkit/extensions";

// ---------------------------------------------------------------------------- semver

type Version = [number, number, number, string | undefined];

export function parseVersion(v: string): Version | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return Math.sign(d);
  }
  // A pre-release sorts before its release.
  if (x[3] === y[3]) return 0;
  if (x[3] === undefined) return 1;
  if (y[3] === undefined) return -1;
  return x[3] < y[3] ? -1 : 1;
}

/**
 * Does `version` satisfy `range`? Supported: exact `1.2.3`, `^1.2.3`, `~1.2.3`, and space-joined
 * comparators (`>=1.0.0 <2.0.0`). Returns undefined when the range itself is not understood.
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const r = range.trim();
  if (!r) return undefined;
  const caret = /^\^(\S+)$/.exec(r);
  if (caret) {
    const base = parseVersion(caret[1] as string);
    if (!base) return undefined;
    const [maj, min, pat] = base;
    const upper = maj > 0 ? `${maj + 1}.0.0` : min > 0 ? `0.${min + 1}.0` : `0.0.${pat + 1}`;
    return compareVersions(version, caret[1] as string) >= 0 && compareVersions(version, upper) < 0;
  }
  const tilde = /^~(\S+)$/.exec(r);
  if (tilde) {
    const base = parseVersion(tilde[1] as string);
    if (!base) return undefined;
    const upper = `${base[0]}.${base[1] + 1}.0`;
    return compareVersions(version, tilde[1] as string) >= 0 && compareVersions(version, upper) < 0;
  }
  const parts = r.split(/\s+/);
  let ok = true;
  for (const p of parts) {
    const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(p);
    if (!m) return undefined;
    const c = compareVersions(version, m[2] as string);
    switch (m[1] ?? "=") {
      case ">=":
        ok &&= c >= 0;
        break;
      case "<=":
        ok &&= c <= 0;
        break;
      case ">":
        ok &&= c > 0;
        break;
      case "<":
        ok &&= c < 0;
        break;
      default:
        ok &&= c === 0;
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------- catalogs

export type PointKind = "ui" | "python" | "action";

export interface PointInfo {
  readonly point: ContributionPoint;
  readonly kind: PointKind;
  readonly where: string;
  readonly description: string;
}

export const CONTRIBUTION_POINTS: readonly PointInfo[] = [
  {
    point: "project.panel",
    kind: "ui",
    where: "Project → Overview, below the summary",
    description: "A dashboard panel for the project.",
  },
  {
    point: "run.tab",
    kind: "ui",
    where: "Runs → a run → an extra tab",
    description: "A run inspector; receives the run ID as context.",
  },
  {
    point: "comparison.view",
    kind: "ui",
    where: "Runs → Compare → an extra view",
    description: "A comparison view; receives the selected run IDs.",
  },
  {
    point: "report.block",
    kind: "ui",
    where: "Knowledge → a report → Extension blocks",
    description:
      "A report figure. Saving a snapshot stores a static fallback, so the report stays legible after the extension is removed.",
  },
  {
    point: "model.demo",
    kind: "ui",
    where: "Models → Demos",
    description:
      "An interactive model demo. Predictions go through the `inference.*` / `llm.*` bridge with allowlisted models and quotas.",
  },
  {
    point: "project.action",
    kind: "action",
    where: "Project → Overview → Actions, and the command palette",
    description: "A button that runs one allowlisted coordinator operation.",
  },
  {
    point: "project.analysis",
    kind: "python",
    where: "Extensions → Run, or a paired view or action",
    description: "A run-to-completion Python analysis over authorized project data.",
  },
  {
    point: "run.evaluator",
    kind: "python",
    where: "A run → Evaluate with an extension",
    description:
      "A Python evaluator for one run; its metrics and artifacts are logged to MLflow through the coordinator.",
  },
];

export function pointInfo(point: string): PointInfo | undefined {
  return CONTRIBUTION_POINTS.find((p) => p.point === point);
}

export type CapabilityRisk = "read" | "write" | "compute" | "inference" | "egress" | "host";

export interface CapabilityInfo {
  readonly id: string;
  readonly risk: CapabilityRisk;
  readonly description: string;
  /** A `capability_config` section this capability requires. */
  readonly config?: "inference" | "llm";
  /** Enforced by the coordinator on every call, or recorded and labelled only. */
  readonly enforcement: "enforced" | "advisory";
}

export const CAPABILITIES: readonly CapabilityInfo[] = [
  ...[
    "backend.execute",
    "services.call",
    "tracking.read",
    "tracking.write",
    "data.read",
    "data.write",
    "events.publish",
    "events.subscribe",
    "executions.start",
    "credentials.use",
    "compute.remote",
  ].map((id) => ({
    id,
    risk: "host" as const,
    description: `Use the scoped ${id} backend broker service. Backend code is trusted local code.`,
    enforcement: "enforced" as const,
  })),
  {
    id: "project.files",
    risk: "host",
    description:
      "Trusted backend code can access files as your OS user; this declaration is not a filesystem sandbox.",
    enforcement: "advisory",
  },
  {
    id: "project.runs.read",
    risk: "read",
    description: "Read this project's runs: parameters, tags, latest metrics and metric history.",
    enforcement: "enforced",
  },
  {
    id: "project.artifacts.preview",
    risk: "read",
    description: "List a run's artifacts and preview small text, JSON and image artifacts.",
    enforcement: "enforced",
  },
  {
    id: "project.research.read",
    risk: "read",
    description: "Read this project's hypotheses, notes, reports and decisions.",
    enforcement: "enforced",
  },
  {
    id: "project.research.write",
    risk: "write",
    description: "Create research notes, attributed to the extension.",
    enforcement: "enforced",
  },
  {
    id: "project.reports.generate",
    risk: "write",
    description: "Generate an evidence-linked report for a study.",
    enforcement: "enforced",
  },
  {
    id: "project.models.read",
    risk: "read",
    description: "List logged and registered models and read their signatures.",
    enforcement: "enforced",
  },
  {
    id: "project.analysis.execute",
    risk: "compute",
    description:
      "Run this extension's own Python contributions under their declared CPU, memory and time limits.",
    enforcement: "enforced",
  },
  {
    id: "project.results.write",
    risk: "write",
    description:
      "Log Python results (metrics and artifacts) to MLflow through the coordinator, as a run tagged with the extension.",
    enforcement: "enforced",
  },
  {
    id: "inference.predict",
    risk: "inference",
    description: "Run one-shot predictions on the allowlisted models, within the request quota.",
    config: "inference",
    enforcement: "enforced",
  },
  {
    id: "inference.compare",
    risk: "inference",
    description: "Compare allowlisted models on the same inputs, within the request quota.",
    config: "inference",
    enforcement: "enforced",
  },
  {
    id: "llm.infer",
    risk: "inference",
    description:
      "Call the allowlisted LLM targets through the project's data controls, within the call quota.",
    config: "llm",
    enforcement: "enforced",
  },
  {
    id: "llm.compare",
    risk: "inference",
    description: "Compare allowlisted LLM targets on the same inputs, within the call quota.",
    config: "llm",
    enforcement: "enforced",
  },
  {
    id: "trace.read",
    risk: "read",
    description: "Read this project's traces, filtered by its capture policy.",
    enforcement: "enforced",
  },
  {
    id: "evaluation.read",
    risk: "read",
    description: "Read classical and GenAI evaluation results (held-out expectations are hidden).",
    enforcement: "enforced",
  },
  {
    id: "network.egress",
    risk: "egress",
    description:
      "Python may use the network. Without it the runner starts Python in an empty network namespace where the host allows it.",
    enforcement: "advisory",
  },
  {
    id: "gpu",
    risk: "host",
    description: "Python may see GPUs. Without it `CUDA_VISIBLE_DEVICES` is empty (advisory).",
    enforcement: "advisory",
  },
];

export function capabilityInfo(id: string): CapabilityInfo | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/** Allowlisted operations a `project.action` may name, and the capability each needs. */
export const ACTION_OPERATIONS: Readonly<
  Record<string, { capability: string; description: string }>
> = {
  "extension.python.run": {
    capability: "project.analysis.execute",
    description: "Run one of this extension's Python contributions (`target`).",
  },
  "report.generate": {
    capability: "project.reports.generate",
    description: "Generate a report for a study (`params.study`).",
  },
  "research.note.create": {
    capability: "project.research.write",
    description: "Create a note (`params.title`, optional `params.body`).",
  },
};

/**
 * Methods a sandboxed view may call through the message bridge, and the capability each needs.
 * `null`: no capability (context and navigation stay inside the host). Everything else is denied.
 */
export const BRIDGE_METHODS: Readonly<Record<string, string | null>> = {
  "context.get": null,
  "host.navigate": null,
  "runs.list": "project.runs.read",
  "runs.get": "project.runs.read",
  "runs.metric_history": "project.runs.read",
  "artifacts.list": "project.artifacts.preview",
  "artifacts.preview": "project.artifacts.preview",
  "research.list": "project.research.read",
  "models.list": "project.models.read",
  "inference.describe": "inference.predict",
  "inference.predict": "inference.predict",
  "inference.compare": "inference.compare",
  "llm.infer": "llm.infer",
  "llm.compare": "llm.compare",
  "traces.get": "trace.read",
  "evaluations.examples": "evaluation.read",
  "evaluations.get": "evaluation.read",
  "python.run": "project.analysis.execute",
  "python.execution": "project.analysis.execute",
  // Called by the host page itself after the researcher confirms in host UI (never forwarded
  // from a frame): `host.save_result` and `host.save_snapshot` in the SDK.
  "inference.save": "inference.predict|inference.compare",
  // Answered for report.block views only, after the researcher confirms in host UI.
  "report.snapshot": null,
};

/** Bridge methods a frame may send; `host.*` are answered by the host page, not the coordinator. */
export const FRAME_METHODS: readonly string[] = [
  ...Object.keys(BRIDGE_METHODS).filter((m) => m !== "inference.save" && m !== "report.snapshot"),
  "host.save_result",
  "host.save_snapshot",
];

/** Methods a Python contribution may call through its broker pipe. */
export const PYTHON_BROKER_METHODS: Readonly<Record<string, string | null>> = {
  "context.get": null,
  "runs.list": "project.runs.read",
  "runs.get": "project.runs.read",
  "runs.metric_history": "project.runs.read",
  "research.list": "project.research.read",
  "models.list": "project.models.read",
};

/** Bare imports a UI entry may use; the host supplies them. Anything else is refused. */
export const ALLOWED_UI_IMPORTS = [
  "@ablationkit/extension-sdk",
  "@ablationkit/extension-sdk/react",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
] as const;

export function importAllowed(spec: string): boolean {
  return (ALLOWED_UI_IMPORTS as readonly string[]).includes(spec);
}

// ---------------------------------------------------------------------------- hashing

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** One hash over a sorted list of (path, file hash): any added, removed or changed file changes it. */
export function treeHash(files: readonly { path: string; sha256: string }[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.sha256}  ${f.path}\n`);
  return sha256(lines.join(""));
}

/**
 * What an approval binds besides code: requested capabilities and their bounds, Python limits,
 * GPU and network, and the contribution list. Changing any of these invalidates an approval.
 */
export function capabilityHash(m: ExtensionManifest): string {
  return sha256(
    canonicalJson({
      capabilities: [...m.capabilities].sort(),
      capability_config: m.capability_config ?? null,
      backend: m.backend ?? null,
      python: m.python
        ? {
            max_runtime_seconds: m.python.max_runtime_seconds,
            max_memory_mb: m.python.max_memory_mb,
            cpu_percent: m.python.cpu_percent ?? null,
            gpu: m.python.gpu,
            network: m.python.network,
          }
        : null,
      contributes: m.contributes,
      host_api: m.host_api,
    }),
  );
}

/** Content-derived build ID. */
export function buildId(parts: {
  source_sha256: string;
  capability_sha256: string;
  host_api_version: string;
}): string {
  return `eb-${sha256(`${parts.source_sha256}\n${parts.capability_sha256}\n${parts.host_api_version}`).slice(0, 16)}`;
}

// ---------------------------------------------------------------------------- validation

/** Files never hashed, copied or bundled: caches and local environments. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "dist",
  ".git",
]);
export const MAX_EXTENSION_FILES = 2000;
export const MAX_EXTENSION_BYTES = 20 * 1024 * 1024;

const UI_ENTRY_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*\.(tsx|ts|jsx|js)$/;
const PY_ENTRY_RE = /^([A-Za-z0-9_][A-Za-z0-9_./-]*\.py):([A-Za-z_][A-Za-z0-9_]*)$/;

/** A relative path that stays inside the extension directory. */
export function safeRelative(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return !p.split("/").some((s) => s === ".." || s === "");
}

export function parsePythonEntry(entry: string): { file: string; func: string } | undefined {
  const m = PY_ENTRY_RE.exec(entry);
  return m ? { file: m[1] as string, func: m[2] as string } : undefined;
}

export interface ValidationResult {
  readonly manifest?: ExtensionManifest;
  readonly diagnostics: ExtensionDiagnostic[];
  readonly ok: boolean;
}

function diag(
  out: ExtensionDiagnostic[],
  level: "error" | "warning",
  code: string,
  message: string,
  extra: { path?: string; fix?: string } = {},
): void {
  out.push({ level, code, message, ...extra });
}

/**
 * Validate a manifest against the schema and the host's rules. `files` lists the extension's
 * relative file paths; `dirName` is the directory it was found in.
 */
export function validateManifest(
  raw: unknown,
  opts: { files: readonly string[]; dirName?: string; hostApiVersion?: string },
): ValidationResult {
  const out: ExtensionDiagnostic[] = [];
  const host = opts.hostApiVersion ?? HOST_API_VERSION;
  let m: ExtensionManifest;
  try {
    m = validateExtensionManifest(raw);
  } catch (e) {
    if (!(e instanceof ProtocolValidationError)) throw e;
    for (const issue of e.issues.slice(0, 20))
      diag(out, "error", "manifest_schema", issue, {
        path: MANIFEST_FILE,
        fix: "See docs/extensions/README.md for the manifest schema.",
      });
    return { diagnostics: out, ok: false };
  }
  const files = new Set(opts.files);
  if (opts.dirName !== undefined && opts.dirName !== m.id)
    diag(
      out,
      "error",
      "id_mismatch",
      `manifest id \`${m.id}\` differs from its directory \`${opts.dirName}\``,
      {
        path: MANIFEST_FILE,
        fix: `Rename the directory to ${m.id} or change \`id\`.`,
      },
    );

  // Host API compatibility (criterion 15b: actionable diagnostics).
  const fits = satisfies(host, m.host_api) || (!m.backend && satisfies("1.0.0", m.host_api));
  if (fits === undefined)
    diag(out, "error", "host_api_range", `host_api \`${m.host_api}\` is not a supported range`, {
      fix: "Use a range such as `^1.0.0`, `~1.0.0` or `>=1.0.0 <2.0.0`.",
    });
  else if (!fits)
    diag(
      out,
      "error",
      "host_api_incompatible",
      `this host implements extension API ${host}, which \`${m.host_api}\` does not include`,
      {
        fix: `Port the extension to API ${host} and set \`host_api\` to \`^${host}\`, or run it on a host whose API matches. docs/extensions/README.md covers host API compatibility.`,
      },
    );

  if (!m.backend && !m.contributes.length)
    diag(out, "error", "empty_extension", "Declare contributions or a backend.");
  if (m.backend) {
    for (const message of validateBackendManifest({
      id: m.id,
      version: m.version,
      host_api: m.host_api,
      capabilities: m.capabilities,
      ...m.backend,
    }))
      diag(out, "error", "backend_contract", message);
    if (!safeRelative(m.backend.entry))
      diag(out, "error", "backend_entry", "Backend entry must be a relative path.");
    if (!m.capabilities.includes("backend.execute"))
      diag(
        out,
        "error",
        "backend_capability",
        "Backends require backend.execute (trusted local code).",
      );
    for (const p of [...m.backend.pages.map((x) => x.entry), ...m.backend.job_sdks])
      if (!safeRelative(p))
        diag(out, "error", "backend_path", "Backend assets must use relative paths.");
    const ids = new Set<string>();
    for (const op of m.backend.operations) {
      if (ids.has(op.id)) diag(out, "error", "duplicate_operation", `Duplicate operation ${op.id}`);
      ids.add(op.id);
      if (!op.path.startsWith("/"))
        diag(out, "error", "operation_path", "Operation paths must begin with /.");
      if (op.agent && op.widens_data_controls)
        diag(
          out,
          "error",
          "agent_widens_data_controls",
          "Agent operations cannot widen data controls.",
        );
    }
  }
  // Capabilities.
  const caps = new Set(m.capabilities);
  if (caps.size !== m.capabilities.length)
    diag(out, "error", "duplicate_capability", "a capability is listed twice");
  for (const c of m.capabilities) {
    const info = capabilityInfo(c);
    if (!info) {
      diag(out, "error", "unknown_capability", `unknown capability \`${c}\``, {
        fix: `Known capabilities: ${CAPABILITIES.map((x) => x.id).join(", ")}.`,
      });
      continue;
    }
    if (info.config && !m.capability_config?.[info.config])
      diag(
        out,
        "error",
        "capability_config_missing",
        `\`${c}\` needs \`capability_config.${info.config}\``,
        {
          fix:
            info.config === "inference"
              ? 'List the allowed models and quotas: {"inference": {"models": ["name@alias"], "max_requests_per_hour": 100, "max_request_bytes": 65536}}.'
              : 'List the allowed targets and quotas: {"llm": {"targets": [{"provider_id": "local", "model": "…"}], "max_calls_per_hour": 50, "max_input_chars": 8000}}.',
        },
      );
  }
  for (const section of ["inference", "llm"] as const) {
    if (
      m.capability_config?.[section] &&
      !CAPABILITIES.some((c) => c.config === section && caps.has(c.id))
    )
      diag(
        out,
        "warning",
        "unused_capability_config",
        `\`capability_config.${section}\` is set but no capability uses it`,
      );
  }

  // Python settings.
  const hasPython = m.contributes.some((c) => pointInfo(c.point)?.kind === "python");
  if (m.python) {
    if (m.python.environment === "project") {
      if (m.python.project !== undefined || m.python.lockfile !== undefined)
        diag(
          out,
          "error",
          "project_environment_lockfile",
          "python.environment is `project`: the project's own uv.lock is used, so `python.project` and `python.lockfile` must be left out",
          {
            fix: "Remove python.project and python.lockfile, or set python.environment to `extension`.",
          },
        );
    } else {
      const lockfile = m.python.lockfile ?? "";
      if (!lockfile || !safeRelative(lockfile) || !files.has(lockfile))
        diag(
          out,
          "error",
          "lockfile_missing",
          `python.lockfile \`${lockfile}\` is not in the extension`,
          {
            path: lockfile || "manifest.json",
            fix: `Run \`uv lock\` in ${m.python.project ?? "the extension's Python project"} and commit the lockfile, or set python.environment to \`project\` to use the project's own environment.`,
          },
        );
      const pyDir = m.python.project ?? "python";
      const pyproject = pyDir === "." ? "pyproject.toml" : `${pyDir}/pyproject.toml`;
      if (!safeRelative(pyproject) || !files.has(pyproject))
        diag(out, "error", "pyproject_missing", `\`${pyproject}\` is missing`, {
          path: pyproject,
          fix: "Python contributions need a pyproject.toml whose dependencies are pinned by the lockfile.",
        });
    }
    if (m.python.network === "egress" && !caps.has("network.egress"))
      diag(
        out,
        "error",
        "network_not_requested",
        "python.network is `egress` but `network.egress` is not requested",
        {
          fix: "Add `network.egress` to capabilities, or set python.network to `none`.",
        },
      );
    if (m.python.gpu && !caps.has("gpu"))
      diag(
        out,
        "error",
        "gpu_not_requested",
        "python.gpu is true but the `gpu` capability is not requested",
        {
          fix: "Add `gpu` to capabilities, or set python.gpu to false.",
        },
      );
    if (!hasPython)
      diag(
        out,
        "warning",
        "python_unused",
        "python settings are present but nothing contributes Python",
      );
  } else if (hasPython) {
    diag(out, "error", "python_settings_missing", "Python contributions need a `python` section", {
      fix: "Add python.requires_python, project, lockfile, max_runtime_seconds, max_memory_mb, gpu and network.",
    });
  }
  if (hasPython && !caps.has("project.analysis.execute"))
    diag(
      out,
      "error",
      "execute_not_requested",
      "Python contributions need the `project.analysis.execute` capability",
    );

  // Contributions.
  const ids = new Set<string>();
  const pythonIds = new Set(
    m.contributes.filter((c) => pointInfo(c.point)?.kind === "python").map((c) => c.id),
  );
  for (const c of m.contributes) {
    if (ids.has(c.id))
      diag(out, "error", "duplicate_contribution", `contribution id \`${c.id}\` is used twice`);
    ids.add(c.id);
    checkContribution(c, files, caps, pythonIds, out);
  }
  if (
    m.contributes.some((c) => c.point === "model.demo") &&
    !caps.has("inference.predict") &&
    !caps.has("llm.infer")
  )
    diag(
      out,
      "warning",
      "demo_without_inference",
      "a model.demo contribution without `inference.predict` or `llm.infer` cannot make predictions",
    );

  const ok = !out.some((d) => d.level === "error");
  return { manifest: m, diagnostics: out, ok };
}

function checkContribution(
  c: ExtensionContribution,
  files: ReadonlySet<string>,
  caps: ReadonlySet<string>,
  pythonIds: ReadonlySet<string>,
  out: ExtensionDiagnostic[],
): void {
  const info = pointInfo(c.point) as PointInfo;
  const where = `contributes[${c.id}]`;
  if (info.kind === "ui") {
    if (!c.entry || !UI_ENTRY_RE.test(c.entry) || !safeRelative(c.entry))
      diag(
        out,
        "error",
        "ui_entry_invalid",
        `${where}: a ${c.point} needs a relative .tsx/.ts entry`,
        {
          fix: "For example `ui/src/View.tsx`.",
        },
      );
    else if (!files.has(c.entry))
      diag(out, "error", "entry_missing", `${where}: entry \`${c.entry}\` does not exist`, {
        path: c.entry,
      });
    if (c.target !== undefined && !pythonIds.has(c.target))
      diag(
        out,
        "error",
        "target_unknown",
        `${where}: target \`${c.target}\` is not one of this extension's Python contributions`,
      );
  } else if (info.kind === "python") {
    const p = c.entry ? parsePythonEntry(c.entry) : undefined;
    if (!p || !safeRelative(p.file))
      diag(
        out,
        "error",
        "python_entry_invalid",
        `${where}: a ${c.point} needs an entry \`path.py:function\``,
        {
          fix: "For example `python/analysis.py:analyze`.",
        },
      );
    else if (!files.has(p.file))
      diag(out, "error", "entry_missing", `${where}: \`${p.file}\` does not exist`, {
        path: p.file,
      });
  } else {
    const op = c.operation ? ACTION_OPERATIONS[c.operation] : undefined;
    if (!c.operation || !op) {
      diag(
        out,
        "error",
        "operation_not_allowed",
        `${where}: \`${c.operation ?? ""}\` is not an allowlisted operation`,
        {
          fix: `Allowed: ${Object.keys(ACTION_OPERATIONS).join(", ")}. Actions cannot run shell commands or call internal or MLflow APIs.`,
        },
      );
      return;
    }
    if (!caps.has(op.capability))
      diag(
        out,
        "error",
        "action_capability_missing",
        `${where}: \`${c.operation}\` needs the \`${op.capability}\` capability`,
      );
    if (c.operation === "extension.python.run" && (!c.target || !pythonIds.has(c.target)))
      diag(
        out,
        "error",
        "target_unknown",
        `${where}: \`extension.python.run\` needs \`target\`, the ID of one of this extension's Python contributions`,
      );
    if (c.entry !== undefined)
      diag(
        out,
        "warning",
        "action_entry_ignored",
        `${where}: actions take an operation, not an entry; \`entry\` is ignored`,
      );
  }
}

/** Plain-language summary of what an approval grants, for the review screen and the CLI. */
export function permissionSummary(m: ExtensionManifest): {
  capability: string;
  description: string;
  risk: CapabilityRisk;
  enforcement: "enforced" | "advisory";
  bounds?: string;
}[] {
  return m.capabilities.map((c) => {
    const info = capabilityInfo(c);
    let bounds: string | undefined;
    if (info?.config === "inference" && m.capability_config?.inference) {
      const i = m.capability_config.inference;
      bounds = `models ${i.models.join(", ")}; ${i.max_requests_per_hour} requests/hour; ${i.max_request_bytes} bytes/request`;
    } else if (info?.config === "llm" && m.capability_config?.llm) {
      const l = m.capability_config.llm;
      bounds = `targets ${l.targets.map((t) => `${t.provider_id}/${t.model}`).join(", ")}; ${l.max_calls_per_hour} calls/hour; ${l.max_input_chars} input chars`;
    } else if (c === "project.analysis.execute" && m.python) {
      bounds = `${m.python.max_runtime_seconds} s, ${m.python.max_memory_mb} MiB, ${m.python.cpu_percent ?? 100}% CPU, GPU ${m.python.gpu ? "yes" : "no"}, network ${m.python.network}`;
    }
    return {
      capability: c,
      description: info?.description ?? "unknown capability",
      risk: info?.risk ?? "host",
      enforcement: info?.enforcement ?? "advisory",
      ...(bounds ? { bounds } : {}),
    };
  });
}

/** Does `selector` (as the demo sent it) match an allowlist entry? Exact match only. */
export function modelAllowed(allow: readonly string[], selector: string): boolean {
  return allow.includes(selector);
}

/** Turn an allowlist entry into a model selector. */
export function parseModelEntry(
  e: string,
):
  | { model_id: string }
  | { name: string; alias: string }
  | { name: string; version: string }
  | undefined {
  if (/^m-[A-Za-z0-9_-]{1,64}$/.test(e)) return { model_id: e };
  const at = /^([A-Za-z0-9_.-][A-Za-z0-9_. -]{0,200})@([A-Za-z0-9_-]{1,100})$/.exec(e);
  if (at) return { name: at[1] as string, alias: at[2] as string };
  const ver = /^([A-Za-z0-9_.-][A-Za-z0-9_. -]{0,200})\/([0-9]{1,9})$/.exec(e);
  if (ver) return { name: ver[1] as string, version: ver[2] as string };
  return undefined;
}
