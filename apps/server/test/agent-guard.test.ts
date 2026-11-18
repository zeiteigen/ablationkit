/** The agent guard (ADR 0041): merge rules for Claude Code and Codex settings, Git hygiene. */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGit } from "@ablationkit/core";
import {
  AGENT_GUARD_PROFILE,
  type AgentGuardFile,
  applyAgentGuard,
  codexUserNotes,
  removeAgentGuard,
} from "../src/agents/guard.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ak-guard-"));
  dirs.push(d);
  return d;
}

/** A writing Git command for setting up a checkout (`readGit` only reads). */
function setupGit(cwd: string, args: string[]): number | null {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode;
}

/** A user home with the default coordinator home in it, and a checkout. */
function world(opts: { git?: boolean } = {}): { user: string; home: string; checkout: string } {
  const user = tmp();
  const home = join(user, ".ablationkit");
  mkdirSync(home);
  const checkout = join(user, "lab");
  mkdirSync(join(checkout, ".ablationkit"), { recursive: true });
  if (opts.git) {
    expect(setupGit(checkout, ["init", "-q"])).toBe(0);
    // The researcher's global ignore file must not decide these tests.
    expect(setupGit(checkout, ["config", "core.excludesFile", "/dev/null"])).toBe(0);
  }
  return { user, home, checkout };
}

interface CodexCfg {
  default_permissions?: string;
  model?: string;
  mcp_servers?: unknown;
  permissions: Record<
    string,
    { description?: string; extends?: string; filesystem: Record<string, unknown> }
  >;
}
const toml = (text: string) => Bun.TOML.parse(text) as unknown as CodexCfg;
const profileFs = (c: string) =>
  toml(readFileSync(codexFile(c), "utf8")).permissions[AGENT_GUARD_PROFILE]?.filesystem ?? {};

const claudeFile = (c: string) => join(c, ".claude", "settings.local.json");
/** The coordinator-owned parts of .ablationkit/ (ADR 0044); extensions/ is not among them. */
const OWNED = [
  "./.ablationkit/project.json",
  "./.ablationkit/research",
  "./.ablationkit/conversations",
  "./.ablationkit/llm",
];
const codexFile = (c: string) => join(c, ".codex", "config.toml");
const byHarness = (r: AgentGuardFile[], h: AgentGuardFile["harness"]) =>
  r.find((x) => x.harness === h) as AgentGuardFile;

