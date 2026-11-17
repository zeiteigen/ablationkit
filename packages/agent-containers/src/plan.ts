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
 * The agent container has no GPU and no project environment (ADR 0066): what needs the
 * environment runs as a job. The way out is the session's run directory, mounted read-only at
 * `/run/ablationkit`: the agent socket (the agent API, for `ablationkit mcp`), the egress proxy
 * and the credential routes, which the container's init forwards to `127.0.0.1` ports.
 *
 * Job containers get the project's environment read-only. An environment build is the one job
 * that writes it: `uv sync` into a new copy, starting from the current one, with the uv cache, the
 * Python installs and the environment allowlist.
 */
import type { ContainerHarness } from "@ablationkit/protocol";
import {
  CLAUDE_MANAGED_SETTINGS,
  CLAUDE_MANAGED_SETTINGS_FILE,
  HARNESSES,
  type HarnessDefaults,
  harnessArgv,
  harnessEnv,
} from "./harness.ts";
import { CONTAINER, CONTAINER_PATH, EGRESS_PORT } from "./paths.ts";

export { CONTAINER, CONTAINER_PATH, CREDENTIAL_PORT, EGRESS_PORT } from "./paths.ts";

/** A path inside a mount that the container must not see: covered by an empty tmpfs or /dev/null. */
export interface Mask {
  readonly path: string;
  readonly kind: "dir" | "file";
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
  readonly tools: { readonly bun: string; readonly harness?: string };
  /** The session's run directory (mounted read-only) and the agent's home. */
  readonly dirs: { readonly run: string; readonly home: string };
  readonly limits: { readonly cpus: number; readonly memory_mb: number; readonly pids_max: number };
  readonly masks: readonly Mask[];
  /** Absolute paths in the checkout mounted read-only over it. */
  readonly readOnly: readonly string[];
  readonly harness: ContainerHarness;
  readonly args: readonly string[];
  /** Claude Code: start Remote Control under this name (ADR 0067); none, not at all. */
  readonly remoteControl?: string;
  /** More environment: credential routes, the harness's own. */
  readonly env: Readonly<Record<string, string>>;
}

export interface JobContainerInput {
  readonly name: string;
  readonly image: string;
  readonly checkout: string;
  /**
   * An agent's job's copy of its source (ADR 0068), mounted read-write at the checkout's path
   * instead of the checkout, with `readOnly` (absolute paths in the checkout: its ignored data,
   * earlier outputs, its Git) mounted read-only over it, then its inputs from earlier runs
   * (`src` on this machine, read-only at `dst` in the checkout).
   */
  readonly source?: {
    readonly dir: string;
    readonly readOnly: readonly string[];
    readonly inputs?: readonly { readonly src: string; readonly dst: string }[];
  };
  readonly tree: string;
  readonly tools: ContainerTools;
  readonly dirs: {
    readonly spool: string;
    /** The attempt's run directory (its egress proxy), mounted read-only. */
    readonly run?: string;
    /** The project's environment: read-only, or the new copy an environment build writes. */
    readonly env?: string;
    /** An environment build's starting point: the current environment. */
    readonly envBase?: string;
    readonly python: string;
    /** The uv cache: environment builds only. */
    readonly uvCache?: string;
  };
  /** An environment build (ADR 0066): writes `dirs.env`; everything else reads it. */
  readonly build?: boolean;
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

/**
 * An empty read-only tmpfs over a directory, `/dev/null` over a file. `notmpcopyup` matters:
 * Podman copies what is under a tmpfs mount point into it by default, which would show the
 * hidden files.
 */
function maskArgs(masks: readonly Mask[]): string[] {
  return masks.flatMap((m) =>
    m.kind === "dir"
      ? ["--mount", `type=tmpfs,destination=${m.path},tmpfs-mode=0555,tmpfs-size=1m,notmpcopyup`]
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

function uvEnv(build: boolean): Record<string, string> {
  return {
    UV_PROJECT_ENVIRONMENT: CONTAINER.env,
    UV_PYTHON_INSTALL_DIR: CONTAINER.python,
    ...(build
      ? {
          UV_CACHE_DIR: CONTAINER.uvCache,
          // The cache and the environment are different mounts: copy, never hard-link across them.
          UV_LINK_MODE: "copy",
        }
      : {}),
  };
}

function toolMounts(tools: ContainerTools): string[] {
  return [
    ...bind(tools.bun, `${CONTAINER.bin}/bun`, "ro"),
    ...(tools.uv ? bind(tools.uv, `${CONTAINER.bin}/uv`, "ro") : []),
  ];
}

function envDirs(dirs: JobContainerInput["dirs"], build: boolean): string[] {
  const mode = build ? "rw" : "ro";
  return [
    ...(dirs.env ? bind(dirs.env, CONTAINER.env, mode) : []),
    ...(build && dirs.envBase ? bind(dirs.envBase, CONTAINER.envBase, "ro") : []),
    ...(build && dirs.uvCache ? bind(dirs.uvCache, CONTAINER.uvCache, "rw") : []),
    ...bind(dirs.python, CONTAINER.python, mode),
  ];
}

/** `podman run …` for one agent container session, attached to a terminal. */
export function agentContainerArgs(i: AgentContainerInput): string[] {
  const h = HARNESSES[i.harness];
  const defaults: HarnessDefaults = i.remoteControl ? { remoteControl: i.remoteControl } : {};
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
      ABLATIONKIT_CONTAINED: "1",
      ABLATIONKIT_SESSION: i.sessionId,
      ABLATIONKIT_PROJECT: i.projectId,
      ABLATIONKIT_AGENT_SOCKET: `${CONTAINER.run}/agent.sock`,
      ABLATIONKIT_AGENT_TOKEN_FILE: `${CONTAINER.run}/token`,
      ...harnessEnv(i.harness, defaults),
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
    // Claude Code's managed settings (ADR 0067), from the run directory: read-only, above the
    // settings in the agent's home and the checkout.
    ...(i.harness === "claude-code"
      ? bind(`${i.dirs.run}/${CLAUDE_MANAGED_SETTINGS_FILE}`, CLAUDE_MANAGED_SETTINGS, "ro")
      : []),
    ...bind(i.dirs.home, CONTAINER.home, "rw"),
    "--workdir",
    i.checkout,
    i.image,
    `${CONTAINER.bin}/bun`,
    initScript(i.tree),
    "--",
    ...harnessArgv(i.harness, i.args, defaults),
  ];
}

/** `podman run …` for one attempt of a contained session's local job. */
export function jobContainerArgs(i: JobContainerInput): string[] {
  const l = i.limits;
  const egress = i.network === "egress" && i.dirs.run !== undefined;
  const build = i.build === true;
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
      ...uvEnv(build),
      ...(egress ? proxyEnv() : { UV_OFFLINE: "1", HF_HUB_OFFLINE: "1" }),
      ...i.env,
    }),
    ...(i.source ? bind(i.source.dir, i.checkout, "rw") : bind(i.checkout, i.checkout, "rw")),
    ...(i.source?.readOnly ?? []).flatMap((p) => bind(p, p, "ro")),
    ...(i.source?.inputs ?? []).flatMap((x) => bind(x.src, x.dst, "ro")),
    ...maskArgs(i.masks),
    ...i.evaluationMounts.flatMap((p) => bind(p, p, "ro")),
    ...bind(i.tree, i.tree, "ro"),
    ...i.extraReadOnly.flatMap((p) => bind(p, p, "ro")),
    ...toolMounts(i.tools),
    ...bind(i.dirs.spool, i.dirs.spool, "rw"),
    ...(egress && i.dirs.run ? bind(i.dirs.run, CONTAINER.run, "ro") : []),
    ...envDirs(i.dirs, build),
    "--workdir",
    i.cwd,
    i.image,
    ...(egress ? [`${CONTAINER.bin}/bun`, initScript(i.tree), "--job", "--"] : []),
    ...i.argv,
  ];
}

