/**
 * `ablationkit login`: print a one-time login link from the local login socket (spec §7.11).
 * `--origin URL` picks a trusted origin (for example the Tailscale name, to open on another
 * machine). `--coordinator URL --code CODE` is the remote-CLI half: it exchanges a code printed
 * on the workstation for a session saved on this machine.
 */
import { exchangeCode, requestLoginLink, saveSession } from "../client.ts";
import { type CliContext, flag, parseArgs, printJson, UsageError } from "../context.ts";

export async function loginCommand(argv: readonly string[], ctx: CliContext): Promise<number> {
  const args = parseArgs(argv, ["json"]);
  const asJson = args.flags["json"] === true;
  const coordinator = flag(args, "coordinator");
  const code = flag(args, "code");
  if (coordinator || code) {
    if (!coordinator || !code) throw new UsageError("--coordinator and --code go together");
    const base = coordinator.replace(/\/+$/, "");
    const s = await exchangeCode(base, code, flag(args, "label") ?? "remote-cli");
    saveSession(ctx.home, base, s.token, s.session_id);
    if (asJson) printJson(ctx, { coordinator: base, session_id: s.session_id });
    else ctx.out(`logged in to ${base} (session ${s.session_id})\n`);
    return 0;
  }
  const link = await requestLoginLink(ctx.home, flag(args, "origin"));
  if (asJson) printJson(ctx, link);
  else {
    ctx.out(`${link.url}\n`);
    ctx.err(
      `One-time link, valid until ${link.expires_at}. For a remote CLI: ablationkit login --coordinator ${link.origin} --code ${link.code}\n`,
    );
  }
  return 0;
}
