/**
 * The library (ADR 0052): the prior work consulted for a project, grouped by the part each work
 * played in the notes that cite it, then the works read and set aside, then the ones found and
 * not read yet. Each work says what was taken from it, how closely it was read, what it was looked
 * up for and which notes cite it, and the whole library (or a notebook's share of it) downloads as
 * BibTeX, CSL-JSON or an annotated bibliography.
 */
import type { VaultWork } from "@ablationkit/protocol";
import {
  CITE_ROLES,
  ROLE_HEADINGS,
  ROLE_WORDS,
  rolesOf,
  shortCite,
  type WorkUse,
  workHref,
} from "@ablationkit/vault";
import { memo, useLayoutEffect, useMemo } from "react";
import { Inline, useStoreVersion, useVaultUi } from "../components/Note.tsx";
import { Link } from "../components/ui.tsx";
import { afterPaint, flash, mainEl, reveal } from "../components/vault-dom.ts";
import { citationsHref, libraryHref } from "../lib/vault.ts";
import { noteHref } from "./notebooks.tsx";

const READING_WORD: Record<VaultWork["reading"], string> = {
  unread: "not read yet",
  abstract: "abstract only",
  skimmed: "skimmed",
  read: "read",
};

function WorkItem(props: { w: VaultWork; uses: readonly WorkUse[] }) {
  const ui = useVaultUi();
  const { w, uses } = props;
  const href = workHref(w);
  const meta = [
    w.kind,
    w.venue,
    w.version ? `version ${w.version}` : undefined,
    READING_WORD[w.reading],
  ].filter(Boolean);
  return (
    <article className="v-work" data-work={w.work_id} id={`w-${w.work_id}`}>
      <div className="v-work-h">
        <span className="v-work-c">{shortCite(w)}</span>{" "}
        {href ? (
          <a href={href} target="_blank" rel="noreferrer noopener" className="v-work-t">
            {w.title}
          </a>
        ) : (
          <span className="v-work-t">{w.title}</span>
        )}
      </div>
      <div className="v-work-m">
        {meta.join(" · ")} · <span className="v-mono">{w.work_id}</span>
      </div>
      <p className="v-work-take">
        <Inline text={w.takeaway} />
      </p>
      {uses.length ? (
        <ul className="v-work-uses">
          {uses.map((u, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: citations in note order
            <li key={i}>
              <span className={`v-role r-${u.role}`}>{ROLE_WORDS[u.role]}</span>
              <Link to={noteHref(ui.base, u.note.note_id)}>{u.note.title}</Link>
              {u.where ? <span className="v-faint">{u.where}</span> : null}
              {u.note_text ? (
                <div className="v-cite-n">
                  <Inline text={u.note_text} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {w.summary ? (
        <details className="v-work-more">
          <summary>What it says</summary>
          <Inline text={w.summary} className="v-work-sum" />
        </details>
      ) : null}
      {w.found_for ? (
        <div className="v-work-for">
          <span className="v-prov-h">Looked up for</span> <Inline text={w.found_for} />
        </div>
      ) : null}
    </article>
  );
}

function Exports(props: { notebook?: string | undefined }) {
  const ui = useVaultUi();
  const link = (f: "bibtex" | "csl-json" | "markdown", label: string) => (
    <a href={citationsHref(ui.pid, f, props.notebook)} download>
      {label}
    </a>
  );
  return (
    <p className="v-work-exp" data-testid="library-export">
      <span className="v-prov-h">Export citations</span> {link("bibtex", "BibTeX")} ·{" "}
      {link("csl-json", "CSL-JSON")} · {link("markdown", "Annotated (Markdown)")}
    </p>
  );
}

export const LibraryPage = memo(function LibraryPage(props: {
  name: string;
  work: string | undefined;
  notebook: string | undefined;
}) {
  const ui = useVaultUi();
  const { store, vault } = ui;
  useStoreVersion(store);
  const nb = props.notebook ? vault.get(props.notebook) : undefined;
  const groups = useMemo(() => {
    const scope = nb ? vault.under(nb.note_id) : undefined;
    const uses = (id: string) =>
      (store.uses.get(id) ?? []).filter((u) => !scope || scope.has(u.note.note_id));
    const works = [...store.works.values()]
      .filter((w) => !scope || uses(w.work_id).length)
      .sort((a, b) => a.work_id.localeCompare(b.work_id));
    const out: { key: string; title: string; sub: string; items: [VaultWork, WorkUse[]][] }[] = [];
    // A work sits under the first role it plays; its lines name every role.
    for (const r of CITE_ROLES) {
      const items = works
        .filter((w) => rolesOf(uses(w.work_id))[0] === r)
        .map((w) => [w, uses(w.work_id)] as [VaultWork, WorkUse[]]);
      if (items.length) out.push({ key: r, title: ROLE_HEADINGS[r], sub: "", items });
    }
    const rest = works.filter((w) => !uses(w.work_id).length);
    const aside = rest.filter((w) => w.reading !== "unread");
    const unread = rest.filter((w) => w.reading === "unread");
    if (aside.length)
      out.push({
        key: "aside",
        title: "Considered and set aside",
        sub: "Read, and not used: why is in each.",
        items: aside.map((w) => [w, []]),
      });
    if (unread.length)
      out.push({
        key: "unread",
        title: "Found, not read yet",
        sub: "",
        items: unread.map((w) => [w, []]),
      });
    return { out, total: works.length };
  }, [store, vault, nb]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: on arrival only
  useLayoutEffect(() => {
    const m = mainEl();
    if (!props.work) {
      if (m) m.scrollTop = 0;
      return;
    }
    afterPaint(() => {
      const el = document.querySelector<HTMLElement>(
        `.v-work[data-work="${CSS.escape(props.work as string)}"]`,
      );
      if (!el) return;
      reveal(el, "start");
      flash(el);
    });
  }, [props.work, props.notebook]);

  return (
    <div className="v-page-w v-library" data-testid="library">
      <header className="v-ph">
        <div className="v-eyebrow">{props.name}</div>
        <h1 className="v-hand">{nb ? `Works cited in ${nb.title}` : "Library"}</h1>
        <p className="v-ph-s">
          {nb ? (
            <>
              The prior work this notebook and the notes beneath it cite, by the part each played.{" "}
              <Link to={libraryHref(ui.base)}>The whole library</Link>.
            </>
          ) : (
            <>
              The prior work consulted for this project, by the part each played in the notes that
              cite it. Every work the agents read is kept, the ones set aside too, with what was
              taken from it.
            </>
          )}
        </p>
        {groups.total ? <Exports notebook={nb?.note_id} /> : null}
      </header>
      {groups.out.map((g) => (
        <section key={g.key} className="v-sh-sec">
          <h2 className="v-gh">
            <span>{g.title}</span> {g.sub ? <span className="v-gs">{g.sub}</span> : null}
          </h2>
          {g.items.map(([w, uses]) => (
            <WorkItem key={w.work_id} w={w} uses={uses} />
          ))}
        </section>
      ))}
      {!groups.total ? (
        <p className="v-empty">
          {nb
            ? "No note in this notebook cites prior work."
            : "The library is empty. Agents record each paper, repository, doc or thread they consult (ablationkit_work add) and cite it from the notes it bears on, with the part it plays."}
        </p>
      ) : null}
    </div>
  );
});
