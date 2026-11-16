/** Launch-dialog parsing into the job API's body (`POST /api/v1/projects/:id/jobs`). */

export function parseSize(s: string): number {
  const m = /^([0-9]+(?:\.[0-9]+)?)([KMGT]?)i?B?$/i.exec(s.trim());
  if (!m) throw new Error(`bad size ${s} (use e.g. 512M or 4G)`);
  const mult = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[
    (m[2] ?? "").toUpperCase() as "" | "K" | "M" | "G" | "T"
  ];
  return Math.round(Number(m[1]) * mult);
}

export function parseDuration(s: string): number {
  const m = /^([0-9]+)(s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new Error(`bad duration ${s} (use e.g. 90s, 30m or 2h)`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? "s") as "s" | "m" | "h" | "d"];
}

/**
 * Split a command line into argv like a POSIX shell would for plain words and quotes (no
 * expansion, no operators): the job runs argv directly, never through a shell.
 */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (q) {
      if (ch === q) q = undefined;
      else if (ch === "\\" && q === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (q) throw new Error("unterminated quote");
  if (has || cur) out.push(cur);
  return out;
}

export interface LaunchForm {
  command: string;
  cwd: string;
  environment: "uv" | "none";
  memory: string;
  cpu: string;
  timeout: string;
  artifacts: string;
  metricsFile: string;
  runName: string;
  study: string;
  variant: string;
}

/** The `POST /api/v1/projects/:id/jobs` body for a launch form. */
export function launchBody(f: LaunchForm): Record<string, unknown> {
  const command = splitArgs(f.command);
  if (command.length === 0) throw new Error("enter a command");
  const limits: Record<string, number> = {};
  if (f.memory.trim()) limits["memory_max_bytes"] = parseSize(f.memory);
  if (f.cpu.trim()) {
    const n = Number(f.cpu.replace(/%$/, ""));
    if (!Number.isSafeInteger(n) || n < 1) throw new Error("CPU quota must be a positive integer");
    limits["cpu_quota_percent"] = n;
  }
  if (f.timeout.trim()) limits["runtime_max_sec"] = parseDuration(f.timeout);
  const artifact_paths = f.artifacts
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    command,
    environment: f.environment,
    ...(f.cwd.trim() ? { cwd: f.cwd.trim() } : {}),
    ...(Object.keys(limits).length ? { limits } : {}),
    ...(artifact_paths.length ? { artifact_paths } : {}),
    ...(f.metricsFile.trim() ? { metrics_file: f.metricsFile.trim() } : {}),
    ...(f.runName.trim() ? { run_name: f.runName.trim() } : {}),
    ...(f.study.trim() ? { study_id: f.study.trim() } : {}),
    ...(f.variant.trim() ? { variant_id: f.variant.trim() } : {}),
  };
}
