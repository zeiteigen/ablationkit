/**
 * Directions (ADR 0057) where the researcher reads: a quiet "direct" control on a line of Standing
 * and on a note (and `d` on the focused one) opens a composer under it; the threads on a note fold
 * to one line ("1 direction · answered"); Standing opens with what waits for the researcher, the
 * rules in force and a composer for the project or the bottom line. Writing one records it; an
 * agent sees it at its next AblationKit call. Nothing here starts or messages an agent.
 */
import type { DirectionKind, DirectionRef, DirectionTarget } from "@ablationkit/protocol";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import "../styles/directions.css";
import {
  ago,
  type DirectionStore,
  type DirectionView,
  KINDS,
  STATUS_WORD,
  sessionWords,
  targetKey,
  useDirections,
} from "../lib/directions.ts";
import { refHref } from "../lib/research.ts";
import { resolveLinks } from "../lib/vault.ts";
import { Markdown } from "./Markdown.tsx";
import { useVaultUi } from "./Note.tsx";
import { Link } from "./ui.tsx";

const enc = encodeURIComponent;
const kindLabel = (k: DirectionKind) => KINDS.find((x) => x.kind === k)?.label ?? k;

/** The control in a note's header: opens the composer under it. */
export function DirectButton(props: { k: string }) {
  const ui = useVaultUi();
  const store = useDirections(ui.pid);
  const open = store.composing === props.k;
  return (
    <button
      type="button"
      className={`dr-direct${open ? " on" : ""}`}
      title="Direct the agents on this (d)"
      aria-expanded={open}
      onClick={() => store.compose(props.k)}
    >
      direct
    </button>
  );
}

/** Under a note: its composer when open, and its directions folded to one line. */
export function NoteDirections(props: { id: string; k: string }) {
  const ui = useVaultUi();
  const store = useDirections(ui.pid);
  const ds = store.on(`note:${props.id}`);
  const composing = store.composing === props.k;
  // A note's own page says it outright, below the note; elsewhere the header's control does.
  const page = props.k === `P:${props.id}`;
  if (!composing && !ds.length && !page) return null;
  return (
    <div className="dr-under">
      {ds.length ? <Folded ds={ds} store={store} /> : null}
      {page && !composing ? (
        <button
          type="button"
          className="dr-direct always dr-page"
          title="Direct the agents on this note (d)"
          onClick={() => store.compose(props.k)}
        >
          Direct the agents on this note
        </button>
      ) : null}
      {composing ? (
        <Composer
          store={store}
          targets={[{ target: { kind: "note", id: props.id }, label: "this note" }]}
          onClose={() => store.compose(undefined)}
        />
      ) : null}
    </div>
  );
}

function summary(ds: DirectionView[]): string {
  const n = `${ds.length} ${ds.length === 1 ? "direction" : "directions"}`;
  const by = new Map<string, number>();
  for (const d of ds) {
    const w =
      d.kind === "rule" && d.status !== "closed" && d.status !== "withdrawn"
        ? "rule in force"
        : (STATUS_WORD[d.status] ?? d.status);
    by.set(w, (by.get(w) ?? 0) + 1);
  }
  if (ds.length === 1) return `${n} · ${[...by.keys()][0]}`;
  return `${n} · ${[...by].map(([w, c]) => `${c} ${w}`).join(", ")}`;
}

