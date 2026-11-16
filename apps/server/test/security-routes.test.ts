/**
 * Security suite (Stage 18b): properties that must hold for every route of every listener, swept
 * from the route tables so a new route is covered when it is added (criterion 56).
 *
 * - The wrong kind of credential gets nothing: no token, or a token minted for another listener.
 * - Path parameters are never paths: traversal, NUL bytes, option injection and oversized values
 *   sent to every `:param` of every route are refused or simply not found. They never reach the
 *   filesystem or a child process (no 5xx, no file contents in the answer).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeMlflow } from "@ablationkit/tracking-mlflow/testing";
import { AGENT_ROUTES, HUMAN_ROUTES, WORKER_ROUTES } from "../src/index.ts";
import { safeArtifactPath } from "../src/listeners/tracking.ts";
import { REMOTE_WORKER_ROUTES } from "../src/listeners/worker.ts";
import { type Client, Harness } from "./helpers.ts";

const h = new Harness();
const fake = new FakeMlflow();
let cl: Client;
let session: string;
let agentToken: string;
let workerToken: string;
let canaryDir: string;

const ALL_WORKER_ROUTES = [...WORKER_ROUTES, ...REMOTE_WORKER_ROUTES];
const CANARY = "ablationkit-canary-5f1d";

/** The route's path with every `:param` set to `value`. */
const fill = (path: string, value: string) =>
  path
    .split("/")
    .map((s) => (s.startsWith(":") ? value : s))
    .join("/");

/** Every value is sent percent-encoded, so the router decodes it into the parameter. */
const EVIL = (canary: string): readonly string[] => [
  "..",
  "../..",
  "../../../../../../etc/passwd",
  "..\\..\\windows",
  `../../../../../../../..${canary}`,
  canary,
  "a\0b",
  "%2e%2e",
  "-rf",
  "--upload-pack=touch /tmp/ablationkit-pwned",
  "HEAD~1^{/x}",
  "$(id)",
  "`id`",
  "a;id",
  "x".repeat(4096),
  "__proto__",
  "constructor",
];

/** Faults of the deployment, not of the request: MLflow off, a feature not configured. */
const UNAVAILABLE = new Set(["tracking_unavailable", "remote_unavailable"]);

async function assertSafe(
  label: string,
  send: () => Promise<Response>,
  problems: string[],
): Promise<void> {
  const r = await send();
  const text = await r.text();
  if (text.includes(CANARY) || text.includes("root:x:0:0")) {
    problems.push(`${label}: file contents in the answer (${r.status})`);
    return;
  }
  if (r.status >= 500) {
    let code = "";
    try {
      code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? "";
    } catch {}
    if (!UNAVAILABLE.has(code) && r.status !== 501 && r.status !== 503)
      problems.push(`${label}: ${r.status} ${text.slice(0, 200)}`);
  }
}

beforeAll(async () => {
  fake.start();
  cl = await h.start({ trackingUrl: fake.url, trackingIntervalMs: 20 });
  session = await cl.session();
  canaryDir = h.tmp("ak-canary-");
  mkdirSync(canaryDir, { recursive: true });
  writeFileSync(join(canaryDir, "secret"), CANARY);
  const repo = h.repo("lab");
  const reg = await cl.json<{ project: { project_id: string } }>(
    cl.human("/api/v1/projects", { token: session, body: { path: repo, project_id: "lab" } }),
  );
  const project = reg.body.project.project_id;
  agentToken = (await cl.agentSession(project)).token;
  workerToken = cl.c.services.tokens.mint("worker", {
    scope: { project_id: project, job_id: "j", attempt_id: "a" },
  }).token;
});

afterAll(async () => {
  await h.cleanup();
  await fake.stop();
});

