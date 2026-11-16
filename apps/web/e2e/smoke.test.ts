/**
 * Playwright smoke tests for the web shell (Stage 6 "done when"): navigation matches spec §2.2,
 * and criterion 4 (tracking UI parity) passes end to end in the browser: create and manage
 * experiments and runs, inspect metrics, parameters, tags, system metrics and artifacts, filter,
 * compare and export, with no MLflow UI.
 *
 * Opt-in (needs Chromium): `bun run test:web`. The browser is `ABLATIONKIT_CHROMIUM`, Playwright's
 * own download, or a system Chromium/Chrome.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import type { Services } from "../../server/src/services.ts";
import { buildWeb } from "../build.ts";
import { type Stack, seedVault, startStack } from "./stack.ts";

function extensionLlm(services: Services) {
  return {
    traces: {
      write: (pid: string, trace: Record<string, unknown>) =>
        services.backends.service<string>(pid, "llm-research", "traces.write", [pid, trace], {
          kind: "human",
          id: "test",
        }),
    },
  };
}

const ENABLED = process.env["ABLATIONKIT_WEB_E2E"] === "1";

function browserPath(): string | undefined {
  const candidates = [
    process.env["ABLATIONKIT_CHROMIUM"],
    (() => {
      try {
        return chromium.executablePath();
      } catch {
        return undefined;
      }
    })(),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  return candidates.find((c): c is string => !!c && existsSync(c));
}

/** Retry an async read until it equals `want` (bun's expect has no poll). */
async function poll<T>(read: () => Promise<T>, want: T, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  let got: T = await read();
  while (got !== want && Date.now() < end) {
    await Bun.sleep(100);
    got = await read();
  }
  expect(got).toBe(want);
}

let stack: Stack;
let browser: Browser;
let page: Page;
const errors: string[] = [];
/**
 * What the extension frame probe's blocked attempts log, by the frame's own CSP directives and
 * sandbox flags: the app's CSP has none of these, so a violation on the app page still fails.
 */
const FRAME_PROBE_NOISE =
  /connect-src 'none'|img-src data: blob:|frame-src 'none'|script-src 'nonce-|Refused to connect because it violates the document's|sandboxed frame|the form's frame is sandboxed|Unsafe attempt to initiate navigation|Failed to fetch|SecurityError|localStorage/;

