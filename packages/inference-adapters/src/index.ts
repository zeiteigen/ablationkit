/**
 * Inference task adapters (spec §4.1 "Inference adapters", §5.6.1 "Input/output adapters"; ADR
 * 0020). Pure: no I/O. The coordinator picks an adapter from a logged model's `MLmodel` (its
 * signature plus an optional `metadata.ablationkit` block), validates every payload against it
 * before a worker starts, and sends the adapter to the Python bridge so both sides read inputs the
 * same way. The web UI builds its input forms from the same adapter.
 *
 * The tested matrix is narrow on purpose:
 *   - tabular: named scalar columns (classification or regression output);
 *   - text: one string column (a text-oriented pyfunc model);
 *   - image: a project-declared image spec (`metadata.ablationkit.image`) over pixel columns or a
 *     tensor input; the bridge decodes, resizes and scales the uploaded image.
 * Anything else is `unsupported` with a reason the researcher can act on.
 */

export type ColumnType =
  | "double"
  | "float"
  | "long"
  | "integer"
  | "boolean"
  | "string"
  | "datetime"
  | "binary";

export interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnType;
  readonly required: boolean;
}

export interface ImageSpec {
  readonly height: number;
  readonly width: number;
  readonly mode: "L" | "RGB";
  /** Pixel values are scaled from [0, 1] to this range. */
  readonly value_range: readonly [number, number];
  /** Invert brightness first (dark ink on a light background → high values). */
  readonly invert: boolean;
  /** `columns`: flattened row-major into the signature's columns. `tensor`: an (n, H, W[, C]) array. */
  readonly layout: "columns" | "tensor";
  readonly dtype?: string;
}

export interface ParamSpec {
  readonly name: string;
  readonly type: string;
  readonly default?: unknown;
}

export type TaskKind = "tabular" | "text" | "image";
export type OutputKind = "classification" | "regression" | "unknown";

export interface Adapter {
  readonly task: TaskKind;
  readonly output: OutputKind;
  /** Signature columns, in order (empty for a tensor input). */
  readonly columns: readonly ColumnSpec[];
  readonly image?: ImageSpec;
  /** Display names for class labels, from `metadata.ablationkit.labels`. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly params: readonly ParamSpec[];
  /** Where the adapter came from: the signature alone, or the project's declared metadata. */
  readonly source: "signature" | "metadata";
}

export type UnsupportedCode =
  | "no_pyfunc"
  | "no_signature"
  | "unnamed_columns"
  | "unsupported_column_type"
  | "tensor_needs_adapter"
  | "bad_adapter_metadata";

export type AdapterChoice =
  | { readonly supported: true; readonly adapter: Adapter }
  | { readonly supported: false; readonly code: UnsupportedCode; readonly message: string };

/** The parts of a parsed `MLmodel` an adapter needs. */
export interface MlmodelLike {
  readonly flavors: readonly { readonly name: string }[];
  readonly signature?: { inputs?: unknown; outputs?: unknown; params?: unknown };
  readonly metadata?: unknown;
}

const COLUMN_TYPES = new Set<string>([
  "double",
  "float",
  "long",
  "integer",
  "boolean",
  "string",
  "datetime",
  "binary",
]);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function no(code: UnsupportedCode, message: string): AdapterChoice {
  return { supported: false, code, message };
}

function outputKind(outputs: unknown, task: string | undefined): OutputKind {
  if (task?.endsWith("classification")) return "classification";
  if (task?.endsWith("regression")) return "regression";
  if (!Array.isArray(outputs) || outputs.length !== 1 || !isObj(outputs[0])) return "unknown";
  const t = outputs[0]["type"];
  if (t === "tensor") {
    const dt = (outputs[0]["tensor-spec"] as Json | undefined)?.["dtype"];
    if (typeof dt === "string")
      return /^(int|uint|bool|str|object)/.test(dt) ? "classification" : "regression";
    return "unknown";
  }
  if (t === "long" || t === "integer" || t === "string" || t === "boolean") return "classification";
  if (t === "double" || t === "float") return "regression";
  return "unknown";
}

