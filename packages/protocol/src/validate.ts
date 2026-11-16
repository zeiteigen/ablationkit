import type { Static, TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

/** A function that returns its input typed as T, or throws ProtocolValidationError. */
export type Validator<T> = (value: unknown) => T;

export class ProtocolValidationError extends Error {
  readonly schema: string;
  readonly issues: readonly string[];

  constructor(schema: string, issues: readonly string[]) {
    super(`invalid ${schema}: ${issues.slice(0, 5).join("; ")}`);
    this.name = "ProtocolValidationError";
    this.schema = schema;
    this.issues = issues;
  }
}

/** Compile a schema once and return a throwing validator for it. */
export function compileValidator<S extends TSchema>(schema: S): Validator<Static<S>> {
  const checker = TypeCompiler.Compile(schema);
  const name = typeof schema.title === "string" ? schema.title : "value";
  return (value: unknown): Static<S> => {
    if (checker.Check(value)) return value;
    const issues = [...checker.Errors(value)].map(
      (e) => `${e.path === "" ? "/" : e.path}: ${e.message}`,
    );
    throw new ProtocolValidationError(name, issues);
  };
}

/**
 * Fields of removed features (ADR 0037): campaigns, candidate workspaces, task budget policies and
 * passkeys (step-up flags, trusted origins' RP IDs).
 */
const REMOVED_KEYS: ReadonlySet<string> = new Set([
  "campaign_id",
  "candidate_id",
  "budget_policy_id",
  "step_up",
  "rp_id",
]);
/** Kinds of references whose objects no longer exist (ADR 0037). */
const REMOVED_KINDS: ReadonlySet<string> = new Set(["campaign", "candidate"]);

/** A reference (or an item holding one in `ref`) to a removed kind of object. */
function removedRef(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  const ref = o["ref"];
  return (
    REMOVED_KINDS.has(o["kind"] as string) ||
    (ref !== null &&
      typeof ref === "object" &&
      REMOVED_KINDS.has((ref as Record<string, unknown>)["kind"] as string))
  );
}

/**
 * Records written before ADR 0037 carry fields and references of removed features; this drops
 * both from a copy, at any depth.
 */
function withoutRemoved(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((x) => !removedRef(x)).map(withoutRemoved);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (!REMOVED_KEYS.has(k)) out[k] = withoutRemoved(v);
  return out;
}

/**
 * A validator for a record the coordinator stores: a value that fails is checked once more without
 * the fields removed features left behind (ADR 0037) and after `upgrade` (one schema's own removed
 * fields or states), so records written before still load; the next save writes them without.
 */
export function compileStoredValidator<S extends TSchema>(
  schema: S,
  upgrade: (doc: Record<string, unknown>) => Record<string, unknown> = (doc) => doc,
): Validator<Static<S>> {
  const validate = compileValidator(schema);
  return (value: unknown): Static<S> => {
    try {
      return validate(value);
    } catch (e) {
      try {
        const doc = withoutRemoved(value);
        return validate(
          doc && typeof doc === "object" && !Array.isArray(doc)
            ? upgrade(doc as Record<string, unknown>)
            : doc,
        );
      } catch {
        throw e;
      }
    }
  };
}
