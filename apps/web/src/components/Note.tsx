/**
 * A note of the vault (ADR 0049), one renderer for every place it appears: a line of the ledger,
 * a note embedded in a notebook or in another note, the sheet beside the page, the tree's preview.
 * Each reads at three cumulative depths (gist, summary, full text) set by three dots, the title or
 * the keys; its full text embeds the notes it rests on, which unfold in turn. Unfolding to the
 * summary is reading it: the mark is sent to the coordinator (`vault-store.ts`).
 */
import type { VaultNote } from "@ablationkit/protocol";
import { type Part, ROLE_WORDS, shortCite, type Vault } from "@ablationkit/vault";
import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { refHref } from "../lib/research.ts";
import {
  DEPTH_WORD,
  DEPTHS,
  type Depth,
  depthIndex,
  evidenceRows,
  fmtDay,
  fmtDiff,
  fmtValue,
  hasFull,
  libraryHref,
  linkTerms,
  metricName,
  type Place,
  placesOf,
  plural,
  resolveLinks,
  STANDING,
  short,
  termName,
  termsOf,
  typeWord,
} from "../lib/vault.ts";
import { cached, useKey, useReadState, useSlot, type VaultStore } from "../lib/vault-store.ts";
import { DirectButton, NoteDirections } from "./Directions.tsx";
import { Figure } from "./Figure.tsx";
import { Markdown, type NoteLinks } from "./Markdown.tsx";
import { Link } from "./ui.tsx";
import { RunsBehind } from "./Witness.tsx";

const enc = encodeURIComponent;

/** What every note on a vault page shares. */
export interface VaultUi {
  pid: string;
  base: string;
  store: VaultStore;
  vault: Vault;
  /** The notebook page being read, if any. */
  root: string | undefined;
  links: NoteLinks;
  openSheet(id: string): void;
  placeHref(p: Place): string;
  setDepth(key: string, id: string, d: Depth): void;
}

export const VaultUiContext = createContext<VaultUi | undefined>(undefined);

export function useVaultUi(): VaultUi {
  const v = useContext(VaultUiContext);
  if (!v) throw new Error("useVaultUi outside a vault page");
  return v;
}

/** Re-render on any change to the store (aggregates: counts, progress). */
export function useStoreVersion(store: VaultStore): number {
  return useSyncExternalStore(
    store.subscribe,
    () => store.version,
    () => 0,
  );
}

// ---------------------------------------------------------------- derived, once per loaded vault

export function places(ui: VaultUi, id: string): Place[] {
  return cached(ui.vault, `places:${id}`, () => placesOf(ui.vault, id));
}

function terms(ui: VaultUi, id: string): VaultNote[] {
  return cached(ui.vault, `terms:${id}`, () =>
    termsOf(ui.vault, id, ui.store.terms, ui.store.termRe),
  );
}

function flatIds(ui: VaultUi, id: string): string[] {
  return cached(ui.vault, `flat:${id}`, () => ui.vault.flatten(id).map((x) => x.note.note_id));
}

const titleOf = (v: Vault) => (id: string) => v.get(id)?.title;

/** Text for one line (a gist, the bottom line): links resolved, terms linked when asked. */
export function lineText(ui: VaultUi, key: string, text: string, linkTermsToo: boolean): string {
  return cached(ui.vault, `line:${key}:${linkTermsToo}`, () => {
    const t = resolveLinks(text, titleOf(ui.vault));
    return linkTermsToo ? (linkTerms([t], ui.store.terms, ui.store.termRe)[0] as string) : t;
  });
}

interface Prose {
  gist: string;
  summary: Part[];
  wc: string | undefined;
  full: Part[];
}

/**
 * A note's own prose in reading order, links resolved and the first mention of each term linked
 * once across all of it (gist, summary, what would change it, full text).
 */
