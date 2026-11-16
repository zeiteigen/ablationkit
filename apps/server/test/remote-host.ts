/**
 * A fake remote host for remote-compute tests (ADR 0023): `ssh` runs the remote command on this
 * machine under a separate HOME, and `sbatch`/`sacct`/`squeue`/`scancel` emulate a SLURM cluster
 * (each job is a detached process group). Workers outlive coordinators by design, so
 * `stopRemotes` kills what the tests started.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const remotes: string[] = [];

export function killTree(pid: unknown, group = false): void {
  if (typeof pid !== "number" || pid <= 0) return;
  if (group) {
    // Everything in the session, like a container teardown: `timeout` makes its own group.
    const ps = Bun.spawnSync(["ps", "-eo", "pid=,sid="], { stdout: "pipe" });
    for (const line of ps.stdout.toString().split("\n")) {
      const [p, sid] = line.trim().split(/\s+/).map(Number);
      if (sid === pid && p && p !== pid)
        try {
          process.kill(p, "SIGKILL");
        } catch {
          // gone
        }
    }
  }
  try {
    process.kill(group ? -pid : pid, "SIGKILL");
  } catch {
    // gone
  }
}

export function stopRemotes(): void {
  for (const home of remotes.splice(0)) {
    const wd = join(home, ".ablationkit-worker");
    if (existsSync(wd))
      for (const a of readdirSync(wd)) {
        const read = (p: string): Record<string, unknown> => {
          try {
            return JSON.parse(readFileSync(join(wd, a, p), "utf8"));
          } catch {
            return {};
          }
        };
        const st = read("state.json");
        const job = read("spool/job.json");
        killTree(st["worker_pid"]);
        killTree(st["shim_pid"]);
        killTree(job["pid"], true);
      }
    const slurm = join(home, "slurm");
    if (existsSync(slurm))
      for (const id of readdirSync(slurm).filter((x) => /^[0-9]+$/.test(x))) {
        const pid = Number(readFileSync(join(slurm, id, "pid"), "utf8").trim() || "0");
        killTree(pid, true);
      }
  }
}

export function remoteDir(home: string, attemptId: string): string {
  return join(home, ".ablationkit-worker", attemptId);
}

export function sbatchCount(home: string): number {
  const d = join(home, "slurm");
  return readdirSync(d).filter((x) => /^[0-9]+$/.test(x)).length;
}

/** A fake remote host: `ssh` runs the command locally with HOME set to `home`. */
export function fakeHost(home: string): { home: string; ssh: string; bin: string } {
  remotes.push(home);
  const bin = join(home, "bin");
  const slurm = join(home, "slurm");
  mkdirSync(bin, { recursive: true });
  mkdirSync(slurm, { recursive: true });
  const script = (name: string, body: string): string => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/bash\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const ssh = script(
    "fake-ssh",
    `host="$1"; shift
export HOME=${JSON.stringify(home)}
export PATH=${JSON.stringify(bin)}:"$PATH"
export ABLATIONKIT_WORKER_SUPERVISOR=direct
echo "$host" >> "$HOME/ssh.log"
cd "$HOME"
exec bash -c "$1"`,
  );
  // SLURM: each job is a detached process group; its exit code and cancellation are recorded.
  script(
    "sbatch",
    `[ "$1" = "--parsable" ] && shift
n=$(( $(cat ${slurm}/counter 2>/dev/null || echo 1000) + 1 )); echo $n > ${slurm}/counter
mkdir -p ${slurm}/$n; echo "$PWD/$1" > ${slurm}/$n/script
SLURM_JOB_ID=$n setsid bash -c 'bash "$0" > "slurm-$SLURM_JOB_ID.out" 2>&1; echo $? > ${slurm}/'$n'/exit' "$1" </dev/null >/dev/null 2>&1 &
echo $! > ${slurm}/$n/pid
echo $n`,
  );
  script(
    "sacct",
    `while [ $# -gt 0 ]; do [ "$1" = "-j" ] && id="$2"; shift; done
d=${slurm}/$id; [ -d "$d" ] || exit 0
if [ -f "$d/cancelled" ]; then echo CANCELLED; elif [ -f "$d/exit" ]; then [ "$(cat $d/exit)" = 0 ] && echo COMPLETED || echo FAILED
elif kill -0 $(cat $d/pid) 2>/dev/null; then echo RUNNING; else echo NODE_FAIL; fi`,
  );
  script("squeue", "exit 0");
  script(
    "scancel",
    `d=${slurm}/$1; touch "$d/cancelled"; kill -TERM -- -$(cat "$d/pid") 2>/dev/null; sleep 0.5; kill -KILL -- -$(cat "$d/pid") 2>/dev/null; exit 0`,
  );
  return { home, ssh, bin };
}

interface FakePod {
  id: string;
  name: string;
  desiredStatus: "RUNNING" | "EXITED" | "TERMINATED";
  env: Record<string, string>;
  cmd: string[];
  pid?: number | undefined;
}

/**
 * A fake Runpod REST API (`/pods`) whose pods are local process groups running the pod's start
 * command, with a fake pod-scoped `runpodctl` that calls back into this API.
 */
export class FakeRunpod {
  readonly pods = new Map<string, FakePod>();
  readonly calls: string[] = [];
  private n = 0;
  private server: ReturnType<typeof Bun.serve> | undefined;
  readonly bin: string;

