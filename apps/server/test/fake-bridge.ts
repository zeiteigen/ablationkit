/**
 * Stand-in for packages/tracking-mlflow/env/bridge/ablationkit_bridge.py in fast tests: same argv and files, talks to
 * the fake MLflow over REST. Its first argument is a JSON config file the test rewrites between
 * launches (the bridge gets a minimal environment, so no env vars): `metrics` maps a model ID to
 * accuracy (so thresholds pass or fail), `sleep_ms` holds it running (restart tests), `fail` makes
 * the operation fail.
 *
 * Inference: `predictions` maps a model ID to the outputs it cycles through (default 0); `serve`
 * answers JSON lines on stdin, `load_fail` makes it fail to load, and a record whose `text` is
 * "crash" kills the session worker (crash cleanup tests). `predict_fail` returns a schema error.
 *
 * The real bridge is exercised by apps/server/test/lifecycle-e2e.test.ts against real MLflow.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const [configFile, reqFile, resFile] = process.argv.slice(2) as [string, string, string];
const config = JSON.parse(readFileSync(configFile, "utf8")) as {
  metrics?: Record<string, number>;
  sleep_ms?: number;
  fail?: boolean;
  predictions?: Record<string, unknown[]>;
  load_fail?: boolean;
  predict_fail?: boolean;
  genai_fail?: boolean;
};
interface Threshold {
  metric: string;
  greater_is_better: boolean;
  threshold?: string;
  min_absolute_change?: string;
}
interface Request {
  op: string;
  examples?: boolean;
  adapter?: { output: string };
  inputs?: { records?: Record<string, unknown>[]; images?: unknown[] };
  data: {
    path: string;
    offset?: number;
    limit?: number;
    targets?: string;
    name?: string;
    source?: string;
  };
  return_inputs?: boolean;
  run_id: string;
  baseline_run_id?: string;
  model_uri: string;
  baseline_model_uri?: string;
  thresholds?: Threshold[];
}
const req = JSON.parse(readFileSync(reqFile, "utf8")) as Request;
const base = `${process.env["MLFLOW_TRACKING_URI"]}/api/2.0/mlflow`;
const accuracy = config.metrics ?? {};

async function post(ep: string, body: unknown): Promise<void> {
  const r = await fetch(`${base}/${ep}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  if (!r.ok) throw new Error(`${ep}: ${r.status} ${await r.text()}`);
}

async function evaluate(
  runId: string | undefined,
  modelUri: string,
): Promise<Record<string, number>> {
  const id = modelUri.replace("models:/", "");
  const metrics = { accuracy_score: accuracy[id] ?? 0.9, example_count: 150 };
  const ts = Date.now();
  await post("runs/log-batch", {
    run_id: runId,
    metrics: Object.entries(metrics).map(([key, value]) => ({
      key,
      value,
      timestamp: ts,
      step: 0,
    })),
  });
  await post("runs/log-inputs", {
    run_id: runId,
    datasets: [
      {
        tags: [{ key: "mlflow.data.context", value: "evaluation" }],
        dataset: {
          name: req.data.name,
          digest: "evaldigest",
          source_type: "local",
          source: JSON.stringify({ uri: req.data.source }),
        },
      },
    ],
  });
  const run = (await (await fetch(`${base}/runs/get?run_id=${runId}`)).json()) as {
    run: { info: { artifact_uri: string } };
  };
  const uri = String(run.run.info.artifact_uri).replace("mlflow-artifacts:/", "");
  await fetch(
    `${process.env["MLFLOW_TRACKING_URI"]}/api/2.0/mlflow-artifacts/artifacts/${uri}/confusion_matrix.png`,
    {
      method: "PUT",
      body: new Uint8Array([137, 80, 78, 71]),
    },
  );
  await post("runs/update", { run_id: runId, status: "FINISHED", end_time: Date.now() });
  return metrics;
}

function predictOnce(r: {
  inputs?: Request["inputs"];
  data?: Request["data"] | undefined;
  return_inputs?: boolean;
}): Record<string, unknown> {
  if (config.predict_fail)
    return {
      ok: false,
      kind: "schema",
      error: "Failed to enforce schema of data with schema ['x1': double (required)]",
    };
  const id = req.model_uri.replace("models:/", "");
  const cycle = config.predictions?.[id] ?? [0];
  let records: Record<string, unknown>[] = r.inputs?.records ?? [];
  let targets: unknown[] | undefined;
  let n = records.length || (r.inputs?.images?.length ?? 0);
  if (r.data) {
    const [head, ...lines] = readFileSync(r.data.path, "utf8").trim().split("\n");
    const cols = (head ?? "").split(",");
    const off = r.data.offset ?? 0;
    const rows = lines.slice(off, off + (r.data.limit ?? 100)).map((l) => {
      const v = l.split(",").map(Number);
      return Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    });
    const t = r.data.targets;
    if (t) targets = rows.map((x) => x[t]);
    records = rows.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== t)));
    n = rows.length;
  }
  if (records.some((x) => x["text"] === "crash")) process.kill(process.pid, "SIGKILL");
  const outputs = Array.from({ length: n }, (_, i) => cycle[i % cycle.length]);
  return {
    ok: true,
    outputs,
    rows: n,
    ...(targets ? { targets } : {}),
    ...(r.return_inputs ? { inputs: records } : {}),
    ...(req.adapter?.output === "classification"
      ? { probabilities: outputs.map((o) => [{ label: o, p: 0.9 }]), postprocess_ms: 0.1 }
      : {}),
    predict_ms: 1.5,
  };
}

async function serve(): Promise<void> {
  const emit = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  if (config.load_fail) {
    emit({ event: "load_failed", error: "OSError: cannot load model" });
    writeFileSync(resFile, JSON.stringify({ ok: false, kind: "load", error: "cannot load" }));
    return;
  }
  emit({
    event: "ready",
    load_ms: 12.5,
    import_ms: 3,
    pid: process.pid,
    rss_bytes: 1_000_000,
    mlflow_version: "fake",
    python_version: "3.12.0",
  });
  console.error("fake session ready");
  let served = 0;
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += Buffer.from(chunk).toString("utf8");
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (!line.trim()) continue;
      const m = JSON.parse(line) as Record<string, unknown>;
      if (m["op"] === "health")
        emit({ id: m["id"], ok: true, served, rss_bytes: 2_000_000, peak_rss_bytes: 3_000_000 });
      else {
        if (config.sleep_ms) await Bun.sleep(config.sleep_ms);
        served++;
        emit({ id: m["id"], ...predictOnce(m as Parameters<typeof predictOnce>[0]) });
      }
    }
  }
  writeFileSync(resFile, JSON.stringify({ ok: true, served }));
}

/**
 * `genai_evaluate`: deterministic outputs (`answer <example_id>`; recorded targets keep their
 * traces), one trace per generated example in the fake MLflow with the request's tags, scores that
 * alternate pass/fail by example index (judges answer yes/no), reported usage unless the model name
 * ends in `-nousage`, and the per-example artifact on each target run. `genai_fail` fails it.
 */
