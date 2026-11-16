/**
 * Coordinator-owned state under the application-data directory (spec §5.1 B): the local
 * project registry, coordinator settings and the append-only audit journal. ADR 0009.
 */
import { type Static, Type } from "@sinclair/typebox";
import { describe, ProjectId, SequenceNumber, Timestamp } from "./common.ts";
import { ExtensionSettings } from "./extensions.ts";

const AbsolutePath = Type.String({
  title: "AbsolutePath",
  description: "Absolute, machine-specific filesystem path. Only the local registry stores these.",
  pattern: "^/.*$",
  minLength: 1,
  maxLength: 4096,
});

export const ProjectRegistration = Type.Object(
  {
    project_id: ProjectId,
    name: Type.String({
      description: "Display name, from the manifest.",
      minLength: 1,
      maxLength: 200,
    }),
    path: describe(AbsolutePath, "Current checkout path on the coordinator machine."),
    registered_at: Timestamp,
    updated_at: Timestamp,
    previous_paths: Type.Array(AbsolutePath, {
      description: "Earlier checkout paths, oldest first, kept when a project is remapped.",
    }),
  },
  {
    title: "ProjectRegistration",
    description: "One registered project: its stable ID and where it lives on this machine.",
    additionalProperties: false,
  },
);
export type ProjectRegistration = Static<typeof ProjectRegistration>;

/** `~/.ablationkit/registry.json`. */
export const ProjectRegistry = Type.Object(
  {
    schema_version: Type.Literal(1),
    projects: Type.Array(ProjectRegistration, {
      description: "Registered projects, by registration order.",
    }),
  },
  {
    title: "ProjectRegistry",
    description: "Local project registry (`registry.json`): project IDs mapped to local paths.",
    additionalProperties: false,
  },
);
export type ProjectRegistry = Static<typeof ProjectRegistry>;

const Host = Type.String({
  title: "ListenHost",
  description: "IP address or hostname to bind.",
  pattern: "^[A-Za-z0-9.:\\[\\]-]{1,253}$",
});
const Port = Type.Integer({
  title: "ListenPort",
  description: "TCP port; 0 picks a free port.",
  minimum: 0,
  maximum: 65535,
});

export const ListenerSettings = Type.Object(
  { host: Host, port: Port },
  {
    title: "ListenerSettings",
    description: "Bind address of one listener.",
    additionalProperties: false,
  },
);
export type ListenerSettings = Static<typeof ListenerSettings>;

export const TrustedOrigin = Type.Object(
  {
    origin: Type.String({
      description:
        "Browser origin allowed to use the human API, for example `http://localhost:7420`.",
      pattern: "^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$",
    }),
  },
  {
    title: "TrustedOrigin",
    description: "An origin the human API accepts.",
    additionalProperties: false,
  },
);
export type TrustedOrigin = Static<typeof TrustedOrigin>;

export const MlflowSidecarSettings = Type.Object(
  {
    enabled: Type.Optional(
      Type.Boolean({
        description:
          "Start the managed MLflow sidecar with the coordinator. Default true. When false, tracking writes queue in the outbox.",
      }),
    ),
    port: Type.Optional(
      describe(
        Port,
        "Loopback port for the sidecar. Default 7423. MLflow never binds off loopback.",
      ),
    ),
    outbox_max_ops: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10_000_000,
        description: "Outbox bound: pending and failed writes. Default 100000.",
      }),
    ),
    outbox_max_bytes: Type.Optional(
      Type.Integer({
        minimum: 1024,
        maximum: 1_099_511_627_776,
        description: "Outbox bound: queued payload bytes. Default 256 MiB.",
      }),
    ),
  },
  {
    title: "MlflowSidecarSettings",
    description: "Managed MLflow sidecar and tracking outbox settings.",
    additionalProperties: false,
  },
);
export type MlflowSidecarSettings = Static<typeof MlflowSidecarSettings>;

