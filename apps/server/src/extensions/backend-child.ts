import { pathToFileURL } from "node:url";
import {
  backendError,
  backendLine,
  backendWireError,
  decodeBackendValue,
  encodeBackendValue,
  readBackendLines,
} from "./backend-codec.ts";

interface Backend {
  call(
    method: string,
    params: unknown,
    context: { signal: AbortSignal },
  ): unknown | Promise<unknown>;
  shutdown?(): unknown | Promise<unknown>;
}

// Keep extension logging off the protocol channel, including during module import.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
const lifecycle = new AbortController();
const calls = new Map<string, AbortController>();
const hostCalls = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let backend: Backend | undefined;
let initializing = false;
let stopping = false;
let hostSequence = 0;

const unsent = new Set<Promise<void>>();

function send(message: Record<string, unknown>): void {
  // Track each write: a bare `process.exit` drops what a pipe has not taken yet (F37).
  const done = new Promise<void>((resolve) => {
    process.stdout.write(backendLine(message), () => resolve());
  });
  unsent.add(done);
  void done.then(() => unsent.delete(done));
}

async function exitAfterSend(code: number): Promise<never> {
  while (unsent.size) await Promise.all([...unsent]);
  process.exit(code);
}

async function initialize(context: unknown): Promise<void> {
  const entry = process.argv[2];
  if (!entry) throw new Error("Missing extension backend entry");
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.default !== "function")
    throw new Error("Extension backend must export a default factory");
  backend = await module.default({
    ...(context as Record<string, unknown>),
    call: async (method: string, params?: unknown) => {
      const encoded = await encodeBackendValue(params);
      const hostId = String(++hostSequence);
      return new Promise((resolve, reject) => {
        hostCalls.set(hostId, { resolve, reject });
        try {
          send({ host_id: hostId, method, params: encoded });
        } catch (error) {
          hostCalls.delete(hostId);
          reject(error);
        }
      });
    },
    notify: async (method: string, params?: unknown) => {
      send({ notification: true, method, params: await encodeBackendValue(params) });
    },
    signal: lifecycle.signal,
  });
  if (!backend || typeof backend.call !== "function")
    throw new Error("Extension backend factory must return a call function");
  send({ ready: true });
}

async function invoke(message: Record<string, unknown>): Promise<void> {
  const id = message["id"] as string;
  const controller = new AbortController();
  calls.set(id, controller);
  try {
    if (!backend) throw new Error("Extension backend is not ready");
    const result = await backend.call(
      message["method"] as string,
      decodeBackendValue(message["params"]),
      { signal: controller.signal },
    );
    send({ id, result: (await encodeBackendValue(result)) ?? null });
  } catch (error) {
    send({ id, error: backendWireError(error) });
  } finally {
    calls.delete(id);
  }
}

async function shutdown(id: string): Promise<void> {
  stopping = true;
  lifecycle.abort();
  for (const controller of calls.values()) controller.abort();
  try {
    await backend?.shutdown?.();
    send({ id, result: null });
  } catch (error) {
    send({ id, error: backendWireError(error) });
  }
  await exitAfterSend(0);
}

function receive(message: Record<string, unknown>): void {
  if (message["initialize"] === true && !initializing) {
    initializing = true;
    void initialize(decodeBackendValue(message["context"])).catch(fatal);
    return;
  }
  if (typeof message["host_id"] === "string" && ("result" in message || "error" in message)) {
    const hostId = message["host_id"];
    const pending = hostCalls.get(hostId);
    if (!pending) throw new Error("Unexpected extension host response id");
    hostCalls.delete(hostId);
    if ("error" in message) pending.reject(backendError(message["error"]));
    else pending.resolve(decodeBackendValue(message["result"]));
    return;
  }
  if (typeof message["cancel"] === "string") {
    calls.get(message["cancel"])?.abort();
    return;
  }
  if (!backend || stopping || typeof message["id"] !== "string")
    throw new Error("Invalid extension backend request");
  if (message["shutdown"] === true) {
    void shutdown(message["id"]).catch(fatal);
    return;
  }
  if (typeof message["method"] !== "string" || calls.has(message["id"]))
    throw new Error("Invalid extension backend method or duplicate id");
  void invoke(message).catch(fatal);
}

function fatal(error: unknown): never {
  try {
    send({ fatal: backendWireError(error) });
  } finally {
    process.exit(1);
  }
}

await readBackendLines(Bun.stdin.stream(), receive).catch(fatal);
lifecycle.abort();
await exitAfterSend(0);
