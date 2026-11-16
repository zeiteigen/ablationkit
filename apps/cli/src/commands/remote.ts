/**
 * `ablationkit target …` (compute targets) and `ablationkit remote …` (actions on remote
 * attempts). ADR 0023. A job reaches a target from the web UI's launch dialog, or from an agent's
 * `ablationkit_job submit` with `target_id` (ADR 0040).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { colabLoader, parsePrintedArchive } from "@ablationkit/compute-targets";
import { CoordinatorClient } from "../client.ts";
import { type CliContext, flag, parseArgs, printJson, UsageError } from "../context.ts";

const TARGET_USAGE = `usage:
  ablationkit target list
  ablationkit target show ID
  ablationkit target add ID --kind ssh|slurm --host [USER@]HOST [options]
      --port N --identity FILE      SSH options (your own SSH keys and config are used)
      --work-dir DIR                where bundles are unpacked (default ~/.ablationkit-worker)
      --python PATH                 Python 3.10+ on the worker (default python3)
      --worker-url URL              how workers reach this coordinator (default: settings remote.worker_url)
      --supervisor auto|systemd|nohup   (ssh) how the worker is kept alive
      --partition P --account A --qos Q --gres G --directive --opt=V…   (slurm)
      --drain-sec N                 (slurm) delivery time inside the allocation after the job
      --ntfy URL [--ntfy-token-env VAR]   workers notify this ntfy topic
  ablationkit target add ID --kind runpod --api-key-env VAR --image IMG --gpu TYPE… [options]
      --gpu-count N --cloud SECURE|COMMUNITY --volume-gb N --container-disk-gb N --network-volume ID
      --tailscale-secret NAME       Runpod secret with a reusable Tailscale auth key (pods join the tailnet)
      --cents-per-hour N            rate card for estimates
      --deliver-deadline-sec N      delivery time before a pod stops itself (default 3600)
  ablationkit target add ID --kind colab [--live]   notebooks to run yourself; --live embeds credentials
  ablationkit target add ID --file TARGET.json    any kind, from a ComputeTarget document
  ablationkit target doctor ID      SSH, Python, the worker listener from the target, disk
  ablationkit target remove ID
  (all take --json and --coordinator URL)`;

const REMOTE_USAGE = `usage:
  ablationkit remote status JOB             compute, connectivity and sync status of each attempt
  ablationkit remote drain JOB              deliver a leftover worker spool (never reruns the job)
  ablationkit remote reauthorize JOB        new credentials for a worker whose launch token expired
  ablationkit remote resolve JOB --note T   accept an ambiguous outcome after checking the target
  ablationkit remote resolve JOB --lost [--note T]   an exported (Colab) attempt that will not report
      back: it ends unknown, releasing its slot; a late import still lands
  ablationkit remote import JOB ARCHIVE     ingest a worker directory archived on an isolated runtime
      (tar -czf spool.tgz -C <work-dir>/<attempt> state.json spool; the archive must be on this machine)
  ablationkit remote import JOB --base64 FILE   the same, from a text file holding the archive a
      Colab notebook printed (BEGIN/END markers; its size and SHA-256 are checked first)
  ablationkit remote notebook JOB [--out F] the exported Colab notebook of an attempt (run it in Colab,
      then import the archive its last cell downloads; default <home>/notebooks/ATTEMPT.ipynb)
  (all take --attempt ATTEMPT_ID, --json and --coordinator URL)`;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface RemoteInfo {
  target_id: string;
  target_kind: string;
  staging: string;
  staging_error?: string;
  provider_job_id?: string;
  provider_state?: string;
  connectivity: string;
  sync: string;
  sync_error?: string;
  last_contact_at?: string;
  worker_host?: string;
  reconcile_required?: string;
  imported_at?: string;
  expected_back_by?: string;
  overdue_at?: string;
  marked_lost_at?: string;
  worker_spool?: { pending_events?: number; pending_artifacts?: number; dropped_events?: number };
  source_commit: string;
}

interface AttemptLite {
  attempt_id: string;
  number: number;
  state: string;
  error?: string;
  remote?: RemoteInfo;
}

interface JobLite {
  job_id: string;
  attempts: string[];
  attempt_details?: AttemptLite[];
  latest_attempt?: AttemptLite;
}

const REPEATABLE = new Set(["directive", "gpu"]);

function parse(argv: readonly string[]) {
  const repeated: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const name = a.startsWith("--") ? a.slice(2).split("=")[0] : undefined;
    if (name && REPEATABLE.has(name)) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      repeated[name] = [...(repeated[name] ?? []), v];
      continue;
    }
    rest.push(a);
  }
  return { args: parseArgs(rest, ["json", "live", "loader", "lost"]), repeated };
}

const LIVE_ATTEMPT = new Set(["queued", "starting", "running"]);

/** An attempt's compute state; an exported notebook waits on a person, not on a scheduler. */
export function attemptStateText(
  state: string,
  r?: Pick<RemoteInfo, "staging" | "expected_back_by" | "overdue_at" | "marked_lost_at">,
): string {
  if (r?.staging === "exported" && LIVE_ATTEMPT.has(state) && r.overdue_at)
    return `overdue: the exported notebook has not reported back (expected by ${r.expected_back_by}); import it or mark it lost`;
  if (state === "unknown" && r?.marked_lost_at)
    return `lost (marked ${r.marked_lost_at}; a late import still lands)`;
  return state === "starting" && r?.staging === "exported"
    ? `waiting for you to run the notebook (exported${r.expected_back_by ? `, expected back by ${r.expected_back_by}` : ""})`
    : state;
}

