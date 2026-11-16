/** Runtime directory layout and settings (spec §5.1 B, ADR 0009). */
import { homedir } from "node:os";
import { join } from "node:path";
import { readJson } from "@ablationkit/core";
import {
  type CoordinatorSettings,
  type ListenerSettings,
  type TrustedOrigin,
  validateCoordinatorSettings,
} from "@ablationkit/protocol";

export const DEFAULT_PORTS = { human: 7420, agent: 7421, worker: 7422, mlflow: 7423 } as const;
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

/** `ABLATIONKIT_HOME`, or `~/.ablationkit`. */
export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const h = env["ABLATIONKIT_HOME"];
  return h && h.length > 0 ? h : join(homedir(), ".ablationkit");
}

export interface RuntimePaths {
  readonly home: string;
  readonly settings: string;
  readonly registry: string;
  readonly lock: string;
  readonly runDir: string;
  readonly loginSocket: string;
  readonly tokens: string;
  readonly auditDir: string;
  readonly eventsDir: string;
  readonly stateDir: string;
  readonly cliSession: string;
  /** Managed MLflow data: `mlflow.db`, `artifacts/`, `venv/`, `logs/`, `sidecar.json`. */
  readonly mlflowDir: string;
  /** Tracking outbox journal. */
  readonly outboxDir: string;
  readonly backupsDir: string;
  /** Collector spools of local attempts (`spool/<attempt-id>/`); written by collectors, not the coordinator. */
  readonly spoolDir: string;
  /** One directory per operations-bridge run (request, result, log). */
  readonly operationsDir: string;
  /** Compute targets (`targets/<target-id>.json`, ADR 0023). */
  readonly targetsDir: string;
  /** Machine-wide compute weights for the agent compute limit (ADR 0037). */
  readonly computeWeights: string;
  /** Staged run bundles of remote attempts (`bundles/<attempt-id>/`). */
  readonly bundlesDir: string;
  /** The Colab CLI's session state for the runtimes the coordinator allocates (ADR 0059). */
  readonly colabState: string;
}

export function runtimePaths(home: string): RuntimePaths {
  return {
    home,
    settings: join(home, "settings.json"),
    registry: join(home, "registry.json"),
    lock: join(home, "coordinator.lock"),
    runDir: join(home, "run"),
    loginSocket: join(home, "run", "login.sock"),
    tokens: join(home, "auth", "tokens.json"),
    auditDir: join(home, "audit"),
    eventsDir: join(home, "events"),
    stateDir: join(home, "state"),
    cliSession: join(home, "cli-session.json"),
    mlflowDir: join(home, "mlflow"),
    outboxDir: join(home, "tracking", "outbox"),
    backupsDir: join(home, "backups"),
    spoolDir: join(home, "spool"),
    operationsDir: join(home, "operations"),
    targetsDir: join(home, "targets"),
    computeWeights: join(home, "compute-weights.json"),
    bundlesDir: join(home, "bundles"),
    colabState: join(home, "colab", "sessions.json"),
  };
}

