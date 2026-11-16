import { describe, expect, test } from "bun:test";
import {
  type Adapter,
  canonicalJson,
  exactMcnemar,
  incompatibilities,
  selectAdapter,
  validateParams,
  validatePayload,
} from "../src/index.ts";

const PYFUNC = [{ name: "python_function" }, { name: "sklearn" }];
const iris = {
  flavors: PYFUNC,
  signature: {
    inputs: [
      { type: "double", name: "sepal_length", required: true },
      { type: "double", name: "petal_width", required: true },
    ],
    outputs: [{ type: "long", required: true }],
  },
};

function adapter(m: Parameters<typeof selectAdapter>[0]): Adapter {
  const c = selectAdapter(m);
  if (!c.supported) throw new Error(c.message);
  return c.adapter;
}

describe("selectAdapter", () => {
  test("tabular classification and regression from the signature", () => {
    const a = adapter(iris);
    expect(a.task).toBe("tabular");
    expect(a.output).toBe("classification");
    expect(a.columns.map((c) => c.name)).toEqual(["sepal_length", "petal_width"]);
    const r = adapter({ ...iris, signature: { ...iris.signature, outputs: [{ type: "double" }] } });
    expect(r.output).toBe("regression");
  });

  test("a single string column is a text model", () => {
    const a = adapter({
      flavors: PYFUNC,
      signature: { inputs: [{ type: "string", name: "text" }], outputs: [{ type: "string" }] },
    });
    expect(a.task).toBe("text");
    expect(a.output).toBe("classification");
  });

  test("an image adapter over pixel columns needs a matching declared spec", () => {
    const cols = Array.from({ length: 64 }, (_, i) => ({ type: "double", name: `pixel_${i}` }));
    const a = adapter({
      flavors: PYFUNC,
      signature: { inputs: cols, outputs: [{ type: "long" }] },
      metadata: {
        ablationkit: {
          task: "image_classification",
          image: { height: 8, width: 8, invert: true, value_range: [0, 16] },
          labels: { "0": "zero" },
        },
      },
    });
    expect(a.task).toBe("image");
    expect(a.image).toMatchObject({ height: 8, width: 8, layout: "columns", invert: true });
    expect(a.labels).toEqual({ "0": "zero" });
    const bad = selectAdapter({
      flavors: PYFUNC,
      signature: { inputs: cols, outputs: [{ type: "long" }] },
      metadata: { ablationkit: { image: { height: 4, width: 4 } } },
    });
    expect(bad).toMatchObject({ supported: false, code: "bad_adapter_metadata" });
  });

  test("unsupported models say why", () => {
    expect(selectAdapter({ flavors: [{ name: "pytorch" }] })).toMatchObject({
      supported: false,
      code: "no_pyfunc",
    });
    expect(selectAdapter({ flavors: PYFUNC })).toMatchObject({ code: "no_signature" });
    expect(
      selectAdapter({
        flavors: PYFUNC,
        signature: {
          inputs: [{ type: "tensor", "tensor-spec": { dtype: "float32", shape: [-1, 3] } }],
        },
      }),
    ).toMatchObject({ code: "tensor_needs_adapter" });
    expect(
      selectAdapter({ flavors: PYFUNC, signature: { inputs: [{ type: "array", name: "x" }] } }),
    ).toMatchObject({ code: "unsupported_column_type" });
  });
});

describe("validatePayload", () => {
  const a = adapter(iris);
  test("accepts well-typed records", () => {
    expect(
      validatePayload(a, { records: [{ sepal_length: 5.1, petal_width: 0.2 }] }, { maxRows: 10 }),
    ).toEqual({ rows: 1, issues: [] });
  });
  test("reports unknown, missing and mistyped fields per row", () => {
    const r = validatePayload(
      a,
      {
        records: [
          { sepal_length: "5", extra: 1 },
          { sepal_length: 1, petal_width: 2 },
        ],
      },
      { maxRows: 10 },
    );
    expect(r.issues).toEqual([
      { row: 0, field: "extra", message: "is not an input of this model" },
      { row: 0, field: "sepal_length", message: "must be a finite number (double)" },
      { row: 0, field: "petal_width", message: "is required (double)" },
    ]);
  });
  test("bounds rows and shape", () => {
    expect(validatePayload(a, { records: [] }, { maxRows: 1 }).issues).toHaveLength(1);
    expect(validatePayload(a, { records: [{}, {}] }, { maxRows: 1 }).issues[0]?.message).toContain(
      "at most 1",
    );
    expect(
      validatePayload(a, { images: [{ data_base64: "AA==" }] }, { maxRows: 1 }).issues,
    ).toEqual([{ message: "this is a tabular model; send records" }]);
  });
  test("params are checked against the signature", () => {
    expect(validateParams(a, { k: 1 })[0]?.message).toContain("not a parameter");
  });
});

test("incompatibilities name the differing columns", () => {
  const a = adapter(iris);
  const b = adapter({
    ...iris,
    signature: { ...iris.signature, inputs: [{ type: "long", name: "sepal_length" }] },
  });
  expect(incompatibilities(a, a)).toEqual([]);
  expect(incompatibilities(a, b)).toEqual([
    "column sepal_length is double vs long",
    "column petal_width is only in the first model",
  ]);
});

test("canonical JSON sorts keys", () => {
  expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: "x" })).toBe('{"a":"x","b":[1,{"c":2,"d":1}]}');
});

test("exact McNemar matches the binomial reference values", () => {
  // scipy.stats.binomtest(1, 10, 0.5).pvalue == 0.021484375
  expect(exactMcnemar(1, 9)).toBeCloseTo(0.021484375, 9);
  expect(exactMcnemar(5, 5)).toBe(1);
  expect(exactMcnemar(0, 0)).toBeUndefined();
});
