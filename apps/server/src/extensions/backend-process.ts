import { join } from "node:path";
import {
  backendError,
  backendLine,
  backendWireError,
  decodeBackendValue,
  encodeBackendValue,
  readBackendLines,
} from "./backend-codec.ts";

export interface ExtensionBackendProcessOptions {
  entry: string;
  context?: Record<string, unknown>;
  broker: (method: string, params: unknown) => unknown | Promise<unknown>;
  notify?: (method: string, params: unknown) => void;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** Trusted code in a separate Bun process; this boundary does not sandbox it. */
export class ExtensionBackendProcess {
  private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly pending = new Map<string, PendingCall>();
  private readonly cancelled = new Set<string>();
  private readonly readiness: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private sequence = 0;
  private failure: Error | undefined;
  private initialized = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private startupTimer: ReturnType<typeof setTimeout>;
  private stderr = "";

  constructor(private readonly options: ExtensionBackendProcessOptions) {
    this.readiness = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readiness.catch(() => {});
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "TMPDIR"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, options.env, { ABLATIONKIT_EXTENSION_BACKEND: "1" });
    this.process = Bun.spawn(
      [process.execPath, join(import.meta.dir, "backend-child.ts"), options.entry],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      },
    );
    this.startupTimer = setTimeout(
      () => this.stop(new Error("Extension backend startup timed out")),
      this.timeoutMs,
    );
    void readBackendLines(this.process.stdout, (message) => this.receive(message)).catch(
      (error: unknown) => this.stop(asError(error)),
    );
    void this.readStderr();
    void this.process.exited.then((code) => {
      this.stop(
        new Error(
          `Extension backend exited (${code})${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
        ),
      );
    });
    void encodeBackendValue(options.context ?? {})
      .then((context) => {
        if (!this.failure) this.send({ initialize: true, context });
      })
      .catch((error: unknown) => this.stop(asError(error)));
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 30_000;
  }

  ready(): Promise<void> {
    return this.readiness;
  }

  async call<T = unknown>(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closing) throw new Error("Extension backend is closing");
    await this.waitUntilReady(options.signal);
    if (this.closing) throw new Error("Extension backend is closing");
    return (await this.request(
      { method, params: await encodeBackendValue(params) },
      options.signal,
    )) as T;
  }

  private waitUntilReady(signal?: AbortSignal): Promise<void> {
    if (!signal) return this.readiness;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const abort = () => reject(abortError());
      signal.addEventListener("abort", abort, { once: true });
      void this.readiness.then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (error: Error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    const timer = setTimeout(
      () => this.stop(new Error("Extension backend shutdown timed out")),
      2_000,
    );
    try {
      await this.readiness;
      if (!this.failure) await this.request({ shutdown: true });
      await this.process.exited;
    } catch {
      this.stop(new Error("Extension backend closed"));
      await this.process.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private request(message: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(abortError());
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.cancelled.add(id);
        pending.cleanup();
        pending.reject(abortError());
        try {
          this.send({ cancel: id });
        } catch (error) {
          this.stop(asError(error));
        }
      };
      const timer = setTimeout(
        () =>
          this.stop(
            new Error(
              `Extension backend call timed out (${String(message["method"] ?? "shutdown")})`,
            ),
          ),
        this.timeoutMs,
      );
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send({ id, ...message });
      } catch (error) {
        this.stop(asError(error));
      }
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    this.process.stdin.write(backendLine(message));
    void Promise.resolve(this.process.stdin.flush()).catch((error: unknown) =>
      this.stop(asError(error)),
    );
  }

  private receive(message: Record<string, unknown>): void {
    if (message["ready"] === true && !this.initialized) {
      this.initialized = true;
      clearTimeout(this.startupTimer);
      this.resolveReady();
      return;
    }
    if ("fatal" in message) throw backendError(message["fatal"]);
    if (typeof message["host_id"] === "string" && typeof message["method"] === "string") {
      void this.broker(
        message["host_id"],
        message["method"],
        decodeBackendValue(message["params"]),
      );
      return;
    }
    if (message["notification"] === true && typeof message["method"] === "string") {
      this.options.notify?.(message["method"], decodeBackendValue(message["params"]));
      return;
    }
    if (typeof message["id"] === "string" && ("result" in message || "error" in message)) {
      const id = message["id"];
      if (this.cancelled.delete(id)) return;
      const pending = this.pending.get(id);
      if (!pending) throw new Error("Unexpected extension backend response id");
      const result =
        "error" in message ? backendError(message["error"]) : decodeBackendValue(message["result"]);
      this.pending.delete(id);
      pending.cleanup();
      if ("error" in message) pending.reject(result as Error);
      else pending.resolve(result);
      return;
    }
    throw new Error("Invalid extension backend protocol message");
  }

  private async broker(hostId: string, method: string, params: unknown): Promise<void> {
    let response: Record<string, unknown>;
    try {
      response = {
        host_id: hostId,
        result: (await encodeBackendValue(await this.options.broker(method, params))) ?? null,
      };
    } catch (error) {
      response = { host_id: hostId, error: backendWireError(error) };
    }
    if (!this.failure) {
      try {
        this.send(response);
      } catch (error) {
        this.stop(asError(error));
      }
    }
  }

  private async readStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderr = (this.stderr + new TextDecoder().decode(value)).slice(-8_192);
      }
    } catch {
      /* Process teardown may close this stream. */
    } finally {
      reader.releaseLock();
    }
  }

  private stop(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.startupTimer);
    this.rejectReady(error);
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    this.cancelled.clear();
    this.process.kill("SIGKILL");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
function abortError(): Error {
  return Object.assign(new Error("Extension backend call aborted"), { name: "AbortError" });
}
