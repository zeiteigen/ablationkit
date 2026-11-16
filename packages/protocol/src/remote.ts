/**
 * Remote compute: targets, staged run bundles, the worker handshake and remote attempt status
 * (spec §2.1 remote worker mode, §5.3, §5.7, §7.4, §10; ADR 0023).
 *
 * A remote attempt runs from a fully staged bundle under the target's own supervisor (a systemd
 * user unit on an SSH host, a SLURM allocation, a Runpod pod). The `ablationkit-worker` process
 * spools events and artifacts on the worker and delivers them through the same worker API as a
 * local collector. The coordinator never needs to be online for the job to finish.
 */
import { type Static, Type } from "@sinclair/typebox";
import { AttemptId, describe, JobId, ProjectId, SequenceNumber, Timestamp } from "./common.ts";
import { JobLimits, MetricsFormat } from "./limits.ts";

export const TargetId = Type.String({
  title: "TargetId",
  description: "Compute target identifier (lowercase slug). `local` is reserved for this machine.",
  pattern: "^[a-z][a-z0-9-]{0,39}$",
});
export type TargetId = Static<typeof TargetId>;

export const TargetKind = Type.Union(
  [Type.Literal("ssh"), Type.Literal("slurm"), Type.Literal("runpod"), Type.Literal("colab")],
  {
    title: "TargetKind",
    description:
      "`ssh`: a worker host reached over SSH (usually on the tailnet). `slurm`: a cluster login node reached over SSH; jobs go through `sbatch`. `runpod`: pods through the Runpod REST API. `colab`: Google Colab runtimes, unattended through Google's Colab CLI (`colab.mode: cli`) or as an exported notebook a person runs (`notebook`).",
  },
);
export type TargetKind = Static<typeof TargetKind>;

const EnvName = Type.String({ pattern: "^[A-Z_][A-Z0-9_]{0,127}$" });
const HttpUrl = Type.String({ pattern: "^https?://[^ ]+$", maxLength: 2048 });

export const SshConfig = Type.Object(
  {
    host: Type.String({
      pattern: "^([A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9.:_-]{1,253}$",
      description: "`[user@]host`, for example a MagicDNS name on the tailnet.",
    }),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    identity_file: Type.Optional(Type.String({ pattern: "^/.*$", maxLength: 4096 })),
    command: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1,
        maxItems: 16,
        description:
          "argv prefix used instead of `ssh` (tests, or a wrapper). The host and remote command are appended.",
      }),
    ),
    supervisor: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("systemd"), Type.Literal("nohup")], {
        description:
          "How an `ssh` target keeps the worker alive: a systemd user service (restarted on failure; `auto` picks it when available) or a detached `setsid nohup` process.",
      }),
    ),
  },
  {
    title: "SshConfig",
    description: "How the coordinator reaches a host. Uses the user's SSH keys and config.",
    additionalProperties: false,
  },
);
export type SshConfig = Static<typeof SshConfig>;

export const SlurmConfig = Type.Object(
  {
    partition: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_.,-]{1,100}$" })),
    account: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_.-]{1,100}$" })),
    qos: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_.-]{1,100}$" })),
    gres: Type.Optional(
      Type.String({ pattern: "^[A-Za-z0-9_:,.-]{1,200}$", description: "For example `gpu:1`." }),
    ),
    directives: Type.Optional(
      Type.Array(Type.String({ pattern: "^--[a-z][a-z-]{0,40}(=[A-Za-z0-9_:,./@%+-]{1,200})?$" }), {
        maxItems: 32,
        description: "Extra `#SBATCH` options, one `--name[=value]` each.",
      }),
    ),
    drain_sec: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 86_400,
        description:
          "How long the worker keeps delivering inside the allocation after the job exits. The rest is drained from the login node on reconnection. Default 300.",
      }),
    ),
  },
  { title: "SlurmConfig", additionalProperties: false },
);
export type SlurmConfig = Static<typeof SlurmConfig>;

