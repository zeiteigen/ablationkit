/**
 * A throwaway stack for the web smoke tests and manual UI checks: a fake MLflow, a real
 * coordinator (direct supervisor mode), one registered project with a seeded study (three
 * variants × two seeds with metric curves), and helpers to log a browser in.
 *
 * `bun apps/web/e2e/stack.ts` starts it and prints a one-time login link (Ctrl-C to stop).
 * With `ABLATIONKIT_E2E_REAL_MLFLOW=1` the coordinator starts the pinned MLflow sidecar instead of
 * the fake (uv-synced into the temp home; slower, but checks the UI against the real server).
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CoordinatorSettings } from "@ablationkit/protocol";
import { Coordinator } from "@ablationkit/server";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";

const FIXTURE = resolve(import.meta.dir, "../../../fixtures/projects/uninstrumented-script");
/** With the fake MLflow, evaluations run through the fake bridge (real mode uses the sidecar's). */
const FAKE_BRIDGE = resolve(import.meta.dir, "../../server/test/fake-bridge.ts");

export interface Stack {
  readonly coordinator: Coordinator;
  readonly mlflow: FakeMlflow;
  readonly origin: string;
  readonly projectId: string;
  readonly repo: string;
  /** A bearer session for API calls from the test. */
  readonly token: string;
  /** A fresh one-time login URL for a browser. */
  loginUrl(): Promise<string>;
  api<T = Record<string, unknown>>(path: string, body?: unknown, method?: string): Promise<T>;
  /** An agent session token, minted through the login socket as `ablationkit mcp` does. */
  agentSession(label: string): Promise<{ token: string; token_id: string }>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port ?? 0;
  await s.stop(true);
  return p;
}

