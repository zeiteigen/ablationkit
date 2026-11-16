/**
 * Security suite (Stage 18b), remote compute: what a compute target can try against the
 * coordinator. A worker's machine is someone else's machine: its tokens can leak, its files can
 * change and an archive it produced can be crafted (spec §5.3, §7.11, §10; criterion 12; ADR 0023).
 *
 * The jobs are real (a fake `ssh`, the real worker); the tests then act as the hostile party with
 * the worker's own credentials.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runpodEndpointScript, runpodStartScript } from "@ablationkit/compute-targets";
import type { ComputeTarget, CoordinatorSettings } from "@ablationkit/protocol";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { Harness } from "./helpers.ts";
import { FakeRunpod, FakeS3, fakeHost, killTree, remoteDir, stopRemotes } from "./remote-host.ts";

const h = new Harness();
const fakes: FakeMlflow[] = [];
const closers: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await c.stop();
  stopRemotes();
  await h.cleanup();
  for (const f of fakes.splice(0)) await f.stop();
});

type Json = Record<string, unknown>;
interface Attempt {
  attempt_id: string;
  state: string;
  artifacts: { path: string; sha256: string }[];
  tracking: { mlflow_run_id?: string };
  remote?: { bundle_id: string; reconcile_required?: string; worker_id?: string };
}
interface JobView {
  job_id: string;
  bundle_inputs?: unknown;
  latest_attempt: Attempt;
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

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    ["git", "-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
}

function repo(files: Record<string, string>): string {
  const dir = join(h.tmp(), "proj");
  mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const SLEEP = "import time\nprint('up', flush=True)\ntime.sleep(120)\n";
const QUICK =
  "import ablationkit_sdk as ak\nak.log_params({'a': 1})\nopen('m.bin','wb').write(b'w'*64)\nak.log_artifact('m.bin')\n";

async function world(remote: Json = {}) {
  const fake = new FakeMlflow().start();
  fakes.push(fake);
  const settings: CoordinatorSettings = {
    schema_version: 1,
    human: { host: "127.0.0.1", port: 0 },
    agent: { host: "127.0.0.1", port: 0 },
    worker: { host: "127.0.0.1", port: 0 },
    mlflow: { enabled: false },
    jobs: { supervisor: "direct", deliver_deadline_sec: 60 },
    remote: {
      heartbeat_sec: 1,
      disconnected_after_sec: 3,
      provider_poll_sec: 1,
      max_backoff_sec: 1,
      min_free_disk_bytes: 0,
      ...remote,
    },
  };
  const home = h.tmp("ak-home-");
  const cl = await h.start({
    trackingUrl: fake.url,
    trackingIntervalMs: 20,
    jobWatchdogMs: 200,
    remoteTickMs: 200,
    settings,
    home,
  });
  const token = await cl.session();
  const call = <T = Json>(path: string, init: { method?: string; body?: unknown } = {}) =>
    cl.json<T>(cl.human(path, { token, ...init }));
  return { fake, cl, call, home };
}
type World = Awaited<ReturnType<typeof world>>;

async function target(w: World, id: string, workerUrl = w.cl.c.urls.worker) {
  const host = fakeHost(h.tmp("ak-remote-"));
  const r = await w.call(`/api/v1/targets/${id}`, {
    method: "PUT",
    body: {
      kind: "ssh",
      ssh: { host: id, command: [host.ssh], supervisor: "nohup" },
      worker_url: workerUrl,
    },
  });
  expect([200, 201]).toContain(r.status);
  return host;
}

async function submit(w: World, project: string, tgt: string, extra: Json = {}): Promise<JobView> {
  const r = await w.call<JobView>(`/api/v1/projects/${project}/jobs`, {
    body: { command: ["python3", "train.py"], target_id: tgt, environment: "none", ...extra },
  });
  if (r.status !== 201) throw new Error(`submit: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function job(w: World, id: string): Promise<JobView> {
  return (await w.call<JobView>(`/api/v1/jobs/${id}`)).body;
}

/** A running remote job, and the credentials an attacker holding its directory would have. */
async function runningJob(w: World, project: string, tgt: string) {
  const host = await target(w, tgt);
  const j = await submit(w, project, tgt);
  const a = j.latest_attempt;
  await until(async () => (await job(w, j.job_id)).latest_attempt.state === "running");
  const dir = remoteDir(host.home, a.attempt_id);
  const creds = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")) as {
    launch_token: string;
    upload_token: string;
  };
  const workerId = await until(
    async () => (await job(w, j.job_id)).latest_attempt.remote?.worker_id,
  );
  const base = `/api/v1/jobs/${j.job_id}/attempts/${a.attempt_id}`;
  return { host, job: j, attempt: a, dir, creds, workerId, base };
}

