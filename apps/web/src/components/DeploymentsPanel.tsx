/**
 * Deployments of a project (§7.7.4 item 5; ADR 0023 decision 20): what was requested, what runs,
 * where, until when, and who supervises it. A research endpoint on Runpod is supervised by the
 * provider and keeps serving while the coordinator is off; a local preview stops with it.
 */
import { api, useApi, useEvents } from "../api.ts";
import { fmtTime } from "../lib/format.ts";
import { Badge, Empty, ErrorBox, Loading, type Tone, useAction } from "./ui.tsx";

interface Deployment {
  deployment_id: string;
  kind: string;
  target: string;
  model_uri: string;
  exposure: string;
  status: string;
  status_reason?: string;
  expires_at?: string;
  endpoint?: string;
  provider?: {
    target_kind: string;
    provider_ref: string;
    independent_supervision: boolean;
    state?: string;
    checked_at?: string;
    estimate_cents?: number;
  };
}

const tone = (s: string): Tone =>
  s === "running" ? "ok" : s === "failed" || s === "blocked" ? "err" : "neutral";

export function DeploymentsPanel(props: { pid: string }) {
  const path = `/api/v1/projects/${encodeURIComponent(props.pid)}/deployments`;
  const d = useApi<{ deployments: Deployment[] }>(path);
  useEvents(() => d.reload(), { types: ["deployment.updated"] });
  const stop = useAction(async (id: string) => {
    await api(`${path}/${encodeURIComponent(id)}/stop`, { body: {} });
    d.reload();
  });
  return (
    <section className="card" data-testid="deployments">
      <h2>Deployments</h2>
      <p className="faint small">
        Agents request deployments through <span className="mono">ablationkit mcp</span>; the
        project policy decides. A research endpoint runs on its provider until it expires, even
        while this workstation is off; a local preview stops with the coordinator.
      </p>
      <ErrorBox error={d.error ?? stop.error} />
      {!d.data ? <Loading /> : null}
      {d.data && d.data.deployments.length === 0 ? <Empty>No deployments.</Empty> : null}
      {d.data && d.data.deployments.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Model</th>
              <th>Target</th>
              <th>Status</th>
              <th>Endpoint</th>
              <th>Supervision</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.data.deployments.map((x) => (
              <tr key={x.deployment_id}>
                <td>{x.kind.replaceAll("_", " ")}</td>
                <td className="mono small">{x.model_uri}</td>
                <td>{x.target}</td>
                <td title={x.status_reason ?? ""}>
                  <Badge tone={tone(x.status)}>{x.status.replaceAll("_", " ")}</Badge>
                </td>
                <td className="mono small">{x.endpoint ?? "—"}</td>
                <td className="small">
                  {x.provider?.independent_supervision ? (
                    <span
                      title={`${x.provider.provider_ref}${x.provider.checked_at ? `, checked ${fmtTime(x.provider.checked_at)}` : ""}`}
                    >
                      {x.provider.target_kind} ({x.provider.state ?? "unchecked"})
                      {x.provider.estimate_cents !== undefined
                        ? ` · est. ${x.provider.estimate_cents}¢`
                        : ""}
                    </span>
                  ) : x.status === "running" ? (
                    "this coordinator"
                  ) : (
                    "—"
                  )}
                </td>
                <td className="small">{x.expires_at ? fmtTime(x.expires_at) : "—"}</td>
                <td>
                  {["running", "approved"].includes(x.status) ? (
                    <button
                      type="button"
                      className="small"
                      disabled={stop.busy}
                      onClick={() => void stop.run(x.deployment_id)}
                    >
                      Stop
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