export const JobSettings = Type.Object(
  {
    supervisor: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("systemd"), Type.Literal("direct")], {
        description:
          "`auto` (default): systemd user scopes when available, otherwise direct mode (limits advisory).",
      }),
    ),
    spool_max_bytes: Type.Optional(
      Type.Integer({
        minimum: 1024 * 1024,
        description: "Per-attempt collector spool bound. Default 1 GiB.",
      }),
    ),
    max_artifact_bytes: Type.Optional(
      Type.Integer({
        minimum: 1024,
        description: "Largest single artifact upload. Default 2 GiB.",
      }),
    ),
    deliver_deadline_sec: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "How long a collector keeps retrying delivery after its job exits. Default 7 days (the worker token grace).",
      }),
    ),
  },
  {
    title: "JobSettings",
    description: "Local job runner and collector settings.",
    additionalProperties: false,
  },
);
export type JobSettings = Static<typeof JobSettings>;

export const ArtifactStoreSettings = Type.Object(
  {
    endpoint: Type.String({
      pattern: "^https?://[^ ]+$",
      maxLength: 2048,
      description:
        "S3-compatible endpoint reachable from the workers, for example `https://<account>.r2.cloudflarestorage.com` or a MinIO URL.",
    }),
    bucket: Type.String({ minLength: 3, maxLength: 63, pattern: "^[a-z0-9][a-z0-9.-]+$" }),
    region: Type.Optional(Type.String({ maxLength: 64, description: "Default `auto`." })),
    prefix: Type.Optional(
      Type.String({
        maxLength: 200,
        pattern: "^[A-Za-z0-9._/-]*$",
        description: "Key prefix. Default `ablationkit/`.",
      }),
    ),
    access_key_id_env: Type.String({
      pattern: "^[A-Z_][A-Z0-9_]*$",
      description: "Coordinator environment variable holding the access key ID (never stored).",
    }),
    secret_access_key_env: Type.String({ pattern: "^[A-Z_][A-Z0-9_]*$" }),
    virtual_hosted_style: Type.Optional(Type.Boolean({ description: "Default path-style." })),
    min_bytes: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Artifacts at least this large go through the store. Default 64 MiB.",
      }),
    ),
    slots: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 64,
        description:
          "Presigned upload slots per attempt (one large artifact each). Default 8; more large artifacts use the coordinator's resumable uploads.",
      }),
    ),
  },
  {
    title: "ArtifactStoreSettings",
    description:
      "Optional S3-compatible store for remote workers' large artifacts (spec §16 storage table; ADR 0023 decision 24). Workers get presigned PUT URLs only; the keys stay on the coordinator. MLflow remains the artifact store of record.",
    additionalProperties: false,
  },
);
export type ArtifactStoreSettings = Static<typeof ArtifactStoreSettings>;

export const RemoteSettings = Type.Object(
  {
    worker_url: Type.Optional(
      Type.String({
        pattern: "^https?://[^ ]+$",
        maxLength: 2048,
        description:
          "URL remote workers use to reach the worker listener, for example `http://ws.tail1234.ts.net:7422` over Tailscale. Required before a remote submission; targets may override it.",
      }),
    ),
    heartbeat_sec: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 3600, description: "Worker heartbeat. Default 30." }),
    ),
    disconnected_after_sec: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "No heartbeat for this long marks a worker disconnected. Default 3 heartbeats.",
      }),
    ),
    export_slack_min: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 10080,
        description:
          "Slack added to an exported (Colab) attempt's time limit for its `expected_back_by`: time for a person to open and set up the runtime. Default 30.",
      }),
    ),
    upload_token_ttl_sec: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Lifetime of a remote worker's upload token; refreshed through the handshake. Default 1 day.",
      }),
    ),
    launch_token_days: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 365,
        description:
          "Lifetime of a remote worker's launch token, from submission. A disconnection longer than this needs `remote import`. Default 30.",
      }),
    ),
    provider_poll_sec: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "How often provider status is checked. Default 60.",
      }),
    ),
    max_backoff_sec: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 3600,
        description: "Worker retry backoff cap. Default 60.",
      }),
    ),
    min_free_disk_bytes: Type.Optional(
      Type.Integer({ minimum: 0, description: "Worker disk-pressure threshold. Default 1 GiB." }),
    ),
    artifact_store: Type.Optional(ArtifactStoreSettings),
  },
  {
    title: "RemoteSettings",
    description: "Remote worker mode (ADR 0023).",
    additionalProperties: false,
  },
);
export type RemoteSettings = Static<typeof RemoteSettings>;

