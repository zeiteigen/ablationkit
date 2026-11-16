/**
 * The project action policy (spec §7.7; ADR 0037).
 *
 * The coordinator owns every record here under `~/.ablationkit/state/<project>/`, outside any
 * agent-editable checkout. A repository file never grants a capability. Git, candidate
 * workspaces, approvals and the agent sandbox belong to the user's harness since ADR 0037: the
 * policy decides only what an agent may ask AblationKit itself to do.
 */
import { type Static, type TProperties, Type } from "@sinclair/typebox";
import { ProjectId, Timestamp } from "./common.ts";

export const PolicyDecision = Type.Union([Type.Literal("deny"), Type.Literal("allow")], {
  title: "PolicyDecision",
  description:
    "`allow` lets an agent do it when every condition passes; `deny` refuses it with a reason naming the policy field.",
});
export type PolicyDecision = Static<typeof PolicyDecision>;

const Targets = (description: string) =>
  Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 100, description });

const Gate = <P extends TProperties>(title: string, extra: P) =>
  Type.Object({ decision: PolicyDecision, ...extra }, { title, additionalProperties: false });

export const LocalJobGate = Gate("LocalJobGate", {});
export const RemoteJobGate = Gate("RemoteJobGate", {
  allowed_targets: Targets(
    "Compute targets an agent may submit to: a target ID, or a kind (`ssh`, `slurm`, `runpod`, `colab`) for every target of that kind.",
  ),
});
export const DeploymentGate = Gate("DeploymentGate", {
  exposure: Type.Optional(Type.String({ maxLength: 40 })),
  allowed_targets: Type.Optional(Targets("Deployment targets.")),
  max_runtime_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
});

export const ProjectActionPolicy = Type.Object(
  {
    schema_version: Type.Literal(2),
    project_id: ProjectId,
    revision: Type.Integer({ minimum: 0, description: "0 is the built-in default." }),
    created_at: Timestamp,
    created_by: Type.String({ maxLength: 200 }),
    summary: Type.Optional(Type.String({ maxLength: 2000 })),
    jobs: Type.Object(
      { run_local: LocalJobGate, submit_remote: RemoteJobGate },
      {
        title: "JobGates",
        additionalProperties: false,
        description: "Jobs an agent submits: on this machine, or to a remote compute target.",
      },
    ),
    deployments: Type.Object(
      {
        preview_local: DeploymentGate,
        remote_research: DeploymentGate,
        persistent: DeploymentGate,
        public: DeploymentGate,
      },
      { title: "DeploymentGates", additionalProperties: false },
    ),
    compute: Type.Object(
      {
        limit_hours: Type.Integer({
          minimum: 0,
          maximum: 1000000,
          description: "Weighted compute hours agent-submitted jobs may use in this project.",
        }),
      },
      { title: "ComputeLimit", additionalProperties: false },
    ),
  },
  {
    title: "ProjectActionPolicy",
    description:
      "One immutable revision of a project's action policy (§7.7.3), stored by the coordinator under `state/<project>/policy/`. Version 1 revisions are migrated on read (ADR 0037).",
    additionalProperties: false,
  },
);
export type ProjectActionPolicy = Static<typeof ProjectActionPolicy>;
