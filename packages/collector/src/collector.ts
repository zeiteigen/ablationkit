/**
 * Worker collector (spec §4.1–4.2, §5.7; ADR 0011). One collector per attempt, co-located with
 * the job. It starts the job under the process supervisor, turns stdout/stderr into console
 * events, copies SDK events from the spool's event file, and appends everything to a durable,
 * bounded spool. A delivery loop sends the spool to the coordinator's worker API (at least once;
 * the coordinator dedupes) and an uploader sends staged artifacts. Training never waits on the
 * coordinator or MLflow: if they are down, the spool grows up to its bound and drains later.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { JsonlLog, listSegments, readJson, readJsonl, writeJsonAtomic } from "@ablationkit/core";
import {
  type Supervised,
  startSupervised,
  type Termination,
} from "@ablationkit/process-supervisor";
import {
  type CollectorManifest,
  type JournalEvent,
  validateCollectorManifest,
} from "@ablationkit/protocol";
import {
  COLLECTOR_PRODUCER,
  COLLECTOR_VERSION,
  JOURNAL_NAME,
  type SpoolLayout,
  spoolLayout,
} from "./layout.ts";
import { metricsFromLine } from "./metrics-file.ts";

export const MAX_LINE_CHARS = 16_384;
export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const FLUSH_MS = 100;
const HEALTH_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
/** Lifecycle events are kept even when the spool is full. */
const ALWAYS_KEEP = new Set([
  "attempt.started",
  "attempt.exited",
  "collector.drained",
  "collector.health",
]);

interface PendingUpload {
  readonly artifact_id: string;
  /** Staged file, relative to the spool. */
  readonly file: string;
  /** Destination inside the run's artifact root. */
  readonly dest: string;
  readonly sha256: string;
  readonly size: number;
}

type NewEvent = Omit<JournalEvent, "seq">;

