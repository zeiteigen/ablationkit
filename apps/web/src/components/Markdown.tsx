/**
 * Research text as a read (ADR 0048): Markdown (GFM tables, lists, code) with LaTeX mathematics,
 * `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` on their own lines.
 *
 * Records are written by agents and are data: the text is parsed to tokens and rendered as React
 * elements, so no HTML in it is ever interpreted (it shows as the text it is), links open only
 * `http(s)` and `mailto` targets, and images are not loaded. KaTeX builds its output as DOM nodes
 * (`katex.render`), with `trust` off, so the page's CSP needs no inline styles.
 *
 * Vault prose (ADR 0049) adds one thing: `[[id]]` and `[[id|words]]` link another note of the
 * vault. Given `notes`, such a link becomes an in-app link to that note (a React element, never
 * HTML); without it, or for a note the vault does not have, it stays the text it is.
 * `[[run:<run>#<metric>]]` is a live run reference (ADR 0056): given `notes.runRef`, it becomes
 * the run's value, read when the note is shown; without it, the reference as written.
 */
import "katex/dist/katex.min.css";
import katex from "katex";
import { Marked, type Token, type Tokens } from "marked";
import { Fragment, type MouseEvent, type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { Link } from "./ui.tsx";

interface MathToken {
  type: "blockMath" | "inlineMath";
  raw: string;
  tex: string;
}

/** `$x$`: the opening `$` hugs its content and the closing one is not followed by a digit. */
const INLINE_DOLLAR = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/;
const INLINE_PAREN = /^\\\((.+?)\\\)/;
const BLOCK_DOLLAR = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/;
const BLOCK_BRACKET = /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/;
/** `[[id]]` or `[[id|words]]`: a link to a note of the vault. */
const WIKI_LINK = /^\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/;

interface WikiToken {
  type: "wikiLink";
  raw: string;
  id: string;
  label?: string | undefined;
}

const parser = new Marked({
  gfm: true,
  breaks: false,
  extensions: [
    {
      name: "wikiLink",
      level: "inline",
      start: (src: string) => {
        const i = src.indexOf("[[");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string): WikiToken | undefined {
        const m = WIKI_LINK.exec(src);
        return m
          ? { type: "wikiLink", raw: m[0], id: (m[1] as string).trim(), label: m[2]?.trim() }
          : undefined;
      },
    },
    {
      name: "blockMath",
      level: "block",
      start: (src: string) => {
        const i = src.search(/\$\$|\\\[/);
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string): MathToken | undefined {
        const m = BLOCK_DOLLAR.exec(src) ?? BLOCK_BRACKET.exec(src);
        return m ? { type: "blockMath", raw: m[0], tex: (m[1] as string).trim() } : undefined;
      },
    },
    {
      name: "inlineMath",
      level: "inline",
      start: (src: string) => {
        const i = src.search(/\$|\\\(/);
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string): MathToken | undefined {
        const block = /^\$\$([^\n]+?)\$\$/.exec(src);
        if (block) return { type: "inlineMath", raw: block[0], tex: (block[1] as string).trim() };
        const m = INLINE_DOLLAR.exec(src) ?? INLINE_PAREN.exec(src);
        return m ? { type: "inlineMath", raw: m[0], tex: (m[1] as string).trim() } : undefined;
      },
    },
  ],
});

/** One formula. A LaTeX error shows the source in the error colour instead of throwing. */
function Tex(props: { tex: string; display?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      katex.render(props.tex, el, {
        displayMode: props.display ?? false,
        throwOnError: false,
        errorColor: "var(--err)",
        trust: false,
        strict: "ignore",
        maxExpand: 500,
      });
    } catch {
      el.textContent = props.tex;
    }
  }, [props.tex, props.display]);
  return (
    <span
      ref={ref}
      className={props.display ? "tex display" : "tex"}
      role="math"
      aria-label={props.tex}
    />
  );
}

const SAFE_HREF = /^(https?:|mailto:)/i;
/** IDs agents write in text: research records and tasks open in the app. */
const RECORD_ID = /^(?:hyp|apr|note|rep|dec|conv)-\d{8}-[0-9a-f]{6}$/;
const TASK_ID = /^task-\d{8}-[a-z0-9]{6}$/;

/** How vault prose links its notes: in-app links, opened by the page that shows them. */
export interface NoteLinks {
  /** The note's type, or undefined when the vault has no such note. */
  typeOf(id: string): string | undefined;
  /** Its address in the app (for a new tab, and as the link's target). */
  href(id: string): string;
  /** What a plain click does (open it beside the page). */
  open(id: string): void;
  /** A live run reference (`run:a#loss vs b`, ADR 0056), drawn as the run's value. */
  runRef?(inner: string): ReactNode;
}

interface Ctx {
  /** Project base path (`/p/<id>`): record and task IDs in code spans become links. */
  base?: string | undefined;
  notes?: NoteLinks | undefined;
}

function noteLink(t: WikiToken, ctx: Ctx): ReactNode {
  const notes = ctx.notes;
  if (t.id.startsWith("run:") && t.label === undefined)
    return notes?.runRef ? notes.runRef(t.id) : t.raw;
  const type = notes?.typeOf(t.id);
  if (!notes) return t.raw;
  const words = t.label || t.id;
  if (!type) return words;
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    notes.open(t.id);
  };
  return (
    <a className={`v-wl v-wl-${type}`} href={notes.href(t.id)} data-note={t.id} onClick={click}>
      {words}
    </a>
  );
}

