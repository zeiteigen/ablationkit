/**
 * The isolated Python operations bridge (spec §4.1, §4.2; ADR 0019): runs one MLflow operation
 * with no REST equivalent (classical evaluation, one-shot prediction) as a short-lived, supervised
 * subprocess, or an interactive inference session as a long-lived one (ADR 0020). Bun stays the coordinator; Python never runs in-process.
 *
 * Each operation gets its own directory under `<home>/operations/<id>/` with `request.json`,
 * `result.json` and `bridge.log`. The process runs under a systemd user scope with a memory cap and
 * a runtime limit when the user manager delegates them (otherwise `direct` mode: a process group
 * and a timer, labelled advisory), with a minimal environment: the tracking URI and nothing else of
 * the coordinator's. Its working directory is the operation directory, and Python runs isolated
 * (`-I`), so neither the checkout nor the user's site-packages are importable by accident.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  probeSupervisor,
  type Supervised,
  type SupervisorProbe,
  startSupervised,
  stopUnit,
  type Termination,
} from "@ablationkit/process-supervisor";
import { recordMlflowUse } from "@ablationkit/tracking-mlflow";

export const BRIDGE_VERSION = 1;
export const DEFAULT_BRIDGE_SCRIPT = resolve(
  import.meta.dir,
  "../../../../packages/tracking-mlflow/env/bridge/ablationkit_bridge.py",
);
const LOG_TAIL_BYTES = 16 * 1024;

export interface BridgeOptions {
  /** Directory holding one sub-directory per operation. */
  readonly dir: string;
  /** argv that runs the bridge script in the managed environment; undefined: unavailable. */
  readonly managedCommand: () => string[] | undefined;
  readonly uv: string;
  readonly trackingUrl: () => string | undefined;
  readonly supervisor?: "auto" | "systemd" | "direct";
}

export interface BridgeRun {
  readonly id: string;
  readonly unit: string;
  readonly enforcement: "enforced" | "advisory";
  readonly done: Promise<BridgeOutcome>;
  stop(): Promise<void>;
}

export interface BridgeOutcome {
  readonly result?: Record<string, unknown>;
  readonly termination: Termination;
  readonly log_tail: string;
}

export interface BridgeSession {
  readonly id: string;
  readonly pid: number;
  readonly unit: string;
  readonly enforcement: "enforced" | "advisory";
  /** Protocol lines from the worker, in order; ends when it exits. */
  readonly lines: AsyncIterable<string>;
  send(msg: Record<string, unknown>): void;
  /** End stdin: the worker finishes the request in hand and exits. */
  close(): void;
  readonly done: Promise<{ termination: Termination; log_tail: string }>;
  stop(): Promise<void>;
}

export class BridgeUnavailableError extends Error {}

export class OperationsBridge {
  private probeResult: SupervisorProbe | undefined;
  constructor(private readonly o: BridgeOptions) {}

  private probe(): SupervisorProbe {
    if (!this.probeResult) {
      const s = this.o.supervisor ?? "auto";
      this.probeResult =
        s === "direct"
          ? probeSupervisor({ ABLATIONKIT_SUPERVISOR: "direct" })
          : probeSupervisor({ ABLATIONKIT_SUPERVISOR: s === "systemd" ? "systemd" : undefined });
    }
    return this.probeResult;
  }

  available(environment: "managed" | "project"): string | undefined {
    if (!this.o.trackingUrl()) return "MLflow is not running";
    if (environment === "managed" && !this.o.managedCommand())
      return "the managed MLflow environment is not installed (start the sidecar once)";
    return undefined;
  }

  unitFor(id: string): string {
    return `ak-op-${id}`;
  }

  /** Stop what a previous coordinator left running (its result is never used). */
  reap(id: string): void {
    stopUnit(`${this.unitFor(id)}.scope`);
  }

