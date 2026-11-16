/**
 * The vault (ADR 0049): a project's knowledge as atomic notes, each stated once and readable at
 * three cumulative depths (gist, summary, full text), composed by embedding (`![[id]]`) into
 * larger notes and into notebooks, with a ledger of where the project stands.
 *
 * The coordinator owns the vault under `~/.ablationkit/state/<project>/vault/`: one `VaultNote`
 * per file, a `VaultIndex` (the shelf and the ledger), a `VaultReadState` (what the researcher
 * has read), a `VaultSetAside` (the runs the agent set aside, ADR 0056) and the library, one
 * `VaultWork` per file: the prior work (papers, code, docs, issues) consulted for the project,
 * which notes cite with the role it played (ADR 0052). Agents write notes, works, set-aside
 * marks and the index; only the researcher's reading writes read marks.
 */
import { type Static, Type } from "@sinclair/typebox";
import { ProjectId, TaskId, Timestamp } from "./common.ts";
import { ResearchActor } from "./research.ts";

export const VaultNoteId = Type.String({
  title: "VaultNoteId",
  description:
    "A note's identifier, unique within a project: kebab-case words that say what the note is (`macro-tokenizer`, not `note-12`). It is what `[[id]]` links and `![[id]]` embeds name, so it does not change.",
  pattern: "^[a-z0-9][a-z0-9-]{0,95}$",
});

export const VaultDate = Type.String({
  title: "VaultDate",
  description: "A calendar date, `YYYY-MM-DD`.",
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
});

export const VaultNoteType = Type.Union(
  [
    Type.Literal("concept"),
    Type.Literal("method"),
    Type.Literal("experiment"),
    Type.Literal("finding"),
    Type.Literal("claim"),
    Type.Literal("decision"),
    Type.Literal("question"),
    Type.Literal("log"),
    Type.Literal("figure"),
    Type.Literal("notebook"),
  ],
  {
    title: "VaultNoteType",
    description:
      "What a note is. concept: a fundamental, independent of any experiment. method: how this project builds or does something. experiment: one study and its protocol. finding: what was observed, with its numbers and limits. claim: what is believed, with a standing. decision: a choice made and why. question: something not known yet. log: process worth keeping that is not knowledge. figure: a chart, table or visualisation drawn from the project's runs by code the note carries (ADR 0053). notebook: a compilation of embedded notes with connecting prose.",
  },
);
export type VaultNoteType = Static<typeof VaultNoteType>;

export const VaultStanding = Type.Union(
  [
    Type.Literal("established"),
    Type.Literal("leaning"),
    Type.Literal("open"),
    Type.Literal("ruled_out"),
    Type.Literal("in_force"),
    Type.Literal("proposed"),
    Type.Literal("superseded"),
    Type.Literal("answered"),
  ],
  {
    title: "VaultStanding",
    description:
      "Where a claim, decision or question stands. claim: established, leaning, open or ruled_out. decision: in_force, proposed or superseded. question: open or answered. Other types carry none.",
  },
);
export type VaultStanding = Static<typeof VaultStanding>;

export const VaultEvidence = Type.Object(
  {
    run: Type.String({
      minLength: 1,
      maxLength: 250,
      description:
        "A run of the project, by run name (or MLflow run ID). Its values are read from the run when the note is shown: a note never stores a metric value here.",
    }),
    role: Type.Union(
      [
        Type.Literal("baseline"),
        Type.Literal("for"),
        Type.Literal("against"),
        Type.Literal("context"),
      ],
      { description: "What the run is to the note." },
    ),
    metric: Type.Optional(
      Type.String({ minLength: 1, maxLength: 250, description: "The metric key that matters." }),
    ),
    vs: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 250,
        description:
          "The baseline run this row is compared with, when a note has more than one baseline.",
      }),
    ),
    note: Type.Optional(Type.String({ maxLength: 600 })),
  },
  {
    title: "VaultEvidence",
    description: "One run a note rests on.",
    additionalProperties: false,
  },
);
export type VaultEvidence = Static<typeof VaultEvidence>;

export const VaultWorkId = Type.String({
  title: "VaultWorkId",
  description:
    "A work's identifier in the project's library, also its citation key: kebab-case, the first author's family name, the year and a word of the title (`vaswani-2017-attention`), or the project and owner for code (`karpathy-nanogpt`). It does not change.",
  pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
});

