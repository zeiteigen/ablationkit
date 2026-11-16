import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  groupAlive,
  limitProperties,
  probeSupervisor,
  type StartSpec,
  type Supervised,
  startSupervised,
} from "../src/index.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ak-sup-"));
  dirs.push(d);
  return d;
}

let n = 0;
function spec(argv: string[], extra: Partial<StartSpec> = {}): StartSpec {
  n += 1;
  return {
    unit: `ak-test-${process.pid}-${Date.now()}-${n}`,
    argv,
    cwd: tmp(),
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    limits: {},
    mode: "direct",
    ...extra,
  };
}

async function drain(s: Supervised): Promise<string> {
  let out = "";
  s.stderr.resume();
  for await (const c of s.stdout) out += String(c);
  return out;
}

test("limit properties always pair MemoryMax with MemorySwapMax=0", () => {
  expect(
    limitProperties({
      memory_max_bytes: 200 * 1024 * 1024,
      cpu_quota_percent: 25,
      runtime_max_sec: 3,
      tasks_max: 20,
    }),
  ).toEqual([
    "MemoryMax=209715200",
    "MemorySwapMax=0",
    "CPUQuota=25%",
    "RuntimeMaxSec=3",
    "TasksMax=20",
  ]);
  expect(limitProperties({})).toEqual([]);
});

test("forced direct mode is labelled advisory", () => {
  const p = probeSupervisor({ ABLATIONKIT_SUPERVISOR: "direct" });
  expect(p.mode).toBe("direct");
  expect(p.enforcement).toBe("advisory");
  expect(p.reason).toContain("time limit");
});

describe("direct mode", () => {
  test("captures output and the exit code", async () => {
    const s = await startSupervised(spec(["sh", "-c", "echo hello; exit 3"]));
    expect(await drain(s)).toBe("hello\n");
    const t = await s.exited;
    expect(t.exit_code).toBe(3);
    expect(t.timed_out).toBe(false);
  });

  test("applies the time limit", async () => {
    const s = await startSupervised(spec(["sleep", "30"], { limits: { runtime_max_sec: 1 } }));
    void drain(s);
    const t = await s.exited;
    expect(t.timed_out).toBe(true);
    expect(t.unit_result).toBe("timeout");
    expect(t.signal).toBe("SIGTERM");
  });

  test("stop kills the whole process group, grandchildren included", async () => {
    const s = await startSupervised(spec(["sh", "-c", "sleep 60 & sleep 60 & wait"]));
    void drain(s);
    await Bun.sleep(200);
    expect(groupAlive(s.pid)).toBe(true);
    await s.stop();
    expect(groupAlive(s.pid)).toBe(false);
  });

  test("leftover processes are killed when the main process exits", async () => {
    const s = await startSupervised(spec(["sh", "-c", "(sleep 60 >/dev/null 2>&1 &) ; exit 0"]));
    void drain(s);
    const t = await s.exited;
    expect(t.exit_code).toBe(0);
    expect(t.leftovers_killed).toBe(true);
    expect(groupAlive(s.pid)).toBe(false);
  });
});

const probe = probeSupervisor({});
const systemdEnforced = probe.mode === "systemd" && probe.enforcement === "enforced";

describe.skipIf(!systemdEnforced)("systemd mode (enforced limits, ADR 0003)", () => {
  test("memory limit OOM-kills the job and reports oom-kill", async () => {
    const s = await startSupervised(
      spec(["python3", "-c", "b = bytearray(1024 * 1024 * 1024); print(len(b))"], {
        mode: "systemd",
        limits: { memory_max_bytes: 64 * 1024 * 1024 },
      }),
    );
    void drain(s);
    const t = await s.exited;
    expect(t.oom_killed).toBe(true);
    expect(t.unit_result).toBe("oom-kill");
  }, 20_000);

  test("RuntimeMaxSec times the job out", async () => {
    const s = await startSupervised(
      spec(["sleep", "30"], { mode: "systemd", limits: { runtime_max_sec: 1 } }),
    );
    void drain(s);
    const t = await s.exited;
    expect(t.timed_out).toBe(true);
    expect(t.signal).toBe("SIGTERM");
  }, 20_000);

  test("TasksMax caps threads", async () => {
    const code =
      "import threading,time\nn=0\ntry:\n  for _ in range(100):\n    threading.Thread(target=time.sleep,args=(2,),daemon=True).start(); n+=1\nexcept RuntimeError: pass\nprint(n)";
    const s = await startSupervised(
      spec(["python3", "-c", code], { mode: "systemd", limits: { tasks_max: 20 } }),
    );
    const out = await drain(s);
    await s.exited;
    expect(Number(out.trim())).toBeLessThan(20);
  }, 20_000);

  test("leftovers in the scope are stopped when the main process exits", async () => {
    const s = await startSupervised(
      spec(["sh", "-c", "setsid sleep 60 >/dev/null 2>&1 & exit 0"], { mode: "systemd" }),
    );
    void drain(s);
    const t = await s.exited;
    expect(t.exit_code).toBe(0);
    expect(t.leftovers_killed).toBe(true);
  }, 20_000);

  test("stop ends the scope", async () => {
    const s = await startSupervised(spec(["sleep", "60"], { mode: "systemd" }));
    void drain(s);
    await Bun.sleep(200);
    await s.stop();
    const t = await s.exited;
    expect(t.signal).toBe("SIGTERM");
  }, 30_000);
});
