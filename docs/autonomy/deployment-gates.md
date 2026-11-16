# Deployment gates

A deployment is a model served somewhere for research (spec §7.7.4 item 5). There are four kinds:

- a loopback preview;
- a remote research endpoint;
- a persistent endpoint;
- a public endpoint.

Each kind is its own gate in the [project policy](project-permissions.md). Starting a demo or registering a model never grants permission to expose an endpoint. The gates were designed in ADR 0018 (decision 10). Since ADR 0037 there are no approvals: a gate allows or denies.

## A request

An agent requests one with the `ablationkit_do deployment.request` MCP tool; the researcher through the human API (`POST /api/v1/projects/:id/deployments`). The body, for example:

```json
{ "kind": "remote_research", "model_uri": "models:/width/3", "target": "pods",
  "exposure": "tailnet", "ttl_minutes": 60, "max_cents": 500 }
```

| Field | Rule |
| --- | --- |
| `model_uri` | Pinned: `models:/<name>/<version>` or `runs:/<run>/<path>`. Aliases, stages and `latest` are refused (`model_not_pinned`). |
| `target` | `local` for a preview, a configured target ID otherwise. For an agent, checked against the gate's `allowed_targets` (target IDs or kinds). |
| `exposure` | `loopback`, `tailnet` or `public`. A preview is loopback only. |
| `ttl_minutes` | Required. For an agent, at most the gate's `max_runtime_minutes`. |
| `max_cents` | Optional spend ceiling. On a paid target the request carries the rate-card estimate, and a ceiling below it is refused (409 `over_spend_ceiling`). |

## Who decides

- **An agent's request is decided by the project policy alone.**
  - `allow` starts the deployment when every condition on the gate passes: exposure, targets, runtime cap.
  - `deny`, or a failed condition, makes it `blocked`. The reasons name the policy field, and the refusal is audited.
  - The defaults: `preview_local` allow; `remote_research`, `persistent` and `public` deny.
- **A researcher's own request is theirs to make.** It is not checked against the agent policy.
- **A public endpoint never starts, for anyone (§7.1).** A policy that sets `public` to `allow` is refused at validation.

An allowed request is started at once, with `expires_at` = start + TTL.

## What starts

| Kind | Launched as |
| --- | --- |
| `preview_local` | An inference session on this machine, reachable only through the coordinator. |
| `remote_research` | A pod on a configured Runpod target, with `exposure: tailnet` and `runpod.tailscale_authkey_secret` set. [How it is served](#how-a-research-endpoint-is-served). |
| `persistent`, `public` | Recorded, never launched by AblationKit v1 (`failed`, `unsupported_deployment`). |

### How a research endpoint is served

- **Model.** The pod downloads the pinned model with a per-deployment token and checks its SHA-256.
- **Serving.** It serves the model with `runpod.serve_command` (default `mlflow models serve`) on `http://ak-<deployment>:<serve_port>` until the deployment expires.
- **Expiry.** The pod enforces it itself, but only advisorily: it removes itself with `runpodctl`. The sweeper also removes it (ADR 0023 decision 20).

If no launcher can serve a kind, the deployment is marked `failed` with the reason (for example `launcher_unavailable`), and nothing is shown as running.

The Inference page lists the project's deployments with their endpoint, who supervises them and the provider's last state.

## Lifecycle

```
approved → running → stopped | expired
blocked | invalidated | failed
```

- **TTL.** A sweeper stops running deployments when their TTL ends (`expired`).
- **Stopping.** `deployment stop ID` stops one at once.
- **Audit.** Every request, start, stop and expiry is audited with the model, target, exposure, TTL and policy revision.
- **Policy changes.** A policy reduction applies to the next request. It does not stop a deployment that is already running.

After a coordinator restart:

- **Local deployments** that were running are marked `stopped`, because their process did not survive.
- **Provider-supervised research endpoints** (`provider.independent_supervision`) stay `running`. The coordinator asks the provider, and marks the endpoint `stopped` only when the pod is gone (criterion 12). An endpoint that expired in the meantime is expired and removed.
- **Authorized but never started:** marked `invalidated`, and must be requested again.
- **Deployments that were waiting for an approval** before ADR 0037 load as `invalidated`.

Nothing queued starts on its own (criterion 34).

## What is enforced

- **The gate is enforced.** AblationKit starts nothing the policy (for an agent) or the researcher did not ask for.
- **TTLs are enforced by the coordinator's sweeper** for everything it launched.
- **A pod's own self-removal is advisory.**
