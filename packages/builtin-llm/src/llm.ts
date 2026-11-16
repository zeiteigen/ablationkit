/**
 * LLM research (spec §5.6.2; ADR 0021): one facade over the data controls, traces, the prompt
 * registry, golden sets, the playground with saved evidence, and GenAI evaluations.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionPythonBridge,
  ExtensionResearchHost,
} from "@ablationkit/extension-host/backend";
import { GoldenSetService } from "./golden-sets.ts";
import { LlmEvaluationService } from "./llm-evaluations.ts";
import { LlmSettingsStore } from "./llm-settings.ts";
import { PlaygroundService } from "./playground.ts";
import { PromptService } from "./prompts.ts";
import { TraceService } from "./traces.ts";

export const PROMPT_EXPORT_DIR = ".ablationkit/llm/prompts";

export interface LlmServiceOptions {
  readonly svc: () => ExtensionResearchHost;
  readonly stateDir: string;
  readonly now: () => Date;
  readonly bridge: ExtensionPythonBridge;
  /** How often the trace retention sweeper runs. Default one hour; 0 disables it (tests). */
  readonly retentionSweepMs?: number;
  readonly env?: () => Readonly<Record<string, string | undefined>>;
  /** Runs `fn` outside the current request's caller context (for timers). */
  readonly detach?: <T>(fn: () => T) => T;
}

export class LlmService {
  readonly settings: LlmSettingsStore;
  readonly traces: TraceService;
  readonly prompts: PromptService;
  readonly golden: GoldenSetService;
  readonly playground: PlaygroundService;
  readonly evaluations: LlmEvaluationService;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly o: LlmServiceOptions) {
    const base = { svc: o.svc, stateDir: o.stateDir, now: o.now };
    this.settings = new LlmSettingsStore({ ...base, ...(o.env ? { env: o.env } : {}) });
    this.traces = new TraceService({ svc: o.svc, settings: this.settings, now: o.now });
    this.prompts = new PromptService({ svc: o.svc });
    this.golden = new GoldenSetService(base);
    this.playground = new PlaygroundService({
      ...base,
      settings: this.settings,
      prompts: this.prompts,
      golden: this.golden,
      traces: this.traces,
    });
    this.evaluations = new LlmEvaluationService({
      ...base,
      bridge: o.bridge,
      settings: this.settings,
      prompts: this.prompts,
      golden: this.golden,
      traces: this.traces,
      ...(o.detach ? { detach: o.detach } : {}),
    });
  }

  get loadProblems(): string[] {
    return [
      ...this.golden.loadProblems,
      ...this.playground.loadProblems,
      ...this.evaluations.loadProblems,
    ];
  }

  load(pids: readonly string[]): void {
    this.golden.load(pids);
    this.playground.load(pids);
    this.evaluations.load(pids);
  }

  start(): void {
    this.evaluations.start();
    const every = this.o.retentionSweepMs ?? 3_600_000;
    if (every > 0) {
      const sweep = () => void this.sweep();
      setTimeout(sweep, Math.min(every, 60_000)).unref?.();
      this.timer = setInterval(sweep, every);
      this.timer.unref?.();
    }
  }

  async sweep(): Promise<Record<string, number>> {
    return this.traces.sweep(
      this.o
        .svc()
        .registry.list()
        .map((p) => p.project_id),
    );
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.evaluations.shutdown();
  }

  /**
   * Export a prompt's versions and current aliases to the main checkout for project jobs
   * (`ablationkit_llm.load_prompt`), with the alias snapshot time. Best effort.
   */
  async exportPrompt(pid: string, name: string): Promise<void> {
    try {
      const p = (await this.prompts.get(pid, name)) as {
        versions: { version: number; template: unknown; format: string; template_sha256: string }[];
        aliases: { alias: string; version: string }[];
      };
      const root = this.o.svc().registry.require(pid).path;
      const dir = join(root, PROMPT_EXPORT_DIR);
      mkdirSync(dir, { recursive: true });
      const doc = {
        notice:
          "Exported by AblationKit; edits here are not read back. Aliases are a snapshot: the coordinator resolves them at use.",
        name,
        exported_at: this.o.now().toISOString(),
        aliases: Object.fromEntries(p.aliases.map((a) => [a.alias, Number(a.version)])),
        versions: Object.fromEntries(
          p.versions.map((v) => [
            String(v.version),
            { template: v.template, format: v.format, sha256: v.template_sha256 },
          ]),
        ),
      };
      const text = `${JSON.stringify(doc, null, 2)}\n`;
      const f = join(dir, `${name}.json`);
      const same =
        existsSync(f) &&
        createHash("sha256").update(readFileSync(f)).digest("hex") ===
          createHash("sha256").update(text).digest("hex");
      if (!same) writeFileSync(f, text);
    } catch {
      // read-only checkout or MLflow down: jobs fall back to explicit templates
    }
  }
}