export interface CollectorOptions {
  readonly spool: string;
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
  /** Health interval (tests). */
  readonly healthMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Files under `root` matching `pattern`, as safe relative paths (no symlinks, no escapes). */
export function globArtifacts(root: string, pattern: string): string[] {
  const out: string[] = [];
  const glob = new Bun.Glob(pattern);
  for (const rel of glob.scanSync({ cwd: root, onlyFiles: true, followSymlinks: false })) {
    const abs = resolve(root, rel);
    if (!abs.startsWith(root + sep)) continue;
    try {
      if (!lstatSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    out.push(relative(root, abs).split(sep).join("/"));
  }
  return out.sort();
}

export function sha256File(path: string): string {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

/** Split a byte stream into lines; a `\r` inside a line keeps only the last rendered state. */
async function* lines(stream: Readable): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk as Buffer, { stream: true });
    let nl = pending.indexOf("\n");
    while (nl >= 0) {
      yield pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
    while (pending.length > MAX_LINE_CHARS) {
      yield pending.slice(0, MAX_LINE_CHARS);
      pending = pending.slice(MAX_LINE_CHARS);
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) yield pending;
}

function cleanLine(raw: string): string {
  const cr = raw.lastIndexOf("\r", raw.length - 2);
  const s = cr >= 0 ? raw.slice(cr + 1) : raw;
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

/** An `input_paths` file larger than this is not recorded (inputs are configs, not data). */
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;

function git(cwd: string, args: string[]): string | undefined {
  try {
    const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the checkout has changes a run's source commit does not hold: modified, staged or
 * untracked files anywhere in the repository (`:/`), except the project's own `.ablationkit/`
 * (the manifest, the coordinator's research export), which AblationKit writes and which is never
 * the run's source. Undefined outside Git.
 */
export function sourceDirty(projectPath: string): boolean | undefined {
  const status = git(projectPath, ["status", "--porcelain", "--", ":/", ":(exclude).ablationkit"]);
  return status === undefined ? undefined : status.length > 0;
}

export class Collector {
  readonly layout: SpoolLayout;
  readonly manifest: CollectorManifest;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly healthMs: number;
  private journal!: JsonlLog<JournalEvent>;
  private buffer: NewEvent[] = [];
  private acked = -1;
  private spoolBytes = 0;
  private dropped = 0;
  private lastError: string | undefined;
  /** Delivery failures clear once delivery works again; other errors stay until replaced. */
  private deliveryError: string | undefined;
  private uploadError: string | undefined;
  private deliveryBackoff = 0;
  private uploadBackoff = 0;
  private stopping = false;
  private cancelled = false;
  private complete = false;
  private child: Supervised | undefined;
  private wake: (() => void) | undefined;
  private workerUrl: string;

  constructor(options: CollectorOptions) {
    this.layout = spoolLayout(options.spool);
    this.manifest = readJson(this.layout.manifest, validateCollectorManifest);
    this.token = readFileSync(this.manifest.token_file, "utf8").trim();
    this.workerUrl = this.manifest.worker_url;
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? ((l) => console.error(`collector: ${l}`));
    this.healthMs = options.healthMs ?? HEALTH_MS;
  }

  /** Run the attempt (or just drain it) to completion. Resolves with the process exit code. */
  async run(): Promise<number> {
    const L = this.layout;
    for (const d of [L.journal, L.artifacts, L.uploads, L.failedUploads])
      mkdirSync(d, { recursive: true, mode: 0o700 });
    writeFileSync(L.pid, `${process.pid}\n`, { mode: 0o600 });
    // Small segments, so acknowledged ones can be deleted and the bound frees up while running.
    this.journal = JsonlLog.open<JournalEvent>(L.journal, {
      name: JOURNAL_NAME,
      maxSegmentBytes: Math.max(
        64 * 1024,
        Math.min(8 * 1024 * 1024, Math.floor(this.manifest.spool_max_bytes / 16)),
      ),
    });
    this.acked = this.readCursor();
    this.spoolBytes = this.measureSpool();

    const flusher = setInterval(() => this.flushBuffer(), FLUSH_MS);
    const tailer = setInterval(() => {
      this.tailSdk();
      this.tailMetricsFile();
    }, FLUSH_MS * 2);
    const health = setInterval(() => this.emitHealth(), this.healthMs);
    const delivery = this.deliveryLoop();
    const uploads = this.uploadLoop();
    const onSignal = (): void => {
      this.log("received SIGTERM; stopping the job");
      this.cancelled = true;
      void this.child?.stop();
    };
    process.on("SIGTERM", onSignal);
    try {
      if (!this.manifest.drain_only && !existsSync(L.exit)) await this.runJob();
      else if (this.manifest.drain_only) {
        this.tailSdk();
        this.emit("collector.drained", { exit_recorded: existsSync(L.exit) });
      }
      this.tailSdk();
      this.flushBuffer();
      this.emitHealth();
      // Keep delivering until everything is acknowledged or the deadline passes.
      const deadline = Date.now() + this.manifest.deliver_deadline_sec * 1000;
      while (Date.now() < deadline && !this.drained()) {
        this.kick();
        await sleep(200);
      }
      if (this.drained()) {
        // Report the final, empty spool so the coordinator does not keep a stale health record.
        this.emitHealth();
        this.flushBuffer();
        const end = Math.min(deadline, Date.now() + 10_000);
        while (Date.now() < end && !this.drained()) {
          this.kick();
          await sleep(100);
        }
      }
      const done = this.drained();
      if (!done)
        this.log(`delivery deadline passed; leaving the spool at ${L.root} for reconciliation`);
      this.complete = done;
      return done ? 0 : 75;
    } finally {
      this.stopping = true;
      this.kick();
      clearInterval(flusher);
      clearInterval(tailer);
      clearInterval(health);
      process.off("SIGTERM", onSignal);
      await Promise.allSettled([delivery, uploads]);
      this.flushBuffer();
      this.journal.close();
      rmSync(L.pid, { force: true });
      // Everything was delivered: the spool (and the token in it) is no longer needed.
      if (this.complete && !process.env["ABLATIONKIT_KEEP_SPOOL"])
        rmSync(L.root, { recursive: true, force: true });
    }
  }

  private drained(): boolean {
    return (
      this.buffer.length === 0 &&
      this.acked >= this.journal.nextSeq - 1 &&
      this.pendingUploads().length === 0
    );
  }

  // ------------------------------------------------------------------ the job

  private async runJob(): Promise<void> {
    const m = this.manifest;
    const started = Date.now();
    if (this.cancelled) {
      this.finishExit(
        { signal: "SIGTERM", timed_out: false, oom_killed: false, leftovers_killed: false },
        started,
        "cancelled before the job started",
      );
      return;
    }
    // Record where the metrics file ends *before* the job starts: a fast job can write its own
    // metrics before startSupervised returns, and those lines must not be taken for an earlier run's.
    this.initMetricsFile();
    // Inputs as they are when the job starts, before it (or the next edit) can change them.
    this.collectInputs();
    let child: Supervised;
    try {
      child = await startSupervised({
        unit: m.unit,
        argv: m.argv,
        cwd: m.cwd,
        env: m.env,
        limits: m.limits,
        mode: m.mode,
      });
    } catch (e) {
      const msg = `could not start the job: ${(e as Error).message}`;
      this.emit("console.line", { stream: "system", text: msg });
      this.finishExit(
        { exit_code: 127, timed_out: false, oom_killed: false, leftovers_killed: false },
        started,
        msg,
      );
      return;
    }
    this.child = child;
    // A copy of the job's source (ADR 0068) has no Git: the coordinator says what it was.
    const commit = m.source ? m.source.commit : git(m.project_path, ["rev-parse", "HEAD"]);
    const dirty = m.source
      ? m.source.dirty
      : commit === undefined
        ? undefined
        : sourceDirty(m.project_path);
    this.emit("attempt.started", {
      pid: child.pid,
      unit: child.unit,
      mode: m.mode,
      collector_pid: process.pid,
      hostname: hostname(),
      command: m.argv,
      cwd: m.cwd,
      collector_version: COLLECTOR_VERSION,
      ...(commit && /^[a-f0-9]{7,64}$/.test(commit) ? { source_commit: commit } : {}),
      ...(dirty === undefined ? {} : { source_dirty: dirty }),
    });
    this.flushBuffer();
    const pump = async (s: Readable, stream: "stdout" | "stderr"): Promise<void> => {
      for await (const raw of lines(s)) this.emit("console.line", { stream, text: cleanLine(raw) });
    };
    const pumps = Promise.all([pump(child.stdout, "stdout"), pump(child.stderr, "stderr")]);
    const term = await child.exited;
    // Leftovers are killed at exit, so the pipes close; don't wait forever if one is inherited.
    await Promise.race([pumps, sleep(3000)]);
    this.tailSdk();
    this.tailMetricsFile();
    this.collectGlobArtifacts();
    this.finishExit(term, started);
  }

  private finishExit(term: Termination, started: number, error?: string): void {
    const exit = {
      ...term,
      duration_ms: Date.now() - started,
      ...(error ? { error } : {}),
    };
    if (term.leftovers_killed)
      this.emit("console.line", {
        stream: "system",
        text: "the job left processes running after its main process exited; they were killed",
      });
    this.emit("attempt.exited", exit);
    this.flushBuffer();
    writeJsonAtomic(this.layout.exit, exit);
  }

  /** `input_paths` files, staged as `inputs/<path>` artifacts; each at most `MAX_INPUT_BYTES`. */
  private collectInputs(): void {
    const root = this.manifest.project_path;
    for (const pattern of this.manifest.input_paths ?? []) {
      let matches: string[];
      try {
        matches = globArtifacts(root, pattern);
      } catch (e) {
        this.emit("console.line", {
          stream: "system",
          text: `input glob ${pattern}: ${(e as Error).message}`,
        });
        continue;
      }
      if (matches.length === 0)
        this.emit("console.line", { stream: "system", text: `input ${pattern}: no files match` });
      for (const rel of matches) {
        const size = statSync(join(root, rel)).size;
        if (size > MAX_INPUT_BYTES) {
          this.emit("console.line", {
            stream: "system",
            text: `input ${rel} not recorded: ${size} bytes is over ${MAX_INPUT_BYTES} (inputs are for configs; list data as artifacts or dataset inputs)`,
          });
          continue;
        }
        this.stageFile(join(root, rel), `inputs/${rel}`, "input");
      }
    }
    this.flushBuffer();
  }

  private collectGlobArtifacts(): void {
    const root = this.manifest.project_path;
    for (const pattern of this.manifest.artifact_paths) {
      let matches: string[];
      try {
        matches = globArtifacts(root, pattern);
      } catch (e) {
        this.emit("console.line", {
          stream: "system",
          text: `artifact glob ${pattern}: ${(e as Error).message}`,
        });
        continue;
      }
      for (const rel of matches) this.stageFile(join(root, rel), rel);
    }
  }

  /**
   * Copy a file into the spool and queue its upload. Never a hard link: it shares the inode, so a
   * later in-place write (by this job or another in the same checkout) would change the staged
   * bytes after they were checksummed, and the upload would be refused (ADR 0011).
   */
  private stageFile(src: string, dest: string, source: "glob" | "input" = "glob"): void {
    const id = randomUUID();
    const dir = join(this.layout.artifacts, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const staged = join(dir, basename(dest));
    copyFileSync(src, staged);
    const size = statSync(staged).size;
    if (this.spoolBytes + size > this.manifest.spool_max_bytes) {
      rmSync(dir, { recursive: true, force: true });
      this.dropped += 1;
      this.emit("console.line", {
        stream: "system",
        text: `artifact ${dest} not collected: spool full`,
      });
      return;
    }
    const sha256 = sha256File(staged);
    this.queueUpload({
      artifact_id: id,
      file: relative(this.layout.root, staged),
      dest,
      sha256,
      size,
    });
    this.emit("artifact.logged", { artifact_id: id, path: dest, sha256, size, source });
  }

  private queueUpload(u: PendingUpload): void {
    writeJsonAtomic(join(this.layout.uploads, `${u.artifact_id}.json`), u, { backup: false });
    this.spoolBytes += u.size;
  }

  // ------------------------------------------------------------------ spool

  private emit(type: string, payload: Record<string, unknown>): void {
    this.buffer.push({
      schema_version: 1,
      event_id: randomUUID(),
      project_id: this.manifest.project_id,
      ablationkit_job_id: this.manifest.job_id,
      attempt_id: this.manifest.attempt_id,
      producer_id: COLLECTOR_PRODUCER,
      producer_seq: 0, // set to the spool seq on append
      ts: new Date().toISOString(),
      type,
      payload,
    });
    if (this.buffer.length >= 1000) this.flushBuffer();
  }

  /** Append buffered events to the durable spool in one write. */
  private flushBuffer(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    const kept: NewEvent[] = [];
    let next = this.journal.nextSeq;
    for (const e of batch) {
      const size = JSON.stringify(e).length + 40;
      if (this.spoolBytes + size > this.manifest.spool_max_bytes && !ALWAYS_KEEP.has(e.type)) {
        this.dropped += 1;
        continue;
      }
      this.spoolBytes += size;
      // The collector's own producer_seq is its spool seq: monotonic across collector restarts.
      kept.push(e.producer_id === COLLECTOR_PRODUCER ? { ...e, producer_seq: next } : e);
      next += 1;
    }
    try {
      this.journal.appendBatch(kept);
    } catch (e) {
      this.lastError = `spool append failed: ${(e as Error).message}`;
      this.log(this.lastError);
      this.dropped += kept.length;
    }
    this.kick();
  }

  // ---------------------------------------------------------- metrics file adapter

  private metricsOffsetPath(): string {
    return join(this.layout.root, "metrics-offset.json");
  }

  /** Lines already in the metrics file when the job starts belong to an earlier run. */
  private initMetricsFile(): void {
    const f = this.manifest.metrics_file;
    if (!f || existsSync(this.metricsOffsetPath())) return;
    let cursor: MetricsCursor = { offset: 0 };
    try {
      cursor = metricsCursor(f, statSync(f).size);
    } catch {
      cursor = { offset: 0 };
    }
    writeJsonAtomic(this.metricsOffsetPath(), cursor, { backup: false });
  }

  /**
   * File adapter for scripts without the SDK: each JSON object line becomes one metric.batch, read
   * by the job's `metrics_format` (`metrics-file.ts`: nested keys flattened with `/`, the step from
   * its step keys or the line number, the time from its time key). The line number counts across
   * reads (kept in the cursor).
   * A file rewritten since it was last read (stress finding F43: another inode, a truncation, or
   * changed bytes before the cursor, including a same-size rewrite) is read from the start.
   */
  private tailMetricsFile(): void {
    const f = this.manifest.metrics_file;
    if (!f || !existsSync(f)) return;
    let cur: MetricsCursor = { offset: 0 };
    try {
      cur = readJson(this.metricsOffsetPath()) as MetricsCursor;
    } catch {
      cur = { offset: 0 };
    }
    const st = statSync(f);
    let offset = cur.offset;
    if (metricsRewritten(f, st, cur)) {
      offset = 0;
      this.emit("console.line", {
        stream: "system",
        text: "metrics file: rewritten since it was last read; reading it from the start",
      });
      writeJsonAtomic(this.metricsOffsetPath(), metricsCursor(f, 0, st), { backup: false });
      cur = { offset: 0 };
    }
    const size = st.size;
    if (size === offset) return;
    const fd = openSync(f, "r");
    let text: string;
    try {
      const buf = Buffer.allocUnsafe(Math.min(size - offset, 8 * 1024 * 1024));
      const n = readSync(fd, buf, 0, buf.length, offset);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
    const end = text.lastIndexOf("\n");
    if (end < 0) return;
    const complete = text.slice(0, end + 1);
    let lineNo = cur.lines ?? 0;
    for (const line of complete.split("\n")) {
      if (line.trim().length === 0) continue;
      lineNo++;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj !== "object" || obj === null || Array.isArray(obj))
          throw new Error("not an object");
      } catch {
        this.emit("console.line", {
          stream: "system",
          text: `metrics file: skipped a line that is not a JSON object`,
        });
        continue;
      }
      const metrics = metricsFromLine(obj, this.manifest.metrics_format, lineNo, Date.now());
      if (metrics.length > 0) this.emit("metric.batch", { metrics, source: "metrics_file" });
    }
    this.flushBuffer();
    writeJsonAtomic(
      this.metricsOffsetPath(),
      { ...metricsCursor(f, offset + Buffer.byteLength(complete), st), lines: lineNo },
      { backup: false },
    );
  }

  /** Copy complete lines appended by the SDK into the spool. */
  private tailSdk(): void {
    const L = this.layout;
    if (!existsSync(L.sdkEvents)) return;
    let offset = 0;
    try {
      offset = (readJson(L.sdkOffset) as { offset: number }).offset;
    } catch {
      offset = 0;
    }
    const size = statSync(L.sdkEvents).size;
    if (size <= offset) return;
    const fd = openSync(L.sdkEvents, "r");
    let text: string;
    try {
      const buf = Buffer.allocUnsafe(Math.min(size - offset, 8 * 1024 * 1024));
      const n = readSync(fd, buf, 0, buf.length, offset);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
    const end = text.lastIndexOf("\n");
    if (end < 0) return;
    const complete = text.slice(0, end + 1);
    for (const line of complete.split("\n")) {
      if (line.trim().length === 0) continue;
      const ev = this.parseSdkEvent(line);
      if (!ev) {
        this.emit("console.line", { stream: "system", text: "dropped a malformed SDK event" });
        continue;
      }
      if (ev.type === "artifact.logged") {
        const queued = this.queueSdkArtifact(ev);
        if (!queued) continue;
      }
      this.buffer.push(ev);
    }
    // Spool first, then the offset: a crash in between replays lines (deduped at ingress).
    this.flushBuffer();
    writeJsonAtomic(
      L.sdkOffset,
      { offset: offset + Buffer.byteLength(complete) },
      { backup: false },
    );
  }

  private parseSdkEvent(line: string): NewEvent | undefined {
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (typeof v !== "object" || v === null) return undefined;
    const { event_id, producer_id, producer_seq, ts, type, payload } = v;
    if (
      typeof event_id !== "string" ||
      typeof producer_id !== "string" ||
      producer_id === COLLECTOR_PRODUCER ||
      typeof producer_seq !== "number" ||
      typeof ts !== "string" ||
      typeof type !== "string" ||
      typeof payload !== "object" ||
      payload === null
    )
      return undefined;
    // Identity comes from the manifest, never from the job.
    return {
      schema_version: 1,
      event_id,
      project_id: this.manifest.project_id,
      ablationkit_job_id: this.manifest.job_id,
      attempt_id: this.manifest.attempt_id,
      producer_id,
      producer_seq,
      ts,
      type,
      payload: payload as Record<string, unknown>,
    };
  }

  /** The SDK staged an artifact under artifacts/; queue its upload (or drop it if the spool is full). */
  private queueSdkArtifact(ev: NewEvent): boolean {
    const p = ev.payload as { artifact_id?: unknown; file?: unknown; path?: unknown };
    const id = typeof p.artifact_id === "string" ? p.artifact_id : "";
    const file = typeof p.file === "string" ? p.file : "";
    const dest = typeof p.path === "string" ? p.path : "";
    const abs = resolve(this.layout.artifacts, file);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id) || !abs.startsWith(this.layout.artifacts + sep) || !dest) {
      this.emit("console.line", {
        stream: "system",
        text: "dropped an artifact event with a bad path",
      });
      return false;
    }
    if (existsSync(join(this.layout.uploads, `${id}.json`))) return true; // replayed line
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      return true; // already uploaded and removed (replay after a crash)
    }
    if (this.spoolBytes + size > this.manifest.spool_max_bytes) {
      rmSync(join(this.layout.artifacts, file.split("/")[0] as string), {
        recursive: true,
        force: true,
      });
      this.dropped += 1;
      this.emit("console.line", { stream: "system", text: `artifact ${dest} dropped: spool full` });
      return false;
    }
    const sha256 = sha256File(abs);
    this.queueUpload({
      artifact_id: id,
      file: relative(this.layout.root, abs),
      dest,
      sha256,
      size,
    });
    ev.payload = { ...ev.payload, sha256, size };
    return true;
  }

  private emitHealth(): void {
    this.emit("collector.health", {
      pid: process.pid,
      spool_bytes: this.spoolBytes,
      pending_events: Math.max(0, this.journal.nextSeq - 1 - this.acked) + this.buffer.length,
      pending_artifacts: this.pendingUploads().length,
      dropped_events: this.dropped,
      ...(this.deliveryError || this.uploadError || this.lastError
        ? { last_error: (this.deliveryError ?? this.uploadError ?? this.lastError) as string }
        : {}),
    });
  }

  private readCursor(): number {
    try {
      return (readJson(this.layout.cursor) as { acked_seq: number }).acked_seq;
    } catch {
      return -1;
    }
  }

  private measureSpool(): number {
    let total = 0;
    const walk = (d: string): void => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.isFile()) total += statSync(p).size;
      }
    };
    for (const d of [this.layout.journal, this.layout.artifacts]) if (existsSync(d)) walk(d);
    return total;
  }

  /** Delete spool segments whose records are all acknowledged (never the active one). */
  private gcJournal(): void {
    const segs = listSegments(this.layout.journal, JOURNAL_NAME);
    for (let i = 0; i < segs.length - 1; i++) {
      const next = segs[i + 1] as [number, string];
      const firstOfNext = firstSeqOf(next[1]);
      if (firstOfNext === undefined || firstOfNext - 1 > this.acked) break;
      const path = (segs[i] as [number, string])[1];
      this.spoolBytes -= statSync(path).size;
      rmSync(path, { force: true });
    }
  }

  // ------------------------------------------------------------------ delivery

  private kick(): void {
    const w = this.wake;
    this.wake = undefined;
    w?.();
  }

  private idle(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(() => {
        this.wake = undefined;
        r();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        r();
      };
    });
  }

  /** The coordinator rewrites worker_url in the manifest when it restarts on another address. */
  private reloadWorkerUrl(): void {
    try {
      this.workerUrl = readJson(this.layout.manifest, validateCollectorManifest).worker_url;
    } catch {
      // keep the old URL
    }
  }

  private base(): string {
    const m = this.manifest;
    return `${this.workerUrl}/api/v1/jobs/${encodeURIComponent(m.job_id)}/attempts/${encodeURIComponent(m.attempt_id)}`;
  }

  private async deliveryLoop(): Promise<void> {
    while (!this.stopping) {
      let sent = false;
      try {
        sent = await this.deliverOnce();
        this.deliveryBackoff = 0;
        this.deliveryError = undefined;
      } catch (e) {
        this.deliveryError = `event delivery: ${(e as Error).message}`;
        this.reloadWorkerUrl();
        this.deliveryBackoff = Math.min(MAX_BACKOFF_MS, Math.max(250, this.deliveryBackoff * 2));
        await sleep(this.deliveryBackoff);
        continue;
      }
      if (!sent) await this.idle(500);
    }
  }

  /** Send one batch from the cursor. True if something was acknowledged. */
  private async deliverOnce(): Promise<boolean> {
    if (this.acked >= this.journal.nextSeq - 1) return false;
    const events: JournalEvent[] = [];
    let bytes = 0;
    for await (const e of readJsonl<JournalEvent>(this.layout.journal, {
      name: JOURNAL_NAME,
      fromSeq: this.acked + 1,
    })) {
      const size = JSON.stringify(e).length;
      if (
        events.length > 0 &&
        (events.length >= MAX_BATCH_EVENTS || bytes + size > MAX_BATCH_BYTES)
      )
        break;
      events.push(e);
      bytes += size;
    }
    if (events.length === 0) return false;
    const res = await this.fetchImpl(`${this.base()}/events:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ events: events.map(({ seq: _s, ...env }) => env) }),
    });
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    await res.body?.cancel().catch(() => undefined);
    this.acked = (events.at(-1) as JournalEvent).seq;
    writeJsonAtomic(this.layout.cursor, { acked_seq: this.acked }, { backup: false });
    this.gcJournal();
    return true;
  }

  private pendingUploads(): string[] {
    try {
      return readdirSync(this.layout.uploads)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      return [];
    }
  }

  private async uploadLoop(): Promise<void> {
    while (!this.stopping) {
      const pending = this.pendingUploads();
      if (pending.length === 0) {
        this.uploadError = undefined;
        await this.idle(500);
        continue;
      }
      let progressed = false;
      for (const f of pending) {
        if (this.stopping) return;
        try {
          if (await this.uploadOne(f)) progressed = true;
        } catch (e) {
          this.uploadError = (e as Error).message;
        }
      }
      if (progressed) {
        this.uploadBackoff = 0;
        this.uploadError = undefined;
      } else {
        this.uploadBackoff = Math.min(MAX_BACKOFF_MS, Math.max(500, this.uploadBackoff * 2));
        await sleep(this.uploadBackoff);
      }
    }
  }

  /** Upload one staged artifact. True when it is done (accepted or refused for good). */
  private async uploadOne(file: string): Promise<boolean> {
    const metaPath = join(this.layout.uploads, file);
    let u: PendingUpload;
    try {
      u = readJson(metaPath) as PendingUpload;
    } catch {
      return false;
    }
    const staged = join(this.layout.root, u.file);
    const finish = (): void => {
      rmSync(join(this.layout.artifacts, u.artifact_id), { recursive: true, force: true });
      rmSync(metaPath, { force: true });
      this.spoolBytes -= u.size;
    };
    if (!existsSync(staged)) {
      finish();
      return true;
    }
    const res = await this.fetchImpl(
      `${this.base()}/artifacts?path=${encodeURIComponent(u.dest)}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/octet-stream",
          "x-ablationkit-sha256": u.sha256,
          "x-ablationkit-artifact-id": u.artifact_id,
        },
        body: Bun.file(staged),
      },
    );
    const text = await res.text().catch(() => "");
    if (res.status === 201 || res.status === 200) {
      finish();
      return true;
    }
    if (res.status === 503 || res.status === 429 || res.status >= 500) {
      // The run is not created yet, or MLflow is down: retry later.
      throw new Error(`artifact ${u.dest}: HTTP ${res.status} (will retry)`);
    }
    // Refused for good (bad path, too large, checksum mismatch, token revoked): park it.
    renameSync(metaPath, join(this.layout.failedUploads, file));
    this.lastError = `artifact ${u.dest} refused: HTTP ${res.status} ${text.slice(0, 300)}`;
    this.emit("console.line", { stream: "system", text: this.lastError });
    return true;
  }
}

