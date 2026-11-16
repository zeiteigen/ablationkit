/**
 * The witness (ADR 0056), where the researcher reads: a number in a note's prose drawn live from
 * the run it came from (`[[run:<run>#<metric>]]`), the runs behind a finding or claim with the
 * ones it leaves out (set aside, cited elsewhere, or unaccounted for), and an agent session's
 * account, the coordinator's record of the session beside what the agent wrote.
 *
 * The values and the record come from the coordinator and MLflow; the set-aside reasons, the
 * notes and their standings are the agent's account. Everything here is shown, not enforced.
 */
import "../styles/witness.css";
import type { VaultNote } from "@ablationkit/protocol";
import { parseRunRef, runsNamedBy } from "@ablationkit/vault";
import { type ReactNode, useState } from "react";
import { useApi } from "../api.ts";
import { fmtDuration } from "../lib/format.ts";
import { fmtValue, plural } from "../lib/vault.ts";
import { type AccountedRun, useSlot } from "../lib/vault-store.ts";
import { useVaultUi } from "./Note.tsx";
import { Badge, ErrorBox, Link, Loading } from "./ui.tsx";

const enc = encodeURIComponent;
const exact = (v: number) => String(Number(v.toPrecision(12)));

// ---------------------------------------------------------------- a number, live

/**
 * `[[run:a#loss]]`: run a's latest loss; `[[run:a#loss vs b]]`: how far a's loss is from b's,
 * shown as its size (the sentence says which way), the signed difference on hover.
 */
export function RunRefValue(props: { inner: string }) {
  const ui = useVaultUi();
  const { store } = ui;
  const slot = useSlot(
    store,
    () => store.runsSlot(),
    () => store.loadRuns(),
    "runs",
  );
  const ref = parseRunRef(props.inner);
  if (!ref) return <span className="v-rr v-rr-bad">[[{props.inner}]]</span>;
  const a = store.runValue(ref.run, ref.metric);
  const b = ref.vs ? store.runValue(ref.vs, ref.metric) : undefined;
  const loading = slot.state === "idle" || slot.state === "loading";
  const off = slot.state === "error" || (slot.state === "done" && !slot.data?.available);
  const what = ref.vs ? `${ref.run} − ${ref.vs}, ${ref.metric}` : `${ref.run}, ${ref.metric}`;
  let shown: string;
  let title: string;
  let bad = false;
  if (loading) {
    shown = "…";
    title = what;
  } else if (off) {
    shown = "?";
    title = `${what}: MLflow is unavailable, so the value cannot be read`;
    bad = true;
  } else if (!a?.runId || (ref.vs && !b?.runId)) {
    shown = "?";
    title = `${what}: no run ${!a?.runId ? ref.run : ref.vs} in this project`;
    bad = true;
  } else if (a.value === undefined || (ref.vs && b?.value === undefined)) {
    shown = "?";
    title = `${what}: the run has no metric ${ref.metric}`;
    bad = true;
  } else if (ref.vs && b?.value !== undefined) {
    const d = a.value - b.value;
    shown = fmtValue(Math.abs(d), Math.abs(d));
    title = `${ref.metric}: ${ref.run} ${exact(a.value)} − ${ref.vs} ${exact(b.value)} = ${exact(d)}`;
  } else {
    shown = fmtValue(a.value);
    title = `${ref.metric} of ${ref.run}: ${exact(a.value)} (latest)`;
  }
  const cls = `v-rr${bad ? " v-rr-bad" : ""}`;
  return a?.runId ? (
    <Link className={cls} to={`${ui.base}/runs/r/${enc(a.runId)}`} title={title}>
      {shown}
    </Link>
  ) : (
    <span className={cls} title={title} data-run-ref="">
      {shown}
    </span>
  );
}

// ---------------------------------------------------------------- the runs behind a note

const STANDING_WORD: Record<AccountedRun["standing"], string> = {
  cited: "cited elsewhere",
  set_aside: "set aside",
  unaccounted: "unaccounted for",
};

/**
 * The runs a finding or claim rests on, and the runs of the same tasks and studies it leaves out,
 * each with how it is accounted for: so selective reporting shows where the researcher reads.
 */
