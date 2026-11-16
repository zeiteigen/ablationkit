/**
 * The vault's pages in the project (ADR 0049): Standing (`/standing`) and Notebooks
 * (`/notebooks`, `/notebooks/n/:id`, `/notebooks/tree`, and the library of prior work,
 * `/notebooks/library`, ADR 0052), around them a trail that always says
 * where the reader is (down to the note crossing the top of the screen), a sheet beside the page
 * for a note opened from a term (`?note=<id>`, so back and forward work), find (`/`), a hover that
 * shows a term's gist, and the keys. The app's own palette keeps Ctrl K.
 */
import type { Vault } from "@ablationkit/vault";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../components/Markdown.tsx";
import {
  crumbWord,
  Inline,
  lineText,
  NoteView,
  places,
  useStoreVersion,
  useVaultUi,
  type VaultUi,
  VaultUiContext,
} from "../components/Note.tsx";
import { ErrorBox, Link, Loading, Trail as PageTrail } from "../components/ui.tsx";
import { afterPaint, mainEl, noteEl, reveal, trailHeight } from "../components/vault-dom.ts";
import { RunRefValue } from "../components/Witness.tsx";
import { directionStore } from "../lib/directions.ts";
import {
  DEPTHS,
  type Depth,
  depthIndex,
  onLedger,
  type Place,
  resolveLinks,
  short,
  typeWord,
} from "../lib/vault.ts";
import { local, useVaultStore, type VaultStore } from "../lib/vault-store.ts";
import { navigate, useLocation } from "../router.ts";
import { LibraryPage } from "./library.tsx";
import { goTo, NotePage, noteHref, PlacesAndMentions, ShelfPage, TreePage } from "./notebooks.tsx";
import { StandingPage } from "./standing.tsx";

const enc = encodeURIComponent;

type Route =
  | { page: "standing" }
  | { page: "shelf" }
  | { page: "tree" }
  | { page: "library" }
  | { page: "note"; id: string };

function parseRoute(rest: string): Route {
  if (rest.startsWith("/standing")) return { page: "standing" };
  if (rest === "/notebooks/tree") return { page: "tree" };
  if (rest === "/notebooks/library") return { page: "library" };
  const m = /^\/notebooks\/n\/([^/]+)/.exec(rest);
  if (m) return { page: "note", id: decodeURIComponent(m[1] as string) };
  return { page: "shelf" };
}

/** The current address with one query parameter changed. */
function withQuery(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return `${location.pathname}${s ? `?${s}` : ""}`;
}

export function VaultRouter(props: { pid: string; base: string; rest: string; name: string }) {
  const loc = useLocation();
  const store = useVaultStore(props.pid) as VaultStore;
  const route = parseRoute(props.rest);
  if (store.error && !store.vault)
    return (
      <div className="vault">
        <div className="v-page-w">
          <ErrorBox error={store.error} onRetry={() => void store.load(true)} />
        </div>
      </div>
    );
  if (!store.vault)
    return (
      <div className="vault">
        <div className="v-page-w">
          <Loading />
        </div>
      </div>
    );
  if (!store.vault.notes.length)
    return <EmptyVault store={store} base={props.base} name={props.name} route={route} />;
  return (
    <VaultShell
      store={store}
      vault={store.vault}
      pid={props.pid}
      base={props.base}
      name={props.name}
      route={route}
      at={loc.query.get("at") ?? undefined}
      sheet={loc.query.get("note") ?? undefined}
      find={loc.query.get("find") ?? undefined}
      work={loc.query.get("work") ?? undefined}
      notebook={loc.query.get("notebook") ?? undefined}
    />
  );
}

