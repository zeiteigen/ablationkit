# Agent containers

An opt-in hardened mode (ADR 0061). Normally an agent runs in your harness as you, and AblationKit decides only what the agent asks AblationKit to do: its jobs, its deployments, the compute they use ([project permissions](project-permissions.md)). In an agent container, the coordinator runs your harness (Claude Code, Codex or a shell) in a rootless Podman container it owns, and decides what the agent itself can reach.

## What changes for the agent

| | In your harness | In an agent container |
| --- | --- | --- |
| GPU | the agent's shell can use it | none: GPU work runs as jobs, which the compute limit and the witness count |
| Network | your harness's sandbox decides | none of its own: an egress proxy applies the project's allowlist, connects only to public addresses and records every connection |
| AblationKit's home and login socket | reachable: an agent on your machine is your operator and may use the whole CLI | not mounted: the session's token is the only way in, and it is bound to the project |
| Hidden data (held-out sets, evaluation code) | readable | not mounted (outside the checkout) or masked (inside it) |
| Local jobs | run on this machine as you | run in job containers: the GPU through CDI, no network unless allowed, hidden paths masked |
| Extension builds and runs | allowed by the policy | refused by default: they run project code on this machine outside a container |
| Your control | end its session | pause, resume, stop, read its terminal and its egress; the compute limit pauses it |

The agent still uses AblationKit through `ablationkit mcp` (inside the container, `ablationkit mcp --contained`, registered for it), with the same tools and the same project policy.

## Set up

1. Install Podman (rootless) and tmux. On Arch Linux: `sudo pacman -S podman passt tmux`.
2. For GPU jobs, generate a CDI spec once: `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`.
3. `ablationkit agent doctor` checks all three. `ablationkit agent image build` builds the image (Debian with Git, Python and common tools; the harness, bun and uv are mounted from this machine, so the container runs your versions).
4. Claude Code starts signed in (ADR 0063). `ablationkit agent start` copies your login from `~/.claude` (`--login-from DIR` for another configuration directory) and keeps the two in step while the session runs: when either side renews it, the fresher login is carried to the other, so neither is signed out. A renewal is carried back to `~/.claude` only for the same subscription and account, and the file it replaces is backed up under `~/.ablationkit/containers/login-backups/`. The container's copy is deleted when the session ends. `--no-login` signs in inside instead, kept per project. Codex: sign in inside the first session (`codex login`); its home is kept per project.

## Run a session

In a registered checkout, `ablationkit agent start` starts Claude Code; `--harness codex` or `--harness shell` the others, and arguments after `--` go to the harness. Your terminal attaches to the container's; detach with Ctrl-b d and return with `ablationkit agent attach SESSION`. The session ends when the harness exits or you stop it (`ablationkit agent stop`, or Stop in the web UI). Then its token is revoked, and its record keeps:

- what changed in the checkout;
- what changed in the project's environment;
- the shell commands the harness's transcript holds.

**Driving a session from another agent.** An agent of yours on the host (or a script) has no terminal to attach. It can:

1. Start the session with `ablationkit agent start --detach -- "first prompt"`; Claude Code takes a prompt as its argument.
2. Read the session's screen with `ablationkit agent screen SESSION`.
3. Type into it with `ablationkit agent send SESSION TEXT…`. The text is submitted with Enter; `--stdin` reads a longer prompt, `--keys Escape,Enter` sends named keys, and `--no-enter` leaves the text unsubmitted.

Each input is audited with its text.

Settings → Agent sessions and Project settings → Agents list each session with its state. From there you can:

- read its terminal (read-only);
- read its egress, and allow a refused host in one click;
- pause, resume or stop it.

## Configure a project

`ablationkit agent config edit` opens the project's configuration (`ContainerConfig`); `ablationkit agent allow HOST…` adds to the allowlist. The fields:

- `image`, and `agent` (CPUs, memory in MB, processes).
- `egress`: `mode` `allowlist` (the default, with Python packages, uv's Python downloads, PyTorch wheels, Hugging Face and where papers live) or `open` (any host, still recorded); `allow`: `example.com` (ports 80 and 443), `*.example.com` (subdomains), `example.com:8443`. The harness's own hosts (its model API, sign-in) are always allowed.
- `hidden`: paths no agent or ordinary job container sees. Paths inside the checkout are masked in the working tree, not in Git history: keep protected files out of the repository.
- `read_only`: checkout paths the agent can read but not change.
- `jobs`: `gpu` (`all` or `none`) and `network` (`none`, the default: sync the environment before submitting, `uv sync` in the agent container; or `egress`, the allowlist through the attempt's own proxy).
- `evaluations`: protected evaluations. Each is a name, a description, the pinned `command`, `environment` (`uv` or `none`), optional `cwd`, `mounts` (paths from `hidden` it reads) and `runtime_max_sec`. A contained agent runs one with `ablationkit_job submit` and `evaluation: NAME`: its job container mounts those paths read-only, has no network, and runs the pinned command against the agent's current code; the agent reads its metrics but not its console.
- `credentials`: a `name`, `upstream` (`https://…`), `header`, optional `prefix` (`Bearer `), the secret's source (`from_env` in the coordinator's environment, or `from_file`) and `env` for the container (`{"HF_ENDPOINT": "{url}"}`). The container calls `http://127.0.0.1:3129/NAME/…` and the proxy adds the secret, which never enters the container.
- `host_code`: `refuse` (the default) or `allow` extension install, build, action and execute for contained sessions.
- `pause_on_compute_limit`: freeze a session whose job the compute limit refuses (the default); resume it after raising the limit.

## What holds, and what does not

Podman enforces these through the kernel, for what runs in an agent or job container:

- no GPU for the agent;
- no network but the proxy;
- no coordinator home or login socket;
- hidden paths unreadable and read-only paths unwritable;
- CPU, memory and process limits.

A container is not an absolute guarantee: kernel and runtime bugs are out of scope.

These do not hold:

- CPU experiments in the agent's shell are still possible within its limits, and unseen.
- Hidden paths inside the checkout stay in Git history.
- A protected evaluation runs the agent's code with the data mounted; that code could encode what it read in the metrics it logs.
- Remote targets run jobs where they always did.
- Your Claude Code login is in the container while it runs, readable by the agent. A renewal it makes is carried back to `~/.claude`, so a hostile agent could replace your login with a broken one; a backup is kept. Use `--no-login` to keep a separate login.
- The checkout is bind-mounted, so the files a session changed include your own edits made meanwhile.
- HTTPS egress is recorded by host only.
