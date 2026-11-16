/** Pure web-shell logic: information architecture, palette, formatting, launch parsing, tables. */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentSession,
  actorText,
  agentSessionsPath,
  sessionName,
} from "../src/lib/agent-sessions.ts";
import {
  computeLabel,
  delta,
  expectedBackBy,
  fmtBytes,
  fmtDelta,
  fmtDuration,
  fmtNum,
  fmtShortTime,
  isUnsafeModelFormat,
  PREVIEW_MAX_BYTES,
  previewKind,
  workerLabel,
} from "../src/lib/format.ts";
import { launchBody, parseDuration, parseSize, splitArgs } from "../src/lib/launch.ts";
import {
  ablationCsv,
  buildFilter,
  compareCsv,
  lowerIsBetter,
  metricDirection,
  niceTicks,
  rankMetricKeys,
  sharedTag,
} from "../src/lib/tables.ts";
import {
  activeProjectItem,
  backendProjectNav,
  GLOBAL_FOOT,
  GLOBAL_NAV,
  MODELS_TABS,
  modelsTabs,
  ORIGINAL_RECORDS,
  PROJECT_NAV,
  projectNav,
  RUNS_TABS,
  runsTabs,
} from "../src/nav.ts";
import { COMMANDS, matchCommands, parseInput } from "../src/palette-commands.ts";

describe("information architecture (spec §2.2, ADR 0036)", () => {
  test("global layer: Home and Compute, then Settings and Docs at the bottom (ADR 0055)", () => {
    expect(GLOBAL_NAV.map((n) => n.label)).toEqual(["Home", "Compute"]);
    expect(GLOBAL_FOOT.map((n) => n.label)).toEqual(["Settings", "Docs"]);
  });

  test("project layer matches the normative table, in order", () => {
    expect(PROJECT_NAV.map((n) => n.label)).toEqual([
      "Overview",
      "Standing",
      "Notebooks",
      "Runs",
      "Data & Evals",
      "Models",
      "Project settings",
    ]);
  });

  test("backend page visibility comes from registered page metadata", () => {
    const backends = [
      {
        id: "llm-research",
        enabled: true,
        pages: [
          {
            id: "llm",
            title: "LLM",
            path: "/llm",
            entry: "ui.tsx",
            profiles: ["llm", "rag", "agent"],
          },
          { id: "audit", title: "Audit", path: "/audit", entry: "audit.tsx" },
        ],
      },
      {
        id: "disabled-addon",
        enabled: false,
        pages: [{ id: "hidden", title: "Hidden", path: "/hidden", entry: "hidden.tsx" }],
      },
    ];
    const llm = backendProjectNav(backends, ["llm"]);
    expect(llm.primary.map((i) => i.id)).toEqual([
      "backend:llm-research:llm",
      "backend:llm-research:audit",
    ]);
    expect(llm.more).toEqual([]);
    const tabular = backendProjectNav(backends, ["tabular"]);
    expect(tabular.primary.map((i) => i.id)).toEqual(["backend:llm-research:audit"]);
    expect(tabular.more.map((i) => i.id)).toEqual(["backend:llm-research:llm"]);
    expect([...tabular.primary, ...tabular.more].map((i) => i.id)).not.toContain(
      "backend:disabled-addon:hidden",
    );
  });

  test("backend profiles move only their declared pages under More", () => {
    const backends = [
      {
        id: "analysis",
        enabled: true,
        pages: [
          {
            id: "vision",
            title: "Vision",
            path: "/vision",
            entry: "vision.tsx",
            profiles: ["computer_vision"],
          },
          { id: "runs", title: "Runs helper", path: "/runs-helper", entry: "runs.tsx" },
        ],
      },
    ];
    const v = backendProjectNav(backends, ["tabular"]);
    expect(v.primary.map((i) => i.id)).toEqual(["backend:analysis:runs"]);
    expect(v.more.map((i) => i.id)).toEqual(["backend:analysis:vision"]);
  });

  test("the core project navigation is never cut, only moved under More (ADR 0055)", () => {
    for (const lifecycle of [true, false]) {
      const v = projectNav(lifecycle);
      expect([...v.primary, ...v.more].map((i) => i.id).sort()).toEqual(
        PROJECT_NAV.map((i) => i.id).sort(),
      );
    }
    // Data & Evals and Models wait under More until the project logs a model or runs an evaluation.
    expect(projectNav(false).primary.map((i) => i.label)).toEqual([
      "Overview",
      "Standing",
      "Notebooks",
      "Runs",
      "Project settings",
    ]);
    expect(projectNav(false).more.map((i) => i.id)).toEqual(["data", "models"]);
    expect(projectNav(true).more).toEqual([]);
    for (const has of [true, false]) {
      const v = modelsTabs(has);
      expect([...v.primary, ...v.more].length).toBe(MODELS_TABS.length);
    }
  });

  test("Registry, Inference and Demos sit under More until a logged model exists", () => {
    expect(modelsTabs(false).primary.map((t) => t.id)).toEqual(["logged"]);
    expect(modelsTabs(false).more.map((t) => t.id)).toEqual(["registry", "inference", "demos"]);
    expect(modelsTabs(true).more).toEqual([]);
  });

  test("Runs holds studies, comparison, jobs, MLproject entrypoints and experiments", () => {
    expect(RUNS_TABS.map((t) => t.id)).toEqual([
      "runs",
      "studies",
      "jobs",
      "compare",
      "entrypoints",
      "experiments",
    ]);
    // ADR 0055: the operator's tabs sit under "More".
    expect(runsTabs().primary.map((t) => t.id)).toEqual(["runs", "studies", "jobs"]);
    expect(runsTabs().more.map((t) => t.id)).toEqual(["compare", "entrypoints", "experiments"]);
  });

  test("active project item from the path", () => {
    expect(activeProjectItem("")).toBe("overview");
    expect(activeProjectItem("/runs/r/abc")).toBe("runs");
    expect(activeProjectItem("/settings")).toBe("settings");
    expect(activeProjectItem("/nope")).toBe("overview");
    expect(activeProjectItem("/standing")).toBe("standing");
    expect(activeProjectItem("/notebooks/n/how-it-works")).toBe("notebooks");
    // Review, Knowledge and Tasks are the original records, under More (ADR 0055).
    expect(ORIGINAL_RECORDS.map((i) => i.label)).toEqual(["Knowledge", "Tasks", "Review"]);
    expect(activeProjectItem("/review")).toBe("review");
    expect(activeProjectItem("/knowledge/r/hyp-20261111-821fd1")).toBe("knowledge");
    expect(activeProjectItem("/tasks/task-20261111-ljvjsb")).toBe("tasks");
    expect(
      activeProjectItem("/llm/prompts", [
        { id: "backend:llm-research:lab", label: "Lab", path: "/llm", contains: "Lab" },
      ]),
    ).toBe("backend:llm-research:lab");
  });
});