function VaultShell(props: {
  store: VaultStore;
  vault: Vault;
  pid: string;
  base: string;
  name: string;
  route: Route;
  at: string | undefined;
  sheet: string | undefined;
  /** `?find=1` opens find (from the palette); any other value opens it with that typed. */
  find: string | undefined;
  /** The library: the work to arrive at, and the notebook whose citations to show. */
  work: string | undefined;
  notebook: string | undefined;
}) {
  const { store, vault, base, route } = props;
  const [finding, setFinding] = useState(false);
  const [findText, setFindText] = useState("");
  const [keys, setKeys] = useState(false);
  const root = route.page === "note" ? route.id : undefined;

  const ui = useMemo<VaultUi>(
    () => ({
      pid: props.pid,
      base,
      store,
      vault,
      root,
      links: {
        typeOf: (id) => vault.get(id)?.type,
        href: (id) => `${base}/notebooks/n/${enc(id)}`,
        open: (id) => openSheet(id),
        runRef: (inner) => <RunRefValue inner={inner} />,
      },
      openSheet: (id) => openSheet(id),
      placeHref: (p: Place) =>
        p.kind === "ledger"
          ? `${base}/standing?at=${enc(p.at)}`
          : `${base}/notebooks/n/${enc(p.root)}?at=${enc(p.at)}`,
      setDepth: (key: string, id: string, d: Depth) => {
        store.setDepth(key, d);
        if (depthIndex(d) >= 1) store.markRead([id]);
      },
    }),
    [props.pid, base, store, vault, root],
  );

  // ?find=1 (from the palette) opens find once; ?find=words opens it with the words typed.
  useEffect(() => {
    if (props.find) {
      setFindText(props.find === "1" ? "" : props.find);
      setFinding(true);
      navigate(withQuery({ find: undefined }), { replace: true });
    }
  }, [props.find]);

  // The page slides left for the sheet on wide screens.
  useEffect(() => {
    document.body.classList.toggle("v-sheet-open", Boolean(props.sheet));
    return () => document.body.classList.remove("v-sheet-open");
  }, [props.sheet]);

  // Where the reader was on the ledger and on each notebook (not when sent to a note).
  const scrollKey =
    route.page === "standing"
      ? "scroll:ledger"
      : route.page === "note"
        ? `scroll:${route.id}`
        : undefined;
  useEffect(() => {
    const main = mainEl();
    if (!main || !scrollKey || props.at) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      clearTimeout(t);
      t = setTimeout(() => local.set(store.lsKey(scrollKey), main.scrollTop), 200);
    };
    main.addEventListener("scroll", save, { passive: true });
    return () => {
      clearTimeout(t);
      main.removeEventListener("scroll", save);
    };
  }, [scrollKey, props.at, store]);

  // The keys (the tree page has its own for moving through the tree).
  const state = useRef({ finding, keys, sheet: props.sheet, route });
  state.current = { finding, keys, sheet: props.sheet, route };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = state.current;
      const t = e.target as Element | null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.metaKey || e.altKey || e.ctrlKey || s.finding) return;
      if (document.querySelector(".overlay")) return;
      if ((e.key === "Enter" || e.key === " ") && t?.closest("a, button")) return;
      const k = e.key;
      if (k === "/") {
        e.preventDefault();
        setFinding(true);
        return;
      }
      if (k === "Escape") {
        if (s.keys) return setKeys(false);
        if (s.sheet) return navigate(withQuery({ note: undefined }));
        if (store.focused) return store.setFocus(undefined);
        return;
      }
      if (k === "?") return setKeys((x) => !x);
      if (k === "L") return navigate(`${base}/standing`);
      if (k === "N") return navigate(`${base}/notebooks`);
      if (k === "T") return navigate(`${base}/notebooks/tree`);
      if (k === "W") return navigate(`${base}/notebooks/library`);
      if (k === "F") {
        const f = vault.shelf[0];
        return navigate(f ? noteHref(base, f.note_id) : `${base}/notebooks`);
      }
      if (s.route.page === "tree") return;
      // d: direct the agents on the focused note (or, on Standing, the project) (ADR 0057).
      if (k === "d") {
        const at = store.focused ?? (s.route.page === "standing" ? "S:project" : undefined);
        if (!at) return;
        e.preventDefault();
        return directionStore(ui.pid)?.compose(at);
      }
      if (k === "j" || k === "ArrowDown") {
        e.preventDefault();
        return move(store, 1);
      }
      if (k === "k" || k === "ArrowUp") {
        e.preventDefault();
        return move(store, -1);
      }
      const el = store.focused ? noteEl(store.focused) : null;
      if (!el) return;
      const id = el.dataset["id"] as string;
      if (["]", "l", "ArrowRight", "Enter", " "].includes(k)) {
        e.preventDefault();
        return step(ui, el, 1);
      }
      if (["[", "h", "ArrowLeft"].includes(k)) {
        e.preventDefault();
        return step(ui, el, -1);
      }
      if (k === "c") {
        const pl = places(ui, id).find((p) => p.kind === "notebook");
        if (pl) navigate(ui.placeHref(pl));
        return;
      }
      if (k === "s" || k === "o") return openSheet(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui, store, vault, base]);

  const page: ReactNode =
    route.page === "standing" ? (
      <StandingPage name={props.name} at={props.at} />
    ) : route.page === "tree" ? (
      <TreePage name={props.name} />
    ) : route.page === "library" ? (
      <LibraryPage name={props.name} work={props.work} notebook={props.notebook} />
    ) : route.page === "note" ? (
      <NotePage key={route.id} id={route.id} at={props.at} />
    ) : (
      <ShelfPage name={props.name} />
    );

  return (
    <VaultUiContext.Provider value={ui}>
      <div className="vault">
        <Trail
          name={props.name}
          route={route}
          onFind={() => setFinding(true)}
          onKeys={() => setKeys((x) => !x)}
        />
        <div className="v-page">{page}</div>
        {props.sheet ? <Sheet id={props.sheet} /> : null}
        {finding ? (
          <Find
            initial={findText}
            onClose={() => {
              setFinding(false);
              setFindText("");
            }}
          />
        ) : null}
        {keys ? <Keys onClose={() => setKeys(false)} /> : null}
        {/* A new page or sheet starts without a hover left over from the last one. */}
        <Peek key={`${location.pathname}?${props.sheet ?? ""}${finding ? "f" : ""}`} />
      </div>
    </VaultUiContext.Provider>
  );
}

