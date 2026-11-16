/**
 * The Podman command lines for agent and job containers (ADR 0061). Pure: the coordinator
 * resolves paths, binaries and the configuration, and runs what this returns.
 *
 * Both kinds of container run rootless (`--userns keep-id`: files they write in the checkout are
 * the researcher's), with every capability dropped, no new privileges, a PID 1 that reaps
 * (`--init`) and no network of their own (`--network none`). The checkout and AblationKit's own
 * tree are mounted at the same paths as on this machine, so paths in jobs, notes and the SDK's
 * `PYTHONPATH` mean the same inside and out. Nothing else of this machine is mounted: not the
 * coordinator's home, not the login socket, not `~/.ssh`.
 *
 * The agent container has no GPU. The way out is the session's run directory, mounted read-only
 * at `/run/ablationkit`: the agent socket (the agent API, for `ablationkit mcp`), the egress proxy
 * and the credential routes, which the container's init forwards to `127.0.0.1` ports.
 */
import type { ContainerHarness } from "@ablationkit/protocol";
import { HARNESSES, harnessArgv } from "./harness.ts";
import { CONTAINER, CONTAINER_PATH, EGRESS_PORT } from "./paths.ts";

export { CONTAINER, CONTAINER_PATH, CREDENTIAL_PORT, EGRESS_PORT } from "./paths.ts";

/** A path inside a mount that the container must not see: covered by an empty tmpfs or /dev/null. */
export interface Mask {
  readonly path: string;
  readonly kind: "dir" | "file";
}

export interface ContainerDirs {
  /** This machine's run directory for the session or attempt, mounted read-only. */
  readonly run?: string;
  readonly env: string;
  readonly uvCache: string;
  readonly python: string;
}

export interface ContainerTools {
  readonly bun: string;
  readonly uv?: string;
}

export interface AgentContainerInput {
  readonly sessionId: string;
  readonly projectId: string;
  readonly image: string;
  readonly checkout: string;
  /** AblationKit's install (this source tree), mounted read-only at its own path. */
  readonly tree: string;
  readonly tools: ContainerTools & { readonly harness?: string };
  readonly dirs: ContainerDirs & { readonly run: string; readonly home: string };
  readonly limits: { readonly cpus: number; readonly memory_mb: number; readonly pids_max: number };
  readonly masks: readonly Mask[];
  /** Absolute paths in the checkout mounted read-only over it. */
  readonly readOnly: readonly string[];
  readonly harness: ContainerHarness;
  readonly args: readonly string[];
  /** More environment: credential routes, the harness's own. */
  readonly env: Readonly<Record<string, string>>;
}

export interface JobContainerInput {
  readonly name: string;
  readonly image: string;
  readonly checkout: string;
  readonly tree: string;
  readonly tools: ContainerTools;
  readonly dirs: ContainerDirs & { readonly spool: string };
  /** Other read-only directories the job needs at their own paths (extension SDK roots). */
  readonly extraReadOnly: readonly string[];
  readonly masks: readonly Mask[];
  /** A protected evaluation's hidden paths, mounted read-only at their own paths. */
  readonly evaluationMounts: readonly string[];
  readonly gpu: "all" | "none";
  readonly network: "none" | "egress";
  readonly limits: {
    readonly memory_max_bytes?: number;
    readonly cpu_quota_percent?: number;
    readonly tasks_max?: number;
    readonly runtime_max_sec?: number;
  };
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly argv: readonly string[];
}

/** The script that runs first in a container: forwards the ports, then runs the command. */
export function initScript(tree: string): string {
  return `${tree.replace(/\/+$/, "")}/apps/cli/src/container-init.ts`;
}

function common(name: string): string[] {
  return [
    "--rm",
    "--init",
    "--name",
    name,
    "--network",
    "none",
    "--userns",
    "keep-id",
    "--cap-drop",
    "all",
    "--security-opt",
    "no-new-privileges",
  ];
}

function bind(src: string, dst: string, mode: "ro" | "rw"): string[] {
  return ["--volume", `${src}:${dst}:${mode}`];
}

function maskArgs(masks: readonly Mask[]): string[] {
  return masks.flatMap((m) =>
    m.kind === "dir"
      ? ["--mount", `type=tmpfs,destination=${m.path},tmpfs-mode=0555,tmpfs-size=1m`]
      : bind("/dev/null", m.path, "ro"),
  );
}

function envArgs(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}

