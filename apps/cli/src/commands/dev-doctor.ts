/**
 * `ablationkit dev doctor`: deterministic check of the development environment (spec §8.6).
 *
 * Checks run in a fixed order and print no timestamps, so two runs on the same machine give the
 * same output. `fail` blocks development; `warn` marks something a later stage needs.
 * Exit code: 0 for ready or ready_with_warnings, 1 for blocked.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeStdout } from "@ablationkit/core";

/** The minimum uv. CI pins the exact versions in .github/workflows/ci.yml. */
const MIN_UV = "0.12.0";

export type CheckStatus = "ok" | "warn" | "fail";
export type DoctorStatus = "ready" | "ready_with_warnings" | "blocked";

export interface CheckResult {
  readonly id: string;
  readonly status: CheckStatus;
  readonly summary: string;
  readonly fix?: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Everything the doctor reads from the machine, injectable for tests. */
export interface Probe {
  readonly root: string;
  readonly platform: string;
  readonly bunVersion: string;
  /** Run a command; undefined when the executable is not found. */
  run(cmd: readonly string[]): CommandResult | undefined;
  exists(path: string): boolean;
  readText(path: string): string | undefined;
}

function systemProbe(root: string): Probe {
  return {
    root,
    platform: process.platform,
    bunVersion: Bun.version,
    run(cmd) {
      try {
        const p = Bun.spawnSync([...cmd], { cwd: root, stdout: "pipe", stderr: "pipe" });
        return { exitCode: p.exitCode ?? -1, stdout: p.stdout.toString().trim() };
      } catch {
        return undefined;
      }
    },
    exists: (path) => existsSync(join(root, path)),
    readText(path) {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

const ok = (id: string, summary: string): CheckResult => ({ id, status: "ok", summary });
const warn = (id: string, summary: string, fix: string): CheckResult => ({
  id,
  status: "warn",
  summary,
  fix,
});
const fail = (id: string, summary: string, fix: string): CheckResult => ({
  id,
  status: "fail",
  summary,
  fix,
});

function versionOf(probe: Probe, cmd: readonly string[]): string | undefined {
  const r = probe.run(cmd);
  if (!r || r.exitCode !== 0) return undefined;
  return /[0-9]+\.[0-9]+\.[0-9]+/.exec(r.stdout)?.[0];
}

export function runDoctor(probe: Probe): CheckResult[] {
  const results: CheckResult[] = [];

  results.push(
    probe.platform === "linux"
      ? ok("platform", "linux")
      : warn(
          "platform",
          probe.platform,
          "The reference platform is Linux with systemd; expect gaps elsewhere.",
        ),
  );

  const pkg = JSON.parse(probe.readText("package.json") ?? "{}") as { engines?: { bun?: string } };
  const bunRange = pkg.engines?.bun ?? "*";
  results.push(
    Bun.semver.satisfies(probe.bunVersion, bunRange)
      ? ok("bun", `${probe.bunVersion} (requires ${bunRange})`)
      : fail(
          "bun",
          `${probe.bunVersion} (requires ${bunRange})`,
          "Install Bun per package.json packageManager.",
        ),
  );

  const git = versionOf(probe, ["git", "--version"]);
  results.push(git ? ok("git", git) : fail("git", "not found", "Install git."));

  const uv = versionOf(probe, ["uv", "--version"]);
  results.push(
    !uv
      ? fail("uv", "not found", "Install uv: https://docs.astral.sh/uv/")
      : Bun.semver.satisfies(uv, `>=${MIN_UV}`)
        ? ok("uv", `${uv} (requires >=${MIN_UV})`)
        : fail("uv", `${uv} (requires >=${MIN_UV})`, "Upgrade uv: uv self update"),
  );

  const pinned = probe.readText(".python-version")?.trim();
  if (!pinned) {
    results.push(fail("python", ".python-version missing", "Restore .python-version from git."));
  } else if (!uv) {
    results.push(fail("python", `${pinned} (cannot check without uv)`, "Install uv first."));
  } else {
    const found = probe.run(["uv", "python", "find", "--no-project", pinned]);
    results.push(
      found?.exitCode === 0
        ? ok(
            "python",
            `${pinned} (${versionOf(probe, [found.stdout, "--version"]) ?? found.stdout})`,
          )
        : fail("python", `${pinned} not installed`, `uv python install ${pinned}`),
    );
  }

  results.push(
    probe.exists("node_modules/.bin/biome") &&
      probe.exists("packages/protocol/node_modules/@sinclair/typebox")
      ? ok("bun-deps", "node_modules installed")
      : fail("bun-deps", "node_modules missing or incomplete", "bun install --frozen-lockfile"),
  );

  const py = uv
    ? probe.run([
        "uv",
        "run",
        "--frozen",
        "--no-sync",
        "python",
        "-c",
        "import ablationkit_protocol, pydantic; print(pydantic.VERSION)",
      ])
    : undefined;
  results.push(
    py?.exitCode === 0
      ? ok("python-deps", `.venv ready (pydantic ${py.stdout})`)
      : fail("python-deps", ".venv missing or incomplete", "uv sync --locked"),
  );

  const systemd = probe.run(["systemctl", "--user", "is-system-running"]);
  const state = systemd?.stdout ?? "";
  results.push(
    state === "running" || state === "degraded"
      ? ok("systemd-user", `user manager ${state}`)
      : warn(
          "systemd-user",
          systemd ? `user manager ${state || "unavailable"}` : "systemctl not found",
          "Without it, job CPU/memory/task limits are advisory (ADR 0003, 0011); builds and tests still work.",
        ),
  );

  // The desktop app runs on the system Electron (ADR 0025); `ABLATIONKIT_ELECTRON` also works.
  const electron = ["electron", "electron43", "electron42", "electron41"]
    .map((c) => versionOf(probe, [c, "--version"]))
    .find((v) => v !== undefined);
  results.push(
    electron
      ? ok("electron", `Electron ${electron}`)
      : warn(
          "electron",
          "not found",
          "Needed only for the desktop app (`bun run desktop`): install electron43, or set ABLATIONKIT_ELECTRON. Not needed to build or test.",
        ),
  );

  return results;
}

export function overallStatus(results: readonly CheckResult[]): DoctorStatus {
  if (results.some((r) => r.status === "fail")) return "blocked";
  if (results.some((r) => r.status === "warn")) return "ready_with_warnings";
  return "ready";
}

export function formatReport(results: readonly CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.id.length));
  const lines = results.map((r) => {
    const line = `${r.status.padEnd(4)}  ${r.id.padEnd(width)}  ${r.summary}`;
    return r.fix && r.status !== "ok" ? `${line}\n      ${" ".repeat(width)}  → ${r.fix}` : line;
  });
  return `${lines.join("\n")}\n\n${overallStatus(results)}\n`;
}

export function devDoctor(args: readonly string[], root: string): number {
  const results = runDoctor(systemProbe(root));
  const status = overallStatus(results);
  if (args.includes("--json")) {
    writeStdout(`${JSON.stringify({ status, checks: results }, null, 2)}\n`);
  } else {
    writeStdout(formatReport(results));
  }
  return status === "blocked" ? 1 : 0;
}