function imageSpec(raw: unknown, tensor: boolean): ImageSpec | string {
  if (!isObj(raw)) return "metadata.ablationkit.image must be an object";
  const h = raw["height"];
  const w = raw["width"];
  if (!Number.isInteger(h) || !Number.isInteger(w) || (h as number) < 1 || (w as number) < 1)
    return "metadata.ablationkit.image needs integer height and width";
  if ((h as number) > 2048 || (w as number) > 2048)
    return "image height and width are at most 2048";
  const mode = raw["mode"] ?? "L";
  if (mode !== "L" && mode !== "RGB") return "metadata.ablationkit.image.mode must be L or RGB";
  const range = raw["value_range"] ?? [0, 1];
  if (
    !Array.isArray(range) ||
    range.length !== 2 ||
    !range.every((x) => typeof x === "number" && Number.isFinite(x))
  )
    return "metadata.ablationkit.image.value_range must be [low, high]";
  const layout = raw["layout"] ?? (tensor ? "tensor" : "columns");
  if (layout !== "columns" && layout !== "tensor")
    return "metadata.ablationkit.image.layout must be columns or tensor";
  return {
    height: h as number,
    width: w as number,
    mode,
    value_range: [range[0] as number, range[1] as number],
    invert: raw["invert"] === true,
    layout,
    ...(typeof raw["dtype"] === "string" ? { dtype: raw["dtype"] } : {}),
  };
}

/** Choose the task adapter for a model, or say exactly why there is none. */
export function selectAdapter(m: MlmodelLike): AdapterChoice {
  if (!m.flavors.some((f) => f.name === "python_function"))
    return no(
      "no_pyfunc",
      `the model has no python_function flavor (flavors: ${m.flavors.map((f) => f.name).join(", ") || "none"}); AblationKit loads models through mlflow.pyfunc. Save it with a pyfunc-compatible flavor or a custom PythonModel.`,
    );
  const inputs = m.signature?.inputs;
  if (!Array.isArray(inputs) || inputs.length === 0)
    return no(
      "no_signature",
      "the model has no input signature, so inputs cannot be validated. Save it with `signature=infer_signature(X, y)`.",
    );
  const meta =
    isObj(m.metadata) && isObj(m.metadata["ablationkit"]) ? m.metadata["ablationkit"] : {};
  const task = typeof meta["task"] === "string" ? meta["task"] : undefined;
  let labels: Record<string, string> | undefined;
  if (meta["labels"] !== undefined) {
    if (
      !isObj(meta["labels"]) ||
      !Object.values(meta["labels"]).every((v) => typeof v === "string")
    )
      return no("bad_adapter_metadata", "metadata.ablationkit.labels must map labels to strings");
    labels = meta["labels"] as Record<string, string>;
  }
  const params: ParamSpec[] = [];
  if (Array.isArray(m.signature?.params))
    for (const p of m.signature.params as unknown[])
      if (isObj(p) && typeof p["name"] === "string")
        params.push({
          name: p["name"],
          type: typeof p["type"] === "string" ? p["type"] : "string",
          ...(p["default"] !== undefined ? { default: p["default"] } : {}),
        });
  const output = outputKind(m.signature?.outputs, task);
  const isTensor = inputs.some((c) => isObj(c) && c["type"] === "tensor");
  const base = { output, params, ...(labels ? { labels } : {}) };

  if (isTensor) {
    if (meta["image"] === undefined)
      return no(
        "tensor_needs_adapter",
        "the model takes a tensor input; AblationKit can only build tensor inputs for images, declared with `metadata={'ablationkit': {'task': 'image_classification', 'image': {'height': H, 'width': W}}}` when saving the model.",
      );
    const spec = imageSpec(meta["image"], true);
    if (typeof spec === "string") return no("bad_adapter_metadata", spec);
    const ts = (inputs[0] as Json)["tensor-spec"] as Json | undefined;
    return {
      supported: true,
      adapter: {
        task: "image",
        columns: [],
        image: {
          ...spec,
          layout: "tensor",
          dtype: spec.dtype ?? String(ts?.["dtype"] ?? "float32"),
        },
        source: "metadata",
        ...base,
      },
    };
  }

  const columns: ColumnSpec[] = [];
  for (const c of inputs) {
    if (!isObj(c) || typeof c["name"] !== "string" || !c["name"])
      return no(
        "unnamed_columns",
        "the signature has unnamed columns; AblationKit needs named columns to build and check inputs",
      );
    const t = c["type"];
    if (typeof t !== "string" || !COLUMN_TYPES.has(t))
      return no(
        "unsupported_column_type",
        `column ${c["name"]} has type ${JSON.stringify(t)}; supported column types are ${[...COLUMN_TYPES].join(", ")}`,
      );
    columns.push({ name: c["name"], type: t as ColumnType, required: c["required"] !== false });
  }
  if (meta["image"] !== undefined || task?.startsWith("image")) {
    const spec = imageSpec(meta["image"], false);
    if (typeof spec === "string") return no("bad_adapter_metadata", spec);
    const per = spec.mode === "RGB" ? 3 : 1;
    if (spec.height * spec.width * per !== columns.length)
      return no(
        "bad_adapter_metadata",
        `the image spec gives ${spec.height}×${spec.width}×${per} values but the signature has ${columns.length} columns`,
      );
    if (
      !columns.every(
        (c) =>
          c.type === "double" || c.type === "float" || c.type === "long" || c.type === "integer",
      )
    )
      return no("bad_adapter_metadata", "image pixel columns must be numeric");
    return {
      supported: true,
      adapter: { task: "image", columns, image: spec, source: "metadata", ...base },
    };
  }
  const textual = columns.length === 1 && columns[0]?.type === "string";
  return {
    supported: true,
    adapter: {
      task: textual || task?.startsWith("text") ? "text" : "tabular",
      columns,
      source: task ? "metadata" : "signature",
      ...base,
    },
  };
}

