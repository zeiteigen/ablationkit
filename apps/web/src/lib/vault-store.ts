/**
 * One project's vault in the browser (ADR 0049): loaded once and shared by the navigation's count
 * and the Standing and Notebooks pages, so a note read on one page is read everywhere at once.
 * Reading marks itself: marks are applied here first and sent to the coordinator in batches.
 * What the reader has unfolded and where they were on a page are conveniences kept in this
 * browser's localStorage only.
 */
import type { VaultWork } from "@ablationkit/protocol";
import { usesByWork, Vault, type WorkUse } from "@ablationkit/vault";
import { useEffect, useSyncExternalStore } from "react";
import { api, useEvents } from "../api.ts";
import type { ResearchRecord } from "./research.ts";
import type { Run, RunsPage } from "./types.ts";
import {
  type Depth,
  ledgerLines,
  type ReadState,
  type RunValue,
  readState,
  type Term,
  termList,
  termPattern,
  type VaultView,
} from "./vault.ts";

export interface StudyView {
  study_id: string;
  record?: {
    title?: string;
    baseline_variant?: string;
    variants?: { variant_id: string; title?: string }[];
    metric_goals?: { key: string; goal: "min" | "max" }[];
  };
  variants: { variant_id: string; runs: unknown[]; metrics: Record<string, { mean: number }> }[];
  metric_keys: string[];
}

/** One run of the file drawer, as `GET …/vault/runs` returns it (ADR 0056). */
export interface AccountedRun {
  name?: string;
  id?: string;
  ended: boolean;
  job_id?: string;
  task_id?: string;
  study_id?: string;
  variant_id?: string;
  state?: string;
  imported?: boolean;
  agent?: string;
  standing: "cited" | "set_aside" | "unaccounted";
  cited_by: string[];
  set_aside?: { reason: string; at: string };
}

export type Lazy<T> = { state: "idle" | "loading" | "done" | "error"; data?: T; error?: unknown };
const IDLE: Lazy<never> = { state: "idle" };

const enc = encodeURIComponent;

/** Per-viewer conveniences: never trusted, never required, every access guarded. */
export const local = {
  get<T>(key: string, dflt: T): T {
    try {
      const s = localStorage.getItem(key);
      return s === null ? dflt : (JSON.parse(s) as T);
    } catch {
      return dflt;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // private window or full storage: the convenience is lost, nothing else
    }
  },
};

/** Values by key with a subscription per key (depths, the focused line). */
class KeyStore<T> {
  private values = new Map<string, T>();
  private subs = new Map<string, Set<() => void>>();
  constructor(initial?: Iterable<[string, T]>) {
    if (initial) this.values = new Map(initial);
  }
  get(key: string): T | undefined {
    return this.values.get(key);
  }
  has(key: string): boolean {
    return this.values.has(key);
  }
  set(key: string, value: T | undefined): void {
    if (this.values.get(key) === value) return;
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    for (const f of this.subs.get(key) ?? []) f();
  }
  clear(): void {
    const keys = [...this.values.keys()];
    this.values.clear();
    for (const k of keys) for (const f of this.subs.get(k) ?? []) f();
  }
  entries(): [string, T][] {
    return [...this.values.entries()];
  }
  subscribe(key: string, f: () => void): () => void {
    let s = this.subs.get(key);
    if (!s) {
      s = new Set();
      this.subs.set(key, s);
    }
    s.add(f);
    return () => s.delete(f);
  }
}

export class VaultStore {
  view: VaultView | undefined;
  vault: Vault | undefined;
  terms: Term[] = [];
  termRe: RegExp | undefined;
  /** The library (ADR 0052): live works by ID, and every note's citation of each. */
  works = new Map<string, VaultWork>();
  uses = new Map<string, WorkUse[]>();
  error: unknown;
  /** Bumped on every change a reader of the store could see. */
  version = 0;
  readonly depths: KeyStore<Depth>;
  readonly focus = new KeyStore<boolean>();
  focused: string | undefined;
  sinceAt: string | undefined;
  private reads: VaultView["reads"] = {};
  private subs = new Set<() => void>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loading: Promise<void> | undefined;
  private runs: Lazy<{ available: boolean; byName: Map<string, Run>; byId: Map<string, Run> }> = {
    state: "idle",
  };
  private names: Lazy<Map<string, string>> = { state: "idle" };
  /** The file drawer (ADR 0056): every run the project's jobs produced, with how it is accounted for. */
  private drawer: Lazy<AccountedRun[]> = { state: "idle" };
  private studies = new Map<string, Lazy<StudyView>>();

  constructor(readonly pid: string) {
    this.depths = new KeyStore(local.get<[string, Depth][]>(this.lsKey("depths"), []));
  }

  lsKey(what: string): string {
    return `ak:vault:${this.pid}:${what}`;
  }

  subscribe = (f: () => void): (() => void) => {
    this.subs.add(f);
    return () => this.subs.delete(f);
  };

  private emit(): void {
    this.version++;
    for (const f of this.subs) f();
  }

