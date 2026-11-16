/** HTTP helpers shared by every listener (the JSON basics live in `@ablationkit/core/http`). */
import { HttpError, json } from "@ablationkit/core/http";
import { ProtocolValidationError } from "@ablationkit/protocol";

export { HttpError, json, readJsonBody } from "@ablationkit/core/http";

function errorResponse(e: HttpError): Response {
  return json(e.status, { error: { code: e.code, message: e.message, ...e.extra } });
}

/** Map anything thrown by a handler to an explicit error response. */
export function toErrorResponse(e: unknown): Response {
  if (e instanceof HttpError) return errorResponse(e);
  if (e instanceof ProtocolValidationError) {
    return errorResponse(
      new HttpError(400, "invalid_request", e.message, { issues: e.issues.slice(0, 20) }),
    );
  }
  console.error("coordinator: unhandled error", e);
  return errorResponse(new HttpError(500, "internal_error", "internal error"));
}

/**
 * A post-login landing path: a web UI path on the same origin (`/p/…`, with an optional query),
 * never another origin (`//host`, `/\\host`), the API, the login route itself, or control
 * characters. Anything else lands on `/`.
 */
export function safeNext(next: string): boolean {
  if (next.length > 2000 || !next.startsWith("/") || next.startsWith("//")) return false;
  if (!/^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/?]*$/.test(next)) return false;
  const path = next.split("?")[0] as string;
  return !path.startsWith("/api/") && path !== "/login" && !path.includes("/..");
}

export function str(
  body: Record<string, unknown>,
  key: string,
  opts: { optional: true },
): string | undefined;
export function str(
  body: Record<string, unknown>,
  key: string,
  opts?: { optional?: false },
): string;
export function str(
  body: Record<string, unknown>,
  key: string,
  opts: { optional?: boolean } = {},
): string | undefined {
  const v = body[key];
  if (v === undefined && opts.optional) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new HttpError(400, "invalid_request", `\`${key}\` must be a non-empty string`);
  }
  return v;
}

export function stringList(body: Record<string, unknown>, key: string): string[] | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw new HttpError(400, "invalid_request", `\`${key}\` must be an array of strings`);
  return v as string[];
}

export function intParam(url: URL, key: string, def: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new HttpError(400, "invalid_request", `${key} must be an integer in [${min}, ${max}]`);
  return n;
}