export const RunpodConfig = Type.Object(
  {
    api_url: Type.Optional(describe(HttpUrl, "Default https://rest.runpod.io/v1.")),
    api_key_env: describe(
      EnvName,
      "Coordinator environment variable holding the Runpod API key. Never stored.",
    ),
    image: Type.String({
      minLength: 1,
      maxLength: 500,
      description: "Container image with Python 3.",
    }),
    gpu_type_ids: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 }),
    gpu_count: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 })),
    cloud_type: Type.Optional(Type.Union([Type.Literal("SECURE"), Type.Literal("COMMUNITY")])),
    container_disk_gb: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
    volume_gb: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 4000,
        description:
          "Pod volume mounted at /workspace (default 20). The worker directory lives there, so a stopped pod keeps its spool and a drain restarts it.",
      }),
    ),
    deliver_deadline_sec: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 7 * 86_400,
        description:
          "How long a pod keeps trying to deliver after the job exits before it stops itself (default 3600). A stopped pod bills storage only; its spool is delivered by a drain (pod restart).",
      }),
    ),
    network_volume_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}$" })),
    tailscale_authkey_secret: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9_-]{1,100}$",
        description:
          "Name of a Runpod secret holding a Tailscale auth key; the pod joins the tailnet to reach the worker listener. Referenced, never copied.",
      }),
    ),
    cents_per_hour: Type.Optional(
      Type.Integer({ minimum: 0, description: "Rate card for estimates (provider billing lags)." }),
    ),
    serve_command: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 2000,
        description:
          'Research endpoints: the shell command that serves the model in `$MODEL_DIR` on `$PORT`. Default `python3 -m mlflow models serve -m "$MODEL_DIR" -h 0.0.0.0 -p "$PORT" --env-manager local` (the image needs MLflow and the model\'s dependencies).',
      }),
    ),
    serve_port: Type.Optional(
      Type.Integer({
        minimum: 1024,
        maximum: 65535,
        description: "Research endpoints: the port the server listens on (default 8080).",
      }),
    ),
  },
  { title: "RunpodConfig", additionalProperties: false },
);
export type RunpodConfig = Static<typeof RunpodConfig>;

export const ColabGpu = Type.Union(
  [
    Type.Literal("T4"),
    Type.Literal("L4"),
    Type.Literal("G4"),
    Type.Literal("A100"),
    Type.Literal("H100"),
  ],
  { title: "ColabGpu", description: "A Colab GPU, as Google's Colab CLI names it (`--gpu`)." },
);
export type ColabGpu = Static<typeof ColabGpu>;

export const ColabConfig = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("notebook"), Type.Literal("cli")], {
        description:
          "`cli`: AblationKit runs each job unattended through Google's Colab CLI (`colab`, signed in once by the researcher): it allocates a runtime, uploads the bundle, starts the worker, collects its spool while it runs and after, and releases the runtime. `notebook` (the default when absent): each job exports a notebook a person runs, and its results come back with `remote import`.",
      }),
    ),
    gpu: Type.Optional(ColabGpu),
    tpu: Type.Optional(
      Type.Union([Type.Literal("v5e1"), Type.Literal("v6e1")], {
        description: "`cli`: a TPU instead of a GPU (`--tpu`).",
      }),
    ),
    high_mem: Type.Optional(
      Type.Boolean({
        description:
          "`cli`: ask for a high-RAM machine shape (`--high-mem`; needs Colab Pro or Pro+).",
      }),
    ),
    cli: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1,
        maxItems: 16,
        description:
          "`cli`: argv of the Colab CLI (default `colab`). Tests and wrappers replace it; the subcommand and its arguments are appended.",
      }),
    ),
    auth: Type.Optional(
      Type.Union([Type.Literal("oauth2"), Type.Literal("adc")], {
        description:
          "`cli`: how the Colab CLI signs in (`--auth`): `oauth2` (its default; run `colab sessions` once in a terminal and follow the link) or `adc` (Application Default Credentials from gcloud).",
      }),
    ),
    keep_after_sec: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 86_400,
        description:
          "`cli`: how long a runtime whose job ended keeps its results for the coordinator to collect before it lets Colab reclaim it (default 3600). The coordinator releases it as soon as it has them.",
      }),
    ),
    live: Type.Optional(
      Type.Boolean({
        description:
          "Give the worker the attempt's credentials so it delivers live. Only when `worker_url` is reachable from Colab; a notebook is then a secret. Default false: the worker spools, and its results come back by collection (`cli`) or `remote import` (`notebook`).",
      }),
    ),
    deliver_deadline_sec: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 86_400,
        description:
          "With `live`, how long the worker keeps delivering after the job (default 120).",
      }),
    ),
  },
  { title: "ColabConfig", additionalProperties: false },
);
export type ColabConfig = Static<typeof ColabConfig>;

