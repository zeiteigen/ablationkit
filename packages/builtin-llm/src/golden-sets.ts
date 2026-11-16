/**
 * Golden sets: fixed, versioned evaluation sets (spec §5.6.2 item 4, criteria 10 and 10a; ADR 0021).
 *
 * A version is an immutable JSONL file under `state/<p>/llm/golden-sets/<gs>/v<N>.jsonl`, pinned by
 * its SHA-256 (checked on every read). Changing a set means adding a version. A held-out set takes
 * new versions only from a researcher, and its expectations never leave the coordinator: the
 * checkout export (`.ablationkit/llm/golden-sets/`) carries its inputs only, so a project job can
 * run its application over the set while scoring stays with the coordinator.
 *
 * Each version is mirrored, best effort, into an MLflow GenAI evaluation dataset.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import { HttpError } from "@ablationkit/core/http";
import type { ExtensionResearchHost } from "@ablationkit/extension-host/backend";
import {
  type GoldenExample,
  type GoldenSetRecord,
  type GoldenSetVersion,
  validateGoldenExample,
  validateGoldenSetRecord,
} from "@ablationkit/protocol";
import { compact } from "./helpers.ts";

type Json = Record<string, unknown>;
type Actor = { kind: "human" | "agent"; id?: string };

export const MAX_GOLDEN_EXAMPLES = 10_000;
export const MAX_GOLDEN_BYTES = 32 * 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,79}$/;
export const EXPORT_DIR = ".ablationkit/llm/golden-sets";

function sha256(b: string | Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

/** One example in canonical key order, so the same content always hashes the same. */
function canonical(e: GoldenExample): GoldenExample {
  return compact({
    example_id: e.example_id,
    inputs: e.inputs,
    expectations: e.expectations,
    category: e.category,
    edge_case: e.edge_case,
    tags: e.tags,
    notes: e.notes,
  }) as GoldenExample;
}

export class GoldenSetService {
  private readonly records = new Map<string, GoldenSetRecord>();
  readonly loadProblems: string[] = [];

  constructor(
    private readonly o: { svc: () => ExtensionResearchHost; stateDir: string; now: () => Date },
  ) {}

  private get svc(): ExtensionResearchHost {
    return this.o.svc();
  }

  private dir(pid: string): string {
    return join(this.o.stateDir, pid, "llm", "golden-sets");
  }

  private versionFile(pid: string, id: string, v: number): string {
    return join(this.dir(pid), id, `v${v}.jsonl`);
  }

