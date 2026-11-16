/**
 * `ablationkit vault` (ADR 0049, 0052): a vault kept as Markdown files comes in whole with its
 * library, reads back in a terminal, exports its citations, and goes out as the same files.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, Harness } from "./helpers.ts";

const h = new Harness();
afterEach(h.cleanup);
const tmp = () => h.tmp("ak-vault-cli-");
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env: ENV });

async function setup() {
  const home = tmp();
  await h.start(home, {}, { jobs: { supervisor: "direct" } });
  const repo = join(tmp(), "lab");
  git(tmp(), "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "train.py"), "print(1)\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const run = (...argv: string[]) => cli(home, argv);

  expect((await run("project", "add", repo, "--id", "lab")).code).toBe(0);
  return { run };
}

const CONCEPT = `---
id: bits-per-byte
type: concept
title: Bits per byte
gist: "Bits per byte is the loss per byte of text: models with different tokenizers compare."
aliases: [BPB]
sources: ["repo:README.md"]
created: 2026-11-02
---

It divides the summed cross-entropy in bits by the bytes the tokens decode to.

<!-- full -->

For a sequence of $N$ bytes the value is $-\\frac{1}{N}\\sum_t \\log_2 p(x_t)$.
`;
const CLAIM = `---
id: width-helps
type: claim
title: Width helps at this scale
gist: "Doubling the width lowers validation loss at equal steps."
standing: leaning
key: { text: "0.41 → 0.37", label: "validation loss, base to wide" }
support: "2 runs · one seed"
evidence:
  - { run: base-s0, role: baseline, metric: val_loss }
  - { run: wide-s0, role: for, metric: val_loss }
sources: ["repo:train.py"]
created: 2026-11-03
updated: 2026-11-04
---

One comparison supports it; the metric is [[bits-per-byte|BPB]].
`;
const NOTEBOOK = `---
id: does-width-help
type: notebook
title: Does width help?
gist: "Width helps in the one comparison run so far."
created: 2026-11-03
---

This notebook says what was compared and what it showed.

The metric first.

![[bits-per-byte]]

Then what the comparison showed.

![[width-helps]]
`;
const INDEX = `shelf: [does-width-help]
ledger:
  bottom_line: "Width helps in one seed; a second seed is next."
  order: [width-helps]
`;

const WORK = `---
id: zagoruyko-2016-wide
kind: paper
title: Wide Residual Networks
authors: ["Zagoruyko, Sergey", "Komodakis, Nikos"]
year: 2016
venue: BMVC 2016
arxiv: 1605.07146
reading: skimmed
takeaway: "The width result this project tests at language-model scale."
---

Widening residual blocks beats deepening them at equal parameters.
`;
const ASIDE = `---
id: karpathy-nanogpt
kind: repo
title: nanoGPT
authors: ["Karpathy, Andrej"]
url: https://github.com/karpathy/nanoGPT
reading: skimmed
takeaway: "Set aside: it ties embeddings."
---
`;

function vaultDir(): string {
  const dir = tmp();
  mkdirSync(join(dir, "notes"));
  writeFileSync(join(dir, "notes", "bits-per-byte.md"), CONCEPT);
  writeFileSync(join(dir, "notes", "width-helps.md"), CLAIM);
  writeFileSync(join(dir, "notes", "does-width-help.md"), NOTEBOOK);
  writeFileSync(join(dir, "index.yaml"), INDEX);
  return dir;
}

function withLibrary(dir: string): string {
  mkdirSync(join(dir, "works"));
  writeFileSync(join(dir, "works", "zagoruyko-2016-wide.md"), WORK);
  writeFileSync(join(dir, "works", "karpathy-nanogpt.md"), ASIDE);
  writeFileSync(
    join(dir, "notes", "width-helps.md"),
    CLAIM.replace(
      'sources: ["repo:train.py"]',
      'sources: ["repo:train.py"]\ncites:\n  - { work: zagoruyko-2016-wide, role: inspiration, where: "§4" }',
    ),
  );
  return dir;
}

describe("ablationkit vault (ADR 0049)", () => {
  test("import brings Markdown notes and the index in; show, check and export read them back", async () => {
    const { run } = await setup();
    expect((await run("vault", "show", "--project", "lab")).out).toContain("the vault is empty");
    const dir = vaultDir();
    const dry = await run("vault", "import", dir, "--project", "lab", "--dry-run");
    expect(dry.out).toContain("3 notes and index.yaml read without a problem");
    expect((await run("vault", "show", "--project", "lab")).out).toContain("the vault is empty");

    const first = await run("vault", "import", dir, "--project", "lab");
    expect(first.code).toBe(0);
    expect(first.out).toContain("3 notes created, 0 updated, 0 unchanged; shelf and ledger set");
    // The runs the claim cites are not runs of this project: a check, not a refusal.
    expect(first.out).toContain("unknown_run");
    const again = await run("vault", "import", dir, "--project", "lab");
    expect(again.out).toContain("0 notes created, 0 updated, 3 unchanged");

    const shown = await run("vault", "show", "--project", "lab");
    expect(shown.out).toContain("Width helps in one seed; a second seed is next.");
    expect(shown.out).toContain("leaning\n  Width helps at this scale  [0.41 → 0.37]");
    expect(shown.out).toContain("Does width help? (2 parts)");
    expect(shown.out).toContain("3 notes · 0 editions · 3 unread");
    const check = await run("vault", "check", "--project", "lab", "--json");
    const codes = (JSON.parse(check.out) as { checks: { code: string }[] }).checks.map(
      (c) => c.code,
    );
    expect([...new Set(codes)]).toEqual(["unknown_run"]);

    // Out again: the same fields, the notebook's opening paragraph as its summary.
    const out = tmp();
    expect((await run("vault", "export", "--out", out, "--project", "lab")).code).toBe(0);
    const claim = readFileSync(join(out, "notes", "width-helps.md"), "utf8");
    expect(claim).toContain("standing: leaning");
    expect(claim).toContain("updated: 2026-11-04");
    expect(claim).toContain("[[bits-per-byte|BPB]]");
    const nb = readFileSync(join(out, "notes", "does-width-help.md"), "utf8");
    expect(nb).toContain(
      "This notebook says what was compared and what it showed.\n\n<!-- full -->\n\nThe metric first.",
    );
    expect(readFileSync(join(out, "index.yaml"), "utf8")).toContain("does-width-help");
    // What was exported imports as no change at all.
    const round = await run("vault", "import", out, "--project", "lab");
    expect(round.out).toContain("0 notes created, 0 updated, 3 unchanged");
  });

  test("a vault with a problem is not imported in part", async () => {
    const { run } = await setup();
    const dir = vaultDir();
    writeFileSync(join(dir, "notes", "broken.md"), "no frontmatter here\n");
    writeFileSync(
      join(dir, "notes", "from-nowhere.md"),
      CONCEPT.replace("id: bits-per-byte", "id: from-nowhere").replace(
        '["repo:README.md"]',
        "[rep-20260101-abcdef]",
      ),
    );
    const r = await run("vault", "import", dir, "--project", "lab");
    expect(r.code).toBe(1);
    expect(r.err).toContain("2 problems; nothing was imported");
    expect(r.err).toContain("broken.md: no frontmatter");
    expect(r.err).toContain('source "rep-20260101-abcdef" is not a record or task of lab');
    expect((await run("vault", "show", "--project", "lab")).out).toContain("the vault is empty");
    expect((await run("vault", "nope")).code).not.toBe(0);
  });

  test("the library comes in with the notes, lists by role, exports citations and goes out again", async () => {
    const { run } = await setup();
    const dir = withLibrary(vaultDir());
    expect((await run("vault", "import", dir, "--project", "lab", "--dry-run")).out).toContain(
      "3 notes, 2 works and index.yaml read without a problem",
    );
    const r = await run("vault", "import", dir, "--project", "lab");
    expect(r.out).toContain("2 works created, 0 updated, 0 unchanged");

    const works = await run("vault", "works", "--project", "lab");
    expect(works.out).toContain(
      "used\n  zagoruyko-2016-wide  Zagoruyko and Komodakis 2016: Wide Residual Networks\n    inspiration in width-helps",
    );
    expect(works.out).toContain("considered and set aside\n  karpathy-nanogpt");
    expect(works.out).toContain("https://arxiv.org/abs/1605.07146");
    expect((await run("vault", "works", "--project", "lab", "--role", "method")).out).toContain(
      "no work matches",
    );

    const bib = await run("vault", "cite", "--project", "lab");
    expect(bib.out).toContain("@inproceedings{zagoruyko-2016-wide,");
    expect(bib.out).toContain("Role: inspiration in “Width helps at this scale” (§4)");
    const file = join(tmp(), "refs.json");
    const csl = await run(
      "vault",
      "cite",
      "--project",
      "lab",
      "--format",
      "csl-json",
      "--cited",
      "--out",
      file,
    );
    expect(csl.out).toContain("wrote 1 citation (csl-json)");
    expect((JSON.parse(readFileSync(file, "utf8")) as { id: string }[]).map((i) => i.id)).toEqual([
      "zagoruyko-2016-wide",
    ]);
    const md = await run(
      "vault",
      "cite",
      "--project",
      "lab",
      "--format",
      "markdown",
      "--notebook",
      "does-width-help",
    );
    expect(md.out).toContain("# Does width help?: works cited");
    expect(md.out).toContain("## Suggested what to try");
    expect((await run("vault", "cite", "--project", "lab", "--format", "ris")).code).not.toBe(0);

    const out = tmp();
    expect((await run("vault", "export", "--out", out, "--project", "lab")).out).toContain(
      "3 notes, 2 works and index.yaml",
    );
    const w = readFileSync(join(out, "works", "zagoruyko-2016-wide.md"), "utf8");
    expect(w).toContain("Widening residual blocks beats deepening them");
    expect(readFileSync(join(out, "notes", "width-helps.md"), "utf8")).toContain("inspiration");
    const round = await run("vault", "import", out, "--project", "lab");
    expect(round.out).toContain(
      "0 notes created, 0 updated, 3 unchanged; 0 works created, 0 updated, 2 unchanged",
    );
  });
});
