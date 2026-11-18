# Project permissions and the agent compute limit

Each project has its own **action policy**. It decides what an agent may ask AblationKit itself to do: run jobs on this machine, submit jobs to remote targets, start deployments, and how many weighted compute hours its jobs may use (spec §7.7, as amended by ADR 0037).

The policy does not cover what the agent does in its own session. The agent's shell, files, Git and network belong to the researcher's harness (Claude Code, Codex, T3 Code), with that harness's own sandbox and permission prompts. AblationKit makes no claim about them.

## Where the policy lives, and who can change it

- **Storage.** The coordinator keeps the policy as immutable revisions in `~/.ablationkit/state/<project>/policy/rev-NNNNNN.json`, outside every checkout. Each file is read-only (0400) and is never rewritten. Revision 0 is the built-in default: a new project has no file.
- **Who can change it.** Only the researcher, with their signed-in session on the human API. This works locally or over Tailscale; there is no passkey (ADR 0037). Two ways:
  - **Web UI:** Project settings → **Agent permissions**. One card with a plain-language row per permission, edited inline. Saving first shows the change as before → after sentences, then writes the next revision and shows its number and author.
  - **Human API:**
    - `POST /api/v1/projects/:id/policy/preview` returns the field-level diff (each change `widened`, `reduced` or `changed`) and writes nothing.
    - `POST /api/v1/projects/:id/policy/revisions` with `{"policy": {…}, "expect_revision": N}` saves the next revision.

  Every revision is audited as `policy.revised`, with its changes.
- **The agent API has no policy-edit route.** An agent reads a summary only: `GET /api/v1/projects/:id/access`, which the `ablationkit_project` MCP tool returns. The summary has the decisions, the targets and the compute limit with its usage, never the editable policy or a credential.
- **Repository files have no authority.** These never grant anything:
  - `.ablationkit/policy.request.json` and `.ablationkit/project.json`;
  - `AGENTS.md` and `CLAUDE.md`;
  - skills, prompts and generated files.

## The policy (schema version 2)

Every gate has a `decision`, `allow` or `deny`. There is no `ask`, because there is nothing to approve.

