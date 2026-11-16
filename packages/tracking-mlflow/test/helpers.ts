import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MlflowClient } from "../src/client.ts";
import { MappingStore } from "../src/mapping.ts";
import { Outbox, type OutboxLimits } from "../src/outbox.ts";
import { TrackingService } from "../src/service.ts";
import { FakeMlflow } from "../src/testing.ts";

export class Env {
  readonly dirs: string[] = [];
  readonly cleanups: (() => Promise<void> | void)[] = [];

  tmp(prefix = "ak-trk-"): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    this.dirs.push(d);
    return d;
  }

  fake(): FakeMlflow {
    const f = new FakeMlflow().start();
    this.cleanups.push(() => f.stop());
    return f;
  }

  async service(
    url: () => string | undefined,
    opts: { home?: string; limits?: Partial<OutboxLimits>; timeoutMs?: number } = {},
  ): Promise<{ svc: TrackingService; home: string; outbox: Outbox; mappings: MappingStore }> {
    const home = opts.home ?? this.tmp();
    const outbox = await Outbox.open(
      join(home, "tracking", "outbox"),
      opts.limits ? { limits: opts.limits } : {},
    );
    const mappings = new MappingStore(join(home, "state"));
    mappings.load();
    const svc = new TrackingService({
      client: new MlflowClient({ url, timeoutMs: opts.timeoutMs ?? 2000 }),
      outbox,
      mappings,
      intervalMs: 20,
      maxBackoffMs: 50,
    });
    this.cleanups.push(async () => {
      await svc.stop();
      outbox.close();
    });
    return { svc, home, outbox, mappings };
  }

  async cleanup(): Promise<void> {
    for (const c of this.cleanups.splice(0).reverse()) await c();
    for (const d of this.dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  }
}

export async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition not met in time");
}
