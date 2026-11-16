/**
 * Knowledge (spec §2.2, §6, §9): hypotheses, approaches, notes, reports, decisions and
 * conversation links. Records are coordinator-owned; the checkout's `.ablationkit/research/` is an
 * export of them (ADR 0013). Conversation links are pointers: nothing is fetched or synced.
 */
import { useEffect, useState } from "react";
import { api, qs, useApi, useEvents } from "../api.ts";
import { LineageStrip } from "../components/Lineage.tsx";
import { Markdown, plainExcerpt } from "../components/Markdown.tsx";
import { ReviewBar } from "../components/Review.tsx";
import {
  Badge,
  Empty,
  ErrorBox,
  KV,
  Link,
  Loading,
  Modal,
  Tabs,
  TrailActions,
  TrailLeaf,
  useAction,
} from "../components/ui.tsx";
import { useAgentSessions } from "../lib/agent-sessions.ts";
import { delta, fmtDelta, fmtNum, fmtTime, shortId } from "../lib/format.ts";
import {
  CONVERSATION_SOURCES,
  formatLinks,
  KINDS,
  kindInfo,
  parseLinks,
  parseTags,
  type RefName,
  type ResearchKind,
  type ResearchRecord,
  type ReviewInfo,
  refHref,
  sourceLabel,
  statusTone,
} from "../lib/research.ts";
import { navigate, setQuery, useLocation } from "../router.ts";
import { ExtensionMounts } from "./extensions.tsx";

const RESEARCH_EVENTS = [
  "research.created",
  "research.updated",
  "research.archived",
  "research.restored",
  "research.deleted",
  "research.imported",
];

/** The Knowledge tab bar: tasks (the questions) first, then each kind of record. */
export function KnowledgeTabs(props: { base: string; active: string }) {
  return (
    <Tabs
      items={[
        { id: "task", label: "Tasks", to: `${props.base}/tasks` },
        ...KINDS.map((k) => ({
          id: k.kind,
          label: k.label,
          to: `${props.base}/knowledge/${k.tab}`,
        })),
        { id: "review", label: "Review", to: `${props.base}/review` },
      ]}
      active={props.active}
    />
  );
}

export function KnowledgeRouter(props: { pid: string; base: string; rest: string }) {
  const parts = props.rest.split("/").filter(Boolean);
  if (parts[0] === "r" && parts[1]) {
    const id = decodeURIComponent(parts[1]);
    return <RecordPage key={id} pid={props.pid} base={props.base} id={id} />;
  }
  const tab = KINDS.find((k) => k.tab === parts[0]) ?? (KINDS[0] as (typeof KINDS)[number]);
  return <KnowledgeList pid={props.pid} base={props.base} kind={tab.kind} />;
}

