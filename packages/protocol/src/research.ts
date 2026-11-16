/**
 * Research knowledge records (spec §5.1 authority note, §6, §9). The coordinator owns these
 * records under `~/.ablationkit/state/<project>/research/`; the project checkout's
 * `.ablationkit/research/` and `.ablationkit/conversations/` are exports of them. ADR 0013.
 *
 * One `ResearchRecord` shape covers every kind. The kind-specific fields are optional here and the
 * coordinator checks which ones a kind may carry, so the file format stays a single schema.
 */
import { type Static, Type } from "@sinclair/typebox";
import { AttemptId, describe, JobId, ProjectId, Timestamp, VariantId } from "./common.ts";

export const ResearchRecordId = Type.String({
  title: "ResearchRecordId",
  description:
    "Research record identifier, unique within a project. Generated as `<prefix>-<date>-<random>`; a study's ID is its `ablationkit.study_id` run tag.",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});

export const ResearchKind = Type.Union(
  [
    Type.Literal("hypothesis"),
    Type.Literal("approach"),
    Type.Literal("note"),
    Type.Literal("report"),
    Type.Literal("decision"),
    Type.Literal("conversation"),
    Type.Literal("study"),
  ],
  {
    title: "ResearchKind",
    description: "What a research record is.",
  },
);
export type ResearchKind = Static<typeof ResearchKind>;

/** Everything a link, lineage step or evidence item can point at. */
export const RefKind = Type.Union(
  [
    Type.Literal("hypothesis"),
    Type.Literal("approach"),
    Type.Literal("note"),
    Type.Literal("report"),
    Type.Literal("decision"),
    Type.Literal("conversation"),
    Type.Literal("study"),
    Type.Literal("variant"),
    Type.Literal("job"),
    Type.Literal("attempt"),
    Type.Literal("run"),
    Type.Literal("metric"),
    Type.Literal("artifact"),
    Type.Literal("commit"),
    Type.Literal("dataset"),
    Type.Literal("evaluation"),
    Type.Literal("logged_model"),
    Type.Literal("model_version"),
    Type.Literal("trace"),
    Type.Literal("task"),
    Type.Literal("inference_session"),
    Type.Literal("inference_evidence"),
    Type.Literal("prompt_version"),
    Type.Literal("golden_set"),
    Type.Literal("llm_evaluation"),
    Type.Literal("llm_evidence"),
    Type.Literal("extension_execution"),
  ],
  {
    title: "RefKind",
    description:
      "Kind of object a reference points at. Compound IDs: variant `study/variant`, metric `run/key`, artifact `run/path`, prompt version `name/version`, golden set `gs-…/version` (or `gs-…` for the set).",
  },
);
export type RefKind = Static<typeof RefKind>;

export const ObjectRef = Type.Object(
  {
    kind: RefKind,
    id: Type.String({ minLength: 1, maxLength: 1024 }),
    label: Type.Optional(Type.String({ maxLength: 300 })),
  },
  {
    title: "ObjectRef",
    description: "A pointer to a research record, run, job, artifact or other object.",
    additionalProperties: false,
  },
);
export type ObjectRef = Static<typeof ObjectRef>;

export const ResearchActor = Type.Object(
  {
    kind: Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("system")]),
    id: Type.Optional(Type.String({ maxLength: 200 })),
  },
  {
    title: "ResearchActor",
    description:
      "Who made a change: a human session, an agent token or the system. Work under a task links the task (`task:ID`).",
    additionalProperties: false,
  },
);
export type ResearchActor = Static<typeof ResearchActor>;