describe("forged workers and misused tokens", () => {
  test("a second worker ID is refused and flagged on every route that takes one, and nothing is rerun", async () => {
    const w = await world();
    await w.call("/api/v1/projects", {
      body: { path: repo({ "train.py": SLEEP }), project_id: "p" },
    });
    const r = await runningJob(w, "p", "box");
    const forged = { "x-ablationkit-worker-id": "w-00000000deadbeef" };
    const t = r.creds.upload_token;
    const codes: Record<string, unknown> = {};
    const code = async (name: string, res: Promise<Response>) => {
      const x = await w.cl.json<{ error?: { code: string } }>(res);
      codes[name] = `${x.status} ${x.body.error?.code}`;
    };
    await code(
      "events",
      w.cl.worker(`${r.base}/events:batch`, { token: t, headers: forged, body: { events: [] } }),
    );
    await code(
      "start",
      w.cl.worker(`${r.base}/uploads`, {
        token: t,
        headers: forged,
        body: { path: "x.bin", size: 1, sha256: "0".repeat(64) },
      }),
    );
    // A real upload the first worker began cannot be continued or finished by another.
    const u = await w.cl.json<{ upload_id: string }>(
      w.cl.worker(`${r.base}/uploads`, {
        token: t,
        headers: { "x-ablationkit-worker-id": r.workerId },
        body: { path: "y.bin", size: 2, sha256: sha("ab") },
      }),
    );
    await code(
      "chunk",
      w.cl.worker(`${r.base}/uploads/${u.body.upload_id}`, {
        method: "PUT",
        token: t,
        headers: { ...forged, "x-ablationkit-offset": "0" },
      }),
    );
    await code(
      "complete",
      w.cl.worker(`${r.base}/uploads/${u.body.upload_id}/complete`, {
        token: t,
        headers: forged,
        body: {},
      }),
    );
    expect(codes).toEqual({
      events: "409 duplicate_execution",
      start: "409 duplicate_execution",
      chunk: "409 duplicate_execution",
      complete: "409 duplicate_execution",
    });
    const after = await job(w, r.job.job_id);
    expect(after.latest_attempt.remote?.reconcile_required).toContain("second worker");
    expect(after.latest_attempt.state).toBe("running");
    const audit = Bun.spawnSync(["grep", "-rh", "job.remote.duplicate", join(w.home, "audit")], {
      stdout: "pipe",
    }).stdout.toString();
    expect(audit).toContain('"outcome":"denied"');
    await w.call(`/api/v1/jobs/${r.job.job_id}/cancel`, { body: {} });
  }, 90_000);

  test("a launch token only hand-shakes: no uploads, no bundle of another attempt, no bundle at all on a pushed target", async () => {
    const w = await world();
    await w.call("/api/v1/projects", {
      body: { path: repo({ "train.py": SLEEP }), project_id: "p" },
    });
    const r = await runningJob(w, "p", "box");
    const other = await runningJob(w, "p", "box2");
    const launch = r.creds.launch_token;
    const status = async (res: Promise<Response>) => {
      const x = await res;
      await x.body?.cancel();
      return x.status;
    };
    expect(
      await status(w.cl.worker(`${r.base}/events:batch`, { token: launch, body: { events: [] } })),
    ).toBe(401);
    expect(
      await status(
        w.cl.worker(`${r.base}/uploads`, {
          token: launch,
          body: { path: "a", size: 1, sha256: "0".repeat(64) },
        }),
      ),
    ).toBe(401);
    expect(
      await status(w.cl.worker(`${r.base}/artifacts?path=a`, { method: "PUT", token: launch })),
    ).toBe(401);
    // Another attempt's routes and bundle.
    expect(await status(w.cl.worker(`${other.base}/bundle`, { token: launch }))).toBe(403);
    expect(
      await status(
        w.cl.worker(`${other.base}/handshake`, {
          token: launch,
          body: {},
        }),
      ),
    ).toBe(403);
    // A pushed target never serves its bundle over HTTP, even to its own token.
    expect(await status(w.cl.worker(`${r.base}/bundle`, { token: launch }))).toBe(404);
    // A handshake naming another attempt's bundle is refused.
    const wrong = await w.cl.json<{ error: { code: string } }>(
      w.cl.worker(`${r.base}/handshake`, {
        token: launch,
        body: {
          schema_version: 1,
          worker_id: r.workerId,
          hostname: "h",
          worker_version: "0.1.0",
          bundle_id: other.attempt.remote?.bundle_id,
          phase: "running",
          last_acked_seq: -1,
          spool: {},
          drained: false,
          refresh: false,
        },
      }),
    );
    expect(wrong.status).toBe(409);
    await w.call(`/api/v1/jobs/${r.job.job_id}/cancel`, { body: {} });
    await w.call(`/api/v1/jobs/${other.job.job_id}/cancel`, { body: {} });
  }, 90_000);

  test("resumable uploads: hostile paths, sizes and IDs are refused; a wrong checksum stores nothing", async () => {
    const w = await world();
    await w.call("/api/v1/projects", {
      body: { path: repo({ "train.py": SLEEP }), project_id: "p" },
    });
    const r = await runningJob(w, "p", "box");
    const t = r.creds.upload_token;
    const headers = { "x-ablationkit-worker-id": r.workerId };
    const start = (body: Json) =>
      w.cl.json<{ upload_id?: string; error?: { code: string } }>(
        w.cl.worker(`${r.base}/uploads`, { token: t, headers, body }),
      );
    for (const path of ["../x", "/etc/passwd", "a/../../b", "s3://b/k", "a\\b", "a\0b"]) {
      const res = await start({ path, size: 1, sha256: "0".repeat(64) });
      expect([path, res.status, res.body.error?.code]).toEqual([
        path,
        400,
        "invalid_artifact_path",
      ]);
    }
    for (const body of [
      { path: "a", size: -1, sha256: "0".repeat(64) },
      { path: "a", size: 1.5, sha256: "0".repeat(64) },
      { path: "a", size: 1, sha256: "../../etc/passwd" },
      { path: "a", size: "1", sha256: "0".repeat(64) },
    ]) {
      expect((await start(body)).status).toBe(400);
    }
    expect((await start({ path: "a", size: 2 ** 52, sha256: "0".repeat(64) })).status).toBe(413);
    for (const id of ["u-..%2F..%2Fetc", "u-0000000000000000", "..%2Fuploads"]) {
      const res = await w.cl.worker(`${r.base}/uploads/${id}/complete`, {
        token: t,
        headers,
        body: {},
      });
      expect(res.status).toBe(404);
      await res.body?.cancel();
    }
    // More bytes than declared; the wrong offset; then a body that does not match its checksum.
    const u = await start({ path: "weights.bin", size: 4, sha256: sha("abcd") });
    const id = u.body.upload_id as string;
    const put = (body: string, offset: number) =>
      fetch(`${w.cl.c.urls.worker}${r.base}/uploads/${id}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${t}`,
          ...headers,
          "x-ablationkit-offset": String(offset),
        },
        body,
      });
    expect((await put("abcdef", 0)).status).toBe(413);
    expect((await put("ab", 3)).status).toBe(409);
    expect((await put("xxxx", 0)).status).toBe(200);
    const done = await w.cl.json<{ error: { code: string } }>(
      w.cl.worker(`${r.base}/uploads/${id}/complete`, { token: t, headers, body: {} }),
    );
    expect([done.status, done.body.error.code]).toEqual([422, "checksum_mismatch"]);
    const after = await job(w, r.job.job_id);
    expect(after.latest_attempt.artifacts).toEqual([]);
    await w.call(`/api/v1/jobs/${r.job.job_id}/cancel`, { body: {} });
  }, 90_000);

  test("job submission over HTTP cannot stage extra paths into a bundle (`bundle_inputs` is internal)", async () => {
    const w = await world();
    await w.call("/api/v1/projects", {
      body: { path: repo({ "train.py": SLEEP }), project_id: "p" },
    });
    const secret = h.tmp("ak-secret-");
    writeFileSync(join(secret, "id_rsa"), "PRIVATE");
    const host = await target(w, "box");
    const j = await submit(w, "p", "box", {
      bundle_inputs: [{ name: "stolen", path: secret }],
    });
    expect(j.bundle_inputs).toBeUndefined();
    const dir = remoteDir(host.home, j.latest_attempt.attempt_id);
    await until(async () => existsSync(join(dir, "bundle", "bundle.json")));
    const manifest = JSON.parse(readFileSync(join(dir, "bundle", "bundle.json"), "utf8")) as {
      files: { path: string }[];
    };
    expect(manifest.files.filter((f) => f.path.startsWith("inputs/"))).toEqual([]);
    expect(existsSync(join(dir, "bundle", "inputs"))).toBe(false);
    await w.call(`/api/v1/jobs/${j.job_id}/cancel`, { body: {} });
  }, 90_000);
});

