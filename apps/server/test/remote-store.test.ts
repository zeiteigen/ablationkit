/**
 * The optional S3-compatible artifact store for remote workers (ADR 0023 decision 24).
 *
 * The worker's credentials carry presigned PUT URLs (one per slot). A large artifact goes to the
 * store without the coordinator, so it leaves the worker while the workstation is off; the worker
 * keeps only a receipt. On reconnection the receipt names the slot, and the coordinator pulls the
 * object, verifies its SHA-256, stores it through MLflow and deletes it. A tampered object is
 * refused and deleted. Small artifacts still use the coordinator's resumable uploads.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";
import { FakeS3, fakeHost, remoteDir, stopRemotes } from "./remote-host.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
const stores: FakeS3[] = [];

afterEach(async () => {
  stopRemotes();
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
  for (const s of stores.splice(0)) await s.stop();
});

type Json = Record<string, unknown>;
interface AttemptView {
  attempt_id: string;
  state: string;
  artifacts: { path: string; size: number; sha256: string }[];
  tracking: { mlflow_run_id?: string };
  remote?: { sync: string; store_slots?: number; store_cleaned_at?: string };
}
interface JobView {
  job_id: string;
  attempts: string[];
  latest_attempt: AttemptView;
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(100);
  }
}

function settings(store: FakeS3, workerPort = 0): CoordinatorSettings {
  return {
    schema_version: 1,
    human: { host: "127.0.0.1", port: 0 },
    agent: { host: "127.0.0.1", port: 0 },
    worker: { host: "127.0.0.1", port: workerPort },
    mlflow: { enabled: false },
    jobs: { supervisor: "direct", deliver_deadline_sec: 60 },
    remote: {
      heartbeat_sec: 1,
      disconnected_after_sec: 3,
      provider_poll_sec: 1,
      max_backoff_sec: 1,
      min_free_disk_bytes: 0,
      artifact_store: {
        endpoint: store.url,
        bucket: "ak-artifacts",
        region: "us-east-1",
        prefix: "runs/",
        access_key_id_env: "AK_TEST_S3_KEY",
        secret_access_key_env: "AK_TEST_S3_SECRET",
        min_bytes: 100_000,
        slots: 3,
      },
    },
  };
}

async function coordinator(home: string, fake: FakeMlflow, store: FakeS3, workerPort = 0) {
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    jobWatchdogMs: 200,
    remoteTickMs: 200,
    settings: settings(store, workerPort),
    home,
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  return { cl, call };
}

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    ["git", "-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
}

/**
 * Waits for `go` (written once the coordinator is down), then logs two large artifacts (to the
 * store; the second is tampered with in transit) and a small one (through the coordinator).
 */
const TRAIN = `
import os, time, ablationkit_sdk as ak
print("started", flush=True)
while not os.path.exists(os.environ["GO_FILE"]):
    time.sleep(0.1)
open("weights.bin", "wb").write(bytes(range(256)) * 1000)
ak.log_artifact("weights.bin", artifact_path="ckpt")
open("optimizer.bin", "wb").write(b"o" * 150_000)
ak.log_artifact("optimizer.bin", artifact_path="ckpt")
open("notes.txt", "w").write("small")
ak.log_artifact("notes.txt")
`;

