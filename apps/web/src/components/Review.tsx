/**
 * Review (ADR 0048): the researcher marks a record or task as read, optionally with a note, and
 * moves to the next item of the project's reading list. A mark records reading; it approves
 * nothing and no gate reads it. Agents can read the notes.
 */
import { useState } from "react";
import { api, useApi, useEvents } from "../api.ts";
import { fmtTime } from "../lib/format.ts";
import {
  RESEARCH_MAP,
  type ReviewInfo,
  type ReviewList,
  type ReviewStatus,
  refHref,
} from "../lib/research.ts";
import { navigate } from "../router.ts";
import { Badge, ErrorBox, Link, useAction } from "./ui.tsx";

const REVIEW_EVENTS = [
  "review.updated",
  "research.created",
  "research.updated",
  "research.archived",
  "research.restored",
  "research.deleted",
  "task.created",
  "task.updated",
];

const reviewPath = (pid: string) => `/api/v1/projects/${encodeURIComponent(pid)}/review`;

export function useReviewList(pid: string | undefined) {
  const list = useApi<ReviewList>(pid ? reviewPath(pid) : undefined);
  useEvents(() => list.reload(), { project: pid ?? "", types: REVIEW_EVENTS });
  return list;
}

export async function markReviewed(
  pid: string,
  ref: { kind: string; id: string },
  reviewed: boolean,
  note?: string,
): Promise<void> {
  await api(reviewPath(pid), {
    body: { kind: ref.kind, id: ref.id, reviewed, ...(note?.trim() ? { note: note.trim() } : {}) },
  });
}

export function ReviewBadge(props: { state: ReviewStatus }) {
  if (props.state === "reviewed") return <Badge tone="ok">reviewed</Badge>;
  if (props.state === "changed")
    return (
      <Badge tone="warn" title="Its text, status or evidence changed after you reviewed it">
        changed
      </Badge>
    );
  return <Badge tone="info">new</Badge>;
}

const GAP_TEXT: Record<string, [string, string]> = {
  summary: ["no summary", "Nobody wrote the short description of this yet"],
  body: ["no write-up", "It has a summary at most: the in-depth read is missing"],
};

export function GapBadges(props: { gaps: readonly string[] }) {
  return (
    <>
      {props.gaps.map((g) => (
        <Badge key={g} tone="warn" title={GAP_TEXT[g]?.[1]}>
          {GAP_TEXT[g]?.[0] ?? g}
        </Badge>
      ))}
    </>
  );
}

/**
 * The strip at the top of a record, study or task page: whether it was reviewed, a button to mark
 * it, the researcher's note, and the next item left to read.
 */
export function ReviewBar(props: {
  pid: string;
  base: string;
  kind: string;
  id: string;
  review: ReviewInfo | undefined;
  onChanged: () => void;
}) {
  const list = useReviewList(props.pid);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState(props.review?.note ?? "");
  const queue = (list.data?.queue ?? []).filter(
    (q) => !(q.kind === props.kind && q.id === props.id),
  );
  const next = queue[0];
  const nextHref = next ? refHref(props.base, next) : undefined;
  const mark = useAction(async (reviewed: boolean, go: boolean) => {
    await markReviewed(props.pid, props, reviewed, noting || note ? note : undefined);
    setNoting(false);
    props.onChanged();
    list.reload();
    if (go && nextHref) navigate(nextHref);
  });
  const st = props.review?.state ?? "new";
  return (
    <div className={`reviewbar ${st}`} data-testid="review-bar">
      <div className="row">
        <ReviewBadge state={st} />
        <span className="small muted">
          {st === "reviewed"
            ? `You reviewed this ${fmtTime(props.review?.reviewed_at)}.`
            : st === "changed"
              ? `Changed since you reviewed it ${fmtTime(props.review?.reviewed_at)}.`
              : "You have not reviewed this yet."}
        </span>
        <span className="row" style={{ marginLeft: "auto" }}>
          <button type="button" className="small" onClick={() => setNoting((n) => !n)}>
            {props.review?.note ? "Edit note" : "Add a note"}
          </button>
          {st === "reviewed" ? (
            <button
              type="button"
              className="small"
              disabled={mark.busy}
              onClick={() => void mark.run(false, false)}
            >
              Mark unread
            </button>
          ) : (
            <button
              type="button"
              className="small"
              disabled={mark.busy}
              onClick={() => void mark.run(true, false)}
            >
              Mark reviewed
            </button>
          )}
          {next && nextHref ? (
            st === "reviewed" ? (
              <Link to={nextHref} className="btn small">
                Next to review ({queue.length}) →
              </Link>
            ) : (
              <button
                type="button"
                className="small primary"
                disabled={mark.busy}
                onClick={() => void mark.run(true, true)}
                title={`${queue.length} more to review`}
              >
                Reviewed, next ({queue.length}) →
              </button>
            )
          ) : (
            <Link to={`${props.base}/review`} className="small">
              reading list
            </Link>
          )}
        </span>
      </div>
      {props.review?.note && !noting ? (
        <p className="small reviewnote">
          <span className="faint">Your note: </span>
          {props.review.note}
        </p>
      ) : null}
      {noting ? (
        <div className="stack tight">
          <textarea
            rows={2}
            style={{ width: "100%" }}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Review note"
            placeholder="A note on this for yourself and for the agent that picks the work back up: a doubt, a correction, what to run next."
          />
          <div className="row end">
            <button type="button" className="small" onClick={() => setNoting(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="small primary"
              disabled={mark.busy}
              onClick={() => void mark.run(true, false)}
            >
              Save note and mark reviewed
            </button>
          </div>
        </div>
      ) : null}
      <ErrorBox error={mark.error} />
    </div>
  );
}

/** Task → hypothesis → study → run → report → decision, each with what it is for. */
export function ResearchMap(props: { base: string }) {
  return (
    <ol className="rmap" aria-label="How the research is organised">
      {RESEARCH_MAP.map((k) => (
        <li key={k.id}>
          <Link to={`${props.base}${k.path}`}>{k.label}</Link>
          <span className="small muted">{k.role}</span>
        </li>
      ))}
    </ol>
  );
}
