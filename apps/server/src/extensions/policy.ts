/** Persistent host-side grants for the explicit extension HTTP broker.
 * Trusted backends retain their own OS network access; this is not a process sandbox. */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeJsonAtomic } from "@ablationkit/core";
import { HttpError } from "../http.ts";

export interface ExtensionDestination {
  id: string;
  base_url: string;
  credential_env?: string;
  models?: string[];
  /** Body-free GETs permitted for endpoint metadata, never project input. */
  metadata_paths?: string[];
  allow_external: boolean;
  allow_dataset: boolean;
}

export interface ExtensionCapturePolicy {
  mode: "off" | "metadata_only" | "redacted" | "full";
  retention_days: number;
  builtin_redactions?: string[];
  redaction_patterns?: string[];
  patterns?: { name: string; regex: string }[];
  remote_capture?: boolean;
}

export interface ExtensionPolicyRules {
  destinations: ExtensionDestination[];
  capture?: ExtensionCapturePolicy;
}

export interface ExtensionPolicyDocument extends ExtensionPolicyRules {
  revision: number;
}

export interface ExtensionNetworkRequest {
  destination: string;
  path: string;
  method?: string;
  body?: unknown;
  data: "adhoc" | "dataset" | "metadata";
  model?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ExtensionPolicyOptions {
  stateDir: string;
  env?: () => Record<string, string | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CAPTURE_RANK = { off: 0, metadata_only: 1, redacted: 2, full: 3 } as const;
// Block credentials and headers that can redirect or interfere with HTTP framing.
const SENSITIVE_HEADER = /auth|cookie|token|secret|credential|(?:^|[-_])key(?:$|[-_])|api[-_]?key/i;
const FORBIDDEN_HEADER = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "forwarded",
  "x-forwarded-host",
  "x-original-url",
  "x-rewrite-url",
]);

function invalid(message: string): never {
  throw new HttpError(400, "invalid_extension_policy", message);
}

function identifier(value: string): string {
  if (typeof value !== "string" || !ID.test(value) || value === "." || value === "..") {
    invalid("Invalid project, extension or destination identifier");
  }
  return value;
}

function baseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("Destination base_url must be an HTTP URL");
  }
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    invalid("Destination base_url must be an HTTP URL without credentials, query or fragment");
  }
  // Encoded path separators have server-specific normalization and cannot define a safe scope.
  if (/%(?:2f|5c|00)/i.test(url.pathname))
    invalid("Destination base_url contains an encoded path separator");
  return url;
}

function local(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname);
}

function scopedUrl(base: URL, path: string): URL {
  if (
    typeof path !== "string" ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    path.startsWith("//") ||
    path.includes("\\") ||
    [...path].some((character) => character.charCodeAt(0) <= 32)
  ) {
    invalid("Network request path must be relative to its destination");
  }
  const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const target = new URL(path, new URL(prefix, base));
  if (
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    target.hash ||
    !target.pathname.startsWith(prefix)
  ) {
    invalid("Network request path leaves its destination scope");
  }
  // Reject nested encodings too: an upstream may decode a path more than once.
  let decoded = target.pathname;
  for (let depth = 0; depth < 5; depth++) {
    if (/%(?:2f|5c|00)/i.test(decoded))
      invalid("Network request contains an encoded path separator");
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      invalid("Network request path has invalid encoding");
    }
    if (next.split("/").some((part) => part === "." || part === ".."))
      invalid("Network request contains encoded traversal");
    if (next === decoded) return target;
    decoded = next;
  }
  invalid("Network request path contains excessive nested encoding");
}

