/**
 * Agent containers (ADR 0061): the coordinator runs the researcher's own harness in a rootless
 * Podman container and holds everything the container can reach.
 *
 * A session is started by the researcher (`ablationkit agent start`, the human API). The
 * coordinator mints the session's agent token itself (never through the login socket), writes it
 * into the session's run directory with the MCP configuration, starts three Unix sockets there
 * (the agent API, the egress proxy, the credential routes), and runs `podman run` in a tmux
 * terminal of its own (a transient systemd unit, so it outlives the coordinator) that the
 * researcher attaches to. The container gets the checkout, the project's environment volumes and
 * the run directory (read-only); never the GPU, the network, the coordinator's home or the login
 * socket (`@ablationkit/agent-containers` plans the command line).
 *
 * Local jobs the session submits run in job containers (`checkJob`, `containerizeJob`): the GPU
 * through CDI, no network (or the project's allowlist through the attempt's own proxy), hidden
 * paths masked except the ones a protected evaluation mounts read-only.
 *
 * The researcher pauses, resumes and stops a session; the compute limit can pause it. When the
 * harness exits the session records what it changed (commits, files, packages, the commands its
 * transcript holds), the token is revoked and the sockets close. A restarted coordinator picks up
 * live sessions and attempts again.
 */
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  type AgentContainerInput,
  agentContainerArgs,
  CONTAINER,
  CREDENTIAL_PORT,
  claudeMcpConfig,
  cliWrapper,
  commandsInTranscripts,
  configProblems,
  DEFAULT_IMAGE,
  defaultContainerConfig,
  diffPackages,
  filesChanged,
  HARNESSES,
  hostAllowed,
  jobContainerArgs,
  type Mask,
  parseDistInfo,
  parseNameStatus,
  parsePorcelain,
  resolveConfigPath,
  shellQuote,
  within,
} from "@ablationkit/agent-containers";
import { gitCommit, readGit, readJson, writeJsonAtomic } from "@ablationkit/core";
import type {
  AttemptContainer,
  ContainerConfig,
  ContainerHarness,
  ContainerSessionRecord,
  ContainerSnapshot,
  EgressRecord,
  JobRecord,
  TokenRecord,
} from "@ablationkit/protocol";
import { validateContainerConfig, validateContainerSessionRecord } from "@ablationkit/protocol";
import type { RuntimePaths } from "../config.ts";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";
import { CredentialProxy, type EgressDecision, EgressProxy } from "./egress.ts";
import { GUARDED_PROJECT_PATHS } from "./guard.ts";
import { BinaryError, hostBinary, Podman, type RuntimeReport } from "./podman.ts";

export const CONTAINER_SESSION_RE = /^c-[a-f0-9]{12}$/;

/** Agent actions that run project code on this machine outside any container (ADR 0061). */
export const HOST_CODE_ACTIONS: ReadonlySet<string> = new Set([
  "extension.install",
  "extension.build",
  "extension.action",
  "extension.execute",
]);

const MONITOR_MS = 2_000;
/** Every this many monitor ticks, check the terminal and the container themselves. */
const DEEP_EVERY = 15;
const RUNTIME_CACHE_MS = 30_000;
const LIVE_STATES = new Set<ContainerSessionRecord["state"]>(["starting", "running", "paused"]);
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

export interface ContainerServiceOptions {
  readonly svc: () => Services;
  readonly paths: RuntimePaths;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  /** The agent API for one session's socket: only that session's token is accepted there. */
  readonly agentFetch: (tokenId: string) => (req: Request) => Promise<Response>;
  /** AblationKit's install root (this source tree). */
  readonly tree?: string;
  readonly podman?: string;
  readonly tmux?: string;
  /** The `uv` binary jobs use (the coordinator's). */
  readonly uv?: string;
  readonly monitorMs?: number;
  /** Tests: resolve egress hosts without DNS. */
  readonly resolve?: (host: string) => Promise<string[]>;
  /** Where CDI specs naming NVIDIA GPUs are looked for (tests). */
  readonly cdiSpecs?: readonly string[];
  /** How long after the compute limit refuses a job its session is paused. Default 3 s. */
  readonly pauseDelayMs?: number;
}

export interface StartInput {
  readonly harness: ContainerHarness;
  readonly label?: string;
  readonly args?: readonly string[];
  /** Binaries the researcher's shell found: the harness, uv (absolute paths on this machine). */
  readonly binaries?: { readonly harness?: string; readonly uv?: string };
  /** The Git identity commits in the container are made with (the researcher's). */
  readonly git?: { readonly name?: string; readonly email?: string };
}

export interface ContainerAccount {
  readonly session_id: string;
  readonly state: ContainerSessionRecord["state"];
  readonly harness: ContainerHarness;
  readonly harness_version?: string;
  readonly image: string;
  readonly image_id?: string;
  readonly boundary: ContainerSessionRecord["boundary"];
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly exit_code?: number;
  readonly paused: number;
  readonly egress: EgressSummary;
  readonly files_changed?: ContainerSessionRecord["files_changed"];
  readonly packages_changed?: ContainerSessionRecord["packages_changed"];
  readonly commands: { readonly count: number; readonly recent: readonly string[] };
  /** Works this session recorded, and whether it reached the work's host through the proxy. */
  readonly works: readonly {
    work_id: string;
    title: string;
    host: string;
    reached: boolean;
  }[];
}

export interface EgressSummary {
  readonly connections: number;
  readonly allowed: readonly { host: string; count: number; bytes_down: number }[];
  readonly denied: readonly { host: string; count: number; reason?: string }[];
}

interface Live {
  agent?: ReturnType<typeof Bun.serve>;
  egress?: EgressProxy;
  creds?: CredentialProxy;
  ticks: number;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The last `max` bytes of a file as text (whole lines). */
function tail(path: string, max: number): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

export class ContainerService {
  readonly podman: Podman;
  readonly tree: string;
  private readonly tmux: string;
  private readonly sessions = new Map<string, ContainerSessionRecord>();
  private readonly live = new Map<string, Live>();
  private readonly attemptProxies = new Map<string, EgressProxy>();
  private runtimeCache: { at: number; report: RuntimeReport } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly o: ContainerServiceOptions) {
    this.podman = new Podman(o.podman, o.cdiSpecs);
    this.tree = realOr(o.tree ?? resolve(import.meta.dir, "../../../.."));
    this.tmux = o.tmux ?? process.env["ABLATIONKIT_TMUX"] ?? "tmux";
    this.load();
  }