export function RunsBehind(props: { n: VaultNote }) {
  const ui = useVaultUi();
  const { store } = ui;
  const slot = useSlot(
    store,
    () => store.drawerSlot(),
    () => store.loadDrawer(),
    "drawer",
  );
  const [open, setOpen] = useState(false);
  const n = props.n;
  if (!["claim", "finding", "experiment"].includes(n.type)) return null;
  const runs = slot.data;
  if (!runs) return null;
  // What it names, itself and through the notes it embeds.
  const named = new Set<string>();
  for (const id of ui.vault.under(n.note_id)) {
    const x = ui.vault.get(id);
    if (x) for (const r of runsNamedBy(x)) named.add(r);
  }
  const names = (r: AccountedRun) =>
    Boolean((r.name && named.has(r.name)) || (r.id && named.has(r.id)));
  const mine = runs.filter(names);
  const tasks = new Set(mine.flatMap((r) => (r.task_id ? [r.task_id] : [])));
  const studies = new Set(mine.flatMap((r) => (r.study_id ? [r.study_id] : [])));
  if (n.study) studies.add(n.study);
  if (n.task_id) tasks.add(n.task_id);
  const left = runs.filter(
    (r) =>
      r.ended &&
      r.id &&
      !names(r) &&
      ((r.task_id && tasks.has(r.task_id)) || (r.study_id && studies.has(r.study_id))),
  );
  if (!left.length) return null;
  const count = (s: AccountedRun["standing"]) => left.filter((r) => r.standing === s).length;
  const scope = [
    tasks.size ? plural(tasks.size, "task", "tasks") : "",
    studies.size ? plural(studies.size, "study", "studies") : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const parts = (["set_aside", "cited", "unaccounted"] as const)
    .filter((s) => count(s))
    .map((s) => `${count(s)} ${STANDING_WORD[s]}`);
  return (
    <section className="v-behind" data-testid="runs-behind">
      <button
        type="button"
        className="v-behind-h"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="v-rests-h">The runs it leaves out</span>{" "}
        <span>
          {mine.length} of the {mine.length + left.length} runs of its {scope} are named here;{" "}
          {plural(left.length, "other", "others")}: {parts.join(", ")}
        </span>
        {count("unaccounted") ? (
          <Badge tone="warn">{count("unaccounted")} unaccounted</Badge>
        ) : null}
      </button>
      {open ? (
        <table className="v-ev v-behind-t">
          <tbody>
            {left.map((r) => (
              <tr key={`${r.id}:${r.job_id ?? ""}`} className={`acc-${r.standing}`}>
                <td className="v-ev-run">
                  <Link to={`${ui.base}/runs/r/${enc(r.id ?? "")}`} title="Open the run">
                    {r.name ?? r.id}
                  </Link>
                  <div className="v-ev-note">{r.state ?? ""}</div>
                </td>
                <td className="v-ev-role">{STANDING_WORD[r.standing]}</td>
                <td>
                  {r.standing === "set_aside" && r.set_aside ? (
                    <span title="The agent's reason">{r.set_aside.reason}</span>
                  ) : r.standing === "cited" ? (
                    <span>
                      by{" "}
                      {r.cited_by.map((id, i) => (
                        <span key={id}>
                          {i ? ", " : ""}
                          <a
                            href={ui.links.href(id)}
                            onClick={(e) => {
                              e.preventDefault();
                              ui.openSheet(id);
                            }}
                          >
                            {ui.vault.get(id)?.title ?? id}
                          </a>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="faint">No note cites it and the agent gave no reason.</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- a task's file drawer

/** One run of a task, as the task read returns it (ADR 0056). */
export interface TaskRun {
  name?: string;
  mlflow_run_id?: string;
  job_id?: string;
  state?: string;
  standing: "cited" | "set_aside" | "unaccounted" | "running";
  cited_by: string[];
  set_aside?: string;
}

const TASK_WORD: Record<TaskRun["standing"], string> = {
  cited: "cited",
  set_aside: "set aside",
  unaccounted: "unaccounted for",
  running: "running",
};

/** Every run a task's jobs produced: cited by a note, set aside with the agent's reason, or neither. */
export function TaskDrawer(props: { runs: TaskRun[]; base: string }) {
  const n = (s: TaskRun["standing"]) => props.runs.filter((r) => r.standing === s).length;
  return (
    <section className="card" data-testid="task-drawer">
      <h2>
        Every run accounted for{" "}
        {n("unaccounted") ? <Badge tone="warn">{n("unaccounted")} unaccounted</Badge> : null}
      </h2>
      <p className="muted small">
        The coordinator recorded these runs for the task's jobs; whether each is cited, and why one
        was set aside, is the agent's account. {n("cited")} cited · {n("set_aside")} set aside ·{" "}
        {n("unaccounted")} unaccounted for.
      </p>
      <div className="table-wrap">
        <table>
          <tbody>
            {props.runs.map((r) => (
              <tr key={`${r.mlflow_run_id ?? r.name}:${r.job_id ?? ""}`}>
                <td>
                  {r.mlflow_run_id ? (
                    <Link to={`${props.base}/runs/r/${enc(r.mlflow_run_id)}`}>
                      {r.name ?? r.mlflow_run_id}
                    </Link>
                  ) : (
                    (r.name ?? "pending")
                  )}{" "}
                  <span className="faint small">{r.state ?? ""}</span>
                </td>
                <td>
                  <Badge
                    tone={
                      r.standing === "unaccounted"
                        ? "warn"
                        : r.standing === "cited"
                          ? "ok"
                          : "neutral"
                    }
                  >
                    {TASK_WORD[r.standing]}
                  </Badge>
                </td>
                <td className="small">
                  {r.standing === "set_aside" ? (
                    r.set_aside
                  ) : r.cited_by.length ? (
                    <>
                      by{" "}
                      {r.cited_by.map((id, i) => (
                        <span key={id}>
                          {i ? ", " : ""}
                          <Link to={`${props.base}/notebooks/n/${enc(id)}`}>{id}</Link>
                        </span>
                      ))}
                    </>
                  ) : r.standing === "unaccounted" ? (
                    <span className="faint">No note cites it and the agent gave no reason.</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- a session's account

export interface SessionAccountView {
  token_id: string;
  project_id: string;
  label?: string;
  harness?: string;
  started_at: string;
  ended_at?: string;
  live: boolean;
  duration_sec: number;
  record: {
    jobs: number;
    attempts: number;
    outcomes: Record<string, number>;
    hit_time_limit: { job_id: string; run_name?: string }[];
    weighted_hours: number;
    tasks: { task_id: string; title: string; status: string }[];
  };
  account: {
    runs: { cited: number; set_aside: number; unaccounted: number };
    unaccounted: string[];
    set_aside: { run: string; reason: string }[];
    notes_added: string[];
    notes_revised: string[];
    standings: { note_id: string; title?: string; from?: string; to?: string }[];
    edition?: string;
  };
  checks: { code: string; ref: string; message: string }[];
  /** When the session ran in an agent container (ADR 0061). */
  container?: {
    session_id: string;
    state: string;
    harness: string;
    harness_version?: string;
    image: string;
    image_id?: string;
    boundary: { egress: string; hidden: string[]; read_only: string[] };
    paused: number;
    egress: {
      connections: number;
      allowed: { host: string; count: number }[];
      denied: { host: string; count: number }[];
    };
    files_changed?: { path: string; status: string }[];
    packages_changed?: { added: unknown[]; removed: unknown[]; changed: unknown[] };
    commands: { count: number; recent: string[] };
    works: { work_id: string; title: string; host: string; reached: boolean }[];
  };
}

const word = (s: string | undefined) => (s ? s.replace("_", " ") : "none");

function Row(props: { k: string; children: ReactNode }) {
  return (
    <>
      <dt>{props.k}</dt>
      <dd>{props.children}</dd>
    </>
  );
}

/**
 * One session's account: on the left what the coordinator recorded on its own, on the right what
 * the agent wrote, measured against it. `compact` is the block on the session's edition notebook.
 */
export function SessionAccount(props: { tokenId: string; base?: string; compact?: boolean }) {
  const res = useApi<SessionAccountView>(`/api/v1/agent-sessions/${enc(props.tokenId)}/account`);
  if (res.error) return <ErrorBox error={res.error} />;
  const a = res.data;
  if (!a) return <Loading />;
  const base = props.base ?? `/p/${enc(a.project_id)}`;
  const outcomes = Object.entries(a.record.outcomes)
    .map(([k, v]) => `${v} ${word(k)}`)
    .join(", ");
  const r = a.account.runs;
  const runsLine = `${r.cited} cited · ${r.set_aside} set aside · ${r.unaccounted} unaccounted for`;
  const noteLink = (id: string) => (
    <Link key={id} to={`${base}/notebooks/n/${enc(id)}`}>
      {id}
    </Link>
  );
  const joined = (xs: ReactNode[]) => xs.flatMap((x, i) => (i ? [", ", x] : [x]));
  if (props.compact)
    return (
      <aside className="w-account w-compact" data-testid="session-account">
        <div className="v-rests-h">The session's account</div>
        <p className="small">
          <b>Recorded:</b> {fmtDuration(a.duration_sec * 1000)} ·{" "}
          {plural(a.record.jobs, "job", "jobs")}
          {outcomes ? ` (${outcomes})` : ""} · {a.record.weighted_hours} weighted h
          {a.record.hit_time_limit.length
            ? ` · ${a.record.hit_time_limit.length} hit the time limit`
            : ""}
          . <b>Its runs:</b> {runsLine}. <b>Notes:</b> {a.account.notes_added.length} added,{" "}
          {a.account.notes_revised.length} revised
          {a.account.standings.length
            ? `; ${a.account.standings.map((s) => `${s.title ?? s.note_id}: ${word(s.from)} → ${word(s.to)}`).join("; ")}`
            : ""}
          .{" "}
          {a.checks.length ? (
            <Badge tone="warn">{plural(a.checks.length, "check", "checks")} outstanding</Badge>
          ) : null}
        </p>
      </aside>
    );
  return (
    <div className="w-account" data-testid="session-account">
      <div className="w-cols">
        <section>
          <h3>What the coordinator recorded</h3>
          <p className="small faint">
            Known independently of the agent: its token, jobs, attempts, runs and times.
          </p>
          <dl className="w-dl">
            <Row k="Duration">
              {fmtDuration(a.duration_sec * 1000)}
              {a.live ? " (live)" : ""}
            </Row>
            <Row k="Jobs">
              {a.record.jobs} ({a.record.attempts} attempts){outcomes ? `: ${outcomes}` : ""}
            </Row>
            <Row k="Hit the time limit">
              {a.record.hit_time_limit.length
                ? a.record.hit_time_limit.map((j) => j.run_name ?? j.job_id).join(", ")
                : "none"}
            </Row>
            <Row k="Weighted hours">{a.record.weighted_hours}</Row>
            {a.container ? (
              <>
                <Row k="Container">
                  {a.container.harness} in <span className="mono">{a.container.image}</span>,{" "}
                  {a.container.state}
                  {a.container.paused ? `, paused ${a.container.paused}×` : ""}; no GPU, egress{" "}
                  {a.container.boundary.egress}, {a.container.boundary.hidden.length} hidden
                </Row>
                <Row k="Egress">
                  {a.container.egress.connections} connections to{" "}
                  {a.container.egress.allowed.length} hosts
                  {a.container.egress.denied.length
                    ? `; refused: ${a.container.egress.denied.map((d) => d.host).join(", ")}`
                    : ""}
                </Row>
                <Row k="Changed">
                  {a.container.files_changed
                    ? `${a.container.files_changed.length} files`
                    : "recorded when it ends"}
                  {a.container.packages_changed
                    ? `; packages +${a.container.packages_changed.added.length} −${a.container.packages_changed.removed.length} ~${a.container.packages_changed.changed.length}`
                    : ""}
                </Row>
              </>
            ) : null}
            <Row k="Tasks">
              {a.record.tasks.length
                ? joined(
                    a.record.tasks.map((t) => (
                      <Link key={t.task_id} to={`${base}/tasks/${enc(t.task_id)}`}>
                        {t.title}
                      </Link>
                    )),
                  )
                : "none"}
            </Row>
          </dl>
        </section>
        <section>
          <h3>What it wrote, against that record</h3>
          <p className="small faint">
            The agent's account: its notes, standings and set-aside reasons are its own words.
          </p>
          <dl className="w-dl">
            <Row k="Its runs">{runsLine}</Row>
            {a.account.unaccounted.length ? (
              <Row k="Unaccounted for">{a.account.unaccounted.join(", ")}</Row>
            ) : null}
            {a.account.set_aside.length ? (
              <Row k="Set aside">
                {a.account.set_aside.map((s) => (
                  <div key={s.run}>
                    <span className="mono">{s.run}</span>: {s.reason}
                  </div>
                ))}
              </Row>
            ) : null}
            <Row k="Notes">
              {a.account.notes_added.length} added
              {a.account.notes_added.length ? (
                <> ({joined(a.account.notes_added.map(noteLink))})</>
              ) : null}
              , {a.account.notes_revised.length} revised
              {a.account.notes_revised.length ? (
                <> ({joined(a.account.notes_revised.map(noteLink))})</>
              ) : null}
            </Row>
            <Row k="Standings changed">
              {a.account.standings.length
                ? a.account.standings.map((s) => (
                    <div key={s.note_id}>
                      {s.title ?? s.note_id}: {word(s.from)} → <b>{word(s.to)}</b>
                    </div>
                  ))
                : "none"}
            </Row>
            <Row k="Edition">{a.account.edition ? noteLink(a.account.edition) : "none"}</Row>
            {a.container ? (
              <>
                <Row k="Commands">
                  {a.container.commands.count} in its harness's transcript (its own record)
                </Row>
                {a.container.works.length ? (
                  <Row k="Works it recorded">
                    {a.container.works.map((w) => (
                      <div key={w.work_id}>
                        {w.title}:{" "}
                        {w.reached ? (
                          `reached ${w.host}`
                        ) : (
                          <Badge tone="warn">no connection to {w.host}</Badge>
                        )}
                      </div>
                    ))}
                  </Row>
                ) : null}
              </>
            ) : null}
          </dl>
        </section>
      </div>
      <h3>Checks outstanding now</h3>
      {a.checks.length ? (
        <ul className="small">
          {a.checks.map((c) => (
            <li key={`${c.code}:${c.ref}:${c.message.slice(0, 40)}`}>
              <code>{c.code}</code> {c.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small faint">None.</p>
      )}
    </div>
  );
}