function openSheet(id: string): void {
  if (new URLSearchParams(location.search).get("note") === id) return;
  navigate(withQuery({ note: id }));
}

/** j and k: the next or previous note on the page (or in the sheet, when focus is there). */
function move(store: VaultStore, dir: number): void {
  const focused = store.focused ? noteEl(store.focused) : null;
  const scope: ParentNode =
    (focused?.closest(".v-sheet") as HTMLElement | null) ??
    document.querySelector(".vault .v-page") ??
    document;
  const list = [...scope.querySelectorAll<HTMLElement>(".v-note")];
  if (!list.length) return;
  let i = focused ? list.indexOf(focused) : -1;
  if (i < 0) {
    const y = (mainEl()?.getBoundingClientRect().top ?? 0) + trailHeight();
    i = list.findIndex((el) => el.getBoundingClientRect().bottom > y) - (dir > 0 ? 1 : 0);
  }
  const next = list[Math.max(0, Math.min(list.length - 1, i + dir))];
  if (!next) return;
  store.setFocus(next.dataset["key"]);
  reveal(next, "nearest");
}

/** Deeper or shallower; at the shallowest, to the note around it. */
function step(ui: VaultUi, el: HTMLElement, dir: 1 | -1): void {
  const d = (el.dataset["depth"] ?? "gist") as Depth;
  const min = DEPTHS.indexOf((el.dataset["min"] ?? "gist") as Depth);
  const max = DEPTHS.indexOf((el.dataset["max"] ?? "summary") as Depth);
  const i = DEPTHS.indexOf(d) + dir;
  const key = el.dataset["key"] as string;
  if (i > max) return;
  if (i < min) {
    const parent = el.parentElement?.closest<HTMLElement>(".v-note");
    if (parent) {
      ui.store.setFocus(parent.dataset["key"]);
      reveal(parent, "nearest");
    }
    return;
  }
  ui.setDepth(key, el.dataset["id"] as string, DEPTHS[i] as Depth);
  afterPaint(() => {
    const now = noteEl(key);
    if (now) reveal(now, "nearest");
  });
}