  // ------------------------------------------------------------------ paths

  private get root(): string {
    return join(this.o.paths.home, "containers");
  }

  projectDir(pid: string): string {
    return join(this.root, "projects", pid);
  }

  private configPath(pid: string): string {
    return join(this.projectDir(pid), "config.json");
  }

  sessionDir(sid: string): string {
    return join(this.root, "sessions", sid);
  }

  /** Host-only run directory of a session or attempt (its tmux socket). Kept short: socket paths. */
  runDir(id: string): string {
    return join(this.o.paths.runDir, "ct", id);
  }

  /** The part of the run directory mounted read-only into the container. */
  mountDir(id: string): string {
    return join(this.runDir(id), "m");
  }

  private egressLog(owner: string): string {
    return CONTAINER_SESSION_RE.test(owner)
      ? join(this.sessionDir(owner), "egress.jsonl")
      : join(this.root, "attempts", owner, "egress.jsonl");
  }

  private tmuxSocket(sid: string): string {
    return join(this.runDir(sid), "tmux.sock");
  }

  // ------------------------------------------------------------------ configuration

  /** The project's configuration, or the default when the researcher has not set one. */
  config(pid: string): ContainerConfig {
    try {
      return readJson(this.configPath(pid), validateContainerConfig);
    } catch (e) {
      if ((e as { kind?: string }).kind === "missing")
        return defaultContainerConfig(pid, this.o.now().toISOString());
      throw e;
    }
  }

  /** Replace the configurable fields; a new revision. The researcher's only. */
  setConfig(pid: string, body: Record<string, unknown>, by: string): ContainerConfig {
    this.o.svc().registry.require(pid);
    const saved = existsSync(this.configPath(pid));
    const cur = this.config(pid);
    const {
      schema_version: _s,
      project_id: _p,
      revision: _r,
      updated_at: _u,
      updated_by: _b,
      ...fields
    } = body;
    const next = {
      ...cur,
      ...fields,
      schema_version: 1 as const,
      project_id: pid,
      revision: saved ? cur.revision + 1 : 1,
      updated_at: this.o.now().toISOString(),
      updated_by: by,
    } as ContainerConfig;
    try {
      validateContainerConfig(next);
    } catch (e) {
      throw new HttpError(400, "invalid_container_config", (e as Error).message.slice(0, 2000));
    }
    const problems = configProblems(next);
    if (problems.length)
      throw new HttpError(400, "invalid_container_config", problems.join("; "), { problems });
    mkdirSync(this.projectDir(pid), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.configPath(pid), next, { validate: validateContainerConfig });
    this.o.svc().audit.record({
      actor: { kind: "human", id: by },
      listener: "human",
      action: "agent.container.config.set",
      outcome: "allowed",
      project_id: pid,
      target: `revision ${next.revision}`,
      details: compact({
        image: next.image,
        egress: next.egress.mode,
        allow: next.egress.allow.length,
        hidden: next.hidden.length,
        evaluations: next.evaluations.map((e) => e.name),
        credentials: next.credentials.map((c) => c.name),
        host_code: next.host_code,
      }),
    });
    return next;
  }

  /** Add hosts to the allowlist (the web UI's "Allow" on a refused connection). */
  allowHosts(pid: string, hosts: readonly string[], by: string): ContainerConfig {
    const cur = this.config(pid);
    const allow = [...cur.egress.allow];
    for (const h of hosts) if (!allow.includes(h)) allow.push(h);
    return this.setConfig(pid, { egress: { ...cur.egress, allow } }, by);
  }

  /** Is this host allowed for the project's containers (with the harness's own hosts)? */
  egressDecision(
    pid: string,
    harness: ContainerHarness | undefined,
    host: string,
    port: number,
  ): EgressDecision {
    const cfg = this.config(pid);
    if (cfg.egress.mode === "open") return { ok: true };
    const hosts = [...cfg.egress.allow, ...(harness ? HARNESSES[harness].hosts : [])];
    if (hostAllowed(hosts, host, port)) return { ok: true };
    return {
      ok: false,
      reason: `${host}:${port} is not on ${cfg.project_id}'s egress allowlist; the researcher can allow it (web UI, or \`ablationkit agent allow ${host}\`)`,
    };
  }

  // ------------------------------------------------------------------ the runtime

  runtime(fresh = false): RuntimeReport {
    const now = Date.now();
    if (!fresh && this.runtimeCache && now - this.runtimeCache.at < RUNTIME_CACHE_MS)
      return this.runtimeCache.report;
    const report = this.podman.report(this.tmux);
    this.runtimeCache = { at: now, report };
    return report;
  }

  private requireRuntime(): RuntimeReport & { binary: string; tmux: string } {
    const rt = this.runtime(true);
    if (!rt.available || !rt.binary)
      throw new HttpError(409, "container_runtime_unavailable", rt.problems.join("; "), {
        problems: rt.problems,
      });
    if (!rt.tmux)
      throw new HttpError(409, "container_runtime_unavailable", "tmux is not installed", {
        problems: rt.problems,
      });
    return rt as RuntimeReport & { binary: string; tmux: string };
  }

  private requireImage(cfg: ContainerConfig): string {
    const id = this.podman.imageId(cfg.image);
    if (id) return id;
    throw new HttpError(
      409,
      "container_image_missing",
      cfg.image === DEFAULT_IMAGE
        ? `the image ${cfg.image} is not built yet: run \`ablationkit agent image build\``
        : `the image ${cfg.image} is not on this machine: \`podman pull ${cfg.image}\` (or build it)`,
    );
  }

  private bun(): string {
    try {
      return hostBinary(process.execPath, "bun");
    } catch (e) {
      throw new HttpError(500, "container_runtime_unavailable", (e as Error).message);
    }
  }

  private uv(given?: string): string | undefined {
    const candidates = [
      given,
      this.o.uv,
      process.env["ABLATIONKIT_UV"],
      Bun.which("uv") ?? undefined,
    ];
    for (const c of candidates) {
      if (!c) continue;
      try {
        return hostBinary(c.startsWith("/") ? c : (Bun.which(c) ?? c), "uv");
      } catch {
        // Try the next one: a shim, or a relative name not on this PATH.
      }
    }
    return undefined;
  }

  // ------------------------------------------------------------------ what a container cannot see

