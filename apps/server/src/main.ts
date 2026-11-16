#!/usr/bin/env bun
/** Coordinator process entry point. The systemd user unit runs this (ADR 0009). */
import { resolveHome } from "./config.ts";
import { Coordinator } from "./coordinator.ts";
import { CoordinatorLockedError } from "./state/lock.ts";
import { CoordinatorMovedError } from "./state/restore.ts";

export async function runCoordinator(
  home = resolveHome(),
  opts: { safeMode?: boolean } = {},
): Promise<number> {
  let c: Coordinator;
  try {
    c = await Coordinator.start({ home, ...(opts.safeMode ? { safeMode: true } : {}) });
  } catch (e) {
    console.error(`coordinator: ${(e as Error).message}`);
    // 3: systemd does not restart-loop on it (RestartPreventExitStatus=3).
    return e instanceof CoordinatorLockedError || e instanceof CoordinatorMovedError ? 3 : 1;
  }
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void c.stop().then(resolve);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  return 0;
}

if (import.meta.main) process.exit(await runCoordinator());
