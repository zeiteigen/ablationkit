/**
 * `ablationkit executive` (ADR 0064) against a real coordinator: the executive session it mints
 * through the login socket, its four tools (the overview, every agent read in any project, the
 * agents, directions written on the researcher's behalf and marked so), and the coordinator
 * refusing the same token every write that is not an executive's (a job, a note, a policy
 * revision), audited.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runtimePaths } from "@ablationkit/server";
import { EXECUTIVE_TOOLS, ExecutiveSession, handleExecutive } from "../src/commands/executive.ts";
import { cli, Harness } from "./helpers.ts";

// Under $HOME, not /tmp (Stage 8 trap: sandboxes treat /tmp specially).
const BASE = join(homedir(), ".cache", "ablationkit-tests");
mkdirSync(BASE, { recursive: true });
const h = new Harness(BASE);
afterEach(h.cleanup);
const tmp = () => h.tmp("ak-cli-exec-");
const ENV = {
  GIT_AUTHOR_NAME: "r",
  GIT_AUTHOR_EMAIL: "r@r",
  GIT_COMMITTER_NAME: "r",
  GIT_COMMITTER_EMAIL: "r@r",
};
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, ...ENV } }).trim();

async function setup() {
  const home = tmp();
  const c = await h.start(home, {}, { jobs: { supervisor: "direct" } });
  const repo = join(tmp(), "lab");
  git(tmp(), "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "train.py"), "print(1)\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  expect((await cli(home, ["project", "add", repo])).code).toBe(0);
  const x = new ExecutiveSession({
    home,
    cwd: repo,
    label: "test executive",
    harness: "claude-code",
  });
  let id = 0;
  // biome-ignore lint/suspicious/noExplicitAny: tool results are JSON
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const r = (await handleExecutive(
      { id: ++id, method: "tools/call", params: { name, arguments: args } },
      x,
    )) as {
      result: { structuredContent?: unknown; isError?: boolean; content: { text: string }[] };
    };
    return {
      out: r.result.structuredContent,
      text: r.result.content[0]?.text ?? "",
      isError: r.result.isError === true,
    };
  };
  return { home, c, repo, x, call };
}

test("an executive session reads every project, runs no research, and its directions are marked", async () => {
  const { home, c, x, call } = await setup();
  const init = (await handleExecutive({ id: 0, method: "initialize", params: {} }, x)) as {
    result: { serverInfo: { name: string }; instructions: string };
  };
  expect(init.result.serverInfo.name).toBe("ablationkit-executive");
  expect(init.result.instructions).toContain("You cannot submit jobs");
  expect(init.result.instructions).toContain('run its tests and checks as jobs with gpu "none"');
  const list = (await handleExecutive({ id: 1, method: "tools/list" }, x)) as {
    result: { tools: { name: string }[] };
  };
  expect(list.result.tools.map((t) => t.name)).toEqual(EXECUTIVE_TOOLS.map((t) => t.name));

  // The overview and the agents' reads, over the human API with the executive's token.
  const o = await call("executive_overview");
  expect(o.isError).toBe(false);
  expect(o.out.projects.map((p: { project_id: string }) => p.project_id)).toEqual(["lab"]);
  const v = await call("executive_read", { op: "vault.show" });
  expect(v.isError).toBe(false);
  const help = await call("executive_read", { op: "help" });
  expect(help.out.reads.join("\n")).toContain("note.show");
  expect(help.out.reads.join("\n")).not.toContain("job.submit");
  const runs = await call("executive_read", { op: "run.search", project: "lab" });
  expect(runs.isError).toBe(false);
  const notARead = await call("executive_read", { op: "job.submit" });
  expect(notARead.isError).toBe(true);
  expect(notARead.text).toContain("does not write the research");
  const agents = await call("executive_agents", { action: "list" });
  expect(agents.isError).toBe(false);

  // A direction on the researcher's behalf, marked as the executive's.
  const d = await call("executive_direct", {
    action: "write",
    kind: "focus",
    text: "Finish the baseline before any ablation.",
  });
  expect(d.isError).toBe(false);
  expect(d.out.direction.via_executive).toBe("test executive");

  // The coordinator refuses the same token any write that is not an executive's.
  const s = await x.start();
  const post = (path: string, body: unknown, method = "POST") =>
    fetch(`${s.human_api}${path}`, {
      method,
      headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  for (const [path, body] of [
    ["/api/v1/projects/lab/jobs", { command: ["python", "train.py"], environment: "none" }],
    ["/api/v1/projects/lab/vault/notes", { note_id: "x", type: "concept", title: "x", gist: "x" }],
    ["/api/v1/projects/lab/policy/revisions", { policy: {} }],
  ] as const) {
    const r = await post(path, body);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "executive_forbidden",
    );
  }
  const audit = readdirSync(runtimePaths(home).auditDir)
    .map((f) => readFileSync(join(runtimePaths(home).auditDir, f), "utf8"))
    .join("");
  expect(audit).toContain("auth.executive_session.start");
  expect(audit).toContain("not an executive's write");

  // Listed for the researcher; it ends with the server.
  const sessions = c.services.tokens.list().filter((t) => t.executive_session);
  expect(sessions).toHaveLength(1);
  await x.end();
  expect(c.services.tokens.get(s.token_id)?.revoked_at).toBeString();
  expect(
    (
      await fetch(`${s.human_api}/api/v1/projects`, {
        headers: { authorization: `Bearer ${s.token}` },
      })
    ).status,
  ).toBe(401);
});
