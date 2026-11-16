/**
 * `ablationkit vault show|check|works|cite|import|export` over the human API (ADR 0049, 0052).
 * The vault is a project's knowledge as atomic notes, with a library of the prior work they cite;
 * agents write it through `ablationkit mcp`. These commands are the researcher's: read where it
 * stands in a terminal, see what the checks say, list the library and the role each work played,
 * export its citations, and move a vault in or out as Markdown files (one note or work per file,
 * as an Obsidian vault keeps them).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { VaultNote, VaultWork } from "@ablationkit/protocol";
import {
  type IndexInput,
  type NoteInput,
  parseIndexYaml,
  parseNoteMarkdown,
  parseWorkMarkdown,
  renderIndexYaml,
  renderNoteMarkdown,
  renderWorkMarkdown,
  type WorkInput,
} from "@ablationkit/vault/markdown";
import { ApiError, CoordinatorClient } from "../client.ts";
import {
  type CliContext,
  flag,
  parseArgs,
  printJson,
  projectFromCwd,
  UsageError,
} from "../context.ts";

const VAULT_USAGE = `usage:
  ablationkit vault show   [--project ID]            where the project stands: the ledger and the shelf
  ablationkit vault check  [--project ID]            where the vault falls short of how it is written
  ablationkit vault works  [--project ID] [--q WORDS] [--role ROLE] [--standing used|considered|unread]
                                                     the library of prior work: what each was used for
  ablationkit vault cite   [--project ID] [--format bibtex|csl-json|markdown] [--notebook ID]
                           [--cited] [--out FILE]    its citations, the role each work played annotated
  ablationkit vault import DIR [--project ID] [--dry-run]
                                                     DIR/notes/*.md (frontmatter, summary, <!-- full -->,
                                                     full text), DIR/works/*.md (the library) and
                                                     DIR/index.yaml (shelf, ledger)
  ablationkit vault export --out DIR [--project ID]  the same files, written from the vault
  (--project defaults to the registered checkout you are in; all take --json and --coordinator URL)`;

interface Check {
  code: string;
  note?: string;
  message: string;
}
interface Brief {
  note_id: string;
  type: string;
  title: string;
  gist: string;
  standing?: string;
  key?: { text: string; label: string };
  embeds: string[];
}
interface View<N> {
  notes: N[];
  shelf: string[];
  editions: string[];
  ledger: { bottom_line?: string; order: string[] };
  counts: { notes: number; new: number; changed: number; checks: number; works?: number };
  checks?: Check[];
  works?: VaultWork[];
}

const enc = encodeURIComponent;
const STANDING_ORDER = ["established", "leaning", "open", "ruled_out"];

function printChecks(ctx: CliContext, checks: readonly Check[]): void {
  for (const c of checks)
    ctx.out(`  ${c.code.padEnd(22)} ${c.note ? `${c.note}: ` : ""}${c.message}\n`);
}

interface WorkLine {
  work_id: string;
  kind: string;
  cite: string;
  title: string;
  reading: string;
  takeaway: string;
  href?: string;
  standing: "used" | "considered" | "unread";
  roles: string[];
  cited_by: string[];
}

/** Read a vault directory. Problems are collected so a writer sees all of them at once. */
function readVaultDir(dir: string): {
  notes: { id: string; note: NoteInput }[];
  works: { id: string; work: WorkInput }[];
  index?: IndexInput;
  problems: string[];
} {
  const problems: string[] = [];
  const parseAll = <T>(from: string, prefix: string, parse: (text: string, id: string) => T) => {
    const parsed: T[] = [];
    for (const f of existsSync(from) ? readdirSync(from).sort() : []) {
      if (!f.endsWith(".md")) continue;
      try {
        parsed.push(parse(readFileSync(join(from, f), "utf8"), f.slice(0, -3)));
      } catch (e) {
        problems.push(`${prefix}${f}: ${(e as Error).message}`);
      }
    }
    return parsed;
  };
  const notesDir = existsSync(join(dir, "notes")) ? join(dir, "notes") : dir;
  const notes = parseAll(notesDir, "", parseNoteMarkdown);
  const works = parseAll(join(dir, "works"), "works/", parseWorkMarkdown);
  let index: IndexInput | undefined;
  const indexPath = join(dir, "index.yaml");
  if (existsSync(indexPath)) {
    try {
      index = parseIndexYaml(readFileSync(indexPath, "utf8"));
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  return { notes, works, ...(index ? { index } : {}), problems };
}

export async function vaultCommand(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest, ["json", "dry-run", "cited"]);
  const asJson = args.flags["json"] === true;
  if (!sub || !["show", "check", "works", "cite", "import", "export"].includes(sub))
    throw new UsageError(VAULT_USAGE);
  const project = flag(args, "project") ?? projectFromCwd(process.cwd());
  if (!project)
    throw new UsageError(
      "no project: give --project ID, or run this inside a registered checkout (ablationkit project list)",
    );
  const client = await CoordinatorClient.connect(ctx, flag(args, "coordinator"));
  const base = `/api/v1/projects/${enc(project)}`;

  if (sub === "show") {
    const v = await client.request<View<Brief>>("GET", `${base}/vault?brief=1`);
    if (asJson) {
      printJson(ctx, v);
      return 0;
    }
    if (!v.notes.length) {
      ctx.out(
        `${project}: the vault is empty. Agents write it through ablationkit mcp (the research-task skill); a vault kept as Markdown comes in with \`ablationkit vault import DIR\`.\n`,
      );
      return 0;
    }
    const by = new Map(v.notes.map((n) => [n.note_id, n]));
    if (v.ledger.bottom_line) ctx.out(`${v.ledger.bottom_line}\n\n`);
    const claims = v.ledger.order.flatMap((id) => by.get(id) ?? []);
    for (const s of STANDING_ORDER) {
      const group = claims.filter((n) => n.standing === s);
      if (!group.length) continue;
      ctx.out(`${s.replace("_", " ")}\n`);
      for (const n of group)
        ctx.out(`  ${n.title}${n.key ? `  [${n.key.text}]` : ""}\n    ${n.gist}\n`);
    }
    const line = (type: string, standing: string, label: string) => {
      const list = v.notes.filter((n) => n.type === type && n.standing === standing);
      if (!list.length) return;
      ctx.out(`${label}\n`);
      for (const n of list) ctx.out(`  ${n.title}\n`);
    };
    line("decision", "in_force", "decisions in force");
    line("question", "open", "open questions");
    ctx.out("\nshelf\n");
    for (const id of v.shelf) {
      const n = by.get(id);
      if (n) ctx.out(`  ${n.title} (${n.embeds.length} parts)\n    ${n.gist}\n`);
    }
    ctx.out(
      `\n${v.counts.notes} notes · ${v.editions.length} editions · ${v.counts.new} unread, ${v.counts.changed} revised since read · ${v.counts.works ?? 0} works of prior work · ${v.counts.checks} checks\n`,
    );
    return 0;
  }

  if (sub === "works") {
    const q = new URLSearchParams();
    for (const k of ["q", "role", "standing", "kind"]) {
      const v = flag(args, k);
      if (v) q.set(k, v);
    }
    const r = await client.request<{ works: WorkLine[]; total: number }>(
      "GET",
      `${base}/vault/works${q.size ? `?${q}` : ""}`,
    );
    if (asJson) {
      printJson(ctx, r);
      return 0;
    }
    if (!r.total) {
      ctx.out(
        `${project}: ${q.size ? "no work matches" : "the library is empty: agents record the prior work they consult with ablationkit_work add"}\n`,
      );
      return 0;
    }
    const groups: [string, WorkLine[]][] = [
      ["used", r.works.filter((w) => w.standing === "used")],
      ["considered and set aside", r.works.filter((w) => w.standing === "considered")],
      ["found, not read yet", r.works.filter((w) => w.standing === "unread")],
    ];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      ctx.out(`${label}\n`);
      for (const w of list) {
        ctx.out(`  ${w.work_id}  ${w.cite}: ${w.title}\n`);
        if (w.roles.length) ctx.out(`    ${w.roles.join(", ")} in ${w.cited_by.join(", ")}\n`);
        ctx.out(`    ${w.reading}; ${w.takeaway}\n`);
        if (w.href) ctx.out(`    ${w.href}\n`);
      }
    }
    ctx.out(`\n${r.total} work${r.total === 1 ? "" : "s"} · ablationkit vault cite exports them\n`);
    return 0;
  }

  if (sub === "cite") {
    const format = flag(args, "format") ?? "bibtex";
    if (!["bibtex", "csl-json", "markdown"].includes(format))
      throw new UsageError("--format is bibtex, csl-json or markdown");
    const q = new URLSearchParams({ format });
    const notebook = flag(args, "notebook");
    if (notebook) q.set("notebook", notebook);
    if (args.flags["cited"] === true) q.set("cited", "1");
    const r = await client.open("GET", `${base}/vault/citations?${q}`);
    const text = await r.text();
    const count = Number(r.headers.get("x-ablationkit-count") ?? 0);
    const out = flag(args, "out");
    if (!out) {
      ctx.out(text);
      return 0;
    }
    const path = resolve(out);
    writeFileSync(path, text);
    if (asJson) printJson(ctx, { project_id: project, out: path, format, works: count });
    else ctx.out(`wrote ${count} citation${count === 1 ? "" : "s"} (${format}) to ${path}\n`);
    return 0;
  }

  if (sub === "check") {
    const r = await client.request<{ checks: Check[]; total: number }>(
      "GET",
      `${base}/vault/check`,
    );
    if (asJson) printJson(ctx, r);
    else if (!r.total) ctx.out(`${project}: nothing to fix\n`);
    else {
      ctx.out(
        `${project}: ${r.total} check${r.total === 1 ? "" : "s"} (advice; nothing is refused for them)\n`,
      );
      printChecks(ctx, r.checks);
    }
    return 0;
  }

  if (sub === "export") {
    const out = flag(args, "out");
    if (!out) throw new UsageError(VAULT_USAGE);
    const dir = resolve(out);
    const v = await client.request<View<VaultNote>>("GET", `${base}/vault`);
    mkdirSync(join(dir, "notes"), { recursive: true });
    for (const n of v.notes)
      writeFileSync(join(dir, "notes", `${n.note_id}.md`), renderNoteMarkdown(n));
    const works = v.works ?? [];
    if (works.length) mkdirSync(join(dir, "works"), { recursive: true });
    for (const w of works)
      writeFileSync(join(dir, "works", `${w.work_id}.md`), renderWorkMarkdown(w));
    writeFileSync(join(dir, "index.yaml"), renderIndexYaml({ shelf: v.shelf, ledger: v.ledger }));
    if (asJson)
      printJson(ctx, { project_id: project, out: dir, notes: v.notes.length, works: works.length });
    else
      ctx.out(
        `wrote ${v.notes.length} notes${works.length ? `, ${works.length} works` : ""} and index.yaml to ${dir}\n`,
      );
    return 0;
  }

  // import
  const src = args.positional[0];
  if (!src) throw new UsageError(VAULT_USAGE);
  const dir = resolve(src);
  if (!existsSync(dir)) throw new UsageError(`${dir} does not exist`);
  const read = readVaultDir(dir);
  if (!read.notes.length && !read.works.length && !read.problems.length)
    throw new UsageError(`no notes in ${dir} (notes/*.md)`);

  // A source written as a bare ID names a research record or a task of the project.
  const kinds = new Map<string, string>();
  const bare = read.notes.some((n) => (n.note.sources ?? []).some((s) => !/^[a-z_]+:/.test(s)));
  if (bare) {
    const rs = await client.request<{ records: { record_id: string; kind: string }[] }>(
      "GET",
      `${base}/research?archived=include`,
    );
    for (const r of rs.records) kinds.set(r.record_id, r.kind);
    const ts = await client.request<{ tasks: { task_id: string }[] }>("GET", `${base}/tasks`);
    for (const t of ts.tasks) kinds.set(t.task_id, "task");
  }
  const problems = [...read.problems];
  for (const n of read.notes)
    n.note.sources = (n.note.sources ?? []).map((s) => {
      if (/^[a-z_]+:/.test(s)) return s;
      const kind = kinds.get(s);
      if (!kind)
        problems.push(
          `${n.id}: source "${s}" is not a record or task of ${project} (use repo:<path> for a file)`,
        );
      return `${kind ?? "note"}:${s}`;
    });
  if (problems.length) {
    if (asJson) printJson(ctx, { imported: false, problems });
    else {
      ctx.err(
        `${problems.length} problem${problems.length === 1 ? "" : "s"}; nothing was imported\n`,
      );
      for (const p of problems) ctx.err(`  ${p}\n`);
    }
    return 1;
  }
  if (args.flags["dry-run"] === true) {
    if (asJson)
      printJson(ctx, {
        imported: false,
        notes: read.notes.length,
        works: read.works.length,
        index: Boolean(read.index),
      });
    else
      ctx.out(
        `${read.notes.length} notes${read.works.length ? `, ${read.works.length} works` : ""}${read.index ? " and index.yaml" : ""} read without a problem; nothing was imported (--dry-run)\n`,
      );
    return 0;
  }

  const counts = { created: 0, updated: 0, unchanged: 0 };
  const workCounts = { created: 0, updated: 0, unchanged: 0 };
  const refused: string[] = [];
  const put = async (path: string, body: unknown, tally: typeof counts) => {
    try {
      const r = await client.request<{ created: boolean; unchanged?: boolean }>("PUT", path, body);
      if (r.created) tally.created++;
      else if (r.unchanged) tally.unchanged++;
      else tally.updated++;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) throw e;
      refused.push(e.message);
    }
  };
  // Works first, so the notes that cite them resolve.
  for (const w of read.works) await put(`${base}/vault/works/${enc(w.id)}`, w.work, workCounts);
  for (const n of read.notes) await put(`${base}/vault/notes/${enc(n.id)}`, n.note, counts);
  let indexError: string | undefined;
  if (read.index) {
    try {
      await client.request("PUT", `${base}/vault/index`, {
        shelf: read.index.shelf,
        order: read.index.order,
        ...(read.index.bottom_line ? { bottom_line: read.index.bottom_line } : {}),
      });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) throw e;
      indexError = e.message;
    }
  }
  const check = await client.request<{ checks: Check[]; total: number }>(
    "GET",
    `${base}/vault/check`,
  );
  const failed = refused.length > 0 || indexError !== undefined;
  if (asJson)
    printJson(ctx, {
      imported: !failed,
      ...counts,
      works: workCounts,
      refused,
      ...(indexError ? { index_error: indexError } : {}),
      checks: check.checks,
    });
  else {
    ctx.out(
      `${project}: ${counts.created} notes created, ${counts.updated} updated, ${counts.unchanged} unchanged${read.works.length ? `; ${workCounts.created} works created, ${workCounts.updated} updated, ${workCounts.unchanged} unchanged` : ""}${read.index && !indexError ? "; shelf and ledger set" : ""}\n`,
    );
    for (const r of refused) ctx.err(`  refused: ${r}\n`);
    if (indexError) ctx.err(`  index refused: ${indexError}\n`);
    if (check.total) {
      ctx.out(`${check.total} check${check.total === 1 ? "" : "s"} (ablationkit vault check):\n`);
      printChecks(ctx, check.checks.slice(0, 20));
      if (check.total > 20) ctx.out(`  … and ${check.total - 20} more\n`);
    }
  }
  return failed ? 1 : 0;
}