describe("command palette", () => {
  test("a CLI line is shown only for human/operations commands the CLI still has (ADR 0040)", () => {
    const kept =
      /^ablationkit (project|target|tracking|backup|login|coordinator|system|access|ui) /;
    for (const c of COMMANDS) {
      expect(c.phrase.length).toBeGreaterThan(0);
      if (c.cli) expect(`${c.cli} `).toMatch(kept);
    }
    expect(COMMANDS.find((c) => c.id === "run.logs")?.cli).toBeUndefined();
  });

  test("project-scoped commands are hidden without a project", () => {
    const ids = matchCommands("", { hasProject: false }).map((c) => c.id);
    expect(ids).not.toContain("run.submit");
    expect(matchCommands("", { hasProject: true }).map((c) => c.id)).toContain("run.submit");
  });

  test("matches by title, CLI text and subsequence", () => {
    expect(matchCommands("backup create", { hasProject: false })[0]?.id).toBe("backup.create");
    expect(matchCommands("tracking doctor", { hasProject: false })[0]?.id).toBe("tracking.doctor");
    expect(matchCommands("launch", { hasProject: true })[0]?.id).toBe("run.submit");
    expect(matchCommands("trkdoc", { hasProject: false }).map((c) => c.id)).toContain(
      "tracking.doctor",
    );
    expect(matchCommands("zzzzqq", { hasProject: true })).toEqual([]);
  });

  test("inside a project the palette leads with the vault, then studies and runs (ADR 0055)", () => {
    expect(
      matchCommands("", { hasProject: true })
        .slice(0, 7)
        .map((c) => c.id),
    ).toEqual([
      "standing",
      "notebooks",
      "vault.find",
      "vault.library",
      "vault.tree",
      "studies",
      "runs.search",
    ]);
    expect(matchCommands("", { hasProject: false })[0]?.id).toBe("go.docs");
    expect(matchCommands("library", { hasProject: true })[0]?.id).toBe("vault.library");
  });

  test("arguments typed after a command", () => {
    expect(parseInput("run logs job-123")).toEqual({ query: "run logs", arg: "job-123" });
    expect(parseInput("project add /srv/repo")).toEqual({ query: "project add", arg: "/srv/repo" });
    expect(parseInput("compare")).toEqual({ query: "compare", arg: "" });
    expect(matchCommands("run logs job-123", { hasProject: false })[0]?.id).toBe("run.logs");
  });
});

