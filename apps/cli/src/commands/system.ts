/** `ablationkit system status`: startup diagnostics (spec §13), safe mode, restore and store (ADR 0025). */
import { CoordinatorClient } from "../client.ts";
import { type CliContext, flag, parseArgs, printJson, UsageError } from "../context.ts";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  items?: string[];
}

interface Operations {
  diagnostics: { at: string; status: string; checks: Check[] };
  safe_mode: boolean;
  restored: { backup_id: string; restored_at: string } | null;
  pending_restore: { backup_id: string } | null;
  artifact_store: {
    configured: boolean;
    endpoint?: string;
    bucket?: string;
    reachable?: boolean;
    error?: string;
  };
  home: string;
}

const MARK = { ok: "ok  ", warn: "WARN", fail: "FAIL" } as const;

export async function systemCommand(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest, ["json"]);
  if (sub !== "status")
    throw new UsageError("usage: ablationkit system status [--json] [--coordinator URL]");
  const client = await CoordinatorClient.connect(ctx, flag(args, "coordinator"));
  const r = await client.request<Operations>("GET", "/api/v1/system/operations");
  if (args.flags["json"] === true) {
    printJson(ctx, r);
    return r.diagnostics.status === "fail" ? 1 : 0;
  }
  ctx.out(`coordinator home ${r.home}: ${r.diagnostics.status}\n`);
  if (r.safe_mode) ctx.out("SAFE MODE: every extension is inactive\n");
  if (r.pending_restore)
    ctx.out(
      `restore of backup ${r.pending_restore.backup_id} pending: applied at the next start\n`,
    );
  for (const c of r.diagnostics.checks) {
    ctx.out(`  ${MARK[c.status]} ${c.name}: ${c.detail}\n`);
    for (const i of c.items ?? []) ctx.out(`         ${i}\n`);
  }
  const s = r.artifact_store;
  ctx.out(
    s.configured
      ? `  artifact store ${s.endpoint} bucket ${s.bucket}: ${s.reachable ? "reachable" : `unreachable (${s.error ?? "?"})`}\n`
      : "  artifact store: not configured (remote workers upload through the coordinator)\n",
  );
  return r.diagnostics.status === "fail" ? 1 : 0;
}
