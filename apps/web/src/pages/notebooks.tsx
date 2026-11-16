/**
 * Notebooks (ADR 0049): the vault for reading rather than checking. The shelf (the fundamentals
 * first with their chapters, then a notebook per question, then the sessions), a notebook read as
 * one compiled text with its embedded notes, any note as a page, and the tree. It replaces
 * Knowledge; the original records stay reachable as provenance.
 */
import type { VaultNote } from "@ablationkit/protocol";
import {
  type CSSProperties,
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { Markdown } from "../components/Markdown.tsx";
import {
  Inline,
  lineText,
  NoteView,
  noteProse,
  places,
  useStoreVersion,
  useVaultUi,
  type VaultUi,
} from "../components/Note.tsx";
import { Link } from "../components/ui.tsx";
import { afterPaint, flash, mainEl, noteEl, reveal } from "../components/vault-dom.ts";
import { SessionAccount } from "../components/Witness.tsx";
import {
  cap,
  citationsHref,
  depthIndex,
  edDay,
  edName,
  fmtDay,
  libraryHref,
  onLedger,
  pathTo,
  placeOf,
  resolveLinks,
  short,
  typeWord,
} from "../lib/vault.ts";
import { local } from "../lib/vault-store.ts";
import { navigate } from "../router.ts";

const enc = encodeURIComponent;
export const noteHref = (base: string, id: string, at?: string) =>
  `${base}/notebooks/n/${enc(id)}${at ? `?at=${enc(at)}` : ""}`;

/** A gist inside a link: its words, links to other notes flattened to their words. */
function Plain(props: { text: string }) {
  const ui = useVaultUi();
  const t = resolveLinks(props.text, (id) => ui.vault.get(id)?.title).replace(
    /\[\[[^\]|]+\|([^\]]*)\]\]/g,
    "$1",
  );
  return <Markdown text={t} inline />;
}

// ---------------------------------------------------------------- the shelf

function progress(ui: VaultUi, id: string): string {
  const ids = [...ui.vault.under(id)].filter((x) => x !== id);
  const r = ids.filter((x) => ui.store.status(x) === "read").length;
  return r === 0 ? "" : r === ids.length ? "read" : `${r} of ${ids.length} read`;
}

function ShelfRow(props: { n: VaultNote; sub?: boolean; session?: boolean }) {
  const ui = useVaultUi();
  const { n } = props;
  const pr = props.session ? "" : progress(ui, n.note_id);
  const read = props.session ? ui.store.status(n.note_id) === "read" : pr === "read";
  const cls = [
    "v-shelf-i",
    props.sub ? "sub" : "",
    props.session ? "ses" : "",
    read ? "v-read" : "",
    props.session && ui.store.fresh(n.note_id) ? "v-fresh" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Link to={noteHref(ui.base, n.note_id)} className={cls}>
      <span className="v-si-t">
        {props.session ? (
          <>
            <span className="v-ses-d">{fmtDay(edDay(n))}</span> {cap(edName(n))}
          </>
        ) : (
          n.title
        )}
      </span>
      <span className="v-si-m">
        {ui.vault.minutes(n.note_id, "summary")} min{pr ? ` · ${pr}` : ""}
      </span>
      <span className="v-si-g">
        <Plain text={n.gist} />
      </span>
    </Link>
  );
}

