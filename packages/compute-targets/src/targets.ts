/**
 * Compute target adapters (spec §10: validate → package → estimate → submit → status → logs →
 * artifacts → cancel; adapters declare capabilities instead of promising parity). ADR 0023.
 *
 * `ssh` and `slurm` reach the worker host (or the cluster's login node) with the user's own SSH.
 * The bundle is streamed over SSH's stdin, so no shared filesystem or scp is assumed. On SLURM the
 * worker directory must live on a filesystem shared by the login and compute nodes (usually $HOME),
 * because a drain after the allocation ended runs on the login node.
 */
import { readFileSync } from "node:fs";
import type { ComputeTarget, JobLimits, TargetKind } from "@ablationkit/protocol";
import { ColabTarget } from "./colab.ts";
import { RunpodTarget } from "./runpod.ts";

export interface ShellResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Shell {
  run(script: string, opts?: { stdin?: Uint8Array; timeoutMs?: number }): Promise<ShellResult>;
}

/** Single-quote for a POSIX shell. */
export function sq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** A remote path for the shell: `~/x` becomes `"$HOME"/'x'` (quoting `~` would stop expansion). */
export function remotePath(p: string): string {
  if (p === "~") return `"$HOME"`;
  if (p.startsWith("~/")) return `"$HOME"/${sq(p.slice(2))}`;
  return sq(p);
}

