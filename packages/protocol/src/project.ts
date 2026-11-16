import { type Static, Type } from "@sinclair/typebox";
import { ProjectId } from "./common.ts";

/** `.ablationkit/project.json`: the small, repository-owned manifest in each ML project (spec §3.1). */
/** Task profiles (spec §2.2) select default tabs and views; they never remove capabilities. */
export const TaskProfile = Type.Union(
  ["llm", "rag", "agent", "computer_vision", "tabular", "other"].map((v) => Type.Literal(v)),
  {
    title: "TaskProfile",
    description: "A project task profile: selects default tabs, schemas and starter views.",
  },
);
export type TaskProfile = Static<typeof TaskProfile>;

export const ProjectManifest = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    name: Type.String({
      description: "Human-readable project name.",
      minLength: 1,
      maxLength: 200,
    }),
    description: Type.Optional(Type.String({ description: "Optional one-paragraph summary." })),
    task_profiles: Type.Optional(
      Type.Array(TaskProfile, {
        description:
          "Task profiles; they choose what the UI shows by default, never what exists (spec §2.2).",
        maxItems: 6,
      }),
    ),
  },
  {
    title: "ProjectManifest",
    description: "Repository-owned project manifest stored at `.ablationkit/project.json`.",
    additionalProperties: false,
  },
);
export type ProjectManifest = Static<typeof ProjectManifest>;