export const VaultCiteRole = Type.Union(
  [
    Type.Literal("background"),
    Type.Literal("method"),
    Type.Literal("solution"),
    Type.Literal("baseline"),
    Type.Literal("supports"),
    Type.Literal("contradicts"),
    Type.Literal("inspiration"),
    Type.Literal("tool"),
  ],
  {
    title: "VaultCiteRole",
    description:
      "The part a work plays in a note. background: explains something the note rests on. method: the note's method is taken or adapted from it. solution: it showed how to get past a problem the note records (a fix, a setting, a workaround). baseline: its method or reported result is what the note compares against. supports: it reports what the note says. contradicts: it reports otherwise. inspiration: it suggested what to try, not how. tool: its code, data or model is used.",
  },
);
export type VaultCiteRole = Static<typeof VaultCiteRole>;

export const VaultCite = Type.Object(
  {
    work: VaultWorkId,
    role: VaultCiteRole,
    where: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 120,
        description: "Where in the work: a section, equation, table, figure, page or file.",
      }),
    ),
    note: Type.Optional(
      Type.String({
        maxLength: 600,
        description: "What exactly was taken from it, or how the note departs from it.",
      }),
    ),
  },
  {
    title: "VaultCite",
    description: "One work of the library a note cites, with the role it plays there.",
    additionalProperties: false,
  },
);
export type VaultCite = Static<typeof VaultCite>;

export const VaultNote = Type.Object(
  {
    schema_version: Type.Literal(1),
    note_id: VaultNoteId,
    project_id: ProjectId,
    type: VaultNoteType,
    title: Type.String({
      minLength: 1,
      maxLength: 80,
      description:
        "A claim, finding or decision is titled with a sentence that states it; a concept or method with its name; a question with the question.",
    }),
    gist: Type.String({
      minLength: 1,
      maxLength: 180,
      description:
        "One sentence that says the thing itself (not a description of the note). The first of the three depths.",
    }),
    summary: Type.Optional(
      Type.String({
        maxLength: 20_000,
        description:
          "Two to four sentences that continue from the gist without restating it. For a notebook: its opening paragraph, what it establishes and how it proceeds. Markdown with LaTeX, `[[id]]` links.",
      }),
    ),
    full: Type.Optional(
      Type.String({
        maxLength: 400_000,
        description:
          "The rest, continuing from the summary without restating it. `![[id]]` alone on a line embeds another note at that point. For a notebook: the composition, connecting prose and embeds, optionally under `##` headings.",
      }),
    ),
    standing: Type.Optional(VaultStanding),
    key: Type.Optional(
      Type.Object(
        {
          text: Type.String({ minLength: 1, maxLength: 80 }),
          label: Type.String({ minLength: 1, maxLength: 200 }),
        },
        {
          title: "VaultKey",
          description: "The one number or comparison that carries the note, and what it is.",
          additionalProperties: false,
        },
      ),
    ),
    support: Type.Optional(
      Type.String({
        maxLength: 300,
        description: "Claims: how much evidence, plainly (runs, seeds, scale).",
      }),
    ),
    would_change: Type.Optional(
      Type.String({ maxLength: 600, description: "Claims: what result would move the standing." }),
    ),
    evidence: Type.Optional(Type.Array(VaultEvidence, { maxItems: 200 })),
    figure: Type.Optional(
      Type.Object(
        {
          script: Type.String({
            minLength: 1,
            maxLength: 200_000,
            description:
              "JavaScript, run as the body of an async function in a sandboxed frame with no network: `el` is the element to draw into, `ak` reads the project's runs (`ak.runs.list({filter, limit})`, `ak.runs.get(id)`, `ak.runs.history(id, key)`, `ak.artifacts.list(id, path)`, `ak.artifacts.preview(id, path)`) and gives the theme (`ak.theme`), and `Plot` and `d3` are Observable Plot and d3. Read every number from the runs: never write one in.",
          }),
        },
        {
          title: "VaultFigure",
          description:
            "Figures: the code that draws the figure (ADR 0053). The gist says in words what it shows; the runs it draws from are its `evidence`.",
          additionalProperties: false,
        },
      ),
    ),
    study: Type.Optional(
      Type.String({
        maxLength: 128,
        description: "Experiments: the study record whose variants this note describes.",
      }),
    ),
    aliases: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
        maxItems: 20,
        description:
          "Concepts and methods: other words the term goes by (an abbreviation, a plural), so a mention in another note's prose finds this note.",
      }),
    ),
    bears_on: Type.Optional(
      Type.Array(VaultNoteId, {
        maxItems: 50,
        description: "Questions: the claims an answer would move.",
      }),
    ),
    cites: Type.Optional(
      Type.Array(VaultCite, {
        maxItems: 100,
        description:
          "The prior work the note rests on, from the project's library, each with its role. Shown with the note; exported as citations.",
      }),
    ),
    sources: Type.Array(Type.String({ pattern: "^[a-z_]{1,32}:.{1,1024}$" }), {
      maxItems: 200,
      description:
        "Where the note was distilled from, as `kind:id` (`task:…`, `run:…`, `study:…`, a research record kind) or `repo:<path>` for a file in the project's repository. Provenance, shown last.",
    }),
    task_id: Type.Optional(TaskId),
    edition: Type.Optional(VaultDate),
    created: VaultDate,
    updated: VaultDate,
    created_at: Timestamp,
    updated_at: Timestamp,
    created_by: ResearchActor,
    updated_by: ResearchActor,
    revision: Type.Integer({ minimum: 1 }),
    archived_at: Type.Optional(Timestamp),
  },
  {
    title: "VaultNote",
    description:
      "An atomic note of a project's vault (ADR 0049). `created` and `updated` are when the thing became known and when what the note says last changed; `edition` marks a notebook that reports one working session; `task_id` is the task it was written under.",
    additionalProperties: false,
  },
);
export type VaultNote = Static<typeof VaultNote>;

