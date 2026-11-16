/**
 * Remote research endpoints (spec §10 offline nuance, criterion 12 endpoint half; ADR 0023
 * decision 20). An approved `remote_research` deployment on a Runpod target becomes one pod that
 * pulls the pinned model package from the worker listener with a per-deployment fetch token,
 * verifies its SHA-256 and serves it on the tailnet until the deployment's expiry.
 *
 * The pod's lifetime is supervised by Runpod and its expiry is enforced on the pod, so the endpoint
 * is independently supervised: it keeps serving while the coordinator is off, and a coordinator
 * restart keeps the deployment `running` after asking the provider. A local preview, by contrast,
 * is an inference session and stops with the coordinator (criterion 9e).
 *
 * Package layout: `<state>/<project>/deployments/endpoints/<deployment>/` holds `model.tgz` and
 * `fetch.json` (`token_sha256`, `sha256`, `bytes`, `expires_at`); the token itself is only in the
 * pod's environment.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type RunpodTarget, TargetError } from "@ablationkit/compute-targets";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import type { DeploymentRecord } from "@ablationkit/protocol";
import { MlflowError } from "@ablationkit/tracking-mlflow";
import { HttpError } from "../http.ts";
import { exportModelFiles } from "../models/export.ts";
import type { Services } from "../services.ts";
import type { DeploymentLauncher, LaunchResult, ProviderCheck } from "./deployments.ts";

interface FetchFile {
  readonly token_sha256: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly expires_at: string;
}

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

function providerError(e: unknown): never {
  if (e instanceof TargetError)
    throw new HttpError(
      e.code === "credentials_missing" || e.code === "invalid_target" ? 422 : 502,
      e.code,
      e.message,
    );
  throw e;
}

export class RemoteEndpoints implements DeploymentLauncher {
  readonly name = "remote-endpoint";

  constructor(
    private readonly o: {
      readonly svc: () => Services;
      readonly stateDir: string;
      readonly now: () => Date;
    },
  ) {}

  private get svc(): Services {
    return this.o.svc();
  }

  private dir(d: Pick<DeploymentRecord, "project_id" | "deployment_id">): string {
    return join(this.o.stateDir, d.project_id, "deployments", "endpoints", d.deployment_id);
  }

  private runpod(targetId: string): RunpodTarget {
    const t = this.svc.targets.get(targetId);
    if (!t)
      throw new HttpError(
        422,
        "unknown_target",
        `no compute target ${targetId}; remote research endpoints run on a configured Runpod target (\`target add --kind runpod\`)`,
      );
    if (t.kind !== "runpod")
      throw new HttpError(
        422,
        "unsupported_deployment",
        `${targetId} is a ${t.kind} target; remote research endpoints run on Runpod targets only (SSH, SLURM and Colab hosts do not supervise a server)`,
      );
    return this.svc.targets.adapter(t) as RunpodTarget;
  }

  /** Whether `target` names a target this launcher can start (for the deployment request checks). */
  handles(d: Pick<DeploymentRecord, "kind" | "target">): boolean {
    return d.kind === "remote_research" && this.svc.targets.get(d.target)?.kind === "runpod";
  }

  /** The artifact URI of a pinned model URI (`models:/<name>/<version>` or `runs:/<run>/<path>`). */
  private async artifactUri(modelUri: string): Promise<string> {
    const c = this.svc.tracking.client;
    const reg = /^models:\/(.+)\/([1-9][0-9]{0,9})$/.exec(modelUri);
    try {
      if (reg) {
        const v = await c.getModelVersion(reg[1] as string, reg[2] as string);
        const modelId = v.model_id || /^models:\/(m-[A-Za-z0-9]+)$/.exec(v.source)?.[1];
        if (modelId) return (await c.getLoggedModel(modelId)).info.artifact_uri;
        return v.source;
      }
      const run = /^runs:\/([A-Za-z0-9]+)\/(.+)$/.exec(modelUri);
      if (run) {
        const r = await c.getRun(run[1] as string);
        return `${(r.info.artifact_uri ?? "").replace(/\/$/, "")}/${run[2]}`;
      }
    } catch (e) {
      if (e instanceof MlflowError)
        throw new HttpError(
          e.notFound ? 404 : 503,
          e.notFound ? "model_not_found" : "tracking_unavailable",
          `resolving ${modelUri}: ${e.message}`,
        );
      throw e;
    }
    throw new HttpError(422, "unsupported_model_uri", `cannot export ${modelUri}`);
  }

  /** Download every file of the model into `<dir>/model` and pack it as `model.tgz`. */
  private async packageModel(d: DeploymentRecord): Promise<{ sha256: string; bytes: number }> {
    const uri = await this.artifactUri(d.model_uri);
    const root = join(this.dir(d), "model");
    await exportModelFiles(this.svc.tracking.client, uri, root, d.model_uri);
    const tgz = join(this.dir(d), "model.tgz");
    const t = Bun.spawnSync(["tar", "-czf", tgz, "-C", root, "."], { stderr: "pipe" });
    rmSync(root, { recursive: true, force: true });
    if (t.exitCode !== 0)
      throw new Error(`packing the model failed: ${new TextDecoder().decode(t.stderr)}`);
    const data = readFileSync(tgz);
    return { sha256: sha256(data), bytes: data.byteLength };
  }

  async start(d: DeploymentRecord): Promise<LaunchResult> {
    if (d.kind !== "remote_research")
      throw new HttpError(422, "unsupported_deployment", `${d.kind} is not a research endpoint`);
    if (d.exposure !== "tailnet")
      throw new HttpError(
        422,
        "unsupported_exposure",
        "a research endpoint is reachable on the tailnet only (`exposure: tailnet`)",
      );
    const adapter = this.runpod(d.target);
    const target = adapter.target;
    if (!target.runpod?.tailscale_authkey_secret)
      throw new HttpError(
        422,
        "no_tailnet",
        `${d.target} has no \`tailscale_authkey_secret\`: the pod could not join the tailnet to serve, or reach the coordinator for its model`,
      );
    const workerUrl = this.svc.remote.workerUrlFor(d.target);
    if (!workerUrl)
      throw new HttpError(
        422,
        "no_worker_url",
        "the pod downloads its model from the worker listener: set `remote.worker_url` or the target's `worker_url`",
      );
    mkdirSync(this.dir(d), { recursive: true, mode: 0o700 });
    const pkg = await this.packageModel(d);
    const token = randomBytes(32).toString("base64url");
    const now = this.o.now();
    const expires = new Date(now.getTime() + d.ttl_minutes * 60_000);
    const fetch: FetchFile = {
      token_sha256: sha256(token),
      sha256: pkg.sha256,
      bytes: pkg.bytes,
      expires_at: expires.toISOString(),
    };
    writeJsonAtomic(join(this.dir(d), "fetch.json"), fetch);
    const out = await adapter
      .startEndpoint({
        deploymentId: d.deployment_id,
        modelUrl: `${workerUrl.replace(/\/$/, "")}/api/v1/deployments/${d.deployment_id}/model`,
        fetchToken: token,
        modelSha256: pkg.sha256,
        expiresAtSec: expires.getTime() / 1000,
      })
      .catch(providerError);
    const est = this.svc.remote.estimate(d.target, d.ttl_minutes);
    return {
      endpoint: adapter.endpointUrl(d.deployment_id),
      provider: {
        target_id: d.target,
        target_kind: "runpod",
        provider_ref: out.provider_ref,
        independent_supervision: true,
        model_sha256: pkg.sha256,
        model_bytes: pkg.bytes,
        ...(est.cents !== undefined ? { estimate_cents: est.cents } : {}),
        state: "CREATED",
        checked_at: now.toISOString(),
      },
    };
  }

  async stop(d: DeploymentRecord): Promise<void> {
    const ref = d.provider?.provider_ref;
    if (ref) {
      const adapter = this.runpod(d.target);
      await (adapter.release?.(d.deployment_id, ref) ?? Promise.resolve()).catch(providerError);
    }
    rmSync(this.dir(d), { recursive: true, force: true });
  }

  /** Ask the provider whether the endpoint still runs (for restart recovery). */
  async check(d: DeploymentRecord): Promise<ProviderCheck> {
    const ref = d.provider?.provider_ref;
    if (!ref) return { state: "UNKNOWN", running: false, gone: true };
    const s = await this.runpod(d.target).status(d.deployment_id, ref).catch(providerError);
    return { state: s.state, running: s.state === "RUNNING", gone: s.state === "TERMINATED" };
  }

  /**
   * The model package for a pod presenting its fetch token. Allowed while the deployment is
   * running and unexpired, so a pod that restarts before unpacking can download it again.
   */
  modelFile(id: string, token: string | undefined): string {
    const d = this.svc.deployments.find(id);
    const deny = (why: string): never => {
      this.svc.audit.record({
        actor: { kind: "worker" },
        listener: "worker",
        action: "deployment.model.fetch",
        outcome: "denied",
        ...(d ? { project_id: d.project_id } : {}),
        target: id,
        reason: why,
      });
      throw new HttpError(401, "unauthenticated", "a valid model fetch token is required");
    };
    if (!d || !token) return deny("unknown deployment or no token");
    const f = join(this.dir(d), "fetch.json");
    if (!existsSync(f)) return deny("no model package for this deployment");
    const meta = readJson<FetchFile>(f);
    const a = Buffer.from(sha256(token), "hex");
    const b = Buffer.from(meta.token_sha256, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return deny("wrong fetch token");
    if (d.status !== "running" && d.status !== "approved") return deny(`deployment is ${d.status}`);
    if (Date.parse(meta.expires_at) <= this.o.now().getTime()) return deny("deployment expired");
    const tgz = join(this.dir(d), "model.tgz");
    if (!existsSync(tgz) || statSync(tgz).size !== meta.bytes) return deny("model package missing");
    this.svc.audit.record({
      actor: { kind: "worker" },
      listener: "worker",
      action: "deployment.model.fetch",
      outcome: "allowed",
      project_id: d.project_id,
      target: id,
      details: { sha256: meta.sha256, bytes: meta.bytes },
    });
    return tgz;
  }
}