describe("S3-compatible artifact store", () => {
  test("a large artifact goes to the store while the coordinator is off; the receipt is verified, stored through MLflow and the object deleted", async () => {
    process.env["AK_TEST_S3_KEY"] = "test-key";
    process.env["AK_TEST_S3_SECRET"] = "test-secret";
    const store = new FakeS3().start();
    stores.push(store);
    store.corruptIf = (b) => b[0] === 0x6f; // optimizer.bin ("ooo…") arrives tampered with
    const fakeMl = new FakeMlflow().start();
    fakes.push(fakeMl);
    const home = h.tmp("ak-home-");
    const first = await coordinator(home, fakeMl, store);
    const workerPort = Number(new URL(first.cl.c.urls.worker).port);
    const host = fakeHost(h.tmp("ak-remote-"));
    const dir = join(h.tmp(), "proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "train.py"), TRAIN);
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    await first.call("/api/v1/projects", { body: { path: dir, project_id: "big" } });
    const t = await first.call("/api/v1/targets/box", {
      method: "PUT",
      body: {
        kind: "ssh",
        ssh: { host: "box", command: [host.ssh], supervisor: "nohup" },
        worker_url: first.cl.c.urls.worker,
      },
    });
    expect([200, 201]).toContain(t.status);
    const go = join(h.tmp(), "go");
    const s = await first.call<JobView>("/api/v1/projects/big/jobs", {
      body: {
        command: ["python3", "train.py"],
        target_id: "box",
        environment: "none",
        env: { GO_FILE: go },
      },
    });
    expect(s.status).toBe(201);
    const attemptId = s.body.latest_attempt.attempt_id;
    expect(s.body.latest_attempt.remote?.store_slots).toBe(3);
    const wd = remoteDir(host.home, attemptId);
    // The worker's credentials hold presigned URLs for its own three keys, never the store's keys.
    await until(async () => existsSync(join(wd, "credentials.json")));
    const creds = readFileSync(join(wd, "credentials.json"), "utf8");
    const slots = JSON.parse(creds).artifact_store.slots as { slot: number; url: string }[];
    expect(slots.map((x) => x.slot)).toEqual([0, 1, 2]);
    expect(slots[0]?.url).toContain(`/ak-artifacts/runs/big/${attemptId}/s00?`);
    expect(slots[0]?.url).toContain("X-Amz-Signature=");
    expect(creds).not.toContain("test-secret");
    await until(async () => {
      const r = await first.call<JobView>(`/api/v1/jobs/${s.body.job_id}`);
      return r.body.latest_attempt.state === "running";
    });

    // The workstation goes off; then the job writes its artifacts.
    await first.cl.c.stop();
    h.coordinators.splice(h.coordinators.indexOf(first.cl.c), 1);
    writeFileSync(go, "");
    await until(async () => existsSync(join(wd, "spool", "exit.json")), 30_000);
    // Both large artifacts left the worker for the store without the coordinator; their staged
    // copies are gone and only the receipts remain. The small one waits in the spool.
    const key0 = `/ak-artifacts/runs/big/${attemptId}/s00`;
    const key1 = `/ak-artifacts/runs/big/${attemptId}/s01`;
    await until(async () => store.objects.has(key0) && store.objects.has(key1), 20_000);
    const metas = await until(async () => {
      const m = readdirSync(join(wd, "spool", "uploads"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(wd, "spool", "uploads", f), "utf8")) as Json);
      return m.filter((x) => x["store_slot"] !== undefined).length === 2 ? m : undefined;
    });
    expect(metas).toHaveLength(3);
    for (const m of metas.filter((x) => x["store_slot"] !== undefined))
      expect(existsSync(join(wd, "spool", m["file"] as string))).toBe(false);
    expect(metas.find((x) => x["dest"] === "notes.txt")?.["store_slot"]).toBeUndefined();

    // The workstation comes back: receipts are pulled, verified, stored and deleted.
    const second = await coordinator(home, fakeMl, store, workerPort);
    const j = await until(async () => {
      const x = (await second.call<JobView>(`/api/v1/jobs/${s.body.job_id}`)).body;
      return x.latest_attempt.state === "succeeded" &&
        x.latest_attempt.remote?.sync === "synced" &&
        x.latest_attempt.remote?.store_cleaned_at
        ? x
        : undefined;
    }, 60_000);
    const a = j.latest_attempt;
    expect(j.attempts).toHaveLength(1);
    expect(a.artifacts.map((x) => x.path).sort()).toEqual(["ckpt/weights.bin", "notes.txt"]);
    const run = fakeMl.run(a.tracking.mlflow_run_id as string);
    const weights = run?.artifacts.get("ckpt/weights.bin");
    expect(weights?.byteLength).toBe(256_000);
    expect(weights?.[255]).toBe(255);
    expect(run?.artifacts.get("notes.txt")?.byteLength).toBe(5);
    // The tampered object was refused (checksum) and never reached MLflow; the store is empty.
    expect(run?.artifacts.has("ckpt/optimizer.bin")).toBe(false);
    expect(store.objects.size).toBe(0);
    expect(store.log.filter((l) => l.startsWith("PUT"))).toHaveLength(2);
    const sys = await second.call<{ lines: { text: string }[] }>(
      `/api/v1/jobs/${j.job_id}/attempts/${a.attempt_id}/console?after=-1&limit=1000&stream=system`,
    );
    expect(sys.body.lines.map((l) => l.text).join("\n")).toMatch(
      /artifact ckpt\/optimizer\.bin refused: HTTP 422 .*checksum_mismatch/,
    );
    // The small artifact never touched the store.
    expect(store.log.some((l) => l.includes("notes"))).toBe(false);
  }, 120_000);
});
