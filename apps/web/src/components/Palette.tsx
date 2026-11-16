/** Command palette (Ctrl/⌘ K), mirroring the CLI: each entry shows its `ablationkit …` line. */
import { useMemo, useState } from "react";
import { api } from "../api.ts";
import type { Project } from "../app.tsx";
import { matchCommands, type PaletteCommand, parseInput } from "../palette-commands.ts";
import { navigate } from "../router.ts";
import { ErrorBox } from "./ui.tsx";

export function Palette(props: {
  onClose: () => void;
  projectId: string | undefined;
  projects: readonly Project[];
}) {
  const [input, setInput] = useState("");
  const [sel, setSel] = useState(0);
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<unknown>();
  const pid = props.projectId;
  const base = pid ? `/p/${encodeURIComponent(pid)}` : "";

  const items = useMemo(() => {
    const cmds = matchCommands(input, { hasProject: pid !== undefined });
    // Projects are commands too ("open project").
    const q = input.trim().toLowerCase();
    const projects: PaletteCommand[] = props.projects
      .filter((p) => !q || `${p.name} ${p.project_id}`.toLowerCase().includes(q))
      .slice(0, 5)
      .map((p) => ({
        id: `open:${p.project_id}`,
        title: `Open ${p.name}`,
        phrase: `project show ${p.project_id}`,
        cli: `ablationkit project show ${p.project_id}`,
      }));
    // Last, in a project: search the vault's notes for what was typed.
    const search: PaletteCommand[] =
      pid && q
        ? [
            {
              id: "vault.search",
              title: `Search notes for “${input.trim()}”`,
              phrase: "find note",
            },
          ]
        : [];
    return [...cmds, ...projects, ...search];
  }, [input, pid, props.projects]);

  const go = (to: string) => {
    navigate(to);
    props.onClose();
  };

  const exec = async (c: PaletteCommand) => {
    setErr(undefined);
    setMsg(undefined);
    const { arg } = parseInput(input);
    if (c.id.startsWith("open:")) return go(`/p/${encodeURIComponent(c.id.slice(5))}`);
    if (c.arg && !arg && c.id !== "runs.search") {
      const short = c.phrase.split(/ [A-Z]/)[0];
      setInput(`${short} `);
      setMsg(`Type the ${c.arg} after the command, then press Enter.`);
      return;
    }
    try {
      switch (c.id) {
        case "go.docs":
          return go("/docs");
        case "go.home":
          return go("/");
        case "go.compute":
          return go("/compute");
        case "go.system":
        case "tracking.doctor":
        case "tracking.outbox":
        case "backup.list":
          return go("/system");
        case "go.settings":
          return go("/settings");
        case "project.add": {
          const r = await api<{ project: Project }>("/api/v1/projects", { body: { path: arg } });
          return go(`/p/${encodeURIComponent(r.project.project_id)}`);
        }
        case "project.show":
          return go(`/p/${encodeURIComponent(arg)}`);
        case "project.doctor":
          return go(`${base}/settings`);
        case "run.submit":
          return go(`${base}/runs/jobs?launch=1`);
        case "run.status":
          return go(`${base}/runs/jobs`);
        case "run.logs": {
          const j = await api<{ project_id: string }>(`/api/v1/jobs/${encodeURIComponent(arg)}`);
          return go(`/p/${encodeURIComponent(j.project_id)}/runs/jobs/${encodeURIComponent(arg)}`);
        }
        case "run.cancel":
          await api(`/api/v1/jobs/${encodeURIComponent(arg)}/cancel`, { body: {} });
          setMsg(`Cancel requested for ${arg}.`);
          return;
        case "run.retry":
          await api(`/api/v1/jobs/${encodeURIComponent(arg)}/retry`, { body: {} });
          setMsg(`Retry started for ${arg}.`);
          return;
        case "runs.search":
          return go(`${base}/runs${arg ? `?filter=${encodeURIComponent(arg)}` : ""}`);
        case "runs.compare":
          return go(`${base}/runs/compare`);
        case "studies":
          return go(`${base}/runs/studies`);
        case "experiments":
          return go(`${base}/runs/experiments`);
        case "standing":
          return go(`${base}/standing`);
        case "notebooks":
          return go(`${base}/notebooks`);
        case "vault.find":
        case "vault.search": {
          // Find opens on the vault page the reader is on, else on Standing; a search starts typed.
          const here = /^\/p\/[^/]+\/(standing|notebooks)/.test(location.pathname);
          const q = new URLSearchParams(here ? location.search : "");
          q.set("find", c.id === "vault.search" ? input.trim() : "1");
          return go(`${here ? location.pathname : `${base}/standing`}?${q}`);
        }
        case "vault.library":
          return go(`${base}/notebooks/library`);
        case "vault.tree":
          return go(`${base}/notebooks/tree`);
        case "knowledge":
          return go(`${base}/knowledge`);
        case "research.note":
          return go(`${base}/knowledge/notes`);
        case "research.hypothesis":
          return go(`${base}/knowledge/hypotheses`);
        case "research.report":
          return go(`${base}/knowledge/reports`);
        case "conversation.link":
          return go(`${base}/knowledge/conversations`);
        case "research.export": {
          const r = await api<{ written: string[] }>(
            `/api/v1/projects/${encodeURIComponent(pid ?? "")}/research/export`,
            {
              body: {},
            },
          );
          setMsg(`Export written (${r.written.length} file(s) changed).`);
          return;
        }
        case "lineage": {
          const i = arg.indexOf(":");
          const kind = arg.slice(0, i);
          const id = arg.slice(i + 1);
          if (i <= 0 || !id) throw new Error("give KIND:ID, e.g. run:abc123");
          if (kind === "run") return go(`${base}/runs/r/${encodeURIComponent(id)}`);
          if (kind === "job") return go(`${base}/runs/jobs/${encodeURIComponent(id)}`);
          if (kind === "study") return go(`${base}/runs/studies/${encodeURIComponent(id)}`);
          if (kind === "logged_model") return go(`${base}/models/m/${encodeURIComponent(id)}`);
          if (kind === "evaluation")
            return go(`${base}/data/evaluations/${encodeURIComponent(id)}`);
          return go(`${base}/knowledge/r/${encodeURIComponent(id)}`);
        }
        case "dataset.list":
          return go(`${base}/data`);
        case "model.list":
          return go(`${base}/models`);
        case "model.show":
          return go(`${base}/models/m/${encodeURIComponent(arg)}`);
        case "registry.list":
          return go(`${base}/models/registry`);
        case "evaluation.run":
          return go(`${base}/data/evaluations/new`);
        case "evaluation.list":
          return go(`${base}/data/evaluations`);
        case "mlproject.show":
          return go(`${base}/runs/entrypoints`);
        case "inference.predict":
          return go(`${base}/models/inference`);
        case "inference.session":
          return go(`${base}/models/inference/session`);
        case "inference.compare":
          return go(`${base}/models/inference/compare`);
        case "inference.evidence":
          return go(`${base}/models/inference/evidence`);
        case "llm.traces":
          return go(`${base}/llm`);
        case "llm.prompts":
          return go(`${base}/llm/prompts`);
        case "llm.eval":
          return go(`${base}/llm/evaluations/new`);
        case "llm.playground":
          return go(`${base}/llm/playground`);
        case "llm.golden":
          return go(`${base}/llm/golden`);
        case "llm.controls":
          return go(`${base}/llm/settings`);
        case "backup.create": {
          const b = await api<{ backup_id: string }>("/api/v1/backups", { body: {} });
          setMsg(`Backup ${b.backup_id} created.`);
          return;
        }
      }
    } catch (e) {
      setErr(e);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes; Escape is handled on window
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="dialog palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          // biome-ignore lint/a11y/noAutofocus: a palette is opened to type into
          autoFocus
          placeholder="Type a command, e.g. run logs JOB_ID"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              const c = items[sel];
              if (c) void exec(c);
            }
          }}
          aria-label="Command"
        />
        {msg ? (
          <div className="banner" style={{ margin: 8 }}>
            {msg}
          </div>
        ) : null}
        {err ? (
          <div style={{ margin: 8 }}>
            <ErrorBox error={err} />
          </div>
        ) : null}
        <ul>
          {items.map((c, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled on the input
            <li
              key={c.id}
              className={i === sel ? "sel" : ""}
              onMouseEnter={() => setSel(i)}
              onClick={() => void exec(c)}
            >
              <span>{c.title}</span>
              <span className="cli">{c.cli ?? c.phrase}</span>
            </li>
          ))}
          {items.length === 0 ? <li className="faint">No matching command.</li> : null}
        </ul>
      </div>
    </div>
  );
}