export const EvidenceItem = Type.Object(
  {
    ref: ObjectRef,
    role: Type.Optional(
      Type.Union([
        Type.Literal("baseline"),
        Type.Literal("candidate"),
        Type.Literal("supporting"),
        Type.Literal("contradicting"),
        Type.Literal("context"),
      ]),
    ),
    mlflow_run_id: Type.Optional(Type.String({ maxLength: 128 })),
    attempt_id: Type.Optional(AttemptId),
    job_id: Type.Optional(JobId),
    variant_id: Type.Optional(VariantId),
    source_commit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{7,64}$" })),
    source_dirty: Type.Optional(Type.Boolean()),
    values: Type.Optional(
      Type.Record(Type.String(), Type.String({ maxLength: 64 }), {
        description:
          "Metric values as recorded (latest value per key), as exact decimal strings: protocol schemas carry no floats.",
      }),
    ),
    artifacts: Type.Optional(
      Type.Array(Type.String({ maxLength: 1024 }), {
        maxItems: 200,
        description: "Artifact paths in the run.",
      }),
    ),
    note: Type.Optional(Type.String({ maxLength: 4000 })),
    captured_at: Timestamp,
  },
  {
    title: "EvidenceItem",
    description:
      "One cited piece of evidence: what was observed, and exactly where, kept apart from interpretation.",
    additionalProperties: false,
  },
);
export type EvidenceItem = Static<typeof EvidenceItem>;

export const ConversationSource = Type.Union(
  [
    Type.Literal("chatgpt"),
    Type.Literal("claude"),
    Type.Literal("claude_code"),
    Type.Literal("codex"),
    Type.Literal("other"),
  ],
  { title: "ConversationSource", description: "Where an external conversation lives." },
);
export type ConversationSource = Static<typeof ConversationSource>;

export const StudyVariant = Type.Object(
  {
    variant_id: VariantId,
    title: Type.Optional(Type.String({ maxLength: 300 })),
    description: Type.Optional(Type.String({ maxLength: 8000 })),
  },
  { title: "StudyVariant", additionalProperties: false },
);

export const MetricGoal = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 250 }),
    goal: Type.Union([Type.Literal("min"), Type.Literal("max")]),
  },
  {
    title: "MetricGoal",
    description: "Which direction is better for a metric.",
    additionalProperties: false,
  },
);

export const ResearchRecord = Type.Object(
  {
    schema_version: Type.Literal(1),
    record_id: ResearchRecordId,
    project_id: ProjectId,
    kind: ResearchKind,
    title: Type.String({ minLength: 1, maxLength: 300 }),
    status: Type.Optional(
      Type.String({
        pattern: "^[a-z][a-z_]{0,31}$",
        description: "Kind-specific status, for example `testing` for a hypothesis.",
      }),
    ),
    summary: Type.Optional(
      Type.String({
        maxLength: 20_000,
        description:
          "The short description every kind carries except a conversation link: what it is, why it exists, what came out and what that means for the research goal, in a few sentences. Markdown with LaTeX (`$…$`).",
      }),
    ),
    body: Type.Optional(
      Type.String({
        maxLength: 1_000_000,
        description:
          "The in-depth read, Markdown with LaTeX (`$…$`, `$$…$$`) and tables: a note's text, a report's interpretation, a decision's rationale, an approach's or hypothesis's details, a study's design and reading; a conversation's personal notes.",
      }),
    ),
    tags: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$" }), {
      maxItems: 50,
    }),
    links: Type.Array(ObjectRef, {
      maxItems: 500,
      description: "Related projects' objects: hypotheses, runs, reports, studies and so on.",
    }),
    created_at: Timestamp,
    updated_at: Timestamp,
    created_by: ResearchActor,
    updated_by: ResearchActor,
    revision: Type.Integer({
      minimum: 1,
      description: "Incremented on every change; updates may require the revision they read.",
    }),
    archived_at: Type.Optional(Timestamp),
    // note
    attribution: Type.Optional(
      Type.Object(
        {
          conversation_id: ResearchRecordId,
          mode: Type.Union([Type.Literal("quote"), Type.Literal("summary")]),
        },
        {
          title: "NoteAttribution",
          description:
            "A note that quotes or summarizes a linked conversation. The text is the researcher's; nothing is fetched.",
          additionalProperties: false,
        },
      ),
    ),
    // report, decision
    evidence: Type.Optional(Type.Array(EvidenceItem, { maxItems: 2000 })),
    follow_up: Type.Optional(Type.String({ maxLength: 100_000 })),
    generated: Type.Optional(
      Type.Object(
        {
          study_id: Type.String({ maxLength: 128 }),
          baseline_variant: Type.Optional(VariantId),
          metric_keys: Type.Array(Type.String({ maxLength: 250 }), { maxItems: 100 }),
          runs: Type.Integer({ minimum: 0 }),
          generated_at: Timestamp,
        },
        {
          title: "ReportGeneration",
          description: "Set when the evidence section was generated from a study's runs.",
          additionalProperties: false,
        },
      ),
    ),
    // conversation
    source: Type.Optional(ConversationSource),
    url: Type.Optional(Type.String({ pattern: "^https?://.{1,4000}$" })),
    local_ref: Type.Optional(
      Type.String({
        maxLength: 4000,
        description: "A local session reference, e.g. a Claude Code session ID. Not resolved.",
      }),
    ),
    conversation_created_at: Type.Optional(
      describe(Timestamp, "When the external conversation was created, if the researcher knows."),
    ),
    export_notes: Type.Optional(
      Type.Boolean({
        description:
          "Copy the personal notes into the Git-tracked export. Off by default (spec §9).",
      }),
    ),
    // study
    protocol: Type.Optional(
      Type.String({ maxLength: 20_000, description: "Evaluation protocol of a study." }),
    ),
    baseline_variant: Type.Optional(VariantId),
    variants: Type.Optional(Type.Array(StudyVariant, { maxItems: 200 })),
    metric_goals: Type.Optional(Type.Array(MetricGoal, { maxItems: 100 })),
  },
  {
    title: "ResearchRecord",
    description:
      "A coordinator-owned research record: hypothesis, approach, note, report, decision, conversation link or study.",
    additionalProperties: false,
  },
);
export type ResearchRecord = Static<typeof ResearchRecord>;