  constructor(
    private readonly home: string,
    readonly key: string,
    private readonly secrets: Record<string, string> = {},
  ) {
    this.bin = join(home, "bin");
    mkdirSync(this.bin, { recursive: true });
    const ctl = join(this.bin, "runpodctl");
    writeFileSync(
      ctl,
      `#!/bin/bash
# runpodctl stop|remove pod ID
m=POST; p="/pods/$3/stop"; [ "$1" = remove ] && { m=DELETE; p="/pods/$3"; }
python3 -c 'import os,sys,urllib.request; urllib.request.urlopen(urllib.request.Request(os.environ["FAKE_RUNPOD_URL"]+sys.argv[2], method=sys.argv[1], headers={"authorization":"Bearer "+os.environ["RUNPOD_API_KEY"]}))' "$m" "$p"
`,
    );
    chmodSync(ctl, 0o755);
    remotes.push(home);
  }

  get url(): string {
    return `http://127.0.0.1:${this.server?.port}`;
  }

  start(): this {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => this.handle(r) });
    return this;
  }

  private spawn(p: FakePod): void {
    const env: Record<string, string> = {
      PATH: `${this.bin}:${process.env["PATH"]}`,
      HOME: this.home,
      RUNPOD_POD_ID: p.id,
      RUNPOD_API_KEY: this.key,
      FAKE_RUNPOD_URL: this.url,
      ABLATIONKIT_WORKER_SUPERVISOR: "direct",
    };
    for (const [k, v] of Object.entries(p.env))
      env[k] = v.replace(
        /\{\{ RUNPOD_SECRET_([A-Za-z0-9_-]+) \}\}/g,
        (_, n) => this.secrets[n] ?? "",
      );
    const proc = Bun.spawn(["setsid", ...p.cmd], {
      env,
      cwd: this.home,
      stdin: "ignore",
      stdout: Bun.file(join(this.home, `${p.id}.out`)),
      stderr: Bun.file(join(this.home, `${p.id}.err`)),
    });
    p.pid = proc.pid;
    writeFileSync(join(this.home, `${p.id}.pid`), String(proc.pid));
  }

  private kill(p: FakePod): void {
    const pid = p.pid;
    p.pid = undefined;
    // After the response, so a pod stopping itself still gets its answer.
    setTimeout(() => killTree(pid, true), 100);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.calls.push(`${req.method} ${url.pathname}`);
    if (req.headers.get("authorization") !== `Bearer ${this.key}`)
      return new Response("unauthorized", { status: 401 });
    const m = url.pathname.match(/^\/pods(?:\/([^/]+))?(?:\/(start|stop))?$/);
    if (!m) return new Response("not found", { status: 404 });
    const [, id, verb] = m;
    if (!id) {
      if (req.method === "GET")
        return Response.json(
          [...this.pods.values()].map(({ id, name, desiredStatus }) => ({
            id,
            name,
            desiredStatus,
          })),
        );
      const b = (await req.json()) as {
        name: string;
        env: Record<string, string>;
        dockerStartCmd: string[];
      };
      const p: FakePod = {
        id: `pod${++this.n}`,
        name: b.name,
        desiredStatus: "RUNNING",
        env: b.env,
        cmd: b.dockerStartCmd,
      };
      this.pods.set(p.id, p);
      this.spawn(p);
      return Response.json(
        { id: p.id, name: p.name, desiredStatus: p.desiredStatus },
        { status: 201 },
      );
    }
    const p = this.pods.get(id);
    if (!p) return new Response("pod not found", { status: 404 });
    if (req.method === "GET")
      return Response.json({ id: p.id, name: p.name, desiredStatus: p.desiredStatus });
    if (req.method === "DELETE") {
      this.kill(p);
      this.pods.delete(id);
      return Response.json({});
    }
    if (verb === "stop") {
      this.kill(p);
      p.desiredStatus = "EXITED";
    } else if (verb === "start" && p.desiredStatus === "EXITED") {
      p.desiredStatus = "RUNNING";
      this.spawn(p);
    }
    return Response.json({ id: p.id, desiredStatus: p.desiredStatus });
  }

  async stop(): Promise<void> {
    for (const p of this.pods.values()) killTree(p.pid, true);
    this.server?.stop(true);
  }
}

/**
 * A minimal S3-compatible store (path-style): presigned PUTs (signature query parameters are
 * required, not verified), HEAD, GET and DELETE. `corruptIf` flips the first byte of the objects
 * whose body it matches, so a tampered upload can be tested.
 */
export class FakeS3 {
  readonly objects = new Map<string, Uint8Array>();
  readonly log: string[] = [];
  corruptIf: ((body: Uint8Array) => boolean) | undefined;
  private server: ReturnType<typeof Bun.serve> | undefined;

  start(): this {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const u = new URL(req.url);
        const key = decodeURIComponent(u.pathname);
        this.log.push(`${req.method} ${key}`);
        if (req.method === "PUT") {
          if (!u.searchParams.get("X-Amz-Signature")) return new Response("", { status: 403 });
          const body = new Uint8Array(await req.arrayBuffer());
          if (body.length && this.corruptIf?.(body)) body[0] = (body[0] ?? 0) ^ 1;
          this.objects.set(key, body);
          return new Response("", { status: 200, headers: { etag: '"e"' } });
        }
        const b = this.objects.get(key);
        if (req.method === "DELETE") {
          this.objects.delete(key);
          return new Response(null, { status: 204 });
        }
        if (!b)
          return new Response("<Error><Code>NoSuchKey</Code></Error>", {
            status: 404,
            headers: { "content-type": "application/xml" },
          });
        return new Response(req.method === "HEAD" ? null : b, {
          headers: { "content-length": String(b.byteLength), etag: '"e"' },
        });
      },
    });
    return this;
  }

  get url(): string {
    return `http://127.0.0.1:${this.server?.port}`;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
  }
}