export function noteProse(ui: VaultUi, n: VaultNote, gistTerms: boolean): Prose {
  return cached(ui.vault, `prose:${n.note_id}:${gistTerms}`, () => {
    const c = ui.vault.compose(n.note_id);
    const t = titleOf(ui.vault);
    const texts: string[] = [];
    const slot = (s: string | undefined) => {
      if (s === undefined) return -1;
      texts.push(resolveLinks(s, t));
      return texts.length - 1;
    };
    const g = gistTerms ? slot(n.gist) : -1;
    const sum = c.summary.map((p) => (p.type === "prose" ? slot(p.md) : -1));
    const wc = slot(n.type === "claim" ? n.would_change : undefined);
    const full = c.full.map((p) => (p.type === "prose" ? slot(p.md) : -1));
    const linked = linkTerms(texts, ui.store.terms, ui.store.termRe, [n.note_id]);
    const at = (i: number, dflt: string) => (i >= 0 ? (linked[i] as string) : dflt);
    const back = (ps: Part[], idx: number[]): Part[] =>
      ps.map((p, i) => (p.type === "prose" ? { type: "prose", md: at(idx[i] ?? -1, p.md) } : p));
    return {
      gist: g >= 0 ? at(g, n.gist) : resolveLinks(n.gist, t),
      summary: back(c.summary, sum),
      wc: wc >= 0 ? at(wc, "") : undefined,
      full: back(c.full, full),
    };
  });
}

// ---------------------------------------------------------------- small parts

export function Inline(props: { text: string; className?: string }) {
  const ui = useVaultUi();
  return <Markdown text={props.text} notes={ui.links} inline className={props.className} />;
}

function Prose(props: { md: string; lead?: boolean }) {
  const ui = useVaultUi();
  return (
    <Markdown
      text={props.md}
      notes={ui.links}
      base={ui.base}
      className={props.lead ? "v-prose v-lead" : "v-prose"}
    />
  );
}

function Dots(props: { d: Depth; canFull: boolean; onSet: (d: Depth) => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: three buttons, one control
    <span className="v-dots" role="group" aria-label="Depth">
      {(["gist", "summary", "full"] as const).map((x, i) => (
        <button
          key={x}
          type="button"
          className={`${i <= depthIndex(props.d) ? "on" : ""}${x === "full" && !props.canFull ? " none" : ""}`}
          title={DEPTH_WORD[x]}
          aria-label={DEPTH_WORD[x]}
          aria-pressed={i <= depthIndex(props.d)}
          onClick={() => props.onSet(x)}
        />
      ))}
    </span>
  );
}

/** A term (concept or method) as a link that opens it beside the page. */
function TermLink(props: { note: VaultNote; children?: ReactNode }) {
  const ui = useVaultUi();
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    ui.openSheet(props.note.note_id);
  };
  return (
    <a
      className="v-wl v-wl-term"
      data-note={props.note.note_id}
      href={ui.links.href(props.note.note_id)}
      onClick={click}
    >
      {props.children ?? termName(ui.store.terms, props.note)}
    </a>
  );
}

function Sep() {
  return <span className="v-sep"> · </span>;
}

function joined(items: ReactNode[]): ReactNode[] {
  return items.flatMap((x, i) => (i ? [<Sep key={`s${String(i)}`} />, x] : [x]));
}

// ---------------------------------------------------------------- the note

export interface LedgerMeta {
  num?: string | number | undefined;
  /** The group the line sits in (for the trail). */
  group: string;
  /** "bears on 4, 8" for a question. */
  on?: ReactNode;
  /** The questions that bear on a claim: scroll to them. */
  questions?: VaultNote[];
  onQuestions?: () => void;
  /** Where the note is on the researcher's agenda, and the moves (ADR 0058). */
  agenda?: ReactNode;
}

