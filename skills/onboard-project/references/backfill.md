# Backfilling research context: the project's first vault

The researcher reads a project's **vault**: atomic notes, each one idea stated once and readable
at three depths, composed by embedding into notebooks, with a ledger of where the project stands.
Onboarding writes its first version from what the repository already knows. The coordinator owns
the notes; the MCP tools write them, attributed to your agent session; `task_id` records one under
the onboarding task. The `research-task` skill's `references/writing.md` says how a note, a
notebook, an edition and the ledger are written: read it first.

## What to write

Start with the fundamentals. A repository's own notes describe the research process and assume
the reader knows the architecture; the vault must not.

| Source in the repository | Note | `ablationkit_note add` |
| --- | --- | --- |
| What the model is and why; each component; the data and tokenizers; the metric; how training and evaluation are set up; every name and abbreviation (README, docs, source) | one `concept` per idea (`method` for how this project does something), with `aliases` for abbreviations | `sources: ["repo:<path>"]`; explain mechanisms concretely: shapes, steps, a small example, a formula |
| The question the code is built to answer ("does X beat Y") | a `claim` with `standing: open` (`leaning` only if recorded runs already bear on it) | `support`, `would_change`; confirm it with the researcher |
| A comparison the repository ran or plans | the study (`ablationkit_run study`), and an `experiment` note that names it | `study: <study-id>` |
| What earlier runs showed, once imported ([history.md](history.md)) | a `finding` per observation | `evidence: [{run: <run name>, role, metric}]`; say in the text that the runs are imported and what that limits |
| Results in README tables, papers or notebooks with no run files behind them | a `finding` that says so, with no `evidence` | see below |
| Decisions already made ("we dropped dropout because …") | a `decision` (`standing: in_force` only if the researcher confirms; else `proposed`) | the reason in the summary |
| What the repository does not say, or says in two ways | a `question` (`standing: open`) | `bears_on` the claim it affects |
| Facts from onboarding (entrypoint, environment, instrumentation, gaps), renames, what was imported | `log` notes, one fact each | |
| Chat threads the researcher points to | a conversation link, cited from the notes it informed | `ablationkit_do conversation.link`, then `sources: ["conversation:<id>"]` |

Then compose (`references/writing.md`, "Composition"):

1. A **fundamentals notebook** ("How <project> works") that embeds the concept notes in the order
   a newcomer needs them, with chapters (nested notebooks) if it runs past a dozen notes. It goes
   first on the shelf.
2. A **notebook per research question**, embedding the claim, the experiment, the findings and the
   open questions, with your sentences between them carrying the argument.
3. One **log notebook** for the log notes, last on the shelf.
4. The **edition** for the onboarding session (`edition: <today>`): the notes this session wrote,
   in the order that tells what happened. It completes the onboarding task.
5. `ablationkit_note ledger`: the `shelf`, the `order` of the claims, and a `bottom_line` that
   says honestly where the project stands ("Tracking works; nothing is settled yet: …").

Finish with `ablationkit_read vault.check` and fix what it names.

## Rules

- **Confirm claims and decisions with the researcher.** You can infer candidates from the code and
  README, but say they are inferred and let the researcher edit or drop them.
- **Never invent.** A description of how the code works comes from the repository
  (`repo:<path>`); a result comes from a run. If the sources do not say, write a `question`.
- **Results without run files are not evidence.** A run that left files is imported (history.md)
  and cited by name. A number that exists only in a README table or a paper goes in a finding's
  text with its source and the words "not reproduced under AblationKit", and no `evidence`; a
  claim resting only on such findings stays `open`:

  ```markdown
  The README's results table (commit abc1234) gives the baseline 0.871 validation accuracy. It was
  not re-run under AblationKit.
  ```

- **State each thing once.** The setup every experiment shares is one `method` note that the
  findings link, not a paragraph repeated in each. `ablationkit_read vault.check` names sentences that
  appear in two notes.
- **Conversations are pointers.** Don't fetch, open, summarize or copy a linked conversation's
  content. Write only what the researcher tells you.
- **No secrets** in any note.
- **Don't duplicate.** `ablationkit_read vault.show` and `ablationkit_read note.list` first. A project
  registered before the vault has research records (`ablationkit_read research.list`): distil them into
  notes and cite each in `sources` (`report:<id>`, `hypothesis:<id>`, `task:<id>`) so nothing is
  lost; do not copy them whole.
- **Atomic beats complete.** A note of three sentences that says one thing is better than a page
  that says five. A handful of accurate notes beats a large speculative set.

## Example

```json
{"tool": "ablationkit_note", "arguments": {"action": "add", "note_id": "bits-per-byte", "type": "concept", "title": "Bits per byte",
  "gist": "Bits per byte is the model's loss per byte of text, so models with different tokenizers can be compared.",
  "summary": "It divides the summed cross-entropy, in bits, by the number of UTF-8 bytes the tokens decode to. Lower is better.",
  "full": "$$\\mathrm{BPB} = \\frac{1}{B \\ln 2} \\sum_t -\\ln p(x_t \\mid x_{<t})$$\n\nwhere $B$ is the byte length of the text.",
  "aliases": ["BPB"], "sources": ["repo:fraise/eval.py"], "task_id": "<task-id>"}}
{"tool": "ablationkit_run", "arguments": {"action": "study", "study_id": "tokenizer-ablation", "title": "Does a BPE tokenizer lower loss at equal steps?",
  "summary": "A character tokenizer against BPE 8k at equal steps.",
  "variants": [{"variant_id": "char", "title": "character tokenizer"}, {"variant_id": "bpe", "title": "BPE 8k"}],
  "baseline_variant": "char", "metric_goals": [{"key": "val/bpb", "goal": "min"}],
  "protocol": "3 seeds, 20k steps, val split from data/val.txt"}}
{"tool": "ablationkit_note", "arguments": {"action": "add", "note_id": "bpe-lowers-loss", "type": "claim", "standing": "open",
  "title": "BPE lowers validation loss at equal steps",
  "gist": "A BPE 8k tokenizer reaches a lower [[bits-per-byte|BPB]] than characters at the same number of steps.",
  "summary": "Inferred from the configs and the README and confirmed by the researcher; no tracked run bears on it yet.",
  "support": "no runs yet", "would_change": "Three seeds of each variant at 20k steps.",
  "sources": ["repo:configs/bpe.yaml", "repo:README.md"], "task_id": "<task-id>"}}
{"tool": "ablationkit_note", "arguments": {"action": "add", "note_id": "how-the-model-works", "type": "notebook", "title": "How the model works",
  "gist": "A byte-level language model, its tokenizers and the one metric that compares them.",
  "summary": "The metric first, since everything else is read through it; then the tokenizers.",
  "full": "Every comparison in this project is in one unit.\n\n![[bits-per-byte]]"}}
{"tool": "ablationkit_note", "arguments": {"action": "ledger", "shelf": ["how-the-model-works", "does-bpe-help"],
  "order": ["bpe-lowers-loss"], "bottom_line": "Tracking works and the baseline runs. Whether BPE helps is open: no tracked run bears on it yet."}}
```
