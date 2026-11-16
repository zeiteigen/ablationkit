/**
 * Agent containers (ADR 0061): an opt-in hardened mode in which the coordinator runs the
 * researcher's own harness (Claude Code, Codex) inside a rootless Podman container. The container
 * has no GPU, no network of its own and no view of the coordinator's home: the agent reaches
 * AblationKit through its session's agent socket and the outside world through the session's
 * egress proxy, which applies the project's allowlist and records every connection. Local jobs a
 * contained session submits run in job containers of their own (with the GPU), so the token is a
 * boundary as well as an identity for what the agent itself runs.
 *
 * Stored under `<home>/containers/`: `projects/<project>/config.json` (ContainerConfig),
 * `sessions/<session>/session.json` (ContainerSessionRecord) and `sessions/<session>/egress.jsonl`
 * (EgressRecord lines; a job container's egress goes to its attempt's journal).
 */
import { type Static, Type } from "@sinclair/typebox";
import { AttemptId, describe, ProjectId, Timestamp } from "./common.ts";

export const ContainerSessionId = Type.String({
  title: "ContainerSessionId",
  description: "An agent container session: `c-` and twelve hex digits.",
  pattern: "^c-[a-f0-9]{12}$",
});
export type ContainerSessionId = Static<typeof ContainerSessionId>;

export const ContainerHarness = Type.Union(
  [Type.Literal("claude-code"), Type.Literal("codex"), Type.Literal("shell")],
  {
    title: "ContainerHarness",
    description:
      "What runs in the agent container: Claude Code, Codex, or a plain shell (to set the container up or look around).",
  },
);
export type ContainerHarness = Static<typeof ContainerHarness>;

export const HostPattern = Type.String({
  title: "HostPattern",
  description:
    "An egress allowlist entry: `example.com` (that host, ports 80 and 443), `*.example.com` (its subdomains, not the host itself), either with `:port` for one other port, or `*` (any host: the same as egress mode `open`).",
  minLength: 1,
  maxLength: 260,
  pattern: "^(\\*|(\\*\\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?)$",
});

const ContainerPath = Type.String({
  minLength: 1,
  maxLength: 4096,
  description:
    "An absolute path on this machine, or a path relative to the checkout (no `..` segments: checked in code).",
});

const CheckoutPath = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: "^[^/].*$",
  description: "A path relative to the checkout (no `..` segments: checked in code).",
});

export const ContainerEvaluation = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" }),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    command: Type.Array(Type.String({ maxLength: 8192 }), {
      minItems: 1,
      maxItems: 256,
      description:
        "argv, pinned by the researcher. Run from `cwd` in the checkout against the agent's current code, in a job container with the evaluation's `mounts` read-only and no network.",
    }),
    environment: Type.Union([Type.Literal("uv"), Type.Literal("none")]),
    cwd: Type.Optional(CheckoutPath),
    mounts: Type.Array(ContainerPath, {
      maxItems: 32,
      description:
        "Hidden paths (from the config's `hidden`) this evaluation reads, mounted read-only into its job container only.",
    }),
    runtime_max_sec: Type.Integer({ minimum: 1, maximum: 7 * 24 * 3600 }),
  },
  {
    title: "ContainerEvaluation",
    description:
      "A protected evaluation (ADR 0061, after ADR 0033): the researcher pins its command and the hidden data it reads; a contained agent can run it (`evaluation` on job submit) but never read its data, its console or its command's source when that is hidden.",
    additionalProperties: false,
  },
);
export type ContainerEvaluation = Static<typeof ContainerEvaluation>;

export const ContainerCredential = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }),
    upstream: Type.String({
      pattern: "^https://[^/?#]+/?$",
      maxLength: 512,
      description: "The service, e.g. `https://huggingface.co`.",
    }),
    header: Type.String({
      pattern: "^[A-Za-z][A-Za-z0-9-]{0,63}$",
      description: "The header the secret is sent in, e.g. `authorization` or `x-api-key`.",
    }),
    prefix: Type.Optional(
      Type.String({ maxLength: 32, description: "Put before the secret, e.g. `Bearer `." }),
    ),
    from_env: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$",
        description: "The coordinator's environment variable holding the secret.",
      }),
    ),
    from_file: Type.Optional(
      Type.String({
        pattern: "^/.*$",
        maxLength: 4096,
        description: "A file on this machine holding the secret (its first line).",
      }),
    ),
    env: Type.Record(Type.String(), Type.String({ maxLength: 4096 }), {
      description:
        "Environment variables set in the agent container, with `{url}` replaced by this credential's route inside the container (e.g. `HF_ENDPOINT: {url}`). Names are checked in code.",
    }),
  },
  {
    title: "ContainerCredential",
    description:
      "A credential the egress proxy adds to requests, so the secret never enters the container: the container calls `http://127.0.0.1:<port>/<name>/…` and the proxy forwards it to `upstream` with the header set.",
    additionalProperties: false,
  },
);
export type ContainerCredential = Static<typeof ContainerCredential>;