/** `~/.ablationkit/settings.json` (optional; defaults apply when missing). */
export const CoordinatorSettings = Type.Object(
  {
    schema_version: Type.Literal(1),
    human: Type.Optional(
      describe(ListenerSettings, "Human API (browser, Electron, CLI). Default 127.0.0.1:7420."),
    ),
    agent: Type.Optional(
      describe(ListenerSettings, "Agent API. Loopback only. Default 127.0.0.1:7421."),
    ),
    worker: Type.Optional(
      describe(
        ListenerSettings,
        "Worker upload API. Default 127.0.0.1:7422. Host `tailscale` binds the machine's Tailscale IPv4 address (remote workers).",
      ),
    ),
    trusted_origins: Type.Optional(
      Type.Array(TrustedOrigin, {
        description:
          "Origins for the human API. The first one is used for login links. Default http://localhost:<human port>.",
        minItems: 1,
      }),
    ),
    mlflow: Type.Optional(MlflowSidecarSettings),
    jobs: Type.Optional(JobSettings),
    extensions: Type.Optional(ExtensionSettings),
    remote: Type.Optional(RemoteSettings),
  },
  {
    title: "CoordinatorSettings",
    description: "Coordinator listener and origin settings (`settings.json`).",
    additionalProperties: false,
  },
);
export type CoordinatorSettings = Static<typeof CoordinatorSettings>;

export const AuditActor = Type.Object(
  {
    kind: Type.Union(
      [
        Type.Literal("human"),
        Type.Literal("agent"),
        Type.Literal("worker"),
        Type.Literal("system"),
      ],
      {
        description:
          "Who acted: a human session, an agent or worker token, or the coordinator itself.",
      },
    ),
    id: Type.Optional(
      Type.String({
        description: "Session or token ID (never the secret).",
        pattern: "^[A-Za-z0-9._:-]{1,128}$",
      }),
    ),
  },
  {
    title: "AuditActor",
    description: "The principal behind an audited action.",
    additionalProperties: false,
  },
);
export type AuditActor = Static<typeof AuditActor>;

/** One line of `~/.ablationkit/audit/audit-NNNN.jsonl`. */
export const AuditRecord = Type.Object(
  {
    seq: describe(SequenceNumber, "Journal sequence number."),
    schema_version: Type.Literal(1),
    ts: Timestamp,
    actor: AuditActor,
    listener: Type.Union(
      [
        Type.Literal("human"),
        Type.Literal("agent"),
        Type.Literal("worker"),
        Type.Literal("login"),
        Type.Literal("internal"),
      ],
      { description: "Where the request arrived." },
    ),
    action: Type.String({
      description: "Dotted action name, for example `project.register` or `policy.revise`.",
      pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$",
    }),
    outcome: Type.Union([Type.Literal("allowed"), Type.Literal("denied"), Type.Literal("error")]),
    project_id: Type.Optional(ProjectId),
    target: Type.Optional(
      Type.String({ description: "What was acted on (an ID or route).", maxLength: 1024 }),
    ),
    reason: Type.Optional(
      Type.String({ description: "Why it was denied or failed.", maxLength: 1024 }),
    ),
    details: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), { description: "Extra non-secret context." }),
    ),
  },
  {
    title: "AuditRecord",
    description: "An append-only audit journal entry. Never contains secrets.",
    additionalProperties: false,
  },
);
export type AuditRecord = Static<typeof AuditRecord>;
