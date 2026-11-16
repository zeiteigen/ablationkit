# Agent containers

An opt-in hardened mode (ADR 0061). Normally an agent runs in your harness as you, and AblationKit decides only what the agent asks AblationKit to do: its jobs, its deployments, the compute they use ([project permissions](project-permissions.md)). In an agent container, the coordinator runs your harness (Claude Code, Codex or a shell) in a rootless Podman container it owns, and decides what the agent itself can reach.

## What changes for the agent

| | In your harness | In an agent container |
| --- | --- | --- |
| GPU | the agent's shell can use it | none: GPU work runs as jobs, which the compute limit and the witness count |
| Network | your harness's sandbox decides | none of its own: an egress proxy applies the project's allowlist, connects only to public addresses and records every connection |
| AblationKit's home and login socket | reachable unless the agent guard holds | not mounted: the session's token is the only way in, and it is bound to the project |
| Hidden data (held-out sets, evaluation code) | readable | not mounted (outside the checkout) or masked (inside it) |
| Local jobs | run on this machine as you | run in job containers: the GPU through CDI, no network unless allowed, hidden paths masked |
| Extension builds and runs | allowed by the policy | refused by default: they run project code on this machine outside a container |
| Your control | end its session | pause, resume, stop, read its terminal and its egress; the compute limit pauses it |

The agent still uses AblationKit through `ablationkit mcp` (inside the container, `ablationkit mcp --contained`, registered for it), with the same tools and the same project policy.

## Set up

1. Install Podman (rootless) and tmux. On Arch Linux: `sudo pacman -S podman passt tmux`.
2. For GPU jobs, generate a CDI spec once: `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`.
3. `ablationkit agent doctor` checks all three. `ablationkit agent image build` builds the image (Debian with Git, Python and common tools; the harness, bun and uv are mounted from this machine, so the container runs your versions).
4. Sign the harness in the first time: the container's home is kept per project and harness, so log in inside the first session (Claude Code's `/login`, `codex login`) and it stays signed in.

## Run a session

In a registered checkout, `ablationkit agent start` starts Claude Code; `--harness codex` or `--harness shell` the others, and arguments after `--` go to the harness. Your terminal attaches to the container's; detach with Ctrl-b d and return with `ablationkit agent attach SESSION`. The session ends when the harness exits or you stop it (`ablationkit agent stop`, or Stop in the web UI). Then its token is revoked, and its record keeps:

- what changed in the checkout;
- what changed in the project's environment;
- the shell commands the harness's transcript holds.

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
- The harness's own sign-in is in the container's home, readable by the agent.
- The checkout is bind-mounted, so the files a session changed include your own edits made meanwhile.
- HTTPS egress is recorded by host only.
