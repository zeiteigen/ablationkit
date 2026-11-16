/** `target …` and `remote …` against a coordinator (ADR 0023); jobs are submitted through the API. */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { CoordinatorClient } from "../src/client.ts";
import { attemptStateText, describeRemote } from "../src/commands/remote.ts";
import { main } from "../src/main.ts";
import { Harness, io } from "./helpers.ts";

const h = new Harness();
afterEach(h.cleanup);
const tmp = () => h.tmp("ak-cli-remote-");

function git(dir: string, ...args: string[]): void {
  const p = Bun.spawnSync([
    "git",
    "-C",
    dir,
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=t",
    ...args,
  ]);
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

/** Submit a job through the human API, as the web UI's launch dialog does. */
async function submit(home: string, project: string, target: string): Promise<string> {
  const client = await CoordinatorClient.connect(io(home).ctx);
  const r = await client.request<{ job_id: string }>("POST", `/api/v1/projects/${project}/jobs`, {
    command: ["python3", "go.py"],
    target_id: target,
    environment: "none",
  });
  return r.job_id;
}

test("target add/list/doctor, a job on the target, remote status", async () => {
  const fake = h.track(new FakeMlflow().start());
  const home = tmp();
  const c = await h.start(
    home,
    { trackingUrl: fake.url, trackingIntervalMs: 20, remoteTickMs: 200 },
    {
      jobs: { supervisor: "direct", deliver_deadline_sec: 30 },
      remote: { heartbeat_sec: 1, max_backoff_sec: 1, min_free_disk_bytes: 0 },
    },
  );
  // A "remote" host: this machine under its own HOME, reached through a fake ssh.
  const remoteHome = tmp();
  const ssh = join(remoteHome, "fake-ssh");
  writeFileSync(
    ssh,
    `#!/bin/bash\nshift\nexport HOME=${JSON.stringify(remoteHome)} ABLATIONKIT_WORKER_SUPERVISOR=direct\ncd "$HOME"\nexec bash -c "$1"\n`,
  );
  chmodSync(ssh, 0o755);
  const targetFile = join(tmp(), "box.json");
  writeFileSync(
    targetFile,
    JSON.stringify({
      kind: "ssh",
      ssh: { host: "box", command: [ssh], supervisor: "nohup" },
      worker_url: c.urls.worker,
    }),
  );
  const add = io(home);
  expect(await main(["target", "add", "box", "--file", targetFile], add.ctx)).toBe(0);
  expect(add.o.stdout).toContain("saved box (ssh)");
  const bad = io(home);
  expect(
    await main(
      ["target", "add", "hpc", "--kind", "ssh", "--host", "h", "--partition", "gpu"],
      bad.ctx,
    ),
  ).toBe(2);
  const list = io(home);
  expect(await main(["target", "list"], list.ctx)).toBe(0);
  expect(list.o.stdout).toContain(`box  ssh  box  worker URL ${c.urls.worker}`);
  // An offline Colab target never reaches the worker URL, so it isn't flagged as missing one.
  expect(await main(["target", "add", "nb", "--kind", "colab"], io(home).ctx)).toBe(0);
  const list2 = io(home);
  expect(await main(["target", "list"], list2.ctx)).toBe(0);
  expect(list2.o.stdout).toMatch(/^nb {2}colab {2}.*offline \(notebook export/m);
  const doc = io(home);
  expect(await main(["target", "doctor", "box"], doc.ctx)).toBe(0);
  expect(doc.o.stdout).toContain("ok    worker listener reachable from the target");

  const repo = join(tmp(), "cli-remote");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "go.py"), "print('hello from the worker')\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  expect(await main(["project", "add", repo], io(home).ctx)).toBe(0);
  const jobId = await submit(home, "cli-remote", "box");
  // The attempt ends once the exit arrives; sync may finish a heartbeat later.
  const deadline = Date.now() + 20_000;
  let status = io(home);
  for (;;) {
    status = io(home);
    expect(await main(["remote", "status", jobId], status.ctx)).toBe(0);
    const out = status.o.stdout;
    if ((out.includes("sync synced") && out.includes("succeeded")) || Date.now() > deadline) break;
    await Bun.sleep(200);
  }
  expect(status.o.stdout).toContain("succeeded");
  expect(status.o.stdout).toContain("box (ssh) · staging submitted");
  expect(status.o.stdout).toContain("sync synced");
  const job = c.services.jobs.get(jobId);
  const attempt = job ? c.services.jobs.latestAttempt(job) : undefined;
  const console = await c.services.jobs.readConsole(attempt as never, { after: -1, limit: 100 });
  expect(console.lines.map((l) => l.text).join("")).toContain("hello from the worker");
}, 90_000);

test("target add --kind runpod and --kind colab; a Colab submission exports a notebook", async () => {
  const home = tmp();
  const c = await h.start(home);
  const pods = io(home);
  expect(
    await main(
      [
        "target",
        "add",
        "pods",
        "--kind",
        "runpod",
        "--api-key-env",
        "RUNPOD_API_KEY",
        "--image",
        "python:3.12",
        "--gpu",
        "NVIDIA A40",
        "--gpu",
        "NVIDIA L40S",
        "--cents-per-hour",
        "45",
        "--tailscale-secret",
        "ts_key",
      ],
      pods.ctx,
    ),
  ).toBe(0);
  expect(pods.o.stdout).toContain("paid compute");
  const t = c.services.targets.require("pods");
  expect(t).toMatchObject({
    kind: "runpod",
    paid: true,
    runpod: {
      gpu_type_ids: ["NVIDIA A40", "NVIDIA L40S"],
      cents_per_hour: 45,
      tailscale_authkey_secret: "ts_key",
    },
  });
  expect(await main(["target", "add", "x", "--kind", "runpod"], io(home).ctx)).toBe(2);
  const runtime = tmp();
  expect(
    await main(
      ["target", "add", "nb", "--kind", "colab", "--work-dir", join(runtime, "content")],
      io(home).ctx,
    ),
  ).toBe(0);

  const repo = join(tmp(), "cli-colab");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "go.py"), "print('hi')\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  expect(await main(["project", "add", repo], io(home).ctx)).toBe(0);
  const pid = c.services.registry.list()[0]?.project_id as string;
  const jobId = await submit(home, pid, "nb");
  for (let i = 0; i < 100; i++) {
    const j = c.services.jobs.get(jobId);
    const a = j ? c.services.jobs.latestAttempt(j) : undefined;
    if (a?.remote?.staging === "exported") break;
    await Bun.sleep(50);
  }
  const out = join(tmp(), "nb.ipynb");
  const nb = io(home);
  expect(await main(["remote", "notebook", jobId, "--out", out], nb.ctx)).toBe(0);
  expect(nb.o.stdout).toContain("remote import");
  const parsed = JSON.parse(await Bun.file(out).text()) as { cells: unknown[] };
  expect(parsed.cells.length).toBe(5);
  // Without --out it lands in the AblationKit home, never in the current directory.
  const nb2 = io(home);
  expect(await main(["remote", "notebook", jobId], nb2.ctx)).toBe(0);
  const job = c.services.jobs.get(jobId);
  const attemptId = job ? c.services.jobs.latestAttempt(job)?.attempt_id : undefined;
  const dflt = join(home, "notebooks", `${attemptId}.ipynb`);
  expect(nb2.o.stdout).toContain(`wrote ${dflt}`);
  expect(existsSync(dflt)).toBe(true);
  expect(existsSync(join(process.cwd(), `${attemptId}.ipynb`))).toBe(false);

  // "Colab" through the pasted loader cell: files.upload hands it the exported notebook, and
  // files.download silently does nothing (as in some browsers), so the archive comes home as the
  // printed base64.
  const loader = io(home);
  expect(await main(["remote", "notebook", jobId, "--out", out, "--loader"], loader.ctx)).toBe(0);
  expect(loader.o.stderr).toContain("paste the cell below into an empty Colab notebook");
  const stub = join(runtime, "stub");
  mkdirSync(join(stub, "google", "colab"), { recursive: true });
  writeFileSync(join(stub, "google", "__init__.py"), "");
  writeFileSync(join(stub, "google", "colab", "__init__.py"), "");
  const colab = (upload: string) =>
    Bun.spawnSync(["python3", "-c", loader.o.stdout], {
      cwd: runtime,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PYTHONPATH: stub,
        UPLOAD: upload,
        ABLATIONKIT_WORKER_SUPERVISOR: "direct",
      },
    });
  writeFileSync(
    join(stub, "google", "colab", "files.py"),
    "import os\ndef upload():\n    p = os.environ['UPLOAD']\n    return {os.path.basename(p): open(p, 'rb').read()}\ndef download(path):\n    pass\n",
  );
  // Another notebook is refused before anything runs.
  const other = join(tmp(), "other.ipynb");
  writeFileSync(other, `${await Bun.file(out).text()} `);
  const refused = colab(other);
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr.toString()).toContain(`not the notebook exported for ${attemptId}`);
  const ran = colab(out);
  expect(ran.exitCode, ran.stderr.toString()).toBe(0);
  expect(ran.stdout.toString()).toContain("--- cell 3");
  expect(ran.stdout.toString()).toContain("-----END ABLATIONKIT ARCHIVE-----");
  rmSync(join(runtime, "content", `ak-${attemptId}-state.tgz`)); // nothing was downloaded
  const pasted = join(tmp(), "pasted.txt");
  writeFileSync(pasted, ran.stdout.toString());
  // A damaged copy is refused before anything reaches the coordinator.
  const broken = join(tmp(), "broken.txt");
  writeFileSync(broken, ran.stdout.toString().replace(/\n[A-Za-z0-9+/]{76}\n/, "\n"));
  const bad = io(home);
  expect(await main(["remote", "import", jobId, "--base64", broken], bad.ctx)).toBe(1);
  expect(bad.o.stderr).toContain("part of the text is missing");
  const imp = io(home);
  expect(await main(["remote", "import", jobId, "--base64", pasted], imp.ctx)).toBe(0);
  expect(imp.o.stderr).toContain(`decoded ak-${attemptId}-state.tgz`);
  expect(imp.o.stdout).toMatch(/imported [1-9][0-9]* events .* attempt succeeded/);
}, 60_000);