describe("formatting", () => {
  test("numbers, bytes and durations", () => {
    expect(fmtNum(3)).toBe("3");
    expect(fmtNum(0.123456)).toBe("0.1235");
    expect(fmtNum(0.00001234)).toBe("1.234e-5");
    expect(fmtNum(undefined)).toBe("—");
    expect(fmtNum(Number.NaN)).toBe("NaN");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 KiB");
    expect(fmtDuration(65_000)).toBe("1m 5s");
    expect(fmtDuration(3_700_000)).toBe("1h 1m");
  });

  test("a table's date is short and drops this year", () => {
    const now = new Date(2026, 10, 13, 12).getTime();
    const same = fmtShortTime(new Date(2026, 10, 13, 3, 39).getTime(), now);
    expect(same).not.toContain("2026");
    expect(same).toContain("13");
    expect(fmtShortTime(new Date(2025, 0, 2, 9, 5).getTime(), now)).toContain("2025");
    expect(fmtShortTime(undefined)).toBe("—");
  });

  test("baseline deltas", () => {
    expect(delta(1.5, 1)).toEqual({ abs: 0.5, rel: 0.5 });
    expect(delta(1, 0)?.rel).toBeUndefined();
    expect(delta(undefined, 1)).toBeUndefined();
    expect(fmtDelta(delta(0.9, 1))).toBe("-0.1 (-10.0%)");
    expect(fmtDelta(delta(2, 1))).toBe("+1 (+100.0%)");
  });

  test("previews follow the served content type and a size cap, never sniffing", () => {
    expect(previewKind("text/plain; charset=utf-8", 10)).toBe("text");
    expect(previewKind("application/json", 10)).toBe("json");
    expect(previewKind("image/png", 10)).toBe("image");
    expect(previewKind("application/octet-stream", 10)).toBe("none");
    expect(previewKind("text/html", 10)).toBe("none");
    expect(previewKind("image/svg+xml", 10)).toBe("none");
    expect(previewKind("text/plain", PREVIEW_MAX_BYTES + 1)).toBe("none");
  });

  test("code-executing model formats get a trust warning", () => {
    for (const f of ["model.pkl", "ckpt/model.pt", "w.pth", "m.joblib", "x.ckpt"])
      expect(isUnsafeModelFormat(f)).toBe(true);
    for (const f of ["model.safetensors", "metrics.json", "plot.png", "model.onnx"])
      expect(isUnsafeModelFormat(f)).toBe(false);
  });
});