export const NtfyConfig = Type.Object(
  {
    url: describe(HttpUrl, "Topic URL, for example https://ntfy.sh/<random-topic>."),
    token_env: Type.Optional(
      describe(EnvName, "Coordinator environment variable with an ntfy access token."),
    ),
  },
  {
    title: "NtfyConfig",
    description:
      "Workers post terminal status, disk pressure and credential problems here, independently of the coordinator. Passed in the worker's credentials file, not the bundle.",
    additionalProperties: false,
  },
);
export type NtfyConfig = Static<typeof NtfyConfig>;

export const ColabComputeUnits = Type.Object(
  {
    per_hour_hundredths: Type.Integer({
      minimum: 0,
      description:
        "The runtime's compute units per hour, in hundredths: how much the account's hourly rate rose when it was allocated (0 on a free runtime).",
    }),
    balance_at_allocation_hundredths: Type.Optional(
      Type.Integer({
        description: "The account's balance, in hundredths, just before the runtime was allocated.",
      }),
    ),
    allocated_at: Timestamp,
    released_at: Type.Optional(
      describe(Timestamp, "When the coordinator stopped the runtime (or found it gone)."),
    ),
  },
  {
    title: "ColabComputeUnits",
    description:
      "A Colab runtime's compute units (`colab.mode: cli`, ADR 0059), in hundredths as Colab reports them. Units used are about `per_hour_hundredths` / 100 times the hours from `allocated_at` to `released_at` (or now): an estimate from the account's rate, which Colab reports for the whole account, not per runtime.",
    additionalProperties: false,
  },
);
export type ColabComputeUnits = Static<typeof ColabComputeUnits>;

export const ColabUsage = Type.Object(
  {
    balance_hundredths: Type.Integer({
      description: "Compute units left on the Google account, in hundredths.",
    }),
    per_hour_hundredths: Type.Integer({
      minimum: 0,
      description: "Compute units the account's runtimes use per hour now, in hundredths.",
    }),
    runtimes: Type.Integer({ minimum: 0, description: "Runtimes allocated to the account now." }),
    checked_at: Timestamp,
  },
  {
    title: "ColabUsage",
    description:
      "A Colab account's compute units as Google's Colab CLI reports them (`colab usage`): the whole account, including runtimes AblationKit did not start.",
    additionalProperties: false,
  },
);
export type ColabUsage = Static<typeof ColabUsage>;

/** `<home>/targets/<target-id>.json`. */
export const ComputeTarget = Type.Object(
  {
    schema_version: Type.Literal(1),
    target_id: TargetId,
    kind: TargetKind,
    label: Type.Optional(Type.String({ maxLength: 200 })),
    ssh: Type.Optional(SshConfig),
    slurm: Type.Optional(SlurmConfig),
    runpod: Type.Optional(RunpodConfig),
    colab: Type.Optional(ColabConfig),
    work_dir: Type.Optional(
      Type.String({
        pattern: "^(/|~/)[A-Za-z0-9._/~-]{0,1000}$",
        description: "Where bundles are unpacked on the worker. Default `~/.ablationkit-worker`.",
      }),
    ),
    python: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9._/-]{1,500}$",
        description: "Python 3.10+ on the worker. Default `python3`.",
      }),
    ),
    worker_url: Type.Optional(
      describe(
        HttpUrl,
        "URL workers on this target use to reach the coordinator's worker listener (a tailnet name or a gateway). Default: settings `remote.worker_url`.",
      ),
    ),
    ntfy: Type.Optional(NtfyConfig),
    paid: Type.Boolean({
      description:
        "Submissions cost money. Human submissions must accept the estimate; agents may submit only when the project policy allows `jobs.submit_remote` on this target.",
    }),
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  {
    title: "ComputeTarget",
    description: "A configured remote compute target. Credentials are referenced, never stored.",
    additionalProperties: false,
  },
);
export type ComputeTarget = Static<typeof ComputeTarget>;

const BundlePath = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: "^[^/].*$",
  description: "Path relative to the bundle root; code rejects `..`.",
});