async function genaiEvaluate(): Promise<Record<string, unknown>> {
  // biome-ignore lint/suspicious/noExplicitAny: loose request shape in a test stub
  const g = req as any;
  if (config.genai_fail) return { ok: false, error: "RuntimeError: call budget of 1 reached" };
  const root = process.env["MLFLOW_TRACKING_URI"] as string;
  const v3 = async (ep: string, body: unknown) => {
    const r = await fetch(`${root}/api/3.0/mlflow/${ep}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    if (!r.ok) throw new Error(`${ep}: ${r.status} ${await r.text()}`);
    return r.json() as Promise<Record<string, unknown>>;
  };
  const results = [];
  let calls = 0;
  for (const t of g.targets) {
    const rows = [];
    const items: { example: Record<string, unknown>; trial: number; trace_id?: string }[] = [];
    if (t.kind === "prompt")
      for (let k = 1; k <= (g.trials ?? 1); k++)
        for (const e of g.examples) items.push({ example: e, trial: k });
    else
      for (const tr of t.traces)
        items.push({
          example: g.examples.find(
            (e: Record<string, unknown>) => e["example_id"] === tr.example_id,
          ),
          trial: 1,
          trace_id: tr.trace_id,
        });
    let i = 0;
    for (const it of items) {
      const eid = it.example["example_id"] as string;
      let traceId = it.trace_id;
      const usage =
        String(t.model ?? "").endsWith("-nousage") || t.kind === "recorded"
          ? undefined
          : { input_tokens: 10, output_tokens: 4, total_tokens: 14 };
      if (!traceId) {
        calls++;
        traceId = `tr-${crypto.randomUUID().replaceAll("-", "")}`;
        const info = (await v3("traces", {
          trace: {
            trace_info: {
              trace_id: traceId,
              trace_location: {
                type: "MLFLOW_EXPERIMENT",
                mlflow_experiment: { experiment_id: g.experiment_id },
              },
              request_time: new Date().toISOString(),
              execution_duration: "0.020s",
              state: "OK",
              trace_metadata: {
                "mlflow.sourceRun": t.run_id,
                ...(usage ? { "mlflow.trace.tokenUsage": JSON.stringify(usage) } : {}),
              },
              tags: {
                ...g.tags,
                "ablationkit.variant": t.label,
                "ablationkit.example_id": eid,
                "mlflow.traceName": "predict_fn",
                ...(t.prompt
                  ? { "ablationkit.prompt": `${t.prompt.name}/${t.prompt.version}` }
                  : {}),
              },
            },
          },
        })) as { trace: { trace_info: { tags: Record<string, string> } } };
        const loc = info.trace.trace_info.tags["mlflow.artifactLocation"]?.replace(
          "mlflow-artifacts:/",
          "",
        );
        await fetch(`${root}/api/2.0/mlflow-artifacts/artifacts/${loc}/traces.json`, {
          method: "PUT",
          body: JSON.stringify({
            spans: [
              {
                span_id: "AAAAAAAAAAE=",
                parent_span_id: null,
                name: "predict_fn",
                start_time_unix_nano: 1e9,
                end_time_unix_nano: 1.02e9,
                status: { code: "STATUS_CODE_OK" },
                attributes: {
                  "mlflow.spanType": '"CHAIN"',
                  "mlflow.spanInputs": JSON.stringify(it.example["inputs"]),
                  "mlflow.spanOutputs": JSON.stringify(`answer ${eid}`),
                },
              },
              {
                span_id: "AAAAAAAAAAI=",
                parent_span_id: "AAAAAAAAAAE=",
                name: "chat_completion",
                start_time_unix_nano: 1.001e9,
                end_time_unix_nano: 1.019e9,
                status: { code: "STATUS_CODE_OK" },
                attributes: {
                  "mlflow.spanType": '"CHAT_MODEL"',
                  ...(usage ? { "mlflow.chat.tokenUsage": JSON.stringify(usage) } : {}),
                },
              },
            ],
          }),
        });
      }
      const scores: Record<string, unknown> = {};
      for (const sc of g.scorers) {
        const pass = i % 2 === 0;
        const exp = it.example["expectations"] as Record<string, unknown> | undefined;
        if (sc.kind === "builtin" && !exp)
          scores[sc.name] = { value: null, error: "missing ground truth: no expected_response" };
        else if (sc.kind === "judge")
          scores[sc.name] = { value: pass ? "yes" : "no", rationale: "fake judge" };
        else scores[sc.name] = { value: pass };
      }
      rows.push({
        example_id: eid,
        trial: it.trial,
        trace_id: traceId,
        output: `answer ${eid}`,
        latency_ms: 20 + i,
        scores,
        ...(usage ? { usage } : {}),
        ...(it.example["category"] ? { category: it.example["category"] } : {}),
      });
      i++;
    }
    const run = (await (await fetch(`${base}/runs/get?run_id=${t.run_id}`)).json()) as {
      run: { info: { artifact_uri: string } };
    };
    const uri = String(run.run.info.artifact_uri).replace("mlflow-artifacts:/", "");
    await fetch(`${root}/api/2.0/mlflow-artifacts/artifacts/${uri}/ablationkit/llm/examples.json`, {
      method: "PUT",
      body: JSON.stringify({ schema: "ablationkit.llm_examples/v1", label: t.label, rows }),
    });
    const reported = rows.filter((r) => "usage" in r).length;
    results.push({
      label: t.label,
      run_id: t.run_id,
      metrics: Object.fromEntries(
        g.scorers.map((sc: { name: string }) => [`${sc.name}/mean`, "0.5"]),
      ),
      examples: new Set(rows.map((r) => r.example_id)).size,
      errors: 0,
      scorer_errors: rows.reduce(
        (n, r) => n + Object.values(r.scores).filter((x) => (x as { error?: string }).error).length,
        0,
      ),
      usage: {
        reported,
        missing: rows.length - reported,
        ...(reported
          ? {
              input_tokens: 10 * reported,
              output_tokens: 4 * reported,
              total_tokens: 14 * reported,
            }
          : {}),
      },
      judge_usage: {},
      latency_ms: { mean: 22, p50: 22, max: 25 },
    });
  }
  return { ok: true, results, calls, mlflow_version: "fake", python_version: "3.12.0" };
}

async function main(): Promise<void> {
  if (req.op === "serve") return serve();
  if (req.op === "genai_evaluate") {
    if (config.sleep_ms) await Bun.sleep(config.sleep_ms);
    const res = await genaiEvaluate();
    writeFileSync(`${resFile}.tmp`, JSON.stringify(res));
    renameSync(`${resFile}.tmp`, resFile);
    return;
  }
  if (config.sleep_ms) await Bun.sleep(config.sleep_ms);
  if (req.op === "predict") {
    const res = {
      ...predictOnce(req),
      load_ms: 20,
      import_ms: 5,
      mlflow_version: "fake",
      python_version: "3.12.0",
    };
    writeFileSync(`${resFile}.tmp`, JSON.stringify(res));
    renameSync(`${resFile}.tmp`, resFile);
    return;
  }
  let result: Record<string, unknown>;
  try {
    if (config.fail) throw new Error("ValueError: target column 'y' is not in the dataset");
    readFileSync(req.data.path); // the dataset must be readable from here
    const cand = await evaluate(req.run_id, req.model_uri);
    const baseM = req.baseline_model_uri
      ? await evaluate(req.baseline_run_id, req.baseline_model_uri)
      : undefined;
    let validation: Record<string, unknown> | null = null;
    if (req.thresholds?.length) {
      const outcomes = req.thresholds.map((t) => {
        const c = cand[t.metric] ?? Number.NaN;
        const b = baseM ? (baseM[t.metric] ?? Number.NaN) : undefined;
        const failures: string[] = [];
        if (
          t.threshold !== undefined &&
          !(t.greater_is_better ? c >= Number(t.threshold) : c <= Number(t.threshold))
        )
          failures.push(`Metric ${t.metric} value threshold check failed`);
        if (
          t.min_absolute_change !== undefined &&
          !(c >= (b ?? Number.NaN) + Number(t.min_absolute_change))
        )
          failures.push(`Metric ${t.metric} minimum absolute change check failed`);
        return {
          metric: t.metric,
          passed: failures.length === 0,
          failures,
          candidate: String(c),
          ...(b !== undefined ? { baseline: String(b) } : {}),
        };
      });
      const passed = outcomes.every((o) => o.passed);
      validation = { passed, outcomes, mlflow_verdict: passed ? "passed" : "failed" };
    }
    const examples = req.examples
      ? {
          rows: 2,
          listed: 1,
          paired: baseM !== undefined,
          model_type: "classifier",
          candidate_correct: 1,
          ...(baseM
            ? {
                baseline_correct: 1,
                both_correct: 0,
                only_candidate_correct: 1,
                only_baseline_correct: 1,
                both_wrong: 0,
                disagreements: 2,
                paired_test: {
                  method: "exact McNemar (two-sided binomial test on discordant pairs)",
                  assumptions: "paired",
                  discordant: 2,
                  p_value: "1.0",
                },
              }
            : {}),
        }
      : null;
    if (examples) {
      const run = (await (await fetch(`${base}/runs/get?run_id=${req.run_id}`)).json()) as {
        run: { info: { artifact_uri: string } };
      };
      const uri = String(run.run.info.artifact_uri).replace("mlflow-artifacts:/", "");
      await fetch(
        `${process.env["MLFLOW_TRACKING_URI"]}/api/2.0/mlflow-artifacts/artifacts/${uri}/ablationkit/examples.json`,
        {
          method: "PUT",
          body: JSON.stringify({
            summary: examples,
            rows: [{ row: 1, target: 1, candidate: 0, baseline: 1 }],
          }),
        },
      );
    }
    result = {
      ok: true,
      examples,
      metrics: cand,
      baseline_metrics: baseM ?? null,
      validation,
      artifacts: ["confusion_matrix"],
    };
  } catch (e) {
    result = { ok: false, error: String((e as Error).message), kind: "operation" };
  }
  writeFileSync(`${resFile}.tmp`, JSON.stringify(result));
  renameSync(`${resFile}.tmp`, resFile);
}

await main();
