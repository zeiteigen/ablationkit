/**
 * A project's agent container configuration (ADR 0061): its defaults and the checks the schema
 * cannot make. Pure.
 */
import type { ContainerConfig } from "@ablationkit/protocol";
import { parsePattern } from "./allowlist.ts";

/** The image `ablationkit agent image build` builds; the default for every project. */
export const DEFAULT_IMAGE = "localhost/ablationkit-agent:1";

/**
 * Package indexes and Python downloads: what an environment build reaches, never the agent
 * (ADR 0066). PyTorch's index answers on one host and serves wheels from the other.
 */
export const PACKAGE_HOSTS: readonly string[] = [
  "pypi.org",
  "files.pythonhosted.org",
  "download.pytorch.org",
  "download-r2.pytorch.org",
  "releases.astral.sh",
];

/**
 * What a new project's agents may reach besides their harness's own hosts: code on GitHub,
 * Hugging Face, and where papers live. Not package indexes: agents install nothing themselves
 * (ADR 0066).
 */
export const DEFAULT_ALLOW: readonly string[] = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "huggingface.co",
  "*.huggingface.co",
  "*.hf.co",
  "arxiv.org",
  "*.arxiv.org",
  "api.semanticscholar.org",
  "openreview.net",
  "*.openreview.net",
  "doi.org",
  "api.crossref.org",
];

/**
 * What a new project's environment builds may reach: the package indexes, uv's Python downloads
 * (astral.sh and GitHub release assets) and Git dependencies on GitHub.
 */
export const DEFAULT_ENVIRONMENT_ALLOW: readonly string[] = [
  ...PACKAGE_HOSTS,
  "github.com",
  "*.githubusercontent.com",
];

/** The hosts the project's environment builds may reach. */
export function environmentAllow(c: ContainerConfig): readonly string[] {
  return c.environment?.allow ?? DEFAULT_ENVIRONMENT_ALLOW;
}

/**
 * A configuration from before environment builds (ADR 0066), brought up to date: the package
 * hosts move from the agent's allowlist to the environment's. `undefined` when it is current.
 */
export function migrateConfig(c: ContainerConfig, at: string): ContainerConfig | undefined {
  if (c.environment) return undefined;
  return {
    ...c,
    revision: c.revision + 1,
    updated_at: at,
    updated_by: "ADR 0066: package hosts moved to environment builds",
    egress: { ...c.egress, allow: c.egress.allow.filter((h) => !PACKAGE_HOSTS.includes(h)) },
    environment: { allow: [...DEFAULT_ENVIRONMENT_ALLOW] },
  };
}

export function defaultContainerConfig(
  projectId: string,
  at: string,
  by = "system",
): ContainerConfig {
  return {
    schema_version: 1,
    project_id: projectId,
    revision: 1,
    updated_at: at,
    updated_by: by,
    image: DEFAULT_IMAGE,
    agent: { cpus: 4, memory_mb: 8192, pids_max: 4096 },
    egress: { mode: "allowlist", allow: [...DEFAULT_ALLOW] },
    environment: { allow: [...DEFAULT_ENVIRONMENT_ALLOW] },
    hidden: [],
    read_only: [],
    jobs: { gpu: "all", network: "none" },
    evaluations: [],
    credentials: [],
    host_code: "refuse",
    pause_on_compute_limit: true,
  };
}

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function relativeInside(p: string): boolean {
  return !p.startsWith("/") && !p.split("/").includes("..") && p.trim() === p && p.length > 0;
}

function absoluteClean(p: string): boolean {
  return p.startsWith("/") && !p.split("/").includes("..");
}

/** Resolve a config path (absolute, or relative to the checkout) to an absolute path. */
export function resolveConfigPath(checkout: string, p: string): string {
  const joined = p.startsWith("/") ? p : `${checkout.replace(/\/+$/, "")}/${p}`;
  return joined.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
}

/** Is `child` the same path as `parent`, or inside it? Both absolute and normalized. */
export function within(parent: string, child: string): boolean {
  const p = parent.replace(/\/+$/, "");
  return child === p || child.startsWith(`${p}/`);
}

/**
 * What is wrong with a configuration the schema accepted: paths with `..`, an invalid host
 * pattern, an environment name, a credential without exactly one source, an evaluation that mounts
 * something not hidden, duplicate names. Empty when it is fine.
 */
export function configProblems(c: ContainerConfig): string[] {
  const out: string[] = [];
  for (const h of c.egress.allow)
    if (!parsePattern(h)) out.push(`egress.allow: ${JSON.stringify(h)} is not a host pattern`);
  for (const h of c.environment?.allow ?? [])
    if (!parsePattern(h)) out.push(`environment.allow: ${JSON.stringify(h)} is not a host pattern`);
  for (const p of c.hidden)
    if (!(relativeInside(p) || absoluteClean(p)))
      out.push(`hidden: ${JSON.stringify(p)} must be absolute or inside the checkout, without ..`);
  for (const p of c.read_only)
    if (!relativeInside(p))
      out.push(`read_only: ${JSON.stringify(p)} must be a path inside the checkout, without ..`);
  // A path both hidden and read-only would be mounted over its own mask.
  const bare = (p: string) => p.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  for (const p of c.read_only)
    for (const h of c.hidden)
      if (relativeInside(p) && relativeInside(h) && within(bare(h), bare(p)))
        out.push(
          `read_only: ${JSON.stringify(p)} is hidden (${JSON.stringify(h)}): a hidden path is never mounted`,
        );
  const names = new Set<string>();
  for (const e of c.evaluations) {
    if (names.has(e.name)) out.push(`evaluations: ${e.name} is defined twice`);
    names.add(e.name);
    if (e.cwd !== undefined && !relativeInside(e.cwd))
      out.push(`evaluations.${e.name}.cwd must be inside the checkout`);
    for (const m of e.mounts)
      if (!c.hidden.includes(m))
        out.push(
          `evaluations.${e.name}.mounts: ${JSON.stringify(m)} is not in hidden (an evaluation mounts only what agents cannot see)`,
        );
  }
  const creds = new Set<string>();
  for (const k of c.credentials) {
    if (creds.has(k.name)) out.push(`credentials: ${k.name} is defined twice`);
    creds.add(k.name);
    if ((k.from_env === undefined) === (k.from_file === undefined))
      out.push(`credentials.${k.name}: give exactly one of from_env and from_file`);
    for (const name of Object.keys(k.env))
      if (!ENV_RE.test(name))
        out.push(`credentials.${k.name}.env: ${JSON.stringify(name)} is not a variable name`);
  }
  return out;
}
