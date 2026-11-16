/**
 * A project's LLM data controls (spec §5.6.2 "LLM measurement and privacy rules", criterion 10e;
 * ADR 0021): OpenAI-compatible providers with their locality and egress approvals, token rates for
 * estimates, and the trace capture, redaction and retention policy.
 *
 * Narrowing is an ordinary edit. Widening (approving egress or dataset egress to an external
 * provider, capturing more, keeping longer, dropping a redaction, allowing remote capture) goes
 * through a separate route, so it is always an explicit request by the researcher (human session
 * only; ADR 0037).
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "@ablationkit/core";
import { HttpError } from "@ablationkit/core/http";
import type { ExtensionResearchHost } from "@ablationkit/extension-host/backend";
import { checkPattern, providerLocality } from "@ablationkit/llm-research";
import {
  type LlmCapturePolicy,
  type LlmProviderConfig,
  type LlmSettings,
  validateLlmSettings,
} from "@ablationkit/protocol";
import { compact } from "./helpers.ts";

type Json = Record<string, unknown>;

export const DEFAULT_CAPTURE: LlmCapturePolicy = {
  mode: "redacted",
  builtin_redactions: ["email", "secret"],
  patterns: [],
  retention_days: 30,
  remote_capture: false,
};

const MODE_RANK = { off: 0, metadata_only: 1, redacted: 2, full: 3 } as const;

export interface ProviderUse {
  readonly provider: LlmProviderConfig;
  readonly apiKey: string | undefined;
}

/** What a request will send to a provider: an ad-hoc playground input, or dataset rows / traces. */
export type EgressData = "adhoc" | "dataset";

export class LlmSettingsStore {
  private readonly cache = new Map<string, LlmSettings>();

  constructor(
    private readonly o: {
      svc: () => ExtensionResearchHost;
      stateDir: string;
      now: () => Date;
      env?: () => Readonly<Record<string, string | undefined>>;
    },
  ) {}

  private file(pid: string): string {
    return join(this.o.stateDir, pid, "llm", "settings.json");
  }

  get(pid: string): LlmSettings {
    this.o.svc().registry.require(pid);
    const c = this.cache.get(pid);
    if (c) return c;
    const f = this.file(pid);
    const s: LlmSettings = existsSync(f)
      ? readJson(f, validateLlmSettings)
      : {
          schema_version: 1,
          project_id: pid,
          revision: 0,
          updated_at: new Date(0).toISOString(),
          updated_by: "default",
          providers: [],
          capture: DEFAULT_CAPTURE,
        };
    this.cache.set(pid, s);
    return s;
  }

  capture(pid: string): LlmCapturePolicy {
    return this.get(pid).capture;
  }

  /** The settings as shown to clients: whether each provider's key variable is set, never its value. */
  view(pid: string): Json {
    const s = this.get(pid);
    const env = this.o.env?.() ?? process.env;
    return {
      ...s,
      providers: s.providers.map((p) =>
        compact({
          ...p,
          api_key_present: p.api_key_env ? Boolean(env[p.api_key_env]) : undefined,
        }),
      ),
    };
  }

  private normalize(body: Json, cur: LlmSettings): LlmSettings {
    const providers = (body["providers"] ?? cur.providers) as Json[];
    if (!Array.isArray(providers))
      throw new HttpError(400, "invalid_request", "providers must be a list");
    const seen = new Set<string>();
    const out = providers.map((p) => {
      const id = String(p["provider_id"] ?? "");
      if (seen.has(id))
        throw new HttpError(400, "invalid_request", `provider ${id} is listed twice`);
      seen.add(id);
      const base = String(p["base_url"] ?? "").replace(/\/+$/, "");
      const locality = providerLocality(base);
      const prev = cur.providers.find((x) => x.provider_id === id);
      // Egress approvals are only set by `approveEgress`/widen; a plain edit keeps or drops them.
      const e = p["egress"] as Json | null | undefined;
      // A requested approval gets its who/when in `update`; an unchanged one keeps its record.
      const egress =
        e === null
          ? undefined
          : e === undefined
            ? prev?.egress
            : (compact({
                approved_at: prev?.egress?.approved_at ?? this.o.now().toISOString(),
                approved_by: prev?.egress?.approved_by ?? "pending",
                allow_datasets: e["allow_datasets"] === true,
                note: typeof e["note"] === "string" ? e["note"] : undefined,
              }) as LlmProviderConfig["egress"]);
      return compact({
        provider_id: id,
        label: p["label"] as string | undefined,
        kind: (p["kind"] ?? "openai_compatible") as "openai_compatible",
        base_url: base,
        api_key_env: p["api_key_env"] as string | undefined,
        models: p["models"] as string[],
        locality,
        // A provider moved to another host loses its approval.
        egress: locality === "external" && (!prev || prev.base_url === base) ? egress : undefined,
        rates: p["rates"] as LlmProviderConfig["rates"],
        timeout_sec: p["timeout_sec"] as number | undefined,
      }) as LlmProviderConfig;
    });
    const capture = {
      ...cur.capture,
      ...((body["capture"] as Json | undefined) ?? {}),
    } as LlmCapturePolicy;
    for (const pat of capture.patterns ?? []) {
      const why = checkPattern(String(pat?.regex ?? ""));
      if (why)
        throw new HttpError(400, "invalid_request", `redaction pattern ${pat?.name}: ${why}`);
    }
    for (const r of capture.patterns ?? [])
      if (typeof r.name !== "string")
        throw new HttpError(400, "invalid_request", "patterns need a name");
    try {
      return validateLlmSettings({
        ...cur,
        providers: out,
        capture,
        revision: cur.revision + 1,
        updated_at: this.o.now().toISOString(),
      });
    } catch (e) {
      throw new HttpError(400, "invalid_settings", (e as Error).message);
    }
  }

