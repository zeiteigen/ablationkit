/**
 * Managed MLflow sidecar (spec §5.5, §5.8; ADR 0010): a pinned MLflow server in a
 * coordinator-owned uv environment, bound to loopback, with SQLite metadata and local artifacts
 * under `<home>/mlflow/`. The coordinator supervises it: health checks, restart with backoff,
 * process-group shutdown, and an upgrade guard that backs up MLflow data before a new MLflow
 * version is allowed to migrate it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import { type MlflowSidecarState, validateMlflowSidecarState } from "@ablationkit/protocol";

export type SidecarState =
  | "disabled"
  /** Tracking points at an MLflow server the coordinator does not manage (tests). */
  | "external"
  | "stopped"
  | "installing"
  | "starting"
  | "healthy"
  | "unhealthy"
  | "restarting"
  | "failed"
  | "upgrade_blocked";

export interface SidecarStatus {
  readonly state: SidecarState;
  readonly since: string;
  readonly url?: string;
  readonly pid?: number;
  readonly pinned_version: string;
  readonly installed_version?: string;
  readonly data_version?: string;
  readonly last_error?: string;
  readonly restarts: number;
  readonly paths: {
    readonly data: string;
    readonly database: string;
    readonly artifacts: string;
    readonly log: string;
    readonly venv: string;
  };
}

export interface SidecarHooks {
  /** Replace `uv sync` (tests). */
  readonly install?: () => Promise<void>;
  /** Replace reading the installed MLflow version (tests). */
  readonly installedVersion?: () => Promise<string>;
  /** Replace the server command line (tests run a fake server). */
  readonly command?: (port: number) => string[];
}

export interface SidecarOptions {
  /** `packages/tracking-mlflow/env`: pyproject.toml + uv.lock with the pinned MLflow. */
  readonly opsDir: string;
  /** `<home>/mlflow`. */
  readonly dataDir: string;
  readonly port: number;
  readonly uv?: string;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
  /** Take a SQLite-safe backup of MLflow data before an upgrade; returns the backup ID. */
  readonly preUpgradeBackup: (from: string, to: string) => Promise<string>;
  readonly onState?: (status: SidecarStatus) => void;
  readonly healthIntervalMs?: number;
  readonly startTimeoutMs?: number;
  readonly maxRestartDelayMs?: number;
  readonly hooks?: SidecarHooks;
}

/** The MLflow version pinned in `packages/tracking-mlflow/env/pyproject.toml`. */
export function pinnedMlflowVersion(opsDir: string): string {
  const text = readFileSync(join(opsDir, "pyproject.toml"), "utf8");
  const m = /"mlflow==([0-9][0-9A-Za-z.+-]*)"/.exec(text);
  if (!m?.[1]) throw new Error(`no exact mlflow pin in ${join(opsDir, "pyproject.toml")}`);
  return m[1];
}

