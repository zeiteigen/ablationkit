import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type EventEnvelope,
  type IngestState,
  validateAttemptRecord,
  validateJobRecord,
} from "@ablationkit/protocol";
import { JobService, type JobServiceOptions } from "../src/compute/jobs.ts";
import { Harness } from "./helpers.ts";

const h = new Harness();
afterEach(async () => h.cleanup());
const PROJECT = "ingest-order";
const JOB = "j-0123456789ab";
const A = `${JOB}-a1`;
const B = `${JOB}-a2`;
const NOW = "2026-11-05T12:00:00.000Z";

async function service(prepareTrace: JobServiceOptions["prepareTrace"]) {
  const client = await h.start();
  const svc = client.c.services;
  const jobDir = join(svc.paths.stateDir, PROJECT, "jobs", JOB);
  mkdirSync(jobDir, { recursive: true });
  writeJsonAtomic(
    join(jobDir, "job.json"),
    validateJobRecord({
      schema_version: 1,
      job_id: JOB,
      project_id: PROJECT,
      command: ["true"],
      environment: "none",
      env: {},
      limits: {},
      artifact_paths: [],
      submitted_by: { kind: "human" },
      state: "running",
      attempts: [A, B],
      created_at: NOW,
      updated_at: NOW,
    }),
  );
  for (const id of [A, B]) {
    const dir = join(jobDir, "attempts", id);
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(
      join(dir, "attempt.json"),
      validateAttemptRecord({
        schema_version: 1,
        attempt_id: id,
        job_id: JOB,
        project_id: PROJECT,
        number: id === A ? 1 : 2,
        state: "running",
        created_at: NOW,
        supervisor: { mode: "direct", enforcement: "advisory" },
        collector: {},
        token_id: "0123456789abcdef",
        artifacts: [],
      }),
    );
  }
  const jobs = new JobService({
    paths: svc.paths,
    now: svc.now,
    registry: svc.registry,
    tokens: svc.tokens,
    tracking: svc.tracking,
    events: svc.events,
    audit: svc.audit,
    log: () => {},
    settings: {
      supervisor: "direct",
      spoolMaxBytes: 1024,
      maxArtifactBytes: 1024,
      deliverDeadlineSec: 1,
    },
    workerUrl: () => client.c.urls.worker,
    ...(prepareTrace ? { prepareTrace } : {}),
  });
  jobs.load();
  expect(jobs.loadProblems).toEqual([]);
  return {
    jobs,
    state: (id = A) => readJson<IngestState>(join(jobDir, "attempts", id, "ingest.json")),
  };
}

function event(seq: number, attempt = A): EventEnvelope {
  return {
    schema_version: 1,
    event_id: `e-${seq}-${attempt}`,
    project_id: PROJECT,
    ablationkit_job_id: JOB,
    attempt_id: attempt,
    producer_id: "sdk-order",
    producer_seq: seq,
    ts: NOW,
    type: "trace.logged",
    payload: { seq },
  };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("concurrent batches wait for trace preparation before reading producer high-water marks", async () => {
  const entered = gate();
  const release = gate();
  const seen: number[] = [];
  const { jobs, state } = await service(async (_pid, payload) => {
    seen.push(Number(payload["seq"]));
    if (seen.length === 1) {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  });
  const first = jobs.ingestAttempt(A, { events: [event(1)] }, { spoolThrough: 4 });
  await entered.promise;
  const second = jobs.ingestAttempt(A, { events: [event(1), event(2)] }, { spoolThrough: 9 });
  await Promise.resolve();
  expect(seen).toEqual([1]);
  release.resolve();
  expect(await first).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
  expect(await second).toEqual({ accepted: 1, duplicates: 1, rejected: 0 });
  expect(seen).toEqual([1, 2]);
  expect(state()).toMatchObject({
    producers: { "sdk-order": 2 },
    accepted: 2,
    duplicates: 1,
    spool_acked_seq: 9,
  });
});

test("a rejected queued request does not wedge retries or serialize unrelated attempts", async () => {
  const entered = gate();
  const release = gate();
  const { jobs, state } = await service(async (_pid, _payload, context) => {
    if (context.attempt_id === A) {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  });
  const first = jobs.ingestAttempt(A, { events: [event(1)] });
  await entered.promise;
  const invalid = jobs.ingestAttempt(A, { invalid: [] }).catch((error: unknown) => error);
  const retry = jobs.ingestAttempt(A, { events: [event(2)] });
  expect(await jobs.ingestAttempt(B, { events: [event(1, B)] })).toEqual({
    accepted: 1,
    duplicates: 0,
    rejected: 0,
  });
  release.resolve();
  await first;
  expect(await invalid).toMatchObject({ status: 400, code: "invalid_request" });
  expect(await retry).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
  expect(state()).toMatchObject({ producers: { "sdk-order": 2 }, accepted: 2 });
  expect(state(B)).toMatchObject({ producers: { "sdk-order": 1 }, accepted: 1 });
});