export function sshShell(cfg: NonNullable<ComputeTarget["ssh"]>): Shell {
  const argv = cfg.command
    ? [...cfg.command]
    : [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        ...(cfg.port ? ["-p", String(cfg.port)] : []),
        ...(cfg.identity_file ? ["-i", cfg.identity_file] : []),
      ];
  return {
    async run(script, opts = {}) {
      const p = Bun.spawn([...argv, cfg.host, script], {
        stdin: opts.stdin ? new Blob([opts.stdin]) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ]);
        return { code, stdout, stderr };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface Capabilities {
  /** Unattended submission. */
  readonly submit: boolean;
  readonly status: boolean;
  /** Provider-native cancellation (independent of the worker's heartbeat). */
  readonly cancel: boolean;
  /** Deliver a leftover spool after the job ended. */
  readonly drain: boolean;
  /** The job's lifetime is supervised independently of the coordinator (spec §2.1). */
  readonly independent_supervision: boolean;
  readonly paid: boolean;
  /** The worker downloads its bundle from the coordinator (no `stage` copy). */
  readonly pulls_bundle?: boolean;
  /** Provider resources outlive the job and are released once results are delivered. */
  readonly release?: boolean;
  /** No unattended submission: `stage` writes an artifact a human runs (a Colab notebook). */
  readonly exports?: boolean;
}

export interface ProviderStatus {
  /** Raw provider status, shown as is. */
  readonly state: string;
  /** The provider says the job (or the worker) is no longer running. */
  readonly terminal: boolean;
  /** The worker's own state.json, when the provider can read it. */
  readonly worker?: Record<string, unknown>;
}

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface StageInput {
  readonly attemptId: string;
  readonly jobId: string;
  readonly workerUrl: string;
  readonly bundleSha256: string;
  readonly tgz: string;
  readonly credentials: string;
  readonly limits: JobLimits;
}

export interface TargetAdapter {
  readonly kind: TargetKind;
  readonly capabilities: Capabilities;
  /** Copy the bundle and the credentials to the worker. */
  stage(input: StageInput): Promise<void>;
  /** Start the job; resolves once the provider confirmed it, with the provider's job ID. */
  submit(input: StageInput): Promise<{ provider_job_id: string }>;
  status(attemptId: string, providerJobId: string): Promise<ProviderStatus>;
  cancel(attemptId: string, providerJobId: string): Promise<void>;
  /** Deliver what is left of a spool without starting anything. */
  drain(attemptId: string, providerJobId?: string): Promise<void>;
  /** Replace the worker's credentials (re-authorization after a long disconnection). */
  reauthorize(attemptId: string, credentials: string): Promise<void>;
  doctor(workerUrl: string): Promise<DoctorCheck[]>;
  /** Release provider resources after delivery (capability `release`). */
  release?(attemptId: string, providerJobId: string): Promise<void>;
}

export class TargetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TargetError";
  }
}

const SLURM_TERMINAL =
  /^(COMPLETED|FAILED|CANCELLED|TIMEOUT|NODE_FAIL|PREEMPTED|OUT_OF_MEMORY|BOOT_FAIL|DEADLINE|REVOKED|SPECIAL_EXIT)/;

function check(r: ShellResult, what: string): string {
  if (r.code !== 0)
    throw new TargetError(
      "target_command_failed",
      `${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 1000)}`,
    );
  return r.stdout;
}

/** Shared by `ssh` and `slurm`: staging, the worker CLI, status of the worker directory. */
class SshBase {
  readonly workDir: string;
  readonly python: string;

  constructor(
    readonly target: ComputeTarget,
    readonly shell: Shell,
  ) {
    this.workDir = target.work_dir ?? "~/.ablationkit-worker";
    this.python = target.python ?? "python3";
  }

  dir(attemptId: string): string {
    return `${remotePath(this.workDir)}/${sq(attemptId)}`;
  }

  /** `D=<dir>; export PYTHONPATH=…` prefix for worker commands. */
  prelude(attemptId: string): string {
    return `D=${this.dir(attemptId)}; export PYTHONPATH="$D/bundle/worker"; `;
  }

  worker(cmd: string): string {
    return `${sq(this.python)} -m ablationkit_worker ${cmd} --dir "$D"`;
  }

  async stage(input: StageInput): Promise<void> {
    const pre = this.prelude(input.attemptId);
    const tgz = new Uint8Array(readFileSync(input.tgz));
    check(
      await this.shell.run(
        `${pre}set -e; if [ -e "$D/state.json" ]; then echo "already staged and started" >&2; exit 17; fi; ` +
          `umask 077; mkdir -p "$D/bundle"; tar -xzf - -C "$D/bundle"`,
        { stdin: tgz, timeoutMs: 600_000 },
      ),
      "copying the bundle",
    );
    await this.reauthorize(input.attemptId, input.credentials);
  }

  async reauthorize(attemptId: string, credentials: string): Promise<void> {
    check(
      await this.shell.run(
        `${this.prelude(attemptId)}set -e; umask 077; cat > "$D/credentials.json.tmp"; mv "$D/credentials.json.tmp" "$D/credentials.json"`,
        { stdin: new TextEncoder().encode(credentials) },
      ),
      "writing the worker credentials",
    );
  }

  async readState(attemptId: string): Promise<Record<string, unknown> | undefined> {
    const r = await this.shell.run(
      `${this.prelude(attemptId)}if [ -f "$D/state.json" ]; then cat "$D/state.json"; fi`,
    );
    if (r.code !== 0 || !r.stdout.trim()) return undefined;
    try {
      return JSON.parse(r.stdout) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  async drain(attemptId: string): Promise<void> {
    check(
      await this.shell.run(
        `${this.prelude(attemptId)}setsid nohup ${this.worker("drain")} >>"$D/drain.out" 2>&1 </dev/null & echo started`,
      ),
      "starting a drain",
    );
  }

  async cancelLocal(attemptId: string): Promise<void> {
    await this.shell.run(`${this.prelude(attemptId)}${this.worker("cancel")}`);
  }

  async doctor(workerUrl: string): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const py = await this.shell.run(
      `${sq(this.python)} -c 'import sys; print("%d.%d" % sys.version_info[:2]); sys.exit(0 if sys.version_info >= (3, 10) else 1)'`,
      { timeoutMs: 30_000 },
    );
    checks.push({
      name: "ssh and python",
      ok: py.code === 0,
      detail:
        py.code === 0
          ? `Python ${py.stdout.trim()} on ${this.target.ssh?.host}`
          : (py.stderr || py.stdout).trim().slice(0, 500) || `exit ${py.code}`,
    });
    if (py.code !== 0) return checks;
    const url = `${workerUrl.replace(/\/$/, "")}/api/v1/health`;
    const reach = await this.shell.run(
      `${sq(this.python)} -c ${sq(`import urllib.request,sys; r=urllib.request.urlopen(${JSON.stringify(url)}, timeout=10); print(r.status)`)}`,
      { timeoutMs: 30_000 },
    );
    checks.push({
      name: "worker listener reachable from the target",
      ok: reach.code === 0 && reach.stdout.trim() === "200",
      detail:
        reach.code === 0
          ? `${url} answered ${reach.stdout.trim()}`
          : `${url}: ${(reach.stderr || reach.stdout).trim().split("\n").at(-1)?.slice(0, 300)}`,
    });
    const wd = await this.shell.run(
      `mkdir -p ${remotePath(this.workDir)} && test -w ${remotePath(this.workDir)} && df -Pk ${remotePath(this.workDir)} | tail -1`,
    );
    checks.push({
      name: "work directory",
      ok: wd.code === 0,
      detail:
        wd.code === 0
          ? `${this.workDir}: ${Math.round(Number(wd.stdout.trim().split(/\s+/)[3] ?? 0) / 1024)} MiB free`
          : (wd.stderr || wd.stdout).trim().slice(0, 300),
    });
    return checks;
  }
}

/** A worker host over SSH: the worker runs as a systemd user service (or `setsid nohup`). */
export class SshTarget extends SshBase implements TargetAdapter {
  readonly kind = "ssh" as const;
  readonly capabilities: Capabilities = {
    submit: true,
    status: true,
    cancel: true,
    drain: true,
    independent_supervision: true,
    paid: false,
  };

  async submit(input: StageInput): Promise<{ provider_job_id: string }> {
    const unit = `ak-worker-${input.attemptId}`;
    const mode = this.target.ssh?.supervisor ?? "auto";
    const nohup = `setsid nohup ${this.worker("run")} >>"$D/worker.out" 2>&1 </dev/null & echo "pid:$!"`;
    const systemd =
      `systemd-run --user --quiet --unit=${sq(unit)} --property=KillMode=process ` +
      `--property=Restart=on-failure --property=RestartSec=5 ` +
      `--property=RestartPreventExitStatus=${sq("0 2 3 4 75")} --setenv=PYTHONPATH="$D/bundle/worker" ` +
      `${this.worker("run")} && echo ${sq(`systemd:${unit}`)}`;
    const script =
      mode === "nohup"
        ? nohup
        : mode === "systemd"
          ? systemd
          : `if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --quiet --scope true 2>/dev/null; then ${systemd}; else ${nohup}; fi`;
    const out = check(
      await this.shell.run(`${this.prelude(input.attemptId)}${script}`),
      "starting the worker",
    );
    const id = out.trim().split("\n").at(-1) ?? "";
    if (!/^(pid:[0-9]+|systemd:[A-Za-z0-9:_.-]+)$/.test(id))
      throw new TargetError(
        "target_command_failed",
        `unexpected worker start output: ${out.slice(0, 300)}`,
      );
    return { provider_job_id: id };
  }

  async status(attemptId: string, providerJobId: string): Promise<ProviderStatus> {
    const [kind, ref] = providerJobId.split(":") as [string, string];
    const probe =
      kind === "systemd"
        ? `systemctl --user is-active ${sq(`${ref}.service`)} 2>/dev/null || true`
        : `if kill -0 ${Number(ref)} 2>/dev/null; then echo active; else echo inactive; fi`;
    const r = await this.shell.run(probe);
    if (r.code !== 0) throw new TargetError("target_unreachable", r.stderr.trim().slice(0, 500));
    const state = r.stdout.trim().split("\n").at(-1) || "unknown";
    const worker = await this.readState(attemptId);
    return {
      state,
      terminal: state !== "active" && state !== "activating" && state !== "reloading",
      ...(worker ? { worker } : {}),
    };
  }

  async cancel(attemptId: string): Promise<void> {
    await this.cancelLocal(attemptId);
  }
}

function slurmTime(limits: JobLimits, drainSec: number): string | undefined {
  if (!limits.runtime_max_sec) return undefined;
  const min = Math.ceil((limits.runtime_max_sec + drainSec) / 60) + 2;
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}:00`;
}

/** The `sbatch` script for one attempt (reproducible: everything else is in the bundle). */
export function sbatchScript(
  target: ComputeTarget,
  attemptId: string,
  limits: JobLimits,
  dir: string,
): string {
  const s = target.slurm ?? {};
  const drainSec = s.drain_sec ?? 300;
  const python = target.python ?? "python3";
  const time = slurmTime(limits, drainSec);
  const lines = [
    "#!/bin/bash",
    `#SBATCH --job-name=ak-${attemptId}`,
    "#SBATCH --output=slurm-%j.out",
    // Never rerun: a requeued job would duplicate paid work (spec §5.3); the worker refuses too.
    "#SBATCH --no-requeue",
    ...(time ? [`#SBATCH --time=${time}`] : []),
    ...(limits.memory_max_bytes
      ? [`#SBATCH --mem=${Math.ceil(limits.memory_max_bytes / (1024 * 1024))}M`]
      : []),
    ...(limits.cpu_quota_percent
      ? [`#SBATCH --cpus-per-task=${Math.max(1, Math.ceil(limits.cpu_quota_percent / 100))}`]
      : []),
    ...(s.partition ? [`#SBATCH --partition=${s.partition}`] : []),
    ...(s.account ? [`#SBATCH --account=${s.account}`] : []),
    ...(s.qos ? [`#SBATCH --qos=${s.qos}`] : []),
    ...(s.gres ? [`#SBATCH --gres=${s.gres}`] : []),
    ...(s.directives ?? []).map((d) => `#SBATCH ${d}`),
    "",
    `D=${dir}`,
    'export PYTHONPATH="$D/bundle/worker"',
    // Inside the allocation the worker delivers for at most drain_sec after the job exits; the
    // rest is drained from the login node, so a slow network does not burn allocation time.
    `export ABLATIONKIT_WORKER_DELIVER_DEADLINE_SEC=${drainSec}`,
    `${sq(python)} -m ablationkit_worker run --dir "$D" --provider-job-id "$SLURM_JOB_ID"`,
    "rc=$?",
    // 75: the job ended and its results wait in the spool for a drain from the login node. The
    // allocation's state reflects the worker, not the job; the job's outcome is in its exit record.
    '[ "$rc" = 75 ] && exit 0',
    "exit $rc",
    "",
  ];
  return lines.join("\n");
}

