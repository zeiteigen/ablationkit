/** The Colab CLI adapter's pure parts (ADR 0059): redaction, usage, generated Python, validation. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputeTarget } from "@ablationkit/protocol";
import {
  ColabCliTarget,
  colabDir,
  colabKeeperCode,
  colabUploads,
  parseColabUsage,
  redact,
} from "../src/colab-cli.ts";
import { adapterFor, validateTarget } from "../src/targets.ts";

const target = (colab: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    schema_version: 1,
    target_id: "colab",
    kind: "colab",
    paid: false,
    colab,
    created_at: "2026-11-16T00:00:00.000Z",
    updated_at: "2026-11-16T00:00:00.000Z",
    ...extra,
  }) as ComputeTarget;

describe("Colab CLI adapter", () => {
  test("the CLI's tokens and sign-in links never survive redaction", () => {
    const err =
      "[colab] Upload failed: 500 Server Error for url: https://8080-m-s.prod.colab.dev/api/contents/x?authuser=0&colab-runtime-proxy-token=eyJhbGciOiJFUzI1NiIsICJraWQiOiJlSElqZkEifQ.eyJhdWQiOiJtLXMtdXNjMWIy.XiTeMEfHQbgTwUtJDKd5-t_E";
    const r = redact(err);
    expect(r).not.toContain("eyJ");
    expect(r).toContain("colab-runtime-proxy-token=REDACTED");
    expect(redact("visit https://accounts.google.com/o/oauth2/auth?code_challenge=abc")).toBe(
      "visit <sign-in link>",
    );
  });

  test("`colab usage` parses into balance, hourly rate and runtimes", () => {
    expect(
      parseColabUsage(
        "Current balance: 199.93 compute units\nUsage rate: 1.94/hr\nActive assignments: 1\n",
      ),
    ).toEqual({ balance: 199.93, per_hour: 1.94, runtimes: 1 });
    expect(parseColabUsage("[colab] Warning: failed to fetch compute-unit info")).toBeUndefined();
  });

  test("the generated Python compiles, and only a live target carries credentials or delivers", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-colab-py-"));
    try {
      const offline = target({ mode: "cli", gpu: "L4" });
      const live = target({ mode: "cli", live: true, deliver_deadline_sec: 30 });
      const sha = "a".repeat(64);
      const scripts = {
        keeper: colabKeeperCode(offline, {
          attemptId: "j-1-a1",
          session: "ak-j-1-a1",
          bundleSha256: sha,
        }),
        live: colabKeeperCode(live, {
          attemptId: "j-1-a1",
          session: "ak-j-1-a1",
          bundleSha256: sha,
        }),
      };
      for (const [name, code] of Object.entries(scripts)) {
        const f = join(dir, `${name}.py`);
        writeFileSync(f, code);
        const r = Bun.spawnSync(["python3", "-m", "py_compile", f], { stderr: "pipe" });
        expect(r.stderr.toString()).toBe("");
        expect(r.exitCode).toBe(0);
      }
      expect(colabDir(offline, "j-1-a1")).toBe("/content/ablationkit/j-1-a1");
      // Uploads land beside the worker directory, in a directory every runtime has.
      expect(colabUploads(offline, "j-1-a1")).toEqual({
        bundle: "/content/ak-j-1-a1.bundle.tgz",
        credentials: "/content/ak-j-1-a1.credentials.json",
      });
      expect(scripts.keeper).toContain('env["ABLATIONKIT_WORKER_OFFLINE"] = "1"');
      expect(scripts.keeper).toContain('"ABLATIONKIT_WORKER_DELIVER_DEADLINE_SEC"] = "0"');
      expect(scripts.live).not.toContain("ABLATIONKIT_WORKER_OFFLINE");
      expect(scripts.live).toContain('"ABLATIONKIT_WORKER_DELIVER_DEADLINE_SEC"] = "30"');
      // Never a second worker for the same directory; a bad bundle is refused before anything runs.
      expect(scripts.keeper).toContain("AK-KEEPER-EXISTS");
      expect(scripts.keeper).toContain("bundle checksum mismatch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validation, and the mode picks the adapter", () => {
    expect(validateTarget(target({ mode: "cli", gpu: "L4", tpu: "v5e1" }))).toContain(
      "a Colab runtime has a `gpu` or a `tpu`, not both",
    );
    expect(validateTarget(target({ gpu: "L4" })).join(" ")).toContain("`mode: cli` only");
    expect(validateTarget(target({ mode: "cli" }, { work_dir: "~/w" })).join(" ")).toContain(
      "absolute",
    );
    expect(validateTarget(target({ mode: "cli", gpu: "A100", high_mem: true }))).toEqual([]);
    expect(adapterFor(target({ mode: "cli" })).capabilities).toMatchObject({
      submit: true,
      collects: true,
      release: true,
    });
    expect(adapterFor(target({})).capabilities).toMatchObject({ submit: false, exports: true });
  });
});

describe("Colab CLI adapter against the fake CLI", () => {
  const FAKE = join(import.meta.dir, "../../../apps/server/test/fake-colab.py");

  test("a start that hangs before running anything is tried again; a bad bundle is refused and the runtime released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-colab-hang-"));
    try {
      const root = join(dir, "content", "ablationkit");
      Bun.spawnSync(["mkdir", "-p", root]);
      // A bundle: any gzip tar; the worker in it is missing, which is fine for starting.
      Bun.spawnSync(["mkdir", "-p", join(dir, "src", "worker")]);
      writeFileSync(join(dir, "src", "bundle.json"), "{}");
      const tgz = join(dir, "bundle.tgz");
      Bun.spawnSync(["tar", "-czf", tgz, "-C", join(dir, "src"), "."]);
      const sha = new Bun.CryptoHasher("sha256")
        .update(await Bun.file(tgz).arrayBuffer())
        .digest("hex");
      const t = target(
        { mode: "cli", cli: ["python3", FAKE], gpu: "L4", keep_after_sec: 0 },
        { work_dir: root },
      );
      const a = new ColabCliTarget(t, { stateFile: join(dir, "s.json"), startTimeoutMs: 1500 });
      const input = {
        attemptId: "j-hang-a1",
        jobId: "j-hang",
        workerUrl: "http://127.0.0.1:1",
        bundleSha256: sha,
        tgz,
        credentials: "{}",
        limits: {},
      };
      process.env["FAKE_COLAB_HANG_EXECS"] = "1";
      const staged = await a.stage(input);
      expect(staged.provider_job_id).toBe("ak-j-hang-a1");
      expect(await a.submit(input)).toEqual({ provider_job_id: "ak-j-hang-a1" });
      // The keeper moved the uploads in and unpacked the bundle.
      expect(await Bun.file(join(root, "j-hang-a1", "bundle", "bundle.json")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "content", "ak-j-hang-a1.bundle.tgz")).exists()).toBe(false);
      await a.release("j-hang-a1", "ak-j-hang-a1");

      // A bundle whose checksum does not match: refused, and the runtime is released.
      delete process.env["FAKE_COLAB_HANG_EXECS"];
      const bad = { ...input, attemptId: "j-bad-a1", bundleSha256: "b".repeat(64) };
      await a.stage(bad);
      await expect(a.submit(bad)).rejects.toThrow("bundle checksum mismatch");
      const left = JSON.parse(await Bun.file(join(dir, "s.json")).text()) as Record<
        string,
        unknown
      >;
      expect(Object.keys(left)).toEqual([]);
    } finally {
      delete process.env["FAKE_COLAB_HANG_EXECS"];
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
