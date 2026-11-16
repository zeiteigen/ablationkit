/**
 * Console viewer for one attempt (ADR 0011). Pages `…/console?after=` until a page says `done`,
 * polling while the attempt runs. Works while MLflow is down: console lines live in the
 * coordinator's journal, not in MLflow.
 */
import { useEffect, useRef, useState } from "react";
import { api, qs } from "../api.ts";
import type { ConsoleLine } from "../lib/types.ts";
import { Badge, ErrorBox } from "./ui.tsx";

const STREAMS = ["stdout", "stderr", "log", "system"] as const;
/** Lines kept in the browser; older ones are dropped with a notice. */
const CONSOLE_KEEP = 20_000;

export function ConsoleViewer(props: { jobId: string; attemptId: string }) {
  const [streams, setStreams] = useState<string[]>([...STREAMS]);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [dropped, setDropped] = useState(0);
  const [done, setDone] = useState(false);
  const [state, setState] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const streamKey = streams.join(",");

  useEffect(() => {
    let after = -1;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLines([]);
    setDropped(0);
    setDone(false);
    const url = (a: number) =>
      `/api/v1/jobs/${encodeURIComponent(props.jobId)}/attempts/${encodeURIComponent(props.attemptId)}/console${qs(
        {
          after: a,
          limit: 1000,
          stream: streamKey.split(",").length === STREAMS.length ? undefined : streamKey,
        },
      )}`;
    const tick = async () => {
      try {
        // Drain every available page, then poll.
        for (;;) {
          const r = await api<{
            lines: ConsoleLine[];
            next_after: number;
            done: boolean;
            state: string;
          }>(url(after));
          if (stop) return;
          after = r.next_after;
          setState(r.state);
          setError(undefined);
          if (r.lines.length) {
            setLines((prev) => {
              const next = prev.concat(r.lines);
              if (next.length > CONSOLE_KEEP) {
                setDropped((d) => d + next.length - CONSOLE_KEEP);
                return next.slice(next.length - CONSOLE_KEEP);
              }
              return next;
            });
          }
          if (r.done) {
            setDone(true);
            return;
          }
          if (r.lines.length < 1000) break;
        }
      } catch (e) {
        if (!stop) setError(e);
      }
      if (!stop) timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [props.jobId, props.attemptId, streamKey]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  });

  return (
    <div className="stack">
      <div className="row small">
        {STREAMS.map((s) => (
          <label key={s} className="row">
            <input
              type="checkbox"
              checked={streams.includes(s)}
              onChange={(e) =>
                setStreams((cur) =>
                  e.target.checked
                    ? STREAMS.filter((x) => x === s || cur.includes(x))
                    : cur.filter((x) => x !== s),
                )
              }
            />
            {s}
          </label>
        ))}
        <label className="row">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />{" "}
          follow
        </label>
        <span style={{ marginLeft: "auto" }}>
          {done ? (
            <Badge tone="ok">complete</Badge>
          ) : (
            <Badge tone="info">live{state ? ` · ${state}` : ""}</Badge>
          )}{" "}
          <span className="faint">{lines.length} lines</span>
        </span>
      </div>
      <ErrorBox error={error} />
      {dropped ? (
        <div className="banner warn small">
          {dropped} older lines are not shown (the browser keeps the last {CONSOLE_KEEP}). The
          coordinator keeps the full journal.
        </div>
      ) : null}
      <div className="console" ref={box} data-testid="console">
        {lines.length === 0 ? (
          <span className="faint">{done ? "No output." : "Waiting for output…"}</span>
        ) : null}
        {lines.map((l) => (
          <div key={l.seq} className={`l-${l.stream}`}>
            <span className="seq">{l.seq}</span>
            {l.stream === "log" && l.level ? `[${l.level}] ` : ""}
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
