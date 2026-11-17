import { describe, expect, test } from "bun:test";
import { validateContainerConfig } from "@ablationkit/protocol";
import {
  agentContainerArgs,
  agentToolShims,
  CONTAINER,
  commandsInTranscriptLine,
  commandsInTranscripts,
  configProblems,
  DEFAULT_ALLOW,
  DEFAULT_ENVIRONMENT_ALLOW,
  defaultContainerConfig,
  diffPackages,
  environmentAllow,
  environmentBuildArgv,
  filesChanged,
  hostAllowed,
  isPublicAddress,
  jobContainerArgs,
  migrateConfig,
  PACKAGE_HOSTS,
  parseDistInfo,
  parseNameStatus,
  parsePattern,
  parsePorcelain,
  resolveConfigPath,
  shellQuote,
  within,
} from "../src/index.ts";

describe("egress allowlist", () => {
  test("a host allows itself on 80 and 443 only", () => {
    expect(hostAllowed(["pypi.org"], "pypi.org", 443)).toBe(true);
    expect(hostAllowed(["pypi.org"], "PyPI.org.", 80)).toBe(true);
    expect(hostAllowed(["pypi.org"], "pypi.org", 22)).toBe(false);
    expect(hostAllowed(["pypi.org"], "evil-pypi.org", 443)).toBe(false);
    expect(hostAllowed(["pypi.org"], "sub.pypi.org", 443)).toBe(false);
  });

  test("a wildcard allows subdomains, not the host itself", () => {
    expect(hostAllowed(["*.hf.co"], "cdn-lfs.hf.co", 443)).toBe(true);
    expect(hostAllowed(["*.hf.co"], "hf.co", 443)).toBe(false);
    expect(hostAllowed(["*.hf.co"], "xhf.co", 443)).toBe(false);
  });

  test("a port names that port only; * allows anything", () => {
    expect(hostAllowed(["example.com:8443"], "example.com", 8443)).toBe(true);
    expect(hostAllowed(["example.com:8443"], "example.com", 443)).toBe(false);
    expect(hostAllowed(["*"], "anything.example", 9999)).toBe(true);
  });

  test("invalid hosts and patterns allow nothing", () => {
    expect(hostAllowed(["*"], "bad host", 443)).toBe(false);
    expect(hostAllowed(["*"], "[::1]", 443)).toBe(false);
    expect(parsePattern("exa mple.com")).toBeUndefined();
    expect(parsePattern("example.com:70000")).toBeUndefined();
  });

  test("only public addresses are reachable", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "100.100.1.1",
      "169.254.1.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPublicAddress(ip)).toBe(false);
    for (const ip of ["151.101.0.223", "8.8.8.8", "2606:4700::6810:84e5", "::ffff:8.8.8.8"])
      expect(isPublicAddress(ip)).toBe(true);
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });
});

describe("configuration", () => {
  test("the default is valid and checks clean", () => {
    const c = defaultContainerConfig("demo", "2026-11-16T00:00:00Z");
    expect(() => validateContainerConfig(c)).not.toThrow();
    expect(configProblems(c)).toEqual([]);
    expect(c.jobs.network).toBe("none");
    expect(c.host_code).toBe("refuse");
    // Agents reach no package index; environment builds do (ADR 0066).
    for (const h of PACKAGE_HOSTS) {
      expect(DEFAULT_ALLOW).not.toContain(h);
      expect(environmentAllow(c)).toContain(h);
    }
    expect(migrateConfig(c, "2026-11-17T00:00:00Z")).toBeUndefined();
  });

  test("a configuration from before environment builds moves the package hosts (ADR 0066)", () => {
    const { environment: _e, ...cur } = defaultContainerConfig("demo", "2026-11-16T00:00:00Z");
    const old = {
      ...cur,
      egress: { mode: "allowlist" as const, allow: ["pypi.org", "github.com", "my.example.org"] },
    };
    expect(environmentAllow(old)).toEqual(DEFAULT_ENVIRONMENT_ALLOW);
    const next = migrateConfig(old, "2026-11-17T00:00:00Z");
    expect(next?.revision).toBe(2);
    expect(next?.egress.allow).toEqual(["github.com", "my.example.org"]);
    expect(next?.environment?.allow).toEqual([...DEFAULT_ENVIRONMENT_ALLOW]);
    expect(() => validateContainerConfig(next)).not.toThrow();
    expect(configProblems({ ...cur, environment: { allow: ["not a host"] } })).toEqual([
      'environment.allow: "not a host" is not a host pattern',
    ]);
  });

  test("problems name what is wrong", () => {
    const c = defaultContainerConfig("demo", "2026-11-16T00:00:00Z");
    const bad = {
      ...c,
      hidden: ["../outside", "eval"],
      read_only: ["/abs"],
      evaluations: [
        {
          name: "heldout",
          description: "x",
          command: ["python", "eval.py"],
          environment: "uv" as const,
          mounts: ["/data/heldout"],
          runtime_max_sec: 60,
        },
      ],
      credentials: [
        {
          name: "hf",
          upstream: "https://huggingface.co",
          header: "authorization",
          env: { "bad name": "{url}" },
        },
      ],
    };
    const p = configProblems(bad).join("\n");
    expect(p).toContain("hidden");
    expect(p).toContain("read_only");
    expect(p).toContain("is not in hidden");
    expect(p).toContain("exactly one of from_env and from_file");
    expect(p).toContain("not a variable name");
  });

  test("paths resolve against the checkout", () => {
    expect(resolveConfigPath("/w/proj/", "eval/data")).toBe("/w/proj/eval/data");
    expect(resolveConfigPath("/w/proj", "/data/x/")).toBe("/data/x");
    expect(within("/w/proj", "/w/proj/a")).toBe(true);
    expect(within("/w/proj", "/w/project")).toBe(false);
  });
});