function inline(tokens: Token[] | undefined, ctx: Ctx): ReactNode {
  return (tokens ?? []).map((t, i) => {
    // biome-ignore lint/suspicious/noArrayIndexKey: tokens of static text, never reordered
    return <Fragment key={i}>{inlineToken(t, ctx)}</Fragment>;
  });
}

function inlineToken(t: Token, ctx: Ctx): ReactNode {
  switch (t.type) {
    case "text": {
      const x = t as Tokens.Text;
      return x.tokens ? inline(x.tokens, ctx) : x.text;
    }
    case "escape":
      return (t as Tokens.Escape).text;
    case "strong":
      return <strong>{inline((t as Tokens.Strong).tokens, ctx)}</strong>;
    case "em":
      return <em>{inline((t as Tokens.Em).tokens, ctx)}</em>;
    case "del":
      return <del>{inline((t as Tokens.Del).tokens, ctx)}</del>;
    case "codespan": {
      const text = (t as Tokens.Codespan).text;
      if (ctx.base && RECORD_ID.test(text))
        return (
          <Link to={`${ctx.base}/knowledge/r/${encodeURIComponent(text)}`}>
            <code>{text}</code>
          </Link>
        );
      if (ctx.base && TASK_ID.test(text))
        return (
          <Link to={`${ctx.base}/tasks/${encodeURIComponent(text)}`}>
            <code>{text}</code>
          </Link>
        );
      return <code>{text}</code>;
    }
    case "br":
      return <br />;
    case "link": {
      const x = t as Tokens.Link;
      const body = inline(x.tokens, ctx);
      return SAFE_HREF.test(x.href) ? (
        <a href={x.href} target="_blank" rel="noopener noreferrer" title={x.title ?? undefined}>
          {body}
        </a>
      ) : (
        <span title={x.href}>{body}</span>
      );
    }
    case "image": {
      // Never loaded: a record must not make the page fetch anything.
      const x = t as Tokens.Image;
      return SAFE_HREF.test(x.href) ? (
        <a href={x.href} target="_blank" rel="noopener noreferrer">
          {x.text || x.href}
        </a>
      ) : (
        <span className="faint">[{x.text || "image"}]</span>
      );
    }
    case "inlineMath":
      return <Tex tex={(t as unknown as MathToken).tex} />;
    case "wikiLink":
      return noteLink(t as unknown as WikiToken, ctx);
    default:
      // HTML and anything unknown: the text as written.
      return t.raw;
  }
}

