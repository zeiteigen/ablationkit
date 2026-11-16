/**
 * A terminal screen with SGR escape sequences (what `tmux capture-pane -e` gives) as lines of
 * styled spans, for the Agents page's live terminals (ADR 0065). Colours (16, 256 and 24-bit),
 * bold, dim, italic, underline, strikethrough and inverse are kept; every other escape sequence
 * (OSC hyperlinks, titles, cursor moves) is dropped. Text is never interpreted as HTML: the spans
 * hold it as text.
 */

export interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: string;
  opacity?: number;
  fontStyle?: string;
  textDecoration?: string;
}

export interface AnsiSpan {
  readonly text: string;
  readonly style: AnsiStyle;
}

export type AnsiLine = readonly AnsiSpan[];

/** The 16 colours, chosen to read on the terminal's dark surface. */
export const PALETTE: readonly string[] = [
  "#4b5263",
  "#e06c75",
  "#98c379",
  "#e5c07b",
  "#61afef",
  "#c678dd",
  "#56b6c2",
  "#d7dae0",
  "#6b7280",
  "#ff7b86",
  "#b5e890",
  "#ffd68a",
  "#82c4ff",
  "#dd9bf0",
  "#7fd4df",
  "#ffffff",
];

/** The terminal's own colours, where a sequence asks for the default (or inverts it). */
export const DEFAULT_FG = "var(--term-fg)";
export const DEFAULT_BG = "var(--term-bg)";

const hex = (n: number) => n.toString(16).padStart(2, "0");

/** xterm's 256 colours: the 16, a 6×6×6 cube, then 24 greys. */
export function color256(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return PALETTE[n];
  if (n < 232) {
    const levels = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    const r = levels[Math.floor(i / 36)] as number;
    const g = levels[Math.floor(i / 6) % 6] as number;
    const b = levels[i % 6] as number;
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  const v = 8 + (n - 232) * 10;
  return `#${hex(v)}${hex(v)}${hex(v)}`;
}

interface State {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
}

function styleOf(s: State): AnsiStyle {
  let fg = s.fg;
  let bg = s.bg;
  if (s.inverse) {
    fg = s.bg ?? DEFAULT_BG;
    bg = s.fg ?? DEFAULT_FG;
  }
  const deco = [s.underline ? "underline" : "", s.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  return {
    ...(fg ? { color: fg } : {}),
    ...(bg ? { backgroundColor: bg } : {}),
    ...(s.bold ? { fontWeight: "bold" } : {}),
    ...(s.dim ? { opacity: 0.65 } : {}),
    ...(s.italic ? { fontStyle: "italic" } : {}),
    ...(deco ? { textDecoration: deco } : {}),
  };
}

/** Apply one SGR sequence's parameters to the state. */
function sgr(params: readonly number[], s: State): State {
  const p = params.length ? [...params] : [0];
  let next: State = { ...s };
  for (let i = 0; i < p.length; i++) {
    const n = p[i] as number;
    if (n === 0) next = {};
    else if (n === 1) next.bold = true;
    else if (n === 2) next.dim = true;
    else if (n === 3) next.italic = true;
    else if (n === 4) next.underline = true;
    else if (n === 7) next.inverse = true;
    else if (n === 9) next.strike = true;
    else if (n === 22) {
      delete next.bold;
      delete next.dim;
    } else if (n === 23) delete next.italic;
    else if (n === 24) delete next.underline;
    else if (n === 27) delete next.inverse;
    else if (n === 29) delete next.strike;
    else if (n >= 30 && n <= 37) next.fg = PALETTE[n - 30] as string;
    else if (n === 39) delete next.fg;
    else if (n >= 40 && n <= 47) next.bg = PALETTE[n - 40] as string;
    else if (n === 49) delete next.bg;
    else if (n >= 90 && n <= 97) next.fg = PALETTE[n - 90 + 8] as string;
    else if (n >= 100 && n <= 107) next.bg = PALETTE[n - 100 + 8] as string;
    else if (n === 38 || n === 48) {
      const mode = p[i + 1];
      let c: string | undefined;
      if (mode === 5) {
        c = color256(p[i + 2] ?? -1);
        i += 2;
      } else if (mode === 2) {
        const [r, g, b] = [p[i + 2], p[i + 3], p[i + 4]];
        if ([r, g, b].every((x) => x !== undefined && x >= 0 && x <= 255))
          c = `#${hex(r as number)}${hex(g as number)}${hex(b as number)}`;
        i += 4;
      }
      if (c) {
        if (n === 38) next.fg = c;
        else next.bg = c;
      }
    }
  }
  return next;
}

// CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), and two-character escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this parses
const ESCAPE = /\u001b(?:\[([0-9;:?]*)([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** A screen as lines of styled spans. */
export function parseAnsi(screen: string): AnsiLine[] {
  const lines: AnsiLine[] = [];
  let state: State = {};
  for (const raw of screen.replace(/\r/g, "").split("\n")) {
    const spans: AnsiSpan[] = [];
    let last = 0;
    const push = (text: string) => {
      if (!text) return;
      const style = styleOf(state);
      const prev = spans.at(-1);
      if (prev && JSON.stringify(prev.style) === JSON.stringify(style))
        spans[spans.length - 1] = { text: prev.text + text, style };
      else spans.push({ text, style });
    };
    for (const m of raw.matchAll(ESCAPE)) {
      push(raw.slice(last, m.index));
      last = (m.index as number) + m[0].length;
      if (m[2] === "m") {
        const params = (m[1] ?? "")
          .split(/[;:]/)
          .filter((x) => x !== "")
          .map(Number);
        state = sgr(params, state);
      }
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stray control characters go
    push(raw.slice(last).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""));
    lines.push(spans);
  }
  return lines;
}