test("an exported notebook reads as waiting on you; an imported spool as an exited worker", () => {
  const r = {
    target_id: "colab",
    target_kind: "colab",
    staging: "exported",
    connectivity: "pending",
    sync: "awaiting_sync",
    source_commit: "a".repeat(40),
  };
  expect(attemptStateText("starting", r)).toBe("waiting for you to run the notebook (exported)");
  expect(attemptStateText("starting", { staging: "submitted" })).toBe("starting");
  expect(describeRemote(r, "starting")).toContain("worker pending");
  const imported = { ...r, sync: "synced", imported_at: "2026-11-09T08:16:57.000Z" };
  expect(describeRemote(imported, "succeeded")).toContain(
    "worker exited (imported 2026-11-09T08:16:57.000Z)",
  );
  expect(describeRemote(imported, "succeeded")).not.toContain("worker pending");
  expect(describeRemote(imported, "running")).toContain("worker offline (partial import");
});

// F29: an exported attempt past its deadline reads as overdue, with both ways out; a lost one as lost.
test("an overdue exported notebook says how to import it or mark it lost; a marked one reads as lost", () => {
  const r = {
    target_id: "colab",
    target_kind: "colab",
    staging: "exported",
    connectivity: "pending",
    sync: "awaiting_sync",
    source_commit: "a".repeat(40),
    expected_back_by: "2026-11-09T09:30:00.000Z",
  };
  expect(attemptStateText("starting", r)).toBe(
    "waiting for you to run the notebook (exported, expected back by 2026-11-09T09:30:00.000Z)",
  );
  const overdue = { ...r, overdue_at: "2026-11-09T09:30:01.000Z" };
  expect(attemptStateText("starting", overdue)).toContain("overdue");
  expect(attemptStateText("starting", overdue)).toContain("import it or mark it lost");
  expect(
    attemptStateText("unknown", { ...overdue, marked_lost_at: "2026-11-09T09:40:00.000Z" }),
  ).toBe("lost (marked 2026-11-09T09:40:00.000Z; a late import still lands)");
});