/** `<home>/containers/projects/<project-id>/config.json`: set by the researcher only. */
export const ContainerConfig = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    revision: Type.Integer({ minimum: 1 }),
    updated_at: Timestamp,
    updated_by: Type.String({ maxLength: 200 }),
    image: Type.String({
      minLength: 1,
      maxLength: 512,
      description:
        "The image agent and job containers run (glibc, a shell, Git, CA certificates). AblationKit's own is built by `ablationkit agent image build`.",
    }),
    agent: Type.Object(
      {
        cpus: Type.Integer({ minimum: 1, maximum: 512 }),
        memory_mb: Type.Integer({ minimum: 256, maximum: 4_194_304 }),
        pids_max: Type.Integer({ minimum: 64, maximum: 1_000_000 }),
      },
      {
        title: "ContainerAgentLimits",
        description:
          "The agent container's own limits (kernel-enforced by its cgroup). It has no GPU.",
        additionalProperties: false,
      },
    ),
    egress: Type.Object(
      {
        mode: Type.Union([Type.Literal("allowlist"), Type.Literal("open")], {
          description:
            "`allowlist`: only `allow` and the harness's own hosts. `open`: any host, every connection still recorded.",
        }),
        allow: Type.Array(HostPattern, { maxItems: 512 }),
      },
      { title: "ContainerEgress", additionalProperties: false },
    ),
    hidden: Type.Array(ContainerPath, {
      maxItems: 64,
      description:
        "Paths neither the agent container nor an ordinary job container can see (held-out data, evaluation code). Inside the checkout the working tree is hidden, not Git history: keep protected files out of the repository.",
    }),
    read_only: Type.Array(CheckoutPath, {
      maxItems: 64,
      description: "Checkout paths the agent container can read but not change.",
    }),
    jobs: Type.Object(
      {
        gpu: Type.Union([Type.Literal("all"), Type.Literal("none")], {
          description: "`all`: every GPU the CDI spec names (`nvidia.com/gpu=all`).",
        }),
        network: Type.Union([Type.Literal("none"), Type.Literal("egress")], {
          description:
            "`none`: no network at all (the environment must be synced by the agent first). `egress`: the project's allowlist through the attempt's own proxy.",
        }),
      },
      { title: "ContainerJobs", additionalProperties: false },
    ),
    evaluations: Type.Array(ContainerEvaluation, { maxItems: 32 }),
    credentials: Type.Array(ContainerCredential, { maxItems: 16 }),
    host_code: Type.Union([Type.Literal("refuse"), Type.Literal("allow")], {
      description:
        "Agent operations that run project code on this machine outside a container (extension builds and runs): `refuse` for contained sessions, or `allow` them.",
    }),
    pause_on_compute_limit: Type.Boolean({
      description:
        "Freeze a contained session when the compute limit refuses its job; the researcher resumes it.",
    }),
  },
  {
    title: "ContainerConfig",
    description:
      "How a project's agent containers and their jobs run (ADR 0061). The researcher's: no agent route reads or writes it.",
    additionalProperties: false,
  },
);
export type ContainerConfig = Static<typeof ContainerConfig>;

export const ContainerSessionState = Type.Union(
  [
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("paused"),
    Type.Literal("exited"),
    Type.Literal("failed"),
    Type.Literal("lost"),
  ],
  {
    title: "ContainerSessionState",
    description:
      "`exited`: the harness ended (its exit code is recorded). `failed`: the container did not start. `lost`: the container was gone without an exit being recorded.",
  },
);
export type ContainerSessionState = Static<typeof ContainerSessionState>;

const FileChange = Type.Object(
  {
    path: Type.String({ maxLength: 4096 }),
    status: Type.String({ maxLength: 8, description: "Git's status letters (A, M, D, R, ??)." }),
  },
  { title: "ContainerFileChange", additionalProperties: false },
);

