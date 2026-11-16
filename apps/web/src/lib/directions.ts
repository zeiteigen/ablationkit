/**
 * The researcher's directions to the agents (ADR 0057), as the vault pages show them: loaded once
 * per project, re-read when one is written, answered or settled (events `direction.*`), and
 * which line's composer is open. Writing one records it; nothing here starts or messages an agent.
 */
import type { DirectionKind, DirectionTarget, ResearchDirection } from "@ablationkit/protocol";
import { useEffect, useSyncExternalStore } from "react";
import { api, useEvents } from "../api.ts";

export interface DirectionView extends ResearchDirection {
  waiting_on: "agent" | "researcher" | "none";
  target_title?: string;
  target_found: boolean;
}

export interface DirectionSession {
  harness?: string;
  label?: string;
  live: boolean;
}

interface Listing {
  directions: DirectionView[];
  sessions: Record<string, DirectionSession>;
  live_sessions: number;
  counts: { waiting_on_agent: number; waiting_on_researcher: number; rules: number };
}

export const KINDS: readonly { kind: DirectionKind; label: string; says: string }[] = [
  { kind: "ask", label: "Ask", says: "Explain or justify this" },
  {
    kind: "doubt",
    label: "Doubt",
    says: "I don't believe this: more evidence, or lower its standing",
  },
  { kind: "do", label: "Do", says: "Do this next" },
  { kind: "focus", label: "Focus", says: "Prioritise this line" },
  { kind: "park", label: "Park", says: "Stop spending on this line for now" },
  { kind: "rule", label: "Rule", says: "A standing rule for every session, until you withdraw it" },
];

export const STATUS_WORD: Record<string, string> = {
  open: "waiting for an agent",
  acknowledged: "acknowledged",
  answered: "answered",
  declined: "declined",
  closed: "closed",
  withdrawn: "withdrawn",
};

/** `note:id`, `run:name`, `bottom_line`, `project`: how a target is named in the API. */
export const targetKey = (t: DirectionTarget): string => (t.id ? `${t.kind}:${t.id}` : t.kind);

export class DirectionStore {
  data: Listing | undefined;
  error: unknown;
  version = 0;
  /** The key of the line whose composer is open (a note's key on the page, or `S:project`). */
  composing: string | undefined;
  private subs = new Set<() => void>();
  private loading: Promise<void> | undefined;

  constructor(readonly pid: string) {}

  subscribe = (f: () => void): (() => void) => {
    this.subs.add(f);
    return () => this.subs.delete(f);
  };

  private emit(): void {
    this.version++;
    for (const f of this.subs) f();
  }

  load(): Promise<void> {
    this.loading ??= api<Listing>(`/api/v1/projects/${encodeURIComponent(this.pid)}/directions`)
      .then(
        (d) => {
          this.data = d;
          this.error = undefined;
        },
        (e: unknown) => {
          this.error = e;
        },
      )
      .finally(() => {
        this.loading = undefined;
        this.emit();
      });
    return this.loading;
  }

  /** Directions on one target, newest first; withdrawn ones only when asked. */
  on(target: string, withdrawn = false): DirectionView[] {
    return (this.data?.directions ?? []).filter(
      (d) => targetKey(d.target) === target && (withdrawn || d.status !== "withdrawn"),
    );
  }

  waitingForYou(): DirectionView[] {
    return (this.data?.directions ?? []).filter((d) => d.waiting_on === "researcher");
  }

  rules(): DirectionView[] {
    return (this.data?.directions ?? []).filter(
      (d) => d.kind === "rule" && d.status !== "withdrawn" && d.status !== "closed",
    );
  }

  waitingOnAgents(): DirectionView[] {
    return (this.data?.directions ?? []).filter((d) => d.waiting_on === "agent");
  }

  session(id: string | undefined): DirectionSession | undefined {
    return id ? this.data?.sessions[id] : undefined;
  }

  liveSessions(): number {
    return this.data?.live_sessions ?? 0;
  }

  compose(key: string | undefined): void {
    this.composing = this.composing === key ? undefined : key;
    this.emit();
  }

  async create(target: DirectionTarget, kind: DirectionKind, text: string): Promise<void> {
    await api(`/api/v1/projects/${encodeURIComponent(this.pid)}/directions`, {
      body: { target, kind, text },
    });
    this.composing = undefined;
    await this.load();
  }

  async act(id: string, act: "close" | "reopen" | "withdraw", text?: string): Promise<void> {
    await api(
      `/api/v1/projects/${encodeURIComponent(this.pid)}/directions/${encodeURIComponent(id)}/${act}`,
      { body: text?.trim() ? { text: text.trim() } : {} },
    );
    await this.load();
  }
}

const stores = new Map<string, DirectionStore>();

const EVENTS = ["direction.created", "direction.updated"];

/** The project's directions, loaded, re-read when one changes anywhere. */
export function useDirections(pid: string): DirectionStore {
  let store = stores.get(pid);
  if (!store) {
    store = new DirectionStore(pid);
    stores.set(pid, store);
  }
  const s = store;
  useSyncExternalStore(
    s.subscribe,
    () => s.version,
    () => 0,
  );
  useEffect(() => {
    if (!s.data && !s.error) void s.load();
  }, [s]);
  useEvents(() => void s.load(), { project: pid, types: EVENTS });
  return s;
}

/** The store for a project if a page has loaded it (the vault's keys use it). */
export function directionStore(pid: string): DirectionStore | undefined {
  return stores.get(pid);
}

/** "2 min ago", "3 h ago", "Nov 12". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** An agent session in words: "claude-code in fraise", or "an agent session". */
export function sessionWords(s: DirectionSession | undefined): string {
  return s?.label ?? s?.harness ?? "an agent session";
}
