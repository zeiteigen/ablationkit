/**
 * Shared harness for the research-task tests (ADR 0039): a coordinator with one registered Git
 * project, the researcher's session, and helpers to act as an agent with a project token.
 */
import { expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResearchTask } from "@ablationkit/protocol";
import type { Client, Harness } from "./helpers.ts";

export type Json = Record<string, unknown>;

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "r",
      GIT_AUTHOR_EMAIL: "r@r",
      GIT_COMMITTER_NAME: "r",
      GIT_COMMITTER_EMAIL: "r@r",
    },
  }).trim();
}

export interface World {
  cl: Client;
  home: string;
  main: string;
  project: string;
  session: string;
  human<T = Json>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ status: number; body: T }>;
  agentAs<T = Json>(
    token: string,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ status: number; body: T }>;
  /** A project agent token (ADR 0039), minted through the researcher's session. */
  agentToken(project?: string): Promise<string>;
  /** Register another project (a second Git checkout). */
  addProject(name: string): Promise<string>;
  restart(): Promise<void>;
}

export async function world(h: Harness, opts: { home?: string } = {}): Promise<World> {
  const root = h.tmp("ak-task-");
  const checkout = (name: string) => {
    const dir = join(root, name);
    git(root, "init", "-q", "-b", "main", dir);
    writeFileSync(join(dir, "train.py"), "print('hi')\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    return dir;
  };
  const main = checkout("lab");
  const home = opts.home ?? h.tmp("ak-home-");
  const start = () => h.start({ home });
  let cl = await start();
  let session = await cl.session();
  const register = async (dir: string, name: string) => {
    const reg = await cl.json<{ project: { project_id: string } }>(
      cl.human("/api/v1/projects", { token: session, body: { path: dir, name } }),
    );
    expect(reg.status).toBe(201);
    return reg.body.project.project_id;
  };
  const project = await register(main, "lab");
  const w: World = {
    get cl() {
      return cl;
    },
    home,
    main,
    project,
    get session() {
      return session;
    },
    human: (path, init = {}) => cl.json(cl.human(path, { token: session, ...init })),
    agentAs: (token, path, init = {}) => cl.json(cl.agent(path, { token, ...init })),
    agentToken: async (pid = project) => {
      return (await cl.agentSession(pid)).token;
    },
    addProject: (name) => register(checkout(name), name),
    restart: async () => {
      await cl.c.stop();
      cl = await start();
      session = await cl.session();
    },
  };
  return w;
}

export const P = (w: World, rest = "", project = w.project) =>
  `/api/v1/projects/${project}/tasks${rest}`;

/** An agent creates a task. */
export async function createTask(w: World, token: string, body: Json = {}): Promise<ResearchTask> {
  const r = await w.agentAs<{ task: ResearchTask }>(token, P(w), {
    body: {
      goal: "Measure the effect of removing rotary embeddings on validation loss.",
      criteria: ["val_loss compared over 3 seeds"],
      ...body,
    },
  });
  expect(r.status).toBe(201);
  return r.body.task;
}
