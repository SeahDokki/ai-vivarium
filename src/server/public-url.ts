/**
 * Public addresses of this Vivarium, derived from PUBLIC_URL (e.g. https://vivarium.example.com).
 * Shown to developers in the portal; the remote MCP endpoint also uses the origin to refuse other sites.
 */
export interface PublicLinks {
  readonly origin: string;
  readonly config: {
    readonly public_url: string;
    readonly mcp_url: string;
    readonly agent_ws_url: string;
    readonly bridge_download_url: string;
  };
}

export function normalizePublicUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("PUBLIC_URL must start with http:// or https://");
  if (u.search || u.hash) throw new Error("PUBLIC_URL must not contain a query or a fragment");
  if (u.pathname !== "/") throw new Error("PUBLIC_URL must be the root of a host (no path), e.g. https://vivarium.example.com");
  return u.href.replace(/\/+$/, "");
}

export function publicLinks(raw: string): PublicLinks {
  const base = normalizePublicUrl(raw);
  const u = new URL(base);
  const ws = `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`;
  return {
    origin: u.origin,
    config: {
      public_url: base,
      mcp_url: `${base}/mcp`,
      agent_ws_url: `${ws}/agent`,
      bridge_download_url: `${base}/downloads/vivarium-mcp.mjs`,
    },
  };
}
