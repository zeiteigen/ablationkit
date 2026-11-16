/** Wire values for the trusted extension subprocess protocol. */
export interface BackendWireError {
  message: string;
  code?: string | number;
  status?: number;
  extra?: Record<string, unknown>;
}

export function backendWireError(error: unknown): BackendWireError {
  const source = error as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
    extra?: unknown;
  } | null;
  return {
    message: typeof source?.message === "string" ? source.message : String(error),
    ...(typeof source?.code === "string" || typeof source?.code === "number"
      ? { code: source.code }
      : {}),
    ...(typeof source?.status === "number" ? { status: source.status } : {}),
    ...(isBackendRecord(source?.extra) ? { extra: source.extra } : {}),
  };
}

export function backendError(value: unknown): Error {
  if (!isBackendRecord(value) || typeof value["message"] !== "string") {
    throw new Error("Invalid extension backend error");
  }
  return Object.assign(new Error(value["message"]), {
    ...(typeof value["code"] === "string" || typeof value["code"] === "number"
      ? { code: value["code"] }
      : {}),
    ...(typeof value["status"] === "number" ? { status: value["status"] } : {}),
    ...(isBackendRecord(value["extra"]) ? { extra: value["extra"] } : {}),
  });
}

function isBackendRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function encodeBackendValue(value: unknown): Promise<unknown> {
  if (value instanceof Response) {
    return {
      __ak_backend_type: "response",
      status: value.status,
      statusText: value.statusText,
      headers: Array.from(value.headers.entries()),
      body: Buffer.from(await value.arrayBuffer()).toString("base64"),
    };
  }
  if (value instanceof Uint8Array) {
    return { __ak_backend_type: "bytes", body: Buffer.from(value).toString("base64") };
  }
  if (value instanceof Error) {
    return { __ak_backend_type: "error", ...backendWireError(value) };
  }
  if (Array.isArray(value)) return Promise.all(value.map(encodeBackendValue));
  if (isBackendRecord(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => [key, await encodeBackendValue(item)]),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

export function decodeBackendValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBackendValue);
  if (!isBackendRecord(value)) return value;
  if (value["__ak_backend_type"] === "bytes" && typeof value["body"] === "string") {
    return new Uint8Array(Buffer.from(value["body"], "base64"));
  }
  if (value["__ak_backend_type"] === "error") return backendError(value);
  if (value["__ak_backend_type"] === "response") {
    if (
      typeof value["status"] !== "number" ||
      typeof value["statusText"] !== "string" ||
      typeof value["body"] !== "string" ||
      !Array.isArray(value["headers"])
    )
      throw new Error("Invalid extension backend Response");
    const status = value["status"];
    return new Response(
      [101, 204, 205, 304].includes(status) ? null : Buffer.from(value["body"], "base64"),
      { status, statusText: value["statusText"], headers: value["headers"] as [string, string][] },
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decodeBackendValue(item)]),
  );
}

export const BACKEND_MAX_LINE_BYTES = 16 * 1024 * 1024;

export function backendLine(value: unknown): string {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > BACKEND_MAX_LINE_BYTES) {
    throw new Error("Extension backend protocol line exceeds 16 MiB");
  }
  return `${line}\n`;
}

/** Stream framing bounds even a peer that never sends a newline. */
export async function readBackendLines(
  stream: ReadableStream<Uint8Array>,
  receive: (message: Record<string, unknown>) => void,
): Promise<void> {
  const reader = stream.getReader();
  let chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      for (let index = 0; index < value.length; index++) {
        if (value[index] !== 10) continue;
        size += index - start;
        if (size > BACKEND_MAX_LINE_BYTES)
          throw new Error("Extension backend protocol line exceeds 16 MiB");
        chunks.push(value.subarray(start, index));
        const message: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
        if (!isBackendRecord(message))
          throw new Error("Invalid extension backend protocol message");
        receive(message);
        chunks = [];
        size = 0;
        start = index + 1;
      }
      if (start < value.length) {
        const remainder = value.subarray(start);
        size += remainder.length;
        if (size > BACKEND_MAX_LINE_BYTES)
          throw new Error("Extension backend protocol line exceeds 16 MiB");
        chunks.push(remainder);
      }
    }
    if (size !== 0) throw new Error("Truncated extension backend protocol line");
  } finally {
    reader.releaseLock();
  }
}
