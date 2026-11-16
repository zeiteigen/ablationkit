import { type Static, Type } from "@sinclair/typebox";
import {
  AttemptId,
  describe,
  EventId,
  EventType,
  JobId,
  ProducerId,
  ProjectId,
  SequenceNumber,
  Timestamp,
} from "./common.ts";

const envelopeFields = {
  schema_version: Type.Literal(1),
  event_id: EventId,
  project_id: ProjectId,
  ablationkit_job_id: Type.Optional(JobId),
  attempt_id: Type.Optional(AttemptId),
  producer_id: ProducerId,
  producer_seq: describe(
    SequenceNumber,
    "Per-producer sequence number; with producer_id it orders and dedupes events.",
  ),
  ts: Timestamp,
  type: EventType,
  payload: Type.Record(Type.String(), Type.Unknown(), {
    description: "Typed payload for this event type; a JSON object.",
  }),
};

/** Wire envelope for one event, as a producer (SDK, collector, coordinator) emits it. */
export const EventEnvelope = Type.Object(envelopeFields, {
  title: "EventEnvelope",
  description: "One event as emitted by a producer, before the coordinator journals it.",
  additionalProperties: false,
});
export type EventEnvelope = Static<typeof EventEnvelope>;

/** An envelope as stored in a coordinator JSONL journal, with the journal's own sequence number. */
export const JournalEvent = Type.Object(
  {
    seq: describe(
      SequenceNumber,
      "Journal sequence number, assigned by the single writer; strictly increasing.",
    ),
    ...envelopeFields,
  },
  {
    title: "JournalEvent",
    description: "An event envelope as appended to a coordinator JSONL journal.",
    additionalProperties: false,
  },
);
export type JournalEvent = Static<typeof JournalEvent>;
