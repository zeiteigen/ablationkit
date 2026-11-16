import { type Static, Type } from "@sinclair/typebox";

/** Resource limits applied with `systemd-run --user --scope` (ADR 0003). */
export const JobLimits = Type.Object(
  {
    memory_max_bytes: Type.Optional(
      Type.Integer({
        minimum: 16 * 1024 * 1024,
        description: "`MemoryMax` (with `MemorySwapMax=0`).",
      }),
    ),
    cpu_quota_percent: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100_000, description: "`CPUQuota`; 100 is one core." }),
    ),
    runtime_max_sec: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 31_536_000, description: "`RuntimeMaxSec`." }),
    ),
    tasks_max: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  },
  {
    title: "JobLimits",
    description: "CPU, memory, time and task limits for one attempt.",
    additionalProperties: false,
  },
);
export type JobLimits = Static<typeof JobLimits>;

/**
 * How the metrics-file adapter reads a job's JSON-lines file (ADR 0042). Here, beside
 * `JobLimits`, because local jobs and remote bundles both carry it.
 */
export const MetricsFormat = Type.Object(
  {
    step_keys: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 250 }), {
        minItems: 1,
        maxItems: 8,
        description:
          'Keys that hold the step, the first holding a non-negative integer wins; nested keys by their flattened name (`validation/global_step`). Default `["step"]`; without one, the line number.',
      }),
    ),
    timestamp_key: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 250,
        description:
          "Key that holds the time: milliseconds, or seconds when below 1e11. Default `timestamp`; without one, the read time.",
      }),
    ),
  },
  {
    title: "MetricsFormat",
    description:
      "How the metrics-file adapter reads each line: nested objects are always flattened with `/`; these name the step and time keys, which are never metrics.",
    additionalProperties: false,
  },
);
export type MetricsFormat = Static<typeof MetricsFormat>;