async function socket(
  c: Coordinator,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const r = await fetch(`http://localhost${path}`, {
    unix: c.loginSocket,
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  } as RequestInit);
  if (!r.ok) throw new Error(`login socket ${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as Record<string, unknown>;
}

export async function startStack(opts: { seed?: boolean } = {}): Promise<Stack> {
  const dirs: string[] = [];
  const tmp = (p: string) => {
    const d = mkdtempSync(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  const real = process.env["ABLATIONKIT_E2E_REAL_MLFLOW"] === "1";
  const mlflow = new FakeMlflow();
  if (!real) mlflow.start();
  const settings: CoordinatorSettings = {
    schema_version: 1,
    human: { host: "127.0.0.1", port: 0 },
    agent: { host: "127.0.0.1", port: 0 },
    worker: { host: "127.0.0.1", port: 0 },
    mlflow: real ? { enabled: true, port: await freePort() } : { enabled: false },
    jobs: { supervisor: "direct", deliver_deadline_sec: 30 },
  };
  const bridgeConfig = join(tmp("ak-web-bridge-"), "config.json");
  writeFileSync(bridgeConfig, "{}");
  const coordinator = await Coordinator.start({
    home: tmp("ak-web-home-"),
    settings,
    ...(real
      ? {}
      : { trackingUrl: mlflow.url, bridgeCommand: [process.execPath, FAKE_BRIDGE, bridgeConfig] }),
    trackingIntervalMs: 50,
    log: () => {},
  });
  if (real) {
    for (let i = 0; coordinator.services.sidecarStatus().state !== "healthy"; i++) {
      if (i > 1200)
        throw new Error(`MLflow sidecar: ${JSON.stringify(coordinator.services.sidecarStatus())}`);
      await Bun.sleep(100);
    }
  }
  const origin = (coordinator.services.trustedOrigins[0] as { origin: string }).origin;

  const login = async () => (await socket(coordinator, "/login", { origin }))["code"] as string;
  const sess = await fetch(`${origin}/api/v1/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: await login() }),
  });
  const token = ((await sess.json()) as { token: string }).token;

  const api = async <T>(path: string, body?: unknown, method?: string): Promise<T> => {
    const r = await fetch(`${origin}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method ?? "GET"} ${path}: ${r.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  };

  // A Git-looking checkout with a plain training script (no AblationKit imports).
  const repo = join(tmp("ak-web-repo-"), "demo-model");
  mkdirSync(repo, { recursive: true });
  copyFileSync(join(FIXTURE, "train.py"), join(repo, "train.py"));
  // A real one-commit repository: remote runs pin its commit.
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "stack",
    GIT_AUTHOR_EMAIL: "s@s",
    GIT_COMMITTER_NAME: "stack",
    GIT_COMMITTER_EMAIL: "s@s",
  };
  for (const a of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["commit", "-qm", "init"],
  ])
    Bun.spawnSync(["git", ...a], { cwd: repo, env: gitEnv });
  const reg = await api<{ project: { project_id: string } }>("/api/v1/projects", {
    path: repo,
    name: "Demo model",
  });
  const projectId = reg.project.project_id;

  // Wait for the project experiment.
  for (let i = 0; i < 400; i++) {
    const t = await api<{ links: { experiment_id?: string } }>(
      `/api/v1/projects/${projectId}/tracking`,
    );
    if (t.links.experiment_id) break;
    await Bun.sleep(50);
  }

  if (opts.seed !== false) await seedStudy(api, projectId);

  return {
    coordinator,
    mlflow,
    origin,
    projectId,
    repo,
    token,
    loginUrl: async () => `${origin}/login?code=${await login()}`,
    api,
    agentSession: async (label) =>
      (await socket(coordinator, "/agent-sessions", {
        project_id: projectId,
        harness: "claude-code",
        label,
        cwd: repo,
      })) as { token: string; token_id: string },
    stop: async () => {
      for (const j of coordinator.services.jobs.list())
        for (const id of j.attempts) {
          const a = coordinator.services.jobs.attempt(id);
          for (const pid of [a?.collector.pid, a?.pid ? -a.pid : undefined]) {
            try {
              if (pid) process.kill(pid, "SIGKILL");
            } catch {
              // gone
            }
          }
        }
      await coordinator.stop();
      await mlflow.stop();
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    },
  };
}

/** Study "lr-sweep": baseline and two variants, two seeds each, 300-step loss curves. */
export async function seedStudy(
  api: <T>(path: string, body?: unknown, method?: string) => Promise<T>,
  projectId: string,
): Promise<string[]> {
  const variants: [string, number][] = [
    ["baseline", 0.01],
    ["lr-high", 0.05],
    ["lr-low", 0.002],
  ];
  const refs: string[] = [];
  const t0 = Date.now() - 3_600_000;
  for (const [variant, lr] of variants)
    for (const seed of [0, 1]) {
      const r = await api<{ ref: string }>("/api/v1/tracking/runs", {
        project_id: projectId,
        run_name: `${variant}-s${seed}`,
        study_id: "lr-sweep",
        variant_id: variant,
        params: { lr: String(lr), seed: String(seed), optimizer: "adamw" },
        tags: { note: "seeded" },
      });
      const metrics = [];
      for (let step = 0; step < 300; step++) {
        const noise = Math.sin(step * 0.7 + seed * 3) * 0.02;
        const loss =
          2.5 * Math.exp(-step * lr * 0.6) + 0.3 + noise + (variant === "lr-high" ? 0.05 : 0);
        metrics.push({ key: "train/loss", value: loss, step, timestamp: t0 + step * 1000 });
        if (step % 10 === 0)
          metrics.push({ key: "val/acc", value: 1 - loss / 3, step, timestamp: t0 + step * 1000 });
        metrics.push({
          key: "system/cpu_utilization_percentage",
          value: 40 + (step % 7),
          step,
          timestamp: t0 + step * 1000,
        });
      }
      for (let i = 0; i < metrics.length; i += 900)
        await api(`/api/v1/tracking/runs/${r.ref}/log`, { metrics: metrics.slice(i, i + 900) });
      await api(`/api/v1/tracking/runs/${r.ref}/end`, { status: "FINISHED" });
      refs.push(r.ref);
    }
  return refs;
}

/**
 * A tiny vault (ADR 0049) over the seeded study: a concept, a finding with evidence on two seeded
 * runs, a claim that embeds the finding and cites a work of the library (ADR 0052), a notebook
 * that embeds the claim and the concept, the shelf and the bottom line. Returns the note IDs.
 */
export async function seedVault(
  api: <T>(path: string, body?: unknown, method?: string) => Promise<T>,
  projectId: string,
): Promise<{ concept: string; finding: string; claim: string; notebook: string }> {
  const ids = {
    concept: "learning-rate",
    finding: "high-lr-ends-higher",
    claim: "lr-001-is-best",
    notebook: "the-lr-sweep",
  };
  const notes: Record<string, unknown>[] = [
    {
      id: ids.concept,
      type: "concept",
      title: "Learning rate (LR)",
      gist: "The step size an optimizer takes along the gradient at each update.",
      summary:
        "Too small and training crawls; too large and the loss oscillates or settles higher. It is the first thing a sweep varies.",
    },
    {
      id: ids.finding,
      type: "finding",
      title: "A higher learning rate ends with a higher loss",
      gist: "At 0.05 the final training loss is above the 0.01 baseline on both seeds.",
      summary: "The gap is the same sign on each seed; two seeds is thin, but it does not flip.",
      full: "Both runs used AdamW with the same schedule; only the LR differs.",
      evidence: [
        { run: "baseline-s0", role: "baseline", metric: "train/loss" },
        { run: "lr-high-s0", role: "for", metric: "train/loss", note: "lr 0.05" },
      ],
      sources: ["study:lr-sweep"],
    },
    {
      id: ids.claim,
      type: "claim",
      title: "A learning rate of 0.01 is the best of the three",
      gist: "Of 0.002, 0.01 and 0.05, the middle learning rate gives the lowest final loss.",
      standing: "leaning",
      key: { text: "0.01", label: "best learning rate of three" },
      support: "6 runs · two seeds each · one model size",
      would_change: "A third seed at 0.05 below the baseline.",
      summary: "The higher rate overshoots and the lower one has not converged by step 300.",
      full: `![[${ids.finding}]]`,
      cites: [{ work: "smith-2018-disciplined", role: "method", where: "§4.1" }],
    },
    {
      id: ids.notebook,
      type: "notebook",
      title: "What the learning-rate sweep showed",
      gist: "Three learning rates, two seeds each: the middle one wins, narrowly.",
      summary: "The sweep asked which learning rate to keep. It answers, with two seeds.",
      full: `## The answer\n\nThe claim first, then the term it rests on.\n\n![[${ids.claim}]]\n\n![[${ids.concept}]]`,
    },
  ];
  await api(`/api/v1/projects/${projectId}/vault/works`, {
    id: "smith-2018-disciplined",
    kind: "preprint",
    title: "A disciplined approach to neural network hyper-parameters",
    authors: ["Smith, Leslie N."],
    year: 2018,
    arxiv: "1803.09820",
    reading: "skimmed",
    takeaway: "Its learning-rate range test chose the three values the sweep tries.",
    found_for: "which learning rates to sweep",
  });
  for (const n of notes) await api(`/api/v1/projects/${projectId}/vault/notes`, n);
  await api(
    `/api/v1/projects/${projectId}/vault/index`,
    {
      shelf: [ids.notebook],
      bottom_line: "The sweep points to a learning rate of 0.01, on two seeds per variant.",
      order: [ids.claim],
    },
    "PUT",
  );
  return ids;
}

if (import.meta.main) {
  const s = await startStack();
  console.log(`coordinator ${s.origin}  project ${s.projectId}`);
  console.log(`login: ${await s.loginUrl()}`);
  console.log("(new links: press Enter; Ctrl-C to stop)");
  for await (const _ of console) console.log(`login: ${await s.loginUrl()}`);
}