  /**
   * Paths under the checkout or AblationKit's tree that a container must not see: the
   * coordinator-owned parts of `.ablationkit/`, the configured hidden paths (except `except`: a
   * protected evaluation's mounts), and the coordinator's home should it sit inside either.
   */
  masks(checkout: string, cfg: ContainerConfig, except: readonly string[] = []): Mask[] {
    const roots = [checkout, this.tree];
    const out = new Map<string, Mask>();
    const add = (p: string) => {
      if (except.includes(p) || !roots.some((r) => within(r, p)) || !exists(p)) return;
      out.set(p, { path: p, kind: isDir(p) ? "dir" : "file" });
    };
    for (const g of GUARDED_PROJECT_PATHS) add(join(checkout, g));
    for (const h of cfg.hidden) add(resolveConfigPath(checkout, h));
    add(realOr(this.o.paths.home));
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  // ------------------------------------------------------------------ sessions

  private load(): void {
    const dir = join(this.root, "sessions");
    if (!existsSync(dir)) return;
    for (const sid of readdirSync(dir)) {
      if (!CONTAINER_SESSION_RE.test(sid)) continue;
      try {
        this.sessions.set(
          sid,
          readJson(join(dir, sid, "session.json"), validateContainerSessionRecord),
        );
      } catch (e) {
        this.o.log(`container session ${sid}: ${(e as Error).message}`);
      }
    }
  }

  private save(s: ContainerSessionRecord): ContainerSessionRecord {
    writeJsonAtomic(join(this.sessionDir(s.session_id), "session.json"), s, {
      validate: validateContainerSessionRecord,
      backup: false,
    });
    this.sessions.set(s.session_id, s);
    this.o.svc().events.publish(s.project_id, "agent.container.state", {
      session_id: s.session_id,
      state: s.state,
      token_id: s.token_id,
    });
    return s;
  }

  list(pid?: string): ContainerSessionRecord[] {
    return [...this.sessions.values()]
      .filter((s) => !pid || s.project_id === pid)
      .sort(
        (a, b) =>
          Number(LIVE_STATES.has(b.state)) - Number(LIVE_STATES.has(a.state)) ||
          b.created_at.localeCompare(a.created_at),
      );
  }

  get(sid: string): ContainerSessionRecord | undefined {
    return this.sessions.get(sid);
  }

  require(sid: string): ContainerSessionRecord {
    const s = CONTAINER_SESSION_RE.test(sid) ? this.sessions.get(sid) : undefined;
    if (!s) throw new HttpError(404, "container_session_not_found", `no agent container ${sid}`);
    return s;
  }

  forToken(tokenId: string): ContainerSessionRecord | undefined {
    for (const s of this.sessions.values()) if (s.token_id === tokenId) return s;
    return undefined;
  }

  /** The researcher's terminal command to attach to a live session. */
  attachCommand(sid: string): string[] {
    return [
      this.runtime().tmux ?? this.tmux,
      "-S",
      this.tmuxSocket(sid),
      "attach-session",
      "-t",
      "agent",
    ];
  }

  async start(pid: string, input: StartInput, by: string): Promise<ContainerSessionRecord> {
    const svc = this.o.svc();
    const project = svc.registry.require(pid);
    const checkout = realOr(project.path);
    const spec = HARNESSES[input.harness];
    if (!spec)
      throw new HttpError(400, "invalid_request", `unknown harness ${String(input.harness)}`);
    if (!existsSync(this.configPath(pid))) {
      // The project's first container: its default configuration becomes revision 1, on record.
      mkdirSync(this.projectDir(pid), { recursive: true, mode: 0o700 });
      writeJsonAtomic(this.configPath(pid), this.config(pid), {
        validate: validateContainerConfig,
      });
    }
    const cfg = this.config(pid);
    const problems = configProblems(cfg);
    if (problems.length)
      throw new HttpError(409, "invalid_container_config", problems.join("; "), { problems });
    const rt = this.requireRuntime();
    const imageId = this.requireImage(cfg);
    let harnessBin: string | undefined;
    try {
      if (spec.binary) {
        const given = input.binaries?.harness ?? Bun.which(spec.binary) ?? undefined;
        if (!given)
          throw new BinaryError(
            `${spec.binary} was not found: give its path (\`ablationkit agent start --harness-binary PATH\`)`,
          );
        harnessBin = hostBinary(given, spec.binary);
      }
    } catch (e) {
      throw new HttpError(409, "harness_binary", (e as Error).message);
    }
    const uv = this.uv(input.binaries?.uv);
    const bun = this.bun();
    const sid = `c-${randomBytes(6).toString("hex")}`;
    const label = (input.label ?? `${input.harness} in a container`).slice(0, 200);
    const args = [...(input.args ?? [])].slice(0, 64);

    // Directories: the session's record, the run directory (host-only and mounted), the agent's
    // home for this project and harness, and the project's environment volumes.
    mkdirSync(this.sessionDir(sid), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.mountDir(sid), "bin"), { recursive: true, mode: 0o700 });
    chmodSync(this.runDir(sid), 0o700);
    const pdir = this.projectDir(pid);
    const home = join(pdir, `home-${input.harness}`);
    const dirs = {
      run: this.mountDir(sid),
      home,
      env: join(pdir, "env"),
      uvCache: join(pdir, "uv-cache"),
      python: join(pdir, "python"),
    };
    for (const d of [home, dirs.env, dirs.uvCache, dirs.python])
      mkdirSync(d, { recursive: true, mode: 0o700 });
    this.prepareHome(home, input);

    const minted = svc.agentSessions.begin({
      project_id: pid,
      harness: input.harness,
      label,
      cwd: checkout,
      container_session: sid,
    });
    const mount = this.mountDir(sid);
    writeFileSync(join(mount, "token"), `${minted.token}\n`, { mode: 0o600 });
    writeFileSync(join(mount, "mcp.json"), `${JSON.stringify(claudeMcpConfig(), null, 2)}\n`, {
      mode: 0o600,
    });
    writeFileSync(join(mount, "bin", "ablationkit"), cliWrapper(this.tree), { mode: 0o755 });

    const readOnly = cfg.read_only
      .map((p) => resolveConfigPath(checkout, p))
      .filter((p) => exists(p) && within(checkout, p));
    const masks = this.masks(checkout, cfg);
    const credEnv: Record<string, string> = {};
    for (const c of cfg.credentials)
      for (const [k, v] of Object.entries(c.env))
        credEnv[k] = v.replaceAll("{url}", `http://127.0.0.1:${CREDENTIAL_PORT}/${c.name}`);

    const now = this.o.now().toISOString();
    let rec: ContainerSessionRecord = {
      schema_version: 1,
      session_id: sid,
      project_id: pid,
      token_id: minted.record.token_id,
      harness: input.harness,
      label,
      args,
      checkout,
      container: `ak-agent-${sid}`,
      image: cfg.image,
      image_id: imageId.slice(0, 200),
      ...(harnessBin ? this.harnessVersion(harnessBin) : {}),
      config_revision: cfg.revision,
      state: "starting",
      started_by: by,
      created_at: now,
      supervisor: { mode: "direct" },
      boundary: {
        gpu: false,
        network: "none",
        egress: cfg.egress.mode,
        hidden: masks.map((m) => m.path).slice(0, 128),
        read_only: readOnly.slice(0, 128),
        cpus: cfg.agent.cpus,
        memory_mb: cfg.agent.memory_mb,
        pids_max: cfg.agent.pids_max,
      },
      start: this.snapshot(checkout, dirs.env),
      control: [],
    };
    this.save(rec);

    try {
      // The sockets are bound before the container starts: its init forwards to them.
      await this.listen(rec);
      const plan: AgentContainerInput = {
        sessionId: sid,
        projectId: pid,
        image: cfg.image,
        checkout,
        tree: this.tree,
        tools: { bun, ...(uv ? { uv } : {}), ...(harnessBin ? { harness: harnessBin } : {}) },
        dirs,
        limits: cfg.agent,
        masks,
        readOnly,
        harness: input.harness,
        args,
        env: credEnv,
      };
      const argv = [rt.binary, ...agentContainerArgs(plan)];
      const script = join(this.sessionDir(sid), "launch.sh");
      const exitFile = join(this.sessionDir(sid), "exit");
      const errLog = join(this.sessionDir(sid), "podman.log");
      writeFileSync(
        script,
        [
          "#!/bin/sh",
          "# Written by the AblationKit coordinator for one agent container session (ADR 0061).",
          `${argv.map(shellQuote).join(" ")} 2>>${shellQuote(errLog)}`,
          `echo $? > ${shellQuote(`${exitFile}.tmp`)} && mv ${shellQuote(`${exitFile}.tmp`)} ${shellQuote(exitFile)}`,
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const supervisor = this.launchTerminal(sid, rt.tmux, script);
      rec = this.save({
        ...rec,
        state: "running",
        started_at: this.o.now().toISOString(),
        supervisor,
      });
    } catch (e) {
      this.finalize(rec, { error: `could not start: ${(e as Error).message}` });
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, "container_start_failed", (e as Error).message.slice(0, 2000));
    }
    svc.audit.record({
      actor: { kind: "human", id: by },
      listener: "human",
      action: "agent.container.start",
      outcome: "allowed",
      project_id: pid,
      target: sid,
      details: compact({
        harness: input.harness,
        image: cfg.image,
        image_id: imageId.slice(0, 80),
        token_id: rec.token_id,
        config_revision: cfg.revision,
        hidden: masks.length,
        read_only: readOnly.length,
        egress: cfg.egress.mode,
      }),
    });
    return rec;
  }

  private harnessVersion(bin: string): { harness_version?: string } {
    try {
      const p = Bun.spawnSync([bin, "--version"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      });
      const v = p.stdout.toString().trim().split("\n")[0]?.slice(0, 200);
      return v ? { harness_version: v } : {};
    } catch {
      return {};
    }
  }

  /**
   * The agent's home: AblationKit's paths on a login shell's PATH (a login shell's /etc/profile
   * resets it), the researcher's Git identity, and AblationKit's Agent Skills linked in.
   */
  private prepareHome(home: string, input: StartInput): void {
    const profile = join(home, ".profile");
    let text = "";
    try {
      text = readFileSync(profile, "utf8");
    } catch {
      // A new home.
    }
    if (!text.includes(`${CONTAINER.run}/bin`))
      appendFileSync(
        profile,
        `${text && !text.endsWith("\n") ? "\n" : ""}# Written by AblationKit (ADR 0061): a login shell's /etc/profile resets PATH.\nexport PATH="${CONTAINER.run}/bin:${CONTAINER.bin}:$PATH"\n[ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n`,
        { mode: 0o600 },
      );
    const gitconfig = join(home, ".gitconfig");
    if (!existsSync(gitconfig) && (input.git?.name || input.git?.email)) {
      const clean = (s: string) => s.replace(/[\r\n"\\]/g, "").slice(0, 200);
      writeFileSync(
        gitconfig,
        `[user]\n${input.git.name ? `\tname = ${clean(input.git.name)}\n` : ""}${input.git.email ? `\temail = ${clean(input.git.email)}\n` : ""}`,
        { mode: 0o600 },
      );
    }
    const skillsDir = HARNESSES[input.harness].skillsDir;
    const skills = join(this.tree, "skills");
    if (!skillsDir || !isDir(skills)) return;
    const into = join(home, skillsDir);
    mkdirSync(into, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(skills)) {
      const dst = join(into, name);
      if (exists(dst)) continue;
      try {
        symlinkSync(realOr(join(skills, name)), dst);
      } catch {
        // A skill the agent's home already has differently: keep the agent's.
      }
    }
  }

  /** Start the session's sockets: the agent API, the egress proxy, the credential routes. */
  private async listen(s: ContainerSessionRecord): Promise<void> {
    const mount = this.mountDir(s.session_id);
    const live: Live = { ticks: 0 };
    this.live.set(s.session_id, live);
    const agentSock = join(mount, "agent.sock");
    rmSync(agentSock, { force: true });
    live.agent = Bun.serve({
      unix: agentSock,
      maxRequestBodySize: 2 * 1024 * 1024,
      fetch: this.o.agentFetch(s.token_id),
    });
    chmodSync(agentSock, 0o600);
    const record = (r: EgressRecord) => this.recordEgress(r);
    live.egress = new EgressProxy({
      socket: join(mount, "egress.sock"),
      owner: s.session_id,
      allowed: (host, port) => this.egressDecision(s.project_id, s.harness, host, port),
      record,
      now: this.o.now,
      ...(this.o.resolve ? { resolve: this.o.resolve } : {}),
    });
    await live.egress.start();
    if (this.config(s.project_id).credentials.length) {
      live.creds = new CredentialProxy({
        socket: join(mount, "creds.sock"),
        owner: s.session_id,
        credentials: () => this.config(s.project_id).credentials,
        record,
        now: this.o.now,
      });
      live.creds.start();
    }
  }

  private unlisten(sid: string): void {
    const live = this.live.get(sid);
    if (!live) return;
    void live.agent?.stop(true);
    live.egress?.stop();
    live.creds?.stop();
    this.live.delete(sid);
  }

  /** Run `script` in a tmux server of the session's own, outliving the coordinator. */
  private launchTerminal(
    sid: string,
    tmux: string,
    script: string,
  ): ContainerSessionRecord["supervisor"] {
    const argv = [
      tmux,
      "-S",
      this.tmuxSocket(sid),
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "agent",
      "-x",
      "200",
      "-y",
      "50",
      "/bin/sh",
      script,
    ];
    const env: Record<string, string> = {};
    for (const k of [
      "PATH",
      "HOME",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "LANG",
      "USER",
    ]) {
      const v = process.env[k];
      if (v) env[k] = v;
    }
    env["TERM"] = "xterm-256color";
    const mode = this.o.svc().jobs.probe().mode;
    if (mode === "systemd") {
      const unit = `ak-agent-${sid}`;
      const p = Bun.spawnSync(
        [
          "systemd-run",
          "--user",
          "--quiet",
          "--collect",
          `--unit=${unit}`,
          "--property=Type=forking",
          `--working-directory=${this.sessionDir(sid)}`,
          ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`),
          "--",
          ...argv,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 },
      );
      if (p.exitCode !== 0)
        throw new Error(`systemd-run failed: ${p.stderr.toString().trim().slice(0, 500)}`);
      return { mode: "systemd", unit: `${unit}.service` };
    }
    const p = Bun.spawnSync(argv, {
      cwd: this.sessionDir(sid),
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    if (p.exitCode !== 0)
      throw new Error(`tmux failed: ${p.stderr.toString().trim().slice(0, 500)}`);
    return { mode: "direct" };
  }

  private tmuxAlive(sid: string): boolean {
    const p = Bun.spawnSync(
      [this.runtime().tmux ?? this.tmux, "-S", this.tmuxSocket(sid), "has-session", "-t", "agent"],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 10_000,
      },
    );
    return p.exitCode === 0;
  }

  /** What the agent's terminal shows now (text, no colours). */
  screen(sid: string): { session_id: string; state: string; text: string; captured_at: string } {
    const s = this.require(sid);
    let text = "";
    if (LIVE_STATES.has(s.state)) {
      const p = Bun.spawnSync(
        [
          this.runtime().tmux ?? this.tmux,
          "-S",
          this.tmuxSocket(sid),
          "capture-pane",
          "-p",
          "-J",
          "-t",
          "agent",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 },
      );
      text = p.exitCode === 0 ? p.stdout.toString() : "";
    }
    return {
      session_id: sid,
      state: s.state,
      text: text.replace(/\s+$/, ""),
      captured_at: this.o.now().toISOString(),
    };
  }

  private control(
    s: ContainerSessionRecord,
    action: "pause" | "resume" | "stop",
    by: string,
    reason?: string,
  ): ContainerSessionRecord["control"] {
    return [
      ...s.control,
      compact({ at: this.o.now().toISOString(), action, by, reason: reason?.slice(0, 500) }),
    ].slice(-1000) as ContainerSessionRecord["control"];
  }

  private audit(s: ContainerSessionRecord, action: string, by: string, reason?: string): void {
    this.o.svc().audit.record({
      actor: by === "system" ? { kind: "system" } : { kind: "human", id: by },
      listener: by === "system" ? "internal" : "human",
      action,
      outcome: "allowed",
      project_id: s.project_id,
      target: s.session_id,
      ...(reason ? { reason: reason.slice(0, 1024) } : {}),
    });
  }

  /** Freeze the container (its processes stop where they are). */
  pause(
    sid: string,
    by: string,
    reason?: string,
    cause: "researcher" | "compute_limit" = "researcher",
  ): ContainerSessionRecord {
    const s = this.require(sid);
    if (s.state !== "running")
      throw new HttpError(409, "container_not_running", `${sid} is ${s.state}, not running`);
    const r = this.podman.pause(s.container);
    if (r.code !== 0)
      throw new HttpError(
        502,
        "container_runtime_error",
        r.stderr.trim().slice(0, 1000) || "podman pause failed",
      );
    const next = this.save({
      ...s,
      state: "paused",
      paused_by: cause,
      control: this.control(s, "pause", by, reason),
    });
    this.audit(next, "agent.container.pause", by, reason);
    return next;
  }

  resume(sid: string, by: string): ContainerSessionRecord {
    const s = this.require(sid);
    if (s.state !== "paused")
      throw new HttpError(409, "container_not_paused", `${sid} is ${s.state}, not paused`);
    const r = this.podman.unpause(s.container);
    if (r.code !== 0)
      throw new HttpError(
        502,
        "container_runtime_error",
        r.stderr.trim().slice(0, 1000) || "podman unpause failed",
      );
    const { paused_by: _p, ...rest } = s;
    const next = this.save({ ...rest, state: "running", control: this.control(s, "resume", by) });
    this.audit(next, "agent.container.resume", by);
    return next;
  }

  /** Stop the container; the session ends when the harness has exited (the monitor sees it). */
  stop(sid: string, by: string, reason?: string): ContainerSessionRecord {
    const s = this.require(sid);
    if (!LIVE_STATES.has(s.state))
      throw new HttpError(409, "container_not_live", `${sid} has already ended (${s.state})`);
    if (s.state === "paused") this.podman.unpause(s.container);
    const next = this.save({ ...s, control: this.control(s, "stop", by, reason) });
    this.audit(next, "agent.container.stop", by, reason);
    this.stopContainer(s.container);
    return next;
  }

  /** `podman stop`, without waiting; the monitor looks at once when it returns. */
  private stopContainer(name: string): void {
    const bin = this.runtime().binary ?? this.podman.bin;
    const p = Bun.spawn([bin, "stop", "--time", "10", name], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    void p.exited.then(() => this.tick());
  }

  /** The compute limit refused this session's job: freeze it, if the project says so. */
  computeLimitRefused(token: TokenRecord): void {
    const sid = token.agent_session?.container_session;
    if (!sid) return;
    const s = this.sessions.get(sid);
    if (s?.state !== "running" || !this.config(s.project_id).pause_on_compute_limit) return;
    // A moment later, so the refusal reaches the agent before it is frozen.
    const t = setTimeout(() => {
      try {
        if (this.sessions.get(sid)?.state === "running")
          this.pause(sid, "system", "the compute limit refused its job", "compute_limit");
      } catch (e) {
        this.o.log(`agent container ${sid}: pause at the compute limit: ${(e as Error).message}`);
      }
    }, this.o.pauseDelayMs ?? 3_000);
    t.unref?.();
  }

  /** Is this agent action refused because it would run project code outside a container? */
  hostCodeRefused(token: TokenRecord, action: string): boolean {
    const pid = token.scope.project_id;
    return (
      token.agent_session?.container_session !== undefined &&
      pid !== undefined &&
      HOST_CODE_ACTIONS.has(action) &&
      this.config(pid).host_code === "refuse"
    );
  }

  // ------------------------------------------------------------------ the monitor

  startMonitor(): void {
    this.recover();
    this.timer = setInterval(() => this.tick(), this.o.monitorMs ?? MONITOR_MS);
    this.timer.unref?.();
  }

  stopAll(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const sid of [...this.live.keys()]) this.unlisten(sid);
    for (const p of this.attemptProxies.values()) p.stop();
    this.attemptProxies.clear();
  }

  /**
   * After a restart: live sessions get their sockets back (their containers kept running), the
   * ones that ended meanwhile are finalized; live attempts get their egress proxy back.
   */
  recover(): void {
    for (const s of this.sessions.values()) {
      if (!LIVE_STATES.has(s.state) || this.live.has(s.session_id)) continue;
      if (existsSync(join(this.sessionDir(s.session_id), "exit"))) {
        this.tick();
        continue;
      }
      if (s.state === "starting" || !this.tmuxAlive(s.session_id)) {
        this.finalize(s, { lost: true });
        continue;
      }
      void this.listen(s).catch((e) =>
        this.o.log(`agent container ${s.session_id}: sockets: ${(e as Error).message}`),
      );
    }
    const ct = join(this.o.paths.runDir, "ct");
    if (!existsSync(ct)) return;
    for (const id of readdirSync(ct)) {
      if (CONTAINER_SESSION_RE.test(id)) {
        if (!LIVE_STATES.has(this.sessions.get(id)?.state ?? "lost"))
          rmSync(this.runDir(id), { recursive: true, force: true });
        continue;
      }
      const a = this.o.svc().jobs.attempt(id);
      const job = a ? this.o.svc().jobs.get(a.job_id) : undefined;
      if (
        a &&
        job &&
        !["succeeded", "failed", "cancelled", "timed_out", "lost", "unknown"].includes(a.state)
      ) {
        if (a.supervisor.container?.network === "egress") this.attemptEgress(job, id);
      } else rmSync(this.runDir(id), { recursive: true, force: true });
    }
  }

  /** One pass: sessions whose harness exited, or whose terminal is gone, are finalized. */
  tick(): void {
    for (const s of [...this.sessions.values()]) {
      if (!LIVE_STATES.has(s.state)) continue;
      const exitFile = join(this.sessionDir(s.session_id), "exit");
      if (existsSync(exitFile)) {
        const code = Number.parseInt(readFileSync(exitFile, "utf8").trim(), 10);
        this.finalize(s, { exit: Number.isInteger(code) ? code : -1 });
        continue;
      }
      const live = this.live.get(s.session_id);
      if (!live) continue;
      live.ticks++;
      // While the container lives its session does not go idle (a paused or thinking agent).
      const t = this.o.svc().tokens.get(s.token_id);
      if (t) this.o.svc().tokens.touch(t);
      if (live.ticks % DEEP_EVERY !== 0) continue;
      if (!this.tmuxAlive(s.session_id)) {
        if (this.podman.status(s.container) !== "missing") this.podman.stop(s.container, 5);
        this.finalize(s, { lost: true });
        continue;
      }
      // A stop asked for while the container was still starting found nothing: ask again.
      if (s.control.at(-1)?.action === "stop") this.stopContainer(s.container);
    }
  }

  private finalize(
    s: ContainerSessionRecord,
    how: { exit?: number; lost?: boolean; error?: string },
  ): void {
    const svc = this.o.svc();
    this.unlisten(s.session_id);
    const envDir = join(this.projectDir(s.project_id), "env");
    const end = this.snapshot(s.checkout, envDir);
    const startHead = s.start?.head;
    const committed =
      startHead && end.head && startHead !== end.head
        ? parseNameStatus(
            readGit(s.checkout, [
              "diff",
              "--name-status",
              "-z",
              startHead,
              end.head,
              ...this.excludes(),
            ]).stdout,
          )
        : [];
    const endStatus = parsePorcelain(this.porcelain(s.checkout));
    const changes = filesChanged(committed, s.start?.dirty ?? [], endStatus).slice(0, 2000);
    const pk = diffPackages(s.start?.packages ?? [], end.packages);
    const endedAt = this.o.now().toISOString();
    const commands = this.commands(s, endedAt);
    const errLog = tail(join(this.sessionDir(s.session_id), "podman.log"), 4000).trim();
    // Podman's own failures are 125 (Podman), 126 (cannot run) and 127 (not found); 128 + n is a
    // signal, which is how a stopped container ends.
    const stopped = s.control.some((c) => c.action === "stop");
    const failed =
      how.error !== undefined ||
      (!stopped && how.exit !== undefined && how.exit >= 125 && how.exit <= 127);
    const state: ContainerSessionRecord["state"] = how.lost ? "lost" : failed ? "failed" : "exited";
    const error = how.error ?? (failed && errLog ? errLog.slice(-2000) : undefined);
    const { paused_by: _p, ...rest } = s;
    this.save(
      compact({
        ...rest,
        state,
        ended_at: endedAt,
        exit_code: how.exit,
        error,
        end,
        files_changed: changes,
        packages_changed: {
          added: pk.added.slice(0, 2000),
          removed: pk.removed.slice(0, 2000),
          changed: pk.changed.slice(0, 2000),
        },
        commands,
      }) as ContainerSessionRecord,
    );
    // The token ends with the container; its files and sockets go.
    if (svc.tokens.get(s.token_id)?.revoked_at === undefined) {
      svc.tokens.revoke(s.token_id, `agent container ${state}`);
      svc.audit.record({
        actor: { kind: "system" },
        listener: "internal",
        action: "auth.agent_session.end",
        outcome: "allowed",
        project_id: s.project_id,
        target: s.token_id,
        reason: `agent container ${s.session_id} ${state}`,
      });
    }
    rmSync(this.runDir(s.session_id), { recursive: true, force: true });
    svc.audit.record({
      actor: { kind: "system" },
      listener: "internal",
      action: "agent.container.end",
      outcome: state === "exited" ? "allowed" : "error",
      project_id: s.project_id,
      target: s.session_id,
      details: compact({
        state,
        exit_code: how.exit,
        files_changed: changes.length,
        packages_added: pk.added.length,
        commands: commands.length,
      }),
      ...(error ? { reason: error.slice(0, 1024) } : {}),
    });
  }

  // ------------------------------------------------------------------ provenance

  private excludes(): string[] {
    return ["--", ":/", ...GUARDED_PROJECT_PATHS.map((p) => `:(exclude)${p}`)];
  }

  private porcelain(checkout: string): string {
    return readGit(checkout, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      ...this.excludes(),
    ]).stdout;
  }

  private packages(envDir: string): { name: string; version: string }[] {
    const out: { name: string; version: string }[] = [];
    const lib = join(envDir, "lib");
    if (!isDir(lib)) return out;
    for (const py of readdirSync(lib)) {
      const site = join(lib, py, "site-packages");
      if (!py.startsWith("python") || !isDir(site)) continue;
      for (const e of readdirSync(site)) {
        const p = parseDistInfo(e);
        if (p) out.push(p);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 5000);
  }

  private snapshot(checkout: string, envDir: string): ContainerSnapshot {
    const head = gitCommit(checkout);
    return {
      at: this.o.now().toISOString(),
      ...(head ? { head } : {}),
      dirty: parsePorcelain(this.porcelain(checkout))
        .map((c) => c.path.slice(0, 4096))
        .slice(0, 500),
      packages: this.packages(envDir),
    };
  }

  /** Shell commands in the harness's transcripts written during the session. */
  private commands(s: ContainerSessionRecord, until: string): { at?: string; command: string }[] {
    const home = join(this.projectDir(s.project_id), `home-${s.harness}`);
    const roots =
      s.harness === "claude-code"
        ? [join(home, ".claude", "projects")]
        : s.harness === "codex"
          ? [join(home, ".codex", "sessions")]
          : [];
    const since = Date.parse(s.created_at);
    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 5 || files.length > 2000) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e);
        let st: ReturnType<typeof statSync>;
        try {
          st = lstatSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(p, depth + 1);
        else if (st.isFile() && e.endsWith(".jsonl") && st.mtimeMs >= since) files.push(p);
      }
    };
    for (const r of roots) walk(r, 0);
    let budget = MAX_TRANSCRIPT_BYTES;
    const lines: string[] = [];
    for (const f of files) {
      if (budget <= 0) break;
      const text = tail(f, Math.min(budget, 8 * 1024 * 1024));
      budget -= text.length;
      for (const l of text.split("\n")) if (l) lines.push(l);
    }
    return commandsInTranscripts(lines, s.created_at, until, 1000).map((c) =>
      compact({ at: c.at, command: c.command }),
    ) as { at?: string; command: string }[];
  }

  // ------------------------------------------------------------------ egress

  private recordEgress(r: EgressRecord): void {
    const path = this.egressLog(r.owner);
    try {
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
      appendFileSync(path, `${JSON.stringify(r)}\n`, { mode: 0o600 });
    } catch (e) {
      this.o.log(`egress record for ${r.owner}: ${(e as Error).message}`);
    }
  }

  /** The connections a session or attempt made, newest last. */
  egress(
    owner: string,
    opts: { limit?: number; outcome?: EgressRecord["outcome"] } = {},
  ): EgressRecord[] {
    const text = tail(this.egressLog(owner), 4 * 1024 * 1024);
    const out: EgressRecord[] = [];
    for (const l of text.split("\n")) {
      if (!l) continue;
      try {
        const r = JSON.parse(l) as EgressRecord;
        if (!opts.outcome || r.outcome === opts.outcome) out.push(r);
      } catch {
        // A torn last line.
      }
    }
    return out.slice(-(opts.limit ?? 500));
  }

  egressSummary(owner: string): EgressSummary {
    const all = this.egress(owner, { limit: 100_000 });
    const allowed = new Map<string, { host: string; count: number; bytes_down: number }>();
    const denied = new Map<string, { host: string; count: number; reason?: string }>();
    for (const r of all) {
      if (r.outcome === "denied") {
        const d = denied.get(r.host) ?? compact({ host: r.host, count: 0, reason: r.reason });
        d.count++;
        denied.set(r.host, d as { host: string; count: number; reason?: string });
      } else {
        const a = allowed.get(r.host) ?? { host: r.host, count: 0, bytes_down: 0 };
        a.count++;
        a.bytes_down += r.bytes_down ?? 0;
        allowed.set(r.host, a);
      }
    }
    const byCount = (x: { count: number }, y: { count: number }) => y.count - x.count;
    return {
      connections: all.length,
      allowed: [...allowed.values()].sort(byCount),
      denied: [...denied.values()].sort(byCount),
    };
  }

  // ------------------------------------------------------------------ job containers

  /** Is this job one a contained session submitted, to run on this machine? */
  contained(job: JobRecord): boolean {
    return job.container !== undefined && job.target_id === undefined;
  }

  /**
   * Before a contained job's attempt starts: the runtime, the image, the GPU and the evaluation it
   * names are there. A refusal here comes back to the submitter; nothing has started.
   */
  checkJob(job: JobRecord): void {
    if (!this.contained(job)) return;
    const cfg = this.config(job.project_id);
    const rt = this.requireRuntime();
    this.requireImage(cfg);
    if (cfg.jobs.gpu === "all" && !job.container?.evaluation && !rt.gpu_cdi)
      throw new HttpError(
        409,
        "container_gpu_unavailable",
        "no CDI spec names this machine's NVIDIA GPUs: generate one (`sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`), or set the project's jobs.gpu to none",
      );
    const name = job.container?.evaluation;
    if (name && !cfg.evaluations.some((e) => e.name === name))
      throw new HttpError(
        404,
        "evaluation_not_found",
        `the project has no protected evaluation ${name}`,
      );
    if (job.environment === "uv" && !this.uv())
      throw new HttpError(
        409,
        "container_runtime_unavailable",
        "uv was not found on this machine as a binary to mount into the job container (set ABLATIONKIT_UV)",
      );
  }

  /** The Podman command an attempt of a contained job runs as, and what it was given. */
  containerizeJob(
    job: JobRecord,
    a: {
      readonly attemptId: string;
      readonly spool: string;
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    },
  ): { argv: string[]; container: AttemptContainer } {
    const svc = this.o.svc();
    const cfg = this.config(job.project_id);
    // `checkJob` looked just before: the cached report is current.
    const rt = this.runtime();
    if (!rt.binary)
      throw new HttpError(409, "container_runtime_unavailable", rt.problems.join("; "));
    const imageId = this.requireImage(cfg);
    const checkout = realOr(svc.registry.require(job.project_id).path);
    const evaluation = job.container?.evaluation
      ? cfg.evaluations.find((e) => e.name === job.container?.evaluation)
      : undefined;
    const evalMounts = (evaluation?.mounts ?? [])
      .map((m) => resolveConfigPath(checkout, m))
      .filter(exists);
    const pdir = this.projectDir(job.project_id);
    const dirs = {
      env: join(pdir, "env"),
      uvCache: join(pdir, "uv-cache"),
      python: join(pdir, "python"),
      spool: a.spool,
    };
    for (const d of [dirs.env, dirs.uvCache, dirs.python])
      mkdirSync(d, { recursive: true, mode: 0o700 });
    const uv = this.uv();
    // The job's argv: `uv` is the mounted one inside.
    const argv =
      job.environment === "uv"
        ? [`${CONTAINER.bin}/uv`, "run", "--frozen", "--project", checkout, "--", ...job.command]
        : [...a.argv];
    if (job.environment === "uv" && !uv)
      throw new HttpError(
        409,
        "container_runtime_unavailable",
        "uv was not found on this machine for the job container",
      );
    // Directories the SDK paths name that are neither the tree nor the checkout.
    const extraReadOnly = (a.env["PYTHONPATH"] ?? "").split(":").filter(
      (p) =>
        p.startsWith("/") &&
        !within(this.tree, p) &&
        !within(checkout, p) &&
        // Never the coordinator's home or a directory above it.
        !within(p, realOr(this.o.paths.home)) &&
        isDir(p),
    );
    const network = evaluation ? "none" : cfg.jobs.network;
    let run: string | undefined;
    if (network === "egress") run = this.attemptEgress(job, a.attemptId);
    const name = `ak-job-${a.attemptId}`;
    const args = jobContainerArgs({
      name,
      image: cfg.image,
      checkout,
      tree: this.tree,
      tools: { bun: this.bun(), ...(uv ? { uv } : {}) },
      dirs: { ...dirs, ...(run ? { run } : {}) },
      extraReadOnly,
      masks: this.masks(checkout, cfg, evalMounts),
      evaluationMounts: evalMounts,
      gpu: cfg.jobs.gpu === "all" && rt.gpu_cdi ? "all" : "none",
      network,
      limits: job.limits,
      env: a.env,
      cwd: a.cwd,
      argv,
    });
    return {
      argv: [rt.binary, ...args],
      container: {
        name,
        image: cfg.image,
        image_id: imageId.slice(0, 200),
        gpu: cfg.jobs.gpu === "all" && rt.gpu_cdi ? "all" : "none",
        network,
        mounts: evalMounts.slice(0, 64),
      },
    };
  }

  /** Start an attempt's egress proxy; returns the directory to mount. */
  private attemptEgress(job: JobRecord, attemptId: string): string {
    const mount = this.mountDir(attemptId);
    mkdirSync(mount, { recursive: true, mode: 0o700 });
    this.attemptProxies.get(attemptId)?.stop();
    const proxy = new EgressProxy({
      socket: join(mount, "egress.sock"),
      owner: attemptId,
      allowed: (host, port) => this.egressDecision(job.project_id, undefined, host, port),
      record: (r) => this.recordEgress(r),
      now: this.o.now,
      ...(this.o.resolve ? { resolve: this.o.resolve } : {}),
    });
    this.attemptProxies.set(attemptId, proxy);
    void proxy
      .start()
      .catch((e) => this.o.log(`attempt ${attemptId}: egress proxy: ${(e as Error).message}`));
    return mount;
  }

  /** A contained attempt ended: its proxy and run directory go, its container is removed. */
  attemptEnded(attemptId: string, container: string | undefined): void {
    this.attemptProxies.get(attemptId)?.stop();
    this.attemptProxies.delete(attemptId);
    rmSync(this.runDir(attemptId), { recursive: true, force: true });
    if (!container) return;
    const bin = this.runtime().binary;
    if (!bin) return;
    // An attempt whose Podman client was killed leaves its container behind: remove it.
    void Bun.spawn([bin, "rm", "--force", "--ignore", container], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).exited.catch(() => undefined);
  }

  /** Cancelling a contained attempt also stops its container (the client may not pass it on). */
  attemptCancelled(container: string | undefined): void {
    const bin = this.runtime().binary;
    if (!container || !bin) return;
    void Bun.spawn([bin, "stop", "--time", "15", container], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).exited.catch(() => undefined);
  }

  // ------------------------------------------------------------------ the session's account

  account(tokenId: string): ContainerAccount | undefined {
    const s = this.forToken(tokenId);
    if (!s) return undefined;
    const egress = this.egressSummary(s.session_id);
    const reached = new Set(egress.allowed.map((a) => a.host));
    let works: ContainerAccount["works"] = [];
    try {
      works = this.o
        .svc()
        .vault.allWorks(s.project_id)
        .filter((w) => w.created_by.kind === "agent" && w.created_by.id === tokenId && w.url)
        .map((w) => {
          const host = new URL(w.url as string).hostname.toLowerCase();
          return { work_id: w.work_id, title: w.title, host, reached: reached.has(host) };
        });
    } catch {
      works = [];
    }
    return compact({
      session_id: s.session_id,
      state: s.state,
      harness: s.harness,
      harness_version: s.harness_version,
      image: s.image,
      image_id: s.image_id,
      boundary: s.boundary,
      started_at: s.started_at,
      ended_at: s.ended_at,
      exit_code: s.exit_code,
      paused: s.control.filter((c) => c.action === "pause").length,
      egress,
      files_changed: s.files_changed,
      packages_changed: s.packages_changed,
      commands: {
        count: s.commands?.length ?? 0,
        recent: (s.commands ?? []).slice(-20).map((c) => c.command),
      },
      works,
    }) as ContainerAccount;
  }
}