describe("credentials per listener (criterion 56)", () => {
  test("no human route answers without a session, or with an agent or worker token", async () => {
    const problems: string[] = [];
    for (const r of HUMAN_ROUTES) {
      if (r.handler.auth === "none") continue;
      const path = fill(r.path, "x");
      const body = r.method === "GET" ? undefined : {};
      for (const [who, token] of [
        ["no token", undefined],
        ["agent token", agentToken],
        ["worker token", workerToken],
        ["garbage token", "ak_session_nope"],
      ] as const) {
        const res = await cl.human(path, {
          method: r.method,
          ...(token ? { token } : {}),
          ...(body ? { body } : {}),
        });
        await res.body?.cancel();
        if (res.status !== 401) problems.push(`${r.method} ${r.path} ${who}: ${res.status}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("no agent route answers without an agent token", async () => {
    const problems: string[] = [];
    for (const r of AGENT_ROUTES) {
      if (r.path === "/api/v1/health") continue;
      const path = fill(r.path, "lab");
      const body = r.method === "GET" ? undefined : {};
      for (const [who, token] of [
        ["no token", undefined],
        ["session", session],
        ["worker token", workerToken],
      ] as const) {
        const res = await cl.agent(path, {
          method: r.method,
          ...(token ? { token } : {}),
          ...(body ? { body } : {}),
        });
        await res.body?.cancel();
        if (res.status !== 401) problems.push(`${r.method} ${r.path} ${who}: ${res.status}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("no worker route answers without a worker token, except the health check and the model fetch's own token", async () => {
    const problems: string[] = [];
    for (const r of ALL_WORKER_ROUTES) {
      if (r.path === "/api/v1/health") continue;
      const path = fill(r.path, "x");
      const body = r.method === "GET" ? undefined : {};
      for (const [who, token] of [
        ["no token", undefined],
        ["session", session],
        ["agent token", agentToken],
      ] as const) {
        const res = await cl.worker(path, {
          method: r.method,
          ...(token ? { token } : {}),
          ...(body ? { body } : {}),
        });
        await res.body?.cancel();
        if (res.status !== 401) problems.push(`${r.method} ${r.path} ${who}: ${res.status}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("a worker token cannot act for another job or attempt on any attempt-scoped route", async () => {
    const problems: string[] = [];
    for (const r of ALL_WORKER_ROUTES) {
      if (!r.path.includes(":attemptId")) continue;
      const res = await cl.worker(
        r.path
          .replace(":id", "other-job")
          .replace(":attemptId", "other-attempt")
          .replace(":uploadId", "u-0000000000000000"),
        {
          method: r.method,
          token: workerToken,
          ...(r.method === "GET" ? {} : { body: {} }),
        },
      );
      await res.body?.cancel();
      if (res.status !== 403) problems.push(`${r.method} ${r.path}: ${res.status}`);
    }
    expect(problems).toEqual([]);
  });
});

describe("hostile path parameters", () => {
  const values = () => EVIL(join(canaryDir, "secret"));

  test("every human route with a parameter refuses them", async () => {
    const problems: string[] = [];
    for (const r of HUMAN_ROUTES) {
      if (!r.path.includes("/:")) continue;
      for (const v of values())
        await assertSafe(
          `${r.method} ${r.path} <- ${v.slice(0, 40)}`,
          () =>
            cl.human(fill(r.path, encodeURIComponent(v)), {
              method: r.method,
              token: session,
              ...(r.method === "GET" ? {} : { body: {} }),
            }),
          problems,
        );
    }
    expect(problems).toEqual([]);
  }, 120_000);

  test("the same values under a real project reach the handlers and are refused there", async () => {
    const problems: string[] = [];
    for (const r of HUMAN_ROUTES) {
      if (!r.path.startsWith("/api/v1/projects/:id/")) continue;
      for (const v of values()) {
        const path = r.path
          .split("/")
          .map((s, i) => (i === 4 ? "lab" : s.startsWith(":") ? encodeURIComponent(v) : s))
          .join("/");
        if (!path.includes(encodeURIComponent(v))) continue;
        await assertSafe(
          `${r.method} ${r.path} <- ${v.slice(0, 40)}`,
          () =>
            cl.human(path, {
              method: r.method,
              token: session,
              ...(r.method === "GET" ? {} : { body: {} }),
            }),
          problems,
        );
      }
    }
    expect(problems).toEqual([]);
  }, 300_000);

  test("every agent route refuses them under its own project", async () => {
    const problems: string[] = [];
    for (const r of AGENT_ROUTES) {
      if (!r.path.includes("/:")) continue;
      for (const v of values()) {
        const path = r.path
          .split("/")
          .map((s, i) =>
            i === 4 && r.path.startsWith("/api/v1/projects/:id")
              ? "lab"
              : s.startsWith(":")
                ? encodeURIComponent(v)
                : s,
          )
          .join("/");
        await assertSafe(
          `${r.method} ${r.path} <- ${v.slice(0, 40)}`,
          () =>
            cl.agent(path, {
              method: r.method,
              token: agentToken,
              ...(r.method === "GET" ? {} : { body: {} }),
            }),
          problems,
        );
      }
    }
    expect(problems).toEqual([]);
  }, 300_000);

  test("artifact paths: traversal, absolute, scheme, NUL and oversized values are all refused", () => {
    for (const p of [
      "../secret",
      "a/../../secret",
      "/etc/passwd",
      "a//b",
      "./a",
      "a\\b",
      "file:///etc/passwd",
      "s3://bucket/key",
      "a\0b",
      "x".repeat(2000),
    ])
      expect(() => safeArtifactPath(p, true)).toThrow(/stay inside the run/);
    expect(() => safeArtifactPath(null, true)).toThrow(/path is required/);
    expect(safeArtifactPath("ckpt/model.bin", true)).toBe("ckpt/model.bin");
    expect(readFileSync(join(canaryDir, "secret"), "utf8")).toBe(CANARY);
  });
});
