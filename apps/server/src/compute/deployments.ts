/**
 * Deployment gates (spec §7.7.4 item 5, criterion 32; ADR 0037). A deployment request names a
 * pinned model version, a target, an exposure, a TTL and a spend ceiling. For an agent the project
 * policy decides: `allow` starts it when every condition passes, `deny` blocks it with the reason
 * naming the policy field. A researcher's own request is theirs to make. TTLs are enforced by a
 * sweeper; every step is audited. Starting the serving process is a `DeploymentLauncher`'s job: the coordinator's
 * default starts a local preview as an inference session (ADR 0020) and a research endpoint as a
 * Runpod pod (`remote-endpoints.ts`, ADR 0023 decision 20); persistent and public endpoints are
 * refused, so nothing is claimed to be running that is not.
 *
 * Restarts (criteria 12 and 34): a local preview does not survive one. An endpoint whose provider
 * supervises it (`provider.independent_supervision`) stays `running` after the provider confirms it.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decide, isPinnedModelUri } from "@ablationkit/autonomy-policy";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type DeploymentKind,
  type DeploymentRecord,
  type ResearchActor,
  validateDeploymentRecord,
} from "@ablationkit/protocol";
import { HttpError } from "../http.ts";
import type { Notifier } from "../notifications.ts";
import type { Services } from "../services.ts";

export interface LaunchResult {
  readonly endpoint?: string;
  readonly provider?: NonNullable<DeploymentRecord["provider"]>;
}

/** What the provider says about an independently supervised endpoint. */
export interface ProviderCheck {
  readonly state: string;
  readonly running: boolean;
  /** The provider no longer has it (removed or terminated). */
  readonly gone: boolean;
}

export interface DeploymentLauncher {
  readonly name: string;
  start(d: DeploymentRecord): Promise<LaunchResult>;
  stop(d: DeploymentRecord): Promise<void>;
  /** Provider status of an independently supervised endpoint (after a restart). */
  check?(d: DeploymentRecord): Promise<ProviderCheck>;
}

const KINDS: readonly DeploymentKind[] = [
  "preview_local",
  "remote_research",
  "persistent",
  "public",
];
const OPEN = new Set<DeploymentRecord["status"]>(["approved", "running"]);

export class DeploymentService {
  private readonly records = new Map<string, DeploymentRecord>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastCheck = 0;

  constructor(
    private readonly o: {
      readonly svc: () => Services;
      readonly stateDir: string;
      readonly now: () => Date;
      readonly notifier: Notifier;
      readonly launcher: DeploymentLauncher;
      readonly sweepMs?: number;
      /** How often running remote endpoints are checked with their provider (default 60 s). */
      readonly checkMs?: number;
    },
  ) {}

  private get svc(): Services {
    return this.o.svc();
  }

  private dir(pid: string): string {
    return join(this.o.stateDir, pid, "deployments");
  }

  /** Deployments of a project that are starting or running (project removal refuses these). */
  active(pid: string): DeploymentRecord[] {
    return [...this.records.values()].filter((r) => r.project_id === pid && OPEN.has(r.status));
  }

  /** Drop a removed project's deployments from memory. */
  forgetProject(pid: string): void {
    for (const [id, r] of [...this.records]) if (r.project_id === pid) this.records.delete(id);
  }

