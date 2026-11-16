/**
 * Local project registry (`<home>/registry.json`, spec §5.1). Project IDs are stable; paths are
 * machine-specific and can be remapped without changing the ID. The repository-owned manifest
 * `.ablationkit/project.json` carries the ID, so re-registering a moved checkout finds it.
 */
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  diagnoseStorage,
  readGit,
  readJson,
  recoverJsonFile,
  writeJsonAtomic,
} from "@ablationkit/core";
import {
  type ProjectManifest,
  type ProjectRegistration,
  type ProjectRegistry,
  type TaskProfile,
  validateProjectManifest,
  validateProjectRegistry,
} from "@ablationkit/protocol";
import { HttpError } from "../http.ts";

export const MANIFEST_RELATIVE = join(".ablationkit", "project.json");
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return s.length > 0 ? s : "project";
}

export interface DoctorCheck {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

export interface DoctorReport {
  readonly project_id: string;
  readonly status: "ok" | "warn" | "fail";
  readonly checks: readonly DoctorCheck[];
}

function resolveDir(path: string): string {
  if (!path.startsWith("/"))
    throw new HttpError(
      400,
      "invalid_path",
      "path must be absolute (it is resolved on the coordinator)",
    );
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new HttpError(400, "invalid_path", `no such directory on the coordinator: ${path}`);
  }
  if (!statSync(real).isDirectory())
    throw new HttpError(400, "invalid_path", `not a directory: ${path}`);
  return real;
}

function readManifest(dir: string): ProjectManifest | undefined {
  const p = join(dir, MANIFEST_RELATIVE);
  try {
    return readJson(p, validateProjectManifest);
  } catch (e) {
    if ((e as { kind?: string }).kind === "missing") return undefined;
    throw new HttpError(422, "invalid_manifest", `${p}: ${(e as Error).message}`);
  }
}

export class ProjectRegistryService {
  private data: ProjectRegistry;

  constructor(
    readonly path: string,
    readonly stateDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    try {
      this.data = readJson(path, validateProjectRegistry);
    } catch (e) {
      if ((e as { kind?: string }).kind !== "missing") throw e;
      this.data = { schema_version: 1, projects: [] };
    }
  }

  static recover(path: string): ReturnType<typeof recoverJsonFile> {
    return recoverJsonFile(path, { validate: validateProjectRegistry });
  }

  private save(): void {
    writeJsonAtomic(this.path, this.data, { validate: validateProjectRegistry });
  }

  list(): readonly ProjectRegistration[] {
    return this.data.projects;
  }

  get(projectId: string): ProjectRegistration | undefined {
    return this.data.projects.find((p) => p.project_id === projectId);
  }

  require(projectId: string): ProjectRegistration {
    const p = this.get(projectId);
    if (!p) throw new HttpError(404, "project_not_found", `no registered project ${projectId}`);
    return p;
  }

  private byPath(path: string): ProjectRegistration | undefined {
    return this.data.projects.find((p) => p.path === path);
  }

  /**
   * Register a checkout. Uses the manifest's ID if one exists; otherwise writes a new manifest.
   * Rejects a path that is already registered, or a manifest ID registered at another path
   * (use `remap` for a moved checkout).
   */
  add(input: { path: string; name?: string; projectId?: string }): {
    project: ProjectRegistration;
    manifestCreated: boolean;
  } {
    const dir = resolveDir(input.path);
    const atPath = this.byPath(dir);
    if (atPath) {
      throw new HttpError(
        409,
        "path_registered",
        `${dir} is already registered as ${atPath.project_id}`,
        {
          project_id: atPath.project_id,
        },
      );
    }
    let manifest = readManifest(dir);
    let manifestCreated = false;
    if (manifest) {
      if (input.projectId && input.projectId !== manifest.project_id) {
        throw new HttpError(
          409,
          "id_mismatch",
          `manifest says ${manifest.project_id}, not ${input.projectId}`,
        );
      }
      const existing = this.get(manifest.project_id);
      if (existing) {
        throw new HttpError(
          409,
          "project_exists",
          `${manifest.project_id} is registered at ${existing.path}; remap it instead`,
          { project_id: existing.project_id, path: existing.path },
        );
      }
    } else {
      const name = input.name ?? basename(dir);
      let id = input.projectId ?? slugify(name);
      if (!ID_RE.test(id))
        throw new HttpError(400, "invalid_project_id", `invalid project id ${id}`);
      if (input.projectId && this.get(id))
        throw new HttpError(409, "project_exists", `${id} is already registered`);
      for (let n = 2; this.get(id); n++) id = `${slugify(name).slice(0, 55)}-${n}`;
      manifest = { schema_version: 1, project_id: id, name };
      mkdirSync(join(dir, ".ablationkit"), { recursive: true });
      writeJsonAtomic(join(dir, MANIFEST_RELATIVE), manifest, {
        validate: validateProjectManifest,
        mode: 0o644,
      });
      manifestCreated = true;
    }
    const ts = this.now().toISOString();
    const project: ProjectRegistration = {
      project_id: manifest.project_id,
      name: manifest.name,
      path: dir,
      registered_at: ts,
      updated_at: ts,
      previous_paths: [],
    };
    this.data.projects.push(project);
    this.save();
    mkdirSync(join(this.stateDir, project.project_id), { recursive: true, mode: 0o700 });
    return { project, manifestCreated };
  }