describe("imported archives (an isolated runtime's spool)", () => {
  /** A finished job on an unreachable target, its worker directory, and a way to craft variants. */
  async function isolated() {
    const w = await world();
    await w.call("/api/v1/projects", {
      body: { path: repo({ "train.py": QUICK }), project_id: "p" },
    });
    const host = await target(w, "island", "http://127.0.0.1:9");
    const j = await submit(w, "p", "island");
    const a = j.latest_attempt;
    const wd = remoteDir(host.home, a.attempt_id);
    await until(async () => existsSync(join(wd, "spool", "exit.json")), 30_000);
    await Bun.sleep(500);
    const craft = (edit: (dir: string) => void): string => {
      const tmp = h.tmp("ak-craft-");
      cpSync(wd, join(tmp, "w"), { recursive: true, verbatimSymlinks: true });
      rmSync(join(tmp, "w", "bundle"), { recursive: true, force: true });
      edit(join(tmp, "w"));
      const out = join(h.tmp(), "a.tgz");
      expect(Bun.spawnSync(["tar", "-czf", out, "-C", tmp, "w"]).exitCode).toBe(0);
      return out;
    };
    const stage = (dir: string, meta: Json, bytes?: string) => {
      writeFileSync(
        join(dir, "spool", "uploads", `evil-${sha(JSON.stringify(meta))}.json`),
        JSON.stringify(meta),
      );
      if (bytes !== undefined) writeFileSync(join(dir, "spool", String(meta["file"])), bytes);
    };
    const imp = (archive: string) =>
      w.call<{ rejected?: number; artifacts?: number; error?: { code: string; message: string } }>(
        `/api/v1/jobs/${j.job_id}/attempts/${a.attempt_id}/remote/import`,
        { body: { archive_path: archive } },
      );
    return { w, j, a, wd, craft, stage, imp };
  }

  test("links, traversal and absolute names are refused before anything is read", async () => {
    const { craft, imp, w, j } = await isolated();
    const secret = join(h.tmp("ak-secret-"), "id_rsa");
    writeFileSync(secret, "PRIVATE KEY");
    // Hand-made archives: GNU tar stores these names as given with -P.
    const raw = (name: string, content: string, ...flags: string[]): string => {
      const tmp = h.tmp("ak-raw-");
      const f = join(tmp, "f");
      writeFileSync(f, content);
      const out = join(h.tmp(), "a.tgz");
      const t = Bun.spawnSync(["tar", "-czPf", out, ...flags, `--transform=s|^${f}$|${name}|`, f]);
      expect(t.exitCode).toBe(0);
      return out;
    };
    for (const name of ["../../evil", "/tmp/ablationkit-evil", "w/../../evil"]) {
      const res = await imp(raw(name, "x"));
      expect([name, res.status, res.body.error?.code]).toEqual([name, 400, "invalid_archive"]);
      expect(res.body.error?.message).toContain("unsafe path");
    }
    // A staged artifact that is a symlink to a coordinator file, with its checksum known.
    const linked = craft((d) => {
      const meta = {
        file: "uploads/stolen.bin",
        dest: "stolen.bin",
        sha256: sha("PRIVATE KEY"),
        size: 11,
      };
      writeFileSync(join(d, "spool", "uploads", "evil.json"), JSON.stringify(meta));
      symlinkSync(secret, join(d, "spool", "uploads", "stolen.bin"));
    });
    const res = await imp(linked);
    expect([res.status, res.body.error?.code]).toEqual([400, "invalid_archive"]);
    expect(res.body.error?.message).toContain("links and special files");
    // A journal that is a symlink is refused the same way.
    const journal = craft((d) => {
      const seg = readdirSync(join(d, "spool", "journal"))[0] as string;
      rmSync(join(d, "spool", "journal", seg));
      symlinkSync(secret, join(d, "spool", "journal", seg));
    });
    expect((await imp(journal)).status).toBe(400);
    const after = await job(w, j.job_id);
    expect(after.latest_attempt.artifacts.map((x) => x.path)).not.toContain("stolen.bin");
    expect(after.latest_attempt.state).not.toBe("succeeded");
  }, 90_000);

  test("hostile staged uploads and malformed records are rejected; the real ones still import", async () => {
    const { craft, stage, imp, w, j, a } = await isolated();
    const bytes = "attacker-bytes";
    const good = { file: "evil.bin", sha256: sha(bytes), size: bytes.length };
    const archive = craft((d) => {
      for (const dest of ["../../outside.bin", "/etc/cron.d/x", "s3://b/k", "a/../../b"])
        stage(d, { ...good, dest }, bytes);
      // Not JSON, wrong types, a file outside the spool, a checksum that does not match.
      writeFileSync(join(d, "spool", "uploads", "bad1.json"), "{not json");
      writeFileSync(
        join(d, "spool", "uploads", "bad2.json"),
        JSON.stringify({ file: 7, dest: "x", sha256: "z", size: "big" }),
      );
      stage(d, { ...good, file: "../../../etc/passwd", dest: "passwd" });
      stage(d, { file: "wrong.bin", dest: "wrong.bin", sha256: sha("other"), size: 5 }, "bytes");
      writeFileSync(join(d, "state.json"), "{not json");
    });
    // A state file that is not JSON refuses the whole archive; a clean one reports the rejects.
    const refused = await imp(archive);
    expect([refused.status, refused.body.error?.code]).toEqual([400, "invalid_archive"]);
    const tolerated = craft((d) => {
      for (const dest of ["../../outside.bin", "/etc/cron.d/x", "s3://b/k", "a/../../b"])
        stage(d, { ...good, dest }, bytes);
      writeFileSync(join(d, "spool", "uploads", "bad1.json"), "{not json");
      writeFileSync(
        join(d, "spool", "uploads", "bad2.json"),
        JSON.stringify({ file: 7, dest: "x", sha256: "z", size: "big" }),
      );
      stage(d, { ...good, file: "../../../etc/passwd", dest: "passwd" });
      stage(d, { file: "wrong.bin", dest: "wrong.bin", sha256: sha("other"), size: 5 }, "bytes");
    });
    const res = await imp(tolerated);
    expect(res.status).toBe(200);
    expect(res.body.rejected).toBeGreaterThanOrEqual(7);
    expect(res.body.artifacts).toBe(1);
    const after = await job(w, j.job_id);
    expect(after.latest_attempt.artifacts.map((x) => x.path)).toEqual(["m.bin"]);
    expect(after.latest_attempt.state).toBe("succeeded");
    const run = w.fake.run(after.latest_attempt.tracking.mlflow_run_id as string);
    expect([...(run?.artifacts.keys() ?? [])]).toEqual(["m.bin"]);
    expect(a.attempt_id).toBe(after.latest_attempt.attempt_id);
  }, 90_000);

  test("a journal event claiming another attempt is refused", async () => {
    const { craft, imp } = await isolated();
    const archive = craft((d) => {
      const dir = join(d, "spool", "journal");
      const seg = join(dir, readdirSync(dir)[0] as string);
      const lines = readFileSync(seg, "utf8").trim().split("\n");
      const ev = JSON.parse(lines[0] as string) as Json;
      writeFileSync(
        seg,
        `${lines[0]}\n${JSON.stringify({ ...ev, event_id: "e-later", attempt_id: "a-someone-else" })}\n`,
      );
    });
    const res = await imp(archive);
    // A later event claiming another attempt fails the ingest scope check.
    expect([res.status, res.body.error?.code]).toEqual([403, "forbidden_scope"]);
    // An archive whose first event names another attempt is refused up front, naming it.
    const other = craft((d) => {
      const dir = join(d, "spool", "journal");
      const seg = join(dir, readdirSync(dir)[0] as string);
      const ev = JSON.parse(readFileSync(seg, "utf8").trim().split("\n")[0] as string) as Json;
      writeFileSync(seg, `${JSON.stringify({ ...ev, attempt_id: "a-someone-else" })}\n`);
    });
    const res2 = await imp(other);
    expect([res2.status, res2.body.error?.code]).toEqual([409, "wrong_attempt"]);
    expect(String(res2.body.error?.message)).toContain("this archive is attempt a-someone-else");
  }, 90_000);
});

