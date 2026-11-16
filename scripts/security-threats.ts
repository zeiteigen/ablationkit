/**
 * The security threat map (Stage 18b; spec §7.11, §14 "permission/security testing"). Each threat
 * names the control that answers it, that control's honest level, and the tests that prove it.
 * `scripts/security-map.ts` generates docs/security/threat-map.md from this; the test in
 * `scripts/test/security-map.test.ts` fails if a named test no longer exists.
 */

/** Labels from spec §7.11. `authoritative` is true only of what AblationKit itself executes. */
export type Level = "enforced" | "server-side" | "approval-gated" | "advisory" | "authoritative";

export interface Proof {
  readonly file: string;
  /** A substring of the test's title. */
  readonly test: string;
  /** `unit` runs in CI's plain `bun test` or `pytest`; others are `package.json` scripts. */
  readonly suite: string;
}

export interface Threat {
  readonly id: string;
  readonly threat: string;
  readonly control: string;
  readonly level: Level;
  readonly proofs: readonly Proof[];
  /** What this does not cover. Read it: it is the honest edge of the control. */
  readonly limit?: string;
}

export interface Area {
  readonly title: string;
  readonly threats: readonly Threat[];
}

const S = "apps/server/test/";
const MCP = "apps/cli/test/mcp.test.ts";
const unit = (file: string, test: string): Proof => ({ file, test, suite: "unit" });
const srv = (file: string, test: string): Proof => unit(`${S}${file}.test.ts`, test);
const WEB = (test: string): Proof => ({
  file: "apps/web/e2e/smoke.test.ts",
  test,
  suite: "test:web",
});
const DESK = (test: string): Proof => ({
  file: "apps/desktop/e2e/desktop.test.ts",
  test,
  suite: "test:desktop",
});