  load(projects: readonly string[]): string[] {
    const problems: string[] = [];
    for (const pid of projects) {
      const d = this.dir(pid);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith(".json") && !x.startsWith("."))) {
        try {
          const r = readJson(join(d, f), validateDeploymentRecord);
          if (r.project_id !== pid || `${r.deployment_id}.json` !== f)
            throw new Error("ID does not match its path");
          this.records.set(r.deployment_id, r);
        } catch (e) {
          problems.push(`${join(d, f)}: ${(e as Error).message}`);
        }
      }
    }
    return problems;
  }

  private save(r: DeploymentRecord): DeploymentRecord {
    mkdirSync(this.dir(r.project_id), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.dir(r.project_id), `${r.deployment_id}.json`), r, {
      validate: validateDeploymentRecord,
    });
    this.records.set(r.deployment_id, r);
    this.svc.events.publish(r.project_id, "deployment.updated", {
      deployment_id: r.deployment_id,
      kind: r.kind,
      status: r.status,
    });
    return r;
  }

  private audit(
    r: DeploymentRecord,
    actor: ResearchActor,
    action: string,
    outcome: "allowed" | "denied" | "error",
    reason?: string,
  ): void {
    this.svc.audit.record({
      actor: { kind: actor.kind, ...(actor.id ? { id: actor.id } : {}) },
      listener: actor.kind === "agent" ? "agent" : actor.kind === "human" ? "human" : "internal",
      action: `deployment.${action}`,
      outcome,
      project_id: r.project_id,
      target: r.deployment_id,
      ...(reason ? { reason: reason.slice(0, 1024) } : {}),
      details: {
        kind: r.kind,
        model_uri: r.model_uri,
        target: r.target,
        exposure: r.exposure,
        ttl_minutes: r.ttl_minutes,
        policy_revision: r.policy_revision,
        status: r.status,
      },
    });
  }

  list(pid: string): DeploymentRecord[] {
    this.sweep();
    return [...this.records.values()]
      .filter((r) => r.project_id === pid)
      .sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1));
  }

  /** A record by ID without sweeping (the worker listener's model fetch). */
  find(id: string): DeploymentRecord | undefined {
    return this.records.get(id);
  }

  require(id: string, pid?: string): DeploymentRecord {
    this.sweep();
    const r = this.records.get(id);
    if (!r || (pid !== undefined && r.project_id !== pid))
      throw new HttpError(404, "deployment_not_found", `no deployment ${id}`);
    return r;
  }

  /**
   * Why a request is refused: a public endpoint never starts (§7.1); an agent's request is decided
   * by the project policy (ADR 0037). Undefined when it may start.
   */
  private denied(r: DeploymentRecord, actor: ResearchActor): string[] | undefined {
    if (r.kind === "public") return ["a public endpoint is never started from a request (§7.1)"];
    if (actor.kind !== "agent") return undefined;
    const t = this.svc.targets.get(r.target);
    const e = decide(this.svc.policy.current(r.project_id), `deployments.${r.kind}`, {
      target: r.target,
      minutes: r.ttl_minutes,
      exposure: r.exposure,
      ...(t ? { targetKind: t.kind } : {}),
    });
    return e.decision === "deny" ? [...e.reasons] : undefined;
  }

  async request(pid: string, body: Record<string, unknown>, actor: ResearchActor) {
    this.svc.registry.require(pid);
    const kind = body["kind"] as DeploymentKind;
    if (!KINDS.includes(kind))
      throw new HttpError(400, "invalid_request", `\`kind\` must be one of ${KINDS.join(", ")}`);
    const model = body["model_uri"];
    if (typeof model !== "string" || !isPinnedModelUri(model))
      throw new HttpError(
        422,
        "model_not_pinned",
        "`model_uri` must pin an exact version (`models:/<name>/<version>` or `runs:/<run>/<path>`); aliases, stages and `latest` are refused",
      );
    const target =
      typeof body["target"] === "string"
        ? (body["target"] as string)
        : kind === "preview_local"
          ? "local"
          : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(target))
      throw new HttpError(400, "invalid_request", "`target` must name a deployment target");
    const exposure = (body["exposure"] ??
      (kind === "preview_local" ? "loopback" : undefined)) as DeploymentRecord["exposure"];
    if (!["loopback", "tailnet", "public"].includes(exposure as string))
      throw new HttpError(400, "invalid_request", "`exposure` must be loopback, tailnet or public");
    const ttl = body["ttl_minutes"];
    if (!Number.isInteger(ttl) || (ttl as number) < 1 || (ttl as number) > 100000)
      throw new HttpError(
        400,
        "invalid_request",
        "`ttl_minutes` is required (an integer number of minutes)",
      );
    const maxCents = body["max_cents"];
    if (maxCents !== undefined && (!Number.isInteger(maxCents) || (maxCents as number) < 0))
      throw new HttpError(400, "invalid_request", "`max_cents` must be a non-negative integer");
    // A configured paid target: the estimate is shown, and a spend ceiling below it is refused.
    const t = this.svc.targets.get(target);
    const estimate = t?.paid ? this.svc.remote.estimate(target, ttl as number) : undefined;
    if (
      estimate?.cents !== undefined &&
      maxCents !== undefined &&
      estimate.cents > (maxCents as number)
    )
      throw new HttpError(
        409,
        "over_spend_ceiling",
        `the estimate (${estimate.cents} cents: ${estimate.basis}) exceeds \`max_cents\` (${maxCents})`,
        { estimate },
      );
    const now = this.o.now();
    let r: DeploymentRecord = validateDeploymentRecord({
      schema_version: 1,
      deployment_id: `dep-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4).toString("hex")}`,
      project_id: pid,
      kind,
      target,
      model_uri: model,
      exposure,
      ttl_minutes: ttl,
      ...(maxCents !== undefined ? { max_cents: maxCents } : {}),
      status: "approved",
      policy_revision: this.svc.policy.current(pid).revision,
      requested_by: actor,
      requested_at: now.toISOString(),
      launcher: this.o.launcher.name,
    });
    const denied = this.denied(r, actor);
    if (denied) {
      const why = denied.join("; ");
      r = this.save({ ...r, status: "blocked", status_reason: why.slice(0, 2000) });
      this.audit(r, actor, "request", "denied", why);
      return { outcome: "blocked" as const, deployment: r, reasons: denied };
    }
    this.audit(r, actor, "request", "allowed");
    r = await this.launch(r, actor);
    return {
      outcome: r.status === "running" ? ("started" as const) : ("failed" as const),
      deployment: r,
      ...(estimate ? { estimate } : {}),
    };
  }

  private async launch(r: DeploymentRecord, actor: ResearchActor): Promise<DeploymentRecord> {
    try {
      const out = await this.o.launcher.start(r);
      const now = this.o.now();
      const next = this.save({
        ...r,
        status: "running",
        started_at: now.toISOString(),
        expires_at: new Date(now.getTime() + r.ttl_minutes * 60_000).toISOString(),
        ...(out.endpoint ? { endpoint: out.endpoint } : {}),
        ...(out.provider ? { provider: out.provider } : {}),
      });
      this.audit(next, actor, "start", "allowed");
      return next;
    } catch (e) {
      const next = this.save({
        ...r,
        status: "failed",
        status_reason: (e as Error).message.slice(0, 2000),
      });
      this.audit(next, actor, "start", "error", (e as Error).message);
      return next;
    }
  }

  async stop(
    id: string,
    pid: string,
    actor: ResearchActor,
    reason = "stopped",
  ): Promise<DeploymentRecord> {
    const r = this.require(id, pid);
    if (!OPEN.has(r.status)) return r;
    if (r.status === "running") await this.o.launcher.stop(r).catch(() => {});
    const next = this.save({
      ...r,
      status: "stopped",
      stopped_at: this.o.now().toISOString(),
      status_reason: reason,
    });
    this.audit(next, actor, "stop", "allowed", reason);
    return next;
  }

  /** TTL enforcement: running deployments past `expires_at` are stopped and marked expired. */
  sweep(): void {
    const t = this.o.now().getTime();
    for (const r of this.records.values())
      if (r.status === "running" && r.expires_at && Date.parse(r.expires_at) <= t) {
        void this.o.launcher.stop(r).catch(() => {});
        const next = this.save({
          ...r,
          status: "expired",
          stopped_at: new Date(t).toISOString(),
          status_reason: `TTL of ${r.ttl_minutes} minutes reached`,
        });
        this.audit(next, { kind: "system" }, "expire", "allowed");
      }
  }

  /**
   * After a restart (criteria 12 and 34): a local deployment's process did not survive and is
   * marked stopped; an independently supervised endpoint stays running until its provider says
   * otherwise (`reconcile`); one that was starting and never started is invalidated and must be
   * requested again.
   */
  recover(): void {
    for (const r of [...this.records.values()]) {
      if (r.status === "running" && r.provider?.independent_supervision) {
        this.audit(
          r,
          { kind: "system" },
          "recover",
          "allowed",
          `independently supervised by ${r.provider.target_kind} (${r.provider.provider_ref}); checking the provider`,
        );
      } else if (r.status === "running") {
        const next = this.save({
          ...r,
          status: "stopped",
          stopped_at: this.o.now().toISOString(),
          status_reason: "the coordinator restarted; the deployment did not survive",
        });
        this.audit(next, { kind: "system" }, "recover", "allowed", next.status_reason);
      } else if (r.status === "approved") {
        const next = this.save({
          ...r,
          status: "invalidated",
          status_reason: "not started before a restart; request it again",
        });
        this.audit(next, { kind: "system" }, "recover", "allowed", next.status_reason);
      }
    }
  }

  /**
   * Ask the provider about every running, independently supervised endpoint. Gone: `stopped` with
   * the provider's word. Unreachable provider: unchanged (the endpoint may well be serving).
   */
  async reconcile(): Promise<void> {
    this.lastCheck = this.o.now().getTime();
    const check = this.o.launcher.check?.bind(this.o.launcher);
    if (!check) return;
    for (const r of [...this.records.values()]) {
      if (r.status !== "running" || !r.provider?.independent_supervision) continue;
      let c: ProviderCheck;
      try {
        c = await check(r);
      } catch {
        continue;
      }
      const cur = this.records.get(r.deployment_id);
      if (cur?.status !== "running") continue;
      const provider = { ...cur.provider, state: c.state, checked_at: this.o.now().toISOString() };
      if (c.gone || (!c.running && c.state === "EXITED")) {
        const next = this.save({
          ...cur,
          provider: provider as NonNullable<DeploymentRecord["provider"]>,
          status: "stopped",
          stopped_at: this.o.now().toISOString(),
          status_reason: `the provider reports the endpoint ${c.state.toLowerCase()}`,
        });
        this.audit(next, { kind: "system" }, "reconcile", "allowed", next.status_reason);
      } else if (cur.provider?.state !== c.state) {
        this.save({ ...cur, provider: provider as NonNullable<DeploymentRecord["provider"]> });
      }
    }
  }

  start(): void {
    this.recover();
    this.sweep();
    void this.reconcile().catch(() => {});
    this.timer = setInterval(() => {
      this.sweep();
      if (this.o.now().getTime() - this.lastCheck >= (this.o.checkMs ?? 60_000))
        void this.reconcile().catch(() => {});
    }, this.o.sweepMs ?? 30_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stopAll(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
