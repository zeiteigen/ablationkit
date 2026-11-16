/**
 * The Level 1 extension host (spec §8 with the §7.11 trust model; criteria 15, 15a, 15b, 15f, 9d;
 * ADR 0022).
 *
 * - **Discovery**: extension source lives in the checkout under `.ablationkit/extensions/<id>/`.
 * - **Build**: copies the source into an immutable, content-addressed snapshot under the
 *   coordinator's state, bundles each UI entry with Bun's bundler (only the SDK and React may be
 *   imported; no plugins, scripts or downloads) and creates the Python environment from the
 *   lockfile with `uv sync --locked --no-build --no-install-project` (wheels only, so no package
 *   build or install scripts run).
 * - **Approval** (human API only: `extension.approve`, `extension.enable`, `extension.rollback`): binds the build's source, lockfile,
 *   capability, bundle and environment hashes in one project. Code only ever runs from an
 *   approved snapshot, so a changed source runs only after its own build is approved.
 * - **Mounting**: UI contributions render in an opaque-origin iframe (`sandbox allow-scripts`,
 *   `connect-src 'none'`); their only channel is the host page's message bridge, which forwards
 *   allowlisted methods to `rpc()`. The coordinator rechecks the project, the active approved
 *   build, the capability, quotas and payload size on every call.
 * - **Disable, rollback, safe mode**: only the researcher disables, enables or rolls back to an
 *   earlier approved build. In safe mode nothing mounts or runs.
 */

import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { gitArchive, gitCommit, readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  ACTION_OPERATIONS,
  BRIDGE_METHODS,
  buildId,
  CAPABILITIES,
  capabilityHash,
  EXTENSIONS_DIR,
  HOST_API_VERSION,
  IGNORED_DIRS,
  importAllowed,
  MANIFEST_FILE,
  MAX_EXTENSION_BYTES,
  MAX_EXTENSION_FILES,
  modelAllowed,
  parseModelEntry,
  permissionSummary,
  pointInfo,
  safeRelative,
  satisfies,
  sha256,
  treeHash,
  validateManifest,
} from "@ablationkit/extension-host";
import type { BackendLegacyPlan } from "@ablationkit/extension-host/backend";
import type {
  ExtensionActor,
  ExtensionApproval,
  ExtensionBuildRecord,
  ExtensionContribution,
  ExtensionDiagnostic,
  ExtensionManifest,
  ExtensionState,
} from "@ablationkit/protocol";
import { validateExtensionBuildRecord, validateExtensionState } from "@ablationkit/protocol";
import { MlflowError } from "@ablationkit/tracking-mlflow";
import type { BunPlugin } from "bun";
import { HttpError } from "../http.ts";
import type { ModelSelector } from "../models/models.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";
import { backendBuildPolicy, rejectBuildMacros } from "./build-policy.ts";
import { ExtensionRunner } from "./runner.ts";

type Json = Record<string, unknown>;

export const SDK_DIR = resolve(import.meta.dir, "../../../../packages/extension-sdk");
const BUILD_TIMEOUT_MS = 600_000;
const MAX_RPC_BYTES = 1024 * 1024;
const MAX_CONSOLE = 200;
const HOUR_MS = 3_600_000;
const ID_RE = /^[a-z][a-z0-9-]{1,62}$/;

export type ExtensionStatus =
  | "invalid"
  | "needs_build"
  | "needs_approval"
  | "active"
  | "active_outdated"
  | "disabled"
  | "removed"
  | "safe_mode";

export interface ConsoleLine {
  readonly at: string;
  readonly level: "info" | "warn" | "error";
  readonly source: string;
  readonly message: string;
}

export interface Mount {
  readonly extension_id: string;
  readonly build_id: string;
  readonly contribution: ExtensionContribution;
  readonly frame_url: string;
  readonly capabilities: readonly string[];
  readonly trusted_code: boolean;
}

interface SourceScan {
  readonly dir: string;
  readonly files: { path: string; sha256: string; bytes: number }[];
  readonly problems: ExtensionDiagnostic[];
}

export class ExtensionService {
  readonly runner: ExtensionRunner;
  readonly loadProblems: string[] = [];
  private readonly states = new Map<string, ExtensionState>();
  private readonly builds = new Map<string, ExtensionBuildRecord>();
  private readonly consoles = new Map<string, ConsoleLine[]>();
  private readonly quotas = new Map<string, number[]>();
  private readonly costs = new Map<string, { at: number; usd: number }[]>();
  /** Inference results a demo produced: result ID → `pid/ext`. */
  private readonly results = new Map<string, string>();
  private readonly building = new Map<string, Promise<ExtensionBuildRecord>>();

  constructor(
    private readonly o: {
      readonly svc: () => Services;
      readonly stateDir: string;
      readonly homeDir: string;
      readonly now: () => Date;
      readonly safeMode: boolean;
      readonly uv: string;
      readonly supervisor: "auto" | "systemd" | "direct";
      readonly maxConcurrent: number;
      /** ADR 0045: unless set, a successful build is enabled as it is built. */
      readonly requireApproval?: boolean;
    },
  ) {
    this.runner = new ExtensionRunner({
      svc: o.svc,
      stateDir: o.stateDir,
      now: o.now,
      supervisor: o.supervisor,
      maxConcurrent: o.maxConcurrent,
      host: this,
    });
  }

  private get svc(): Services {
    return this.o.svc();
  }

  get safeMode(): boolean {
    return this.o.safeMode;
  }

  // ------------------------------------------------------------------ paths and records

  private extDir(pid: string, ext: string): string {
    return join(this.o.stateDir, pid, "extensions", ext);
  }
  private statePath(pid: string, ext: string): string {
    return join(this.extDir(pid, ext), "state.json");
  }
  buildDir(pid: string, ext: string, eb: string): string {
    return join(this.extDir(pid, ext), "builds", eb);
  }
  registryDir(): string {
    return join(this.o.homeDir, "extensions");
  }
  checkoutDir(pid: string, ext: string): string {
    return join(this.svc.registry.require(pid).path, EXTENSIONS_DIR, ext);
  }

  /** Drop a removed project's extension state, builds and executions from memory. */
  forgetProject(pid: string): void {
    const prefix = `${pid}/`;
    for (const m of [
      this.states,
      this.builds,
      this.consoles,
      this.quotas,
      this.costs,
      this.building,
    ])
      for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
    for (const [k, v] of [...this.results]) if (v.startsWith(prefix)) this.results.delete(k);
    this.runner.forgetProject(pid);
  }

  /** Extension executions of a project still running (project removal refuses these). */
  running(pid: string) {
    return this.runner.running(pid);
  }

  load(pids: readonly string[]): void {
    for (const pid of pids) {
      const root = join(this.o.stateDir, pid, "extensions");
      if (!existsSync(root)) continue;
      for (const ext of readdirSync(root)) {
        if (!ID_RE.test(ext)) continue;
        const sp = this.statePath(pid, ext);
        if (existsSync(sp)) {
          try {
            this.states.set(`${pid}/${ext}`, readJson(sp, validateExtensionState));
          } catch {
            this.loadProblems.push(sp);
          }
        }
        const bd = join(this.extDir(pid, ext), "builds");
        if (!existsSync(bd)) continue;
        for (const eb of readdirSync(bd)) {
          const f = join(bd, eb, "build.json");
          if (!/^eb-[a-f0-9]{16}$/.test(eb) || !existsSync(f)) continue;
          try {
            this.builds.set(`${pid}/${eb}`, readJson(f, validateExtensionBuildRecord));
          } catch {
            this.loadProblems.push(f);
          }
        }
      }
    }
    this.runner.load(pids);
    this.loadProblems.push(...this.runner.loadProblems);
  }

  start(): void {
    this.runner.start();
  }

  async shutdown(): Promise<void> {
    await this.runner.shutdown();
  }

  state(pid: string, ext: string): ExtensionState | undefined {
    return this.states.get(`${pid}/${ext}`);
  }

  private saveState(s: ExtensionState): void {
    mkdirSync(this.extDir(s.project_id, s.extension_id), { recursive: true });
    writeJsonAtomic(this.statePath(s.project_id, s.extension_id), s, {
      validate: validateExtensionState,
    });
    this.states.set(`${s.project_id}/${s.extension_id}`, s);
  }

  build(pid: string, eb: string): ExtensionBuildRecord | undefined {
    return this.builds.get(`${pid}/${eb}`);
  }

  buildsOf(pid: string, ext: string): ExtensionBuildRecord[] {
    return [...this.builds.values()]
      .filter((b) => b.project_id === pid && b.extension_id === ext)
      .sort((a, b) => (a.built_at < b.built_at ? 1 : -1));
  }

  approval(pid: string, ext: string, eb: string): ExtensionApproval | undefined {
    return this.state(pid, ext)?.approvals.findLast((a) => a.build_id === eb);
  }

  /**
   * The build's source snapshot still holds the bytes the researcher approved (spec §7.11: changes
   * invalidate approval). Added files count: a planted module could shadow an import.
   */
  assertApprovedSource(pid: string, ext: string, b: ExtensionBuildRecord): void {
    const root = join(this.buildDir(pid, ext, b.build_id), "src");
    if (treeHash(this.scan(root).files) !== b.source_sha256)
      throw new HttpError(
        409,
        "extension_changed",
        `the source snapshot of ${ext} ${b.build_id} changed after approval; rebuild and approve it again`,
      );
  }

  // ------------------------------------------------------------------ source

