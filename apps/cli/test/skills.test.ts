/**
 * Agent Skills under `skills/` stay valid and in step with how agents use AblationKit (ADR 0040):
 * frontmatter, relative links, every `ablationkit_<tool>` they mention is a tool of
 * `ablationkit mcp` and every operation or action they name with it (`ablationkit_read run.metrics`,
 * `ablationkit_note add`) is one it reaches, every `ablationkit <command>` they still mention (the researcher's and the
 * operator's, or offline extension authoring) is in the CLI's usage, and none hands the agent a
 * token.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MCP_TOOLS, OPERATIONS, toolFor } from "../src/commands/mcp.ts";
import { cli, ROOT } from "./helpers.ts";

const SKILLS = join(ROOT, "skills");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? markdownFiles(p) : n.endsWith(".md") ? [p] : [];
  });
}

const skillDirs = readdirSync(SKILLS).filter((n) => statSync(join(SKILLS, n)).isDirectory());
const ALL = markdownFiles(SKILLS).map((f) => ({ f, md: readFileSync(f, "utf8") }));
/** Python packages the job SDKs put on the path; not MCP tools. */
const PYTHON_MODULES = new Set([
  "ablationkit_sdk",
  "ablationkit_pytorch",
  "ablationkit_llm",
  "ablationkit_protocol",
  "ablationkit_extension",
  "ablationkit_worker",
]);

describe("agent skills", () => {
  test("there is at least one skill", () => {
    expect(skillDirs).toContain("onboard-project");
  });

  for (const name of skillDirs) {
    test(`${name}: frontmatter and links`, () => {
      const text = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
      const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(m).not.toBeNull();
      const fm = Object.fromEntries(
        (m?.[1] ?? "").split("\n").map((l) => {
          const i = l.indexOf(":");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
      );
      expect(fm["name"]).toBe(name);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect((fm["description"] ?? "").length).toBeGreaterThan(50);
      expect((fm["description"] ?? "").length).toBeLessThanOrEqual(1024);
      for (const f of markdownFiles(join(SKILLS, name))) {
        const md = readFileSync(f, "utf8");
        for (const [, target] of md.matchAll(/\]\(([^)#\s]+)\)/g)) {
          if (/^[a-z]+:/.test(target as string)) continue;
          expect(existsSync(resolve(dirname(f), target as string)), `${f} → ${target}`).toBe(true);
        }
      }
    });
  }

  test("every MCP tool, operation and action the skills mention is one of `ablationkit mcp`", () => {
    const tools = new Set(MCP_TOOLS.map((t) => t.name));
    const reachable = new Set(OPERATIONS.map((o) => toolFor(o.id)));
    const mentioned = new Set<string>();
    for (const { f, md } of ALL) {
      for (const [, name] of md.matchAll(/\b(ablationkit_[a-z_]+)\b(?![.(])/g)) {
        if (PYTHON_MODULES.has(name as string)) continue;
        mentioned.add(name as string);
        expect(tools.has(name as string), `${f}: ${name}`).toBe(true);
      }
      // A call written `ablationkit_read run.metrics` or `ablationkit_note add` names an
      // operation or action the tool reaches.
      for (const [, usage] of md.matchAll(/`(ablationkit_[a-z]+ [a-z_.]+)`/g)) {
        mentioned.add(usage as string);
        expect(reachable.has(usage as string), `${f}: ${usage}`).toBe(true);
      }
    }
    expect(mentioned.size).toBeGreaterThan(30);
    // Every skill starts by checking the server is there.
    for (const name of skillDirs)
      expect(readFileSync(join(SKILLS, name, "SKILL.md"), "utf8"), name).toContain(
        "ablationkit_project",
      );
  });

  test("every CLI command the skills mention is in the CLI's usage", async () => {
    const usage = (await cli(tmpdir(), ["help"])).out;
    const lines = usage.split("\n").map((l) => l.trim());
    const mentioned = new Set<string>();
    for (const { md } of ALL)
      for (const [, a, b] of md.matchAll(
        /(?:\bablationkit|\$AK)[ \t]+([a-z]+)(?:[ \t]+([a-z]+))?/g,
      ))
        mentioned.add([a, b].filter(Boolean).join(" "));
    expect(mentioned.size).toBeGreaterThan(3);
    for (const cmd of mentioned) {
      const [group, sub] = cmd.split(" ") as [string, string | undefined];
      const known = lines.some(
        (l) =>
          l.startsWith(`${group} `) &&
          (!sub || new RegExp(`(^|[ |])${sub}([ |]|$)`).test(l.slice(group.length))),
      );
      expect(known, `ablationkit ${cmd}`).toBe(true);
    }
  });

  test("no skill hands the agent a token or points it at the coordinator's API", () => {
    for (const { f, md } of ALL) {
      expect(md, f).not.toContain("ABLATIONKIT_AGENT_TOKEN");
      expect(md, f).not.toContain("ABLATIONKIT_AGENT_URL");
      expect(md, f).not.toContain("/api/v1/");
      expect(md, f).not.toContain("$AK");
    }
  });
});
