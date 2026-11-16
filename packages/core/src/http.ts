/** JSON responses, HTTP errors and body parsing for the coordinator and the bundled LLM backend. */

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export async function readJsonBody(
  req: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "request body must be application/json");
  }
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes)
    throw new HttpError(413, "body_too_large", "request body too large");
  let value: unknown;
  try {
    value = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}
