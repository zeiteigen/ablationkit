/**
 * Directions (ADR 0057): the researcher steers through the record. A direction is the
 * researcher's own words, written in the web UI where they read (a line of Standing, a note, a run,
 * a study, a task, the bottom line or the project as a whole), with a kind that says what they
 * want. Agents receive it on their next AblationKit call (`ablationkit mcp` appends it to that
 * tool's result) and answer it on the record; the researcher closes or reopens the thread.
 *
 * The coordinator owns each direction under `~/.ablationkit/state/<project>/directions/<id>.json`.
 * Only the researcher's session (the human listener) creates, closes, reopens or withdraws one;
 * agents read them and respond (acknowledge, answer, decline). Deliveries record which agent
 * session was shown what.
 */
import { type Static, Type } from "@sinclair/typebox";
import { ProjectId, Timestamp } from "./common.ts";
import { ResearchActor } from "./research.ts";

export const DirectionId = Type.String({
  title: "DirectionId",
  description: "A direction's identifier, `dir-YYYYMMDD-xxxxxx`.",
  pattern: "^dir-[0-9]{8}-[a-z0-9]{6}$",
});

export const DirectionKind = Type.Union(
  [
    Type.Literal("ask"),
    Type.Literal("doubt"),
    Type.Literal("do"),
    Type.Literal("focus"),
    Type.Literal("park"),
    Type.Literal("rule"),
  ],
  {
    title: "DirectionKind",
    description:
      "What the researcher wants. ask: explain or justify this. doubt: I do not believe this; bring more evidence or lower its standing. do: do this next. focus: prioritise this line. park: stop spending on this line for now. rule: a standing rule for every session, in force until the researcher withdraws it.",
  },
);
export type DirectionKind = Static<typeof DirectionKind>;

export const DirectionStatus = Type.Union(
  [
    Type.Literal("open"),
    Type.Literal("acknowledged"),
    Type.Literal("answered"),
    Type.Literal("declined"),
    Type.Literal("closed"),
    Type.Literal("withdrawn"),
  ],
  {
    title: "DirectionStatus",
    description:
      "open: waiting for an agent. acknowledged: an agent said what it will do. answered or declined: an agent answered (with what it changed) or declined (with its reason); waiting for the researcher, who closes it or reopens it (back to open). withdrawn: the researcher took it back. A rule is open until a session acknowledges it and stays in force (open or acknowledged) until withdrawn.",
  },
);
export type DirectionStatus = Static<typeof DirectionStatus>;

export const DirectionTarget = Type.Object(
  {
    kind: Type.Union(
      [
        Type.Literal("note"),
        Type.Literal("run"),
        Type.Literal("study"),
        Type.Literal("task"),
        Type.Literal("bottom_line"),
        Type.Literal("project"),
      ],
      {
        description:
          "note: a note of the vault. run: a run by name or MLflow run ID. study: a study record. task: a research task. bottom_line: the ledger's bottom line. project: the project as a whole.",
      },
    ),
    id: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 250,
        description: "The note, run, study or task; absent for the bottom line and the project.",
      }),
    ),
  },
  {
    title: "DirectionTarget",
    description: "What a direction is about: where the researcher was reading when they wrote it.",
    additionalProperties: false,
  },
);
export type DirectionTarget = Static<typeof DirectionTarget>;

export const DirectionRef = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("note"),
      Type.Literal("run"),
      Type.Literal("job"),
      Type.Literal("study"),
      Type.Literal("task"),
      Type.Literal("work"),
    ]),
    id: Type.String({ minLength: 1, maxLength: 250 }),
  },
  {
    title: "DirectionRef",
    description:
      "Something an answer points at by name: a note it revised, a job or run it ran, a study, a task, a work of the library. It resolved when it was recorded.",
    additionalProperties: false,
  },
);
export type DirectionRef = Static<typeof DirectionRef>;

export const DirectionEntry = Type.Object(
  {
    act: Type.Union(
      [
        Type.Literal("ack"),
        Type.Literal("answer"),
        Type.Literal("decline"),
        Type.Literal("close"),
        Type.Literal("reopen"),
        Type.Literal("withdraw"),
      ],
      {
        description:
          "ack, answer and decline are an agent's; close, reopen and withdraw the researcher's.",
      },
    ),
    at: Timestamp,
    by: ResearchActor,
    text: Type.Optional(Type.String({ maxLength: 8000, description: "Markdown with LaTeX." })),
    refs: Type.Optional(Type.Array(DirectionRef, { maxItems: 50 })),
  },
  {
    title: "DirectionEntry",
    description:
      "One turn of a direction's thread. An agent's entry is attributed to its agent session (`by.id` is the session's token ID).",
    additionalProperties: false,
  },
);
export type DirectionEntry = Static<typeof DirectionEntry>;

export const ResearchDirection = Type.Object(
  {
    schema_version: Type.Literal(1),
    direction_id: DirectionId,
    project_id: ProjectId,
    target: DirectionTarget,
    kind: DirectionKind,
    text: Type.String({
      minLength: 1,
      maxLength: 8000,
      description: "The researcher's words, Markdown with LaTeX.",
    }),
    status: DirectionStatus,
    round: Type.Integer({
      minimum: 1,
      description:
        "1, and one more each time the researcher reopens it: a reopened direction is delivered again.",
    }),
    thread: Type.Array(DirectionEntry, { maxItems: 500 }),
    deliveries: Type.Array(
      Type.Object(
        {
          session: Type.String({
            minLength: 1,
            maxLength: 200,
            description: "The agent session (its token ID) it was shown to.",
          }),
          at: Timestamp,
          round: Type.Integer({ minimum: 1 }),
        },
        {
          title: "DirectionDelivery",
          description: "One agent session was shown the direction.",
          additionalProperties: false,
        },
      ),
      {
        maxItems: 2000,
        description:
          "Which agent session was shown it, when, and in which round: shown once per session and round.",
      },
    ),
    created_at: Timestamp,
    created_by: ResearchActor,
    via_executive: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          "Written on the researcher's behalf by their executive agent (ADR 0064): its session's label. Absent: the researcher wrote it.",
      }),
    ),
    updated_at: Timestamp,
    revision: Type.Integer({ minimum: 1 }),
  },
  {
    title: "ResearchDirection",
    description:
      "The researcher's direction to the agents working on a project (ADR 0057), anchored where they read, with its thread and its deliveries. Written by the researcher only; agents respond.",
    additionalProperties: false,
  },
);
export type ResearchDirection = Static<typeof ResearchDirection>;
