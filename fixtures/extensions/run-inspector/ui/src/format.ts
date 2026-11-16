export function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toPrecision(4);
}
