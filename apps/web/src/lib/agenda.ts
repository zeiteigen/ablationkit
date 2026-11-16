/**
 * The researcher's agenda (ADR 0058), one store per project shared by the Agenda panel and the
 * ledger lines on Standing: loaded over REST, re-read when the agenda changes or an agent reads it
 * or records work, and written whole (`PUT …/agenda` with `if_revision`).
 */
import type { AgendaItem, AgendaLane, AgendaRule } from "@ablationkit/protocol";
import { useSyncExternalStore } from "react";
import { ApiError, api, useEvents } from "../api.ts";

export interface AgendaWork {
  tasks: { task_id: string; title: string; status: string; outcome?: string }[];
  jobs: number;
  running: number;
  edition?: { note_id: string; title: string; edition: string };
}

export interface AgendaViewItem extends AgendaItem {
  note?: { title: string; type: string; gist: string; standing?: string; archived?: boolean };
  work: AgendaWork;
}

export interface AgendaSession {
  token_id: string;
  label?: string;
  harness?: string;
  started_at: string;
  last_used_at?: string;
  seen_revision?: number;
  seen_at?: string;
}

export interface AgendaCheck {
  code: string;
  message: string;
  item?: string;
  job?: string;
  task?: string;
  session?: string;
}

export interface AgendaView {
  revision: number;
  updated_at: string;
  items: AgendaViewItem[];
  rules: AgendaRule[];
  sessions: AgendaSession[];
  checks: AgendaCheck[];
  last_change: string[];
}

/** An item as the PUT takes it. */
export interface AgendaEdit {
  item_id?: string;
  note_id?: string;
  text?: string;
  lane: AgendaLane;
  reason?: string;
}

const enc = encodeURIComponent;

export class AgendaStore {
  data: AgendaView | undefined;
  error: string | undefined;
  /** The item whose reason the researcher is asked for (just parked or dropped), and where. */
  asking: { id: string; at: "panel" | "line" } | undefined;
  version = 0;
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | undefined;
  private stale = false;

  constructor(readonly pid: string) {}

  readonly subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private bump(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  private get path(): string {
    return `/api/v1/projects/${enc(this.pid)}/agenda`;
  }

  load(): Promise<void> {
    // A change that lands while a read is in flight may postdate it: read once more after.
    if (this.loading) {
      this.stale = true;
      return this.loading;
    }
    this.stale = false;
    const read = api<AgendaView>(this.path)
      .then(
        (d) => {
          this.data = d;
          this.error = undefined;
        },
        (e: unknown) => {
          this.error = e instanceof Error ? e.message : String(e);
        },
      )
      .finally(() => {
        this.loading = undefined;
        this.bump();
      });
    this.loading = read.then(() => (this.stale ? this.load() : undefined));
    return this.loading;
  }

  ask(asking: AgendaStore["asking"]): void {
    this.asking = asking;
    this.bump();
  }

  /** The item a note is on the agenda as, if it is. */
  itemOf(noteId: string): AgendaViewItem | undefined {
    return this.data?.items.find((i) => i.note_id === noteId);
  }

  /** Write the agenda whole; a write that lost a race reloads and says so. */
  async save(items: AgendaEdit[], rules: { rule_id?: string; text: string }[]): Promise<boolean> {
    const cur = this.data;
    try {
      this.data = await api<AgendaView>(this.path, {
        method: "PUT",
        body: { items, rules, if_revision: cur?.revision ?? 0 },
      });
      this.error = undefined;
      this.bump();
      return true;
    } catch (e) {
      this.error =
        e instanceof ApiError && e.code === "revision_conflict"
          ? "The agenda changed in another window; this is the latest. Try again."
          : e instanceof Error
            ? e.message
            : String(e);
      await this.load();
      return false;
    }
  }

  /** The current agenda as edits, to change and save. */
  edits(): AgendaEdit[] {
    return (this.data?.items ?? []).map((i) =>
      i.note_id
        ? { note_id: i.note_id, lane: i.lane, ...(i.reason ? { reason: i.reason } : {}) }
        : {
            item_id: i.item_id,
            text: i.text ?? "",
            lane: i.lane,
            ...(i.reason ? { reason: i.reason } : {}),
          },
    );
  }

  rules(): { rule_id?: string; text: string }[] {
    return (this.data?.rules ?? []).map((r) => ({ rule_id: r.rule_id, text: r.text }));
  }

  /** Put a note on the agenda in a lane (or move it there), at the end of that lane. */
  placeNote(noteId: string, lane: AgendaLane, reason?: string): Promise<boolean> {
    const edits = this.edits().filter((e) => e.note_id !== noteId);
    return this.save(
      [...edits, { note_id: noteId, lane, ...(reason ? { reason } : {}) }],
      this.rules(),
    );
  }
}

const stores = new Map<string, AgendaStore>();

export function agendaStore(pid: string): AgendaStore {
  let s = stores.get(pid);
  if (!s) {
    s = new AgendaStore(pid);
    stores.set(pid, s);
    void s.load();
  }
  return s;
}

const RELOAD_ON = [
  "agenda.updated",
  "agenda.read",
  "task.created",
  "task.updated",
  "job.attempt.state",
  "vault.note.created",
  "vault.note.updated",
];

/** The project's agenda store, kept current as the researcher and agents act. */
export function useAgenda(pid: string): AgendaStore {
  const s = agendaStore(pid);
  useSyncExternalStore(
    s.subscribe,
    () => s.version,
    () => 0,
  );
  useEvents(() => void s.load(), { project: pid, types: RELOAD_ON });
  return s;
}
