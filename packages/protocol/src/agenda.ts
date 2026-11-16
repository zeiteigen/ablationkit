/**
 * The agenda (ADR 0058): the researcher's plan for a project, which agents work from.
 * An ordered list of items in lanes (now, next, parked, dropped), each a vault note it points at
 * (`note:<id>`, an open question or a claim of the ledger) or a line of the researcher's own text,
 * and the rules every agent session follows. Written only on the human listener; agents read it.
 *
 * The coordinator owns it under `~/.ablationkit/state/<project>/vault/`: `agenda.json` (the
 * agenda, with the last revisions so a session can be told what changed since it last read) and
 * `agenda-seen.json` (the revision each agent session last read).
 */
import { type Static, Type } from "@sinclair/typebox";
import { ProjectId, Timestamp } from "./common.ts";
import { ResearchActor } from "./research.ts";

export const AgendaLane = Type.Union(
  [Type.Literal("now"), Type.Literal("next"), Type.Literal("parked"), Type.Literal("dropped")],
  {
    title: "AgendaLane",
    description:
      "now: what agents should work on. next: what comes after. parked: do not spend on it for now. dropped: decided against, with a reason.",
  },
);
export type AgendaLane = Static<typeof AgendaLane>;

export const AgendaItemId = Type.String({
  title: "AgendaItemId",
  description:
    "An agenda item's identifier: `note:<note-id>` for an item that is a vault note, `L<n>` for a line of the researcher's own text. Jobs and tasks name it as `agenda_item`.",
  pattern: "^(note:[a-z0-9][a-z0-9-]{0,95}|L[0-9]{1,6})$",
});

export const AgendaItem = Type.Object(
  {
    item_id: AgendaItemId,
    lane: AgendaLane,
    note_id: Type.Optional(
      Type.String({
        pattern: "^[a-z0-9][a-z0-9-]{0,95}$",
        description: "The vault note this item is (an item that is a note has no text).",
      }),
    ),
    text: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 300,
        description: "The researcher's own line (an item that is not a note).",
      }),
    ),
    reason: Type.Optional(
      Type.String({
        maxLength: 500,
        description: "Why it was dropped or parked, in the researcher's words.",
      }),
    ),
    added_at: Timestamp,
    moved_at: Timestamp,
  },
  {
    title: "AgendaItem",
    description:
      "One item of the agenda: a vault note (`note_id`) or a line of text (`text`), in a lane. Its place in the list is its order within its lane.",
    additionalProperties: false,
  },
);
export type AgendaItem = Static<typeof AgendaItem>;

export const AgendaRule = Type.Object(
  {
    rule_id: Type.String({ pattern: "^R[0-9]{1,6}$" }),
    text: Type.String({ minLength: 1, maxLength: 300 }),
    added_at: Timestamp,
  },
  {
    title: "AgendaRule",
    description:
      "A standing instruction for every agent session of the project, in the researcher's words (`three seeds before anything is established`).",
    additionalProperties: false,
  },
);
export type AgendaRule = Static<typeof AgendaRule>;

export const AgendaRevision = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    at: Timestamp,
    by: ResearchActor,
    items: Type.Array(AgendaItem, { maxItems: 200 }),
    rules: Type.Array(AgendaRule, { maxItems: 50 }),
  },
  {
    title: "AgendaRevision",
    description: "The agenda as one revision left it.",
    additionalProperties: false,
  },
);
export type AgendaRevision = Static<typeof AgendaRevision>;

export const Agenda = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    revision: Type.Integer({
      minimum: 0,
      description: "Moves on every change; 0 for an agenda never written.",
    }),
    items: Type.Array(AgendaItem, {
      maxItems: 200,
      description: "In order: an item's place among the items of its lane is its priority.",
    }),
    rules: Type.Array(AgendaRule, { maxItems: 50 }),
    next_line: Type.Integer({ minimum: 1, description: "The number the next `L<n>` takes." }),
    next_rule: Type.Integer({ minimum: 1, description: "The number the next `R<n>` takes." }),
    updated_at: Timestamp,
    updated_by: ResearchActor,
    history: Type.Array(AgendaRevision, {
      maxItems: 50,
      description:
        "The last revisions, oldest first (the current one included), so a session is told what changed since the revision it last read.",
    }),
  },
  {
    title: "Agenda",
    description:
      "A project's agenda (ADR 0058): the researcher's plan, which agents work from. Only the researcher writes it (the human listener); agents read it, and are told when it changed since they last read it.",
    additionalProperties: false,
  },
);
export type Agenda = Static<typeof Agenda>;

export const AgendaSeen = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    sessions: Type.Record(
      Type.String({ maxLength: 128 }),
      Type.Object(
        { revision: Type.Integer({ minimum: 0 }), at: Timestamp },
        { title: "AgendaSeenMark", additionalProperties: false },
      ),
      { description: "By agent token ID: the agenda revision the session last read, and when." },
    ),
  },
  {
    title: "AgendaSeen",
    description:
      "Which revision of the agenda each agent session last read (ADR 0058). It records reading, not agreement.",
    additionalProperties: false,
  },
);
export type AgendaSeen = Static<typeof AgendaSeen>;
