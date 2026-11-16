/**
 * The container runtime (ADR 0061): rootless Podman, called as the researcher's user. Its binary
 * is `ABLATIONKIT_PODMAN` or `podman` on the coordinator's PATH. Every call is short and
 * synchronous except the container itself, which runs in a terminal (containers.ts).
 */
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ContainerStatus = "running" | "paused" | "exited" | "created" | "missing" | "other";

export interface RuntimeReport {
  readonly available: boolean;
  readonly binary?: string;
  readonly version?: string;
  readonly rootless?: boolean;
  readonly cgroup_version?: string;
  /** A CDI spec that names NVIDIA GPUs (for `--device nvidia.com/gpu=all` in job containers). */
  readonly gpu_cdi?: string;
  readonly tmux?: string;
  readonly problems: string[];
}

export const CDI_SPECS: readonly string[] = [
  "/var/run/cdi/nvidia.yaml",
  "/etc/cdi/nvidia.yaml",
  "/run/cdi/nvidia.yaml",
];

export class Podman {
  constructor(
    readonly bin: string = process.env["ABLATIONKIT_PODMAN"] ?? "podman",
    private readonly cdiSpecs: readonly string[] = CDI_SPECS,
  ) {}

  run(args: readonly string[], timeoutMs = 60_000): RunResult {
    try {
      const p = Bun.spawnSync([this.bin, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
      });
      return {
        code: p.exitCode ?? -1,
        stdout: p.stdout.toString(),
        stderr: p.stderr.toString(),
      };
    } catch (e) {
      return { code: -1, stdout: "", stderr: (e as Error).message };
    }
  }

  /** The absolute path of the binary, for scripts the coordinator writes. */
  resolved(): string | undefined {
    const found = this.bin.startsWith("/") ? this.bin : Bun.which(this.bin);
    return found && existsSync(found) ? found : undefined;
  }

  report(tmux: string): RuntimeReport {
    const problems: string[] = [];
    const binary = this.resolved();
    if (!binary) {
      problems.push(
        `Podman is not installed (or not on the coordinator's PATH): install it (on Arch, \`sudo pacman -S podman passt\`) or set ABLATIONKIT_PODMAN`,
      );
      return { available: false, problems };
    }
    const info = this.run([
      "info",
      "--format",
      "{{.Version.Version}}|{{.Host.Security.Rootless}}|{{.Host.CgroupsVersion}}",
    ]);
    const [version, rootless, cgroup] = info.stdout.trim().split("|");
    if (info.code !== 0)
      problems.push(`\`podman info\` failed: ${info.stderr.trim().slice(0, 300)}`);
    else if (rootless !== "true")
      problems.push("Podman is not running rootless: AblationKit runs containers as you, not root");
    const gpu = this.cdiSpecs.find((p) => existsSync(p));
    const tmuxPath = tmux.startsWith("/") ? tmux : Bun.which(tmux);
    if (!tmuxPath) problems.push("tmux is not installed: agent containers run in a tmux terminal");
    return {
      available: info.code === 0,
      binary,
      ...(version ? { version } : {}),
      ...(rootless ? { rootless: rootless === "true" } : {}),
      ...(cgroup ? { cgroup_version: cgroup } : {}),
      ...(gpu ? { gpu_cdi: gpu } : {}),
      ...(tmuxPath ? { tmux: tmuxPath } : {}),
      problems,
    };
  }

  /** The image's ID, or undefined when it is not present. */
  imageId(image: string): string | undefined {
    const r = this.run(["image", "inspect", "--format", "{{.Id}}", image]);
    return r.code === 0 ? r.stdout.trim().split("\n")[0] || undefined : undefined;
  }

  status(name: string): ContainerStatus {
    const r = this.run(["container", "inspect", "--format", "{{.State.Status}}", name], 15_000);
    if (r.code !== 0) return "missing";
    const s = r.stdout.trim();
    return s === "running" || s === "paused" || s === "exited" || s === "created" ? s : "other";
  }

  pause(name: string): RunResult {
    return this.run(["pause", name]);
  }

  unpause(name: string): RunResult {
    return this.run(["unpause", name]);
  }

  stop(name: string, graceSec = 10): RunResult {
    return this.run(["stop", "--time", String(graceSec), name], (graceSec + 30) * 1000);
  }

  /** Remove a container whatever its state; quiet when it is already gone. */
  remove(name: string): void {
    this.run(["rm", "--force", "--ignore", name], 60_000);
  }
}

export class BinaryError extends Error {}

/**
 * A binary from this machine to mount into a container: absolute, a regular file and an ELF
 * executable (a version manager's shell shim would not run inside). Symlinks are resolved.
 */
export function hostBinary(path: string, what: string): string {
  if (!path.startsWith("/")) throw new BinaryError(`${what}: ${path} is not an absolute path`);
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new BinaryError(`${what}: ${path} does not exist`);
  }
  if (!statSync(real).isFile()) throw new BinaryError(`${what}: ${real} is not a file`);
  const head = Buffer.alloc(4);
  const fd = openSync(real, "r");
  try {
    readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  const name = real.split("/").at(-1) ?? "";
  if (["mise", "rtx", "busybox", "toybox"].includes(name))
    throw new BinaryError(
      `${what}: ${path} is ${real}, a multi-call binary that picks a tool by its name (a version manager's wrapper?); give the real binary's path (for mise: \`mise which ${what}\`)`,
    );
  if (head[0] !== 0x7f || head.toString("latin1", 1, 4) !== "ELF")
    throw new BinaryError(
      `${what}: ${real} is not an executable binary (a version manager's shim?); give the real binary's path`,
    );
  return real;
}