export const AREAS: readonly Area[] = [
  {
    title: "Human API and sessions",
    threats: [
      {
        id: "AUTH-1",
        threat:
          "A privileged write (policy revision, extension or build activation, restore, project removal, widening data controls) by anyone but the researcher",
        control:
          "Privileged writes exist only on the human API and need a human session; agent and worker tokens are refused there and their listeners have no such routes. No second factor (ADR 0037)",
        level: "authoritative",
        proofs: [
          srv("listeners", "privileged human actions are on the human table only"),
          srv("listeners", "privileged human routes do not exist there"),
          srv("security-routes", "no human route answers without a session"),
          srv("security-agent", "a misbehaving agent cannot widen anything through its own API"),
        ],
        limit:
          "The session is the only gate: whoever holds one (a stolen cookie or CLI session file, or a process running as the researcher that asks the login socket for a link) can make privileged writes. Agents working through `ablationkit mcp` cannot; one that goes around it as the researcher's user (the login socket, `~/.ablationkit`) can. For an agent on the researcher's machine that is by design since ADR 0062: it is their operator and may use the whole CLI. An agent in an agent container cannot (CTR-1); an uncontained one is kept out only by its harness's sandbox (the opt-in agent guard, AUTH-10).",
      },
      {
        id: "AUTH-4",
        threat:
          "A web page drives the coordinator through the researcher's browser (CSRF, rebinding)",
        control:
          "Cookie writes need a trusted Origin; the Host header is checked on every listener",
        level: "enforced",
        proofs: [
          srv("coordinator", "requests need a session; cookie writes need a trusted Origin"),
          srv("listeners", "the agent listener refuses non-loopback Host headers"),
        ],
      },
      {
        id: "AUTH-5",
        threat: "A token used on the wrong listener, or a stolen token file read for its secret",
        control: "One token kind per listener, swept across every route; only hashes are stored",
        level: "enforced",
        proofs: [
          srv("security-routes", "no human route answers without a session"),
          srv("security-routes", "no agent route answers without an agent token"),
          srv("security-routes", "no worker route answers without a worker token"),
          unit(
            "packages/auth/test/auth.test.ts",
            "mints, verifies by kind, and stores only a hash",
          ),
          unit("packages/auth/test/auth.test.ts", "login codes are single-use and expire"),
        ],
      },
      {
        id: "AUTH-6",
        threat: "Path parameters and artifact paths that walk out of a directory or inject options",
        control: "IDs are looked up, never joined blind; artifact paths have one validator",
        level: "enforced",
        proofs: [
          srv("security-routes", "every human route with a parameter refuses them"),
          srv("security-routes", "the same values under a real project"),
          srv("security-routes", "every agent route refuses them"),
          srv("security-routes", "artifact paths: traversal, absolute, scheme"),
          srv("shell", "paths never escape the bundle directory"),
        ],
      },
      {
        id: "AUTH-7",
        threat: "An uploaded artifact or model file runs as script on the coordinator's origin",
        control:
          "Downloads are attachments with `nosniff` and a sandbox CSP; the app CSP has no inline script",
        level: "enforced",
        proofs: [
          srv("tracking", "runs: manual create, log, metrics"),
          srv("lifecycle", "the SDK's dataset inputs and model directory reach MLflow"),
          srv("shell", "client routes get index.html with a strict CSP"),
        ],
      },
      {
        id: "AUTH-8",
        threat:
          "A one-time login link that signs the researcher in and then sends the browser elsewhere (an open redirect to another site, or straight into the API)",
        control:
          "The link's `next` is checked twice, on the login socket and on `GET /login`: only a same-origin web UI path is accepted; `//host`, `/\\host`, absolute URLs, `/api/…`, `/login`, `..` segments and control characters are refused (socket: 400; `/login`: lands on `/`)",
        level: "enforced",
        proofs: [
          srv(
            "coordinator",
            "a login link can land on a web UI path, never another origin or the API",
          ),
        ],
        limit: "Any web UI path is accepted; landing on a page grants nothing by itself.",
      },
      {
        id: "AUTH-9",
        threat:
          "The login socket's agent-session endpoint used to get a human session, a token for an unregistered project, or a session that never ends",
        control:
          "`POST /agent-sessions` mints only an agent token, for one registered project, labelled with a validated harness and an absolute directory; it issues no login code and no session. A session ends when `ablationkit mcp` closes (by its own token), after 12 hours without a request, 7 days after it began, or when the researcher ends it in Settings; each start, end and expiry is audited (ADR 0040)",
        level: "enforced",
        proofs: [
          srv("listeners", "the login socket mints only agent tokens for a registered project"),
          srv(
            "listeners",
            "a session ends with its own token, after 12 idle hours, or by the researcher",
          ),
          unit(MCP, "the stdio server ends its session when the harness closes stdin"),
          unit(MCP, "the token stays inside; ending it revokes it"),
        ],
        limit:
          "A session token is identity, not a boundary, except in an agent container (CTR-1). The socket answers any process running as the researcher, and the same socket's `/login` gives out a human login link: an agent that can reach `~/.ablationkit/run/login.sock` (or the CLI's saved session) can act as the researcher, which for an agent on the host is by design (ADR 0062). Only the harness's sandbox, denying the agent `~/.ablationkit`, stops an uncontained one (the opt-in agent guard, AUTH-10). Anyone holding a session's token is that session to AblationKit.",
      },
      {
        id: "AUTH-10",
        threat:
          "An uncontained agent the researcher does not want acting for them, working in a registered checkout, reads `~/.ablationkit` (the login socket, the CLI's saved session) or the coordinator-owned parts of the project's `.ablationkit/` and acts as the researcher",
        control:
          "The agent guard (ADR 0041), opt-in since ADR 0062 (agents on the host are the researcher's operators; execution agents belong in agent containers, CTR-1): `ablationkit project guard` and `scripts/setup.sh --guard` merge Claude Code deny rules and sandbox entries into the checkout's `.claude/settings.local.json` and add a Codex permission profile (`ablationkit-guard`, the default) to `.codex/config.toml`, both denying the coordinator home and the coordinator-owned parts of `.ablationkit/` (`project.json`, `research/`, `conversations/`, `llm/`; extension source stays open, ADR 0044). Existing settings are kept; a Codex config that already chose a sandbox is reported, not edited; created files go in `.git/info/exclude`",
        level: "advisory",
        proofs: [
          srv("agent-guard", "a fresh checkout gets the deny rules and sandbox entries"),
          srv("agent-guard", "a fresh checkout gets the profile as the default"),
          srv("agent-guard", "a config that already chose a sandbox is skipped"),
          srv("agent-guard", "created files go in .git/info/exclude once"),
          srv("coordinator", "registration and remap write no agent guard into the checkout"),
          srv("agent-guard", "only the guard's entries go; the researcher's own stay"),
          unit("apps/cli/test/commands.test.ts", "project guard applies it on request"),
        ],
        limit:
          "AblationKit writes the configuration; the harness enforces it. Claude Code's permission rules bind its own file tools and the Bash file commands it recognizes, not arbitrary programs (a Python one-liner or a socket client); its sandbox entries bind Bash at the OS level only when the researcher turns on `sandbox.enabled`, which the guard never sets. Codex enforces its profile with bubblewrap and seccomp (measured with codex-cli 0.167.0: the home, the login socket and the owned `.ablationkit/` paths refused, `extensions/` writable), but only for a trusted project and when no `--sandbox` or legacy `sandbox_mode` takes precedence. Neither covers an agent run outside these harnesses or with their sandbox bypassed, and a Codex agent can still edit `.claude/settings.local.json`.",
      },
    ],
  },
  {
    title: "Agent containers",
    threats: [
      {
        id: "CTR-1",
        threat:
          "An agent in an agent container reaches the coordinator's home, the login socket, the CLI's saved session or another session's token, and acts as the researcher",
        control:
          "The container (rootless Podman, `--userns keep-id`, every capability dropped, no new privileges) mounts only the checkout, AblationKit's tree read-only, the harness, bun and uv read-only, the agent's home and the environment volumes, and the session's run directory read-only. The coordinator mints the session's token for the container (never through the login socket); the session's agent socket accepts only that token. The coordinator's home is masked should it sit inside the checkout or the tree, as are the coordinator-owned parts of `.ablationkit/` (ADR 0061)",
        level: "enforced",
        proofs: [
          srv("containers", "start: a token minted for the container"),
          srv("containers", "the agent socket takes only the session's own token"),
          unit(
            "packages/agent-containers/test/containers.test.ts",
            "the agent container has no network, GPU, privileges or coordinator home",
          ),
          {
            file: `${S}containers-e2e.test.ts`,
            test: "a contained shell meets the boundary",
            suite: "test:containers",
          },
        ],
        limit:
          "Enforced by the kernel through Podman for what runs in the container; a kernel or runtime escape is out of scope. The harness's own sign-in lives in the container's home and is readable by the agent. Agents in the researcher's own harness, outside a container, are covered only by AUTH-10.",
      },
      {
        id: "CTR-2",
        threat:
          "A contained agent runs GPU experiments in its own shell, outside the compute limit and the runs the witness accounts for",
        control:
          "The agent container gets no devices: GPU work runs as jobs, in job containers that get the GPU through CDI, each admitted under the compute limit and recorded as runs",
        level: "enforced",
        proofs: [
          unit(
            "packages/agent-containers/test/containers.test.ts",
            "the agent container has no network, GPU, privileges or coordinator home",
          ),
          unit(
            "packages/agent-containers/test/containers.test.ts",
            "a job container gets the GPU, no network and the spool",
          ),
        ],
        limit:
          "CPU experiments in the agent's shell remain possible within the container's CPU and memory limits, and are not seen.",
      },
      {
        id: "CTR-3",
        threat:
          "A contained agent or its job sends data out, or reaches this machine's own services (the coordinator, MLflow) or the local network",
        control:
          "Agent and job containers have `--network none`. The only way out is the session's (or attempt's) egress proxy: it applies the project's allowlist plus the harness's own hosts at each connection, resolves names itself, connects only to public addresses, and records every connection with its outcome; job containers have no proxy unless `jobs.network: egress`",
        level: "enforced",
        proofs: [
          srv("egress", "a CONNECT tunnel to an allowed host carries the bytes and is recorded"),
          srv("egress", "a host off the allowlist is refused with the reason, and recorded"),
          srv("egress", "an allowed name that resolves to this machine is refused"),
          srv("containers", "egress goes through the session's proxy"),
          unit(
            "packages/agent-containers/test/containers.test.ts",
            "only public addresses are reachable",
          ),
        ],
        limit:
          "An allowed host can carry data out (a repository, a paste on an allowed service); HTTPS is recorded by host only; egress mode `open` allows any public host and only records it.",
      },
      {
        id: "CTR-4",
        threat: "An agent reads held-out data or evaluation code, or changes how it is scored",
        control:
          "Hidden paths are not mounted (outside the checkout) or masked (inside it) in agent and ordinary job containers; a protected evaluation's pinned command, environment and time limit run in a job container with its hidden paths read-only and no network, and its console is withheld from agents (`protected_evaluation`); outside a container an evaluation is refused",
        level: "enforced",
        proofs: [
          srv("containers", "a protected evaluation runs the pinned command, its console withheld"),
          srv("containers", "start: a token minted for the container"),
        ],
        limit:
          "Masking hides the working tree, not Git history: protected files belong outside the repository. The evaluated code is the agent's and sees the mounted data while it runs; it could encode what it read in the metrics or parameters it logs.",
      },
      {
        id: "CTR-5",
        threat:
          "A contained agent gets its code run on this machine outside any container through AblationKit (a local job, an extension build or run)",
        control:
          "A contained session's local jobs run only in job containers (a job that cannot be containerized is refused, never run on the host); extension install, build, action and execute are refused for contained sessions unless the project sets `host_code: allow`",
        level: "enforced",
        proofs: [
          srv("containers", "a contained session's jobs run in job containers"),
          srv(
            "containers",
            "host code is refused for contained sessions unless the project allows it",
          ),
        ],
        limit:
          "Remote targets run jobs where they always did. Models a contained job logged are loaded on this machine when the researcher runs inference or an evaluation on them.",
      },
      {
        id: "CTR-6",
        threat: "API keys and tokens the agent's work needs are copied into the container",
        control:
          "Credential routes: the container calls `http://127.0.0.1:3129/<name>/…` and the proxy forwards it with the secret, read from the coordinator's environment or a file at each request; job containers get only the job's and the SDK's environment, not the coordinator's",
        level: "enforced",
        proofs: [srv("egress", "the secret is added on the way out")],
        limit:
          "Only for tools that take a configurable endpoint. Claude Code's login is copied into the container by default (ADR 0063): readable by the agent, and a renewal made there is carried back to `~/.claude` (same subscription and account only, the replaced file backed up), so a hostile agent could replace the researcher's login with a broken one. `--no-login` keeps a separate login.",
      },
    ],
  },
  {
    title: "Policy escalation",
    threats: [
      {
        id: "POL-1",
        threat: "An agent edits a repository file to grant itself remote jobs or deployments",
        control: "Repository files have no authority; the policy lives in the coordinator",
        level: "enforced",
        proofs: [srv("agent-policy", "repository files never change the policy")],
      },
      {
        id: "POL-2",
        threat: "An agent changes the policy or activates an extension itself",
        control: "The agent listener has no such routes; the human API refuses its token",
        level: "enforced",
        proofs: [
          srv("listeners", "the agent table has no policy-edit"),
          srv("listeners", "privileged human routes do not exist there"),
          srv("security-agent", "a misbehaving agent cannot widen anything through its own API"),
        ],
        limit:
          "A process running as the researcher could in principle read a browser's session, or ask the login socket for one, and call the human API, privileged writes included (AUTH-1).",
      },
      {
        id: "POL-3",
        threat: "An agent starts a job or a deployment the project policy does not allow",
        control:
          "Every agent job submission and deployment request is decided by the project policy (ADR 0037): remote targets and deployments are denied by default, and a refusal names the field",
        level: "authoritative",
        proofs: [
          unit(
            "packages/autonomy-policy/test/policy.test.ts",
            "remote jobs need allow and an allowed target",
          ),
          srv("agent-policy", "denied when the policy says so, naming the field"),
          srv("agent-policy", "only allowed targets pass the policy"),
          srv("deployments", "never a persistent or public endpoint"),
        ],
        limit:
          "The policy covers what an agent asks AblationKit to do. What the agent does in its own session (edits, shell commands, Git) is the user's harness's to sandbox and approve.",
      },
      {
        id: "POL-5",
        threat:
          "An agent session's token used on another project, its tasks, its runs, or another session's jobs",
        control:
          "Agent session tokens are bound to one project (ADRs 0039, 0040); a job or record names only a task of that project; runs are read only from the project's experiments; a session cancels only the jobs it submitted",
        level: "enforced",
        proofs: [
          srv("listeners", "agent tokens are scoped to their project"),
          srv("security-agent", "another project's tasks, jobs and policy are out of reach"),
          srv("tasks", "work names only an open task of the token's project"),
          srv("agent-policy", "an agent cancels only the jobs it submitted"),
          srv("tracking", "agents read their project's runs, metrics and text artifacts"),
          unit(MCP, "a session cancels its own jobs only"),
        ],
        limit:
          "Every session of a project can read that project's jobs, consoles, runs and tasks, and complete or abandon any of its tasks. A new session cannot cancel an earlier session's jobs; the researcher can.",
      },
      {
        id: "POL-6",
        threat: "A deployment starts after a restart without a fresh request",
        control:
          "Nothing is queued: a local preview does not survive a restart, and a request that waited for an approval before ADR 0037 loads closed",
        level: "authoritative",
        proofs: [srv("deployments", "nothing starts silently")],
      },
      {
        id: "POL-7",
        threat: "A policy revision written before ADR 0037 is read as allowing more than it did",
        control:
          "Version 1 revisions migrate on every read: `ask` becomes `deny`, and gates whose enforcement is gone are dropped",
        level: "authoritative",
        proofs: [
          unit("packages/autonomy-policy/test/policy.test.ts", "ask becomes deny"),
          srv("agent-policy", "a version 1 revision on disk is read as version 2"),
        ],
      },
      {
        id: "POL-8",
        threat: "An agent's jobs use more compute than the researcher allowed for the project",
        control:
          "Every agent job needs a time limit and is admitted only if the weighted hours used, those live attempts still hold and its own time limit × its target's weight fit under `compute.limit_hours` (ADR 0037); a refusal is audited and notifies the researcher, and only a policy revision raises the limit",
        level: "authoritative",
        proofs: [
          unit(
            "packages/autonomy-policy/test/compute.test.ts",
            "used + reserved + time limit × weight must fit under the limit",
          ),
          srv("compute-limit", "a time limit is required; human jobs never count"),
          srv("compute-limit", "the target's weight counts"),
        ],
        limit:
          "Admission is authoritative; what an admitted job uses is bounded by its time limit: systemd's RuntimeMaxSec where a user manager runs it (enforced), otherwise the collector or the remote shim stopping the job's process group, which a process that leaves the group escapes. Remote attempts count the times their worker reports, so a wrong clock or a late import can take usage past the limit; that notifies once and blocks further agent jobs.",
      },
    ],
  },
  {
    title: "Honest labels",
    threats: [
      {
        id: "LBL-2",
        threat: "Resource limits shown as enforced in direct mode",
        control: "Direct mode reports `advisory`; extension records say what was enforced",
        level: "authoritative",
        proofs: [
          unit(
            "packages/process-supervisor/test/supervisor.test.ts",
            "forced direct mode is labelled advisory",
          ),
          srv("extensions", "time and memory limits stop the process"),
        ],
      },
      {
        id: "LBL-3",
        threat: "Docs or the UI promise more than the control does",
        control: "A CI sweep for overclaiming wording in docs, skills and UI text",
        level: "advisory",
        proofs: [unit("scripts/test/security-map.test.ts", "docs and the UI do not overclaim")],
        limit: "A text sweep. It catches the common wordings, not every overclaim.",
      },
    ],
  },
  {
    title: "Prompt injection",
    threats: [
      {
        id: "INJ-2",
        threat: "An agent convinced by a document, trace or repository file to escalate",
        control:
          "Authority is outside the agent: the policy and the researcher's decisions do not read its context",
        level: "enforced",
        proofs: [
          srv("security-agent", "whatever a task or record says, the policy does not move"),
          srv("agent-policy", "repository files never change the policy"),
        ],
        limit:
          "Inside what the policy and its harness allow, a convinced agent can still do bad work: wrong experiments, misleading notes. Reviewing evidence is the researcher's job.",
      },
      {
        id: "INJ-5",
        threat:
          "An agent (or text it wrote) passes itself off as the researcher's direction, which `ablationkit mcp` presents to agents as the researcher's words rather than as data (ADR 0057)",
        control:
          "Directions are written only on the human API with a researcher session; the agent API refuses an agent token that tries (403 `researcher_only`, audited) and has no close, reopen or withdraw routes. The MCP block quotes only the researcher's text and names the target by ID, not by the title an agent wrote",
        level: "authoritative",
        proofs: [
          srv("directions", "the researcher writes one; an agent cannot"),
          unit(MCP, "the researcher's directions (ADR 0057)"),
          WEB("directions (ADR 0057)"),
        ],
        limit:
          "Attribution, not a boundary (ADR 0040): a process running as the researcher can reach the login socket and get a human session, as in AUTH-1; the agent guard (AUTH-10) denies that to Claude Code and Codex. Nothing checks that an agent acts on a direction or that its answer is true.",
      },
      {
        id: "INJ-6",
        threat:
          "An agent (or text it recorded) passes itself off as the researcher's agenda, which `ablationkit mcp` presents as the researcher's instruction (ADR 0058)",
        control:
          "The agenda is written only through `PUT /agenda` on the human listener with a human session; the agent listener has only `GET /agenda`, so no agent token can author what `ablationkit mcp` presents as the researcher's instruction (it presents only the coordinator's agenda and change notice, saying they were written in the web UI)",
        level: "authoritative",
        proofs: [
          srv("agenda", "the researcher writes it; an agent cannot"),
          srv("listeners", "the agent table has no policy-edit"),
          unit(MCP, "the researcher's agenda (ADR 0058)"),
        ],
        limit:
          "Whether an agent follows the agenda is up to the agent: which item a job or task serves is its own declaration, and the agenda's checks (`off_agenda`, `parked_work`) advise; nothing refuses work on a Parked or Dropped item. A note that quotes the agenda is still recorded content, and other text in an agent's context can claim to be the researcher; the MCP framing says where the real agenda comes from (advisory). The compute limit, not the agenda, holds spending.",
      },
      {
        id: "INJ-4",
        threat: "A skill leads an agent to treat recorded content as commands",
        control: "Every bundled skill states that recorded content is data",
        level: "advisory",
        proofs: [
          srv("security-agent", "every Agent Skill that reads recorded content says it is data"),
        ],
      },
    ],
  },
  {
    title: "Extensions",
    threats: [
      {
        id: "EXT-1",
        threat:
          "A view escapes its frame: cookies, network, parent DOM, popups, top navigation, forms, beacons",
        control: "Opaque-origin `sandbox allow-scripts`; CSP with no network; nonce-only scripts",
        level: "enforced",
        proofs: [
          WEB("extensions: approved views render in opaque-origin sandboxes"),
          srv("extensions", "an agent-authored extension is validated and built"),
        ],
      },
      {
        id: "EXT-2",
        threat:
          "Malicious bridge payloads: wrong shapes, inherited names, other projects, huge bodies",
        control: "Project, build, contribution, method and capability checked on every call",
        level: "enforced",
        proofs: [
          srv(
            "extensions",
            "the bridge checks project, build, contribution, method and capability",
          ),
          srv("extensions", "malicious bridge payloads are refused with a code"),
        ],
      },
      {
        id: "EXT-3",
        threat: "An extension exhausts quotas, storage or the console",
        control: "Per-capability quotas, data quotas and bounded logs",
        level: "enforced",
        proofs: [
          srv(
            "extensions",
            "an approved demo predicts through the scoped bridge with an allowlist and quotas",
          ),
          srv("extension-data", "quotas cover combined collection and blob bytes"),
          srv("extensions", "malicious bridge payloads are refused with a code"),
        ],
      },
      {
        id: "EXT-4",
        threat: "Source that smuggles a symlink, an oversized tree or an import from outside",
        control: "The scan refuses links and sizes; UI entries import only the SDK and React",
        level: "authoritative",
        proofs: [
          srv("extensions", "source: a symlink, an oversized file or too many files never build"),
          srv("extensions", "UI entries may import only the SDK and React"),
          srv("extension-build-policy", "outside relative dependencies are rejected"),
          unit("packages/extension-host/test/host.test.ts", "paths must stay inside the extension"),
        ],
      },
      {
        id: "EXT-5",
        threat: "Approved bytes changed on disk afterwards",
        control:
          "The frame and the Python runner re-check hashes; a changed tree needs a new build (enabled as built, ADR 0045, or approved when `require_approval` is set)",
        level: "authoritative",
        proofs: [
          srv("extensions", "a tampered snapshot: the frame and the Python runner refuse"),
          srv("extensions", "the same extension needs its own approval in a second project"),
        ],
        limit:
          "This detects changes before a run. Approved Python runs as trusted code under the researcher's user, so its behavior once running is advisory (spec §7.11).",
      },
      {
        id: "EXT-6",
        threat:
          "A Python contribution returns artifacts outside its output area, or calls the broker for more",
        control: "Results checked for links, paths and sizes; the broker checks capabilities",
        level: "authoritative",
        proofs: [
          srv("extensions", "Python results: artifacts outside the output area"),
          unit(
            "python/ablationkit-extension/tests/test_runner.py",
            "test_remote_broker_stays_inside_its_capabilities",
          ),
        ],
      },
      {
        id: "EXT-7",
        threat: "Backends spoof identity, escape their data namespace or call unapproved hosts",
        control: "The host supplies identity; pinned namespaces; network policy with no redirects",
        level: "authoritative",
        proofs: [
          srv(
            "extension-backends",
            "pins broker data to the invoking project and extension namespace",
          ),
          srv("extension-backends", "uses the host caller identity when a backend spoofs"),
          srv("extension-data", "rejects traversal and symlinks"),
          srv(
            "extension-policy",
            "rejects cross-origin, prefix escapes and ambiguous encoded paths",
          ),
          srv("extension-policy", "rejects redirects even with an injected fetch"),
          srv(
            "extension-policy",
            "blocks caller supplied credentials and sensitive or routing headers",
          ),
        ],
        limit:
          "Backends are trusted code in their own process: these bind the broker, not the process.",
      },
      {
        id: "EXT-8",
        threat: "A broken extension or modified build stops the researcher recovering",
        control: "Safe mode; Level 2 activation is human-only and only changes the next start",
        level: "enforced",
        proofs: [
          srv("extensions", "safe mode keeps every extension inactive"),
          srv(
            "extensions",
            "a modified build is listed with its checks; activation only changes the next start",
          ),
        ],
      },
      {
        id: "EXT-9",
        threat:
          "An agent-written vault figure (ADR 0053) escapes its frame, or does more than read the project's runs",
        control:
          "The extension views' sandbox (opaque-origin `sandbox allow-scripts`, CSP with no network, nonce-only scripts); the coordinator answers only the read-only run methods, for a live figure of the project, from the researcher's page; safe mode stops figures",
        level: "enforced",
        proofs: [
          srv(
            "vault",
            "a figure is a note whose script draws it in a sandboxed frame that can only read runs",
          ),
          WEB("vault figures draw in opaque-origin sandboxes from the runs"),
        ],
        limit:
          "A figure's script is code its writer chose: it can show the researcher anything, and nothing stops it typing numbers in instead of reading them from the runs (the field's description and the skills say not to; advisory). Like an extension view it can navigate its own frame to an address that carries what it read; what it can read, an agent can already read through MCP.",
      },
    ],
  },
  {
    title: "Remote compute",
    threats: [
      {
        id: "REM-1",
        threat: "A second worker reports for the same attempt, from a copied bundle",
        control:
          "The first worker's ID is recorded; others are refused and flagged, nothing is rerun",
        level: "authoritative",
        proofs: [
          srv("security-remote", "a second worker ID is refused and flagged on every route"),
          srv("remote", "a second worker for the same attempt is refused and flagged"),
        ],
        limit:
          "The worker ID is a duplicate-execution guard, not a credential: a party holding the attempt's token can present any ID. The token is the boundary (REM-2).",
      },
      {
        id: "REM-2",
        threat: "A worker token used beyond its job, or a launch token used to upload",
        control: "Tokens are bound to job and attempt; a launch token only hand-shakes and pulls",
        level: "enforced",
        proofs: [
          srv("security-routes", "a worker token cannot act for another job or attempt"),
          srv("security-remote", "a launch token only hand-shakes"),
          srv("listeners", "a worker token can only upload for its own job attempt"),
          unit(
            "packages/auth/test/auth.test.ts",
            "remote worker tokens: short-lived upload tokens",
          ),
        ],
      },
      {
        id: "REM-3",
        threat: "Uploads with hostile paths, sizes, IDs or the wrong bytes",
        control: "The artifact path validator, declared sizes and a checksum before MLflow sees it",
        level: "enforced",
        proofs: [
          srv("security-remote", "resumable uploads: hostile paths, sizes and IDs are refused"),
        ],
      },
      {
        id: "REM-4",
        threat: "A bundle changed in transit or on the target, pushed or pulled",
        control:
          "Each file checked against the manifest; a pulled archive checked by hash, links refused",
        level: "authoritative",
        proofs: [
          unit(
            "python/ablationkit-worker/tests/test_worker.py",
            "test_a_changed_bundle_file_is_refused",
          ),
          srv("security-remote", "a tampered bundle served to a pod is refused by checksum"),
          srv("security-remote", "a bundle holding a link is refused"),
        ],
        limit:
          "Someone in control of the target can change the worker too. The check catches corruption and a tampered transfer; it does not make the target trustworthy, so results from a target are as trustworthy as the target.",
      },
      {
        id: "REM-5",
        threat:
          "A crafted import archive: traversal, links to coordinator files, hostile staged uploads",
        control: "Names checked before unpacking; links refused; each staged upload validated",
        level: "enforced",
        proofs: [
          srv(
            "security-remote",
            "links, traversal and absolute names are refused before anything is read",
          ),
          srv("security-remote", "hostile staged uploads and malformed records are rejected"),
          srv("security-remote", "a journal event claiming another attempt is refused"),
        ],
        limit: "Archive size is not bounded: a researcher chooses which archive to import.",
      },
      {
        id: "REM-6",
        threat: "A stolen secret: Runpod key, store keys, provider keys",
        control:
          "Keys stay in environment variables; workers get presigned URLs; keyed providers stay local",
        level: "authoritative",
        proofs: [
          srv("security-remote", "Runpod: a literal key is never accepted"),
          srv("remote", "a notebook carries the verified bundle and no credentials"),
          srv("remote-llm-evaluations", "a GenAI evaluation runs as a job on a target"),
          srv("security-remote", "a receipt cannot name another attempt's object"),
        ],
      },
      {
        id: "REM-7",
        threat: "A model package fetched without the right token, late, or tampered with",
        control: "A per-deployment token stored only as a hash; refused once stopped or expired",
        level: "enforced",
        proofs: [
          srv("remote-endpoints", "the fetch token is the only key"),
          srv("security-remote", "a tampered model package is refused by checksum"),
        ],
      },
      {
        id: "REM-8",
        threat: "Store receipts for another attempt's slot, an expired slot or a changed object",
        control:
          "Keys derive from the attempt; expired slots fall back; objects are hashed and deleted",
        level: "enforced",
        proofs: [
          srv("security-remote", "a receipt cannot name another attempt's object"),
          srv("remote-store", "a large artifact goes to the store while the coordinator is off"),
          unit(
            "python/ablationkit-worker/tests/test_worker.py",
            "test_expired_store_slots_fall_back",
          ),
        ],
      },
      {
        id: "REM-9",
        threat: "Job submission stages extra local paths into a bundle",
        control: "`bundle_inputs` is internal; only pinned commits are bundled",
        level: "enforced",
        proofs: [
          srv("security-remote", "job submission over HTTP cannot stage extra paths"),
          srv("remote", "submission checks: pinned commits only"),
        ],
      },
    ],
  },
  {
    title: "Backup, restore and the desktop shell",
    threats: [
      {
        id: "OPS-1",
        threat: "A crafted backup writes outside the home, into `.git/hooks`, or through a symlink",
        control: "Only manifest files, checked by hash, in two project trees, never behind a link",
        level: "authoritative",
        proofs: [
          srv(
            "restore",
            "restore refuses an occupied home, a damaged backup and paths outside the backup",
          ),
          srv("restore", "crafted backups: extra files, foreign checkout paths"),
        ],
        limit:
          "The manifest proves integrity, not origin. A backup holds settings and the token store, so restore only backups you made.",
      },
      {
        id: "OPS-2",
        threat: "A retired home restarts, so two coordinators write at once",
        control: "`moved.json` stops start and restore; a damaged marker fails closed",
        level: "authoritative",
        proofs: [
          srv("restore", "a retired home stays retired"),
          srv("restore", "coordinator move: backs up a stopped coordinator"),
        ],
      },
      {
        id: "OPS-3",
        threat: "A restore scheduled without the researcher",
        control:
          "`backup.restore` is on the human API only (a human session); it only applies at the next start",
        level: "authoritative",
        proofs: [
          srv("restore", "a restore scheduled from the System page replaces the home"),
          srv("listeners", "privileged human actions are on the human table only"),
        ],
        limit: "Whoever holds a human session can schedule one (AUTH-1).",
      },
      {
        id: "OPS-4",
        threat: "A page in the desktop app reaches Node, IPC, other origins or device permissions",
        control:
          "Sandboxed, isolated windows with no preload; IPC answers only the connection page",
        level: "enforced",
        proofs: [
          unit(
            "apps/desktop/test/policy.test.ts",
            "every window is sandboxed, isolated and without Node",
          ),
          unit("apps/desktop/test/policy.test.ts", "navigation stays on the coordinator"),
          unit(
            "apps/desktop/test/policy.test.ts",
            "only notifications (and sanitized clipboard writes)",
          ),
          DESK("managed: the web UI of a running coordinator, sandboxed"),
          DESK("remote: the connection page takes a URL and a one-time link"),
        ],
      },
    ],
  },
];

/** Accepted, by the trust model. Stated so nobody assumes otherwise. */
export const OUT_OF_SCOPE: readonly string[] = [
  "**Anything running as the researcher can read what the researcher can** (spec §7.11), including `~/.ssh` and `~/.ablationkit`. Jobs and approved Python extensions run unsandboxed.",
  "**The agent's own session is the user's harness's to contain** (ADRs 0037, 0039): its sandbox, its network, its edits, its Git, its runtime requests and what it sends to its model provider. AblationKit decides only what the agent asks AblationKit to do through `ablationkit mcp`, whose session token says which project and session the agent is, not what else it can reach (ADR 0040).",
  "**Jobs have ordinary host and network access** in v1.0. A job's `metrics_file` or artifact can be a symlink to anything the job could read anyway.",
  "**The researcher's own Git and shell commands** are not governed.",
  "**Compute targets are as trustworthy as whoever runs them.** Checks catch corruption and tampered transfers, and a hostile target cannot reach beyond its own attempt, but its metrics are what it reports.",
  "**A real MinIO or S3 server** has not been run against the artifact store; the tests use a fake that checks presigned URLs are signed, not that the signature is valid.",
];
