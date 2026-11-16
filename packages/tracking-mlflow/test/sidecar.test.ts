import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  compareVersions,
  MlflowSidecar,
  pinnedMlflowVersion,
  type SidecarHooks,
} from "../src/sidecar.ts";
import { Env, until } from "./helpers.ts";

const env = new Env();
afterEach(() => env.cleanup());

const OPS = resolve(import.meta.dir, "../env");
const FAKE_MAIN = resolve(import.meta.dir, "../src/fake-server-main.ts");
const PIN = pinnedMlflowVersion(OPS);

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port ?? 0;
  await s.stop(true);
  return p;
}

async function sidecar(
  opts: { dataDir?: string; installed?: string; serverVersion?: string; backups?: string[] } = {},
) {
  const dataDir = opts.dataDir ?? join(env.tmp(), "mlflow");
  const port = await freePort();
  const hooks: SidecarHooks = {
    install: async () => {},
    installedVersion: async () => opts.installed ?? PIN,
    command: (p) => [process.execPath, FAKE_MAIN, String(p), opts.serverVersion ?? PIN],
  };
  const sc = new MlflowSidecar({
    opsDir: OPS,
    dataDir,
    port,
    hooks,
    healthIntervalMs: 50,
    maxRestartDelayMs: 50,
    startTimeoutMs: 10_000,
    preUpgradeBackup: async (from, to) => {
      opts.backups?.push(`${from}->${to}`);
      return "20261102T180000Z-pre-upgrade";
    },
  });
  env.cleanups.push(() => sc.stop());
  return { sc, dataDir };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("MlflowSidecar", () => {
  test("pins an exact MLflow 3.x version", () => {
    expect(PIN).toMatch(/^3\.[0-9]+\.[0-9]+$/);
    expect(compareVersions("3.17.2", "3.9.0")).toBe(1);
    expect(compareVersions("3.17.2", "3.17.2")).toBe(0);
  });

  test("starts healthy, restarts after a crash, and stops its process group", async () => {
    const { sc } = await sidecar();
    await sc.start();
    expect(sc.status().state).toBe("healthy");
    expect(await (await fetch(`${sc.url}/health`)).text()).toBe("OK");
    const pid = sc.status().pid as number;
    process.kill(pid, "SIGKILL");
    await until(() => sc.status().state === "restarting");
    await until(() => sc.status().state === "healthy" && sc.status().pid !== pid, 10_000);
    expect(sc.status().restarts).toBe(1);
    const pid2 = sc.status().pid as number;
    await sc.stop();
    expect(sc.status().state).toBe("stopped");
    expect(alive(pid2)).toBe(false);
    expect(sc.activeUrl).toBeUndefined();
  });

  test("fails visibly when the server reports another version", async () => {
    const { sc } = await sidecar({ serverVersion: "3.0.0" });
    await sc.start();
    expect(sc.status().state).toBe("failed");
    expect(sc.status().last_error).toContain("3.0.0");
  });

  test("upgrade guard: backs up before a newer MLflow opens existing data", async () => {
    const backups: string[] = [];
    const { sc, dataDir } = await sidecar({ backups });
    await sc.start();
    expect(sc.readState()?.data_mlflow_version).toBe(PIN);
    await sc.stop();
    // Pretend the data was written by an older MLflow and a database exists.
    const st = JSON.parse(readFileSync(join(dataDir, "sidecar.json"), "utf8"));
    writeFileSync(
      join(dataDir, "sidecar.json"),
      JSON.stringify({ ...st, data_mlflow_version: "3.16.1" }),
    );
    writeFileSync(join(dataDir, "mlflow.db"), "");
    const again = await sidecar({ dataDir, backups });
    await again.sc.start();
    expect(backups).toEqual([`3.16.1->${PIN}`]);
    expect(again.sc.status().state).toBe("healthy");
    const after = again.sc.readState();
    expect(after?.data_mlflow_version).toBe(PIN);
    expect(after?.upgrades.at(-1)).toMatchObject({ from_version: "3.16.1", to_version: PIN });
  });

  test("upgrade guard: refuses a downgrade and a failed pre-upgrade backup", async () => {
    const { sc, dataDir } = await sidecar();
    await sc.start();
    await sc.stop();
    const st = JSON.parse(readFileSync(join(dataDir, "sidecar.json"), "utf8"));
    writeFileSync(
      join(dataDir, "sidecar.json"),
      JSON.stringify({ ...st, data_mlflow_version: "9.0.0" }),
    );
    const older = await sidecar({ dataDir });
    await older.sc.start();
    expect(older.sc.status().state).toBe("upgrade_blocked");
    expect(older.sc.status().last_error).toContain("refusing to start older");
    expect(older.sc.status().pid).toBeUndefined();

    writeFileSync(
      join(dataDir, "sidecar.json"),
      JSON.stringify({ ...st, data_mlflow_version: "3.0.0" }),
    );
    writeFileSync(join(dataDir, "mlflow.db"), "");
    const port = await freePort();
    const failing = new MlflowSidecar({
      opsDir: OPS,
      dataDir,
      port,
      hooks: {
        install: async () => {},
        installedVersion: async () => PIN,
        command: (p) => [process.execPath, FAKE_MAIN, String(p)],
      },
      preUpgradeBackup: async () => {
        throw new Error("disk full");
      },
    });
    await failing.start();
    expect(failing.status().state).toBe("upgrade_blocked");
    expect(failing.status().last_error).toContain("disk full");
  });

  test("kills a sidecar orphaned by a crashed coordinator", async () => {
    const { sc, dataDir } = await sidecar();
    await sc.start();
    const pid = sc.status().pid as number;
    // Simulate a coordinator crash: forget the child without stopping it.
    const orphan = new MlflowSidecar({
      opsDir: OPS,
      dataDir,
      port: await freePort(),
      hooks: {
        install: async () => {},
        installedVersion: async () => PIN,
        command: (p) => [process.execPath, FAKE_MAIN, String(p)],
      },
      preUpgradeBackup: async () => "x",
    });
    env.cleanups.push(() => orphan.stop());
    expect(existsSync(join(dataDir, "sidecar.pid"))).toBe(true);
    await orphan.start();
    await until(() => !alive(pid));
    expect(orphan.status().state).toBe("healthy");
  });
});
