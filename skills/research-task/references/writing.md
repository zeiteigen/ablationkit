# Writing a vault the researcher will read

The researcher reads AblationKit, not your session. They arrive at **Standing**: the bottom line,
then the claims as plain sentences grouped by how sure they are, the decisions in force and the
open questions. Every line is a note that unfolds in place (gist, then summary, then full text,
with the notes it rests on inside it), and from any line they can open the notebook that argues
it. Under **Notebooks** they read the shelf in order, the fundamentals first. Reading marks
itself; a note you revise comes back as revised.

So the vault is written the way a careful person keeps notes: small notes, each stated once,
built into a tree. Not one long report per session.

## A note

| Field | What it holds |
| --- | --- |
| `note_id` | Kebab-case words that say what the note is: `macro-tokenizer`, `final-layernorm-missing`. Not a number, not a date alone. It never changes: links and embeds name it. |
| `type` | One of the types below. |
| `title` | At most 80 characters, something a person would say aloud. A claim, finding or decision is titled with a sentence that states it; a concept or method with its name; a question with the question. |
| `gist` | Depth 1. One sentence, at most 180 characters, that **says the thing**: a claim states the claim, a concept says what it is, a decision says what was chosen. With the key number if there is one. Never "this note describes…". |
| `summary` | Depth 2. Two to four sentences (30 to 80 words) that **continue** from the gist: the next most important things to know. It does not restate the gist. |
| `full` | Depth 3. The rest, **continuing** from the summary: mechanism, numbers with units, a formula, a small table. Under about 200 words, no headings. Leave it out when the note is complete at its summary. |

A reader steps gist → summary → full and never reads a sentence twice. Check yours by reading the
three in a row: if the summary's first sentence could replace the gist, rewrite it.

Markdown throughout; LaTeX as `$L = -\ln p$` inline and `$$ … $$` on its own lines. No HTML (it is
shown as text) and no images in prose: a chart, a table across runs or any visualisation is a
`figure` note you embed (see Figures below), and a static image a run produced is a run artifact. No bare IDs, file
paths or internal labels in prose: say "the 64k model with both fixes", and let `evidence` carry
the run. Expand an abbreviation once, in its own concept note, and link it.

### Types

| Type | Is | Its gist says | Also carries |
| --- | --- | --- | --- |
| `concept` | A fundamental: what something is and how it works, independent of any experiment | What it is, in one sentence a newcomer follows | `aliases` (the abbreviation, the plural) |
| `method` | How this project builds or does something | What is done | `aliases` |
| `experiment` | One study: what was compared, under what protocol | What was compared against what | `study` (the study ID: its variant table is shown from the runs) |
| `finding` | What was observed, with its numbers and its limits | The observation with its number | `evidence` (the runs), `key` |
| `claim` | What is believed; rests on findings | The claim itself | `standing`, `support`, `would_change`, `key`; embeds its findings |
| `decision` | A choice made, and why | What was chosen over what | `standing` (`in_force`, `proposed`, `superseded`) |
| `question` | Something not known yet | The question's stakes: what an answer would settle | `standing` (`open`, `answered`), `bears_on` (claims) |
| `log` | Process worth keeping that is not knowledge: renames, imports, setup steps | What happened | |
| `figure` | A chart, table or visualisation drawn live from the runs by code you write | What it shows, as a caption a reader can take away without the picture | `figure: {script}`, `evidence` (the runs it draws) |
| `notebook` | A compilation: connecting prose and embedded notes, read as one piece | What it establishes | `edition` for a session's notebook |

### Standing, support, evidence

- A **claim** is `established` (we act on it), `leaning` (probably true; the support is thin),
  `open` (not known yet) or `ruled_out` (tested and not so). Grade by the evidence, not by hope:
  one seed, one scale or imported runs is `leaning` at most. `support` says how much there is in
  plain words (`4 runs · one seed each · 38M parameters`); `would_change` says what result would
  move it.
- **Evidence** is a list of runs by run name, each with a `role` (`baseline`, `for`, `against`,
  `context`) and the `metric` that matters. Never type a metric's value into `evidence`: the page
  reads it from the run and shows the difference to the baseline. With two baselines, give each
  row its `vs`. In prose, a number you quote is the run's number, with its unit, written as a
  **live reference** (below), never typed.