describe("launch dialog", () => {
  test("sizes and durations match the CLI", () => {
    expect(parseSize("4G")).toBe(4 * 1024 ** 3);
    expect(parseSize("512M")).toBe(512 * 1024 ** 2);
    expect(parseSize("1.5GiB")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(() => parseSize("lots")).toThrow();
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("15")).toBe(15);
    expect(() => parseDuration("1y")).toThrow();
  });

  test("argv splitting without a shell", () => {
    expect(splitArgs("python train.py --lr 0.01")).toEqual(["python", "train.py", "--lr", "0.01"]);
    expect(splitArgs(`python -c "print('a b')"`)).toEqual(["python", "-c", "print('a b')"]);
    expect(splitArgs(`echo '' "x\\"y" a\\ b`)).toEqual(["echo", "", 'x"y', "a b"]);
    expect(splitArgs("  ")).toEqual([]);
    expect(() => splitArgs(`echo "oops`)).toThrow();
  });

  test("request body", () => {
    const body = launchBody({
      command: "python train.py",
      cwd: "",
      environment: "none",
      memory: "1G",
      cpu: "150%",
      timeout: "10m",
      artifacts: "outputs/*.json, ckpt/*.pt",
      metricsFile: "outputs/metrics.jsonl",
      runName: "r1",
      study: "s1",
      variant: "",
    });
    expect(body).toEqual({
      command: ["python", "train.py"],
      environment: "none",
      limits: { memory_max_bytes: 1024 ** 3, cpu_quota_percent: 150, runtime_max_sec: 600 },
      artifact_paths: ["outputs/*.json", "ckpt/*.pt"],
      metrics_file: "outputs/metrics.jsonl",
      run_name: "r1",
      study_id: "s1",
    });
  });
});

describe("tables and filters", () => {
  test("quick filters compose into an MLflow filter string", () => {
    expect(buildFilter({})).toBe("");
    expect(
      buildFilter({
        status: "FINISHED",
        study: "s1",
        variant: "it's",
        filter: " metrics.loss < 1 ",
      }),
    ).toBe(
      "attributes.status = 'FINISHED' and tags.`ablationkit.study_id` = 's1' and " +
        "tags.`ablationkit.variant_id` = 'it\\'s' and metrics.loss < 1",
    );
  });

  test("runs table columns: the studies' metrics, then held-out ones, then the rest (ADR 0055)", () => {
    const keys = [
      "epoch",
      "gradient_norm",
      "loss",
      "system/cpu_utilization_percentage",
      "tokens_per_second",
      "tokens_seen",
      "validation/bits_per_byte",
      "eval/acc",
      "bench/watts",
    ];
    expect(rankMetricKeys(keys, new Set())).toEqual([
      "eval/acc",
      "validation/bits_per_byte",
      "bench/watts",
      "epoch",
      "gradient_norm",
      "loss",
    ]);
    expect(rankMetricKeys(keys, new Set(["loss"]), 3)).toEqual([
      "loss",
      "eval/acc",
      "validation/bits_per_byte",
    ]);
  });

  test("metric direction heuristic", () => {
    expect(lowerIsBetter("train/loss")).toBe(true);
    expect(lowerIsBetter("val_rmse")).toBe(true);
    expect(lowerIsBetter("val/acc")).toBe(false);
    expect(lowerIsBetter("f1")).toBe(false);
    // Bits per byte, wall time and compute are lower-is-better; throughput is not.
    expect(lowerIsBetter("val/bits_per_byte")).toBe(true);
    expect(lowerIsBetter("val_bpb")).toBe(true);
    expect(lowerIsBetter("time/train_seconds")).toBe(true);
    expect(lowerIsBetter("time/setup_seconds")).toBe(true);
    expect(lowerIsBetter("compute/train_flops_est")).toBe(true);
    expect(lowerIsBetter("perf/tokens_per_sec")).toBe(false);
    expect(lowerIsBetter("throughput/samples")).toBe(false);
  });

  test("declared directions win over the name: study goals", () => {
    // "val/score" reads as higher-is-better by name; a study can say otherwise.
    expect(metricDirection("val/score")).toEqual({ lower: false, source: "name" });
    expect(
      metricDirection("val/score", { studyGoals: [{ key: "val/score", goal: "min" }] }),
    ).toEqual({ lower: true, source: "study" });
    // A plain baseline doesn't break the shared study; two studies are not one.
    const runs = (...c: (string | undefined)[]) =>
      c.map((x) => ({ ablationkit: x ? { study_id: x } : {} }));
    expect(sharedTag(runs(undefined, "st-1", "st-1"), "study_id")).toBe("st-1");
    expect(sharedTag(runs("st-1", "st-2"), "study_id")).toBeUndefined();
    expect(sharedTag(runs(undefined, undefined), "study_id")).toBeUndefined();
  });

  test("comparison CSV quotes values", () => {
    const csv = compareCsv({
      runs: [{ run_id: "a", run_name: "base" }, { run_id: "b" }],
      params: [{ key: "opt", values: ["adam,w", undefined] }],
      metrics: [{ key: "loss", values: [0.5, 0.25] }],
    });
    expect(csv).toBe('kind,key,base,b\nparam,opt,"adam,w",\nmetric,loss,0.5,0.25\n');
  });

  test("ablation CSV has mean, std and n per metric", () => {
    const csv = ablationCsv({
      metric_keys: ["loss"],
      differing_params: ["lr"],
      variants: [
        {
          variant_id: "base",
          runs: [1, 2],
          params: { lr: "0.1" },
          metrics: { loss: { mean: 1, std: 0.1, n: 2 } },
        },
        { variant_id: "v1", runs: [1], params: { lr: "0.2" }, metrics: {} },
      ],
    });
    expect(csv).toBe(
      "variant,n_runs,param.lr,loss.mean,loss.std,loss.n\nbase,2,0.1,1,0.1,2\nv1,1,0.2,,,\n",
    );
  });

  test("nice axis ticks", () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(0.31, 0.89, 5)).toEqual([0.4, 0.5, 0.6, 0.7, 0.8]);
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(Number.NaN, 1)).toEqual([]);
  });
});