// ------------------------------------------------------------------------------------ payloads

export interface ImageInput {
  readonly data_base64: string;
  readonly media_type?: string;
  readonly name?: string;
}

export interface InferencePayload {
  readonly records?: readonly Record<string, unknown>[];
  readonly images?: readonly ImageInput[];
}

export interface InputIssue {
  readonly row?: number;
  readonly field?: string;
  readonly message: string;
}

const MAX_ISSUES = 50;
export const MAX_IMAGE_BASE64 = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

function typeIssue(t: ColumnType, v: unknown): string | undefined {
  switch (t) {
    case "double":
    case "float":
      return typeof v === "number" && Number.isFinite(v) ? undefined : "must be a finite number";
    case "long":
    case "integer":
      return Number.isSafeInteger(v) ? undefined : "must be an integer";
    case "boolean":
      return typeof v === "boolean" ? undefined : "must be true or false";
    case "string":
      return typeof v === "string" ? undefined : "must be a string";
    case "datetime":
      return typeof v === "string" && ISO_RE.test(v) ? undefined : "must be an ISO 8601 date-time";
    case "binary":
      return typeof v === "string" && B64_RE.test(v) ? undefined : "must be base64";
  }
}

/** Check a payload against the adapter. Returns the row count and up to 50 issues. */
export function validatePayload(
  a: Adapter,
  p: unknown,
  opts: { maxRows: number },
): { rows: number; issues: InputIssue[] } {
  const issues: InputIssue[] = [];
  const add = (i: InputIssue) => {
    if (issues.length < MAX_ISSUES) issues.push(i);
  };
  if (!isObj(p)) return { rows: 0, issues: [{ message: "inputs must be an object" }] };
  const keys = Object.keys(p).filter((k) => p[k] !== undefined);
  if (keys.length !== 1 || !["records", "images"].includes(keys[0] as string))
    return {
      rows: 0,
      issues: [{ message: "inputs must have exactly one of `records` or `images`" }],
    };
  if (p["images"] !== undefined) {
    if (a.task !== "image")
      return { rows: 0, issues: [{ message: `this is a ${a.task} model; send records` }] };
    const imgs = p["images"];
    if (!Array.isArray(imgs) || imgs.length === 0)
      return { rows: 0, issues: [{ message: "images must be a non-empty list" }] };
    if (imgs.length > opts.maxRows)
      return { rows: imgs.length, issues: [{ message: `at most ${opts.maxRows} images` }] };
    imgs.forEach((im, row) => {
      if (!isObj(im) || typeof im["data_base64"] !== "string" || !im["data_base64"]) {
        add({ row, field: "data_base64", message: "each image needs data_base64" });
        return;
      }
      const d = im["data_base64"];
      if (d.length > MAX_IMAGE_BASE64) add({ row, message: "an image is at most 8 MiB" });
      else if (!B64_RE.test(d)) add({ row, field: "data_base64", message: "is not base64" });
      if (im["media_type"] !== undefined && !IMAGE_TYPES.has(String(im["media_type"])))
        add({ row, field: "media_type", message: `must be one of ${[...IMAGE_TYPES].join(", ")}` });
    });
    return { rows: imgs.length, issues };
  }
  const recs = p["records"];
  if (!Array.isArray(recs) || recs.length === 0)
    return { rows: 0, issues: [{ message: "records must be a non-empty list of objects" }] };
  if (recs.length > opts.maxRows)
    return { rows: recs.length, issues: [{ message: `at most ${opts.maxRows} records` }] };
  if (a.image?.layout === "tensor")
    return {
      rows: recs.length,
      issues: [{ message: "this image model takes images, not records" }],
    };
  const known = new Map(a.columns.map((c) => [c.name, c]));
  recs.forEach((r, row) => {
    if (!isObj(r)) {
      add({ row, message: "each record must be an object" });
      return;
    }
    for (const k of Object.keys(r))
      if (!known.has(k)) add({ row, field: k, message: "is not an input of this model" });
    for (const c of a.columns) {
      const v = r[c.name];
      if (v === undefined || v === null) {
        if (c.required) add({ row, field: c.name, message: `is required (${c.type})` });
        continue;
      }
      const why = typeIssue(c.type, v);
      if (why) add({ row, field: c.name, message: `${why} (${c.type})` });
    }
  });
  return { rows: recs.length, issues };
}

