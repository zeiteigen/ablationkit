/**
 * The researcher's agenda on Standing (ADR 0058): the plan agents work from, edited in
 * place. Items sit in lanes (Now, Next, Parked, Dropped); each is a note of the ledger or a line
 * of the researcher's own text; the rules hold for every agent session. Agents read it through
 * `ablationkit mcp` and are told when it changes; this panel shows which live sessions have read
 * the current revision and, beside each item, what agents have done for it. Nothing here starts,
 * drives or messages an agent: it writes the record they read.
 *
 * Keys: on a row of the panel, n (Now), e (Next), p (Park), x (Drop), Alt+↑/↓ (reorder),
 * Delete (take it off); on a focused line of the ledger, n, e, p and x put that note on the agenda.
 */
import type { AgendaLane } from "@ablationkit/protocol";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  type AgendaEdit,
  type AgendaStore,
  type AgendaViewItem,
  useAgenda,
} from "../lib/agenda.ts";
import { cap, fmtDay, plural } from "../lib/vault.ts";
import { useVaultUi } from "./Note.tsx";
import { Link } from "./ui.tsx";

const LANES: readonly AgendaLane[] = ["now", "next", "parked", "dropped"];
const LABEL: Record<AgendaLane, string> = {
  now: "Now",
  next: "Next",
  parked: "Parked",
  dropped: "Dropped",
};
const SAYS: Record<AgendaLane, string> = {
  now: "what agents work on, in order",
  next: "after Now",
  parked: "not to be spent on for now",
  dropped: "decided against",
};
/** One key per lane, on a panel row and on a focused ledger line. */
const KEY_LANE: Record<string, AgendaLane> = { n: "now", e: "next", p: "parked", x: "dropped" };

function moveTo(s: AgendaStore, id: string, lane: AgendaLane, reason?: string): Promise<boolean> {
  const edits = s.edits();
  const i = edits.findIndex((e) => (e.item_id ?? `note:${e.note_id}`) === id);
  if (i < 0) return Promise.resolve(false);
  const [it] = edits.splice(i, 1) as [AgendaEdit];
  const moved: AgendaEdit = { ...it, lane };
  if (reason !== undefined) moved.reason = reason;
  else if (lane === "now" || lane === "next") delete moved.reason;
  edits.push(moved);
  return s.save(edits, s.rules());
}

function reorder(s: AgendaStore, id: string, dir: -1 | 1): Promise<boolean> {
  const edits = s.edits();
  const key = (e: AgendaEdit) => e.item_id ?? `note:${e.note_id}`;
  const i = edits.findIndex((e) => key(e) === id);
  const lane = edits[i]?.lane;
  let j = i + dir;
  while (j >= 0 && j < edits.length && edits[j]?.lane !== lane) j += dir;
  if (i < 0 || j < 0 || j >= edits.length) return Promise.resolve(false);
  [edits[i], edits[j]] = [edits[j] as AgendaEdit, edits[i] as AgendaEdit];
  return s.save(edits, s.rules());
}

function remove(s: AgendaStore, id: string): Promise<boolean> {
  return s.save(
    s.edits().filter((e) => (e.item_id ?? `note:${e.note_id}`) !== id),
    s.rules(),
  );
}

const itemKey = (i: AgendaViewItem) => i.item_id;

/** What agents did for an item: its tasks, its jobs and the latest edition that reports it. */
function WorkLine(props: { item: AgendaViewItem; base: string }) {
  const w = props.item.work;
  if (!w.tasks.length && !w.jobs) return <span className="ag-work ag-none">no agent work yet</span>;
  const open = w.tasks.filter((t) => t.status === "open").length;
  return (
    <span className="ag-work">
      {w.tasks.length ? (
        <span title={w.tasks.map((t) => `${t.title} (${t.outcome ?? t.status})`).join("\n")}>
          {plural(w.tasks.length, "task", "tasks")}
          {open ? ` (${open} open)` : ""}
        </span>
      ) : null}
      {w.jobs ? (
        <span>
          {plural(w.jobs, "job", "jobs")}
          {w.running ? ` (${w.running} running)` : ""}
        </span>
      ) : null}
      {w.edition ? (
        <Link to={`${props.base}/notebooks/n/${encodeURIComponent(w.edition.note_id)}`}>
          edition {fmtDay(w.edition.edition)}
        </Link>
      ) : null}
    </span>
  );
}