export const ResearchExportState = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    imported_at: Type.Optional(
      describe(Timestamp, "When the one-time import from the checkout's export ran."),
    ),
    imported_records: Type.Optional(Type.Integer({ minimum: 0 })),
    import_note: Type.Optional(Type.String({ maxLength: 2000 })),
    last_export_at: Type.Optional(Timestamp),
    last_export_error: Type.Optional(Type.String({ maxLength: 2000 })),
    last_export_redactions: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Fields the last export replaced because they looked like secrets.",
      }),
    ),
    drift: Type.Array(
      Type.Object(
        {
          path: Type.String({ maxLength: 1024 }),
          saved_to: Type.String({ maxLength: 4096 }),
          detected_at: Timestamp,
        },
        {
          title: "ExportDrift",
          description:
            "An export file that was edited by hand. The edit was saved here and the file rewritten from the canonical records.",
          additionalProperties: false,
        },
      ),
      { maxItems: 200 },
    ),
    files: Type.Record(Type.String(), Type.String({ pattern: "^[a-f0-9]{64}$" }), {
      description:
        "SHA-256 of every file the last export wrote, by path relative to `.ablationkit/`. Used to detect hand edits and to remove only files AblationKit wrote.",
    }),
  },
  {
    title: "ResearchExportState",
    description:
      "Per-project export and import bookkeeping, stored in the coordinator state directory.",
    additionalProperties: false,
  },
);
export type ResearchExportState = Static<typeof ResearchExportState>;

export const ReviewMark = Type.Object(
  {
    digest: Type.String({
      pattern: "^[a-f0-9]{16}$",
      description:
        "Hash of what the researcher read (title, status, description, read, evidence and the like; not links or tags). A different hash later shows the item as changed since review.",
    }),
    reviewed_at: Timestamp,
    by: ResearchActor,
    note: Type.Optional(
      Type.String({
        maxLength: 4000,
        description: "The researcher's note on the item. Agents can read it; it grants nothing.",
      }),
    ),
  },
  {
    title: "ReviewMark",
    description: "The researcher read one research record or task (ADR 0048).",
    additionalProperties: false,
  },
);
export type ReviewMark = Static<typeof ReviewMark>;

export const ReviewState = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    items: Type.Record(Type.String({ maxLength: 1100 }), ReviewMark, {
      description: "Review marks by `kind:id` (a research record kind, or `task`).",
    }),
  },
  {
    title: "ReviewState",
    description:
      "What the researcher has reviewed in a project (ADR 0048), stored in the coordinator state directory. A mark records reading, not approval, and decides nothing.",
    additionalProperties: false,
  },
);
export type ReviewState = Static<typeof ReviewState>;
