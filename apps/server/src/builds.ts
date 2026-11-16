/**
 * Level 2 source builds (spec §8.5 items 3–4, criterion 15c; ADR 0022 § Level 2). A coding agent
 * changes AblationKit in a Git branch and runs `ablationkit dev build`, which runs the documented
 * checks and writes a reviewable build to `<home>/builds/<build-id>/`. Nothing here replaces the
 * running coordinator: activating a build (`build.activate`, the researcher's session) only records it in
 * `<home>/builds/active.json`, and `ablationkit coordinator start` runs the active build next time.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import { type SourceBuildRecord, validateSourceBuildRecord } from "@ablationkit/protocol";
import { HttpError } from "./http.ts";
import { compact } from "./state/audit.ts";

type Json = Record<string, unknown>;

/** The source tree this process runs from. */
export const RUNNING_ROOT = resolve(import.meta.dir, "../../..");

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
  } catch {
    return undefined;
  }
}

export interface ActiveBuild {
  readonly build_id: string;
  readonly activated_at: string;
  readonly activated_by?: string;
}

export function buildsDir(home: string): string {
  return join(home, "builds");
}

/** The build `coordinator start` should run, if one is active and still present. */
export function activeBuild(
  home: string,
): { record: SourceBuildRecord; active: ActiveBuild } | undefined {
  const f = join(buildsDir(home), "active.json");
  if (!existsSync(f)) return undefined;
  try {
    const active = JSON.parse(readFileSync(f, "utf8")) as ActiveBuild;
    const rec = readJson(
      join(buildsDir(home), active.build_id, "build.json"),
      validateSourceBuildRecord,
    );
    if (!existsSync(join(rec.source_dir, "apps/server/src/main.ts"))) return undefined;
    return { record: rec, active };
  } catch {
    return undefined;
  }
}

export class BuildService {
  constructor(
    private readonly o: {
      readonly home: string;
      readonly now: () => Date;
      readonly root?: string;
      readonly audit: (action: string, actor: { id?: string }, details: Json) => void;
    },
  ) {}

  private get root(): string {
    return this.o.root ?? RUNNING_ROOT;
  }

  list(): SourceBuildRecord[] {
    const d = buildsDir(this.o.home);
    if (!existsSync(d)) return [];
    const out: SourceBuildRecord[] = [];
    for (const n of readdirSync(d)) {
      const f = join(d, n, "build.json");
      if (!/^b-[a-f0-9]{12}-\d+$/.test(n) || !existsSync(f)) continue;
      try {
        out.push(readJson(f, validateSourceBuildRecord));
      } catch {
        // an unreadable build is not offered
      }
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  get(id: string): SourceBuildRecord {
    const b = this.list().find((x) => x.build_id === id);
    if (!b) throw new HttpError(404, "not_found", `no build ${id}`);
    return b;
  }

  /** What is running now, and what will run after the next start. */
  status(): Json {
    const commit = git(this.root, "rev-parse", "HEAD");
    const branch = git(this.root, "rev-parse", "--abbrev-ref", "HEAD");
    const dirty = git(this.root, "status", "--porcelain");
    const running = this.list().find((b) => resolve(b.source_dir) === this.root);
    const next = activeBuild(this.o.home);
    return compact({
      running: compact({
        root: this.root,
        commit,
        branch,
        dirty: dirty === undefined ? undefined : dirty.length > 0,
        modified_build: running?.build_id,
      }),
      modified: running !== undefined,
      next_start: next
        ? {
            build_id: next.record.build_id,
            commit: next.record.commit,
            activated_at: next.active.activated_at,
          }
        : { build_id: null, root: "the original install" },
      restart_required: (next?.record.build_id ?? null) !== (running?.build_id ?? null),
    });
  }

  /** Make a ready build the one `coordinator start` runs. Human API only. */
  activate(id: string, actor: { id?: string }): Json {
    const b = this.get(id);
    if (b.status !== "ready")
      throw new HttpError(
        409,
        "build_not_ready",
        `build ${id} is ${b.status}; only a build whose checks passed can be activated`,
        {
          checks: b.checks,
        },
      );
    if (!existsSync(join(b.source_dir, "apps/server/src/main.ts")))
      throw new HttpError(409, "build_missing", `the source of ${id} is gone`);
    const active: ActiveBuild = compact({
      build_id: id,
      activated_at: this.o.now().toISOString(),
      activated_by: actor.id,
    }) as ActiveBuild;
    writeJsonAtomic(join(buildsDir(this.o.home), "active.json"), active);
    this.o.audit("build.activate", actor, { build_id: id, commit: b.commit, branch: b.branch });
    return this.status();
  }

  /** Go back to the original install at the next start. */
  deactivate(actor: { id?: string }): Json {
    rmSync(join(buildsDir(this.o.home), "active.json"), { force: true });
    this.o.audit("build.deactivate", actor, {});
    return this.status();
  }
}
