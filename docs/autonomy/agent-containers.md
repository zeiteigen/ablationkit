# Agent containers

An opt-in hardened mode (ADR 0061). Normally an agent runs in your harness as you, and AblationKit decides only what the agent asks AblationKit to do: its jobs, its deployments, the compute they use ([project permissions](project-permissions.md)). In an agent container, the coordinator runs your harness (Claude Code, Codex or a shell) in a rootless Podman container it owns, and decides what the agent itself can reach.

## What changes for the agent

| | In your harness | In an agent container |
| --- | --- | --- |
| GPU | the agent's shell can use it | none: GPU work runs as jobs, which the compute limit and the witness count |
| The project's Python environment | the checkout's own `.venv` | none: tests, checks and training all run as jobs (ADR 0066); `uv` and `pip` say so |
| Installing packages | in its shell | an environment build, a job (`ablationkit_job environment`) |
| Network | your harness's sandbox decides | none of its own: an egress proxy applies the project's allowlist, connects only to public addresses and records every connection |
| AblationKit's home and login socket | reachable: an agent on your machine is your operator and may use the whole CLI | not mounted: the session's token is the only way in, and it is bound to the project |
| Hidden data (held-out sets, evaluation code) | readable | not mounted (outside the checkout) or masked (inside it) |
| Local jobs | run on this machine as you | run in job containers: the GPU through CDI unless the job asks for none (`gpu: "none"`), no network unless allowed, the environment read-only, hidden paths masked |
| Extension builds and runs | allowed by the policy | refused by default: they run project code on this machine outside a container |
| Your control | end its session | pause, resume, stop, read its terminal and its egress; the compute limit pauses it |

The agent still uses AblationKit through `ablationkit mcp` (inside the container, `ablationkit mcp --contained`, registered for it), with the same tools and the same project policy.

## Set up

1. Install Podman (rootless) and tmux. On Arch Linux: `sudo pacman -S podman passt tmux`.
2. For GPU jobs, generate a CDI spec once: `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`.
3. `ablationkit agent doctor` checks all three. `ablationkit agent image build` builds the image (Debian with Git, Python and common tools; the harness and bun are mounted from this machine, and uv into job containers, so the containers run your versions).
4. Claude Code starts signed in (ADR 0063). `ablationkit agent start` copies your login from `~/.claude` (`--login-from DIR` for another configuration directory) and keeps the two in step while the session runs: when either side renews it, the fresher login is carried to the other, so neither is signed out. A renewal is carried back to `~/.claude` only for the same subscription and account, and the file it replaces is backed up under `~/.ablationkit/containers/login-backups/`. The container's copy is deleted when the session ends. `--no-login` signs in inside instead, kept per project. Codex: sign in inside the first session (`codex login`); its home is kept per project.

## Run a session

In a registered checkout, `ablationkit agent start` starts Claude Code; `--harness codex` or `--harness shell` the others, and arguments after `--` go to the harness. Your terminal attaches to the container's; detach with Ctrl-b d and return with `ablationkit agent attach SESSION`. The session ends when the harness exits or you stop it (`ablationkit agent stop`, or Stop in the web UI). Then its token is revoked, and its record keeps:

- what changed in the checkout;
- what changed in the project's environment;
- the shell commands the harness's transcript holds.

## The environment and jobs

The agent container has no project environment (ADR 0066). It has no `uv` or `pip` either: stand-ins with those names say what to do instead. The checkout's own `.venv` is hidden from it. Everything that runs the project's code is a job, so it is recorded and counted:

- **Installing packages:** the agent edits `pyproject.toml` and calls `ablationkit_job environment`. That job runs `uv sync` (relocking first, and writing `uv.lock`) in a job container with no GPU, which may reach only `environment.allow`.
  - It starts from a copy of the current environment.
  - Only when it succeeds does the copy become the environment new jobs run in, so running jobs are never changed under them.
  - The project's copies live in `~/.ablationkit/containers/projects/PROJECT/envs/`, the current one named in `environment.json`.
- **Running code:** `ablationkit_job submit` with `environment: "uv"` runs `uv run --frozen --no-sync` in the environment, mounted read-only.
  - It is refused (`environment_not_built`, `environment_stale`) until a build from the checkout's current `uv.lock` has succeeded.
  - Tests and quick checks use `gpu: "none"`: they get no GPU device and run beside a training job without touching its GPU.
- **A refused host in a build** (a private index, a Git dependency elsewhere) is yours to allow: `ablationkit agent allow --environment HOST`.

An environment agents installed before ADR 0066 (`env/`) is adopted on first use, taken as built from the `uv.lock` of that moment. Sessions started earlier keep their old mounts until they end.

