/**
 * Compute targets (spec §10; ADR 0023): `<home>/targets/<target-id>.json`, one file per target.
 * Credentials are referenced by environment-variable name, never stored here.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  adapterFor,
  type DoctorCheck,
  type Shell,
  type TargetAdapter,
  validateTarget,
} from "@ablationkit/compute-targets";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import { type ColabUsage, type ComputeTarget, validateComputeTarget } from "@ablationkit/protocol";
import { HttpError } from "../http.ts";

export interface TargetServiceOptions {
  readonly dir: string;
  readonly now: () => Date;
  /** Tests replace SSH with a local shell. */
  readonly shellFor?: (t: ComputeTarget) => Shell | undefined;
  /** The Colab CLI's session state file for the coordinator's runtimes (`colab.mode: cli`). */
  readonly colabStateFile?: string;
}

/** How long a provider account's compute units are reused before asking again. */
const USAGE_TTL_MS = 30_000;

export class TargetService {
  private readonly targets = new Map<string, ComputeTarget>();
  private readonly usageCache = new Map<string, { at: number; value: Promise<ColabUsage> }>();
  readonly loadProblems: string[] = [];

  constructor(private readonly o: TargetServiceOptions) {}

  load(): void {
    if (!existsSync(this.o.dir)) return;
    for (const f of readdirSync(this.o.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = readJson(join(this.o.dir, f), validateComputeTarget);
        this.targets.set(t.target_id, t);
      } catch (e) {
        this.loadProblems.push(`${f}: ${(e as Error).message}`);
      }
    }
  }

  list(): ComputeTarget[] {
    return [...this.targets.values()].sort((a, b) => a.target_id.localeCompare(b.target_id));
  }

  get(id: string): ComputeTarget | undefined {
    return this.targets.get(id);
  }

  require(id: string): ComputeTarget {
    const t = this.targets.get(id);
    if (!t) throw new HttpError(404, "target_not_found", `no compute target ${id}`);
    return t;
  }

  /** Add or replace a target. */
  put(body: Record<string, unknown>): ComputeTarget {
    const ts = this.o.now().toISOString();
    const prev =
      typeof body["target_id"] === "string" ? this.targets.get(body["target_id"]) : undefined;
    let t: ComputeTarget;
    try {
      t = validateComputeTarget({
        schema_version: 1,
        paid: body["kind"] === "runpod",
        ...body,
        created_at: prev?.created_at ?? ts,
        updated_at: ts,
      });
    } catch (e) {
      throw new HttpError(400, "invalid_target", (e as Error).message);
    }
    const errs = validateTarget(t);
    if (errs.length) throw new HttpError(400, "invalid_target", errs.join("; "));
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.o.dir, `${t.target_id}.json`), t, {
      validate: validateComputeTarget,
    });
    this.targets.set(t.target_id, t);
    return t;
  }

  remove(id: string): void {
    this.require(id);
    rmSync(join(this.o.dir, `${id}.json`), { force: true });
    this.targets.delete(id);
  }

  adapter(t: ComputeTarget): TargetAdapter {
    try {
      const stateFile = this.o.colabStateFile;
      if (stateFile && t.kind === "colab" && t.colab?.mode === "cli")
        mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
      return adapterFor(t, this.o.shellFor?.(t), stateFile ? { colab: { stateFile } } : {});
    } catch (e) {
      throw new HttpError(
        501,
        (e as { code?: string }).code ?? "target_unavailable",
        (e as Error).message,
      );
    }
  }

  /**
   * The provider account's compute units (a Colab target driven through the Colab CLI): the whole
   * account, as Colab reports it. Reused for 30 s, so a page that polls does not run the CLI each
   * time.
   */
  async usage(id: string): Promise<ColabUsage> {
    const t = this.require(id);
    const adapter = this.adapter(t);
    if (!adapter.usage)
      throw new HttpError(
        409,
        "no_usage",
        `${id} reports no compute units (only Colab targets with \`mode: cli\` do)`,
      );
    const hit = this.usageCache.get(id);
    if (hit && Date.now() - hit.at < USAGE_TTL_MS) return hit.value;
    const read = adapter.usage.bind(adapter);
    const value = read().then((u) => ({
      balance_hundredths: Math.round(u.balance * 100),
      per_hour_hundredths: Math.round(u.per_hour * 100),
      runtimes: u.runtimes,
      checked_at: this.o.now().toISOString(),
    }));
    this.usageCache.set(id, { at: Date.now(), value });
    value.catch(() => this.usageCache.delete(id));
    try {
      return await value;
    } catch (e) {
      throw new HttpError(
        502,
        (e as { code?: string }).code ?? "usage_unavailable",
        (e as Error).message,
      );
    }
  }

  async doctor(id: string, workerUrl: string | undefined): Promise<DoctorCheck[]> {
    const t = this.require(id);
    const checks: DoctorCheck[] = [];
    // An offline Colab worker (a notebook, or a runtime the coordinator collects from) never calls
    // back: no worker URL needed.
    if (t.kind === "colab" && t.colab?.live !== true) {
      try {
        return await this.adapter(t).doctor(workerUrl ?? "");
      } catch (e) {
        return [{ name: "adapter", ok: false, detail: (e as Error).message }];
      }
    }
    if (!workerUrl)
      checks.push({
        name: "worker URL",
        ok: false,
        detail:
          "no worker URL: set `remote.worker_url` in settings.json (for example http://<tailnet-name>:7422) or the target's `worker_url`",
      });
    else checks.push({ name: "worker URL", ok: true, detail: workerUrl });
    let adapter: TargetAdapter;
    try {
      adapter = this.adapter(t);
    } catch (e) {
      return [...checks, { name: "adapter", ok: false, detail: (e as Error).message }];
    }
    if (workerUrl) checks.push(...(await adapter.doctor(workerUrl)));
    return checks;
  }
}