export function NoteView(props: {
  id: string;
  /** Where this instance is: a scope letter and the IDs down to it ("L:claim>finding"). */
  k: string;
  level: number;
  dflt: Depth;
  ledger?: LedgerMeta | undefined;
  sheet?: boolean;
  /** A line of "Rests on": it can fold to its title. */
  rests?: boolean;
  /** The note is the page itself (its own page or the tree's preview). */
  page?: boolean;
}) {
  const ui = useVaultUi();
  const { store } = ui;
  const n = ui.vault.get(props.id);
  const d = useKey(store.depths, props.k) ?? props.dflt;
  const st = useReadState(store, props.id);
  const focused = useKey(store.focus, props.k) ?? false;
  const ref = useRef<HTMLElement>(null);
  const ki = depthIndex(d);

  // Reading marks itself: held on screen at its summary or deeper for a moment.
  useEffect(() => {
    const el = ref.current;
    if (!el || ki < 1 || st === "read" || typeof IntersectionObserver === "undefined") return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const enough =
            e.isIntersecting &&
            (e.intersectionRatio >= 0.6 || e.intersectionRect.height > window.innerHeight * 0.45);
          if (enough && !t) t = setTimeout(() => store.markRead([props.id]), 1400);
          if (!enough && t) {
            clearTimeout(t);
            t = undefined;
          }
        }
      },
      { threshold: [0, 0.3, 0.6, 1] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(t);
    };
  }, [ki, st, props.id, store]);

  if (!n) return null;
  const canFull = hasFull(n) || n.type === "notebook";
  const minD: Depth = props.ledger || props.rests ? "title" : "gist";
  const set = (x: Depth) => {
    // Clicking the dot you are at folds back one step, as a toggle would.
    const target =
      x === d ? (DEPTHS[Math.max(DEPTHS.indexOf(minD), DEPTHS.indexOf(x) - 1)] as Depth) : x;
    ui.setDepth(props.k, n.note_id, target);
    store.setFocus(props.k);
  };
  const stepTitle = () => {
    const i = DEPTHS.indexOf(d);
    const top = canFull ? 3 : 2;
    ui.setDepth(props.k, n.note_id, i >= top ? "gist" : (DEPTHS[i + 1] as Depth));
    store.setFocus(props.k);
  };
  const path = props.k.slice(2).split(">");
  const chapter = n.type === "notebook" && props.level > 0;
  const cls = [
    "v-note",
    `t-${n.type}`,
    `lv-${Math.min(props.level, 4)}`,
    `d-${d}`,
    st === "read" ? "v-read" : "",
    store.fresh(n.note_id) ? "v-fresh" : "",
    props.ledger ? "v-lline" : "",
    chapter ? "v-chapter" : "",
    focused ? "v-focus" : "",
    props.page ? "v-pagenote" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const p = noteProse(ui, n, !props.ledger);
  const childDflt: Depth = n.type === "notebook" ? "summary" : "gist";
  const parts = (ps: Part[], lead = false) =>
    ps.map((x, i) =>
      x.type === "prose" ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: a note's parts in their written order
        <Prose key={`p${i}`} md={x.md} lead={lead} />
      ) : path.includes(x.id) ? null : (
        <NoteView
          key={`e${x.id}`}
          id={x.id}
          k={`${props.k}>${x.id}`}
          level={props.level + 1}
          dflt={childDflt}
        />
      ),
    );
  // A claim's runs are its case, shown before the reasoning, unless the findings it embeds show them.
  const claimRunsFirst = () => {
    if (n.type !== "claim" || !n.evidence?.length) return false;
    const childRuns = new Set(
      flatIds(ui, n.note_id)
        .slice(1)
        .flatMap((x) => (ui.vault.get(x)?.evidence ?? []).map((e) => e.run)),
    );
    return !n.evidence.every((e) => childRuns.has(e.run));
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the page's keys move the focus (j, k)
    <article
      ref={ref}
      className={cls}
      data-id={n.note_id}
      data-key={props.k}
      data-depth={d}
      data-min={minD}
      data-max={canFull ? "full" : "summary"}
      data-level={props.level}
      data-group={props.ledger?.group}
      onClick={(e) => {
        const t = e.target as Element;
        if (t.closest("a, button") || t.closest(".v-note") !== ref.current) return;
        store.setFocus(props.k);
      }}
    >
      {props.ledger ? (
        <LedgerHead
          n={n}
          k={props.k}
          d={d}
          meta={props.ledger}
          canFull={canFull}
          onSet={set}
          onTitle={stepTitle}
        />
      ) : (
        <NoteHead
          n={n}
          d={d}
          k={props.k}
          level={props.level}
          sheet={props.sheet ?? false}
          page={props.page ?? false}
          canFull={canFull}
          onSet={set}
          onTitle={stepTitle}
        />
      )}
      <div className="v-nb">
        {/* A figure is read as the figure, its gist the caption below it (ADR 0053). */}
        {n.type === "figure" && n.figure && !props.ledger && ki >= 0 ? (
          <Figure pid={ui.pid} id={n.note_id} revision={n.revision} title={n.title} />
        ) : null}
        {!props.ledger && ki >= 0 && !(n.type === "notebook" && props.level === 0) ? (
          <p className="v-gist">
            <Inline text={p.gist} />
          </p>
        ) : null}
        {ki >= 1 ? parts(p.summary) : null}
        {ki >= 1 && p.wc ? (
          <p className="v-wc">
            <span className="v-wc-h">Would change it</span> <Inline text={p.wc} />
          </p>
        ) : null}
        {ki >= 1 && !props.ledger && n.key && n.type !== "claim" ? (
          <p className="v-kline">
            <b>{n.key.text}</b> <span>{n.key.label}</span>
          </p>
        ) : null}
        {ki === 1 && chapter ? (
          <button
            type="button"
            className="v-ch-more"
            onClick={() => ui.setDepth(props.k, n.note_id, "full")}
          >
            Read the chapter{" "}
            <span className="v-faint">
              {flatIds(ui, n.note_id).length - 1} notes · {ui.vault.minutes(n.note_id, "summary")}{" "}
              min
            </span>
          </button>
        ) : null}
        {ki >= 2 ? (
          <>
            {claimRunsFirst() ? <Evidence n={n} /> : null}
            {parts(p.full)}
            {n.type !== "claim" ? <Evidence n={n} /> : null}
            <RunsBehind n={n} />
            {n.type === "experiment" && n.study ? <StudyTable study={n.study} /> : null}
            <RestsOn n={n} k={props.k} level={props.level} />
            <PriorWork n={n} />
            <Sources n={n} />
          </>
        ) : null}
        {props.ledger && ki >= 1 ? <Moves n={n} ki={ki} /> : null}
      </div>
      <NoteDirections id={n.note_id} k={props.k} />
    </article>
  );
}