/** Set an item's reason where it stands. */
function withReason(s: AgendaStore, id: string, reason: string): Promise<boolean> {
  const edits = s
    .edits()
    .map((e) => ((e.item_id ?? `note:${e.note_id}`) === id ? { ...e, reason } : e));
  return s.save(edits, s.rules());
}

const asksWhy = (lane: AgendaLane) => lane === "parked" || lane === "dropped";

/** Why the researcher parked or dropped an item, asked right after; agents read it. */
function Reason(props: { s: AgendaStore; item: AgendaViewItem }) {
  const { s, item } = props;
  const [reason, setReason] = useState(item.reason ?? "");
  const close = () => s.ask(undefined);
  return (
    <form
      className="ag-ask"
      onSubmit={(e) => {
        e.preventDefault();
        const r = reason.trim();
        if (!r || r === item.reason) return close();
        void withReason(s, item.item_id, r).then(close);
      }}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: asked right after the researcher parked or dropped it
        autoFocus
        value={reason}
        aria-label="Why"
        placeholder={`${item.lane === "dropped" ? "Dropped" : "Parked"}. Why? Agents read this (Enter to save, Esc to skip).`}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
      />
    </form>
  );
}

function Row(props: { item: AgendaViewItem; num: number; s: AgendaStore }) {
  const ui = useVaultUi();
  const { item, s } = props;
  const id = itemKey(item);
  const lanes = LANES.filter((l) => l !== item.lane);
  const asking = s.asking?.at === "panel" && s.asking.id === id;
  const go = (lane: AgendaLane) => {
    void moveTo(s, id, lane).then((ok) => {
      if (ok && asksWhy(lane)) s.ask({ id, at: "panel" });
    });
  };
  const onKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if ((e.target as Element).closest("input, button, a")) return;
    if (e.metaKey || e.ctrlKey) return;
    const lane = KEY_LANE[e.key];
    if (lane && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (lane !== item.lane) go(lane);
      return;
    }
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      e.stopPropagation();
      void reorder(s, id, e.key === "ArrowUp" ? -1 : 1).then(() =>
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>(`[data-agenda-item="${id}"]`)?.focus(),
        ),
      );
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      void remove(s, id);
    }
  };
  const n = item.note;
  return (
    <li
      className={`ag-row ln-${item.lane}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a row takes the panel's keys (n, e, p, x, Alt+↑/↓)
      tabIndex={0}
      data-agenda-item={id}
      onKeyDown={onKey}
    >
      <span className="ag-num">{item.lane === "now" || item.lane === "next" ? props.num : ""}</span>
      <div className="ag-main">
        <div className="ag-title">
          {item.note_id ? (
            <button
              type="button"
              className="ag-note"
              title={n?.gist}
              onClick={() => ui.openSheet(item.note_id as string)}
            >
              {n?.title ?? item.note_id}
            </button>
          ) : (
            <span className="ag-text">{item.text}</span>
          )}
        </div>
        <div className="ag-sub">
          <span className="ag-kind">
            {n ? `${n.type}${n.standing ? `, ${n.standing.replace("_", " ")}` : ""}` : "your line"}{" "}
            <span className="ag-id">{id}</span>
          </span>
          {item.lane === "now" || item.lane === "next" ? (
            <WorkLine item={item} base={ui.base} />
          ) : null}
        </div>
        {item.reason && !asking ? (
          <div className="ag-reason">
            {cap(item.lane)}: {item.reason}
          </div>
        ) : null}
        {asking ? <Reason s={s} item={item} /> : null}
      </div>
      <div className="ag-acts">
        {item.lane === "now" || item.lane === "next" ? (
          <>
            <button type="button" title="Up (Alt+↑)" onClick={() => void reorder(s, id, -1)}>
              ↑
            </button>
            <button type="button" title="Down (Alt+↓)" onClick={() => void reorder(s, id, 1)}>
              ↓
            </button>
          </>
        ) : null}
        {lanes.map((l) => (
          <button
            key={l}
            type="button"
            title={`${LABEL[l]} (${Object.keys(KEY_LANE).find((k) => KEY_LANE[k] === l)})`}
            onClick={() => go(l)}
          >
            {l === "parked" ? "Park" : l === "dropped" ? "Drop" : LABEL[l]}
          </button>
        ))}
        <button
          type="button"
          title="Take it off the agenda (Delete)"
          onClick={() => void remove(s, id)}
        >
          ✕
        </button>
      </div>
    </li>
  );
}

function AddLine(props: { s: AgendaStore; lane: AgendaLane }) {
  const [text, setText] = useState("");
  return (
    <form
      className="ag-add"
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) return;
        void props.s
          .save([...props.s.edits(), { text: t, lane: props.lane }], props.s.rules())
          .then((ok) => ok && setText(""));
      }}
    >
      <input
        value={text}
        maxLength={300}
        aria-label={`Add a line to ${LABEL[props.lane]}`}
        placeholder={`Add a line to ${LABEL[props.lane]}…`}
        onChange={(e) => setText(e.target.value)}
      />
    </form>
  );
}

function Rules(props: { s: AgendaStore }) {
  const { s } = props;
  const [text, setText] = useState("");
  const rules = s.data?.rules ?? [];
  return (
    <div className="ag-rules" data-testid="agenda-rules">
      <div className="ag-lh">
        Rules <span className="ag-ls">every agent session follows these</span>
      </div>
      <ul>
        {rules.map((r) => (
          <li key={r.rule_id} className="ag-rule">
            <span className="ag-id">{r.rule_id}</span> {r.text}
            <button
              type="button"
              className="ag-x"
              title="Withdraw the rule"
              onClick={() =>
                void s.save(
                  s.edits(),
                  s.rules().filter((x) => x.rule_id !== r.rule_id),
                )
              }
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <form
        className="ag-add"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t) return;
          void s.save(s.edits(), [...s.rules(), { text: t }]).then((ok) => ok && setText(""));
        }}
      >
        <input
          value={text}
          maxLength={300}
          aria-label="Add a rule"
          placeholder="Add a rule, e.g. three seeds before anything is established…"
          onChange={(e) => setText(e.target.value)}
        />
      </form>
    </div>
  );
}

/** Which live agent sessions have read the agenda as it stands. */
function Readers(props: { s: AgendaStore }) {
  const d = props.s.data;
  if (!d || d.revision === 0) return null;
  const live = d.sessions;
  if (!live.length)
    return (
      <p className="ag-readers">
        No agent session is live; the next one reads revision {d.revision} as it starts.
      </p>
    );
  return (
    <p className="ag-readers" data-testid="agenda-readers">
      {live.map((x) => {
        const ok = (x.seen_revision ?? 0) >= d.revision;
        return (
          <span key={x.token_id} className={ok ? "ag-read" : "ag-unread"} title={x.token_id}>
            {x.label ?? x.harness ?? x.token_id}:{" "}
            {ok
              ? "read this revision"
              : x.seen_revision
                ? `read revision ${x.seen_revision}; is told on its next call`
                : "not read yet; is told on its next call"}
          </span>
        );
      })}
    </p>
  );
}

/** The agenda at the top of Standing. */
export function AgendaPanel(props: { pid: string }) {
  const ui = useVaultUi();
  const s = useAgenda(props.pid);
  const [more, setMore] = useState(false);
  const d = s.data;

  // A focused line of the ledger: n, e, p, x put its note on the agenda.
  const ref = useRef({ s, ui });
  ref.current = { s, ui };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as Element | null;
      if (t?.closest("input, textarea, select, [contenteditable], .ag-row")) return;
      if (e.metaKey || e.altKey || e.ctrlKey || document.querySelector(".overlay")) return;
      const lane = KEY_LANE[e.key];
      const { s: st, ui: u } = ref.current;
      const k = u.store.focused;
      if (!lane || !k?.startsWith("L:") || k.includes(">")) return;
      const id = k.slice(2);
      const n = u.vault.get(id);
      if (!n || (n.type !== "question" && n.type !== "claim")) return;
      e.preventDefault();
      if (st.itemOf(id)?.lane === lane) return;
      void st.placeNote(id, lane).then((ok) => {
        if (ok && asksWhy(lane)) st.ask({ id: `note:${id}`, at: "line" });
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!d) return s.error ? <p className="ag-err">The agenda did not load: {s.error}</p> : null;
  const of = (l: AgendaLane) => d.items.filter((i) => i.lane === l);
  const lane = (l: AgendaLane, add: boolean) => {
    const items = of(l);
    return (
      <div className={`ag-lane ln-${l}`} data-testid={`agenda-${l}`}>
        <div className="ag-lh">
          {LABEL[l]} <span className="ag-ls">{SAYS[l]}</span>
        </div>
        {items.length ? (
          <ol>
            {items.map((i, n) => (
              <Row key={i.item_id} item={i} num={n + 1} s={s} />
            ))}
          </ol>
        ) : l === "now" ? (
          <p className="ag-empty">
            Nothing in Now: agents choose from the ledger themselves. Put a question or claim here
            from its line below (<kbd>n</kbd>), or add a line.
          </p>
        ) : null}
        {add ? <AddLine s={s} lane={l} /> : null}
      </div>
    );
  };
  const parked = of("parked").length;
  const dropped = of("dropped").length;
  const asked = s.asking;
  const showMore =
    more ||
    (asked?.at === "panel" && d.items.some((i) => i.item_id === asked.id && asksWhy(i.lane)));
  const checks = d.checks;
  return (
    <section className="ag" data-testid="agenda" aria-label="Agenda">
      <header className="ag-head">
        <span className="v-eyebrow">Agenda</span>
        <span className="ag-meta">
          {d.revision
            ? `revision ${d.revision}, ${fmtDay(d.updated_at.slice(0, 10))} ${new Date(d.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "not written yet"}
          {" · "}agents read it; only you change it
        </span>
      </header>
      {s.error ? <p className="ag-err">{s.error}</p> : null}
      <div className="ag-cols">
        <div className="ag-plan">
          {lane("now", true)}
          {lane("next", true)}
          {parked || dropped ? (
            <button type="button" className="ag-more" onClick={() => setMore(!more)}>
              {showMore ? "Hide" : "Show"} {parked ? `${parked} parked` : ""}
              {parked && dropped ? " and " : ""}
              {dropped ? `${dropped} dropped` : ""}
            </button>
          ) : null}
          {showMore ? (
            <>
              {parked ? lane("parked", false) : null}
              {dropped ? lane("dropped", false) : null}
            </>
          ) : null}
        </div>
        <Rules s={s} />
      </div>
      {checks.length ? (
        <ul className="ag-checks" data-testid="agenda-checks">
          {checks.map((c) => (
            <li key={`${c.code}:${c.task ?? c.job ?? c.session}`}>
              <span className="ag-code">{c.code.replace("_", " ")}</span> {c.message}
            </li>
          ))}
        </ul>
      ) : null}
      <Readers s={s} />
      <p className="ag-keys">
        On a line of the ledger: <kbd>n</kbd> Now · <kbd>e</kbd> Next · <kbd>p</kbd> Park ·{" "}
        <kbd>x</kbd> Drop. On a row here, the same keys, <kbd>Alt</kbd>+<kbd>↑</kbd>
        <kbd>↓</kbd> to reorder.
      </p>
    </section>
  );
}

/** On a line of the ledger: where its note is on the agenda, and the one-key moves. */
export function AgendaLine(props: { pid: string; noteId: string }) {
  const s = useAgenda(props.pid);
  const ui = useVaultUi();
  const n = ui.vault.get(props.noteId);
  if (!s.data || !n || (n.type !== "question" && n.type !== "claim")) return null;
  const item = s.itemOf(props.noteId);
  const pos = item ? s.data.items.filter((i) => i.lane === item.lane).indexOf(item) + 1 : 0;
  const asking = item && s.asking?.at === "line" && s.asking.id === item.item_id;
  return (
    <div className={`ag-line${asking ? " ag-asking" : ""}`} data-agenda-lane={item?.lane ?? "none"}>
      {item ? (
        <span className={`ag-chip ln-${item.lane}`}>
          {LABEL[item.lane]}
          {item.lane === "now" || item.lane === "next" ? ` ${pos}` : ""}
        </span>
      ) : null}
      {item?.reason && !asking ? <span className="ag-reason">{item.reason}</span> : null}
      {asking ? <Reason s={s} item={item} /> : null}
      <span className="ag-acts">
        {LANES.filter((l) => l !== item?.lane).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() =>
              void s.placeNote(props.noteId, l).then((ok) => {
                if (ok && asksWhy(l)) s.ask({ id: `note:${props.noteId}`, at: "line" });
              })
            }
            title={`Put it in ${LABEL[l]} on the agenda`}
          >
            {l === "parked" ? "Park" : l === "dropped" ? "Drop" : LABEL[l]}{" "}
            <kbd>{Object.keys(KEY_LANE).find((k) => KEY_LANE[k] === l)}</kbd>
          </button>
        ))}
      </span>
    </div>
  );
}