  load(force = false): Promise<void> {
    if (this.loading && !force) return this.loading;
    this.loading = api<VaultView>(`/api/v1/projects/${enc(this.pid)}/vault`).then(
      (v) => {
        this.view = v;
        this.vault = new Vault(v.notes, { shelf: v.shelf, ledger: v.ledger });
        this.terms = termList(this.vault.notes);
        this.works = new Map((v.works ?? []).map((w) => [w.work_id, w]));
        this.uses = usesByWork(this.vault.notes);
        this.termRe = termPattern(this.terms);
        // When the reader last read here, as the coordinator had it when the page loaded.
        this.sinceAt = Object.values(v.reads).reduce<string | undefined>(
          (a, r) => (r.read_at && (!a || r.read_at > a) ? r.read_at : a),
          undefined,
        );
        // Marks not yet sent stay read.
        this.reads = { ...v.reads };
        for (const id of this.pending) this.reads[id] = { state: "read" };
        this.error = undefined;
        this.emit();
      },
      (e: unknown) => {
        this.error = e;
        this.loading = undefined;
        this.emit();
      },
    );
    return this.loading;
  }

  status(id: string): ReadState {
    return readState(this.reads, id);
  }

  /**
   * Whether a note carries the "new" mark: unread, and revised since it was read or written after
   * the reader last read anything here. On a first visit nothing is marked: everything is unread,
   * and the weight of each title already says so.
   */
  fresh(id: string): boolean {
    const st = this.status(id);
    if (st === "read") return false;
    if (st === "changed") return true;
    const n = this.vault?.get(id);
    return Boolean(this.sinceAt && n && n.updated_at > this.sinceAt);
  }

  /** The line or note the keys act on (one at a time). */
  setFocus(key: string | undefined): void {
    if (this.focused === key) return;
    if (this.focused) this.focus.set(this.focused, undefined);
    this.focused = key;
    if (key) this.focus.set(key, true);
  }

  /** Lines of the ledger not read as they now stand: what the navigation shows. */
  ledgerUnread(): number {
    if (!this.vault) return this.view?.counts.ledger_unread ?? 0;
    return ledgerLines(this.vault).filter((n) => this.status(n.note_id) !== "read").length;
  }

  /** Reading marks itself: applied now, sent in a batch a moment later. */
  markRead(ids: readonly string[]): void {
    let changed = false;
    for (const id of ids) {
      if (!this.vault?.has(id) || this.status(id) === "read") continue;
      this.reads[id] = { state: "read", read_at: new Date().toISOString() };
      this.pending.add(id);
      changed = true;
    }
    if (!changed) return;
    this.emit();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 700);
  }

  async flush(keepalive = false): Promise<void> {
    clearTimeout(this.timer);
    if (!this.pending.size) return;
    const read = [...this.pending];
    this.pending.clear();
    const path = `/api/v1/projects/${enc(this.pid)}/vault/reads`;
    try {
      if (keepalive) {
        await fetch(path, {
          method: "POST",
          credentials: "same-origin",
          keepalive: true,
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ read }),
        });
        return;
      }
      const r = await api<{ reads: VaultView["reads"] }>(path, { body: { read } });
      for (const [id, st] of Object.entries(r.reads ?? {}))
        if (!this.pending.has(id)) this.reads[id] = st;
    } catch {
      // Not sent: try again with the next mark.
      for (const id of read) this.pending.add(id);
    }
  }

  async forget(): Promise<void> {
    clearTimeout(this.timer);
    this.pending.clear();
    await api(`/api/v1/projects/${enc(this.pid)}/vault/reads`, { body: { forget: true } });
    this.reads = {};
    this.depths.clear();
    local.set(this.lsKey("depths"), []);
    this.emit();
  }

  setDepth(key: string, d: Depth | undefined): void {
    this.depths.set(key, d);
    // The newest few hundred are kept.
    local.set(this.lsKey("depths"), this.depths.entries().slice(-400));
  }

  // -------------------------------------------------------------- what notes cite, loaded lazily

  private lazy<T>(slot: Lazy<T>, load: () => Promise<T>, set: (l: Lazy<T>) => void): void {
    if (slot.state !== "idle") return;
    set({ state: "loading" });
    load().then(
      (data) => {
        set({ state: "done", data });
        this.emit();
      },
      (error: unknown) => {
        set({ state: "error", error });
        this.emit();
      },
    );
  }

  /** What is loaded so far (stable until it changes: safe as a snapshot). */
  runsSlot() {
    return this.runs;
  }
  namesSlot() {
    return this.names;
  }
  drawerSlot() {
    return this.drawer;
  }

  /** Load the file drawer: the project's runs, each cited, set aside or unaccounted (ADR 0056). */
  loadDrawer(): void {
    this.lazy(
      this.drawer,
      async () =>
        (await api<{ runs: AccountedRun[] }>(`/api/v1/projects/${enc(this.pid)}/vault/runs`)).runs,
      (l) => {
        this.drawer = l;
      },
    );
  }
  studySlot(id: string): Lazy<StudyView> {
    return this.studies.get(id) ?? IDLE;
  }

  /** Load the project's runs by name and ID, for evidence values. */
  loadRuns(): void {
    this.lazy(
      this.runs,
      async () => {
        const byName = new Map<string, Run>();
        const byId = new Map<string, Run>();
        let token: string | undefined;
        let available = true;
        for (let i = 0; i < 10; i++) {
          const page: RunsPage = await api<RunsPage>(
            `/api/v1/tracking/runs?project=${enc(this.pid)}&max_results=1000${token ? `&page_token=${enc(token)}` : ""}`,
          );
          available = page.mlflow_available;
          for (const r of page.runs) {
            byId.set(r.info.run_id, r);
            if (r.info.run_name && !byName.has(r.info.run_name)) byName.set(r.info.run_name, r);
          }
          token = page.next_page_token;
          if (!token) break;
        }
        return { available, byName, byId };
      },
      (l) => {
        this.runs = l;
      },
    );
  }

  runValue(run: string, metric: string | undefined): RunValue | undefined {
    const idx = this.runs.data;
    if (!idx) return undefined;
    const r = idx.byName.get(run) ?? idx.byId.get(run);
    if (!r) return undefined;
    const m = metric ? r.data.metrics?.find((x) => x.key === metric) : undefined;
    return { runId: r.info.run_id, value: m?.value };
  }

  /** Load the titles of the project's research records and tasks, for "Distilled from". */
  loadNames(): void {
    this.lazy(
      this.names,
      async () => {
        const p = enc(this.pid);
        const out = new Map<string, string>();
        const [recs, tasks] = await Promise.all([
          api<{ records: ResearchRecord[] }>(`/api/v1/projects/${p}/research`).catch(() => ({
            records: [],
          })),
          api<{ tasks: { task_id: string; title: string }[] }>(`/api/v1/projects/${p}/tasks`).catch(
            () => ({ tasks: [] }),
          ),
        ]);
        for (const r of recs.records) out.set(r.record_id, r.title);
        for (const t of tasks.tasks) out.set(t.task_id, t.title);
        return out;
      },
      (l) => {
        this.names = l;
      },
    );
  }

  loadStudy(id: string): void {
    this.lazy(
      this.studySlot(id),
      () => api<StudyView>(`/api/v1/projects/${enc(this.pid)}/studies/${enc(id)}`),
      (l) => {
        this.studies.set(id, l);
      },
    );
  }
}

