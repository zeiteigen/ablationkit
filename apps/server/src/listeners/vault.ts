/**
 * Vault routes (ADR 0049) and the library's (ADR 0052). The same paths exist on the human and
 * agent listeners. Agents read the vault and write notes, works and the index; deleting a note or
 * a work and marking notes read are the researcher's. Every change is attributed and audited.
 */
import {
  CITATION_FORMATS,
  CITE_ROLES,
  type CitationFormat,
  NOTE_TYPES,
  READINGS,
  WORK_KINDS,
} from "@ablationkit/vault";
import { HttpError, json, readJsonBody } from "../http.ts";
import { figureRpc } from "../vault/figures.ts";
import type { ResearchCall, ResearchOp } from "./research.ts";

const pid = (c: ResearchCall) => c.params["id"] as string;
const nid = (c: ResearchCall) => c.params["nid"] as string;
const wid = (c: ResearchCall) => c.params["wid"] as string;

/** A query parameter that must be one of a few values. */
function oneOf(c: ResearchCall, key: string, values: readonly string[]): string | undefined {
  const v = c.url.searchParams.get(key) ?? undefined;
  if (v !== undefined && !values.includes(v))
    throw new HttpError(400, "invalid_request", `\`${key}\` is one of ${values.join(", ")}`);
  return v;
}

function revision(body: Record<string, unknown>): { ifRevision?: number } {
  const v = body["if_revision"];
  if (v === undefined) return {};
  if (!Number.isSafeInteger(v))
    throw new HttpError(400, "invalid_request", "`if_revision` must be an integer");
  return { ifRevision: v as number };
}

function ids(body: Record<string, unknown>, key: string): string[] | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw new HttpError(400, "invalid_request", `\`${key}\` must be an array of note IDs`);
  return v as string[];
}

