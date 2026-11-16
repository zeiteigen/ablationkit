/**
 * Runpod pods (spec §10: provision, a secure collector route, logs/metrics/artifacts, terminate,
 * approval for paid compute; ADR 0023).
 *
 * There is no SSH into a pod, so the bundle is *pulled*: the pod's start command downloads it from
 * the coordinator's worker listener with the attempt's launch token, checks its SHA-256 and runs
 * `ablationkit_worker run`. The pod reaches the listener over the tailnet: with
 * `tailscale_authkey_secret` it joins with a Runpod secret (referenced, never copied) in userspace
 * mode and routes the worker's HTTP through tailscaled's proxy.
 *
 * The worker directory lives on the pod volume (/workspace), so:
 * - a container restart never reruns the job (the worker finds its state and resumes delivery);
 * - after delivery the pod removes itself; when delivery did not finish within the deadline it
 *   stops itself (storage billing only), and a drain restarts it to deliver the spool;
 * - self-stop uses the pod-scoped `runpodctl` Runpod injects; without it the coordinator releases
 *   the pod when it next sees the attempt synced (labelled in `target doctor`).
 */
import type { ComputeTarget } from "@ablationkit/protocol";
import {
  type Capabilities,
  type DoctorCheck,
  type ProviderStatus,
  type StageInput,
  sq,
  type TargetAdapter,
  TargetError,
} from "./targets.ts";

const DEFAULT_API = "https://rest.runpod.io/v1";
export const RUNPOD_WORK_DIR = "/workspace/.ablationkit-worker";

interface Pod {
  readonly id: string;
  readonly name?: string;
  readonly desiredStatus?: string;
}

/** The pod's start command: join the tailnet, pull and verify the bundle once, run the worker. */
export function runpodStartScript(t: ComputeTarget, input: StageInput): string {
  const r = t.runpod;
  const dir = `${t.work_dir ?? RUNPOD_WORK_DIR}/${input.attemptId}`;
  const python = t.python ?? "python3";
  const deadline = r?.deliver_deadline_sec ?? 3600;
  const url = `${input.workerUrl.replace(/\/$/, "")}/api/v1/jobs/${input.jobId}/attempts/${input.attemptId}/bundle`;
  const pull = [
    "import hashlib, io, json, os, sys, tarfile, time, urllib.request",
    "d = sys.argv[1]",
    'c = json.load(open(os.path.join(d, "credentials.json")))',
    `req = urllib.request.Request(${JSON.stringify(url)}, headers={"authorization": "Bearer " + c["launch_token"]})`,
    "for i in range(60):",
    "    try:",
    "        data = urllib.request.urlopen(req, timeout=600).read()",
    "        break",
    "    except Exception as e:",
    '        print("bundle download failed:", e, flush=True)',
    "        time.sleep(min(60, 2 ** min(i, 5)))",
    "else:",
    '    sys.exit("the coordinator did not serve the bundle")',
    `if hashlib.sha256(data).hexdigest() != ${JSON.stringify(input.bundleSha256)}:`,
    '    sys.exit("bundle checksum mismatch")',
    'b = os.path.join(d, "bundle")',
    "os.makedirs(b, exist_ok=True)",
    "with tarfile.open(fileobj=io.BytesIO(data)) as tf:",
    "    for m in tf.getmembers():",
    '        if m.name.startswith("/") or ".." in m.name.split("/") or m.issym() or m.islnk():',
    '            sys.exit("unsafe path in bundle: " + m.name)',
    "    tf.extractall(b)",
  ].join("\n");
  return [
    "set -u",
    `D=${sq(dir)}`,
    'mkdir -p "$D"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    'if [ -n "${AK_TS_AUTHKEY:-}" ]; then',
    "  command -v tailscale >/dev/null 2>&1 || (curl -fsSL https://tailscale.com/install.sh | sh)",
    '  (tailscaled --tun=userspace-networking --outbound-http-proxy-listen=localhost:1055 --state=mem: >>"$D/tailscaled.log" 2>&1 &)',
    "  sleep 3",
    `  tailscale up --authkey="$AK_TS_AUTHKEY" --hostname=${sq(`ak-${input.attemptId}`)} || echo "tailscale up failed" >&2`,
    "  export http_proxy=http://localhost:1055 HTTP_PROXY=http://localhost:1055",
    "fi",
    // Delivered before a container restart: nothing to do but release the pod.
    'if grep -q \'"phase": *"synced"\' "$D/state.json" 2>/dev/null; then rc=0',
    "else",
    '  if [ ! -e "$D/bundle/bundle.json" ]; then',
    '    (umask 077; printf %s "$AK_WORKER_CREDENTIALS" | base64 -d > "$D/credentials.json")',
    `    ${sq(python)} -c ${sq(pull)} "$D" || { echo "bundle staging failed" >&2; sleep infinity; }`,
    "  fi",
    '  export PYTHONPATH="$D/bundle/worker"',
    `  export ABLATIONKIT_WORKER_DELIVER_DEADLINE_SEC=${deadline}`,
    `  ${sq(python)} -m ablationkit_worker run --dir "$D" --provider-job-id "\${RUNPOD_POD_ID:-}" >>"$D/worker.out" 2>&1`,
    "  rc=$?",
    "fi",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    'if command -v runpodctl >/dev/null 2>&1 && [ -n "${RUNPOD_POD_ID:-}" ]; then',
    '  if [ "$rc" = 0 ]; then runpodctl remove pod "$RUNPOD_POD_ID"; else runpodctl stop pod "$RUNPOD_POD_ID"; fi',
    "fi",
    // Never exit: a container that exits is restarted by Runpod.
    "sleep infinity",
  ].join("\n");
}