/** Check inference params against the signature's params. */
export function validateParams(a: Adapter, params: unknown): InputIssue[] {
  if (params === undefined) return [];
  if (!isObj(params)) return [{ field: "params", message: "params must be an object" }];
  const known = new Map(a.params.map((p) => [p.name, p]));
  const out: InputIssue[] = [];
  for (const [k, v] of Object.entries(params)) {
    const spec = known.get(k);
    if (!spec) {
      out.push({ field: k, message: "is not a parameter in the model's signature" });
      continue;
    }
    const why = COLUMN_TYPES.has(spec.type) ? typeIssue(spec.type as ColumnType, v) : undefined;
    if (why) out.push({ field: k, message: `${why} (${spec.type})` });
  }
  return out;
}

/** Why two models cannot be compared on the same inputs (empty: compatible). */
export function incompatibilities(a: Adapter, b: Adapter): string[] {
  const out: string[] = [];
  if (a.task !== b.task) out.push(`task ${a.task} vs ${b.task}`);
  if (a.output !== b.output && a.output !== "unknown" && b.output !== "unknown")
    out.push(`output ${a.output} vs ${b.output}`);
  const bc = new Map(b.columns.map((c) => [c.name, c]));
  for (const c of a.columns) {
    const o = bc.get(c.name);
    if (!o) {
      if (c.required) out.push(`column ${c.name} is only in the first model`);
    } else if (o.type !== c.type) out.push(`column ${c.name} is ${c.type} vs ${o.type}`);
  }
  const ac = new Set(a.columns.map((c) => c.name));
  for (const c of b.columns)
    if (!ac.has(c.name) && c.required) out.push(`column ${c.name} is only in the second model`);
  if (a.image || b.image) {
    const ai = a.image;
    const bi = b.image;
    if (!ai || !bi) out.push("only one model declares an image adapter");
    else if (
      ai.height !== bi.height ||
      ai.width !== bi.width ||
      ai.mode !== bi.mode ||
      ai.layout !== bi.layout ||
      ai.invert !== bi.invert ||
      ai.value_range[0] !== bi.value_range[0] ||
      ai.value_range[1] !== bi.value_range[1]
    )
      out.push("the image preprocessing differs (size, mode, scaling or layout)");
  }
  return out;
}

/** Deterministic JSON (sorted keys) for hashing an input sample. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** An empty record for a form, with numeric zeros, empty strings and false. */
export function blankRecord(a: Adapter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of a.columns)
    out[c.name] =
      c.type === "string" || c.type === "datetime" || c.type === "binary"
        ? ""
        : c.type === "boolean"
          ? false
          : 0;
  return out;
}

/**
 * Two-sided exact McNemar test on the discordant pairs of a paired classifier comparison:
 * a binomial test of `b` successes in `b + c` trials at p = 0.5.
 */
export function exactMcnemar(b: number, c: number): number | undefined {
  const n = b + c;
  if (n === 0 || n > 10_000) return undefined;
  const k = Math.min(b, c);
  // log-space binomial coefficients to stay finite for large n
  let logC = 0;
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}
