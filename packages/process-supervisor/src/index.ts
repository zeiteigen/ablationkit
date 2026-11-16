/**
 * @ablationkit/process-supervisor: runs one job attempt under resource limits and cleans up its
 * whole process tree (spec §7.11, ADR 0003, ADR 0011).
 *
 * - `systemd` mode: `systemd-run --user --scope` with `MemoryMax`, `MemorySwapMax=0`, `CPUQuota`,
 *   `RuntimeMaxSec` and `TasksMax`. The kernel enforces the limits when the user manager has the
 *   `cpu`, `memory` and `pids` controllers delegated; otherwise they are advisory.
 * - `direct` mode (no systemd user manager, for example CI containers): a new process group. Only
 *   the time limit is applied (by this process); everything else is advisory and labelled so.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import type { JobLimits } from "@ablationkit/protocol";

export type SupervisorMode = "systemd" | "direct";

export interface SupervisorProbe {
  readonly mode: SupervisorMode;
  readonly enforcement: "enforced" | "advisory";
  readonly reason?: string;
  readonly controllers: readonly string[];
}

const REQUIRED_CONTROLLERS = ["cpu", "memory", "pids"] as const;

/** Grace between SIGTERM and SIGKILL when stopping an attempt. */
export const STOP_GRACE_MS = 15_000;

function run(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  try {
    const p = Bun.spawnSync([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...userManagerEnv() },
    });
    return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  } catch (e) {
    return { code: -1, stdout: "", stderr: String(e) };
  }
}

/** What `systemctl --user`/`systemd-run --user` need to find the user manager. */
function userManagerEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  if (!out["XDG_RUNTIME_DIR"] && process.getuid)
    out["XDG_RUNTIME_DIR"] = `/run/user/${process.getuid()}`;
  return out;
}

