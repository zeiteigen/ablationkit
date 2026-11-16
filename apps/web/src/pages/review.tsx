/**
 * Review (ADR 0048): the project's reading list. One thread per task, newest first, then records
 * outside any task; inside a thread the task (the question and its answer), then reports,
 * hypotheses, studies, decisions, approaches and notes. The list ends when nothing is left
 * unreviewed.
 */
import { useState } from "react";
import { Markdown, plainExcerpt } from "../components/Markdown.tsx";
import {
  GapBadges,
  markReviewed,
  ResearchMap,
  ReviewBadge,
  useReviewList,
} from "../components/Review.tsx";
import { Badge, Empty, ErrorBox, Link, Loading, useAction } from "../components/ui.tsx";
import { fmtTime } from "../lib/format.ts";
import { type ReviewItem, type ReviewThread, refHref, statusTone } from "../lib/research.ts";
import { setQuery, useLocation } from "../router.ts";

const taskStatus = (t: NonNullable<ReviewThread["task"]>) =>
  t.status === "completed" && t.outcome ? t.outcome.replace("_", " ") : (t.status ?? "");

export function ReviewPage(props: { pid: string; base: string }) {
  const { query } = useLocation();
  const all = query.get("show") === "all";
  const list = useReviewList(props.pid);
  const mark = useAction(async (items: readonly ReviewItem[]) => {
    for (const i of items) await markReviewed(props.pid, i, true);
    list.reload();
  });
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const c = list.data.counts;
  const left = c.new + c.changed;
  const threads = list.data.threads
    .map((t) => ({
      thread: t,
      shown: all ? t.items : t.items.filter((i) => i.review !== "reviewed"),
      taskShown: Boolean(t.task && (all || t.task.review !== "reviewed")),
    }))
    .filter((t) => t.shown.length || t.taskShown);
  return (
    <div className="stack">
      <section className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Review</h2>
          <span className="muted" data-testid="review-progress">
            {c.total === 0
              ? "Nothing recorded yet."
              : left === 0
                ? `All ${c.total} reviewed.`
                : `${left} of ${c.total} left to review${c.changed ? ` (${c.changed} changed since you read them)` : ""}.`}
          </span>
          <span className="row" style={{ marginLeft: "auto" }}>
            <button
              type="button"
              className={all ? "small" : "small on"}
              onClick={() => setQuery({ show: undefined })}
            >
              To review
            </button>
            <button
              type="button"
              className={all ? "small on" : "small"}
              onClick={() => setQuery({ show: "all" })}
            >
              Everything
            </button>
          </span>
        </div>
        {c.total ? (
          <div className="meter" style={{ margin: "12px 0 4px" }}>
            <div className="used" style={{ width: `${(100 * c.reviewed) / c.total}%` }} />
          </div>
        ) : null}
        <p className="small muted" style={{ margin: "8px 0 0" }}>
          Everything agents and you recorded, in reading order: per task, the question and its
          answer first, then the reports, hypotheses, studies, decisions, approaches and notes
          behind it. Read an item on its page or from its summary here and mark it reviewed; an item
          whose text, status or evidence changes comes back as changed. A mark records that you read
          it. It approves nothing.
          {c.gaps ? ` ${c.gaps} item(s) have no description yet.` : ""}
        </p>
        <details className="small" style={{ marginTop: 8 }}>
          <summary>How the pieces fit together</summary>
          <ResearchMap base={props.base} />
        </details>
      </section>
      <ErrorBox error={mark.error} />
      {threads.length === 0 ? (
        <Empty>
          {c.total === 0
            ? "No tasks or research records yet."
            : "Everything is reviewed. New and changed records will appear here."}
        </Empty>
      ) : null}
      {threads.map(({ thread, shown, taskShown }) => {
        const t = thread.task;
        const pending = [
          ...(t && t.review !== "reviewed" ? [t] : []),
          ...thread.items.filter((i) => i.review !== "reviewed"),
        ];
        return (
          <section key={t?.id ?? "loose"} className="card thread" data-testid="review-thread">
            <div className="row">
              <span className="eyebrow" style={{ margin: 0 }}>
                {t ? "Task" : "Not under a task"}
              </span>
              {t ? <Badge tone={statusTone(t.outcome ?? t.status)}>{taskStatus(t)}</Badge> : null}
              {t ? <span className="faint small">{fmtTime(t.updated_at)}</span> : null}
              <span className="row" style={{ marginLeft: "auto" }}>
                {t ? <ReviewBadge state={t.review} /> : null}
                {pending.length > 1 ? (
                  <button
                    type="button"
                    className="small"
                    disabled={mark.busy}
                    onClick={() => void mark.run(pending)}
                    title="Mark the task and every record under it as reviewed"
                  >
                    Mark all {pending.length} reviewed
                  </button>
                ) : null}
              </span>
            </div>
            {t ? (
              <>
                <h2 style={{ margin: "6px 0" }}>
                  <Link to={`${props.base}/tasks/${encodeURIComponent(t.id)}`}>{t.title}</Link>
                </h2>
                {taskShown ? (
                  t.conclusion ? (
                    <Markdown text={t.conclusion} base={props.base} />
                  ) : (
                    <p className="muted">{plainExcerpt(t.goal, 400)}</p>
                  )
                ) : null}
                {t.note ? <p className="small reviewnote">Your note: {t.note}</p> : null}
                {taskShown && t.review !== "reviewed" ? (
                  <div className="row">
                    <GapBadges gaps={t.gaps} />
                    <button
                      type="button"
                      className="small"
                      disabled={mark.busy}
                      onClick={() => void mark.run([t])}
                    >
                      Mark task reviewed
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="muted small" style={{ margin: "6px 0" }}>
                Records that no task links: written by you, or by an agent outside a task.
              </p>
            )}
            {shown.length ? (
              <div className="ritems">
                {shown.map((i) => (
                  <Row
                    key={`${i.kind}:${i.id}`}
                    item={i}
                    base={props.base}
                    busy={mark.busy}
                    onMark={() => void mark.run([i])}
                  />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function Row(props: { item: ReviewItem; base: string; busy: boolean; onMark: () => void }) {
  const i = props.item;
  const [open, setOpen] = useState(false);
  const text = plainExcerpt(i.summary, 280);
  return (
    <div className={`ritem ${i.review}`} data-testid="review-item">
      <div className="row">
        <Badge>{i.kind}</Badge>
        {i.status ? <Badge tone={statusTone(i.status)}>{i.status}</Badge> : null}
        <Link to={refHref(props.base, i) ?? props.base} className="rtitle">
          {i.title}
        </Link>
        <span className="row" style={{ marginLeft: "auto" }}>
          <GapBadges gaps={i.gaps} />
          <ReviewBadge state={i.review} />
          {i.review !== "reviewed" ? (
            <button type="button" className="small" disabled={props.busy} onClick={props.onMark}>
              Mark reviewed
            </button>
          ) : null}
        </span>
      </div>
      {i.summary ? (
        open ? (
          <Markdown text={i.summary} base={props.base} />
        ) : (
          <p className="muted rsum">
            {text}{" "}
            {i.summary.length > text.length || /[$|#*`]/.test(i.summary) ? (
              <button type="button" className="link small" onClick={() => setOpen(true)}>
                more
              </button>
            ) : null}
          </p>
        )
      ) : null}
      {i.note ? <p className="small reviewnote">Your note: {i.note}</p> : null}
    </div>
  );
}
