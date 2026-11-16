#!/usr/bin/env bun
/**
 * AblationKit CLI (spec §12): the researcher's and the operator's commands, over the same API as the
 * UI. Agents use AblationKit only through `ablationkit mcp` (ADR 0040).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exitAfterFlush } from "@ablationkit/core";
import { ApiError, CoordinatorUnavailable } from "./client.ts";
import { accessCommand } from "./commands/access.ts";
import { agentCommand } from "./commands/agent.ts";
import { coordinatorCommand } from "./commands/coordinator.ts";
import { devBuild } from "./commands/dev-build.ts";
import { devDoctor } from "./commands/dev-doctor.ts";
import { executiveCommand } from "./commands/executive.ts";
import { extensionCommand } from "./commands/extension.ts";
import { loginCommand } from "./commands/login.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { projectCommand } from "./commands/project.ts";
import { remoteCommand, targetCommand } from "./commands/remote.ts";
import { systemCommand } from "./commands/system.ts";
import { backupCommand, trackingCommand } from "./commands/tracking.ts";
import { uiCommand } from "./commands/ui.ts";
import { vaultCommand } from "./commands/vault.ts";
import { type CliContext, processContext, UsageError } from "./context.ts";

const ROOT = resolve(import.meta.dir, "../../..");

const USAGE = `usage: ablationkit <command>

The researcher's and the operator's commands. Research itself happens in the web UI
(\`ablationkit ui\`), and agents use AblationKit through \`ablationkit mcp\`.

commands:
  ui [--no-open]                     start if needed and open a one-time login link
  login [--origin URL]               print a one-time login link
  login --coordinator URL --code C   log a remote CLI in with a code from the workstation
  version                            the version, commit and where this CLI runs from
  coordinator start [--foreground] [--safe-mode]
                                     start the coordinator and its managed MLflow sidecar
                                     (--safe-mode: this boot with every extension inactive)
  coordinator stop | restart | status
  coordinator move --out FILE        stopped coordinator: back up, pack, retire this home
  system status [--json]             startup diagnostics, safe mode, restore, artifact store
  access tailscale | status | off    serve the UI over HTTPS on the tailnet name (remote clients)
  project add PATH                   register a project checkout
  project list | show ID             list or show registered projects
  project remap ID PATH              point a project at its moved checkout
  project doctor --project ID        check a project's checkout, manifest and state
  project guard ID | --all           opt-in: keep agents in a checkout out of .ablationkit (ADR 0041)
  project unguard ID | --all         take the agent guard out of a checkout (ADR 0062)
  vault show | check [--project ID]  where a project stands (its ledger and shelf); what its notes lack
  vault works | cite [--format F]    the library of prior work its notes cite, and its citations
                                     (BibTeX, CSL-JSON, Markdown; the role each work played) (ADR 0052)
  vault import DIR | export --out DIR
                                     a project's vault of atomic notes as Markdown files (ADR 0049)
  target list | show | add | doctor | remove
                                     remote compute targets (SSH, SLURM, Runpod, Colab)
  remote status|drain|reauthorize|resolve|import|notebook JOB
                                     remote attempts: sync, leftover spools, ambiguous outcomes, Colab cells
  tracking doctor | status           check MLflow, storage and the tracking outbox
  tracking outbox [--failed]         list queued or rejected MLflow writes
  tracking retry OP_ID               requeue a rejected write
  tracking import --project ID --experiment EXP
                                     link a historical MLflow experiment read-only
  backup create | list | verify ID   coordinated coordinator + MLflow snapshot
  backup export ID --out FILE        pack a backup for another machine
  backup restore SOURCE [--project ID=PATH]... [--worker-url URL] [--force]
                                     restore into ABLATIONKIT_HOME (coordinator stopped)
  extension templates | scaffold --template T --id ID [--path DIR]
                                     start an extension from one of the bundled templates (offline)
  extension validate --path DIR | doctor
                                     check extensions on disk (offline)
  extension publish EXT              publish an approved build to your user registry
  dev doctor [--json]                check the development environment
  dev build [--check CMD…]           checks + a reviewable modified build (activate in the web UI)
  mcp [--project ID] [--label T]     agents: the MCP server their harness launches, one per session
                                     (claude mcp add ablationkit -- ablationkit mcp)
  executive [--label T]              your agent on this machine as executive: the MCP server that reads
                                     the research and runs the agents, but does no research (ADR 0064)
                                     (claude mcp add ablationkit-executive -- ablationkit executive)
  agent start [--harness H] [-- ARGS] run your harness in an agent container (ADR 0061): rootless
                                     Podman, no GPU, egress allowlist, jobs in job containers
  agent attach | list | show | pause | resume | stop | screen | send | egress SESSION
  agent allow HOST… | config [show|edit|set FILE] | image build | doctor

Most commands take --json. Remote use: --coordinator URL (or ABLATIONKIT_COORDINATOR).
`;

/** `ablationkit 1.0.0 (commit abc1234, installed at ROOT)`; a checkout says so instead. */
export function versionLine(root: string): string {
  const v = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string })
    .version;
  const info = join(root, "BUILD-INFO.json");
  if (!existsSync(info)) return `ablationkit ${v ?? "unknown"} (source checkout at ${root})`;
  const b = JSON.parse(readFileSync(info, "utf8")) as { commit?: string; dirty?: boolean };
  const commit = `${(b.commit ?? "unknown").slice(0, 12)}${b.dirty ? ", modified" : ""}`;
  return `ablationkit ${v ?? "unknown"} (commit ${commit}, installed at ${root})`;
}

