/**
 * The lineage strip (spec §2.2 persistent elements, §6): the provenance chain of the current
 * object with explicit gaps. "missing" means nothing links there yet; "not recorded yet" means a
 * later build stage records that step. Nothing is inferred beyond what the coordinator knows.
 */
import { useApi, useEvents } from "../api.ts";
import { refHref } from "../lib/research.ts";
import { Link } from "./ui.tsx";

interface Step {
  step: string;
  label: string;
  status: "linked" | "missing" | "unavailable" | "subject";
  reason?: string;
  more: number;
  items: { ref: { kind: string; id: string }; label: string; status?: string; exists: boolean }[];
}
export interface LineageResp {
  steps: Step[];
  backlinks: { ref: { kind: string; id: string }; label: string; status?: string }[];
}

export function LineageStrip(props: { pid: string; kind: string; id: string; base: string }) {
  const l = useApi<LineageResp>(
    `/api/v1/projects/${encodeURIComponent(props.pid)}/lineage?kind=${encodeURIComponent(props.kind)}&id=${encodeURIComponent(props.id)}`,
  );
  useEvents(() => l.reload(), {
    project: props.pid,
    types: [
      "research.created",
      "research.updated",
      "research.deleted",
      "job.attempt.state",
      "tracking.run.sync",
    ],
  });
  if (l.error)
    return (
      <div className="lineage faint small" data-testid="lineage-strip">
        Lineage unavailable: {l.error.message}
      </div>
    );
  if (!l.data) return <div className="lineage faint small">Lineage…</div>;
  return (
    <nav className="lineage" data-testid="lineage-strip" aria-label="Lineage">
      <ol>
        {l.data.steps.map((s) => (
          <li
            key={s.step}
            className={`lstep ${s.status}`}
            data-step={s.step}
            data-status={s.status}
          >
            <span className="lname">{s.label}</span>
            {s.items.length ? (
              <span className="litems">
                {s.items.slice(0, 3).map((i) => {
                  const href = i.exists ? refHref(props.base, i.ref) : undefined;
                  const text = `${i.label}${i.status ? ` · ${i.status}` : ""}`;
                  return href && s.status !== "subject" ? (
                    <Link key={i.ref.id} to={href} title={`${i.ref.kind}:${i.ref.id}`}>
                      {text}
                    </Link>
                  ) : (
                    <span
                      key={i.ref.id}
                      className={i.exists ? "" : "dangling"}
                      title={`${i.ref.kind}:${i.ref.id}${i.exists ? "" : " (no longer exists)"}`}
                    >
                      {text}
                    </span>
                  );
                })}
                {s.items.length + s.more > 3 ? (
                  <span className="faint">+{s.items.length + s.more - 3}</span>
                ) : null}
              </span>
            ) : (
              <span className="lgap" title={s.reason}>
                {s.status === "unavailable" ? "not recorded yet" : "missing"}
              </span>
            )}
          </li>
        ))}
      </ol>
      {l.data.backlinks.length ? (
        <div className="small lback">
          Cited by{" "}
          {l.data.backlinks.map((b, i) => {
            const href = refHref(props.base, b.ref);
            return (
              <span key={b.ref.id}>
                {i ? ", " : ""}
                {href ? <Link to={href}>{b.label}</Link> : b.label}{" "}
                <span className="faint">({b.ref.kind})</span>
              </span>
            );
          })}
        </div>
      ) : null}
    </nav>
  );
}