const PackageVersion = Type.Object(
  {
    name: Type.String({ maxLength: 200 }),
    version: Type.String({ maxLength: 100 }),
    previous: Type.Optional(
      Type.String({ maxLength: 100, description: "Changed: the old version." }),
    ),
  },
  { title: "ContainerPackage", additionalProperties: false },
);

export const ContainerCommand = Type.Object(
  {
    at: Type.Optional(Timestamp),
    command: Type.String({ maxLength: 2000 }),
  },
  { title: "ContainerCommand", additionalProperties: false },
);

export const ContainerSnapshot = Type.Object(
  {
    at: Timestamp,
    head: Type.Optional(Type.String({ pattern: "^[a-f0-9]{7,64}$" })),
    dirty: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 500 }),
    packages: Type.Array(PackageVersion, { maxItems: 5000 }),
  },
  {
    title: "ContainerSnapshot",
    description:
      "The checkout's commit and uncommitted files, and the project environment's packages, at a point of the session.",
    additionalProperties: false,
  },
);
export type ContainerSnapshot = Static<typeof ContainerSnapshot>;

/** `<home>/containers/sessions/<session-id>/session.json`. */
export const ContainerSessionRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    session_id: ContainerSessionId,
    project_id: ProjectId,
    token_id: Type.String({
      pattern: "^[a-f0-9]{16}$",
      description: "The agent session token minted for it.",
    }),
    harness: ContainerHarness,
    label: Type.String({ minLength: 1, maxLength: 200 }),
    args: Type.Array(Type.String({ maxLength: 4096 }), {
      maxItems: 64,
      description: "Extra arguments given to the harness.",
    }),
    checkout: Type.String({ pattern: "^/.*$", maxLength: 4096 }),
    container: Type.String({ pattern: "^ak-agent-c-[a-f0-9]{12}$" }),
    image: Type.String({ maxLength: 512 }),
    image_id: Type.Optional(Type.String({ maxLength: 200 })),
    harness_version: Type.Optional(Type.String({ maxLength: 200 })),
    config_revision: Type.Integer({ minimum: 1 }),
    state: ContainerSessionState,
    paused_by: Type.Optional(
      Type.Union([Type.Literal("researcher"), Type.Literal("compute_limit")]),
    ),
    started_by: Type.String({ maxLength: 200 }),
    created_at: Timestamp,
    started_at: Type.Optional(Timestamp),
    ended_at: Type.Optional(Timestamp),
    exit_code: Type.Optional(Type.Integer()),
    error: Type.Optional(Type.String({ maxLength: 2000 })),
    supervisor: Type.Object(
      {
        mode: Type.Union([Type.Literal("systemd"), Type.Literal("direct")]),
        unit: Type.Optional(Type.String({ maxLength: 256 })),
      },
      {
        title: "ContainerSupervisor",
        description:
          "Where the terminal the container is attached to lives: a tmux server in a transient systemd unit, or a detached process.",
        additionalProperties: false,
      },
    ),
    boundary: Type.Object(
      {
        gpu: Type.Literal(false),
        network: Type.Literal("none"),
        egress: Type.Union([Type.Literal("allowlist"), Type.Literal("open")]),
        hidden: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 128 }),
        read_only: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 128 }),
        cpus: Type.Integer({ minimum: 1 }),
        memory_mb: Type.Integer({ minimum: 1 }),
        pids_max: Type.Integer({ minimum: 1 }),
      },
      {
        title: "ContainerBoundary",
        description: "What the container was given when it started, as applied.",
        additionalProperties: false,
      },
    ),
    start: Type.Optional(ContainerSnapshot),
    end: Type.Optional(ContainerSnapshot),
    files_changed: Type.Optional(
      Type.Array(FileChange, {
        maxItems: 2000,
        description:
          "Between the start and end snapshots, from Git: the bind-mounted checkout also shows the researcher's own edits made meanwhile.",
      }),
    ),
    packages_changed: Type.Optional(
      Type.Object(
        {
          added: Type.Array(PackageVersion, { maxItems: 2000 }),
          removed: Type.Array(PackageVersion, { maxItems: 2000 }),
          changed: Type.Array(PackageVersion, { maxItems: 2000 }),
        },
        { title: "ContainerPackagesChanged", additionalProperties: false },
      ),
    ),
    commands: Type.Optional(
      Type.Array(ContainerCommand, {
        maxItems: 1000,
        description:
          "Shell commands as the harness's own transcript recorded them (the agent can write its home, so this is its account, not the coordinator's record).",
      }),
    ),
    login: Type.Optional(
      Type.Object(
        {
          source: Type.String({
            maxLength: 4096,
            description: "The Claude Code configuration directory the login was copied from.",
          }),
          copied_at: Timestamp,
          synced_back: Type.Integer({
            minimum: 0,
            description: "Renewals made in the container and carried back to the source.",
          }),
          synced_in: Type.Integer({
            minimum: 0,
            description: "Renewals made on this machine and carried into the container.",
          }),
          stopped: Type.Optional(
            Type.String({
              maxLength: 500,
              description: "Why keeping the two in step stopped (another account signed in).",
            }),
          ),
        },
        {
          title: "ContainerLogin",
          description:
            "The researcher's Claude Code login, copied into the container at start and kept in step with the source while the session runs (whichever side renews it, the fresher token is carried to the other); the container's copy is deleted when the session ends.",
          additionalProperties: false,
        },
      ),
    ),
    control: Type.Array(
      Type.Object(
        {
          at: Timestamp,
          action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("stop")]),
          by: Type.String({ maxLength: 200 }),
          reason: Type.Optional(Type.String({ maxLength: 500 })),
        },
        { title: "ContainerControl", additionalProperties: false },
      ),
      { maxItems: 1000 },
    ),
  },
  {
    title: "ContainerSessionRecord",
    description:
      "One agent container session (ADR 0061): the harness in its container, the agent session token minted for it, what the container was given, and the provenance recorded at its start and end.",
    additionalProperties: false,
  },
);
export type ContainerSessionRecord = Static<typeof ContainerSessionRecord>;

