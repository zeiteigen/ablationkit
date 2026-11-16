/**
 * Project settings → Extensions (spec §8.2 items 4 and 7, §8.4 development loop; ADR 0022):
 * discovered extensions and their status; per extension the manifest, requested permissions with
 * their bounds and enforcement level, Python limits, diagnostics, builds with hashes, the source
 * diff against the last approved build, a sandbox preview, approval (with the
 * trusted-code acknowledgement), disable, enable and rollback, Python executions with logs, and a
 * developer console. Also the user registry, to install an extension into this project.
 */
import { type ReactNode, useState } from "react";
import { api, useApi, useEvents } from "../api.ts";
import { ExtensionFrame, type ExtensionMount } from "../components/ExtensionFrame.tsx";
import {
  Badge,
  Empty,
  ErrorBox,
  KV,
  Link,
  Loading,
  Modal,
  PageHead,
  type Tone,
  TrailLeaf,
  useAction,
  usePageProject,
} from "../components/ui.tsx";
import { fmtTime, shortId } from "../lib/format.ts";

// biome-ignore lint/suspicious/noExplicitAny: coordinator JSON rendered for people
type J = any;

const EVENTS = [
  "extension.built",
  "extension.activated",
  "extension.disabled",
  "extension.installed",
  "extension.execution.started",
  "extension.execution.progress",
  "extension.execution.finished",
];

const STATUS: Record<string, [Tone, string]> = {
  invalid: ["err", "Invalid: fix the diagnostics"],
  needs_build: ["warn", "Needs a build"],
  needs_approval: ["warn", "Built; needs your approval"],
  active: ["ok", "Active"],
  active_outdated: ["warn", "Active (an approved build); the checkout has changed since"],
  disabled: ["neutral", "Disabled"],
  removed: ["neutral", "Removed from the checkout: inactive"],
  safe_mode: ["warn", "Inactive: safe mode"],
};

