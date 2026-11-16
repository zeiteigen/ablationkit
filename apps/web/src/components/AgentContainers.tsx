/**
 * Agent containers (ADR 0061): sessions started with `ablationkit agent start`, the researcher's
 * own harness in a rootless Podman container. Each row reads the session and controls it: pause
 * freezes the container, resume thaws it, stop ends it. Its terminal is shown read-only (attach
 * from a terminal to type into it), its egress lists every connection the proxy allowed or
 * refused (a refused host can be allowed from here), and its record holds what changed. With a
 * project, the project's container configuration is shown too; it is edited with
 * `ablationkit agent config edit`.
 */
import { useState } from "react";
import { api, useApi } from "../api.ts";
import { fmtTime } from "../lib/format.ts";
import { Badge, ErrorBox, Loading, type Tone, useAction } from "./ui.tsx";

export interface ContainerSession {
  session_id: string;
  project_id: string;
  token_id: string;
  harness: string;
  harness_version?: string;
  label: string;
  state: "starting" | "running" | "paused" | "exited" | "failed" | "lost";
  paused_by?: "researcher" | "compute_limit";
  image: string;
  image_id?: string;
  checkout: string;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  exit_code?: number;
  error?: string;
  boundary: {
    egress: string;
    hidden: string[];
    read_only: string[];
    cpus: number;
    memory_mb: number;
  };
  files_changed?: { path: string; status: string }[];
  packages_changed?: {
    added: { name: string; version: string }[];
    removed: { name: string; version: string }[];
    changed: { name: string; version: string; previous?: string }[];
  };
  commands?: { at?: string; command: string }[];
}

interface Runtime {
  available: boolean;
  problems: string[];
}

interface EgressRecord {
  at: string;
  kind: string;
  host: string;
  port: number;
  method?: string;
  path?: string;
  outcome: "allowed" | "denied" | "error";
  reason?: string;
  bytes_down?: number;
}

interface EgressView {
  records: EgressRecord[];
  summary: {
    connections: number;
    allowed: { host: string; count: number; bytes_down: number }[];
    denied: { host: string; count: number; reason?: string }[];
  };
}

const enc = encodeURIComponent;
const LIVE = new Set(["starting", "running", "paused"]);

function stateTone(s: ContainerSession["state"]): Tone {
  if (s === "running") return "ok";
  if (s === "paused" || s === "starting") return "warn";
  if (s === "failed" || s === "lost") return "err";
  return "neutral";
}

