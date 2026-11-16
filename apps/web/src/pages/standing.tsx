/**
 * Standing (ADR 0049): where the project stands, the page a researcher arrives at. The bottom
 * line, what is new or revised since they last read, the claims by standing, the decisions in
 * force and the open questions; each line an atomic note of the vault that unfolds in place, with
 * "in context" leading to the notebook that argues it. It replaces Review: nothing here asks the
 * reader to do anything, and reading marks itself.
 */
import type { VaultNote } from "@ablationkit/protocol";
import { memo, type ReactNode, useLayoutEffect, useMemo, useState } from "react";
import { AgendaLine, AgendaPanel } from "../components/Agenda.tsx";
import { StandingDirections } from "../components/Directions.tsx";
import { Markdown } from "../components/Markdown.tsx";
import {
  Inline,
  type LedgerMeta,
  lineText,
  NoteView,
  useStoreVersion,
  useVaultUi,
} from "../components/Note.tsx";
import { Link } from "../components/ui.tsx";
import { afterPaint, flash, mainEl, noteEl, reveal } from "../components/vault-dom.ts";
import {
  bearsOn,
  cap,
  depthIndex,
  edDay,
  fmtDay,
  newsSentence,
  nothingEstablished,
  numWord,
  plainLinks,
  plural,
  STANDING,
} from "../lib/vault.ts";
import { local, useVaultStore } from "../lib/vault-store.ts";

const SHOW_QUESTIONS = 6;
const stamp = (n: VaultNote) => n.updated ?? n.created ?? "";