// ---------------------------------------------------------------- the trail

interface Crumb {
  label: ReactNode;
  to?: string;
  jump?: string;
  top?: boolean;
}

function Trail(props: { name: string; route: Route; onFind: () => void; onKeys: () => void }) {
  const ui = useVaultUi();
  const { vault: v, base } = ui;
  const [chain, setChain] = useState<string[]>([]);
  const [group, setGroup] = useState<string>();

  useEffect(() => {
    const main = mainEl();
    if (!main) return;
    let raf = 0;
    const update = () => {
      const y = main.getBoundingClientRect().top + trailHeight() + 48;
      let deepest: HTMLElement | undefined;
      for (const el of document.querySelectorAll<HTMLElement>(".vault .v-page .v-note[data-key]")) {
        const r = el.getBoundingClientRect();
        if (r.top <= y && r.bottom > y + 6) deepest = el;
      }
      const els: HTMLElement[] = [];
      for (
        let el: HTMLElement | null | undefined = deepest;
        el;
        el = el.parentElement?.closest<HTMLElement>(".v-note[data-key]")
      )
        els.unshift(el);
      const keys = els.map((e) => e.dataset["key"] as string);
      setChain((old) => (old.join("|") === keys.join("|") ? old : keys));
      setGroup(els[0]?.dataset["group"]);
      // The rail follows the reading position.
      const top = keys[0];
      for (const a of document.querySelectorAll<HTMLElement>(".v-rail-i"))
        a.classList.toggle("cur", a.dataset["jump"] === top);
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    update();
    main.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    const t = setTimeout(update, 300);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
      main.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  const crumbs: Crumb[] = [{ label: props.name, to: base }];
  const r = props.route;
  // On the shelf, the tree and the library, the trail says which of the three (ADR 0055).
  const shelf = r.page === "shelf" || r.page === "tree" || r.page === "library";
  if (shelf) crumbs.push({ label: <SubTrail base={base} at={r.page} /> });
  else if (r.page === "note") {
    const n = v.get(r.id);
    crumbs.push({ label: "Notebooks", to: `${base}/notebooks` });
    if (n && v.isEdition(n.note_id)) crumbs.push({ label: "Sessions", to: `${base}/notebooks` });
    else if (n?.type === "notebook")
      for (const c of (v.contexts(r.id)[0] ?? []).slice(0, -1))
        crumbs.push({ label: short(c.title, 34), to: noteHref(base, c.note_id) });
    if (n) crumbs.push({ label: short(n.title, 40), top: true });
  } else crumbs.push({ label: "Where it stands", top: true });
  if (group) crumbs.push({ label: group });
  for (const k of chain) {
    const id = k
      .split(">")
      .at(-1)
      ?.replace(/^[A-Z]:/, "") as string;
    const n = v.get(id);
    if (!n) continue;
    crumbs.push({
      label: (
        <>
          <span className="v-nt">{crumbWord(v, n)}</span> {short(n.title, 44)}
        </>
      ),
      jump: k,
    });
  }
  return (
    <nav className="trail v-trail" aria-label="Where you are">
      <div className="trail-path">
        {crumbs.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a path, in order
          <span key={i} className={`crumb${shelf && i === 1 ? " v-subtrail" : ""}`}>
            {i ? <span className="trail-sep">›</span> : null}
            {c.to ? (
              <Link to={c.to}>{c.label}</Link>
            ) : c.top || c.jump ? (
              <button
                type="button"
                onClick={() => {
                  const main = mainEl();
                  if (c.top && main) main.scrollTop = 0;
                  const el = c.jump ? noteEl(c.jump) : null;
                  if (el) {
                    reveal(el, "start");
                    ui.store.setFocus(c.jump);
                  }
                }}
              >
                {c.label}
              </button>
            ) : (
              <span>{c.label}</span>
            )}
          </span>
        ))}
      </div>
      <span className="trail-r">
        <button type="button" className="v-find-btn" onClick={props.onFind} title="Find a note (/)">
          Find a note <kbd>/</kbd>
        </button>
        <button type="button" className="v-keys-btn" onClick={props.onKeys} title="Keys (?)">
          <kbd>?</kbd> Keys
        </button>
      </span>
    </nav>
  );
}

/** Notebooks · Tree · Library: the three ways into the notebooks, the one open marked. */
function SubTrail(props: { base: string; at: string }) {
  const ways: [string, string, string][] = [
    ["shelf", "Notebooks", `${props.base}/notebooks`],
    ["tree", "Tree", `${props.base}/notebooks/tree`],
    ["library", "Library", `${props.base}/notebooks/library`],
  ];
  return (
    <>
      {ways.map(([id, label, to], i) => (
        <span key={id}>
          {i ? <span className="v-faint"> · </span> : null}
          {id === props.at ? (
            <span aria-current="page">{label}</span>
          ) : (
            <Link to={to}>{label}</Link>
          )}
        </span>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- the sheet

function Sheet(props: { id: string }) {
  const ui = useVaultUi();
  const stack = useRef<string[]>([]);
  const s = stack.current;
  if (s.at(-1) !== props.id) {
    if (s.at(-2) === props.id) s.pop();
    else s.push(props.id);
  }
  const n = ui.vault.get(props.id);
  const ref = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new note starts at the top
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    if (n) ui.store.markRead([n.note_id]);
  }, [props.id]);
  if (!n) return null;
  const prev = s.length > 1 ? ui.vault.get(s.at(-2) as string) : undefined;
  return (
    <aside className="v-sheet" aria-label="Note beside the page" ref={ref} data-testid="sheet">
      <div className="v-sh-top">
        {prev ? (
          <button type="button" className="v-sh-back" title="Back" onClick={() => history.back()}>
            ← {short(prev.title, 30)}
          </button>
        ) : (
          <span className="v-faint">
            {n.type === "concept"
              ? "A fundamental"
              : typeWord(ui.vault, n).replace(/^./, (c) => c.toUpperCase())}
          </span>
        )}
        <button
          type="button"
          className="v-sh-x"
          title="Close (esc)"
          onClick={() => {
            stack.current = [];
            navigate(withQuery({ note: undefined }));
          }}
        >
          Close
        </button>
      </div>
      <div className="v-sh-body">
        <NoteView
          key={n.note_id}
          id={n.note_id}
          k={`S:${n.note_id}`}
          level={0}
          dflt="summary"
          sheet
        />
        <PlacesAndMentions id={n.note_id} />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- find

function Find(props: { initial?: string; onClose: () => void }) {
  const ui = useVaultUi();
  const { vault: v, store } = ui;
  const [q, setQ] = useState(props.initial ?? "");
  const [sel, setSel] = useState(0);
  const res = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) {
      const f = v.shelf[0];
      return [
        ...v.ledger.claims.slice(0, 3),
        ...(f ? [f, ...v.children(f.note_id).filter((c) => c.type === "notebook")] : []),
      ].slice(0, 9);
    }
    const bonus = (n: (typeof v.notes)[number]) => {
      const t = n.title.toLowerCase();
      return (
        (t.startsWith(ql) ? 4 : 0) +
        (t.includes(ql) ? 3 : 0) +
        (n.gist.toLowerCase().includes(ql) ? 1 : 0) +
        (v.isEdition(n.note_id) ? -2 : 0)
      );
    };
    return v
      .search(q)
      .map((n, i) => ({ n, s: bonus(n) - i * 0.01 }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.n)
      .slice(0, 12);
  }, [q, v]);
  const choose = (i: number, beside: boolean) => {
    const n = res[i];
    if (!n) return;
    props.onClose();
    if (beside) openSheet(n.note_id);
    else goTo(ui, n.note_id);
  };
  useEffect(() => {
    document.querySelector(".v-fr.sel")?.scrollIntoView({ block: "nearest" });
  });
  const where = (n: (typeof v.notes)[number]) => {
    if (onLedger(n)) return "where it stands";
    if (v.isEdition(n.note_id)) return "a session";
    return places(ui, n.note_id)[0]?.label ?? "the shelf";
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a backdrop click closes; Escape is on the input
    <div
      className="v-find"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="v-find-box" role="dialog" aria-label="Find a note">
        <input
          // biome-ignore lint/a11y/noAutofocus: find is opened to type into
          autoFocus
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Find any note by name or words"
          aria-label="Find a note"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
            else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
              e.preventDefault();
              setSel((s) => Math.min(res.length - 1, s + 1));
            } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(sel, e.shiftKey);
            }
          }}
        />
        <div className="v-find-list" role="listbox" aria-label="Notes">
          {res.length ? (
            q.trim() ? null : (
              <div className="v-fl-h">Start typing, or go to</div>
            )
          ) : (
            <div className="v-fl-h">No note matches.</div>
          )}
          {res.map((n, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keys are on the input
            <div
              key={n.note_id}
              className={`v-fr${i === sel ? " sel" : ""}${store.status(n.note_id) === "read" ? " v-read" : ""}`}
              role="option"
              aria-selected={i === sel}
              tabIndex={-1}
              onMouseEnter={() => setSel(i)}
              onClick={(e) => choose(i, e.shiftKey)}
            >
              <div className="v-fr-1">
                <span className="v-nt">{typeWord(v, n)}</span>
                <span className="v-fr-t">{n.title}</span>
                <span className="v-fr-w">{short(where(n), 34)}</span>
              </div>
              <div className="v-fr-g">
                <Markdown
                  text={resolveLinks(n.gist, (id) => v.get(id)?.title).replace(
                    /\[\[[^\]|]+\|([^\]]*)\]\]/g,
                    "$1",
                  )}
                  inline
                />
              </div>
            </div>
          ))}
        </div>
        <div className="v-find-foot">
          <kbd>↵</kbd> where it stands or in context <kbd>⇧↵</kbd> beside the page <kbd>esc</kbd>{" "}
          close
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- hover: a term's gist

