import type { IncomingMessage, ServerResponse } from "node:http";
import { DEVELOPER_NAME, type Developer, type Store } from "../store/store.js";
import type { AgentId } from "../world/types.js";
import { RateWindow, ipBucket } from "./ip.js";

/**
 * Developer portal API. A developer authenticates with their token (Authorization: Bearer vivdev_...),
 * given by Seah (invited) or obtained by signing up here (self-service). No cookies, so no CSRF;
 * no password or e-mail stored.
 *
 *   GET  /api/portal/signup                is sign-up open, and the per-IP quota
 *   POST /api/portal/signup                {name} → a new account token, shown once
 *   GET  /api/portal/me                    the developer and their agents
 *   POST /api/portal/agents                {label} → a new agent key, shown once
 *   POST /api/portal/agents/<id>/revoke    revoke one of their keys
 *
 * Self-service keys are capped per IP (IPv6: per /64), across accounts: creating more accounts
 * does not give more keys. Revoking a key frees its slot; keys idle for IDLE_DAYS are released.
 */

const MAX_BODY = 1024;
/** Accounts that can be signed up from one IP per day. */
const SIGNUPS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60_000;
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
  /** Anyone may sign up. Default false: invitation only. */
  readonly signup?: boolean;
  /** Active self-service keys per IP. Default 5. */
  readonly keysPerIp?: number;
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
    const route = `${req.method} ${path}`;
    if (route === "GET /api/portal/signup") {
      send(res, 200, { open: this.signupOpen, keys_per_ip: this.keysPerIp });
      return true;
    }
    if (route === "POST /api/portal/signup") {
      readJson(req, res, (body) => this.signup(body, ip, res));
      return true;
    }
    if (this.failures.blocked(ip)) return send(res, 429, { error: "too_many_failed_logins" }), true;

    const auth = req.headers["authorization"];
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const dev = this.deps.store.resolveDeveloper(token);
    if (!dev) {
      this.failures.hit(ip);
      send(res, 401, { error: "invalid_token" });
      return true;
    }

    if (route === "GET /api/portal/me") {
      send(res, 200, this.me(dev, ip));
      return true;
    }
    if (route === "POST /api/portal/agents") {
      readJson(req, res, (body) => this.createAgent(dev, body, ip, res));
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

  private get signupOpen(): boolean {
    return this.deps.signup ?? false;
  }

  private get keysPerIp(): number {
    return this.deps.keysPerIp ?? 5;
  }

  private ipTag(ip: string): string {
    return this.deps.store.ipTag(ipBucket(ip));
  }

  private signup(body: Record<string, unknown>, ip: string, res: ServerResponse): void {
    if (!this.signupOpen) return send(res, 403, { error: "signup_closed" });
    const name = typeof body["name"] === "string" ? body["name"].trim().toLowerCase() : "";
    if (!DEVELOPER_NAME.test(name)) return send(res, 400, { error: "invalid_name", detail: "2-32 characters: a-z, 0-9, _ or -" });
    const tag = this.ipTag(ip);
    const since = new Date((this.deps.now ?? Date.now)() - DAY_MS).toISOString();
    if (this.deps.store.signupsFromIp(tag, since) >= SIGNUPS_PER_DAY) return send(res, 429, { error: "too_many_signups" });
    if (this.deps.store.isDeveloperNameTaken(name)) return send(res, 409, { error: "name_taken" });
    const { token } = this.deps.store.createDeveloper(name, this.keysPerIp, tag);
    send(res, 201, { developer: name, token, note: "Keep this token: it is your only way back in, and it cannot be shown again." });
  }

  private me(dev: Developer, ip: string) {
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
      ...(dev.selfService ? { ip_quota: { used: this.deps.store.activeKeysFromIp(this.ipTag(ip)), max: this.keysPerIp } } : {}),
      agents,
    };
  }

  private createAgent(dev: Developer, body: Record<string, unknown>, ip: string, res: ServerResponse): void {
    const label = typeof body["label"] === "string" ? body["label"].trim() : "";
    if (!LABEL.test(label)) return send(res, 400, { error: "invalid_label", detail: "up to 40 characters: letters, digits, space, _ . -" });
    if (this.deps.store.activeKeyCount(dev.name) >= dev.maxAgents) {
      return send(res, 409, { error: "limit_reached", detail: `${dev.maxAgents} active agents at most: revoke one first` });
    }
    // Self-service keys also count against the IP, whatever the account.
    const tag = dev.selfService ? this.ipTag(ip) : null;
    if (tag && this.deps.store.activeKeysFromIp(tag) >= this.keysPerIp) {
      return send(res, 409, { error: "ip_limit_reached", detail: `${this.keysPerIp} active keys per IP address at most: revoke one first` });
    }
    const { agentId, key } = this.deps.store.createKey(dev.name, label, tag);
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
