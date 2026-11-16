/** Project-scoped trusted backends: lifecycle, caller identity, and capability broker. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import { satisfies } from "@ablationkit/extension-host";
import type { BackendCaller, BackendContext } from "@ablationkit/extension-host/backend";
import {
  checkBackendValue,
  validateBackendManifest,
} from "@ablationkit/extension-host/backend-validation";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import type { BridgeRun } from "../tracking/bridge.ts";
import {
  callExtensionBackendBroker,
  type ExtensionBackendBrokerContext,
} from "./backend-broker.ts";
import { renderExtensionBackendPage } from "./backend-page.ts";
import { ExtensionBackendProcess } from "./backend-process.ts";
import type { BackendBundle, Invocation, LiveBackend } from "./backend-state.ts";
import { ExtensionDataStore } from "./data.ts";
import { ExtensionPolicyStore } from "./policy.ts";
import { sweepExtensionRetention } from "./retention.ts";

export type { BackendBundle } from "./backend-state.ts";
export class ExtensionBackends {
  private dataStore: ExtensionDataStore | undefined;
  private policyStore: ExtensionPolicyStore | undefined;
  get data(): ExtensionDataStore {
    this.dataStore ??= new ExtensionDataStore({ stateDir: this.svc.paths.stateDir });
    return this.dataStore;
  }
  get policies(): ExtensionPolicyStore {
    this.policyStore ??= new ExtensionPolicyStore({ stateDir: this.svc.paths.stateDir });
    return this.policyStore;
  }
  private live = new Map<string, LiveBackend>();
  private stopped = false;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly o: {
      svc: () => Services;
      bundles: readonly BackendBundle[];
      safeMode: boolean;
      retentionSweepMs?: number;
    },
  ) {}
  private get svc() {
    return this.o.svc();
  }
  bundle(ext: string, pid?: string): BackendBundle {
    const b =
      this.o.bundles.find((b) => b.manifest.id === ext) ??
      (pid ? this.svc.extensions.backendBundle(pid, ext) : undefined);
    if (!b) throw new HttpError(404, "unknown_extension", `No backend extension ${ext}`);
    return b;
  }
  legacyBridge(pid: string, method: string) {
    const provider = this.bundles(pid).find((b) => b.legacyBridges?.[method]);
    const bridge = provider?.legacyBridges?.[method];
    return provider && bridge ? { extension: provider.manifest.id, ...bridge } : undefined;
  }
  private stateFile(pid: string, ext: string) {
    this.svc.registry.require(pid);
    this.bundle(ext, pid);
    return join(this.svc.paths.stateDir, pid, "extensions", "backends", ext, "activation.json");
  }
  private importPolicy(pid: string, bundle: BackendBundle): void {
    if (!bundle.migratePolicy || this.policies.get(pid, bundle.manifest.id).revision !== 0) return;
    const rules = bundle.migratePolicy(this.svc.paths.stateDir, pid);
    if (rules)
      this.policies.update(pid, bundle.manifest.id, rules, {
        expected_revision: 0,
        allowWiden: true,
      });
  }
  enabled(pid: string, ext: string): boolean {
    const bundled = this.o.bundles.find((b) => b.manifest.id === ext);
    if (bundled) this.importPolicy(pid, bundled);
    if (this.o.safeMode) return false;
    if (!bundled && !this.svc.extensions.backendBundle(pid, ext)) return false;
    const f = this.stateFile(pid, ext);
    const bundle = this.bundle(ext, pid);
    if (!existsSync(f)) {
      mkdirSync(dirname(f), { recursive: true });
      writeJsonAtomic(f, {
        enabled: true,
        version: bundle.manifest.version,
        capabilities: bundle.manifest.capabilities,
      });
      return true;
    }
    const saved = readJson(f, (x) => x as { enabled: boolean; capabilities?: string[] });
    return (
      saved.enabled === true &&
      bundle.manifest.capabilities.every((cap) => saved.capabilities?.includes(cap))
    );
  }
  async setEnabled(
    pid: string,
    ext: string,
    enabled: boolean,
    actor: BackendCaller,
  ): Promise<void> {
    const b = this.bundle(ext, pid);
    const f = this.stateFile(pid, ext);
    mkdirSync(resolve(f, ".."), { recursive: true });
    writeJsonAtomic(f, {
      enabled,
      version: b.manifest.version,
      capabilities: b.manifest.capabilities,
      updated_at: this.svc.now().toISOString(),
      actor,
    });
    const key = `${pid}/${ext}`;
    const live = this.live.get(key);
    if (!enabled && live) {
      this.live.delete(key);
      await live.process.close();
      for (const run of live.runs.values()) await run.stop();
    }
    this.svc.events.publish(pid, "extension.backend.activation", { extension_id: ext, enabled });
  }
  private bundles(pid: string): BackendBundle[] {
    return [
      ...this.o.bundles,
      ...this.svc.extensions.list(pid).flatMap((e) => {
        const id = String(e["extension_id"]);
        if (this.o.bundles.some((b) => b.manifest.id === id)) return [];
        const b = this.svc.extensions.backendBundle(pid, id);
        return b ? [b] : [];
      }),
    ];
  }
  list(pid: string) {
    return this.bundles(pid).map((b) => ({
      id: b.manifest.id,
      version: b.manifest.version,
      bundled: this.o.bundles.some((x) => x.manifest.id === b.manifest.id),
      enabled: this.enabled(pid, b.manifest.id),
      operations: b.manifest.operations,
      pages: b.manifest.pages,
      services: b.manifest.services,
      agent_skills: b.manifest.agent_skills ?? [],
      capabilities: b.manifest.capabilities,
    }));
  }
  private snapshot(pid: string): Omit<BackendContext, "call" | "notify" | "signal"> {
    const project = this.svc.registry.require(pid);
    return {
      project,
      stateDir: this.svc.paths.stateDir,
      operationDir: join(this.svc.paths.home, "operations"),
      experimentIds: this.svc.models.experimentIds(pid),
      links: this.svc.tracking.mappings.getLinks(pid),
      now: this.svc.now().toISOString(),
      credentialNames: Object.keys(process.env).filter((n) => !!process.env[n]),
      ...(this.svc.bridge.available("managed")
        ? { bridgeAvailable: this.svc.bridge.available("managed") as string }
        : {}),
      ...(this.o.retentionSweepMs !== undefined
        ? { retentionSweepMs: this.o.retentionSweepMs }
        : {}),
    };
  }
  private brokerContext(): ExtensionBackendBrokerContext {
    return {
      svc: this.svc,
      data: this.data,
      policies: this.policies,
      enabled: (pid, ext) => !this.stopped && this.enabled(pid, ext),
      bundle: this.bundle.bind(this),
      invoke: this.invoke.bind(this),
    };
  }
  private start(pid: string, ext: string): LiveBackend {
    if (this.stopped || !this.enabled(pid, ext))
      throw new HttpError(403, "extension_inactive", `${ext} is inactive`);
    const key = `${pid}/${ext}`;
    const previous = this.live.get(key);
    if (previous) return previous;
    const bundle = this.bundle(ext, pid);
    const errors = validateBackendManifest(bundle.manifest);
    if (satisfies("2.0.0", bundle.manifest.host_api) !== true)
      errors.push("Backend requires Extension Host API 2");
    if (!bundle.manifest.capabilities.includes("backend.execute"))
      errors.push("Backend requires backend.execute capability");
    if (errors.length) throw new HttpError(400, "invalid_backend", errors.join("; "));
    const invocations = new Map<string, Invocation>();
    const runs = new Map<string, BridgeRun>();
    let live: LiveBackend;
    const process = new ExtensionBackendProcess({
      entry: join(bundle.root, bundle.manifest.entry),
      context: this.snapshot(pid),
      timeoutMs: 120_000,
      broker: (method, raw) =>
        callExtensionBackendBroker(this.brokerContext(), pid, ext, live, method, raw),
      notify: (method, raw) => {
        void callExtensionBackendBroker(this.brokerContext(), pid, ext, live, method, raw).catch(
          (e) =>
            console.error("extension notification rejected", ext, method, (e as Error).message),
        );
      },
    });
    live = { bundle, invocations, runs, process };
    this.live.set(key, live);
    return live;
  }
  async service<T = unknown>(
    pid: string,
    ext: string,
    service: string,
    args: unknown[],
    actor: BackendCaller = { kind: "human" },
    signal?: AbortSignal,
  ): Promise<T> {
    const b = this.bundle(ext, pid);
    // Internal compatibility services are explicit in the manifest, never arbitrary property traversal.
    if (!b.manifest.services.includes(service))
      throw new HttpError(403, "service_not_exported", service);
    if (actor.kind === "agent" && !b.manifest.service_agents?.includes(service))
      throw new HttpError(403, "human_only", "This service requires a researcher");
    return this.invoke(
      pid,
      ext,
      "service",
      { service, args, actor },
      actor,
      false,
      actor.kind === "human",
      signal,
    );
  }
  async operation(
    pid: string,
    ext: string,
    id: string,
    request: {
      url: string;
      method: string;
      params: Readonly<Record<string, string>>;
      body?: string;
    },
    actor: BackendCaller,
    signal?: AbortSignal,
  ): Promise<Response> {
    const op = this.bundle(ext, pid).manifest.operations.find((op) => op.id === id);
    if (!op) throw new HttpError(404, "unknown_operation", id);
    if (actor.kind === "agent" && !op.agent)
      throw new HttpError(403, "human_only", "Researcher only");
    let body: unknown;
    try {
      body = request.body ? JSON.parse(request.body) : {};
      checkBackendValue(op.input_schema, body);
    } catch (e) {
      throw new HttpError(400, "invalid_request", (e as Error).message);
    }
    const result: Response = await this.invoke(
      pid,
      ext,
      "operation",
      { operation: id, ...request, actor },
      actor,
      op.widens_data_controls === true && actor.kind === "human",
      actor.kind === "human",
      signal,
    );
    if (op.output_schema) {
      try {
        checkBackendValue(op.output_schema, await result.clone().json());
      } catch {
        throw new HttpError(
          500,
          "invalid_extension_output",
          "Extension returned an invalid result",
        );
      }
    }
    return result;
  }
  private async invoke<T>(
    pid: string,
    ext: string,
    method: string,
    params: Record<string, unknown>,
    actor: BackendCaller,
    allowWiden: boolean,
    canExecute: boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    const live = this.start(pid, ext);
    const token = randomUUID();
    for (const [id, v] of live.invocations)
      if (Date.now() - v.at > 7_200_000) live.invocations.delete(id);
    live.invocations.set(token, {
      actor,
      allowWiden,
      canExecute,
      at: Date.now(),
      ...(signal ? { signal } : {}),
    });
    try {
      return await live.process.call<T>(
        method,
        { ...params, invocation: token, snapshot: this.snapshot(pid) },
        signal ? { signal } : {},
      );
    } catch (e) {
      const x = e as Error & { status?: number; code?: string; extra?: Record<string, unknown> };
      if (x.code === "extension_tracking_scope" && params["method"] === "GET")
        throw new HttpError(404, "not_found", "Object not found in this project");
      throw new HttpError(x.status ?? 500, x.code ?? "extension_error", x.message, x.extra);
    }
  }
  async page(pid: string, ext: string, pageId: string): Promise<Response> {
    return renderExtensionBackendPage(
      { enabled: this.enabled.bind(this), bundle: this.bundle.bind(this) },
      pid,
      ext,
      pageId,
    );
  }
  jobSdks(pid: string): string[] {
    return this.bundles(pid)
      .filter((b) => this.enabled(pid, b.manifest.id))
      .flatMap((b) => b.manifest.job_sdks.map((path) => join(b.root, path)));
  }
  sdkPythonPaths(pid: string): string[] {
    return [...new Set(this.jobSdks(pid).map((path) => dirname(path)))];
  }
  async ingest<T>(
    pid: string,
    event: string,
    payload: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<T> {
    const bundle = this.bundles(pid).find(
      (b) => this.enabled(pid, b.manifest.id) && b.manifest.ingest.includes(event),
    );
    const service = bundle?.manifest.ingest_services?.[event];
    if (!bundle || !service)
      throw new HttpError(403, "ingest_unavailable", "No ingestion adapter is active");
    const actor: BackendCaller = { kind: "agent", id: `extension:${bundle.manifest.id}:ingest` };
    return this.invoke<T>(
      pid,
      bundle.manifest.id,
      "service",
      { service, args: [pid, payload, context], actor },
      actor,
      false,
      false,
    );
  }
  async sweep(): Promise<Record<string, number>> {
    return sweepExtensionRetention(this.svc, this.policies);
  }
  async startAll(): Promise<void> {
    for (const project of this.svc.registry.list())
      for (const bundle of this.o.bundles) {
        try {
          this.importPolicy(project.project_id, bundle);
        } catch (error) {
          console.error(
            "extension policy migration failed",
            bundle.manifest.id,
            project.project_id,
            (error as Error).message,
          );
        }
      }
    const every = this.o.retentionSweepMs ?? 3_600_000;
    if (every > 0 && !this.sweepTimer) {
      this.sweepTimer = setInterval(() => {
        void this.sweep().catch((error) =>
          console.error("extension retention failed", (error as Error).message),
        );
      }, every);
      this.sweepTimer.unref?.();
    }
    if (this.o.safeMode) return;
    for (const p of this.svc.registry.list()) {
      try {
        for (const b of this.bundles(p.project_id)) {
          try {
            if (this.enabled(p.project_id, b.manifest.id))
              await this.start(p.project_id, b.manifest.id).process.ready();
          } catch (error) {
            console.error(
              "extension backend startup failed",
              b.manifest.id,
              (error as Error).message,
            );
          }
        }
      } catch (error) {
        console.error("extension backend catalog failed", p.project_id, (error as Error).message);
      }
    }
  }
  async stop(pid: string, ext: string): Promise<void> {
    const key = `${pid}/${ext}`;
    const live = this.live.get(key);
    if (live) {
      this.live.delete(key);
      await live.process.close();
      await Promise.all([...live.runs.values()].map((r) => r.stop()));
    }
  }
  /** Stop every backend of a project (project removal); its caches go with the process. */
  async stopProject(pid: string): Promise<void> {
    const exts = [...this.live.keys()]
      .filter((k) => k.startsWith(`${pid}/`))
      .map((k) => k.slice(pid.length + 1));
    for (const ext of exts) await this.stop(pid, ext);
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.all(
      [...this.live.values()].map(async (l) => {
        await l.process.close();
        await Promise.all([...l.runs.values()].map((r) => r.stop()));
      }),
    );
    this.live.clear();
  }
}
