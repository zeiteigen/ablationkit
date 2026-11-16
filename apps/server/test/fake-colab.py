"""A fake of Google's Colab CLI (`colab`) for the Colab runtime tests (ADR 0059).

A "runtime" is this machine: remote paths are local paths, `exec -f FILE` runs the file with
python3 in its own session (so, like a Colab kernel, the execution continues when the client is
killed), and the file API (`upload`, `download`) copies files. Accounting mimics `colab usage`:
each GPU runtime adds 1.5 compute units per hour. Environment switches for the tests:

  FAKE_COLAB_SIGNED_OUT=1   behave like a CLI that is not signed in (print the sign-in link, then
                            fail reading the code from a closed stdin)
  FAKE_COLAB_REFUSE=<GPU>   refuse that accelerator like an account without entitlement

  FAKE_COLAB_HANG_EXECS=<n> the first n `exec` calls on a runtime hang before running anything

An upload into a directory that does not exist fails with the CLI's HTTP error, which carries a
token, as the real file API does.

Session state lives in the `--config` file; the runtimes' process IDs next to it.
"""

import contextlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time

GPU_RATE = 1.5


def main(argv: list[str]) -> int:
    config = os.path.expanduser("~/.config/colab-cli/sessions.json")
    args = list(argv)
    while args and args[0].startswith("--"):
        flag = args.pop(0)
        value = args.pop(0)
        if flag == "--config":
            config = value
    if not args:
        print("usage: colab COMMAND", file=sys.stderr)
        return 2
    cmd, rest = args[0], args[1:]
    if cmd == "version":
        print("Version: 0.8.0-fake")
        return 0
    if os.environ.get("FAKE_COLAB_SIGNED_OUT") == "1":
        print("\nTo authorize colab-cli, visit this URL in any browser:\n", file=sys.stderr)
        print(
            "  https://accounts.google.com/o/oauth2/auth?client_id=fake&state=x\n", file=sys.stderr
        )
        print("After approving, Google will display an authorization code.", file=sys.stderr)
        sys.stdout.write("Enter the authorization code: ")
        sys.stdout.flush()
        try:
            input()
        except EOFError:
            print("EOFError: EOF when reading a line", file=sys.stderr)
        return 1

    def load() -> dict:
        try:
            with open(config) as f:
                return json.load(f)
        except FileNotFoundError:
            return {}

    def save(d: dict) -> None:
        os.makedirs(os.path.dirname(config) or ".", exist_ok=True)
        with open(config + ".tmp", "w") as f:
            json.dump(d, f)
        os.replace(config + ".tmp", config)

    def opt(name: str) -> str | None:
        return rest[rest.index(name) + 1] if name in rest else None

    positional = []
    i = 0
    while i < len(rest):
        if rest[i] in ("-s", "-f", "--gpu", "--tpu", "--timeout"):
            i += 2
            continue
        if rest[i].startswith("--"):
            i += 1
            continue
        positional.append(rest[i])
        i += 1
    name = opt("-s")
    sessions = load()

    if cmd == "usage":
        rate = sum(GPU_RATE for s in sessions.values() if s.get("gpu"))
        print(f"Current balance: {100 - len(sessions) * 0.5:.2f} compute units")
        print(f"Usage rate: {rate:.2f}/hr")
        print(f"Active assignments: {len(sessions)}")
        return 0
    if cmd == "sessions":
        if not sessions:
            print("[colab] No active sessions found on server.")
        for n, s in sessions.items():
            print(f"[{n}] fake-{n} | Hardware: {s.get('gpu') or 'CPU'} | Variant: DEFAULT")
        return 0
    if cmd == "new":
        gpu = opt("--gpu")
        print(f"[colab] Creating session '{name}'...")
        if gpu and gpu == os.environ.get("FAKE_COLAB_REFUSE"):
            print(
                f"[colab] Backend rejected accelerator '{gpu}'. You may not have quota or "
                "entitlement for this accelerator on your account.",
                file=sys.stderr,
            )
            return 1
        sessions[name] = {"gpu": gpu, "pids": []}
        save(sessions)
        print("[colab] Session READY.")
        return 0
    if name not in sessions:
        print(f"[colab] Session '{name}' not found.")
        return 1
    if cmd == "stop":
        for pid in sessions[name].get("pids", []):
            with contextlib.suppress(OSError):
                os.killpg(pid, signal.SIGKILL)
        del sessions[name]
        save(sessions)
        print(f"[colab] Stopping session '{name}'...")
        print("[colab] Session terminated.")
        return 0
    if cmd == "upload":
        local, remote = positional
        if not os.path.isdir(os.path.dirname(remote)):
            print(
                "[colab] Upload failed: 500 Server Error: Internal Server Error for url: "
                f"https://8080-fake.colab.dev/api/contents{remote}?authuser=0&colab-runtime-proxy-token=eyJhbGciOi.eyJhdWQiOiJt.XiTeMEfHQbgT"
            )
            return 1
        shutil.copyfile(local, remote)
        print(f"[colab] Uploaded '{local}' to '{remote}'")
        return 0
    if cmd == "download":
        remote, local = positional
        if not os.path.isfile(remote):
            print(f"[colab] Download failed: File or directory not found: {remote}")
            return 1
        shutil.copyfile(remote, local)
        print(f"[colab] Downloaded '{remote}' to '{local}'")
        return 0
    if cmd == "exec":
        file = opt("-f")
        hangs = int(os.environ.get("FAKE_COLAB_HANG_EXECS", "0"))
        count = sessions[name].get("execs", 0)
        sessions[name]["execs"] = count + 1
        save(sessions)
        if count < hangs:
            # Like CLI 0.8.0 attaching to a runtime's kernel: hang before anything runs.
            time.sleep(3600)
            return 1
        log = config + f".{name}.{time.time_ns()}.log"
        with open(log, "wb") as out:
            p = subprocess.Popen(
                [sys.executable, file],
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                env={k: v for k, v in os.environ.items() if not k.startswith("FAKE_COLAB_")},
            )
        sessions[name].setdefault("pids", []).append(p.pid)
        save(sessions)
        # Stream the kernel's output; a killed client leaves the execution running.
        pos = 0
        while True:
            done = p.poll() is not None
            with open(log, "rb") as f:
                f.seek(pos)
                chunk = f.read()
            if chunk:
                pos += len(chunk)
                sys.stdout.write(chunk.decode(errors="replace"))
                sys.stdout.flush()
            if done:
                break
            time.sleep(0.1)
        return 0
    print(f"fake colab: unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