export const ShelfPage = memo(function ShelfPage(props: { name: string }) {
  const ui = useVaultUi();
  const { vault: v } = ui;
  useStoreVersion(ui.store);
  const fund = v.shelf[0];
  const chapters = fund ? v.children(fund.note_id).filter((c) => c.type === "notebook") : [];
  const rest = v.shelf.slice(1);
  const eds = [...v.editions].reverse();
  useLayoutEffect(() => {
    const m = mainEl();
    if (m) m.scrollTop = 0;
  }, []);
  return (
    <div className="v-shelf v-page-w" data-testid="shelf">
      <header className="v-ph">
        <div className="v-eyebrow">{props.name}</div>
        <h1 className="v-hand">Notebooks</h1>
        <p className="v-ph-s">
          For reading rather than checking: the project explained from first principles, then one
          notebook per question. <Link to={`${ui.base}/notebooks/tree`}>See it as a tree</Link>
          {ui.store.works.size ? (
            <>
              , or the <Link to={libraryHref(ui.base)}>library</Link> of the{" "}
              {ui.store.works.size === 1 ? "work" : `${ui.store.works.size} works`} of prior work it
              draws on
            </>
          ) : null}
          .
        </p>
      </header>
      {fund ? (
        <section className="v-sh-sec">
          <h2 className="v-gh">
            <span>Fundamentals</span>{" "}
            <span className="v-gs">How it works, from the ground up.</span>
          </h2>
          <ShelfRow n={fund} />
          <div className="v-chapters">
            {chapters.map((c) => (
              <ShelfRow key={c.note_id} n={c} sub />
            ))}
          </div>
        </section>
      ) : null}
      {rest.length ? (
        <section className="v-sh-sec">
          <h2 className="v-gh">
            <span>Research</span>{" "}
            <span className="v-gs">One notebook per question, then the log.</span>
          </h2>
          {rest.map((n) => (
            <ShelfRow key={n.note_id} n={n} />
          ))}
        </section>
      ) : null}
      {eds.length ? (
        <section className="v-sh-sec">
          <h2 className="v-gh">
            <span>Sessions</span>{" "}
            <span className="v-gs">What each working session established, newest first.</span>
          </h2>
          {eds.map((e) => (
            <ShelfRow key={e.note_id} n={e} session />
          ))}
        </section>
      ) : null}
      {!v.shelf.length && !eds.length ? (
        <p className="v-empty">
          No notebook is on the shelf yet: the vault's notes are reached from{" "}
          <Link to={`${ui.base}/standing`}>where it stands</Link> and{" "}
          <Link to={`${ui.base}/notebooks/tree`}>the tree</Link>.
        </p>
      ) : null}
      <footer className="v-lfoot">
        The notes were distilled from the project's tasks, hypotheses, reports and decisions, kept
        as they were written: <Link to={`${ui.base}/knowledge`}>the original records</Link>.
      </footer>
    </div>
  );
});

// ---------------------------------------------------------------- a notebook, compiled

/** Open every note on the way to a target; the target at least at its summary. */
function openWay(ui: VaultUi, scope: string, path: readonly string[]): string {
  let key = scope;
  path.forEach((id, i) => {
    key += `>${id}`;
    const cur = ui.store.depths.get(key);
    if (i < path.length - 1) ui.store.setDepth(key, "full");
    else if (!cur || depthIndex(cur) < 1) ui.store.setDepth(key, "summary");
  });
  return key;
}

function arrive(ui: VaultUi, key: string | undefined, scrollKey: string): void {
  const main = mainEl();
  if (!key) {
    if (main) main.scrollTop = local.get(ui.store.lsKey(scrollKey), 0);
    return;
  }
  ui.store.setFocus(key);
  afterPaint(() => {
    const el = noteEl(key);
    if (!el) return;
    reveal(el, "start");
    flash(el);
  });
}

export const NotePage = memo(function NotePage(props: { id: string; at: string | undefined }) {
  const ui = useVaultUi();
  const n = ui.vault.get(props.id);
  if (!n)
    return (
      <div className="v-page-w">
        <p className="v-empty">
          No note <code>{props.id}</code> in this vault.{" "}
          <Link to={`${ui.base}/notebooks`}>The shelf</Link>.
        </p>
      </div>
    );
  return n.type === "notebook" ? (
    <Notebook n={n} at={props.at} />
  ) : (
    <SingleNote n={n} at={props.at} />
  );
});

