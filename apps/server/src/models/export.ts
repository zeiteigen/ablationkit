/**
 * Copy a logged model's files out of MLflow to a local directory, for shipping to a remote worker
 * (a research endpoint pod, a remote evaluation's bundle). Pinned: the caller passes the artifact URI
 * of an exact model, never an alias. The tree hash matches `ablationkit_sdk.evaluate.tree_sha256`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { type MlflowClient, MlflowError } from "@ablationkit/tracking-mlflow";
import { HttpError } from "../http.ts";

/** Largest model shipped to a worker (larger models belong in a network volume). */
export const MAX_MODEL_BYTES = 20 * 1024 ** 3;

/** Download every file under `artifactUri` into `root` (replaced). */
export async function exportModelFiles(
  client: MlflowClient,
  artifactUri: string,
  root: string,
  what: string,
): Promise<{ files: number; bytes: number }> {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let bytes = 0;
  let files = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 20) throw new HttpError(422, "model_too_deep", "the model's tree is too deep");
    for (const f of await client.listProxiedArtifacts(artifactUri, path)) {
      if (f.path.split("/").some((s) => s === ".." || s === "" || s === "."))
        throw new HttpError(422, "unsafe_model_path", `unsafe path ${f.path} in the model`);
      if (f.is_dir) {
        await walk(f.path, depth + 1);
        continue;
      }
      const body = new Uint8Array(
        await (await client.downloadProxiedArtifact(artifactUri, f.path)).arrayBuffer(),
      );
      bytes += body.byteLength;
      if (bytes > MAX_MODEL_BYTES)
        throw new HttpError(413, "model_too_large", "the model is larger than 20 GiB");
      const out = join(root, f.path);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, body);
      files++;
    }
  };
  try {
    await walk("", 0);
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    if (e instanceof MlflowError)
      throw new HttpError(
        e.notFound ? 404 : 503,
        e.notFound ? "model_not_found" : "tracking_unavailable",
        `downloading ${what}: ${e.message}`,
      );
    throw e;
  }
  if (files === 0) {
    rmSync(root, { recursive: true, force: true });
    throw new HttpError(404, "model_empty", `${what} has no files`);
  }
  return { files, bytes };
}

const fileSha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** SHA-256 of `<file sha256>  <relative path>\n` lines in path order. */
export function treeSha256(root: string): string {
  const paths: string[] = [];
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile()) paths.push(relative(root, p).split(sep).join("/"));
    }
  };
  visit(root);
  paths.sort();
  return createHash("sha256")
    .update(paths.map((p) => `${fileSha(join(root, p))}  ${p}\n`).join(""))
    .digest("hex");
}