describe("remote attempt labels", () => {
  test("an exported notebook waits on a person; an imported spool is an exited worker", () => {
    expect(computeLabel("starting", { staging: "exported" })).toBe(
      "waiting for you to run the notebook",
    );
    expect(computeLabel("starting", { staging: "submitted" })).toBe("starting");
    expect(computeLabel("succeeded")).toBe("succeeded");
    expect(workerLabel("starting", { connectivity: "pending" })).toBe("pending");
    expect(workerLabel("succeeded", { connectivity: "pending", imported_at: "t" })).toBe(
      "exited (imported)",
    );
    expect(workerLabel("running", { connectivity: "pending", imported_at: "t" })).toBe(
      "offline (partial import)",
    );
    // An exported notebook is expected back at its export time plus the job's time limit.
    expect(expectedBackBy("2026-11-09T08:00:00.000Z", 7200)).toBe("2026-11-09T10:00:00.000Z");
    expect(expectedBackBy("2026-11-09T08:00:00.000Z", undefined)).toBeUndefined();
    expect(expectedBackBy(undefined, 7200)).toBeUndefined();
  });
});

describe("product text", () => {
  test("no build-stage placeholders reach the UI (every stage has shipped)", () => {
    const root = join(import.meta.dir, "../src");
    const hits: string[] = [];
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(rel)) continue;
      readFileSync(join(root, rel), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
          if (/build stage|arrives in (build )?stage/i.test(t)) hits.push(`${rel}:${i + 1}: ${t}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("agent sessions (ADR 0040)", () => {
  const s = (o: Partial<AgentSession>): AgentSession => ({
    token_id: "0123456789abcdef",
    project_id: "lab",
    started_at: "2026-11-10T09:00:00Z",
    live: true,
    jobs: 0,
    records: 0,
    tasks: 0,
    ...o,
  });
  test("an agent is named by its session; others by their kind", () => {
    const sessions = new Map([
      ["0123456789abcdef", s({ label: "ALiBi sweep", harness: "claude-code" })],
      ["fedcba9876543210", s({ token_id: "fedcba9876543210", label: "old token" })],
    ]);
    expect(actorText({ kind: "agent", id: "0123456789abcdef" }, sessions)).toBe(
      "agent · ALiBi sweep (claude-code)",
    );
    expect(actorText({ kind: "agent", id: "fedcba9876543210" }, sessions)).toBe(
      "agent · old token",
    );
    expect(actorText({ kind: "agent", id: "unknown" }, sessions)).toBe("agent");
    expect(actorText({ kind: "human", id: "x" }, sessions)).toBe("human");
    expect(sessionName(s({}))).toBe("token 01234567");
    expect(agentSessionsPath("a b")).toBe("/api/v1/agent-sessions?project=a%20b");
  });
});