/** `bundle.json` at the root of a run bundle. */
export const RunBundleManifest = Type.Object(
  {
    schema_version: Type.Literal(1),
    bundle_id: Type.String({ pattern: "^b-[a-f0-9]{12}$" }),
    project_id: ProjectId,
    job_id: JobId,
    attempt_id: AttemptId,
    target_id: TargetId,
    target_kind: TargetKind,
    created_at: Timestamp,
    worker_url: HttpUrl,
    argv: Type.Array(Type.String({ maxLength: 8192 }), { minItems: 1, maxItems: 1100 }),
    environment: Type.Union([Type.Literal("uv"), Type.Literal("none")]),
    cwd: describe(BundlePath, "Working directory inside `source/`; `.` for its root."),
    env: Type.Record(Type.String(), Type.String({ maxLength: 32_768 })),
    limits: JobLimits,
    artifact_paths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 64 }),
    metrics_file: Type.Optional(describe(BundlePath, "Relative to `source/`.")),
    metrics_format: Type.Optional(MetricsFormat),
    source_commit: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
    files: Type.Array(
      Type.Object(
        {
          path: BundlePath,
          sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          size: Type.Integer({ minimum: 0 }),
        },
        { title: "BundleFile", additionalProperties: false },
      ),
      { maxItems: 200_000, description: "Every file in the bundle except this manifest." },
    ),
    heartbeat_sec: Type.Integer({ minimum: 1, maximum: 3600 }),
    max_backoff_sec: Type.Integer({ minimum: 1, maximum: 3600 }),
    spool_max_bytes: Type.Integer({ minimum: 1024 * 1024 }),
    min_free_disk_bytes: describe(
      Type.Integer({ minimum: 0 }),
      "Below this much free space the worker stops staging artifacts and drops noncritical events (disk pressure).",
    ),
    deliver_deadline_sec: Type.Integer({ minimum: 0 }),
  },
  {
    title: "RunBundleManifest",
    description:
      "A self-sufficient run bundle: pinned source, the worker, the SDK and everything the worker needs to run and report one attempt without the coordinator.",
    additionalProperties: false,
  },
);
export type RunBundleManifest = Static<typeof RunBundleManifest>;

export const RemoteConnectivity = Type.Union(
  [Type.Literal("pending"), Type.Literal("connected"), Type.Literal("disconnected")],
  {
    title: "RemoteConnectivity",
    description:
      "`pending`: the worker has not called in yet. `disconnected`: no heartbeat within `remote.disconnected_after_sec`; live monitoring and cancellation are not guaranteed.",
  },
);

export const RemoteSyncStatus = Type.Union(
  [
    Type.Literal("awaiting_sync"),
    Type.Literal("syncing"),
    Type.Literal("synced"),
    Type.Literal("sync_failed"),
  ],
  {
    title: "RemoteSyncStatus",
    description:
      "Worker-to-coordinator sync, shown separately from compute status (spec §5.3). `synced`: the worker reported its exit and an empty spool.",
  },
);
export type RemoteSyncStatus = Static<typeof RemoteSyncStatus>;

export const RemoteStaging = Type.Union(
  [
    Type.Literal("bundling"),
    Type.Literal("staging"),
    Type.Literal("submitted"),
    Type.Literal("exported"),
    Type.Literal("failed"),
  ],
  {
    title: "RemoteStaging",
    description:
      "`submitted`: the provider confirmed the job; from here the provider's scheduler owns process lifetime (spec §5.7). `exported`: a notebook was written for an interactive runtime (Colab); nothing runs unattended, and results arrive by `remote import` (or live, if the notebook was exported with credentials).",
  },
);

export const WorkerSpoolReport = Type.Object(
  {
    next_seq: Type.Optional(SequenceNumber),
    pending_events: Type.Optional(Type.Integer({ minimum: 0 })),
    pending_artifacts: Type.Optional(Type.Integer({ minimum: 0 })),
    bytes: Type.Optional(Type.Integer({ minimum: 0 })),
    dropped_events: Type.Optional(Type.Integer({ minimum: 0 })),
    disk_free_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
    disk_pressure: Type.Optional(Type.Boolean()),
  },
  { title: "WorkerSpoolReport", additionalProperties: false },
);
export type WorkerSpoolReport = Static<typeof WorkerSpoolReport>;

