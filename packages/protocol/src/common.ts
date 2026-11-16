/**
 * Shared scalar types for every AblationKit protocol schema.
 *
 * Rules that keep TypeScript and Python validation identical (ADR 0005):
 * - Field names are snake_case; every top-level record carries an integer `schema_version`.
 * - No `null`: an optional field is omitted, never set to null.
 * - Patterns are anchored and ASCII-only (`[0-9]`, never `\d`), so JS and Rust regex agree.
 * - Timestamps are RFC 3339 UTC strings, kept as strings so they round-trip byte-for-byte.
 * - A `title` on a schema names the generated Python alias or model.
 */
import { type TSchema, Type } from "@sinclair/typebox";

/** Largest integer both JSON parsers represent exactly. */
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export const ProjectId = Type.String({
  title: "ProjectId",
  description:
    "Stable project identifier (lowercase slug). Never a path; paths live in the local registry.",
  pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
});

const opaqueIdPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";

export const EventId = Type.String({
  title: "EventId",
  description: "Globally unique event identifier chosen by the producer; the dedupe key at ingest.",
  pattern: opaqueIdPattern,
});

export const JobId = Type.String({
  title: "JobId",
  description: "AblationKit job identifier.",
  pattern: opaqueIdPattern,
});

export const AttemptId = Type.String({
  title: "AttemptId",
  description: "Identifier of one attempt of a job.",
  pattern: opaqueIdPattern,
});

export const ProducerId = Type.String({
  title: "ProducerId",
  description: "Identifier of the process or worker that produced an event.",
  pattern: opaqueIdPattern,
});

export const Timestamp = Type.String({
  title: "Timestamp",
  description: "RFC 3339 timestamp in UTC with a `Z` suffix and optional fractional seconds.",
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$",
});

export const EventType = Type.String({
  title: "EventType",
  description: "Dotted lowercase event type, for example `run.started` or `console.line`.",
  pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$",
});

export const SequenceNumber = Type.Integer({
  title: "SequenceNumber",
  description: "Non-negative sequence number.",
  minimum: 0,
  maximum: MAX_SAFE_INTEGER,
});

/** Reuse a named type with a field-specific description (keeps the title, so the alias is shared). */
export function describe<T extends TSchema>(schema: T, description: string): T {
  return { ...schema, description };
}

export const TaskId = Type.String({
  title: "TaskId",
  description: "AblationKit task identifier (UI- or agent-first task).",
  pattern: opaqueIdPattern,
});

export const StudyId = Type.String({
  title: "StudyId",
  description: "Study identifier (a planned comparison: baseline plus variants).",
  pattern: opaqueIdPattern,
});

export const VariantId = Type.String({
  title: "VariantId",
  description: "Variant identifier (one configuration or code change under test).",
  pattern: opaqueIdPattern,
});

/**
 * A metric value as a decimal string (`String(x)` of a finite number). Protocol schemas carry no
 * floats (ADR 0005), and MLflow stays the canonical store of the number.
 */
export const DecimalString = Type.String({
  title: "DecimalString",
  description: "A finite number written as a decimal string, for example `0.8125` or `-1.5e-3`.",
  pattern: "^-?[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?$",
  maxLength: 40,
});
