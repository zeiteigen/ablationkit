/**
 * Project settings → Agent permissions (ADR 0037): what an agent may ask AblationKit to do in this
 * project, in plain language, edited inline. Saving shows the coordinator's diff as before → after
 * sentences first, then writes a new immutable policy revision with the researcher's session.
 */
import { type ReactNode, useEffect, useState } from "react";
import { api, useApi, useEvents } from "../api.ts";
import { fmtTime } from "../lib/format.ts";
import {
  describeChange,
  fmtWeightedHours,
  meterParts,
  type PolicyChange,
  type ProjectPolicy,
  revisionAuthor,
  revisionBody,
} from "../lib/policy.ts";
import type { ComputeTargetView } from "../lib/types.ts";
import { Badge, ErrorBox, Link, Loading, Modal, useAction } from "./ui.tsx";

export interface AgentUsage {
  project_id: string;
  name: string;
  limit_hours: number;
  used_hours: number;
  reserved_hours: number;
  available_hours: number;
  jobs: number;
  attempts: number;
  live: number;
  over_limit: boolean;
  /** Agents' jobs waiting for a slot (ADR 0068). */
  queued?: number;
  /** The pool: where AblationKit places agents' jobs, in the order it tries them. */
  targets?: { target_id: string; label: string; slots: number; busy: number; weight: number }[];
  refused?: { at: string; count: number; message: string };
}

/** Used and reserved weighted hours of a limit, as a bar and a caption. */
export function ComputeMeter(props: {
  used: number;
  reserved: number;
  limit: number;
  label?: string;
}) {
  const m = meterParts(props.used, props.reserved, props.limit);
  const caption = `${fmtWeightedHours(props.used)} used + ${fmtWeightedHours(props.reserved)} reserved of ${props.limit} weighted hours`;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div
        className={`meter${m.full ? " full" : ""}`}
        role="img"
        aria-label={`${props.label ?? "Agent compute"}: ${caption}`}
      >
        <span className="used" style={{ width: `${m.used}%` }} />
        <span className="reserved" style={{ width: `${m.reserved}%` }} />
      </div>
      <div className="faint small">{caption}</div>
    </div>
  );
}

function Choice(props: {
  label: string;
  value: "allow" | "deny";
  onChange: (v: "allow" | "deny") => void;
}) {
  return (
    <select
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as "allow" | "deny")}
    >
      <option value="allow">Allowed</option>
      <option value="deny">Denied</option>
    </select>
  );
}

function Row(props: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="perm-row">
      <div>
        <div>{props.title}</div>
        {props.hint ? <div className="faint small">{props.hint}</div> : null}
      </div>
      <div className="perm-control">{props.children}</div>
    </div>
  );
}

