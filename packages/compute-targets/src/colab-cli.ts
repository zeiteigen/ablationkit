/**
 * Google Colab, unattended through Google's Colab CLI (`colab.mode: cli`; ADR 0059).
 *
 * The researcher signs the CLI in once (`colab sessions` in a terminal; the token stays in the OS
 * keyring). For each attempt the coordinator then:
 *
 * 1. `stage`: allocates a runtime (`colab new -s ak-<attempt> --gpu …`), creates the worker
 *    directory, uploads the bundle and the credentials through the runtime's file API, and
 *    verifies and unpacks the bundle there;
 * 2. `submit`: starts a *keeper* execution in the runtime's kernel: it starts the worker in its own
 *    session (so a kernel interrupt never reaches the job), keeps the kernel busy while the job
 *    runs (which keeps the runtime alive), writes `ak-keeper.json` every few seconds and a snapshot
 *    of the spool's journal every minute, and an archive of the whole spool when the job ends. The
 *    local `colab exec` is stopped once the keeper reports: the execution continues without it;
 * 3. `status` and `collect`: read `ak-keeper.json` and download the snapshots through the file API,
 *    which answers while the kernel is busy; the coordinator imports each through the same dedupe
 *    as `remote import`, so metrics appear while the job runs;
 * 4. `cancel`: uploads `ak-cancel`, which the keeper turns into `ablationkit_worker cancel`;
 * 5. `release`: `colab stop` once the results are home. A runtime nobody collects from is held
 *    `keep_after_sec` after the job, then left idle for Colab to reclaim.
 *
 * Code is always passed as a file (`-f`) and stdin is closed, so a CLI that is not signed in fails
 * at once instead of waiting for (or swallowing) an authorization code. The CLI's errors can carry
 * the runtime's proxy token; they are redacted before they are reported anywhere.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ComputeTarget } from "@ablationkit/protocol";
import { OFFLINE_CREDENTIALS } from "./colab.ts";
import type {
  AccountUsage,
  Capabilities,
  DoctorCheck,
  ProviderStatus,
  ShellResult,
  StageInput,
  StageResult,
  TargetAdapter,
} from "./targets.ts";
import { TargetError } from "./targets.ts";

export const COLAB_WORK_DIR = "/content/ablationkit";
const DEFAULT_KEEP_SEC = 3600;
/** How often the keeper snapshots the journal for progress. */
const PROGRESS_SEC = 60;

export const SIGNIN_HELP =
  "the Colab CLI is not signed in: run `colab sessions` once in a terminal, open the link it prints, approve, and paste the code (the token stays in your keyring)";