  load(projects: readonly string[]): void {
    for (const pid of projects) {
      const d = this.dir(pid);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
        try {
          const r = readJson(join(d, f), validateGoldenSetRecord);
          this.records.set(r.golden_set_id, r);
        } catch {
          this.loadProblems.push(join(d, f));
        }
      }
    }
  }

  private save(r: GoldenSetRecord): GoldenSetRecord {
    mkdirSync(this.dir(r.project_id), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.dir(r.project_id), `${r.golden_set_id}.json`), r, {
      validate: validateGoldenSetRecord,
    });
    this.records.set(r.golden_set_id, r);
    this.svc.events.publish(r.project_id, "llm.golden_set.updated", {
      golden_set_id: r.golden_set_id,
      version: r.versions.at(-1)?.version,
    });
    return r;
  }

  list(pid: string): GoldenSetRecord[] {
    this.svc.registry.require(pid);
    return [...this.records.values()]
      .filter((r) => r.project_id === pid)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** By ID or by name. */
  get(pid: string, idOrName: string): GoldenSetRecord {
    const r =
      this.records.get(idOrName) ??
      [...this.records.values()].find((x) => x.project_id === pid && x.name === idOrName);
    if (!r || r.project_id !== pid)
      throw new HttpError(404, "not_found", `no golden set ${idOrName}`);
    return r;
  }

  pinVersion(
    pid: string,
    idOrName: string,
    version?: number,
  ): { set: GoldenSetRecord; version: GoldenSetVersion } {
    const set = this.get(pid, idOrName);
    const v =
      version === undefined ? set.versions.at(-1) : set.versions.find((x) => x.version === version);
    if (!v) throw new HttpError(404, "not_found", `${set.name} has no version ${version}`);
    return { set, version: v };
  }

  /** The examples of one version, after checking the file still hashes to the pinned SHA-256. */
  examples(
    pid: string,
    idOrName: string,
    version?: number,
  ): { set: GoldenSetRecord; version: GoldenSetVersion; examples: GoldenExample[] } {
    const { set, version: v } = this.pinVersion(pid, idOrName, version);
    const f = this.versionFile(pid, set.golden_set_id, v.version);
    const bytes = existsSync(f) ? readFileSync(f) : undefined;
    if (!bytes || sha256(bytes) !== v.sha256)
      throw new HttpError(
        500,
        "golden_set_corrupt",
        `${set.name} v${v.version} does not match its SHA-256; it was changed or lost`,
      );
    const examples = bytes
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as GoldenExample);
    return { set, version: v, examples };
  }

  /** Examples from the request (`examples`) or a JSONL/JSON file in the checkout (`from_file`). */
  private readInput(pid: string, body: Json): GoldenExample[] {
    let raw: unknown = body["examples"];
    if (raw === undefined && body["from_file"] !== undefined) {
      const root = this.svc.registry.require(pid).path;
      const rel = body["from_file"];
      if (typeof rel !== "string" || !rel || rel.startsWith("/") || rel.split("/").includes(".."))
        throw new HttpError(
          400,
          "invalid_request",
          "from_file must be a relative path inside the checkout",
        );
      const abs = resolve(root, rel);
      if (!abs.startsWith(root + sep) || !existsSync(abs) || !statSync(abs).isFile())
        throw new HttpError(404, "file_not_found", `no file ${rel} in the project checkout`);
      if (statSync(abs).size > MAX_GOLDEN_BYTES)
        throw new HttpError(413, "too_large", "golden sets are limited to 32 MiB");
      const text = readFileSync(abs, "utf8");
      try {
        raw = /\.jsonl$/i.test(abs)
          ? text
              .split("\n")
              .filter((l) => l.trim())
              .map((l) => JSON.parse(l))
          : JSON.parse(text);
      } catch (e) {
        throw new HttpError(422, "invalid_examples", `${rel}: ${(e as Error).message}`);
      }
    }
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_GOLDEN_EXAMPLES)
      throw new HttpError(
        400,
        "invalid_request",
        `examples must be a list of 1..${MAX_GOLDEN_EXAMPLES}`,
      );
    const seen = new Set<string>();
    const issues: { index: number; message: string }[] = [];
    const out: GoldenExample[] = [];
    raw.forEach((item, i) => {
      const x = (typeof item === "object" && item !== null ? { ...(item as Json) } : {}) as Json;
      if (x["example_id"] === undefined) x["example_id"] = `ex-${String(i + 1).padStart(4, "0")}`;
      try {
        const e = canonical(validateGoldenExample(x));
        if (!Object.keys(e.inputs).length) throw new Error("inputs must name at least one field");
        if (seen.has(e.example_id)) throw new Error(`duplicate example_id ${e.example_id}`);
        seen.add(e.example_id);
        out.push(e);
      } catch (err) {
        if (issues.length < 50)
          issues.push({ index: i, message: (err as Error).message.slice(0, 300) });
      }
    });
    if (issues.length)
      throw new HttpError(422, "invalid_examples", "some examples are invalid", { issues });
    return out;
  }

  private writeVersion(
    pid: string,
    id: string,
    n: number,
    examples: GoldenExample[],
    actor: Actor,
    note?: string,
    parent?: number,
    sameAs?: string,
  ): GoldenSetVersion {
    const text = `${examples.map((e) => JSON.stringify(e)).join("\n")}\n`;
    if (sameAs !== undefined && sha256(text) === sameAs)
      throw new HttpError(409, "unchanged", `identical to version ${n - 1}`);
    if (Buffer.byteLength(text) > MAX_GOLDEN_BYTES)
      throw new HttpError(413, "too_large", "golden sets are limited to 32 MiB");
    const f = this.versionFile(pid, id, n);
    if (existsSync(f)) throw new HttpError(409, "version_exists", `version ${n} already exists`);
    mkdirSync(join(this.dir(pid), id), { recursive: true, mode: 0o700 });
    writeFileSync(f, text, { mode: 0o400, flag: "wx" });
    const categories: Record<string, number> = {};
    for (const e of examples)
      if (e.category) categories[e.category] = (categories[e.category] ?? 0) + 1;
    return compact({
      version: n,
      sha256: sha256(text),
      examples: examples.length,
      categories,
      edge_cases: examples.filter((e) => e.edge_case).length,
      missing_expectations: examples.filter(
        (e) => !e.expectations || !Object.keys(e.expectations).length,
      ).length,
      parent_version: parent,
      note,
      created_at: this.o.now().toISOString(),
      created_by: compact({ kind: actor.kind, id: actor.id }),
    }) as GoldenSetVersion;
  }

  create(pid: string, body: Json, actor: Actor): GoldenSetRecord {
    this.svc.registry.require(pid);
    const name = body["name"];
    if (typeof name !== "string" || !NAME_RE.test(name))
      throw new HttpError(
        400,
        "invalid_request",
        "name: lowercase letters, digits, '_', '-', '.' (1-80)",
      );
    if (this.list(pid).some((r) => r.name === name))
      throw new HttpError(409, "exists", `golden set ${name} exists; add a version`);
    const held = body["held_out"] === true;
    if (held && actor.kind === "agent")
      throw new HttpError(
        403,
        "held_out_guarded",
        "only a researcher can create a held-out golden set",
      );
    const description = body["description"];
    if (description !== undefined && (typeof description !== "string" || description.length > 4000))
      throw new HttpError(400, "invalid_request", "description is at most 4000 characters");
    const examples = this.readInput(pid, body);
    const id = `gs-${randomBytes(6).toString("hex")}`;
    const v = this.writeVersion(pid, id, 1, examples, actor, body["note"] as string | undefined);
    const now = this.o.now().toISOString();
    const rec = this.save(
      compact({
        schema_version: 1 as const,
        golden_set_id: id,
        project_id: pid,
        name,
        description: description as string | undefined,
        held_out: held,
        versions: [v],
        created_at: now,
        updated_at: now,
        created_by: compact({ kind: actor.kind, id: actor.id }),
      }) as GoldenSetRecord,
    );
    this.after(rec, v, examples, actor, "llm.golden_set.create");
    return this.records.get(id) as GoldenSetRecord;
  }

  addVersion(pid: string, idOrName: string, body: Json, actor: Actor): GoldenSetRecord {
    const cur = this.get(pid, idOrName);
    if (cur.held_out && actor.kind === "agent")
      throw new HttpError(
        403,
        "held_out_guarded",
        `${cur.name} is held out: only a researcher can change it`,
      );
    const examples = this.readInput(pid, body);
    const last = cur.versions.at(-1) as GoldenSetVersion;
    const note = body["note"];
    if (note !== undefined && (typeof note !== "string" || note.length > 2000))
      throw new HttpError(400, "invalid_request", "note is at most 2000 characters");
    const v = this.writeVersion(
      pid,
      cur.golden_set_id,
      last.version + 1,
      examples,
      actor,
      note as string | undefined,
      last.version,
      last.sha256,
    );
    const rec = this.save({
      ...cur,
      versions: [...cur.versions, v],
      updated_at: this.o.now().toISOString(),
    });
    this.after(rec, v, examples, actor, "llm.golden_set.version");
    return this.records.get(rec.golden_set_id) as GoldenSetRecord;
  }

  private after(
    rec: GoldenSetRecord,
    v: GoldenSetVersion,
    examples: GoldenExample[],
    actor: Actor,
    action: string,
  ): void {
    this.svc.audit.record({
      actor: compact({ kind: actor.kind, id: actor.id }),
      listener: actor.kind,
      action,
      outcome: "allowed",
      project_id: rec.project_id,
      target: `${rec.golden_set_id}/${v.version}`,
      details: { name: rec.name, examples: v.examples, sha256: v.sha256, held_out: rec.held_out },
    });
    try {
      this.exportToCheckout(rec.project_id);
    } catch {
      // the checkout may be read-only or missing: the canonical copy is the coordinator's
    }
    void this.mirror(rec, v, examples);
  }

  /** Mirror a version into an MLflow GenAI evaluation dataset (best effort; recorded on the version). */
  private async mirror(
    rec: GoldenSetRecord,
    v: GoldenSetVersion,
    examples: GoldenExample[],
  ): Promise<void> {
    try {
      const exp = await this.svc.tracking.ensureExperimentNow(rec.project_id);
      const ds = await this.svc.tracking.client.createGenaiDataset({
        name: `${rec.name}-v${v.version}`,
        experiment_ids: [exp],
        tags: {
          "ablationkit.golden_set": rec.golden_set_id,
          "ablationkit.golden_version": String(v.version),
          "ablationkit.sha256": v.sha256,
          "ablationkit.held_out": String(rec.held_out),
        },
      });
      for (let i = 0; i < examples.length; i += 500)
        await this.svc.tracking.client.upsertGenaiDatasetRecords(
          ds.dataset_id,
          examples.slice(i, i + 500).map((e) =>
            compact({
              inputs: e.inputs,
              expectations: e.expectations,
              tags: compact({
                example_id: e.example_id,
                category: e.category,
                edge_case: e.edge_case ? "true" : undefined,
              }),
            }),
          ),
        );
      const cur = this.records.get(rec.golden_set_id);
      if (!cur) return;
      this.save({
        ...cur,
        versions: cur.versions.map((x) =>
          x.version === v.version ? { ...x, mlflow_dataset_id: ds.dataset_id } : x,
        ),
      });
    } catch {
      // MLflow down: the version stays unmirrored (shown as such); evaluations use the pinned file
    }
  }

  /**
   * Write every set's versions into the main checkout for project jobs, with an index of hashes.
   * Held-out sets export inputs only.
   */
  exportToCheckout(pid: string): void {
    const root = this.svc.registry.require(pid).path;
    const base = join(root, EXPORT_DIR);
    const index: Json[] = [];
    for (const r of this.list(pid)) {
      for (const v of r.versions) {
        const { examples } = this.examples(pid, r.golden_set_id, v.version);
        const rows = r.held_out
          ? examples.map((e) =>
              compact({ example_id: e.example_id, inputs: e.inputs, category: e.category }),
            )
          : examples;
        const text = `${rows.map((e) => JSON.stringify(e)).join("\n")}\n`;
        const rel = `${r.name}/v${v.version}.jsonl`;
        mkdirSync(join(base, r.name), { recursive: true });
        const f = join(base, rel);
        if (!existsSync(f) || sha256(readFileSync(f)) !== sha256(text)) writeFileSync(f, text);
        index.push({
          golden_set_id: r.golden_set_id,
          name: r.name,
          version: v.version,
          path: rel,
          sha256: v.sha256,
          export_sha256: sha256(text),
          held_out: r.held_out,
          inputs_only: r.held_out,
          examples: v.examples,
        });
      }
    }
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, "index.json"),
      `${JSON.stringify({ notice: "Exported by AblationKit; edits here are not read back. Held-out sets carry inputs only.", sets: index }, null, 2)}\n`,
    );
  }
}