**Driving a session from another agent.** An agent of yours on the host (or a script) has no terminal to attach. It can:

1. Start the session with `ablationkit agent start --detach -- "first prompt"`; Claude Code takes a prompt as its argument.
2. Read the session's screen with `ablationkit agent screen SESSION`.
3. Type into it with `ablationkit agent send SESSION TEXT…`. The text is submitted with Enter; `--stdin` reads a longer prompt, `--keys Escape,Enter` sends named keys, and `--no-enter` leaves the text unsubmitted.

Each input is audited with its text.

**Agents**, in the web UI's main navigation, shows every running agent as a tile with its live terminal; each agent's page has its full terminal, its container's facts, controls, egress, record and account (ADR 0065). Settings → Agent sessions and Project settings → Agents list each session too. From these you can:

- read its terminal (read-only);
- read its egress, and allow a refused host in one click;
- pause, resume or stop it.

## Configure a project

`ablationkit agent config edit` opens the project's configuration (`ContainerConfig`); `ablationkit agent allow HOST…` adds to the agents' allowlist, and `--environment` to environment builds'. The fields:

- `image`, and `agent` (CPUs, memory in MB, processes).
- `egress`: `mode` `allowlist` (the default, with GitHub, Hugging Face and where papers live) or `open` (any host, still recorded, for builds too); `allow`: `example.com` (ports 80 and 443), `*.example.com` (subdomains), `example.com:8443`. The harness's own hosts (its model API, sign-in) are always allowed. Package indexes are not here: agents install nothing themselves.
- `environment`: `allow`, the hosts environment builds may reach (by default PyPI, PyTorch's two download hosts, uv's Python downloads and GitHub). A configuration from before ADR 0066 moves its package hosts here on first read, as a new revision.
- `hidden`: paths no agent or ordinary job container sees. Paths inside the checkout are masked in the working tree, not in Git history: keep protected files out of the repository.
- `read_only`: checkout paths the agent can read but not change.
- `jobs`: `gpu` (`all` or `none`; a job can also ask for none itself) and `network` (`none`, the default: jobs read the environment an environment build installed; or `egress`, the agents' allowlist through the attempt's own proxy).
- `evaluations`: protected evaluations. Each is a name, a description, the pinned `command`, `environment` (`uv` or `none`), optional `cwd`, `mounts` (paths from `hidden` it reads) and `runtime_max_sec`. A contained agent runs one with `ablationkit_job submit` and `evaluation: NAME`: its job container mounts those paths read-only, has no network, and runs the pinned command against the agent's current code; the agent reads its metrics but not its console.
- `credentials`: a `name`, `upstream` (`https://…`), `header`, optional `prefix` (`Bearer `), the secret's source (`from_env` in the coordinator's environment, or `from_file`) and `env` for the container (`{"HF_ENDPOINT": "{url}"}`). The container calls `http://127.0.0.1:3129/NAME/…` and the proxy adds the secret, which never enters the container.
- `host_code`: `refuse` (the default) or `allow` extension install, build, action and execute for contained sessions.
- `pause_on_compute_limit`: freeze a session whose job the compute limit refuses (the default); resume it after raising the limit.

## What holds, and what does not

Podman enforces these through the kernel, for what runs in an agent or job container:

- no GPU and no project environment for the agent;
- jobs cannot change the environment (it is mounted read-only); only a build writes a new copy;
- no network but the proxy;
- no coordinator home or login socket;
- hidden paths unreadable and read-only paths unwritable;
- CPU, memory and process limits.

A container is not an absolute guarantee: kernel and runtime bugs are out of scope.

These do not hold:

- CPU work in the agent's shell is still possible within its limits (4 CPUs and 8 GB by default), and unseen. Without the project's environment or a package index it cannot use the ML stack in practice, but the image's `python3`, a compiler, `curl` and GitHub remain, so an agent determined to could fetch an interpreter or build from source.
- An environment build runs the project's build backend (installing the project runs its build code) with access to the package hosts. It is recorded and time-limited like any job, and has no GPU.
- Hidden paths inside the checkout stay in Git history.
- A protected evaluation runs the agent's code with the data mounted; that code could encode what it read in the metrics it logs.
- Remote targets run jobs where they always did.
- Your Claude Code login is in the container while it runs, readable by the agent. A renewal it makes is carried back to `~/.claude`, so a hostile agent could replace your login with a broken one; a backup is kept. Use `--no-login` to keep a separate login.
- The checkout is bind-mounted, so the files a session changed include your own edits made meanwhile.
- HTTPS egress is recorded by host only.