export function AgentPermissions(props: { pid: string }) {
  const base = `/api/v1/projects/${encodeURIComponent(props.pid)}`;
  const pol = useApi<{ policy: ProjectPolicy; revisions: number[] }>(`${base}/policy`);
  const usage = useApi<AgentUsage>(`${base}/compute`);
  const targets = useApi<{ targets: ComputeTargetView[] }>("/api/v1/targets");
  useEvents(
    () => {
      pol.reload();
      usage.reload();
    },
    { project: props.pid, types: ["policy.revised", "job.attempt.state"] },
  );
  const [draft, setDraft] = useState<ProjectPolicy | undefined>();
  const [review, setReview] = useState<
    { changes: PolicyChange[]; errors: string[]; valid: boolean } | undefined
  >();
  const current = pol.data?.policy;
  const p = draft ?? current;

  const edit = (f: (x: ProjectPolicy) => ProjectPolicy) => {
    if (p) setDraft(f(structuredClone(p)));
  };
  const preview = useAction(async () => {
    if (!draft) return;
    const r = await api<{ valid: boolean; errors: string[]; changes: PolicyChange[] }>(
      `${base}/policy/preview`,
      { body: { policy: revisionBody(draft) } },
    );
    setReview(r);
  });
  const save = useAction(async () => {
    if (!draft || !current) return;
    await api(`${base}/policy/revisions`, {
      body: { policy: revisionBody(draft), expect_revision: current.revision },
    });
    setReview(undefined);
    setDraft(undefined);
    pol.reload();
    usage.reload();
  });

  const targetIds = (targets.data?.targets ?? []).map((t) => t.target_id);
  const allowed = p?.jobs.submit_remote.allowed_targets ?? [];
  // Kinds (`slurm`) and targets since removed stay listed so a revision never drops them silently.
  const listed = [...targetIds, ...allowed.filter((t) => !targetIds.includes(t))];
  const u = usage.data;
  const loaded = p !== undefined;
  // Links from notifications and the inbox point here (`…/settings#agent-permissions`).
  useEffect(() => {
    if (loaded && location.hash === "#agent-permissions")
      document.getElementById("agent-permissions")?.scrollIntoView({ block: "start" });
  }, [loaded]);

  return (
    <section className="card" id="agent-permissions" data-testid="agent-permissions">
      <h2>Agent permissions</h2>
      <p className="muted small">
        What an agent working in this project may ask AblationKit to do. Git, files and the agent's
        sandbox belong to its harness. Repository files never change this.
      </p>
      <ErrorBox error={pol.error ?? usage.error} />
      {!p ? (
        <Loading />
      ) : (
        <>
          <div className="faint small" data-testid="policy-revision">
            Revision {p.revision} · set by {revisionAuthor(p.created_by)}
            {p.revision > 0 ? ` · ${fmtTime(p.created_at)}` : ""}
            {draft ? <Badge tone="warn">unsaved changes</Badge> : null}
          </div>
          <Row title="Run jobs on this workstation">
            <Choice
              label="Run jobs on this workstation"
              value={p.jobs.run_local.decision}
              onChange={(v) =>
                edit((x) => {
                  x.jobs.run_local.decision = v;
                  return x;
                })
              }
            />
          </Row>
          <Row
            title="Submit jobs to remote targets"
            hint={
              listed.length ? "Only the targets ticked here." : "No remote targets are configured."
            }
          >
            <Choice
              label="Submit jobs to remote targets"
              value={p.jobs.submit_remote.decision}
              onChange={(v) =>
                edit((x) => {
                  x.jobs.submit_remote.decision = v;
                  return x;
                })
              }
            />
            {listed.map((t) => (
              <label key={t} className="row small">
                <input
                  type="checkbox"
                  disabled={p.jobs.submit_remote.decision === "deny"}
                  checked={allowed.includes(t)}
                  onChange={(e) =>
                    edit((x) => {
                      const s = new Set(x.jobs.submit_remote.allowed_targets);
                      if (e.target.checked) s.add(t);
                      else s.delete(t);
                      x.jobs.submit_remote.allowed_targets = [...s];
                      return x;
                    })
                  }
                />
                {t}
              </label>
            ))}
          </Row>
          <p className="faint small" data-testid="agent-pool">
            Together these are the project's pool. Agents never choose where a job runs: AblationKit
            queues it and starts it on the first target here with a free slot, this workstation
            first (slots are set on the Compute page).{" "}
            {usage.data?.targets?.length
              ? `Pool now: ${usage.data.targets
                  .map(
                    (t) =>
                      `${t.target_id === "local" ? "this workstation" : t.label} (${t.busy}/${t.slots} ${t.slots === 1 ? "slot" : "slots"} busy)`,
                  )
                  .join(", then ")}${usage.data.queued ? `; ${usage.data.queued} queued` : ""}.`
              : "The pool is empty: agents' jobs are refused."}
          </p>
          <Row title="Start local previews" hint="An inference session on this workstation only.">
            <Choice
              label="Start local previews"
              value={p.deployments.preview_local.decision}
              onChange={(v) =>
                edit((x) => {
                  x.deployments.preview_local.decision = v;
                  return x;
                })
              }
            />
          </Row>
          <Row
            title="Start remote research endpoints"
            hint="A Runpod pod serving a pinned model, with a TTL."
          >
            <Choice
              label="Start remote research endpoints"
              value={p.deployments.remote_research.decision}
              onChange={(v) =>
                edit((x) => {
                  x.deployments.remote_research.decision = v;
                  return x;
                })
              }
            />
          </Row>
          <Row
            title="Persistent deployments and public endpoints"
            hint="AblationKit never starts these for an agent."
          >
            <Badge>off</Badge>
          </Row>
          <Row
            title="Compute limit"
            hint="Weighted hours of agent-submitted jobs, never reset. Each job needs a time limit and is refused if it would not fit."
          >
            <label className="row small">
              <input
                type="number"
                min={0}
                step={1}
                aria-label="Compute limit in weighted hours"
                style={{ width: 90 }}
                value={p.compute.limit_hours}
                onChange={(e) => {
                  const n = Math.max(0, Math.floor(Number(e.target.value)));
                  if (Number.isFinite(n))
                    edit((x) => {
                      x.compute.limit_hours = n;
                      return x;
                    });
                }}
              />
              weighted hours
            </label>
          </Row>
          {u ? (
            <div data-testid="agent-usage" style={{ margin: "4px 0 10px" }}>
              <ComputeMeter
                used={u.used_hours}
                reserved={u.reserved_hours}
                limit={p.compute.limit_hours}
              />
              <div className="faint small">
                {u.jobs} agent job{u.jobs === 1 ? "" : "s"}, {u.live} running. An hour on a target
                counts as its weight: set weights on <Link to="/compute">Compute</Link>.
              </div>
              {u.refused ? (
                <div className="banner warn small" style={{ marginTop: 6 }}>
                  {u.refused.message}
                  {u.refused.count > 1 ? ` (${u.refused.count} jobs refused)` : ""}
                </div>
              ) : null}
            </div>
          ) : null}
          <ErrorBox error={preview.error ?? save.error} />
          <div className="row end">
            <button
              type="button"
              disabled={!draft || preview.busy}
              onClick={() => {
                setDraft(undefined);
                preview.clear();
              }}
            >
              Discard
            </button>
            <button
              type="button"
              className="primary"
              disabled={!draft || preview.busy}
              onClick={() => void preview.run()}
            >
              Review changes…
            </button>
          </div>
        </>
      )}
      {review && current ? (
        <Modal
          title="Save agent permissions"
          onClose={() => setReview(undefined)}
          footer={
            <>
              <button type="button" onClick={() => setReview(undefined)}>
                Keep editing
              </button>
              <button
                type="button"
                className="primary"
                disabled={!review.valid || review.changes.length === 0 || save.busy}
                onClick={() => void save.run()}
              >
                Save as revision {current.revision + 1}
              </button>
            </>
          }
        >
          <ErrorBox error={save.error} />
          {review.errors.map((e) => (
            <div key={e} className="banner err small">
              {e}
            </div>
          ))}
          {review.changes.length === 0 ? (
            <p className="muted small">Nothing changes.</p>
          ) : (
            <ul className="stack" data-testid="policy-changes" style={{ gap: 6 }}>
              {review.changes.map((c) => {
                const t = describeChange(c);
                return (
                  <li key={c.path}>
                    <strong>{t.label}</strong>: {t.from} → {t.to}{" "}
                    <Badge
                      tone={
                        c.effect === "widened" ? "warn" : c.effect === "reduced" ? "ok" : "info"
                      }
                    >
                      {t.effect}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="faint small">
            Revision {current.revision} stays on record; agents see the new one at once.
          </p>
        </Modal>
      ) : null}
    </section>
  );
}