function stateText(s: ContainerSession): string {
  if (s.state === "paused")
    return s.paused_by === "compute_limit" ? "paused: compute limit" : "paused";
  if (s.state === "exited") return `exited${s.exit_code !== undefined ? ` (${s.exit_code})` : ""}`;
  return s.state;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function AgentContainers(props: { pid?: string }) {
  const list = useApi<{ sessions: ContainerSession[]; runtime: Runtime }>(
    `/api/v1/agent-containers${props.pid ? `?project=${enc(props.pid)}` : ""}`,
    { pollMs: 5_000 },
  );
  const [open, setOpen] = useState<{ sid: string; view: "terminal" | "egress" | "record" }>();
  const control = useAction(async (sid: string, action: "pause" | "resume" | "stop") => {
    await api(`/api/v1/agent-containers/${enc(sid)}/${action}`, {
      body: action === "resume" ? {} : { reason: `${action} in the web UI` },
    });
    list.reload();
  });
  const toggle = (sid: string, view: "terminal" | "egress" | "record") =>
    setOpen((o) => (o?.sid === sid && o.view === view ? undefined : { sid, view }));
  const sessions = list.data?.sessions ?? [];
  const cols = props.pid ? 5 : 6;
  return (
    <section className="card" data-testid="agent-containers">
      <h2>Agent containers</h2>
      <p className="small muted">
        <code>ablationkit agent start</code> runs your harness in a rootless Podman container: no
        GPU, no network but the project's egress allowlist, no view of AblationKit's own home. Its
        local jobs run in job containers with the GPU. Pausing freezes the container; stopping ends
        the session and its token.
      </p>
      <ErrorBox error={list.error ?? control.error} />
      {list.data?.runtime.problems.length ? (
        <div className="banner warn small">
          {list.data.runtime.problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      ) : null}
      {!list.data ? <Loading /> : null}
      {list.data && !sessions.length ? (
        <p className="faint small">
          No agent containers yet. In a registered checkout, run{" "}
          <code>ablationkit agent start</code>.
        </p>
      ) : null}
      {sessions.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                {props.pid ? null : <th>Project</th>}
                <th>Started</th>
                <th>State</th>
                <th>Container</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => [
                <tr key={s.session_id}>
                  <td>
                    {s.label} <span className="faint small">{s.harness}</span>
                    <div className="mono small faint">{s.session_id}</div>
                  </td>
                  {props.pid ? null : <td className="mono small">{s.project_id}</td>}
                  <td className="small">{fmtTime(s.started_at ?? s.created_at)}</td>
                  <td>
                    <Badge tone={stateTone(s.state)} title={s.error}>
                      {stateText(s)}
                    </Badge>
                  </td>
                  <td className="small">
                    <span className="mono">{s.image}</span>
                    <div className="faint">
                      egress {s.boundary.egress} · {s.boundary.hidden.length} hidden ·{" "}
                      {s.boundary.cpus} CPU · {s.boundary.memory_mb} MB
                    </div>
                  </td>
                  <td className="row" style={{ flexWrap: "wrap", gap: 4 }}>
                    {LIVE.has(s.state) ? (
                      <button
                        type="button"
                        className="small"
                        aria-expanded={open?.sid === s.session_id && open.view === "terminal"}
                        onClick={() => toggle(s.session_id, "terminal")}
                      >
                        Terminal
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="small"
                        aria-expanded={open?.sid === s.session_id && open.view === "record"}
                        onClick={() => toggle(s.session_id, "record")}
                      >
                        Record
                      </button>
                    )}
                    <button
                      type="button"
                      className="small"
                      aria-expanded={open?.sid === s.session_id && open.view === "egress"}
                      onClick={() => toggle(s.session_id, "egress")}
                    >
                      Egress
                    </button>
                    {s.state === "running" ? (
                      <button
                        type="button"
                        className="small"
                        disabled={control.busy}
                        onClick={() => void control.run(s.session_id, "pause")}
                      >
                        Pause
                      </button>
                    ) : null}
                    {s.state === "paused" ? (
                      <button
                        type="button"
                        className="small"
                        disabled={control.busy}
                        onClick={() => void control.run(s.session_id, "resume")}
                      >
                        Resume
                      </button>
                    ) : null}
                    {LIVE.has(s.state) ? (
                      <button
                        type="button"
                        className="small"
                        disabled={control.busy}
                        onClick={() => void control.run(s.session_id, "stop")}
                      >
                        Stop
                      </button>
                    ) : null}
                  </td>
                </tr>,
                open?.sid === s.session_id ? (
                  <tr key={`${s.session_id}:${open.view}`}>
                    <td colSpan={cols}>
                      {open.view === "terminal" ? <ContainerTerminal session={s} /> : null}
                      {open.view === "egress" ? <ContainerEgress session={s} /> : null}
                      {open.view === "record" ? <ContainerRecord session={s} /> : null}
                    </td>
                  </tr>
                ) : null,
              ])}
            </tbody>
          </table>
        </div>
      ) : null}
      {props.pid ? <ContainerConfigSummary pid={props.pid} /> : null}
    </section>
  );
}

/** The agent's terminal as it is now, read-only. */
function ContainerTerminal(props: { session: ContainerSession }) {
  const s = props.session;
  const screen = useApi<{ text: string; captured_at: string }>(
    `/api/v1/agent-containers/${enc(s.session_id)}/screen`,
    { pollMs: 2_000 },
  );
  return (
    <div data-testid="container-terminal">
      <ErrorBox error={screen.error} />
      <pre className="console" style={{ whiteSpace: "pre", overflowX: "auto" }}>
        {screen.data ? screen.data.text || "(nothing on the screen)" : "…"}
      </pre>
      <p className="faint small">
        Read-only. To type into it: <code>ablationkit agent attach {s.session_id}</code> (detach
        with Ctrl-b d).
      </p>
    </div>
  );
}