export async function main(
  argv: readonly string[],
  ctx: CliContext = processContext(ROOT),
): Promise<number> {
  const [group, command, ...rest] = argv;
  try {
    if (group === "dev" && command === "doctor") return devDoctor(rest, ctx.repoRoot);
    if (group === "dev" && command === "build") return await devBuild(rest, ctx);
    if (group === "coordinator") return await coordinatorCommand(argv.slice(1), ctx);
    if (group === "project") return await projectCommand(argv.slice(1), ctx);
    if (group === "target") return await targetCommand(argv.slice(1), ctx);
    if (group === "remote") return await remoteCommand(argv.slice(1), ctx);
    if (group === "mcp") return await mcpCommand(argv.slice(1), ctx);
    if (group === "agent") return await agentCommand(argv.slice(1), ctx);
    if (group === "executive") return await executiveCommand(argv.slice(1), ctx);
    if (group === "tracking") return await trackingCommand(argv.slice(1), ctx);
    if (group === "extension") return await extensionCommand(argv.slice(1), ctx);
    if (group === "backup") return await backupCommand(argv.slice(1), ctx);
    if (group === "system") return await systemCommand(argv.slice(1), ctx);
    if (group === "access") return await accessCommand(argv.slice(1), ctx);
    if (group === "login") return await loginCommand(argv.slice(1), ctx);
    if (group === "ui") return await uiCommand(argv.slice(1), ctx);
    if (group === "vault") return await vaultCommand(argv.slice(1), ctx);
    if (group === "version" || group === "--version") {
      ctx.out(`${versionLine(ctx.repoRoot)}\n`);
      return 0;
    }
    if (group === undefined || group === "help" || group === "--help" || group === "-h") {
      ctx.out(USAGE);
      return 0;
    }
    ctx.err(`unknown command: ${argv.join(" ")}\n\n${USAGE}`);
    return 2;
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.err(`${e.message}\n`);
      return 2;
    }
    if (e instanceof CoordinatorUnavailable) {
      ctx.err(`${e.message}\n`);
      return 3;
    }
    if (e instanceof ApiError) {
      ctx.err(`error: ${e.message} (${e.code}, HTTP ${e.status})\n`);
      return 1;
    }
    throw e;
  }
}

// Never a bare `process.exit`: it drops whatever of a large write a pipe has not taken yet (F37).
if (import.meta.main) await exitAfterFlush(await main(process.argv.slice(2)));
