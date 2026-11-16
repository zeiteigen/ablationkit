/**
 * Prompt templates as MLflow's Prompt Registry stores them (spec §5.6.2 item 1): a text template or
 * a chat template (a list of `{role, content}` messages), with `{{variable}}` placeholders.
 */

export interface ChatMessage {
  role: string;
  content: string;
}
export type Template = string | ChatMessage[];

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

export function isChat(t: Template): t is ChatMessage[] {
  return Array.isArray(t);
}

/** Parse MLflow's stored template (`mlflow.prompt.text`) given its `_mlflow_prompt_type`. */
export function parseTemplate(text: string, type: string | undefined): Template {
  if (type === "chat") {
    try {
      const v = JSON.parse(text) as unknown;
      if (
        Array.isArray(v) &&
        v.every(
          (m) =>
            typeof m === "object" &&
            m !== null &&
            typeof (m as ChatMessage).role === "string" &&
            typeof (m as ChatMessage).content === "string",
        )
      )
        return v as ChatMessage[];
    } catch {
      // fall through: show it as text
    }
  }
  return text;
}

export function templateText(t: Template): string {
  return isChat(t) ? JSON.stringify(t) : t;
}

export function templateVariables(t: Template): string[] {
  const set = new Set<string>();
  for (const s of isChat(t) ? t.map((m) => m.content) : [t]) {
    for (const m of s.matchAll(VAR_RE)) set.add(m[1] as string);
  }
  return [...set].sort();
}

export interface Rendered {
  /** The messages sent to a chat completion (a text template becomes one user message). */
  messages: ChatMessage[];
  missing: string[];
}

function fill(s: string, vars: Readonly<Record<string, unknown>>, missing: Set<string>): string {
  return s.replace(VAR_RE, (_, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null) {
      missing.add(name);
      return "";
    }
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

export function renderPrompt(t: Template, vars: Readonly<Record<string, unknown>>): Rendered {
  const missing = new Set<string>();
  const messages = isChat(t)
    ? t.map((m) => ({ role: m.role, content: fill(m.content, vars, missing) }))
    : [{ role: "user", content: fill(t, vars, missing) }];
  return { messages, missing: [...missing].sort() };
}

export interface DiffLine {
  op: "same" | "add" | "del";
  text: string;
}

/** Line diff by longest common subsequence (bounded: very long inputs fall back to del+add). */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 4_000_000)
    return [
      ...x.map((text) => ({ op: "del" as const, text })),
      ...y.map((text) => ({ op: "add" as const, text })),
    ];
  const n = x.length;
  const m = y.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (L[i] as number[])[j] =
        x[i] === y[j]
          ? ((L[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((L[i + 1] as number[])[j] as number, (L[i] as number[])[j + 1] as number);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: "same", text: x[i] as string });
      i++;
      j++;
    } else if (((L[i + 1] as number[])[j] as number) >= ((L[i] as number[])[j + 1] as number)) {
      out.push({ op: "del", text: x[i] as string });
      i++;
    } else {
      out.push({ op: "add", text: y[j] as string });
      j++;
    }
  }
  while (i < n) out.push({ op: "del", text: x[i++] as string });
  while (j < m) out.push({ op: "add", text: y[j++] as string });
  return out;
}

export interface PromptDiff {
  format: { from: "text" | "chat"; to: "text" | "chat" };
  variables: { added: string[]; removed: string[]; kept: string[] };
  /** Per message for chat templates (role changes are reported), one block for text. */
  blocks: { label: string; role_from?: string; role_to?: string; lines: DiffLine[] }[];
  identical: boolean;
}

export function diffPrompts(a: Template, b: Template): PromptDiff {
  const va = new Set(templateVariables(a));
  const vb = new Set(templateVariables(b));
  const blocks: PromptDiff["blocks"] = [];
  if (isChat(a) && isChat(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const ma = a[i];
      const mb = b[i];
      blocks.push({
        label: `message ${i + 1}`,
        ...(ma ? { role_from: ma.role } : {}),
        ...(mb ? { role_to: mb.role } : {}),
        lines: diffLines(ma?.content ?? "", mb?.content ?? "").filter(
          (l, _k, all) => !(all.length === 1 && l.text === "" && l.op !== "same"),
        ),
      });
    }
  } else {
    const flat = (t: Template) =>
      isChat(t) ? t.map((m) => `[${m.role}] ${m.content}`).join("\n") : t;
    blocks.push({ label: "template", lines: diffLines(flat(a), flat(b)) });
  }
  const identical =
    templateText(a) === templateText(b) ||
    blocks.every((bl) => bl.lines.every((l) => l.op === "same") && bl.role_from === bl.role_to);
  return {
    format: { from: isChat(a) ? "chat" : "text", to: isChat(b) ? "chat" : "text" },
    variables: {
      added: [...vb].filter((v) => !va.has(v)).sort(),
      removed: [...va].filter((v) => !vb.has(v)).sort(),
      kept: [...va].filter((v) => vb.has(v)).sort(),
    },
    blocks,
    identical,
  };
}

/** `name@alias`, `name/3`, `name@3` or `prompts:/name/3`; aliases resolve at the coordinator. */
export function parsePromptRef(
  ref: string,
): { name: string; version?: number; alias?: string } | undefined {
  const s = ref.startsWith("prompts:/") ? ref.slice("prompts:/".length) : ref;
  const m = /^([^@/]{1,256})(?:[@/]([A-Za-z0-9_.-]{1,256}))?$/.exec(s);
  if (!m) return undefined;
  const name = m[1] as string;
  const tail = m[2];
  if (tail === undefined) return { name };
  if (/^[0-9]+$/.test(tail)) return { name, version: Number(tail) };
  if (s.includes("/")) return undefined;
  return { name, alias: tail };
}