/** "1 direction · answered", opening to the threads. Open when an answer waits for the reader. */
function Folded(props: { ds: DirectionView[]; store: DirectionStore }) {
  const [open, setOpen] = useState(false);
  const yours = props.ds.some((d) => d.waiting_on === "researcher");
  return (
    <div className="dr-fold" data-testid="direction-fold">
      <button
        type="button"
        className={`dr-sum${yours ? " dr-yours" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dr-caret">{open ? "▾" : "▸"}</span> {summary(props.ds)}
        {yours ? <span className="dr-wait"> · for you to read</span> : null}
      </button>
      {open ? props.ds.map((d) => <Thread key={d.direction_id} d={d} store={props.store} />) : null}
    </div>
  );
}

/** Where a ref of an answer opens. */
function RefLink(props: { r: DirectionRef }) {
  const ui = useVaultUi();
  const { r } = props;
  if (r.kind === "note") {
    const n = ui.vault.get(r.id);
    return (
      <a
        className="dr-ref"
        href={ui.links.href(r.id)}
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          ui.openSheet(r.id);
        }}
      >
        <span className="dr-rk">note</span> {n?.title ?? r.id}
      </a>
    );
  }
  const href =
    r.kind === "work"
      ? `${ui.base}/notebooks/library?work=${enc(r.id)}`
      : r.kind === "run"
        ? `${ui.base}/runs/r/${enc(ui.store.runValue(r.id, undefined)?.runId ?? r.id)}`
        : refHref(ui.base, r);
  return href ? (
    <Link className="dr-ref" to={href}>
      <span className="dr-rk">{r.kind}</span> {r.id}
    </Link>
  ) : (
    <span className="dr-ref">
      <span className="dr-rk">{r.kind}</span> {r.id}
    </span>
  );
}

const ACT_WORD: Record<string, string> = {
  ack: "acknowledged",
  answer: "answered",
  decline: "declined",
  close: "closed it",
  reopen: "reopened it",
  withdraw: "withdrew it",
};

/** One direction: the researcher's words, each turn after them, who was shown it, and the moves. */
export function Thread(props: { d: DirectionView; store: DirectionStore; showTarget?: boolean }) {
  const ui = useVaultUi();
  const { d, store } = props;
  // `[[note-id]]` in either side's words reads as the note's title, as in the vault.
  const linked = (t: string) => resolveLinks(t, (id) => ui.vault.get(id)?.title);
  const [reopening, setReopening] = useState(false);
  const [more, setMore] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const shown = [...new Set(d.deliveries.filter((x) => x.round === d.round).map((x) => x.session))];
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await f();
      setReopening(false);
      setMore("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const ended = d.status === "closed" || d.status === "withdrawn";
  const rule = d.kind === "rule";
  return (
    <div
      className={`dr-thread s-${d.status}`}
      data-testid="direction-thread"
      data-id={d.direction_id}
    >
      <div className="dr-turn dr-you">
        <div className="dr-h">
          <span className={`dr-kind k-${d.kind}`}>{kindLabel(d.kind)}</span>
          {props.showTarget ? <TargetLink d={d} /> : null}
          <span className="dr-when">you · {ago(d.created_at)}</span>
          <span className={`dr-st st-${d.status}`}>
            {rule && !ended ? "in force" : STATUS_WORD[d.status]}
          </span>
        </div>
        <Markdown text={linked(d.text)} notes={ui.links} base={ui.base} className="dr-text" />
      </div>
      {d.thread.map((e, i) => {
        const agent = e.by.kind === "agent";
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: turns in the order they were taken
            key={i}
            className={`dr-turn ${agent ? "dr-agent" : "dr-you"} a-${e.act}`}
          >
            <div className="dr-h">
              <span className="dr-who">
                {agent ? sessionWords(store.session(e.by.id)) : "you"} {ACT_WORD[e.act] ?? e.act}
              </span>
              <span className="dr-when">{ago(e.at)}</span>
            </div>
            {e.text ? (
              <Markdown text={linked(e.text)} notes={ui.links} base={ui.base} className="dr-text" />
            ) : null}
            {e.refs?.length ? (
              <div className="dr-refs">
                {e.refs.map((r) => (
                  <RefLink key={`${r.kind}:${r.id}`} r={r} />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {!ended ? (
        <p className="dr-seen">
          {shown.length
            ? `Shown to ${shown.map((s) => sessionWords(store.session(s))).join(", ")}${d.round > 1 ? ` (round ${d.round})` : ""}.`
            : store.liveSessions()
              ? "Not shown yet: a live agent session sees it at its next AblationKit call."
              : "Not shown yet: no agent session is live. Delivered when an agent session next calls AblationKit."}
        </p>
      ) : null}
      {reopening ? (
        <div className="dr-reopen">
          <textarea
            value={more}
            placeholder="What is still missing? (optional)"
            rows={2}
            onChange={(e) => setMore(e.target.value)}
            // biome-ignore lint/a11y/noAutofocus: opened by the reader's click
            autoFocus
          />
          <div className="dr-btns">
            <button
              type="button"
              className="dr-btn primary"
              disabled={busy}
              onClick={() => void run(() => store.act(d.direction_id, "reopen", more))}
            >
              Reopen
            </button>
            <button type="button" className="dr-btn" onClick={() => setReopening(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="dr-btns">
          {!rule && !ended && d.status !== "open" ? (
            <button
              type="button"
              className="dr-btn primary"
              disabled={busy}
              onClick={() => void run(() => store.act(d.direction_id, "close"))}
            >
              Close
            </button>
          ) : null}
          {d.status !== "open" && !(rule && d.status === "acknowledged") ? (
            <button
              type="button"
              className="dr-btn"
              disabled={busy}
              onClick={() => setReopening(true)}
            >
              Reopen
            </button>
          ) : null}
          {d.status !== "withdrawn" && d.status !== "closed" ? (
            <button
              type="button"
              className="dr-btn quiet"
              disabled={busy}
              onClick={() => void run(() => store.act(d.direction_id, "withdraw"))}
            >
              Withdraw
            </button>
          ) : null}
        </div>
      )}
      {err ? <p className="dr-err">{err}</p> : null}
      <span className="dr-id" title="The direction's ID, as the agent sees it">
        {d.direction_id}
      </span>
    </div>
  );
}

function TargetLink(props: { d: DirectionView }) {
  const ui = useVaultUi();
  const t = props.d.target;
  const title = props.d.target_title ?? t.id ?? t.kind;
  if (t.kind === "note" && t.id)
    return (
      <Link className="dr-target" to={`${ui.base}/standing?at=${enc(t.id)}`}>
        on {title}
      </Link>
    );
  if (t.kind === "project") return <span className="dr-target">on the project</span>;
  if (t.kind === "bottom_line") return <span className="dr-target">on the bottom line</span>;
  const href =
    t.kind === "run"
      ? `${ui.base}/runs/r/${enc(t.id ?? "")}`
      : refHref(ui.base, { kind: t.kind, id: t.id ?? "" });
  return href ? (
    <Link className="dr-target" to={href}>
      on {t.kind} {title}
    </Link>
  ) : (
    <span className="dr-target">
      on {t.kind} {title}
    </span>
  );
}

const PLACEHOLDER: Record<DirectionKind, string> = {
  ask: "What do you want explained? e.g. Why this baseline and not the tuned one?",
  doubt: "What would convince you? e.g. One seed: run three before calling this leaning.",
  do: "What next? e.g. Run the 1B model with the same tokenizer.",
  focus: "Why this line? e.g. This is the interesting result: push here before anything else.",
  park: "Why stop? e.g. Not worth more compute until the data question is settled.",
  rule: "The rule, for every session. e.g. Three seeds before anything is established.",
};

/** Kind chips, the text, and when it will arrive. */
export function Composer(props: {
  store: DirectionStore;
  targets: { target: DirectionTarget; label: string }[];
  onClose: () => void;
}) {
  const { store } = props;
  const [kind, setKind] = useState<DirectionKind>("ask");
  const [text, setText] = useState("");
  const [ti, setTi] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const target = props.targets[ti]?.target ?? props.targets[0]?.target;
  const send = async () => {
    if (!text.trim() || !target) return;
    setBusy(true);
    setErr(undefined);
    try {
      await store.create(target, kind, text.trim());
      setText("");
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };
  const live = Object.values(store.data?.sessions ?? {}).filter((s) => s.live);
  return (
    <div className="dr-compose" data-testid="direction-composer">
      {props.targets.length > 1 ? (
        <div className="dr-targets">
          {props.targets.map((t, i) => (
            <button
              key={targetKey(t.target)}
              type="button"
              className={`dr-chip${i === ti ? " on" : ""}`}
              aria-pressed={i === ti}
              onClick={() => setTi(i)}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
      {/* biome-ignore lint/a11y/useSemanticElements: six chips, one choice */}
      <div className="dr-kinds" role="group" aria-label="What you want">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            className={`dr-chip k-${k.kind}${kind === k.kind ? " on" : ""}`}
            aria-pressed={kind === k.kind}
            title={k.says}
            onClick={() => {
              setKind(k.kind);
              ref.current?.focus();
            }}
          >
            {k.label}
          </button>
        ))}
        <span className="dr-says">{KINDS.find((k) => k.kind === kind)?.says}</span>
      </div>
      <textarea
        ref={ref}
        value={text}
        rows={3}
        placeholder={PLACEHOLDER[kind]}
        aria-label="Your direction"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="dr-foot">
        <span className="dr-live">
          {live.length
            ? `${live.length === 1 ? `An agent session is live (${sessionWords(live[0])})` : `${live.length} agent sessions are live`}: ${live.length === 1 ? "it sees" : "each sees"} this at its next AblationKit call and ${kind === "rule" ? "acknowledges" : "answers"} it here.`
            : "No agent session is live: delivered when an agent session next calls AblationKit."}
        </span>
        <span className="dr-btns">
          <button type="button" className="dr-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dr-btn primary"
            disabled={busy || !text.trim()}
            onClick={() => void send()}
            title="Ctrl Enter"
          >
            Send
          </button>
        </span>
      </div>
      {err ? <p className="dr-err">{err}</p> : null}
    </div>
  );
}

/**
 * At the top of Standing: answers waiting for the researcher, the rules in force, what waits on
 * the agents, and directions on the project or the bottom line.
 */
export function StandingDirections() {
  const ui = useVaultUi();
  const store = useDirections(ui.pid);
  const [open, setOpen] = useState(false);
  if (!store.data) return null;
  const yours = store.waitingForYou();
  const rules = store.rules();
  const agents = store.waitingOnAgents().filter((d) => d.kind !== "rule");
  const general = (store.data.directions ?? []).filter(
    (d) =>
      (d.target.kind === "project" || d.target.kind === "bottom_line") &&
      d.kind !== "rule" &&
      d.waiting_on === "agent",
  );
  const composing = store.composing === "S:project";
  const live = store.liveSessions();
  const parts: string[] = [];
  if (yours.length)
    parts.push(
      `${yours.length} ${yours.length === 1 ? "answer waits" : "answers wait"} for you to read`,
    );
  if (agents.length)
    parts.push(`${agents.length} ${agents.length === 1 ? "waits" : "wait"} on an agent`);
  if (rules.length) parts.push(`${rules.length} ${rules.length === 1 ? "rule" : "rules"} in force`);
  const nothing = !parts.length;
  return (
    <section className={`dr-standing${nothing ? " dr-quiet" : ""}`} data-testid="directions">
      <div className="dr-row">
        <span className="v-eyebrow">Directions</span>
        <span className="dr-line">
          {nothing ? (
            <>
              Steer the agents from where you read: <b>direct</b> on any line (or <kbd>d</kbd>), or
              the project as a whole.
            </>
          ) : (
            `${parts.join(" · ")}.`
          )}{" "}
          <span className="v-faint">
            {live
              ? `${live === 1 ? "An agent session is" : `${live} agent sessions are`} live.`
              : "No agent session is live."}
          </span>
        </span>
        <button
          type="button"
          className={`dr-direct always${composing ? " on" : ""}`}
          aria-expanded={composing}
          onClick={() => store.compose("S:project")}
        >
          direct the project
        </button>
      </div>
      {composing ? (
        <Composer
          store={store}
          targets={[
            { target: { kind: "project" }, label: "The project as a whole" },
            { target: { kind: "bottom_line" }, label: "The bottom line" },
          ]}
          onClose={() => store.compose(undefined)}
        />
      ) : null}
      {yours.length ? (
        <div className="dr-group">
          <div className="dr-gh">For you to read</div>
          {yours.map((d) => (
            <Thread key={d.direction_id} d={d} store={store} showTarget />
          ))}
        </div>
      ) : null}
      {general.length ? (
        <div className="dr-group">
          <div className="dr-gh">On the project</div>
          {general.map((d) => (
            <Thread key={d.direction_id} d={d} store={store} showTarget />
          ))}
        </div>
      ) : null}
      {rules.length ? (
        <div className="dr-group">
          <button
            type="button"
            className="dr-gh dr-gh-b"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "▾" : "▸"} Rules in force
          </button>
          {open ? (
            rules.map((d) => <Thread key={d.direction_id} d={d} store={store} showTarget />)
          ) : (
            <ul className="dr-rules">
              {rules.map((d) => (
                <li key={d.direction_id}>
                  <Markdown text={d.text} inline />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
