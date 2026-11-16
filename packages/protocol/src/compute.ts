/**
 * The agent compute limit (ADR 0037): the machine-wide weight of each compute target and each
 * project's limit notices. The limit itself is `compute.limit_hours` in the project action policy;
 * the hours an agent's jobs used are derived from their attempts.
 */
import { type Static, Type } from "@sinclair/typebox";
import { describe, ProjectId, Timestamp } from "./common.ts";

export const WeightHundredths = Type.Integer({
  minimum: 1,
  maximum: 100_000,
  description:
    "A compute weight in hundredths (100 is a weight of 1, 50 is 0.5, 300 is 3): an hour on the target counts as weight hours.",
});

/** `<home>/compute-weights.json`. */
export const ComputeWeights = Type.Object(
  {
    schema_version: Type.Literal(1),
    weights: Type.Record(Type.String(), WeightHundredths, {
      description:
        "By target: `local` (this workstation) or a compute target's ID. A target without an entry has weight 1.",
    }),
    updated_at: Type.Optional(Timestamp),
    updated_by: Type.Optional(Type.String({ maxLength: 200 })),
  },
  {
    title: "ComputeWeights",
    description:
      "Machine-wide compute weights, set by the researcher. Each agent job records the weight in effect when it was submitted, so changing a weight never rewrites what was used.",
    additionalProperties: false,
  },
);
export type ComputeWeights = Static<typeof ComputeWeights>;

/** `state/<project-id>/compute/limit.json`. */
export const ComputeLimitState = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    refused: Type.Optional(
      Type.Object(
        {
          first_at: Timestamp,
          last_at: Timestamp,
          count: Type.Integer({ minimum: 1 }),
          policy_revision: Type.Integer({ minimum: 0 }),
          message: Type.String({ maxLength: 2000 }),
        },
        {
          title: "ComputeLimitRefusals",
          description:
            "Agent submissions refused since the last admitted one under this policy revision: one notification per burst.",
          additionalProperties: false,
        },
      ),
    ),
    over_limit_since: Type.Optional(
      describe(
        Timestamp,
        "When the hours used went over the limit (a remote clock or an import can push them past it); cleared once they are within it again.",
      ),
    ),
  },
  {
    title: "ComputeLimitState",
    description:
      "What the researcher was told about a project's agent compute limit, so a burst of refusals or one crossing notifies once.",
    additionalProperties: false,
  },
);
export type ComputeLimitState = Static<typeof ComputeLimitState>;