  /** Every file under `dir`, hashed, skipping caches and local environments. */
  scan(dir: string): SourceScan {
    const files: SourceScan["files"] = [];
    const problems: ExtensionDiagnostic[] = [];
    let total = 0;
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const full = join(d, name);
        const rel = relative(dir, full);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) {
          problems.push({
            level: "error",
            code: "symlink_not_allowed",
            message: `${rel} is a symbolic link; extensions must be plain files`,
            path: rel,
            fix: "Replace the link with the file it points to.",
          });
          continue;
        }
        if (st.isDirectory()) {
          if (!IGNORED_DIRS.has(name)) walk(full);
          continue;
        }
        if (!st.isFile()) continue;
        if (name.endsWith(".pyc")) continue;
        total += st.size;
        if (files.length >= MAX_EXTENSION_FILES || total > MAX_EXTENSION_BYTES) {
          problems.push({
            level: "error",
            code: "too_large",
            message: `extensions are limited to ${MAX_EXTENSION_FILES} files and ${MAX_EXTENSION_BYTES} bytes`,
          });
          return;
        }
        files.push({ path: rel, sha256: sha256(readFileSync(full)), bytes: st.size });
      }
    };
    if (existsSync(dir)) walk(dir);
    return { dir, files, problems };
  }

  /** Validate the checkout source of one extension and compute the hashes a build would get. */
  inspect(
    pid: string,
    ext: string,
  ): {
    present: boolean;
    manifest?: ExtensionManifest;
    raw?: unknown;
    diagnostics: ExtensionDiagnostic[];
    ok: boolean;
    files: SourceScan["files"];
    source_sha256?: string;
    lockfile_sha256?: string;
    capability_sha256?: string;
    build_id?: string;
    project_commit?: string;
  } {
    if (!ID_RE.test(ext)) throw new HttpError(400, "invalid_request", "invalid extension id");
    const dir = this.checkoutDir(pid, ext);
    if (!existsSync(join(dir, MANIFEST_FILE)))
      return { present: existsSync(dir), diagnostics: [], ok: false, files: [] };
    const scan = this.scan(dir);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
    } catch (e) {
      return {
        present: true,
        diagnostics: [
          {
            level: "error",
            code: "manifest_json",
            message: `manifest.json is not valid JSON: ${(e as Error).message}`,
            path: MANIFEST_FILE,
          },
        ],
        ok: false,
        files: scan.files,
      };
    }
    const v = validateManifest(raw, {
      files: scan.files.map((f) => f.path),
      dirName: ext,
    });
    const diagnostics = [...scan.problems, ...v.diagnostics];
    const ok = v.ok && !scan.problems.some((p) => p.level === "error");
    if (!v.manifest) return { present: true, raw, diagnostics, ok: false, files: scan.files };
    const m = v.manifest;
    const source_sha256 = treeHash(scan.files);
    const lock = m.python ? scan.files.find((f) => f.path === m.python?.lockfile) : undefined;
    const capability_sha256 = capabilityHash(m);
    // Environment `project` (ADR 0046): the build is of this extension *and* the checkout's
    // commit, so a new commit makes a new build.
    let projectCommit: string | undefined;
    if (m.python?.environment === "project") {
      projectCommit = gitCommit(this.svc.registry.require(pid).path);
      if (!projectCommit)
        return {
          present: true,
          manifest: m,
          raw,
          diagnostics: [
            ...diagnostics,
            {
              level: "error",
              code: "project_commit_missing",
              message:
                "python.environment is `project`, but the checkout has no Git commit to build the environment from",
              fix: "Commit the project (with its uv.lock), or set python.environment to `extension`.",
            },
          ],
          ok: false,
          files: scan.files,
        };
    }
    return compact({
      present: true,
      manifest: m,
      raw,
      diagnostics,
      ok,
      files: scan.files,
      source_sha256,
      lockfile_sha256: lock?.sha256,
      capability_sha256,
      build_id: buildId({
        source_sha256: projectCommit
          ? sha256(`${source_sha256}\nproject ${projectCommit}`)
          : source_sha256,
        capability_sha256,
        host_api_version: HOST_API_VERSION,
      }),
      project_commit: projectCommit,
    });
  }

  /** Extension directories in the checkout plus extensions this project has state for. */
  ids(pid: string): string[] {
    const ids = new Set<string>();
    const d = join(this.svc.registry.require(pid).path, EXTENSIONS_DIR);
    if (existsSync(d))
      for (const n of readdirSync(d))
        if (ID_RE.test(n) && statSync(join(d, n)).isDirectory()) ids.add(n);
    for (const s of this.states.values()) if (s.project_id === pid) ids.add(s.extension_id);
    return [...ids].sort();
  }

  status(pid: string, ext: string, inspected = this.inspect(pid, ext)): ExtensionStatus {
    const st = this.state(pid, ext);
    if (!inspected.present) return st ? "removed" : "invalid";
    if (!inspected.ok) return st?.enabled && st.active_build ? "active_outdated" : "invalid";
    if (st && !st.enabled && st.approvals.length) return "disabled";
    const active = st?.enabled ? st.active_build : undefined;
    if (active && this.approval(pid, ext, active)) {
      if (this.o.safeMode) return "safe_mode";
      return active === inspected.build_id ? "active" : "active_outdated";
    }
    const b = inspected.build_id ? this.build(pid, inspected.build_id) : undefined;
    return b?.status === "ready" ? "needs_approval" : "needs_build";
  }

  /** Is this build the one that may run now? */
  activeBuild(pid: string, ext: string): ExtensionBuildRecord | undefined {
    if (this.o.safeMode) return undefined;
    const st = this.state(pid, ext);
    if (!st?.enabled || !st.active_build) return undefined;
    if (!this.approval(pid, ext, st.active_build)) return undefined;
    // Removing the source from the checkout revokes the extension (spec §5.6.1 demo removal).
    if (!existsSync(join(this.checkoutDir(pid, ext), MANIFEST_FILE))) return undefined;
    const b = this.build(pid, st.active_build);
    return b?.status === "ready" ? b : undefined;
  }

  backendBundle(pid: string, ext: string) {
    const b = this.activeBuild(pid, ext);
    if (!b?.manifest.backend || !b.backend) return undefined;
    const approval = this.approval(pid, ext, b.build_id);
    if (!approval) return undefined;
    const root = join(this.buildDir(pid, ext, b.build_id), "src");
    if (sha256(readFileSync(join(root, b.backend.file))) !== b.backend.sha256)
      throw new HttpError(409, "extension_changed", "Backend bundle hash changed");
    for (const file of b.files)
      if (sha256(readFileSync(join(root, file.path))) !== file.sha256)
        throw new HttpError(409, "extension_changed", "Extension source snapshot changed");
    return {
      root,
      manifest: {
        id: ext,
        version: b.version,
        host_api: b.manifest.host_api,
        capabilities: approval.capabilities,
        ...b.manifest.backend,
        entry: b.backend.file,
      },
    };
  }
  list(pid: string): Json[] {
    return this.ids(pid).map((ext) => this.summary(pid, ext));
  }

  summary(pid: string, ext: string): Json {
    const i = this.inspect(pid, ext);
    const st = this.state(pid, ext);
    const active = st?.active_build ? this.build(pid, st.active_build) : undefined;
    const m = i.manifest ?? active?.manifest;
    return compact({
      extension_id: ext,
      name: m?.name,
      version: m?.version,
      description: m?.description,
      status: this.status(pid, ext, i),
      enabled: st?.enabled ?? false,
      active_build: st?.active_build,
      active_version: active?.version,
      checkout_build: i.build_id,
      errors: i.diagnostics.filter((d) => d.level === "error").length,
      warnings: i.diagnostics.filter((d) => d.level === "warning").length,
      contributes: m?.contributes.map((c) => ({ id: c.id, point: c.point, title: c.title })),
      capabilities: m?.capabilities,
      trusted_code: !!m?.python,
      safe_mode: this.o.safeMode,
    });
  }

  detail(pid: string, ext: string): Json {
    const i = this.inspect(pid, ext);
    const st = this.state(pid, ext);
    if (!i.present && !st)
      throw new HttpError(404, "not_found", `no extension ${ext} in this project`);
    const builds = this.buildsOf(pid, ext);
    const m = i.manifest;
    return compact({
      ...this.summary(pid, ext),
      host_api_version: HOST_API_VERSION,
      host_api_compatible: m
        ? satisfies(HOST_API_VERSION, m.host_api) === true ||
          (!m.backend && satisfies("1.0.0", m.host_api) === true)
        : undefined,
      manifest: m ?? i.raw,
      diagnostics: i.diagnostics,
      source: compact({
        path: relative(this.svc.registry.require(pid).path, this.checkoutDir(pid, ext)),
        files: i.files,
        source_sha256: i.source_sha256,
        lockfile_sha256: i.lockfile_sha256,
        capability_sha256: i.capability_sha256,
      }),
      permissions: m ? permissionSummary(m) : undefined,
      python: m?.python,
      builds: builds.map((b) => this.buildView(pid, b)),
      approvals: st?.approvals ?? [],
      disabled: st?.disabled_at
        ? compact({ at: st.disabled_at, by: st.disabled_by, reason: st.disabled_reason })
        : undefined,
      enforcement: {
        ui: "enforced: opaque-origin sandboxed iframe, no network (connect-src 'none'), capability checks in the coordinator",
        python:
          "limits enforced by systemd when available; Python runs as trusted code under your user (it could read your files), so approval is advisory against malicious code",
      },
      console: this.consoles.get(`${pid}/${ext}`) ?? [],
    });
  }

  buildView(pid: string, b: ExtensionBuildRecord): Json {
    const a = this.approval(pid, b.extension_id, b.build_id);
    return compact({
      build_id: b.build_id,
      version: b.version,
      status: b.status,
      built_at: b.built_at,
      built_by: b.built_by,
      source_sha256: b.source_sha256,
      lockfile_sha256: b.lockfile_sha256,
      capability_sha256: b.capability_sha256,
      bundle_sha256: b.bundle_sha256,
      python: b.python,
      ui: b.ui,
      capabilities: b.manifest.capabilities,
      approved: a
        ? compact({ at: a.approved_at, by: a.approved_by, automatic: a.automatic })
        : undefined,
      active: this.state(pid, b.extension_id)?.active_build === b.build_id,
      diagnostics: b.diagnostics,
    });
  }

  // ------------------------------------------------------------------ build

  async buildExtension(
    pid: string,
    ext: string,
    actor: ExtensionActor,
  ): Promise<ExtensionBuildRecord> {
    const i = this.inspect(pid, ext);
    if (!i.present) throw new HttpError(404, "not_found", `no extension ${ext} in the checkout`);
    if (!i.ok || !i.manifest || !i.build_id)
      throw new HttpError(422, "extension_invalid", `${ext} does not validate`, {
        diagnostics: i.diagnostics,
      });
    const key = `${pid}/${i.build_id}`;
    const existing = this.builds.get(key);
    if (existing?.status === "ready") {
      // A build made before ADR 0045 (or while approval was required) and never enabled.
      if (!this.approval(pid, ext, existing.build_id))
        this.enableOnBuild(pid, ext, existing, actor);
      return existing;
    }
    const running = this.building.get(key);
    if (running) return running;
    const p = this.doBuild(
      pid,
      ext,
      i as Required<typeof i> & { project_commit?: string },
      actor,
    ).finally(() => this.building.delete(key));
    this.building.set(key, p);
    return p;
  }

  private async doBuild(
    pid: string,
    ext: string,
    i: {
      manifest: ExtensionManifest;
      files: SourceScan["files"];
      source_sha256: string;
      capability_sha256: string;
      build_id: string;
      lockfile_sha256?: string;
      project_commit?: string;
      diagnostics: ExtensionDiagnostic[];
    },
    actor: ExtensionActor,
  ): Promise<ExtensionBuildRecord> {
    const eb = i.build_id;
    const final = this.buildDir(pid, ext, eb);
    const tmp = `${final}.tmp-${randomBytes(4).toString("hex")}`;
    rmSync(final, { recursive: true, force: true });
    mkdirSync(join(tmp, "src"), { recursive: true, mode: 0o700 });
    const from = this.checkoutDir(pid, ext);
    // Snapshot exactly the hashed files, then re-hash the copy: what was hashed is what runs.
    for (const f of i.files) {
      const dst = join(tmp, "src", f.path);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(join(from, f.path), dst);
    }
    const copied = this.scan(join(tmp, "src")).files;
    if (treeHash(copied) !== i.source_sha256) {
      rmSync(tmp, { recursive: true, force: true });
      throw new HttpError(
        409,
        "source_changed",
        "the source changed while it was being built; build again",
      );
    }
    const diagnostics: ExtensionDiagnostic[] = i.diagnostics.filter((d) => d.level === "warning");
    const m = i.manifest;
    // UI bundles.
    const ui: ExtensionBuildRecord["ui"] = [];
    mkdirSync(join(tmp, "ui"), { recursive: true });
    for (const c of m.contributes) {
      if (pointInfo(c.point)?.kind !== "ui" || !c.entry) continue;
      const r = await bundleEntry(join(tmp, "src"), c.entry);
      if (!r.ok) {
        diagnostics.push(...r.diagnostics);
        continue;
      }
      writeFileSync(join(tmp, "ui", `${c.id}.js`), r.js);
      if (r.css) writeFileSync(join(tmp, "ui", `${c.id}.css`), r.css);
      const bytes = Buffer.from(r.js + (r.css ?? ""));
      ui.push({
        contribution: c.id,
        file: `${c.id}.js`,
        sha256: sha256(bytes),
        bytes: bytes.length,
      });
    }
    let backend: ExtensionBuildRecord["backend"];
    if (m.backend) {
      const output = await Bun.build({
        entrypoints: [join(tmp, "src", m.backend.entry)],
        target: "bun",
        plugins: [backendBuildPolicy(join(tmp, "src"))],
      });
      if (!output.success)
        diagnostics.push({
          level: "error",
          code: "backend_build",
          message: output.logs.map(String).join("\n").slice(0, 2000),
        });
      else {
        const artifact = output.outputs[0];
        if (!artifact)
          throw new HttpError(500, "backend_build", "No backend artifact was produced");
        const bytes = Buffer.from(await artifact.arrayBuffer());
        writeFileSync(join(tmp, "src", "compiled-backend.js"), bytes);
        backend = { file: "compiled-backend.js", sha256: sha256(bytes) };
      }
    }
    // Python environment.
    let python: ExtensionBuildRecord["python"];
    if (m.python)
      python = await this.pythonEnv(join(tmp, "src"), join(tmp, "venv"), m, {
        pid,
        commit: i.project_commit,
      });
    if (python?.status === "failed")
      diagnostics.push({
        level: "error",
        code: "python_env_failed",
        message:
          `the Python environment could not be created from the lockfile: ${python.error ?? ""}`.slice(
            0,
            2000,
          ),
        fix: "Check that every dependency has a wheel for this platform (source builds are refused) and that `uv lock` is current.",
      });
    const failed = diagnostics.some((d) => d.level === "error");
    const rec: ExtensionBuildRecord = compact({
      schema_version: 1 as const,
      build_id: eb,
      project_id: pid,
      extension_id: ext,
      version: m.version,
      manifest: m,
      origin: "checkout" as const,
      files: i.files,
      source_sha256: i.source_sha256,
      lockfile_sha256: i.lockfile_sha256,
      capability_sha256: i.capability_sha256,
      bundle_sha256:
        ui.length || backend
          ? sha256([...ui.map((u) => u.sha256), ...(backend ? [backend.sha256] : [])].join("\n"))
          : undefined,
      backend,
      ui,
      python,
      host_api_version: HOST_API_VERSION,
      status: failed ? ("failed" as const) : ("ready" as const),
      diagnostics: diagnostics.slice(0, 200),
      built_by: actor,
      built_at: this.o.now().toISOString(),
    }) as ExtensionBuildRecord;
    writeJsonAtomic(join(tmp, "build.json"), rec, { validate: validateExtensionBuildRecord });
    renameSync(tmp, final);
    this.builds.set(`${pid}/${eb}`, rec);
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: actor.kind === "agent" ? "agent" : actor.kind === "human" ? "human" : "internal",
      action: "extension.build",
      outcome: failed ? "error" : "allowed",
      project_id: pid,
      target: `${ext}@${eb}`,
      details: { version: m.version, source_sha256: i.source_sha256, status: rec.status },
    });
    this.svc.events.publish(pid, "extension.built", {
      extension_id: ext,
      build_id: eb,
      status: rec.status,
    });
    if (!failed) this.enableOnBuild(pid, ext, rec, actor);
    return rec;
  }

  /**
   * Enabled by default (ADR 0045): a ready build becomes the active one, bound to its hashes like
   * an approval, unless the coordinator requires the researcher's approval. An extension the
   * researcher disabled stays disabled until they enable it again; a trusted backend (a
   * long-running process in the coordinator's broker) still waits for their approval.
   */
  private enableOnBuild(
    pid: string,
    ext: string,
    rec: ExtensionBuildRecord,
    actor: ExtensionActor,
  ): void {
    const st = this.state(pid, ext);
    const disabled = st !== undefined && !st.enabled && st.approvals.length > 0;
    if (this.o.requireApproval || disabled || rec.manifest.backend || !this.hostCompatible(rec))
      return;
    this.enableBuild(pid, ext, rec, actor, { automatic: true });
  }

  /** Whether approval or automatic enabling may proceed. */
  get requireApproval(): boolean {
    return this.o.requireApproval === true;
  }

  private hostCompatible(b: ExtensionBuildRecord): boolean {
    return (
      satisfies(HOST_API_VERSION, b.manifest.host_api) === true ||
      (!b.manifest.backend && satisfies("1.0.0", b.manifest.host_api) === true)
    );
  }

  private envRebuilds = new Map<string, Promise<void>>();

  /**
   * A restored coordinator has no Python environments (backups leave them out, ADR 0025): the
   * first run rebuilds the build's venv from its own snapshot and lockfile. The result must match
   * the environment recorded at build time, or the run is refused.
   */
  ensurePythonEnv(pid: string, ext: string, eb: string): Promise<void> {
    const b = this.builds.get(`${pid}/${eb}`);
    const dir = this.buildDir(pid, ext, eb);
    if (b?.python?.status !== "ready" || !b.manifest.python) return Promise.resolve();
    if (existsSync(join(dir, "venv", "bin", "python"))) return Promise.resolve();
    const key = `${pid}/${eb}`;
    const inflight = this.envRebuilds.get(key);
    if (inflight) return inflight;
    const want = b.python.environment_sha256;
    const run = (async () => {
      const tmp = join(dir, `venv.rebuild-${randomBytes(4).toString("hex")}`);
      try {
        const got = await this.pythonEnv(join(dir, "src"), tmp, b.manifest, {
          pid,
          commit: b.python?.project_commit,
        });
        if (got.status !== "ready")
          throw new HttpError(
            503,
            "python_env_rebuild_failed",
            `the Python environment of ${ext}@${eb} could not be rebuilt from its lockfile: ${got.error ?? ""}`.slice(
              0,
              2000,
            ),
          );
        if (want && got.environment_sha256 !== want)
          throw new HttpError(
            409,
            "python_env_mismatch",
            `the rebuilt environment of ${ext}@${eb} differs from the approved one (Python ${got.python_version} vs ${b.python?.python_version}); rebuild and approve the extension again`,
          );
        rmSync(join(dir, "venv"), { recursive: true, force: true });
        renameSync(tmp, join(dir, "venv"));
        this.svc.audit.record({
          actor: { kind: "system" },
          listener: "internal",
          action: "extension.env.rebuild",
          outcome: "allowed",
          project_id: pid,
          target: `${ext}@${eb}`,
          details: { environment_sha256: got.environment_sha256 },
        });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        this.envRebuilds.delete(key);
      }
    })();
    this.envRebuilds.set(key, run);
    return run;
  }

  private async pythonEnv(
    src: string,
    venv: string,
    m: ExtensionManifest,
    at: { pid: string; commit?: string | undefined },
  ): Promise<NonNullable<ExtensionBuildRecord["python"]>> {
    const py = m.python as NonNullable<ExtensionManifest["python"]>;
    // Environment `project` (ADR 0046): the checkout's committed tree at `commit`, its uv.lock,
    // and its own package installed non-editable, so the contribution imports the project's code
    // as of that commit (never the working tree).
    let project = join(src, py.project ?? "python");
    let projectLock: string | undefined;
    if (py.environment === "project") {
      if (!at.commit) return { status: "failed", error: "no project commit to build from" };
      const tree = `${venv}.project`;
      rmSync(tree, { recursive: true, force: true });
      mkdirSync(tree, { recursive: true });
      const tar = `${tree}.tar`;
      const a = gitArchive(this.svc.registry.require(at.pid).path, at.commit, tar);
      if (a.code !== 0)
        return { status: "failed", error: `git archive ${at.commit}: ${a.stderr.trim()}` };
      const x = Bun.spawnSync(["tar", "-xf", tar, "-C", tree], { stderr: "pipe" });
      rmSync(tar, { force: true });
      if (x.exitCode !== 0)
        return { status: "failed", error: `unpacking the project: ${x.stderr.toString().trim()}` };
      if (!existsSync(join(tree, "uv.lock")) || !existsSync(join(tree, "pyproject.toml")))
        return {
          status: "failed",
          error: `the project's commit ${at.commit.slice(0, 12)} has no pyproject.toml and uv.lock at its root; commit them`,
        };
      projectLock = sha256(readFileSync(join(tree, "uv.lock")));
      project = tree;
    }
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: process.env["HOME"] ?? "/tmp",
      UV_PROJECT_ENVIRONMENT: venv,
      UV_NO_CONFIG: "1",
      UV_PYTHON_PREFERENCE: process.env["UV_PYTHON_PREFERENCE"] ?? "managed",
    };
    for (const k of [
      "UV_CACHE_DIR",
      "UV_OFFLINE",
      "UV_PYTHON_INSTALL_DIR",
      "XDG_CACHE_HOME",
      "UV_INDEX_URL",
      "UV_DEFAULT_INDEX",
    ])
      if (process.env[k]) env[k] = process.env[k] as string;
    const run = async (argv: string[]) => {
      const p = Bun.spawn(argv, { cwd: project, env, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => p.kill(), BUILD_TIMEOUT_MS);
      const [out, err] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      clearTimeout(timer);
      return { code: await p.exited, out, err };
    };
    const sync = await run([
      this.o.uv,
      "sync",
      "--locked",
      // Dependencies come as wheels only; with `project`, uv still builds the project's own
      // package (its build backend runs, as the trusted code it is).
      "--no-build",
      ...(py.environment === "project" ? ["--no-editable"] : ["--no-install-project"]),
      "--no-dev",
      "--project",
      project,
    ]);
    const done = () => {
      if (py.environment === "project") rmSync(project, { recursive: true, force: true });
    };
    if (sync.code !== 0) {
      done();
      return {
        status: "failed",
        error: (sync.err || sync.out).trim().slice(-3000) || `uv exited ${sync.code}`,
      };
    }
    const probe = await run([
      join(venv, "bin", "python"),
      "-I",
      "-c",
      "import json,sys,importlib.metadata as m;print(json.dumps({'python':'%d.%d.%d'%sys.version_info[:3],'packages':sorted(set(d.metadata['Name'].lower()+'=='+d.version for d in m.distributions()))}))",
    ]);
    done();
    if (probe.code !== 0) return { status: "failed", error: probe.err.trim().slice(-3000) };
    const info = JSON.parse(probe.out) as { python: string; packages: string[] };
    return compact({
      status: "ready" as const,
      python_version: info.python,
      packages: info.packages.slice(0, 500),
      environment_sha256: sha256(`${info.python}\n${info.packages.join("\n")}`),
      project_commit: py.environment === "project" ? at.commit : undefined,
      project_lockfile_sha256: projectLock,
    });
  }

  /** Source text of one file in a build snapshot (for review), at most 1 MiB. */
  sourceFile(pid: string, ext: string, eb: string, path: string): string {
    const b = this.build(pid, eb);
    if (!b || b.extension_id !== ext) throw new HttpError(404, "not_found", `no build ${eb}`);
    if (!safeRelative(path) || !b.files.some((f) => f.path === path))
      throw new HttpError(404, "not_found", `${path} is not in build ${eb}`);
    const buf = readFileSync(join(this.buildDir(pid, ext, eb), "src", path));
    if (buf.length > 1024 * 1024) return `(${buf.length} bytes; too large to show)`;
    return buf.toString("utf8");
  }

  /** Files that differ between a build and the last approved build (or the checkout). */
  diff(pid: string, ext: string, eb: string, against?: string): Json {
    const b = this.build(pid, eb);
    if (!b || b.extension_id !== ext) throw new HttpError(404, "not_found", `no build ${eb}`);
    const baseId =
      against ??
      this.state(pid, ext)
        ?.approvals.filter((a) => a.build_id !== eb)
        .at(-1)?.build_id;
    const base = baseId ? this.build(pid, baseId) : undefined;
    const before = new Map((base?.files ?? []).map((f) => [f.path, f]));
    const after = new Map(b.files.map((f) => [f.path, f]));
    const changes: Json[] = [];
    for (const [p, f] of after) {
      const old = before.get(p);
      if (!old) changes.push({ path: p, change: "added", after: this.sourceFile(pid, ext, eb, p) });
      else if (old.sha256 !== f.sha256)
        changes.push({
          path: p,
          change: "modified",
          before: this.sourceFile(pid, ext, base?.build_id as string, p),
          after: this.sourceFile(pid, ext, eb, p),
        });
    }
    for (const p of before.keys())
      if (!after.has(p))
        changes.push({
          path: p,
          change: "removed",
          before: this.sourceFile(pid, ext, base?.build_id as string, p),
        });
    return compact({
      build_id: eb,
      against: base?.build_id,
      capabilities_changed: base ? base.capability_sha256 !== b.capability_sha256 : undefined,
      lockfile_changed: base ? base.lockfile_sha256 !== b.lockfile_sha256 : undefined,
      capabilities: { before: base?.manifest.capabilities, after: b.manifest.capabilities },
      changes,
    });
  }

  // ------------------------------------------------------------------ approval and lifecycle

  private emptyState(pid: string, ext: string): ExtensionState {
    return {
      schema_version: 1,
      project_id: pid,
      extension_id: ext,
      enabled: false,
      approvals: [],
      updated_at: this.o.now().toISOString(),
    };
  }

  private record(
    pid: string,
    actor: ExtensionActor,
    action: string,
    target: string,
    details: Json,
  ) {
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: actor.kind === "agent" ? "agent" : actor.kind === "human" ? "human" : "internal",
      action,
      outcome: "allowed",
      project_id: pid,
      target,
      details,
    });
  }

  /** Approve a build in this project and make it active. Human API only. */
  approve(pid: string, ext: string, body: Json, actor: ExtensionActor): ExtensionState {
    this.svc.registry.require(pid);
    const eb = body["build_id"];
    if (typeof eb !== "string") throw new HttpError(400, "invalid_request", "give build_id");
    if (body["trusted_code"] !== true)
      throw new HttpError(
        400,
        "trusted_code_ack_required",
        "approving runs this extension's code as trusted code under your user; confirm with trusted_code: true",
      );
    const b = this.build(pid, eb);
    if (!b || b.extension_id !== ext)
      throw new HttpError(404, "not_found", `no build ${eb} of ${ext}`);
    if (b.status !== "ready")
      throw new HttpError(
        409,
        "build_failed",
        "this build failed; fix the diagnostics and build again",
        {
          diagnostics: b.diagnostics,
        },
      );
    if (!this.hostCompatible(b))
      throw new HttpError(
        409,
        "host_api_incompatible",
        `this host implements API ${HOST_API_VERSION}; the build needs ${b.manifest.host_api}`,
      );
    const note = body["note"];
    if (note !== undefined && (typeof note !== "string" || note.length > 2000))
      throw new HttpError(400, "invalid_request", "note must be at most 2000 characters");
    return this.enableBuild(pid, ext, b, actor, { note: note as string | undefined });
  }

  /** Record an approval of `b` (the researcher's, or automatic at build) and make it active. */
  private enableBuild(
    pid: string,
    ext: string,
    b: ExtensionBuildRecord,
    actor: ExtensionActor,
    opts: { automatic?: boolean; note?: string | undefined },
  ): ExtensionState {
    const eb = b.build_id;
    const note = opts.note;
    const st = this.state(pid, ext) ?? this.emptyState(pid, ext);
    const now = this.o.now().toISOString();
    const approval: ExtensionApproval = compact({
      build_id: b.build_id,
      version: b.version,
      source_sha256: b.source_sha256,
      lockfile_sha256: b.lockfile_sha256,
      capability_sha256: b.capability_sha256,
      bundle_sha256: b.bundle_sha256,
      environment_sha256: b.python?.environment_sha256,
      capabilities: [...b.manifest.capabilities],
      trusted_code: true as const,
      automatic: opts.automatic ? true : undefined,
      approved_by: actor,
      approved_at: now,
      note,
    }) as ExtensionApproval;
    const next: ExtensionState = {
      schema_version: 1,
      project_id: pid,
      extension_id: ext,
      enabled: true,
      active_build: b.build_id,
      approvals: [...st.approvals, approval].slice(-200),
      updated_at: now,
    };
    this.saveState(next);
    this.record(
      pid,
      actor,
      opts.automatic ? "extension.enable_on_build" : "extension.approve",
      `${ext}@${eb}`,
      {
        version: b.version,
        source_sha256: b.source_sha256,
        lockfile_sha256: b.lockfile_sha256,
        capability_sha256: b.capability_sha256,
        capabilities: b.manifest.capabilities,
      },
    );
    this.svc.events.publish(pid, "extension.activated", { extension_id: ext, build_id: eb });
    return next;
  }

  async disable(
    pid: string,
    ext: string,
    body: Json,
    actor: ExtensionActor,
  ): Promise<ExtensionState> {
    this.svc.registry.require(pid);
    const st = this.state(pid, ext);
    if (!st) throw new HttpError(404, "not_found", `${ext} was never approved in this project`);
    const reason =
      typeof body["reason"] === "string" ? (body["reason"] as string).slice(0, 500) : undefined;
    const now = this.o.now().toISOString();
    const next: ExtensionState = compact({
      ...st,
      enabled: false,
      disabled_at: now,
      disabled_by: actor,
      disabled_reason: reason,
      updated_at: now,
    }) as ExtensionState;
    this.saveState(next);
    this.clearQuotas(pid, ext);
    const stopped = await this.runner.cancelAll(pid, ext, "the extension was disabled");
    await this.svc.backends.stop(pid, ext);
    this.record(
      pid,
      actor,
      "extension.disable",
      ext,
      compact({ reason, executions_stopped: stopped }),
    );
    this.svc.events.publish(pid, "extension.disabled", { extension_id: ext });
    return next;
  }

  /** Re-enable the active approved build, or roll back to an earlier approved one. Human only. */
  activate(
    pid: string,
    ext: string,
    eb: string | undefined,
    actor: ExtensionActor,
  ): ExtensionState {
    this.svc.registry.require(pid);
    const st = this.state(pid, ext);
    if (!st) throw new HttpError(404, "not_found", `${ext} was never approved in this project`);
    const target = eb ?? st.active_build;
    if (!target) throw new HttpError(409, "no_build", "nothing to activate");
    if (!this.approval(pid, ext, target))
      throw new HttpError(
        409,
        "not_approved",
        `build ${target} is not approved in this project; approve it first`,
      );
    const b = this.build(pid, target);
    if (b?.status !== "ready")
      throw new HttpError(
        409,
        "build_missing",
        `build ${target} is missing or failed; build again`,
      );
    const now = this.o.now().toISOString();
    const rollback = eb !== undefined && eb !== st.active_build;
    const next: ExtensionState = {
      schema_version: 1,
      project_id: pid,
      extension_id: ext,
      enabled: true,
      active_build: target,
      approvals: st.approvals,
      updated_at: now,
    };
    this.saveState(next);
    this.clearQuotas(pid, ext);
    this.record(
      pid,
      actor,
      rollback ? "extension.rollback" : "extension.enable",
      `${ext}@${target}`,
      {
        from: st.active_build,
        to: target,
        version: b.version,
      },
    );
    this.svc.events.publish(pid, "extension.activated", { extension_id: ext, build_id: target });
    return next;
  }

  // ------------------------------------------------------------------ user registry (portability)

  /** Copy a checkout extension into the user-level registry (`~/.ablationkit/extensions/<id>/<version>/`). */
  publish(pid: string, ext: string, actor: ExtensionActor): Json {
    const i = this.inspect(pid, ext);
    if (!i.ok || !i.manifest)
      throw new HttpError(422, "extension_invalid", `${ext} does not validate`, {
        diagnostics: i.diagnostics,
      });
    const dest = join(this.registryDir(), ext, i.manifest.version);
    if (existsSync(dest)) {
      const there = treeHash(this.scan(dest).files);
      if (there !== i.source_sha256)
        throw new HttpError(
          409,
          "version_exists",
          `${ext} ${i.manifest.version} is already in the registry with different source; bump the version`,
        );
    } else {
      const tmp = `${dest}.tmp-${randomBytes(4).toString("hex")}`;
      for (const f of i.files) {
        mkdirSync(dirname(join(tmp, f.path)), { recursive: true });
        cpSync(join(this.checkoutDir(pid, ext), f.path), join(tmp, f.path));
      }
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(tmp, dest);
    }
    this.record(pid, actor, "extension.publish", ext, {
      version: i.manifest.version,
      source_sha256: i.source_sha256,
    });
    return { extension_id: ext, version: i.manifest.version, source_sha256: i.source_sha256 };
  }

  registryList(): Json[] {
    const root = this.registryDir();
    if (!existsSync(root)) return [];
    const out: Json[] = [];
    for (const ext of readdirSync(root)
      .filter((x) => ID_RE.test(x))
      .sort())
      for (const v of readdirSync(join(root, ext))
        .filter((x) => /^\d+\.\d+\.\d+/.test(x) && !x.includes(".tmp-"))
        .sort()) {
        let m: Json | undefined;
        try {
          m = JSON.parse(readFileSync(join(root, ext, v, MANIFEST_FILE), "utf8")) as Json;
        } catch {
          m = undefined;
        }
        out.push(
          compact({
            extension_id: ext,
            version: v,
            name: m?.["name"],
            host_api: m?.["host_api"],
            compatible:
              typeof m?.["host_api"] === "string"
                ? satisfies(HOST_API_VERSION, m["host_api"] as string) === true ||
                  (!m["backend"] && satisfies("1.0.0", m["host_api"] as string) === true)
                : false,
          }),
        );
      }
    return out;
  }

  /**
   * Install a registry extension into this project's checkout. Nothing is enabled: the project
   * needs its own build and approval (criteria 15b, 15f).
   */
  install(pid: string, ext: string, version: string, actor: ExtensionActor): Json {
    if (!ID_RE.test(ext) || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
      throw new HttpError(400, "invalid_request", "invalid extension id or version");
    const from = join(this.registryDir(), ext, version);
    if (!existsSync(join(from, MANIFEST_FILE)))
      throw new HttpError(404, "not_found", `${ext} ${version} is not in the registry`);
    const raw = JSON.parse(readFileSync(join(from, MANIFEST_FILE), "utf8")) as Json;
    const scan = this.scan(from);
    const v = validateManifest(raw, { files: scan.files.map((f) => f.path), dirName: ext });
    if (!v.ok)
      throw new HttpError(422, "extension_invalid", `${ext} ${version} cannot be installed here`, {
        diagnostics: v.diagnostics,
      });
    const dest = this.checkoutDir(pid, ext);
    if (existsSync(dest)) {
      if (treeHash(this.scan(dest).files) === treeHash(scan.files))
        return { extension_id: ext, version, installed: false, reason: "already installed" };
      throw new HttpError(
        409,
        "exists",
        `${dest} already exists with different source; remove it first`,
      );
    }
    for (const f of scan.files) {
      mkdirSync(dirname(join(dest, f.path)), { recursive: true });
      cpSync(join(from, f.path), join(dest, f.path));
    }
    this.record(pid, actor, "extension.install", ext, {
      version,
      source_sha256: treeHash(scan.files),
    });
    this.svc.events.publish(pid, "extension.installed", { extension_id: ext, version });
    return {
      extension_id: ext,
      version,
      installed: true,
      path: relative(this.svc.registry.require(pid).path, dest),
    };
  }

  // ------------------------------------------------------------------ mounts and frames

  mounts(pid: string, point?: string): Mount[] {
    const out: Mount[] = [];
    for (const ext of this.ids(pid)) {
      const b = this.activeBuild(pid, ext);
      if (!b) continue;
      const a = this.approval(pid, ext, b.build_id) as ExtensionApproval;
      for (const c of b.manifest.contributes) {
        if (point && c.point !== point) continue;
        const kind = pointInfo(c.point)?.kind;
        if (kind === "python") continue;
        if (kind === "ui" && !b.ui.some((u) => u.contribution === c.id)) continue;
        out.push({
          extension_id: ext,
          build_id: b.build_id,
          contribution: c,
          frame_url: kind === "ui" ? `/ext-frame/${pid}/${ext}/${b.build_id}/${c.id}` : "",
          capabilities: a.capabilities,
          trusted_code: !!b.manifest.python,
        });
      }
    }
    return out;
  }

  /** The sandboxed frame document for one UI contribution. */
  frame(
    pid: string,
    ext: string,
    eb: string,
    cid: string,
    opts: { preview: boolean; ancestors: string[] },
  ): Response {
    this.svc.registry.require(pid);
    const b = this.build(pid, eb);
    if (!b || b.extension_id !== ext) throw new HttpError(404, "not_found", "no such build");
    if (!opts.preview && this.activeBuild(pid, ext)?.build_id !== eb)
      throw new HttpError(
        403,
        "extension_inactive",
        "this build is not the active approved build in this project",
      );
    const u = b.ui.find((x) => x.contribution === cid);
    if (!u) throw new HttpError(404, "not_found", "no such contribution");
    const dir = join(this.buildDir(pid, ext, eb), "ui");
    const js = readFileSync(join(dir, u.file), "utf8");
    if (
      sha256(
        Buffer.from(
          js +
            (existsSync(join(dir, `${cid}.css`))
              ? readFileSync(join(dir, `${cid}.css`), "utf8")
              : ""),
        ),
      ) !== u.sha256
    )
      throw new HttpError(
        409,
        "bundle_tampered",
        "the bundle on disk does not match its recorded hash; rebuild",
      );
    const css = existsSync(join(dir, `${cid}.css`))
      ? readFileSync(join(dir, `${cid}.css`), "utf8")
      : "";
    const nonce = randomBytes(16).toString("base64");
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${FRAME_BASE_CSS}</style><style>${escapeTag(css, "style")}</style></head><body><div id="root"></div><script type="module" nonce="${nonce}">${escapeTag(js, "script")}</script></body></html>`;
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        // `sandbox` without allow-same-origin gives the document an opaque origin even when it is
        // opened directly; connect-src 'none' leaves it no network at all.
        "content-security-policy": [
          "sandbox allow-scripts",
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          "style-src 'unsafe-inline'",
          "img-src data: blob:",
          "font-src data:",
          "media-src data: blob:",
          "connect-src 'none'",
          "frame-src 'none'",
          "worker-src 'none'",
          "form-action 'none'",
          "base-uri 'none'",
          `frame-ancestors ${opts.ancestors.length ? opts.ancestors.join(" ") : "'self'"}`,
        ].join("; "),
      },
    });
  }

  // ------------------------------------------------------------------ console

  log(
    pid: string,
    ext: string,
    level: ConsoleLine["level"],
    source: string,
    message: string,
  ): void {
    const k = `${pid}/${ext}`;
    const lines = this.consoles.get(k) ?? [];
    lines.push({
      at: this.o.now().toISOString(),
      level,
      source: source.slice(0, 80),
      message: message.slice(0, 4000),
    });
    if (lines.length > MAX_CONSOLE) lines.splice(0, lines.length - MAX_CONSOLE);
    this.consoles.set(k, lines);
  }

  // ------------------------------------------------------------------ quotas

  private clearQuotas(pid: string, ext: string): void {
    for (const k of [...this.quotas.keys()])
      if (k.startsWith(`${pid}/${ext}/`)) this.quotas.delete(k);
  }

  private take(pid: string, ext: string, bucket: string, perHour: number): void {
    const k = `${pid}/${ext}/${bucket}`;
    const t = this.o.now().getTime();
    const xs = (this.quotas.get(k) ?? []).filter((x) => x > t - HOUR_MS);
    if (xs.length >= perHour)
      throw new HttpError(
        429,
        "quota_exceeded",
        `${ext} may make ${perHour} ${bucket} calls per hour`,
        {
          retry_after_sec: Math.ceil(((xs[0] as number) + HOUR_MS - t) / 1000),
        },
      );
    xs.push(t);
    this.quotas.set(k, xs);
  }

  // ------------------------------------------------------------------ the capability bridge

  /**
   * One bridge call from a mounted view, forwarded by the host page with the researcher's session.
   * Checked here on every call: safe mode, the project, the active approved build, the
   * contribution, the method allowlist, the capability, quotas and sizes.
   */
  async rpc(
    pid: string,
    ext: string,
    body: Json,
    actor: ExtensionActor,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const method = body["method"];
    const eb = body["build_id"];
    const cid = body["contribution"];
    const params = (body["params"] ?? {}) as Json;
    const deny = (status: number, code: string, message: string): never => {
      this.svc.audit.record({
        actor: compact({ kind: actor.kind, id: actor.id }),
        listener: "human",
        action: "extension.rpc",
        outcome: "denied",
        project_id: pid,
        target: ext,
        details: compact({
          method: typeof method === "string" ? method.slice(0, 80) : undefined,
          code,
        }),
      });
      this.log(pid, ext, "warn", "bridge", `${String(method)}: ${message}`);
      throw new HttpError(status, code, message);
    };
    if (typeof method !== "string" || typeof eb !== "string" || typeof cid !== "string")
      return deny(400, "invalid_request", "give method, build_id and contribution");
    if (typeof params !== "object" || params === null || Array.isArray(params))
      return deny(400, "invalid_request", "params must be an object");
    if (this.o.safeMode) return deny(503, "safe_mode", "extensions are inactive in safe mode");
    this.svc.registry.require(pid);
    const b = this.activeBuild(pid, ext);
    if (!b)
      return deny(403, "extension_inactive", `${ext} is not enabled and approved in this project`);
    if (b.build_id !== eb)
      return deny(409, "extension_changed", "the active build changed; reload the view");
    const contribution = b.manifest.contributes.find((c) => c.id === cid);
    if (!contribution || pointInfo(contribution.point)?.kind !== "ui")
      return deny(403, "unknown_contribution", `no UI contribution ${cid}`);
    if (!Object.hasOwn(BRIDGE_METHODS, method))
      return deny(403, "method_not_allowed", `${method} is not a bridge method`);
    const need = BRIDGE_METHODS[method] ?? null;
    const granted = (this.approval(pid, ext, eb) as ExtensionApproval).capabilities;
    if (need !== null && !need.split("|").some((c) => granted.includes(c)))
      return deny(
        403,
        "capability_denied",
        `${method} needs the ${need.replaceAll("|", " or ")} capability, which ${ext} was not granted`,
      );
    const cfg = b.manifest.capability_config;
    let result: unknown;
    try {
      result = await this.dispatch(pid, ext, b, contribution, method, params, actor, cfg, signal);
    } catch (e) {
      if (e instanceof HttpError) {
        this.log(pid, ext, "warn", "bridge", `${method}: ${e.code}: ${e.message}`);
        throw e;
      }
      if (e instanceof MlflowError) throw new HttpError(503, "tracking_unavailable", e.message);
      throw e;
    }
    const size = Buffer.byteLength(JSON.stringify(result ?? null));
    if (size > 8 * MAX_RPC_BYTES)
      throw new HttpError(
        413,
        "response_too_large",
        `${method} returned ${size} bytes; ask for less`,
      );
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: "human",
      action: "extension.rpc",
      outcome: "allowed",
      project_id: pid,
      target: ext,
      details: { method, build_id: eb, contribution: cid },
    });
    return result;
  }

  private projectExperimentIds(pid: string): string[] {
    const l = this.svc.tracking.mappings.getLinks(pid);
    return [
      ...(l.experiment_id ? [l.experiment_id] : []),
      ...l.imports.map((i) => i.experiment_id),
    ];
  }

  /** A run of this project, or 404: views never see another project's runs. */
  async projectRun(pid: string, runId: unknown) {
    if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(runId))
      throw new HttpError(400, "invalid_request", "give a run_id");
    let run: Awaited<ReturnType<Services["tracking"]["client"]["getRun"]>>;
    try {
      run = await this.svc.tracking.client.getRun(runId);
    } catch (e) {
      if (e instanceof MlflowError && e.kind === "rejected")
        throw new HttpError(404, "not_found", `no run ${runId} in this project`);
      throw e;
    }
    if (!this.projectExperimentIds(pid).includes(run.info.experiment_id))
      throw new HttpError(404, "not_found", `no run ${runId} in this project`);
    return run;
  }

  runSummary(r: Awaited<ReturnType<Services["tracking"]["client"]["getRun"]>>): Json {
    return compact({
      run_id: r.info.run_id,
      run_name: r.info.run_name,
      status: r.info.status,
      start_time: r.info.start_time,
      end_time: r.info.end_time,
      params: Object.fromEntries((r.data.params ?? []).map((p) => [p.key, p.value])),
      metrics: Object.fromEntries((r.data.metrics ?? []).map((m) => [m.key, m.value])),
      tags: Object.fromEntries(
        (r.data.tags ?? [])
          .filter((t) => !t.key.startsWith("mlflow."))
          .map((t) => [t.key, t.value]),
      ),
    });
  }

  async listRuns(pid: string, params: Json): Promise<Json> {
    const ids = this.projectExperimentIds(pid);
    if (!ids.length) return { runs: [] };
    const limit = Math.min(200, Math.max(1, Number(params["limit"] ?? 50) | 0));
    const filter =
      typeof params["filter"] === "string"
        ? (params["filter"] as string).slice(0, 1000)
        : undefined;
    const page = await this.svc.tracking.client.searchRuns(
      compact({
        experiment_ids: ids,
        max_results: limit,
        filter,
        order_by: ["attributes.start_time DESC"],
      }),
    );
    return { runs: page.items.map((r) => this.runSummary(r)) };
  }

  /**
   * The read-only run methods a view may call, shared with vault figures (ADR 0053): the project's
   * runs, their metric histories and their artifacts, never another project's.
   */
  async readRuns(pid: string, method: (typeof READ_RUN_METHODS)[number], params: Json) {
    const svc = this.svc;
    switch (method) {
      case "runs.list":
        return this.listRuns(pid, params);
      case "runs.get":
        return this.runSummary(await this.projectRun(pid, params["run_id"]));
      case "runs.metric_history": {
        const run = await this.projectRun(pid, params["run_id"]);
        const key = params["key"];
        if (typeof key !== "string" || !key || key.length > 250)
          throw new HttpError(400, "invalid_request", "give a metric key");
        const h = await svc.tracking.client.getMetricHistory({
          run_id: run.info.run_id,
          metric_key: key,
          max_results: 25_000,
        });
        return {
          history: h.items.map((m) => ({ step: m.step, value: m.value, timestamp: m.timestamp })),
        };
      }
      case "artifacts.list": {
        const run = await this.projectRun(pid, params["run_id"]);
        const path =
          typeof params["path"] === "string" && params["path"]
            ? (params["path"] as string)
            : undefined;
        if (path !== undefined && !safeRelative(path))
          throw new HttpError(400, "invalid_request", "invalid path");
        const page = await svc.tracking.client.listArtifacts(run.info.run_id, path);
        return { files: page.items };
      }
      case "artifacts.preview":
        return this.previewArtifact(pid, params);
    }
  }

  private async dispatch(
    pid: string,
    ext: string,
    b: ExtensionBuildRecord,
    contribution: ExtensionContribution,
    method: string,
    params: Json,
    actor: ExtensionActor,
    cfg: ExtensionManifest["capability_config"],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const svc = this.svc;
    if (this.svc.backends.legacyBridge(pid, method))
      return this.backendBridge(pid, ext, method, params, actor, cfg, signal);
    switch (method) {
      case "context.get":
        return {
          project_id: pid,
          extension_id: ext,
          build_id: b.build_id,
          contribution: {
            id: contribution.id,
            point: contribution.point,
            title: contribution.title,
          },
          capabilities: (this.approval(pid, ext, b.build_id) as ExtensionApproval).capabilities,
        };
      case "host.navigate":
        return null;
      case "runs.list":
      case "runs.get":
      case "runs.metric_history":
      case "artifacts.list":
      case "artifacts.preview":
        return this.readRuns(pid, method, params);
      case "research.list": {
        const kind = typeof params["kind"] === "string" ? (params["kind"] as string) : undefined;
        const recs = svc.research.list(pid, kind ? { kind: kind as never } : {});
        return {
          records: recs.slice(0, 200).map((r) =>
            compact({
              record_id: r.record_id,
              kind: r.kind,
              title: r.title,
              status: r.status,
              tags: r.tags,
              body: typeof r.body === "string" ? r.body.slice(0, 4000) : undefined,
              updated_at: r.updated_at,
            }),
          ),
        };
      }
      case "models.list":
        return svc.models.listModels(pid, { max_results: 100 });
      case "inference.describe": {
        const sel = this.allowedModel(cfg, params["model"]);
        return svc.inference.describe(pid, sel);
      }
      case "inference.predict": {
        const inf = cfg?.inference;
        if (!inf) throw new HttpError(403, "capability_denied", "no inference allowlist");
        const sel = this.allowedModel(cfg, params["model"]);
        this.checkBytes(params, inf.max_request_bytes);
        this.checkRows(params["inputs"], inf.max_rows);
        this.take(pid, ext, "inference", inf.max_requests_per_hour);
        const r = await svc.inference.predict(
          pid,
          compact({
            model: sel,
            inputs: params["inputs"],
            params: params["params"],
            acknowledge_trust: true,
          }),
          compact({ kind: "human" as const, id: actor.id }),
          signal,
        );
        this.rememberResult(pid, ext, r.result_id);
        this.log(
          pid,
          ext,
          "info",
          "bridge",
          `inference.predict ${String(params["model"])}: ${r.models[0]?.status}`,
        );
        return r;
      }
      case "inference.compare": {
        const inf = cfg?.inference;
        if (!inf) throw new HttpError(403, "capability_denied", "no inference allowlist");
        const models = params["models"];
        if (!Array.isArray(models))
          throw new HttpError(400, "invalid_request", "models must be a list");
        const sels = models.map((m) => this.allowedModel(cfg, m));
        this.checkBytes(params, inf.max_request_bytes);
        this.checkRows(params["inputs"], inf.max_rows);
        this.take(pid, ext, "inference", inf.max_requests_per_hour);
        const r = await svc.inference.compare(
          pid,
          compact({
            models: sels,
            inputs: params["inputs"],
            targets: params["targets"],
            params: params["params"],
            acknowledge_trust: true,
          }),
          compact({ kind: "human" as const, id: actor.id }),
          signal,
        );
        this.rememberResult(pid, ext, r.result_id);
        return r;
      }
      case "inference.save": {
        const rid = params["result_id"];
        if (typeof rid !== "string" || this.results.get(rid) !== `${pid}/${ext}`)
          throw new HttpError(404, "not_found", "this view can only save results it produced");
        const ev = await svc.inference.save(
          pid,
          rid,
          compact({ title: params["title"], note: params["note"] }),
          compact({ kind: "human" as const, id: actor.id }),
        );
        this.record(pid, actor, "extension.result.save", ext, {
          result: rid,
          evidence_id: ev.evidence_id,
        });
        return { evidence_id: ev.evidence_id, mlflow_run_id: ev.mlflow_run_id };
      }
      case "python.run": {
        const target = params["target"];
        const py = b.manifest.contributes.find(
          (c) => c.id === target && pointInfo(c.point)?.kind === "python",
        );
        if (!py)
          throw new HttpError(
            403,
            "unknown_contribution",
            `${String(target)} is not one of ${ext}'s Python contributions`,
          );
        const x = await this.runner.run(
          pid,
          ext,
          py.id,
          { params: params["params"] ?? {}, refs: params["refs"] ?? [] },
          actor,
        );
        return this.runner.view(x);
      }
      case "python.execution": {
        const x = this.runner.get(pid, String(params["execution_id"] ?? ""));
        if (x.extension_id !== ext)
          throw new HttpError(404, "not_found", "no such execution of this extension");
        return this.runner.view(x);
      }
      case "evaluations.get": {
        const id = params["evaluation_id"];
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
          throw new HttpError(400, "invalid_request", "give an evaluation_id");
        return { evaluation: svc.evaluations.get(pid, id) };
      }
      case "report.snapshot":
        return this.saveSnapshot(pid, ext, b, contribution, params, actor);
      default:
        throw new HttpError(403, "method_not_allowed", `${method} is not a bridge method`);
    }
  }

  /** API 1 compatibility aliases use the same declared backend service boundary. */
  private async backendBridge(
    pid: string,
    ext: string,
    method: string,
    params: Json,
    actor: ExtensionActor,
    cfg: ExtensionManifest["capability_config"],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const bridge = this.svc.backends.legacyBridge(pid, method);
    if (!bridge)
      throw new HttpError(
        403,
        "method_not_allowed",
        "No active backend provides this bridge method",
      );
    const caller = compact({ kind: "human" as const, id: actor.id });
    const plan = await this.svc.backends.service<BackendLegacyPlan>(
      pid,
      bridge.extension,
      bridge.plan,
      [pid, ext, method, params, cfg],
      caller,
      signal,
    );
    for (const quota of plan.quotas ?? []) {
      if (
        !Number.isSafeInteger(quota.count) ||
        quota.count < 0 ||
        quota.count > 10000 ||
        !Number.isSafeInteger(quota.limit) ||
        quota.limit < 1
      )
        throw new HttpError(500, "invalid_extension_output", "Invalid backend quota plan");
      for (let i = 0; i < quota.count; i++) this.take(pid, ext, quota.key, quota.limit);
    }
    const costKey = `${pid}/${ext}/${plan.cost?.key ?? method}`;
    const t = this.o.now().getTime();
    const spent = (this.costs.get(costKey) ?? []).filter((c) => c.at > t - HOUR_MS);
    if (plan.cost) {
      if (!Number.isFinite(plan.cost.max_usd) || plan.cost.max_usd < 0)
        throw new HttpError(500, "invalid_extension_output", "Invalid backend cost ceiling");
      if (spent.reduce((sum, c) => sum + c.usd, 0) >= plan.cost.max_usd)
        throw new HttpError(
          429,
          "cost_ceiling",
          `${ext} reached its estimated cost ceiling of $${plan.cost.max_usd} per hour`,
        );
    }
    const response = await this.svc.backends.service<{ result: unknown; estimated_usd?: number }>(
      pid,
      bridge.extension,
      bridge.execute,
      [plan.work],
      caller,
      signal,
    );
    if (
      response.estimated_usd !== undefined &&
      Number.isFinite(response.estimated_usd) &&
      response.estimated_usd >= 0
    ) {
      spent.push({ at: t, usd: response.estimated_usd });
      this.costs.set(costKey, spent);
    }
    return response.result;
  }

  // ------------------------------------------------------------------ report snapshots

  private snapshotDir(pid: string): string {
    return join(this.o.stateDir, pid, "extensions", "snapshots");
  }

  /**
   * Store a `report.block`'s static fallback with the report (called by the host page after the
   * researcher confirms). The text and table are also appended to the report's body, so the
   * report stays legible in the checkout export after the extension is removed.
   */
  private saveSnapshot(
    pid: string,
    ext: string,
    b: ExtensionBuildRecord,
    contribution: ExtensionContribution,
    params: Json,
    actor: ExtensionActor,
  ): Json {
    if (contribution.point !== "report.block")
      throw new HttpError(403, "unknown_contribution", "only report.block views save snapshots");
    const rid = params["report_id"];
    const rec = typeof rid === "string" ? this.svc.research.get(pid, rid) : undefined;
    if (rec?.kind !== "report")
      throw new HttpError(404, "not_found", "no such report in this project");
    const snap = (params["snapshot"] ?? {}) as Json;
    const title = snap["title"];
    if (typeof title !== "string" || !title.trim() || title.length > 200)
      throw new HttpError(400, "invalid_request", "snapshot.title must be 1..200 characters");
    const text = snap["text"];
    if (text !== undefined && (typeof text !== "string" || text.length > 20_000))
      throw new HttpError(400, "invalid_request", "snapshot.text must be at most 20000 characters");
    const table = snap["table"] as { columns?: unknown; rows?: unknown } | undefined;
    if (
      table !== undefined &&
      (!Array.isArray(table.columns) ||
        table.columns.length < 1 ||
        table.columns.length > 50 ||
        !Array.isArray(table.rows) ||
        table.rows.length > 200 ||
        !table.rows.every(
          (r) =>
            Array.isArray(r) &&
            r.length <= 50 &&
            r.every((c) => ["string", "number", "boolean"].includes(typeof c)),
        ))
    )
      throw new HttpError(
        400,
        "invalid_request",
        "snapshot.table needs 1..50 columns and at most 200 rows of scalars",
      );
    const image = snap["image"];
    let png: Buffer | undefined;
    if (image !== undefined) {
      const m =
        typeof image === "string" ? /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image) : null;
      png = m ? Buffer.from(m[1] as string, "base64") : undefined;
      if (
        !png ||
        png.length > 1024 * 1024 ||
        png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      )
        throw new HttpError(
          400,
          "invalid_request",
          "snapshot.image must be a PNG data URL of at most 1 MiB",
        );
    }
    const sid = `xs-${randomBytes(8).toString("hex")}`;
    const dir = this.snapshotDir(pid);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (png) writeFileSync(join(dir, `${sid}.png`), png);
    const doc = compact({
      snapshot_id: sid,
      report_id: rec.record_id,
      extension_id: ext,
      build_id: b.build_id,
      source_sha256: b.source_sha256,
      contribution: contribution.id,
      title: title.trim(),
      text: text as string | undefined,
      table: table as Json | undefined,
      image: png ? { file: `${sid}.png`, bytes: png.length, sha256: sha256(png) } : undefined,
      saved_at: this.o.now().toISOString(),
      saved_by: actor,
    });
    writeJsonAtomic(join(dir, `${sid}.json`), doc);
    // The static fallback, in the report itself.
    const lines = [
      "",
      `<!-- ablationkit:extension-snapshot ${sid} ${ext}@${b.build_id} -->`,
      `**${doc.title}** (snapshot from extension \`${ext}\` ${b.version}, ${doc.saved_at})`,
      ...(typeof text === "string" && text ? ["", text] : []),
      ...(table
        ? [
            "",
            `| ${(table.columns as string[]).join(" | ")} |`,
            `| ${(table.columns as string[]).map(() => "---").join(" | ")} |`,
            ...(table.rows as unknown[][]).map(
              (r) => `| ${r.map((c) => String(c).replaceAll("|", "\\|")).join(" | ")} |`,
            ),
          ]
        : []),
      ...(png
        ? [
            "",
            `(figure stored with the report: snapshot ${sid}, sha256 ${doc.image?.sha256.slice(0, 12)}…)`,
          ]
        : []),
    ];
    this.svc.research.update(
      pid,
      rec.record_id,
      { body: `${rec.body ?? ""}${lines.join("\n")}\n` },
      compact({ kind: "human" as const, id: actor.id }),
    );
    this.record(pid, actor, "extension.snapshot.save", `${ext}/${contribution.id}`, {
      report_id: rec.record_id,
      snapshot_id: sid,
    });
    return { snapshot_id: sid };
  }

  snapshots(pid: string, reportId?: string): Json[] {
    this.svc.registry.require(pid);
    const dir = this.snapshotDir(pid);
    if (!existsSync(dir)) return [];
    const out: Json[] = [];
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".json"))
      .sort()) {
      try {
        const d = JSON.parse(readFileSync(join(dir, f), "utf8")) as Json;
        if (!reportId || d["report_id"] === reportId) out.push(d);
      } catch {
        // an unreadable snapshot is skipped
      }
    }
    return out;
  }

  snapshotImage(pid: string, sid: string): Buffer {
    if (!/^xs-[a-f0-9]{16}$/.test(sid))
      throw new HttpError(400, "invalid_request", "invalid snapshot id");
    const f = join(this.snapshotDir(pid), `${sid}.png`);
    if (!existsSync(f)) throw new HttpError(404, "not_found", "no such snapshot image");
    return readFileSync(f);
  }

  private rememberResult(pid: string, ext: string, rid: string): void {
    this.results.set(rid, `${pid}/${ext}`);
    if (this.results.size > 1000) this.results.delete(this.results.keys().next().value as string);
  }

  private allowedModel(cfg: ExtensionManifest["capability_config"], model: unknown): ModelSelector {
    const allow = cfg?.inference?.models ?? [];
    if (typeof model !== "string" || !modelAllowed(allow, model))
      throw new HttpError(
        403,
        "model_not_allowed",
        `model ${String(model)} is not in this extension's allowlist (${allow.join(", ")})`,
      );
    const sel = parseModelEntry(model);
    if (!sel) throw new HttpError(400, "invalid_request", `cannot read model ${model}`);
    return sel;
  }

  private checkBytes(params: Json, max: number): void {
    const n = Buffer.byteLength(JSON.stringify(params));
    if (n > max)
      throw new HttpError(
        413,
        "request_too_large",
        `this extension may send at most ${max} bytes per request (got ${n})`,
      );
  }

  private checkRows(inputs: unknown, max: number | undefined): void {
    if (max === undefined) return;
    const i = (inputs ?? {}) as Json;
    const rows = Array.isArray(i["records"])
      ? (i["records"] as unknown[]).length
      : Array.isArray(i["images"])
        ? (i["images"] as unknown[]).length
        : Array.isArray(i["texts"])
          ? (i["texts"] as unknown[]).length
          : 1;
    if (rows > max)
      throw new HttpError(
        413,
        "too_many_rows",
        `this extension may send at most ${max} rows per request`,
      );
  }

  private async previewArtifact(pid: string, params: Json): Promise<Json> {
    const run = await this.projectRun(pid, params["run_id"]);
    const path = params["path"];
    if (typeof path !== "string" || !safeRelative(path))
      throw new HttpError(400, "invalid_request", "give an artifact path");
    const res = await this.svc.tracking.client.downloadArtifact(run.info.run_id, path);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 1024 * 1024)
      throw new HttpError(413, "too_large", "previews are limited to 1 MiB");
    const ext = path.split(".").at(-1)?.toLowerCase() ?? "";
    const images: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
      webp: "image/webp",
    };
    if (images[ext])
      return {
        path,
        content_type: images[ext],
        data_url: `data:${images[ext]};base64,${buf.toString("base64")}`,
      };
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    if (isBinary(text.slice(0, 4096)))
      throw new HttpError(
        415,
        "binary",
        "this artifact is binary; only text and images can be previewed",
      );
    return { path, content_type: ext === "json" ? "application/json" : "text/plain", text };
  }

  /** Run an allowlisted `project.action` operation. */
  async action(
    pid: string,
    ext: string,
    cid: string,
    actor: ExtensionActor,
    listener: "human" | "agent",
  ): Promise<unknown> {
    if (this.o.safeMode)
      throw new HttpError(503, "safe_mode", "extensions are inactive in safe mode");
    const b = this.activeBuild(pid, ext);
    if (!b)
      throw new HttpError(
        403,
        "extension_inactive",
        `${ext} is not enabled and approved in this project`,
      );
    const c = b.manifest.contributes.find((x) => x.id === cid && x.point === "project.action");
    if (!c?.operation) throw new HttpError(404, "not_found", `no action ${cid}`);
    const op = ACTION_OPERATIONS[c.operation];
    const granted = (this.approval(pid, ext, b.build_id) as ExtensionApproval).capabilities;
    if (!op || !granted.includes(op.capability))
      throw new HttpError(
        403,
        "capability_denied",
        `${c.operation} needs ${op?.capability ?? "an allowlisted operation"}`,
      );
    const p = c.params ?? {};
    const by = compact({
      kind: actor.kind === "agent" ? ("agent" as const) : ("human" as const),
      id: actor.id,
    });
    let out: unknown;
    switch (c.operation) {
      case "extension.python.run": {
        const x = await this.runner.run(
          pid,
          ext,
          c.target as string,
          { params: p, refs: [] },
          actor,
        );
        out = { execution: this.runner.view(x) };
        break;
      }
      case "research.note.create": {
        const r = this.svc.research.create(
          pid,
          "note",
          compact({
            title: String(p["title"] ?? c.title).slice(0, 300),
            body: typeof p["body"] === "string" ? p["body"] : undefined,
            tags: [`extension:${ext}`],
          }),
          by,
          { listener },
        );
        out = { record_id: r.record_id };
        break;
      }
      case "report.generate": {
        const { generateReport } = await import("../research/reports.ts");
        const r = await generateReport(
          this.svc,
          pid,
          { study_id: String(p["study"] ?? "") } as never,
          by,
          listener,
        );
        out = { record_id: r.record_id };
        break;
      }
      default:
        throw new HttpError(403, "operation_not_allowed", "not an allowlisted operation");
    }
    this.record(pid, actor, "extension.action", `${ext}/${cid}`, { operation: c.operation });
    return out;
  }

  capabilityCatalog(): Json {
    return {
      host_api_version: HOST_API_VERSION,
      capabilities: CAPABILITIES,
      operations: ACTION_OPERATIONS,
    };
  }
}