function KnowledgeList(props: { pid: string; base: string; kind: ResearchKind }) {
  const { query } = useLocation();
  const info = kindInfo(props.kind);
  const q = {
    kind: props.kind,
    q: query.get("q") ?? undefined,
    tag: query.get("tag") ?? undefined,
    status: query.get("status") ?? undefined,
    source: query.get("source") ?? undefined,
    sort: query.get("sort") ?? undefined,
    archived: query.get("archived") ? "include" : undefined,
  };
  const list = useApi<{ records: ResearchRecord[]; tags: string[] }>(
    `/api/v1/projects/${encodeURIComponent(props.pid)}/research${qs(q)}`,
  );
  useEvents(() => list.reload(), { project: props.pid, types: RESEARCH_EVENTS });
  const who = useAgentSessions(props.pid);
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  return (
    <div className="stack">
      <KnowledgeTabs base={props.base} active={props.kind} />
      {info ? (
        <p className="muted small role" data-testid="kind-role">
          {info.role}
        </p>
      ) : null}
      <div className="row">
        <input
          type="search"
          placeholder={`Search ${info?.label.toLowerCase()}`}
          aria-label="Search"
          defaultValue={q.q ?? ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") setQuery({ q: (e.target as HTMLInputElement).value });
          }}
        />
        <select
          aria-label="Tag"
          value={q.tag ?? ""}
          onChange={(e) => setQuery({ tag: e.target.value })}
        >
          <option value="">any tag</option>
          {list.data?.tags.map((t) => (
            <option key={t} value={t}>
              #{t}
            </option>
          ))}
        </select>
        {info?.statuses ? (
          <select
            aria-label="Status"
            value={q.status ?? ""}
            onChange={(e) => setQuery({ status: e.target.value })}
          >
            <option value="">any status</option>
            {info.statuses.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        ) : null}
        {props.kind === "conversation" ? (
          <select
            aria-label="Source"
            value={q.source ?? ""}
            onChange={(e) => setQuery({ source: e.target.value })}
          >
            <option value="">any source</option>
            {CONVERSATION_SOURCES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        ) : null}
        <select
          aria-label="Sort"
          value={q.sort ?? "updated"}
          onChange={(e) => setQuery({ sort: e.target.value })}
        >
          <option value="updated">recently updated</option>
          <option value="created">recently created</option>
          <option value="title">title</option>
        </select>
        <label className="row small">
          <input
            type="checkbox"
            checked={Boolean(q.archived)}
            onChange={(e) => setQuery({ archived: e.target.checked ? "1" : undefined })}
          />
          archived
        </label>
        <span className="row" style={{ marginLeft: "auto" }}>
          {props.kind === "report" ? (
            <button type="button" onClick={() => setGenerating(true)}>
              Generate from a study
            </button>
          ) : null}
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            {props.kind === "conversation"
              ? "Link a conversation"
              : `New ${info?.singular.toLowerCase()}`}
          </button>
        </span>
      </div>
      {props.kind === "conversation" ? (
        <p className="faint small">
          Links are pointers to ChatGPT, Claude, Claude Code, Codex or other conversations.
          AblationKit never fetches, copies or searches their content, and a link may not open on
          another machine or account.
        </p>
      ) : null}
      <ErrorBox error={list.error} onRetry={list.reload} />
      {!list.data ? <Loading /> : null}
      {list.data?.records.length === 0 ? <Empty>No {info?.label.toLowerCase()} yet.</Empty> : null}
      {list.data?.records.length ? (
        <div className="table-wrap">
          <table data-testid="knowledge-table">
            <thead>
              <tr>
                <th>{info?.singular ?? "Title"}</th>
                {props.kind === "conversation" ? <th>Source</th> : <th>Status</th>}
                <th>By</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {list.data.records.map((r) => (
                <tr key={r.record_id}>
                  <td>
                    <Link
                      to={`${props.base}/knowledge/r/${encodeURIComponent(r.record_id)}`}
                      className="rtitle"
                    >
                      {r.title}
                    </Link>{" "}
                    {r.archived_at ? <Badge>archived</Badge> : null}
                    {r.generated ? (
                      <Badge title="Its evidence table was generated from a study's runs">
                        from study {r.generated.study_id}
                      </Badge>
                    ) : null}
                    {props.kind === "conversation" ? null : r.summary?.trim() ? (
                      <div className="muted rsum">{plainExcerpt(r.summary, 300)}</div>
                    ) : (
                      <div className="rsum">
                        <Badge tone="warn" title="Nobody wrote the short description of this yet">
                          no summary
                        </Badge>{" "}
                        <span className="faint">{plainExcerpt(r.body, 200)}</span>
                      </div>
                    )}
                    {r.tags.length ? (
                      <div className="faint small">{r.tags.map((t) => `#${t}`).join(" ")}</div>
                    ) : null}
                  </td>
                  <td>
                    {props.kind === "conversation" ? (
                      <span className="row">
                        <Badge>{sourceLabel(r.source)}</Badge>
                        {r.url ? (
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="small"
                          >
                            open ↗
                          </a>
                        ) : (
                          <span className="faint small mono">{r.local_ref}</span>
                        )}
                      </span>
                    ) : (
                      <span className="row nowrap">
                        {r.status ? <Badge tone={statusTone(r.status)}>{r.status}</Badge> : null}
                      </span>
                    )}
                  </td>
                  <td className="small">{who.actor(r.created_by)}</td>
                  <td className="small">{fmtTime(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ExportStatus pid={props.pid} />
      {creating ? (
        <RecordForm
          pid={props.pid}
          kind={props.kind}
          onClose={() => setCreating(false)}
          onSaved={(r) => {
            setCreating(false);
            navigate(`${props.base}/knowledge/r/${encodeURIComponent(r.record_id)}`);
          }}
        />
      ) : null}
      {generating ? (
        <GenerateReport
          pid={props.pid}
          onClose={() => setGenerating(false)}
          onDone={(r) => navigate(`${props.base}/knowledge/r/${encodeURIComponent(r.record_id)}`)}
        />
      ) : null}
    </div>
  );
}

function ExportStatus(props: { pid: string }) {
  const s = useApi<{
    checkout: string;
    state: {
      last_export_at?: string;
      last_export_error?: string;
      last_export_redactions?: number;
      drift: unknown[];
    };
  }>(`/api/v1/projects/${encodeURIComponent(props.pid)}/research/export`);
  useEvents(() => s.reload(), { project: props.pid, types: ["research.exported"] });
  const run = useAction(async () => {
    await api(`/api/v1/projects/${encodeURIComponent(props.pid)}/research/export`, { body: {} });
    s.reload();
  });
  if (!s.data) return null;
  const st = s.data.state;
  return (
    <div className="faint small row">
      <span>
        Exported to <span className="mono">{s.data.checkout}/.ablationkit/research/</span> for Git
        {st.last_export_at ? ` at ${fmtTime(st.last_export_at)}` : " (not yet)"}. Edits to those
        files are not read back.
        {st.last_export_redactions
          ? ` ${st.last_export_redactions} secret-looking field(s) withheld.`
          : ""}
        {st.drift.length ? ` ${st.drift.length} hand edit(s) were replaced; see the inbox.` : ""}
      </span>
      {st.last_export_error ? <Badge tone="err">{st.last_export_error}</Badge> : null}
      <button type="button" className="small" disabled={run.busy} onClick={() => void run.run()}>
        Export now
      </button>
      <ErrorBox error={run.error} />
    </div>
  );
}

/** Create or edit any research record kind except studies (those live under Runs → Studies). */
function RecordForm(props: {
  pid: string;
  kind: ResearchKind;
  record?: ResearchRecord;
  initial?: Partial<ResearchRecord>;
  onClose: () => void;
  onSaved: (r: ResearchRecord) => void;
}) {
  const info = kindInfo(props.kind);
  const r = { ...props.initial, ...props.record };
  const [title, setTitle] = useState(r.title ?? "");
  const [status, setStatus] = useState(r.status ?? "");
  const [summary, setSummary] = useState(r.summary ?? "");
  const [body, setBody] = useState(r.body ?? "");
  const [followUp, setFollowUp] = useState(r.follow_up ?? "");
  const [tags, setTags] = useState((r.tags ?? []).join(" "));
  const [links, setLinks] = useState(formatLinks(r.links ?? []));
  const [source, setSource] = useState(r.source ?? "claude");
  const [url, setUrl] = useState(r.url ?? "");
  const [localRef, setLocalRef] = useState(r.local_ref ?? "");
  const [exportNotes, setExportNotes] = useState(r.export_notes ?? false);
  const [attribution, setAttribution] = useState(r.attribution);
  const convs = useApi<{ records: ResearchRecord[] }>(
    props.kind === "note"
      ? `/api/v1/projects/${encodeURIComponent(props.pid)}/research?kind=conversation`
      : undefined,
  );
  const save = useAction(async () => {
    const fields: Record<string, unknown> = {
      title: title.trim(),
      tags: parseTags(tags),
      links: parseLinks(links),
    };
    const unset: string[] = [];
    const opt = (k: string, v: string | undefined) => {
      if (v?.trim()) fields[k] = v;
      else if (
        props.record &&
        (props.record as unknown as Record<string, unknown>)[k] !== undefined
      )
        unset.push(k);
    };
    if (info?.statuses && status) fields["status"] = status;
    if (info?.summaryLabel) opt("summary", summary);
    opt("body", body);
    if (props.kind === "report") opt("follow_up", followUp);
    if (props.kind === "conversation") {
      fields["source"] = source;
      opt("url", url.trim());
      opt("local_ref", localRef.trim());
      fields["export_notes"] = exportNotes;
    }
    if (props.kind === "note") {
      if (attribution) fields["attribution"] = attribution;
      else if (props.record?.attribution) unset.push("attribution");
    }
    const path = `/api/v1/projects/${encodeURIComponent(props.pid)}/research`;
    const res = props.record
      ? await api<{ record: ResearchRecord }>(
          `${path}/${encodeURIComponent(props.record.record_id)}`,
          {
            method: "PATCH",
            body: {
              ...fields,
              if_revision: props.record.revision,
              ...(unset.length ? { unset } : {}),
            },
          },
        )
      : await api<{ record: ResearchRecord }>(path, { body: { kind: props.kind, ...fields } });
    props.onSaved(res.record);
  });
  return (
    <Modal
      title={`${props.record ? "Edit" : "New"} ${info?.singular.toLowerCase() ?? props.kind}`}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={save.busy || !title.trim()}
            onClick={() => void save.run()}
          >
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <ErrorBox error={save.error} />
        <label className="field">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        </label>
        {props.kind === "conversation" ? (
          <>
            <div className="row">
              <label className="field">
                Source
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  aria-label="Source"
                >
                  {CONVERSATION_SOURCES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ flex: 1 }}>
                URL
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://…"
                  aria-label="URL"
                />
              </label>
            </div>
            <label className="field">
              Or a local session reference
              <input
                value={localRef}
                onChange={(e) => setLocalRef(e.target.value)}
                placeholder="e.g. a Claude Code or Codex session ID"
                aria-label="Local reference"
              />
            </label>
          </>
        ) : null}
        {info?.statuses ? (
          <label className="field">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              {props.record ? null : <option value="">default ({info.statuses[0]})</option>}
              {info.statuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        ) : null}
        {info?.summaryLabel ? (
          <label className="field">
            {info.summaryLabel}
            <textarea
              rows={4}
              placeholder="What this is, why it exists, what came out and what it means, in a few sentences. Markdown; LaTeX as $…$."
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              aria-label={info.summaryLabel}
            />
          </label>
        ) : null}
        <label className="field">
          {info?.bodyLabel ?? "Body"}
          <textarea
            rows={12}
            placeholder={
              props.kind === "conversation"
                ? undefined
                : "The in-depth read. Markdown: ## headings, tables, lists, LaTeX as $…$ or $$…$$ on its own lines."
            }
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="Body"
          />
        </label>
        {props.kind === "conversation" ? (
          <label className="row small">
            <input
              type="checkbox"
              checked={exportNotes}
              onChange={(e) => setExportNotes(e.target.checked)}
            />
            copy these notes into the Git-tracked export
          </label>
        ) : null}
        {props.kind === "report" ? (
          <label className="field">
            Next steps
            <textarea
              rows={4}
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              aria-label="Follow-up"
            />
          </label>
        ) : null}
        {props.kind === "note" ? (
          <div className="row">
            <label className="field" style={{ flex: 1 }}>
              From a conversation
              <select
                aria-label="Attributed conversation"
                value={attribution?.conversation_id ?? ""}
                onChange={(e) =>
                  setAttribution(
                    e.target.value
                      ? { conversation_id: e.target.value, mode: attribution?.mode ?? "quote" }
                      : undefined,
                  )
                }
              >
                <option value="">none</option>
                {convs.data?.records.map((c) => (
                  <option key={c.record_id} value={c.record_id}>
                    {c.title} ({sourceLabel(c.source)})
                  </option>
                ))}
              </select>
            </label>
            {attribution ? (
              <label className="field">
                As
                <select
                  aria-label="Attribution mode"
                  value={attribution.mode}
                  onChange={(e) =>
                    setAttribution({ ...attribution, mode: e.target.value as "quote" | "summary" })
                  }
                >
                  <option value="quote">a quote</option>
                  <option value="summary">a summary</option>
                </select>
              </label>
            ) : null}
          </div>
        ) : null}
        <label className="field">
          Tags (space-separated)
          <input value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
        </label>
        <label className="field">
          Links, one KIND:ID per line (hypothesis, study, run, job, note, report, …)
          <textarea
            rows={3}
            className="mono"
            value={links}
            onChange={(e) => setLinks(e.target.value)}
            aria-label="Links"
          />
        </label>
      </div>
    </Modal>
  );
}

function GenerateReport(props: {
  pid: string;
  onClose: () => void;
  onDone: (r: ResearchRecord) => void;
}) {
  const studies = useApi<{
    studies: { study_id: string; runs: number; record?: { title?: string } }[];
  }>(`/api/v1/projects/${encodeURIComponent(props.pid)}/studies`);
  const [study, setStudy] = useState("");
  const [title, setTitle] = useState("");
  const gen = useAction(async () => {
    const r = await api<{ record: ResearchRecord }>(
      `/api/v1/projects/${encodeURIComponent(props.pid)}/research/reports/generate`,
      { body: { study_id: study, ...(title.trim() ? { title: title.trim() } : {}) } },
    );
    props.onDone(r.record);
  });
  const withRuns = studies.data?.studies.filter((s) => s.runs > 0) ?? [];
  return (
    <Modal
      title="Generate a report from a study"
      onClose={props.onClose}
      footer={
        <button
          type="button"
          className="primary"
          disabled={!study || gen.busy}
          onClick={() => void gen.run()}
        >
          Generate
        </button>
      }
    >
      <div className="stack">
        <p className="muted small">
          AblationKit writes the evidence: every run with its attempt, job, source commit, metric
          values and artifacts, plus a summary table against the baseline. The interpretation is
          left for you (or an agent) to write.
        </p>
        <ErrorBox error={studies.error ?? gen.error} />
        <label className="field">
          Study
          <select value={study} onChange={(e) => setStudy(e.target.value)} aria-label="Study">
            <option value="">choose…</option>
            {withRuns.map((s) => (
              <option key={s.study_id} value={s.study_id}>
                {s.record?.title ? `${s.record.title} (${s.study_id})` : s.study_id} · {s.runs} runs
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Title (optional)
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Report title"
          />
        </label>
      </div>
    </Modal>
  );
}

interface RecordResp {
  record: ResearchRecord;
  backlinks: {
    record_id: string;
    kind: string;
    title: string;
    status?: string;
    summary?: string;
  }[];
  names?: Record<string, RefName>;
  review?: ReviewInfo;
}

function Redirect(props: { to: string }) {
  useEffect(() => navigate(props.to, { replace: true }), [props.to]);
  return <Loading />;
}

/** Linked objects by kind, in the order a reader wants them. */
const RELATED_ORDER: [string, string][] = [
  ["task", "Task"],
  ["hypothesis", "Hypotheses"],
  ["study", "Studies"],
  ["report", "Reports"],
  ["decision", "Decisions"],
  ["approach", "Approaches"],
  ["note", "Notes"],
  ["conversation", "Conversations"],
];

function RecordPage(props: { pid: string; base: string; id: string }) {
  const rec = useApi<RecordResp>(
    `/api/v1/projects/${encodeURIComponent(props.pid)}/research/${encodeURIComponent(props.id)}`,
  );
  useEvents(() => rec.reload(), { project: props.pid, types: RESEARCH_EVENTS });
  const who = useAgentSessions(props.pid);
  const [editing, setEditing] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const path = `/api/v1/projects/${encodeURIComponent(props.pid)}/research/${encodeURIComponent(props.id)}`;
  const archive = useAction(async (archived: boolean) => {
    await api(`${path}/archive`, { body: { archived } });
    rec.reload();
  });
  const regen = useAction(async () => {
    await api(`${path}/regenerate`, { body: {} });
    rec.reload();
  });
  const del = useAction(async () => {
    await api(path, { method: "DELETE" });
    navigate(`${props.base}/knowledge/${kindInfo(rec.data?.record.kind ?? "")?.tab ?? ""}`);
  });
  if (rec.error) return <ErrorBox error={rec.error} onRetry={rec.reload} />;
  if (!rec.data) return <Loading />;
  const r = rec.data.record;
  // A study reads on its own page, with its live table.
  if (r.kind === "study")
    return <Redirect to={`${props.base}/runs/studies/${encodeURIComponent(r.record_id)}`} />;
  const info = kindInfo(r.kind);
  const names = rec.data.names ?? {};
  const evidenceKeys = new Set((r.evidence ?? []).map((e) => `${e.ref.kind}:${e.ref.id}`));
  // Everything this record is tied to: what it links and what links it, once each.
  const related = new Map<string, { kind: string; id: string; name?: RefName | undefined }>();
  for (const l of r.links) {
    const k = `${l.kind}:${l.id}`;
    if (!evidenceKeys.has(k)) related.set(k, { kind: l.kind, id: l.id, name: names[k] });
  }
  for (const b of rec.data.backlinks) {
    const k = `${b.kind}:${b.record_id}`;
    if (!related.has(k))
      related.set(k, { kind: b.kind, id: b.record_id, name: names[k] ?? { title: b.title } });
  }
  const groups = RELATED_ORDER.map(
    ([kind, label]) => [label, [...related.values()].filter((x) => x.kind === kind)] as const,
  ).filter(([, items]) => items.length);
  const other = [...related.values()].filter((x) => !RELATED_ORDER.some(([k]) => k === x.kind));
  const bodyTitle =
    r.kind === "report" ? "Interpretation" : (info?.bodyLabel?.replace(/ \(.*$/, "") ?? "Body");
  return (
    <div className="stack read">
      <KnowledgeTabs base={props.base} active={r.kind} />
      {r.kind === "conversation" ? null : (
        <ReviewBar
          pid={props.pid}
          base={props.base}
          kind={r.kind}
          id={r.record_id}
          review={rec.data.review}
          onChanged={rec.reload}
        />
      )}
      <header className="readhead ph">
        <TrailLeaf>{r.title}</TrailLeaf>
        <div className="row">
          <span className="eyebrow" style={{ margin: 0 }}>
            {info?.singular ?? r.kind}
          </span>
          {r.status ? <Badge tone={statusTone(r.status)}>{r.status}</Badge> : null}
          {r.archived_at ? <Badge>archived</Badge> : null}
          <span className="faint small">
            {who.actor(r.created_by)} · updated {fmtTime(r.updated_at)}
          </span>
          <TrailActions>
            {r.kind === "conversation" && r.url ? (
              <a className="btn small" href={r.url} target="_blank" rel="noopener noreferrer">
                Open conversation ↗
              </a>
            ) : null}
            {r.kind === "conversation" ? (
              <button type="button" className="small" onClick={() => setQuoting(true)}>
                Quote into a note
              </button>
            ) : null}
            {r.generated ? (
              <button
                type="button"
                className="small"
                disabled={regen.busy}
                onClick={() => void regen.run()}
              >
                Refresh evidence
              </button>
            ) : null}
            <button type="button" className="small" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className="small"
              disabled={archive.busy}
              onClick={() => void archive.run(!r.archived_at)}
            >
              {r.archived_at ? "Restore" : "Archive"}
            </button>
            <button type="button" className="small danger" onClick={() => setDeleting(true)}>
              Delete
            </button>
          </TrailActions>
        </div>
        <h1 className="readtitle" data-testid="record-title">
          {r.title}
        </h1>
        {r.summary ? (
          <Markdown text={r.summary} base={props.base} testId="record-summary" lede />
        ) : r.kind === "conversation" ? null : (
          <p className="faint" data-testid="record-no-summary">
            No summary yet: nobody wrote what this is, why it exists and what came out.{" "}
            <button type="button" className="link" onClick={() => setEditing(true)}>
              Write one
            </button>
          </p>
        )}
      </header>
      <ErrorBox error={archive.error ?? regen.error ?? del.error} />
      {r.kind === "conversation" ? (
        <section className="card">
          <KV
            rows={[
              ["Source", sourceLabel(r.source)],
              [
                "Where",
                r.url ? (
                  <a
                    key="u"
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mono"
                  >
                    {r.url}
                  </a>
                ) : (
                  <span key="l" className="mono">
                    {r.local_ref}
                  </span>
                ),
              ],
              [
                "Conversation created",
                r.conversation_created_at ? fmtTime(r.conversation_created_at) : undefined,
              ],
              [
                "Notes exported to Git",
                r.export_notes ? "yes" : "no (kept in the coordinator only)",
              ],
            ]}
          />
          <p className="faint small">
            A pointer only: AblationKit does not fetch or store the conversation, and it may be
            unavailable from another machine or account.
          </p>
        </section>
      ) : null}
      {r.attribution ? (
        <div className="banner">
          {r.attribution.mode === "quote" ? "Quotes" : "Summarizes"}{" "}
          <Link
            to={`${props.base}/knowledge/r/${encodeURIComponent(r.attribution.conversation_id)}`}
          >
            a linked conversation
          </Link>
          . The text is the researcher's; nothing was copied automatically.
        </div>
      ) : null}
      {r.evidence?.length ? <EvidenceTable base={props.base} r={r} names={names} /> : null}
      {r.kind === "report" || r.body ? (
        <section className="card">
          <h2>{bodyTitle}</h2>
          {r.body ? (
            <Markdown text={r.body} base={props.base} testId="record-body" />
          ) : (
            <p className="faint small">
              Not written yet. The evidence above is recorded; what it means is not.
            </p>
          )}
        </section>
      ) : null}
      {r.follow_up ? (
        <section className="card" data-testid="record-next">
          <h2>Next steps</h2>
          <Markdown text={r.follow_up} base={props.base} />
        </section>
      ) : null}
      {r.kind === "report" ? (
        <ReportExtensionBlocks pid={props.pid} reportId={r.record_id} />
      ) : null}
      {groups.length || other.length ? (
        <section className="card" data-testid="record-related">
          <h2>Related</h2>
          <div className="related">
            {groups.map(([label, items]) => (
              <div key={label}>
                <h3>{label}</h3>
                {items.map((x) => (
                  <RelatedItem key={`${x.kind}:${x.id}`} base={props.base} item={x} />
                ))}
              </div>
            ))}
            {other.length ? (
              <div>
                <h3>Runs, jobs and other objects</h3>
                {other.map((x) => (
                  <RelatedItem key={`${x.kind}:${x.id}`} base={props.base} item={x} />
                ))}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      <details className="provenance">
        <summary className="small">Provenance: lineage, IDs and revisions</summary>
        <LineageStrip pid={props.pid} kind={r.kind} id={r.record_id} base={props.base} />
        <KV
          rows={[
            [
              "ID",
              <span key="id" className="mono">
                {r.record_id}
              </span>,
            ],
            ["Revision", String(r.revision)],
            ["Created", `${fmtTime(r.created_at)} by ${who.actor(r.created_by)}`],
            ["Updated", `${fmtTime(r.updated_at)} by ${who.actor(r.updated_by)}`],
            ["Tags", r.tags.length ? r.tags.map((t) => `#${t}`).join(" ") : undefined],
            [
              "Generated",
              r.generated
                ? `from study ${r.generated.study_id}, ${r.generated.runs} runs, baseline ${r.generated.baseline_variant ?? "—"}, ${fmtTime(r.generated.generated_at)}`
                : undefined,
            ],
          ]}
        />
      </details>
      {editing ? (
        <RecordForm
          pid={props.pid}
          kind={r.kind}
          record={r}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            rec.reload();
          }}
        />
      ) : null}
      {quoting ? (
        <RecordForm
          pid={props.pid}
          kind="note"
          initial={{
            title: `From “${r.title}”`,
            attribution: { conversation_id: r.record_id, mode: "quote" },
            links: r.links,
            body: "> ",
          }}
          onClose={() => setQuoting(false)}
          onSaved={(n) => navigate(`${props.base}/knowledge/r/${encodeURIComponent(n.record_id)}`)}
        />
      ) : null}
      {deleting ? (
        <Modal
          title="Delete this record?"
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button type="button" onClick={() => setDeleting(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={del.busy}
                onClick={() => void del.run()}
              >
                Delete
              </button>
            </>
          }
        >
          <p>
            Deleting removes <strong>{r.title}</strong> from the coordinator and from the next
            export. Records that link to it keep the link, shown as missing. Archive it instead to
            keep it out of lists.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/** One linked object: its name and status, and its short description when it has one. */
export function RelatedItem(props: {
  base: string;
  item: { kind: string; id: string; name?: RefName | undefined };
}) {
  const x = props.item;
  const href = refHref(props.base, x);
  const title = x.name?.title ?? (x.kind === "run" ? shortId(x.id, 12) : x.id);
  return (
    <div className="relitem">
      <div className="titleline">
        {x.name?.status ? <Badge tone={statusTone(x.name.status)}>{x.name.status}</Badge> : null}
        {href ? (
          <Link to={href} title={`${x.kind}:${x.id}`}>
            {title}
          </Link>
        ) : (
          <span title={`${x.kind}:${x.id}`}>{title}</span>
        )}
        {RELATED_ORDER.some(([k]) => k === x.kind) ? null : (
          <span className="faint small">{x.kind}</span>
        )}
      </div>
      {x.name?.summary ? (
        <p className="muted small rsum">{plainExcerpt(x.name.summary, 220)}</p>
      ) : null}
    </div>
  );
}

/**
 * What a report or decision rests on, as a reader needs it: each run by name, its values rounded
 * (the exact value on hover) with the difference to the baseline row. The attempt, job, commit
 * and artifact columns are provenance and stay behind a toggle.
 */
function EvidenceTable(props: { base: string; r: ResearchRecord; names: Record<string, RefName> }) {
  const ev = props.r.evidence ?? [];
  const [prov, setProv] = useState(false);
  const keys = [...new Set(ev.flatMap((e) => Object.keys(e.values ?? {})))].sort();
  const baselines = ev.filter((e) => e.role === "baseline");
  const base = baselines.length === 1 ? baselines[0] : undefined;
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  return (
    <section className="card">
      <h2>
        Evidence ({ev.length})
        <label className="row small faint" style={{ marginLeft: "auto", fontWeight: 400 }}>
          <input type="checkbox" checked={prov} onChange={(e) => setProv(e.target.checked)} />
          provenance columns
        </label>
      </h2>
      <div className="table-wrap">
        <table data-testid="evidence-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Role</th>
              {keys.map((k) => (
                <th key={k} className="num mono">
                  {k}
                </th>
              ))}
              {prov ? (
                <>
                  <th>Attempt / job</th>
                  <th>Source</th>
                  <th>Artifacts</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {ev.map((e) => {
              const href = refHref(props.base, e.ref);
              const name = props.names[`${e.ref.kind}:${e.ref.id}`];
              const label =
                e.ref.label ??
                name?.title ??
                (e.ref.kind === "run" ? `run ${shortId(e.ref.id)}` : e.ref.id);
              return (
                <tr key={`${e.ref.kind}:${e.ref.id}`} className={e === base ? "selected" : ""}>
                  <td>
                    {href ? (
                      <Link to={href} title={`${e.ref.kind}:${e.ref.id}`}>
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                    {e.note ? <div className="muted small">{e.note}</div> : null}
                    {e.variant_id && e.variant_id !== label ? (
                      <div className="faint small mono">{e.variant_id}</div>
                    ) : null}
                    {prov ? (
                      <div className="faint small mono">
                        {e.ref.kind}:{e.ref.id}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {e.role ? (
                      <Badge tone={e.role === "baseline" ? "info" : "neutral"}>{e.role}</Badge>
                    ) : null}
                  </td>
                  {keys.map((k) => {
                    const v = num(e.values?.[k]);
                    const b = base && e !== base ? num(base.values?.[k]) : undefined;
                    return (
                      <td key={k} className="num" title={e.values?.[k]}>
                        {v === undefined || Number.isNaN(v) ? (e.values?.[k] ?? "—") : fmtNum(v, 5)}
                        {v !== undefined && b !== undefined && !Number.isNaN(v) ? (
                          <div className="faint small">{fmtDelta(delta(v, b))}</div>
                        ) : null}
                      </td>
                    );
                  })}
                  {prov ? (
                    <>
                      <td className="mono small">
                        {e.attempt_id}
                        {e.job_id ? (
                          <div>
                            <Link to={`${props.base}/runs/jobs/${encodeURIComponent(e.job_id)}`}>
                              {e.job_id}
                            </Link>
                          </div>
                        ) : null}
                      </td>
                      <td className="mono small">
                        {e.source_commit
                          ? `${e.source_commit.slice(0, 12)}${e.source_dirty ? " (dirty)" : ""}`
                          : "—"}
                      </td>
                      <td className="small">{e.artifacts?.length ?? 0}</td>
                    </>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="faint small">
        Captured {fmtTime(ev[0]?.captured_at)}
        {base ? "; differences are against the baseline row" : ""}. Values are rounded for reading;
        hover one for the value exactly as logged.
      </p>
    </section>
  );
}

interface ExtensionSnapshot {
  snapshot_id: string;
  extension_id: string;
  build_id: string;
  title: string;
  text?: string;
  table?: { columns: string[]; rows: (string | number | boolean)[][] };
  image?: { file: string; bytes: number; sha256: string };
  saved_at: string;
}

/**
 * `report.block` extension views for this report, and the static snapshots saved from them
 * (shown whether or not the extension is still installed or enabled).
 */
function ReportExtensionBlocks(props: { pid: string; reportId: string }) {
  const p = encodeURIComponent(props.pid);
  const snaps = useApi<{ snapshots: ExtensionSnapshot[] }>(
    `/api/v1/projects/${p}/extension-snapshots?report=${encodeURIComponent(props.reportId)}`,
  );
  useEvents(() => snaps.reload(), { project: props.pid, types: ["research.updated"] });
  const list = snaps.data?.snapshots ?? [];
  return (
    <>
      <ExtensionMounts
        pid={props.pid}
        point="report.block"
        context={{ report_id: props.reportId }}
      />
      {list.length ? (
        <section className="card" data-testid="report-snapshots">
          <h2>Extension snapshots</h2>
          <p className="faint small">
            Static copies saved with the report; they do not need the extension.
          </p>
          {list.map((s) => (
            <figure key={s.snapshot_id} className="stack" style={{ margin: "8px 0" }}>
              <figcaption className="small">
                <strong>{s.title}</strong>{" "}
                <span className="faint">
                  from <span className="mono">{s.extension_id}</span> · {fmtTime(s.saved_at)}
                </span>
              </figcaption>
              {s.text ? <Markdown text={s.text} /> : null}
              {s.table ? (
                <table className="table small">
                  <thead>
                    <tr>
                      {s.table.columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {s.table.rows.map((row, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: snapshot rows are positional
                      <tr key={i}>
                        {row.map((c, j) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                          <td key={j}>{String(c)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {s.image ? (
                <img
                  alt={s.title}
                  style={{ maxWidth: "100%" }}
                  src={`/api/v1/projects/${p}/extension-snapshots/${s.snapshot_id}/image`}
                />
              ) : null}
            </figure>
          ))}
        </section>
      ) : null}
    </>
  );
}