function Notebook(props: { n: VaultNote; at: string | undefined }) {
  const ui = useVaultUi();
  const { vault: v, store } = ui;
  const nb = props.n;
  const root = nb.note_id;
  const ed = v.isEdition(root);
  const parts = v.compose(root);

  // biome-ignore lint/correctness/useExhaustiveDependencies: on arrival only
  useLayoutEffect(() => {
    store.markRead([root]);
    const path = props.at && props.at !== root ? pathTo(v, root, props.at) : [];
    const key = path.length ? openWay(ui, `N:${root}`, path) : undefined;
    arrive(ui, key, `scroll:${root}`);
  }, [root, props.at]);

  const outline = useMemo(() => {
    const out: ({ h: string } | { n: VaultNote })[] = [];
    for (const p of parts.full) {
      if (p.type === "prose")
        for (const m of p.md.matchAll(/^##\s+(.+)$/gm)) out.push({ h: m[1] as string });
      else {
        const c = v.get(p.id);
        if (c) out.push({ n: c });
      }
    }
    return out;
  }, [parts, v]);

  const chain = ed ? [] : (v.contexts(root)[0] ?? []).slice(0, -1);
  const fund = v.shelf[0];
  const all = ed ? [] : places(ui, root);
  const prose = noteProse(ui, nb, true);
  return (
    <div className="v-nbpage" data-testid="notebook">
      <Rail root={root} title={nb.title} outline={outline} />
      <article className="v-nbcol">
        <h1 className="v-hand">{nb.title}</h1>
        <p className="v-nb-gist">
          <Inline text={lineText(ui, `g:${root}`, nb.gist, false)} />
        </p>
        <NotebookMeta
          root={root}
          kind={
            ed ? (
              `the session of ${fmtDay(edDay(nb))}`
            ) : chain.length ? (
              <>
                a chapter of{" "}
                <Link to={noteHref(ui.base, (chain.at(-1) as VaultNote).note_id)}>
                  {(chain.at(-1) as VaultNote).title}
                </Link>
              </>
            ) : fund && root === fund.note_id ? (
              "the fundamentals"
            ) : undefined
          }
          also={all.slice(1)}
        />
        <div className="v-nb-open">
          {prose.summary.map((p, i) =>
            p.type === "prose" ? (
              <Markdown
                // biome-ignore lint/suspicious/noArrayIndexKey: parts in their written order
                key={i}
                text={p.md}
                notes={ui.links}
                base={ui.base}
                className="v-prose v-lead"
              />
            ) : null,
          )}
        </div>
        <div className="v-nb-body">
          <NotebookBody n={nb} />
        </div>
        <WorksCited root={root} />
        {/* An edition an agent session wrote carries that session's account (ADR 0056). */}
        {ui.vault.isEdition(root) && nb.created_by.kind === "agent" && nb.created_by.id ? (
          <SessionAccount tokenId={nb.created_by.id} base={ui.base} compact />
        ) : null}
        <Next root={root} />
      </article>
    </div>
  );
}

/** How many works of the library the notebook rests on, and where to read and export them. */
function WorksCited(props: { root: string }) {
  const ui = useVaultUi();
  const under = ui.vault.under(props.root);
  let n = 0;
  for (const [id, uses] of ui.store.uses)
    if (ui.store.works.has(id) && uses.some((u) => under.has(u.note.note_id))) n++;
  if (!n) return null;
  return (
    <p className="v-nb-works" data-testid="works-cited">
      <span className="v-prov-h">Prior work</span> This notebook cites{" "}
      {n === 1 ? "one work" : `${n} works`}:{" "}
      <Link to={libraryHref(ui.base, undefined, props.root)}>what each was used for</Link> ·{" "}
      <a href={citationsHref(ui.pid, "bibtex", props.root)} download>
        BibTeX
      </a>
    </p>
  );
}

/** The notebook's own composition: its prose (terms linked) and its notes at their summary. */
function NotebookBody(props: { n: VaultNote }) {
  const ui = useVaultUi();
  const p = noteProse(ui, props.n, true);
  return (
    <>
      {p.full.map((x, i) =>
        x.type === "prose" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts in their written order
          <Markdown key={`p${i}`} text={x.md} notes={ui.links} base={ui.base} className="v-prose" />
        ) : (
          <NoteView
            key={`e${x.id}`}
            id={x.id}
            k={`N:${props.n.note_id}>${x.id}`}
            level={1}
            dflt="summary"
          />
        ),
      )}
    </>
  );
}

function NotebookMeta(props: { root: string; kind: ReactNode; also: ReturnType<typeof places> }) {
  const ui = useVaultUi();
  useStoreVersion(ui.store);
  const unique = [...ui.vault.under(props.root)].filter((x) => x !== props.root);
  const nread = unique.filter((x) => ui.store.status(x) === "read").length;
  const bits: ReactNode[] = [
    props.kind,
    `${unique.length} notes`,
    `${ui.vault.minutes(props.root, "summary")} min as summaries, ${ui.vault.minutes(props.root, "full")} in full`,
    nread ? `${nread} read` : undefined,
  ].filter(Boolean);
  return (
    <p className="v-nb-meta">
      {bits.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed order
        <span key={i}>
          {i ? <span className="v-sep"> · </span> : null}
          {b}
        </span>
      ))}
      {props.also.length ? (
        <>
          <span className="v-sep"> · </span>also in{" "}
          {props.also.map((p, i) => (
            <span key={`${p.kind}:${p.root}`}>
              {i ? ", " : ""}
              <Link to={ui.placeHref(p)}>{p.label}</Link>
            </span>
          ))}
        </>
      ) : null}
    </p>
  );
}

