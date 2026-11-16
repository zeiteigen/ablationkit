/** Type-only process and invocation state shared by backend lifecycle and brokers. */
import type { BackendCaller, BackendManifest } from "@ablationkit/extension-host/backend";
import type { BridgeRun } from "../tracking/bridge.ts";
import type { ExtensionBackendProcess } from "./backend-process.ts";
import type { ExtensionPolicyRules } from "./policy.ts";

export interface BackendBundle {
  manifest: BackendManifest;
  root: string;
  legacyBridges?: Readonly<Record<string, { plan: string; execute: string }>>;
  migratePolicy?: (stateDir: string, pid: string) => ExtensionPolicyRules | undefined;
}
export interface Invocation {
  actor: BackendCaller;
  allowWiden: boolean;
  canExecute: boolean;
  at: number;
  signal?: AbortSignal;
}
export interface LiveBackend {
  process: ExtensionBackendProcess;
  invocations: Map<string, Invocation>;
  runs: Map<string, BridgeRun>;
  bundle: BackendBundle;
}