function proxyEnv(): Record<string, string> {
  const url = `http://127.0.0.1:${EGRESS_PORT}`;
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    ALL_PROXY: url,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

function uvEnv(): Record<string, string> {
  return {
    UV_PROJECT_ENVIRONMENT: CONTAINER.env,
    UV_CACHE_DIR: CONTAINER.uvCache,
    UV_PYTHON_INSTALL_DIR: CONTAINER.python,
    // The cache and the environment are different mounts: copy, never hard-link across them.
    UV_LINK_MODE: "copy",
  };
}

function toolMounts(tools: ContainerTools): string[] {
  return [
    ...bind(tools.bun, `${CONTAINER.bin}/bun`, "ro"),
    ...(tools.uv ? bind(tools.uv, `${CONTAINER.bin}/uv`, "ro") : []),
  ];
}

function envDirs(dirs: ContainerDirs): string[] {
  return [
    ...bind(dirs.env, CONTAINER.env, "rw"),
    ...bind(dirs.uvCache, CONTAINER.uvCache, "rw"),
    ...bind(dirs.python, CONTAINER.python, "rw"),
  ];
}

/** `podman run …` for one agent container session, attached to a terminal. */
export function agentContainerArgs(i: AgentContainerInput): string[] {
  const h = HARNESSES[i.harness];
  return [
    "run",
    ...common(`ak-agent-${i.sessionId}`),
    "--interactive",
    "--tty",
    "--hostname",
    `ak-${i.sessionId.slice(2, 10)}`,
    "--cpus",
    String(i.limits.cpus),
    "--memory",
    `${i.limits.memory_mb}m`,
    "--memory-swap",
    `${i.limits.memory_mb}m`,
    "--pids-limit",
    String(i.limits.pids_max),
    "--label",
    `ablationkit.session=${i.sessionId}`,
    "--label",
    `ablationkit.project=${i.projectId}`,
    ...envArgs({
      HOME: CONTAINER.home,
      PATH: `${CONTAINER.run}/bin:${CONTAINER_PATH}`,
      TERM: "xterm-256color",
      ...proxyEnv(),
      ...uvEnv(),
      ABLATIONKIT_CONTAINED: "1",
      ABLATIONKIT_SESSION: i.sessionId,
      ABLATIONKIT_PROJECT: i.projectId,
      ABLATIONKIT_AGENT_SOCKET: `${CONTAINER.run}/agent.sock`,
      ABLATIONKIT_AGENT_TOKEN_FILE: `${CONTAINER.run}/token`,
      ...h.env,
      ...i.env,
    }),
    ...bind(i.checkout, i.checkout, "rw"),
    ...maskArgs(i.masks),
    ...i.readOnly.flatMap((p) => bind(p, p, "ro")),
    ...bind(i.tree, i.tree, "ro"),
    ...toolMounts(i.tools),
    ...(i.tools.harness && h.binary
      ? bind(i.tools.harness, `${CONTAINER.bin}/${h.binary}`, "ro")
      : []),
    ...bind(i.dirs.run, CONTAINER.run, "ro"),
    ...bind(i.dirs.home, CONTAINER.home, "rw"),
    ...envDirs(i.dirs),
    "--workdir",
    i.checkout,
    i.image,
    `${CONTAINER.bin}/bun`,
    initScript(i.tree),
    "--",
    ...harnessArgv(i.harness, i.args),
  ];
}

/** `podman run …` for one attempt of a contained session's local job. */
export function jobContainerArgs(i: JobContainerInput): string[] {
  const l = i.limits;
  const egress = i.network === "egress" && i.dirs.run !== undefined;
  return [
    "run",
    ...common(i.name),
    "--hostname",
    i.name.slice(0, 63),
    ...(i.gpu === "all" ? ["--device", "nvidia.com/gpu=all"] : []),
    ...(l.memory_max_bytes
      ? ["--memory", `${l.memory_max_bytes}b`, "--memory-swap", `${l.memory_max_bytes}b`]
      : []),
    ...(l.cpu_quota_percent ? ["--cpus", (l.cpu_quota_percent / 100).toFixed(2)] : []),
    ...(l.tasks_max ? ["--pids-limit", String(l.tasks_max)] : []),
    // A backstop for the collector's own time limit, which ends the Podman client first.
    ...(l.runtime_max_sec ? ["--timeout", String(l.runtime_max_sec + 60)] : []),
    "--label",
    `ablationkit.attempt=${i.name.replace(/^ak-job-/, "")}`,
    ...envArgs({
      HOME: "/tmp",
      PATH: CONTAINER_PATH,
      ...uvEnv(),
      ...(egress ? proxyEnv() : { UV_OFFLINE: "1", HF_HUB_OFFLINE: "1" }),
      ...i.env,
    }),
    ...bind(i.checkout, i.checkout, "rw"),
    ...maskArgs(i.masks),
    ...i.evaluationMounts.flatMap((p) => bind(p, p, "ro")),
    ...bind(i.tree, i.tree, "ro"),
    ...i.extraReadOnly.flatMap((p) => bind(p, p, "ro")),
    ...toolMounts(i.tools),
    ...bind(i.dirs.spool, i.dirs.spool, "rw"),
    ...(egress && i.dirs.run ? bind(i.dirs.run, CONTAINER.run, "ro") : []),
    ...envDirs(i.dirs),
    "--workdir",
    i.cwd,
    i.image,
    ...(egress ? [`${CONTAINER.bin}/bun`, initScript(i.tree), "--job", "--"] : []),
    ...i.argv,
  ];
}

/** The `ablationkit` command inside a container: the mounted CLI, run by the mounted bun. */
export function cliWrapper(tree: string): string {
  return `#!/bin/sh\nexec ${CONTAINER.bin}/bun ${tree.replace(/\/+$/, "")}/apps/cli/src/main.ts "$@"\n`;
}

/** Quote one argument for a POSIX shell. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`;
}
