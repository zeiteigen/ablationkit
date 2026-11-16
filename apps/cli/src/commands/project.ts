/**
 * `ablationkit project add|list|show|remap|doctor` over the human API (spec §12), and
 * `project guard` / `project unguard`, which apply or take out the agent guard (ADR 0041; opt-in
 * since ADR 0062) from the registry file directly.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJson } from "@ablationkit/core";
import { validateProjectRegistry } from "@ablationkit/protocol";
import {
  type AgentGuardFile,
  applyAgentGuard,
  codexUserNotes,
  removeAgentGuard,
  runtimePaths,
} from "@ablationkit/server";
import { CoordinatorClient } from "../client.ts";
import { type CliContext, flag, parseArgs, printJson, UsageError } from "../context.ts";

interface Project {
  project_id: string;
  name: string;
  path: string;
  previous_paths: string[];
}

interface Doctor {
  project_id: string;
  status: string;
  checks: { name: string; status: string; detail: string }[];
}

const USAGE = `usage:
  ablationkit project add PATH [--name NAME] [--id PROJECT_ID]
  ablationkit project list
  ablationkit project show PROJECT_ID
  ablationkit project remap PROJECT_ID NEW_PATH
  ablationkit project doctor --project PROJECT_ID
  ablationkit project guard PROJECT_ID | --all     opt-in: keep agents on this machine out of .ablationkit
  ablationkit project unguard PROJECT_ID | --all   take the agent guard out again
  (all take --json; all but guard and unguard take --coordinator URL)`;

/** Print what the agent guard did to a checkout, and the user-level Codex notes. */
function printGuard(
  ctx: CliContext,
  guard: readonly AgentGuardFile[],
  notes: readonly string[],
): void {
  for (const g of guard) {
    ctx.out(`  agent guard  ${g.action.padEnd(9)} ${g.file}\n`);
    if (g.note) ctx.out(`               ${g.note}\n`);
  }
  for (const n of notes) ctx.out(`               note: ${n}\n`);
}

export async function projectCommand(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest, ["json", "all"]);
  const asJson = args.flags["json"] === true;
  const coordinator = flag(args, "coordinator");
  // Paths are resolved on the coordinator; a relative path only makes sense locally.
  const pathArg = (p: string | undefined): string => {
    if (!p) throw new UsageError(USAGE);
    if (p.startsWith("/")) return p;
    if (coordinator)
      throw new UsageError("with --coordinator, give an absolute path on the coordinator machine");
    return resolve(p);
  };

  if (sub === "add") {
    const client = await CoordinatorClient.connect(ctx, coordinator);
    const body: Record<string, string> = { path: pathArg(args.positional[0]) };
    const name = flag(args, "name");
    const id = flag(args, "id");
    if (name) body["name"] = name;
    if (id) body["project_id"] = id;
    const r = await client.request<{
      project: Project;
      manifest_created: boolean;
    }>("POST", "/api/v1/projects", body);
    if (asJson) printJson(ctx, r);
    else
      ctx.out(
        `registered ${r.project.project_id} at ${r.project.path}${r.manifest_created ? " (wrote .ablationkit/project.json)\ncommit it: git add .ablationkit/project.json && git commit (remote runs and candidates use the committed tree)" : ""}\n`,
      );
    return 0;
  }
  if (sub === "list") {
    const client = await CoordinatorClient.connect(ctx, coordinator);
    const r = await client.request<{ projects: Project[] }>("GET", "/api/v1/projects");
    if (asJson) printJson(ctx, r);
    else if (r.projects.length === 0)
      ctx.out("no projects registered (ablationkit project add PATH)\n");
    else for (const p of r.projects) ctx.out(`${p.project_id}\t${p.name}\t${p.path}\n`);
    return 0;
  }
  if (sub === "show") {
    const id = args.positional[0];
    if (!id) throw new UsageError(USAGE);
    const client = await CoordinatorClient.connect(ctx, coordinator);
    const r = await client.request<{ project: Project }>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(id)}`,
    );
    if (asJson) printJson(ctx, r);
    else
      ctx.out(
        `${r.project.project_id}\n  name  ${r.project.name}\n  path  ${r.project.path}\n${r.project.previous_paths.map((p) => `  was   ${p}\n`).join("")}`,
      );
    return 0;
  }
  if (sub === "remap") {
    const [id, p] = args.positional;
    if (!id) throw new UsageError(USAGE);
    const client = await CoordinatorClient.connect(ctx, coordinator);
    const r = await client.request<{ project: Project; changed: boolean }>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(id)}/remap`,
      { path: pathArg(p) },
    );
    if (asJson) printJson(ctx, r);
    else
      ctx.out(
        r.changed
          ? `remapped ${id} to ${r.project.path}\n`
          : `${id} is already at ${r.project.path}\n`,
      );
    return 0;
  }
  if (sub === "doctor") {
    const id = flag(args, "project") ?? args.positional[0];
    if (!id) throw new UsageError(USAGE);
    const client = await CoordinatorClient.connect(ctx, coordinator);
    const r = await client.request<Doctor>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(id)}/doctor`,
    );
    if (asJson) printJson(ctx, r);
    else {
      for (const c of r.checks) ctx.out(`${c.status.padEnd(4)}  ${c.name.padEnd(9)} ${c.detail}\n`);
      ctx.out(`\n${r.project_id}: ${r.status}\n`);
    }
    return r.status === "fail" ? 1 : 0;
  }
  if (sub === "guard" || sub === "unguard")
    return guardCommand(
      args.positional[0],
      args.flags["all"] === true,
      asJson,
      ctx,
      sub === "unguard",
    );
  throw new UsageError(USAGE);
}

/**
 * Apply the agent guard to registered checkouts, or take it out (`remove`), straight from
 * `<home>/registry.json`: it needs no running coordinator, and it runs as the researcher, who
 * owns both the home and the checkouts. Exit 0 unless a named project is unknown.
 */
function guardCommand(
  id: string | undefined,
  all: boolean,
  asJson: boolean,
  ctx: CliContext,
  remove = false,
): number {
  if (!all && !id) throw new UsageError(USAGE);
  if (all && id) throw new UsageError("give a project ID or --all, not both");
  const paths = runtimePaths(ctx.home);
  const projects = existsSync(paths.registry)
    ? readJson(paths.registry, validateProjectRegistry).projects
    : [];
  const chosen = all ? projects : projects.filter((p) => p.project_id === id);
  if (id && chosen.length === 0) {
    ctx.err(`no registered project ${id} in ${paths.registry}\n`);
    return 1;
  }
  type Result = {
    project_id: string;
    path: string;
    agent_guard?: AgentGuardFile[];
    codex_notes?: string[];
    missing?: true;
  };
  const results = chosen.map((p): Result => {
    const present = existsSync(p.path);
    return {
      project_id: p.project_id,
      path: p.path,
      ...(present
        ? remove
          ? { agent_guard: removeAgentGuard(p.path, ctx.home) }
          : {
              agent_guard: applyAgentGuard(p.path, ctx.home),
              codex_notes: codexUserNotes(p.path, ctx.env),
            }
        : { missing: true as const }),
    };
  });
  if (asJson) {
    printJson(ctx, { home: ctx.home, projects: results });
    return 0;
  }
  if (results.length === 0) ctx.out(`no projects registered in ${paths.registry}\n`);
  for (const r of results) {
    ctx.out(`${r.project_id}  ${r.path}\n`);
    if (r.missing) ctx.out("  checkout missing; remap the project, then run this again\n");
    else printGuard(ctx, r.agent_guard ?? [], r.codex_notes ?? []);
  }
  return 0;
}
