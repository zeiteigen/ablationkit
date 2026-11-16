/** Criterion 56: API separation between the human, agent and worker listeners. */
import { afterEach, describe, expect, test } from "bun:test";
import { AGENT_ROUTES, HUMAN_ROUTES, WORKER_ROUTES } from "../src/index.ts";
import { Harness } from "./helpers.ts";

const h = new Harness();
afterEach(() => h.cleanup());

const FORBIDDEN_ON_AGENT = [
  /polic/i,
  /extensions?\/[^/]+\/activate/i,
  /activate/i,
  /auth\/tokens/i,
  /budget/i,
  /permission/i,
];

describe("route tables", () => {
  test("the agent table has no policy-edit, extension-activation or auth-admin routes", () => {
    for (const r of AGENT_ROUTES) {
      for (const re of FORBIDDEN_ON_AGENT) expect(`${r.method} ${r.path}`).not.toMatch(re);
    }
    // And it is small and explicit: any growth must be a deliberate edit of this list.
    expect(AGENT_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v1/health",
      "GET /api/v1/whoami",
      // The session's own account (ADR 0056).
      "GET /api/v1/projects/:id/session/account",
      "GET /api/v1/projects/:id",
      // Stage 7: research records bound to the token's project (no delete, no export control).
      "GET /api/v1/projects/:id/research",
      "POST /api/v1/projects/:id/research",
      "POST /api/v1/projects/:id/research/reports/generate",
      "GET /api/v1/projects/:id/research/:rid",
      "PATCH /api/v1/projects/:id/research/:rid",
      "POST /api/v1/projects/:id/research/:rid/archive",
      "POST /api/v1/projects/:id/research/:rid/regenerate",
      "GET /api/v1/projects/:id/review",
      "GET /api/v1/projects/:id/lineage",
      // The vault (ADR 0049): agents read it and write notes and the index. Deleting a note and
      // marking notes read are the researcher's and are not here.
      "GET /api/v1/projects/:id/vault",
      "PUT /api/v1/projects/:id/vault/index",
      "GET /api/v1/projects/:id/vault/runs",
      "GET /api/v1/projects/:id/vault/check",
      "GET /api/v1/projects/:id/vault/notes",
      "POST /api/v1/projects/:id/vault/notes",
      "GET /api/v1/projects/:id/vault/notes/:nid",
      "PUT /api/v1/projects/:id/vault/notes/:nid",
      "PATCH /api/v1/projects/:id/vault/notes/:nid",
      "POST /api/v1/projects/:id/vault/notes/:nid/archive",
      // The library (ADR 0052): agents read and write works and export citations; deleting a
      // work is the researcher's.
      "GET /api/v1/projects/:id/vault/works",
      "POST /api/v1/projects/:id/vault/works",
      "GET /api/v1/projects/:id/vault/works/:wid",
      "PUT /api/v1/projects/:id/vault/works/:wid",
      "PATCH /api/v1/projects/:id/vault/works/:wid",
      "POST /api/v1/projects/:id/vault/works/:wid/archive",
      "GET /api/v1/projects/:id/vault/citations",
      // The agenda (ADR 0058): agents read it; writing it is the researcher's alone.
      "GET /api/v1/projects/:id/agenda",
      // Stage 12: model lifecycle reads only (writes and launches are human-only).
      "GET /api/v1/projects/:id/datasets",
      "GET /api/v1/projects/:id/models",
      "GET /api/v1/projects/:id/models/:mid",
      "GET /api/v1/projects/:id/models/:mid/artifacts",
      "GET /api/v1/projects/:id/registry",
      "GET /api/v1/projects/:id/registry/:name",
      "GET /api/v1/projects/:id/registry/:name/resolve",
      "GET /api/v1/projects/:id/evaluations",
      "GET /api/v1/projects/:id/evaluations/:eid",
      "GET /api/v1/projects/:id/evaluations/:eid/examples",
      "GET /api/v1/projects/:id/evaluations/:eid/log",
      "GET /api/v1/projects/:id/mlproject",
      // Inference (ADR 0020): reads only; running models and sessions is human-only.
      "GET /api/v1/projects/:id/inference/describe",
      "GET /api/v1/projects/:id/inference/sessions",
      "GET /api/v1/projects/:id/inference/sessions/:sid",
      "GET /api/v1/projects/:id/inference/evidence",
      "GET /api/v1/projects/:id/inference/evidence/:eid",
      // Stage 14 (ADR 0021): LLM reads, prompt-version and golden-set proposals (never held-out
      // sets), trace links and evaluation reports; running models and data controls are human-only.
      "GET /api/v1/projects/:id/llm/settings",
      "GET /api/v1/projects/:id/llm/traces",
      "GET /api/v1/projects/:id/llm/traces/:tid",
      "POST /api/v1/projects/:id/llm/traces/:tid/link",
      "GET /api/v1/projects/:id/llm/prompts",
      "GET /api/v1/projects/:id/llm/prompts/resolve",
      "POST /api/v1/projects/:id/llm/prompts",
      "GET /api/v1/projects/:id/llm/prompts/:name",
      "GET /api/v1/projects/:id/llm/prompts/:name/diff",
      "GET /api/v1/projects/:id/llm/golden-sets",
      "POST /api/v1/projects/:id/llm/golden-sets",
      "GET /api/v1/projects/:id/llm/golden-sets/:gs",
      "GET /api/v1/projects/:id/llm/golden-sets/:gs/examples",
      "POST /api/v1/projects/:id/llm/golden-sets/:gs/versions",
      "GET /api/v1/projects/:id/llm/evidence",
      "GET /api/v1/projects/:id/llm/evidence/:lx",
      "GET /api/v1/projects/:id/llm/evaluations",
      "GET /api/v1/projects/:id/llm/evaluations/compare",
      "GET /api/v1/projects/:id/llm/evaluations/:le",
      "GET /api/v1/projects/:id/llm/evaluations/:le/examples",
      "GET /api/v1/projects/:id/llm/evaluations/:le/log",
      "POST /api/v1/projects/:id/llm/evaluations/:le/report",
      "GET /api/v1/projects/:id/extension-backends",
      "POST /api/v1/projects/:id/extensions/:ext/operations/:operation",
      "GET /api/v1/projects/:id/extension-catalog",
      "GET /api/v1/projects/:id/extension-registry",
      "GET /api/v1/projects/:id/extensions",
      "POST /api/v1/projects/:id/extensions/install",
      "GET /api/v1/projects/:id/extensions/:ext",
      "POST /api/v1/projects/:id/extensions/:ext/validate",
      "POST /api/v1/projects/:id/extensions/:ext/build",
      "GET /api/v1/projects/:id/extensions/:ext/builds/:eb/diff",
      "GET /api/v1/projects/:id/extensions/:ext/builds/:eb/file",
      "POST /api/v1/projects/:id/extensions/:ext/actions/:cid",
      "POST /api/v1/projects/:id/extensions/:ext/run",
      "GET /api/v1/projects/:id/extension-snapshots",
      "GET /api/v1/projects/:id/extension-executions",
      "GET /api/v1/projects/:id/extension-executions/:xid",
      "GET /api/v1/projects/:id/extension-executions/:xid/log",
      "POST /api/v1/projects/:id/extension-executions/:xid/cancel",
      "GET /api/v1/projects/:id/runs",
      "GET /api/v1/projects/:id/runs/:run",
      "GET /api/v1/projects/:id/runs/:run/metrics",
      "GET /api/v1/projects/:id/runs/:run/artifacts",
      "GET /api/v1/projects/:id/runs/:run/artifacts/text",
      "PUT /api/v1/projects/:id/runs/:run/description",
      // Research tasks (ADR 0039): agents create, read, complete and abandon them.
      "GET /api/v1/projects/:id/tasks",
      "POST /api/v1/projects/:id/tasks",
      "GET /api/v1/projects/:id/tasks/:tid",
      "POST /api/v1/projects/:id/tasks/:tid/complete",
      "POST /api/v1/projects/:id/tasks/:tid/abandon",
      // The researcher's directions (ADR 0057): agents read them, take the ones not yet shown to
      // their session and respond. Writing one is refused (403), not absent: the route says why.
      "GET /api/v1/projects/:id/directions",
      "POST /api/v1/projects/:id/directions",
      "POST /api/v1/projects/:id/directions/deliver",
      "POST /api/v1/projects/:id/directions/:did/respond",
      // Deployments: list and request (the project policy decides); the policy: a summary only.
      "GET /api/v1/projects/:id/deployments",
      "POST /api/v1/projects/:id/deployments",
      "GET /api/v1/projects/:id/access",
      // The agent compute limit (ADR 0037): the project's usage, and the weights, to plan with.
      "GET /api/v1/projects/:id/compute",
      // Historical runs (ADR 0043): import a pre-AblationKit run from checkout files; list them.
      "POST /api/v1/projects/:id/run-imports",
      "GET /api/v1/projects/:id/run-imports",
      // Jobs (ADR 0037): submit within the policy, read the project's, cancel its own.
      "POST /api/v1/projects/:id/jobs",
      "GET /api/v1/projects/:id/jobs",
      "GET /api/v1/jobs",
      "GET /api/v1/jobs/:id",
      "POST /api/v1/jobs/:id/cancel",
      "GET /api/v1/jobs/:id/attempts/:attemptId/console",
      "GET /api/v1/compute/weights",
    ]);
  });

  test("the worker table only uploads for a job attempt", () => {
    expect(WORKER_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v1/health",
      "GET /api/v1/whoami",
      "POST /api/v1/jobs/:id/attempts/:attemptId/events:batch",
      "PUT /api/v1/jobs/:id/attempts/:attemptId/artifacts",
    ]);
  });

  test("privileged human actions are on the human table only (criterion 57: the session authorizes them, ADR 0037)", () => {
    const human = new Set(HUMAN_ROUTES.map((r) => r.handler.action));
    const agent = new Set(AGENT_ROUTES.map((r) => r.handler.action));
    for (const a of [
      "policy.revise",
      "extension.approve",
      "extension.enable",
      "extension.rollback",
      "extension.backend.enable",
      "build.activate",
      "backup.restore",
      "project.remove",
      "llm.settings.widen",
    ]) {
      expect(human.has(a)).toBe(true);
      expect(agent.has(a)).toBe(false);
    }
  });
});