/** A SLURM cluster: bundles are staged on the login node and submitted with `sbatch`. */
export class SlurmTarget extends SshBase implements TargetAdapter {
  readonly kind = "slurm" as const;
  readonly capabilities: Capabilities = {
    submit: true,
    status: true,
    cancel: true,
    drain: true,
    independent_supervision: true,
    paid: false,
  };

  async submit(input: StageInput): Promise<{ provider_job_id: string }> {
    const pre = this.prelude(input.attemptId);
    const script = sbatchScript(
      this.target,
      input.attemptId,
      input.limits,
      this.dir(input.attemptId),
    );
    check(
      await this.shell.run(`${pre}set -e; umask 077; cat > "$D/job.sbatch"`, {
        stdin: new TextEncoder().encode(script),
      }),
      "writing the sbatch script",
    );
    const out = check(
      await this.shell.run(`${pre}cd "$D" && sbatch --parsable job.sbatch`),
      "sbatch",
    );
    const id = (out.trim().split("\n").at(-1) ?? "").split(";")[0] ?? "";
    if (!/^[0-9]+(_[0-9]+)?$/.test(id))
      throw new TargetError(
        "target_command_failed",
        `sbatch printed no job ID: ${out.slice(0, 300)}`,
      );
    return { provider_job_id: id };
  }

