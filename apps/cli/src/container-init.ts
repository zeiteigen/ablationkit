/**
 * The first process (after the reaper) in an AblationKit agent or job container (ADR 0061), run by
 * the bun mounted from this machine: `bun container-init.ts [--job] -- COMMAND…`.
 *
 * The container has no network. The session's (or attempt's) run directory, mounted read-only at
 * /run/ablationkit, holds the egress proxy's socket and, for an agent session with credentials,
 * the credential routes' socket. This forwards 127.0.0.1:3128 and 127.0.0.1:3129 to them (the
 * container's HTTP(S)_PROXY points at the first), then runs the command with the terminal and
 * exits with its status. Killing it only cuts the container off: there is no other way out.
 *
 * Standalone on purpose: nothing from the rest of the tree is imported, so it starts at once.
 */
import { connect, createServer } from "node:net";

const RUN = "/run/ablationkit";
const PORTS: readonly [number, string][] = [
  [3128, `${RUN}/egress.sock`],
  [3129, `${RUN}/creds.sock`],
];

function forward(port: number, socket: string): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer((client) => {
      const upstream = connect(socket);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.on("error", (e) => {
      process.stderr.write(`ablationkit container init: port ${port}: ${e.message}\n`);
      resolve();
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const dash = argv.indexOf("--");
  const command = dash >= 0 ? argv.slice(dash + 1) : [...argv];
  if (command.length === 0) {
    process.stderr.write("usage: container-init.ts [--job] -- COMMAND...\n");
    return 2;
  }
  // Forwarded whether or not a socket is there yet: a connection reaches it when it is.
  await Promise.all(PORTS.map(([p, s]) => forward(p, s)));
  const child = Bun.spawn([...command], { stdio: ["inherit", "inherit", "inherit"] });
  // The terminal sends ^C to the whole foreground group: the command decides what it means.
  process.on("SIGINT", () => {});
  for (const sig of ["SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"] as const)
    process.on(sig, () => child.kill(sig));
  const code = await child.exited;
  const sig = child.signalCode;
  return sig ? 128 + (typeof sig === "number" ? sig : (SIGNALS[sig] ?? 0)) : code;
}

const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