describe("pulled bundles and model packages", () => {
  const target_ = (dir: string): ComputeTarget =>
    ({ target_id: "pods", kind: "runpod", work_dir: dir, runpod: {} }) as unknown as ComputeTarget;

  /** Run a pod start script against a server that answers with `bytes`, until it says `until_`. */
  async function runPod(script: string, env: Record<string, string>, log: string, want: string) {
    const out = h.tmp("ak-podlog-");
    const p = Bun.spawn(["setsid", "bash", "-c", script], {
      env: { ...process.env, ...env },
      stdout: Bun.file(join(out, "out")),
      stderr: Bun.file(join(out, "err")),
    });
    try {
      await until(async () => readFileSync(join(out, "err"), "utf8").includes(want), 20_000);
      return readFileSync(join(out, "err"), "utf8");
    } catch {
      throw new Error(`${log}: ${readFileSync(join(out, "err"), "utf8")}`);
    } finally {
      killTree(p.pid, true);
    }
  }

  function serving(body: Uint8Array) {
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(body),
    });
    closers.push({ stop: async () => void srv.stop(true) });
    return `http://127.0.0.1:${srv.port}`;
  }

  function tgz(files: Record<string, string>, link?: [string, string]): Uint8Array {
    const d = h.tmp("ak-tgz-");
    for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
    if (link) symlinkSync(link[1], join(d, link[0]));
    const out = join(h.tmp(), "b.tgz");
    expect(Bun.spawnSync(["tar", "-czf", out, "-C", d, "."]).exitCode).toBe(0);
    return new Uint8Array(readFileSync(out));
  }

  test("a tampered bundle served to a pod is refused by checksum and never runs", async () => {
    const pod = h.tmp("ak-pod-");
    const genuine = tgz({ "bundle.json": "{}" });
    const tampered = tgz({ "bundle.json": "{}", "evil.py": "boom" });
    const creds = Buffer.from(JSON.stringify({ launch_token: "t" })).toString("base64");
    const script = runpodStartScript(target_(pod), {
      attemptId: "a1",
      jobId: "j1",
      workerUrl: serving(tampered),
      bundleSha256: sha(Buffer.from(genuine)),
      tgz: "",
      credentials: "",
      limits: {},
    });
    const err = await runPod(
      script,
      { AK_WORKER_CREDENTIALS: creds },
      "tampered bundle",
      "bundle staging failed",
    );
    expect(err).toContain("bundle checksum mismatch");
    expect(existsSync(join(pod, "a1", "bundle", "bundle.json"))).toBe(false);
    expect(existsSync(join(pod, "a1", "bundle", "evil.py"))).toBe(false);
  }, 40_000);

  test("a bundle holding a link is refused even when its checksum matches", async () => {
    const pod = h.tmp("ak-pod-");
    const linked = tgz({ "bundle.json": "{}" }, ["etc", "/etc"]);
    const creds = Buffer.from(JSON.stringify({ launch_token: "t" })).toString("base64");
    const script = runpodStartScript(target_(pod), {
      attemptId: "a1",
      jobId: "j1",
      workerUrl: serving(linked),
      bundleSha256: sha(Buffer.from(linked)),
      tgz: "",
      credentials: "",
      limits: {},
    });
    const err = await runPod(
      script,
      { AK_WORKER_CREDENTIALS: creds },
      "linked bundle",
      "bundle staging failed",
    );
    expect(err).toContain("unsafe path in bundle");
    expect(existsSync(join(pod, "a1", "bundle", "etc"))).toBe(false);
  }, 40_000);

  test("a tampered model package is refused by checksum and never served", async () => {
    const pod = h.tmp("ak-pod-");
    const genuine = tgz({ MLmodel: "flavors: {}" });
    const tampered = tgz({ MLmodel: "flavors: {evil: 1}" });
    const script = runpodEndpointScript(target_(pod), {
      deploymentId: "d1",
      modelUrl: serving(tampered),
      fetchToken: "t",
      modelSha256: sha(Buffer.from(genuine)),
      expiresAtSec: Date.now() / 1000 + 600,
    });
    const err = await runPod(
      script,
      { AK_MODEL_TOKEN: "t" },
      "tampered model",
      "model staging failed",
    );
    expect(err).toContain("model checksum mismatch");
    expect(existsSync(join(pod, "endpoints", "d1", "model"))).toBe(false);
  }, 40_000);

  test("Runpod: a literal key is never accepted and the key never reaches the coordinator's files, the bundle or the pod", async () => {
    const w = await world();
    const podHome = h.tmp("ak-pod-");
    const KEY = "rp-secret-value-17";
    process.env["AK_TEST_RUNPOD_SECRET"] = KEY;
    const rp = new FakeRunpod(podHome, KEY).start();
    closers.push(rp);
    await w.call("/api/v1/projects", {
      body: { path: repo({ "train.py": QUICK }), project_id: "p" },
    });
    const base = {
      kind: "runpod",
      work_dir: join(podHome, "workspace", ".ablationkit-worker"),
      worker_url: w.cl.c.urls.worker,
    };
    const literal = await w.call("/api/v1/targets/pods", {
      method: "PUT",
      body: {
        ...base,
        runpod: { api_url: rp.url, api_key: KEY, image: "python:3.12", gpu_type_ids: ["A"] },
      },
    });
    expect(literal.status).toBe(400);
    const put = await w.call("/api/v1/targets/pods", {
      method: "PUT",
      body: {
        ...base,
        runpod: {
          api_url: rp.url,
          api_key_env: "AK_TEST_RUNPOD_SECRET",
          image: "python:3.12",
          gpu_type_ids: ["A"],
          cents_per_hour: 50,
        },
      },
    });
    expect([200, 201]).toContain(put.status);
    const j = await submit(w, "p", "pods", { limits: { runtime_max_sec: 600 }, accept_cost: true });
    await until(async () => (await job(w, j.job_id)).latest_attempt.state === "succeeded");
    await until(async () => rp.calls.includes("POST /pods"));
    const leaks = (root: string) => {
      const r = Bun.spawnSync(["grep", "-rlF", KEY, root], { stdout: "pipe" });
      return r.stdout.toString().trim();
    };
    expect(leaks(w.home)).toBe("");
    expect(leaks(podHome)).toBe("");
  }, 90_000);
});

