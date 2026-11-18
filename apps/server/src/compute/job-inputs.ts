/**
 * A job's inputs from earlier runs (ADR 0068). An agent's job runs a copy of its source and keeps
 * only what its `artifact_paths` collect, so a later job takes what an earlier one produced (a
 * checkpoint, a dataset it prepared) from that run's artifacts: `inputs: [{run, path?, to?}]`.
 * The coordinator downloads them when the job is submitted, into the job's own directory; on this
 * machine they are mounted read-only at `to` in the job's source, and on a remote target they
 * travel in its bundle there.
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JobInput } from "@ablationkit/protocol";
import { HttpError } from "../http.ts";
import { projectRunId, safeArtifactPath } from "../listeners/tracking.ts";
import type { Services } from "../services.ts";

export const MAX_INPUTS = 8;
export const INPUTS_MAX_BYTES = 16 * 1024 * 1024 * 1024;
export const INPUTS_MAX_FILES = 10_000;

/** One input as the agent gives it. */
export interface InputSpec {
  readonly run: string;
  readonly path?: string;
  readonly to?: string;
}

/** A path in the job's source an input may be put at. */
function checkTo(to: string): string {
  const t = safeArtifactPath(to, true) as string;
  const first = t.split("/")[0];
  if (first === ".git" || first === ".ablationkit")
    throw new HttpError(400, "invalid_request", `an input cannot go to ${to}`);
  return t;
}

/** Parse and check `inputs` from a request body. */
export function parseInputs(raw: unknown): InputSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_INPUTS)
    throw new HttpError(
      400,
      "invalid_request",
      `\`inputs\`: at most ${MAX_INPUTS} of {run, path?, to?}`,
    );
  return raw.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o["run"] !== "string" || !o["run"])
      throw new HttpError(400, "invalid_request", "each input names a `run`");
    const path = o["path"] === undefined ? undefined : safeArtifactPath(String(o["path"]), false);
    const to = o["to"] === undefined ? path : checkTo(String(o["to"]));
    if (!to)
      throw new HttpError(
        400,
        "invalid_request",
        "an input of a whole run needs `to`: where in the job's source its artifacts go",
      );
    checkTo(to);
    return { run: o["run"] as string, ...(path ? { path } : {}), to };
  });
}

/**
 * Download each input into `dir/<n>` (a file, or a directory of the artifacts under `path`).
 * Returns what to record; throws 404 `input_not_found` for an empty one and 413 `inputs_too_large`.
 */
export async function stageInputs(
  svc: Services,
  projectId: string,
  specs: readonly InputSpec[],
  dir: string,
): Promise<JobInput[]> {
  const client = svc.tracking.client;
  const out: JobInput[] = [];
  let bytes = 0;
  let files = 0;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    for (const [n, spec] of specs.entries()) {
      const runId = await projectRunId(svc, projectId, spec.run);
      const base = spec.path ?? "";
      // Every file under `path`, or `path` itself when it is a file.
      const found: { path: string; size: number }[] = [];
      const walk = async (p: string, depth: number): Promise<void> => {
        if (depth > 32) return;
        let token: string | undefined;
        do {
          const page = await client.listArtifacts(runId, p || undefined, token);
          for (const f of page.items)
            if (f.is_dir) await walk(f.path, depth + 1);
            else found.push({ path: f.path, size: f.file_size ?? 0 });
          token = page.next_page_token;
        } while (token);
      };
      await walk(base, 0);
      let single = false;
      if (!found.length && base) {
        const parent = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
        // The file among its parent's entries, on whichever page it falls.
        let token: string | undefined;
        do {
          const page = await client.listArtifacts(runId, parent || undefined, token);
          const f = page.items.find((x) => x.path === base && !x.is_dir);
          if (f) {
            found.push({ path: f.path, size: f.file_size ?? 0 });
            single = true;
            break;
          }
          token = page.next_page_token;
        } while (token);
      }
      if (!found.length)
        throw new HttpError(
          404,
          "input_not_found",
          `run ${spec.run} has no artifacts${base ? ` at ${base}` : ""} (ablationkit_read run.artifacts lists them)`,
        );
      for (const f of found) {
        bytes += f.size;
        files++;
        if (bytes > INPUTS_MAX_BYTES || files > INPUTS_MAX_FILES)
          throw new HttpError(
            413,
            "inputs_too_large",
            `a job's inputs are at most ${INPUTS_MAX_BYTES / 1024 ** 3} GiB and ${INPUTS_MAX_FILES} files`,
          );
        const rel = single ? "" : base ? f.path.slice(base.length + 1) : f.path;
        const dest = single ? join(dir, String(n)) : join(dir, String(n), rel);
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        const res = await client.downloadArtifact(runId, f.path);
        if (!res.ok)
          throw new HttpError(
            502,
            "input_download_failed",
            `${spec.run}: ${f.path}: HTTP ${res.status}`,
          );
        await Bun.write(dest, res);
      }
      out.push({
        run: spec.run,
        run_id: runId,
        path: base,
        to: spec.to as string,
        kind: single ? "file" : "dir",
        files: found.length,
        bytes: found.reduce((a, f) => a + f.size, 0),
      });
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return out;
}
