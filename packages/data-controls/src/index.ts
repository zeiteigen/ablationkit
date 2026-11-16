/**
 * Capture and redaction of trace bodies (spec §5.6.2 "LLM measurement and privacy rules",
 * criterion 10e). The same functions run where traces are written (playground, job ingest,
 * evaluation results) and where they are read (the trace explorer applies the current rules again,
 * so tightening the policy also hides what was captured under an older one).
 */

export type CaptureMode = "full" | "redacted" | "metadata_only" | "off";
export type BuiltinRedaction = "email" | "secret" | "phone" | "card" | "ipv4";

export interface CapturePolicyLike {
  readonly mode: CaptureMode;
  readonly builtin_redactions: readonly BuiltinRedaction[];
  readonly patterns: readonly { readonly name: string; readonly regex: string }[];
}

export const BUILTIN_REDACTIONS: Readonly<Record<BuiltinRedaction, string>> = {
  email: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}",
  secret:
    "(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|[Bb]earer +[A-Za-z0-9._~+/=-]{16,}",
  phone:
    "(?<![0-9A-Za-z])[+]?[0-9]{1,3}[ .-]?[(]?[0-9]{3}[)]?[ .-]?[0-9]{3}[ .-]?[0-9]{4}(?![0-9A-Za-z])",
  card: "(?<![0-9])(?:[0-9][ -]?){12,15}[0-9](?![0-9])",
  ipv4: "(?<![0-9.])(?:[0-9]{1,3}[.]){3}[0-9]{1,3}(?![0-9.])",
};

export interface Redactor {
  /** Redact every string inside a JSON value. Object keys are left alone. */
  readonly value: (v: unknown) => unknown;
  readonly text: (s: string) => string;
  /** Matches replaced so far, by rule name. */
  readonly counts: Record<string, number>;
}

/** Compile a user pattern, or explain why it is unusable. */
export function checkPattern(regex: string): string | undefined {
  if (regex.length > 500) return "longer than 500 characters";
  try {
    const re = new RegExp(regex, "g");
    if (re.test("")) return "matches the empty string";
  } catch (e) {
    return `not a valid regular expression: ${(e as Error).message}`;
  }
  return undefined;
}

export function redactor(
  policy: Pick<CapturePolicyLike, "builtin_redactions" | "patterns">,
): Redactor {
  const rules: { name: string; re: RegExp }[] = [];
  for (const b of policy.builtin_redactions)
    rules.push({ name: b, re: new RegExp(BUILTIN_REDACTIONS[b], "g") });
  for (const p of policy.patterns) {
    if (checkPattern(p.regex) === undefined)
      rules.push({ name: p.name, re: new RegExp(p.regex, "g") });
  }
  const counts: Record<string, number> = {};
  const text = (s: string): string => {
    let out = s;
    for (const r of rules) {
      out = out.replace(r.re, () => {
        counts[r.name] = (counts[r.name] ?? 0) + 1;
        return `[REDACTED:${r.name}]`;
      });
    }
    return out;
  };
  const value = (v: unknown, depth = 0): unknown => {
    if (typeof v === "string") return text(v);
    if (depth > 64 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => value(x, depth + 1));
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = value(x, depth + 1);
    return o;
  };
  return { value: (v) => value(v), text, counts };
}

/** MLflow span attributes whose values are bodies (inputs, outputs, retrieved text). */
export const BODY_ATTRIBUTES = new Set(["mlflow.spanInputs", "mlflow.spanOutputs"]);
/** Trace metadata keys that hold bodies or previews of them. */
export const BODY_METADATA = new Set(["mlflow.traceInputs", "mlflow.traceOutputs"]);

/** A span as MLflow stores it in `traces.json`: attribute values are JSON-encoded strings. */
export interface RawSpan {
  trace_id?: string;
  span_id: string;
  parent_span_id?: string | null;
  name: string;
  start_time_unix_nano: number | string;
  end_time_unix_nano?: number | string | null;
  status?: { code?: string; message?: string };
  attributes?: Record<string, string>;
  events?: {
    name: string;
    time_unix_nano?: number | string;
    attributes?: Record<string, unknown>;
  }[];
  links?: unknown[];
}

export interface CaptureResult {
  readonly spans: RawSpan[];
  readonly redactions: Record<string, number>;
  /** Bodies removed by `metadata_only`. */
  readonly dropped: number;
}

function parseAttr(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Apply a capture policy to MLflow-format spans. `off` returns no spans (the caller does not write
 * the trace); `metadata_only` keeps names, types, timings, status, token usage and project
 * configuration attributes, and replaces bodies with their size.
 */
export function applyCapture(spans: readonly RawSpan[], policy: CapturePolicyLike): CaptureResult {
  if (policy.mode === "off") return { spans: [], redactions: {}, dropped: 0 };
  if (policy.mode === "full") return { spans: [...spans], redactions: {}, dropped: 0 };
  const r = redactor(policy);
  let dropped = 0;
  const out = spans.map((s) => {
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.attributes ?? {})) {
      if (BODY_ATTRIBUTES.has(k)) {
        if (policy.mode === "metadata_only") {
          dropped++;
          attributes[k] = JSON.stringify({ omitted: "metadata_only", bytes: v.length });
          continue;
        }
        if (policy.mode === "redacted") {
          attributes[k] = JSON.stringify(r.value(parseAttr(v)));
          continue;
        }
      } else if (policy.mode !== "full" && typeof v === "string" && !k.startsWith("mlflow.")) {
        // Project attributes are configuration, but may still carry an email or key.
        attributes[k] = JSON.stringify(r.value(parseAttr(v)));
        continue;
      }
      attributes[k] = v;
    }
    const events = (s.events ?? []).map((e) => {
      if (policy.mode === "full") return e;
      const a: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(e.attributes ?? {})) {
        if (policy.mode === "metadata_only" && k !== "exception.type") {
          dropped++;
          continue;
        }
        a[k] = r.value(v);
      }
      return { ...e, attributes: a };
    });
    const status =
      s.status && policy.mode !== "full" && s.status.message
        ? {
            ...s.status,
            message: policy.mode === "metadata_only" ? "" : r.text(s.status.message),
          }
        : s.status;
    return { ...s, attributes, events, ...(status ? { status } : {}) };
  });
  return { spans: out, redactions: { ...r.counts }, dropped };
}

/** Apply the policy to trace metadata and the request/response previews. */
export function captureMetadata(
  metadata: Readonly<Record<string, string>>,
  policy: CapturePolicyLike,
): Record<string, string> {
  if (policy.mode === "full") return { ...metadata };
  const r = redactor(policy);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (BODY_METADATA.has(k)) {
      if (policy.mode === "redacted") out[k] = r.text(v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function capturePreview(
  preview: string | undefined,
  policy: CapturePolicyLike,
): string | undefined {
  if (preview === undefined || policy.mode === "full") return preview;
  if (policy.mode === "redacted") return redactor(policy).text(preview);
  return undefined;
}