export interface EndpointInput {
  /** The deployment ID: the pod is named `ak-<id>` and joins the tailnet under that name. */
  readonly deploymentId: string;
  /** Where the pod downloads the model package (`GET`, bearer `fetchToken`). */
  readonly modelUrl: string;
  readonly fetchToken: string;
  readonly modelSha256: string;
  /** Unix seconds: the pod removes itself at this time even if nobody stops it. */
  readonly expiresAtSec: number;
}

export const DEFAULT_SERVE_COMMAND =
  'python3 -m mlflow models serve -m "$MODEL_DIR" -h 0.0.0.0 -p "$PORT" --env-manager local';

/**
 * A research endpoint pod's start command (criterion 12, endpoint half): join the tailnet, pull and
 * verify the model package once onto the volume, then serve it until the deployment's expiry. The
 * serving loop and the expiry run on the pod, so the endpoint does not depend on the coordinator; a
 * container restart resumes serving the same files and never downloads a different model.
 */
export function runpodEndpointScript(t: ComputeTarget, input: EndpointInput): string {
  const r = t.runpod;
  const dir = `${t.work_dir ?? RUNPOD_WORK_DIR}/endpoints/${input.deploymentId}`;
  const python = t.python ?? "python3";
  const pull = [
    "import hashlib, io, os, sys, tarfile, time, urllib.request",
    "d = sys.argv[1]",
    `req = urllib.request.Request(${JSON.stringify(input.modelUrl)}, headers={"authorization": "Bearer " + os.environ["AK_MODEL_TOKEN"]})`,
    "for i in range(60):",
    "    try:",
    "        data = urllib.request.urlopen(req, timeout=600).read()",
    "        break",
    "    except Exception as e:",
    '        print("model download failed:", e, flush=True)',
    "        time.sleep(min(60, 2 ** min(i, 5)))",
    "else:",
    '    sys.exit("the coordinator did not serve the model")',
    `if hashlib.sha256(data).hexdigest() != ${JSON.stringify(input.modelSha256)}:`,
    '    sys.exit("model checksum mismatch")',
    'm = os.path.join(d, "model.tmp")',
    "os.makedirs(m, exist_ok=True)",
    "with tarfile.open(fileobj=io.BytesIO(data)) as tf:",
    "    for x in tf.getmembers():",
    '        if x.name.startswith("/") or ".." in x.name.split("/") or x.issym() or x.islnk():',
    '            sys.exit("unsafe path in model package: " + x.name)',
    "    tf.extractall(m)",
    'os.rename(m, os.path.join(d, "model"))',
  ].join("\n");
  return [
    "set -u",
    `D=${sq(dir)}`,
    'mkdir -p "$D"',
    `EXP=${Math.floor(input.expiresAtSec)}`,
    "release() {",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '  if command -v runpodctl >/dev/null 2>&1 && [ -n "${RUNPOD_POD_ID:-}" ]; then runpodctl remove pod "$RUNPOD_POD_ID"; fi',
    "  sleep infinity",
    "}",
    'if [ "$(date +%s)" -ge "$EXP" ]; then echo "the endpoint expired" >&2; release; fi',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    'if [ -n "${AK_TS_AUTHKEY:-}" ]; then',
    "  command -v tailscale >/dev/null 2>&1 || (curl -fsSL https://tailscale.com/install.sh | sh)",
    '  (tailscaled --tun=userspace-networking --outbound-http-proxy-listen=localhost:1055 --state=mem: >>"$D/tailscaled.log" 2>&1 &)',
    "  sleep 3",
    `  tailscale up --authkey="$AK_TS_AUTHKEY" --hostname=${sq(`ak-${input.deploymentId}`)} || echo "tailscale up failed" >&2`,
    "fi",
    'if [ ! -d "$D/model" ]; then',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '  ( if [ -n "${AK_TS_AUTHKEY:-}" ]; then export http_proxy=http://localhost:1055 HTTP_PROXY=http://localhost:1055; fi',
    `    ${sq(python)} -c ${sq(pull)} "$D" ) || { echo "model staging failed" >&2; release; }`,
    "fi",
    'export MODEL_DIR="$D/model"',
    `export PORT=${r?.serve_port ?? 8080}`,
    // Serve until the expiry; a crashed server is restarted (bounded by the same deadline).
    'while [ "$(date +%s)" -lt "$EXP" ]; do',
    "  left=$(( EXP - $(date +%s) ))",
    `  timeout "$left" bash -c ${sq(r?.serve_command ?? DEFAULT_SERVE_COMMAND)} >>"$D/serve.log" 2>&1`,
    '  [ "$(date +%s)" -lt "$EXP" ] && sleep 5',
    "done",
    "release",
  ].join("\n");
}

