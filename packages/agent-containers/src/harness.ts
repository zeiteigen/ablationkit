/**
 * The harnesses an agent container runs (ADR 0061): the researcher's own Claude Code or Codex,
 * from the binary installed on this machine (mounted read-only), registered with `ablationkit mcp`
 * inside the container, plus a plain shell. Pure.
 */
import type { ContainerHarness } from "@ablationkit/protocol";
import { CONTAINER } from "./paths.ts";

export interface HarnessSpec {
  readonly id: ContainerHarness;
  /** The binary looked up on this machine and mounted at `CONTAINER.bin/<binary>`; none for the shell. */
  readonly binary?: string;
  /** Hosts its own traffic needs (the model API, sign-in), allowed whatever the project allows. */
  readonly hosts: readonly string[];
  /** Environment set in the container for it. */
  readonly env: Readonly<Record<string, string>>;
  /** Where it looks for Agent Skills, under the container's home. */
  readonly skillsDir?: string;
}

export const HARNESSES: Readonly<Record<ContainerHarness, HarnessSpec>> = {
  "claude-code": {
    id: "claude-code",
    binary: "claude",
    hosts: [
      "api.anthropic.com",
      "*.anthropic.com",
      "claude.ai",
      "*.claude.ai",
      "claude.com",
      "*.claude.com",
    ],
    // No auto-update (the binary is read-only), error reporting, bug reports or feedback, and no
    // other nonessential traffic unless Remote Control needs it (`harnessEnv`); no auto memory,
    // Artifacts or cron (ADR 0067): off in the process, whatever settings say.
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_BUG_COMMAND: "1",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_ARTIFACT: "1",
      CLAUDE_CODE_DISABLE_CRON: "1",
    },
    skillsDir: ".claude/skills",
  },
  codex: {
    id: "codex",
    binary: "codex",
    hosts: ["api.openai.com", "*.openai.com", "chatgpt.com", "*.chatgpt.com"],
    env: {},
    skillsDir: ".codex/skills",
  },
  shell: { id: "shell", hosts: [], env: {} },
};

/**
 * Claude Code's own management tools, barred in an agent container (ADR 0067): they schedule work,
 * reach other Claude sessions or publish to claude.ai, outside the session's record. Auto memory,
 * the other one, is not a tool: it is turned off (`autoMemoryEnabled`,
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY`).
 */
export const CLAUDE_BARRED_TOOLS: readonly string[] = [
  // Scheduling: wake-ups and cron jobs (a contained agent waits for its jobs with
  // `ablationkit_wait`, ADR 0060) and cloud routines, which run outside the container.
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  // Other Claude sessions of the account: messages around the record (the researcher's words
  // reach an agent as directions, ADR 0057, or typed into its terminal).
  "ListAgents",
  "SendMessage",
  "SendToProject",
  "SendToProjectContext",
  "FetchInboxMessage",
  "ReadNotifications",
  // Artifacts and design systems on claude.ai: results belong in the vault, as notes and figures
  // (ADRs 0049, 0053).
  "Artifact",
  "ArtifactComments",
  "ArtifactData",
  "DesignSync",
];

/** Where Claude Code reads its managed settings on Linux: above every other settings file. */
export const CLAUDE_MANAGED_SETTINGS = "/etc/claude-code/managed-settings.json";

/** The managed settings file's name in the session's run directory, mounted over the above. */
export const CLAUDE_MANAGED_SETTINGS_FILE = "claude-managed-settings.json";

/**
 * Claude Code's managed settings in an agent container (ADR 0067), mounted read-only: the agent
 * cannot edit them, and its user, project and local settings cannot loosen them. Bypassing
 * permissions is consented to here, so the default mode starts without the dialog; the mode
 * itself stays a default on the command line.
 */
export function claudeManagedSettings(): Record<string, unknown> {
  return {
    skipDangerousModePermissionPrompt: true,
    autoMemoryEnabled: false,
    autoDreamEnabled: false,
    enableArtifact: false,
    permissions: { deny: [...CLAUDE_BARRED_TOOLS] },
  };
}

/** What a harness starts with unless the researcher's arguments say otherwise. */
export interface HarnessDefaults {
  /** Claude Code: start Remote Control under this session name. */
  readonly remoteControl?: string;
}

/**
 * The name a contained Claude Code's Remote Control session is shown under in claude.ai and the
 * Claude app: the project and the session's label, on one line.
 */
export function remoteControlName(projectId: string, label: string): string {
  const name = `${projectId} · ${label.replace(/\s+/g, " ").trim()}`;
  return name.length > 120 ? `${name.slice(0, 119)}…` : name;
}

/**
 * The environment the harness runs with. Claude Code's Remote Control needs its feature flags,
 * which `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turns off (as `DISABLE_TELEMETRY` would): with
 * Remote Control on, the narrower switches stand in for it, and Claude Code's usage reporting to
 * Anthropic's hosts goes through the egress proxy with the rest of its traffic.
 */
export function harnessEnv(
  harness: ContainerHarness,
  defaults: HarnessDefaults = {},
): Record<string, string> {
  const { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _, ...rest } = HARNESSES[harness].env;
  return harness === "claude-code" && defaults.remoteControl ? rest : { ...HARNESSES[harness].env };
}

/** Does the researcher's argv give this option (`--opt` or `--opt=…`)? */
function gives(args: readonly string[], ...options: string[]): boolean {
  return args.some((a) => options.some((o) => a === o || a.startsWith(`${o}=`)));
}

/** The MCP configuration file Claude Code is given (`--mcp-config`). */
export function claudeMcpConfig(): Record<string, unknown> {
  return {
    mcpServers: {
      ablationkit: { command: `${CONTAINER.run}/bin/ablationkit`, args: ["mcp", "--contained"] },
    },
  };
}

/** The harness's argv inside the container, with `ablationkit mcp` registered and `args` after. */
export function harnessArgv(
  harness: ContainerHarness,
  args: readonly string[],
  defaults: HarnessDefaults = {},
): string[] {
  switch (harness) {
    case "claude-code":
      // `--mcp-config` takes several values: after the researcher's arguments (a first prompt
      // among them), or it swallows them. Strict: AblationKit's server and no other (no project
      // `.mcp.json`, no account connectors, which would bypass the egress proxy).
      return [
        `${CONTAINER.bin}/claude`,
        // The container is the boundary (ADR 0067): no permission prompts, unless the
        // researcher's arguments choose a mode.
        ...(gives(args, "--permission-mode", "--dangerously-skip-permissions")
          ? []
          : ["--permission-mode", "bypassPermissions"]),
        // Its name always follows `--remote-control`, which otherwise takes a first prompt for one.
        ...(defaults.remoteControl && !gives(args, "--remote-control", "--rc")
          ? ["--remote-control", defaults.remoteControl]
          : []),
        ...args,
        "--mcp-config",
        `${CONTAINER.run}/mcp.json`,
        "--strict-mcp-config",
      ];
    case "codex":
      return [
        `${CONTAINER.bin}/codex`,
        "-c",
        `mcp_servers.ablationkit.command=${JSON.stringify(`${CONTAINER.run}/bin/ablationkit`)}`,
        "-c",
        'mcp_servers.ablationkit.args=["mcp","--contained"]',
        ...args,
      ];
    case "shell":
      return [
        "/bin/sh",
        "-c",
        'if command -v bash >/dev/null; then exec bash -l "$@"; else exec sh -l "$@"; fi',
        "sh",
        ...args,
      ];
  }
}