function Peek() {
  const ui = useVaultUi();
  const [p, setP] = useState<
    { id: string; left: number; top: number; below: number } | undefined
  >();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const over = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.<HTMLElement>(".vault a.v-wl[data-note]");
      if (!a) return;
      clearTimeout(t);
      t = setTimeout(() => {
        const r = a.getBoundingClientRect();
        setP({ id: a.dataset["note"] as string, left: r.left, top: r.top, below: r.bottom });
      }, 220);
    };
    const out = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.(".vault a.v-wl")) {
        clearTimeout(t);
        setP(undefined);
      }
    };
    const hide = () => {
      clearTimeout(t);
      setP(undefined);
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    document.addEventListener("click", hide, true);
    document.addEventListener("keydown", hide, true);
    mainEl()?.addEventListener("scroll", hide, { passive: true });
    return () => {
      clearTimeout(t);
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseout", out);
      document.removeEventListener("click", hide, true);
      document.removeEventListener("keydown", hide, true);
      mainEl()?.removeEventListener("scroll", hide);
    };
  }, []);
  // Placed below the link, or above it when there is no room.
  useEffect(() => {
    const el = ref.current;
    if (!el || !p) return;
    const w = Math.min(380, window.innerWidth - 24);
    el.style.width = `${w}px`;
    el.style.left = `${Math.max(12, Math.min(p.left, window.innerWidth - w - 12))}px`;
    const h = el.offsetHeight;
    el.style.top = `${p.below + 8 + h > window.innerHeight - 8 ? p.top - h - 8 : p.below + 8}px`;
  }, [p]);
  const n = p ? ui.vault.get(p.id) : undefined;
  if (!n) return null;
  return (
    <div className="v-peek" ref={ref} role="tooltip">
      <div className="v-pk-t">
        <span className="v-nt">{n.type === "concept" ? "fundamental" : typeWord(ui.vault, n)}</span>{" "}
        {n.title}
      </div>
      <div className="v-pk-g">
        <Inline text={lineText(ui, `g:${n.note_id}`, n.gist, false)} />
      </div>
      <div className="v-pk-h">Click to open beside the page</div>
    </div>
  );
}