/** Control characters other than tab, newline, form feed and carriage return mean binary. */
function isBinary(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------- bundling

/** The bridge methods that only read the project's runs (`readRuns`). */
export const READ_RUN_METHODS = [
  "runs.list",
  "runs.get",
  "runs.metric_history",
  "artifacts.list",
  "artifacts.preview",
] as const;

export function escapeTag(s: string, tag: "script" | "style"): string {
  return s.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1").replace(/<!--/g, "<\\!--");
}

/** Bundle one UI entry from the snapshot. Imports may only reach the snapshot, the SDK and React. */
export async function bundleEntry(
  srcDir: string,
  entry: string,
): Promise<
  { ok: true; js: string; css?: string } | { ok: false; diagnostics: ExtensionDiagnostic[] }
> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const root = resolve(srcDir);
  const sdkSrc = join(SDK_DIR, "src");
  const policy: BunPlugin = {
    name: "ablationkit-extension-imports",
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
        if (!resolve(args.path).startsWith(`${root}/`)) return undefined;
        const source = readFileSync(args.path, "utf8");
        rejectBuildMacros(args.path, source);
        return {
          contents: source,
          loader: args.path.endsWith(".tsx")
            ? "tsx"
            : args.path.endsWith(".jsx")
              ? "jsx"
              : args.path.endsWith(".js")
                ? "js"
                : "ts",
        };
      });

      build.onResolve({ filter: /.*/ }, (args) => {
        const importer = args.importer ? resolve(args.importer) : "";
        // Imports made by the SDK or by React itself resolve normally.
        if (importer && !importer.startsWith(`${root}/`)) return undefined;
        const spec = args.path;
        if (spec.startsWith(".") || spec.startsWith("/")) {
          const target = resolve(importer ? dirname(importer) : root, spec);
          if (target !== root && !target.startsWith(`${root}/`)) {
            diagnostics.push({
              level: "error",
              code: "import_outside_extension",
              message: `${relative(root, importer)} imports ${spec}, outside the extension`,
              path: relative(root, importer),
            });
            return { path: join(root, "__blocked__.js") };
          }
          return undefined;
        }
        if (!importAllowed(spec)) {
          diagnostics.push({
            level: "error",
            code: "dependency_not_allowed",
            message: `${relative(root, importer) || entry} imports \`${spec}\`; UI extensions may import only @ablationkit/extension-sdk and React`,
            path: relative(root, importer) || entry,
            fix: "Vendor small helpers into the extension, or move heavy computation to a Python contribution.",
          });
          return { path: join(root, "__blocked__.js") };
        }
        if (spec === "@ablationkit/extension-sdk") return { path: join(sdkSrc, "index.ts") };
        if (spec === "@ablationkit/extension-sdk/react") return { path: join(sdkSrc, "react.tsx") };
        return { path: Bun.resolveSync(spec, sdkSrc) };
      });
    },
  };
  let r: Awaited<ReturnType<typeof Bun.build>>;
  try {
    r = await Bun.build({
      entrypoints: [join(root, entry)],
      target: "browser",
      format: "esm",
      minify: true,
      splitting: false,
      plugins: [policy],
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      throw: false,
    });
  } catch (e) {
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "bundle_failed",
          message: String((e as Error).message).slice(0, 2000),
          path: entry,
        },
      ],
    };
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  if (!r.success)
    return {
      ok: false,
      diagnostics: r.logs.slice(0, 20).map((l) => ({
        level: "error" as const,
        code: "bundle_failed",
        message: String(l.message ?? l).slice(0, 2000),
        path: entry,
      })),
    };
  let js = "";
  let css = "";
  for (const o of r.outputs) {
    if (o.path.endsWith(".css")) css += await o.text();
    else if (o.kind === "entry-point") js += await o.text();
  }
  return css ? { ok: true, js, css } : { ok: true, js };
}

