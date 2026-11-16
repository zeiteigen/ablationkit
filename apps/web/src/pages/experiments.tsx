/**
 * Experiments (spec §5.6 Experiments row): the project's `ak/` experiment and read-only imports,
 * plus every MLflow experiment: create, rename, filter, archive/restore, and link a historical
 * experiment to this project (read-only import).
 */
import { useState } from "react";
import { api, qs, useApi } from "../api.ts";
import { Badge, Empty, ErrorBox, Link, Loading, Modal, useAction } from "../components/ui.tsx";
import { fmtTime } from "../lib/format.ts";
import type { Experiment } from "../lib/types.ts";

export function ExperimentsPage(props: { pid: string }) {
  const mine = useApi<{ experiments: Experiment[] }>(
    `/api/v1/tracking/experiments?project=${encodeURIComponent(props.pid)}`,
  );
  const [view, setView] = useState("active");
  const [filterText, setFilterText] = useState("");
  const [filter, setFilter] = useState("");
  const [tokens, setTokens] = useState<string[]>([]);
  const all = useApi<{ experiments: Experiment[]; next_page_token?: string }>(
    `/api/v1/tracking/experiments${qs({ view, filter, max_results: 50, page_token: tokens.at(-1) })}`,
  );
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Experiment>();
  const reload = () => {
    mine.reload();
    all.reload();
  };

  const lifecycle = useAction(async (e: Experiment, to: "active" | "deleted") => {
    await api(`/api/v1/tracking/experiments/${encodeURIComponent(e.experiment_id)}`, {
      method: "PATCH",
      body: { lifecycle: to },
    });
    reload();
  });
  const link = useAction(async (e: Experiment) => {
    await api(`/api/v1/projects/${encodeURIComponent(props.pid)}/tracking/imports`, {
      body: { experiment_id: e.experiment_id },
    });
    reload();
  });

  return (
    <div className="stack">
      <section className="card">
        <h2>This project's experiments</h2>
        <ErrorBox error={mine.error} onRetry={mine.reload} />
        {!mine.data && !mine.error ? <Loading /> : null}
        {mine.data?.experiments.length === 0 ? (
          <Empty>The project experiment is still queued for MLflow.</Empty>
        ) : null}
        {mine.data?.experiments.map((e) => (
          <div key={e.experiment_id} className="row">
            <strong className="mono">{e.name}</strong>
            <Badge tone={e.ablationkit.role === "project" ? "info" : "neutral"}>
              {e.ablationkit.role === "project" ? "project experiment" : "imported · read-only"}
            </Badge>
            <span className="faint small">id {e.experiment_id}</span>
            <Link to={`/p/${encodeURIComponent(props.pid)}/runs`} className="small">
              runs →
            </Link>
          </div>
        ))}
      </section>
      <section className="card">
        <h2>
          All MLflow experiments
          <button
            type="button"
            className="primary small"
            style={{ marginLeft: "auto" }}
            onClick={() => setCreating(true)}
          >
            New experiment
          </button>
        </h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            setTokens([]);
            setFilter(filterText);
          }}
        >
          <input
            className="mono"
            placeholder="filter, e.g. name LIKE 'baseline%'"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
            aria-label="Experiment filter"
          />
          <select
            value={view}
            onChange={(e) => setView(e.target.value)}
            aria-label="Experiment view"
          >
            <option value="active">active</option>
            <option value="deleted">archived</option>
            <option value="all">all</option>
          </select>
          <button type="submit">Filter</button>
        </form>
        <ErrorBox error={all.error ?? lifecycle.error ?? link.error} onRetry={all.reload} />
        {all.data?.experiments.length ? (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table data-testid="experiments-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>ID</th>
                  <th>Role</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {all.data.experiments.map((e) => {
                  const isProject = e.ablationkit.role === "project";
                  const archived = e.lifecycle_stage === "deleted";
                  return (
                    <tr key={e.experiment_id}>
                      <td className="mono">
                        {e.name} {archived ? <Badge tone="warn">archived</Badge> : null}
                      </td>
                      <td className="small">{e.experiment_id}</td>
                      <td className="small">
                        {e.ablationkit.role}
                        {e.ablationkit.project_id ? ` · ${e.ablationkit.project_id}` : ""}
                      </td>
                      <td className="small">{fmtTime(e.creation_time)}</td>
                      <td>
                        <span className="row">
                          {!isProject && !e.ablationkit.read_only ? (
                            <button type="button" className="small" onClick={() => setRenaming(e)}>
                              Rename
                            </button>
                          ) : null}
                          {!isProject ? (
                            <button
                              type="button"
                              className="small"
                              onClick={() => void lifecycle.run(e, archived ? "active" : "deleted")}
                            >
                              {archived ? "Restore" : "Archive"}
                            </button>
                          ) : null}
                          {e.ablationkit.role === "other" && !archived ? (
                            <button
                              type="button"
                              className="small"
                              title="Link read-only to this project"
                              onClick={() => void link.run(e)}
                            >
                              Link to project
                            </button>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : all.data ? (
          <Empty>No experiments match.</Empty>
        ) : (
          <Loading />
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            disabled={!tokens.length}
            onClick={() => setTokens((t) => t.slice(0, -1))}
          >
            ← Previous
          </button>
          <button
            type="button"
            disabled={!all.data?.next_page_token}
            onClick={() => {
              const t = all.data?.next_page_token;
              if (t) setTokens((ts) => [...ts, t]);
            }}
          >
            Next →
          </button>
        </div>
      </section>
      {creating ? <CreateExperiment onClose={() => setCreating(false)} onDone={reload} /> : null}
      {renaming ? (
        <RenameExperiment exp={renaming} onClose={() => setRenaming(undefined)} onDone={reload} />
      ) : null}
    </div>
  );
}

function CreateExperiment(props: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const create = useAction(async () => {
    await api("/api/v1/tracking/experiments", { body: { name, confirm: true } });
    props.onDone();
    props.onClose();
  });
  return (
    <Modal
      title="New MLflow experiment"
      onClose={props.onClose}
      footer={
        <>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!name || create.busy}
            onClick={() => void create.run()}
          >
            Create
          </button>
        </>
      }
    >
      <p className="muted small">
        Project runs always go to the project's own <code>ak/&lt;project-id&gt;</code> experiment;
        names under <code>ak/</code> are reserved. Use separate experiments for work outside a
        project, then link them read-only.
      </p>
      <label className="field">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Experiment name"
        />
      </label>
      <ErrorBox error={create.error} />
    </Modal>
  );
}

function RenameExperiment(props: { exp: Experiment; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(props.exp.name);
  const save = useAction(async () => {
    await api(`/api/v1/tracking/experiments/${encodeURIComponent(props.exp.experiment_id)}`, {
      method: "PATCH",
      body: { name },
    });
    props.onDone();
    props.onClose();
  });
  return (
    <Modal
      title="Rename experiment"
      onClose={props.onClose}
      footer={
        <>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!name || save.busy}
            onClick={() => void save.run()}
          >
            Save
          </button>
        </>
      }
    >
      <label className="field">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="New experiment name"
        />
      </label>
      <ErrorBox error={save.error} />
    </Modal>
  );
}
