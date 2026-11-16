import type { PredictResult } from "@ablationkit/extension-sdk";
import { Button, mountReact, Notice, useHost } from "@ablationkit/extension-sdk/react";
import { useEffect, useState } from "react";

const MODEL = "__MODEL__";

interface Described {
  adapter?: { inputs?: { name: string }[] };
}

function Demo() {
  const host = useHost();
  const [fields, setFields] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<PredictResult>();
  const [saved, setSaved] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    host
      .call<Described>("inference.describe", { model: MODEL })
      .then((d) => setFields((d.adapter?.inputs ?? []).map((i) => i.name)))
      .catch((e: Error) => setError(e.message));
  }, [host]);
  const predict = async () => {
    setError(undefined);
    const record = Object.fromEntries(fields.map((f) => [f, Number(values[f] ?? 0)]));
    try {
      setResult(
        await host.call<PredictResult>("inference.predict", {
          model: MODEL,
          inputs: { records: [record] },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const out = result?.models[0];
  return (
    <div data-testid="inference-demo">
      {fields.map((f) => (
        <label key={f} style={{ marginRight: 8 }}>
          {f}{" "}
          <input
            aria-label={f}
            value={values[f] ?? ""}
            onChange={(e) => setValues({ ...values, [f]: e.target.value })}
          />
        </label>
      ))}
      <Button onClick={predict}>Predict</Button>
      {out ? (
        <p>
          {out.status === "ok"
            ? `Prediction: ${JSON.stringify(out.outputs?.[0])}`
            : out.error?.message}{" "}
          <Button
            onClick={async () => {
              const r = await host.saveResult(result.result_id, {
                title: `${MODEL} demo prediction`,
              });
              setSaved(r ? r.evidence_id : "not saved");
            }}
          >
            Save as evidence
          </Button>
        </p>
      ) : null}
      {saved ? <p>Saved: {saved}</p> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </div>
  );
}

void mountReact(Demo);