function NoteHead(props: {
  n: VaultNote;
  d: Depth;
  k: string;
  level: number;
  sheet: boolean;
  page: boolean;
  canFull: boolean;
  onSet: (d: Depth) => void;
  onTitle: () => void;
}) {
  const ui = useVaultUi();
  const [open, setOpen] = useState(false);
  const { n } = props;
  const all = places(ui, n.note_id);
  const inNotebook = props.k.startsWith("N:");
  const tree = props.k.startsWith("T:");
  const list = inNotebook ? all.filter((p) => p.root !== ui.root) : all;
  const others = list.length;
  const quiet = props.sheet || tree || props.page;
  const showAlso = !quiet && (inNotebook ? others > 0 : others > 1 && props.level > 0);
  const ctxLink = !inNotebook && !quiet && props.level > 0 && others === 1 ? all[0] : undefined;
  const st = n.standing ? STANDING[n.standing] : undefined;
  const chapter = n.type === "notebook" && props.level > 0;
  const next = DEPTHS[Math.min(3, Math.max(1, depthIndex(props.d) + 2))] as Depth;
  return (
    <>
      <header className={`v-nh${chapter ? " v-ch-h" : ""}`}>
        <span className="v-nt">
          {chapter ? "chapter" : typeWord(ui.vault, n)}
          {st ? <span className={`v-st tone-${st.tone}`}> {st.label}</span> : null}
        </span>
        <button type="button" className="v-ntitle" title={DEPTH_WORD[next]} onClick={props.onTitle}>
          {n.title}
        </button>
        <span className="v-nh-r">
          {showAlso ? (
            <button
              type="button"
              className="v-also"
              title="Where else this note is read"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {inNotebook ? `also in ${others}` : `in ${others} places`}
            </button>
          ) : null}
          {ctxLink ? (
            <Link className="v-also" to={ui.placeHref(ctxLink)} title={ctxLink.chain.join(" › ")}>
              in context
            </Link>
          ) : null}
          {!props.sheet && !props.page ? (
            <button
              type="button"
              className="v-open-s"
              title="Open beside the page (s)"
              onClick={() => ui.openSheet(n.note_id)}
            >
              open
            </button>
          ) : null}
          {props.page ? null : <DirectButton k={props.k} />}
          <Dots d={props.d} canFull={props.canFull} onSet={props.onSet} />
        </span>
      </header>
      {open ? (
        <div className="v-places">
          <div className="v-rests-h">{inNotebook ? "Also read in" : "Read it in"}</div>
          {list.map((p) => (
            <Link key={`${p.kind}:${p.root}`} to={ui.placeHref(p)}>
              {p.chain.map((c, i) =>
                i === p.chain.length - 1 ? (
                  <b key={c}>{c}</b>
                ) : (
                  <span key={`${c}${String(i)}`}>{c} › </span>
                ),
              )}
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}

function LedgerHead(props: {
  n: VaultNote;
  k: string;
  d: Depth;
  meta: LedgerMeta;
  canFull: boolean;
  onSet: (d: Depth) => void;
  onTitle: () => void;
}) {
  const ui = useVaultUi();
  const { n, meta } = props;
  const ki = depthIndex(props.d);
  const claim = n.type === "claim";
  // New notes beneath a claim: re-counted as any of them is read.
  const beneath = useSyncExternalStore(
    ui.store.subscribe,
    () =>
      claim
        ? flatIds(ui, n.note_id)
            .slice(1)
            .filter((x) => ui.store.fresh(x)).length
        : 0,
    () => 0,
  );
  const fresh = ui.store.fresh(n.note_id);
  let num = meta.num ?? "";
  let title = n.title;
  const dm = /^(D\d+):\s*/.exec(title);
  if (dm) {
    num = dm[1] as string;
    title = title.slice(dm[0].length);
  }
  const items: ReactNode[] = [];
  if (claim && n.support) items.push(<span key="sup">{n.support}</span>);
  if (beneath)
    items.push(
      <span key="bn" className="v-ink">
        {beneath} new beneath
      </span>,
    );
  if (claim && meta.questions?.length)
    items.push(
      <button
        key="qs"
        type="button"
        className="v-qs"
        title={meta.questions.map((q) => q.title).join("\n")}
        onClick={meta.onQuestions}
      >
        {plural(meta.questions.length, "open question", "open questions")}
      </button>,
    );
  if (!claim && fresh)
    items.push(
      <span key="nw" className="v-nw">
        {ui.store.status(n.note_id) === "changed"
          ? `revised ${fmtDay(n.updated)}`
          : `new ${fmtDay(n.created)}`}
      </span>,
    );
  if (meta.on) items.push(<span key="on">{meta.on}</span>);
  const showMeta = items.length > 0 && (ki >= 0 || !claim);
  return (
    <div className="v-lrow v-nh">
      <span className="v-lnum">{String(num)}</span>
      <div className="v-lmain">
        <button type="button" className="v-ntitle" onClick={props.onTitle}>
          {title}
        </button>
        {ki >= 0 ? (
          <p className="v-gist">
            <Inline text={lineText(ui, `g:${n.note_id}`, n.gist, false)} />
          </p>
        ) : null}
        {showMeta ? <div className="v-lmeta">{joined(items)}</div> : null}
        {meta.agenda}
      </div>
      <div className="v-lkey">
        {n.key ? (
          <>
            <b>{n.key.text}</b>
            <small>{n.key.label}</small>
          </>
        ) : null}
        <Dots d={props.d} canFull={props.canFull} onSet={props.onSet} />
        <DirectButton k={props.k} />
      </div>
    </div>
  );
}

/** From a ledger line: the notebook that argues it, its other places, its terms. */
function Moves(props: { n: VaultNote; ki: number }) {
  const ui = useVaultUi();
  const all = places(ui, props.n.note_id);
  const nbs = all.filter((p) => p.kind === "notebook");
  const sess = all.filter((p) => p.kind === "session");
  const first = nbs[0];
  const also = [...nbs.slice(1), ...sess];
  const ts = props.ki === 1 ? terms(ui, props.n.note_id).slice(0, 5) : [];
  if (!first && !also.length && !ts.length) return null;
  return (
    <div className="v-moves">
      {first ? (
        <Link className="v-mv-ctx" to={ui.placeHref(first)} title={first.chain.join(" › ")}>
          In context <span className="v-arr">→</span> <b>{first.label}</b>
        </Link>
      ) : null}
      {also.length ? (
        <span className="v-mv-also">
          also in{" "}
          {also.map((p, i) => (
            <span key={`${p.kind}:${p.root}`}>
              {i ? ", " : ""}
              <Link to={ui.placeHref(p)} title={p.chain.join(" › ")}>
                {p.label}
              </Link>
            </span>
          ))}
        </span>
      ) : null}
      {ts.length ? (
        <span className="v-mv-terms">
          Terms {joined(ts.map((t) => <TermLink key={t.note_id} note={t} />))}
        </span>
      ) : null}
    </div>
  );
}

/** The fundamentals a note uses that are not already explained above it on the same line. */
function RestsOn(props: { n: VaultNote; k: string; level: number }) {
  const ui = useVaultUi();
  const { n } = props;
  if (n.type === "notebook") return null;
  const path = props.k.slice(2).split(">");
  const shown = new Set(path);
  for (const id of path) if (ui.vault.has(id)) for (const x of flatIds(ui, id)) shown.add(x);
  const embeds = new Set(ui.vault.children(n.note_id).map((c) => c.note_id));
  const list0 = terms(ui, n.note_id).filter((t) => !shown.has(t.note_id) && !embeds.has(t.note_id));
  const above = new Set<string>();
  for (let i = 0; i < path.length - 1; i++)
    for (const t of terms(ui, path[i] as string)) above.add(t.note_id);
  const list = props.level > 0 ? list0.filter((t) => !above.has(t.note_id)) : list0;
  if (!list.length) return null;
  return (
    <div className="v-rests">
      <div className="v-rests-h">Rests on</div>
      {list.map((t) => (
        <NoteView
          key={t.note_id}
          id={t.note_id}
          k={`${props.k}>${t.note_id}`}
          level={props.level + 1}
          dflt="title"
          rests
        />
      ))}
    </div>
  );
}

/** A note's runs with their values read now and the difference to the baseline. */
function Evidence(props: { n: VaultNote }) {
  const ui = useVaultUi();
  const { store } = ui;
  const slot = useSlot(
    store,
    () => store.runsSlot(),
    () => store.loadRuns(),
    "runs",
  );
  const ev = props.n.evidence ?? [];
  if (!ev.length) return null;
  const rows = evidenceRows(ev, (run, metric) => store.runValue(run, metric));
  const metrics = [...new Set(rows.map((r) => r.metric))];
  const one = metrics.length === 1;
  const off = slot.state === "error" || (slot.state === "done" && !slot.data?.available);
  const loaded = slot.state === "done" && !off;
  const runCell = (r: (typeof rows)[number]) =>
    r.runId ? (
      <Link to={`${ui.base}/runs/r/${enc(r.runId)}`} title="Open the run">
        {r.run}
      </Link>
    ) : (
      <span title={loaded ? "No run by this name in the project" : undefined}>{r.run}</span>
    );
  return (
    <>
      <table className="v-ev">
        <thead>
          <tr>
            <th>Runs</th>
            <th />
            {off ? null : (
              <>
                <th className="num" title={metrics.filter(Boolean).join(", ")}>
                  {one ? metricName(metrics[0], store.terms) : "value"}
                </th>
                <th className="num">vs baseline</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows in the note's order
            <tr key={i} className={`role-${r.role}`}>
              <td className="v-ev-run">
                {runCell(r)}
                {r.note ? <div className="v-ev-note">{r.note}</div> : null}
              </td>
              <td className="v-ev-role">
                {r.role}
                {one || !r.metric ? "" : ` · ${metricName(r.metric, store.terms)}`}
              </td>
              {off ? null : (
                <>
                  <td className="num">{loaded ? fmtValue(r.value) : ""}</td>
                  <td className="num v-ev-d">
                    {r.role === "baseline" || !loaded ? "" : fmtDiff(r.delta, r.value)}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {off ? (
        <p className="v-ev-off">
          MLflow is unavailable, so the runs are named without their values.
        </p>
      ) : null}
    </>
  );
}

/** An experiment's study, variant by variant, against its baseline. */
function StudyTable(props: { study: string }) {
  const ui = useVaultUi();
  const { store } = ui;
  const slot = useSlot(
    store,
    () => store.studySlot(props.study),
    () => store.loadStudy(props.study),
    `study:${props.study}`,
  );
  const href = `${ui.base}/runs/studies/${enc(props.study)}`;
  const d = slot.data;
  if (slot.state !== "done" || !d?.variants.length)
    return slot.state === "loading" || slot.state === "idle" ? null : (
      <p className="v-tbl-h">
        <Link to={href}>The study {props.study}</Link>
      </p>
    );
  const rec = d.record;
  const goals = (rec?.metric_goals ?? [])
    .map((g) => g.key)
    .filter((k) => d.metric_keys.includes(k));
  const keys = (goals.length ? goals : d.metric_keys.filter((k) => !k.startsWith("system/"))).slice(
    0,
    2,
  );
  const base =
    rec?.baseline_variant && d.variants.some((v) => v.variant_id === rec.baseline_variant)
      ? rec.baseline_variant
      : d.variants[0]?.variant_id;
  const declared = (rec?.variants ?? []).map((v) => v.variant_id);
  const pos = (id: string) =>
    id === base ? -1 : declared.includes(id) ? declared.indexOf(id) : declared.length;
  const rows = [...d.variants].sort((a, b) => pos(a.variant_id) - pos(b.variant_id));
  const baseV = d.variants.find((v) => v.variant_id === base);
  const titleOfV = (id: string) => rec?.variants?.find((v) => v.variant_id === id)?.title ?? id;
  return (
    <>
      <div className="v-tbl-h">
        The study, variant by variant{" "}
        <Link to={href} className="v-tbl-link">
          open it
        </Link>
      </div>
      <table className="v-ev v-study">
        <thead>
          <tr>
            <th>Variant</th>
            {keys.map((k) => (
              <th key={k} className="num" title={k} colSpan={2}>
                {metricName(k, store.terms)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.variant_id} className={v.variant_id === base ? "role-baseline" : ""}>
              <td>
                {titleOfV(v.variant_id)}
                {v.variant_id === base ? <span className="v-faint"> baseline</span> : null}
              </td>
              {keys.map((k) => {
                const m = v.metrics[k]?.mean;
                const b = baseV?.metrics[k]?.mean;
                return [
                  <td key={`${k}v`} className="num">
                    {fmtValue(m)}
                  </td>,
                  <td key={`${k}d`} className="num v-ev-d">
                    {v.variant_id === base || m === undefined || b === undefined
                      ? ""
                      : fmtDiff(m - b, m)}
                  </td>,
                ];
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** The prior work a note rests on, each with the part it plays there (ADR 0052). */
function PriorWork(props: { n: VaultNote }) {
  const ui = useVaultUi();
  const cites = props.n.cites ?? [];
  if (!cites.length) return null;
  return (
    <div className="v-cites" data-testid="prior-work">
      <div className="v-prov-h">Prior work</div>
      <ul>
        {cites.map((c, i) => {
          const w = ui.store.works.get(c.work);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: citations in the note's order
            <li key={i}>
              <span className={`v-role r-${c.role}`}>{ROLE_WORDS[c.role]}</span>
              {w ? (
                <Link to={libraryHref(ui.base, w.work_id)} title="In the library">
                  {shortCite(w)}
                </Link>
              ) : (
                <span className="v-mono">{c.work}</span>
              )}
              {w ? (
                <span className="v-cite-t">{short(w.title, 80)}</span>
              ) : (
                <span className="v-faint">not in the library</span>
              )}
              {c.where ? <span className="v-faint">{c.where}</span> : null}
              {c.note ? (
                <div className="v-cite-n">
                  <Inline text={c.note} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const SOURCE_WORD: Record<string, string> = {
  hypothesis: "hypothesis",
  approach: "approach",
  note: "note",
  report: "report",
  decision: "decision",
  conversation: "conversation",
  study: "study",
  task: "task",
  run: "run",
};

/** Where a note was distilled from: provenance, last and quiet. */
function Sources(props: { n: VaultNote }) {
  const ui = useVaultUi();
  const { store } = ui;
  const slot = useSlot(
    store,
    () => store.namesSlot(),
    () => store.loadNames(),
    "names",
  );
  if (!props.n.sources.length) return null;
  const names = slot.data;
  const items = props.n.sources.map((s) => {
    const i = s.indexOf(":");
    const kind = s.slice(0, i);
    const id = s.slice(i + 1);
    if (kind === "repo") return <code key={s}>{id}</code>;
    const word = SOURCE_WORD[kind] ?? kind;
    const title = names?.get(id);
    const runId = kind === "run" ? store.runValue(id, undefined)?.runId : undefined;
    const href =
      kind === "task"
        ? `${ui.base}/tasks/${enc(id)}`
        : kind === "run"
          ? runId
            ? `${ui.base}/runs/r/${enc(runId)}`
            : undefined
          : refHref(ui.base, { kind, id });
    const label = title ? (
      <>
        {word} “{short(title, 54)}”
      </>
    ) : (
      <>
        {word} <span className="v-mono">{id}</span>
      </>
    );
    return href ? (
      <Link key={s} to={href} title={title ?? id}>
        {label}
      </Link>
    ) : (
      <span key={s} title={title ?? id}>
        {label}
      </span>
    );
  });
  return (
    <div className="v-prov">
      <span className="v-prov-h">Distilled from</span> {joined(items)}
    </div>
  );
}

/** "The 64k model trails …" → a short label for the trail. */
export function crumbWord(v: Vault, n: VaultNote): string {
  return n.type === "notebook" && !v.isEdition(n.note_id) ? "chapter" : typeWord(v, n);
}
