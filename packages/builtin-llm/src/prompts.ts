/**
 * The MLflow Prompt Registry, read and written over the model-registry REST API the way MLflow's
 * own client does (prompts are registered models tagged `mlflow.prompt.is_prompt`; a version holds
 * the template in `mlflow.prompt.text`). Spec §5.6.2 item 1, criteria 10 and 10a; ADR 0021.
 *
 * A project sees the prompts linked to its experiment (`_mlflow_experiment_ids`) or created through
 * it. Versions are immutable; aliases are not, so every use resolves an alias to a version and
 * records both.
 */
import { createHash } from "node:crypto";
import { HttpError } from "@ablationkit/core/http";
import type { ExtensionResearchHost } from "@ablationkit/extension-host/backend";
import {
  diffPrompts,
  isChat,
  parsePromptRef,
  parseTemplate,
  type Template,
  templateText,
  templateVariables,
} from "@ablationkit/llm-research";
import type { PinnedPrompt } from "@ablationkit/protocol";
import {
  MlflowError,
  type MlflowModelVersion,
  type MlflowRegisteredModel,
} from "@ablationkit/tracking-mlflow";
import { compact } from "./helpers.ts";

type Json = Record<string, unknown>;

export const PROMPT_TAG = "mlflow.prompt.is_prompt";
const TEXT_TAG = "mlflow.prompt.text";
const TYPE_TAG = "_mlflow_prompt_type";
const EXP_TAG = "_mlflow_experiment_ids";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;

export interface PromptVersionView {
  name: string;
  version: number;
  template: Template;
  format: "text" | "chat";
  variables: string[];
  template_sha256: string;
  commit_message: string | undefined;
  aliases: string[];
  created_at: string | undefined;
  tags: Record<string, string>;
}

export interface ResolvedPrompt {
  pinned: PinnedPrompt;
  template: Template;
}

function tagMap(tags: { key: string; value: string }[] | undefined): Record<string, string> {
  return Object.fromEntries((tags ?? []).map((t) => [t.key, t.value]));
}

export function templateSha(t: Template): string {
  return createHash("sha256").update(templateText(t)).digest("hex");
}

export class PromptService {
  constructor(private readonly o: { svc: () => ExtensionResearchHost }) {}

  private get svc(): ExtensionResearchHost {
    return this.o.svc();
  }

  private c() {
    return this.svc.tracking.client;
  }

  private wrap(e: unknown): never {
    if (e instanceof HttpError) throw e;
    if (e instanceof MlflowError) {
      if (e.notFound) throw new HttpError(404, "not_found", e.message);
      throw new HttpError(503, "tracking_unavailable", `MLflow is unavailable: ${e.message}`);
    }
    throw e;
  }

  private inProject(pid: string, m: MlflowRegisteredModel): boolean {
    const tags = tagMap(m.tags);
    if (tags[PROMPT_TAG] !== "true") return false;
    if (tags["ablationkit.project"] === pid) return true;
    const exps = (tags[EXP_TAG] ?? "").split(",").filter(Boolean);
    return this.svc.models.experimentIds(pid).some((id) => exps.includes(id));
  }

  private async model(pid: string, name: string): Promise<MlflowRegisteredModel> {
    if (!NAME_RE.test(name)) throw new HttpError(400, "invalid_request", "bad prompt name");
    const m = await this.c()
      .getRegisteredModel(name)
      .catch((e: unknown) => this.wrap(e));
    if (!this.inProject(pid, m))
      throw new HttpError(404, "not_found", `no prompt ${name} in this project`);
    return m;
  }

  private view(v: MlflowModelVersion, aliases: Map<string, string[]>): PromptVersionView {
    const tags = tagMap(v.tags);
    const template = parseTemplate(tags[TEXT_TAG] ?? "", tags[TYPE_TAG]);
    return {
      name: v.name,
      version: Number(v.version),
      template,
      format: isChat(template) ? "chat" : "text",
      variables: templateVariables(template),
      template_sha256: templateSha(template),
      commit_message: v.description || undefined,
      aliases: aliases.get(v.version) ?? v.aliases ?? [],
      created_at: v.creation_timestamp ? new Date(v.creation_timestamp).toISOString() : undefined,
      tags: Object.fromEntries(
        Object.entries(tags).filter(([k]) => k !== TEXT_TAG && k !== TYPE_TAG && k !== PROMPT_TAG),
      ),
    };
  }