describe("podman command lines", () => {
  const base = {
    sessionId: "c-0123456789ab",
    projectId: "demo",
    image: "localhost/ablationkit-agent:1",
    checkout: "/w/proj",
    tree: "/opt/ak",
    tools: { bun: "/host/bun", harness: "/host/claude" },
    dirs: {
      run: "/home/u/.ablationkit/run/containers/c-0123456789ab/mount",
      home: "/home/u/.ablationkit/containers/projects/demo/home-claude-code",
    },
    limits: { cpus: 4, memory_mb: 8192, pids_max: 4096 },
    masks: [
      { path: "/w/proj/eval", kind: "dir" as const },
      { path: "/w/proj/.ablationkit/project.json", kind: "file" as const },
    ],
    readOnly: ["/w/proj/data"],
    harness: "claude-code" as const,
    args: ["--model", "opus"],
    env: { HF_ENDPOINT: "http://127.0.0.1:3129/hf" },
  };

  test("the agent container has no network, GPU, privileges or coordinator home", () => {
    const a = agentContainerArgs(base);
    const s = a.join(" ");
    expect(a[0]).toBe("run");
    expect(s).toContain("--network none");
    expect(s).toContain("--userns keep-id");
    expect(s).toContain("--cap-drop all");
    expect(s).toContain("--security-opt no-new-privileges");
    expect(s).not.toContain("--device");
    expect(s).not.toContain("nvidia");
    expect(s).not.toContain(".ablationkit/run/login.sock");
    expect(s).toContain(`${base.dirs.run}:${CONTAINER.run}:ro`);
    expect(s).toContain("/w/proj:/w/proj:rw");
    expect(s).toContain(
      "type=tmpfs,destination=/w/proj/eval,tmpfs-mode=0555,tmpfs-size=1m,notmpcopyup",
    );
    expect(s).toContain("/dev/null:/w/proj/.ablationkit/project.json:ro");
    expect(s).toContain("/w/proj/data:/w/proj/data:ro");
    expect(s).toContain("/host/claude:/opt/ablationkit/bin/claude:ro");
    expect(s).toContain("HTTPS_PROXY=http://127.0.0.1:3128");
    expect(s).toContain("HF_ENDPOINT=http://127.0.0.1:3129/hf");
    expect(s).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    // No project environment and no uv (ADR 0066): the project's code runs as jobs.
    expect(s).not.toContain(CONTAINER.env);
    expect(s).not.toContain("UV_");
    expect(s).not.toContain("/opt/ablationkit/bin/uv");
    // The harness runs under the init, with the MCP server registered and the extra args after.
    const i = a.indexOf(base.image);
    expect(a.slice(i + 1, i + 4)).toEqual([
      "/opt/ablationkit/bin/bun",
      "/opt/ak/apps/cli/src/container-init.ts",
      "--",
    ]);
    expect(a.slice(i + 4)).toEqual([
      "/opt/ablationkit/bin/claude",
      "--model",
      "opus",
      "--mcp-config",
      "/run/ablationkit/mcp.json",
      "--strict-mcp-config",
    ]);
  });

  test("codex is registered with -c overrides", () => {
    const a = agentContainerArgs({
      ...base,
      harness: "codex",
      tools: { ...base.tools, harness: "/host/codex" },
    });
    expect(a.join(" ")).toContain('mcp_servers.ablationkit.args=["mcp","--contained"]');
    expect(a.join(" ")).toContain("/host/codex:/opt/ablationkit/bin/codex:ro");
  });

  test("a job container gets the GPU, no network and the spool", () => {
    const j = jobContainerArgs({
      name: "ak-job-j-abc-a1",
      image: base.image,
      checkout: base.checkout,
      tree: base.tree,
      tools: { bun: "/host/bun", uv: "/host/uv" },
      dirs: { env: "/e", python: "/p", spool: "/s/j-abc-a1" },
      extraReadOnly: [],
      masks: [{ path: "/w/proj/eval", kind: "dir" }],
      evaluationMounts: [],
      gpu: "all",
      network: "none",
      limits: { memory_max_bytes: 1 << 30, cpu_quota_percent: 250, runtime_max_sec: 600 },
      env: { ABLATIONKIT_ATTEMPT_ID: "j-abc-a1" },
      cwd: "/w/proj",
      argv: ["/opt/ablationkit/bin/uv", "run", "--frozen", "--", "python", "train.py"],
    });
    const s = j.join(" ");
    expect(s).toContain("--device nvidia.com/gpu=all");
    expect(s).toContain("--network none");
    expect(s).toContain("UV_OFFLINE=1");
    expect(s).toContain("--cpus 2.50");
    expect(s).toContain("--timeout 660");
    expect(s).toContain("/s/j-abc-a1:/s/j-abc-a1:rw");
    expect(s).toContain("type=tmpfs,destination=/w/proj/eval");
    expect(s).not.toContain("container-init");
    // The environment read-only; no cache: a job never installs.
    expect(s).toContain("/e:/opt/ablationkit/env:ro");
    expect(s).toContain("/p:/opt/ablationkit/python:ro");
    expect(s).not.toContain("uv-cache");
    expect(s).not.toContain("UV_CACHE_DIR");
    expect(j.slice(-6)).toEqual([
      "/opt/ablationkit/bin/uv",
      "run",
      "--frozen",
      "--",
      "python",
      "train.py",
    ]);
  });

  test("a job container with egress runs under the init with the proxy", () => {
    const j = jobContainerArgs({
      name: "ak-job-j-abc-a1",
      image: base.image,
      checkout: base.checkout,
      tree: base.tree,
      tools: { bun: "/host/bun" },
      dirs: { python: "/p", spool: "/s", run: "/r" },
      extraReadOnly: ["/x/sdk"],
      masks: [],
      evaluationMounts: ["/data/heldout"],
      gpu: "none",
      network: "egress",
      limits: {},
      env: {},
      cwd: "/w/proj",
      argv: ["python", "eval.py"],
    });
    const s = j.join(" ");
    expect(s).not.toContain("--device");
    expect(s).toContain("HTTPS_PROXY=http://127.0.0.1:3128");
    expect(s).toContain("/r:/run/ablationkit:ro");
    expect(s).toContain("/data/heldout:/data/heldout:ro");
    expect(s).toContain("/x/sdk:/x/sdk:ro");
    expect(s).toContain("container-init.ts --job -- python eval.py");
    expect(s).not.toContain(`:${CONTAINER.env}:`);
  });

  test("an environment build writes a new copy from the current one, with the cache (ADR 0066)", () => {
    const argv = environmentBuildArgv("/w/proj", ["--extra", "cuda"]);
    const j = jobContainerArgs({
      name: "ak-job-j-abc-a1",
      image: base.image,
      checkout: base.checkout,
      tree: base.tree,
      tools: { bun: "/host/bun", uv: "/host/uv" },
      dirs: {
        env: "/envs/new",
        envBase: "/envs/cur",
        uvCache: "/c",
        python: "/p",
        spool: "/s",
        run: "/r",
      },
      build: true,
      extraReadOnly: [],
      masks: [],
      evaluationMounts: [],
      gpu: "none",
      network: "egress",
      limits: {},
      env: {},
      cwd: "/w/proj",
      argv,
    });
    const s = j.join(" ");
    expect(s).toContain("/envs/new:/opt/ablationkit/env:rw");
    expect(s).toContain("/envs/cur:/opt/ablationkit/env-base:ro");
    expect(s).toContain("/c:/opt/ablationkit/uv-cache:rw");
    expect(s).toContain("/p:/opt/ablationkit/python:rw");
    expect(s).toContain("UV_CACHE_DIR=/opt/ablationkit/uv-cache");
    expect(s).toContain("UV_LINK_MODE=copy");
    expect(s).not.toContain("--device");
    expect(j.slice(-argv.length)).toEqual(argv);
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(argv.slice(3)).toEqual(["environment-build", "/w/proj", "--extra", "cuda"]);
    // The script, run by a real shell: copies the base, then hands uv its arguments as given.
    expect(argv[2]).toContain(
      "cp -a --reflink=auto /opt/ablationkit/env-base/. /opt/ablationkit/env/",
    );
    const p = Bun.spawnSync(
      [
        "/bin/sh",
        "-c",
        (argv[2] as string).replace(/exec \S+\/uv sync/, "printf '%s\\n' sync"),
        "x",
        "/w/proj",
        "--extra",
        "it's",
      ],
      { stdout: "pipe" },
    );
    expect(p.stdout.toString()).toBe("sync\n--project\n/w/proj\n--extra\nit's\n");
  });

  test("the package tools in an agent container say what to do instead", () => {
    const shims = agentToolShims();
    expect(Object.keys(shims).sort()).toEqual(["pip", "pip3", "uv", "uvx"]);
    expect(shims["uv"]).toStartWith("#!/bin/sh\n");
    expect(shims["uv"]).toContain("ablationkit_job environment");
    expect(shims["pip"]).toContain("exit 127");
  });

  test("shell quoting", () => {
    expect(shellQuote("abc/def")).toBe("abc/def");
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
    expect(shellQuote("a b")).toBe("'a b'");
  });
});

