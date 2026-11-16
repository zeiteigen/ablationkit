/** Display helpers. */

export function fmtTime(ms: number | string | undefined): string {
  if (ms === undefined || ms === "") return "—";
  const d = new Date(typeof ms === "string" && /^\d+$/.test(ms) ? Number(ms) : ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function shortId(id: string | undefined, n = 8): string {
  if (!id) return "—";
  return id.length > n + 2 ? id.slice(0, n) : id;
}