function Rail(props: {
  root: string;
  title: string;
  outline: ({ h: string } | { n: VaultNote })[];
}) {
  const ui = useVaultUi();
  useStoreVersion(ui.store);
  return (
    <nav className="v-rail" aria-label="In this notebook">
      <div className="v-rail-h">{short(props.title, 60)}</div>
      {props.outline.map((x, i) =>
        "h" in x ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: headings in order
          <div key={`h${i}`} className="v-rail-sec">
            {x.h}
          </div>
        ) : (
          <a
            key={x.n.note_id}
            href={noteHref(ui.base, props.root, x.n.note_id)}
            className={`v-rail-i${ui.store.status(x.n.note_id) === "read" ? " v-read" : ""}`}
            data-jump={`N:${props.root}>${x.n.note_id}`}
            onClick={(e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              const el = noteEl(`N:${props.root}>${x.n.note_id}`);
              if (el) {
                reveal(el, "start");
                ui.store.setFocus(el.dataset["key"]);
              }
            }}
          >
            {short(x.n.title, 64)}
          </a>
        ),
      )}
    </nav>
  );
}

function Next(props: { root: string }) {
  const ui = useVaultUi();
  const v = ui.vault;
  if (v.isEdition(props.root)) {
    const i = v.editions.findIndex((e) => e.note_id === props.root);
    const prev = v.editions[i - 1];
    return (
      <div className="v-nb-next">
        {prev ? (
          <Link to={noteHref(ui.base, prev.note_id)}>The session before: {edName(prev)}</Link>
        ) : (
          <span />
        )}
        <Link to={`${ui.base}/standing`}>Back to where it stands</Link>
      </div>
    );
  }
  const i = v.shelf.findIndex((n) => n.note_id === props.root);
  const next = i >= 0 ? v.shelf[i + 1] : undefined;
  return next ? (
    <div className="v-nb-next">
      <span>
        <span className="v-faint">Next on the shelf</span>{" "}
        <Link to={noteHref(ui.base, next.note_id)}>{next.title}</Link>
      </span>
    </div>
  ) : null;
}

/** A note that is not a notebook, as a page: at its full text, with its places and mentions. */
function SingleNote(props: { n: VaultNote; at: string | undefined }) {
  const ui = useVaultUi();
  const id = props.n.note_id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: on arrival only
  useLayoutEffect(() => {
    ui.store.markRead([id]);
    const path = props.at && props.at !== id ? pathTo(ui.vault, id, props.at) : [];
    arrive(ui, path.length ? openWay(ui, `P:${id}`, path) : undefined, `scroll:${id}`);
  }, [id, props.at]);
  return (
    <div className="v-page-w v-notepage" data-testid="note-page">
      <NoteView id={id} k={`P:${id}`} level={0} dflt="full" page />
      <PlacesAndMentions id={id} />
    </div>
  );
}