describe("agent listener", () => {
  test("privileged human routes do not exist there, even with a valid agent token", async () => {
    const cl = await h.start();
    const session = await cl.session();
    const repo = h.repo();
    const { body } = await cl.json<{ project: { project_id: string } }>(
      cl.human("/api/v1/projects", { token: session, body: { path: repo } }),
    );
    const pid = body.project.project_id;
    const agentToken = (await cl.agentSession(pid)).token;

    const ok = await cl.json<{ scope: Record<string, string> }>(
      cl.agent("/api/v1/whoami", { token: agentToken }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.scope).toEqual({ project_id: pid });

    for (const r of HUMAN_ROUTES) {
      if (AGENT_ROUTES.some((a) => a.method === r.method && a.path === r.path)) continue;
      const path = r.path.replaceAll(":id", pid);
      const res = await cl.agent(path, {
        token: agentToken,
        method: r.method,
        ...(r.method === "GET" ? {} : { body: {} }),
      });
      expect({ route: `${r.method} ${r.path}`, status: res.status }).toEqual({
        route: `${r.method} ${r.path}`,
        status: 404,
      });
    }
  });

  test("agent tokens are scoped to their project; other tokens are rejected", async () => {
    const cl = await h.start();
    const session = await cl.session();
    const a = (
      await cl.json<{ project: { project_id: string } }>(
        cl.human("/api/v1/projects", { token: session, body: { path: h.repo("a") } }),
      )
    ).body.project.project_id;
    const b = (
      await cl.json<{ project: { project_id: string } }>(
        cl.human("/api/v1/projects", { token: session, body: { path: h.repo("b") } }),
      )
    ).body.project.project_id;
    const tok = (await cl.agentSession(a)).token;
    expect((await cl.agent(`/api/v1/projects/${a}`, { token: tok })).status).toBe(200);
    expect((await cl.agent(`/api/v1/projects/${b}`, { token: tok })).status).toBe(403);
    // A human session token or no token gets nothing on the agent listener.
    expect((await cl.agent(`/api/v1/projects/${a}`, { token: session })).status).toBe(401);
    expect((await cl.agent(`/api/v1/projects/${a}`)).status).toBe(401);
    // And an agent token gets nothing on the human listener.
    expect((await cl.human("/api/v1/projects", { token: tok })).status).toBe(401);
    // Revocation takes effect immediately.
    const id = (await cl.json<{ token_id: string }>(cl.agent("/api/v1/whoami", { token: tok })))
      .body.token_id;
    expect(
      (await cl.human(`/api/v1/agent-sessions/${id}/end`, { token: session, body: {} })).status,
    ).toBe(200);
    expect((await cl.agent("/api/v1/whoami", { token: tok })).status).toBe(401);
  });

  test("the agent listener refuses non-loopback Host headers", async () => {
    const cl = await h.start();
    expect((await cl.agent("/api/v1/health", { host: "evil.example" })).status).toBe(421);
  });
});

describe("worker listener", () => {
  test("a worker token can only upload for its own job attempt", async () => {
    const cl = await h.start();
    const session = await cl.session();
    const pid = (
      await cl.json<{ project: { project_id: string } }>(
        cl.human("/api/v1/projects", { token: session, body: { path: h.repo() } }),
      )
    ).body.project.project_id;
    const w = cl.c.services.tokens.mint("worker", {
      scope: { project_id: pid, job_id: "job-1", attempt_id: "att-1" },
    });
    expect(w.record.expires_at).toBeUndefined();
    const tok = w.token;
    const up = (job: string, att: string, token = tok) =>
      cl.worker(`/api/v1/jobs/${job}/attempts/${att}/events:batch`, {
        token,
        body: { events: [] },
      });

    // Authorized for its own attempt: reaches ingest, which knows no such attempt.
    const own = await cl.json<{ error: { code: string } }>(up("job-1", "att-1"));
    expect(own.status).toBe(404);
    expect(own.body.error.code).toBe("attempt_not_found");
    expect((await up("job-1", "att-2")).status).toBe(403);
    expect((await up("job-2", "att-1")).status).toBe(403);
    // Agent and session tokens are not worker tokens.
    expect((await up("job-1", "att-1", session)).status).toBe(401);
    // Worker tokens do nothing on the other listeners.
    expect((await cl.human("/api/v1/projects", { token: tok })).status).toBe(401);
    expect((await cl.agent("/api/v1/whoami", { token: tok })).status).toBe(401);
    // No other routes exist on the worker listener.
    expect((await cl.worker("/api/v1/projects", { token: tok })).status).toBe(404);
    expect(
      (await cl.worker(`/api/v1/projects/${pid}/policy/revisions`, { token: tok, body: {} }))
        .status,
    ).toBe(404);

    // Denials are audited.
    const audit = await cl.json<{
      records: { action: string; outcome: string; listener: string }[];
    }>(cl.human("/api/v1/audit?limit=1000", { token: session }));
    expect(
      audit.body.records.some(
        (r) =>
          r.listener === "worker" && r.action === "job.events.upload" && r.outcome === "denied",
      ),
    ).toBe(true);
  });

  test("worker tokens must name a job and attempt", async () => {
    const cl = await h.start();
    const tokens = cl.c.services.tokens;
    expect(() => tokens.mint("worker", { scope: { project_id: "p", job_id: "j" } })).toThrow(
      "job_id and attempt_id",
    );
    expect(() => tokens.mint("session", { scope: { project_id: "p" } })).toThrow("no scope");
  });
});

describe("agent sessions (ADR 0040)", () => {
  const start = async () => {
    let t = Date.parse("2026-11-10T09:00:00Z");
    const cl = await h.start({ now: () => new Date(t) });
    const session = await cl.session();
    const pid = (
      await cl.json<{ project: { project_id: string } }>(
        cl.human("/api/v1/projects", { token: session, body: { path: h.repo("lab") } }),
      )
    ).body.project.project_id;
    return { cl, session, pid, advance: (ms: number) => (t += ms) };
  };

  test("the login socket mints only agent tokens for a registered project", async () => {
    const { cl, session, pid } = await start();
    const r = await cl.json<{
      token: string;
      token_id: string;
      project_id: string;
      agent_api: string;
      idle_timeout_sec: number;
    }>(
      cl.socket("/agent-sessions", {
        project_id: pid,
        harness: "claude-code",
        label: "ALiBi sweep",
        cwd: "/work/lab",
        kind: "session",
      }),
    );
    expect(r.status).toBe(201);
    expect(r.body.token.startsWith("aka_")).toBe(true);
    expect(r.body).toMatchObject({ project_id: pid, agent_api: cl.c.urls.agent });
    expect(r.body.idle_timeout_sec).toBe(12 * 3600);
    // It is an agent token: the human listener refuses it.
    expect((await cl.human("/api/v1/projects", { token: r.body.token })).status).toBe(401);
    const who = await cl.json<{ session: { harness: string; label: string } }>(
      cl.agent("/api/v1/whoami", { token: r.body.token }),
    );
    expect(who.body.session).toMatchObject({ harness: "claude-code", label: "ALiBi sweep" });
    // An unknown project, a bad harness or a relative cwd are refused.
    for (const body of [
      { project_id: "nope", harness: "codex", cwd: "/w" },
      { project_id: pid, harness: "Bad Harness", cwd: "/w" },
      { project_id: pid, harness: "codex", cwd: "w" },
    ])
      expect((await cl.socket("/agent-sessions", body)).status).not.toBe(201);
    // The session is listed with what it recorded, and the minting is audited.
    await cl.agent(`/api/v1/projects/${pid}/research`, {
      token: r.body.token,
      body: { kind: "note", title: "from the session" },
    });
    const list = await cl.json<{
      sessions: { token_id: string; harness: string; live: boolean; records: number }[];
    }>(cl.human(`/api/v1/agent-sessions?project=${pid}`, { token: session }));
    expect(list.body.sessions).toEqual([
      expect.objectContaining({
        token_id: r.body.token_id,
        harness: "claude-code",
        cwd: "/work/lab",
        live: true,
        records: 1,
        jobs: 0,
      }),
    ]);
    const audit = await cl.json<{ records: { action: string; target?: string }[] }>(
      cl.human("/api/v1/audit?limit=1000", { token: session }),
    );
    expect(
      audit.body.records.some(
        (a) => a.action === "auth.agent_session.start" && a.target === r.body.token_id,
      ),
    ).toBe(true);
  });

  test("a session ends with its own token, after 12 idle hours, or by the researcher", async () => {
    const { cl, session, pid, advance } = await start();
    // Ended by its own token (the MCP server shutting down).
    const a = await cl.agentSession(pid, "a");
    const end = await fetch("http://localhost/agent-sessions/end", {
      unix: cl.c.loginSocket,
      method: "POST",
      headers: { authorization: `Bearer ${a.token}` },
    } as RequestInit);
    expect(end.status).toBe(200);
    expect((await cl.agent("/api/v1/whoami", { token: a.token })).status).toBe(401);
    // A request keeps a session alive; 12 hours without one ends it.
    const b = await cl.agentSession(pid, "b");
    advance(11 * 3600_000);
    expect((await cl.agent("/api/v1/whoami", { token: b.token })).status).toBe(200);
    advance(11 * 3600_000);
    expect((await cl.agent("/api/v1/whoami", { token: b.token })).status).toBe(200);
    advance(12 * 3600_000 + 1000);
    expect((await cl.agent("/api/v1/whoami", { token: b.token })).status).toBe(401);
    cl.c.services.agentSessions.sweep();
    // Ended by the researcher.
    const c = await cl.agentSession(pid, "c");
    const ended = await cl.human(`/api/v1/agent-sessions/${c.token_id}/end`, {
      token: session,
      body: { reason: "done" },
    });
    expect(ended.status).toBe(200);
    expect((await cl.agent("/api/v1/whoami", { token: c.token })).status).toBe(401);
    const list = await cl.json<{
      sessions: { token_id: string; live: boolean; end_reason?: string }[];
    }>(cl.human("/api/v1/agent-sessions", { token: session }));
    const reason = (id: string) => list.body.sessions.find((s) => s.token_id === id)?.end_reason;
    expect([reason(a.token_id), reason(b.token_id), reason(c.token_id)]).toEqual([
      "ended",
      "idle",
      "done",
    ]);
    const audit = await cl.json<{ records: { action: string; reason?: string }[] }>(
      cl.human("/api/v1/audit?limit=1000", { token: session }),
    );
    const actions = audit.body.records.map((r) => `${r.action}:${r.reason ?? ""}`);
    expect(actions).toContain("auth.agent_session.end:ended");
    expect(actions).toContain("auth.agent_session.expire:idle");
    expect(actions).toContain("auth.agent_session.end:done");
    // An agent token cannot reach the sessions routes; a human session cannot end a worker token.
    expect((await cl.agent("/api/v1/agent-sessions", { token: c.token })).status).toBe(404);
    const w = cl.c.services.tokens.mint("worker", {
      scope: { project_id: pid, job_id: "j", attempt_id: "a" },
    });
    expect(
      (
        await cl.human(`/api/v1/agent-sessions/${w.record.token_id}/end`, {
          token: session,
          body: {},
        })
      ).status,
    ).toBe(404);
  });
});
