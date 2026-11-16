/** Small utilities shared by the standalone LLM research module. */
export type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drop undefined-valued keys (records never carry explicit undefined or null). */
export function compact<T extends object>(o: T): Compact<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Compact<T>;
}

/** The checkout's HEAD commit, if it is a Git repository. */
export function gitHead(path: string): string | undefined {
  try {
    const p = Bun.spawnSync(["git", "-C", path, "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = p.stdout.toString().trim();
    return p.exitCode === 0 && /^[a-f0-9]{7,64}$/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}