// ---------------------------------------------------------------- keys

function Keys(props: { onClose: () => void }) {
  const rows: [ReactNode, string][] = [
    [<kbd key="find">/</kbd>, "Find any note (Ctrl K stays the command palette)"],
    [
      <>
        <kbd>j</kbd> <kbd>k</kbd>
      </>,
      "Next, previous line or note",
    ],
    [
      <>
        <kbd>]</kbd> <kbd>→</kbd> <kbd>↵</kbd>
      </>,
      "Deeper: gist, summary, full text",
    ],
    [
      <>
        <kbd>[</kbd> <kbd>←</kbd>
      </>,
      "Shallower; at the top, to the note around it",
    ],
    [<kbd key="c">c</kbd>, "Read it in context, in its notebook"],
    [<kbd key="s">s</kbd>, "Open it beside the page"],
    [<kbd key="d">d</kbd>, "Direct the agents on it: ask, doubt, do, focus, park, or a rule"],
    [
      <>
        <kbd>n</kbd> <kbd>e</kbd> <kbd>p</kbd> <kbd>x</kbd>
      </>,
      "On Standing: put the claim or question in Now, Next, Parked or Dropped on the agenda",
    ],
    [
      <>
        <kbd>L</kbd> <kbd>N</kbd> <kbd>F</kbd> <kbd>T</kbd> <kbd>W</kbd>
      </>,
      "Where it stands, notebooks, fundamentals, the tree, the library",
    ],
    [<kbd key="esc">esc</kbd>, "Close the sheet; Alt+← goes back"],
  ];
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a backdrop click closes; Escape is on the page
    <div
      className="v-keys"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="v-keys-box" role="dialog" aria-label="Keys">
        <h3>Keys</h3>
        <dl>
          {rows.map(([k, d]) => (
            <div key={d} className="v-keys-row">
              <dt>{k}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
        <p className="v-faint">
          A note is read once you have seen its summary: unfolded, or held on screen for a moment.
          Read titles lose their weight everywhere the note appears.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- an empty vault

function EmptyVault(props: { store: VaultStore; base: string; name: string; route: Route }) {
  const store = props.store;
  useStoreVersion(store);
  useEffect(() => store.loadNames(), [store]);
  const names = store.namesSlot();
  const hasRecords = (names.data?.size ?? 0) > 0;
  const here = props.route.page === "standing" ? "Where it stands" : "Notebooks";
  return (
    <div className="vault">
      <PageTrail crumbs={[{ label: props.name, to: props.base }, { label: here }]} />
      <div className="v-page-w v-empty-vault" data-testid="vault-empty">
        <header className="v-ph">
          <div className="v-eyebrow">{props.name}</div>
          <h1 className="v-hand">{here}</h1>
        </header>
        <p className="v-intro">
          This project has no vault yet. The vault is where the project's knowledge is kept for
          reading: small notes (concepts, methods, experiments, findings, claims, decisions and
          questions), each read as a gist, a summary or in full, composed into notebooks that
          explain the project from first principles, and a ledger of where it stands: what is
          established, what is leaning, what is open, the decisions in force.
        </p>
        <p>
          Agents write it as they work, through <code>ablationkit mcp</code>; the research-task
          skill tells them how. Notes you already keep as Markdown files come in with{" "}
          <code>ablationkit vault import DIR --project {store.pid}</code>.
        </p>
        <p>
          Reading marks itself here: nothing asks you to review or rate anything. What you have read
          loses its weight, and what is new since you last read carries a mark.
        </p>
        {hasRecords ? (
          <p>
            Until then, the project's tasks and records are as they were written:{" "}
            <Link to={`${props.base}/knowledge`}>the original records</Link>.
          </p>
        ) : null}
      </div>
    </div>
  );
}