export class RunpodTarget implements TargetAdapter {
  readonly kind = "runpod" as const;
  readonly capabilities: Capabilities = {
    submit: true,
    status: true,
    cancel: true,
    drain: true,
    independent_supervision: true,
    paid: true,
    pulls_bundle: true,
    release: true,
  };
  private readonly api: string;

  constructor(
    readonly target: ComputeTarget,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    if (!target.runpod) throw new TargetError("invalid_target", "runpod targets need `runpod`");
    this.api = (target.runpod.api_url ?? DEFAULT_API).replace(/\/$/, "");
  }

  private key(): string {
    const name = this.target.runpod?.api_key_env as string;
    const k = this.env[name];
    if (!k)
      throw new TargetError(
        "credentials_missing",
        `the coordinator's environment has no ${name} (the Runpod API key)`,
      );
    return k;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    let res: Response;
    try {
      res = await fetch(`${this.api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.key()}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (e instanceof TargetError) throw e;
      throw new TargetError("target_unreachable", `Runpod API: ${(e as Error).message}`);
    }
    if (res.status === 404) return undefined;
    const text = await res.text();
    if (!res.ok)
      throw new TargetError(
        res.status === 401 || res.status === 403 ? "credentials_rejected" : "target_command_failed",
        `Runpod API ${method} ${path}: ${res.status} ${text.slice(0, 500)}`,
      );
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async findPod(attemptId: string): Promise<Pod | undefined> {
    const pods = (await this.call<Pod[]>("GET", "/pods")) ?? [];
    return (Array.isArray(pods) ? pods : []).find((p) => p.name === `ak-${attemptId}`);
  }

  /** Nothing to copy: the pod pulls its bundle from the coordinator. */
  async stage(): Promise<void> {}

  /**
   * The pod named `ak-<key>`, created if it does not exist yet: a retried create finds the pod it
   * already made, also when the create's response was lost.
   */
  private async ensurePod(
    key: string,
    o: { env: Record<string, string>; script: string; networkVolume: boolean },
  ): Promise<string> {
    const existing = await this.findPod(key);
    if (existing) return existing.id;
    const r = this.target.runpod as NonNullable<ComputeTarget["runpod"]>;
    const body = {
      name: `ak-${key}`,
      imageName: r.image,
      gpuTypeIds: r.gpu_type_ids,
      gpuCount: r.gpu_count ?? 1,
      ...(r.cloud_type ? { cloudType: r.cloud_type } : {}),
      containerDiskInGb: r.container_disk_gb ?? 20,
      volumeInGb: r.volume_gb ?? 20,
      volumeMountPath: "/workspace",
      ...(o.networkVolume && r.network_volume_id ? { networkVolumeId: r.network_volume_id } : {}),
      interruptible: false,
      env: {
        ...o.env,
        ...(r.tailscale_authkey_secret
          ? { AK_TS_AUTHKEY: `{{ RUNPOD_SECRET_${r.tailscale_authkey_secret} }}` }
          : {}),
      },
      dockerStartCmd: ["bash", "-c", o.script],
    };
    let pod: Pod | undefined;
    try {
      pod = await this.call<Pod>("POST", "/pods", body);
    } catch (e) {
      const again = await this.findPod(key).catch(() => undefined);
      if (again) return again.id;
      throw e;
    }
    if (!pod?.id) throw new TargetError("target_command_failed", "Runpod returned no pod ID");
    return pod.id;
  }

  /** One pod per attempt. */
  async submit(input: StageInput): Promise<{ provider_job_id: string }> {
    const id = await this.ensurePod(input.attemptId, {
      env: { AK_WORKER_CREDENTIALS: Buffer.from(input.credentials).toString("base64") },
      script: runpodStartScript(this.target, input),
      networkVolume: true,
    });
    return { provider_job_id: id };
  }

  async status(_attemptId: string, podId: string): Promise<ProviderStatus> {
    const pod = await this.call<Pod>("GET", `/pods/${encodeURIComponent(podId)}`);
    if (!pod) return { state: "TERMINATED", terminal: true };
    const state = pod.desiredStatus ?? "UNKNOWN";
    return { state, terminal: state === "EXITED" || state === "TERMINATED" };
  }

  /** Stop the pod (its volume, and so the spool, is kept; a drain delivers what is left). */
  async cancel(_attemptId: string, podId: string): Promise<void> {
    await this.call("POST", `/pods/${encodeURIComponent(podId)}/stop`);
  }

  /** Restart a stopped pod: its worker finds the spool on the volume and delivers it. */
  async drain(_attemptId: string, podId?: string): Promise<void> {
    if (!podId) throw new TargetError("cannot_drain", "no pod ID recorded");
    const pod = await this.call<Pod>("GET", `/pods/${encodeURIComponent(podId)}`);
    if (!pod || pod.desiredStatus === "TERMINATED")
      throw new TargetError(
        "cannot_drain",
        `pod ${podId} is terminated; its volume and spool are gone unless a network volume holds them`,
      );
    if (pod.desiredStatus !== "RUNNING")
      await this.call("POST", `/pods/${encodeURIComponent(podId)}/start`);
  }

  /**
   * Start a research endpoint pod (one per deployment, looked up by name before any create, so a
   * retried start never creates a second pod). The model token and the Tailscale secret reference
   * are the only credentials in the pod's environment.
   */
  async startEndpoint(input: EndpointInput): Promise<{ provider_ref: string }> {
    const id = await this.ensurePod(input.deploymentId, {
      env: { AK_MODEL_TOKEN: input.fetchToken },
      script: runpodEndpointScript(this.target, input),
      networkVolume: false,
    });
    return { provider_ref: id };
  }

  /** The tailnet URL of a research endpoint (MagicDNS name of the pod). */
  endpointUrl(deploymentId: string): string {
    return `http://ak-${deploymentId}:${this.target.runpod?.serve_port ?? 8080}`;
  }

  async reauthorize(): Promise<void> {
    throw new TargetError(
      "not_supported",
      "a pod's credentials cannot be replaced from outside; drain it after the launch token expires, or `remote import` its worker directory",
    );
  }

  /** Terminate the pod once its results are delivered (no-op when it already removed itself). */
  async release(_attemptId: string, podId: string): Promise<void> {
    await this.call("DELETE", `/pods/${encodeURIComponent(podId)}`);
  }

  async doctor(workerUrl: string): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const name = this.target.runpod?.api_key_env as string;
    if (!this.env[name]) {
      checks.push({ name: "runpod api key", ok: false, detail: `${name} is not set` });
      return checks;
    }
    checks.push({ name: "runpod api key", ok: true, detail: `${name} is set` });
    try {
      const pods = (await this.call<Pod[]>("GET", "/pods")) ?? [];
      checks.push({
        name: "runpod api",
        ok: true,
        detail: `${this.api} answered (${Array.isArray(pods) ? pods.length : 0} pods)`,
      });
    } catch (e) {
      checks.push({ name: "runpod api", ok: false, detail: (e as Error).message.slice(0, 300) });
    }
    const host = new URL(workerUrl).hostname;
    const tailnet = /\.ts\.net$/.test(host) || /^100\./.test(host) || !host.includes(".");
    const ts = this.target.runpod?.tailscale_authkey_secret;
    checks.push({
      name: "route from the pod",
      ok: !tailnet || ts !== undefined,
      detail: ts
        ? `pods join the tailnet with the Runpod secret ${ts} (a reusable auth key, so restarts can rejoin) and reach ${workerUrl}`
        : tailnet
          ? `${workerUrl} is on the tailnet, but no \`tailscale_authkey_secret\` is set: pods cannot reach it`
          : `${workerUrl} must be reachable from Runpod without the tailnet`,
    });
    checks.push({
      name: "pod self-stop",
      ok: true,
      detail:
        "advisory: the pod stops or removes itself with Runpod's pod-scoped runpodctl when the image has it; otherwise the coordinator releases it when it next sees the attempt synced",
    });
    if (this.target.runpod?.cents_per_hour === undefined)
      checks.push({
        name: "rate card",
        ok: false,
        detail: "no `cents_per_hour`: submissions show no estimate",
      });
    return checks;
  }
}