export const VaultIndex = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    shelf: Type.Array(VaultNoteId, {
      maxItems: 200,
      description:
        "The top-level notebooks in the order to read them, the fundamentals first. Everything else is reached by embedding.",
    }),
    ledger: Type.Object(
      {
        bottom_line: Type.Optional(
          Type.String({
            maxLength: 2000,
            description: "Two or three sentences: where the project stands today.",
          }),
        ),
        order: Type.Array(VaultNoteId, {
          maxItems: 2000,
          description: "The claims, most important first. Claims left out follow in id order.",
        }),
      },
      { title: "VaultLedger", additionalProperties: false },
    ),
    updated_at: Timestamp,
    updated_by: ResearchActor,
    revision: Type.Integer({ minimum: 1 }),
  },
  {
    title: "VaultIndex",
    description:
      "The shelf and the ledger of a project's vault (ADR 0049). Editions are not listed: they are the notebooks that carry an `edition` date.",
    additionalProperties: false,
  },
);
export type VaultIndex = Static<typeof VaultIndex>;

export const VaultReadState = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    notes: Type.Record(
      Type.String({ maxLength: 96 }),
      Type.Object(
        {
          digest: Type.String({
            pattern: "^[a-f0-9]{16}$",
            description:
              "Hash of what the researcher read (title, gist, summary, full text, standing, key, support, evidence). A different hash later shows the note as revised.",
          }),
          read_at: Timestamp,
        },
        { title: "VaultReadMark", additionalProperties: false },
      ),
      { description: "Read marks by note ID." },
    ),
  },
  {
    title: "VaultReadState",
    description:
      "What the researcher has read in a project's vault (ADR 0049). Reading marks itself in the web UI; a mark records reading, approves nothing and no gate reads it.",
    additionalProperties: false,
  },
);
export type VaultReadState = Static<typeof VaultReadState>;

export const VaultSetAside = Type.Object(
  {
    schema_version: Type.Literal(1),
    project_id: ProjectId,
    runs: Type.Record(
      Type.String({ minLength: 1, maxLength: 128 }),
      Type.Object(
        {
          reason: Type.String({
            minLength: 1,
            maxLength: 1000,
            description:
              "Why the run is not reported: diverged, superseded by a rerun, a bug in the code it ran, an exploratory probe. As the agent wrote it.",
          }),
          run_name: Type.Optional(Type.String({ minLength: 1, maxLength: 250 })),
          at: Timestamp,
          by: ResearchActor,
        },
        { title: "VaultSetAsideMark", additionalProperties: false },
      ),
      { description: "Set-aside marks by MLflow run ID." },
    ),
  },
  {
    title: "VaultSetAside",
    description:
      "The runs the agent set aside, each with its reason (ADR 0056): a run a task's jobs produced is cited by a note or set aside, or it is unaccounted for. The reason is the agent's account, not the coordinator's record; a mark gates nothing.",
    additionalProperties: false,
  },
);
export type VaultSetAside = Static<typeof VaultSetAside>;

