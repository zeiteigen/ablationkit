/**
 * What an agent container session changed (ADR 0061): packages in the project environment, files
 * in the checkout, and the shell commands its harness recorded. Pure: the coordinator reads the
 * directories and Git, these turn what it read into the session's record.
 */

export interface PackageVersion {
  readonly name: string;
  readonly version: string;
  readonly previous?: string;
}

/** PEP 503 normalisation, so `Foo_Bar` and `foo-bar` are the same package. */
export function normalizePackage(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** A `site-packages` entry `name-version.dist-info` as a package, or undefined. */
export function parseDistInfo(entry: string): PackageVersion | undefined {
  const m = /^(.+?)-([^-]+)\.dist-info$/.exec(entry);
  if (!m) return undefined;
  return { name: normalizePackage(m[1] as string), version: m[2] as string };
}

export function diffPackages(
  before: readonly PackageVersion[],
  after: readonly PackageVersion[],
): { added: PackageVersion[]; removed: PackageVersion[]; changed: PackageVersion[] } {
  const b = new Map(before.map((p) => [p.name, p.version]));
  const a = new Map(after.map((p) => [p.name, p.version]));
  const added: PackageVersion[] = [];
  const removed: PackageVersion[] = [];
  const changed: PackageVersion[] = [];
  for (const [name, version] of a) {
    const old = b.get(name);
    if (old === undefined) added.push({ name, version });
    else if (old !== version) changed.push({ name, version, previous: old });
  }
  for (const [name, version] of b) if (!a.has(name)) removed.push({ name, version });
  const byName = (x: PackageVersion, y: PackageVersion) => x.name.localeCompare(y.name);
  return {
    added: added.sort(byName),
    removed: removed.sort(byName),
    changed: changed.sort(byName),
  };
}

/** `git status --porcelain=v1 -z` (untracked included) as paths with their status letters. */
export function parsePorcelain(z: string): { path: string; status: string }[] {
  const out: { path: string; status: string }[] = [];
  const parts = z.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i] as string;
    if (e.length < 4) continue;
    const status = e.slice(0, 2).trim() || "M";
    out.push({ path: e.slice(3), status });
    // A rename or copy is followed by its source path.
    if (status.startsWith("R") || status.startsWith("C")) i++;
  }
  return out;
}

/** `git diff --name-status -z A B` as paths with their status letters. */
export function parseNameStatus(z: string): { path: string; status: string }[] {
  const out: { path: string; status: string }[] = [];
  const parts = z.split("\0").filter((p) => p.length > 0);
  for (let i = 0; i < parts.length; ) {
    const status = parts[i] as string;
    if (status.startsWith("R") || status.startsWith("C")) {
      out.push({ path: parts[i + 2] ?? "", status: status.slice(0, 1) });
      i += 3;
    } else {
      out.push({ path: parts[i + 1] ?? "", status });
      i += 2;
    }
  }
  return out.filter((c) => c.path.length > 0);
}

/**
 * Files changed in a session: committed between its start and end commits, plus what is
 * uncommitted at its end and was not already uncommitted at its start.
 */
export function filesChanged(
  committed: readonly { path: string; status: string }[],
  dirtyAtStart: readonly string[],
  dirtyAtEnd: readonly { path: string; status: string }[],
): { path: string; status: string }[] {
  const seen = new Map<string, string>();
  for (const c of committed) seen.set(c.path, c.status);
  const before = new Set(dirtyAtStart);
  for (const d of dirtyAtEnd)
    if (!before.has(d.path) && !seen.has(d.path)) seen.set(d.path, d.status);
  return [...seen]
    .map(([path, status]) => ({ path, status }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface RecordedCommand {
  readonly at?: string;
  readonly command: string;
}

const MAX_COMMAND = 2000;

function clip(s: string): string {
  return s.length > MAX_COMMAND ? `${s.slice(0, MAX_COMMAND - 1)}…` : s;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function commandText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    // `["bash", "-lc", "…"]`: the script is what the agent wrote.
    const a = v as string[];
    if (a.length === 3 && /(^|\/)(ba|z)?sh$/.test(a[0] as string) && /^-l?c$/.test(a[1] as string))
      return a[2];
    return a.join(" ");
  }
  return undefined;
}

/**
 * Shell commands in one line of a harness transcript: Claude Code's (`~/.claude/projects/…/*.jsonl`,
 * a `Bash` tool use) or Codex's (`~/.codex/sessions/…/rollout-*.jsonl`, a `shell`, `exec_command`
 * or `local_shell_call` item).
 */
export function commandsInTranscriptLine(line: string): RecordedCommand[] {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return [];
  }
  const o = obj(v);
  if (!o) return [];
  const at = typeof o["timestamp"] === "string" ? (o["timestamp"] as string) : undefined;
  const out: RecordedCommand[] = [];
  const push = (c: string | undefined) => {
    if (c?.trim()) out.push(at ? { at, command: clip(c.trim()) } : { command: clip(c.trim()) });
  };
  // Claude Code: an assistant message whose content has a Bash tool use.
  const content = obj(o["message"])?.["content"];
  if (Array.isArray(content))
    for (const part of content) {
      const p = obj(part);
      if (p?.["type"] === "tool_use" && p["name"] === "Bash")
        push(commandText(obj(p["input"])?.["command"]));
    }
  // Codex: a response item.
  const payload = obj(o["payload"]);
  if (payload) {
    const type = payload["type"];
    if (type === "function_call" && typeof payload["arguments"] === "string") {
      const name = payload["name"];
      if (name === "shell" || name === "exec_command" || name === "container.exec") {
        let args: Record<string, unknown> | undefined;
        try {
          args = obj(JSON.parse(payload["arguments"] as string));
        } catch {
          args = undefined;
        }
        push(commandText(args?.["command"] ?? args?.["cmd"]));
      }
    } else if (type === "local_shell_call") {
      push(commandText(obj(payload["action"])?.["command"]));
    }
  }
  return out;
}

/** Commands recorded at or after `since` (when the line says when), oldest first, at most `max`. */
export function commandsInTranscripts(
  lines: Iterable<string>,
  since: string,
  until: string | undefined,
  max = 1000,
): RecordedCommand[] {
  const out: RecordedCommand[] = [];
  for (const line of lines)
    for (const c of commandsInTranscriptLine(line)) {
      if (c.at && (c.at < since || (until && c.at > until))) continue;
      out.push(c);
    }
  out.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  return out.slice(-max);
}
