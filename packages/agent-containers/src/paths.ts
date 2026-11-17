/** Fixed paths and ports inside every agent and job container (ADR 0061). Pure. */

export const CONTAINER = {
  /** The session's (or attempt's) run directory: sockets, token, MCP config, `bin/ablationkit`. */
  run: "/run/ablationkit",
  /** Binaries mounted from this machine: bun, the harness; uv in job containers only. */
  bin: "/opt/ablationkit/bin",
  /** The agent's home: a directory per project and harness, kept between sessions. */
  home: "/home/agent",
  /**
   * The project's environment (`UV_PROJECT_ENVIRONMENT`) in job containers: read-only in a job,
   * the new copy in an environment build (ADR 0066). Agent containers have none.
   */
  env: "/opt/ablationkit/env",
  /** An environment build's starting point: the current environment, read-only. */
  envBase: "/opt/ablationkit/env-base",
  uvCache: "/opt/ablationkit/uv-cache",
  python: "/opt/ablationkit/python",
} as const;

/** Ports the container's init listens on, forwarding to the run directory's sockets. */
export const EGRESS_PORT = 3128;
export const CREDENTIAL_PORT = 3129;

export const CONTAINER_PATH =
  "/opt/ablationkit/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
