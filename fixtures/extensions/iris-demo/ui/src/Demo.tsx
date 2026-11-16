import type { PredictResult } from "@ablationkit/extension-sdk";
import { Button, mountReact, Notice, useHost } from "@ablationkit/extension-sdk/react";
import { useState } from "react";

const MODEL = "clf-reg@champion";

function Demo() {
  const host = useHost();
  const [x1, setX1] = useState("0.1");
  const [x2, setX2] = useState("0.2");
  const [result, setResult] = useState<PredictResult>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const predict = async () => {
    setError(undefined);
    try {
      setResult(
        await host.call<PredictResult>("inference.predict", {
          model: MODEL,
          inputs: { records: [{ x1: Number(x1), x2: Number(x2) }] },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = async () => {
    if (!result) return;
    const r = await host.saveResult(result.result_id, {
      title: `Demo prediction x1=${x1} x2=${x2}`,
    });
    setSaved(r ? r.evidence_id : "not saved");
  };
  const out = result?.models[0];
  return (
    <div data-testid="iris-demo">
      <label>
        x1 <input aria-label="x1" value={x1} onChange={(e) => setX1(e.target.value)} />
      </label>{" "}
      <label>
        x2 <input aria-label="x2" value={x2} onChange={(e) => setX2(e.target.value)} />
      </label>{" "}
      <Button onClick={predict}>Predict</Button>
      {out ? (
        <p data-testid="prediction">
          {out.status === "ok"
            ? `Prediction: ${JSON.stringify(out.outputs?.[0])}`
            : out.error?.message}{" "}
          <Button onClick={save}>Save as evidence</Button>
        </p>
      ) : null}
      {saved ? <p data-testid="saved">Saved: {saved}</p> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </div>
  );
}

void mountReact(Demo);