| Field | Meaning | Default (revision 0) |
| --- | --- | --- |
| `jobs.run_local` | Agents' jobs may be placed on this machine | `allow` |
| `jobs.submit_remote` | Agents' jobs may be placed on the remote targets in `allowed_targets` | `deny`, no targets |
| `deployments.preview_local` | An agent may start a loopback preview (an inference session on this machine) | `allow` |
| `deployments.remote_research` | An agent may start a research endpoint on a remote target | `deny` |
| `deployments.persistent` | Persistent endpoints. They are gated, but AblationKit never launches one | `deny` |
| `deployments.public` | Public endpoints. They are never started: a revision that allows one is refused | `deny` |
| `compute.limit_hours` | Weighted compute hours agent-submitted jobs may use in this project ([below](#the-agent-compute-limit)) | `10` |

- **`allowed_targets`** entries are either a target kind (`ssh`, `slurm`, `runpod`, `colab`; `slurm` allows every SLURM target) or a configured target's ID (`ablationkit target add`). `local` is not a remote target: that is `jobs.run_local`.
- **Deployment gates** may also carry an `exposure` (`loopback`, `tailnet`, `public`), their own `allowed_targets` and `max_runtime_minutes`. See [deployment-gates.md](deployment-gates.md).
- **Unknown actions and a missing policy** are `deny`.

### The pool: where agents' jobs run

An agent never chooses where its job runs (ADR 0068); it cannot name a target (400 `target_not_agents`). The two job gates together are the project's **pool**: this machine when `jobs.run_local` allows it, then each configured target `jobs.submit_remote` allows, in that order. AblationKit places each agent job on the first of them with a free slot:

- **Slots.** Each target has a number of slots: how many jobs needing a GPU run there at once. It is 1 by default, and 2 for a Colab target, whose account runs two runtimes. You set slots beside the weights on the Compute page (`PUT /api/v1/compute/weights` with `slots`). Every live GPU job counts, yours included, though your own jobs never wait.
- **The queue.** A job with no free slot in its pool is `queued`. Its `placement.waiting` says why, for example `every slot in the pool is busy (local 1/1, colab 2/2)`. Jobs are placed oldest first when a slot frees, when you add slots or change the policy, and every 15 seconds. A target that cannot start a job (its preflight, its runtime) is passed over for the next one in the pool with a free slot; the job fails, with `placement.error`, only when every target of its pool refused it, and waits for a busy one meanwhile. A refusal that is the coordinator's for the moment (the tracking outbox full) leaves it queued for the next pass.
- **Jobs without a GPU.** A job with `gpu: "none"` (tests, checks) runs on this machine at once, without a slot, when this machine is in the pool.
- **This machine only.** Protected evaluations and environment builds run only here; they need `jobs.run_local`.
- **An empty pool** refuses every agent job with 403 `policy_denied`.
- **What you see.** The Jobs page shows a queued job's state and what it waits for. Agent permissions in Project settings shows the pool with its busy slots. The agent reads the same in `ablationkit_project`.

### An example revision

```json
{
  "policy": {
    "jobs": {
      "run_local": {"decision": "allow"},
      "submit_remote": {"decision": "allow", "allowed_targets": ["slurm", "a100-pod"]}
    },
    "deployments": {
      "preview_local": {"decision": "allow", "exposure": "loopback", "max_runtime_minutes": 30},
      "remote_research": {"decision": "allow", "allowed_targets": ["runpod"], "exposure": "tailnet", "max_runtime_minutes": 120},
      "persistent": {"decision": "deny"},
      "public": {"decision": "deny"}
    },
    "compute": {"limit_hours": 40}
  },
  "expect_revision": 3
}
```

### What an agent's refusal looks like

- **Policy denial.** A denied job or deployment is refused with 403 `policy_denied`. The reasons name the policy field, for example `policy revision 3 sets jobs.submit_remote.decision to deny`, or `target pods is not in jobs.submit_remote.allowed_targets`. Every refusal is audited.
- **Paid targets.** When the policy allows a paid remote target, that counts as the researcher's acceptance of its cost. The agent cannot accept cost itself: an `accept_cost` it sends is ignored. A researcher's own paid submission still needs `accept_cost` (ADR 0023).

## Fails closed

The coordinator refuses a revision, and writes nothing, in these cases:

- **422 `invalid_policy`:** it does not match the schema.
- **422 `unsupported_policy`:** it asks for something AblationKit cannot enforce:
  - `deployments.public` set to `allow`;
  - a local preview with an exposure other than `loopback`;
  - an exposure other than `loopback`, `tailnet` or `public`;
  - a target entry that is neither a kind nor a target ID;
  - `local` in `jobs.submit_remote.allowed_targets`.
- **409 `revision_conflict`:** `expect_revision` is stale.

## Revisions written before ADR 0037

Version 1 revisions stay on disk as written. They are migrated to version 2 on every read, conservatively:

- `ask` becomes `deny`;
- `experiments.run_local` and `experiments.submit_remote` become `jobs.*`, keeping their target lists;
- deployment exposures, targets and runtime caps are kept, and an idle timeout becomes the runtime cap it acted as;
- `compute.limit_hours` gets its default (10);
- Git gates, checks, the network gate, edit and test gates, denied commands, `protected_evaluation` and the defaults block are dropped. What enforced them is gone.

A reduction takes effect at the next request. There are no pending approvals for it to invalidate.

## The agent compute limit

`compute.limit_hours` caps the **weighted compute hours** that **agent-submitted** jobs use in the project. Jobs a researcher submits never count.

### Weights

- **One weight per compute target, machine-wide.** `local` (this workstation) and every configured target each get a weight, for example `local` 1, a T4 target 1, an A100 target 3. A target without one has weight 1.
- **Values.** At most two decimals, from 0.01 to 1000. The weights are stored in hundredths in `~/.ablationkit/compute-weights.json`, which is backed up and restored.
- **Who sets them.** The researcher, on the Compute page's weights editor or with `PUT /api/v1/compute/weights` (session only, audited). Agents can read them: `GET /api/v1/compute/weights`.
- **History is never rewritten.** Each agent job records the weight in effect when it was submitted. A later change to a weight does not change what was already used.

### Accounting

- **Hours used** are, for every attempt of every agent-submitted job (retries included, even a researcher's retry), the attempt's wall time × the job's recorded weight.
  - A remote attempt counts the start and end times its worker or its import reports.
  - Usage never resets.
- **Hours reserved:** a live attempt also holds the rest of its time limit × the weight. A queued job holds its whole time limit × the heaviest weight in its pool; once placed, it counts at the weight of the target it was placed on.
- **Available hours** = limit − used − reserved, never below 0.

### Admission

The coordinator checks an agent's job when it is submitted, after the policy gives it a non-empty pool:

1. **A time limit is required.** Without `limits.runtime_max_sec` (`runtime_max_sec` on the `ablationkit_job submit` MCP tool), the job is refused with 400 `time_limit_required`.
2. **The job must fit.** It is admitted only if used + reserved + its time limit × the heaviest weight in its pool ≤ `compute.limit_hours`.

   Otherwise it is refused with 403 `compute_limit_reached`. The response carries the hours used, reserved, the limit, the hours available, the hours needed, the target and the weight. The refusal is audited.

### Notifications

- **Refusals.** The first refusal in a burst raises one notification ("An agent reached the compute limit for *project*"): `notification.raised`, plus a desktop notification where available. It also adds a `compute_limit` item to the Home inbox, linked to Project settings. The next admitted job, or a new policy revision, re-arms it.
- **Going over the limit.** Hours used can go over the limit after admission, for example through a remote clock or a late import. That notifies once per crossing.
- **State.** Both notices are kept in `~/.ablationkit/state/<project>/compute/limit.json`.

### Raising the limit

Raising the limit is a policy revision by the researcher: Agent permissions, or the revision API. Nothing raises it automatically, and usage is never reset.

### Reading usage

| Who | Where |
| --- | --- |
| Researcher | Project settings → Agent permissions (a used + reserved meter); the Compute page (per-project agent usage against each limit, and the weights); `GET /api/v1/compute` |
| Researcher or agent | `GET /api/v1/projects/:id/compute` (an agent: its own project); the `compute` block of `GET …/access` |
| Agent over MCP | `ablationkit_read compute`, or the `compute` block of `ablationkit_project`; both list the targets the policy lets the agent use, with their weights and whether job limits are enforced there |

### Where it is enforced

- **Admission is authoritative.** The coordinator refuses the job.
- **After admission**, usage is bounded only as far as each attempt's time limit holds:
  - `RuntimeMaxSec` in a systemd user scope, locally and on remote workers with systemd, is **enforced**;
  - in direct mode the collector or the remote shim stops the job's process group, and a process that leaves the group escapes it;
  - a Colab runtime (`colab.mode: cli`, ADR 0059) is bounded by the shim on the runtime, and the coordinator stops the runtime once its results are home;
  - an exported Colab notebook is bounded only by the shim, once someone runs it.

Every compute response carries this note. The threat map lists it as POL-8 ([threat-map.md](../security/threat-map.md)).

## Nothing else grants anything

What an agent may ask AblationKit to do is this policy alone. A task, a record, a repository file or anything the agent writes changes none of it. See [agent-first.md](agent-first.md).