  async start(
    id: string,
    request: Record<string, unknown>,
    opts: {
      environment: "managed" | "project";
      projectPath?: string;
      scriptPath?: string;
      timeoutSec: number;
      memoryMb?: number;
      /** Extra environment (provider API keys), passed to the process and never written to disk. */
      secretEnv?: Readonly<Record<string, string>>;
    },
  ): Promise<BridgeRun> {
    const why = this.available(opts.environment);
    if (why) throw new BridgeUnavailableError(why);
    const dir = join(this.o.dir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const reqFile = join(dir, "request.json");
    const resFile = join(dir, "result.json");
    const logFile = join(dir, "bridge.log");
    rmSync(resFile, { force: true });
    writeFileSync(reqFile, JSON.stringify({ bridge_version: BRIDGE_VERSION, ...request }), {
      mode: 0o600,
    });
    const argv = this.argv(opts.environment, opts.projectPath);
    if (opts.scriptPath && argv.at(-1)?.endsWith("ablationkit_bridge.py"))
      argv[argv.length - 1] = opts.scriptPath;
    const env = { ...this.env(), ...(opts.secretEnv ?? {}) };
    const probe = this.probe();
    const sup: Supervised = await startSupervised({
      unit: this.unitFor(id),
      argv: [...argv, reqFile, resFile],
      cwd: dir,
      env,
      mode: probe.mode,
      limits: {
        runtime_max_sec: opts.timeoutSec,
        ...(opts.memoryMb ? { memory_max_bytes: opts.memoryMb * 1024 * 1024 } : {}),
      },
    });
    const log = Bun.file(logFile).writer();
    const pump = async (s: NodeJS.ReadableStream) => {
      for await (const chunk of s) log.write(chunk as Uint8Array);
    };
    const pumps = Promise.all([pump(sup.stdout), pump(sup.stderr)]).catch(() => undefined);
    const done = (async (): Promise<BridgeOutcome> => {
      const termination = await sup.exited;
      await pumps;
      await log.end();
      let result: Record<string, unknown> | undefined;
      if (existsSync(resFile))
        try {
          result = JSON.parse(readFileSync(resFile, "utf8")) as Record<string, unknown>;
        } catch {
          result = undefined;
        }
      const text = existsSync(logFile) ? readFileSync(logFile) : Buffer.alloc(0);
      recordMlflowUse(
        `bridge ${String(request["op"] ?? "unknown")} ${result ? (result["ok"] === false ? "error" : "ok") : "none"}`,
      );
      return {
        ...(result ? { result } : {}),
        termination,
        log_tail: text.subarray(Math.max(0, text.length - LOG_TAIL_BYTES)).toString("utf8"),
      };
    })();
    return {
      id,
      unit: sup.unit,
      enforcement: probe.mode === "systemd" ? probe.enforcement : "advisory",
      done,
      stop: () => sup.stop(),
    };
  }

  /**
   * An interactive worker (an inference session): the bridge's `serve` op. Requests go to its
   * stdin as JSON lines; its stdout carries only the protocol (the bridge points the model's own
   * prints at stderr, which goes to `bridge.log`). Nothing the caller sends touches the disk.
   */
  async startSession(
    id: string,
    request: Record<string, unknown>,
    opts: {
      environment: "managed" | "project";
      projectPath?: string;
      lifetimeSec: number;
      memoryMb: number;
    },
  ): Promise<BridgeSession> {
    const why = this.available(opts.environment);
    if (why) throw new BridgeUnavailableError(why);
    const dir = join(this.o.dir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const reqFile = join(dir, "request.json");
    const resFile = join(dir, "result.json");
    rmSync(resFile, { force: true });
    writeFileSync(reqFile, JSON.stringify({ bridge_version: BRIDGE_VERSION, ...request }), {
      mode: 0o600,
    });
    const probe = this.probe();
    const sup = await startSupervised({
      unit: this.unitFor(id),
      argv: [...this.argv(opts.environment, opts.projectPath), reqFile, resFile],
      cwd: dir,
      env: this.env(),
      mode: probe.mode,
      stdin: "pipe",
      limits: { runtime_max_sec: opts.lifetimeSec, memory_max_bytes: opts.memoryMb * 1024 * 1024 },
    });
    const log = Bun.file(join(dir, "bridge.log")).writer();
    const errPump = (async () => {
      for await (const chunk of sup.stderr) log.write(chunk as Uint8Array);
    })().catch(() => undefined);
    const stdin = sup.stdin;
    if (!stdin) throw new Error("the supervisor gave the session no stdin");
    stdin.on("error", () => undefined);
    const lines = (async function* (): AsyncGenerator<string> {
      let buf = "";
      for await (const chunk of sup.stdout) {
        buf += Buffer.from(chunk as Uint8Array).toString("utf8");
        let i = buf.indexOf("\n");
        while (i >= 0) {
          yield buf.slice(0, i);
          buf = buf.slice(i + 1);
          i = buf.indexOf("\n");
        }
        if (buf.length > 64 * 1024 * 1024) throw new Error("a session response exceeded 64 MiB");
      }
    })();
    const done = (async () => {
      const termination = await sup.exited;
      await errPump;
      await log.end();
      return { termination, log_tail: this.logTail(id, LOG_TAIL_BYTES) };
    })();
    return {
      id,
      pid: sup.pid,
      unit: sup.unit,
      enforcement: probe.mode === "systemd" ? probe.enforcement : "advisory",
      lines,
      send: (msg) => {
        stdin.write(`${JSON.stringify(msg)}\n`);
      },
      close: () => {
        stdin.end();
      },
      done,
      stop: () => sup.stop(),
    };
  }

  /** Remove an operation's directory (exploratory inference leaves nothing behind). */
  discard(id: string): void {
    rmSync(join(this.o.dir, id), { recursive: true, force: true });
  }

  logTail(id: string, bytes = LOG_TAIL_BYTES): string {
    const f = this.logPath(id);
    if (!existsSync(f)) return "";
    const text = readFileSync(f);
    return text.subarray(Math.max(0, text.length - bytes)).toString("utf8");
  }

  private argv(environment: "managed" | "project", projectPath?: string): string[] {
    if (environment === "project") {
      if (!projectPath) throw new BridgeUnavailableError("no project checkout");
      return [
        this.o.uv,
        "run",
        "--frozen",
        "--project",
        projectPath,
        "--",
        "python",
        "-I",
        DEFAULT_BRIDGE_SCRIPT,
      ];
    }
    return this.o.managedCommand() as string[];
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR", "XDG_RUNTIME_DIR", "UV_CACHE_DIR"]) {
      const v = process.env[k];
      if (v) env[k] = v;
    }
    env["MLFLOW_TRACKING_URI"] = this.o.trackingUrl() as string;
    env["MLFLOW_DISABLE_AGENT_HINT"] = "1";
    // MLflow's Python SDK otherwise phones home (config.mlflow-telemetry.io); ADR 0021.
    env["MLFLOW_DISABLE_TELEMETRY"] = "true";
    env["DO_NOT_TRACK"] = "true";
    env["PYTHONUNBUFFERED"] = "1";
    // Plots render off-screen.
    env["MPLBACKEND"] = "Agg";
    return env;
  }

  logPath(id: string): string {
    return join(this.o.dir, id, "bridge.log");
  }
}
