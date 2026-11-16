/**
 * Append-only audit journal (`<home>/audit/audit-NNNN.jsonl`, spec §13). Every authentication
 * event, privileged attempt and mutation is recorded, allowed or denied. Never contains secrets.
 */
import { JsonlLog, readJsonl } from "@ablationkit/core";
import { type AuditRecord, validateAuditRecord } from "@ablationkit/protocol";

export type AuditInput = Omit<AuditRecord, "seq" | "schema_version" | "ts">;
type OptionalKeys = "project_id" | "target" | "reason" | "details";

/** What callers pass: optional fields may be `undefined` and are dropped. */
export type AuditEntry = Omit<AuditInput, OptionalKeys | "actor"> & {
  actor: { kind: AuditInput["actor"]["kind"]; id?: string | undefined };
} & { [K in OptionalKeys]?: AuditInput[K] | undefined };

/** `T` with `undefined`-able keys made optional and `undefined` removed from their types. */
export type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drop undefined-valued keys (records never carry explicit undefined or null). */
export function compact<T extends object>(o: T): Compact<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Compact<T>;
}

export class AuditLog {
  private readonly log: JsonlLog<AuditRecord>;

  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.log = JsonlLog.open<AuditRecord>(dir, { name: "audit", validate: validateAuditRecord });
  }

  get recovery(): JsonlLog<AuditRecord>["recovery"] {
    return this.log.recovery;
  }

  record(entry: AuditEntry): AuditRecord {
    const actor = compact(entry.actor);
    return this.log.append(
      compact({
        schema_version: 1 as const,
        ts: this.now().toISOString(),
        ...entry,
        actor,
      }) as Omit<AuditRecord, "seq">,
    );
  }

  /** Records with seq > after, up to `limit`. */
  async read(after = -1, limit = 100): Promise<AuditRecord[]> {
    const out: AuditRecord[] = [];
    for await (const r of readJsonl<AuditRecord>(this.dir, { name: "audit", fromSeq: after + 1 })) {
      if (r.seq <= after) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  close(): void {
    this.log.close();
  }
}