describe("S3-compatible store receipts", () => {
  async function storeWorld() {
    process.env["AK_TEST_S3_KEY"] = "test-key";
    process.env["AK_TEST_S3_SECRET"] = "test-secret";
    const store = new FakeS3().start();
    closers.push(store);
    const w = await world({
      artifact_store: {
        endpoint: store.url,
        bucket: "b",
        region: "us-east-1",
        prefix: "runs/",
        access_key_id_env: "AK_TEST_S3_KEY",
        secret_access_key_env: "AK_TEST_S3_SECRET",
        min_bytes: 100_000,
        slots: 2,
      },
    });
    await w.call("/api/v1/projects", {
      body: { path: repo({ "train.py": SLEEP }), project_id: "p" },
    });
    return { w, store };
  }

  test("a receipt cannot name another attempt's object, an unissued slot, or the wrong size", async () => {
    const { w, store } = await storeWorld();
    const a = await runningJob(w, "p", "one");
    const b = await runningJob(w, "p", "two");
    const receipt = (body: Json) =>
      w.cl.json<{ done?: boolean; error?: { code: string } }>(
        w.cl.worker(`${a.base}/uploads`, {
          token: a.creds.upload_token,
          headers: { "x-ablationkit-worker-id": a.workerId },
          body,
        }),
      );
    const base = { path: "w.bin", size: 3, sha256: sha("abc") };
    // The other attempt's object exists; this attempt's slot resolves to its own, empty key.
    const theirKey = `/b/runs/p/${b.attempt.attempt_id}/s00`;
    store.objects.set(theirKey, new TextEncoder().encode("abc"));
    const stolen = await receipt({ ...base, store_slot: 0 });
    expect([stolen.status, stolen.body.error?.code]).toEqual([404, "store_object_missing"]);
    expect(store.objects.has(theirKey)).toBe(true);
    // Slots this attempt was never issued, in every shape.
    for (const store_slot of [2, -1, 1.5, "0", "../../x", null, {}]) {
      const r = await receipt({ ...base, store_slot });
      expect([store_slot, r.status]).toEqual([store_slot, 400]);
    }
    // A wrong size or checksum deletes the object and stores nothing.
    const ownKey = `/b/runs/p/${a.attempt.attempt_id}/s01`;
    store.objects.set(ownKey, new TextEncoder().encode("abcd"));
    const size = await receipt({ ...base, store_slot: 1 });
    expect([size.status, size.body.error?.code]).toEqual([422, "checksum_mismatch"]);
    expect(store.objects.has(ownKey)).toBe(false);
    store.objects.set(ownKey, new TextEncoder().encode("xyz"));
    const hash = await receipt({ ...base, store_slot: 1 });
    expect([hash.status, hash.body.error?.code]).toEqual([422, "checksum_mismatch"]);
    expect(store.objects.has(ownKey)).toBe(false);
    const j = await job(w, a.job.job_id);
    expect(j.latest_attempt.artifacts).toEqual([]);
    // Credentials hold presigned URLs for this attempt's own keys and never the store's keys.
    const creds = readFileSync(join(a.dir, "credentials.json"), "utf8");
    expect(creds).not.toContain("test-secret");
    expect(creds).not.toContain(b.attempt.attempt_id);
    await w.call(`/api/v1/jobs/${a.job.job_id}/cancel`, { body: {} });
    await w.call(`/api/v1/jobs/${b.job.job_id}/cancel`, { body: {} });
  }, 90_000);
});
