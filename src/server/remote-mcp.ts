import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AgentLink, handleRpc } from "../../mcp/vivarium-mcp.mjs";
import type { Connection, ConnectionHandlers } from "../../mcp/vivarium-mcp.mjs";
import type { Store } from "../store/store.js";
import type { AgentId } from "../world/types.js";
import { RateWindow } from "./ip.js";

/**
 * Remote MCP: the same tools as the stdio bridge, served by the Vivarium server itself at /mcp
 * (MCP Streamable HTTP, JSON responses). Developers install nothing:
 *
 *   claude mcp add --transport http vivarium https://<host>/mcp --header "Authorization: Bearer viv_..."
 *
 * Each agent key gets one AgentLink, wired to the game server through an in-process socket
 * (no network hop), so the handshake, moderation and limits are exactly those of a WebSocket agent.
 */

const MAX_BODY = 64 * 1024;
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** The subset of a ws WebSocket the game server uses, backed by plain function calls. */
export class VirtualSocket extends EventEmitter {
  readyState = 1; // OPEN
  constructor(private readonly deliver: (text: string) => void, private readonly onClosed: (code: number, reason: string) => void) {
    super();
  }
  send(data: string): void {
    if (this.readyState !== 1) return;
    queueMicrotask(() => this.deliver(String(data)));
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    queueMicrotask(() => {
      this.emit("close", code, Buffer.from(reason));
      this.onClosed(code, reason);
    });
  }
  terminate(): void {
    this.close(1006, "terminated");
  }
  ping(): void {
    queueMicrotask(() => this.emit("pong"));
  }
  /** Client → server frame. */
  receive(text: string): void {
    if (this.readyState === 1) this.emit("message", Buffer.from(text), false);
  }
}

interface RemoteSession {
  readonly link: AgentLink;
  lastUsed: number;
  inFlight: number;
}

export interface RemoteMcpOptions {
  readonly store: Store;
  /** Hands a new virtual socket to the game server, as if a WebSocket agent had connected. */
  readonly attach: (socket: VirtualSocket) => void;
  /** Allowed browser origin (from PUBLIC_URL). Requests with another Origin header are refused. */
  readonly publicOrigin: string;
  /** An agent that makes no call for this long leaves the world. Default 5 minutes. */
  readonly idleMs?: number;
  readonly log?: (line: string) => void;
}

export class RemoteMcp {
  private readonly sessions = new Map<AgentId, RemoteSession>();
  private readonly requests = new RateWindow(300, 60_000);
  private readonly failures = new RateWindow(20, 10 * 60_000);
  private readonly sweeper: NodeJS.Timeout;
  private readonly idleMs: number;

  constructor(private readonly opts: RemoteMcpOptions) {
    this.idleMs = opts.idleMs ?? 5 * 60_000;
    this.sweeper = setInterval(() => this.sweep(), Math.min(30_000, this.idleMs));
    this.sweeper.unref();
  }

  stop(): void {
    clearInterval(this.sweeper);
    for (const s of this.sessions.values()) s.link.close();
    this.sessions.clear();
  }

  /** Returns true when the request was for /mcp. */
  handle(req: IncomingMessage, res: ServerResponse, ip: string): boolean {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/mcp") return false;

    const origin = req.headers["origin"];
    if (typeof origin === "string" && origin !== this.opts.publicOrigin && !isLocalOrigin(origin)) {
      return json(res, 403, { error: "origin_not_allowed" }), true;
    }
    if (!this.requests.hit(ip)) return json(res, 429, { error: "too_many_requests" }), true;
    if (this.failures.blocked(ip)) return json(res, 429, { error: "too_many_failed_keys" }), true;

    if (req.method === "GET") return res.writeHead(405, { allow: "POST, DELETE" }).end(), true;
    if (req.method !== "POST" && req.method !== "DELETE") return res.writeHead(405, { allow: "POST, DELETE" }).end(), true;

    const auth = req.headers["authorization"];
    const key = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const agentId = key ? this.opts.store.resolve(key) : null;
    if (!agentId) {
      this.failures.hit(ip);
      res.writeHead(401, { ...HEADERS, "www-authenticate": 'Bearer realm="vivarium"' }).end(JSON.stringify({ error: "invalid_key" }));
      return true;
    }

    if (req.method === "DELETE") {
      this.end(agentId);
      return res.writeHead(204).end(), true;
    }

    readBody(req, res, async (body) => {
      const session = this.sessionFor(agentId, key);
      session.inFlight++;
      session.lastUsed = Date.now();
      try {
        const out = Array.isArray(body)
          ? (await Promise.all(body.map((m) => handleRpc(m, session.link)))).filter((r) => r !== null)
          : await handleRpc(body, session.link);
        if (out === null || (Array.isArray(out) && out.length === 0)) return res.writeHead(202).end();
        json(res, 200, out);
      } catch (e) {
        this.opts.log?.(`mcp error: ${(e as Error).message}`);
        json(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
      } finally {
        session.inFlight--;
        session.lastUsed = Date.now();
      }
    });
    return true;
  }

  /** Agents currently driven through /mcp. */
  get count(): number {
    return this.sessions.size;
  }

  private sessionFor(agentId: AgentId, key: string): RemoteSession {
    const existing = this.sessions.get(agentId);
    if (existing) return existing;
    const link = new AgentLink({
      key,
      manifest: { agent: "vivarium-remote-mcp" },
      log: (...parts) => this.opts.log?.(`mcp ${agentId}: ${parts.join(" ")}`),
      open: (h: ConnectionHandlers): Connection => {
        const socket = new VirtualSocket(
          (text) => h.message(text),
          (code, reason) => h.close(code, reason),
        );
        this.opts.attach(socket);
        queueMicrotask(() => h.open());
        return {
          send: (text) => socket.receive(text),
          close: (code) => socket.close(code ?? 1000, "bye"),
        };
      },
    });
    const session: RemoteSession = { link, lastUsed: Date.now(), inFlight: 0 };
    this.sessions.set(agentId, session);
    return session;
  }

  private end(agentId: AgentId): void {
    const s = this.sessions.get(agentId);
    if (!s) return;
    s.link.close();
    this.sessions.delete(agentId);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [agentId, s] of this.sessions) {
      if (s.inFlight === 0 && now - s.lastUsed > this.idleMs) {
        this.opts.log?.(`mcp ${agentId}: idle, leaving`);
        this.end(agentId);
      }
    }
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch {
    return false;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, HEADERS).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, res: ServerResponse, then: (body: unknown) => void): void {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) return json(res, 415, { error: "json_required" });
  let size = 0;
  let aborted = false;
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY && !aborted) {
      aborted = true;
      json(res, 413, { error: "body_too_large" });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return;
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    then(body);
  });
}
