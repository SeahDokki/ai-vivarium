import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/**
 * The client's IP address, for per-IP limits.
 * Proxy headers are only trusted when the server sits behind a proxy it controls (TRUST_PROXY=1),
 * and only when the request comes from that proxy (loopback). Otherwise anyone could forge them.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const direct = req.socket.remoteAddress ?? "unknown";
  if (!trustProxy || !isLoopback(direct)) return direct;
  // Cloudflare sets CF-Connecting-IP; nginx passes it through or sets X-Real-IP / X-Forwarded-For.
  for (const h of ["cf-connecting-ip", "x-real-ip"]) {
    const v = req.headers[h];
    if (typeof v === "string" && isIP(v.trim())) return v.trim();
  }
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") {
    const first = xff.split(",")[0]?.trim();
    if (first && isIP(first)) return first;
  }
  return direct;
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** Fixed-window counter per key (IP). */
export class RateWindow {
  private readonly hits = new Map<string, { count: number; start: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one hit; false when over the limit. */
  hit(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      this.hits.set(key, { count: 1, start: t });
      this.prune(t);
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }

  /** True when the key is already over the limit, without counting. */
  blocked(key: string): boolean {
    const h = this.hits.get(key);
    return !!h && this.now() - h.start < this.windowMs && h.count >= this.limit;
  }

  private prune(t: number): void {
    if (this.hits.size < 10_000) return;
    for (const [k, h] of this.hits) if (t - h.start >= this.windowMs) this.hits.delete(k);
  }
}

/**
 * What counts as "one IP" for quotas: the IPv4 address, or the /64 of an IPv6 address
 * (one subscriber usually holds a whole /64, so per-address limits would not hold).
 */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (isIP(ip) !== 6) return ip;
  const count = (part: string) => (part ? part.split(":").reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0) : 0);
  let groups: string[];
  if (ip.includes("::")) {
    const [head = "", tail = ""] = ip.split("::");
    const missing = 8 - count(head) - count(tail);
    groups = [...(head ? head.split(":") : []), ...Array<string>(missing).fill("0"), ...(tail ? tail.split(":") : [])];
  } else groups = ip.split(":");
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
