/** The Colab CLI adapter's pure parts (ADR 0059): redaction, usage, generated Python, validation. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputeTarget } from "@ablationkit/protocol";
import {
  colabDir,
  colabKeeperCode,
  colabMkdirCode,
  colabUnpackCode,
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
      const scripts = {
        mkdir: colabMkdirCode(colabDir(offline, "j-1-a1")),
        unpack: colabUnpackCode(colabDir(offline, "j-1-a1"), "a".repeat(64)),
        keeper: colabKeeperCode(offline, { attemptId: "j-1-a1", session: "ak-j-1-a1" }),
        live: colabKeeperCode(live, { attemptId: "j-1-a1", session: "ak-j-1-a1" }),
      };
      for (const [name, code] of Object.entries(scripts)) {
        const f = join(dir, `${name}.py`);
        writeFileSync(f, code);
        const r = Bun.spawnSync(["python3", "-m", "py_compile", f], { stderr: "pipe" });
        expect(r.stderr.toString()).toBe("");
        expect(r.exitCode).toBe(0);
      }
      expect(colabDir(offline, "j-1-a1")).toBe("/content/ablationkit/j-1-a1");
      expect(scripts.keeper).toContain('env["ABLATIONKIT_WORKER_OFFLINE"] = "1"');
      expect(scripts.keeper).toContain('"ABLATIONKIT_WORKER_DELIVER_DEADLINE_SEC"] = "0"');
      expect(scripts.live).not.toContain("ABLATIONKIT_WORKER_OFFLINE");
      expect(scripts.live).toContain('"ABLATIONKIT_WORKER_DELIVER_DEADLINE_SEC"] = "30"');
      // Never a second worker for the same directory.
      expect(scripts.keeper).toContain("AK-KEEPER-EXISTS");
      expect(scripts.unpack).toContain("AK-ALREADY-STARTED");
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
