import type { TokenRecord } from "@ablationkit/protocol";
import { isLoopbackHost } from "../config.ts";
import { HttpError } from "../http.ts";
import type { Services } from "../services.ts";
import type { AuditEntry } from "../state/audit.ts";
import type { HumanCall, HumanHandler } from "./human.ts";

/** Bearer token from `Authorization: Bearer …`. */
export function bearer(req: Request): string | undefined {
  const h = req.headers.get("authorization");
  if (!h) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m?.[1];
}

/**
 * Reject requests whose Host is not one we serve (DNS-rebinding defense). `extra` are the hosts
 * of trusted origins (for example a Tailscale name proxied to this listener).
 */
export function checkHost(req: Request, port: number, extra: readonly string[] = []): void {
  const host = req.headers.get("host");
  if (!host) throw new HttpError(400, "bad_host", "missing Host header");
  if (extra.includes(host)) return;
  const m = /^(\[[0-9a-fA-F:]+\]|[^:]+)(?::([0-9]+))?$/.exec(host);
  if (m && isLoopbackHost(m[1] as string) && Number(m[2] ?? "80") === port) return;
  throw new HttpError(421, "bad_host", `this listener does not serve host ${host}`);
}

export function notFound(): HttpError {
  return new HttpError(404, "not_found", "no such route on this listener");
}

/** An agent token reaches only its own project (spec §7.11); a refusal is audited. */
export function requireProject(svc: Services, token: TokenRecord, projectId: string): void {
  if (token.scope.project_id === projectId) return;
  svc.audit.record({
    actor: { kind: "agent", id: token.token_id },
    listener: "agent",
    action: "agent.scope_check",
    outcome: "denied",
    project_id: token.scope.project_id,
    target: projectId,
    reason: "token is not bound to this project",
  });
  throw new HttpError(403, "forbidden_scope", "this token is not bound to that project");
}

export function session(action: string, run: HumanHandler["run"]): HumanHandler {
  return { auth: "session", action, run };
}

/** An allowed human action, audited. */
export function audit(c: HumanCall, action: string, extra: Partial<AuditEntry> = {}): void {
  c.svc.audit.record({
    outcome: "allowed",
    ...extra,
    actor: { kind: "human", id: c.session.token_id },
    listener: "human",
    action,
  });
}