export const StandingPage = memo(function StandingPage(props: {
  name: string;
  at: string | undefined;
}) {
  const ui = useVaultUi();
  const { vault: v, store } = ui;
  const L = v.ledger;
  const [allQ, setAllQ] = useState(() => local.get(store.lsKey("allQ"), false));

  const claimNum = useMemo(() => {
    const m = new Map<string, number>();
    let i = 0;
    for (const g of ["established", "leaning", "open", "ruled_out"] as const)
      for (const c of L.groups[g]) m.set(c.note_id, ++i);
    return m;
  }, [L]);
  const bears = useMemo(
    () => new Map(L.questions.map((q) => [q.note_id, bearsOn(v, q.note_id)])),
    [v, L],
  );
  const questions = useMemo(() => {
    const first = (q: VaultNote) =>
      Math.min(...(bears.get(q.note_id) ?? []).map((c) => claimNum.get(c) ?? 99), 99);
    return [...L.questions].sort((a, b) => first(a) - first(b) || stamp(b).localeCompare(stamp(a)));
  }, [L, bears, claimNum]);
  const questionsOn = (cid: string) => questions.filter((q) => bears.get(q.note_id)?.includes(cid));
  const targetHidden =
    props.at !== undefined && questions.findIndex((q) => q.note_id === props.at) >= SHOW_QUESTIONS;
  const showAll = allQ || targetHidden;

  // Arriving: at a line (its summary opened, read, focused, in view), or where the reader was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on arrival only
  useLayoutEffect(() => {
    const main = mainEl();
    if (props.at && v.has(props.at)) {
      const k = `L:${props.at}`;
      if (depthIndex(store.depths.get(k) ?? "title") < 1) ui.setDepth(k, props.at, "summary");
      store.markRead([props.at]);
      store.setFocus(k);
      afterPaint(() => {
        const el = noteEl(k);
        if (!el) return;
        reveal(el, "center");
        flash(el);
      });
    } else if (main) main.scrollTop = local.get(store.lsKey("scroll:ledger"), 0);
  }, [props.at]);

  const showQuestions = (cid: string) => {
    const qs = questionsOn(cid);
    const go = () => {
      const els = qs.map((q) => noteEl(`L:${q.note_id}`)).filter((x) => x !== null);
      if (!els[0]) return;
      store.setFocus(`L:${qs[0]?.note_id}`);
      reveal(els[0], "center");
      for (const el of els) flash(el);
    };
    if (!showAll && qs.some((q) => questions.indexOf(q) >= SHOW_QUESTIONS)) {
      setAllQ(true);
      local.set(store.lsKey("allQ"), true);
      afterPaint(go);
    } else go();
  };

  const line = (n: VaultNote, meta: LedgerMeta, dflt: "gist" | "title") => (
    <NoteView
      key={n.note_id}
      id={n.note_id}
      k={`L:${n.note_id}`}
      level={0}
      dflt={dflt}
      ledger={meta}
    />
  );
  const claimLine = (c: VaultNote, group: string) => {
    const qs = questionsOn(c.note_id);
    return line(
      c,
      {
        num: claimNum.get(c.note_id),
        group,
        questions: qs,
        onQuestions: () => showQuestions(c.note_id),
        agenda: <AgendaLine pid={ui.pid} noteId={c.note_id} />,
      },
      "gist",
    );
  };
  const dnum = (d: VaultNote) => Number(/^D(\d+)/.exec(d.title)?.[1] ?? 999);
  const decisions = [...L.decisions].sort(
    (a, b) => dnum(a) - dnum(b) || stamp(a).localeCompare(stamp(b)),
  );
  const fund = v.shelf[0];

  return (
    <div className="v-ledger v-page-w" data-testid="standing">
      <header className="v-ph">
        <div className="v-eyebrow">{props.name}</div>
        <h1 className="v-hand">Where it stands</h1>
      </header>
      {L.bottom_line ? (
        <div className="v-bl" data-testid="bottom-line">
          <p>
            <Inline text={lineText(ui, "bottom-line", L.bottom_line, true)} />
          </p>
        </div>
      ) : (
        <p className="v-empty">
          The vault has no bottom line yet: the claims below say it in parts.
        </p>
      )}
      {/* What waits for the researcher (ADR 0057), then the plan agents work from (ADR 0058). */}
      <StandingDirections />
      <AgendaPanel pid={ui.pid} />
      <News />

      <Group cls="established" tone="ok" label="Established" says={STANDING["established"]?.says}>
        {L.groups.established.length ? (
          L.groups.established.map((c) => claimLine(c, "Established"))
        ) : (
          <p className="v-empty">{nothingEstablished(L.claims)}</p>
        )}
      </Group>
      {(["leaning", "open", "ruled_out"] as const).map((g) => {
        const st = STANDING[g] as { label: string; tone: string; says: string };
        const list = L.groups[g];
        return (
          <Group key={g} cls={g} tone={st.tone} label={cap(st.label)} says={st.says}>
            {list.length ? (
              list.map((c) => claimLine(c, cap(st.label)))
            ) : (
              <p className="v-empty">
                Nothing {g === "ruled_out" ? "has been ruled out" : `is ${st.label}`} yet.
              </p>
            )}
          </Group>
        );
      })}

      <Group cls="dec" label="Decisions in force" says={STANDING["in_force"]?.says}>
        {decisions.length ? (
          decisions.map((d) => line(d, { group: "Decisions in force" }, "title"))
        ) : (
          <p className="v-empty">No decision is recorded.</p>
        )}
        {L.proposed.length || L.superseded.length ? (
          <p className="v-empty">{otherDecisions(L.proposed.length, L.superseded.length)}</p>
        ) : null}
      </Group>

      <Group
        cls="q"
        label="Open questions"
        says="Not known yet; each sits after the claims it bears on."
      >
        {questions.length ? null : <p className="v-empty">No question is open.</p>}
        {(showAll ? questions : questions.slice(0, SHOW_QUESTIONS)).map((q) => {
          const on = (bears.get(q.note_id) ?? [])
            .map((c) => claimNum.get(c))
            .filter((x): x is number => x !== undefined)
            .sort((a, b) => a - b);
          const onText: ReactNode = on.length ? (
            <span
              className="v-on"
              title={(bears.get(q.note_id) ?? [])
                .map((c) => `${claimNum.get(c)}. ${v.get(c)?.title}`)
                .join("\n")}
            >
              bears on {on.join(", ")}
            </span>
          ) : undefined;
          return line(
            q,
            {
              group: "Open questions",
              on: onText,
              agenda: <AgendaLine pid={ui.pid} noteId={q.note_id} />,
            },
            "title",
          );
        })}
        {questions.length > SHOW_QUESTIONS && !targetHidden ? (
          <button
            type="button"
            className="v-more-q"
            onClick={() => {
              setAllQ(!allQ);
              local.set(store.lsKey("allQ"), !allQ);
            }}
          >
            {allQ
              ? "Show fewer"
              : `${cap(numWord(questions.length - SHOW_QUESTIONS))} more open ${questions.length - SHOW_QUESTIONS === 1 ? "question" : "questions"}`}
          </button>
        ) : null}
        {L.answered.length ? (
          <p className="v-empty">
            {cap(plural(L.answered.length, "question has", "questions have"))} been answered; they
            are in the notebooks.
          </p>
        ) : null}
      </Group>

      <footer className="v-lfoot">
        This page lists what the project believes, does and does not know. The explanations and
        arguments are in <Link to={`${ui.base}/notebooks`}>the notebooks</Link>
        {fund ? (
          <>
            , starting with{" "}
            <Link to={`${ui.base}/notebooks/n/${encodeURIComponent(fund.note_id)}`}>
              {fund.title}
            </Link>
          </>
        ) : null}
        .
        <button
          type="button"
          className="v-reset"
          onClick={() => {
            void store.forget().then(() => {
              setAllQ(false);
              local.set(store.lsKey("allQ"), false);
            });
          }}
        >
          Forget what I have read
        </button>
      </footer>
    </div>
  );
});