function firstSeqOf(path: string): number | undefined {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    if (nl < 0) return undefined;
    return (JSON.parse(buf.subarray(0, nl).toString("utf8")) as { seq: number }).seq;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Where the metrics-file adapter stopped, and which file it read (F43): device and inode, mtime,
 * and a fingerprint of the bytes before the offset (its first and last 4 KiB), so a rewrite is
 * told from an append.
 */
interface MetricsCursor {
  readonly offset: number;
  /** Non-blank lines read so far: the step of a line without one. */
  readonly lines?: number;
  readonly dev?: number;
  readonly ino?: number;
  readonly mtime_ms?: number;
  readonly fingerprint?: string;
}

const FINGERPRINT_BYTES = 4096;

function fingerprint(file: string, offset: number): string {
  const h = createHash("sha256").update(String(offset));
  if (offset > 0) {
    const fd = openSync(file, "r");
    try {
      const head = Buffer.alloc(Math.min(offset, FINGERPRINT_BYTES));
      h.update(head.subarray(0, readSync(fd, head, 0, head.length, 0)));
      const at = Math.max(0, offset - FINGERPRINT_BYTES);
      const tail = Buffer.alloc(offset - at);
      h.update(tail.subarray(0, readSync(fd, tail, 0, tail.length, at)));
    } finally {
      closeSync(fd);
    }
  }
  return h.digest("hex");
}

function metricsCursor(
  file: string,
  offset: number,
  st: { dev: number; ino: number; mtimeMs: number } = statSync(file),
): MetricsCursor {
  return {
    offset,
    dev: st.dev,
    ino: st.ino,
    mtime_ms: st.mtimeMs,
    fingerprint: fingerprint(file, offset),
  };
}

/**
 * Has the file been replaced or rewritten since the cursor was taken? Another inode, a size below
 * the offset, or (once it was written again) changed bytes before the offset or no growth at all:
 * an append only adds bytes after the offset, so a same-size write is a rewrite. A rewrite that
 * keeps the old bytes as its prefix and grows is indistinguishable from an append (read as one).
 */
function metricsRewritten(
  file: string,
  st: { dev: number; ino: number; size: number; mtimeMs: number },
  cur: MetricsCursor,
): boolean {
  if (cur.ino !== undefined && (st.ino !== cur.ino || st.dev !== cur.dev)) return true;
  if (st.size < cur.offset) return true;
  if (cur.offset === 0 || cur.mtime_ms === undefined || st.mtimeMs === cur.mtime_ms) return false;
  if (st.size === cur.offset) return true;
  return cur.fingerprint !== undefined && fingerprint(file, cur.offset) !== cur.fingerprint;
}