export const VAULT_OPS: readonly ResearchOp[] = [
  {
    method: "GET",
    path: "/api/v1/projects/:id/vault",
    action: "vault.read",
    agent: true,
    run: (c) =>
      json(200, c.svc.vault.view(pid(c), { brief: c.url.searchParams.get("brief") === "1" })),
  },
  {
    method: "PUT",
    path: "/api/v1/projects/:id/vault/index",
    action: "vault.index.update",
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      for (const k of Object.keys(body))
        if (!["shelf", "bottom_line", "order", "if_revision"].includes(k))
          throw new HttpError(400, "invalid_request", `\`${k}\` is not part of the vault index`);
      return json(
        200,
        c.svc.vault.setIndex(
          pid(c),
          { shelf: body["shelf"], bottom_line: body["bottom_line"], order: body["order"] },
          c.actor,
          { ...revision(body), listener: c.listener },
        ),
      );
    },
  },
  {
    // The file drawer (ADR 0056): every run the project's jobs produced, with how it is accounted for.
    method: "GET",
    path: "/api/v1/projects/:id/vault/runs",
    action: "vault.runs",
    agent: true,
    run: (c) => json(200, { runs: c.svc.witness.accounted(pid(c)) }),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/vault/check",
    action: "vault.check",
    agent: true,
    run: (c) => {
      const checks = c.svc.vault.checks(pid(c));
      return json(200, { checks, total: checks.length });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/vault/reads",
    action: "vault.reads.mark",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const forget = body["forget"] ?? false;
      if (typeof forget !== "boolean")
        throw new HttpError(400, "invalid_request", "`forget` must be a boolean");
      const read = ids(body, "read");
      const unread = ids(body, "unread");
      if (!forget && !read?.length && !unread?.length)
        throw new HttpError(400, "invalid_request", "give `read`, `unread` or `forget`");
      return json(200, {
        reads: c.svc.vault.markRead(
          pid(c),
          { ...(read ? { read } : {}), ...(unread ? { unread } : {}), forget },
          c.actor,
        ),
      });
    },
  },
  {
    // A figure's frame reads runs through the page (ADR 0053): read-only methods, checked here.
    method: "POST",
    path: "/api/v1/projects/:id/vault/notes/:nid/figure/rpc",
    action: "vault.figure.rpc",
    agent: false,
    run: async (c) =>
      json(200, {
        result: await figureRpc(c.svc, pid(c), nid(c), await readJsonBody(c.req), {
          kind: "human",
          id: c.actor.id,
        }),
      }),
  },
  {
    // How a figure fared when the page drew it; an error becomes the `figure_error` check.
    method: "POST",
    path: "/api/v1/projects/:id/vault/notes/:nid/figure/drawn",
    action: "vault.figure.drawn",
    agent: false,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      return json(200, {
        drawn: c.svc.vault.figureDrawn(pid(c), nid(c), {
          revision: body["revision"],
          error: body["error"],
        }),
      });
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/vault/notes",
    action: "vault.notes.list",
    agent: true,
    run: (c) => {
      const u = c.url.searchParams;
      const type = u.get("type") ?? undefined;
      if (type !== undefined && !(NOTE_TYPES as readonly string[]).includes(type))
        throw new HttpError(400, "invalid_request", `\`type\` is one of ${NOTE_TYPES.join(", ")}`);
      const notes = c.svc.vault.list(pid(c), {
        ...(type ? { type } : {}),
        ...(u.get("standing") ? { standing: u.get("standing") as string } : {}),
        ...(u.get("q") ? { q: u.get("q") as string } : {}),
        ...(u.get("task") ? { task: u.get("task") as string } : {}),
        archived: u.get("archived") === "only",
      });
      return json(200, { notes, total: notes.length });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/vault/notes",
    action: "vault.notes.create",
    agent: true,
    run: async (c) => {
      const { id, ...fields } = await readJsonBody(c.req);
      return json(201, c.svc.vault.create(pid(c), id, fields, c.actor, c.listener));
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/vault/notes/:nid",
    action: "vault.notes.read",
    agent: true,
    run: (c) => json(200, c.svc.vault.noteView(pid(c), nid(c))),
  },
  {
    method: "PUT",
    path: "/api/v1/projects/:id/vault/notes/:nid",
    action: "vault.notes.replace",
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const out = c.svc.vault.put(pid(c), nid(c), body, c.actor, c.listener);
      return json(out.created ? 201 : 200, out);
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/projects/:id/vault/notes/:nid",
    action: "vault.notes.update",
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const { if_revision: _r, unset: _u, ...patch } = body;
      const unset = ids(body, "unset");
      return json(
        200,
        c.svc.vault.update(pid(c), nid(c), patch, c.actor, {
          ...revision(body),
          ...(unset ? { unset } : {}),
          listener: c.listener,
        }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/vault/notes/:nid/archive",
    action: "vault.notes.archive",
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const archived = body["archived"] ?? true;
      if (typeof archived !== "boolean")
        throw new HttpError(400, "invalid_request", "`archived` must be a boolean");
      return json(200, c.svc.vault.setArchived(pid(c), nid(c), archived, c.actor, c.listener));
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/projects/:id/vault/notes/:nid",
    action: "vault.notes.delete",
    agent: false,
    run: (c) => json(200, { deleted: c.svc.vault.remove(pid(c), nid(c), c.actor).note_id }),
  },
  // ---- the library (ADR 0052) ---------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/projects/:id/vault/works",
    action: "vault.works.list",
    agent: true,
    run: (c) => {
      const u = c.url.searchParams;
      const kind = oneOf(c, "kind", WORK_KINDS);
      const reading = oneOf(c, "reading", READINGS);
      const role = oneOf(c, "role", CITE_ROLES);
      const standing = oneOf(c, "standing", ["used", "considered", "unread"]);
      const works = c.svc.vault.listWorks(pid(c), {
        ...(u.get("q") ? { q: u.get("q") as string } : {}),
        ...(kind ? { kind } : {}),
        ...(reading ? { reading } : {}),
        ...(role ? { role } : {}),
        ...(standing ? { standing } : {}),
        ...(u.get("task") ? { task: u.get("task") as string } : {}),
        ...(u.get("note") ? { note: u.get("note") as string } : {}),
        archived: u.get("archived") === "only",
      });
      return json(200, { works, total: works.length });
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/vault/works",
    action: "vault.works.create",
    agent: true,
    run: async (c) => {
      const { id, ...fields } = await readJsonBody(c.req);
      return json(201, c.svc.vault.addWork(pid(c), id, fields, c.actor, c.listener));
    },
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/vault/works/:wid",
    action: "vault.works.read",
    agent: true,
    run: (c) => json(200, c.svc.vault.workView(pid(c), wid(c))),
  },
  {
    method: "PUT",
    path: "/api/v1/projects/:id/vault/works/:wid",
    action: "vault.works.replace",
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const out = c.svc.vault.putWork(pid(c), wid(c), body, c.actor, c.listener);
      return json(out.created ? 201 : 200, out);
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/projects/:id/vault/works/:wid",
    action: "vault.works.update",
    agent: true,
    run: async (c) => {
      const { if_revision: _r, ...patch } = await readJsonBody(c.req);
      return json(
        200,
        c.svc.vault.updateWork(pid(c), wid(c), patch, c.actor, {
          ...revision({ if_revision: _r }),
          listener: c.listener,
        }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/v1/projects/:id/vault/works/:wid/archive",
    action: "vault.works.archive",
    agent: true,
    run: async (c) => {
      const body = await readJsonBody(c.req);
      const archived = body["archived"] ?? true;
      if (typeof archived !== "boolean")
        throw new HttpError(400, "invalid_request", "`archived` must be a boolean");
      return json(200, c.svc.vault.setWorkArchived(pid(c), wid(c), archived, c.actor, c.listener));
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/projects/:id/vault/works/:wid",
    action: "vault.works.delete",
    agent: false,
    run: (c) => json(200, { deleted: c.svc.vault.removeWork(pid(c), wid(c), c.actor).work_id }),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/vault/citations",
    action: "vault.citations",
    agent: true,
    run: (c) => {
      const format = (oneOf(c, "format", CITATION_FORMATS) ?? "bibtex") as CitationFormat;
      const notebook = c.url.searchParams.get("notebook") ?? undefined;
      const out = c.svc.vault.citations(pid(c), {
        format,
        ...(notebook ? { notebook } : {}),
        cited: c.url.searchParams.get("cited") === "1",
      });
      return new Response(out.text, {
        status: 200,
        headers: {
          "content-type": out.content_type,
          "content-disposition": `attachment; filename="${out.filename}"`,
          "x-ablationkit-count": String(out.count),
          "cache-control": "no-store",
        },
      });
    },
  },
];
