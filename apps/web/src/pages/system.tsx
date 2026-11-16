/**
 * System (spec §2.2, §5.6 Operations, §13): startup diagnostics, safe mode, sidecar health, delivery
 * backlog, backups and restore, the artifact store, and build information.
 */
import { useState } from "react";
import { api, useApi } from "../api.ts";
import {
  Badge,
  Empty,
  ErrorBox,
  KV,
  Link,
  Loading,
  Modal,
  type Tone,
  useAction,
} from "../components/ui.tsx";
import { fmtBytes, fmtTime, shortId } from "../lib/format.ts";

interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
}

const tone = (s: string): Tone => (s === "ok" ? "ok" : s === "warn" ? "warn" : "err");

/** Settings → System (`/system`): the coordinator's operations, for the Settings page's tab. */
export function SystemSection() {
  const status = useApi<{
    sidecar: Record<string, unknown>;
    outbox: { pending: number; failed: number; bytes: number; oldest_enqueued_at?: string };
    last_contact_at?: string;
    last_transport_error?: string;
  }>("/api/v1/tracking/status", { pollMs: 5000 });
  const doctor = useApi<{ status: string; checks: DoctorCheck[] }>("/api/v1/tracking/doctor");
  const outbox = useApi<{
    entries: {
      op_id: string;
      kind: string;
      project_id: string;
      ref?: string;
      state: string;
      attempts: number;
      last_error?: { message: string };
      enqueued_at: string;
    }[];
  }>("/api/v1/tracking/outbox?limit=100", { pollMs: 5000 });
  const backups = useApi<{
    backups: {
      backup_id: string;
      created_at: string;
      reason: string;
      files: number;
      bytes: number;
      source?: { hostname: string };
    }[];
    pending_restore: { backup_id: string; requested_at: string } | null;
  }>("/api/v1/backups");
  const coord = useApi<{
    pid: number;
    started_at: string;
    urls: Record<string, string>;
    startup: { findings: unknown[]; repairs: string[] };
    projects: number;
    event_seq: number;
  }>("/api/v1/coordinator/status");

  const backup = useAction(async () => {
    await api("/api/v1/backups", { body: {} });
    backups.reload();
  });
  const [verified, setVerified] = useState<Record<string, { ok: boolean; problems: string[] }>>({});
  const verify = useAction(async (id: string) => {
    const r = await api<{ ok: boolean; problems: string[] }>(
      `/api/v1/backups/${encodeURIComponent(id)}/verify`,
      { body: {} },
    );
    setVerified((v) => ({ ...v, [id]: r }));
  });
  const [confirming, setConfirming] = useState<string | undefined>();
  const restore = useAction(async (id: string) => {
    await api(`/api/v1/backups/${encodeURIComponent(id)}/restore`, { body: {} });
    setConfirming(undefined);
    backups.reload();
  });
  const cancelRestore = useAction(async () => {
    await api("/api/v1/backups/restore", { method: "DELETE" });
    backups.reload();
  });
  const retry = useAction(async (id: string) => {
    await api(`/api/v1/tracking/outbox/${encodeURIComponent(id)}/retry`, { body: {} });
    outbox.reload();
    status.reload();
  });

  const sc = status.data?.sidecar ?? {};
  return (
    <div className="stack">
      <p className="muted">MLflow sidecar, delivery backlog, backups and build information.</p>
      <Operations />
      <div className="grid2">
        <section className="card">
          <h2>MLflow sidecar</h2>
          <ErrorBox error={status.error} />
          {status.data ? (
            <KV
              rows={[
                [
                  "state",
                  <Badge
                    key="s"
                    tone={sc["state"] === "healthy" || sc["state"] === "external" ? "ok" : "err"}
                  >
                    {String(sc["state"])}
                  </Badge>,
                ],
                ["pinned version", String(sc["pinned_version"] ?? "—")],
                ["installed", String(sc["installed_version"] ?? "—")],
                ["restarts", String(sc["restarts"] ?? 0)],
                ["last contact", fmtTime(status.data.last_contact_at)],
                ["last transport error", status.data.last_transport_error ?? "—"],
              ]}
            />
          ) : (
            <Loading />
          )}
        </section>
        <section className="card">
          <h2>
            Tracking doctor{" "}
            {doctor.data ? (
              <Badge tone={tone(doctor.data.status)}>{doctor.data.status}</Badge>
            ) : null}
            <button
              type="button"
              className="small"
              onClick={doctor.reload}
              style={{ marginLeft: "auto" }}
            >
              Re-run
            </button>
          </h2>
          <ErrorBox error={doctor.error} />
          {doctor.data?.checks.map((c) => (
            <div key={c.name} className="row small">
              <Badge tone={tone(c.status)}>{c.status}</Badge>
              <strong>{c.name}</strong>
              <span className="muted">{c.detail}</span>
            </div>
          )) ?? <Loading />}
        </section>
      </div>
      <section className="card">
        <h2>
          Delivery backlog{" "}
          {status.data ? (
            <>
              <Badge tone={status.data.outbox.pending ? "warn" : "ok"}>
                {status.data.outbox.pending} pending
              </Badge>
              <Badge tone={status.data.outbox.failed ? "err" : "ok"}>
                {status.data.outbox.failed} failed
              </Badge>
              <span className="faint small">{fmtBytes(status.data.outbox.bytes)}</span>
            </>
          ) : null}
        </h2>
        <ErrorBox error={retry.error ?? outbox.error} />
        {outbox.data && outbox.data.entries.length === 0 ? (
          <p className="muted small">Every MLflow write has been delivered.</p>
        ) : null}
        {outbox.data?.entries.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Op</th>
                  <th>Kind</th>
                  <th>Project / ref</th>
                  <th>State</th>
                  <th>Tries</th>
                  <th>Last error</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {outbox.data.entries.map((e) => (
                  <tr key={e.op_id}>
                    <td className="mono small">{e.op_id}</td>
                    <td>{e.kind}</td>
                    <td className="small">
                      {e.project_id}
                      {e.ref ? <div className="mono faint">{e.ref}</div> : null}
                    </td>
                    <td>
                      <Badge tone={e.state === "failed" ? "err" : "warn"}>{e.state}</Badge>
                    </td>
                    <td className="num">{e.attempts}</td>
                    <td className="small wrap">{e.last_error?.message ?? ""}</td>
                    <td>
                      {e.state === "failed" ? (
                        <button
                          type="button"
                          className="small"
                          disabled={retry.busy}
                          onClick={() => void retry.run(e.op_id)}
                        >
                          Retry
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      <div className="grid2">
        <section className="card" data-testid="backups">
          <h2>
            Backups
            <button
              type="button"
              className="small primary"
              style={{ marginLeft: "auto" }}
              disabled={backup.busy}
              onClick={() => void backup.run()}
            >
              {backup.busy ? "Backing up…" : "Create backup"}
            </button>
          </h2>
          <ErrorBox
            error={
              backup.error ?? verify.error ?? restore.error ?? cancelRestore.error ?? backups.error
            }
          />
          {backups.data?.pending_restore ? (
            <div className="banner warn row small" data-testid="pending-restore">
              <span>
                Restore of <span className="mono">{backups.data.pending_restore.backup_id}</span> is
                scheduled for the next start (<code>ablationkit coordinator restart</code>).
              </span>
              <button
                type="button"
                className="small"
                disabled={cancelRestore.busy}
                onClick={() => void cancelRestore.run()}
              >
                Cancel
              </button>
            </div>
          ) : null}
          {backups.data?.backups.length === 0 ? <Empty>No backups yet.</Empty> : null}
          {backups.data?.backups
            .slice()
            .reverse()
            .map((b) => {
              const v = verified[b.backup_id];
              return (
                <div key={b.backup_id} className="stack" style={{ marginBottom: 6 }}>
                  <div className="row small">
                    <span className="mono">{b.backup_id}</span>
                    <span className="faint">{fmtTime(b.created_at)}</span>
                    <Badge>{b.reason.replace("_", " ")}</Badge>
                    {b.source ? <span className="faint">from {b.source.hostname}</span> : null}
                    <span className="faint">
                      {b.files} files · {fmtBytes(b.bytes)}
                    </span>
                    {v ? (
                      <Badge tone={v.ok ? "ok" : "err"} title={v.problems.join("\n")}>
                        {v.ok ? "verified" : `damaged (${v.problems.length})`}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="row small">
                    <button
                      type="button"
                      className="small"
                      disabled={verify.busy}
                      onClick={() => void verify.run(b.backup_id)}
                    >
                      Verify
                    </button>
                    <a
                      className="button small"
                      href={`/api/v1/backups/${encodeURIComponent(b.backup_id)}/archive`}
                      download
                    >
                      Download archive
                    </a>
                    <button
                      type="button"
                      className="small"
                      disabled={
                        restore.busy || backups.data?.pending_restore?.backup_id === b.backup_id
                      }
                      onClick={() => setConfirming(b.backup_id)}
                    >
                      Restore at next start…
                    </button>
                  </div>
                </div>
              );
            })}
          {confirming ? (
            <Modal
              title="Restore at the next start"
              onClose={() => setConfirming(undefined)}
              footer={
                <>
                  <button type="button" onClick={() => setConfirming(undefined)}>
                    Keep the current state
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={restore.busy}
                    onClick={() => void restore.run(confirming)}
                  >
                    Schedule the restore
                  </button>
                </>
              }
            >
              <p>
                At the next coordinator start, backup <span className="mono">{confirming}</span>{" "}
                replaces this coordinator&apos;s research, jobs, settings and MLflow data.
              </p>
              <p className="small muted">
                Everything changed since the backup is moved aside to{" "}
                <code>{"<home>"}.pre-restore-…</code>, not deleted. Every browser and CLI logs in
                again. The running coordinator is unchanged until you restart it.
              </p>
              <ErrorBox error={restore.error} />
            </Modal>
          ) : null}
          <p className="faint small" style={{ marginTop: 8 }}>
            A backup holds the MLflow database snapshot and artifacts, coordinator state, settings,
            compute targets and each project&apos;s research files. On another machine:{" "}
            <code>ablationkit backup restore ARCHIVE --project ID=PATH</code>. To hand this
            coordinator to another machine, stop it and run{" "}
            <code>ablationkit coordinator move --out FILE</code>.
          </p>
        </section>
        <section className="card">
          <h2>Coordinator and build</h2>
          {coord.data ? (
            <KV
              rows={[
                ["pid", String(coord.data.pid)],
                ["started", fmtTime(coord.data.started_at)],
                ["human API", coord.data.urls["human"] ?? "—"],
                ["projects", String(coord.data.projects)],
                ["event journal", `seq ${coord.data.event_seq}`],
                [
                  "startup repairs",
                  coord.data.startup.repairs.length
                    ? coord.data.startup.repairs.join("; ")
                    : "none",
                ],
              ]}
            />
          ) : (
            <Loading />
          )}
          <SourceBuilds />
        </section>
      </div>
    </div>
  );
}

// biome-ignore lint/suspicious/noExplicitAny: coordinator JSON rendered for people
type J = any;

/**
 * Level 2 builds (spec §8.5, criterion 15c): what runs now, whether it is a modified build, and
 * reviewable builds made with `ablationkit dev build`. Activating one takes
 * effect at the next coordinator start; the running coordinator is never replaced in place.
 */
function SourceBuilds() {
  const b = useApi<{ build: J; builds: J[] }>("/api/v1/system/build");
  const act = useAction(async (fn: () => Promise<unknown>) => {
    await fn();
    b.reload();
  });
  if (!b.data) return <ErrorBox error={b.error} />;
  const st = b.data.build;
  return (
    <div className="stack" style={{ marginTop: 10 }} data-testid="source-builds">
      <ErrorBox error={act.error} />
      <div className="row small">
        <strong>Running</strong>
        <span className="mono">{shortId(st.running?.commit, 12)}</span>
        {st.running?.branch ? <span className="mono">{st.running.branch}</span> : null}
        {st.modified ? (
          <Badge tone="warn">modified build {st.running.modified_build}</Badge>
        ) : (
          <Badge tone="ok">original install</Badge>
        )}
        {st.running?.dirty ? (
          <Badge tone="warn">uncommitted changes in the running tree</Badge>
        ) : null}
      </div>
      <div className="small">
        Next start runs{" "}
        <span className="mono">{st.next_start?.build_id ?? "the original install"}</span>
        {st.restart_required ? (
          <Badge tone="warn">restart to apply: ablationkit coordinator stop &amp;&amp; start</Badge>
        ) : null}
        {st.next_start?.build_id ? (
          <button
            type="button"
            className="small"
            disabled={act.busy}
            onClick={() =>
              void act.run(() => api("/api/v1/system/builds/deactivate", { body: {} }))
            }
          >
            Use the original install
          </button>
        ) : null}
      </div>
      {(b.data.builds ?? []).length === 0 ? (
        <p className="faint small">
          No modified builds. A coding agent makes one with <code>ablationkit dev build</code> from
          its branch (docs/contributing/source-changes.md).
        </p>
      ) : null}
      {(b.data.builds ?? []).map((x: J) => (
        <details key={x.build_id}>
          <summary className="row small">
            <span className="mono">{x.build_id}</span>
            <span className="mono">{x.branch}</span>
            <Badge tone={x.status === "ready" ? "ok" : "err"}>{x.status}</Badge>
            <span className="faint">
              {x.changed_files.length} files vs {x.base_ref} · {fmtTime(x.created_at)}
            </span>
            {x.status === "ready" && st.next_start?.build_id !== x.build_id ? (
              <button
                type="button"
                className="small"
                disabled={act.busy}
                onClick={() =>
                  void act.run(() =>
                    api(`/api/v1/system/builds/${x.build_id}/activate`, { body: {} }),
                  )
                }
              >
                Activate for next start
              </button>
            ) : null}
          </summary>
          <div className="small">
            {x.checks.map((c: J) => (
              <div key={c.command}>
                <Badge
                  tone={c.status === "passed" ? "ok" : c.status === "skipped" ? "warn" : "err"}
                >
                  {c.status}
                </Badge>{" "}
                <span className="mono">{c.command}</span>
              </div>
            ))}
            {x.diffstat ? <pre className="small">{x.diffstat}</pre> : null}
          </div>
        </details>
      ))}
    </div>
  );
}

interface Operations {
  diagnostics: {
    at: string;
    status: "ok" | "warn" | "fail";
    checks: { name: string; status: "ok" | "warn" | "fail"; detail: string; items?: string[] }[];
  };
  safe_mode: boolean;
  restored: {
    backup_id: string;
    backup_reason: string;
    backup_created_at: string;
    restored_at: string;
    source?: { hostname: string };
    projects: { project_id: string; to_path: string; checkout: string }[];
    warnings: string[];
    extension_envs: string[];
  } | null;
  artifact_store: {
    configured: boolean;
    endpoint?: string;
    bucket?: string;
    prefix?: string;
    key_env?: string[];
    keys_set?: boolean;
    reachable?: boolean;
    error?: string;
  };
}

/**
 * Startup diagnostics (spec §13), the safe-mode recovery view (§8.3), the last restore and the
 * remote artifact store. Diagnostics re-run on demand; they never repair anything.
 */
function Operations() {
  const ops = useApi<Operations>("/api/v1/system/operations");
  const projects = useApi<{ projects: { project_id: string; name: string }[] }>("/api/v1/projects");
  const d = ops.data;
  return (
    <div className="stack">
      <ErrorBox error={ops.error} />
      {d?.safe_mode ? (
        <section className="card banner warn" data-testid="safe-mode">
          <h2>
            Safe mode <Badge tone="warn">every extension is inactive</Badge>
          </h2>
          <p className="small">
            The coordinator booted with <code>--safe-mode</code>: no extension view mounts and no
            extension code runs. Core research, runs, models and agents work as usual. Review,
            disable or roll back extensions per project, then restart normally with{" "}
            <code>ablationkit coordinator restart</code>.
          </p>
          <div className="row small">
            {(projects.data?.projects ?? []).map((p) => (
              <Link key={p.project_id} to={`/p/${p.project_id}/settings/extensions`}>
                {p.name || p.project_id}: extensions
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      <div className="grid2">
        <section className="card" data-testid="diagnostics">
          <h2>
            Startup diagnostics{" "}
            {d ? <Badge tone={tone(d.diagnostics.status)}>{d.diagnostics.status}</Badge> : null}
            <button
              type="button"
              className="small"
              onClick={ops.reload}
              style={{ marginLeft: "auto" }}
            >
              Re-run
            </button>
          </h2>
          {d ? (
            d.diagnostics.checks.map((c) => (
              <details key={c.name} open={c.status !== "ok" && (c.items?.length ?? 0) > 0}>
                <summary className="row small">
                  <Badge tone={tone(c.status)}>{c.status}</Badge>
                  <strong>{c.name}</strong>
                  <span className="muted">{c.detail}</span>
                </summary>
                {c.items?.length ? (
                  <ul className="small mono" style={{ margin: "4px 0 8px 24px" }}>
                    {c.items.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                ) : null}
              </details>
            ))
          ) : (
            <Loading />
          )}
        </section>
        <section className="card">
          <h2>Restore and remote artifacts</h2>
          {d?.restored ? (
            <div className="stack small" data-testid="restored">
              <div>
                Restored from <span className="mono">{d.restored.backup_id}</span> (
                {d.restored.backup_reason.replace("_", " ")}, taken{" "}
                {fmtTime(d.restored.backup_created_at)}
                {d.restored.source ? ` on ${d.restored.source.hostname}` : ""}) at{" "}
                {fmtTime(d.restored.restored_at)}.
              </div>
              {d.restored.projects.map((p) => (
                <div key={p.project_id} className="row">
                  <span className="mono">{p.project_id}</span>
                  <span className="mono faint">{p.to_path}</span>
                  <Badge tone={p.checkout === "present" ? "ok" : "warn"}>
                    {p.checkout.replace("_", " ")}
                  </Badge>
                </div>
              ))}
              {d.restored.extension_envs.length ? (
                <div className="faint">
                  {d.restored.extension_envs.length} Python extension environment(s) are rebuilt
                  from their lockfile on first use.
                </div>
              ) : null}
              {d.restored.warnings.map((w) => (
                <div key={w} className="faint">
                  · {w}
                </div>
              ))}
            </div>
          ) : (
            <p className="faint small">This coordinator was not restored from a backup.</p>
          )}
          <h3 className="small" style={{ marginTop: 12 }}>
            S3-compatible artifact store
          </h3>
          {d ? (
            d.artifact_store.configured ? (
              <KV
                rows={[
                  ["endpoint", d.artifact_store.endpoint ?? "—"],
                  ["bucket / prefix", `${d.artifact_store.bucket} / ${d.artifact_store.prefix}`],
                  [
                    "keys",
                    d.artifact_store.keys_set
                      ? `set (${d.artifact_store.key_env?.join(", ")})`
                      : `missing: set ${d.artifact_store.key_env?.join(" and ")} for the coordinator`,
                  ],
                  [
                    "reachable",
                    <Badge key="r" tone={d.artifact_store.reachable ? "ok" : "err"}>
                      {d.artifact_store.reachable ? "yes" : (d.artifact_store.error ?? "no")}
                    </Badge>,
                  ],
                ]}
              />
            ) : (
              <p className="faint small">
                Not configured: remote workers upload artifacts through the coordinator (
                <code>remote.artifact_store</code> in settings.json adds one).
              </p>
            )
          ) : null}
        </section>
      </div>
    </div>
  );
}