/** Every place a note is read, and the notes that mention it. */
export function PlacesAndMentions(props: { id: string }) {
  const ui = useVaultUi();
  const all = places(ui, props.id);
  const mentions = [
    ...new Map(ui.vault.mentions(props.id).map((m) => [m.note.note_id, m.note])).values(),
  ].filter((x) => !ui.vault.isEdition(x.note_id));
  return (
    <>
      <div className="v-sh-places">
        <div className="v-rests-h">{all.length > 1 ? "Its places" : "Its place"}</div>
        {all.length ? (
          all.map((p) => (
            <Link
              key={`${p.kind}:${p.root}:${p.chain.join(">")}`}
              to={ui.placeHref(p)}
              className="v-sh-place"
            >
              {p.chain.join(" › ")}
            </Link>
          ))
        ) : (
          <span className="v-faint">
            {ui.vault.shelf.some((s) => s.note_id === props.id)
              ? "On the shelf."
              : "Not in any notebook yet."}
          </span>
        )}
      </div>
      {mentions.length ? (
        <div className="v-sh-ment">
          <div className="v-rests-h">Mentioned in</div>
          {mentions.slice(0, 8).map((m) => (
            <a
              key={m.note_id}
              className="v-wl"
              data-note={m.note_id}
              href={ui.links.href(m.note_id)}
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                ui.openSheet(m.note_id);
              }}
            >
              {m.title}
            </a>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Where a note lives first: its line on the ledger, its notebook page, else its first place. */
export function goTo(ui: VaultUi, id: string): void {
  const n = ui.vault.get(id);
  if (!n) return;
  const pl = places(ui, id)[0];
  navigate(
    onLedger(n)
      ? `${ui.base}/standing?at=${enc(id)}`
      : n.type === "notebook" || !pl
        ? noteHref(ui.base, id)
        : ui.placeHref(pl),
  );
}

// ---------------------------------------------------------------- the tree

interface TreeRow {
  n: VaultNote;
  depth: number;
  key: string;
  kids: number;
}

export const TreePage = memo(function TreePage(props: { name: string }) {
  const ui = useVaultUi();
  const { vault: v, store } = ui;
  useStoreVersion(store);
  const fund = v.shelf[0];
  useLayoutEffect(() => {
    const m = mainEl();
    if (m) m.scrollTop = 0;
  }, []);
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(local.get<string[]>(store.lsKey("treeOpen"), fund ? [fund.note_id] : [])),
  );
  const [sel, setSel] = useState<string>(() =>
    local.get(store.lsKey("treeSel"), fund?.note_id ?? ""),
  );
  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const walk = (id: string, depth: number, trail: string[]) => {
      const n = v.get(id);
      if (!n) return;
      const kids = v.children(id).filter((c) => !trail.includes(c.note_id));
      const key = [...trail, id].join(">");
      out.push({ n, depth, key, kids: kids.length });
      if (kids.length && open.has(key))
        for (const c of kids) walk(c.note_id, depth + 1, [...trail, id]);
    };
    for (const s of v.shelf) walk(s.note_id, 0, []);
    if (open.has("#sessions"))
      for (const e of [...v.editions].reverse())
        out.push({ n: e, depth: 1, key: `ses>${e.note_id}`, kids: 0 });
    return out;
  }, [v, open]);
  const cur = rows.find((r) => r.key === sel) ?? rows[0];

  const toggle = (key: string, to?: boolean) => {
    const next = new Set(open);
    if (to ?? !next.has(key)) next.add(key);
    else next.delete(key);
    setOpen(next);
    local.set(store.lsKey("treeOpen"), [...next]);
  };
  const choose = (key: string) => {
    setSel(key);
    local.set(store.lsKey("treeSel"), key);
  };
  const contextHref = (r: TreeRow) => {
    const ids = r.key.startsWith("ses>") ? [r.n.note_id] : r.key.split(">");
    if (r.n.type === "notebook" && ids.length === 1) return noteHref(ui.base, r.n.note_id);
    const pl = placeOf(v, ids);
    return pl.path.length ? noteHref(ui.base, pl.root, r.n.note_id) : noteHref(ui.base, pl.root);
  };

  // The tree's keys: j k move, → ← open and close, ↵ read in context, s beside the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as Element | null;
      if (
        t?.closest("input, textarea, select, [contenteditable]") ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      )
        return;
      if (document.querySelector(".overlay, .v-find:not([hidden]), .v-keys:not([hidden])")) return;
      const all = [...rows.map((r) => r.key), "#sessions"];
      const i = all.indexOf(cur?.key ?? "");
      const k = e.key;
      const move = (to: string | undefined) => {
        if (!to) return;
        choose(to);
        afterPaint(() =>
          document
            .querySelector(`.v-tr[data-tkey="${CSS.escape(to)}"]`)
            ?.scrollIntoView({ block: "nearest" }),
        );
      };
      if (k === "j" || k === "ArrowDown") {
        e.preventDefault();
        move(all[i + 1]);
      } else if (k === "k" || k === "ArrowUp") {
        e.preventDefault();
        move(all[Math.max(0, i - 1)]);
      } else if ((k === "ArrowRight" || k === "l") && cur) {
        e.preventDefault();
        if (cur.kids) toggle(cur.key, true);
      } else if ((k === "ArrowLeft" || k === "h") && cur) {
        e.preventDefault();
        if (open.has(cur.key)) toggle(cur.key, false);
        else move(cur.key.split(">").slice(0, -1).join(">") || undefined);
      } else if (k === "Enter" && cur) {
        e.preventDefault();
        navigate(contextHref(cur));
      } else if (k === "s" && cur) ui.openSheet(cur.n.note_id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="v-tree v-page-w wide" data-testid="tree">
      <header className="v-ph">
        <div className="v-eyebrow">{props.name}</div>
        <h1 className="v-hand">The tree</h1>
        <p className="v-ph-s">
          Every note under the notebook that embeds it, as the shelf reads. A note used in several
          places appears in each.{" "}
          <span className="v-faint">
            <kbd>j</kbd>
            <kbd>k</kbd> move, <kbd>→</kbd>
            <kbd>←</kbd> open and close, <kbd>↵</kbd> read in context.
          </span>
        </p>
      </header>
      <div className="v-tree-grid">
        <div className="v-tree-list" role="tree">
          {rows.map((r) => {
            const pl = v.contexts(r.n.note_id).length;
            const isOpen = open.has(r.key);
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the tree's keys are on the page
              <div
                key={r.key}
                className={`v-tr${r.key === cur?.key ? " sel" : ""}${store.status(r.n.note_id) === "read" ? " v-read" : ""}${store.fresh(r.n.note_id) ? " v-fresh" : ""}`}
                data-tkey={r.key}
                style={{ "--d": r.depth } as CSSProperties}
                role="treeitem"
                aria-selected={r.key === cur?.key}
                aria-expanded={r.kids ? isOpen : undefined}
                tabIndex={-1}
                onClick={(e) => {
                  if ((e.target as Element).closest(".v-tw") || (r.key === cur?.key && r.kids))
                    return toggle(r.key);
                  choose(r.key);
                }}
              >
                <span className="v-tw">{r.kids ? (isOpen ? "▾" : "▸") : ""}</span>
                <span className="v-tt">
                  {r.key.startsWith("ses>") ? `${fmtDay(edDay(r.n))} · ${edName(r.n)}` : r.n.title}
                </span>
                <span className="v-tm">
                  {r.key.startsWith("ses>")
                    ? "session"
                    : r.n.type === "notebook"
                      ? String(r.kids)
                      : typeWord(v, r.n)}
                  {pl > 1 && !r.key.startsWith("ses>") ? ` · ${pl} places` : ""}
                </span>
              </div>
            );
          })}
          {v.editions.length ? (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the tree's keys are on the page
            <div
              className={`v-tr v-tr-ses${cur === undefined && sel === "#sessions" ? " sel" : ""}`}
              data-tkey="#sessions"
              style={{ "--d": 0 } as CSSProperties}
              role="treeitem"
              aria-selected={false}
              aria-expanded={open.has("#sessions")}
              tabIndex={-1}
              onClick={() => toggle("#sessions")}
            >
              <span className="v-tw">{open.has("#sessions") ? "▾" : "▸"}</span>
              <span className="v-tt">Sessions</span>
              <span className="v-tm">{v.editions.length}</span>
            </div>
          ) : null}
        </div>
        <div className="v-tree-prev">
          {cur ? (
            <>
              <NoteView
                key={cur.key}
                id={cur.n.note_id}
                k={`T:${cur.n.note_id}`}
                level={0}
                dflt="summary"
              />
              <div className="v-tp-acts">
                <Link to={contextHref(cur)} className="v-go">
                  Read in context <kbd>↵</kbd>
                </Link>{" "}
                <button type="button" className="v-go" onClick={() => ui.openSheet(cur.n.note_id)}>
                  Beside the page <kbd>s</kbd>
                </button>
              </div>
              {places(ui, cur.n.note_id).length > 1 ? (
                <div className="v-tp-places">
                  <div className="v-rests-h">Its places</div>
                  {places(ui, cur.n.note_id).map((p) => (
                    <Link key={`${p.kind}:${p.root}:${p.chain.join(">")}`} to={ui.placeHref(p)}>
                      {p.chain.join(" › ")}
                    </Link>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
});