function normalizeRules(input: ExtensionPolicyRules): ExtensionPolicyRules {
  if (!input || !Array.isArray(input.destinations)) invalid("Rules require a destinations array");
  const ids = new Set<string>();
  const destinations = input.destinations.map((item) => {
    if (!item || typeof item !== "object") invalid("Invalid destination");
    const id = identifier(item.id);
    if (ids.has(id)) invalid("Duplicate destination id");
    ids.add(id);
    if (typeof item.base_url !== "string") invalid("Destination requires base_url");
    const url = baseUrl(item.base_url);
    if (typeof item.allow_external !== "boolean" || typeof item.allow_dataset !== "boolean")
      invalid("Destination grants must be booleans");
    if (
      item.credential_env !== undefined &&
      (typeof item.credential_env !== "string" || !ENV_NAME.test(item.credential_env))
    )
      invalid("Invalid credential environment variable name");
    if (
      item.models !== undefined &&
      (!Array.isArray(item.models) ||
        item.models.some((model) => typeof model !== "string" || !model))
    )
      invalid("Destination models must be non-empty strings");
    if (
      item.metadata_paths !== undefined &&
      (!Array.isArray(item.metadata_paths) ||
        item.metadata_paths.some(
          (path) => typeof path !== "string" || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path),
        ))
    )
      invalid("Invalid metadata paths");
    return {
      id,
      base_url: url.href,
      allow_external: item.allow_external,
      allow_dataset: item.allow_dataset,
      ...(item.credential_env === undefined ? {} : { credential_env: item.credential_env }),
      ...(item.models === undefined ? {} : { models: [...new Set(item.models)] }),
      ...(item.metadata_paths === undefined
        ? {}
        : { metadata_paths: [...new Set(item.metadata_paths)] }),
    };
  });
  if (input.capture === undefined) return { destinations };
  const capture = input.capture;
  if (
    !capture ||
    !Object.hasOwn(CAPTURE_RANK, capture.mode) ||
    !Number.isSafeInteger(capture.retention_days) ||
    capture.retention_days < 1
  )
    invalid("Invalid capture mode or retention_days");
  for (const key of ["builtin_redactions", "redaction_patterns"] as const) {
    if (
      capture[key] !== undefined &&
      (!Array.isArray(capture[key]) || capture[key].some((pattern) => typeof pattern !== "string"))
    )
      invalid("Invalid redaction patterns");
  }
  if (
    capture.patterns !== undefined &&
    (!Array.isArray(capture.patterns) ||
      capture.patterns.some(
        (pattern) =>
          !pattern || typeof pattern.name !== "string" || typeof pattern.regex !== "string",
      ))
  )
    invalid("Invalid named redaction patterns");
  if (capture.remote_capture !== undefined && typeof capture.remote_capture !== "boolean")
    invalid("Invalid remote_capture flag");
  return {
    destinations,
    capture: {
      mode: capture.mode,
      retention_days: capture.retention_days,
      ...(capture.builtin_redactions === undefined
        ? {}
        : { builtin_redactions: [...capture.builtin_redactions] }),
      ...(capture.redaction_patterns === undefined
        ? {}
        : { redaction_patterns: [...capture.redaction_patterns] }),
      ...(capture.patterns === undefined
        ? {}
        : {
            patterns: capture.patterns.map((pattern) => ({
              name: pattern.name,
              regex: pattern.regex,
            })),
          }),
      ...(capture.remote_capture === undefined ? {} : { remote_capture: capture.remote_capture }),
    },
  };
}

function widening(current: ExtensionPolicyDocument, next: ExtensionPolicyRules): string[] {
  const reasons: string[] = [];
  for (const destination of next.destinations) {
    const previous = current.destinations.find((item) => item.id === destination.id);
    const url = baseUrl(destination.base_url);
    if (!previous) {
      if (
        (local(url) && destination.credential_env) ||
        (!local(url) && (destination.allow_dataset || destination.allow_external))
      )
        reasons.push(`new sensitive destination ${destination.id}`);
      continue;
    }
    if (!local(url) && !previous.allow_external && destination.allow_external)
      reasons.push(`external access for ${destination.id}`);
    if (!local(url) && !previous.allow_dataset && destination.allow_dataset)
      reasons.push(`dataset access for ${destination.id}`);
    if (destination.credential_env && previous.credential_env !== destination.credential_env)
      reasons.push(`credential access for ${destination.id}`);
    const oldUrl = baseUrl(previous.base_url);
    if (
      oldUrl.href !== url.href &&
      (!local(url) || destination.credential_env || destination.allow_dataset)
    )
      reasons.push(`changed sensitive destination ${destination.id}`);
    if (
      previous.models &&
      (!destination.models || destination.models.some((model) => !previous.models?.includes(model)))
    )
      reasons.push(`model access for ${destination.id}`);
  }
  const before = current.capture;
  const after = next.capture;
  if (after) {
    if (CAPTURE_RANK[after.mode] > CAPTURE_RANK[before?.mode ?? "redacted"])
      reasons.push("increased capture");
    if (after.retention_days > (before?.retention_days ?? 30)) reasons.push("increased retention");
    if (after.remote_capture && !before?.remote_capture) reasons.push("remote capture enabled");
  }
  if (before) {
    for (const key of ["builtin_redactions", "redaction_patterns"] as const) {
      if (before[key]?.some((pattern) => !after?.[key]?.includes(pattern)))
        reasons.push(`removed ${key}`);
    }
    if (
      before.patterns?.some(
        (pattern) =>
          !after?.patterns?.some(
            (item) => item.name === pattern.name && item.regex === pattern.regex,
          ),
      )
    )
      reasons.push("removed or changed named redaction patterns");
  }
  return reasons;
}