  async list(pid: string, qy: { q?: string | undefined } = {}): Promise<Json[]> {
    const out: Json[] = [];
    try {
      let token: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await this.c().searchRegisteredModels(
          compact({
            filter: `tags.\`${PROMPT_TAG}\` = 'true'`,
            max_results: 200,
            page_token: token,
          }),
        );
        for (const m of page.items) {
          if (!this.inProject(pid, m)) continue;
          if (qy.q && !m.name.toLowerCase().includes(qy.q.toLowerCase())) continue;
          out.push(
            compact({
              name: m.name,
              description: m.description || undefined,
              latest_version: m.latest_versions?.[0]
                ? Number(m.latest_versions[0].version)
                : undefined,
              aliases: m.aliases ?? [],
              updated_at: m.last_updated_timestamp
                ? new Date(m.last_updated_timestamp).toISOString()
                : undefined,
            }),
          );
        }
        token = page.next_page_token;
        if (!token) break;
      }
    } catch (e) {
      this.wrap(e);
    }
    return out.sort((a, b) => String(a["name"]).localeCompare(String(b["name"])));
  }

  async get(pid: string, name: string): Promise<Json> {
    const m = await this.model(pid, name);
    const aliases = new Map<string, string[]>();
    for (const a of m.aliases ?? [])
      aliases.set(a.version, [...(aliases.get(a.version) ?? []), a.alias]);
    const versions: PromptVersionView[] = [];
    try {
      let token: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await this.c().searchModelVersions(
          compact({
            filter: `name = '${name}' AND tags.\`${PROMPT_TAG}\` = 'true'`,
            max_results: 200,
            page_token: token,
          }),
        );
        versions.push(...page.items.map((v) => this.view(v, aliases)));
        token = page.next_page_token;
        if (!token) break;
      }
    } catch (e) {
      this.wrap(e);
    }
    versions.sort((a, b) => b.version - a.version);
    return compact({
      name,
      description: m.description || undefined,
      aliases: m.aliases ?? [],
      tags: tagMap(m.tags),
      versions,
    });
  }

  async version(pid: string, name: string, version: number): Promise<PromptVersionView> {
    const m = await this.model(pid, name);
    const aliases = new Map<string, string[]>();
    for (const a of m.aliases ?? [])
      aliases.set(a.version, [...(aliases.get(a.version) ?? []), a.alias]);
    const v = await this.c()
      .getModelVersion(name, String(version))
      .catch((e: unknown) => this.wrap(e));
    if (tagMap(v.tags)[PROMPT_TAG] !== "true")
      throw new HttpError(404, "not_found", `${name} v${version} is not a prompt`);
    return this.view(v, aliases);
  }

  /** Resolve `name@alias`, `name/3` (or an object) to an exact version, recording the alias asked for. */
  async resolve(pid: string, ref: unknown): Promise<ResolvedPrompt> {
    let r: { name: string; version?: number; alias?: string } | undefined;
    if (typeof ref === "string") r = parsePromptRef(ref);
    else if (typeof ref === "object" && ref !== null) {
      const o = ref as Json;
      r = compact({
        name: String(o["name"] ?? ""),
        version:
          typeof o["version"] === "number"
            ? o["version"]
            : typeof o["version"] === "string"
              ? Number(o["version"])
              : undefined,
        alias: typeof o["alias"] === "string" ? o["alias"] : undefined,
      });
    }
    if (!r?.name)
      throw new HttpError(
        400,
        "invalid_request",
        "prompt must be `name@alias`, `name/version` or {name, version|alias}",
      );
    let version = r.version;
    if (version === undefined) {
      if (!r.alias)
        throw new HttpError(400, "invalid_request", `prompt ${r.name}: give a version or an alias`);
      if (!ALIAS_RE.test(r.alias)) throw new HttpError(400, "invalid_request", "bad alias");
      await this.model(pid, r.name);
      const v = await this.c()
        .getVersionByAlias(r.name, r.alias)
        .catch((e: unknown) => {
          if (e instanceof MlflowError && e.kind === "rejected")
            throw new HttpError(
              404,
              "alias_not_found",
              `prompt ${r?.name} has no alias ${r?.alias}`,
            );
          return this.wrap(e);
        });
      version = Number(v.version);
    }
    if (!Number.isSafeInteger(version) || version < 1)
      throw new HttpError(400, "invalid_request", "bad prompt version");
    const v = await this.version(pid, r.name, version);
    return {
      template: v.template,
      pinned: compact({
        name: v.name,
        version: v.version,
        alias: r.alias,
        template_sha256: v.template_sha256,
        format: v.format,
      }),
    };
  }

  async diff(pid: string, name: string, from: number, to: number, toName?: string): Promise<Json> {
    const a = await this.version(pid, name, from);
    const b = await this.version(pid, toName ?? name, to);
    return {
      from: { name: a.name, version: a.version, template_sha256: a.template_sha256 },
      to: { name: b.name, version: b.version, template_sha256: b.template_sha256 },
      diff: diffPrompts(a.template, b.template),
    };
  }

  /** Register a new immutable version (creating the prompt if needed), linked to the project experiment. */
  async createVersion(
    pid: string,
    body: Json,
    actor: { kind: "human" | "agent"; id?: string },
  ): Promise<PromptVersionView> {
    const name = body["name"];
    if (typeof name !== "string" || !NAME_RE.test(name))
      throw new HttpError(400, "invalid_request", "name: letters, digits, '_', '-', '.' (1-100)");
    const raw = body["template"];
    let template: Template;
    if (typeof raw === "string") template = raw;
    else if (
      Array.isArray(raw) &&
      raw.length > 0 &&
      raw.length <= 50 &&
      raw.every(
        (m) =>
          typeof m?.role === "string" &&
          typeof m?.content === "string" &&
          ["system", "user", "assistant"].includes(m.role),
      )
    )
      template = (raw as { role: string; content: string }[]).map((m) => ({
        role: m.role,
        content: m.content,
      }));
    else
      throw new HttpError(
        400,
        "invalid_request",
        "template is a string or a list of {role: system|user|assistant, content}",
      );
    if (templateText(template).length > 64_000)
      throw new HttpError(413, "too_large", "templates are limited to 64000 characters");
    const message = body["commit_message"];
    if (message !== undefined && (typeof message !== "string" || message.length > 2000))
      throw new HttpError(400, "invalid_request", "commit_message is at most 2000 characters");
    const exp = await this.svc.tracking
      .ensureExperimentNow(pid)
      .catch((e: unknown) => this.wrap(e));
    const c = this.c();
    try {
      let m: MlflowRegisteredModel | undefined;
      try {
        m = await c.getRegisteredModel(name);
      } catch (e) {
        if ((e as { code?: string }).code === "extension_tracking_scope")
          throw new HttpError(
            409,
            "prompt_in_other_project",
            `${name} is already reserved outside this project`,
          );
        if (!(e instanceof MlflowError && e.notFound)) throw e;
      }
      if (m) {
        if (!this.inProject(pid, m)) {
          const tags = tagMap(m.tags);
          throw new HttpError(
            409,
            tags[PROMPT_TAG] === "true" ? "prompt_in_other_project" : "name_taken_by_model",
            `${name} already exists outside this project`,
          );
        }
      } else
        await c.createRegisteredModel(
          compact({
            name,
            description: message as string | undefined,
            tags: [
              { key: PROMPT_TAG, value: "true" },
              { key: EXP_TAG, value: `,${exp},` },
              { key: "ablationkit.project", value: pid },
            ],
          }),
        );
      const v = await c.createModelVersion(
        compact({
          name,
          source: "dummy-source",
          description: message as string | undefined,
          tags: [
            { key: PROMPT_TAG, value: "true" },
            { key: TYPE_TAG, value: isChat(template) ? "chat" : "text" },
            { key: TEXT_TAG, value: templateText(template) },
            { key: "ablationkit.created_by", value: actor.kind },
          ],
        }),
      );
      const out = await this.version(pid, name, Number(v.version));
      this.svc.audit.record({
        actor: compact({ kind: actor.kind, id: actor.id }),
        listener: actor.kind,
        action: "llm.prompt.version",
        outcome: "allowed",
        project_id: pid,
        target: `${name}/${v.version}`,
        details: { template_sha256: out.template_sha256 },
      });
      this.svc.events.publish(pid, "llm.prompt.updated", { name, version: out.version });
      return out;
    } catch (e) {
      return this.wrap(e);
    }
  }

  /** Point an alias at a version (or remove it). Researcher only: it changes what `@alias` means. */
  async setAlias(
    pid: string,
    name: string,
    alias: string,
    version: number | null,
    actor: { kind: "human"; id?: string },
  ): Promise<Json> {
    if (!ALIAS_RE.test(alias))
      throw new HttpError(
        400,
        "invalid_request",
        "alias: a letter, then letters, digits, '_' or '-'",
      );
    if (/^(latest|v[0-9]+)$/i.test(alias))
      throw new HttpError(400, "invalid_request", `${alias} is reserved`);
    const m = await this.model(pid, name);
    const before = m.aliases?.find((a) => a.alias === alias)?.version;
    try {
      if (version === null) await this.c().deleteAlias(name, alias);
      else {
        await this.version(pid, name, version);
        await this.c().setAlias(name, alias, String(version));
      }
    } catch (e) {
      this.wrap(e);
    }
    this.svc.audit.record({
      actor: compact({ kind: "human" as const, id: actor.id }),
      listener: "human",
      action: "llm.prompt.alias",
      outcome: "allowed",
      project_id: pid,
      target: `${name}@${alias}`,
      details: compact({ from: before, to: version ?? undefined }),
    });
    this.svc.events.publish(pid, "llm.prompt.updated", { name, alias, version });
    return compact({ name, alias, version, previous: before ? Number(before) : undefined });
  }
}