- **Live references.** `[[run:<run name>#<metric>]]` in a gist, summary or full text is drawn as
  the run's latest value of the metric, rounded, exact on hover and linked to the run;
  `[[run:<run>#<metric> vs <baseline run>]]` is how far the run is from the baseline (its size:
  the sentence says which way, "[[run:fraise#val/bpb vs sym64k]] behind"). Write every number a
  claim, finding or experiment reports this way, and the bottom line's too:
  "ends at [[run:wide-s0#val_loss]], [[run:wide-s0#val_loss vs base-s0]] below the base model".
  A decimal typed by hand is flagged (`unreferenced_number`); settings a run is named after
  (`lr0.5` in `probe-lr0.5`), integers (steps, seeds, sizes) and code are not. A number no run of
  the project recorded (a paper's, a measurement made outside AblationKit) stays as written, and
  the sentence says where it is from.
- `key` is the one number or comparison that carries the note (`1.5180 → 1.4990`) and what it is.
- `sources` say where the note was distilled from: `task:…`, `run:…`, `study:…`, an earlier record
  (`report:…`, `hypothesis:…`), or `repo:<path>` for a file of the repository. They are shown
  last, as provenance.

### Figures

A figure is a note whose `figure.script` draws it, live, from the project's runs. You have full
control: write JavaScript that draws whatever makes the point (a line or scatter plot, bars, a
per-level profile, a table of statistics across runs, small multiples, a heatmap, controls that
redraw). It is shown where the note is embedded, with its gist as the caption below it. No
extension, manifest or build.

The script is the body of an async function, run in a sandboxed frame with no network. In scope:

| Name | What it is |
| --- | --- |
| `el` | The element to draw into: `el.append(…)`. Draw something, or the figure counts as failed. |
| `Plot` | Observable Plot 0.6 (`Plot.plot({marks: […]})`, `Plot.lineY`, `Plot.dot`, `Plot.barY`, `Plot.cell`, `Plot.text`, …). |
| `d3` | d3 7, for anything Plot does not do. |
| `ak.runs.list({filter, limit})` | The project's runs, newest first; MLflow filter syntax (`"tags.ablationkit.study_id = 'my-study'"`, `"params.lr = '0.001'"`). Each run: `run_id`, `run_name`, `status`, `params`, `metrics` (latest values), `tags`. |
| `ak.runs.named(name)`, `ak.runs.get(run_id)` | One run. |
| `ak.runs.history(run_id, key)` | Every logged value of a metric: `[{step, value, timestamp}]`. |
| `ak.artifacts.list(run_id, path?)`, `ak.artifacts.preview(run_id, path)` | A run's files; a small one's `text` (with `json` for a .json file) or an image's `data_url`. |
| `ak.theme` | The page's colours: `fg`, `muted`, `line`, `bg`, `dark`, and `series` (a palette for categories). |

Rules:

- **Read every number from the runs.** Never type a value into the script: select runs by tag or
  name and read their metrics, so the figure stays true as runs are added. Name the runs it
  draws in `evidence` (the reader sees them under the figure; `figure_without_runs` otherwise).
- **One figure, one point.** The gist says what the reader should see ("PC-NCM's bound falls below
  the baseline's within the first hour and stays there"), not "a chart of …". Label axes with
  units. Use `ak.theme.series` for categories, so the figure matches the page in either theme.
- **Embed it where the argument is made**: a finding or claim embeds the figure that shows it, a
  notebook embeds it between the sentences that lead up to it and follow from it.
- **Check it.** A syntax error is refused when you write the note, with its line. You cannot see the
  figure drawn: an error it throws comes back as the `figure_error` check (`ablationkit_read vault.check`)
  once the researcher has opened it. Guard against missing data (a run without the metric) and
  say so in the figure rather than throwing.

```js
const runs = await ak.runs.list({ filter: "tags.ablationkit.study_id = 'ts-dev-pc-vs-ncm'" });
const rows = [];
for (const r of runs) {
  const h = await ak.runs.history(r.run_id, "val/elbo_bits_per_token");
  const t = await ak.runs.history(r.run_id, "val/train_time");
  const at = new Map(t.map((p) => [p.step, p.value]));
  for (const p of h) if (at.has(p.step)) rows.push({ run: r.run_name, s: at.get(p.step), v: p.value });
}
el.append(Plot.plot({
  x: { label: "wall-clock (s)" }, y: { label: "val ELBO (bits/token)" },
  color: { legend: true, range: ak.theme.series },
  marks: [Plot.lineY(rows, { x: "s", y: "v", stroke: "run" })],
}));
```

An extension is for what a figure cannot do: run the project's own Python, call a model or a
backend, or write (the `author-extension` skill).

### Prior work: the library and `cites`

Work from outside the project (a paper, a preprint, a repository, a doc, an issue thread) is
recorded once in the library (`ablationkit_work add`) and cited from each note it bears on, with
the part it plays there:

| Role | The work… |
| --- | --- |
| `method` | is where the note's method comes from (taken or adapted) |
| `solution` | showed how to get past a problem the note records (a fix, a setting, a workaround) |
| `baseline` | is what the note compares against (its method or its reported result) |
| `supports`, `contradicts` | reports what the note says, or otherwise |
| `inspiration` | suggested what to try, not how |
| `tool` | provides code, data or a model the note uses |
| `background` | explains something the note rests on (a concept's origin, a definition) |

`where` points into the work (`§3`, `Table 2`, `src/model.py`); `note` says what exactly was
taken or how the note departs from it. In prose, name a work as a reader would (Xiong et al.
2020), never by its key. A number from a paper goes in a finding that says it is the paper's
number and cites the paper as `baseline` or `supports`; it is never a run's evidence.

A work's own fields are about the work: `summary` is what it says, in your words; `takeaway` is
what this project took from it, or why it was set aside. A work you read and set aside is
recorded too, with why: the next session needs to know it was tried.

## Composition: embeds make the tree

`![[note-id]]` alone on a line embeds that note at that point. `[[note-id]]` or
`[[note-id|words]]` links it.

- **A note embeds smaller notes** when an idea is made of parts: a claim embeds the findings it
  rests on; a concept embeds the sub-concepts it is built from.
- **A notebook** is embeds with your sentences between them: why the next note follows from the
  last, what the previous one left open. Never more than two embeds in a row without prose, and
  the prose never states a fact that belongs in a note (write the note and embed it). Its
  `summary` is its opening paragraph: what it establishes and how it proceeds. `##` headings may
  mark its parts.
- **A notebook embeds notebooks**: a notebook on one question becomes a chapter of a larger one.
- **Depth follows the content.** Some chains are note → notebook; some are
  note → note → notebook → notebook. Do not force a shape and do not nest for its own sake.
- **A note sits in several places** (a concept explained in the fundamentals and needed again in
  an argument; a claim in its question's notebook and in a session's edition). That reuse is the
  point: it is written once.
- Embeds cannot form a cycle (`embed_cycle`): a note embeds smaller notes and links larger ones.

### The shelf, editions, the ledger (`ablationkit_note ledger`)

- **The shelf** is the top-level notebooks in reading order. It starts with the fundamentals: a
  notebook (with chapters if it needs them) that explains the project from first principles to
  someone technically fluent who has been away for a month. Then a notebook per research question.
  Logs go in one notebook at the end.
- **An edition** reports one working session: a short notebook with `edition` set to the date,
  embedding the notes that session produced or changed, in the order that tells what happened. It
  adds no fact of its own; the same notes live in the shelf's notebooks. It is what you complete a
  task with (`notebook_id`).
- **The ledger** is the claims in `order`, most important first, under a `bottom_line`: two or
  three sentences on where the project stands today. Rewrite the bottom line whenever a claim
  moves. Decisions in force and open questions appear from their standing.

## A small example

A session that found a final LayerNorm matters wrote five notes, not one report:

- `layernorm` (concept): what LayerNorm is. Embedded in the fundamentals notebook.
- `gap-audit-38m` (experiment, `study: vocab-gap-audit-38m`): what the audit compared.
- `finalnorm-closes-part-of-the-gap` (finding): "Adding a final LayerNorm lowers the 64k model's
  BPB by 0.019 and leaves the 8k model unchanged." Evidence: the two pairs of runs.
- `final-layernorm-missing` (claim, `leaning`): "Without a final LayerNorm the 64k model is
  penalised more." Embeds the finding; support "4 runs · one seed each".
- `does-it-hold-at-100m` (question, `open`, `bears_on: [final-layernorm-missing]`).

Then it embedded the experiment, the claim and the question in the notebook "Why the 64k model
trailed", wrote `edition-2026-11-11` embedding the same three with two sentences between them,
moved the bottom line, and completed its task with the edition.

## Keeping the vault current

Before you report to the researcher, and before `ablationkit_task complete`, call
`ablationkit_read task.show` and `ablationkit_read vault.check` and clear their `checks`. They advise;
nothing is refused for them, except that a task with an unanswered direction of the researcher's
on it cannot be completed.

| Check | Fix |
| --- | --- |
| `no_notes` | Runs ended under the task and no note says what they showed: write the findings |
| `off_shelf` | Embed the note where it belongs in a notebook the shelf reaches (an edition alone is not enough) |
| `unresolved_embed`, `unresolved_link` | The note named does not exist (a typo, or archived): fix the ID, write the note, or remove the reference |
| `repeated` | The same sentence is in two notes: keep it in one and link or embed it from the other |
| `long_note`, `headings` | The note holds more than one idea: split it, or embed the notes it compiles |
| `long_summary` | Move detail from the summary to the full text |
| `no_summary`, `no_sources`, `no_support`, `no_standing`, `no_study` | Write the field |
| `claim_without_evidence` | A claim beyond `open` cites runs, or embeds the findings that do |
| `unknown_run`, `unknown_study`, `unknown_source`, `unknown_baseline` | The run name, study ID or source is not one of this project's: use the name `ablationkit_read run.search` shows |
| `embeds_without_prose`, `empty_notebook` | Write the sentences that carry the argument between embeds; a notebook embeds notes |
| `empty_shelf`, `shelf_unknown`, `shelf_not_a_notebook` | Put the top-level notebooks on the shelf |
| `no_fundamentals` | Write the concept notes the research assumes, and a notebook for them first on the shelf |
| `no_bottom_line`, `stale_bottom_line`, `ledger_order`, `ledger_unknown` | `ablationkit_note ledger`: rewrite the bottom line, list every claim in `order` |
| `task_without_notes` | A completed task left nothing in the vault: distil its report into notes and cite `task:…` |
| `unknown_work` | The note cites a work the library does not hold (a typo, or archived): add the work, or fix the key |
| `cites_unread` | The note rests on a work marked `unread`: read it and update `reading`, or cite it as `inspiration` |
| `question_without_prior_work` | An open question cites no work: look for what others found (library first) and cite it; record what you read and set aside too |
| `work_without_locator` | Give the work its DOI, arXiv ID or URL |
| `duplicate_work` | Two works are the same: keep one, re-point the notes' `cites`, archive the other |
| `study_status`, `undeclared_variants` | `ablationkit_run study` with the study's `study_id`: `status`, `add_variants` |
| `no_description` | `ablationkit_run describe` each run |
| `unreferenced_number` | Write the number as a live reference, `[[run:<run>#<metric>]]` or `[[run:<run>#<metric> vs <baseline>]]`; if no run recorded it, say in the sentence where it is from |
| `unaccounted_runs` | Every run a task's jobs produced is cited by a note (`evidence`, a live reference or a `run:` source) or set aside: `ablationkit_run describe` with `set_aside` (why it is not reported: diverged, a bug, superseded by a rerun, an exploratory probe). The researcher sees the runs a finding leaves out, with your reasons, under the finding |
| `direction_unanswered` | The researcher wrote a direction (on the note, the task, a run, the bottom line or the project) no agent has answered: `ablationkit_do direction.respond` with `answer` and the refs of what you changed (revise the note first: a doubt moves a standing or brings runs), or `decline` with why; a `rule` is acknowledged (`ack`) |

Also by hand, because no check can see them:

- A note an earlier result contradicts or qualifies: revise it (and its claim's standing) rather
  than adding a note that disagrees with it.
- A question your work answered: set it to `answered` and put the answer in its summary.
- A note that was wrong or merged into another: `ablationkit_note archive`, then fix the notes it
  names in `embedded_in`.
- Whether the researcher has read a note as it now stands: `ablationkit_read note.show` (`read`).