function block(t: Token, ctx: Ctx): ReactNode {
  switch (t.type) {
    case "space":
      return null;
    case "heading": {
      const x = t as Tokens.Heading;
      // A record's own headings sit under the page's: start at h3.
      const H = `h${Math.min(6, x.depth + 2)}` as "h3" | "h4" | "h5" | "h6";
      return <H className={`md-h${Math.min(4, x.depth)}`}>{inline(x.tokens, ctx)}</H>;
    }
    case "paragraph":
      return <p>{inline((t as Tokens.Paragraph).tokens, ctx)}</p>;
    case "text": {
      const x = t as Tokens.Text;
      return x.tokens ? inline(x.tokens, ctx) : x.text;
    }
    case "blockquote":
      return <blockquote>{blocks((t as Tokens.Blockquote).tokens, ctx)}</blockquote>;
    case "hr":
      return <hr />;
    case "code": {
      const x = t as Tokens.Code;
      if (x.lang === "math" || x.lang === "latex" || x.lang === "tex")
        return (
          <div className="md-math">
            <Tex tex={x.text} display />
          </div>
        );
      return (
        <pre className="md-code">
          <code>{x.text}</code>
        </pre>
      );
    }
    case "list": {
      const x = t as Tokens.List;
      const items = x.items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
        <li key={i} className={it.task ? "md-task" : undefined}>
          {it.task ? <input type="checkbox" checked={it.checked ?? false} readOnly /> : null}
          {blocks(it.tokens, ctx)}
        </li>
      ));
      return x.ordered ? (
        <ol start={typeof x.start === "number" ? x.start : undefined}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case "table": {
      const x = t as Tokens.Table;
      const cls = (a: string | null) => (a === "right" ? "num" : a === "center" ? "center" : "");
      return (
        <div className="table-wrap md-table">
          <table>
            <thead>
              <tr>
                {x.header.map((h, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
                  <th key={i} className={cls(x.align[i] ?? null)}>
                    {inline(h.tokens, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {x.rows.map((r, k) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
                <tr key={k}>
                  {r.map((c, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
                    <td key={i} className={cls(x.align[i] ?? null)}>
                      {inline(c.tokens, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "blockMath":
      return (
        <div className="md-math">
          <Tex tex={(t as unknown as MathToken).tex} display />
        </div>
      );
    case "html":
      // Shown, never interpreted.
      return <p>{t.raw}</p>;
    default:
      return "tokens" in t && t.tokens ? inline(t.tokens, ctx) : t.raw;
  }
}

function blocks(tokens: Token[] | undefined, ctx: Ctx): ReactNode {
  return (tokens ?? []).map((t, i) => {
    // biome-ignore lint/suspicious/noArrayIndexKey: tokens of static text, never reordered
    return <Fragment key={i}>{block(t, ctx)}</Fragment>;
  });
}

export function Markdown(props: {
  text: string;
  base?: string | undefined;
  testId?: string | undefined;
  /** Larger type for the description at the top of a page. */
  lede?: boolean;
  /** Vault prose: `[[id]]` links become links to notes. */
  notes?: NoteLinks | undefined;
  /** A single paragraph (a gist, a line) as a span, without the paragraph around it. */
  inline?: boolean;
  className?: string | undefined;
}) {
  const tokens = useMemo(() => {
    try {
      return parser.lexer(props.text);
    } catch {
      return undefined;
    }
  }, [props.text]);
  const ctx: Ctx = { base: props.base, notes: props.notes };
  if (props.inline) {
    const one = tokens?.length === 1 && tokens[0]?.type === "paragraph" ? tokens[0] : undefined;
    return (
      <span className={props.className ? `md-inline ${props.className}` : "md-inline"}>
        {one
          ? inline((one as Tokens.Paragraph).tokens, ctx)
          : tokens
            ? blocks(tokens, ctx)
            : props.text}
      </span>
    );
  }
  const cls = `${props.lede ? "md lede" : "md"}${props.className ? ` ${props.className}` : ""}`;
  return (
    <div className={cls} data-testid={props.testId}>
      {tokens ? blocks(tokens, ctx) : <p className="pre">{props.text}</p>}
    </div>
  );
}

/**
 * One or two lines of a description for a list row: Markdown marks dropped, mathematics kept as
 * its source, cut at `max` characters.
 */
export function plainExcerpt(text: string | undefined, max = 240): string {
  if (!text) return "";
  const s = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*\|.*$/gm, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}