export const VaultWorkKind = Type.Union(
  [
    Type.Literal("paper"),
    Type.Literal("preprint"),
    Type.Literal("book"),
    Type.Literal("thesis"),
    Type.Literal("report"),
    Type.Literal("repo"),
    Type.Literal("software"),
    Type.Literal("dataset"),
    Type.Literal("model"),
    Type.Literal("docs"),
    Type.Literal("article"),
    Type.Literal("thread"),
    Type.Literal("talk"),
    Type.Literal("other"),
  ],
  {
    title: "VaultWorkKind",
    description:
      "What a work is. paper: published in a journal or conference (`venue`). preprint: arXiv and the like. book, thesis, report (a technical report). repo: a code repository. software: a released package. dataset, model: a published dataset or model card. docs: documentation. article: a blog post or essay. thread: an issue, pull request, forum or Q&A thread. talk: a talk or video.",
  },
);
export type VaultWorkKind = Static<typeof VaultWorkKind>;

export const VaultWorkReading = Type.Union(
  [Type.Literal("unread"), Type.Literal("abstract"), Type.Literal("skimmed"), Type.Literal("read")],
  {
    title: "VaultWorkReading",
    description:
      "How closely the work was read: unread (found, not read yet), abstract (the abstract or README only), skimmed, read (the parts that matter, closely). Said plainly so a reader knows how much a citation rests on.",
  },
);
export type VaultWorkReading = Static<typeof VaultWorkReading>;

export const VaultWork = Type.Object(
  {
    schema_version: Type.Literal(1),
    work_id: VaultWorkId,
    project_id: ProjectId,
    kind: VaultWorkKind,
    title: Type.String({ minLength: 1, maxLength: 400, description: "The work's own title." }),
    authors: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 100,
      description:
        "As `Family, Given` (or an organisation's name), in the work's order. `others` for et al.",
    }),
    year: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3000 })),
    venue: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 300,
        description:
          "Journal, conference, publisher, institution or site (`NeurIPS 2017`, `GitHub`).",
      }),
    ),
    doi: Type.Optional(Type.String({ pattern: "^10\\.[0-9]{4,9}/[^ \\t\\r\\n]{1,300}$" })),
    arxiv: Type.Optional(
      Type.String({
        pattern: "^([0-9]{4}\\.[0-9]{4,5}|[a-z-]+(\\.[A-Z]{2})?/[0-9]{7})(v[0-9]+)?$",
        description: "The arXiv identifier, `1706.03762` (a version, `v2`, when it matters).",
      }),
    ),
    url: Type.Optional(Type.String({ pattern: "^https?://[^ \\t\\r\\n]{1,2000}$" })),
    version: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 120,
        description: "The commit, tag or release consulted (code, data, models, docs).",
      }),
    ),
    accessed: Type.Optional(VaultDate),
    reading: VaultWorkReading,
    summary: Type.Optional(
      Type.String({
        maxLength: 4000,
        description:
          "What the work says or does, in two to five sentences of your own words: its question, method and result as they bear on this project. Markdown with LaTeX. Never pasted from the work.",
      }),
    ),
    takeaway: Type.String({
      minLength: 1,
      maxLength: 600,
      description:
        "What this project took from it, or why it was set aside, in one or two sentences.",
    }),
    found_for: Type.Optional(
      Type.String({
        maxLength: 400,
        description:
          "The problem or question it was looked up for (a note's `[[id]]` may be named).",
      }),
    ),
    found_via: Type.Optional(
      Type.String({
        maxLength: 400,
        description:
          "How it was found: the search and where it was run, or the work that cited it.",
      }),
    ),
    task_id: Type.Optional(TaskId),
    created_at: Timestamp,
    updated_at: Timestamp,
    created_by: ResearchActor,
    updated_by: ResearchActor,
    revision: Type.Integer({ minimum: 1 }),
    archived_at: Type.Optional(Timestamp),
  },
  {
    title: "VaultWork",
    description:
      "A work in a project's library (ADR 0052): prior work consulted for the project, used or set aside, with where to find it, how closely it was read and what the project took from it. Notes cite it (`cites`) with the role it plays; its citation is exported as BibTeX, CSL-JSON or an annotated bibliography.",
    additionalProperties: false,
  },
);
export type VaultWork = Static<typeof VaultWork>;