describe("provenance", () => {
  test("packages from dist-info names, and their differences", () => {
    expect(parseDistInfo("Torch_Audio-2.5.0.dist-info")).toEqual({
      name: "torch-audio",
      version: "2.5.0",
    });
    expect(parseDistInfo("README.txt")).toBeUndefined();
    const d = diffPackages(
      [
        { name: "numpy", version: "2.0.0" },
        { name: "old", version: "1" },
      ],
      [
        { name: "numpy", version: "2.1.0" },
        { name: "torch", version: "2.5.0" },
      ],
    );
    expect(d.added).toEqual([{ name: "torch", version: "2.5.0" }]);
    expect(d.removed).toEqual([{ name: "old", version: "1" }]);
    expect(d.changed).toEqual([{ name: "numpy", version: "2.1.0", previous: "2.0.0" }]);
  });

  test("git status and diff output, and the files a session changed", () => {
    expect(parsePorcelain(" M a.py\0?? new.py\0R  b.py\0old.py\0")).toEqual([
      { path: "a.py", status: "M" },
      { path: "new.py", status: "??" },
      { path: "b.py", status: "R" },
    ]);
    expect(parseNameStatus("M\0a.py\0R100\0old.py\0b.py\0A\0c.py\0")).toEqual([
      { path: "a.py", status: "M" },
      { path: "b.py", status: "R" },
      { path: "c.py", status: "A" },
    ]);
    expect(
      filesChanged(
        [{ path: "a.py", status: "M" }],
        ["notes.md"],
        [
          { path: "notes.md", status: "M" },
          { path: "x.py", status: "??" },
        ],
      ),
    ).toEqual([
      { path: "a.py", status: "M" },
      { path: "x.py", status: "??" },
    ]);
  });

  test("commands from Claude Code and Codex transcripts", () => {
    const claude = JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-16T10:00:00Z",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "uv run pytest" } }],
      },
    });
    const codex = JSON.stringify({
      timestamp: "2026-11-16T10:01:00Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["bash", "-lc", "ls -la"] }),
      },
    });
    const old = JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-15T10:00:00Z",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "before the session" } }],
      },
    });
    expect(commandsInTranscriptLine(claude)).toEqual([
      { at: "2026-11-16T10:00:00Z", command: "uv run pytest" },
    ]);
    expect(commandsInTranscriptLine(codex)).toEqual([
      { at: "2026-11-16T10:01:00Z", command: "ls -la" },
    ]);
    expect(commandsInTranscriptLine("not json")).toEqual([]);
    expect(
      commandsInTranscripts([codex, old, claude], "2026-11-16T00:00:00Z", undefined).map(
        (c) => c.command,
      ),
    ).toEqual(["uv run pytest", "ls -la"]);
  });
});