const stores = new Map<string, VaultStore>();

function vaultStore(pid: string): VaultStore {
  let s = stores.get(pid);
  if (!s) {
    s = new VaultStore(pid);
    stores.set(pid, s);
  }
  return s;
}

if (typeof window !== "undefined")
  window.addEventListener("pagehide", () => {
    for (const s of stores.values()) void s.flush(true);
  });

const VAULT_EVENTS = [
  "vault.note.created",
  "vault.note.updated",
  "vault.note.archived",
  "vault.note.restored",
  "vault.note.deleted",
  "vault.index.updated",
  "vault.work.created",
  "vault.work.updated",
  "vault.work.archived",
  "vault.work.restored",
  "vault.work.deleted",
];

/** The project's vault store, loaded, re-read when an agent writes the vault. */
export function useVaultStore(pid: string | undefined): VaultStore | undefined {
  const store = pid ? vaultStore(pid) : undefined;
  useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => store?.version ?? 0,
    () => 0,
  );
  useEffect(() => {
    if (store && !store.view && !store.error) void store.load();
  }, [store]);
  useEvents(
    () => {
      if (store) void store.load(true);
    },
    { project: pid ?? "", types: VAULT_EVENTS },
  );
  return store;
}

const noopSubscribe = () => () => {};

/** One note's read state, re-rendering only when it changes. */
export function useReadState(store: VaultStore, id: string): ReadState {
  return useSyncExternalStore(
    store.subscribe,
    () => store.status(id),
    () => "new" as ReadState,
  );
}

export function useKey<T>(ks: KeyStore<T>, key: string): T | undefined {
  return useSyncExternalStore(
    (f) => ks.subscribe(key, f),
    () => ks.get(key),
    () => undefined,
  );
}

/** Something a note cites, loading on first use; re-renders when it arrives. */
export function useSlot<T>(
  store: VaultStore,
  peek: () => Lazy<T>,
  start: () => void,
  key: string,
): Lazy<T> {
  const slot = useSyncExternalStore(store.subscribe, peek, peek);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what `start` loads
  useEffect(() => start(), [store, key]);
  return slot;
}

const caches = new WeakMap<object, Map<string, unknown>>();
/** Computed once per loaded vault (places, terms, linked prose): a reload starts afresh. */
export function cached<T>(owner: object, key: string, make: () => T): T {
  let m = caches.get(owner);
  if (!m) {
    m = new Map();
    caches.set(owner, m);
  }
  if (!m.has(key)) m.set(key, make());
  return m.get(key) as T;
}

/** The navigation's count: ledger lines not read. */
export function useLedgerUnread(pid: string | undefined): number {
  const store = useVaultStore(pid);
  return store?.ledgerUnread() ?? 0;
}
