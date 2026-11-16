/** What every command gets: injectable for tests. */
export interface CliContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly repoRoot: string;
  out(text: string): void;
  err(text: string): void;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

/** `--name value`, `--name=value` and boolean `--flag`. `booleans` lists flags that take no value. */
export function parseArgs(argv: readonly string[], booleans: readonly string[] = []): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (eq >= 0) flags[name] = a.slice(eq + 1);
    else if (booleans.includes(name)) flags[name] = true;
    else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      flags[name] = v;
      i++;
    }
  }
  return { positional, flags };
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  if (v === true) throw new UsageError(`--${name} needs a value`);
  return v;
}

export function printJson(ctx: CliContext, value: unknown): void {
  ctx.out(`${JSON.stringify(value, null, 2)}\n`);
}
