import type { IncomingMessage, ServerResponse } from "node:http";
import type { Developer, Store } from "../store/store.js";
import type { AgentId } from "../world/types.js";
import { RateWindow } from "./ip.js";

/**
 * Developer portal API. Invite-only: a developer authenticates with the token Seah gave them
 * (Authorization: Bearer vivdev_...). No cookies, so no CSRF; no password or e-mail stored.
 *
 *   GET  /api/portal/me                    the developer and their agents
 *   POST /api/portal/agents                {label} → a new agent key, shown once
 *   POST /api/portal/agents/<id>/revoke    revoke one of their keys
 */

const MAX_BODY = 1024;
const LABEL = /^[\p{L}\p{N} _.-]{0,40}$/u;

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export interface PortalDeps {
  readonly store: Store;
  readonly isOnline: (agentId: AgentId) => boolean;
  /** Called after a key is revoked, to cut its live connection at once. */
  readonly onRevoked?: (agentId: AgentId) => void;
  readonly now?: () => number;
}

export class PortalApi {
  /** All requests: 60 per minute per IP. */
  private readonly requests: RateWindow;
  /** Failed authentications: 10 per 10 minutes per IP, then locked for the rest of the window. */
  private readonly failures: RateWindow;

  constructor(private readonly deps: PortalDeps) {
    this.requests = new RateWindow(60, 60_000, deps.now);
    this.failures = new RateWindow(10, 10 * 60_000, deps.now);
  }

  /** Returns true when the request was for the portal API (handled or refused). */
  handle(req: IncomingMessage, res: ServerResponse, ip: string): boolean {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (!path.startsWith("/api/portal/")) return false;

    if (!this.requests.hit(ip)) return send(res, 429, { error: "too_many_requests" }), true;
    if (this.failures.blocked(ip)) return send(res, 429, { error: "too_many_failed_logins" }), true;

    const auth = req.headers["authorization"];
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const dev = this.deps.store.resolveDeveloper(token);
    if (!dev) {
      this.failures.hit(ip);
      send(res, 401, { error: "invalid_token" });
      return true;
    }

    const route = `${req.method} ${path}`;
    if (route === "GET /api/portal/me") {
      send(res, 200, this.me(dev));
      return true;
    }
    if (route === "POST /api/portal/agents") {
      readJson(req, res, (body) => this.createAgent(dev, body, res));
      return true;
    }
    const revoke = /^POST \/api\/portal\/agents\/(agt_[A-Za-z0-9_-]{6,40})\/revoke$/.exec(route);
    if (revoke) {
      const ok = this.deps.store.revokeKeyOf(dev.name, revoke[1]!);
      if (ok) this.deps.onRevoked?.(revoke[1]!);
      send(res, ok ? 200 : 404, ok ? { revoked: true } : { error: "not_found" });
      return true;
    }
    send(res, 404, { error: "not_found" });
    return true;
  }

  private me(dev: Developer) {
    const agents = this.deps.store.agentsOf(dev.name).map((a) => ({
      agent_id: a.agentId,
      label: a.label,
      name: a.name,
      avatar: a.avatar,
      created_at: a.createdAt,
      revoked_at: a.revokedAt,
      last_seen: a.lastSeen,
      contract_version: a.contractVersion,
      online: !a.revokedAt && this.deps.isOnline(a.agentId),
    }));
    return {
      developer: dev.name,
      max_agents: dev.maxAgents,
      active_agents: agents.filter((a) => !a.revoked_at).length,
      agents,
    };
  }

  private createAgent(dev: Developer, body: Record<string, unknown>, res: ServerResponse): void {
    const label = typeof body["label"] === "string" ? body["label"].trim() : "";
    if (!LABEL.test(label)) return send(res, 400, { error: "invalid_label", detail: "up to 40 characters: letters, digits, space, _ . -" });
    if (this.deps.store.activeKeyCount(dev.name) >= dev.maxAgents) {
      return send(res, 409, { error: "limit_reached", detail: `${dev.maxAgents} active agents at most: revoke one first` });
    }
    const { agentId, key } = this.deps.store.createKey(dev.name, label);
    send(res, 201, { agent_id: agentId, key, note: "Copy this key now: it is stored only as a hash and cannot be shown again." });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, HEADERS).end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, res: ServerResponse, then: (body: Record<string, unknown>) => void): void {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) return send(res, 415, { error: "json_required" });
  let size = 0;
  const chunks: Buffer[] = [];
  let aborted = false;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY && !aborted) {
      aborted = true;
      send(res, 413, { error: "body_too_large" });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return;
    let body: unknown;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      return send(res, 400, { error: "invalid_json" });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return send(res, 400, { error: "invalid_json" });
    then(body as Record<string, unknown>);
  });
}
