import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOGIN_CODE_TTL_MS,
  OneTimeStore,
  parseToken,
  TokenScopeError,
  TokenStore,
  WORKER_GRACE_MS,
} from "../src/index.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ak-auth-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class Clock {
  t = Date.parse("2026-11-02T10:00:00Z");
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

describe("TokenStore", () => {
  test("mints, verifies by kind, and stores only a hash", async () => {
    const path = join(tmp(), "tokens.json");
    const store = new TokenStore(path);
    const { token, record } = store.mint("agent", { scope: { project_id: "p1" } });
    expect(token.startsWith("aka_")).toBe(true);
    expect(store.verify(token, "agent")?.token_id).toBe(record.token_id);
    expect(store.verify(token, "worker")).toBeUndefined();
    expect(store.verify(token, "session")).toBeUndefined();
    const onDisk = await Bun.file(path).text();
    expect(onDisk).not.toContain(parseToken(token)?.secret as string);
    // Reloads from disk.
    expect(new TokenStore(path).verify(token, "agent")?.token_id).toBe(record.token_id);
  });

  test("rejects a tampered secret and unknown ids", () => {
    const store = new TokenStore(join(tmp(), "tokens.json"));
    const { token } = store.mint("session");
    const bad = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(store.verify(bad, "session")).toBeUndefined();
    expect(
      store.verify("aks_0000000000000000.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "session"),
    ).toBeUndefined();
    expect(store.verify("garbage", "session")).toBeUndefined();
  });

  test("enforces scope shape per kind", () => {
    const store = new TokenStore(join(tmp(), "tokens.json"));
    // Agent tokens are bound to a project (ADR 0039).
    expect(() => store.mint("agent", {})).toThrow(TokenScopeError);
    expect(store.mint("agent", { scope: { project_id: "p1" } }).record.scope).toEqual({
      project_id: "p1",
    });
    expect(() => store.mint("worker", { scope: { project_id: "p1", job_id: "j1" } })).toThrow(
      TokenScopeError,
    );
    expect(() => store.mint("session", { scope: { project_id: "p1" } })).toThrow(TokenScopeError);
  });

  test("revocation and expiry", () => {
    const clock = new Clock();
    const store = new TokenStore(join(tmp(), "tokens.json"), clock.now);
    const s = store.mint("session", { ttlMs: 1000 });
    const a = store.mint("agent", { scope: { project_id: "p1" } });
    expect(store.revoke(a.record.token_id, "work done")).toBe(true);
    expect(store.verify(a.token, "agent")).toBeUndefined();
    expect(store.revoke(a.record.token_id, "again")).toBe(false);
    expect(store.verify(s.token, "session")).toBeDefined();
    clock.advance(1000);
    expect(store.verify(s.token, "session")).toBeUndefined();
  });

  test("worker tokens: valid until terminal + 7 days, revoked on reconciliation", () => {
    const clock = new Clock();
    const store = new TokenStore(join(tmp(), "tokens.json"), clock.now);
    const scope = { project_id: "p1", job_id: "j1", attempt_id: "a1" };
    const w1 = store.mint("worker", { scope });
    store.mint("worker", { scope: { ...scope, attempt_id: "a2" } });
    expect(w1.record.expires_at).toBeUndefined();
    clock.advance(365 * 24 * 3600 * 1000);
    expect(store.verify(w1.token, "worker")).toBeDefined();
    expect(store.markJobTerminal("j1", clock.now())).toBe(2);
    clock.advance(WORKER_GRACE_MS - 1);
    expect(store.verify(w1.token, "worker")).toBeDefined();
    clock.advance(1);
    expect(store.verify(w1.token, "worker")).toBeUndefined();
  });

  test("remote worker tokens: short-lived upload tokens, a launch token, one live upload token", () => {
    const clock = new Clock();
    const store = new TokenStore(join(tmp(), "tokens.json"), clock.now);
    const scope = { project_id: "p1", job_id: "j1", attempt_id: "a1" };
    const launch = store.mint("worker", { scope, ttlMs: 30 * 86_400_000, purpose: "launch" });
    const up1 = store.mint("worker", { scope, ttlMs: 60_000 });
    expect(launch.record.purpose).toBe("launch");
    expect(up1.record.purpose).toBeUndefined();
    expect(() => store.mint("agent", { scope: { project_id: "p1" }, purpose: "launch" })).toThrow();
    clock.advance(60_000);
    expect(store.verify(up1.token, "worker")).toBeUndefined(); // stale after a long disconnection
    expect(store.verify(launch.token, "worker")?.purpose).toBe("launch");
    const up2 = store.mint("worker", { scope, ttlMs: 60_000 });
    const up3 = store.mint("worker", { scope, ttlMs: 60_000 });
    expect(store.revokeUploadTokens("a1", up3.record.token_id)).toBe(2); // up1 (expired) and up2
    expect(store.verify(up2.token, "worker")).toBeUndefined();
    expect(store.verify(up3.token, "worker")).toBeDefined();
    expect(store.verify(launch.token, "worker")).toBeDefined();
    // Terminal: the launch token's long horizon shrinks to the grace period.
    store.markJobTerminal("j1", clock.now());
    clock.advance(WORKER_GRACE_MS);
    expect(store.verify(launch.token, "worker")).toBeUndefined();
  });
});

describe("one-time secrets", () => {
  test("login codes are single-use and expire", () => {
    const clock = new Clock();
    const codes = new OneTimeStore<string>(LOGIN_CODE_TTL_MS, clock.now);
    const a = codes.issue("x");
    expect(codes.consume(a.secret)).toBe("x");
    expect(codes.consume(a.secret)).toBeUndefined();
    const b = codes.issue("y");
    clock.advance(LOGIN_CODE_TTL_MS);
    expect(codes.consume(b.secret)).toBeUndefined();
  });
});