function StatusBadge(props: { status: string }) {
  const [tone, label] = STATUS[props.status] ?? ["neutral", props.status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function ExtensionsPage(props: { pid: string; base: string; rest: string }) {
  const ext = props.rest.split("/").filter(Boolean)[0];
  return ext ? (
    <ExtensionDetail pid={props.pid} base={props.base} ext={decodeURIComponent(ext)} />
  ) : (
    <ExtensionList pid={props.pid} base={props.base} />
  );
}

function ExtensionList(props: { pid: string; base: string }) {
  const p = encodeURIComponent(props.pid);
  const list = useApi<J>(`/api/v1/projects/${p}/extensions`);
  const registry = useApi<J>(`/api/v1/projects/${p}/extension-registry`);
  const backends = useApi<J>(`/api/v1/projects/${p}/extension-backends`);
  useEvents(() => list.reload(), { project: props.pid, types: EVENTS });
  useEvents(() => backends.reload(), {
    project: props.pid,
    types: ["extension.backend.activation"],
  });
  const toggleBackend = useAction(async (backend: J) => {
    const route = `/api/v1/projects/${p}/extensions/${encodeURIComponent(backend.id)}/backend`;
    if (backend.enabled) await api(`${route}/disable`, { body: {} });
    else await api(`${route}/enable`, { body: {} });
    backends.reload();
  });
  const install = useAction(async (id: string, version: string) => {
    await api(`/api/v1/projects/${p}/extensions/install`, { body: { extension_id: id, version } });
    list.reload();
  });
  const here = new Set((list.data?.extensions ?? []).map((e: J) => e.extension_id));
  return (
    <div className="stack" data-testid="extensions">
      <section className="card">
        <h2>Extensions</h2>
        <p className="muted small">
          Project-scoped extensions live in <code>.ablationkit/extensions/&lt;id&gt;/</code>.
          Nothing runs until you approve an exact build in this project. Views run in a sandboxed
          frame with no network; Python runs as <strong>trusted code</strong> under your user,
          within its declared CPU, memory and time limits. General runs and tracking work when
          feature extensions are disabled.
        </p>
        {list.data?.safe_mode ? (
          <div className="banner warn">
            Safe mode: every extension is inactive. You can still disable and roll back.
          </div>
        ) : null}
        <ErrorBox error={list.error} />
        {list.loading && !list.data ? <Loading /> : null}
        {list.data && !list.data.extensions.length ? (
          <Empty>
            No extensions yet. An agent can scaffold one from a template; see
            docs/extensions/README.md.
          </Empty>
        ) : null}
        {(list.data?.extensions ?? []).map((e: J) => (
          <div key={e.extension_id} className="row" data-testid={`ext-row-${e.extension_id}`}>
            <Link to={`${props.base}/settings/extensions/${encodeURIComponent(e.extension_id)}`}>
              <strong>{e.name ?? e.extension_id}</strong>
            </Link>
            <span className="mono small">
              {e.extension_id} {e.version}
            </span>
            <StatusBadge status={e.status} />
            {e.trusted_code ? <Badge tone="warn">trusted code</Badge> : null}
            {e.errors ? <Badge tone="err">{e.errors} errors</Badge> : null}
            <span className="faint small">
              {(e.contributes ?? []).map((c: J) => c.point).join(", ")}
            </span>
          </div>
        ))}
      </section>
      <section className="card" data-testid="bundled-backends">
        <h2>Bundled features</h2>
        <p className="muted small">
          Coordinator-provided backend features are separate from project extensions. Enabling one
          grants its declared capabilities for this project; safe mode keeps every backend inactive.
        </p>
        <ErrorBox error={backends.error ?? toggleBackend.error} onRetry={backends.reload} />
        {backends.loading && !backends.data ? <Loading /> : null}
        {backends.data && !(backends.data.extensions ?? []).some((b: J) => b.bundled) ? (
          <Empty>No bundled backend features are registered.</Empty>
        ) : null}
        {(backends.data?.extensions ?? [])
          .filter((backend: J) => backend.bundled)
          .map((backend: J) => (
            <div key={backend.id} className="stack" data-testid={`backend-row-${backend.id}`}>
              <div className="row">
                <strong>{backend.id}</strong>
                <span className="mono small">{backend.version}</span>
                {list.data?.safe_mode ? (
                  <Badge tone="warn">Inactive: safe mode</Badge>
                ) : backend.enabled ? (
                  <Badge tone="ok">Enabled</Badge>
                ) : (
                  <Badge tone="neutral">Disabled</Badge>
                )}
                {backend.enabled ? (
                  <button
                    type="button"
                    className="small"
                    disabled={toggleBackend.busy}
                    onClick={() => void toggleBackend.run(backend)}
                  >
                    Disable
                  </button>
                ) : (
                  <button
                    type="button"
                    className="small"
                    disabled={toggleBackend.busy || list.data?.safe_mode === true}
                    onClick={() => void toggleBackend.run(backend)}
                  >
                    Enable
                  </button>
                )}
              </div>
              <details className="small">
                <summary>Declared capabilities ({backend.capabilities?.length ?? 0})</summary>
                {backend.capabilities?.length ? (
                  <ul className="small">
                    {backend.capabilities.map((capability: string) => (
                      <li key={capability}>
                        <code>{capability}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="faint">This backend declares no capabilities.</p>
                )}
              </details>
            </div>
          ))}
      </section>
      <section className="card">
        <h2>User registry</h2>
        <p className="muted small">
          Extensions published from any project. Installing copies the source into this checkout; it
          still needs a build and this project's own approval.
        </p>
        <ErrorBox error={registry.error ?? install.error} />
        {(registry.data?.extensions ?? []).length === 0 ? (
          <p className="faint small">Empty.</p>
        ) : null}
        {(registry.data?.extensions ?? []).map((e: J) => (
          <div key={`${e.extension_id}@${e.version}`} className="row small">
            <span className="mono">
              {e.extension_id} {e.version}
            </span>
            {e.compatible ? null : <Badge tone="err">incompatible host API {e.host_api}</Badge>}
            <button
              type="button"
              className="small"
              disabled={here.has(e.extension_id) || !e.compatible || install.busy}
              onClick={() => void install.run(e.extension_id, e.version)}
            >
              {here.has(e.extension_id) ? "In this project" : "Install here"}
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}

function ExtensionDetail(props: { pid: string; base: string; ext: string }) {
  const P = `/api/v1/projects/${encodeURIComponent(props.pid)}/extensions/${encodeURIComponent(props.ext)}`;
  const d = useApi<{ extension: J }>(P);
  const execs = useApi<J>(
    `/api/v1/projects/${encodeURIComponent(props.pid)}/extension-executions?extension=${encodeURIComponent(props.ext)}`,
  );
  useEvents(
    () => {
      d.reload();
      execs.reload();
    },
    { project: props.pid, types: EVENTS },
  );
  const [approving, setApproving] = useState<J>();
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState("");
  const [review, setReview] = useState<string>();
  const [log, setLog] = useState<{ id: string; text: string }>();
  const act = useAction(async (what: () => Promise<unknown>) => {
    await what();
    d.reload();
    execs.reload();
  });
  const build = () => api(`${P}/build`, { body: {} });
  const approve = (b: J) =>
    api(`${P}/approve`, {
      body: { build_id: b.build_id, trusted_code: true, ...(note ? { note } : {}) },
    });
  const rollback = (b: J) => api(`${P}/rollback`, { body: { build_id: b.build_id } });
  const enable = () => api(`${P}/enable`, { body: {} });
  const disable = () =>
    api(`${P}/disable`, { body: { reason: "disabled from the Extensions page" } });

  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  const e = d.data?.extension as J;
  const latest = e.builds?.[0];
  const checkoutBuild = e.builds?.find((b: J) => b.build_id === e.checkout_build);
  const m = e.manifest ?? {};
  const uiContribs = (m.contributes ?? []).filter((c: J) =>
    ["project.panel", "run.tab", "comparison.view", "report.block", "model.demo"].includes(c.point),
  );
  return (
    <div className="stack" data-testid="extension-detail">
      <TrailLeaf>{e.name ?? e.extension_id}</TrailLeaf>
      <section className="card">
        <div className="row">
          <h2 className="grow">
            {e.name ?? e.extension_id} <span className="mono small">{e.version}</span>
          </h2>
          <StatusBadge status={e.status} />
          {e.trusted_code ? (
            <Badge
              tone="warn"
              title="Approved Python runs under your user and could read your files"
            >
              trusted code
            </Badge>
          ) : null}
        </div>
        {e.description ? <p>{e.description}</p> : null}
        <ErrorBox error={act.error} />
        <div className="row">
          <button
            type="button"
            disabled={act.busy || e.errors > 0 || !e.checkout_build}
            onClick={() => void act.run(build)}
          >
            Build from the checkout
          </button>
          {e.enabled ? (
            <button type="button" disabled={act.busy} onClick={() => void act.run(disable)}>
              Disable
            </button>
          ) : e.active_build ? (
            <button type="button" disabled={act.busy} onClick={() => void act.run(enable)}>
              Enable
            </button>
          ) : null}
        </div>
        <KV
          rows={[
            [
              "Source",
              <span key="s" className="mono small">
                {e.source?.path}
              </span>,
            ],
            ["Host API", `${m.host_api ?? "?"} (this host: ${e.host_api_version})`],
            [
              "Active build",
              e.active_build ? (
                <span key="a" className="mono">
                  {e.active_build}
                </span>
              ) : (
                "none"
              ),
            ],
            [
              "Checkout build",
              e.checkout_build ? (
                <span key="c" className="mono">
                  {e.checkout_build}
                </span>
              ) : (
                "—"
              ),
            ],
            ...(e.disabled
              ? ([
                  [
                    "Disabled",
                    `${fmtTime(e.disabled.at)}${e.disabled.reason ? ` — ${e.disabled.reason}` : ""}`,
                  ],
                ] as [string, ReactNode][])
              : []),
          ]}
        />
      </section>
      {e.diagnostics?.length ? (
        <section className="card">
          <h2>Diagnostics</h2>
          {e.diagnostics.map((x: J, i: number) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics are positional
            <div key={i} className="small">
              <Badge tone={x.level === "error" ? "err" : "warn"}>{x.code}</Badge> {x.message}
              {x.path ? <span className="mono faint"> ({x.path})</span> : null}
              {x.fix ? <div className="faint">Fix: {x.fix}</div> : null}
            </div>
          ))}
        </section>
      ) : null}
      <div className="grid2">
        <section className="card">
          <h2>Permissions requested</h2>
          {(e.permissions ?? []).length === 0 ? <p className="faint small">None.</p> : null}
          {(e.permissions ?? []).map((p: J) => (
            <div key={p.capability} className="small" style={{ marginBottom: 6 }}>
              <span className="mono">{p.capability}</span>{" "}
              <Badge tone={p.enforcement === "enforced" ? "ok" : "warn"}>{p.enforcement}</Badge>{" "}
              <Badge>{p.risk}</Badge>
              <div className="muted">{p.description}</div>
              {p.bounds ? <div className="faint">Bounds: {p.bounds}</div> : null}
            </div>
          ))}
          <h3>Contributions</h3>
          {(m.contributes ?? []).map((c: J) => (
            <div key={c.id} className="small">
              <span className="mono">{c.point}</span> {c.title}
              {c.operation ? <span className="faint"> → {c.operation}</span> : null}
            </div>
          ))}
        </section>
        <section className="card">
          <h2>Python</h2>
          {e.python ? (
            <>
              <div className="banner warn small">
                Approved Python runs as trusted code under your Linux user: it can read anything you
                can. Limits below are enforced by systemd where available; the network is cut off
                with a network namespace where the host allows it.
              </div>
              <KV
                rows={[
                  ["Time", `${e.python.max_runtime_seconds} s`],
                  ["Memory", `${e.python.max_memory_mb} MiB`],
                  ["CPU", `${e.python.cpu_percent ?? 100}%`],
                  ["GPU", e.python.gpu ? "requested" : "no"],
                  ["Network", e.python.network],
                  [
                    "Lockfile",
                    <span key="l" className="mono small">
                      {e.python.lockfile}
                    </span>,
                  ],
                ]}
              />
            </>
          ) : (
            <p className="faint small">No Python contributions.</p>
          )}
        </section>
      </div>
      <section className="card">
        <h2>Builds and approvals</h2>
        {(e.builds ?? []).length === 0 ? <Empty>No builds yet.</Empty> : null}
        {(e.builds ?? []).map((b: J) => (
          <div
            key={b.build_id}
            className="stack"
            style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}
          >
            <div className="row small">
              <span className="mono">{b.build_id}</span> <span>{b.version}</span>
              <Badge tone={b.status === "ready" ? "ok" : "err"}>{b.status}</Badge>
              {b.active ? <Badge tone="ok">active</Badge> : null}
              {b.approved ? (
                <Badge
                  tone="ok"
                  title={`${b.approved.automatic ? "enabled as built" : "approved"} ${fmtTime(b.approved.at)}`}
                >
                  {b.approved.automatic ? "enabled as built" : "approved"}
                </Badge>
              ) : (
                <Badge tone="warn">not approved here</Badge>
              )}
              <span className="faint">
                built {fmtTime(b.built_at)} by {b.built_by?.kind}
              </span>
              <span className="grow" />
              <button
                type="button"
                className="small"
                onClick={() => setReview(review === b.build_id ? undefined : b.build_id)}
              >
                {review === b.build_id ? "Hide review" : "Review"}
              </button>
              {b.status === "ready" && !b.approved ? (
                <button
                  type="button"
                  className="small primary"
                  onClick={() => {
                    setApproving(b);
                    setAck(false);
                  }}
                >
                  Approve…
                </button>
              ) : null}
              {b.approved && !b.active ? (
                <button
                  type="button"
                  className="small"
                  disabled={act.busy}
                  onClick={() => void act.run(() => rollback(b))}
                >
                  Activate this build
                </button>
              ) : null}
            </div>
            <div className="faint small mono">
              source {shortId(b.source_sha256)} · capabilities {shortId(b.capability_sha256)}
              {b.lockfile_sha256 ? ` · lock ${shortId(b.lockfile_sha256)}` : ""}
              {b.python?.environment_sha256
                ? ` · env ${shortId(b.python.environment_sha256)} (Python ${b.python.python_version}, ${b.python.packages?.length ?? 0} packages)`
                : ""}
            </div>
            {review === b.build_id ? (
              <BuildReview
                api={P}
                build={b}
                pid={props.pid}
                ext={props.ext}
                contribs={uiContribs}
              />
            ) : null}
          </div>
        ))}
        {checkoutBuild === undefined && e.checkout_build && e.errors === 0 ? (
          <p className="muted small">The checkout has changes that are not built yet.</p>
        ) : null}
        {latest ? null : null}
      </section>
      <section className="card">
        <h2>Python executions</h2>
        <ErrorBox error={execs.error} />
        {(execs.data?.executions ?? []).length === 0 ? <p className="faint small">None.</p> : null}
        {(execs.data?.executions ?? []).map((x: J) => (
          <div key={x.execution_id} className="small" style={{ marginBottom: 6 }}>
            <div className="row">
              <span className="mono">{x.execution_id}</span> <span>{x.contribution}</span>
              <Badge
                tone={x.status === "succeeded" ? "ok" : x.status === "running" ? "neutral" : "err"}
              >
                {x.status}
              </Badge>
              {x.progress ? (
                <span className="faint">
                  {x.progress.percent}% {x.progress.message ?? ""}
                </span>
              ) : null}
              {x.enforcement ? (
                <>
                  <Badge tone={x.enforcement.limits === "enforced" ? "ok" : "warn"}>
                    limits {x.enforcement.limits}
                  </Badge>
                  <Badge tone={x.enforcement.network === "enforced" ? "ok" : "warn"}>
                    network {x.enforcement.network}
                  </Badge>
                </>
              ) : null}
              <span className="faint">{fmtTime(x.created_at)}</span>
              <button
                type="button"
                className="small"
                onClick={async () => {
                  const r = await fetch(
                    `/api/v1/projects/${encodeURIComponent(props.pid)}/extension-executions/${x.execution_id}/log`,
                    { credentials: "same-origin" },
                  );
                  setLog({ id: x.execution_id, text: await r.text() });
                }}
              >
                Log
              </button>
            </div>
            {x.result ? (
              <div className="muted">
                {x.result.summary}
                {Object.keys(x.result.metrics ?? {}).length
                  ? ` · ${Object.entries(x.result.metrics)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(", ")}`
                  : ""}
                {x.mlflow_run_id ? (
                  <>
                    {" · "}
                    <Link to={`/p/${encodeURIComponent(props.pid)}/runs/r/${x.mlflow_run_id}`}>
                      MLflow run
                    </Link>
                  </>
                ) : null}
              </div>
            ) : null}
            {x.error ? <div className="faint">{x.error}</div> : null}
          </div>
        ))}
      </section>
      <section className="card">
        <h2>Developer console</h2>
        {(e.console ?? []).length === 0 ? <p className="faint small">No messages.</p> : null}
        <pre className="small" style={{ maxHeight: 260, overflow: "auto" }}>
          {(e.console ?? [])
            .map((l: J) => `${l.at} ${l.level} [${l.source}] ${l.message}`)
            .join("\n")}
        </pre>
      </section>
      {log ? (
        <Modal title={`Log ${log.id}`} onClose={() => setLog(undefined)}>
          <pre className="small" style={{ maxHeight: 480, overflow: "auto" }}>
            {log.text || "(empty)"}
          </pre>
        </Modal>
      ) : null}
      {approving ? (
        <Modal
          title={`Approve ${props.ext} ${approving.version}`}
          onClose={() => setApproving(undefined)}
          footer={
            <div className="row end">
              <button type="button" onClick={() => setApproving(undefined)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={!ack || act.busy}
                onClick={() =>
                  void act.run(async () => {
                    await approve(approving);
                    setApproving(undefined);
                  })
                }
              >
                Approve
              </button>
            </div>
          }
        >
          <p>
            This approves build <span className="mono">{approving.build_id}</span> in this project
            only: source <span className="mono">{shortId(approving.source_sha256)}</span>,
            capabilities <span className="mono">{shortId(approving.capability_sha256)}</span>
            {approving.lockfile_sha256 ? (
              <>
                , lockfile <span className="mono">{shortId(approving.lockfile_sha256)}</span>
              </>
            ) : null}
            . Any change to the code, lockfile, limits or capabilities makes a new build that needs
            its own approval.
          </p>
          <p className="small">Grants: {(approving.capabilities ?? []).join(", ") || "nothing"}.</p>
          <label className="row small">
            <input type="checkbox" checked={ack} onChange={(ev) => setAck(ev.target.checked)} />I
            reviewed the source. I understand its views run sandboxed and its Python runs as trusted
            code under my user.
          </label>
          <label className="stack small">
            Note (optional)
            <input value={note} onChange={(ev) => setNote(ev.target.value)} />
          </label>
        </Modal>
      ) : null}
    </div>
  );
}

function BuildReview(props: { api: string; build: J; pid: string; ext: string; contribs: J[] }) {
  const diff = useApi<J>(`${props.api}/builds/${props.build.build_id}/diff`);
  const [file, setFile] = useState<{ path: string; text: string }>();
  const open = async (path: string) => {
    const r = await fetch(
      `${props.api}/builds/${props.build.build_id}/file?path=${encodeURIComponent(path)}`,
      { credentials: "same-origin" },
    );
    setFile({ path, text: await r.text() });
  };
  const ui = (props.build.ui ?? []) as J[];
  return (
    <div className="stack" data-testid="build-review">
      <ErrorBox error={diff.error} />
      {diff.data ? (
        <div className="small">
          <strong>
            Changes against{" "}
            {diff.data.against ? (
              <span className="mono">{diff.data.against}</span>
            ) : (
              "nothing approved yet"
            )}
          </strong>
          {diff.data.capabilities_changed ? <Badge tone="warn">capabilities changed</Badge> : null}
          {diff.data.lockfile_changed ? <Badge tone="warn">lockfile changed</Badge> : null}
          {(diff.data.changes ?? []).map((c: J) => (
            <details key={c.path}>
              <summary>
                <Badge>{c.change}</Badge> <span className="mono">{c.path}</span>
              </summary>
              <div className="grid2">
                {c.before !== undefined ? (
                  <pre className="small diff-del">{c.before}</pre>
                ) : (
                  <div />
                )}
                {c.after !== undefined ? <pre className="small diff-add">{c.after}</pre> : <div />}
              </div>
            </details>
          ))}
        </div>
      ) : null}
      <div className="small">
        <strong>Files</strong>{" "}
        {(props.build.files ?? []).length ? null : <span className="faint">(see the diff)</span>}
      </div>
      {ui.length ? (
        <div className="stack">
          <strong className="small">Sandbox preview (no capabilities)</strong>
          {ui.map((u) => {
            const c = props.contribs.find((x) => x.id === u.contribution);
            if (!c) return null;
            const mount: ExtensionMount = {
              extension_id: props.ext,
              build_id: props.build.build_id,
              contribution: { id: c.id, point: c.point, title: c.title },
              frame_url: `/ext-frame/${encodeURIComponent(props.pid)}/${props.ext}/${props.build.build_id}/${c.id}`,
              capabilities: [],
              trusted_code: false,
            };
            return <ExtensionFrame key={u.contribution} pid={props.pid} mount={mount} preview />;
          })}
        </div>
      ) : null}
      <button type="button" className="small" onClick={() => void open("manifest.json")}>
        View manifest.json
      </button>
      {file ? (
        <Modal title={file.path} onClose={() => setFile(undefined)}>
          <pre className="small" style={{ maxHeight: 520, overflow: "auto" }}>
            {file.text}
          </pre>
        </Modal>
      ) : null}
    </div>
  );
}

/** Contributions for one point, as frames (project panels, demos, comparison views). */
export function ExtensionMounts(props: {
  pid: string;
  point: string;
  context?: { run_id?: string; run_ids?: string[]; report_id?: string };
  empty?: ReactNode;
}) {
  const r = useApi<{ mounts: ExtensionMount[] }>(
    `/api/v1/projects/${encodeURIComponent(props.pid)}/extension-mounts?point=${encodeURIComponent(props.point)}`,
  );
  useEvents(() => r.reload(), {
    project: props.pid,
    types: ["extension.activated", "extension.disabled"],
  });
  const mounts = r.data?.mounts ?? [];
  if (!mounts.length) return <>{props.empty ?? null}</>;
  return (
    <div className="stack">
      {mounts.map((m) => (
        <ExtensionFrame
          key={`${m.extension_id}/${m.contribution.id}/${m.build_id}`}
          pid={props.pid}
          mount={m}
          {...(props.context ? { context: props.context } : {})}
        />
      ))}
    </div>
  );
}

/** `project.action` buttons. */
export function ExtensionActions(props: { pid: string }) {
  const r = useApi<{ mounts: ExtensionMount[] }>(
    `/api/v1/projects/${encodeURIComponent(props.pid)}/extension-mounts?point=project.action`,
  );
  useEvents(() => r.reload(), {
    project: props.pid,
    types: ["extension.activated", "extension.disabled"],
  });
  const [done, setDone] = useState<string>();
  const run = useAction(async (m: ExtensionMount) => {
    const out = await api<J>(
      `/api/v1/projects/${encodeURIComponent(props.pid)}/extensions/${encodeURIComponent(m.extension_id)}/actions/${encodeURIComponent(m.contribution.id)}`,
      { body: {} },
    );
    setDone(`${m.contribution.title}: ${JSON.stringify(out.result)}`);
  });
  const mounts = r.data?.mounts ?? [];
  if (!mounts.length) return null;
  return (
    <section className="card" data-testid="extension-actions">
      <h2>Extension actions</h2>
      <ErrorBox error={run.error} />
      <div className="row">
        {mounts.map((m) => (
          <button
            key={`${m.extension_id}/${m.contribution.id}`}
            type="button"
            disabled={run.busy}
            onClick={() => void run.run(m)}
            title={`${m.extension_id}`}
          >
            {m.contribution.title}
          </button>
        ))}
      </div>
      {done ? <p className="faint small">{done}</p> : null}
    </section>
  );
}

/** Where a project panel lives: its own page in the project (`/p/<id>/x/<ext>/<contribution>`). */
export function panelPath(m: Pick<ExtensionMount, "extension_id" | "contribution">): string {
  return `/x/${encodeURIComponent(m.extension_id)}/${encodeURIComponent(m.contribution.id)}`;
}

/** The project's enabled `project.panel` contributions (navigation, Overview links). */
export function useProjectPanels(pid: string | undefined): ExtensionMount[] {
  const r = useApi<{ mounts: ExtensionMount[] }>(
    pid
      ? `/api/v1/projects/${encodeURIComponent(pid)}/extension-mounts?point=project.panel`
      : undefined,
  );
  useEvents(() => r.reload(), {
    ...(pid ? { project: pid } : {}),
    types: ["extension.activated", "extension.disabled"],
  });
  return r.data?.mounts ?? [];
}

/**
 * Overview lists project panels as links. A panel is mounted only on its own page, so opening
 * Overview never starts an extension's Python (a panel may load a whole project environment).
 */
export function ExtensionPanelLinks(props: { pid: string; base: string }) {
  const panels = useProjectPanels(props.pid);
  if (!panels.length) return null;
  return (
    <section className="card" data-testid="extension-panels">
      <h2>Extension panels</h2>
      <div className="stack">
        {panels.map((m) => (
          <div key={`${m.extension_id}/${m.contribution.id}`} className="row small">
            <Link to={`${props.base}${panelPath(m)}`}>{m.contribution.title}</Link>
            <span className="faint mono">{m.extension_id}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** A project panel on its own full-width page. */
export function ExtensionPanelPage(props: { pid: string; base: string; rest: string }) {
  const project = usePageProject();
  const [ext, contribution] = props.rest
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  const r = useApi<{ mounts: ExtensionMount[] }>(
    `/api/v1/projects/${encodeURIComponent(props.pid)}/extension-mounts?point=project.panel`,
  );
  useEvents(() => r.reload(), {
    project: props.pid,
    types: ["extension.activated", "extension.disabled"],
  });
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Loading />;
  const m = r.data.mounts.find((x) => x.extension_id === ext && x.contribution.id === contribution);
  if (!m)
    return (
      <section className="card">
        <h2>Panel not available</h2>
        <p className="muted">
          No enabled panel <code>{contribution}</code> of <code>{ext}</code> in this project.{" "}
          <Link to={`${props.base}/settings/extensions/${encodeURIComponent(ext ?? "")}`}>
            Open the extension
          </Link>
          .
        </p>
      </section>
    );
  return (
    <div data-testid="extension-panel-page">
      <TrailLeaf>{m.contribution.title}</TrailLeaf>
      <PageHead
        eyebrow={project ? `${project} · extension ${m.extension_id}` : m.extension_id}
        title={m.contribution.title}
      />
      <ExtensionFrame pid={props.pid} mount={m} minHeight={640} />
    </div>
  );
}