/** Base styles for frames, matching the host's palette in both themes (curated components). */
export const FRAME_BASE_CSS = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1d1b18;--muted:#6b665d;--line:#d9d4ca;--accent:#2f5d50;--err:#a33a2a}
@media (prefers-color-scheme:dark){:root{--bg:#1a1916;--fg:#ece8e1;--muted:#a59f94;--line:#3a3731;--accent:#7fb8a6;--err:#e58a7a}}
html[data-theme=light]{--bg:#fbfaf7;--fg:#1d1b18;--muted:#6b665d;--line:#d9d4ca;--accent:#2f5d50}
html[data-theme=dark]{--bg:#1a1916;--fg:#ece8e1;--muted:#a59f94;--line:#3a3731;--accent:#7fb8a6}
html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
body{padding:12px}
.ak-table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
.ak-table th,.ak-table td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left}
.ak-table th{color:var(--muted);font-weight:500}
.ak-stat{display:inline-block;margin:0 16px 8px 0}.ak-stat-label{color:var(--muted);font-size:12px}.ak-stat-value{font-size:20px}
.ak-stat-hint{color:var(--muted);font-size:12px}
.ak-button{font:inherit;padding:4px 12px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg);cursor:pointer}
.ak-button:disabled{opacity:.5;cursor:default}
.ak-notice{padding:8px 12px;border-left:3px solid var(--accent);margin:8px 0}.ak-notice-error{border-color:var(--err)}
`;