  async status(attemptId: string, providerJobId: string): Promise<ProviderStatus> {
    const id = sq(providerJobId);
    const r = await this.shell.run(
      `S=$(sacct -j ${id} -X -n -P -o State 2>/dev/null | head -1); ` +
        `if [ -z "$S" ]; then S=$(squeue -h -j ${id} -o %T 2>/dev/null | head -1); fi; echo "\${S:-UNKNOWN}"`,
    );
    if (r.code !== 0) throw new TargetError("target_unreachable", r.stderr.trim().slice(0, 500));
    const state = (r.stdout.trim().split("\n").at(-1) ?? "UNKNOWN").trim() || "UNKNOWN";
    const worker = await this.readState(attemptId);
    return { state, terminal: SLURM_TERMINAL.test(state), ...(worker ? { worker } : {}) };
  }

  async cancel(attemptId: string, providerJobId: string): Promise<void> {
    await this.cancelLocal(attemptId);
    check(await this.shell.run(`scancel ${sq(providerJobId)}`), "scancel");
  }
}

export function adapterFor(target: ComputeTarget, shell?: Shell): TargetAdapter {
  switch (target.kind) {
    case "ssh":
    case "slurm": {
      if (!target.ssh)
        throw new TargetError("invalid_target", `${target.kind} targets need \`ssh\``);
      const sh = shell ?? sshShell(target.ssh);
      return target.kind === "ssh" ? new SshTarget(target, sh) : new SlurmTarget(target, sh);
    }
    case "runpod":
      return new RunpodTarget(target);
    case "colab":
      return new ColabTarget(target);
    default:
      throw new TargetError(
        "target_kind_unavailable",
        `${target.kind} targets are not available yet`,
      );
  }
}

/** Configuration problems that make a target unusable (validated at add time). */
export function validateTarget(t: ComputeTarget): string[] {
  const errs: string[] = [];
  if (t.target_id === "local") errs.push("`local` is reserved for this machine");
  if ((t.kind === "ssh" || t.kind === "slurm") && !t.ssh)
    errs.push(`${t.kind} targets need \`ssh\``);
  if (t.kind !== "slurm" && t.slurm) errs.push("`slurm` settings apply to slurm targets only");
  if (t.kind === "runpod" && !t.runpod) errs.push("runpod targets need `runpod`");
  if (t.kind !== "runpod" && t.runpod) errs.push("`runpod` settings apply to runpod targets only");
  if (t.kind !== "colab" && t.colab) errs.push("`colab` settings apply to colab targets only");
  if (t.kind === "runpod" && !t.paid) errs.push("runpod targets are paid compute (`paid: true`)");
  return errs;
}
