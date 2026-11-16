/**
 * LLM research operations (spec §5.6 GenAI rows, §5.6.2, §12.1; ADR 0021): the handlers behind
 * the manifest's project-scoped routes (`/api/v1/projects/:id/llm/...`).
 *
 * Agents read everything (traces, prompts, golden sets, evaluations, evidence, settings), may
 * propose prompt versions and golden sets (not held-out ones), link traces to research records and
 * generate evaluation reports. Running models (playground, evaluations), feedback, aliases,
 * evidence and data-control changes are human-only; a widening of data controls is sent to its own
 * route, so it is never made by accident.
 */

import { HttpError, json, readJsonBody } from "@ablationkit/core/http";
import type { BackendCaller, ExtensionResearchHost } from "@ablationkit/extension-host/backend";
import type { ObjectRef } from "@ablationkit/protocol";
import { compact } from "./helpers.ts";
import type { LlmService } from "./llm.ts";
import { inspectProvider } from "./llm-provider.ts";

interface ResearchCall {
  req: Request;
  url: URL;
  params: Readonly<Record<string, string>>;
  svc: ExtensionResearchHost & { llm: LlmService };
  actor: BackendCaller;
  listener: "human" | "agent";
}
interface ResearchOp {
  action: string;
  run(c: ResearchCall): Response | Promise<Response>;
}

const pid = (c: ResearchCall) => c.params["id"] as string;

function human(c: ResearchCall): { kind: "human"; id?: string } {
  if (c.actor.kind !== "human") throw new HttpError(403, "human_only", "researcher only");
  return compact({ kind: "human" as const, id: c.actor.id });
}

function actor(c: ResearchCall): { kind: "human" | "agent"; id?: string } {
  return compact({
    kind: c.actor.kind === "agent" ? ("agent" as const) : ("human" as const),
    id: c.actor.id,
  });
}

function intParam(url: URL, k: string): number | undefined {
  const v = url.searchParams.get(k);
  if (v === null || v === "") return undefined;
  if (!/^[0-9]+$/.test(v))
    throw new HttpError(400, "invalid_request", `${k} must be a positive integer`);
  return Number(v);
}

