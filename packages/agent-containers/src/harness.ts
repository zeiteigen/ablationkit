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
    // No auto-update (the binary is read-only), error reporting or telemetry to other hosts.
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
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

/** The MCP configuration file Claude Code is given (`--mcp-config`). */
export function claudeMcpConfig(): Record<string, unknown> {
  return {
    mcpServers: {
      ablationkit: { command: `${CONTAINER.run}/bin/ablationkit`, args: ["mcp", "--contained"] },
    },
  };
}

/** The harness's argv inside the container, with `ablationkit mcp` registered and `args` after. */
export function harnessArgv(harness: ContainerHarness, args: readonly string[]): string[] {
  switch (harness) {
    case "claude-code":
      return [`${CONTAINER.bin}/claude`, "--mcp-config", `${CONTAINER.run}/mcp.json`, ...args];
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
