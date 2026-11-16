/**
 * Short-lived, single-use secrets kept only in memory: login codes.
 * A coordinator restart invalidates all of them, which is the safe direction.
 */
import { randomToken } from "./crypto.ts";

export const LOGIN_CODE_TTL_MS = 2 * 60 * 1000;

interface Entry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export class OneTimeStore<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  issue(value: T): { secret: string; expiresAt: Date } {
    this.sweep();
    const secret = randomToken(32);
    const expiresAt = this.now().getTime() + this.ttlMs;
    this.entries.set(secret, { value, expiresAt });
    return { secret, expiresAt: new Date(expiresAt) };
  }

  /** Remove and return the value, or undefined if unknown, used or expired. */
  consume(secret: string): T | undefined {
    const e = this.entries.get(secret);
    if (!e) return undefined;
    if (e.expiresAt <= this.now().getTime()) {
      this.entries.delete(secret);
      return undefined;
    }
    this.entries.delete(secret);
    return e.value;
  }

  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const t = this.now().getTime();
    for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
  }
}