/** Credentials stay in the coordinator; disabling a backend does not remove these grants. */
export class ExtensionPolicyStore {
  private readonly stateDir: string;
  private readonly timeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: ExtensionPolicyOptions) {
    this.stateDir = resolve(options.stateDir);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    for (const limit of [this.timeoutMs, this.maxRequestBytes, this.maxResponseBytes]) {
      if (!Number.isSafeInteger(limit) || limit < 1)
        invalid("Network limits must be positive integers");
    }
  }

  get(pid: string, ext: string): ExtensionPolicyDocument {
    const path = this.file(pid, ext);
    let document: ExtensionPolicyDocument;
    try {
      document = JSON.parse(readFileSync(path, "utf8")) as ExtensionPolicyDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { revision: 0, destinations: [] };
      throw new HttpError(500, "invalid_stored_extension_policy", "Cannot read extension policy");
    }
    try {
      if (!Number.isSafeInteger(document.revision) || document.revision < 1)
        invalid("Invalid policy revision");
      return { revision: document.revision, ...normalizeRules(document) };
    } catch {
      throw new HttpError(
        500,
        "invalid_stored_extension_policy",
        "Stored extension policy is invalid",
      );
    }
  }

  update(
    pid: string,
    ext: string,
    rules: ExtensionPolicyRules,
    options: { expected_revision: number | null; allowWiden: boolean },
  ): ExtensionPolicyDocument {
    const current = this.get(pid, ext);
    if ((options.expected_revision ?? 0) !== current.revision)
      throw new HttpError(
        409,
        "revision_conflict",
        `Extension policy is at revision ${current.revision}`,
      );
    const normalized = normalizeRules(rules);
    const changes = widening(current, normalized);
    if (changes.length && options.allowWiden !== true)
      throw new HttpError(
        403,
        "widening_requires_confirmation",
        "This change widens extension data controls",
        { widening: changes },
      );
    const next = { revision: current.revision + 1, ...normalized };
    const path = this.file(pid, ext);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeJsonAtomic(path, next);
    return next;
  }

  /** Includes inactive extensions: persisted controls are project policy, not runtime state. */
  list(pid: string): ExtensionPolicyDocument[] {
    const dir = join(this.stateDir, identifier(pid), "extension-policy");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => this.get(pid, name.slice(0, -5)));
  }

  hasCredential(name: string): boolean {
    return typeof name === "string" && ENV_NAME.test(name) && !!this.environment()[name];
  }

  async request(pid: string, ext: string, input: ExtensionNetworkRequest): Promise<Response> {
    const destination = this.get(pid, ext).destinations.find(
      (item) => item.id === input.destination,
    );
    if (!destination)
      throw new HttpError(403, "destination_denied", "Extension destination is not configured");
    const base = baseUrl(destination.base_url);
    const target = scopedUrl(base, input.path);
    const metadata = input.data === "metadata";
    if (
      metadata &&
      ((input.method ?? "GET") !== "GET" ||
        input.body !== undefined ||
        Object.keys(input.headers ?? {}).length ||
        !destination.metadata_paths?.includes(input.path))
    )
      invalid("Metadata access requires a declared body-free GET path");
    if (!metadata && input.data !== "adhoc" && input.data !== "dataset")
      invalid("Network request must declare its data class");
    if (!local(target) && !destination.allow_external && (!metadata || destination.credential_env))
      throw new HttpError(403, "external_denied", "External network access is not approved");
    if (input.data === "dataset" && !destination.allow_dataset)
      throw new HttpError(403, "dataset_denied", "Dataset access is not approved");
    if (
      !metadata &&
      destination.models &&
      (!input.model || !destination.models.includes(input.model))
    )
      throw new HttpError(403, "model_denied", "Model is not in the destination allowlist");
    if (
      destination.models &&
      input.body &&
      typeof input.body === "object" &&
      "model" in input.body &&
      input.body.model !== input.model
    ) {
      throw new HttpError(
        403,
        "model_denied",
        "Request body model does not match the approved model",
      );
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (SENSITIVE_HEADER.test(name) || FORBIDDEN_HEADER.has(name.toLowerCase()))
        invalid("Request contains a prohibited header");
      try {
        headers.set(name, value);
      } catch {
        invalid("Invalid request header");
      }
    }
    const credential = destination.credential_env
      ? this.environment()[destination.credential_env]
      : undefined;
    if (destination.credential_env && !credential)
      throw new HttpError(503, "credential_missing", "Destination credential is unavailable");
    if (credential) {
      try {
        headers.set("authorization", `Bearer ${credential}`);
      } catch {
        throw new HttpError(503, "credential_invalid", "Destination credential is invalid");
      }
    }
    let body: string | undefined;
    if (input.body !== undefined) {
      try {
        body = JSON.stringify(input.body);
      } catch {
        invalid("Request body must be JSON");
      }
      if (body === undefined) invalid("Request body must be JSON");
      if (Buffer.byteLength(body) > this.maxRequestBytes)
        throw new HttpError(
          413,
          "request_too_large",
          "Extension network request exceeds its byte limit",
        );
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    const method = input.method ?? (body === undefined ? "GET" : "POST");
    if (
      !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) ||
      ((method === "GET" || method === "HEAD") && body !== undefined)
    )
      invalid("Invalid network request method or body");
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await abortable(
        (this.options.fetch ?? fetch)(target, {
          method,
          headers,
          redirect: "error",
          signal: controller.signal,
          ...(body === undefined ? {} : { body }),
        }),
        controller.signal,
      );
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => {});
        throw new HttpError(502, "redirect_denied", "Extension network redirects are prohibited");
      }
      const bytes = await this.readBody(response, controller.signal);
      const safeHeaders = new Headers();
      for (const [name, value] of response.headers.entries()) {
        if (
          !SENSITIVE_HEADER.test(name) &&
          !["content-length", "content-encoding", "transfer-encoding"].includes(name)
        )
          safeHeaders.append(name, redact(value, credential));
      }
      return new Response(
        [204, 205, 304].includes(response.status) || method === "HEAD"
          ? null
          : new Uint8Array(redactBytes(bytes, credential)),
        {
          status: response.status,
          statusText: redact(response.statusText, credential),
          headers: safeHeaders,
        },
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (input.signal?.aborted)
        throw new HttpError(499, "request_canceled", "Extension network request was canceled");
      if (timedOut)
        throw new HttpError(504, "network_timeout", "Extension network request timed out");
      throw new HttpError(502, "network_error", "Extension destination request failed");
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  private environment(): Record<string, string | undefined> {
    return this.options.env?.() ?? process.env;
  }

  private file(pid: string, ext: string): string {
    return join(this.stateDir, identifier(pid), "extension-policy", `${identifier(ext)}.json`);
  }

  private async readBody(response: Response, signal: AbortSignal): Promise<Buffer> {
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > this.maxResponseBytes) {
      void response.body?.cancel().catch(() => {});
      throw new HttpError(
        502,
        "response_too_large",
        "Extension network response exceeds its byte limit",
      );
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) return Buffer.concat(chunks, size);
        size += value.byteLength;
        if (size > this.maxResponseBytes)
          throw new HttpError(
            502,
            "response_too_large",
            "Extension network response exceeds its byte limit",
          );
        chunks.push(value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(new Error("Request aborted"));
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("Request aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function redact(value: string, credential?: string): string {
  return credential ? value.replaceAll(credential, "[redacted]") : value;
}

function redactBytes(value: Buffer, credential?: string): Buffer {
  if (!credential) return value;
  const needle = Buffer.from(credential);
  let start = 0;
  let index = value.indexOf(needle);
  if (index < 0) return value;
  const chunks: Buffer[] = [];
  while (index >= 0) {
    chunks.push(value.subarray(start, index), Buffer.from("[redacted]"));
    start = index + needle.length;
    index = value.indexOf(needle, start);
  }
  chunks.push(value.subarray(start));
  return Buffer.concat(chunks);
}