/**
 * On the project's Overview (ADR 0055): where it stands, in brief. The bottom line, what is new
 * since the reader last read (Standing's own sentence) and the claims counted by standing, each
 * a way into Standing. A project with no vault says so.
 */
export function OverviewBrief(props: { pid: string; base: string }) {
  const store = useVaultStore(props.pid);
  const v = store?.vault;
  if (!store || (!v && !store.error))
    return (
      <section className="card ov-brief" data-testid="overview-standing">
        <h2>Where it stands</h2>
        <p className="faint small">Loading…</p>
      </section>
    );
  if (!v?.notes.length)
    return (
      <section className="card ov-brief" data-testid="overview-standing">
        <h2>Where it stands</h2>
        <p className="muted">
          This project has no vault yet: agents write it as they work, and it becomes the place to
          read where the project stands.{" "}
          <Link to={`${props.base}/standing`}>What the vault is →</Link>
        </p>
      </section>
    );
  const L = v.ledger;
  const titleOf = (id: string) => v.get(id)?.title;
  const unread = store.ledgerUnread();
  const news = newsSentence(v, (id) => store.status(id));
  const counts: [string, number, string][] = [
    ["established", L.groups.established.length, "ok"],
    ["leaning", L.groups.leaning.length, "warn"],
    ["open", L.groups.open.length, "info"],
    ["ruled out", L.groups.ruled_out.length, "err"],
  ];
  return (
    <section className="card ov-brief" data-testid="overview-standing">
      <h2>
        Where it stands{" "}
        <Link to={`${props.base}/standing`} className="small">
          {unread ? `${unread} ${unread === 1 ? "line" : "lines"} unread →` : "Standing →"}
        </Link>
      </h2>
      {L.bottom_line ? (
        <Markdown text={plainLinks(L.bottom_line, titleOf)} className="ov-bl" />
      ) : (
        <p className="faint">No bottom line yet: the claims say it in parts.</p>
      )}
      {news ? <p className="ov-news">{news}</p> : null}
      <p className="ov-counts small">
        <Link to={`${props.base}/standing`} className="ov-link">
          {counts.map(([label, n, tone], i) => (
            <span key={label} className={n ? `tone-${tone}` : "faint"}>
              {i ? <span className="faint"> · </span> : null}
              {n} {label}
            </span>
          ))}
          <span className="faint">
            {" "}
            · {L.decisions.length} {L.decisions.length === 1 ? "decision" : "decisions"} in force ·{" "}
            {L.questions.length} open {L.questions.length === 1 ? "question" : "questions"}
          </span>
        </Link>
      </p>
      <p className="small">
        <Link to={`${props.base}/notebooks`}>Notebooks →</Link>
      </p>
    </section>
  );
}

function otherDecisions(proposed: number, superseded: number): string {
  const parts: string[] = [];
  if (proposed) parts.push(`${plural(proposed, "decision is", "decisions are")} proposed`);
  if (superseded)
    parts.push(
      proposed
        ? `${plural(superseded, "was", "were")} superseded`
        : `${plural(superseded, "decision was", "decisions were")} superseded`,
    );
  return `${cap(parts.join("; "))}; they are in the notebooks.`;
}

function Group(props: {
  cls: string;
  label: string;
  says: string | undefined;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <section className={`v-grp g-${props.cls}`}>
      <h2 className="v-gh">
        <span className={props.tone ? `tone-${props.tone}` : undefined}>{props.label}</span>{" "}
        <span className="v-gs">{props.says}</span>
      </h2>
      {props.children}
    </section>
  );
}

/** What is new or revised since the reader last read, and the last session while it is unread. */
function News() {
  const ui = useVaultUi();
  const { vault: v, store } = ui;
  useStoreVersion(store);
  const s = newsSentence(v, (id) => store.status(id));
  const marked = v.ledger.claims.some((c) => store.fresh(c.note_id));
  const ed = v.editions.at(-1);
  const edUnread = ed ? [...v.under(ed.note_id)].some((id) => store.status(id) !== "read") : false;
  if (!s && !(ed && edUnread)) return null;
  return (
    <section className="v-since" data-testid="news">
      <div className="v-eyebrow">What is new</div>
      {s ? (
        <p className="v-since-s">
          {s}
          {marked ? <span className="v-faint"> They carry a mark below.</span> : null}
        </p>
      ) : null}
      {ed && edUnread ? (
        <p className="v-since-ed">
          <span className="v-faint">The last session, {fmtDay(edDay(ed))}:</span>{" "}
          <Inline text={lineText(ui, `g:${ed.note_id}`, ed.gist, false)} />{" "}
          <Link className="v-go" to={`${ui.base}/notebooks/n/${encodeURIComponent(ed.note_id)}`}>
            Read what it established{" "}
            <span className="v-faint">{v.minutes(ed.note_id, "summary")} min</span>
          </Link>
        </p>
      ) : null}
    </section>
  );
}