/**
 * What an environment build runs (ADR 0066): copy the current environment into the new one (a
 * reflink where the filesystem has them), then `uv sync`, which locks first when `pyproject.toml`
 * changed and writes `uv.lock` into the checkout. `args` go to `uv sync` (`--extra cuda`).
 */
export function environmentBuildArgv(checkout: string, args: readonly string[]): string[] {
  const script = [
    "set -e",
    `if [ -e ${CONTAINER.envBase}/pyvenv.cfg ]; then`,
    `  echo "AblationKit: starting from the current environment"`,
    `  cp -a --reflink=auto ${CONTAINER.envBase}/. ${CONTAINER.env}/`,
    "fi",
    'project="$1"',
    "shift",
    `exec ${CONTAINER.bin}/uv sync --project "$project" "$@"`,
  ].join("\n");
  return ["/bin/sh", "-c", script, "environment-build", checkout, ...args];
}

/**
 * Stand-ins for the package tools in an agent container's PATH (ADR 0066): the container has no
 * project environment and no package index, and these say what to do instead.
 */
export function agentToolShims(): Record<string, string> {
  const text = (name: string) =>
    [
      "#!/bin/sh",
      "# Written by AblationKit (ADR 0066).",
      "cat >&2 <<'EOF'",
      `${name}: not available in an AblationKit agent container. It has no project environment and`,
      "cannot reach package indexes: AblationKit runs and records the project's code as jobs.",
      "- To add or change packages: edit pyproject.toml, then build the environment with",
      "  ablationkit_job environment (uv sync in a job; it relocks and writes uv.lock). Wait for it",
      "  with ablationkit_wait.",
      "- To run code that needs the environment, tests and quick checks included: submit it with",
      '  ablationkit_job submit (environment "uv"; gpu "none" for CPU work, so it runs beside',
      "  GPU jobs without touching the GPU).",
      "EOF",
      "exit 127",
      "",
    ].join("\n");
  return Object.fromEntries(["uv", "uvx", "pip", "pip3"].map((n) => [n, text(n)]));
}

/** The `ablationkit` command inside a container: the mounted CLI, run by the mounted bun. */
export function cliWrapper(tree: string): string {
  return `#!/bin/sh\nexec ${CONTAINER.bin}/bun ${tree.replace(/\/+$/, "")}/apps/cli/src/main.ts "$@"\n`;
}

/** Quote one argument for a POSIX shell. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`;
}