/** Where the container connected through its proxy, and what was refused. */
function ContainerEgress(props: { session: ContainerSession }) {
  const s = props.session;
  const eg = useApi<EgressView>(`/api/v1/agent-containers/${enc(s.session_id)}/egress?limit=100`, {
    pollMs: LIVE.has(s.state) ? 5_000 : 0,
  });
  const allow = useAction(async (host: string) => {
    await api(`/api/v1/projects/${enc(s.project_id)}/agent-containers/allow`, {
      body: { hosts: [host] },
    });
    eg.reload();
  });
  if (!eg.data) return eg.error ? <ErrorBox error={eg.error} /> : <Loading />;
  const { summary, records } = eg.data;
  return (
    <div className="stack" data-testid="container-egress">
      <ErrorBox error={allow.error} />
      <p className="small">
        {summary.connections} connections through the egress proxy. Only the host of an HTTPS
        connection is known; plain HTTP requests show their path.
      </p>
      {summary.denied.length ? (
        <div>
          <h3>Refused</h3>
          <ul className="small">
            {summary.denied.map((d) => (
              <li key={d.host}>
                <span className="mono">{d.host}</span> ×{d.count}{" "}
                <button
                  type="button"
                  className="small"
                  disabled={allow.busy}
                  onClick={() => void allow.run(d.host)}
                >
                  Allow
                </button>
                {d.reason ? <div className="faint">{d.reason}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary.allowed.length ? (
        <div>
          <h3>Reached</h3>
          <ul className="small">
            {summary.allowed.map((a) => (
              <li key={a.host}>
                <span className="mono">{a.host}</span> ×{a.count} · {bytes(a.bytes_down)} in
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {records.length ? (
        <details>
          <summary className="small">The last {records.length} connections</summary>
          <pre className="console" style={{ whiteSpace: "pre", overflowX: "auto" }}>
            {records
              .map(
                (r) =>
                  `${r.at}  ${r.outcome.padEnd(7)} ${`${r.host}:${r.port}`.padEnd(40)} ${r.method ? `${r.method} ${r.path ?? ""}` : r.kind}`,
              )
              .join("\n")}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/** What an ended session changed: files, packages, and the commands its harness recorded. */
export function ContainerRecord(props: { session: ContainerSession }) {
  const s = props.session;
  const pk = s.packages_changed;
  return (
    <div className="stack small" data-testid="container-record">
      {s.error ? <div className="banner err">{s.error}</div> : null}
      <div>
        <b>Files changed</b> ({s.files_changed?.length ?? 0}, from Git; your own edits to the
        checkout meanwhile show too)
        {s.files_changed?.length ? (
          <ul>
            {s.files_changed.slice(0, 50).map((f) => (
              <li key={f.path}>
                <span className="mono">{f.status}</span> <span className="mono">{f.path}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div>
        <b>Packages</b>{" "}
        {pk && pk.added.length + pk.removed.length + pk.changed.length
          ? [
              ...pk.added.map((p) => `+${p.name} ${p.version}`),
              ...pk.removed.map((p) => `−${p.name} ${p.version}`),
              ...pk.changed.map((p) => `${p.name} ${p.previous ?? "?"} → ${p.version}`),
            ]
              .slice(0, 40)
              .join(", ")
          : "unchanged"}
      </div>
      <div>
        <b>Commands</b> as the harness recorded them ({s.commands?.length ?? 0}; the agent can write
        its own transcript)
        {s.commands?.length ? (
          <pre className="console" style={{ maxHeight: "30vh" }}>
            {s.commands
              .slice(-30)
              .map((c) => `$ ${c.command}`)
              .join("\n")}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

interface ContainerConfig {
  revision: number;
  image: string;
  agent: { cpus: number; memory_mb: number; pids_max: number };
  egress: { mode: string; allow: string[] };
  hidden: string[];
  read_only: string[];
  jobs: { gpu: string; network: string };
  evaluations: { name: string; description: string; mounts: string[] }[];
  credentials: { name: string; upstream: string }[];
  host_code: string;
  pause_on_compute_limit: boolean;
}

function ContainerConfigSummary(props: { pid: string }) {
  const cfg = useApi<ContainerConfig>(`/api/v1/projects/${enc(props.pid)}/agent-containers/config`);
  if (!cfg.data) return <ErrorBox error={cfg.error} />;
  const c = cfg.data;
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "none");
  return (
    <details className="small" data-testid="container-config">
      <summary>
        This project's container settings (revision {c.revision}): edit with{" "}
        <code>ablationkit agent config edit</code>
      </summary>
      <dl className="w-dl">
        <dt>Image</dt>
        <dd className="mono">{c.image}</dd>
        <dt>Agent container</dt>
        <dd>
          {c.agent.cpus} CPUs, {c.agent.memory_mb} MB, {c.agent.pids_max} processes; no GPU
        </dd>
        <dt>Egress</dt>
        <dd>
          {c.egress.mode === "open"
            ? "open (every connection recorded)"
            : `allowlist: ${list(c.egress.allow)}`}
        </dd>
        <dt>Hidden</dt>
        <dd>{list(c.hidden)}</dd>
        <dt>Read-only</dt>
        <dd>{list(c.read_only)}</dd>
        <dt>Job containers</dt>
        <dd>
          GPU {c.jobs.gpu}, network {c.jobs.network}
        </dd>
        <dt>Protected evaluations</dt>
        <dd>
          {c.evaluations.length
            ? c.evaluations.map((e) => `${e.name} (reads ${list(e.mounts)})`).join("; ")
            : "none"}
        </dd>
        <dt>Credentials</dt>
        <dd>{list(c.credentials.map((x) => `${x.name} → ${x.upstream}`))}</dd>
        <dt>Host code</dt>
        <dd>{c.host_code === "refuse" ? "refused for contained sessions" : "allowed"}</dd>
        <dt>At the compute limit</dt>
        <dd>{c.pause_on_compute_limit ? "the session is paused" : "the session keeps running"}</dd>
      </dl>
    </details>
  );
}