describe.skipIf(!ENABLED)("web shell smoke (Playwright)", () => {
  beforeAll(async () => {
    await buildWeb();
    stack = await startStack();
    const exe = browserPath();
    if (!exe)
      throw new Error(
        "no Chromium found: set ABLATIONKIT_CHROMIUM or run `bunx playwright-core install chromium`",
      );
    browser = await chromium.launch({ executablePath: exe, headless: true });
    const ctx = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1400, height: 900 },
    });
    page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      // A 4xx/5xx the UI handles shows up as a console "Failed to load resource"; ignore those.
      if (m.type() === "error" && !m.text().includes("Failed to load resource"))
        errors.push(m.text());
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await stack?.stop();
  });

  const proj = () => `/p/${stack.projectId}`;
  const go = (path: string) => page.goto(`${stack.origin}${path}`);

  test("signed-out browsers are told how to sign in", async () => {
    await go("/");
    await page.getByText("You are not signed in").waitFor();
    await page.getByText("ablationkit ui").first().waitFor();
  });

  test("one-time login link signs the browser in; global navigation matches §2.2 as ADR 0055 calmed it", async () => {
    await page.goto(await stack.loginUrl());
    await page.getByRole("heading", { name: "Home" }).waitFor();
    // Home and Compute, then the projects, then Settings and Docs at the bottom.
    const global = page.getByRole("navigation", { name: "Global" });
    expect(await global.getByRole("link").allTextContents()).toEqual(["Home", "Compute"]);
    const foot = page.getByRole("navigation", { name: "Settings and help" });
    expect(await foot.getByRole("link").allTextContents()).toEqual(["Settings", "Docs"]);
    await page.getByRole("heading", { name: /Attention inbox/ }).waitFor();
    expect(await page.getByTestId("inbox-count").textContent()).toBe("0");
    // The header's inbox badge appears only when something is in the inbox.
    expect(await page.getByTestId("inbox-badge").count()).toBe(0);
    const bar = page.getByTestId("statusbar");
    await bar.getByText("coordinator ok").waitFor();
    await bar.getByText(/MLflow (external|healthy)/).waitFor();
    await global.getByRole("link", { name: "Compute" }).click();
    await page.getByRole("heading", { name: "Compute", exact: true }).waitFor();
    await foot.getByRole("link", { name: "Settings" }).click();
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    // System is a tab of Settings, at /system.
    await page
      .getByRole("navigation", { name: "Section" })
      .getByRole("link", { name: "System" })
      .click();
    await page.waitForURL(`${stack.origin}/system`);
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    await page.getByTestId("diagnostics").waitFor();
  });

  test("HTML guide works inside the UI and independently", async () => {
    await page
      .getByRole("navigation", { name: "Settings and help" })
      .getByRole("link", { name: "Docs" })
      .click();
    const guide = page.locator(".ak-guide");
    expect(await page.locator("iframe").count()).toBe(0);
    await guide.getByRole("heading", { name: "Start here", exact: true }).waitFor();
    await guide.getByRole("navigation").getByRole("link", { name: "Your first project" }).click();
    await guide.getByRole("heading", { name: "Your first project", exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/docs/getting-started");
    await page.reload();
    await guide.getByRole("heading", { name: "Your first project", exact: true }).waitFor();
    await guide.getByText("Codex MCP configuration").click();
    await guide.getByText("[mcp_servers.ablationkit]", { exact: false }).waitFor();
    const standalone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await standalone.goto(`file://${resolve(import.meta.dir, "../../../docs/guide/index.html")}`);
      await standalone.getByRole("heading", { name: "Start here", exact: true }).waitFor();
      await standalone
        .getByRole("navigation")
        .getByRole("link", { name: "Run and compare" })
        .click();
      await standalone.getByRole("heading", { name: "Run and compare", exact: true }).waitFor();
      expect(
        await standalone.locator("html").evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    } finally {
      await standalone.close();
    }
  });

  test("project navigation uses core items and declared backend page profiles", async () => {
    await page.getByRole("link", { name: "Demo model" }).first().click();
    const nav = page.getByRole("navigation", { name: "Demo model navigation" });
    await nav.waitFor();
    const primary = async () =>
      (await nav.locator(":scope > a").allTextContents()).map((s) => s.trim());
    // ADR 0055: Data & Evals and Models wait under More until the project uses them, beside the
    // profile-hidden backend pages and the original records.
    expect(await primary()).toEqual(["Standing", "Notebooks", "Runs", "Project settings"]);
    await nav.getByText("More").click();
    await nav.getByRole("link", { name: "LLM" }).waitFor();
    for (const name of ["Data & Evals", "Models", "Knowledge", "Tasks", "Review"])
      await nav.getByRole("link", { name, exact: true }).waitFor();
    // ADR 0036: agent orchestration is not in the web UI.
    expect(await page.getByRole("button", { name: "New task" }).count()).toBe(0);

    await nav.getByRole("link", { name: "Project settings" }).click();
    await page.getByRole("heading", { name: "Task profiles" }).waitFor();
    await page.getByLabel("llm").check();
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Save profiles" }).click(),
    ]);
    await nav.waitFor();
    await expect(primary()).resolves.toContain("LLM");
    await page.getByLabel("llm").uncheck();
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Save profiles" }).click(),
    ]);
    await nav.waitFor();
    await expect(primary()).resolves.not.toContain("LLM");
  });

  test("criterion 4: create, rename, archive and restore an MLflow experiment", async () => {
    await go(`${proj()}/runs/experiments`);
    await page.getByRole("heading", { name: "This project's experiments" }).waitFor();
    await page.getByText(`ak/${stack.projectId}`).first().waitFor();
    await page.getByRole("button", { name: "New experiment" }).click();
    await page.getByLabel("Experiment name").fill("e2e-baselines");
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    const table = page.getByTestId("experiments-table");
    const row = (name: string) => table.locator("tr", { hasText: name });
    await row("e2e-baselines").waitFor();

    await row("e2e-baselines").getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("New experiment name").fill("e2e-baselines-v2");
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await row("e2e-baselines-v2").waitFor();

    await row("e2e-baselines-v2").getByRole("button", { name: "Archive" }).click();
    await row("e2e-baselines-v2").waitFor({ state: "detached" });
    await page.getByLabel("Experiment view").selectOption("deleted");
    await page.getByRole("button", { name: "Filter" }).click();
    await row("e2e-baselines-v2").getByRole("button", { name: "Restore" }).click();
    await page.getByLabel("Experiment view").selectOption("active");
    await page.getByRole("button", { name: "Filter" }).click();
    await row("e2e-baselines-v2").waitFor();

    // Link it read-only to the project.
    await row("e2e-baselines-v2").getByRole("button", { name: "Link to project" }).click();
    await page.getByText("imported · read-only").waitFor();
  });

  test("criterion 4: run search, filters and pagination controls", async () => {
    await go(`${proj()}/runs`);
    const table = page.getByTestId("runs-table");
    await table.waitFor();
    const rows = () => table.locator("tbody tr").count();
    expect(await rows()).toBe(6);
    // Latest metric columns are shown in the table.
    await table.getByRole("columnheader", { name: "train/loss" }).waitFor();

    await page.getByLabel("Variant").fill("lr-high");
    await page.getByLabel("Variant").blur();
    await poll(rows, 2);
    await page.getByLabel("Variant").fill("");
    await page.getByLabel("Variant").blur();
    await poll(rows, 6);

    await page.getByLabel("MLflow filter").fill("metrics.`train/loss` < 0.5");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await poll(rows, 2);
    await page.getByLabel("MLflow filter").fill("params.lr = '0.002'");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await poll(rows, 2);
    await page.getByLabel("MLflow filter").fill("");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByLabel("Status").selectOption("FINISHED");
    await poll(rows, 6);
    await page.getByLabel("Status").selectOption("");
    expect(await page.getByRole("button", { name: "Next →" }).isDisabled()).toBe(true);
  });

  test("criterion 4: create a manual run, rename it, edit tags and finish it", async () => {
    await go(`${proj()}/runs`);
    await page.getByRole("button", { name: "New manual run" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Run name").fill("manual-e2e");
    await d.getByLabel("Study").fill("manual-study");
    await d.getByLabel(/Parameters/).fill("lr=0.3\nbatch=32");
    await d.getByLabel(/Metrics/).fill("acc=0.71");
    await d.getByRole("button", { name: "Create run" }).click();
    await page.getByTestId("run-name").getByText("manual-e2e").waitFor();
    await page.getByTestId("params-table").getByText("batch").waitFor();
    await page.getByText("0.71").first().waitFor();

    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("Run name").fill("manual-renamed");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByTestId("run-name").getByText("manual-renamed").waitFor();

    await page.getByLabel("Tag key").fill("reviewer");
    await page.getByLabel("Tag value").fill("ali");
    await page.getByRole("button", { name: "Set tag" }).click();
    await page.getByTestId("tags-table").getByText("reviewer").waitFor();
    await page.getByRole("button", { name: "delete tag reviewer" }).click();
    await page.getByTestId("tags-table").getByText("reviewer").waitFor({ state: "detached" });

    await page.getByRole("button", { name: "Mark finished" }).click();
    await page.getByText("FINISHED", { exact: true }).first().waitFor();

    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByText("deleted", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Restore" }).click();
    await page.getByText("deleted", { exact: true }).waitFor({ state: "detached" });
  });

  test("criterion 4: metric charts and system metrics", async () => {
    await go(`${proj()}/runs`);
    await page.getByTestId("runs-table").getByRole("link", { name: "baseline-s0" }).click();
    await page.getByRole("button", { name: "Metrics", exact: true }).click();
    const chart = page.getByTestId("chart-train/loss");
    await chart.locator("svg path").first().waitFor();
    await chart.getByText("raw history CSV").waitFor();
    const dl = page.waitForEvent("download");
    await chart.getByRole("button", { name: "CSV" }).click();
    const file = await (await dl).path();
    expect(readFileSync(file, "utf8").split("\n")[0]).toBe("series,x,y");

    await page.getByRole("button", { name: "System metrics" }).click();
    await page
      .getByTestId("chart-system/cpu_utilization_percentage")
      .locator("svg path")
      .first()
      .waitFor();
  });

  test("criterion 4: compare runs side by side and export", async () => {
    await go(`${proj()}/runs`);
    const table = page.getByTestId("runs-table");
    await table.getByLabel("select baseline-s0").check();
    await table.getByLabel("select lr-high-s0").check();
    await page.getByRole("button", { name: /Compare/ }).click();
    const cmp = page.getByTestId("compare-table");
    await cmp.waitFor();
    // lr differs between the runs and is highlighted; optimizer does not.
    await expect(cmp.locator("tr.differs", { hasText: "lr" }).count()).resolves.toBe(1);
    await expect(cmp.locator("tr.differs", { hasText: "optimizer" }).count()).resolves.toBe(0);
    await page.getByLabel("only rows that differ").check();
    await expect(cmp.locator("tr", { hasText: "optimizer" }).count()).resolves.toBe(0);
    await cmp.getByText("baseline", { exact: true }).waitFor();

    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export table CSV" }).click();
    const csv = readFileSync(await (await dl).path(), "utf8");
    expect(csv.split("\n")[0]).toBe("kind,key,baseline-s0,lr-high-s0");

    const dl2 = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export runs CSV" }).click();
    const runsCsv = readFileSync(await (await dl2).path(), "utf8");
    expect(runsCsv).toContain("params.lr");
    expect(runsCsv.trim().split("\n")).toHaveLength(3);

    await page.getByTestId("chart-train/loss").locator("svg path").nth(1).waitFor();
  });

  test("studies: ablation table aggregates seeds per variant against a baseline", async () => {
    await go(`${proj()}/runs/studies`);
    await page.getByTestId("studies-table").getByRole("link", { name: "lr-sweep" }).click();
    const t = page.getByTestId("ablation-table");
    await t.waitFor();
    await expect(t.locator("tbody tr").count()).resolves.toBe(3);
    await t.getByText("n=2").first().waitFor();
    await page.getByLabel("Baseline variant").selectOption("lr-high");
    await t.locator("tr.selected", { hasText: "lr-high" }).waitFor();
  });

  test("jobs: launch a real job, stream its console, then inspect its run's artifacts", async () => {
    await go(`${proj()}/runs/jobs`);
    await page.getByRole("button", { name: "Launch job" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Command").fill("python3 train.py --epochs 3");
    await d.getByLabel("Environment").selectOption("none");
    await d.getByLabel("Metrics file").fill("outputs/metrics.jsonl");
    await d.getByLabel("Artifact globs").fill("outputs/*.json");
    await d.getByLabel("Run name").fill("e2e-job");
    await d.getByRole("button", { name: "Launch" }).click();

    const consoleBox = page.getByTestId("console");
    await consoleBox.getByText("epoch 1/3").waitFor({ timeout: 60_000 });
    await consoleBox.getByText("epoch 3/3").waitFor({ timeout: 60_000 });
    await consoleBox.getByText("done").waitFor();
    await page.getByText("compute: succeeded").waitFor({ timeout: 60_000 });
    await page
      .getByText(/limits (advisory|enforced)/)
      .first()
      .waitFor();
    await page.getByText("outputs/model.json").waitFor({ timeout: 60_000 });

    await page.getByRole("link", { name: "Open run" }).click();
    await page.getByRole("button", { name: "Artifacts" }).click();
    await page
      .getByTestId("artifacts-table")
      .getByRole("button", { name: /outputs/ })
      .click();
    await page.getByTestId("artifacts-table").getByRole("button", { name: "model.json" }).click();
    await page.getByTestId("artifact-preview").getByText("rmse").waitFor();
    await page.getByRole("button", { name: "Console" }).click();
    await page.getByTestId("console").getByText("epoch 1/3").waitFor();
  });

  test("knowledge: hypotheses, conversation links quoted into notes, a recorded study and an evidence-linked report; lineage strips show gaps", async () => {
    await go(`${proj()}/knowledge`);
    await page.getByRole("button", { name: "New hypothesis" }).click();
    let d = page.getByRole("dialog");
    await d.getByLabel("Title").fill("Higher learning rate converges faster");
    await d.getByLabel("Statement").fill("lr-high reaches lower loss at 300 steps.");
    await d.getByLabel("Tags").fill("lr sweep");
    await d.getByRole("button", { name: "Save" }).click();
    await page
      .getByTestId("record-title")
      .getByText("Higher learning rate converges faster")
      .waitFor();
    const hypUrl = page.url();
    const hypId = decodeURIComponent(hypUrl.split("/knowledge/r/")[1] as string);
    // The page leads with the description; a record without one says so.
    await page.getByTestId("record-summary").getByText("lr-high reaches lower loss").waitFor();
    // The strip on a lone hypothesis says what is missing instead of inventing links.
    await page.getByText("Provenance: lineage, IDs and revisions").click();
    const strip = page.getByTestId("lineage-strip");
    await strip.locator('[data-step="study"][data-status="missing"]').waitFor();
    await strip.locator('[data-step="evaluation"][data-status="missing"]').waitFor();
    await strip.locator('[data-step="inference"][data-status="missing"]').waitFor();

    // A conversation link: a pointer only, then quoted into an attributed note.
    await go(`${proj()}/knowledge/conversations`);
    await page.getByRole("button", { name: "Link a conversation" }).click();
    d = page.getByRole("dialog");
    await d.getByLabel("Title").fill("LR schedule brainstorm");
    await d.getByLabel("Source").selectOption("chatgpt");
    await d.getByLabel("URL").fill("https://chatgpt.com/c/e2e-example");
    await d.getByLabel("Body").fill("private: try warmup");
    await d.getByLabel("Links").fill(`hypothesis:${hypId}`);
    await d.getByRole("button", { name: "Save" }).click();
    await page.getByRole("link", { name: "Open conversation ↗" }).waitFor();
    await page.getByRole("button", { name: "Quote into a note" }).click();
    d = page.getByRole("dialog");
    await d.getByLabel("Body").fill("> warmup helps high learning rates");
    await d.getByRole("button", { name: "Save" }).click();
    await page.getByText("a linked conversation").waitFor();

    // Record the seeded study with a stored baseline, then generate a report from it.
    await go(`${proj()}/runs/studies/lr-sweep`);
    await page.getByRole("button", { name: "Record study" }).click();
    d = page.getByRole("dialog");
    await d.getByLabel("Study title").fill("Learning-rate sweep");
    await d.getByLabel("Baseline").selectOption("baseline");
    await d.getByLabel("Metric goals").fill("train/loss:min");
    await d.getByLabel("Study links").fill(`hypothesis:${hypId}`);
    await d.getByRole("button", { name: "Save study" }).click();
    await page.getByRole("heading", { name: "Learning-rate sweep" }).waitFor();
    // What the study tests, by name; the lineage sits under Provenance.
    await page
      .getByTestId("study-tests")
      .getByRole("link", { name: "Higher learning rate converges faster" })
      .waitFor();
    await page.getByText("Provenance: lineage").click();
    await page
      .getByTestId("lineage-strip")
      .locator('[data-step="hypothesis"][data-status="linked"]')
      .waitFor();
    await page.getByRole("button", { name: "Generate report" }).click();
    await page.getByTestId("evidence-table").waitFor();
    await expect(page.getByTestId("evidence-table").locator("tbody tr").count()).resolves.toBe(6);
    await page.getByText("Not written yet.").waitFor();
    await page
      .getByTestId("record-summary")
      .getByRole("cell", { name: "baseline (baseline)" })
      .waitFor();

    // A run's strip: hypothesis → study → variant (manual runs have no job), cited by the report.
    const runLink = page
      .getByTestId("evidence-table")
      .locator("tbody tr")
      .first()
      .getByRole("link")
      .first();
    await runLink.click();
    // The run's lineage sits under Provenance, as on a study (ADR 0055).
    await page.getByText("Provenance: lineage", { exact: true }).click();
    const runStrip = page.getByTestId("lineage-strip");
    await runStrip.locator('[data-step="hypothesis"][data-status="linked"]').waitFor();
    await runStrip.locator('[data-step="job"][data-status="missing"]').waitFor();
    await runStrip.getByText("Cited by").waitFor();

    // ADR 0055: the Overview reads where the project stands from the vault (none yet) and lists
    // no record statuses; the hypothesis, the recorded study and its report are in the original
    // records and the studies table. The export landed in the checkout, without the private notes.
    await go(proj());
    await page
      .getByTestId("overview-standing")
      .getByText("no vault yet", { exact: false })
      .waitFor();
    await page.getByTestId("findings").getByText("What the agents did").waitFor();
    expect(
      await page.getByTestId("findings").getByText("Higher learning rate converges faster").count(),
    ).toBe(0);
    await go(`${proj()}/knowledge`);
    await page
      .getByRole("link", { name: "Higher learning rate converges faster" })
      .first()
      .waitFor();
    await go(`${proj()}/knowledge/reports`);
    await page.getByRole("link", { name: "Learning-rate sweep: results" }).first().waitFor();
    await go(`${proj()}/runs/studies`);
    await page
      .getByTestId("studies-table")
      .getByRole("link", { name: "Learning-rate sweep", exact: true })
      .waitFor();
    const convs = await Bun.file(
      join(stack.repo, ".ablationkit/conversations/references.json"),
    ).text();
    expect(convs).toContain("chatgpt.com/c/e2e-example");
    expect(convs).not.toContain("private: try warmup");
  });

  test("reads and review: a record renders Markdown and LaTeX and never HTML; a run gets a description; the reading list ends when everything is reviewed (ADR 0048)", async () => {
    const pid = stack.projectId;
    const P = `/api/v1/projects/${pid}`;
    const { record } = await stack.api<{ record: { record_id: string } }>(`${P}/research`, {
      kind: "approach",
      title: "Bits per byte across tokenizers",
      summary: "Models are compared on **bits per byte**, $B = L / (n \\ln 2)$.",
      body: "## Why\n\nPer-token loss depends on the tokenizer.\n\n$$\n\\mathrm{BPB} = \\frac{L}{n \\ln 2}\n$$\n\n| Tokenizer | BPB |\n|---|---:|\n| 8k | 1.41 |\n\n<img src=x onerror=\"document.title='pwned'\"> stays text.",
    });
    await go(`${proj()}/knowledge/r/${record.record_id}`);
    const summary = page.getByTestId("record-summary");
    await summary.locator("strong", { hasText: "bits per byte" }).waitFor();
    await summary.locator(".katex").waitFor();
    const body = page.getByTestId("record-body");
    await body.getByRole("heading", { name: "Why" }).waitFor();
    await body.locator(".md-math .katex-display").waitFor();
    await body.getByRole("cell", { name: "1.41" }).waitFor();
    await body.getByText("<img src=x onerror=", { exact: false }).waitFor();
    expect(await body.locator("img").count()).toBe(0);
    expect(await page.title()).not.toBe("pwned");
    // KaTeX's fonts come from this origin, and its layout is applied (no inline-style CSP block).
    const laidOut = await page.evaluate<string[]>(
      `(() => {
        const el = document.querySelector('[data-testid="record-body"] .katex .mfrac .vlist');
        return [el.style.height, getComputedStyle(el).fontFamily, String(document.fonts.check("1em KaTeX_Main"))];
      })()`,
    );
    expect(laidOut[0]).toMatch(/em$/);
    expect(laidOut[1]).toContain("KaTeX_Main");
    expect(laidOut[2]).toBe("true");

    // Review: mark this record with a note; it leaves the reading list.
    const bar = page.getByTestId("review-bar");
    await bar.getByText("You have not reviewed this yet.").waitFor();
    await bar.getByRole("button", { name: "Add a note" }).click();
    await bar.getByLabel("Review note").fill("Check the 64k row too.");
    await bar.getByRole("button", { name: "Save note and mark reviewed" }).click();
    await bar.getByText("Your note: Check the 64k row too.").waitFor();
    await bar.getByText(/You reviewed this/).waitFor();
    const reading = await stack.api<{
      counts: { total: number; reviewed: number };
      queue: { kind: string; id: string }[];
    }>(`${P}/review`);
    expect(reading.queue.some((q) => q.id === record.record_id)).toBe(false);

    // The reading list: threads in reading order, each item with its summary; mark the rest.
    await go(`${proj()}/review`);
    await page
      .getByTestId("review-progress")
      .getByText(`${reading.queue.length} of ${reading.counts.total} left to review`)
      .waitFor();
    const item = page
      .getByTestId("review-item")
      .filter({ hasText: "Higher learning rate converges faster" });
    await item.getByText("lr-high reaches lower loss at 300 steps.").waitFor();
    await item.getByRole("button", { name: "Mark reviewed" }).click();
    await item.waitFor({ state: "detached" });
    for (;;) {
      const all = page.getByRole("button", { name: /^Mark all \d+ reviewed$/ });
      const one = page.getByRole("button", { name: /^Mark (task )?reviewed$/ });
      if (await all.count()) await all.first().click();
      else if (await one.count()) await one.first().click();
      else break;
      await page.waitForTimeout(150);
    }
    await page
      .getByTestId("review-progress")
      .getByText(/^All \d+ reviewed\.$/)
      .waitFor();
    await page.getByText("Everything is reviewed.").waitFor();
    // Review left the navigation (ADR 0049) but stays routable: its count is on the page.
    expect(await page.getByTestId("review-count").count()).toBe(0);
    // An edit a reader would see brings it back as changed.
    await stack.api(`${P}/research/${record.record_id}`, { status: "adopted" }, "PATCH");
    await page.getByTestId("review-item").getByText("changed", { exact: true }).waitFor();
    await page
      .getByTestId("review-progress")
      .getByText(/^1 of \d+ left to review \(1 changed since you read them\)\.$/)
      .waitFor();
    await page.getByRole("button", { name: "Everything" }).click();
    await page.getByText("How the pieces fit together").click();
    await page
      .getByRole("list", { name: "How the research is organised" })
      .getByText(/A written conclusion drawn from runs/)
      .waitFor();

    // A run's description: written on its page, shown in the runs list and in its study.
    const runs = await stack.api<{ runs: { info: { run_id: string; run_name?: string } }[] }>(
      `/api/v1/tracking/runs?project=${pid}&max_results=1`,
    );
    const run = runs.runs[0] as { info: { run_id: string } };
    await go(`${proj()}/runs/r/${run.info.run_id}`);
    const desc = page.getByTestId("run-description");
    await desc.getByText("No description").waitFor();
    await desc.getByRole("button", { name: "Write one" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Run summary").fill("Reaches a loss of $0.31$, below the baseline.");
    await d.getByLabel("Run notes").fill("## Caveat\n\nOne seed.");
    await d.getByRole("button", { name: "Save" }).click();
    await page.getByTestId("run-summary").locator(".katex").waitFor();
    await page.getByTestId("run-notes").getByRole("heading", { name: "Caveat" }).waitFor();
    await go(`${proj()}/runs`);
    await page.getByTestId("runs-table").getByText("below the baseline.").waitFor();
  });

  test("Standing and Notebooks (ADR 0049): an empty vault explains itself; a claim unfolds and is read; in context lands in its notebook; a term opens beside the page; evidence reads the runs", async () => {
    const P = `/api/v1/projects/${stack.projectId}`;
    const nav = page.getByRole("navigation", { name: "Demo model navigation" });
    // No vault yet: the page says what the vault is and how it gets written, and links the records.
    await go(`${proj()}/standing`);
    const empty = page.getByTestId("vault-empty");
    await empty.getByText("This project has no vault yet.", { exact: false }).waitFor();
    await empty.getByText("ablationkit mcp").waitFor();
    await empty.getByText(/ablationkit vault import DIR/).waitFor();
    await empty.getByRole("link", { name: "the original records" }).waitFor();

    const ids = await seedVault(stack.api, stack.projectId);
    await go(`${proj()}/standing`);
    const standing = page.getByTestId("standing");
    await page
      .getByTestId("bottom-line")
      .getByText(/learning rate of 0\.01/)
      .waitFor();
    const line = standing.locator(`.v-lline[data-id="${ids.claim}"]`);
    await line.getByText("A learning rate of 0.01 is the best of the three").waitFor();
    await line.getByText("6 runs · two seeds each · one model size").waitFor();
    await page
      .getByText("You have not read anything here yet: one claim", { exact: false })
      .waitFor();
    await nav.getByTestId("standing-count").getByText("1").waitFor();

    // Unfolding the claim to its summary is reading it: the count goes, the mark is stored.
    await line.locator(".v-ntitle").click();
    await line.getByText("Would change it").waitFor();
    await nav.getByTestId("standing-count").waitFor({ state: "detached" });
    await poll(
      async () =>
        (await stack.api<{ reads: Record<string, { state: string }> }>(`${P}/vault`)).reads[
          ids.claim
        ]?.state,
      "read",
    );

    // In context: the notebook that argues it, scrolled to it.
    await line.locator(".v-mv-ctx").click();
    await page.waitForURL(`**/notebooks/n/${ids.notebook}?at=${ids.claim}`);
    await page
      .getByTestId("notebook")
      .getByRole("heading", { name: "What the learning-rate sweep showed" })
      .waitFor();
    await page.locator(`.v-note.v-focus[data-key="N:${ids.notebook}>${ids.claim}"]`).waitFor();
    await page.getByTestId("works-cited").getByText("one work", { exact: false }).waitFor();
    expect(await nav.getByRole("link", { name: "Notebooks" }).getAttribute("class")).toContain(
      "active",
    );

    // A term in prose opens its concept beside the page; the address says so.
    await page.goto(`${stack.origin}${proj()}/notebooks/n/${ids.finding}`);
    await page
      .getByTestId("note-page")
      .getByText("A higher learning rate ends with a higher loss")
      .waitFor();
    await page.locator(`a.v-wl[data-note="${ids.concept}"]`).first().click();
    await page.getByTestId("sheet").getByText("Learning rate (LR)").waitFor();
    expect(new URL(page.url()).searchParams.get("note")).toBe(ids.concept);
    await page.keyboard.press("Escape");
    await page.getByTestId("sheet").waitFor({ state: "detached" });

    // Evidence: the runs' values read now, the difference to the baseline.
    const ev = page.locator(".v-ev").first();
    await ev.getByRole("link", { name: "baseline-s0" }).waitFor();
    await ev.getByRole("columnheader", { name: "loss" }).waitFor();
    const cells = await ev.locator("td.num").allTextContents();
    expect(cells.filter((c) => /^\d+\.\d{4}$/.test(c)).length).toBe(2);
    expect(cells.some((c) => /^[+−]\d+\.\d{4}$/.test(c))).toBe(true);

    // Find (/), the shelf and the tree; the original records stay one link away.
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Find a note" }).fill("learning rate");
    await page.locator(".v-fr").first().waitFor();
    await page.keyboard.press("Escape");
    await go(`${proj()}/notebooks`);
    await page.getByTestId("shelf").getByText("What the learning-rate sweep showed").waitFor();
    await page.getByRole("link", { name: "the original records" }).click();
    await page.waitForURL(`**${proj()}/knowledge`);
    await go(`${proj()}/notebooks/tree`);
    const row = page
      .getByTestId("tree")
      .getByRole("treeitem", { name: /What the learning-rate sweep showed/ });
    await row.waitFor();
    // The tree opens with the first notebook selected; its preview reads it.
    await page.locator(".v-tree-prev .v-note").first().waitFor();

    // The library (ADR 0052): prior work by the part it played, each with the notes citing it,
    // and its citations downloaded with the role as the annotation.
    await go(`${proj()}/notebooks/library`);
    const lib = page.getByTestId("library");
    await lib.getByRole("heading", { name: "Methods taken from it" }).waitFor();
    await lib.getByText("Smith 2018").waitFor();
    await lib
      .getByRole("link", { name: "A learning rate of 0.01 is the best of the three" })
      .waitFor();
    const href = await page
      .getByTestId("library-export")
      .getByRole("link", { name: "BibTeX" })
      .getAttribute("href");
    const bib = await page.evaluate(async (h) => (await fetch(h as string)).text(), href);
    expect(bib).toContain("@misc{smith-2018-disciplined,");
    expect(bib).toContain("Role: method in “A learning rate of 0.01 is the best of the three”");
  });

  test("directions (ADR 0057): the researcher directs on a claim with d; an agent session is told at its next call and answers; the answer waits on Standing until the researcher closes it", async () => {
    const pid = stack.projectId;
    await go(`${proj()}/standing`);
    const standing = page.getByTestId("standing");
    const line = standing.locator('.v-lline[data-id="lr-001-is-best"]');
    await line.locator(".v-gist").click();
    await page.keyboard.press("d");
    const composer = line.getByTestId("direction-composer");
    await composer
      .getByText("delivered when an agent session next calls AblationKit", { exact: false })
      .waitFor();
    await composer.getByRole("button", { name: "Doubt" }).click();
    await composer.locator("textarea").fill("Two seeds is thin: run a third at 0.05 first.");
    await composer.getByRole("button", { name: "Send" }).click();
    await line
      .getByTestId("direction-fold")
      .getByText("1 direction · waiting for an agent")
      .waitFor();

    // The agent side, as `ablationkit mcp` does it: the header, then deliver, then respond.
    const { token } = await stack.agentSession("Directions session");
    const agent = (path: string, body?: unknown) =>
      fetch(`${stack.coordinator.urls.agent}/api/v1/projects/${pid}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    expect((await agent("")).headers.get("x-ablationkit-directions")).toBe("1");
    const { directions } = (await (await agent("/directions/deliver", {})).json()) as {
      directions: { direction_id: string; text: string }[];
    };
    expect(directions.map((d) => d.text)).toEqual([
      "Two seeds is thin: run a third at 0.05 first.",
    ]);
    const id = directions[0]?.direction_id as string;
    expect(
      (await agent("/directions", { target: { kind: "project" }, kind: "do", text: "x" })).status,
    ).toBe(403);
    const answered = await agent(`/directions/${id}/respond`, {
      kind: "answer",
      text: "Lowered it to open until the third seed runs.",
      refs: [{ kind: "note", id: "lr-001-is-best" }],
    });
    expect(answered.status).toBe(200);

    // Standing says an answer waits; the thread shows it with its ref; closing it settles it.
    const box = page.getByTestId("directions");
    await box.getByText("1 answer waits for you to read", { exact: false }).waitFor();
    const thread = box.getByTestId("direction-thread");
    await thread.getByText("Lowered it to open until the third seed runs.").waitFor();
    await thread.getByText("Directions session answered").waitFor();
    await thread
      .locator(".dr-ref")
      .getByText(/A learning rate of 0\.01 is the best/)
      .waitFor();
    await thread.getByRole("button", { name: "Close" }).click();
    await line.getByTestId("direction-fold").getByText("1 direction · closed").waitFor();
    await box.getByText("1 answer waits", { exact: false }).waitFor({ state: "detached" });
  });

  test("the agenda (ADR 0058): the researcher puts a claim in Now from its ledger line with one key, adds a line and a rule; an agent session is told, reads it and records a task for the line; the panel shows who read it and what was done", async () => {
    const pid = stack.projectId;
    const P = `/api/v1/projects/${pid}`;
    await go(`${proj()}/standing`);
    const panel = page.getByTestId("agenda");
    await panel.getByText("Nothing in Now", { exact: false }).waitFor();
    // One key on a focused ledger line: n puts the claim in Now.
    const line = page.locator('.v-lline[data-id="lr-001-is-best"]');
    await line.locator(".v-lnum").click();
    await page.keyboard.press("n");
    await line.locator(".ag-chip", { hasText: "Now 1" }).waitFor();
    await page
      .getByTestId("agenda-now")
      .getByRole("button", { name: "A learning rate of 0.01 is the best of the three" })
      .waitFor();
    // A line of the researcher's own and a rule.
    await panel
      .getByRole("textbox", { name: "Add a line to Now" })
      .fill("Re-run 0.01 with three seeds");
    await panel.getByRole("textbox", { name: "Add a line to Now" }).press("Enter");
    await page.getByTestId("agenda-now").getByText("Re-run 0.01 with three seeds").waitFor();
    await panel.getByRole("textbox", { name: "Add a rule" }).fill("Keep each job under an hour");
    await panel.getByRole("textbox", { name: "Add a rule" }).press("Enter");
    await page.getByTestId("agenda-rules").getByText("Keep each job under an hour").waitFor();

    // An agent session: every response names the revision it has not read; reading it is the diff.
    const { token } = await stack.agentSession("Agenda session");
    const agent = (path: string, init: RequestInit = {}) =>
      fetch(`${stack.coordinator.urls.agent}${P}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
    const waiting = (await agent("/tasks")).headers.get("x-ablationkit-agenda-revision");
    expect(Number(waiting)).toBeGreaterThan(0);
    const read = (await (await agent("/agenda")).json()) as { now: string[]; rules: string[] };
    expect(read.now).toEqual([
      "note:lr-001-is-best: A learning rate of 0.01 is the best of the three [claim, leaning]",
      expect.stringMatching(/^L\d+: Re-run 0\.01 with three seeds$/),
    ]);
    expect(read.rules).toEqual([expect.stringMatching(/^R\d+: Keep each job under an hour$/)]);
    expect((await agent("/tasks")).headers.get("x-ablationkit-agenda-revision")).toBeNull();
    // An agent cannot write the agenda.
    expect((await agent("/agenda", { method: "PUT", body: "{}" })).status).toBe(404);
    const lineId = (read.now[1] as string).split(":")[0];
    const made = await agent("/tasks", {
      method: "POST",
      body: JSON.stringify({ goal: "Three seeds at 0.01", agenda_item: lineId }),
    });
    expect(made.status).toBe(201);

    // The panel: the session read this revision; the line has its task.
    await page
      .getByTestId("agenda-readers")
      .getByText("Agenda session: read this revision")
      .waitFor();
    await page.locator(`[data-agenda-item="${lineId}"]`).getByText("one task (1 open)").waitFor();
  });

  test("vault figures draw in opaque-origin sandboxes from the runs (ADR 0053): a figure reads the study's runs, cannot reach the network, and a failure is shown and comes back as a check", async () => {
    const P = `/api/v1/projects/${stack.projectId}`;
    const fig = (id: string, title: string, gist: string, script: string) =>
      stack.api(`${P}/vault/notes`, {
        id,
        type: "figure",
        title,
        gist,
        figure: { script },
        evidence: [{ run: "baseline-s0", role: "baseline" }],
        sources: ["study:lr-sweep"],
      });
    await fig(
      "loss-by-lr",
      "Training loss by learning rate",
      "The 0.05 runs sit above the others to the end; 0.01 and 0.002 meet.",
      `let net = "network reached";
try { await fetch("/api/v1/projects"); } catch { net = "no network"; }
let dom = "parent DOM reached";
try { parent.document.body; } catch { dom = "no parent DOM"; }
const runs = await ak.runs.list({ filter: "tags.ablationkit.study_id = 'lr-sweep'" });
const rows = [];
for (const r of runs)
  for (const p of await ak.runs.history(r.run_id, "train/loss"))
    rows.push({ run: r.run_name, step: p.step, loss: p.value });
const note = document.createElement("p");
note.dataset.testid = "probe";
note.textContent = runs.length + " runs · " + rows.length + " points · " + net + " · " + dom;
el.append(note, Plot.plot({ color: { range: ak.theme.series }, marks: [Plot.lineY(rows, { x: "step", y: "loss", stroke: "run" })] }));`,
    );
    await fig(
      "broken-figure",
      "A figure that throws",
      "It reads a field of nothing.",
      "const x = undefined;\nel.append(String(x.field));",
    );
    await stack.api(`${P}/vault/notes`, {
      id: "figures-of-the-sweep",
      type: "notebook",
      title: "Figures of the sweep",
      gist: "What the sweep looks like.",
      summary: "The sweep, drawn from its runs.",
      full: "First the curves.\n\n![[loss-by-lr]]\n\nThen one that fails.\n\n![[broken-figure]]",
    });
    await go(`${proj()}/notebooks/n/figures-of-the-sweep`);
    const good = page.getByTestId("figure-loss-by-lr");
    expect(await good.locator("iframe").getAttribute("sandbox")).toBe("allow-scripts");
    const inner = good.frameLocator("iframe");
    // Six runs of 300 steps, read through the page; no network and no parent DOM in the frame.
    await inner
      .getByTestId("probe")
      .getByText("6 runs · 1800 points · no network · no parent DOM")
      .waitFor();
    await inner.locator("svg").first().waitFor();
    await page.getByText("The 0.05 runs sit above the others to the end").waitFor();
    await page
      .getByTestId("figure-broken-figure")
      .frameLocator("iframe")
      .getByText(/The figure failed: TypeError/)
      .waitFor();
    await poll(
      async () =>
        (
          await stack.api<{ checks: { code: string; note?: string }[] }>(`${P}/vault/check`)
        ).checks.some((c) => c.code === "figure_error" && c.note === "broken-figure"),
      true,
    );
    const checks = (
      await stack.api<{ checks: { code: string; note?: string }[] }>(`${P}/vault/check`)
    ).checks;
    expect(checks.some((c) => c.code === "figure_error" && c.note === "loss-by-lr")).toBe(false);
  });

  test("model lifecycle: MLproject entrypoint → logged model → register and alias → dataset lineage → evaluation with thresholds and plots (criteria 5-8)", async () => {
    const MLMODEL =
      'flavors:\\n  python_function: {loader_module: mlflow.sklearn}\\n  sklearn: {serialization_format: skops, sklearn_version: 1.9.1}\\nsignature:\\n  inputs: \'[{\\"type\\": \\"double\\", \\"name\\": \\"x\\"}]\'\\n  outputs: \'[{\\"type\\": \\"long\\"}]\'\\n';
    writeFileSync(join(stack.repo, "data.csv"), "x,y\n0.1,0\n0.9,1\n");
    writeFileSync(
      join(stack.repo, "MLproject"),
      'name: demo\nentry_points:\n  main:\n    parameters:\n      lr: {type: float, default: 0.1}\n    command: "python3 lifecycle.py {lr}"\n',
    );
    writeFileSync(
      join(stack.repo, "lifecycle.py"),
      `import sys, pathlib
import ablationkit_sdk as ak
ak.log_input("demo-data", source="data.csv", path="data.csv", split="train", version="v1")
out = pathlib.Path("out/model"); out.mkdir(parents=True, exist_ok=True)
(out / "MLmodel").write_text("${MLMODEL}")
(out / "model.skops").write_bytes(b"w")
ak.log_model(out, "demo-clf")
print("lr", sys.argv[1])
`,
    );
    // Criterion 8: the entrypoint is detected and launched from Runs → Entrypoints.
    await go(`${proj()}/runs/entrypoints`);
    const eps = page.getByTestId("entrypoints");
    await eps.getByText("python3 lifecycle.py {lr}").waitFor();
    await eps.getByRole("button", { name: "Run…" }).click();
    await page.getByLabel("Parameter lr").fill("0.2");
    await page.getByRole("button", { name: "Run as a job" }).click();
    await page.waitForURL(/\/runs\/jobs\//);
    await page.getByText("succeeded").first().waitFor({ timeout: 30_000 });
    // Criterion 6: the logged model, its flavors, signature, trust note and files.
    let modelId = "";
    for (let i = 0; i < 200 && !modelId; i++) {
      const r = await stack.api<{ models: { model_id: string; status: string }[] }>(
        `/api/v1/projects/${stack.projectId}/models`,
      );
      modelId = r.models.find((m) => m.status === "LOGGED_MODEL_READY")?.model_id ?? "";
      if (!modelId) await Bun.sleep(50);
    }
    await go(`${proj()}/models`);
    await page.getByTestId("logged-models").getByRole("link", { name: "demo-clf" }).click();
    const md = page.getByTestId("model-detail");
    await md.getByTestId("flavors").getByText("sklearn 1.9.1").waitFor();
    await md.getByTestId("trust").getByText("Restricted format").waitFor();
    await md.getByTestId("signature").getByRole("cell", { name: "x", exact: true }).waitFor();
    await md.getByTestId("model-files").getByRole("link", { name: "model.skops" }).waitFor();
    await md
      .getByTestId("lineage-strip")
      .locator('[data-step="job"][data-status="linked"]')
      .waitFor();
    await md.getByRole("button", { name: "Register" }).click();
    await page.getByLabel("Registered model", { exact: true }).selectOption("__new");
    await page.getByLabel("New registered model name").fill("demo-clf");
    await page.getByRole("button", { name: "Register version" }).click();
    await page.waitForURL(/\/models\/registry\/demo-clf/);
    const versions = page.getByTestId("versions");
    await versions.getByRole("link", { name: "v1" }).waitFor();
    await versions.getByRole("button", { name: "Set alias" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Set alias" }).click();
    await page.getByText("@champion → v1").waitFor();
    await page
      .getByTestId("lineage-strip")
      .locator('[data-step="logged_model"][data-status="linked"]')
      .waitFor();
    // Criterion 5: the dataset, its version, role, split and the model trained on it.
    await go(`${proj()}/data`);
    const ds = page.getByTestId("datasets");
    await ds.getByRole("heading", { name: /demo-data/ }).waitFor();
    await ds.getByRole("cell", { name: "training" }).waitFor();
    await ds.getByRole("cell", { name: "train", exact: true }).waitFor();
    await ds.getByText("(trained)").waitFor();
    // Criterion 7: a classifier evaluation by alias, with a failing threshold and a plot.
    // The stack's fake bridge reports accuracy 0.9 for every model, so a 0.95 threshold fails.
    await go(`${proj()}/data/evaluations`);
    await page.getByRole("button", { name: "New evaluation" }).click();
    const form = page.getByTestId("new-evaluation");
    await form.getByLabel("Model registered model").selectOption("demo-clf");
    await form.getByLabel("Model version").selectOption("a:champion");
    await form.getByLabel("Dataset path").fill("data.csv");
    await form.getByLabel("Target column").fill("y");
    await form.getByRole("button", { name: "Add threshold" }).click();
    await form.getByLabel("Threshold metric").fill("accuracy_score");
    await form.getByLabel("Threshold value").fill("0.95");
    await form.getByRole("button", { name: "Run evaluation" }).click();
    await page.waitForURL(/\/data\/evaluations\/ev-/);
    const th = page.getByTestId("thresholds");
    await th.getByText("MLflow verdict: failed").waitFor({ timeout: 30_000 });
    await th.getByRole("cell", { name: "accuracy_score", exact: true }).waitFor();
    await page
      .getByTestId("eval-metrics")
      .getByRole("cell", { name: "accuracy_score", exact: true })
      .waitFor();
    const plot = page.getByTestId("eval-plots").getByRole("img", { name: "confusion_matrix.png" });
    await plot.waitFor();
    await page.getByText("demo-clf v1 (@champion at launch)").waitFor();
    await page
      .getByTestId("lineage-strip")
      .locator('[data-step="model_version"][data-status="linked"]')
      .waitFor();
    expect(modelId).toStartWith("m-");
    // Phone width: the new pages scroll inside their tables, never the page sideways.
    const evalUrl = page.url();
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      for (const path of [
        `${proj()}/data`,
        `${proj()}/data/evaluations/new`,
        `${proj()}/models/m/${modelId}`,
        `${proj()}/models/registry/demo-clf`,
        `${proj()}/runs/entrypoints`,
        evalUrl.slice(stack.origin.length),
      ]) {
        await go(path);
        await page.waitForLoadState("networkidle");
        const over = await page.evaluate<number>(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        );
        expect(over, path).toBeLessThanOrEqual(0);
      }
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
  }, 90_000);

  test("inference: one-shot by alias with validated inputs and timings, save as evidence, a warm session, saved evidence (criteria 9, 9a, 9b)", async () => {
    // Uses demo-clf@champion from the model lifecycle test (signature: x double → long).
    await go(`${proj()}/models/inference`);
    const one = page.getByTestId("one-shot");
    await one.getByLabel("Model registered model").selectOption("demo-clf");
    await one.getByLabel("Model version").selectOption("a:champion");
    await one.getByTestId("adapter-summary").getByText("tabular").waitFor();
    await one.getByTestId("adapter-summary").getByText("trust: restricted").waitFor();
    await one.getByLabel("x row 0").fill("0.5");
    await one.getByText("1 validated against the signature").waitFor();
    await one.getByRole("button", { name: "Predict" }).click();
    const res = page.getByTestId("prediction-result");
    await res.getByTestId("output").first().waitFor();
    await res.getByTestId("timings").getByText("20.0 ms").waitFor();
    await res.getByRole("button", { name: "Save as evidence" }).click();
    await res.getByTestId("saved").waitFor();
    // Session mode: start, predict, inspect, stop.
    await page.getByRole("tab", { name: "Session" }).click();
    const start = page.getByTestId("session-start");
    await start.getByLabel("Model registered model").selectOption("demo-clf");
    await start.getByLabel("Model version").selectOption("v:1");
    await start.getByRole("button", { name: "Start session" }).click();
    const panel = page.getByTestId("session-panel");
    await panel.getByText("ready", { exact: true }).waitFor({ timeout: 20_000 });
    await panel.getByLabel("x row 0").fill("1");
    await panel.getByRole("button", { name: "Predict" }).click();
    await page.getByTestId("prediction-result").getByText("round trip").waitFor();
    await panel.getByRole("button", { name: "Stop" }).click();
    await panel
      .getByTestId("end-reason")
      .getByText("stopped by the researcher")
      .waitFor({ timeout: 20_000 });
    // Compare refuses one model twice; the saved evidence is listed with what it stores.
    await page.getByRole("tab", { name: "Saved evidence" }).click();
    const ev = page.getByTestId("evidence-list");
    await ev
      .getByText(/inputs, outputs/)
      .first()
      .waitFor();
    await ev.getByRole("button", { name: /Prediction of demo-clf v1/ }).click();
    await page.getByTestId("evidence-detail").getByText("bridge v1", { exact: false }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      for (const path of [
        "/models/inference",
        "/models/inference/session",
        "/models/inference/compare",
        "/models/inference/evidence",
      ]) {
        await go(`${proj()}${path}`);
        await page.waitForLoadState("networkidle");
        const over = await page.evaluate<number>(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        );
        expect(over, path).toBeLessThanOrEqual(0);
      }
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }
  }, 90_000);

  test("LLM lab: prompt versions and diff, a RAG trace's span tree, retrieval and tool views with feedback, a GenAI evaluation side by side linked to traces, data controls (criteria 10, 10a, 10b, 10c, 10e)", async () => {
    const llmFrame = () => page.frameLocator('iframe[title="LLM"]');
    const llm = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (r) => {
        const b = (await r.json()) as { model: string; messages: { content: string }[] };
        return Response.json({
          model: b.model,
          choices: [{ message: { content: `ok ${b.messages.at(-1)?.content}` } }],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        });
      },
    });
    try {
      const pid = stack.projectId;
      const L = `/api/v1/projects/${pid}/llm`;
      await stack.api(
        `${L}/settings`,
        {
          providers: [
            { provider_id: "local", base_url: `http://127.0.0.1:${llm.port}/v1`, models: ["echo"] },
          ],
        },
        "PUT",
      );
      for (const content of ["Be terse.", "Be friendly."])
        await stack.api(`${L}/prompts`, {
          name: "faq-answer",
          template: [
            { role: "system", content },
            { role: "user", content: "{{question}}" },
          ],
        });
      await stack.api(`${L}/prompts/faq-answer/alias`, { alias: "champion", version: 1 });
      await stack.api(`${L}/golden-sets`, {
        name: "faq-golden",
        examples: [
          {
            example_id: "e1",
            inputs: { question: "refunds?" },
            expectations: { expected_response: "5 days" },
            category: "billing",
          },
          { example_id: "e2", inputs: { question: "hours?" } },
        ],
      });
      const js = (v: unknown) => JSON.stringify(v);
      const ns = Date.now() * 1e6;
      const traceId = await extensionLlm(stack.coordinator.services).traces.write(pid, {
        name: "support_agent",
        state: "OK",
        request_time: new Date().toISOString(),
        duration_ms: 900,
        tags: { "ablationkit.example_id": "e1", "ablationkit.source": "job" },
        spans: [
          {
            span_id: "r",
            parent_span_id: null,
            name: "support_agent",
            start_time_unix_nano: ns,
            end_time_unix_nano: ns + 9e8,
            status: { code: "STATUS_CODE_OK" },
            attributes: {
              "mlflow.spanType": js("AGENT"),
              "mlflow.spanInputs": js({ question: "refunds?" }),
              "mlflow.spanOutputs": js("5 days [faq.md#1]"),
            },
          },
          {
            span_id: "q",
            parent_span_id: "r",
            name: "retrieve",
            start_time_unix_nano: ns + 1e7,
            end_time_unix_nano: ns + 5e7,
            status: { code: "STATUS_CODE_OK" },
            attributes: {
              "mlflow.spanType": js("RETRIEVER"),
              "mlflow.spanOutputs": js([
                {
                  page_content: "Refunds take 5 days.",
                  metadata: { doc_uri: "faq.md", chunk_id: "1", score: 0.9 },
                },
              ]),
              "ablationkit.rag.index_revision": js("faq-abc123"),
            },
          },
          {
            span_id: "t1",
            parent_span_id: "r",
            name: "lookup_order",
            start_time_unix_nano: ns + 6e7,
            end_time_unix_nano: ns + 7e7,
            status: { code: "STATUS_CODE_ERROR", message: "slow" },
            attributes: { "mlflow.spanType": js("TOOL"), "mlflow.spanInputs": js({ order: 7 }) },
            events: [
              {
                name: "exception",
                attributes: { "exception.type": "TimeoutError", "exception.message": "slow" },
              },
            ],
          },
          {
            span_id: "t2",
            parent_span_id: "r",
            name: "lookup_order",
            start_time_unix_nano: ns + 7.5e7,
            end_time_unix_nano: ns + 8e7,
            status: { code: "STATUS_CODE_OK" },
            attributes: {
              "mlflow.spanType": js("TOOL"),
              "mlflow.spanInputs": js({ order: 7 }),
              "mlflow.spanOutputs": js({ status: "shipped" }),
            },
          },
          {
            span_id: "g",
            parent_span_id: "r",
            name: "chat_completion",
            start_time_unix_nano: ns + 1e8,
            end_time_unix_nano: ns + 8.9e8,
            status: { code: "STATUS_CODE_OK" },
            attributes: {
              "mlflow.spanType": js("CHAT_MODEL"),
              "mlflow.spanOutputs": js("5 days [faq.md#1]"),
              "mlflow.chat.tokenUsage": js({
                input_tokens: 40,
                output_tokens: 5,
                total_tokens: 45,
              }),
            },
          },
        ],
      });
      const ev = await stack.api<{ evaluation: { evaluation_id: string } }>(`${L}/evaluations`, {
        golden_set: { id: "faq-golden" },
        targets: [
          { label: "terse", prompt: "faq-answer@champion", provider_id: "local", model: "echo" },
          { label: "friendly", prompt: "faq-answer/2", provider_id: "local", model: "echo" },
        ],
        scorers: [{ name: "exact", builtin: "exact_match" }],
      });
      const evId = ev.evaluation.evaluation_id;
      for (let i = 0; i < 200; i++) {
        const r = await stack.api<{ evaluation: { state: string } }>(`${L}/evaluations/${evId}`);
        if (r.evaluation.state === "succeeded") break;
        await Bun.sleep(100);
      }
      // Prompts: versions, alias and a diff.
      await go(`${proj()}/llm/prompts`);
      await llmFrame().getByTestId("llm-lab").waitFor();
      await llmFrame().getByTestId("prompts").getByRole("link", { name: "faq-answer" }).click();
      const pd = llmFrame().getByTestId("prompt-detail");
      await pd.getByText("@champion").first().waitFor();
      await llmFrame().getByTestId("prompt-diff").getByText("- Be terse.").waitFor();
      await llmFrame().getByTestId("prompt-diff").getByText("+ Be friendly.").waitFor();
      // Traces: the RAG/tool trace from the list.
      await go(`${proj()}/llm`);
      await llmFrame()
        .getByTestId("traces")
        .getByRole("link", { name: (traceId as string).slice(0, 8) })
        .first()
        .click();
      const tree = llmFrame().getByTestId("span-tree");
      await tree.getByRole("button", { name: "retrieve" }).waitFor();
      await tree.getByText("TimeoutError").waitFor();
      await llmFrame().getByTestId("rag-view").getByText("faq.md#1").waitFor();
      await llmFrame().getByTestId("rag-view").getByText("faq-abc123").waitFor();
      await page
        .frameLocator('iframe[title="LLM"]')
        .getByTestId("rag-view")
        .getByText(/retrieval config.*unavailable|unavailable: the application did not record/i)
        .first()
        .waitFor();
      await llmFrame().getByTestId("tool-view").getByText("retried").waitFor();
      await tree.getByRole("button", { name: "chat_completion" }).click();
      await llmFrame().getByTestId("span-detail").getByText("5 days [faq.md#1]").waitFor();
      const fb = llmFrame().getByTestId("feedback");
      await fb.getByLabel("feedback name").fill("grounded");
      await fb.getByRole("button", { name: /Add feedback/ }).click();
      await fb.getByText("HUMAN").waitFor();
      // GenAI evaluation: pinned targets, side-by-side examples, the trace behind an example.
      await go(`${proj()}/llm/evaluations`);
      await llmFrame().getByTestId("llm-evaluations").getByRole("link", { name: evId }).click();
      const targets = llmFrame().getByTestId("llm-eval-targets");
      await targets.getByText("faq-answer v1").waitFor();
      await targets.getByText("(@champion)").waitFor();
      const row = llmFrame().getByTestId("example-e1");
      await row.getByText("answer e1").first().waitFor();
      await llmFrame().getByTestId("example-e2").getByText("no ground truth").waitFor();
      await row.getByRole("link", { name: "trace" }).first().click();
      await llmFrame().getByTestId("trace-detail").getByRole("link", { name: evId }).waitFor();
      // Data controls: the local provider needs no egress approval.
      await go(`${proj()}/llm/settings`);
      const dc = llmFrame().getByTestId("llm-data-controls");
      await dc.getByText("not needed").waitFor();
      // The current mode is the disabled button; capturing more is offered next to it.
      expect(await dc.getByRole("button", { name: "redacted", exact: true }).isDisabled()).toBe(
        true,
      );
      await dc.getByRole("button", { name: "full", exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      try {
        for (const path of [
          "/llm",
          `/llm/traces/${traceId}`,
          "/llm/prompts/faq-answer",
          "/llm/golden",
          `/llm/evaluations/${evId}`,
          "/llm/playground",
          "/llm/settings",
        ]) {
          await go(`${proj()}${path}`);
          await page.waitForLoadState("networkidle");
          await llmFrame().getByTestId("llm-lab").waitFor();
          const over = await llmFrame()
            .locator("html")
            .evaluate((el) => el.scrollWidth - el.clientWidth);
          expect(over, path).toBeLessThanOrEqual(0);
        }
      } finally {
        await page.setViewportSize({ width: 1400, height: 900 });
      }
    } finally {
      await llm.stop(true);
    }
  }, 90_000);

  test("backend page events remain project scoped across overlapping subscriptions", async () => {
    await go(`${proj()}/llm`);
    const frame = page.frameLocator('iframe[title="LLM"]');
    await frame.getByTestId("llm-lab").waitFor();
    const replies = await frame.locator("body").evaluate(
      (_el, pid) =>
        new Promise<{ status: number; code: string; message?: string }[]>((resolve) => {
          const results: { status: number; code: string; message?: string }[] = [];
          const probe = { events: [] as string[], done: false };
          Reflect.set(globalThis, "backendScopeProbe", probe);
          const connect = (incoming: Event) => {
            const event = incoming as MessageEvent;
            if (
              event.source !== Reflect.get(globalThis, "parent") ||
              event.data?.type !== "ablationkit.backend.connect"
            )
              return;
            Reflect.get(globalThis, "removeEventListener").call(globalThis, "message", connect);
            const port = event.ports[0];
            if (!port) return;
            port.onmessage = ({ data }) => {
              if (data.type === "event" && data.event.type === "backend.scope.probe") {
                probe.events.push(data.event.payload.marker);
                setTimeout(() => {
                  probe.done = true;
                }, 100);
                return;
              }
              if (data.id >= 901 && data.id <= 903) {
                results.push(data.error ?? { status: 200, code: "ok" });
                if (results.length === 3) resolve(results);
              }
            };
            port.start();
            port.postMessage({
              id: 901,
              method: "subscribe",
              params: {
                subscription_id: 1,
                project: "foreign-project",
                types: ["backend.scope.probe"],
              },
            });
            port.postMessage({
              id: 902,
              method: "subscribe",
              params: { subscription_id: 2, types: ["backend.scope.probe"] },
            });
            port.postMessage({
              id: 903,
              method: "subscribe",
              params: { subscription_id: 3, project: pid, types: ["backend.scope.probe"] },
            });
          };
          Reflect.get(globalThis, "addEventListener").call(globalThis, "message", connect);
          Reflect.get(globalThis, "parent").postMessage({ type: "ablationkit.backend.hello" }, "*");
        }),
      stack.projectId,
    );
    expect(replies).toEqual([
      { status: 403, code: "capability_denied", message: "Event subscription is not allowed" },
      { status: 200, code: "ok" },
      { status: 200, code: "ok" },
    ]);
    stack.coordinator.services.events.publish("foreign-project", "backend.scope.probe", {
      marker: "foreign",
    });
    stack.coordinator.services.events.publish(stack.projectId, "backend.scope.probe", {
      marker: "owned",
    });
    await poll(
      () => frame.locator("body").evaluate(() => Reflect.get(globalThis, "backendScopeProbe").done),
      true,
    );
    expect(
      await frame
        .locator("body")
        .evaluate(() => Reflect.get(globalThis, "backendScopeProbe").events),
    ).toEqual(["owned"]);
  });

  test("extensions: approved views render in opaque-origin sandboxes that cannot reach the coordinator; a run tab, a panel, an action and a demo that saves only after confirmation (criteria 15, 15a, 9d)", async () => {
    const svc = stack.coordinator.services;
    const exts = join(stack.repo, ".ablationkit/extensions");
    mkdirSync(exts, { recursive: true });
    cpSync(
      resolve(import.meta.dir, "../../../fixtures/extensions/run-inspector"),
      join(exts, "run-inspector"),
      { recursive: true },
    );
    // A demo for demo-clf@champion (from the model lifecycle test; signature: x double → long).
    const demo = join(exts, "x-demo");
    mkdirSync(join(demo, "ui"), { recursive: true });
    writeFileSync(
      join(demo, "manifest.json"),
      JSON.stringify({
        schema_version: 1,
        id: "x-demo",
        version: "0.1.0",
        name: "x demo",
        host_api: "^1.0.0",
        contributes: [
          { id: "demo", point: "model.demo", title: "x playground", entry: "ui/Demo.tsx" },
        ],
        capabilities: ["inference.predict"],
        capability_config: {
          inference: {
            models: ["demo-clf@champion"],
            max_requests_per_hour: 20,
            max_request_bytes: 4096,
          },
        },
      }),
    );
    writeFileSync(
      join(demo, "ui/Demo.tsx"),
      `import type { PredictResult } from "@ablationkit/extension-sdk";
import { Button, mountReact, useHost } from "@ablationkit/extension-sdk/react";
import { useState } from "react";
function Demo() {
  const host = useHost();
  const [r, setR] = useState<PredictResult>();
  const [saved, setSaved] = useState<string>();
  return (
    <div data-testid="x-demo">
      <Button onClick={async () => setR(await host.call<PredictResult>("inference.predict", { model: "demo-clf@champion", inputs: { records: [{ x: 0.5 }] } }))}>Predict</Button>
      {r ? <p data-testid="out">out {JSON.stringify(r.models[0]?.outputs)}</p> : null}
      {r ? <Button onClick={async () => { const s = await host.saveResult(r.result_id, { title: "x demo prediction" }); setSaved(s ? s.evidence_id : "declined"); }}>Save</Button> : null}
      {saved ? <p data-testid="saved">saved {saved}</p> : null}
    </div>
  );
}
void mountReact(Demo);
`,
    );
    // Approval is a web UI action; here the service call stands in for it.
    for (const id of ["run-inspector", "x-demo"]) {
      const b = await svc.extensions.buildExtension(stack.projectId, id, { kind: "human" });
      expect(b.status).toBe("ready");
      svc.extensions.approve(
        stack.projectId,
        id,
        { build_id: b.build_id, trusted_code: true },
        { kind: "human" },
      );
    }
    await go(`${proj()}/settings/extensions`);
    await page.getByTestId("ext-row-run-inspector").getByText("Active").waitFor();
    await page.getByTestId("ext-row-x-demo").getByText("Active").waitFor();
    await page.getByTestId("ext-row-run-inspector").getByRole("link").click();
    await page.getByTestId("extension-detail").getByText("project.research.write").waitFor();
    await page.getByRole("button", { name: "Disable" }).waitFor();

    // A run tab: the bridge reads the run; the frame is sandboxed with no way out.
    const runs = await stack.api<{ runs: { info: { run_id: string } }[] }>(
      `/api/v1/tracking/runs?project=${stack.projectId}&max_results=1`,
    );
    const runId = runs.runs[0]?.info.run_id as string;
    await go(`${proj()}/runs/r/${runId}`);
    await page.getByRole("button", { name: "Inspector" }).click();
    const tab = page.frameLocator('iframe[title="run-inspector: Inspector"]');
    await tab.getByTestId("run-inspector").getByText("metric").waitFor();
    const frame = page.frames().find((f) => f.url().includes("/ext-frame/"));
    expect(frame).toBeDefined();
    const probe = (await frame?.evaluate(`(async () => {
      const out = { origin: String(self.origin) };
      const attempt = async (k, f) => {
        try {
          out[k] = String(await f());
        } catch {
          out[k] = "blocked";
        }
      };
      await attempt("cookie", () => document.cookie);
      await attempt("fetch", async () => (await fetch("/api/v1/health"), "reached"));
      await attempt("parent", () => window.parent.document.title);
      await attempt("storage", () => (localStorage.setItem("k", "v"), "allowed"));
      // Ways out that do not need fetch: each must leave the frame where it is, with nothing sent.
      await attempt("socket", async () => {
        const ws = new WebSocket("ws://" + location.host + "/");
        return await new Promise((res, rej) => {
          ws.onopen = () => res("reached");
          ws.onerror = () => rej(new Error("x"));
        });
      });
      await attempt("beacon", async () => {
        const img = new Image();
        img.src = "http://127.0.0.1:9/leak.png?secret=1";
        return await new Promise((res, rej) => {
          img.onload = () => res("reached");
          img.onerror = () => rej(new Error("x"));
        });
      });
      await attempt("popup", () => (window.open("https://example.com/") ? "opened" : "blocked"));
      await attempt("top", () => {
        window.top.location.href = "https://example.com/";
        return "navigated";
      });
      await attempt("nested", async () => {
        const f = document.createElement("iframe");
        f.src = "/api/v1/health";
        document.body.append(f);
        await new Promise((res) => setTimeout(res, 300));
        const seen = f.contentDocument;
        f.remove();
        return seen ? "reached" : "blocked";
      });
      await attempt("form", async () => {
        const f = document.createElement("form");
        f.action = "/api/v1/projects";
        f.method = "post";
        document.body.append(f);
        f.submit();
        return "blocked";
      });
      await attempt("eval", () => eval("1 + 1"));
      await attempt("script", async () => {
        const el = document.createElement("script");
        el.src = "http://127.0.0.1:9/x.js";
        return await new Promise((res, rej) => {
          el.onload = () => res("reached");
          el.onerror = () => rej(new Error("x"));
          document.head.append(el);
        });
      });
      return out;
    })()`)) as Record<string, string>;
    // None of those moved the host page.
    expect(page.url().startsWith(stack.origin)).toBe(true);
    expect(probe).toEqual({
      origin: "null",
      cookie: "blocked",
      fetch: "blocked",
      parent: "blocked",
      storage: "blocked",
      socket: "blocked",
      beacon: "blocked",
      popup: "blocked",
      top: "blocked",
      nested: "blocked",
      form: "blocked",
      eval: "blocked",
      script: "blocked",
    });
    // A frame cannot forge its way into another view's bridge: the host only answers its own
    // window's hello, over a private channel. A stray message to the top window does nothing.
    const stray = await frame?.evaluate(`(async () => {
      window.parent.postMessage({ type: "hello", id: 1, method: "runs.list" }, "*");
      window.parent.postMessage({ navigate: "https://example.com/" }, "*");
      await new Promise((r) => setTimeout(r, 200));
      return "sent";
    })()`);
    expect(stray).toBe("sent");
    expect(page.url().startsWith(stack.origin)).toBe(true);

    // A project panel has its own page, linked from the project navigation and Overview; Overview
    // itself mounts no panel frame (opening it never starts an extension's Python).
    await go(proj());
    await page.getByTestId("extension-panels").getByRole("link", { name: "Recent runs" }).waitFor();
    expect(await page.locator('iframe[title="run-inspector: Recent runs"]').count()).toBe(0);
    await page
      .getByRole("navigation", { name: /navigation$/ })
      .last()
      .getByRole("link", { name: "Recent runs" })
      .click();
    await page.getByTestId("extension-panel-page").waitFor();
    expect(page.url()).toContain("/x/run-inspector/");
    await page
      .frameLocator('iframe[title="run-inspector: Recent runs"]')
      .getByText(/recent runs/)
      .waitFor();
    // Overview: the action.
    await go(proj());
    await page
      .getByTestId("extension-actions")
      .getByRole("button", { name: "Add a checkpoint note" })
      .click();
    await page
      .getByTestId("extension-actions")
      .getByText(/record_id/)
      .waitFor();

    // A demo predicts through the bridge; saving asks the researcher in trusted UI first.
    await go(`${proj()}/models/demos`);
    const d = page.frameLocator('iframe[title="x-demo: x playground"]');
    await d.getByRole("button", { name: "Predict" }).click();
    await d
      .getByTestId("out")
      .waitFor()
      .catch((e: unknown) => {
        // Name what the bridge saw (each call and its status) before failing.
        const detail = svc.extensions.detail(stack.projectId, "x-demo") as { console?: unknown };
        console.error("x-demo console:", JSON.stringify(detail.console, null, 1));
        throw e;
      });
    await d.getByRole("button", { name: "Save" }).click();
    const dialog = page.getByRole("dialog", { name: "Save this result as evidence?" });
    await dialog.getByText("x demo prediction").waitFor();
    await dialog.getByRole("button", { name: "Save evidence" }).click();
    await d
      .getByTestId("saved")
      .getByText(/saved ie-/)
      .waitFor();

    // Disabled: nothing mounts; core pages still work.
    await svc.extensions.disable(stack.projectId, "x-demo", {}, { kind: "human" });
    await go(`${proj()}/models/demos`);
    await page.getByText("No approved demos in this project.").waitFor();
  }, 90_000);

  test("extensions: enabled as built and shown so in the browser; a report block saves a static snapshot after confirmation; a comparison view mounts (criteria 15a, 15f)", async () => {
    const { scaffoldExtension } = await import("@ablationkit/extension-host/templates");
    const svc = stack.coordinator.services;
    for (const [template, id] of [
      ["report-widget", "loss-widget"],
      ["result-comparison", "metric-compare"],
    ] as const)
      scaffoldExtension({ template, id, checkout: stack.repo, name: id });
    const block = join(stack.repo, ".ablationkit/extensions/loss-widget/ui/src/Block.tsx");
    writeFileSync(
      block,
      readFileSync(block, "utf8").replace('const METRIC = "loss";', 'const METRIC = "train/loss";'),
    );
    const built: Record<string, string> = {};
    for (const id of ["loss-widget", "metric-compare"])
      built[id] = (
        await svc.extensions.buildExtension(stack.projectId, id, { kind: "agent" })
      ).build_id;

    // Enabled as built (ADR 0045): the agent's build is active, labelled as such, no approval step.
    for (const id of ["loss-widget", "metric-compare"]) {
      await go(`${proj()}/settings/extensions/${id}`);
      const detail = page.getByTestId("extension-detail");
      await detail.getByText("Active", { exact: true }).waitFor();
      await detail.getByText("enabled as built").first().waitFor();
      const a = svc.extensions.approval(stack.projectId, id, built[id] as string);
      expect([a?.build_id, a?.automatic]).toEqual([built[id], true]);
    }

    // The report block: snapshot only after confirming in trusted UI; it outlives the extension.
    const rep = await stack.api<{ record: { record_id: string } }>(
      `/api/v1/projects/${stack.projectId}/research`,
      {
        kind: "report",
        title: "Widget report",
      },
    );
    await go(`${proj()}/knowledge/r/${rep.record.record_id}`);
    const w = page.frameLocator('iframe[title="loss-widget: loss-widget"]');
    await w.getByRole("button", { name: "Save snapshot to the report" }).click();
    const dlg = page.getByRole("dialog", { name: "Add this snapshot to the report?" });
    await dlg.getByRole("button", { name: "Add to report" }).click();
    await w.getByRole("button", { name: "Saved to the report" }).waitFor();
    await page.getByTestId("report-snapshots").getByText("train/loss of recent runs").waitFor();
    await svc.extensions.disable(stack.projectId, "loss-widget", {}, { kind: "human" });
    await page.reload();
    await page.getByTestId("report-snapshots").getByText("train/loss of recent runs").waitFor();
    await page
      .getByTestId("record-body")
      .getByText(/train\/loss of recent runs/)
      .waitFor();

    // A comparison view below Runs → Compare, with the selected run IDs as context.
    const runs = await stack.api<{ runs: { info: { run_id: string } }[] }>(
      `/api/v1/tracking/runs?project=${stack.projectId}&max_results=2&filter=${encodeURIComponent("metrics.`train/loss` >= 0")}`,
    );
    expect(runs.runs).toHaveLength(2);
    await go(`${proj()}/runs/compare?runs=${runs.runs.map((r) => r.info.run_id).join(",")}`);
    await page
      .frameLocator('iframe[title="metric-compare: metric-compare"]')
      .getByTestId("result-comparison")
      .getByText("train/loss")
      .waitFor();
  }, 90_000);

  test("agent compute limit: set a weight on Compute and see an agent job's usage; raise the limit in Project settings after a before → after summary (ADR 0037)", async () => {
    const pid = stack.projectId;
    await go("/compute");
    const weights = page.getByTestId("compute-weights");
    // The weights editor is folded away on Compute (ADR 0055).
    await weights.locator("summary").click();
    await weights.getByLabel("Weight of local").fill("2");
    await weights.getByRole("button", { name: "Save weights" }).click();
    await weights.getByText(/Last changed/).waitFor();

    // An agent submits a job with a 30-minute time limit: at weight 2 it reserves 1 weighted hour.
    const { token } = await stack.agentSession("compute check");
    const r = await fetch(`${stack.coordinator.urls.agent}/api/v1/projects/${pid}/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        command: ["sleep", "60"],
        environment: "none",
        limits: { runtime_max_sec: 1800 },
      }),
    });
    expect(r.status).toBe(201);
    const job = (await r.json()) as { job_id: string; compute_weight_hundredths: number };
    expect(job.compute_weight_hundredths).toBe(200);
    const agentCompute = page.getByTestId("agent-compute");
    await agentCompute
      .getByRole("img", { name: /Agent compute in .*: .* used \+ 1 reserved of 10 weighted hours/ })
      .waitFor();

    await go(`${proj()}/settings`);
    const card = page.getByTestId("agent-permissions");
    const before = await stack.api<{ policy: { revision: number } }>(
      `/api/v1/projects/${pid}/policy`,
    );
    await card.getByText(`Revision ${before.policy.revision}`, { exact: false }).waitFor();
    await card.getByText("Run jobs on this workstation").waitFor();
    await card.getByText(/reserved of 10 weighted hours/).waitFor();
    await card.getByLabel("Compute limit in weighted hours").fill("24");
    await card.getByRole("button", { name: "Review changes…" }).click();
    const dialog = page.getByRole("dialog");
    const changes = dialog.getByTestId("policy-changes");
    await changes.getByText("Compute limit").waitFor();
    await changes.getByText("10 weighted hours → 24 weighted hours", { exact: false }).waitFor();
    await changes.getByText("agents may do more").waitFor();
    await dialog
      .getByRole("button", { name: `Save as revision ${before.policy.revision + 1}` })
      .click();
    await dialog.waitFor({ state: "detached" });
    await card.getByText(`Revision ${before.policy.revision + 1}`, { exact: false }).waitFor();
    await card.getByText(/reserved of 24 weighted hours/).waitFor();
    const after = await stack.api<{ policy: { compute: { limit_hours: number } } }>(
      `/api/v1/projects/${pid}/policy`,
    );
    expect(after.policy.compute.limit_hours).toBe(24);

    await stack.api(`/api/v1/jobs/${job.job_id}/cancel`, {});
    await stack.api("/api/v1/compute/weights", { weights: { local: null } }, "PUT");
  });

  test("tasks: an agent session's task with the job and note recorded under it; the researcher abandons it; Settings ends the session (ADR 0039, 0040)", async () => {
    const pid = stack.projectId;
    const { token, token_id } = await stack.agentSession("Width sweep session");
    const agent = async <T>(path: string, body: unknown): Promise<T> => {
      const r = await fetch(`${stack.coordinator.urls.agent}/api/v1/projects/${pid}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(201);
      return (await r.json()) as T;
    };
    const { task } = await agent<{ task: { task_id: string } }>("/tasks", {
      title: "Width sweep",
      goal: "Does width 256 beat 128 on val_loss?",
      criteria: ["three seeds per width"],
    });
    const job = await agent<{ job_id: string }>("/jobs", {
      command: ["sleep", "30"],
      environment: "none",
      limits: { runtime_max_sec: 60 },
      task_id: task.task_id,
    });
    await agent("/research", {
      kind: "note",
      title: "Sweep plan",
      body: "Widths 128 and 256.",
      links: [{ kind: "task", id: task.task_id }],
    });

    await go(proj());
    await page.getByTestId("findings").getByRole("link", { name: "Width sweep" }).click();
    await page
      .getByTestId("task-question")
      .getByText("Does width 256 beat 128 on val_loss?")
      .waitFor();
    await page.getByTestId("task-answer").getByText("Still open").waitFor();
    await page.getByText("three seeds per width").waitFor();
    await page.getByRole("link", { name: "Sweep plan" }).waitFor();
    await page
      .getByTestId("task-runs")
      .getByRole("link", { name: job.job_id.slice(0, 22) })
      .waitFor();
    // Attributed to the agent session that created it.
    await page
      .getByText(/by agent · Width sweep session \(claude-code\)/)
      .first()
      .waitFor();
    // No buttons that would drive an agent; the researcher can abandon an open task.
    expect(await page.getByRole("button", { name: /dispatch|approve|new task/i }).count()).toBe(0);
    page.once("dialog", (d) => void d.accept("superseded"));
    await page.getByRole("button", { name: "Abandon" }).click();
    await page.getByText("superseded", { exact: true }).waitFor();
    await page
      .getByRole("navigation", { name: "Section" })
      .getByRole("link", { name: "Tasks" })
      .click();
    await page.getByTestId("tasks-table").getByText("abandoned", { exact: true }).waitFor();
    await stack.api(`/api/v1/jobs/${job.job_id}/cancel`, {});

    // Settings → Agent sessions lists the session with what it recorded; ending it revokes its
    // token.
    await go("/settings");
    await page
      .getByRole("navigation", { name: "Section" })
      .getByRole("link", { name: "Agent sessions" })
      .click();
    const sessions = page.getByTestId("agent-sessions");
    const row = sessions.getByRole("row").filter({ hasText: token_id });
    await row.getByText("Width sweep session").waitFor();
    await row.getByText("1 jobs · 1 records · 1 tasks").waitFor();
    await row.getByRole("button", { name: "End session" }).click();
    await row.getByText("ended: ended in settings").waitFor();
    const after = await fetch(`${stack.coordinator.urls.agent}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
  });

  test("the witness (ADR 0056): a finding's numbers are live run references; the runs it leaves out show with the agent's reasons; the task accounts for every run; Project settings → Agents shows the session's account", async () => {
    const pid = stack.projectId;
    const { token, token_id } = await stack.agentSession("Witness session");
    const agent = async <T>(path: string, body?: unknown, method?: string): Promise<T> => {
      const r = await fetch(`${stack.coordinator.urls.agent}/api/v1/projects/${pid}${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(r.ok).toBe(true);
      return (await r.json()) as T;
    };
    const { task } = await agent<{ task: { task_id: string } }>("/tasks", {
      title: "Witness probe",
      goal: "Do the probes agree?",
    });
    for (const run_name of ["witness-a", "witness-b", "witness-c"])
      await agent("/jobs", {
        command: ["true"],
        environment: "none",
        limits: { runtime_max_sec: 60 },
        task_id: task.task_id,
        run_name,
      });
    type Run = { name?: string; mlflow_run_id?: string; standing: string };
    let runs: Run[] = [];
    for (let i = 0; i < 400; i++) {
      runs = (await agent<{ runs: Run[] }>(`/tasks/${task.task_id}`)).runs;
      if (runs.length === 3 && runs.every((r) => r.mlflow_run_id && r.standing !== "running"))
        break;
      await Bun.sleep(100);
    }
    const b = runs.find((r) => r.name === "witness-b")?.mlflow_run_id;
    await agent(`/runs/${b}/description`, { set_aside: "Launched with the wrong config." }, "PUT");
    await agent("/vault/notes", {
      id: "witness-probe",
      type: "finding",
      title: "The probe ends where the baseline ends",
      gist: "Probe A ends at [[run:baseline-s0#train/loss]] train loss, [[run:lr-low-s0#train/loss vs baseline-s0]] from lr-low.",
      evidence: [
        { run: "witness-a", role: "for" },
        { run: "baseline-s0", role: "baseline", metric: "train/loss" },
      ],
      task_id: task.task_id,
      sources: [`task:${task.task_id}`],
    });
    await agent("/vault/notes", {
      id: "witness-claim",
      type: "claim",
      title: "The probes agree",
      gist: "The probes agree with the baseline.",
      standing: "open",
      support: "one probe",
      full: "![[witness-probe]]",
      sources: [`task:${task.task_id}`],
    });
    await agent("/vault/notes/witness-claim", { standing: "leaning" }, "PATCH");

    // The finding: its numbers are drawn from the runs, and the runs it leaves out are listed.
    await go(`${proj()}/notebooks/n/witness-probe`);
    const live = page.locator("a.v-rr").first();
    await live.waitFor();
    expect(await live.getAttribute("title")).toMatch(/^train\/loss of baseline-s0: \d/);
    expect(await live.textContent()).toMatch(/^\d+\.\d{4}$/);
    const behind = page.getByTestId("runs-behind");
    await behind.getByText(/1 of the 3 runs of its one task are named here/).waitFor();
    await behind.getByRole("button").click();
    await behind.getByText("Launched with the wrong config.").waitFor();
    await behind.getByText("No note cites it and the agent gave no reason.").waitFor();

    // The task accounts for every run.
    await go(`${proj()}/tasks/${task.task_id}`);
    const drawer = page.getByTestId("task-drawer");
    await drawer.getByText("1 cited · 1 set aside · 1 unaccounted for", { exact: false }).waitFor();

    // Project settings → Agents lists this project's sessions, each with its account: the
    // coordinator's record beside what it wrote.
    await go(`${proj()}/settings`);
    const row = page.getByTestId("agent-sessions").getByRole("row").filter({ hasText: token_id });
    await row.getByRole("button", { name: "Account" }).click();
    const acc = page.getByTestId("session-account");
    await acc.getByText("What the coordinator recorded").waitFor();
    await acc.getByText("3 (3 attempts): 3 succeeded").waitFor();
    await acc.getByText("1 cited · 1 set aside · 1 unaccounted for").waitFor();
    await acc.getByText(/The probes agree: open → /).waitFor();
  });

  test("compute: time and spend by target, utilization from system metrics, targets; an exported Colab attempt shows its sync status and notebook", async () => {
    await stack.api("/api/v1/targets/colab-nb", { kind: "colab", label: "Colab notebooks" }, "PUT");
    // An unattended Colab target (ADR 0059), with the test suite's fake Colab CLI: the account's
    // compute units show on Compute.
    await stack.api(
      "/api/v1/targets/colab-cli",
      {
        kind: "colab",
        label: "Colab L4",
        colab: {
          mode: "cli",
          gpu: "L4",
          cli: ["python3", resolve(import.meta.dir, "../../server/test/fake-colab.py")],
        },
      },
      "PUT",
    );
    const job = await stack.api<{ job_id: string }>(`/api/v1/projects/${stack.projectId}/jobs`, {
      command: ["python3", "train.py", "--epochs", "1"],
      target_id: "colab-nb",
      environment: "none",
      limits: { runtime_max_sec: 3600 },
    });
    await go("/compute");
    await page.getByTestId("compute-totals").getByText("Estimated spend").waitFor();
    const byTarget = page.getByTestId("compute-by-target");
    await byTarget.getByText("this workstation").waitFor();
    await byTarget.getByText("Colab notebooks").waitFor();
    // The seeded runs report system/cpu_utilization_percentage.
    await page
      .getByTestId("compute-utilization")
      .getByText(/Mean over \d+ runs/)
      .waitFor();
    await page.getByTestId("compute-jobs").getByText("colab-nb").first().waitFor();
    const targets = page.getByTestId("remote-targets");
    await targets.getByText("Colab notebooks").waitFor();
    await targets.getByText("notebook export only").waitFor();
    await targets.getByText("GPU L4", { exact: true }).waitFor();
    const usage = targets.getByTestId("colab-usage");
    await usage.getByText("100.00 compute units left").waitFor();
    await usage.getByText("using 0.00/h on 0 runtimes").waitFor();
    await targets.getByRole("button", { name: "Doctor" }).first().click();
    await targets.getByText("unattended execution").waitFor();
    await go(`${proj()}/runs/jobs`);
    await page.getByTestId("jobs-table").getByText("on colab-nb").first().waitFor();
    await go(`${proj()}/runs/jobs/${job.job_id}`);
    const panel = page.getByTestId("remote-panel");
    await panel.getByText("Remote: colab-nb").waitFor();
    await panel.getByText("staging").waitFor();
    await panel.getByRole("link", { name: "Download the notebook" }).waitFor({ timeout: 30_000 });
    await panel.getByText("sync: awaiting sync").waitFor();
    // It waits on a person, says Colab doesn't run unattended, and when it should be back.
    await panel.getByText("compute: waiting for you to run the notebook").waitFor();
    const help = panel.getByTestId("colab-help");
    await help.getByText("A notebook does not run unattended.").waitFor();
    await help.getByText(/Expected back by .* plus the job's time limit/).waitFor();
    await help.getByText("--loader", { exact: false }).first().waitFor();
    // F29: a runtime that is gone can be marked lost from here.
    await panel.getByTestId("remote-overdue").getByRole("button", { name: "Mark lost" }).waitFor();
  });

  test("system: startup diagnostics; a backup is created, verified and scheduled for restore, then cancelled (criterion 17)", async () => {
    await go("/system");
    const diag = page.getByTestId("diagnostics");
    await diag.getByText("orphaned tracking runs").waitFor();
    await diag.getByText("missing artifacts").waitFor();
    const backups = page.getByTestId("backups");
    const before = await backups.getByRole("button", { name: "Verify" }).count();
    await backups.getByRole("button", { name: "Create backup" }).click();
    await poll(() => backups.getByRole("button", { name: "Verify" }).count(), before + 1);
    await backups.getByRole("button", { name: "Verify" }).first().click();
    await backups.getByText("verified", { exact: true }).waitFor();
    await backups.getByRole("button", { name: "Restore at next start…" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Schedule the restore" }).click();
    await page.getByTestId("pending-restore").waitFor();
    const pending = await stack.api<{ pending_restore: { backup_id: string } | null }>(
      "/api/v1/backups",
    );
    expect(pending.pending_restore?.backup_id).toMatch(/^[0-9]{8}T[0-9]{6}Z/);
    await page.getByTestId("pending-restore").getByRole("button", { name: "Cancel" }).click();
    await page.getByTestId("pending-restore").waitFor({ state: "detached" });
  });

  test("remove a project from Project settings: the plan and the typed ID; the code stays (ADR 0034)", async () => {
    const repo = join(stack.repo, "..", "scratch-model");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "train.py"), "print('kept')\n");
    await stack.api("/api/v1/projects", { path: repo, project_id: "scratch" });
    expect(existsSync(join(repo, ".ablationkit", "project.json"))).toBe(true);

    await go("/p/scratch/settings");
    await page.getByRole("button", { name: "Remove project…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("the checkout's .ablationkit/").waitFor();
    const remove = dialog.getByRole("button", { name: "Remove", exact: true });
    expect(await remove.isDisabled()).toBe(true);
    await dialog.getByLabel("Project ID to confirm").fill("scratch");
    await remove.click();
    await page.waitForURL(`${stack.origin}/`);

    const listed = await stack.api<{ projects: { project_id: string }[] }>("/api/v1/projects");
    expect(listed.projects.map((p) => p.project_id)).not.toContain("scratch");
    expect(existsSync(join(repo, "train.py"))).toBe(true);
    expect(existsSync(join(repo, ".ablationkit"))).toBe(false);
  });

  test("command palette mirrors the CLI", async () => {
    await go(`${proj()}/runs`);
    await page.getByTestId("runs-table").waitFor();
    await page.keyboard.press("Control+k");
    const input = page.getByLabel("Command", { exact: true });
    await input.fill("tracking doctor");
    await page.getByText("ablationkit tracking doctor").waitFor();
    await input.press("Enter");
    // System is Settings' tab (ADR 0055).
    await page.waitForURL(`${stack.origin}/system`);
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    await page.getByRole("heading", { name: /Tracking doctor/ }).waitFor();
  });

  test("no uncaught page errors", () => {
    expect(errors.filter((e) => !FRAME_PROBE_NOISE.test(e))).toEqual([]);
  });
});