export function describeRemote(r: RemoteInfo, state?: string): string {
  // An imported spool: the worker ran offline and reported by archive, never live.
  const worker = r.imported_at
    ? state !== undefined && LIVE_ATTEMPT.has(state)
      ? `worker offline (partial import ${r.imported_at})`
      : `worker exited (imported ${r.imported_at})`
    : `worker ${r.connectivity}${r.last_contact_at ? ` (last seen ${r.last_contact_at})` : ""}`;
  const parts = [
    `${r.target_id} (${r.target_kind})`,
    `staging ${r.staging}`,
    r.provider_job_id
      ? `provider job ${r.provider_job_id}${r.provider_state ? ` ${r.provider_state}` : ""}`
      : undefined,
    worker,
    `sync ${r.sync}`,
  ];
  return parts.filter(Boolean).join(" · ");
}

export async function targetCommand(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [sub, ...rest] = argv;
  const { args, repeated } = parse(rest);
  const asJson = args.flags["json"] === true;
  const client = () => CoordinatorClient.connect(ctx, flag(args, "coordinator"));
  const id = args.positional[0];

  if (sub === "list") {
    const r = await (await client()).request<{ targets: Record<string, unknown>[] }>(
      "GET",
      "/api/v1/targets",
    );
    if (asJson) printJson(ctx, r);
    else if (r.targets.length === 0)
      ctx.out("no compute targets (add one with `ablationkit target add`)\n");
    else
      for (const t of r.targets) {
        // An offline Colab notebook never calls the coordinator: no worker URL to miss.
        const offline =
          t["kind"] === "colab" && !(t["colab"] as { live?: boolean } | undefined)?.live;
        const delivery = offline
          ? "offline (notebook export; results come back with `remote import`)"
          : `worker URL ${t["effective_worker_url"] ?? "not set"}`;
        ctx.out(
          `${t["target_id"]}  ${t["kind"]}${t["paid"] ? " (paid)" : ""}  ${(t["ssh"] as { host?: string } | undefined)?.host ?? ""}  ${delivery}\n`,
        );
      }
    return 0;
  }
  if (!id) throw new UsageError(TARGET_USAGE);
  const path = `/api/v1/targets/${encodeURIComponent(id)}`;
  if (sub === "show") {
    printJson(ctx, await (await client()).request("GET", path));
    return 0;
  }
  if (sub === "remove") {
    await (await client()).request("DELETE", path);
    if (!asJson) ctx.out(`removed ${id}\n`);
    return 0;
  }
  if (sub === "doctor") {
    const r = await (await client()).request<{ ok: boolean; checks: Check[] }>(
      "POST",
      `${path}/doctor`,
      {},
    );
    if (asJson) printJson(ctx, r);
    else for (const c of r.checks) ctx.out(`${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.detail}\n`);
    return r.ok ? 0 : 1;
  }
  if (sub === "add") {
    let body: Record<string, unknown>;
    // What to say about a Runpod or Colab target added from flags.
    let saved: string | undefined;
    const file = flag(args, "file");
    if (file) body = JSON.parse(readFileSync(resolve(file), "utf8")) as Record<string, unknown>;
    else {
      const kind = flag(args, "kind");
      const host = flag(args, "host");
      const opt = (k: string, f: string, num = false): Record<string, unknown> => {
        const v = flag(args, f);
        if (v === undefined) return {};
        if (num && !/^[0-9]+$/.test(v)) throw new UsageError(`--${f} takes a number`);
        return { [k]: num ? Number(v) : v };
      };
      const common = {
        ...opt("label", "label"),
        ...opt("work_dir", "work-dir"),
        ...opt("python", "python"),
        ...opt("worker_url", "worker-url"),
      };
      const ntfyUrl = flag(args, "ntfy");
      const ntfy = ntfyUrl ? { ntfy: { url: ntfyUrl, ...opt("token_env", "ntfy-token-env") } } : {};
      if (kind === "runpod") {
        const keyEnv = flag(args, "api-key-env");
        const image = flag(args, "image");
        if (!keyEnv || !image || !repeated["gpu"]?.length)
          throw new UsageError(
            `--kind runpod needs --api-key-env, --image and at least one --gpu\n\n${TARGET_USAGE}`,
          );
        body = {
          kind,
          runpod: {
            api_key_env: keyEnv,
            image,
            gpu_type_ids: repeated["gpu"],
            ...opt("gpu_count", "gpu-count", true),
            ...opt("cloud_type", "cloud"),
            ...opt("volume_gb", "volume-gb", true),
            ...opt("container_disk_gb", "container-disk-gb", true),
            ...opt("network_volume_id", "network-volume"),
            ...opt("tailscale_authkey_secret", "tailscale-secret"),
            ...opt("cents_per_hour", "cents-per-hour", true),
            ...opt("deliver_deadline_sec", "deliver-deadline-sec", true),
            ...opt("api_url", "api-url"),
          },
          ...common,
          ...ntfy,
        };
        saved = `saved ${id} (runpod, paid compute: submissions need --timeout and --accept-cost)\ncheck it with: ablationkit target doctor ${id}\n`;
      } else if (kind === "colab") {
        body = {
          kind,
          ...(args.flags["live"] === true ? { colab: { live: true } } : {}),
          ...common,
        };
        saved = `saved ${id} (colab: a job submitted to ${id} exports a notebook; \`remote notebook JOB\` fetches it)\n`;
      } else {
        if ((kind !== "ssh" && kind !== "slurm") || !host)
          throw new UsageError(
            `--kind ssh|slurm|runpod|colab is required, with --host for ssh and slurm (or --file)\n\n${TARGET_USAGE}`,
          );
        const slurm = {
          ...opt("partition", "partition"),
          ...opt("account", "account"),
          ...opt("qos", "qos"),
          ...opt("gres", "gres"),
          ...opt("drain_sec", "drain-sec", true),
          ...(repeated["directive"] ? { directives: repeated["directive"] } : {}),
        };
        if (kind === "ssh" && Object.keys(slurm).length)
          throw new UsageError("SLURM options apply to --kind slurm only");
        body = {
          kind,
          ssh: {
            host,
            ...opt("port", "port", true),
            ...opt("identity_file", "identity"),
            ...opt("supervisor", "supervisor"),
          },
          ...(kind === "slurm" ? { slurm } : {}),
          ...common,
          ...ntfy,
        };
      }
    }
    const t = await (await client()).request<Record<string, unknown>>("PUT", path, body);
    if (asJson) printJson(ctx, t);
    else if (saved) ctx.out(saved);
    else {
      ctx.out(`saved ${id} (${t["kind"]})\n`);
      if (!t["effective_worker_url"])
        ctx.out(
          "note: no worker URL yet; set `remote.worker_url` in settings.json or --worker-url (workers must reach this coordinator)\n",
        );
      ctx.out(`check it with: ablationkit target doctor ${id}\n`);
    }
    return 0;
  }
  throw new UsageError(TARGET_USAGE);
}

