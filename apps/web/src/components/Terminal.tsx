/**
 * A contained agent's terminal, live and read-only (ADR 0065): the screen tmux holds for it,
 * polled with its colours (`/screen?ansi=1`) and drawn as styled text. `lines` keeps only the last
 * lines that hold something (the Agents page's tiles); without it the whole screen is drawn.
 */
import "../styles/agents.css";
import { useMemo } from "react";
import { useApi } from "../api.ts";
import { type AnsiLine, parseAnsi } from "../lib/ansi.ts";
import { ErrorBox } from "./ui.tsx";

export function LiveTerminal(props: {
  sid: string;
  pollMs?: number;
  /** Show only the last this many lines with text in them (a compact view). */
  lines?: number;
  className?: string;
}) {
  const screen = useApi<{ state: string; text: string; captured_at: string }>(
    `/api/v1/agent-containers/${encodeURIComponent(props.sid)}/screen?ansi=1`,
    { pollMs: props.pollMs ?? 1_500 },
  );
  const lines = useMemo<AnsiLine[]>(() => {
    const all = parseAnsi(screen.data?.text ?? "");
    if (!props.lines) return all;
    let end = all.length;
    while (end > 0 && (all[end - 1] as AnsiLine).every((s) => !s.text.trim())) end--;
    return all.slice(Math.max(0, end - props.lines), end);
  }, [screen.data?.text, props.lines]);
  if (screen.error) return <ErrorBox error={screen.error} />;
  const ended = screen.data && !["starting", "running", "paused"].includes(screen.data.state);
  return (
    <section aria-label="The agent's terminal (read-only)">
      <pre
        className={`term${props.lines ? " term-compact" : ""}${props.className ? ` ${props.className}` : ""}`}
        data-testid="live-terminal"
      >
        {!screen.data ? (
          <span className="term-dim">…</span>
        ) : ended ? (
          <span className="term-dim">The session has ended: no terminal.</span>
        ) : (
          lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: screen rows in order
            <div key={i} className="term-line">
              {line.length === 0
                ? " "
                : line.map((s, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: spans in order
                    <span key={j} style={s.style}>
                      {s.text}
                    </span>
                  ))}
            </div>
          ))
        )}
      </pre>
    </section>
  );
}