/** Handlers by manifest operation ID; the manifest declares each one's method, path and agent access. */
export const LLM_OPS: readonly ResearchOp[] = [
  // ---------------------------------------------------------------- data controls
  {
    action: "llm.settings.read",
    run: (c) => json(200, { settings: c.svc.llm.settings.view(pid(c)) }),
  },
  {
    action: "llm.settings.update",
    run: async (c) => {
      const body = await readJsonBody(c.req);
      c.svc.llm.settings.update(pid(c), body, human(c), false);
      void c.svc.llm.sweep();
      return json(200, { settings: c.svc.llm.settings.view(pid(c)) });
    },
  },
  {
    action: "llm.settings.widen",
    run: async (c) => {
      const body = await readJsonBody(c.req);
      c.svc.llm.settings.update(pid(c), body, human(c), true);
      return json(200, { settings: c.svc.llm.settings.view(pid(c)) });
    },
  },
  {
    action: "llm.provider.check",
    run: async (c) => {
      human(c);
      const p = c.svc.llm.settings
        .get(pid(c))
        .providers.find((x) => x.provider_id === c.params["provider"]);
      if (!p) throw new HttpError(404, "unknown_provider", `no provider ${c.params["provider"]}`);
      // Listing models sends no project data, so it needs no egress approval.
      const t0 = performance.now();
      try {
        const r = await inspectProvider(p.base_url);
        const j = (await r.json().catch(() => ({}))) as { data?: { id?: string }[] };
        return json(200, {
          provider_id: p.provider_id,
          reachable: r.ok,
          status: r.status,
          latency_ms: Math.round(performance.now() - t0),
          models: (j.data ?? [])
            .map((m) => m.id)
            .filter(Boolean)
            .slice(0, 200),
          listed: p.models,
        });
      } catch (e) {
        return json(200, {
          provider_id: p.provider_id,
          reachable: false,
          error: (e as Error).message.slice(0, 300),
        });
      }
    },
  },
  // ---------------------------------------------------------------- traces
  {
    action: "llm.trace.search",
    run: async (c) => {
      const q = (k: string) => c.url.searchParams.get(k) ?? undefined;
      return json(
        200,
        await c.svc.llm.traces.search(pid(c), {
          status: q("status"),
          run_id: q("run_id"),
          name: q("name"),
          source: q("source"),
          evaluation: q("evaluation"),
          example_id: q("example_id"),
          variant: q("variant"),
          prompt: q("prompt"),
          model: q("model"),
          page_token: q("page_token"),
          max_results: intParam(c.url, "max_results"),
          clusters: q("clusters") === "1" || q("clusters") === "true",
        }),
      );
    },
  },
  {
    action: "llm.trace.read",
    run: async (c) => json(200, await c.svc.llm.traces.get(pid(c), c.params["tid"] as string)),
  },
  {
    action: "llm.trace.feedback",
    run: async (c) => {
      const body = await readJsonBody(c.req);
      return json(200, {
        assessment: await c.svc.llm.traces.feedback(
          pid(c),
          c.params["tid"] as string,
          body,
          human(c),
        ),
      });
    },
  },
  {
    action: "llm.trace.link",
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const tid = c.params["tid"] as string;
      await c.svc.llm.traces.info(pid(c), tid);
      const to = body["to"] as ObjectRef | undefined;
      if (!to || typeof to.id !== "string")
        throw new HttpError(400, "invalid_request", "to: {kind, id} of a research record");
      await c.svc.llm.traces.link(pid(c), tid, to, actor(c));
      return json(200, { linked: { trace: tid, to: to.id } });
    },
  },
  // ---------------------------------------------------------------- prompts
  {
    action: "llm.prompt.list",
    run: async (c) =>
      json(200, {
        prompts: await c.svc.llm.prompts.list(pid(c), {
          q: c.url.searchParams.get("q") ?? undefined,
        }),
      }),
  },
  {
    action: "llm.prompt.resolve",
    run: async (c) => {
      const r = await c.svc.llm.prompts.resolve(pid(c), c.url.searchParams.get("ref") ?? "");
      return json(200, r);
    },
  },
  {
    action: "llm.prompt.version",
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const v = await c.svc.llm.prompts.createVersion(pid(c), body, actor(c));
      await c.svc.llm.exportPrompt(pid(c), v.name);
      return json(201, { version: v });
    },
  },
  {
    action: "llm.prompt.read",
    run: async (c) =>
      json(200, { prompt: await c.svc.llm.prompts.get(pid(c), c.params["name"] as string) }),
  },
  {
    action: "llm.prompt.diff",
    run: async (c) => {
      const from = intParam(c.url, "from");
      const to = intParam(c.url, "to");
      if (from === undefined || to === undefined)
        throw new HttpError(400, "invalid_request", "give from and to versions");
      return json(
        200,
        await c.svc.llm.prompts.diff(
          pid(c),
          c.params["name"] as string,
          from,
          to,
          c.url.searchParams.get("to_name") ?? undefined,
        ),
      );
    },
  },
  {
    action: "llm.prompt.alias",
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const v = body["version"];
      if (v !== null && (typeof v !== "number" || !Number.isSafeInteger(v)))
        throw new HttpError(
          400,
          "invalid_request",
          "version is a number (or null to remove the alias)",
        );
      const name = c.params["name"] as string;
      const r = await c.svc.llm.prompts.setAlias(
        pid(c),
        name,
        String(body["alias"] ?? ""),
        v as number | null,
        human(c),
      );
      await c.svc.llm.exportPrompt(pid(c), name);
      return json(200, r);
    },
  },
  // ---------------------------------------------------------------- golden sets
  {
    action: "llm.golden_set.list",
    run: (c) => json(200, { golden_sets: c.svc.llm.golden.list(pid(c)) }),
  },
  {
    action: "llm.golden_set.create",
    run: async (c) =>
      json(201, {
        golden_set: c.svc.llm.golden.create(
          pid(c),
          await readJsonBody(c.req, 33 * 1024 * 1024),
          actor(c),
        ),
      }),
  },
  {
    action: "llm.golden_set.export",
    run: (c) => {
      human(c);
      c.svc.llm.golden.exportToCheckout(pid(c));
      return json(200, { exported: true });
    },
  },
  {
    action: "llm.golden_set.read",
    run: (c) => json(200, { golden_set: c.svc.llm.golden.get(pid(c), c.params["gs"] as string) }),
  },
  {
    action: "llm.golden_set.examples",
    run: (c) => {
      const r = c.svc.llm.golden.examples(
        pid(c),
        c.params["gs"] as string,
        intParam(c.url, "version"),
      );
      const hide = c.actor.kind === "agent" && r.set.held_out;
      return json(200, {
        golden_set_id: r.set.golden_set_id,
        version: r.version,
        expectations_hidden: hide || undefined,
        examples: hide
          ? r.examples.map(({ expectations: _e, notes: _n, ...rest }) => rest)
          : r.examples,
      });
    },
  },
  {
    action: "llm.golden_set.version",
    run: async (c) =>
      json(201, {
        golden_set: c.svc.llm.golden.addVersion(
          pid(c),
          c.params["gs"] as string,
          await readJsonBody(c.req, 33 * 1024 * 1024),
          actor(c),
        ),
      }),
  },
  // ---------------------------------------------------------------- playground and evidence
  {
    action: "llm.playground.run",
    run: async (c) => {
      const body = await readJsonBody(c.req, 4 * 1024 * 1024);
      const r = await c.svc.llm.playground.run(pid(c), body, human(c), c.req.signal);
      return json(200, { result: c.svc.llm.playground.view(r) });
    },
  },
  {
    action: "llm.playground.read",
    run: (c) =>
      json(200, {
        result: c.svc.llm.playground.view(
          c.svc.llm.playground.result(pid(c), c.params["rid"] as string),
        ),
      }),
  },
  {
    action: "llm.evidence.save",
    run: async (c) => {
      const body = await readJsonBody(c.req);
      return json(201, {
        evidence: await c.svc.llm.playground.save(
          pid(c),
          c.params["rid"] as string,
          body,
          human(c),
        ),
      });
    },
  },
  {
    action: "llm.evidence.list",
    run: (c) => json(200, { evidence: c.svc.llm.playground.listEvidence(pid(c)) }),
  },
  {
    action: "llm.evidence.read",
    run: (c) =>
      json(200, { evidence: c.svc.llm.playground.getEvidence(pid(c), c.params["lx"] as string) }),
  },
  {
    action: "llm.evidence.delete",
    run: async (c) =>
      json(200, {
        evidence: await c.svc.llm.playground.deleteEvidence(
          pid(c),
          c.params["lx"] as string,
          human(c),
        ),
      }),
  },
  // ---------------------------------------------------------------- GenAI evaluations
  {
    action: "llm.evaluation.list",
    run: (c) => json(200, { evaluations: c.svc.llm.evaluations.list(pid(c)) }),
  },
  {
    action: "llm.evaluation.create",
    run: async (c) => {
      const body = await readJsonBody(c.req);
      return json(201, { evaluation: await c.svc.llm.evaluations.create(pid(c), body, human(c)) });
    },
  },
  {
    action: "llm.evaluation.compare",
    run: async (c) => {
      const q = (k: string) => c.url.searchParams.get(k) ?? undefined;
      const a = q("a");
      const b = q("b");
      if (!a || !b) throw new HttpError(400, "invalid_request", "give a and b evaluation IDs");
      return json(
        200,
        await c.svc.llm.evaluations.compare(
          pid(c),
          a,
          b,
          compact({ a: q("label_a"), b: q("label_b") }),
          c.actor.kind === "agent" ? "agent" : "human",
        ),
      );
    },
  },
  {
    action: "llm.evaluation.read",
    run: (c) =>
      json(200, { evaluation: c.svc.llm.evaluations.get(pid(c), c.params["le"] as string) }),
  },
  {
    action: "llm.evaluation.examples",
    run: async (c) =>
      json(
        200,
        await c.svc.llm.evaluations.examples(
          pid(c),
          c.params["le"] as string,
          c.actor.kind === "agent" ? "agent" : "human",
        ),
      ),
  },
  {
    action: "llm.evaluation.log",
    run: (c) =>
      new Response(c.svc.llm.evaluations.logTail(pid(c), c.params["le"] as string), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
  },
  {
    action: "llm.evaluation.cancel",
    run: async (c) =>
      json(200, {
        evaluation: await c.svc.llm.evaluations.cancel(pid(c), c.params["le"] as string, human(c)),
      }),
  },
  {
    action: "llm.evaluation.flag",
    run: async (c) =>
      json(200, {
        flag: await c.svc.llm.evaluations.flag(
          pid(c),
          c.params["le"] as string,
          await readJsonBody(c.req),
          human(c),
        ),
      }),
  },
  {
    action: "llm.evaluation.report",
    run: async (c) =>
      json(201, await c.svc.llm.evaluations.report(pid(c), c.params["le"] as string, actor(c))),
  },
];