function delegatedControllers(): string[] {
  const uid = process.getuid?.() ?? 0;
  const path = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`;
  try {
    return readFileSync(path, "utf8").trim().split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Decide how attempts run on this machine. `ABLATIONKIT_SUPERVISOR=direct` forces direct mode
 * (tests); `=systemd` makes a missing user manager an error instead of a fallback.
 */
export function probeSupervisor(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SupervisorProbe {
  const forced = env["ABLATIONKIT_SUPERVISOR"];
  if (forced === "direct") {
    return {
      mode: "direct",
      enforcement: "advisory",
      reason: "direct mode forced by ABLATIONKIT_SUPERVISOR=direct; only the time limit is applied",
      controllers: [],
    };
  }
  const state = run(["systemctl", "--user", "is-system-running"]);
  const up = ["running", "degraded"].includes(state.stdout.trim());
  const scope = up ? run(["systemd-run", "--user", "--scope", "--quiet", "true"]) : undefined;
  if (!up || scope?.code !== 0) {
    if (forced === "systemd")
      throw new Error(
        `ABLATIONKIT_SUPERVISOR=systemd but the systemd user manager is unusable: ${(scope?.stderr || state.stdout || state.stderr).trim()}`,
      );
    return {
      mode: "direct",
      enforcement: "advisory",
      reason:
        "no usable systemd user manager (systemd-run --user failed); CPU, memory and task limits are not applied, the time limit is applied by the collector",
      controllers: [],
    };
  }
  const controllers = delegatedControllers();
  const missing = REQUIRED_CONTROLLERS.filter((c) => !controllers.includes(c));
  if (missing.length > 0) {
    return {
      mode: "systemd",
      enforcement: "advisory",
      reason: `cgroup controllers not delegated to the user manager: ${missing.join(", ")}`,
      controllers,
    };
  }
  return { mode: "systemd", enforcement: "enforced", controllers };
}

/** systemd unit properties for `limits` (ADR 0003: always pair MemoryMax with MemorySwapMax=0). */
export function limitProperties(limits: JobLimits): string[] {
  const props: string[] = [];
  if (limits.memory_max_bytes !== undefined)
    props.push(`MemoryMax=${limits.memory_max_bytes}`, "MemorySwapMax=0");
  if (limits.cpu_quota_percent !== undefined) props.push(`CPUQuota=${limits.cpu_quota_percent}%`);
  if (limits.runtime_max_sec !== undefined) props.push(`RuntimeMaxSec=${limits.runtime_max_sec}`);
  if (limits.tasks_max !== undefined) props.push(`TasksMax=${limits.tasks_max}`);
  return props;
}

const UNIT_RE = /^[A-Za-z0-9:_.-]{1,200}$/;

export function checkUnitName(unit: string): string {
  if (!UNIT_RE.test(unit)) throw new Error(`invalid unit name ${unit}`);
  return unit;
}

export interface StartSpec {
  /** Unit name without suffix; the scope is `<unit>.scope`. */
  readonly unit: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly limits: JobLimits;
  readonly mode: SupervisorMode;
  /** `pipe`: give the process a stdin the caller writes (interactive sessions). Default `ignore`. */
  readonly stdin?: "ignore" | "pipe";
}

export interface Termination {
  readonly exit_code?: number;
  readonly signal?: string;
  /** systemd `Result` of the scope (`success`, `timeout`, `oom-kill`, …); `timeout` in direct mode too. */
  readonly unit_result?: string;
  readonly timed_out: boolean;
  readonly oom_killed: boolean;
  /** Processes the job left behind were killed when its main process exited. */
  readonly leftovers_killed: boolean;
}

export interface Supervised {
  readonly pid: number;
  readonly unit: string;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Present when the spec asked for `stdin: "pipe"`. */
  readonly stdin?: Writable;
  readonly exited: Promise<Termination>;
  /** SIGTERM the whole tree, SIGKILL after the grace period. */
  stop(): Promise<void>;
}

function showUnit(unit: string): Record<string, string> {
  const r = run([
    "systemctl",
    "--user",
    "show",
    "-p",
    "ActiveState",
    "-p",
    "Result",
    "-p",
    "LoadState",
    unit,
  ]);
  const out: Record<string, string> = {};
  for (const line of r.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** Stop a systemd unit (whole cgroup). Errors are ignored: the unit may already be gone. */
export function stopUnit(unit: string): void {
  run(["systemctl", "--user", "stop", unit]);
}

/** Signal a whole process group; false if it no longer exists. */
export function killGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Start one supervised process. The caller must consume stdout and stderr. */
export async function startSupervised(spec: StartSpec): Promise<Supervised> {
  checkUnitName(spec.unit);
  if (spec.mode === "systemd") return startScope(spec);
  return startDirect(spec);
}

async function startScope(spec: StartSpec): Promise<Supervised> {
  const unit = `${spec.unit}.scope`;
  const props = [...limitProperties(spec.limits), `TimeoutStopSec=${STOP_GRACE_MS / 1000}s`];
  const argv = [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    `--unit=${spec.unit}`,
    ...props.map((p) => `--property=${p}`),
    "--",
    ...spec.argv,
  ];
  // systemd-run --scope registers the scope for its own PID and then execs argv, so the child
  // is the job's main process.
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd: spec.cwd,
    env: { ...userManagerEnv(), ...spec.env },
    stdio: [spec.stdin ?? "ignore", "pipe", "pipe"],
  });
  const exit = waitExit(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exited = (async (): Promise<Termination> => {
    const { code, signal } = await exit;
    // The scope may still be deactivating (it is stopping leftovers, or systemd is recording
    // the result). Wait briefly for a settled state.
    let st = showUnit(unit);
    for (let i = 0; i < 50 && st["ActiveState"] === "deactivating"; i++) {
      await sleep(100);
      st = showUnit(unit);
    }
    let leftovers = false;
    if (st["ActiveState"] === "active") {
      // Main process is gone but the scope is not empty: the job left processes behind.
      leftovers = true;
      stopUnit(unit);
    }
    const result = st["Result"] && st["LoadState"] !== "not-found" ? st["Result"] : "success";
    run(["systemctl", "--user", "reset-failed", unit]);
    return {
      ...(code === null ? {} : { exit_code: code }),
      ...(signal === null ? {} : { signal }),
      unit_result: result,
      timed_out: result === "timeout",
      oom_killed: result === "oom-kill",
      leftovers_killed: leftovers,
    };
  })();
  return {
    pid: child.pid as number,
    unit,
    stdout: child.stdout as Readable,
    stderr: child.stderr as Readable,
    ...(child.stdin ? { stdin: child.stdin } : {}),
    exited,
    stop: async () => {
      stopUnit(unit);
      await exited.catch(() => undefined);
    },
  };
}

async function startDirect(spec: StartSpec): Promise<Supervised> {
  const child = spawn(spec.argv[0] as string, spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...spec.env },
    stdio: [spec.stdin ?? "ignore", "pipe", "pipe"],
    detached: true, // setsid: the job leads its own process group
  });
  const exit = waitExit(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const pid = child.pid as number;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    killGroup(pid, "SIGTERM");
    killTimer ??= setTimeout(() => killGroup(pid, "SIGKILL"), STOP_GRACE_MS);
  };
  const limit = spec.limits.runtime_max_sec;
  const timer =
    limit === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          terminate();
        }, limit * 1000);
  const exited = (async (): Promise<Termination> => {
    const { code, signal } = await exit;
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    // Anything left in the job's process group dies with it. A process that called setsid
    // itself escapes: direct mode cannot follow it (advisory, ADR 0011).
    const leftovers = groupAlive(pid);
    if (leftovers) {
      killGroup(pid, "SIGKILL");
      for (let i = 0; i < 50 && groupAlive(pid); i++) await sleep(20);
    }
    return {
      ...(code === null ? {} : { exit_code: code }),
      ...(signal === null ? {} : { signal }),
      ...(timedOut ? { unit_result: "timeout" } : {}),
      timed_out: timedOut,
      oom_killed: false,
      leftovers_killed: leftovers,
    };
  })();
  return {
    pid,
    unit: spec.unit,
    stdout: child.stdout as Readable,
    stderr: child.stderr as Readable,
    ...(child.stdin ? { stdin: child.stdin } : {}),
    exited,
    stop: async () => {
      terminate();
      await exited.catch(() => undefined);
    },
  };
}

export interface DetachedSpec {
  /** Unit name without suffix; the service is `<unit>.service` in systemd mode. */
  readonly unit: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly mode: SupervisorMode;
  /** stdout/stderr of the detached process (direct mode; systemd mode logs to the journal). */
  readonly logFile: string;
}

/**
 * Launch a long-lived helper (the collector) that outlives the caller: a transient systemd user
 * service, or a detached session leader in direct mode.
 */
export function launchDetached(spec: DetachedSpec): { pid?: number; unit?: string } {
  checkUnitName(spec.unit);
  if (spec.mode === "systemd") {
    const r = run([
      "systemd-run",
      "--user",
      "--quiet",
      "--collect",
      `--unit=${spec.unit}`,
      `--working-directory=${spec.cwd}`,
      ...Object.entries(spec.env).map(([k, v]) => `--setenv=${k}=${v}`),
      "--",
      ...spec.argv,
    ]);
    if (r.code !== 0) throw new Error(`systemd-run failed: ${r.stderr.trim()}`);
    return { unit: `${spec.unit}.service` };
  }
  const fd = openSync(spec.logFile, "a", 0o600);
  try {
    const child = spawn(spec.argv[0] as string, spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...spec.env },
      stdio: ["ignore", fd, fd],
      detached: true,
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`could not start ${spec.argv[0]}`);
    return { pid: child.pid };
  } finally {
    closeSync(fd);
  }
}

/** Is a detached helper still running? */
export function detachedAlive(info: { pid?: number; unit?: string }): boolean {
  if (info.unit) {
    const st = showUnit(info.unit);
    return st["ActiveState"] === "active" || st["ActiveState"] === "activating";
  }
  if (info.pid) {
    try {
      // A zombie still answers kill(0); it is not running.
      const stat = readFileSync(`/proc/${info.pid}/stat`, "utf8");
      return !/^\d+ \(.*\) [ZX]/.test(stat);
    } catch {
      return false;
    }
  }
  return false;
}

/** Send a signal to a detached helper's main process without stopping its unit. */
export function signalDetached(
  info: { pid?: number; unit?: string },
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  if (info.unit) {
    return (
      run(["systemctl", "--user", "kill", `--signal=${signal}`, "--kill-whom=main", info.unit])
        .code === 0
    );
  }
  if (info.pid) {
    try {
      process.kill(info.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
