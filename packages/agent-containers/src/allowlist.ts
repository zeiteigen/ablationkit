/**
 * The egress allowlist (ADR 0061): which hosts a container's proxy connects to. Pure.
 *
 * A pattern is `example.com` (that host on ports 80 and 443), `*.example.com` (its subdomains, not
 * the host itself), either with `:port` for one other port, or `*` (any host). Whatever the
 * pattern, the proxy never connects to an address that is not public (loopback, private,
 * link-local, carrier-grade NAT such as a tailnet, multicast): a container must not reach this
 * machine's own services (the coordinator, MLflow) or the local network through a name it was
 * allowed.
 */
import { isIP } from "node:net";

export const DEFAULT_PORTS: readonly number[] = [80, 443];

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*$/;

/** A host name as the proxy compares it: lowercase, without a trailing dot. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** A host the proxy will look up: a DNS name or an IPv4 address (IPv6 literals are refused). */
export function validHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h.length === 0 || h.length > 253) return false;
  return isIP(h) === 4 || HOST_RE.test(h);
}

/** Parse a pattern into its host part and ports; undefined when it is not a valid pattern. */
export function parsePattern(
  pattern: string,
):
  | { readonly any: true }
  | { readonly host: string; readonly ports: readonly number[] }
  | undefined {
  const p = normalizeHost(pattern);
  if (p === "*") return { any: true };
  const m = /^(\*\.)?([a-z0-9.-]+?)(?::([0-9]{1,5}))?$/.exec(p);
  if (!m) return undefined;
  const host = m[2] as string;
  if (!validHost(host)) return undefined;
  const port = m[3] === undefined ? undefined : Number(m[3]);
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  return { host: `${m[1] ?? ""}${host}`, ports: port === undefined ? DEFAULT_PORTS : [port] };
}

/** Is `host:port` allowed by any of `patterns`? */
export function hostAllowed(patterns: readonly string[], host: string, port: number): boolean {
  const h = normalizeHost(host);
  if (!validHost(h)) return false;
  for (const raw of patterns) {
    const p = parsePattern(raw);
    if (!p) continue;
    if ("any" in p) return true;
    if (!p.ports.includes(port)) continue;
    if (p.host.startsWith("*.")) {
      const suffix = p.host.slice(1);
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === p.host) return true;
  }
  return false;
}

function ipv4Parts(ip: string): number[] | undefined {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return undefined;
  return parts;
}

/**
 * Is `ip` a public unicast address? False for loopback, private (RFC 1918, unique local),
 * link-local, carrier-grade NAT (100.64/10: Tailscale), multicast, unspecified, documentation and
 * benchmarking ranges, and IPv4-mapped forms of any of them.
 */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const p = ipv4Parts(ip);
    if (!p) return false;
    const [a, b, c] = p as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a >= 224) return false;
    return true;
  }
  if (kind === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:([0-9.]+)$/.exec(s);
    if (mapped) return isPublicAddress(mapped[1] as string);
    if (s === "::" || s === "::1") return false;
    const first = Number.parseInt(s.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
    if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (s.startsWith("2001:db8:") || s.startsWith("2001:0db8:")) return false;
    if (s.startsWith("64:ff9b:")) return false; // NAT64 can reach IPv4 private space
    return true;
  }
  return false;
}
