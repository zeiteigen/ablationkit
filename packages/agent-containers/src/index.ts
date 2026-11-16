/**
 * Agent containers (ADR 0061): the pure half. The egress allowlist and which addresses are
 * public, a project's container configuration and its checks, the harnesses, the Podman command
 * lines for agent and job containers, and the provenance a session records. The coordinator's
 * `agents/containers.ts` runs what this plans.
 */
export * from "./allowlist.ts";
export * from "./config.ts";
export * from "./harness.ts";
export * from "./paths.ts";
export * from "./plan.ts";
export * from "./provenance.ts";