describe("Claude Code settings", () => {
  test("a fresh checkout gets the deny rules and sandbox entries; a second run is unchanged", () => {
    const w = world();
    const r = applyAgentGuard(w.checkout, w.home, { userHome: w.user });
    const claude = byHarness(r, "claude-code");
    expect(claude.action).toBe("created");
    expect(claude.sandbox_enabled).toBe(false);
    expect(claude.note).toContain("sandbox is off");
    const text = readFileSync(claudeFile(w.checkout), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "permissions": {\n    "deny": [');
    expect(JSON.parse(text)).toEqual({
      permissions: {
        deny: [
          "Read(~/.ablationkit/**)",
          "Edit(~/.ablationkit/**)",
          "Read(/.ablationkit/project.json)",
          "Edit(/.ablationkit/project.json)",
          "Read(/.ablationkit/research/**)",
          "Edit(/.ablationkit/research/**)",
          "Read(/.ablationkit/conversations/**)",
          "Edit(/.ablationkit/conversations/**)",
          "Read(/.ablationkit/llm/**)",
          "Edit(/.ablationkit/llm/**)",
          "Edit(/.claude/settings.local.json)",
          "Edit(/.claude/settings.json)",
          "Edit(/.codex/config.toml)",
        ],
      },
      sandbox: {
        filesystem: {
          denyRead: ["~/.ablationkit", ...OWNED],
          denyWrite: [
            "~/.ablationkit",
            ...OWNED,
            "./.claude/settings.local.json",
            "./.claude/settings.json",
            "./.codex/config.toml",
          ],
        },
      },
    });
    const again = applyAgentGuard(w.checkout, w.home, { userHome: w.user });
    expect(again.map((x) => x.action)).toEqual(["unchanged", "unchanged"]);
    expect(readFileSync(claudeFile(w.checkout), "utf8")).toBe(text);
  });

  test("existing settings keep their keys, order and rules; sandbox.enabled is reported, never set", () => {
    const w = world();
    mkdirSync(join(w.checkout, ".claude"));
    writeFileSync(
      claudeFile(w.checkout),
      JSON.stringify({
        model: "opus",
        permissions: { allow: ["Bash(ls:*)"], deny: ["Read(./.env)", "Read(~/.ablationkit/**)"] },
        sandbox: { enabled: true, filesystem: { denyRead: ["~/.ssh"] } },
        hooks: {},
      }),
    );
    const claude = byHarness(
      applyAgentGuard(w.checkout, w.home, { userHome: w.user }),
      "claude-code",
    );
    expect(claude.action).toBe("updated");
    expect(claude.sandbox_enabled).toBe(true);
    expect(claude.note).toBeUndefined();
    const doc = JSON.parse(readFileSync(claudeFile(w.checkout), "utf8"));
    expect(Object.keys(doc)).toEqual(["model", "permissions", "sandbox", "hooks"]);
    expect(doc.permissions.allow).toEqual(["Bash(ls:*)"]);
    expect(doc.permissions.deny.slice(0, 3)).toEqual([
      "Read(./.env)",
      "Read(~/.ablationkit/**)",
      "Edit(~/.ablationkit/**)",
    ]);
    expect(
      doc.permissions.deny.filter((d: string) => d === "Read(~/.ablationkit/**)"),
    ).toHaveLength(1);
    expect(doc.sandbox.enabled).toBe(true);
    expect(doc.sandbox.filesystem.denyRead).toEqual(["~/.ssh", "~/.ablationkit", ...OWNED]);
  });

  test("a checkout guarded before ADR 0044 loses the all-of-.ablationkit rules and keeps the rest", () => {
    const w = world();
    mkdirSync(join(w.checkout, ".claude"));
    writeFileSync(
      claudeFile(w.checkout),
      JSON.stringify({
        permissions: {
          deny: ["Read(./.env)", "Read(/.ablationkit/**)", "Edit(/.ablationkit/**)"],
        },
        sandbox: {
          filesystem: { denyRead: ["~/.ssh", "./.ablationkit"], denyWrite: ["./.ablationkit"] },
        },
      }),
    );
    expect(
      byHarness(applyAgentGuard(w.checkout, w.home, { userHome: w.user }), "claude-code").action,
    ).toBe("updated");
    const doc = JSON.parse(readFileSync(claudeFile(w.checkout), "utf8"));
    expect(doc.permissions.deny).not.toContain("Read(/.ablationkit/**)");
    expect(doc.permissions.deny).not.toContain("Edit(/.ablationkit/**)");
    expect(doc.permissions.deny).toContain("Read(./.env)");
    expect(doc.permissions.deny).toContain("Edit(/.ablationkit/research/**)");
    expect(doc.permissions.deny.some((d: string) => d.includes("extensions"))).toBe(false);
    expect(doc.sandbox.filesystem.denyRead).toEqual(["~/.ssh", "~/.ablationkit", ...OWNED]);
    expect(doc.sandbox.filesystem.denyWrite).not.toContain("./.ablationkit");
  });

  test("the shared settings.json's sandbox.enabled counts when the local file does not set it", () => {
    const w = world();
    mkdirSync(join(w.checkout, ".claude"));
    writeFileSync(join(w.checkout, ".claude", "settings.json"), '{"sandbox":{"enabled":true}}');
    const claude = byHarness(
      applyAgentGuard(w.checkout, w.home, { userHome: w.user }),
      "claude-code",
    );
    expect(claude.sandbox_enabled).toBe(true);
  });

  test("invalid JSON, or a deny that is not a list, is skipped and left as it was", () => {
    const w = world();
    mkdirSync(join(w.checkout, ".claude"));
    writeFileSync(claudeFile(w.checkout), "{ not json");
    const bad = byHarness(applyAgentGuard(w.checkout, w.home, { userHome: w.user }), "claude-code");
    expect(bad.action).toBe("skipped");
    expect(bad.note).toContain("not valid JSON");
    expect(readFileSync(claudeFile(w.checkout), "utf8")).toBe("{ not json");

    writeFileSync(claudeFile(w.checkout), '{"permissions":{"deny":"Read(x)"}}');
    const odd = byHarness(applyAgentGuard(w.checkout, w.home, { userHome: w.user }), "claude-code");
    expect(odd.action).toBe("skipped");
    expect(odd.note).toContain("permissions.deny is not a list");
  });

  test("a symlinked .claude is not written through", () => {
    const w = world();
    const elsewhere = tmp();
    symlinkSync(elsewhere, join(w.checkout, ".claude"));
    const claude = byHarness(
      applyAgentGuard(w.checkout, w.home, { userHome: w.user }),
      "claude-code",
    );
    expect(claude.action).toBe("skipped");
    expect(existsSync(join(elsewhere, "settings.local.json"))).toBe(false);
  });
});

describe("Codex config", () => {
  test("a fresh checkout gets the profile as the default; a second run is unchanged", () => {
    const w = world();
    const codex = byHarness(applyAgentGuard(w.checkout, w.home, { userHome: w.user }), "codex");
    expect(codex.action).toBe("created");
    const text = readFileSync(codexFile(w.checkout), "utf8");
    const cfg = toml(text);
    expect(cfg.default_permissions).toBe(AGENT_GUARD_PROFILE);
    expect(cfg.permissions[AGENT_GUARD_PROFILE]).toEqual({
      description: expect.any(String),
      extends: ":workspace",
      filesystem: {
        ":root": "read",
        "~/.ablationkit": "deny",
        ":workspace_roots": {
          ".ablationkit/project.json": "deny",
          ".ablationkit/research": "deny",
          ".ablationkit/conversations": "deny",
          ".ablationkit/llm": "deny",
        },
      },
    });
    expect(
      byHarness(applyAgentGuard(w.checkout, w.home, { userHome: w.user }), "codex").action,
    ).toBe("unchanged");
    expect(readFileSync(codexFile(w.checkout), "utf8")).toBe(text);
  });

  test("an existing config keeps its content; the root key goes before any table", () => {
    const w = world();
    mkdirSync(join(w.checkout, ".codex"));
    const mine = 'model = "o3"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';
    writeFileSync(codexFile(w.checkout), mine);
    expect(
      byHarness(applyAgentGuard(w.checkout, w.home, { userHome: w.user }), "codex").action,
    ).toBe("updated");
    const text = readFileSync(codexFile(w.checkout), "utf8");
    expect(text).toContain(mine);
    const cfg = toml(text);
    expect(cfg.default_permissions).toBe(AGENT_GUARD_PROFILE);
    expect(cfg.mcp_servers).toEqual({ docs: { command: "docs-mcp" } });
    expect(cfg.model).toBe("o3");
    expect(
      byHarness(applyAgentGuard(w.checkout, w.home, { userHome: w.user }), "codex").action,
    ).toBe("unchanged");
  });

  test.each([
    ['sandbox_mode = "workspace-write"\n', "sandbox_mode"],
    ["[sandbox_workspace_write]\nnetwork_access = true\n", "[sandbox_workspace_write]"],
    ['default_permissions = ":workspace"\n', "default_permissions"],
  ])("a config that already chose a sandbox is skipped (%#)", (mine, what) => {
    const w = world();
    mkdirSync(join(w.checkout, ".codex"));
    writeFileSync(codexFile(w.checkout), mine);
    const codex = byHarness(applyAgentGuard(w.checkout, w.home, { userHome: w.user }), "codex");
    expect(codex.action).toBe("skipped");
    expect(codex.note).toContain(what);
    expect(readFileSync(codexFile(w.checkout), "utf8")).toBe(mine);
  });

  test("invalid TOML is skipped", () => {
    const w = world();
    mkdirSync(join(w.checkout, ".codex"));
    writeFileSync(codexFile(w.checkout), "model = \n");
    const codex = byHarness(applyAgentGuard(w.checkout, w.home, { userHome: w.user }), "codex");
    expect(codex.action).toBe("skipped");
    expect(codex.note).toContain("not valid TOML");
  });

  test("a non-default home is named by its absolute path in both files, and the blocks follow it", () => {
    const w = world();
    const other = join(tmp(), "ak-home");
    mkdirSync(other);
    applyAgentGuard(w.checkout, other, { userHome: w.user });
    const doc = JSON.parse(readFileSync(claudeFile(w.checkout), "utf8"));
    expect(doc.permissions.deny).toContain(`Read(/${other}/**)`);
    expect(doc.permissions.deny).toContain(`Edit(/${other}/**)`);
    expect(doc.permissions.deny.some((d: string) => d.includes("~/"))).toBe(false);
    expect(doc.sandbox.filesystem.denyRead[0]).toBe(other);
    expect(profileFs(w.checkout)[other]).toBe("deny");

    // The coordinator home moves: AblationKit's own blocks are rewritten, the rest kept.
    const moved = join(tmp(), "ak-home-2");
    mkdirSync(moved);
    expect(
      byHarness(applyAgentGuard(w.checkout, moved, { userHome: w.user }), "codex").action,
    ).toBe("updated");
    const fs2 = profileFs(w.checkout);
    expect(fs2[moved]).toBe("deny");
    expect(fs2[other]).toBeUndefined();
  });
});

describe("Git hygiene", () => {
  test("created files go in .git/info/exclude once; tracked files are left to the researcher", () => {
    const w = world({ git: true });
    applyAgentGuard(w.checkout, w.home, { userHome: w.user });
    const exclude = () => readFileSync(join(w.checkout, ".git", "info", "exclude"), "utf8");
    expect(
      exclude()
        .split("\n")
        .filter((l) => l === "/.claude/settings.local.json"),
    ).toHaveLength(1);
    expect(
      exclude()
        .split("\n")
        .filter((l) => l === "/.codex/config.toml"),
    ).toHaveLength(1);
    const status = readGit(w.checkout, ["status", "--porcelain", "--untracked-files=all"]);
    expect(status.stdout).not.toContain(".claude");
    expect(status.stdout).not.toContain(".codex");

    // Recreated after deletion: still one line each.
    rmSync(join(w.checkout, ".claude"), { recursive: true });
    rmSync(join(w.checkout, ".codex"), { recursive: true });
    applyAgentGuard(w.checkout, w.home, { userHome: w.user });
    expect(
      exclude()
        .split("\n")
        .filter((l) => l === "/.claude/settings.local.json"),
    ).toHaveLength(1);

    // A tracked .codex/config.toml the guard changes gets a note.
    const other = world({ git: true });
    mkdirSync(join(other.checkout, ".codex"));
    writeFileSync(codexFile(other.checkout), 'model = "o3"\n');
    setupGit(other.checkout, ["add", ".codex/config.toml"]);
    const codex = byHarness(
      applyAgentGuard(other.checkout, other.home, { userHome: other.user }),
      "codex",
    );
    expect(codex.action).toBe("updated");
    expect(codex.note).toContain("tracked by Git");
    expect(
      existsSync(join(other.checkout, ".git", "info", "exclude")) &&
        readFileSync(join(other.checkout, ".git", "info", "exclude"), "utf8").includes(
          "/.codex/config.toml",
        ),
    ).toBe(false);
  });

  test("a file Git already ignores is not added to the exclude file", () => {
    const w = world({ git: true });
    writeFileSync(join(w.checkout, ".gitignore"), ".claude/settings.local.json\n");
    applyAgentGuard(w.checkout, w.home, { userHome: w.user });
    const exclude = readFileSync(join(w.checkout, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain("/.claude/settings.local.json");
    expect(exclude).toContain("/.codex/config.toml");
  });
});

describe("user-level Codex notes", () => {
  test("an untrusted checkout and a legacy sandbox_mode are reported; a trusted one is quiet", () => {
    const w = world();
    const codexHome = join(w.user, "codex");
    mkdirSync(codexHome);
    const env = { CODEX_HOME: codexHome, HOME: w.user };
    expect(codexUserNotes(w.checkout, env)[0]).toContain("not trusted");
    writeFileSync(
      join(codexHome, "config.toml"),
      `sandbox_mode = "workspace-write"\n[projects.${JSON.stringify(w.checkout)}]\ntrust_level = "trusted"\n`,
    );
    const notes = codexUserNotes(w.checkout, env);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("sandbox_mode");
    writeFileSync(
      join(codexHome, "config.toml"),
      `[projects.${JSON.stringify(w.checkout)}]\ntrust_level = "trusted"\n`,
    );
    expect(codexUserNotes(w.checkout, env)).toEqual([]);
    // No Codex home: Codex is not in use, nothing to say.
    expect(codexUserNotes(w.checkout, { HOME: w.user, CODEX_HOME: join(w.user, "nope") })).toEqual(
      [],
    );
  });
});

describe("taking the guard out (ADR 0062)", () => {
  test("only the guard's entries go; the researcher's own stay", () => {
    const w = world();
    mkdirSync(join(w.checkout, ".claude"));
    const own = {
      model: "opus",
      permissions: { deny: ["Read(./secrets/**)"], allow: ["Bash(uv run:*)"] },
      sandbox: { enabled: true, filesystem: { denyRead: ["./secrets"] } },
    };
    writeFileSync(claudeFile(w.checkout), JSON.stringify(own));
    mkdirSync(join(w.checkout, ".codex"));
    writeFileSync(codexFile(w.checkout), 'model = "gpt-5"\n');
    applyAgentGuard(w.checkout, w.home, { userHome: w.user });
    const r = removeAgentGuard(w.checkout, w.home, { userHome: w.user });
    expect(r.map((x) => x.action)).toEqual(["removed", "removed"]);
    expect(JSON.parse(readFileSync(claudeFile(w.checkout), "utf8"))).toEqual(own);
    expect(toml(readFileSync(codexFile(w.checkout), "utf8"))).toEqual({ model: "gpt-5" } as never);
    // A second time there is nothing to take out.
    expect(removeAgentGuard(w.checkout, w.home, { userHome: w.user }).map((x) => x.action)).toEqual(
      ["unchanged", "unchanged"],
    );
  });

  test("files the guard alone made are deleted; a broken file is reported, not touched", () => {
    const w = world();
    applyAgentGuard(w.checkout, w.home, { userHome: w.user });
    const r = removeAgentGuard(w.checkout, w.home, { userHome: w.user });
    expect(r.map((x) => x.action)).toEqual(["removed", "removed"]);
    expect(existsSync(claudeFile(w.checkout))).toBe(false);
    expect(existsSync(join(w.checkout, ".codex"))).toBe(false);
    mkdirSync(join(w.checkout, ".claude"), { recursive: true });
    writeFileSync(claudeFile(w.checkout), "{ broken");
    const bad = byHarness(
      removeAgentGuard(w.checkout, w.home, { userHome: w.user }),
      "claude-code",
    );
    expect(bad.action).toBe("skipped");
    expect(readFileSync(claudeFile(w.checkout), "utf8")).toBe("{ broken");
  });
});