/** The CLI's output with tokens removed (its HTTP errors print the runtime's proxy token). */
export function redact(text: string): string {
  return text
    .replace(/(token=)[^&\s"']+/gi, "$1REDACTED")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "REDACTED")
    .replace(/(https:\/\/accounts\.google\.com\/\S+)/g, "<sign-in link>");
}

/** `colab usage` output: balance, hourly rate and runtimes of the whole account. */
export function parseColabUsage(text: string): AccountUsage | undefined {
  const balance = /Current balance:\s*(-?[0-9.]+)/.exec(text)?.[1];
  const rate = /Usage rate:\s*([0-9.]+)/.exec(text)?.[1];
  const runtimes = /Active assignments:\s*([0-9]+)/.exec(text)?.[1];
  if (balance === undefined || rate === undefined) return undefined;
  return { balance: Number(balance), per_hour: Number(rate), runtimes: Number(runtimes ?? 0) };
}

/** The runtime's session name for an attempt (the provider job ID). */
export function colabSession(attemptId: string): string {
  return `ak-${attemptId}`;
}

/** Where the attempt's worker directory lives on the runtime. */
export function colabDir(t: ComputeTarget, attemptId: string): string {
  return `${(t.work_dir ?? COLAB_WORK_DIR).replace(/\/$/, "")}/${attemptId}`;
}

const py = (v: unknown): string => JSON.stringify(v);

/** Make the worker directory (the file API cannot create directories). */
export function colabMkdirCode(dir: string): string {
  return [
    "import os",
    `os.makedirs(${py(dir)}, mode=0o700, exist_ok=True)`,
    `print("AK-DIR-READY", flush=True)`,
  ].join("\n");
}

/** Verify and unpack the uploaded bundle; refuse a directory whose worker already started. */
export function colabUnpackCode(dir: string, sha256: string): string {
  return [
    "import hashlib, os, tarfile",
    `D = ${py(dir)}`,
    'if os.path.exists(os.path.join(D, "state.json")):',
    '    print("AK-ALREADY-STARTED", flush=True)',
    "else:",
    '    data = open(os.path.join(D, "bundle.tgz"), "rb").read()',
    `    assert hashlib.sha256(data).hexdigest() == ${py(sha256)}, "bundle checksum mismatch"`,
    '    os.makedirs(os.path.join(D, "bundle"), exist_ok=True)',
    '    with tarfile.open(os.path.join(D, "bundle.tgz")) as tf:',
    "        for m in tf.getmembers():",
    '            assert not (m.name.startswith("/") or ".." in m.name.split("/") or m.issym() or m.islnk()), m.name',
    '        tf.extractall(os.path.join(D, "bundle"))',
    '    os.chmod(os.path.join(D, "credentials.json"), 0o600)',
    '    os.remove(os.path.join(D, "bundle.tgz"))',
    '    print("AK-STAGED", flush=True)',
  ].join("\n");
}

/**
 * The keeper: runs in the runtime's kernel for the whole job (see the module comment). It never
 * starts a second worker for the same directory.
 */
export function colabKeeperCode(
  t: ComputeTarget,
  input: { attemptId: string; session: string },
): string {
  const live = t.colab?.live === true;
  return [
    "import json, os, subprocess, sys, tarfile, time",
    `D = ${py(colabDir(t, input.attemptId))}`,
    // A kernel has no such variable; tests set it to see progress sooner.
    `PROGRESS_SEC = float(os.environ.get("ABLATIONKIT_COLAB_PROGRESS_SEC", "${PROGRESS_SEC}"))`,
    `KEEP_SEC = ${t.colab?.keep_after_sec ?? DEFAULT_KEEP_SEC}`,
    "",
    "def _write(path, value):",
    '    tmp = path + ".tmp"',
    '    with open(tmp, "w") as f:',
    "        json.dump(value, f)",
    "    os.replace(tmp, path)",
    "",
    "def _read(path):",
    "    try:",
    "        with open(path) as f:",
    "            return json.load(f)",
    "    except Exception:",
    "        return None",
    "",
    "def _snapshot(name, full):",
    '    tmp = os.path.join(D, "." + name + ".tmp")',
    "    try:",
    '        with tarfile.open(tmp, "w:gz") as tf:',
    '            if os.path.exists(os.path.join(D, "state.json")):',
    '                tf.add(os.path.join(D, "state.json"), "state.json")',
    '            spool = os.path.join(D, "spool")',
    "            if full:",
    '                tf.add(spool, "spool")',
    '            elif os.path.isdir(os.path.join(spool, "journal")):',
    '                tf.add(os.path.join(spool, "journal"), "spool/journal")',
    "        os.replace(tmp, os.path.join(D, name))",
    "        return True",
    "    except Exception as e:",
    '        print("snapshot failed:", e, flush=True)',
    "        return False",
    "",
    "def _keep():",
    '    k = os.path.join(D, "ak-keeper.json")',
    "    if os.path.exists(k):",
    '        print("AK-KEEPER-EXISTS", flush=True)',
    "        return",
    "    env = dict(os.environ)",
    '    env.pop("MPLBACKEND", None)',
    '    env["PYTHONPATH"] = os.path.join(D, "bundle", "worker")',
    `    env["ABLATIONKIT_WORKER_DELIVER_DEADLINE_SEC"] = ${py(String(live ? (t.colab?.deliver_deadline_sec ?? 120) : 0))}`,
    '    env.setdefault("ABLATIONKIT_WORKER_SUPERVISOR", "direct")',
    ...(live ? [] : ['    env["ABLATIONKIT_WORKER_OFFLINE"] = "1"']),
    '    log = open(os.path.join(D, "worker.out"), "ab")',
    "    p = subprocess.Popen(",
    `        [sys.executable, "-m", "ablationkit_worker", "run", "--dir", D, "--provider-job-id", ${py(input.session)}],`,
    "        env=env, cwd=D, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,",
    "        start_new_session=True,",
    "    )",
    "    seq = 0",
    "    cancelled = False",
    "    def status(phase, **extra):",
    '        _write(k, {"phase": phase, "worker_pid": p.pid, "progress": seq, "updated_at": time.time(),',
    '                   "cancel_requested": cancelled, "worker": _read(os.path.join(D, "state.json")), **extra})',
    '    status("running")',
    '    print("AK-KEEPER-STARTED", p.pid, flush=True)',
    "    last = time.monotonic()",
    "    while p.poll() is None:",
    "        time.sleep(2)",
    '        if not cancelled and os.path.exists(os.path.join(D, "ak-cancel")):',
    "            cancelled = True",
    "            subprocess.run([sys.executable, '-m', 'ablationkit_worker', 'cancel', '--dir', D], env=env, timeout=120)",
    "        if time.monotonic() - last >= PROGRESS_SEC:",
    "            last = time.monotonic()",
    '            if _snapshot("ak-progress.tgz", False):',
    "                seq += 1",
    '        status("running")',
    "    rc = p.returncode",
    '    ok = _snapshot("ak-final.tgz", True)',
    '    status("done" if ok else "archive_failed", exit_code=rc)',
    '    print("AK-KEEPER-DONE", rc, flush=True)',
    "    t0 = time.monotonic()",
    '    while time.monotonic() - t0 < KEEP_SEC and not os.path.exists(os.path.join(D, "ak-collected")):',
    "        time.sleep(10)",
    "",
    "_keep()",
    "",
  ].join("\n");
}

/**
 * Colab reports compute units for the whole account, so a runtime's rate is read as the rise in
 * the account's rate across its allocation. Allocations and releases on one account take turns,
 * so concurrent submissions do not count each other's runtimes.
 */
const accountTurns = new Map<string, Promise<unknown>>();

async function inTurn<T>(account: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountTurns.get(account) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  accountTurns.set(account, tail);
  try {
    return await next;
  } finally {
    if (accountTurns.get(account) === tail) accountTurns.delete(account);
  }
}

export interface ColabCliOptions {
  /** The CLI's session state file (`--config`): the coordinator keeps its runtimes apart. */
  readonly stateFile?: string;
}

interface KeeperStatus {
  phase?: string;
  progress?: number;
  exit_code?: number;
  worker?: Record<string, unknown> | null;
}

export class ColabCliTarget implements TargetAdapter {
  readonly kind = "colab" as const;
  readonly capabilities: Capabilities = {
    submit: true,
    status: true,
    cancel: true,
    drain: false,
    independent_supervision: true,
    paid: false,
    release: true,
    collects: true,
  };
  private readonly argv: readonly string[];

  constructor(
    readonly target: ComputeTarget,
    readonly opts: ColabCliOptions = {},
  ) {
    const c = target.colab ?? {};
    this.argv = [
      ...(c.cli ?? ["colab"]),
      ...(opts.stateFile ? ["--config", opts.stateFile] : []),
      ...(c.auth ? ["--auth", c.auth] : []),
    ];
  }

  /** Run one CLI command with stdin closed. Never throws for a non-zero exit. */
  async run(args: readonly string[], timeoutMs = 120_000): Promise<ShellResult> {
    let p: ReturnType<typeof Bun.spawn>;
    try {
      p = Bun.spawn([...this.argv, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
    } catch (e) {
      throw new TargetError(
        "colab_cli_missing",
        `cannot run ${this.argv[0]}: ${(e as Error).message} (install Google's Colab CLI: uv tool install google-colab-cli)`,
      );
    }
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout as ReadableStream).text(),
        new Response(p.stderr as ReadableStream).text(),
        p.exited,
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A failed command as a TargetError, classified (sign-in, entitlement, a runtime that is gone). */
  failure(what: string, r: ShellResult): TargetError {
    const text = `${r.stdout}\n${r.stderr}`;
    if (/To authorize colab-cli|Enter the authorization code/.test(text))
      return new TargetError("colab_signin_required", SIGNIN_HELP);
    if (/Session '[^']*' not found/.test(text))
      return new TargetError("runtime_gone", `${what}: the Colab runtime is gone`);
    const detail = redact(text)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^\[colab\] (Creating|Stopping|Using unique)/.test(l))
      .slice(-6)
      .join(" ")
      .slice(0, 800);
    if (/Backend rejected accelerator/.test(text))
      return new TargetError(
        "accelerator_unavailable",
        `${what}: ${detail} (\`colab usage\` shows the account's compute units)`,
      );
    if (/Allocation refused/.test(text))
      return new TargetError("allocation_refused", `${what}: ${detail}`);
    return new TargetError("target_command_failed", `${what} failed (exit ${r.code}): ${detail}`);
  }

  private async must(what: string, args: readonly string[], timeoutMs?: number): Promise<string> {
    const r = await this.run(args, timeoutMs);
    if (r.code !== 0) throw this.failure(what, r);
    return r.stdout;
  }

  /** Run Python in the runtime's kernel (idle only) and require `marker` in its output. */
  private async exec(
    session: string,
    code: string,
    marker: string,
    what: string,
    timeoutMs: number,
  ): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "ak-colab-"));
    try {
      const file = join(dir, "code.py");
      writeFileSync(file, code, { mode: 0o600 });
      const r = await this.run(
        ["exec", "-s", session, "-f", file, "--timeout", String(Math.ceil(timeoutMs / 1000))],
        timeoutMs + 60_000,
      );
      if (r.code !== 0 || !r.stdout.includes(marker)) {
        const f = this.failure(what, r);
        throw f.code === "target_command_failed"
          ? new TargetError(
              "target_command_failed",
              `${what} did not finish: ${redact(`${r.stdout}\n${r.stderr}`).trim().slice(-800)}`,
            )
          : f;
      }
      return r.stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async upload(session: string, local: string, remote: string): Promise<void> {
    await this.must(
      `uploading ${remote.split("/").at(-1)}`,
      ["upload", "-s", session, local, remote],
      30 * 60_000,
    );
  }

  /** Download a file; false when it does not exist (yet). Throws when the runtime is gone. */
  async download(session: string, remote: string, local: string): Promise<boolean> {
    const r = await this.run(["download", "-s", session, remote, local], 30 * 60_000);
    if (r.code === 0) return true;
    if (/File or directory not found/.test(`${r.stdout}${r.stderr}`)) return false;
    throw this.failure(`downloading ${remote.split("/").at(-1)}`, r);
  }

  /** The account's compute units now. */
  async usage(): Promise<AccountUsage> {
    const r = await this.run(["usage"], 90_000);
    const u = r.code === 0 ? parseColabUsage(r.stdout) : undefined;
    if (!u) throw this.failure("reading the account's compute units", r);
    return u;
  }

  /** The key allocations on one Google account take turns under. */
  private get account(): string {
    return `${this.opts.stateFile ?? "default"}:${this.target.colab?.auth ?? ""}`;
  }

  async stage(input: StageInput): Promise<StageResult> {
    const c = this.target.colab ?? {};
    const session = colabSession(input.attemptId);
    const dir = colabDir(this.target, input.attemptId);
    // The runtime's rate is how much the account's rate rises when it is allocated.
    const { before, after } = await inTurn(this.account, async () => {
      const before = await this.usage().catch((e: unknown) => {
        if (e instanceof TargetError && e.code === "colab_signin_required") throw e;
        return undefined;
      });
      await this.must(
        "allocating a Colab runtime",
        [
          "new",
          "-s",
          session,
          ...(c.tpu ? ["--tpu", c.tpu] : c.gpu ? ["--gpu", c.gpu] : []),
          ...(c.high_mem ? ["--high-mem"] : []),
        ],
        15 * 60_000,
      );
      // Colab may take a moment to count the new runtime in the account's rate.
      let after = before ? await this.usage().catch(() => undefined) : undefined;
      for (let i = 0; before && after && after.per_hour <= before.per_hour && i < 3; i++) {
        await Bun.sleep(2000);
        after = await this.usage().catch(() => after);
      }
      return { before, after };
    });
    // From here on a runtime is allocated (and billed): release it on any failure.
    const local = mkdtempSync(join(dirname(input.tgz), ".colab-"));
    try {
      await this.exec(
        session,
        colabMkdirCode(dir),
        "AK-DIR-READY",
        "preparing the runtime",
        300_000,
      );
      await this.upload(session, input.tgz, `${dir}/bundle.tgz`);
      const creds = join(local, "credentials.json");
      writeFileSync(creds, c.live === true ? input.credentials : OFFLINE_CREDENTIALS, {
        mode: 0o600,
      });
      await this.upload(session, creds, `${dir}/credentials.json`);
      const out = await this.exec(
        session,
        colabUnpackCode(dir, input.bundleSha256),
        "AK-",
        "unpacking the bundle",
        600_000,
      );
      if (!out.includes("AK-STAGED"))
        throw new TargetError("target_command_failed", "already staged and started on the runtime");
      return before && after
        ? {
            provider_job_id: session,
            compute_units: {
              per_hour_hundredths: Math.max(
                0,
                Math.round((after.per_hour - before.per_hour) * 100),
              ),
              balance_at_allocation_hundredths: Math.round(before.balance * 100),
            },
          }
        : { provider_job_id: session };
    } catch (e) {
      await this.run(["stop", "-s", session], 120_000).catch(() => undefined);
      throw e;
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  }

  async submit(input: StageInput): Promise<{ provider_job_id: string }> {
    const session = colabSession(input.attemptId);
    const local = mkdtempSync(join(tmpdir(), "ak-colab-"));
    const file = join(local, "keeper.py");
    writeFileSync(file, colabKeeperCode(this.target, { attemptId: input.attemptId, session }), {
      mode: 0o600,
    });
    let out = "";
    let err = "";
    try {
      const p = Bun.spawn([...this.argv, "exec", "-s", session, "-f", file, "--timeout", "0"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      const started = await waitFor(p, /AK-KEEPER-(STARTED|EXISTS)/, 300_000, (o, e) => {
        out = o;
        err = e;
      });
      // The execution continues in the runtime's kernel without this client.
      p.kill("SIGTERM");
      if (started) return { provider_job_id: session };
      // No marker: if the keeper reported anyway, it runs; otherwise nothing runs, so release.
      const probe = join(local, "keeper.json");
      if (
        await this.download(
          session,
          `${colabDir(this.target, input.attemptId)}/ak-keeper.json`,
          probe,
        ).catch(() => false)
      )
        return { provider_job_id: session };
      const f = this.failure("starting the worker", { code: 1, stdout: out, stderr: err });
      await this.run(["stop", "-s", session], 120_000).catch(() => undefined);
      throw f.code === "target_command_failed"
        ? new TargetError(
            "target_command_failed",
            `the worker did not start on the runtime (it was released): ${redact(`${out}\n${err}`).trim().slice(-800)}`,
          )
        : f;
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  }

  private async keeper(attemptId: string, session: string): Promise<KeeperStatus | undefined> {
    const local = mkdtempSync(join(tmpdir(), "ak-colab-"));
    try {
      const f = join(local, "keeper.json");
      if (!(await this.download(session, `${colabDir(this.target, attemptId)}/ak-keeper.json`, f)))
        return undefined;
      try {
        return JSON.parse(await Bun.file(f).text()) as KeeperStatus;
      } catch {
        return undefined;
      }
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  }

  async status(attemptId: string, session: string): Promise<ProviderStatus> {
    let k: KeeperStatus | undefined;
    try {
      k = await this.keeper(attemptId, session);
    } catch (e) {
      if (e instanceof TargetError && e.code === "runtime_gone")
        return { state: "runtime gone", terminal: true };
      throw e;
    }
    if (!k) return { state: "starting", terminal: false };
    const worker = k.worker ?? undefined;
    const progress = typeof k.progress === "number" ? k.progress : undefined;
    if (k.phase === "running")
      return {
        state: worker?.["phase"] ? `running (worker ${String(worker["phase"])})` : "running",
        terminal: false,
        ...(worker ? { worker } : {}),
        ...(progress !== undefined ? { progress } : {}),
      };
    return {
      state:
        k.phase === "done"
          ? `job ended (worker exit ${k.exit_code ?? "?"})`
          : `job ended; archiving failed (worker exit ${k.exit_code ?? "?"})`,
      terminal: true,
      ...(worker ? { worker } : {}),
      ...(progress !== undefined ? { progress } : {}),
    };
  }

  /** Download the final archive (or, before the job ended, the latest progress snapshot). */
  async collect(
    attemptId: string,
    session: string,
    dest: string,
    opts: { final: boolean },
  ): Promise<boolean> {
    const name = opts.final ? "ak-final.tgz" : "ak-progress.tgz";
    return this.download(session, `${colabDir(this.target, attemptId)}/${name}`, dest);
  }

  /** Ask the keeper to stop the job (the file API answers while the kernel is busy). */
  async cancel(attemptId: string, session: string): Promise<void> {
    const local = mkdtempSync(join(tmpdir(), "ak-colab-"));
    try {
      const f = join(local, "ak-cancel");
      writeFileSync(f, `${new Date().toISOString()}\n`);
      await this.upload(session, f, `${colabDir(this.target, attemptId)}/ak-cancel`);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  }

  async drain(): Promise<void> {
    throw new TargetError(
      "not_supported",
      "the coordinator collects a Colab runtime's results itself (remote drain collects them now)",
    );
  }

  async reauthorize(attemptId: string, credentials: string): Promise<void> {
    if (this.target.colab?.live !== true)
      throw new TargetError("not_supported", "this runtime's worker has no credentials (offline)");
    const session = colabSession(attemptId);
    const local = mkdtempSync(join(tmpdir(), "ak-colab-"));
    try {
      const f = join(local, "credentials.json");
      writeFileSync(f, credentials, { mode: 0o600 });
      await this.upload(session, f, `${colabDir(this.target, attemptId)}/credentials.json`);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  }

  /** Stop the runtime (it stops billing). A runtime that is already gone is fine. */
  async release(_attemptId: string, session: string): Promise<void> {
    const r = await inTurn(this.account, () => this.run(["stop", "-s", session], 120_000));
    if (r.code !== 0 && !/not found/.test(`${r.stdout}${r.stderr}`))
      throw this.failure("stopping the Colab runtime", r);
  }

  async doctor(workerUrl: string): Promise<DoctorCheck[]> {
    const c = this.target.colab ?? {};
    const checks: DoctorCheck[] = [];
    let v: ShellResult;
    try {
      v = await this.run(["version"], 60_000);
    } catch (e) {
      return [{ name: "colab cli", ok: false, detail: (e as Error).message }];
    }
    checks.push({
      name: "colab cli",
      ok: v.code === 0,
      detail:
        v.code === 0
          ? `Google's Colab CLI ${v.stdout.trim().replace(/^Version:\s*/, "")}`
          : `${redact(v.stderr || v.stdout)
              .trim()
              .slice(0, 300)} (install it: uv tool install google-colab-cli)`,
    });
    if (v.code !== 0) return checks;
    const s = await this.run(["sessions"], 90_000);
    const signedIn = s.code === 0;
    checks.push({
      name: "signed in",
      ok: signedIn,
      detail: signedIn
        ? `the CLI answers for your Google account (${
            s.stdout.includes("No active sessions")
              ? "no runtimes"
              : `${
                  s.stdout
                    .trim()
                    .split("\n")
                    .filter((l) => l.startsWith("[")).length
                } runtimes`
          })`
        : this.failure("listing runtimes", s).message,
    });
    if (signedIn) {
      const u = await this.run(["usage"], 90_000);
      checks.push({
        name: "compute units",
        ok: u.code === 0,
        detail: redact(u.stdout || u.stderr)
          .trim()
          .replace(/\s*\n\s*/g, "; ")
          .slice(0, 300),
      });
    }
    checks.push({
      name: "runtime",
      ok: true,
      detail: `${c.tpu ? `TPU ${c.tpu}` : c.gpu ? `GPU ${c.gpu}` : "CPU (no gpu or tpu set)"}${c.high_mem ? ", high RAM" : ""}; availability depends on the account's Colab plan and compute units, and a refused accelerator fails the submission without running it`,
    });
    checks.push({
      name: "unattended execution",
      ok: true,
      detail: `advisory: the job runs while the runtime's kernel is busy, so it does not need this workstation; Colab can still reclaim a runtime (usage limits, maximum lifetime). A runtime whose results were not collected is held ${c.keep_after_sec ?? DEFAULT_KEEP_SEC} s after the job, then left idle for Colab to reclaim`,
    });
    checks.push({
      name: "live delivery",
      ok: true,
      detail: c.live
        ? `on: the worker delivers to ${workerUrl} when Colab can reach it; collection covers the rest`
        : "off: the worker spools on the runtime and the coordinator collects its results",
    });
    return checks;
  }
}

/** Read a process's output until `re` matches (true), it exits, or the time runs out (false). */
async function waitFor(
  p: ReturnType<typeof Bun.spawn>,
  re: RegExp,
  timeoutMs: number,
  seen: (stdout: string, stderr: string) => void,
): Promise<boolean> {
  let out = "";
  let err = "";
  const decoder = new TextDecoder();
  const errDone = (async () => {
    for await (const chunk of p.stderr as ReadableStream<Uint8Array>) {
      err += decoder.decode(chunk);
      if (err.length > 64_000) err = err.slice(-32_000);
    }
  })();
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
  // One clearable timer: a pending sleep would keep a short-lived process alive.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ done: true; value: undefined }>((resolve) => {
    timer = setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs);
  });
  let found = false;
  try {
    while (!found) {
      const r = await Promise.race([reader.read(), timedOut]);
      if (r.value) out += decoder.decode(r.value);
      if (re.test(out)) found = true;
      if (r.done) break;
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
    seen(out, err);
  }
  if (!found) await Promise.race([errDone, Bun.sleep(1000)]);
  seen(out, err);
  return found;
}