/** One line of `egress.jsonl`: a connection the egress proxy allowed, refused or lost. */
export const EgressRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    at: Timestamp,
    owner: Type.Union([ContainerSessionId, AttemptId], {
      description: "The container session, or the job attempt, it came from.",
    }),
    kind: Type.Union([Type.Literal("connect"), Type.Literal("http"), Type.Literal("credential")], {
      description:
        "`connect`: an HTTPS tunnel (only the host is known). `http`: a plain HTTP request (method and path known). `credential`: a request through a credential route.",
    }),
    host: Type.String({ maxLength: 260 }),
    port: Type.Integer({ minimum: 0, maximum: 65535 }),
    method: Type.Optional(Type.String({ maxLength: 16 })),
    path: Type.Optional(Type.String({ maxLength: 2000 })),
    credential: Type.Optional(Type.String({ maxLength: 32 })),
    outcome: Type.Union([Type.Literal("allowed"), Type.Literal("denied"), Type.Literal("error")]),
    reason: Type.Optional(Type.String({ maxLength: 500 })),
    status: Type.Optional(Type.Integer({ minimum: 0, maximum: 999 })),
    bytes_up: Type.Optional(Type.Integer({ minimum: 0 })),
    bytes_down: Type.Optional(Type.Integer({ minimum: 0 })),
    duration_ms: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  {
    title: "EgressRecord",
    description: "One connection out of an agent or job container through its egress proxy.",
    additionalProperties: false,
  },
);
export type EgressRecord = Static<typeof EgressRecord>;

export const JobContainer = Type.Object(
  {
    session_id: describe(ContainerSessionId, "The contained session that submitted the job."),
    evaluation: Type.Optional(
      Type.String({
        pattern: "^[a-z][a-z0-9_-]{0,39}$",
        description: "A protected evaluation's name: its pinned command ran, not the agent's.",
      }),
    ),
  },
  {
    title: "JobContainer",
    description:
      "Set on jobs a contained agent session submits (ADR 0061): each local attempt runs in a job container of its own.",
    additionalProperties: false,
  },
);
export type JobContainer = Static<typeof JobContainer>;

export const AttemptContainer = Type.Object(
  {
    name: Type.String({ pattern: "^ak-job-[A-Za-z0-9._-]{1,200}$" }),
    image: Type.String({ maxLength: 512 }),
    image_id: Type.Optional(Type.String({ maxLength: 200 })),
    gpu: Type.Union([Type.Literal("all"), Type.Literal("none")]),
    network: Type.Union([Type.Literal("none"), Type.Literal("egress")]),
    mounts: Type.Array(Type.String({ maxLength: 4096 }), {
      maxItems: 64,
      description: "Hidden paths mounted read-only for a protected evaluation.",
    }),
  },
  {
    title: "AttemptContainer",
    description: "The job container a contained session's local attempt ran in (ADR 0061).",
    additionalProperties: false,
  },
);
export type AttemptContainer = Static<typeof AttemptContainer>;
