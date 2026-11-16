import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  type CommandResult,
  formatReport,
  overallStatus,
  type Probe,
  runDoctor,
} from "../src/commands/dev-doctor.ts";

const ROOT = resolve(import.meta.dir, "../../..");

function fakeProbe(
  overrides: Partial<Probe> & { commands?: Record<string, CommandResult | undefined> } = {},
): Probe {
  const commands: Record<string, CommandResult | undefined> = {
    "git --version": { exitCode: 0, stdout: "git version 2.50.0" },
    "uv --version": { exitCode: 0, stdout: "uv 0.12.13 (abc 2026-10-01)" },
    "uv python find --no-project 3.14": { exitCode: 0, stdout: "/py/bin/python3.14" },
    "/py/bin/python3.14 --version": { exitCode: 0, stdout: "Python 3.14.8" },
    "systemctl --user is-system-running": { exitCode: 0, stdout: "running" },
    "electron --version": { exitCode: 0, stdout: "v43.8.3" },
    ...overrides.commands,
  };
  return {
    root: "/repo",
    platform: "linux",
    bunVersion: "1.4.4",
    run: (cmd) => {
      const key = cmd.join(" ");
      if (key.startsWith("uv run")) return { exitCode: 0, stdout: "2.14.2" };
      return key in commands ? commands[key] : undefined;
    },
    exists: () => true,
    readText: (p) =>
      p === "package.json"
        ? '{"engines":{"bun":">=1.4.4"}}'
        : p === ".python-version"
          ? "3.14\n"
          : undefined,
    ...overrides,
  };
}

test("all checks pass → ready, in a fixed order", () => {
  const results = runDoctor(fakeProbe());
  expect(results.map((r) => r.id)).toEqual([
    "platform",
    "bun",
    "git",
    "uv",
    "python",
    "bun-deps",
    "python-deps",
    "systemd-user",
    "electron",
  ]);
  expect(results.every((r) => r.status === "ok")).toBe(true);
  expect(overallStatus(results)).toBe("ready");
});

test("missing systemd user manager or Electron only warns", () => {
  const results = runDoctor(
    fakeProbe({
      commands: {
        "systemctl --user is-system-running": undefined,
        "electron --version": undefined,
      },
    }),
  );
  expect(overallStatus(results)).toBe("ready_with_warnings");
  expect(formatReport(results)).toContain("→ Without it, job CPU/memory/task limits are advisory");
});

test("missing uv, old bun or missing deps block", () => {
  expect(overallStatus(runDoctor(fakeProbe({ commands: { "uv --version": undefined } })))).toBe(
    "blocked",
  );
  expect(
    overallStatus(
      runDoctor(fakeProbe({ commands: { "uv --version": { exitCode: 0, stdout: "uv 0.8.0" } } })),
    ),
  ).toBe("blocked");
  expect(overallStatus(runDoctor(fakeProbe({ bunVersion: "1.3.0" })))).toBe("blocked");
  expect(overallStatus(runDoctor(fakeProbe({ exists: () => false })))).toBe("blocked");
});

test("output is deterministic", () => {
  expect(formatReport(runDoctor(fakeProbe()))).toBe(formatReport(runDoctor(fakeProbe())));
});

test("the real CLI prints JSON and is not blocked in a set-up checkout", () => {
  const p = Bun.spawnSync([process.execPath, "apps/cli/src/main.ts", "dev", "doctor", "--json"], {
    cwd: ROOT,
    stdout: "pipe",
  });
  const report = JSON.parse(p.stdout.toString()) as { status: string; checks: { id: string }[] };
  expect(report.checks.length).toBe(9);
  expect(report.status).not.toBe("blocked");
  expect(p.exitCode).toBe(0);
});

test("unknown commands exit 2", () => {
  const p = Bun.spawnSync([process.execPath, "apps/cli/src/main.ts", "nope"], {
    cwd: ROOT,
    stderr: "pipe",
  });
  expect(p.exitCode).toBe(2);
});