  /** Drop a registration (project removal, `project-removal.ts`); the caller moves its files aside. */
  remove(projectId: string): ProjectRegistration {
    const project = this.require(projectId);
    this.data = {
      ...this.data,
      projects: this.data.projects.filter((p) => p.project_id !== projectId),
    };
    this.save();
    return project;
  }

  /** Point an existing project at a new checkout path. The checkout's manifest must carry the same ID. */
  remap(projectId: string, newPath: string): ProjectRegistration {
    const project = this.require(projectId);
    const dir = resolveDir(newPath);
    if (dir === project.path) return project;
    const other = this.byPath(dir);
    if (other)
      throw new HttpError(
        409,
        "path_registered",
        `${dir} is already registered as ${other.project_id}`,
      );
    const manifest = readManifest(dir);
    if (!manifest) throw new HttpError(422, "no_manifest", `${dir} has no ${MANIFEST_RELATIVE}`);
    if (manifest.project_id !== projectId) {
      throw new HttpError(
        409,
        "id_mismatch",
        `${dir} belongs to ${manifest.project_id}, not ${projectId}`,
      );
    }
    project.previous_paths.push(project.path);
    project.path = dir;
    project.name = manifest.name;
    project.updated_at = this.now().toISOString();
    this.save();
    return project;
  }

  /** The checkout's manifest, read fresh (undefined if the checkout or manifest is missing). */
  manifest(projectId: string): ProjectManifest | undefined {
    const p = this.require(projectId);
    try {
      return readManifest(p.path);
    } catch {
      return undefined;
    }
  }

  /** Set task profiles in the repository-owned manifest (spec §2.2: visibility only). */
  setTaskProfiles(projectId: string, profiles: readonly TaskProfile[]): ProjectManifest {
    const p = this.require(projectId);
    const m = readManifest(p.path);
    if (!m) throw new HttpError(422, "no_manifest", `${p.path} has no ${MANIFEST_RELATIVE}`);
    const { task_profiles: _old, ...rest } = m;
    const next: ProjectManifest = profiles.length
      ? { ...rest, task_profiles: [...new Set(profiles)] }
      : rest;
    writeJsonAtomic(join(p.path, MANIFEST_RELATIVE), next, {
      validate: validateProjectManifest,
      mode: 0o644,
    });
    return next;
  }

  doctor(projectId: string): DoctorReport {
    const p = this.require(projectId);
    const checks: DoctorCheck[] = [];
    const exists = existsSync(p.path) && statSync(p.path).isDirectory();
    checks.push({
      name: "checkout",
      status: exists ? "ok" : "fail",
      detail: exists ? p.path : `${p.path} is missing; remap the project to its new location`,
    });
    if (exists) {
      try {
        const m = readManifest(p.path);
        if (!m)
          checks.push({
            name: "manifest",
            status: "fail",
            detail: `${MANIFEST_RELATIVE} is missing`,
          });
        else if (m.project_id !== projectId) {
          checks.push({
            name: "manifest",
            status: "fail",
            detail: `manifest ID is ${m.project_id}`,
          });
        } else
          checks.push({ name: "manifest", status: "ok", detail: `${m.project_id} (${m.name})` });
      } catch (e) {
        checks.push({ name: "manifest", status: "fail", detail: (e as Error).message });
      }
      const git = existsSync(join(p.path, ".git"));
      checks.push({
        name: "git",
        status: git ? "ok" : "warn",
        detail: git
          ? "Git repository"
          : "not a Git repository; source-control features will be unavailable",
      });
      const uncommitted = git ? manifestUncommitted(p.path) : undefined;
      if (uncommitted)
        checks.push({
          name: "manifest committed",
          status: "warn",
          detail: `${MANIFEST_RELATIVE} is ${uncommitted}: remote runs use the committed tree (git add ${MANIFEST_RELATIVE} && git commit)`,
        });
    }
    const state = join(this.stateDir, projectId);
    const findings = existsSync(state) ? diagnoseStorage(state) : [];
    checks.push({
      name: "state",
      status: findings.length ? "warn" : "ok",
      detail: findings.length
        ? `${findings.length} storage finding(s): ${findings.map((f) => f.kind).join(", ")}`
        : state,
    });
    const status = checks.some((c) => c.status === "fail")
      ? "fail"
      : checks.some((c) => c.status === "warn")
        ? "warn"
        : "ok";
    return { project_id: projectId, status, checks };
  }
}

/** How the manifest differs from the checkout's HEAD, or undefined (committed, or no usable Git). */
function manifestUncommitted(dir: string): string | undefined {
  const r = readGit(dir, ["status", "--porcelain", "--ignored", "--", MANIFEST_RELATIVE], {
    timeoutMs: 10_000,
  });
  if (r.code !== 0) return undefined;
  const code = r.stdout.slice(0, 2);
  if (!code.trim()) return undefined;
  return code === "??"
    ? "not committed"
    : code === "!!"
      ? "ignored by Git"
      : "changed since the last commit";
}