export interface ResolvedSettings {
  readonly human: ListenerSettings;
  readonly agent: ListenerSettings;
  readonly worker: ListenerSettings;
  /** Undefined means "derive http://localhost:<bound human port>" once bound. */
  readonly trustedOrigins: readonly TrustedOrigin[] | undefined;
  readonly mlflow: {
    readonly enabled: boolean;
    readonly port: number;
    readonly outboxMaxOps: number;
    readonly outboxMaxBytes: number;
  };
  readonly jobs: {
    readonly supervisor: "auto" | "systemd" | "direct";
    readonly spoolMaxBytes: number;
    readonly maxArtifactBytes: number;
    readonly deliverDeadlineSec: number;
  };
  readonly extensions: {
    readonly safeMode: boolean;
    readonly maxConcurrent: number;
    /** ADR 0045: a successful build is enabled as built unless this is set. */
    readonly requireApproval: boolean;
  };
  /** Remote worker mode (ADR 0023). */
  readonly remote: {
    readonly workerUrl: string | undefined;
    readonly heartbeatSec: number;
    readonly disconnectedAfterSec: number;
    /** Slack on an exported attempt's time limit before it is overdue (F29). */
    readonly exportSlackMin: number;
    readonly uploadTokenTtlSec: number;
    readonly launchTokenDays: number;
    readonly providerPollSec: number;
    readonly maxBackoffSec: number;
    readonly minFreeDiskBytes: number;
    /** Optional S3-compatible store for large remote artifacts (ADR 0023 decision 24). */
    readonly artifactStore?: {
      readonly endpoint: string;
      readonly bucket: string;
      readonly region: string;
      readonly prefix: string;
      readonly accessKeyIdEnv: string;
      readonly secretAccessKeyEnv: string;
      readonly virtualHostedStyle: boolean;
      readonly minBytes: number;
      readonly slots: number;
    };
  };
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export function resolveSettings(s: CoordinatorSettings): ResolvedSettings {
  const resolved: ResolvedSettings = {
    human: s.human ?? { host: "127.0.0.1", port: DEFAULT_PORTS.human },
    agent: s.agent ?? { host: "127.0.0.1", port: DEFAULT_PORTS.agent },
    worker: s.worker ?? { host: "127.0.0.1", port: DEFAULT_PORTS.worker },
    trustedOrigins: s.trusted_origins,
    mlflow: {
      enabled: s.mlflow?.enabled ?? true,
      port: s.mlflow?.port ?? DEFAULT_PORTS.mlflow,
      outboxMaxOps: s.mlflow?.outbox_max_ops ?? 100_000,
      outboxMaxBytes: s.mlflow?.outbox_max_bytes ?? 256 * 1024 * 1024,
    },
    jobs: {
      supervisor: s.jobs?.supervisor ?? "auto",
      spoolMaxBytes: s.jobs?.spool_max_bytes ?? 1024 * 1024 * 1024,
      maxArtifactBytes: s.jobs?.max_artifact_bytes ?? 2 * 1024 * 1024 * 1024,
      deliverDeadlineSec: s.jobs?.deliver_deadline_sec ?? 7 * 24 * 60 * 60,
    },
    extensions: {
      safeMode: s.extensions?.safe_mode ?? false,
      maxConcurrent: s.extensions?.max_concurrent_executions ?? 4,
      requireApproval: s.extensions?.require_approval ?? false,
    },
    remote: {
      workerUrl: s.remote?.worker_url,
      heartbeatSec: s.remote?.heartbeat_sec ?? 30,
      disconnectedAfterSec: s.remote?.disconnected_after_sec ?? 3 * (s.remote?.heartbeat_sec ?? 30),
      exportSlackMin: s.remote?.export_slack_min ?? 30,
      uploadTokenTtlSec: s.remote?.upload_token_ttl_sec ?? 24 * 60 * 60,
      launchTokenDays: s.remote?.launch_token_days ?? 30,
      providerPollSec: s.remote?.provider_poll_sec ?? 60,
      maxBackoffSec: s.remote?.max_backoff_sec ?? 60,
      minFreeDiskBytes: s.remote?.min_free_disk_bytes ?? 1024 * 1024 * 1024,
      ...(s.remote?.artifact_store
        ? {
            artifactStore: {
              endpoint: s.remote.artifact_store.endpoint,
              bucket: s.remote.artifact_store.bucket,
              region: s.remote.artifact_store.region ?? "auto",
              prefix: s.remote.artifact_store.prefix ?? "ablationkit/",
              accessKeyIdEnv: s.remote.artifact_store.access_key_id_env,
              secretAccessKeyEnv: s.remote.artifact_store.secret_access_key_env,
              virtualHostedStyle: s.remote.artifact_store.virtual_hosted_style ?? false,
              minBytes: s.remote.artifact_store.min_bytes ?? 64 * 1024 * 1024,
              slots: s.remote.artifact_store.slots ?? 8,
            },
          }
        : {}),
    },
  };
  // Agents run on the workstation (spec §7.11); the agent API never leaves loopback.
  if (!isLoopbackHost(resolved.agent.host)) {
    throw new SettingsError(`agent listener must bind to loopback, not ${resolved.agent.host}`);
  }
  for (const o of resolved.trustedOrigins ?? []) {
    const host = new URL(o.origin).hostname;
    if (new URL(o.origin).protocol === "http:" && !isLoopbackHost(host)) {
      throw new SettingsError(
        `${o.origin}: plain http is allowed only for localhost (session cookies need https off loopback)`,
      );
    }
  }
  return resolved;
}

/** Read `settings.json`; a missing file means defaults. */
export function loadSettings(path: string): ResolvedSettings {
  let s: CoordinatorSettings = { schema_version: 1 };
  try {
    s = readJson(path, validateCoordinatorSettings);
  } catch (e) {
    if ((e as { kind?: string }).kind !== "missing") throw e;
  }
  return resolveSettings(s);
}

/**
 * `worker.host: "tailscale"` binds the worker listener to this machine's Tailscale IPv4 address,
 * so remote workers on the tailnet can reach it while it stays off other interfaces.
 */
export function resolveWorkerHost(host: string, tailscale = "tailscale"): string {
  if (host !== "tailscale") return host;
  const p = Bun.spawnSync([tailscale, "ip", "-4"], { stdout: "pipe", stderr: "pipe" });
  const ip = p.stdout.toString().trim().split("\n")[0] ?? "";
  if (p.exitCode !== 0 || !/^100\.[0-9.]+$/.test(ip))
    throw new SettingsError(
      `worker.host is "tailscale" but \`tailscale ip -4\` gave no tailnet address (${p.stderr.toString().trim() || ip || "no output"}); is Tailscale up?`,
    );
  return ip;
}
