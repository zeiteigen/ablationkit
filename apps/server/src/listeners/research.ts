/**
 * Research, export and lineage routes (ADR 0013). The same paths exist on the human and agent
 * listeners, so the CLI works unchanged with a session or an agent token. Agents may create,
 * edit, archive and generate; deleting records, clearing drift and forcing an export are human
 * only. Every change is attributed (human session or agent token) and audited.
 */
import type { ObjectRef, ResearchActor, ResearchKind, ResearchRecord } from "@ablationkit/protocol";
import { HttpError, json, readJsonBody, stringList } from "../http.ts";
import { lineage } from "../research/lineage.ts";
import { isResearchKind, type ListQuery, outgoingRefs, parseRef } from "../research/records.ts";
import { generateReport, regenerateReport } from "../research/reports.ts";
import type { Method } from "../router.ts";
import type { Services } from "../services.ts";
import { compact } from "../state/audit.ts";

export interface ResearchCall {
  readonly req: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly svc: Services;
  readonly actor: ResearchActor;
  readonly listener: "human" | "agent";
}

export interface ResearchOp {
  readonly method: Method;
  readonly path: string;
  readonly action: string;
  /** Reachable through the agent listener too. */
  readonly agent: boolean;
  readonly run: (c: ResearchCall) => Response | Promise<Response>;
}

const pid = (c: ResearchCall) => c.params["id"] as string;
const rid = (c: ResearchCall) => c.params["rid"] as string;

function enumParam<T extends string>(url: URL, name: string, allowed: readonly T[]): T | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  if (!(allowed as readonly string[]).includes(v))
    throw new HttpError(400, "invalid_request", `\`${name}\` must be one of ${allowed.join(", ")}`);
  return v as T;
}

/**
 * What a record's links, evidence and backlinks point at, by `kind:id`: titles, statuses and
 * short descriptions, so a reader sees names instead of IDs. Runs and jobs resolve from the
 * coordinator's own files (MLflow may be offline); anything else is left out.
 */
function names(c: ResearchCall, record: ResearchRecord, backlinks: ResearchRecord[]) {
  const p = pid(c);
  const out: Record<string, { title: string; status?: string; summary?: string }> = {};
  const clip = (s: string | undefined) => (s && s.length > 400 ? `${s.slice(0, 400)}…` : s);
  const put = (r: ResearchRecord) => {
    out[`${r.kind}:${r.record_id}`] = compact({
      title: r.title,
      status: r.status,
      summary: clip(r.summary),
    });
  };
  for (const b of backlinks) put(b);
  for (const ref of outgoingRefs(record)) {
    const key = `${ref.kind}:${ref.id}`;
    if (out[key]) continue;
    if (isResearchKind(ref.kind)) {
      const r = c.svc.research.get(p, ref.id);
      if (r) put(r);
    } else if (ref.kind === "task") {
      const t = c.svc.tasks.get(p, ref.id);
      if (t)
        out[key] = compact({
          title: t.title,
          status: t.status === "completed" && t.outcome ? t.outcome : t.status,
          summary: clip(t.conclusion ?? t.goal),
        });
    } else if (ref.kind === "run") {
      const m = c.svc.tracking.mappings.getByRunId(ref.id) ?? c.svc.tracking.mappings.get(ref.id);
      if (m?.project_id === p && m.run_name)
        out[key] = compact({ title: m.run_name, status: m.variant_id });
    } else if (ref.kind === "job") {
      const j = c.svc.jobs.get(ref.id);
      if (j?.project_id === p && (j.run_name || j.description))
        out[key] = compact({ title: j.run_name ?? j.job_id, summary: clip(j.description) });
    }
  }
  return out;
}

function backlinkView(c: ResearchCall, ref: ObjectRef) {
  return c.svc.research.backlinks(pid(c), ref).map((r) =>
    compact({
      record_id: r.record_id,
      kind: r.kind,
      title: r.title,
      status: r.status,
      summary: r.summary && r.summary.length > 400 ? `${r.summary.slice(0, 400)}…` : r.summary,
    }),
  );
}