export async function remoteCommand(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [sub, ...rest] = argv;
  const { args } = parse(rest);
  const asJson = args.flags["json"] === true;
  const jobId = args.positional[0];
  if (!sub || !jobId) throw new UsageError(REMOTE_USAGE);
  const c = await CoordinatorClient.connect(ctx, flag(args, "coordinator"));
  const j = await c.request<JobLite>("GET", `/api/v1/jobs/${encodeURIComponent(jobId)}`);
  const attemptId = flag(args, "attempt") ?? j.latest_attempt?.attempt_id;
  if (!attemptId) throw new UsageError(`${jobId} has no attempt`);
  const base = `/api/v1/jobs/${encodeURIComponent(jobId)}/attempts/${encodeURIComponent(attemptId)}/remote`;

  if (sub === "status") {
    const attempts = j.attempt_details ?? (j.latest_attempt ? [j.latest_attempt] : []);
    if (asJson)
      printJson(
        ctx,
        attempts.map((a) => ({ attempt_id: a.attempt_id, state: a.state, remote: a.remote })),
      );
    else
      for (const a of attempts) {
        ctx.out(`attempt #${a.number} ${a.attempt_id}: ${attemptStateText(a.state, a.remote)}\n`);
        if (!a.remote) {
          ctx.out("         local attempt\n");
          continue;
        }
        const r = a.remote;
        ctx.out(`         ${describeRemote(r, a.state)}\n`);
        ctx.out(
          `         source ${r.source_commit}${r.worker_host ? ` on ${r.worker_host}` : ""}\n`,
        );
        const s = r.worker_spool;
        if (s && (s.pending_events || s.pending_artifacts || s.dropped_events))
          ctx.out(
            `         worker spool: ${s.pending_events ?? 0} events and ${s.pending_artifacts ?? 0} artifacts pending, ${s.dropped_events ?? 0} dropped\n`,
          );
        if (r.staging_error) ctx.out(`         staging: ${r.staging_error}\n`);
        if (r.sync_error) ctx.out(`         sync: ${r.sync_error}\n`);
        if (r.reconcile_required)
          ctx.out(
            `         RECONCILE: ${r.reconcile_required}\n         (check the target, then: ablationkit remote resolve ${jobId} --note "…")\n`,
          );
        if (r.overdue_at && LIVE_ATTEMPT.has(a.state))
          ctx.out(
            `         OVERDUE since ${r.overdue_at}: if it ran, ablationkit remote import ${jobId} ARCHIVE; if its runtime is gone, ablationkit remote resolve ${jobId} --lost\n`,
          );
        if (a.error) ctx.out(`         error: ${a.error}\n`);
      }
    return 0;
  }
  if (sub === "notebook") {
    const res = await c.open("GET", `${base}/notebook`);
    // Default: the AblationKit home, not wherever the CLI runs (often the AblationKit checkout).
    const out = flag(args, "out");
    const file = out ? resolve(out) : join(ctx.home, "notebooks", `${attemptId}.ipynb`);
    if (!out) mkdirSync(join(ctx.home, "notebooks"), { recursive: true, mode: 0o700 });
    const bytes = new Uint8Array(await res.arrayBuffer());
    writeFileSync(file, bytes, { mode: 0o600 });
    if (args.flags["loader"] === true) {
      // One cell for an empty Colab notebook, pinned to these exact notebook bytes.
      const cell = colabLoader({
        attemptId,
        jobId,
        notebookSha256: createHash("sha256").update(bytes).digest("hex"),
      });
      if (asJson) printJson(ctx, { notebook: file, loader: cell });
      else {
        ctx.err(
          `wrote ${file}\npaste the cell below into an empty Colab notebook, run it and choose ${file.split("/").at(-1)} when asked; keep the tab open until it ends\n\n`,
        );
        ctx.out(cell);
      }
      return 0;
    }
    if (asJson) printJson(ctx, { notebook: file });
    else
      ctx.out(
        `wrote ${file}\nopen it in Colab, run every cell, then: ablationkit remote import ${jobId} ak-${attemptId}-state.tgz\n`,
      );
    return 0;
  }
  let out: unknown;
  if (sub === "drain") out = await c.request("POST", `${base}/drain`, {});
  else if (sub === "reauthorize") out = await c.request("POST", `${base}/reauthorize`, {});
  else if (sub === "resolve") {
    const note = flag(args, "note");
    const lost = args.flags["lost"] === true;
    if (!note && !lost)
      throw new UsageError("--note is required: say what you checked on the target");
    out = await c.request("POST", `${base}/resolve`, {
      ...(note ? { note } : {}),
      ...(lost ? { lost } : {}),
    });
  } else if (sub === "import") {
    const printed = flag(args, "base64");
    const archive = args.positional[1];
    if (!archive === !printed) throw new UsageError(REMOTE_USAGE);
    if (printed) {
      // The archive a notebook printed (BEGIN/END markers): check its size and SHA-256, then
      // import it like a downloaded one.
      let a: ReturnType<typeof parsePrintedArchive>;
      try {
        a = parsePrintedArchive(readFileSync(resolve(printed), "utf8"));
      } catch (e) {
        ctx.err(`error: ${(e as Error).message}\n`);
        return 1;
      }
      const dir = mkdtempSync(join(tmpdir(), "ak-import-"));
      try {
        const file = join(dir, a.name);
        writeFileSync(file, a.bytes, { mode: 0o600 });
        if (!asJson) ctx.err(`decoded ${a.name} (${a.bytes.length} bytes, sha256 ${a.sha256})\n`);
        out = await c.request("POST", `${base}/import`, { archive_path: file });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else
      out = await c.request("POST", `${base}/import`, { archive_path: resolve(archive as string) });
  } else throw new UsageError(REMOTE_USAGE);
  if (asJson) printJson(ctx, out);
  else if (sub === "import") {
    const r = out as {
      accepted: number;
      duplicates: number;
      rejected: number;
      artifacts: number;
      state: string;
    };
    ctx.out(
      `imported ${r.accepted} events (${r.duplicates} already known, ${r.rejected} rejected) and ${r.artifacts} artifacts; attempt ${r.state}\n`,
    );
  } else if (sub === "resolve" && args.flags["lost"] === true)
    ctx.out(
      `marked lost: the attempt ended unknown and its slot is released; a late import still lands (ablationkit remote import ${jobId} ARCHIVE)\n`,
    );
  else ctx.out(`${sub}: done\n`);
  return 0;
}