  /** The ways `next` widens `cur`, in words. Empty means a narrowing or neutral edit. */
  static widening(cur: LlmSettings, next: LlmSettings): string[] {
    const why: string[] = [];
    const a = cur.capture;
    const b = next.capture;
    if (MODE_RANK[b.mode] > MODE_RANK[a.mode]) why.push(`capture ${a.mode} → ${b.mode}`);
    if (b.retention_days > a.retention_days)
      why.push(`retention ${a.retention_days} → ${b.retention_days} days`);
    if (!a.remote_capture && b.remote_capture) why.push("remote capture enabled");
    for (const r of a.builtin_redactions)
      if (!b.builtin_redactions.includes(r)) why.push(`redaction ${r} removed`);
    for (const p of a.patterns)
      if (!b.patterns.some((q) => q.name === p.name && q.regex === p.regex))
        why.push(`redaction pattern ${p.name} removed or changed`);
    for (const p of next.providers) {
      if (p.locality !== "external" || !p.egress) continue;
      const prev = cur.providers.find((x) => x.provider_id === p.provider_id);
      if (!prev?.egress) why.push(`egress to ${p.provider_id} (${p.base_url}) approved`);
      else if (p.egress.allow_datasets && !prev.egress.allow_datasets)
        why.push(`dataset egress to ${p.provider_id} approved`);
    }
    return why;
  }

  /**
   * Replace the settings. Without `widen` (the widening route), any widening is refused with the
   * list of what would widen.
   */
  update(
    pid: string,
    body: Json,
    actor: { kind: "human"; id?: string },
    widen: boolean,
    dryRun = false,
  ): LlmSettings {
    const cur = this.get(pid);
    if (body["revision"] !== undefined && body["revision"] !== cur.revision)
      throw new HttpError(409, "stale_revision", `settings are at revision ${cur.revision}`);
    let next = this.normalize(body, cur);
    // New egress approvals carry who and when; the caller's values for those are ignored.
    next = {
      ...next,
      updated_by: actor.id ?? "human",
      providers: next.providers.map((p) => {
        if (!p.egress) return p;
        const prev = cur.providers.find((x) => x.provider_id === p.provider_id)?.egress;
        const same = prev && prev.allow_datasets === p.egress.allow_datasets;
        return same
          ? { ...p, egress: prev }
          : {
              ...p,
              egress: compact({
                approved_at: this.o.now().toISOString(),
                approved_by: actor.id ?? "human",
                allow_datasets: p.egress.allow_datasets === true,
                note: p.egress.note,
              }) as NonNullable<LlmProviderConfig["egress"]>,
            };
      }),
    };
    const widening = LlmSettingsStore.widening(cur, next);
    if (widening.length && !widen)
      throw new HttpError(
        403,
        "widening_requires_confirmation",
        "this change widens data controls",
        {
          widening,
          route: `POST /api/v1/projects/${pid}/llm/settings/widen`,
        },
      );
    if (dryRun) return next;
    mkdirSync(join(this.o.stateDir, pid, "llm"), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.file(pid), next, { validate: validateLlmSettings });
    this.cache.set(pid, next);
    const svc = this.o.svc();
    svc.audit.record({
      actor: compact({ kind: "human" as const, id: actor.id }),
      listener: "human",
      action: widen ? "llm.settings.widen" : "llm.settings.update",
      outcome: "allowed",
      project_id: pid,
      target: `revision ${next.revision}`,
      details: compact({
        widening: widening.length ? widening : undefined,
        capture: next.capture.mode,
        retention_days: next.capture.retention_days,
        providers: next.providers.map(
          (p) => `${p.provider_id}:${p.locality}${p.egress ? "+egress" : ""}`,
        ),
      }),
    });
    svc.events.publish(pid, "llm.settings.updated", {
      revision: next.revision,
      capture: next.capture.mode,
    });
    return next;
  }

  /**
   * Resolve a provider for one use, enforcing egress: local providers need nothing; an external
   * one needs an approval, and dataset rows or recorded traces need `allow_datasets`.
   */
  provider(pid: string, providerId: string, model: string, data: EgressData): ProviderUse {
    const p = this.get(pid).providers.find((x) => x.provider_id === providerId);
    if (!p)
      throw new HttpError(404, "unknown_provider", `no LLM provider ${providerId} in this project`);
    if (!p.models.includes(model))
      throw new HttpError(422, "model_not_allowed", `${providerId} does not list model ${model}`, {
        models: p.models,
      });
    if (p.locality === "external") {
      if (!p.egress)
        throw new HttpError(
          403,
          "egress_not_approved",
          `${providerId} is external (${p.base_url}); approve egress first`,
        );
      if (data === "dataset" && !p.egress.allow_datasets)
        throw new HttpError(
          403,
          "dataset_egress_not_approved",
          `${providerId} may receive ad-hoc inputs only; golden-set rows and traces need dataset egress`,
        );
    }
    const env = this.o.env?.() ?? process.env;
    const key = p.api_key_env ? env[p.api_key_env] : undefined;
    if (p.api_key_env && !key)
      throw new HttpError(
        503,
        "api_key_missing",
        `environment variable ${p.api_key_env} is not set for the coordinator`,
      );
    return { provider: p, apiKey: key };
  }

  rate(pid: string, providerId: string, model: string) {
    return this.get(pid)
      .providers.find((p) => p.provider_id === providerId)
      ?.rates?.find((r) => r.model === model);
  }
}
