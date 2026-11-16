/**
 * Interactive inference sessions (spec §5.6.1 mode 2, criterion 9a; ADR 0020).
 *
 * A session is one supervised Python worker (the bridge's `serve` op) that loads a pinned model
 * once and answers predictions over its stdin/stdout. The coordinator is its only client, so the
 * session has no network endpoint at all. Limits: a memory cap and a maximum lifetime (a systemd
 * scope when delegated, else advisory), a bounded request size, a bounded queue (the worker
 * answers one request at a time), a per-request timeout and an idle timeout.
 *
 * Every lifecycle change is recorded (`state/<p>/inference/sessions/<id>.json`); no inputs or
 * outputs are. A crash, an idle expiry or an explicit stop ends in an honest terminal state, and a
 * coordinator restart stops every session (local sessions stop with the workstation; spec §5.6.1
 * "Offline and remote behavior").
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import { type Adapter, validateParams, validatePayload } from "@ablationkit/inference-adapters";
import {
  type InferenceSessionRecord,
  type InferenceSessionState,
  validateInferenceSessionRecord,
} from "@ablationkit/protocol";
import { recordMlflowUse } from "@ablationkit/tracking-mlflow";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";
import type { BridgeSession, OperationsBridge } from "../tracking/bridge.ts";

const TERMINAL = new Set<InferenceSessionState>(["stopped", "expired", "crashed", "failed"]);
const MAX_TRANSITIONS = 100;
export const SESSION_DEFAULTS = {
  idle_timeout_sec: 15 * 60,
  max_lifetime_sec: 8 * 3600,
  memory_mb: 2048,
  max_request_bytes: 1024 * 1024,
  max_queue: 4,
  request_timeout_sec: 120,
} as const;
const LOAD_TIMEOUT_SEC = 600;
const MAX_ROWS = 1000;

export type SessionActor = InferenceSessionRecord["requested_by"];

/** A session prediction, as the worker answered it (outputs are never persisted). */
export interface SessionAnswer {
  readonly ok: boolean;
  readonly kind?: string;
  readonly error?: string;
  readonly outputs?: unknown[];
  readonly probabilities?: unknown[];
  readonly probabilities_note?: string;
  readonly targets?: unknown[];
  readonly rows?: number;
  readonly predict_ms?: number;
  readonly postprocess_ms?: number;
  readonly round_trip_ms: number;
}

interface Live {
  readonly proc: BridgeSession;
  readonly adapter: Adapter;
  readonly pending: Map<number, (msg: Record<string, unknown>) => void>;
  nextId: number;
  inflight: number;
  /** Final state once the process exits after a requested stop. */
  finalState?: { state: "stopped" | "expired"; reason: string };
  loadError?: string;
  lastHealth: number;
  readyWaiters: (() => void)[];
  loadTimer?: ReturnType<typeof setTimeout>;
  readonly startedAt: number;
}

export interface SessionStartInput {
  readonly idle_timeout_sec?: number;
  readonly max_lifetime_sec?: number;
  readonly memory_mb?: number;
  readonly max_request_bytes?: number;
  readonly max_queue?: number;
  readonly request_timeout_sec?: number;
}

function intIn(v: unknown, name: string, lo: number, hi: number, def: number): number {
  if (v === undefined) return def;
  if (!Number.isSafeInteger(v) || (v as number) < lo || (v as number) > hi)
    throw new HttpError(400, "invalid_request", `${name} must be an integer in [${lo}, ${hi}]`);
  return v as number;
}

function sessionLimits(b: SessionStartInput): InferenceSessionRecord["limits"] {
  const d = SESSION_DEFAULTS;
  return {
    idle_timeout_sec: intIn(b.idle_timeout_sec, "idle_timeout_sec", 2, 86_400, d.idle_timeout_sec),
    max_lifetime_sec: intIn(
      b.max_lifetime_sec,
      "max_lifetime_sec",
      10,
      7 * 86_400,
      d.max_lifetime_sec,
    ),
    memory_mb: intIn(b.memory_mb, "memory_mb", 128, 1_048_576, d.memory_mb),
    max_request_bytes: intIn(
      b.max_request_bytes,
      "max_request_bytes",
      1024,
      64 * 1024 * 1024,
      d.max_request_bytes,
    ),
    max_queue: intIn(b.max_queue, "max_queue", 1, 64, d.max_queue),
    request_timeout_sec: intIn(
      b.request_timeout_sec,
      "request_timeout_sec",
      1,
      3600,
      d.request_timeout_sec,
    ),
  };
}