export const RESEARCH_OPS: readonly ResearchOp[] = [
  {
    method: "GET",
    path: "/api/v1/projects/:id/research",
    action: "research.list",
    agent: true,
    run: (c) => {
      const u = c.url;
      const kind = u.searchParams.get("kind") ?? undefined;
      if (kind !== undefined && !isResearchKind(kind))
        throw new HttpError(400, "invalid_request", "unknown `kind`");
      const q: ListQuery = {
        kind: kind as ResearchKind | undefined,
        tag: u.searchParams.get("tag") ?? undefined,
        status: u.searchParams.get("status") ?? undefined,
        q: u.searchParams.get("q") ?? undefined,
        link: u.searchParams.get("link") ?? undefined,
        source: u.searchParams.get("source") ?? undefined,
        archived: enumParam(u, "archived", ["exclude", "include", "only"] as const),
        sort: enumParam(u, "sort", ["updated", "created", "title"] as const),
        order: enumParam(u, "order", ["asc", "desc"] as const),
      };
      const records = c.svc.research.list(pid(c), q);
      const tags = [...new Set(c.svc.research.all(pid(c)).flatMap((r) => r.tags))].sort();
      return json(200, { records, total: records.length, tags });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/research",
    action: "research.create",
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const { kind, id, ...fields } = body;
      if (!isResearchKind(kind)) throw new HttpError(400, "invalid_request", "unknown `kind`");
      if (id !== undefined && typeof id !== "string")
        throw new HttpError(400, "invalid_request", "`id` must be a string");
      const record = c.svc.research.create(pid(c), kind, fields, c.actor, {
        listener: c.listener,
        ...(id !== undefined ? { id } : {}),
      });
      return json(201, { record });
    },
  },
  // Static paths before `/research/:rid`: the router takes the first match.
  {
    method: "POST",
    path: "/api/v1/projects/:id/research/reports/generate",
    action: "research.report.generate",
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const study = body["study_id"];
      if (typeof study !== "string" || !study)
        throw new HttpError(400, "invalid_request", "`study_id` is required");
      const record = await generateReport(
        c.svc,
        pid(c),
        compact({
          study_id: study,
          title: typeof body["title"] === "string" ? body["title"] : undefined,
          metric_keys: stringList(body, "metric_keys"),
          baseline_variant:
            typeof body["baseline_variant"] === "string" ? body["baseline_variant"] : undefined,
          hypothesis_ids: stringList(body, "hypothesis_ids"),
        }),
        c.actor,
        c.listener,
      );
      return json(201, { record });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/research/export",
    action: "research.export.read",
    agent: false,
    run: (c) => {
      const p = c.svc.registry.require(pid(c));
      return json(200, { checkout: p.path, state: c.svc.research.exportState(pid(c)) });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/research/export",
    action: "research.export.run",
    agent: false,
    run: (c) => {
      c.svc.registry.require(pid(c));
      const result = c.svc.research.exportNow(pid(c));
      c.svc.audit.record({
        actor: compact({ kind: c.actor.kind, id: c.actor.id }),
        listener: c.listener,
        action: "research.export.run",
        outcome: "allowed",
        project_id: pid(c),
        details: { written: result.written.length, drift: result.drift.length },
      });
      return json(200, result);
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/research/export/drift/clear",
    action: "research.export.drift.clear",
    agent: false,
    run: (c) => {
      c.svc.research.clearDrift(pid(c));
      return json(200, { cleared: true });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/research/:rid",
    action: "research.read",
    agent: true,
    run: (c) => {
      const record = c.svc.research.require(pid(c), rid(c));
      const ref = { kind: record.kind, id: record.record_id };
      const st = c.svc.reviews.ofRecord(record);
      return json(200, {
        record,
        backlinks: backlinkView(c, ref),
        names: names(c, record, c.svc.research.backlinks(pid(c), ref)),
        review: compact({
          state: st.review,
          reviewed_at: st.mark?.reviewed_at,
          note: st.mark?.note,
        }),
      });
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/projects/:id/research/:rid",
    action: "research.update",
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const { if_revision, unset: _unset, ...patch } = body;
      if (if_revision !== undefined && !Number.isSafeInteger(if_revision))
        throw new HttpError(400, "invalid_request", "`if_revision` must be an integer");
      const unsetList = stringList(body, "unset");
      const record = c.svc.research.update(pid(c), rid(c), patch, c.actor, {
        listener: c.listener,
        ...(if_revision !== undefined ? { ifRevision: if_revision as number } : {}),
        ...(unsetList ? { unset: unsetList } : {}),
      });
      return json(200, { record });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/research/:rid/archive",
    action: "research.archive",
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const archived = body["archived"] ?? true;
      if (typeof archived !== "boolean")
        throw new HttpError(400, "invalid_request", "`archived` must be a boolean");
      const record = c.svc.research.setArchived(pid(c), rid(c), archived, c.actor, c.listener);
      return json(200, { record });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/research/:rid/regenerate",
    action: "research.report.regenerate",
    agent: true,
    run: async (c) => {
      const record = await regenerateReport(c.svc, pid(c), rid(c), c.actor, c.listener);
      return json(200, { record });
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/projects/:id/research/:rid",
    action: "research.delete",
    agent: false,
    run: (c) => {
      const record = c.svc.research.remove(pid(c), rid(c), c.actor);
      return json(200, { deleted: record.record_id });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/review",
    action: "review.read",
    agent: true,
    run: (c) => json(200, c.svc.reviews.list(pid(c))),
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/review",
    action: "review.mark",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const kind = body["kind"];
      const id = body["id"];
      if (typeof kind !== "string" || typeof id !== "string")
        throw new HttpError(400, "invalid_request", "`kind` and `id` are required");
      if (kind !== "task" && (!isResearchKind(kind) || kind === "conversation"))
        throw new HttpError(400, "invalid_request", "`kind` is a research record kind or task");
      const reviewed = body["reviewed"] ?? true;
      if (typeof reviewed !== "boolean")
        throw new HttpError(400, "invalid_request", "`reviewed` must be a boolean");
      const note = body["note"];
      if (note !== undefined && typeof note !== "string")
        throw new HttpError(400, "invalid_request", "`note` must be a string");
      const st = c.svc.reviews.mark(
        pid(c),
        kind,
        id,
        { reviewed, ...(note !== undefined ? { note } : {}) },
        c.actor,
      );
      return json(
        200,
        compact({ state: st.review, reviewed_at: st.mark?.reviewed_at, note: st.mark?.note }),
      );
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/lineage",
    action: "lineage.read",
    agent: true,
    run: (c) => {
      const kind = c.url.searchParams.get("kind");
      const id = c.url.searchParams.get("id");
      const ref = kind && id ? parseRef(`${kind}:${id}`) : undefined;
      if (!ref) throw new HttpError(400, "invalid_request", "`kind` and `id` are required");
      return json(200, lineage(c.svc, pid(c), ref));
    },
  },
];
