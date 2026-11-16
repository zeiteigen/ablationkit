/** Host-owned retention continues even while trusted extension code is inactive. */

import type { Services } from "../services.ts";
import type { ExtensionPolicyStore } from "./policy.ts";

export async function sweepExtensionRetention(
  svc: Services,
  policies: ExtensionPolicyStore,
): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const project of svc.registry.list()) {
    const pid = project.project_id;
    const captures = policies.list(pid).flatMap((p) => (p.capture ? [p.capture] : []));
    const experiment = svc.tracking.mappings.getLinks(pid).experiment_id;
    if (!experiment || !captures.length) continue;
    const days = Math.min(...captures.map((capture) => capture.retention_days));
    try {
      let total = 0;
      for (let page = 0; page < 20; page++) {
        const count = await svc.tracking.client.deleteTraces({
          experiment_id: experiment,
          max_timestamp_millis: svc.now().getTime() - days * 86_400_000,
          max_traces: 1000,
        });
        total += count;
        if (count < 1000) break;
      }
      deleted[pid] = total;
      if (total)
        svc.audit.record({
          actor: { kind: "system" },
          listener: "internal",
          action: "extension.trace.retention",
          outcome: "allowed",
          project_id: pid,
          target: experiment,
          details: { deleted: total, retention_days: days },
        });
    } catch {
      // Tracking outages retry on the next sweep; linked experiments are never deleted.
    }
  }
  return deleted;
}
