/**
 * Cross-language round trip (stage 2 "done" criterion): TypeScript-valid documents are parsed,
 * validated and re-serialized by the generated Pydantic models, and the result must be identical
 * and still valid in TypeScript. Invalid documents must be rejected by both sides.
 */
import { expect, test } from "bun:test";
import { compileValidator, validateEventEnvelope } from "../src/index.ts";
import { loadFixtures, REPO_ROOT } from "./fixtures.ts";

type Reply = { ok: unknown } | { error: string };

const FIXTURES = loadFixtures();

/**
 * Every fixture document through one Python process (`roundtrip --batch`): importing the generated
 * models takes about half a second, so a process per model made this file take about a minute.
 */
const replies: Map<string, { valid: Reply[]; invalid: Reply[] }> = (() => {
  const reqs = FIXTURES.flatMap(({ entry, valid, invalid }) => [
    ...valid.map((doc) => ({ model: entry.name, doc })),
    ...invalid.map((c) => ({ model: entry.name, doc: c.value })),
  ]);
  const proc = Bun.spawnSync(
    ["uv", "run", "--frozen", "python", "-m", "ablationkit_protocol.roundtrip", "--batch"],
    {
      cwd: REPO_ROOT,
      stdin: new TextEncoder().encode(`${reqs.map((r) => JSON.stringify(r)).join("\n")}\n`),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0) throw new Error(`python roundtrip failed: ${proc.stderr.toString()}`);
  const out = proc.stdout
    .toString()
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Reply);
  if (out.length !== reqs.length)
    throw new Error(`python answered ${out.length} of ${reqs.length} documents`);
  const m = new Map<string, { valid: Reply[]; invalid: Reply[] }>();
  let i = 0;
  for (const { entry, valid, invalid } of FIXTURES) {
    const v = out.slice(i, i + valid.length);
    i += valid.length;
    m.set(entry.name, { valid: v, invalid: out.slice(i, i + invalid.length) });
    i += invalid.length;
  }
  return m;
})();

for (const { entry, valid, invalid } of FIXTURES) {
  test(`${entry.name}: TypeScript → Python → TypeScript preserves every valid document`, () => {
    const validate = compileValidator(entry.schema);
    const got = replies.get(entry.name)?.valid ?? [];
    expect(got.length).toBe(valid.length);
    got.forEach((reply, i) => {
      expect(reply).toHaveProperty("ok");
      const back = (reply as { ok: unknown }).ok;
      expect(back).toEqual(valid[i]);
      expect(validate(back) as unknown).toEqual(valid[i]);
    });
  });

  test(`${entry.name}: Python rejects every document TypeScript rejects`, () => {
    const got = replies.get(entry.name)?.invalid ?? [];
    expect(got.length).toBe(invalid.length);
    got.forEach((reply, i) => {
      if (!("error" in reply))
        throw new Error(`Python accepted invalid case: ${invalid[i]?.reason}`);
    });
  });
}

test("a document built by Python code validates in TypeScript", () => {
  const code = [
    "from ablationkit_protocol import EventEnvelope",
    "e = EventEnvelope(schema_version=1, event_id='evt-py', project_id='lab', producer_id='sdk',",
    "    producer_seq=3, ts='2026-11-02T10:00:00.5Z', type='metric.logged',",
    "    payload={'name': 'loss', 'value': 0.5, 'step': 3})",
    "print(e.to_json())",
  ].join("\n");
  const proc = Bun.spawnSync(["uv", "run", "--frozen", "python", "-c", code], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.stderr.toString()).toBe("");
  const doc = validateEventEnvelope(JSON.parse(proc.stdout.toString()));
  expect(doc).not.toHaveProperty("attempt_id");
  expect(doc.payload).toEqual({ name: "loss", value: 0.5, step: 3 });
});
