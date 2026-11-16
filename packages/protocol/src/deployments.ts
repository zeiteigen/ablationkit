/**
 * Deployment requests and their lifecycle (spec §7.7.4 item 5; ADR 0018). The coordinator owns
 * every record under `~/.ablationkit/state/<project>/deployments/`.
 */
import { type Static, Type } from "@sinclair/typebox";
import { describe, ProjectId, Timestamp } from "./common.ts";
import { ResearchActor } from "./research.ts";

const Text = (maxLength: number, description?: string) =>
  Type.String({ maxLength, ...(description ? { description } : {}) });
const Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const DeploymentKind = Type.Union(
  [
    Type.Literal("preview_local"),
    Type.Literal("remote_research"),
    Type.Literal("persistent"),
    Type.Literal("public"),
  ],
  { title: "DeploymentKind" },
);
export type DeploymentKind = Static<typeof DeploymentKind>;

export const DeploymentRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    deployment_id: Type.String({ pattern: "^dep-[a-z0-9-]{1,60}$" }),
    project_id: ProjectId,
    kind: DeploymentKind,
    target: Text(100),
    model_uri: Text(
      1000,
      "Pinned model: `models:/<name>/<version>` or `runs:/<run>/<path>`. Aliases and `latest` are refused.",
    ),
    exposure: Type.Union([
      Type.Literal("loopback"),
      Type.Literal("tailnet"),
      Type.Literal("public"),
    ]),
    ttl_minutes: Type.Integer({ minimum: 1, maximum: 100000 }),
    max_cents: Type.Optional(Type.Integer({ minimum: 0 })),
    status: Type.Union([
      Type.Literal("blocked"),
      Type.Literal("approved"),
      Type.Literal("running"),
      Type.Literal("stopped"),
      Type.Literal("expired"),
      Type.Literal("invalidated"),
      Type.Literal("failed"),
    ]),
    status_reason: Type.Optional(Text(2000)),
    policy_revision: Type.Integer({ minimum: 0 }),
    requested_by: ResearchActor,
    requested_at: Timestamp,
    started_at: Type.Optional(Timestamp),
    expires_at: Type.Optional(Timestamp),
    stopped_at: Type.Optional(Timestamp),
    endpoint: Type.Optional(Text(500)),
    launcher: Type.Optional(Text(100)),
    provider: Type.Optional(
      Type.Object(
        {
          target_id: Text(100),
          target_kind: Text(32),
          provider_ref: Text(200, "The provider's ID for the endpoint (a Runpod pod ID)."),
          independent_supervision: describe(
            Type.Boolean(),
            "The endpoint's lifetime is supervised by the provider, not the coordinator: it survives a coordinator restart and stops itself at `expires_at` (spec §10 offline nuance, criterion 12).",
          ),
          model_sha256: Type.Optional(Sha256),
          model_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
          estimate_cents: Type.Optional(
            describe(Type.Integer({ minimum: 0 }), "Rate card times TTL: an estimate, not a bill."),
          ),
          state: Type.Optional(Text(100, "The provider's last reported state, shown as is.")),
          checked_at: Type.Optional(Timestamp),
        },
        { title: "DeploymentProvider", additionalProperties: false },
      ),
    ),
  },
  {
    title: "DeploymentRecord",
    description:
      "A deployment request and its lifecycle (§7.7.4 item 5): pinned model, named target, exposure, TTL and budget. A preview is never a public deployment.",
    additionalProperties: false,
  },
);
export type DeploymentRecord = Static<typeof DeploymentRecord>;