export class InferenceSessions {
  private readonly records = new Map<string, InferenceSessionRecord>();
  private readonly live = new Map<string, Live>();
  private readonly adapters = new Map<string, Adapter>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  readonly loadProblems: string[] = [];

  constructor(
    private readonly o: {
      readonly svc: () => Services;
      readonly stateDir: string;
      readonly bridge: OperationsBridge;
      readonly now: () => Date;
      readonly sweepMs?: number;
      readonly maxLive?: number;
    },
  ) {}

  private get svc(): Services {
    return this.o.svc();
  }

  private dir(pid: string): string {
    return join(this.o.stateDir, pid, "inference", "sessions");
  }

  private save(r: InferenceSessionRecord): InferenceSessionRecord {
    mkdirSync(this.dir(r.project_id), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.dir(r.project_id), `${r.session_id}.json`), r, {
      validate: validateInferenceSessionRecord,
    });
    const prev = this.records.get(r.session_id);
    this.records.set(r.session_id, r);
    if (prev?.state !== r.state)
      this.svc.events.publish(r.project_id, "inference.session.updated", {
        session_id: r.session_id,
        state: r.state,
        model_id: r.model.model_id,
      });
    return r;
  }

  private update(id: string, patch: Partial<InferenceSessionRecord>, reason?: string) {
    const cur = this.records.get(id) as InferenceSessionRecord;
    const now = this.o.now().toISOString();
    const transitions =
      patch.state && patch.state !== cur.state
        ? [
            ...cur.transitions,
            compact({ state: patch.state, at: now, reason: reason?.slice(0, 1000) }),
          ].slice(-MAX_TRANSITIONS)
        : cur.transitions;
    return this.save({ ...cur, ...patch, transitions, updated_at: now });
  }

  /** Inference sessions of a project that are still up (project removal refuses these). */
  open(pid: string): InferenceSessionRecord[] {
    return [...this.records.values()].filter((r) => r.project_id === pid && !TERMINAL.has(r.state));
  }

  /** Drop a removed project's sessions from memory. */
  forgetProject(pid: string): void {
    for (const [id, r] of [...this.records]) {
      if (r.project_id !== pid) continue;
      this.records.delete(id);
      this.adapters.delete(id);
    }
  }

  load(projects: readonly string[]): void {
    for (const pid of projects) {
      const d = this.dir(pid);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
        try {
          const r = readJson(join(d, f), validateInferenceSessionRecord);
          if (r.project_id !== pid || `${r.session_id}.json` !== f)
            throw new Error("ID does not match its path");
          this.records.set(r.session_id, r);
        } catch {
          this.loadProblems.push(join(d, f));
        }
      }
    }
  }

  /** After a restart nothing a previous coordinator started is alive: stop and record it. */
  start(): void {
    for (const r of this.records.values()) {
      if (TERMINAL.has(r.state)) continue;
      this.o.bridge.reap(r.session_id);
      this.update(
        r.session_id,
        {
          state: "stopped",
          ended_at: this.o.now().toISOString(),
          end_reason:
            "the coordinator stopped; local inference sessions do not survive a restart. Start it again.",
        },
        "coordinator restart",
      );
    }
    this.timer = setInterval(() => this.sweep(), this.o.sweepMs ?? 5000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Local sessions stop with the coordinator (and the workstation). */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all(
      [...this.live.keys()].map((id) =>
        this.stop(id, "stopped", "the coordinator shut down").catch(() => undefined),
      ),
    );
  }

  list(pid: string): InferenceSessionRecord[] {
    return [...this.records.values()]
      .filter((r) => r.project_id === pid)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(pid: string, id: string): InferenceSessionRecord {
    const r = this.records.get(id);
    if (!r || r.project_id !== pid)
      throw new HttpError(404, "not_found", `no inference session ${id}`);
    return r;
  }

  byDeployment(deploymentId: string): InferenceSessionRecord | undefined {
    return [...this.records.values()].find((r) => r.deployment_id === deploymentId);
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  adapterOf(id: string): Adapter | undefined {
    return this.adapters.get(id);
  }

  /** The record, with memory refreshed from the worker when it is idle (best effort, ≤ 2 s). */
  async view(pid: string, id: string): Promise<InferenceSessionRecord> {
    const r = this.get(pid, id);
    const l = this.live.get(id);
    if (r.state === "ready" && l && l.inflight === 0 && Date.now() - l.lastHealth > 3000) {
      l.lastHealth = Date.now();
      const msg = await this.call(l, { op: "health" }, 2000).catch(() => undefined);
      if (msg?.["ok"] === true && this.records.get(id)?.state === "ready")
        return this.update(id, { memory: this.memoryOf(msg) });
    }
    return this.records.get(id) as InferenceSessionRecord;
  }

  private memoryOf(msg: Record<string, unknown>): NonNullable<InferenceSessionRecord["memory"]> {
    const int = (k: string) =>
      Number.isSafeInteger(msg[k]) && (msg[k] as number) >= 0 ? (msg[k] as number) : undefined;
    return compact({
      rss_bytes: int("rss_bytes"),
      peak_rss_bytes: int("peak_rss_bytes"),
      gpu_allocated_bytes: int("gpu_allocated_bytes"),
      at: this.o.now().toISOString(),
    });
  }

  /** Create a session record and start its worker. */
  async create(
    pid: string,
    pinned: { model: InferenceSessionRecord["model"]; source_run_id?: string; adapter: Adapter },
    input: SessionStartInput & { environment?: "managed" | "project" },
    actor: SessionActor,
    extra: { deployment_id?: string } = {},
  ): Promise<InferenceSessionRecord> {
    const limits = sessionLimits(input);
    const environment = input.environment ?? "managed";
    const why = this.o.bridge.available(environment);
    if (why) throw new HttpError(503, "bridge_unavailable", `cannot start a session: ${why}`);
    const max = this.o.maxLive ?? 4;
    if (this.live.size >= max)
      throw new HttpError(
        409,
        "too_many_sessions",
        `${this.live.size} sessions are running (at most ${max}); stop one first`,
      );
    const now = this.o.now().toISOString();
    const rec: InferenceSessionRecord = compact({
      schema_version: 1 as const,
      session_id: `is-${randomBytes(8).toString("hex")}`,
      project_id: pid,
      model: pinned.model,
      source_run_id: pinned.source_run_id,
      task: pinned.adapter.task,
      output: pinned.adapter.output,
      environment,
      state: "starting" as const,
      limits,
      timings: {},
      counters: { requests: 0, errors: 0, rejected: 0 },
      deployment_id: extra.deployment_id,
      restarts: 0,
      transitions: [{ state: "starting" as const, at: now }],
      requested_by: actor,
      created_at: now,
      updated_at: now,
    });
    this.save(rec);
    this.adapters.set(rec.session_id, pinned.adapter);
    this.audit(rec, actor, "start");
    await this.launch(rec.session_id);
    return this.records.get(rec.session_id) as InferenceSessionRecord;
  }

  private audit(r: InferenceSessionRecord, actor: SessionActor, action: string, reason?: string) {
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: actor.kind === "system" ? "internal" : actor.kind,
      action: `inference.session.${action}`,
      outcome: "allowed",
      project_id: r.project_id,
      target: r.session_id,
      ...(reason ? { reason } : {}),
      details: compact({
        model_id: r.model.model_id,
        registered: r.model.registered_name
          ? `${r.model.registered_name}/${r.model.version}`
          : undefined,
        deployment_id: r.deployment_id,
        idle_timeout_sec: r.limits.idle_timeout_sec,
        memory_mb: r.limits.memory_mb,
      }),
    });
  }

  private async launch(id: string): Promise<void> {
    const r = this.records.get(id) as InferenceSessionRecord;
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`no adapter for session ${id}`);
    const project = this.svc.registry.get(r.project_id);
    let proc: BridgeSession;
    const t0 = Date.now();
    try {
      proc = await this.o.bridge.startSession(
        id,
        { op: "serve", model_uri: `models:/${r.model.model_id}`, adapter },
        compact({
          environment: r.environment,
          projectPath: project?.path,
          lifetimeSec: r.limits.max_lifetime_sec,
          memoryMb: r.limits.memory_mb,
        }),
      );
    } catch (e) {
      this.update(
        id,
        {
          state: "failed",
          ended_at: this.o.now().toISOString(),
          end_reason: String(e).slice(0, 4000),
        },
        "the worker did not start",
      );
      return;
    }
    const live: Live = {
      proc,
      adapter,
      pending: new Map(),
      nextId: 1,
      inflight: 0,
      lastHealth: Date.now(),
      readyWaiters: [],
      startedAt: t0,
    };
    this.live.set(id, live);
    this.update(id, { pid: proc.pid, unit: proc.unit, enforcement: proc.enforcement });
    live.loadTimer = setTimeout(() => {
      if (this.records.get(id)?.state === "starting") {
        live.loadError = `the model did not load within ${LOAD_TIMEOUT_SEC}s`;
        void proc.stop();
      }
    }, LOAD_TIMEOUT_SEC * 1000);
    (live.loadTimer as { unref?: () => void }).unref?.();
    void this.readLines(id, live);
    void proc.done.then((out) => this.onExit(id, live, out));
  }

  private async readLines(id: string, live: Live): Promise<void> {
    try {
      for await (const line of live.proc.lines) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg["event"] === "ready") {
          recordMlflowUse("bridge serve ok");
          if (live.loadTimer) clearTimeout(live.loadTimer);
          const ms = (k: string) =>
            typeof msg[k] === "number" && Number.isFinite(msg[k]) && (msg[k] as number) >= 0
              ? Math.round(msg[k] as number)
              : undefined;
          const now = this.o.now().toISOString();
          this.update(
            id,
            compact({
              state: "ready" as const,
              ready_at: now,
              last_activity_at: now,
              timings: compact({
                import_ms: ms("import_ms"),
                load_ms: ms("load_ms"),
                start_ms: Date.now() - live.startedAt,
              }),
              memory: this.memoryOf(msg),
              mlflow_version:
                typeof msg["mlflow_version"] === "string"
                  ? msg["mlflow_version"].slice(0, 50)
                  : undefined,
              python_version:
                typeof msg["python_version"] === "string"
                  ? msg["python_version"].slice(0, 50)
                  : undefined,
            }),
            "model loaded",
          );
          for (const w of live.readyWaiters.splice(0)) w();
        } else if (msg["event"] === "load_failed") {
          live.loadError = String(msg["error"] ?? "the model failed to load").slice(0, 4000);
        } else if (typeof msg["id"] === "number") {
          const resolve = live.pending.get(msg["id"]);
          live.pending.delete(msg["id"]);
          resolve?.(msg);
        }
      }
    } catch {
      // the stream broke: the exit handler records what happened
    }
  }

  private onExit(id: string, live: Live, out: Awaited<BridgeSession["done"]>): void {
    if (live.loadTimer) clearTimeout(live.loadTimer);
    this.live.delete(id);
    for (const resolve of live.pending.values())
      resolve({ ok: false, kind: "session_crashed", error: "the session ended before answering" });
    live.pending.clear();
    for (const w of live.readyWaiters.splice(0)) w();
    if (this.stopped && !live.finalState)
      live.finalState = { state: "stopped", reason: "the coordinator shut down" };
    const r = this.records.get(id);
    if (!r || TERMINAL.has(r.state)) return;
    const t = out.termination;
    const ended = this.o.now().toISOString();
    if (live.finalState) {
      this.update(
        id,
        { state: live.finalState.state, ended_at: ended, end_reason: live.finalState.reason },
        live.finalState.reason,
      );
    } else if (r.state === "starting") {
      const why =
        live.loadError ??
        (t.oom_killed
          ? `the worker ran out of memory (limit ${r.limits.memory_mb} MB) while loading`
          : `the worker exited before the model loaded (exit ${t.exit_code ?? t.signal ?? "?"}): ${out.log_tail.slice(-1500)}`);
      this.update(
        id,
        { state: "failed", ended_at: ended, end_reason: why.slice(0, 4000) },
        "load failed",
      );
    } else if (t.timed_out) {
      this.update(
        id,
        {
          state: "expired",
          ended_at: ended,
          end_reason: `the maximum lifetime of ${r.limits.max_lifetime_sec}s was reached`,
        },
        "max lifetime",
      );
    } else {
      const why = t.oom_killed
        ? `out of memory: the worker hit its ${r.limits.memory_mb} MB limit`
        : `the worker exited unexpectedly (${t.signal ? `signal ${t.signal}` : `exit ${t.exit_code ?? "?"}`})${t.leftovers_killed ? "; leftover processes were killed" : ""}`;
      this.update(id, { state: "crashed", ended_at: ended, end_reason: why }, "crashed");
      this.svc.audit.record({
        actor: { kind: "system" },
        listener: "internal",
        action: "inference.session.crashed",
        outcome: "error",
        project_id: r.project_id,
        target: id,
        reason: why,
      });
    }
    const final = this.records.get(id) as InferenceSessionRecord;
    if (final.deployment_id && !live.finalState)
      void this.svc.deployments
        .stop(
          final.deployment_id,
          final.project_id,
          { kind: "system" },
          `the inference session ${final.state}: ${final.end_reason ?? ""}`.slice(0, 1000),
        )
        .catch(() => undefined);
  }

  /** Resolve once the session is ready or has ended (or after `ms`). */
  async waitReady(id: string, ms: number): Promise<InferenceSessionRecord> {
    const l = this.live.get(id);
    const r = this.records.get(id) as InferenceSessionRecord;
    if (!l || r.state !== "starting") return r;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      l.readyWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
    // the exit handler may still be recording the end state
    for (
      let i = 0;
      i < 50 && this.live.has(id) === false && this.records.get(id)?.state === "starting";
      i++
    )
      await Bun.sleep(20);
    return this.records.get(id) as InferenceSessionRecord;
  }

  private call(l: Live, msg: Record<string, unknown>, timeoutMs: number) {
    const id = l.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => {
        l.pending.delete(id);
        reject(new HttpError(504, "prediction_timeout", `no answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      l.pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      try {
        l.proc.send({ ...msg, id });
      } catch (e) {
        clearTimeout(t);
        l.pending.delete(id);
        reject(new HttpError(502, "session_crashed", `the session is gone: ${String(e)}`));
      }
    });
  }

  /** One prediction on a ready session. Inputs go straight to the worker's stdin. */
  async predict(
    pid: string,
    id: string,
    body: { inputs?: unknown; params?: unknown },
  ): Promise<SessionAnswer> {
    const r = this.get(pid, id);
    const l = this.live.get(id);
    if (r.state !== "ready" || !l)
      throw new HttpError(409, "session_not_ready", `session ${id} is ${r.state}`, {
        state: r.state,
      });
    const reject = (e: HttpError): never => {
      this.update(id, {
        counters: {
          ...(this.records.get(id) as InferenceSessionRecord).counters,
          rejected: r.counters.rejected + 1,
        },
      });
      throw e;
    };
    const v = validatePayload(l.adapter, body.inputs, { maxRows: MAX_ROWS });
    const issues = [...v.issues, ...validateParams(l.adapter, body.params)];
    if (issues.length)
      reject(
        new HttpError(422, "invalid_input", "the inputs do not match the model's signature", {
          issues,
        }),
      );
    if (l.inflight >= r.limits.max_queue)
      reject(
        new HttpError(
          429,
          "session_busy",
          `${l.inflight} requests are queued (at most ${r.limits.max_queue})`,
        ),
      );
    l.inflight++;
    const t0 = performance.now();
    let msg: Record<string, unknown>;
    try {
      msg = await this.call(
        l,
        compact({ op: "predict", inputs: body.inputs, params: body.params }),
        r.limits.request_timeout_sec * 1000,
      );
    } catch (e) {
      const cur = this.records.get(id) as InferenceSessionRecord;
      this.update(id, {
        counters: {
          ...cur.counters,
          requests: cur.counters.requests + 1,
          errors: cur.counters.errors + 1,
        },
        last_activity_at: this.o.now().toISOString(),
      });
      throw e;
    } finally {
      l.inflight--;
    }
    const round = performance.now() - t0;
    const cur = this.records.get(id) as InferenceSessionRecord;
    const ok = msg["ok"] === true;
    const predictMs =
      typeof msg["predict_ms"] === "number" ? (msg["predict_ms"] as number) : undefined;
    if (!TERMINAL.has(cur.state))
      this.update(id, {
        counters: compact({
          requests: cur.counters.requests + 1,
          errors: cur.counters.errors + (ok ? 0 : 1),
          rejected: cur.counters.rejected,
          last_predict_ms:
            predictMs !== undefined ? Math.round(predictMs) : cur.counters.last_predict_ms,
        }),
        last_activity_at: this.o.now().toISOString(),
      });
    const { id: _id, ...rest } = msg;
    return {
      ...(rest as Omit<SessionAnswer, "round_trip_ms">),
      ok,
      round_trip_ms: Math.round(round * 1000) / 1000,
    };
  }

  /**
   * Stop a session: close its stdin (the worker exits on its own), then stop its scope or process
   * group if it has not exited within 3 s.
   */
  async stop(
    id: string,
    state: "stopped" | "expired" = "stopped",
    reason = "stopped by the researcher",
    actor?: SessionActor,
  ): Promise<InferenceSessionRecord> {
    const r = this.records.get(id);
    if (!r) throw new HttpError(404, "not_found", `no inference session ${id}`);
    if (TERMINAL.has(r.state)) return r;
    const l = this.live.get(id);
    if (actor) this.audit(r, actor, "stop", reason);
    if (!l) {
      return this.update(
        id,
        { state, ended_at: this.o.now().toISOString(), end_reason: reason },
        reason,
      );
    }
    l.finalState = { state, reason };
    this.update(id, { state: "stopping" }, reason);
    l.proc.close();
    const exited = l.proc.done.then(() => true);
    if (!(await Promise.race([exited, Bun.sleep(3000).then(() => false)]))) await l.proc.stop();
    await exited;
    // let the exit handler record the final state
    for (
      let i = 0;
      i < 100 && !TERMINAL.has((this.records.get(id) as InferenceSessionRecord).state);
      i++
    )
      await Bun.sleep(10);
    return this.records.get(id) as InferenceSessionRecord;
  }

  /** Stop (if running) and start a fresh worker for the same pinned model. */
  async restart(pid: string, id: string, actor: SessionActor): Promise<InferenceSessionRecord> {
    const r = this.get(pid, id);
    if (!this.adapters.has(id))
      throw new HttpError(
        409,
        "session_not_restartable",
        "this session's model adapter is not loaded; start a new session",
      );
    if (this.live.has(id)) await this.stop(id, "stopped", "restarting");
    const max = this.o.maxLive ?? 4;
    if (this.live.size >= max)
      throw new HttpError(409, "too_many_sessions", `at most ${max} sessions run at once`);
    this.audit(r, actor, "restart");
    const cur = this.records.get(id) as InferenceSessionRecord;
    const { ended_at: _e, end_reason: _r, pid: _p, ready_at: _ra, memory: _m, ...rest } = cur;
    this.save({
      ...rest,
      state: "starting",
      restarts: cur.restarts + 1,
      timings: {},
      transitions: [
        ...cur.transitions,
        { state: "starting" as const, at: this.o.now().toISOString(), reason: "restart" },
      ].slice(-MAX_TRANSITIONS),
      updated_at: this.o.now().toISOString(),
    });
    await this.launch(id);
    return this.records.get(id) as InferenceSessionRecord;
  }

  /** Idle expiry: a ready session with nothing in flight past its idle timeout is stopped. */
  sweep(): void {
    const t = this.o.now().getTime();
    for (const [id, l] of this.live) {
      const r = this.records.get(id);
      if (r?.state !== "ready" || l.inflight > 0 || !r.last_activity_at) continue;
      const idle = (t - Date.parse(r.last_activity_at)) / 1000;
      if (idle >= r.limits.idle_timeout_sec)
        void this.stop(id, "expired", `idle for ${r.limits.idle_timeout_sec}s (idle timeout)`);
    }
  }

  logTail(pid: string, id: string): string {
    this.get(pid, id);
    return this.o.bridge.logTail(id, 65_536);
  }
}
