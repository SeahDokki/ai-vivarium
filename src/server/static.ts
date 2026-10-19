import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Only these files are served. No directory listing, no path built from the URL. */
const FILES: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/art.js": { file: "art.js", type: "text/javascript; charset=utf-8" },
  "/i18n.js": { file: "i18n.js", type: "text/javascript; charset=utf-8" },
  "/portal": { file: "portal.html", type: "text/html; charset=utf-8" },
  "/portal.js": { file: "portal.js", type: "text/javascript; charset=utf-8" },
};

/** src/web, whether we run from src/server (tsx) or from dist/src/server (built). */
const WEB_DIR = [new URL("../web/", import.meta.url), new URL("../../../src/web/", import.meta.url)].find((u) =>
  existsSync(new URL("index.html", u)),
) ?? new URL("../web/", import.meta.url);

/** The MCP bridge, offered as a download for clients that only run local (stdio) MCP servers. */
const BRIDGE_FILE = [new URL("../../mcp/vivarium-mcp.mjs", import.meta.url), new URL("../../../mcp/vivarium-mcp.mjs", import.meta.url)].find((u) =>
  existsSync(u),
);

const SECURITY_HEADERS = {
  // Everything comes from this server; inline scripts and third-party content are refused.
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-cache",
};

/** Returns true when the request was handled. */
export function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  if (path === "/favicon.ico") {
    res.writeHead(204, SECURITY_HEADERS).end();
    return true;
  }
  if (path === "/downloads/vivarium-mcp.mjs" && BRIDGE_FILE) {
    const body = readFileSync(BRIDGE_FILE);
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "content-disposition": 'attachment; filename="vivarium-mcp.mjs"',
      "content-length": body.length,
      ...SECURITY_HEADERS,
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }
  const entry = FILES[path];
  if (!entry) return false;
  let body: Buffer;
  try {
    // Read on each request so edits show up without a restart; the files are tiny.
    body = readFileSync(new URL(entry.file, WEB_DIR));
  } catch {
    res.writeHead(500, { "content-type": "text/plain" }).end("Missing file\n");
    return true;
  }
  res.writeHead(200, { "content-type": entry.type, "content-length": body.length, ...SECURITY_HEADERS });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}