export const RemoteAttemptInfo = Type.Object(
  {
    target_id: TargetId,
    target_kind: TargetKind,
    bundle_id: Type.String({ pattern: "^b-[a-f0-9]{12}$" }),
    bundle_sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    source_commit: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
    staging: RemoteStaging,
    staging_error: Type.Optional(Type.String({ maxLength: 2000 })),
    submitted_at: Type.Optional(Timestamp),
    provider_job_id: Type.Optional(Type.String({ maxLength: 200 })),
    provider_state: Type.Optional(
      Type.String({ maxLength: 100, description: "Raw provider status, for example `COMPLETED`." }),
    ),
    provider_checked_at: Type.Optional(Timestamp),
    worker_id: Type.Optional(Type.String({ pattern: "^w-[a-f0-9]{8,32}$" })),
    worker_host: Type.Optional(Type.String({ maxLength: 253 })),
    first_contact_at: Type.Optional(Timestamp),
    last_contact_at: Type.Optional(Timestamp),
    connectivity: RemoteConnectivity,
    sync: RemoteSyncStatus,
    sync_error: Type.Optional(Type.String({ maxLength: 2000 })),
    spool_acked_seq: describe(
      Type.Integer({ minimum: -1 }),
      "Highest worker spool seq the coordinator has applied; returned in the handshake so the worker replays only what is unacknowledged.",
    ),
    worker_spool: Type.Optional(WorkerSpoolReport),
    reconcile_required: Type.Optional(
      Type.String({
        maxLength: 2000,
        description:
          "Why the outcome is ambiguous (a second worker, a lost process, a provider that ended the job). Nothing is rerun; a human decides.",
      }),
    ),
    drains: Type.Optional(Type.Integer({ minimum: 0 })),
    launch_token_id: Type.String({ pattern: "^[a-f0-9]{16}$" }),
    launch_expires_at: Timestamp,
    estimated_cents: Type.Optional(Type.Integer({ minimum: 0 })),
    store_slots: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 64,
        description:
          "Presigned S3 upload slots issued to the worker (settings `remote.artifact_store`). Slot `n` is the object `<prefix><project>/<attempt>/s<nn>`.",
      }),
    ),
    store_cleaned_at: Type.Optional(
      describe(Timestamp, "When the attempt's leftover store objects were deleted after sync."),
    ),
    imported_at: Type.Optional(
      describe(
        Timestamp,
        "When a spool archive was last imported (`remote import`): the worker reported offline, never live.",
      ),
    ),
    expected_back_by: Type.Optional(
      describe(
        Timestamp,
        "An exported attempt (Colab): when its results should be back, the export time plus the job's time limit plus `remote.export_slack_min`. Absent without a time limit. Passing it makes the attempt overdue; nothing fails it automatically.",
      ),
    ),
    overdue_at: Type.Optional(
      describe(
        Timestamp,
        "When the coordinator saw an exported attempt still unreported after `expected_back_by`. Import its archive, or mark it lost.",
      ),
    ),
    marked_lost_at: Type.Optional(
      describe(
        Timestamp,
        "When a researcher marked an exported attempt lost (`remote resolve JOB --lost`): it ended `unknown`, releasing its parallel slot. A late import still lands and settles it.",
      ),
    ),
    compute_units: Type.Optional(ColabComputeUnits),
  },
  {
    title: "RemoteAttemptInfo",
    description: "Remote execution, connectivity and sync status of one attempt.",
    additionalProperties: false,
  },
);
export type RemoteAttemptInfo = Static<typeof RemoteAttemptInfo>;

export const WorkerPhase = Type.Union(
  [
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("exited"),
    Type.Literal("lost"),
    Type.Literal("draining"),
  ],
  {
    title: "WorkerPhase",
    description:
      "`lost`: the worker restarted and the job's process was gone without an exit record (a reboot, a requeue). It is never rerun.",
  },
);

