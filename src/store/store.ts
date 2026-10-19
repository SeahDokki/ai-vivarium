import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Avatar } from "../world/avatar.js";
import type { AgentId, Position } from "../world/types.js";
import type { BanBook } from "../moderation/moderator.js";

/**
 * Persistent state: agent keys, identities, positions, accepted contract version.
 * Nothing secret is stored in clear: keys are kept as SHA-256 hashes and shown once at creation.
 * No chat is stored.
 */

export interface AgentRecord {
  readonly agentId: AgentId;
  readonly name: string | null;
  readonly avatar: Avatar | null;
  readonly lastPos: Position | null;
  readonly contractVersion: string | null;
}

export interface Developer {
  readonly name: string;
  readonly maxAgents: number;
  /** Signed up on the portal (not invited): their keys count against the per-IP quota. */
  readonly selfService: boolean;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface AgentSummary {
  readonly agentId: AgentId;
  readonly label: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly name: string | null;
  readonly avatar: Avatar | null;
  readonly lastSeen: string | null;
  readonly contractVersion: string | null;
}

export const DEVELOPER_NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export interface KeyInfo {
  readonly agentId: AgentId;
  readonly developer: string;
  readonly label: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly name: string | null;
  readonly lastSeen: string | null;
}

const hashKey = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");
const now = (): string => new Date().toISOString();

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS agent_keys (
    agent_id    TEXT PRIMARY KEY,
    key_hash    TEXT NOT NULL UNIQUE,
    developer   TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    revoked_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    name        TEXT PRIMARY KEY,
    value       TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bans (
    agent_id    TEXT NOT NULL REFERENCES agent_keys(agent_id),
    until_ms    INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    created_ms  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bans_agent ON bans(agent_id, until_ms);
  CREATE TABLE IF NOT EXISTS developers (
    name        TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    max_agents  INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    revoked_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS agents (
    agent_id          TEXT PRIMARY KEY REFERENCES agent_keys(agent_id),
    name              TEXT UNIQUE COLLATE NOCASE,
    avatar_json       TEXT,
    last_x            INTEGER,
    last_y            INTEGER,
    contract_version  TEXT,
    created_at        TEXT NOT NULL,
    last_seen         TEXT
  );
`;

export class Store implements BanBook {
  private readonly db: DatabaseSync;

  /** `path` is a file path, or ":memory:" for tests. */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    const row = this.db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
    if (!row) this.db.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
    this.migrate();
  }

  /** Version 2: self-service sign-up. Who created a key is kept as a keyed hash of the IP, never the IP itself. */
  private migrate(): void {
    const columns = (table: string) =>
      new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    const devs = columns("developers");
    if (!devs.has("self_service")) this.db.exec("ALTER TABLE developers ADD COLUMN self_service INTEGER NOT NULL DEFAULT 0");
    if (!devs.has("created_ip")) this.db.exec("ALTER TABLE developers ADD COLUMN created_ip TEXT");
    if (!columns("agent_keys").has("created_ip")) this.db.exec("ALTER TABLE agent_keys ADD COLUMN created_ip TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS keys_ip ON agent_keys(created_ip, revoked_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS developers_ip ON developers(created_ip, created_at)");
    this.db.prepare("UPDATE schema_version SET version = 2 WHERE version < 2").run();
  }

  /**
   * An opaque tag for an IP (or IPv6 /64, see ipBucket): HMAC with a random secret kept in the database.
   * Enough to count keys per IP; the IP cannot be read back without the secret.
   */
  ipTag(bucket: string): string {
    let secret = (this.db.prepare("SELECT value FROM settings WHERE name = 'ip_secret'").get() as { value: string } | undefined)?.value;
    if (!secret) {
      secret = randomBytes(32).toString("hex");
      this.db.prepare("INSERT INTO settings (name, value) VALUES ('ip_secret', ?)").run(secret);
    }
    return createHmac("sha256", secret).update(bucket, "utf8").digest("hex").slice(0, 32);
  }

  close(): void {
    this.db.close();
  }

  /** Consistent copy of the database while it is in use. */
  backup(path: string): void {
    if (!/^[\w./\\:-]+$/.test(path)) throw new Error("backup path: letters, digits, . _ - / \\ : only");
    mkdirSync(dirname(path), { recursive: true });
    this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  // -------------------------------------------------------------------- keys

  /** Create an agent and its key. The clear key is returned once and never stored. */
  createKey(developer: string, label = "", ipTag: string | null = null): { agentId: AgentId; key: string } {
    const agentId = `agt_${randomBytes(9).toString("base64url")}`;
    const key = `viv_${randomBytes(24).toString("base64url")}`;
    this.insertKey(agentId, key, developer, label, ipTag);
    return { agentId, key };
  }

  /** Register a key chosen elsewhere (dev keys from the environment). No-op if it already exists. */
  ensureKey(agentId: AgentId, key: string, developer = "dev", label = ""): void {
    if (key.length < 16) throw new Error(`Key for ${agentId} is too short (16 characters minimum)`);
    const existing = this.db.prepare("SELECT key_hash FROM agent_keys WHERE agent_id = ?").get(agentId) as
      | { key_hash: string }
      | undefined;
    if (existing) {
      if (existing.key_hash !== hashKey(key)) throw new Error(`Agent ${agentId} already has a different key`);
      return;
    }
    this.insertKey(agentId, key, developer, label);
  }

  private insertKey(agentId: AgentId, key: string, developer: string, label: string, ipTag: string | null = null): void {
    this.db
      .prepare("INSERT INTO agent_keys (agent_id, key_hash, developer, label, created_at, created_ip) VALUES (?, ?, ?, ?, ?, ?)")
      .run(agentId, hashKey(key), developer, label, now(), ipTag);
    this.db.prepare("INSERT INTO agents (agent_id, created_at) VALUES (?, ?)").run(agentId, now());
  }

  /** The agent a key belongs to, or null if unknown or revoked. */
  resolve(key: string): AgentId | null {
    if (typeof key !== "string" || key.length === 0 || key.length > 256) return null;
    const row = this.db
      .prepare("SELECT agent_id FROM agent_keys WHERE key_hash = ? AND revoked_at IS NULL")
      .get(hashKey(key)) as { agent_id: string } | undefined;
    return row?.agent_id ?? null;
  }

  /** False once the agent's key is revoked. */
  isActive(agentId: AgentId): boolean {
    return this.db.prepare("SELECT 1 FROM agent_keys WHERE agent_id = ? AND revoked_at IS NULL").get(agentId) !== undefined;
  }

  revokeKey(agentId: AgentId): boolean {
    const r = this.db
      .prepare("UPDATE agent_keys SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL")
      .run(now(), agentId);
    return Number(r.changes) > 0;
  }

  listKeys(): KeyInfo[] {
    const rows = this.db
      .prepare(
        `SELECT k.agent_id, k.developer, k.label, k.created_at, k.revoked_at, a.name, a.last_seen
         FROM agent_keys k JOIN agents a USING (agent_id) ORDER BY k.created_at`,
      )
      .all() as Record<string, string | null>[];
    return rows.map((r) => ({
      agentId: r["agent_id"]!,
      developer: r["developer"]!,
      label: r["label"] ?? "",
      createdAt: r["created_at"]!,
      revokedAt: r["revoked_at"] ?? null,
      name: r["name"] ?? null,
      lastSeen: r["last_seen"] ?? null,
    }));
  }

  hasAnyKey(): boolean {
    return this.db.prepare("SELECT 1 FROM agent_keys LIMIT 1").get() !== undefined;
  }

  // ------------------------------------------------------------------ agents

  getAgent(agentId: AgentId): AgentRecord | null {
    const r = this.db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as
      | Record<string, string | number | null>
      | undefined;
    if (!r) return null;
    const x = r["last_x"];
    const y = r["last_y"];
    return {
      agentId,
      name: (r["name"] as string | null) ?? null,
      avatar: r["avatar_json"] ? (JSON.parse(r["avatar_json"] as string) as Avatar) : null,
      lastPos: typeof x === "number" && typeof y === "number" ? [x, y] : null,
      contractVersion: (r["contract_version"] as string | null) ?? null,
    };
  }

  isNameTaken(name: string, exceptAgentId?: AgentId): boolean {
    const r = this.db.prepare("SELECT agent_id FROM agents WHERE name = ? COLLATE NOCASE").get(name.trim()) as
      | { agent_id: string }
      | undefined;
    return r !== undefined && r.agent_id !== exceptAgentId;
  }

  /** Set name and avatar once. Returns false if the name is taken. */
  setIdentity(agentId: AgentId, name: string, avatar: Avatar): boolean {
    try {
      const r = this.db
        .prepare("UPDATE agents SET name = ?, avatar_json = ? WHERE agent_id = ? AND name IS NULL")
        .run(name.trim(), JSON.stringify(avatar), agentId);
      return Number(r.changes) > 0;
    } catch (e) {
      if (String(e).includes("UNIQUE")) return false;
      throw e;
    }
  }

  acceptContract(agentId: AgentId, version: string): void {
    this.db.prepare("UPDATE agents SET contract_version = ? WHERE agent_id = ?").run(version, agentId);
  }

  savePosition(agentId: AgentId, [x, y]: Position): void {
    this.db.prepare("UPDATE agents SET last_x = ?, last_y = ?, last_seen = ? WHERE agent_id = ?").run(x, y, now(), agentId);
  }

  // ------------------------------------------------------------- developers

  /**
   * Invite a developer (CLI), or sign one up from the portal (`ipTag` set: self-service).
   * The clear token is returned once and never stored.
   */
  createDeveloper(name: string, maxAgents = 5, ipTag: string | null = null): { name: string; token: string } {
    if (!DEVELOPER_NAME.test(name)) throw new Error("developer name: 2-32 characters, lowercase letters, digits, _ or -");
    if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > 100) throw new Error("max agents: 1 to 100");
    const token = `vivdev_${randomBytes(24).toString("base64url")}`;
    try {
      this.db
        .prepare("INSERT INTO developers (name, token_hash, max_agents, created_at, self_service, created_ip) VALUES (?, ?, ?, ?, ?, ?)")
        .run(name, hashKey(token), maxAgents, now(), ipTag ? 1 : 0, ipTag);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new Error(`developer ${name} already exists`);
      throw e;
    }
    return { name, token };
  }

  resolveDeveloper(token: string): Developer | null {
    if (typeof token !== "string" || !token.startsWith("vivdev_") || token.length > 256) return null;
    const r = this.db.prepare("SELECT * FROM developers WHERE token_hash = ? AND revoked_at IS NULL").get(hashKey(token)) as
      | Record<string, string | number | null>
      | undefined;
    return r ? toDeveloper(r) : null;
  }

  revokeDeveloper(name: string): boolean {
    const r = this.db.prepare("UPDATE developers SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").run(now(), name);
    return Number(r.changes) > 0;
  }

  listDevelopers(): Developer[] {
    return (this.db.prepare("SELECT * FROM developers ORDER BY created_at").all() as Record<string, string | number | null>[]).map(toDeveloper);
  }

  agentsOf(developer: string): AgentSummary[] {
    const rows = this.db
      .prepare(
        `SELECT k.agent_id, k.label, k.created_at, k.revoked_at, a.name, a.avatar_json, a.last_seen, a.contract_version
         FROM agent_keys k JOIN agents a USING (agent_id) WHERE k.developer = ? ORDER BY k.created_at`,
      )
      .all(developer) as Record<string, string | null>[];
    return rows.map((r) => ({
      agentId: r["agent_id"]!,
      label: r["label"] ?? "",
      createdAt: r["created_at"]!,
      revokedAt: r["revoked_at"] ?? null,
      name: r["name"] ?? null,
      avatar: r["avatar_json"] ? (JSON.parse(r["avatar_json"]) as Avatar) : null,
      lastSeen: r["last_seen"] ?? null,
      contractVersion: r["contract_version"] ?? null,
    }));
  }

  activeKeyCount(developer: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM agent_keys WHERE developer = ? AND revoked_at IS NULL").get(developer) as { n: number };
    return Number(r.n);
  }

  /** Active keys created from this IP tag, whatever the account: the per-IP quota. */
  activeKeysFromIp(ipTag: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM agent_keys WHERE created_ip = ? AND revoked_at IS NULL").get(ipTag) as { n: number };
    return Number(r.n);
  }

  /** Accounts signed up from this IP tag since `sinceIso`. */
  signupsFromIp(ipTag: string, sinceIso: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM developers WHERE created_ip = ? AND created_at >= ?").get(ipTag, sinceIso) as { n: number };
    return Number(r.n);
  }

  isDeveloperNameTaken(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM developers WHERE name = ?").get(name) !== undefined;
  }

  /**
   * Revoke self-service keys not used since `cutoffIso` (never used: since creation), so a lost
   * account token cannot hold an IP's slots forever. Returns the revoked agents.
   */
  releaseIdleKeys(cutoffIso: string): AgentId[] {
    const rows = this.db
      .prepare(
        `SELECT k.agent_id FROM agent_keys k JOIN agents a USING (agent_id)
         WHERE k.created_ip IS NOT NULL AND k.revoked_at IS NULL AND COALESCE(a.last_seen, k.created_at) < ?`,
      )
      .all(cutoffIso) as { agent_id: string }[];
    for (const r of rows) this.revokeKey(r.agent_id);
    return rows.map((r) => r.agent_id);
  }

  /** Revoke a key only if it belongs to this developer. */
  revokeKeyOf(developer: string, agentId: AgentId): boolean {
    const r = this.db
      .prepare("UPDATE agent_keys SET revoked_at = ? WHERE agent_id = ? AND developer = ? AND revoked_at IS NULL")
      .run(now(), agentId, developer);
    return Number(r.changes) > 0;
  }

  // ------------------------------------------------------------------- bans

  ban(agentId: AgentId, until: number, reason: string): void {
    this.db.prepare("INSERT INTO bans (agent_id, until_ms, reason, created_ms) VALUES (?, ?, ?, ?)").run(agentId, until, reason, Date.now());
  }

  bannedUntil(agentId: AgentId, now: number): number | null {
    const r = this.db.prepare("SELECT MAX(until_ms) AS u FROM bans WHERE agent_id = ?").get(agentId) as { u: number | null } | undefined;
    return r?.u && r.u > now ? r.u : null;
  }

  bansSince(agentId: AgentId, since: number): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM bans WHERE agent_id = ? AND created_ms >= ?").get(agentId, since) as { n: number };
    return Number(r.n);
  }

  touch(agentId: AgentId): void {
    this.db.prepare("UPDATE agents SET last_seen = ? WHERE agent_id = ?").run(now(), agentId);
  }
}

function toDeveloper(r: Record<string, string | number | null>): Developer {
  return {
    name: String(r["name"]),
    maxAgents: Number(r["max_agents"]),
    selfService: Number(r["self_service"] ?? 0) === 1,
    createdAt: String(r["created_at"]),
    revokedAt: (r["revoked_at"] as string | null) ?? null,
  };
}
