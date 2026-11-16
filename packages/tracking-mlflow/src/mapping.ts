/**
 * AblationKit's side of the MLflow mapping (spec §5.5 "Run mapping", §6.1), as small JSON files:
 *
 *   state/<project-id>/tracking/experiments.json   TrackingProjectLinks
 *   state/<project-id>/tracking/runs/<ref>.json    TrackingRunMapping, one per attempt/manual run
 *
 * Loaded once at startup by scanning (spec §6: rebuild lookup maps from small canonical files).
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import {
  type TrackingProjectLinks,
  type TrackingRunMapping,
  validateTrackingProjectLinks,
  validateTrackingRunMapping,
} from "@ablationkit/protocol";
import { projectExperimentName } from "./tags.ts";

export class MappingStore {
  private readonly runs = new Map<string, TrackingRunMapping>();
  private readonly byRunId = new Map<string, string>();
  private readonly links = new Map<string, TrackingProjectLinks>();

  constructor(private readonly stateDir: string) {}

  private dir(projectId: string): string {
    return join(this.stateDir, projectId, "tracking");
  }

  /** Scan every project's tracking directory. Returns unreadable files (left in place). */
  load(): string[] {
    const problems: string[] = [];
    if (!existsSync(this.stateDir)) return problems;
    for (const pid of readdirSync(this.stateDir)) {
      const dir = this.dir(pid);
      const linksPath = join(dir, "experiments.json");
      if (existsSync(linksPath)) {
        try {
          const l = readJson(linksPath, validateTrackingProjectLinks);
          this.links.set(l.project_id, l);
        } catch (e) {
          problems.push(`${linksPath}: ${(e as Error).message}`);
        }
      }
      const runsDir = join(dir, "runs");
      if (!existsSync(runsDir)) continue;
      for (const f of readdirSync(runsDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          this.index(readJson(join(runsDir, f), validateTrackingRunMapping));
        } catch (e) {
          problems.push(`${join(runsDir, f)}: ${(e as Error).message}`);
        }
      }
    }
    return problems;
  }

  private index(m: TrackingRunMapping): void {
    this.runs.set(m.ref, m);
    if (m.mlflow_run_id) this.byRunId.set(m.mlflow_run_id, m.ref);
  }

  // ------------------------------------------------------------------ links

  getLinks(projectId: string): TrackingProjectLinks {
    return (
      this.links.get(projectId) ?? {
        schema_version: 1,
        project_id: projectId,
        experiment_name: projectExperimentName(projectId),
        imports: [],
      }
    );
  }

  putLinks(links: TrackingProjectLinks): TrackingProjectLinks {
    mkdirSync(this.dir(links.project_id), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.dir(links.project_id), "experiments.json"), links, {
      validate: validateTrackingProjectLinks,
    });
    this.links.set(links.project_id, links);
    return links;
  }

  /** Project that owns experiment `id` (as its `ak/` experiment), if any. */
  projectForExperiment(id: string): string | undefined {
    for (const l of this.links.values()) if (l.experiment_id === id) return l.project_id;
    return undefined;
  }

  /** Project that linked experiment `id` read-only, if any. */
  importOwner(id: string): string | undefined {
    for (const l of this.links.values())
      if (l.imports.some((i) => i.experiment_id === id)) return l.project_id;
    return undefined;
  }

  // ------------------------------------------------------------------- runs

  get(ref: string): TrackingRunMapping | undefined {
    return this.runs.get(ref);
  }

  getByRunId(runId: string): TrackingRunMapping | undefined {
    const ref = this.byRunId.get(runId);
    return ref ? this.runs.get(ref) : undefined;
  }

  forProject(projectId: string): TrackingRunMapping[] {
    return [...this.runs.values()].filter((m) => m.project_id === projectId);
  }

  all(): TrackingRunMapping[] {
    return [...this.runs.values()];
  }

  put(m: TrackingRunMapping): TrackingRunMapping {
    const dir = join(this.dir(m.project_id), "runs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(dir, `${m.ref}.json`), m, { validate: validateTrackingRunMapping });
    this.index(m);
    return m;
  }
}