/** Compare dotted numeric versions; non-numeric parts compare as strings. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (c !== 0) return Math.sign(c);
  }
  return 0;
}

const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

class GuardError extends Error {}

export class MlflowSidecar {
  readonly pinnedVersion: string;
  readonly paths: SidecarStatus["paths"] & { readonly state: string; readonly pidFile: string };
  private state: SidecarState = "stopped";
  private since: string;
  private lastError: string | undefined;
  private installedVersion: string | undefined;
  private child: ChildProcess | undefined;
  private restarts = 0;
  private stopping = false;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private failedChecks = 0;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private starting: Promise<void> | undefined;

  constructor(private readonly options: SidecarOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.since = this.now().toISOString();
    this.pinnedVersion = pinnedMlflowVersion(options.opsDir);
    const d = options.dataDir;
    this.paths = {
      data: d,
      database: join(d, "mlflow.db"),
      artifacts: join(d, "artifacts"),
      log: join(d, "logs", "sidecar.log"),
      venv: join(d, "venv"),
      state: join(d, "sidecar.json"),
      pidFile: join(d, "sidecar.pid"),
    };
  }

  get url(): string {
    return `http://127.0.0.1:${this.options.port}`;
  }

  /** URL to send requests to, or undefined while no server process is up. */
  get activeUrl(): string | undefined {
    return this.child && (this.state === "healthy" || this.state === "unhealthy")
      ? this.url
      : undefined;
  }

  status(): SidecarStatus {
    const data = this.readState()?.data_mlflow_version;
    return {
      state: this.state,
      since: this.since,
      ...(this.child ? { url: this.url } : {}),
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      pinned_version: this.pinnedVersion,
      ...(this.installedVersion ? { installed_version: this.installedVersion } : {}),
      ...(data ? { data_version: data } : {}),
      ...(this.lastError ? { last_error: this.lastError } : {}),
      restarts: this.restarts,
      paths: {
        data: this.paths.data,
        database: this.paths.database,
        artifacts: this.paths.artifacts,
        log: this.paths.log,
        venv: this.paths.venv,
      },
    };
  }

  private set(state: SidecarState, error?: string): void {
    if (error !== undefined) this.lastError = error;
    else if (state === "healthy") this.lastError = undefined;
    if (state === this.state && error === undefined) return;
    this.state = state;
    this.since = this.now().toISOString();
    this.log(`mlflow sidecar: ${state}${error ? ` (${error})` : ""}`);
    this.options.onState?.(this.status());
  }

  readState(): MlflowSidecarState | undefined {
    try {
      return readJson(this.paths.state, validateMlflowSidecarState);
    } catch {
      return undefined;
    }
  }

  private writeState(s: MlflowSidecarState): void {
    writeJsonAtomic(this.paths.state, s, { validate: validateMlflowSidecarState });
  }

  /** Install, check the upgrade guard, launch and wait for health. Never throws; see `status()`. */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = this.startInner().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startInner(): Promise<void> {
    try {
      for (const d of [this.paths.data, this.paths.artifacts, join(this.paths.data, "logs")])
        mkdirSync(d, { recursive: true, mode: 0o700 });
      this.killOrphan();
      this.set("installing");
      await (this.options.hooks?.install ?? (() => this.uvSync()))();
      this.installedVersion = await (
        this.options.hooks?.installedVersion ?? (() => this.readInstalledVersion())
      )();
      if (this.installedVersion !== this.pinnedVersion)
        throw new Error(
          `installed MLflow ${this.installedVersion} does not match the pin ${this.pinnedVersion}`,
        );
      await this.upgradeGuard(this.installedVersion);
      if (this.stopping) return;
      await this.launch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.set(e instanceof GuardError ? "upgrade_blocked" : "failed", msg);
    }
  }

  private async run(cmd: string[], env: Record<string, string>): Promise<void> {
    const logFd = openSync(this.paths.log, "a", 0o600);
    try {
      const p = Bun.spawn(cmd, {
        env: { ...process.env, ...env },
        stdout: logFd,
        stderr: logFd,
        cwd: this.paths.data,
      });
      const code = await p.exited;
      if (code !== 0)
        throw new Error(`${cmd.slice(0, 3).join(" ")} exited with ${code}; see ${this.paths.log}`);
    } finally {
      closeSync(logFd);
    }
  }

  private uvSync(): Promise<void> {
    return this.run(
      [
        this.options.uv ?? "uv",
        "sync",
        "--locked",
        "--no-install-project",
        "--project",
        this.options.opsDir,
      ],
      { UV_PROJECT_ENVIRONMENT: this.paths.venv },
    );
  }

  private async readInstalledVersion(): Promise<string> {
    const p = Bun.spawn(
      [
        join(this.paths.venv, "bin", "python"),
        "-c",
        "from importlib.metadata import version; print(version('mlflow'))",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = (await new Response(p.stdout).text()).trim();
    if ((await p.exited) !== 0 || !out) throw new Error("cannot read the installed MLflow version");
    return out;
  }

  /**
   * Refuse to let a different MLflow version open existing data until it is backed up. A
   * downgrade is refused outright (MLflow's schema migrations only go forward).
   */
  private async upgradeGuard(installed: string): Promise<void> {
    const st = this.readState();
    const hasDb = existsSync(this.paths.database);
    const ts = this.now().toISOString();
    if (!st) {
      if (hasDb) {
        // Data from an unknown MLflow version: back it up before this version migrates it.
        const backupId = await this.backupForUpgrade("unknown", installed);
        this.writeState({
          schema_version: 1,
          data_mlflow_version: installed,
          initialized_at: ts,
          updated_at: ts,
          upgrades: [
            { from_version: "unknown", to_version: installed, at: ts, backup_id: backupId },
          ],
        });
        return;
      }
      this.writeState({
        schema_version: 1,
        data_mlflow_version: installed,
        initialized_at: ts,
        updated_at: ts,
        upgrades: [],
      });
      return;
    }
    const cmp = compareVersions(installed, st.data_mlflow_version);
    if (cmp === 0) return;
    if (cmp < 0)
      throw new GuardError(
        `MLflow data was last opened by ${st.data_mlflow_version}; refusing to start older ${installed}. Restore a backup taken before the upgrade, or pin ${st.data_mlflow_version}.`,
      );
    if (!hasDb) {
      this.writeState({ ...st, data_mlflow_version: installed, updated_at: ts });
      return;
    }
    const backupId = await this.backupForUpgrade(st.data_mlflow_version, installed);
    this.writeState({
      ...st,
      data_mlflow_version: installed,
      updated_at: ts,
      upgrades: [
        ...st.upgrades,
        {
          from_version: st.data_mlflow_version,
          to_version: installed,
          at: ts,
          backup_id: backupId,
        },
      ],
    });
  }

  private async backupForUpgrade(from: string, to: string): Promise<string> {
    this.log(`mlflow sidecar: upgrade ${from} -> ${to}; backing up first`);
    try {
      return await this.options.preUpgradeBackup(from, to);
    } catch (e) {
      throw new GuardError(
        `pre-upgrade backup failed, not starting MLflow ${to}: ${(e as Error).message}`,
      );
    }
  }

  private command(): string[] {
    const port = this.options.port;
    if (this.options.hooks?.command) return this.options.hooks.command(port);
    return [
      join(this.paths.venv, "bin", "mlflow"),
      "server",
      "--backend-store-uri",
      `sqlite:///${this.paths.database}`,
      "--artifacts-destination",
      this.paths.artifacts,
      "--serve-artifacts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--workers",
      "1",
    ];
  }

  private rotateLog(): void {
    try {
      if (statSync(this.paths.log).size > LOG_ROTATE_BYTES)
        renameSync(this.paths.log, `${this.paths.log}.1`);
    } catch {
      // no log yet
    }
  }

  private async launch(): Promise<void> {
    this.set("starting");
    this.rotateLog();
    const [bin, ...args] = this.command();
    const logFd = openSync(this.paths.log, "a", 0o600);
    // A new process group, so stop() can take down MLflow's worker processes too.
    const child = spawn(bin as string, args, {
      cwd: this.paths.data,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.env["HOME"] ?? this.paths.data,
        LANG: process.env["LANG"] ?? "C.UTF-8",
        PYTHONUNBUFFERED: "1",
        MLFLOW_DISABLE_AGENT_HINT: "1",
        // No usage telemetry leaves the workstation (spec §5.6.2 egress rules; ADR 0021).
        MLFLOW_DISABLE_TELEMETRY: "true",
        DO_NOT_TRACK: "true",
        // MLflow's built-in job runner (GenAI background jobs) is not used: GenAI evaluations run
        // in the operations bridge (ADR 0021).
        MLFLOW_SERVER_ENABLE_JOB_EXECUTION: "false",
      },
    });
    closeSync(logFd);
    this.child = child;
    writeJsonAtomic(
      this.paths.pidFile,
      { pid: child.pid, port: this.options.port },
      { backup: false },
    );
    child.once("exit", (code, signal) => this.onExit(child, code, signal));

    const deadline = Date.now() + (this.options.startTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (this.child !== child || this.stopping) return;
      if (await this.probe()) {
        const v = await this.version().catch(() => undefined);
        if (v !== undefined && v !== this.pinnedVersion) {
          this.set("failed", `server reports MLflow ${v}, expected ${this.pinnedVersion}`);
          await this.killChild();
          return;
        }
        this.failedChecks = 0;
        this.set("healthy");
        this.startHealthChecks();
        return;
      }
      await Bun.sleep(250);
    }
    this.set(
      "failed",
      `MLflow did not become healthy within ${this.options.startTimeoutMs ?? 120_000} ms; see ${this.paths.log}`,
    );
    await this.killChild();
  }

  private async probe(): Promise<boolean> {
    try {
      const r = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
      return r.ok && (await r.text()).trim() === "OK";
    } catch {
      return false;
    }
  }

  private async version(): Promise<string> {
    const r = await fetch(`${this.url}/version`, { signal: AbortSignal.timeout(2000) });
    return (await r.text()).trim();
  }

  private startHealthChecks(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      void this.probe().then((ok) => {
        if (!this.child || this.stopping) return;
        if (ok) {
          this.failedChecks = 0;
          if (this.state === "unhealthy") this.set("healthy");
        } else if (++this.failedChecks >= 3 && this.state === "healthy") {
          this.set("unhealthy", "health check failed 3 times");
        }
      });
    }, this.options.healthIntervalMs ?? 5000);
  }

  private onExit(child: ChildProcess, code: number | null, signal: string | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    rmSync(this.paths.pidFile, { force: true });
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    // Kill anything left in the group (MLflow's uvicorn workers).
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
    }
    if (this.stopping) return;
    if (this.state === "failed") return;
    this.restarts++;
    const delay = Math.min(
      this.options.maxRestartDelayMs ?? 60_000,
      1000 * 2 ** Math.min(this.restarts - 1, 6),
    );
    this.set(
      "restarting",
      `MLflow exited (${signal ?? `code ${code}`}); restarting in ${delay} ms`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.stopping) void this.launch();
    }, delay);
  }

  /** A sidecar left behind by a crashed coordinator holds the port: stop its process group. */
  private killOrphan(): void {
    let pid: number | undefined;
    try {
      pid = (JSON.parse(readFileSync(this.paths.pidFile, "utf8")) as { pid?: number }).pid;
    } catch {
      return;
    }
    if (pid && pid > 1) {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        const ours = this.options.hooks?.command ? true : cmdline.includes(this.paths.venv);
        if (ours) {
          process.kill(-pid, "SIGKILL");
          this.log(`mlflow sidecar: killed orphaned process group ${pid}`);
        }
      } catch {
        // not running
      }
    }
    rmSync(this.paths.pidFile, { force: true });
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      return;
    }
    const timeout = Bun.sleep(10_000).then(() => "timeout" as const);
    if ((await Promise.race([exited, timeout])) === "timeout") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone
      }
      await exited;
    }
  }

  /** Stop the server and its whole process group. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.restartTimer = undefined;
    this.healthTimer = undefined;
    await this.starting?.catch(() => {});
    await this.killChild();
    if (this.state !== "failed" && this.state !== "upgrade_blocked") this.set("stopped");
  }

  /** Mark the sidecar disabled by settings. */
  disable(): void {
    this.set("disabled");
  }
}