/** `POST /api/v1/jobs/:id/attempts/:a/handshake` (launch or upload token). */
export const WorkerHandshake = Type.Object(
  {
    schema_version: Type.Literal(1),
    worker_id: Type.String({ pattern: "^w-[a-f0-9]{8,32}$" }),
    hostname: Type.String({ maxLength: 253 }),
    worker_version: Type.String({ maxLength: 100 }),
    bundle_id: Type.String({ pattern: "^b-[a-f0-9]{12}$" }),
    provider_job_id: Type.Optional(Type.String({ maxLength: 200 })),
    phase: WorkerPhase,
    last_acked_seq: describe(
      Type.Integer({ minimum: -1 }),
      "The worker's own acknowledged cursor (it may lag the coordinator's after a lost response).",
    ),
    spool: WorkerSpoolReport,
    drained: describe(
      Type.Boolean(),
      "The job has exited and every event and artifact was acknowledged.",
    ),
    refresh: describe(Type.Boolean(), "Ask for a fresh upload token."),
  },
  {
    title: "WorkerHandshake",
    description: "Reconnection handshake and heartbeat from a remote worker (spec §5.3).",
    additionalProperties: false,
  },
);
export type WorkerHandshake = Static<typeof WorkerHandshake>;

export const WorkerHandshakeReply = Type.Object(
  {
    schema_version: Type.Literal(1),
    spool_acked_seq: Type.Integer({ minimum: -1 }),
    cancel_requested: Type.Boolean(),
    heartbeat_sec: Type.Integer({ minimum: 1 }),
    upload_token: Type.Optional(Type.String({ maxLength: 200 })),
    upload_expires_at: Type.Optional(Timestamp),
    artifacts: Type.Array(
      Type.Object(
        {
          path: Type.String({ maxLength: 1024 }),
          sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        },
        { title: "ReceivedArtifact", additionalProperties: false },
      ),
      { maxItems: 10_000, description: "Artifacts already received, so they are not re-sent." },
    ),
  },
  { title: "WorkerHandshakeReply", additionalProperties: false },
);
export type WorkerHandshakeReply = Static<typeof WorkerHandshakeReply>;

/** `.../attempts/<a>/uploads/<upload-id>.json`: a resumable artifact upload at the coordinator. */
export const ResumableUpload = Type.Object(
  {
    schema_version: Type.Literal(1),
    upload_id: Type.String({ pattern: "^u-[a-f0-9]{16}$" }),
    attempt_id: AttemptId,
    path: Type.String({ minLength: 1, maxLength: 1024 }),
    size: Type.Integer({ minimum: 0 }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    received: Type.Integer({ minimum: 0 }),
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  {
    title: "ResumableUpload",
    description:
      "Chunked upload state: an interrupted upload resumes at `received` (spec §5.7: interrupted artifact upload).",
    additionalProperties: false,
  },
);
export type ResumableUpload = Static<typeof ResumableUpload>;

/** `credentials.json` next to an unpacked bundle (0600). Never inside the bundle archive. */
export const WorkerCredentials = Type.Object(
  {
    schema_version: Type.Literal(1),
    launch_token: Type.String({ maxLength: 200 }),
    launch_expires_at: Timestamp,
    upload_token: Type.String({ maxLength: 200 }),
    upload_expires_at: Timestamp,
    ntfy: Type.Optional(
      Type.Object(
        { url: HttpUrl, token: Type.Optional(Type.String({ maxLength: 500 })) },
        { title: "WorkerNtfy", additionalProperties: false },
      ),
    ),
    artifact_store: Type.Optional(
      Type.Object(
        {
          min_bytes: Type.Integer({
            minimum: 0,
            description: "Artifacts at least this large go to the store.",
          }),
          slots: Type.Array(
            Type.Object(
              {
                slot: Type.Integer({ minimum: 0, maximum: 63 }),
                url: Type.String({ pattern: "^https?://[^ ]+$", maxLength: 4096 }),
                expires_at: Timestamp,
              },
              { title: "WorkerStoreSlot", additionalProperties: false },
            ),
            { maxItems: 64 },
          ),
        },
        {
          title: "WorkerArtifactStore",
          description:
            "Presigned PUT URLs for an S3-compatible store: the worker uploads a large artifact there without the coordinator, then reports a receipt naming the slot; the coordinator pulls, verifies the SHA-256, stores it through MLflow and deletes the object (ADR 0023 decision 24).",
          additionalProperties: false,
        },
      ),
    ),
  },
  {
    title: "WorkerCredentials",
    description:
      "Scoped worker credentials: a launch token that can only perform the handshake (and so refresh), and a short-lived upload token.",
    additionalProperties: false,
  },
);
export type WorkerCredentials = Static<typeof WorkerCredentials>;
